/**
 * Stop a command an agent moved to the background (the Stop on a "Still running in the background" row), safely: AIB kills only
 * processes it can prove are that command's. Each target is a (pid, start time) pair AIB noted when the command went to the
 * background. At the kill each one must still be a descendant of the agent with the same start time (a reused pid fails this);
 * then the subtree below those processes is walked again (the command's own children, started since), and everything is killed
 * leaf first so nothing is re-parented away. Windows: the process is opened once, its creation time is read through that same
 * handle, and only then TerminateProcess is called on it (the handle pins the process, so the check and the kill see the same one).
 * POSIX: SIGTERM, then SIGKILL after 2 s for any that is still there with the same start time. A target that cannot be verified is
 * left alone. Never throws for a process that is already gone.
 */
import { type Descendant, descendants, refreshDescendants } from './descendants.ts';
import { kernel32, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_TERMINATE } from './win32.ts';

export interface ProcId {
  pid: number;
  /** Epoch seconds. */
  started: number;
}

/** How far a start time may differ and still be the same process: Windows reads it exactly; ps gives whole seconds of age. */
export const START_SLACK = Deno.build.os === 'windows' ? 1 : 2.5;

export interface KillResult {
  /** Processes a kill was sent to, leaf first. */
  killed: ProcId[];
  /** Targets that were not killed: gone already, no longer the agent's, or another process now has their pid. */
  skipped: number[];
}

/** Injectable for tests: the kill of one verified process. Returns false when it could not be sent. */
export type Killer = (target: ProcId) => boolean | Promise<boolean>;

/**
 * Which processes a kill of `targets` reaches now: the targets that are still `root`'s descendants with the same start time, plus
 * every descendant of those (started no earlier than its parent), deepest first. Null when the processes cannot be listed.
 */
export function verifiedSubtree(root: number, targets: ProcId[]): { plan: (Descendant & { started: number })[]; skipped: number[] } | null {
  refreshDescendants();
  const tree = descendants(root);
  if (!tree) return null;
  const byPid = new Map(tree.map((d) => [d.pid, d]));
  const verified = new Set<number>();
  const skipped: number[] = [];
  for (const target of targets) {
    const row = byPid.get(target.pid);
    if (row && row.started !== null && Math.abs(row.started - target.started) <= START_SLACK) verified.add(target.pid);
    else skipped.push(target.pid);
  }
  const reached = new Set<number>(verified);
  // descendants() lists parents before their children (a walk from the root), so one pass finds every process below a target.
  for (const d of tree) if (reached.has(d.parentPid) && d.started !== null) reached.add(d.pid);
  const plan = tree.filter((d) => reached.has(d.pid) && d.started !== null) as (Descendant & { started: number })[];
  plan.sort((a, b) => b.depth - a.depth);
  return { plan, skipped };
}

/** Kill `targets` (and what they started) below the agent `root`, as described above. Null when the processes cannot be listed. */
export async function killVerified(root: number, targets: ProcId[], killer?: Killer): Promise<KillResult | null> {
  const found = verifiedSubtree(root, targets);
  if (!found) return null;
  const killed: ProcId[] = [];
  const kill = killer ?? (Deno.build.os === 'windows' ? terminateWindows : signalPosix('SIGTERM'));
  for (const d of found.plan) {
    const target = { pid: d.pid, started: d.started };
    try {
      if (await kill(target)) killed.push(target);
    } catch { /* gone meanwhile */ }
  }
  if (!killer && Deno.build.os !== 'windows' && killed.length) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const again = verifiedSubtree(root, killed);
    const hard = signalPosix('SIGKILL');
    for (const d of again?.plan ?? []) {
      if (killed.some((k) => k.pid === d.pid)) {
        try {
          hard({ pid: d.pid, started: d.started });
        } catch { /* gone */ }
      }
    }
  }
  return { killed, skipped: found.skipped };
}

/** Open, check the creation time through the same handle, terminate. False when the process is gone or is another one now. */
function terminateWindows(target: ProcId): boolean {
  const k = kernel32();
  const handle = k.OpenProcess(PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, target.pid);
  if (handle === null) return false;
  try {
    const created = new BigUint64Array(1);
    const scratch = () => new BigUint64Array(1);
    if (!k.GetProcessTimes(handle, created, scratch(), scratch(), scratch())) return false;
    const started = Number(created[0]) / 10_000_000 - 11644473600;
    if (Math.abs(started - target.started) > START_SLACK) return false;
    return k.TerminateProcess(handle, 1) !== 0;
  } finally {
    k.CloseHandle(handle);
  }
}

function signalPosix(signal: Deno.Signal): Killer {
  return (target) => {
    try {
      Deno.kill(target.pid, signal);
      return true;
    } catch {
      return false;
    }
  };
}
