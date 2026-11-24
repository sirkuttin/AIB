/**
 * Merge for a WSL chat's worktree, Windows side (docs/wsl/design.md section 4 phase 2, section 5 item 1). The merge engine
 * (worktrees/merge.ts) runs whole in the distro's helper (wsl/helper/merge.ts, `merge.*`), over the worktree registry there, with its
 * locks and clash records next to it. Here AIB hands the helper the chat's public state (its cwd as the worktree's Linux path) and
 * then makes, in order, the live calls merge.ts made there (conflict prompts, the "Merged into" note, a clash note and prompt, the
 * Merge button's queued message), so the chat sees exactly what a Windows chat sees. A refusal comes back as merge.ts's Refused.
 *
 * The routes (web/studio_routes.ts) ask wslMergeChat first: a live chat whose cwd is a WSL ref goes here, every other chat to
 * merge.ts as before. Nothing here reads or writes a Windows file for a WSL path.
 */
import * as merge from '../worktrees/merge.ts';
import { clip, isDict, pyStr, ValueError } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { hostWhenReady, notReady, peekWslHost, wslHost, wslLoc } from './access.ts';
import { type HelperMethods, WslHelperError, type WslMergeAnswer } from './contract.ts';

const log = getLogger('wsl_merge');

/** A live chat of a WSL project: its distro, the Linux folder it works in (its worktree) and its public state. */
export interface WslMergeChat {
  id: string;
  distro: string;
  linuxPath: string;
  state: Record<string, unknown>;
}

const RUN_TIMEOUT_MS = 600_000;
const READ_TIMEOUT_MS = 120_000;
/** The only live calls the helper may hand back (merge.ts's own): never a page op. */
const OPS = new Set(['prompt', merge.NOTE_OP, 'queue']);

let running = 0;

/** WSL merges this AIB is waiting on (Quit AIB waits for them, as for merge.ts's own). */
export function wslMergesRunning(): number {
  return running;
}

/** The chat behind `chatId` when it is a live chat working in a WSL folder, else null (merge.ts handles it). */
export async function wslMergeChat(studio: merge.MergeStudio, chatId: unknown): Promise<WslMergeChat | null> {
  if (typeof chatId !== 'string' || !chatId) return null;
  let state: unknown;
  try {
    state = await studio.liveState(chatId);
  } catch {
    return null;
  }
  if (!isDict(state)) return null;
  const wsl = wslLoc(state.cwd);
  return wsl ? { id: chatId, distro: wsl.distro, linuxPath: wsl.linuxPath, state } : null;
}

const pick = (value: unknown, names: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (isDict(value)) for (const name of names) if (Object.hasOwn(value, name)) out[name] = value[name];
  return out;
};

/**
 * The part of a chat's public state merge.ts reads (stateIdleReason, canEditProject, requestBlocked, the subagents' folders), with
 * cwd the Linux folder. Queued messages go as empty items (only whether there are any counts), so no message text crosses.
 */
