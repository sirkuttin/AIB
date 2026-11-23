/**
 * Subagent worktrees for WSL projects, Windows side (owner 2026-11-23). The work is the distro's helper's (wsl/helper/subagents.ts,
 * `subagent.*`: subagents/service.ts and worktrees/subagent_land.ts run natively over the distro's `<data>`); AIB keeps what it keeps
 * for every subagent: when a worktree is wanted (a hook), when the parent is idle (landing), what the parent is told. Here:
 *
 *   - a chat's facts as the helper takes them (its Linux folder and project), and a record's Linux paths back as refs, so the rest of
 *     AIB (Activity, Changes, the swarm's registry) names a WSL subagent's worktree the way it names a WSL chat's;
 *   - the calls, each failing closed: a distro that is not ready or a helper without `subagent.*` is "no worktree" (the caller refuses
 *     the subagent's edits, as for every agent whose worktree can't be made), never an edit in the project folder;
 *   - the landing: the folder's chats were held and their states are sent; the outcome is the swarm's, so a failed landing wakes the
 *     parent exactly as on Windows.
 */
import { isDict } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { refOf } from '../platform/location.ts';
import { hostWhenReady, peekWslHost, wslLoc } from './access.ts';
import { type HelperMethods, WslHelperError, type WslSubagentChat, type WslSubagentRecord } from './contract.ts';

const log = getLogger('wsl_subagents');

type Json = Record<string, unknown>;

const CALL_MS = 120_000;
const LAND_MS = 600_000;

/** A chat that works in a WSL folder: the helper's facts for it (Linux paths), else null (the Windows service handles it). */
export function wslSubagentChat(chat: { id: string; provider: string; lasting: string; folder: string; project: string; readOnly?: Iterable<string> }): { distro: string; facts: WslSubagentChat } | null {
  const folder = wslLoc(chat.folder);
  const project = wslLoc(chat.project);
  if (!folder || !project || folder.distro !== project.distro) return null;
  return {
    distro: folder.distro,
    facts: {
      id: chat.id,
      provider: chat.provider,
      lasting: chat.lasting,
      folder: folder.linuxPath,
      project: project.linuxPath,
      ...(chat.readOnly ? { readOnly: [...chat.readOnly].slice(0, 200) } : {}),
    },
  };
}

/** A helper record with its Linux paths as refs of `distro` (what AIB stores and shows). The Linux paths stay in `linux`. */
export function recordWithRefs(distro: string, record: WslSubagentRecord): WslSubagentRecord {
  const ref = (p: unknown) => (typeof p === 'string' && p ? refOf({ kind: 'wsl', distro, linuxPath: p }) : '');
  return {
    ...record,
    path: ref(record.path),
    folder: ref(record.folder),
    ...(typeof record.project === 'string' ? { project: ref(record.project) } : {}),
    linux: { path: record.path, folder: record.folder },
  };
}

async function call<M extends keyof HelperMethods>(
  distro: string,
  method: M,
  params: HelperMethods[M]['params'],
  timeoutMs = CALL_MS,
): Promise<HelperMethods[M]['result']> {
  const host = await hostWhenReady(distro);
  return await host.call(method, params, { timeoutMs });
}

const missing = (error: unknown) => error instanceof WslHelperError && (error.code === 'unknown_method' || error.code === 'no_method');
const why = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/**
 * A worktree for the chat's next subagent, made in the distro: the record with refs (state prepared), or why not (the subagent's
 * edits are then refused, never made in the project folder).
 */
export async function wslSubagentPrepare(
  chat: Parameters<typeof wslSubagentChat>[0],
  meta: { toolUseId: string; agentType: string; description: string; background?: boolean },
): Promise<WslSubagentRecord | { deny: string }> {
  const target = wslSubagentChat(chat);
  if (!target) return { deny: 'this chat is not in a WSL folder' };
  try {
    const out = await call(target.distro, 'subagent.prepare', { chat: target.facts, meta });
    if (out.deny) return { deny: out.deny };
    if (!out.record) return { deny: 'the distro made no worktree' };
    return recordWithRefs(target.distro, out.record);
  } catch (error) {
    if (missing(error)) return { deny: "this distro's AIB helper is too old to give subagents their own worktree" };
    log.warning('wsl: a subagent worktree could not be made: %s', why(error));
    return { deny: `the distro could not make it (${why(error)})` };
  }
}

