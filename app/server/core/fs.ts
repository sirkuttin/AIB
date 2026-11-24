/**
 * File helpers shared by the stores in the state folder.
 *
 * writeJsonAtomic replaces a JSON file so a reader (this process, or a Python process sharing the folder during the transition)
 * only ever sees the old file or the complete new one: write a temp file in the same folder, fsync it, then rename it over the
 * target (Python: tempfile.mkstemp + os.fsync + os.replace). It is synchronous on purpose: the Python stores save under a lock
 * and their callers rely on the file being on disk when the call returns.
 */

export interface AtomicWriteOptions {
  /** Temp file name prefix (Python's mkstemp prefix), e.g. '.studio-queues-'. */
  prefix?: string;
  /** Temp file name suffix. */
  suffix?: string;
  /** Text to write instead of JSON.stringify(value) (for callers that need their own layout). */
  text?: string;
}

/**
 * On Windows a rename over a file another process has open (a reader, an antivirus scan) fails for a moment. Retried as
 * state_store.replace_with_retry does: 8 attempts, pausing 20 ms, doubled each time up to 400 ms (about 1.4 s in all).
 */
const RENAME_ATTEMPTS = 8;
const RENAME_FIRST_PAUSE_MS = 20;
const RENAME_MAX_PAUSE_MS = 400;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function transient(error: unknown): boolean {
  return Deno.build.os === 'windows' && (error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.Busy);
}

function randomName(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

/** Write `value` as compact JSON (or options.text) to `path` atomically. Creates the folder. Throws Deno's I/O errors. */
export function writeJsonAtomic(path: string, value: unknown, options: AtomicWriteOptions = {}): void {
  const text = options.text ?? JSON.stringify(value);
  const separator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const directory = separator >= 0 ? path.slice(0, separator) || path.slice(0, 1) : '.';
  Deno.mkdirSync(directory, { recursive: true });
  const data = new TextEncoder().encode(text);
  let temporary = '';
  let file: Deno.FsFile | null = null;
  for (let attempt = 0; file === null; attempt++) {
    temporary = `${directory}/${options.prefix ?? '.tmp-'}${randomName()}${options.suffix ?? '.tmp'}`;
    try {
      file = Deno.openSync(temporary, { write: true, createNew: true, mode: 0o600 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists) || attempt > 10) throw error;
    }
  }
  try {
    try {
      let written = 0;
      while (written < data.length) written += file.writeSync(data.subarray(written));
      file.syncSync();
    } finally {
      file.close();
    }
    let pause = RENAME_FIRST_PAUSE_MS;
    for (let attempt = 0;; attempt++) {
      try {
        Deno.renameSync(temporary, path);
        return;
      } catch (error) {
        if (!transient(error) || attempt >= RENAME_ATTEMPTS - 1) throw error;
        sleepSync(pause);
        pause = Math.min(pause * 2, RENAME_MAX_PAUSE_MS);
      }
    }
  } catch (error) {
    try {
      Deno.removeSync(temporary);
    } catch { /* already gone */ }
    throw error;
  }
}
