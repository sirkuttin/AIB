/**
 * One AIB per data folder. Every AIB web server (the desktop app, `serve`, `--in-process`) holds an OS file lock on
 * <data>/desktop.lock for its whole life, taken right after the data folder is resolved (released by the OS if the process dies, so a
 * crash never leaves the folder locked). The file keeps its old name so the released desktop app and this one exclude each other.
 * Next to it the holder writes <data>/aib-owner.json ({pid, mode, port}) and removes it when it quits; it is only read while the
 * lock is held, so a file left by a crash is ignored.
 *
 * A second start on the same folder: a desktop launch whose owner is the desktop app writes <data>/desktop-show.signal and exits
 * quietly (the running app polls for that file, deletes it and shows its window); a desktop launch whose owner is a server shows a
 * native message box and exits with code 2; a `serve`/`--in-process` start prints one line and exits with code 2. The agent host
 * and the commands that talk to a running AIB (--stop-host, deploy, mcp-artifact, update-helper) never take the lock.
 * No HTTP route is involved (the HTTP API stays identical to Python's).
 */
import { LockHeld, tryLockNow } from '../platform/lock.ts';
import { processAlive } from '../platform/process_info.ts';

export const LOCK_FILE = 'desktop.lock';
export const OWNER_FILE = 'aib-owner.json';
export const SIGNAL_FILE = 'desktop-show.signal';
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

export type Mode = 'desktop' | 'server';
export interface OwnerInfo {
  pid: number;
  mode: Mode;
  port: number | null;
}

export interface Held {
  primary: true;
  lock: Deno.FsFile;
  /** Records the port the server listens on in the owner file. */
  setPort(port: number): Promise<void>;
  /** Removes the owner file (if still ours) and drops the lock; the process exiting drops the lock too. */
  release(): void;
}
export type Claim = Held | { primary: false; owner: OwnerInfo | null };

const ownerPath = (stateDir: string) => `${stateDir}${SEP}${OWNER_FILE}`;