/** The chat's subagent `agentId` starts / ends (Codex SubagentStart / Stop, Claude's WorktreeCreate answered by the helper). */
export async function wslSubagentBind(chat: Parameters<typeof wslSubagentChat>[0], agentId: string, agentType = ''): Promise<WslSubagentRecord | null> {
  const target = wslSubagentChat(chat);
  if (!target) return null;
  try {
    const out = await call(target.distro, 'subagent.bind', { chat: target.facts, agentId, agentType });
    return out.record ? recordWithRefs(target.distro, out.record) : null;
  } catch (error) {
    log.warning('wsl: a subagent could not be bound to its worktree: %s', why(error));
    return null;
  }
}

export async function wslSubagentEnd(chat: Parameters<typeof wslSubagentChat>[0], agentId: string): Promise<void> {
  const target = wslSubagentChat(chat);
  if (!target) return;
  await call(target.distro, 'subagent.end', { chat: target.facts, agentId }).catch((error) => log.warning('wsl: a subagent end was not recorded: %s', why(error)));
}

/** The records of the distro (one chat's, or all), with refs. [] when the distro is not ready (it is not started for this). */
export async function wslSubagentRecords(distro: string, chat?: string): Promise<WslSubagentRecord[]> {
  const host = peekWslHost(distro);
  if (!host || host.state !== 'ready') return [];
  try {
    const out = await host.call('subagent.records', chat ? { chat } : {}, { timeoutMs: CALL_MS });
    return out.records.map((r) => recordWithRefs(distro, r));
  } catch (error) {
    if (!missing(error)) log.warning('wsl: subagent records could not be read: %s', why(error));
    return [];
  }
}

/** The chat closed: the distro removes its spare and unused worktrees. Never throws. */
export async function wslSubagentChatClosed(distro: string, chat: string): Promise<void> {
  const host = peekWslHost(distro);
  if (!host || host.state !== 'ready') return;
  await host.call('subagent.chatClosed', { chat }, { timeoutMs: CALL_MS }).catch((error) => {
    if (!missing(error)) log.warning('wsl: subagent worktrees of a closed chat were not cleaned up: %s', why(error));
  });
}

/**
 * Land the subagent `id` on `target` in the distro. `states`: the public state (cwd as Linux paths) of the folder's chats AIB holds
 * (`held`). The outcome is #landSubagent's ({state: 'merged' | 'empty' | 'scratch' | 'refused' | 'conflicts', ...}); a distro that
 * can't answer is a `refused` outcome that a later try may meet (code 'wsl_unavailable'), never a landing in the project folder.
 * `journal` and `actions` come back for AIB to record and to post (a landing posts nothing to a chat today; kept for the contract).
 */
export async function wslSubagentLand(
  distro: string,
  args: { id: string; parent: string; target: string; title: string; held: string[]; states: Record<string, Json>; landKept?: string[] | null; landScratch?: boolean },
): Promise<{ outcome: Json; journal: { stage: string; data: Json }[]; actions: Json[] }> {
  try {
    const out = await call(distro, 'subagent.land', args, LAND_MS);
    return { outcome: isDict(out.outcome) ? out.outcome : { state: 'refused', code: 'failed', message: 'the distro gave no answer' }, journal: out.journal ?? [], actions: out.actions ?? [] };
  } catch (error) {
    if (missing(error)) {
      return { outcome: { state: 'refused', code: 'wsl_unavailable', message: "this distro's AIB helper is too old to land subagents" }, journal: [], actions: [] };
    }
    log.warning('wsl: a subagent could not be landed: %s', why(error));
    return { outcome: { state: 'refused', code: 'wsl_unavailable', message: `the distro could not land it (${why(error)})` }, journal: [], actions: [] };
  }
}

/** Landed, empty or discarded: the worktree, branch and record go in the distro. 'gone' when the distro can't be asked now. */
export async function wslSubagentRelease(distro: string, id: string): Promise<'removed' | 'kept' | 'running' | 'gone'> {
  try {
    return (await call(distro, 'subagent.release', { id })).outcome;
  } catch (error) {
    log.warning('wsl: a subagent worktree was not removed: %s', why(error));
    return 'gone';
  }
}
