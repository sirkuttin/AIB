/**
 * Cross-process advisory file locks, compatible with the Python server's (state_store.FileLock and ownership.SessionLease use
 * msvcrt.locking on byte 0 on Windows and flock elsewhere). Deno's FsFile.tryLock is LockFileEx over the whole file on Windows and
 * flock elsewhere, so a Deno holder and a Python holder exclude each other; work/deno/platform_test.ts checks both directions.
 * Python writes one NUL byte into an empty lock file on Windows (msvcrt cannot lock past the end); this does the same.
 */
import { dirname } from './path.ts';

export class LockTimeout extends Error {}
export class LockHeld extends Error {}

export const LOCK_TIMEOUT_MS = 10_000; // state_store.LOCK_TIMEOUT: a crashed holder cannot block longer than this

async function openForLock(path: string, create: boolean): Promise<Deno.FsFile> {
  if (create) await Deno.mkdir(dirname(path), { recursive: true });
  const file = await Deno.open(path, create ? { read: true, append: true, create: true } : { read: true, write: true });
  try {
    if (create && Deno.build.os === 'windows' && (await file.stat()).size === 0) await file.write(new Uint8Array(1));
  } catch (error) {
    file.close();
    throw error;
  }
  return file;
}

/** Waits up to timeoutMs for an exclusive lock (state_store.FileLock). */
export class FileLock {
  #file: Deno.FsFile | null = null;
  constructor(readonly path: string, readonly timeoutMs = LOCK_TIMEOUT_MS) {}

  async acquire(): Promise<this> {
    const file = await openForLock(this.path, true);
    const deadline = performance.now() + this.timeoutMs;
    try {
      while (!(await file.tryLock(true))) {
        if (performance.now() >= deadline) throw new LockTimeout(`Timed out waiting for the state file lock (${this.path})`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } catch (error) {
      file.close();
      throw error;
    }
    this.#file = file;
    return this;
  }

  release(): void {
    const file = this.#file;
    this.#file = null;
    if (!file) return;
    try {
      file.unlockSync();
    } catch { /* closing releases it too */ }
    file.close();
  }

  async run<T>(work: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }
}

/** Takes the lock now or throws LockHeld (ownership.SessionLease). create=false only opens an existing file. */
export async function tryLockNow(path: string, create = true): Promise<Deno.FsFile> {
  const file = await openForLock(path, create);
  if (await file.tryLock(true)) return file;
  file.close();
  throw new LockHeld(`${path} is locked by another process`);
}
