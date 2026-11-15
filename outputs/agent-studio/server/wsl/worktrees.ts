/**
 * The worktree per chat of a WSL project, Windows side (docs/wsl/design.md section 4 phase 2, section 5 item 3). The worktree manager
 * runs whole in the distro's helper (wsl/helper/worktrees.ts, `worktree.*`): the records, the root (`<data>/worktrees` in the Linux
 * keeper's data folder of this AIB) and every git call and removal are there. Here the helper's Linux paths become refs
 * (`wsl://<distro><linuxPath>`), so Studio, the page and the chat notes key on refs exactly as before, and the agent gets the Linux path.
 *
 * A helper that does not offer the methods (older, or started without its data folder), or a distro that is not ready, means the chat
 * works in the project folder, as phase 1 did; nothing about a WSL project ever reaches the Windows worktree registry.
 */
import * as wt from '../worktrees/worktrees.ts';
import { refOf } from '../platform/location.ts';
import { hostWhenReady, wslLoc } from './access.ts';
import { type WorktreePlanJson, type WslHost, WslHelperError } from './contract.ts';

/** A WSL chat's plan: path and project are refs (what Studio uses); `linuxPath` is the worktree folder the agent gets. */
export class WslPlan extends wt.Plan {
  constructor(readonly distro: string, readonly raw: WorktreePlanJson) {
    super(
      refOf({ kind: 'wsl', distro, linuxPath: raw.project }),
      raw.base,
      raw.key,
      raw.slug,
      raw.branch,
      refOf({ kind: 'wsl', distro, linuxPath: raw.path }),
      raw.folderBranch,
      raw.note,
    );
  }

  get linuxPath(): string {
    return this.raw.path;
  }
}

/** A record of a WSL worktree with refs for `path` and `project` (as Studio reads records), and the Linux folder. */
export type WslRecord = wt.WorktreeRecord & { key: string; path: string; project: string; linuxPath: string; distro: string };

export function isWslRecord(record: unknown): record is WslRecord {
  return !!record && typeof record === 'object' && typeof (record as WslRecord).linuxPath === 'string' &&
    typeof (record as WslRecord).distro === 'string' && !!wslLoc((record as WslRecord).path);
}

const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The helper does not offer worktree.* (an older helper, or one started without its data folder): the chat works in place. */
function noWorktrees(error: unknown): boolean {
  return error instanceof WslHelperError && (error.code === 'unknown_method' || error.code === 'no_method');
}

async function host(distro: string): Promise<WslHost> {
  return await hostWhenReady(distro);
}

/** The plan of a new chat in the WSL project `projectRef`, or null with the reason it works in the project folder. */
export async function wslPlanWithReason(projectRef: string, kind: 'chat' | 'helper' = 'chat'): Promise<{ plan: WslPlan | null; reason: string }> {
  const wsl = wslLoc(projectRef);
  if (!wsl) return { plan: null, reason: 'not a WSL project' };
  try {
    const answer = await (await host(wsl.distro)).call('worktree.plan', { project: wsl.linuxPath, kind });
    return answer.plan ? { plan: new WslPlan(wsl.distro, answer.plan), reason: '' } : { plan: null, reason: answer.reason || 'unknown reason' };
  } catch (error) {
    const reason = noWorktrees(error)
      ? "this distro's AIB helper cannot make worktrees"
      : `the worktree could not be planned in the distro: ${text(error)}`;
    wt.say(`Worktree: ${projectRef} works in place: ${reason}`);
    return { plan: null, reason };
  }
}

/** Make the plan's worktree in the distro. Throws wt.Fallback (the chat works in place) as Manager.create does. */
export async function wslCreate(plan: WslPlan): Promise<void> {
  let answer: { note: string };
  try {
    answer = await (await host(plan.distro)).call('worktree.create', { plan: plan.raw }, { timeoutMs: 600_000 });
  } catch (error) {
    if (error instanceof WslHelperError && error.code === 'fallback') throw new wt.Fallback(error.message);
    throw new wt.Fallback(`could not make the worktree: ${text(error)}`);
  }
  if (answer.note) plan.note = answer.note;
}

/** Forget a plan's worktree (the chat never began, or it fell back). Never throws. */
export async function wslDiscard(plan: WslPlan): Promise<void> {
  try {
    await (await host(plan.distro)).call('worktree.discard', { key: plan.key }, { timeoutMs: 120_000 });
  } catch (error) {
    wt.say(`Worktree: could not discard ${plan.path}: ${text(error)}`);
  }
}

export async function wslSetSession(plan: WslPlan, provider: string, sessionId: string): Promise<void> {
  await (await host(plan.distro)).call('worktree.setSession', { key: plan.key, provider, sessionId });
}

function recordOf(distro: string, raw: (Record<string, unknown> & { key: string }) | null): WslRecord | null {
  if (!raw || typeof raw.path !== 'string' || typeof raw.project !== 'string' || !raw.path.startsWith('/') || !raw.project.startsWith('/')) return null;
  return {
    ...raw,
    key: String(raw.key),
    distro,
    linuxPath: raw.path,
    path: refOf({ kind: 'wsl', distro, linuxPath: raw.path }),
    project: refOf({ kind: 'wsl', distro, linuxPath: raw.project }),
  };
}

/**
 * The finished record of the WSL worktree at `ref` (a chat's folder), else the only one of the saved chat `session`; null when there
 * is none, the helper cannot tell, or the distro is not ready (`strict`: then it throws instead).
 */
export async function wslRecord(ref: string, session: string | null = null, strict = false): Promise<WslRecord | null> {
  const wsl = wslLoc(ref);
  if (!wsl) return null;
  try {
    const found = await (await host(wsl.distro)).call('worktree.find', { path: wsl.linuxPath, ...(session ? { session } : {}) });
    return recordOf(wsl.distro, found.record);
  } catch (error) {
    if (noWorktrees(error)) return null;
    if (strict) throw error;
    return null;
  }
}

/** True when `ref` (or the saved chat `session`) belongs to a WSL worktree AIB removed or is removing. */
export async function wslIsRemoved(ref: string, session: string | null = null): Promise<boolean> {
  const wsl = wslLoc(ref);
  if (!wsl) return false;
  try {
    return (await (await host(wsl.distro)).call('worktree.isRemoved', { workspace: wsl.linuxPath, ...(session ? { session } : {}) })).removed;
  } catch (error) {
    if (noWorktrees(error)) return false;
    throw error;
  }
}

/** The Linux folder of a recorded worktree, made again from its branch if deleted. Throws wt.WorktreeGone as Manager.ensure. */
export async function wslEnsure(record: WslRecord): Promise<string> {
  try {
    return (await (await host(record.distro)).call('worktree.ensure', { key: record.key }, { timeoutMs: 600_000 })).path;
  } catch (error) {
    if (error instanceof WslHelperError && error.code === 'gone') throw new wt.WorktreeGone(error.message);
    throw error;
  }
}

export async function wslRemove(record: WslRecord, confirmed: boolean): Promise<wt.RemoveOutcome> {
  return (await (await host(record.distro)).call('worktree.remove', { key: record.key, confirmed }, { timeoutMs: 600_000 })).outcome;
}

export async function wslHasChanges(record: WslRecord): Promise<boolean> {
  return (await (await host(record.distro)).call('worktree.hasChanges', { key: record.key }, { timeoutMs: 120_000 })).changes;
}
