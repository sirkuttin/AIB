/**
 * Atomic file writes, shared by live sync (sync.ts) and the file editor's save (files/live_files.ts): the bytes go into a new temp file
 * in the target's own folder, are flushed, get the target's mode bits (POSIX and WSL; Windows has none to copy), and are renamed over
 * the target, retried for a moment on Windows while another process has it open. A crash leaves the old file or the new one, never a
 * half-written one; a leftover temp file is swept by its owner (live_files.ts sweeps `.aib-save-*.tmp` when a file opens).
 */
import { dirname, join, WIN } from '../platform/ospath.ts';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** state_store.replace_with_retry: os.replace, retried for a moment on Windows while another process has the target open. */
export async function replaceWithRetry(source: string, target: string, tries = 7): Promise<void> {
  let pause = 20;
  for (let attempt = 0;; attempt++) {
    try {
      Deno.renameSync(source, target);
      return;
    } catch (error) {
      const transient = WIN && (error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.Busy);
      if (!transient || attempt >= tries) throw error;
      await sleep(pause);
      pause = Math.min(pause * 2, 400);
    }
  }
}

/** tempfile.mkstemp(prefix, suffix='.tmp', dir=folder): a new, empty file. */
export function mkstemp(folder: string, prefix = '.studio-sync-'): string {
  for (let attempt = 0;; attempt++) {
    const name = join(folder, `${prefix}${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}.tmp`);
    try {
      Deno.openSync(name, { write: true, createNew: true, mode: 0o600 }).close();
      return name;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists) || attempt > 50) throw error;
    }
  }
}

/** shutil.copymode: the permission bits (on Windows only the read-only flag, which AIB never sets: nothing to do). */
export function copyMode(source: string, target: string): void {
  if (WIN) return;
  try {
    Deno.chmodSync(target, (Deno.statSync(source).mode ?? 0o644) & 0o7777);
  } catch { /* ignored, as Python's OSError */ }
}

export interface AtomicOptions {
  /** The temp file's name prefix (default '.studio-sync-'; the editor uses '.aib-save-'). */
  prefix?: string;
  /** fsync the temp file before the rename (the editor's saves do; live sync's many small copies don't). */
  flush?: boolean;
  /** Create the folder when it is missing (live sync does; a save into a folder that is gone fails instead). */
  mkdir?: boolean;
}

/** Write `data` over `target` through a temp file in the same folder and a rename. `modeFrom`: whose mode bits the result gets. */
export async function writeAtomicBytes(target: string, data: Uint8Array, modeFrom: string, options: AtomicOptions = {}): Promise<void> {
  const folder = dirname(target);
  if (options.mkdir !== false) Deno.mkdirSync(folder, { recursive: true });
  const temporary = mkstemp(folder, options.prefix);
  try {
    const file = Deno.openSync(temporary, { write: true, truncate: true });
    try {
      let at = 0;
      while (at < data.length) at += file.writeSync(data.subarray(at));
      if (options.flush) file.syncSync();
    } finally {
      file.close();
    }
    copyMode(modeFrom, temporary);
    await replaceWithRetry(temporary, target);
  } catch (error) {
    try {
      Deno.removeSync(temporary);
    } catch { /* gone */ }
    throw error;
  }
}

/** Write `source` over `target` (shutil.copyfile: the bytes, not the times). */
export async function copyAtomic(source: string, target: string): Promise<void> {
  await writeAtomicBytes(target, Deno.readFileSync(source), source);
}

/** Bytes into folder/path through a temp file and a rename (the mode of an existing file is kept). */
export async function writeAtomic(folder: string, path: string, data: Uint8Array): Promise<void> {
  const target = join(folder, path);
  await writeAtomicBytes(target, data, target);
}
