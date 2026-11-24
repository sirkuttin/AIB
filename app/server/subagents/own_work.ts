/**
 * Does a finished subagent still have processes of its own running? (2026-11-24: two builders were landed, and their worktrees removed,
 * under the background test runs they had started: 67 false failures.) A subagent whose TURN ended is not necessarily quiet: Claude Code
 * lets it end with a background Bash command or a Monitor still running. While any of these runs, AIB neither lands it nor removes its
 * worktree nor shuts its processes down:
 *   - a process that carries the subagent's shell cookie (AIB_PROC <chat>.<agent>.<call>: background shells and monitors),
 *   - any other process that started after the subagent did and whose current folder is inside its worktree.
 * The wait ends when it is quiet, or at a hard ceiling after it finished (OWN_WORK.ceilingS): then it is treated as stuck, its
 * processes are shut down (reap.ts) and it lands as it always did. The same code runs in the distro's helper over /proc.
 */
import { COOKIE_SHAPE } from '../allow/aib_prefix.ts';
import { type ProcSource, realProcesses } from '../platform/proc_env.ts';
import { START_SLACK } from '../platform/kill_verified.ts';
import { parseCookie } from './shell_tag.ts';

/** Settings (tests replace them). */
export const OWN_WORK = {
  /** Two hours after it finished, a subagent that still has processes is stuck. */
  ceilingS: 7200,
  /** Seconds between two looks. */
  recheckS: 30,
  source: realProcesses as ProcSource,
  now: () => Date.now() / 1000,
};

/** What the words "Waiting to land: <reason>" say. */
export const OWN_WORK_REASON = 'its tests are still running';

export interface OwnWorkRecord {
  chat: string;
  agentId: string;
  path: string;
  createdAt: number;
  boundAt?: number;
  doneAt?: number;
  stoppedAt?: number;
  continuedAt?: number;
  wsl?: unknown;
}

const norm = (p: string) => {
  const slash = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return Deno.build.os === 'windows' ? slash.toLowerCase() : slash;
};

/** The pids of the processes that are the subagent's own and still run (empty: quiet). */
export function ownProcesses(rec: OwnWorkRecord, source: ProcSource = OWN_WORK.source): number[] {
  if (!rec.agentId || !rec.path) return [];
  const since = (rec.boundAt ?? rec.createdAt) - START_SLACK;
  const all = source.list(Math.max(0, since));
  if (!all) return [];
  const cookies = source.cookies(all.map((p) => p.pid));
  const hits = new Set<number>();
  const rest: number[] = [];
  for (const p of all) {
    const cookie = cookies.get(p.pid);
    const c = cookie && COOKIE_SHAPE.test(cookie) ? parseCookie(cookie) : null;
    if (c && c.chat === rec.chat && c.owner === rec.agentId) hits.add(p.pid);
    else if (p.parentPid !== Deno.pid) rest.push(p.pid);
  }
  if (source.cwds && rest.length) {
    const root = norm(rec.path);
    for (const [pid, cwd] of source.cwds(rest)) {
      const at = norm(cwd);
      if (at === root || at.startsWith(root + '/')) hits.add(pid);
    }
  }
  return [...hits];
}

/**
 * '' when the subagent is quiet or has waited past the ceiling (or is a WSL mirror: its distro looks), else the reason. `since` is when it
 * finished (default: its record's).
 */
export function ownWorkReason(rec: OwnWorkRecord, source: ProcSource = OWN_WORK.source): string {
  if (rec.wsl) return '';
  const ended = Math.max(rec.doneAt ?? 0, rec.stoppedAt ?? 0, rec.continuedAt ?? 0) || rec.createdAt;
  if (OWN_WORK.now() - ended >= OWN_WORK.ceilingS) return '';
  // a busy answer is kept for recheckS: the poll asks every few seconds, a process scan is not free (Windows reads each one's memory)
  const key = `${rec.chat}\0${rec.agentId}\0${rec.path}`;
  const hit = BUSY.get(key);
  if (hit && OWN_WORK.now() - hit < OWN_WORK.recheckS) return OWN_WORK_REASON;
  if (ownProcesses(rec, source).length) {
    BUSY.set(key, OWN_WORK.now());
    return OWN_WORK_REASON;
  }
  BUSY.delete(key);
  return '';
}

const BUSY = new Map<string, number>();

/** Whether the ceiling has passed with processes still there (the caller says so, visibly, and goes on). */
export function ownWorkStuck(rec: OwnWorkRecord, source: ProcSource = OWN_WORK.source): boolean {
  if (rec.wsl) return false;
  const ended = Math.max(rec.doneAt ?? 0, rec.stoppedAt ?? 0, rec.continuedAt ?? 0) || rec.createdAt;
  return OWN_WORK.now() - ended >= OWN_WORK.ceilingS && ownProcesses(rec, source).length > 0;
}
