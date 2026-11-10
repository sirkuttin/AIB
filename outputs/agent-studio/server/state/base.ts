/**
 * JsonFileStore (state_store.JsonFileStore): shared plumbing for the stores that keep one JSON file in the state folder.
 *
 * Every update holds the cross-process lock '<file>.lock' (server/platform/lock.ts, interoperable with Python's msvcrt/flock
 * lock) for the whole reload -> modify -> save, so a Python and a Deno process on the same folder never lose each other's
 * changes. Acquiring the lock is the only await: once it is held the reload, the change and the atomic save run synchronously,
 * and an in-process queue keeps two updates of the same store from interleaving (Python's threading.RLock).
 * A file that could not be read (as opposed to one that is corrupt) is never overwritten.
 */
import { FileLock, LockTimeout } from '../platform/lock.ts';
import { basename } from '../platform/path.ts';
import { ValueError } from '../core/py.ts';
import { fileStamp } from './json.ts';

export { FileLock, LOCK_TIMEOUT_MS, LockTimeout } from '../platform/lock.ts';

export const VERSION = 1;

/** Python's OSError: what a failed save raises inside a store (turned into a ValueError 'could not save' by the callers). */
export class OSError extends Error {
  override name = 'OSError';
}

const DENO_ERRORS = Object.values(Deno.errors) as (new (...args: never[]) => Error)[];

/** True for errors Python would raise as OSError (file system and lock errors). */
export function isOSError(error: unknown): error is Error {
  return error instanceof OSError || error instanceof LockTimeout || DENO_ERRORS.some((type) => error instanceof type);
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** os.urandom(3).hex() */
export function nonce(): string {
  return [...crypto.getRandomValues(new Uint8Array(3))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Directory + file name with one separator. */
export function inDir(directory: string, name: string): string {
  return `${directory.replace(/[\\/]+$/, '')}${Deno.build.os === 'windows' ? '\\' : '/'}${name}`;
}

export abstract class JsonFileStore {
  path: string | null = null;
  warning = '';
  protected unreadable = false;
  protected seen: string | null = null; // file stamp as last read or written by this process
  protected counter = 0;
  protected readonly nonce = nonce();
  #queue: Promise<unknown> = Promise.resolve();

  protected abstract reload(): void;

  /** Pick up changes written by another Studio (Python or Deno); costs one stat() when nothing changed. */
  protected sync(): void {
    if (this.path !== null && fileStamp(this.path) !== this.seen) this.reload();
  }

  protected stamp(): string | null {
    return this.path === null ? null : fileStamp(this.path);
  }

  revision(): string {
    this.sync();
    return `${this.nonce}.${this.counter}`;
  }

  protected requireReadable(): void {
    if (this.unreadable) throw new OSError('the saved file could not be read just now, so it was left untouched; try again');
  }

  protected unreadableNow(message: string): void {
    this.unreadable = true;
    this.warning = message;
    this.seen = null; // forces a fresh read attempt on the next sync
  }

  /**
   * Run `work` (synchronous) holding this store's in-process queue and the cross-process file lock. A lock that cannot be had
   * in time becomes ValueError('Studio could not save: ...'), which every caller already reports.
   */
  protected locked<T>(work: () => T): Promise<T> {
    const run = this.#queue.then(async () => {
      let lock: FileLock | null = null;
      if (this.path !== null) {
        lock = new FileLock(this.path + '.lock');
        try {
          await lock.acquire();
        } catch (error) {
          if (error instanceof LockTimeout) {
            throw new ValueError(`Studio could not save: Timed out waiting for the state file lock (${basename(this.path)}.lock)`);
          }
          throw new ValueError(`Studio could not save: ${errorText(error)}`);
        }
      }
      try {
        return work();
      } finally {
        lock?.release();
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}

/** Deep equality of plain JSON values (dict key order ignored, as Python's ==). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b); // the same float object: Python's == is True by identity
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameJson(v, b[i]));
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !sameJson(v, b.get(k))) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length &&
    ka.every((k) =>
      Object.prototype.hasOwnProperty.call(b, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
    );
}

/** copy.deepcopy of plain JSON values and Maps (own '__proto__' keys kept as data). */
export function deepCopy<T>(value: T): T {
  if (Array.isArray(value)) return value.map(deepCopy) as T;
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, deepCopy(v)])) as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      Object.defineProperty(out, k, { value: deepCopy(v), writable: true, enumerable: true, configurable: true });
    }
    return out as T;
  }
  return value;
}