async function writeOwner(stateDir: string, info: OwnerInfo): Promise<void> {
  const tmp = `${ownerPath(stateDir)}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify({ ...info, at: Date.now() }));
  await Deno.rename(tmp, ownerPath(stateDir));
}

/** The owner file as written by the lock holder; null when missing or unreadable. Never trusted without a held lock. */
export async function readOwner(stateDir: string): Promise<OwnerInfo | null> {
  try {
    const raw = JSON.parse(await Deno.readTextFile(ownerPath(stateDir)));
    if (!Number.isInteger(raw?.pid) || (raw.mode !== 'desktop' && raw.mode !== 'server')) return null;
    return { pid: raw.pid, mode: raw.mode, port: Number.isInteger(raw.port) ? raw.port : null };
  } catch {
    return null;
  }
}

/** False only when the process is known to be gone. */
function alive(pid: number): boolean {
  if (Deno.build.os === 'windows') return processAlive(pid) !== false;
  try {
    return new Deno.Command('kill', { args: ['-0', String(pid)], stdout: 'null', stderr: 'null' }).outputSync().success;
  } catch {
    return true;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ClaimOptions {
  mode?: Mode;
  port?: number | null;
  /** How long to keep trying while the named holder is exiting (an update or `deploy` restart starts the new copy right after). */
  exitWaitMs?: number;
  isAlive?: (pid: number) => boolean;
}

/** Takes the data folder's lock, or reports who holds it. Does nothing to the holder. */
export async function claimFolder(stateDir: string, o: ClaimOptions = {}): Promise<Claim> {
  const path = `${stateDir}${SEP}${LOCK_FILE}`;
  const isAlive = o.isAlive ?? alive;
  const deadline = performance.now() + (o.exitWaitMs ?? 10_000);
  for (let attempt = 0;; attempt++) {
    try {
      const lock = await tryLockNow(path);
      const info: OwnerInfo = { pid: Deno.pid, mode: o.mode ?? 'desktop', port: o.port ?? null };
      try {
        await writeOwner(stateDir, info);
      } catch { /* the lock is what counts; the file only names the owner */ }
      let held = true;
      return {
        primary: true,
        lock,
        async setPort(port) {
          info.port = port;
          if (held) await writeOwner(stateDir, info).catch(() => {});
        },
        release() {
          if (!held) return;
          held = false;
          try {
            if (JSON.parse(Deno.readTextFileSync(ownerPath(stateDir)))?.pid === Deno.pid) Deno.removeSync(ownerPath(stateDir));
          } catch { /* gone already */ }
          try {
            lock.close();
          } catch { /* closed */ }
        },
      };
    } catch (error) {
      if (!(error instanceof LockHeld)) throw error;
    }
    const owner = await readOwner(stateDir);
    // The holder may have just taken the lock and not yet written the file: look again shortly.
    if (!owner && attempt < 5) {
      await sleep(100);
      continue;
    }
    // Keep trying only while the named holder is on its way out (its process is gone, the OS has not let go of the lock yet), or
    // while the file is a crashed holder's and the new holder has not written its own yet.
    if (owner && owner.pid !== Deno.pid && !isAlive(owner.pid) && performance.now() < deadline) {
      await sleep(100);
      continue;
    }
    return { primary: false, owner };
  }
}

/** The desktop app's claim: takes the lock (this is the app) or, if another app holds it, asks that one to show its window. */
export async function claim(stateDir: string): Promise<Claim> {
  const result = await claimFolder(stateDir, { mode: 'desktop' });
  if (!result.primary && result.owner?.mode !== 'server') await signalShow(stateDir);
  return result;
}

/** The one line a refused start prints (and the desktop app's message box shows). */
export function alreadyRunning(stateDir: string, owner: OwnerInfo | null): string {
  const who = !owner
    ? 'another AIB'
    : `pid ${owner.pid}, ${owner.mode === 'desktop' ? 'desktop app' : `server on port ${owner.port ?? 'unknown'}`}`;
  return `AIB is already running for this data folder (${stateDir}, ${who}). Quit it first, or use --state-dir for a separate copy.`;
}

export interface GuardOptions {
  mode: Mode;
  port?: number | null;
  /** Desktop launch refused by a server: an OK-only native message box (resolves when it is closed). */
  notice?: (message: string) => Promise<void>;
  say?: (line: string) => void;
  exit?: (code: number) => never;
  exitWaitMs?: number;
  isAlive?: (pid: number) => boolean;
  /**
   * A tray-only start (the keeper's orphan restart): when the folder is taken, exit quietly (code 0): no window is asked to show and
   * no message box appears. Another AIB is attached to the keeper then, which is all the restart wanted.
   */
  quiet?: boolean;
}

/**
 * The start-up check of every AIB web server: returns the held lock, or ends the process. A desktop launch while the desktop app
 * runs (or an owner that wrote no file: the 0.1.0-beta.1 app): show its window, exit 0. A desktop launch while a server runs:
 * message box, exit 2. A server start while anything runs: one line on stderr, exit 2.
 */
export async function guardDataFolder(stateDir: string, o: GuardOptions): Promise<Held> {
  const exit = o.exit ?? ((code: number) => Deno.exit(code));
  const result = await claimFolder(stateDir, { mode: o.mode, port: o.port, exitWaitMs: o.exitWaitMs, isAlive: o.isAlive });
  if (result.primary) return result;
  if (o.quiet) {
    (o.say ?? console.log)('AIB is already running for this data folder; this tray-only start is not needed.');
    return exit(0);
  }
  if (o.mode === 'desktop' && result.owner?.mode !== 'server') {
    await signalShow(stateDir);
    (o.say ?? console.log)('AIB is already running: its window was asked to show.');
    return exit(0);
  }
  const message = alreadyRunning(stateDir, result.owner);
  (o.say ?? console.error)(message);
  if (o.mode === 'desktop') await (o.notice ?? nativeNotice)(message).catch(() => {});
  return exit(2);
}

/** An OK-only error box. Windows: MessageBoxW on a worker thread (FFI nonblocking); elsewhere the runtime's alert, if any. */
export async function nativeNotice(message: string): Promise<void> {
  if (Deno.build.os === 'windows') {
    const lib = Deno.dlopen('user32.dll', {
      MessageBoxW: { parameters: ['pointer', 'buffer', 'buffer', 'u32'], result: 'i32', nonblocking: true },
    });
    const wide = (s: string) => {
      const a = new Uint16Array(s.length + 1);
      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
      return a;
    };
    const MB_OK = 0x0, MB_ICONERROR = 0x10, MB_SETFOREGROUND = 0x10000, MB_TOPMOST = 0x40000;
    try {
      await lib.symbols.MessageBoxW(null, wide(message), wide('AIB'), MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);
    } finally {
      lib.close();
    }
    return;
  }
  const alert = (globalThis as { alert?: (m: string) => void }).alert;
  if (typeof alert === 'function') alert(message);
}

export async function signalShow(stateDir: string): Promise<void> {
  await Deno.writeTextFile(`${stateDir}${SEP}${SIGNAL_FILE}`, JSON.stringify({ pid: Deno.pid, at: Date.now() }));
}

/** Consumes a waiting signal: true if there was one. */
export async function takeSignal(stateDir: string): Promise<boolean> {
  try {
    await Deno.remove(`${stateDir}${SEP}${SIGNAL_FILE}`);
    return true;
  } catch {
    return false;
  }
}

/** Polls for the signal; returns a stop function. A signal left from before this app started is consumed silently first. */
export async function watchSignal(stateDir: string, onShow: () => void, intervalMs = 400): Promise<() => void> {
  await takeSignal(stateDir);
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (await takeSignal(stateDir)) onShow();
    } finally {
      busy = false;
    }
  }, intervalMs);
  return () => clearInterval(timer);
}
