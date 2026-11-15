/**
 * The processes below a WSL chat's agent, for its busy-children detection (acp/connection.ts backgroundShellsRunning, #markBackground):
 * the agent runs in the distro, so its pid is a Linux pid and Windows' process list knows nothing of it. The distro's helper lists
 * them (`proc.tree`, platform/descendants.ts run natively). Connection asks synchronously (Studio.busyList asks every chat each
 * second), so this keeps the last answer per distro and fetches a new one in the background: a call answers from a snapshot at most
 * FRESH_MS old and otherwise asks for a new one and answers null, which Connection already reads as "cannot be listed" (a shell
 * then keeps counting as running). So a helper that is away, slow or too old never makes a chat look idle while its command runs.
 * A distro that is not running is never started for this.
 */
import type { Descendant } from '../platform/descendants.ts';
import { peekWslHost } from './access.ts';

/** How old a snapshot may be and still answer (ms); a fetch takes one helper round trip. */
export const FRESH_MS = 3000;
const TIMEOUT_MS = 5000;

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
        trees.set(
          root,
          Array.isArray(rows)
            ? rows.map(([pid, parentPid, depth, age]) => ({ pid, parentPid, depth, started: typeof age === 'number' ? at / 1000 - age : null }))
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

/** Tests: forget every snapshot. */
export function resetWslProcs(): void {
  distros.clear();
}
