/**
 * Helpers (swarm builders) of WSL projects, Windows side (owner 2026-11-25). The helper's chat and its worktree are made like any WSL
 * chat's (wsl/worktrees.ts, kind 'helper'); what the swarm does to that worktree with git is the distro's helper's work
 * (wsl/helper/helpers.ts, `helper.*` and `merge.run` with held/builder), asked for here. AIB keeps what it keeps for every helper:
 * who started it, when it lands, what the parent is told. Everything here fails closed: a distro that is not ready, or a helper
 * without `helper.*`, answers "unavailable" (a refusal a later try may meet, or no facts), never a git call on a Windows path and never
 * a landing guessed.
 *
 * One landing at a time per project folder: the swarm's folder key (service.ts #folderKey, the folder's ref lower-cased) is the same
 * for a WSL helper and a WSL subagent, and the distro runs both landings in one process under one repository lock (worktrees/merge.ts
 * repoLock), so the Windows side and the distro helper share one lock per folder.
 */
import { isDict } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { refOf } from '../platform/location.ts';
import type { MergeHost } from '../worktrees/merge.ts';
import { helperState, wslMergeChat } from './merge.ts';
import { hostWhenReady, peekWslHost, wslLoc } from './access.ts';
import { type HelperMethods, WslHelperError } from './contract.ts';

const log = getLogger('wsl_helpers');

type Json = Record<string, unknown>;

const CALL_MS = 120_000;
const LAND_MS = 600_000;

const missing = (error: unknown) => error instanceof WslHelperError && (error.code === 'unknown_method' || error.code === 'no_method');
const why = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 300);

/** The distro and Linux folder of a WSL ref, else null (a Windows path). */
export const wslHelperLoc = (ref: string) => wslLoc(ref);

/** The ref of a Linux path in `distro`. */
export const wslRef = (distro: string, linuxPath: string) => refOf({ kind: 'wsl', distro, linuxPath });

async function call<M extends keyof HelperMethods>(
  distro: string,
  method: M,
  params: HelperMethods[M]['params'],
  timeoutMs = CALL_MS,
): Promise<HelperMethods[M]['result']> {
  return await (await hostWhenReady(distro)).call(method, params, { timeoutMs });
}

/** True when the distro's helper offers the helper.* methods (a ready host that lists them; an older one does not). */
export async function wslHelpersAvailable(distro: string): Promise<string> {
  try {
    // a look at a key no record has: an answer from a helper that offers helper.*, "no method" from an older one, nothing changed
    await call(distro, 'helper.work', { key: 'probe-no-such-key', op: 'status' });
    return '';
  } catch (error) {
    if (missing(error)) return "this distro's AIB helper is too old to run helpers (update AIB in Settings › AIB Linking)";
    return `the distro could not be reached (${why(error)})`;
  }
}

/** Stop: the helper's uncommitted work is committed on its branch. Commits over its start; 0 when the distro can't say. */
export async function wslHelperKeep(distro: string, key: string, message: string): Promise<number> {
  try {
    return (await call(distro, 'helper.keep', { key, message }, LAND_MS)).commits;
  } catch (error) {
    if (!missing(error)) log.warning('wsl: the work of a helper could not be kept: %s', why(error));
    return 0;
  }
}

/**
 * A closed helper's landing from its record, in the distro. The folder's chats AIB holds are sent as their public states. The outcome
 * is the swarm's ({state: 'merged' | 'empty' | 'scratch' | 'refused' | 'conflicts' | 'dirty', ...}); a distro that can't answer is a
 * refusal a later try may meet (code 'wsl_unavailable').
 */
