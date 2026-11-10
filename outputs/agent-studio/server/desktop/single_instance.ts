/**
 * One desktop app per data folder. The running app holds an OS file lock on <data>/desktop.lock for its whole life (released by the
 * OS if it crashes). A second launch that can't take the lock writes <data>/desktop-show.signal and exits; the running app polls
 * for that file, deletes it and shows its window. No HTTP route is involved (the HTTP API stays identical to Python's).
 */
import { LockHeld, tryLockNow } from '../platform/lock.ts';

export const LOCK_FILE = 'desktop.lock';
export const SIGNAL_FILE = 'desktop-show.signal';
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

export type Claim = { primary: true; lock: Deno.FsFile } | { primary: false };

/** Takes the lock (this is the app) or, if another app holds it, asks that one to show its window. */
export async function claim(stateDir: string): Promise<Claim> {
  try {
    const lock = await tryLockNow(`${stateDir}${SEP}${LOCK_FILE}`);
    return { primary: true, lock };
  } catch (error) {
    if (!(error instanceof LockHeld)) throw error;
    await signalShow(stateDir);
    return { primary: false };
  }
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
