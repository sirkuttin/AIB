/**
 * Which project folders are gone from the disk. A project whose folder no longer exists (a temp folder a test run made and deleted,
 * an unplugged drive) is left out of the project list; it is not removed or hidden anywhere, so it comes back by itself once the
 * folder exists again. Read-only: this only stats folders, and never writes or deletes anything.
 *
 * Cached: an answer lives for TTL_MS, so the page polling every few seconds costs no stat in between, however many windows ask.
 * Network paths (UNC, mapped shares) are not stat-ed (a dead share can hang for a minute) and count as present.
 */
import { isNetworkPath } from '../web/security.ts';

export const TTL_MS = 30_000;
export const MAX_PATHS = 200;
const MAX_ENTRIES = 5000;

export interface PresenceHooks {
  /** true when the folder is there, false when it is gone, true for any error that is not "not found" (stay visible when unsure). */
  stat: (path: string) => boolean;
  now: () => number;
}

export const defaultHooks: PresenceHooks = {
  stat(path) {
    try {
      return Deno.statSync(path).isDirectory;
    } catch (error) {
      return !(error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory);
    }
  },
  now: () => Date.now(),
};

export class FolderPresence {
  #seen = new Map<string, { gone: boolean; at: number }>();
  /** How many stats were made (tests check the cache with it). */
  stats = 0;

  constructor(readonly hooks: PresenceHooks = defaultHooks, readonly ttl = TTL_MS) {}

  isGone(path: string): boolean {
    if (!path || path.length > 1024 || isNetworkPath(path)) return false;
    const at = this.hooks.now();
    const hit = this.#seen.get(path);
    if (hit && at - hit.at < this.ttl && at >= hit.at) return hit.gone;
    this.stats++;
    const gone = !this.hooks.stat(path);
    if (this.#seen.size >= MAX_ENTRIES) this.#seen.clear();
    this.#seen.set(path, { gone, at });
    return gone;
  }

  /** The folders among `paths` that are gone. */
  gone(paths: unknown): string[] {
    const out: string[] = [];
    for (const p of (Array.isArray(paths) ? paths : []).slice(0, MAX_PATHS)) {
      if (typeof p === 'string' && this.isGone(p)) out.push(p);
    }
    return out;
  }
}

/** The one cache of the running server. */
export const presence = new FolderPresence();
