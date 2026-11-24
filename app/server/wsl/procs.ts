/**
 * The processes below a WSL chat's agent, for its busy-children detection (acp/connection.ts backgroundShellsRunning, #markBackground):
 * the agent runs in the distro, so its pid is a Linux pid and Windows' process list knows nothing of it. The distro's helper lists
 * them (`proc.tree`, platform/descendants.ts run natively). Connection asks synchronously (Studio.busyList asks every chat each
 * second), so this keeps the last answer per distro and fetches a new one in the background: a call answers from a snapshot at most
 * FRESH_MS old and otherwise asks for a new one and answers null, which Connection already reads as "cannot be listed" (a shell
 * then keeps counting as running). So a helper that is away, slow or too old never makes a chat look idle while its command runs.
 * A distro that is not running is never started for this. Stop on a background row goes to the same helper (wslKillVerified).
 */
import type { Descendant } from '../platform/descendants.ts';
import type { KillResult, ProcId } from '../platform/kill_verified.ts';
import { peekWslHost } from './access.ts';

/** How old a snapshot may be and still answer (ms); a fetch takes one helper round trip. */
export const FRESH_MS = 3000;
const TIMEOUT_MS = 5000;
/** A stop waits 2 s in the helper before its KILL, plus two process listings. */
const STOP_TIMEOUT_MS = 15_000;

interface Snapshot {
  /** Date.now() when the helper answered. */
  at: number;
  /** When the fetch was asked for: everything that started before then is in it. */
  asked: number;
  trees: Map<number, Descendant[] | null>;
}

class DistroProcs {
  snapshot: Snapshot | null = null;
  roots = new Map<number, number>(); // root pid -> last asked (ms); roots not asked for a minute are dropped
  #fetching: Promise<void> | null = null;
  #again = false;

  constructor(readonly distro: string) {}

  fetch(): Promise<void> {
    if (this.#fetching) {
      this.#again = true;
      return this.#fetching;
    }
    const run = async () => {
      do {
        this.#again = false;
        await this.#once();
      } while (this.#again);
    };
    this.#fetching = run().finally(() => (this.#fetching = null));
    return this.#fetching;
  }

  async #once(): Promise<void> {
    const now = Date.now();
    for (const [root, at] of [...this.roots]) if (now - at > 60_000) this.roots.delete(root);
    const roots = [...this.roots.keys()].slice(0, 64);
    const host = peekWslHost(this.distro);
    if (!roots.length || !host || host.state !== 'ready') return;
    try {
      const answer = await host.call('proc.tree', { roots }, { timeoutMs: TIMEOUT_MS });
      const trees = new Map<number, Descendant[] | null>();
      const at = Date.now();
      for (const root of roots) {
        const rows = answer.trees?.[String(root)];
        // ages back from when the snapshot was asked for, not answered: a start time is never later than the real one (the turn's
        // processes, Connection #noteTurnProcesses, are the ones started before the turn, to the hundredth of a second)
        const asked = now / 1000;
        trees.set(
          root,
          Array.isArray(rows)
            ? rows.map(([pid, parentPid, depth, age]) => ({ pid, parentPid, depth, started: typeof age === 'number' ? asked - age : null }))
            : null,
        );
      }
      this.snapshot = { at, asked: now, trees };
    } catch {
      this.snapshot = null; // the helper is away or lacks proc.tree: unknown until it answers again
    }
  }
}

const distros = new Map<string, DistroProcs>();

function of(distro: string): DistroProcs {
  const key = distro.toLowerCase();
  let d = distros.get(key);
  if (!d) distros.set(key, d = new DistroProcs(key));
  return d;
}

/**
 * The processes below `root` (a Linux pid) in `distro` from a snapshot at most FRESH_MS old, or null (then a new one is fetched).
 * `since` (ms): the snapshot must have been asked for after then (a command that started a moment ago must be in it).
 */
export function wslDescendants(distro: string, root: number, since = 0): Descendant[] | null {
  if (!Number.isInteger(root) || root <= 0) return null;
  const d = of(distro);
  const now = Date.now();
  const known = d.roots.has(root);
  d.roots.set(root, now);
  const snap = d.snapshot;
  if (known && snap && now - snap.at < FRESH_MS && snap.asked >= since && snap.trees.has(root)) return snap.trees.get(root) ?? null;
  void d.fetch();
  return null;
}

/** Fetch a new snapshot for `root` now and resolve once it is in (or the helper did not answer). Never rejects. */
export async function refreshWslDescendants(distro: string, root: number): Promise<void> {
  if (!Number.isInteger(root) || root <= 0) return;
  const d = of(distro);
  d.roots.set(root, Date.now());
  await d.fetch().catch(() => {});
}

/**
 * Stop on a WSL chat's background row (acp/connection.ts stopBackgroundTool): the distro's helper runs platform/kill_verified.ts on
 * `targets` below the agent `root` (`proc.stop`: each still `root`'s descendant with the same start time, then what they started, TERM
 * and KILL after a grace). Start times go as ages (seconds before now), so a Windows clock that differs from the distro's never makes a
 * process look like another one. Null when the processes cannot be listed (the helper is away, too old, or `ps` failed); never
 * starts a distro.
 */
export async function wslKillVerified(distro: string, root: number, targets: ProcId[]): Promise<KillResult | null> {
  const host = peekWslHost(distro);
  if (!host || host.state !== 'ready') return null;
  try {
    const now = Date.now() / 1000;
    const answer = await host.call('proc.stop', { root, targets: targets.map((t) => [t.pid, Math.max(0, now - t.started)]) }, {
      timeoutMs: STOP_TIMEOUT_MS,
    });
    if (!answer.listed) return null;
    const at = Date.now() / 1000;
    return { killed: answer.killed.map(([pid, age]) => ({ pid, started: at - age })), skipped: answer.skipped };
  } catch {
    return null;
  } finally {
    void refreshWslDescendants(distro, root); // the busy list sees the processes gone at the next snapshot, not FRESH_MS later
  }
}

/** Tests: forget every snapshot. */
export function resetWslProcs(): void {
  distros.clear();
}