export async function wslHelperLand(
  aib: MergeHost,
  args: { distro: string; key: string; id: string; target: string; parent: string; title: string; held: string[] },
  onStage: (stage: string, data: Json) => Promise<void> | void,
): Promise<{ outcome: Json; counted: number; branchTip: string }> {
  const states: Record<string, Json> = {};
  for (const id of args.held) {
    const chat = await wslMergeChat(aib, id);
    if (chat) states[id] = helperState(chat);
  }
  try {
    const out = await call(args.distro, 'helper.land', {
      key: args.key,
      id: args.id,
      target: args.target,
      parent: args.parent,
      title: args.title,
      held: args.held,
      states,
    }, LAND_MS);
    for (const j of out.journal ?? []) await onStage(j.stage, j.data);
    return {
      outcome: isDict(out.outcome) ? out.outcome : { state: 'refused', code: 'failed', message: 'the distro gave no answer' },
      counted: out.counted,
      branchTip: out.branchTip,
    };
  } catch (error) {
    const message = missing(error) ? "this distro's AIB helper is too old to land helpers" : `the distro could not land it (${why(error)})`;
    if (!missing(error)) log.warning('wsl: a helper could not be landed: %s', why(error));
    return { outcome: { state: 'refused', code: 'wsl_unavailable', message }, counted: 0, branchTip: '' };
  }
}

/** What the swarm reads of a helper's repository (helper/helpers.ts helper.facts). null when the distro can't answer now. */
export async function wslHelperFacts(distro: string, params: HelperMethods['helper.facts']['params']): Promise<Json | null> {
  const host = peekWslHost(distro);
  if (!host || host.state !== 'ready') return null; // never started for a look
  try {
    return await host.call('helper.facts', params, { timeoutMs: CALL_MS });
  } catch (error) {
    if (!missing(error)) log.warning('wsl: the repository of a helper could not be read: %s', why(error));
    return null;
  }
}

/** Unlanded work of a WSL helper (helper.work); null when the distro can't answer now. */
export async function wslHelperWork(
  distro: string,
  params: HelperMethods['helper.work']['params'],
): Promise<HelperMethods['helper.work']['result'] | null> {
  try {
    return await call(distro, 'helper.work', params, LAND_MS);
  } catch (error) {
    if (!missing(error)) log.warning('wsl: the unlanded work of a helper could not be read: %s', why(error));
    return null;
  }
}

/** Drop a helper's branch (or its `-landable` one); false when the distro can't do it now. */
export async function wslHelperBranchDrop(distro: string, project: string, branch: string): Promise<boolean> {
  try {
    return (await call(distro, 'helper.branch', { project, branch })).dropped;
  } catch (error) {
    if (!missing(error)) log.warning('wsl: a helper branch was not removed: %s', why(error));
    return false;
  }
}

/** Remove a helper's worktree by its record key (never confirmed: git refuses a worktree with edits). 'gone' when the distro can't be asked. */
export async function wslHelperRemove(distro: string, key: string): Promise<'removed' | 'pending' | 'gone'> {
  try {
    return (await call(distro, 'worktree.remove', { key, confirmed: false }, LAND_MS)).outcome;
  } catch (error) {
    log.warning('wsl: a helper worktree was not removed: %s', why(error));
    return 'gone';
  }
}

/** Undo / Merge again in the distro (swarm/undo.ts applyChange); a refusal when the distro can't answer. */
export async function wslHelperApply(
  aib: MergeHost,
  distro: string,
  args: { project: string; branch: string; from: string; to: string; message: string; noStash: boolean; held: string[]; title: string },
): Promise<Json> {
  const states: Record<string, Json> = {};
  for (const id of args.held) {
    const chat = await wslMergeChat(aib, id);
    if (chat) states[id] = helperState(chat);
  }
  try {
    const out = await call(distro, 'helper.apply', { ...args, states }, LAND_MS);
    return isDict(out.outcome) ? out.outcome : { state: 'refused', message: 'the distro gave no answer' };
  } catch (error) {
    return {
      state: 'refused',
      code: 'wsl_unavailable',
      message: missing(error) ? "this distro's AIB helper is too old for that" : `the distro could not do it (${why(error)})`,
    };
  }
}