export function helperState(chat: WslMergeChat): Record<string, unknown> {
  const s = chat.state;
  const out: Record<string, unknown> = { ...pick(s, ['closed', 'state', 'busy', 'provider', 'readOnly']), cwd: chat.linuxPath };
  if (isDict(s.queue)) out.queue = { items: Array.isArray(s.queue.items) ? s.queue.items.map(() => ({})) : s.queue.items ? [{}] : [] };
  if (isDict(s.clientCaps)) {
    const terminals = Array.isArray(s.clientCaps.terminals) ? s.clientCaps.terminals : [];
    out.clientCaps = { terminals: terminals.map((t) => pick(t, ['id', 'status', 'command'])) };
  }
  if (isDict(s.subagents)) {
    const names = ['state', 'title', 'name', 'cwd', 'worktree', 'worktreePath', 'workingDirectory'];
    out.subagents = Object.fromEntries(Object.entries(s.subagents).map(([k, v]) => [k, pick(v, names)]));
  }
  return out;
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A helper call that must happen (a merge, a request, a clash action): the distro is started if needed; failures are Refused. */
async function mustCall<M extends keyof HelperMethods>(
  chat: WslMergeChat,
  method: M,
  params: HelperMethods[M]['params'],
): Promise<HelperMethods[M]['result']> {
  try {
    const host = await hostWhenReady(chat.distro);
    return await host.call(method, params, { timeoutMs: RUN_TIMEOUT_MS });
  } catch (error) {
    if (error instanceof WslHelperError && (error.code === 'unknown_method' || error.code === 'no_method')) {
      throw new merge.Refused('This chat does not work in its own worktree', 'no_worktree', 404);
    }
    if (error instanceof WslHelperError || error instanceof ValueError) {
      throw new merge.Refused(clip(text(error), 200), 'wsl_unavailable', 409);
    }
    throw error;
  }
}

/** Makes the helper's recorded live calls in order (each for this chat only); a `must` call that is not accepted is a refusal. */
async function post(studio: merge.MergeStudio, chat: WslMergeChat, answer: WslMergeAnswer): Promise<void> {
  for (const action of Array.isArray(answer.actions) ? answer.actions : []) {
    if (!isDict(action) || !OPS.has(String(action.op)) || action.op === 'queue') continue; // AIB queues no message for a merge
    const payload = { ...(isDict(action.payload) ? action.payload : {}), id: chat.id };
    if (action.must) {
      const [status, reply] = await studio.liveCall(String(action.op), payload);
      if (status !== 200) {
        throw new merge.Refused(pyStr(action.fail || 'Could not ask the chat: ') + merge.payloadError(reply, 'it did not accept the message'), 'prompt_failed');
      }
      continue;
    }
    try {
      await studio.liveCall(String(action.op), payload);
    } catch (error) {
      log.exception(error, 'Could not post the merge note');
    }
  }
}

/** The result, after its live calls are made; a refusal (with any calls made before it) is thrown as merge.ts's Refused. */
async function settle(studio: merge.MergeStudio, chat: WslMergeChat, answer: WslMergeAnswer): Promise<merge.MergeResult> {
  await post(studio, chat, answer);
  const r = answer.refused;
  if (r) throw new merge.Refused(String(r.message), String(r.code || 'refused'), Number(r.status) || 409, isDict(r.extra) ? r.extra : {});
  return isDict(answer.result) ? answer.result : {};
}

/** A WSL chat's merge status, from the helper (merge.ts status()). Never starts a distro; never throws for one. */
export async function wslMergeStatus(chat: WslMergeChat): Promise<Record<string, unknown>> {
  const host = wslHost(chat.distro);
  const why = notReady(host, chat.distro);
  if (why) return { worktree: true, enabled: false, state: 'unavailable', message: why, base: '' };
  try {
    return (await host!.call('merge.status', { chat: chat.id, state: helperState(chat) }, { timeoutMs: READ_TIMEOUT_MS })).result;
  } catch (error) {
    if (error instanceof WslHelperError && (error.code === 'unknown_method' || error.code === 'no_method')) return { worktree: false };
    if (error instanceof WslHelperError) return { worktree: true, enabled: false, state: 'unavailable', message: clip(error.message, 160), base: '' };
    throw error;
  }
}

/** Merge a WSL chat's worktree: the agent's merge_into_project (`fromTool`) or the page's direct merge route. */
export async function wslMerge(studio: merge.MergeStudio, chat: WslMergeChat, title = '', fromTool = false): Promise<merge.MergeResult> {
  running++;
  try {
    const answer = await mustCall(chat, 'merge.run', { chat: chat.id, state: helperState(chat), title: String(title || ''), fromTool });
    return await settle(studio, chat, answer);
  } finally {
    running--;
  }
}

/** A clash action (Keep my version, I'll sort it myself, check) for a WSL chat's project. */
export async function wslResolveClash(studio: merge.MergeStudio, chat: WslMergeChat, action: string, fromTool = false): Promise<merge.MergeResult> {
  const answer = await mustCall(chat, 'merge.resolveClash', { chat: chat.id, state: helperState(chat), action, fromTool });
  return await settle(studio, chat, answer);
}

/**
 * The amber line of a WSL project folder (`project`: its ref): an unresolved clash after a merge, read in the distro. A distro AIB is
 * not using, or one that is not ready, is not started for it: no line then.
 */
export async function wslClashStatus(project: string): Promise<Record<string, unknown>> {
  const wsl = wslLoc(project);
  if (!wsl) return { unresolved: false };
  const host = peekWslHost(wsl.distro);
  if (!host || host.state !== 'ready') return { unresolved: false };
  try {
    return (await host.call('merge.clashStatus', { project: wsl.linuxPath }, { timeoutMs: READ_TIMEOUT_MS })).result;
  } catch (error) {
    log.warning('wsl: the clash status of %s could not be read: %s', project, text(error));
    return { unresolved: false };
  }
}
