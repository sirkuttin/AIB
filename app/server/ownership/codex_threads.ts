/**
 * Open elsewhere for Codex chats (aib-shared/designs/open-elsewhere/research.md, section 4; handoff.ts): who else has a Codex thread open.
 *
 * Codex (0.166, codex-rs/rollout/src/writer_lock.rs) lets one process write a thread at a time: the writer holds an exclusive OS lock
 * on `<CODEX_HOME>/thread-writer-locks/<threadId>.lock` while the thread is loaded, and a second opener is refused ("thread <id>
 * already has an active writer"; the TUI and the VS Code / Codex Desktop apps show "This conversation is open in another app" with
 * Retry). The refusal writes nothing anywhere, so AIB cannot see an app-server client (VS Code, Codex Desktop) try. What it can see:
 *
 *   - a Codex CLI process whose command line names the thread (`codex resume <id>`, `codex exec resume <id>`, `codex fork <id>`):
 *     the TUI stays open on its "open in another app, r to retry" card, so it is there to be seen (cliHolder);
 *   - whether the thread's writer lock is held right now (writerLockState), read without taking a lock (a plain read of the lock
 *     file: Windows refuses it while another handle holds the lock; Linux: /proc/locks names the flock and its pid), so AIB never
 *     races Codex for it. A crashed writer's file stays behind unlocked: it reads as free.
 *
 * Read-only: nothing here opens a lock file for writing, locks it or deletes it.
 */
import { join, WIN } from '../platform/ospath.ts';
import { processList, processStrings } from '../platform/process_info.ts';
import type { Holder } from './claude_sessions.ts';

/** Codex thread ids are UUIDs (v7 today). */
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(value: unknown): value is string {
  return typeof value === 'string' && THREAD_ID_RE.test(value);
}

/** The writer lock file of a thread in a Codex home. */
export function writerLockPath(codexHome: string, threadId: string): string {
  return join(codexHome, 'thread-writer-locks', `${threadId}.lock`);
}

export type LockState = { state: 'free' } | { state: 'held'; pid: number } | { state: 'unknown' };

/** The Windows answer to reading a byte range another handle holds with LockFileEx: ERROR_LOCK_VIOLATION (33). */
function lockViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'EBUSY' || /\(os error 33\)/.test(error.message) || error instanceof Deno.errors.Busy;
}

/** Linux: the pid of a FLOCK WRITE lock on `inode` in /proc/locks; 0 when none; null when /proc/locks cannot be read. */
export function procLocksHolder(text: string, inode: number): number {
  for (const line of text.split('\n')) {
    // "1: FLOCK  ADVISORY  WRITE 12345 00:2a:56789 0 EOF" (a blocked waiter's line has "->" after the number)
    const m = /^\d+:\s+FLOCK\s+\S+\s+WRITE\s+(\d+)\s+[0-9a-f]+:[0-9a-f]+:(\d+)\s/i.exec(line.trim());
    if (m && Number(m[2]) === inode) return Number(m[1]);
  }
  return 0;
}

/**
 * Whether the thread's writer lock is held now. 'free': no lock file, or a file nobody locks (a crashed writer left it).
 * 'unknown': the platform cannot tell (macOS) or the file cannot be read for another reason. Never takes the lock.
 */
export function writerLockState(path: string): LockState {
  let info: Deno.FileInfo;
  try {
    info = Deno.statSync(path);
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? { state: 'free' } : { state: 'unknown' };
  }
  if (WIN) {
    let file: Deno.FsFile | null = null;
    try {
      file = Deno.openSync(path, { read: true });
      file.readSync(new Uint8Array(1)); // an empty, unlocked file reads 0 bytes; a locked one refuses the read
      return { state: 'free' };
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return { state: 'free' };
      return lockViolation(error) ? { state: 'held', pid: 0 } : { state: 'unknown' };
    } finally {
      try {
        file?.close();
      } catch { /* closed */ }
    }
  }
  if (Deno.build.os === 'linux' && info.ino) {
    try {
      const pid = procLocksHolder(Deno.readTextFileSync('/proc/locks'), info.ino);
      return pid ? { state: 'held', pid } : { state: 'free' };
    } catch {
      return { state: 'unknown' };
    }
  }
  return { state: 'unknown' };
}

export interface CodexProcess {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string;
  /** Only on `codex app-server` rows (codex_apps.ts): an opaque start token; with the pid it names one process, never a reused pid. */
  start?: string;
}

/** A Codex CLI process: codex.exe / codex, or node running the npm package's codex.js (it starts codex.exe with the same arguments). */
export function isCodexCli(proc: { name: string; cmdline: string }): boolean {
  const name = proc.name.replaceAll('\\', '/').split('/').pop()!.toLowerCase();
  if (name === 'codex.exe' || name === 'codex') return true;
  return (name === 'node.exe' || name === 'node') && /[\\/]codex(\.js)?["']?(\s|$)/i.test(proc.cmdline);
}

/** The process list with command lines of Codex-looking processes only (Windows: one Toolhelp snapshot, PEB reads for codex/node). */
export function codexProcesses(): CodexProcess[] {
  const out: CodexProcess[] = [];
  if (WIN) {
    for (const entry of processList()) {
      const low = entry.exe.toLowerCase();
      if (low !== 'codex.exe' && low !== 'node.exe') continue;
      const strings = processStrings(entry.pid);
      const cmdline = strings?.commandLine ?? '';
      if (cmdline) out.push({ pid: entry.pid, ppid: entry.parentPid, name: entry.exe, cmdline });
    }
    return out;
  }
  if (Deno.build.os !== 'linux') return out;
  const decoder = new TextDecoder();
  for (const entry of Deno.readDirSync('/proc')) {
    if (!/^\d+$/.test(entry.name)) continue;
    try {
      const raw = Deno.readFileSync(`/proc/${entry.name}/cmdline`);
      const cmdline = decoder.decode(raw).split('\0').filter(Boolean).join(' ');
      if (!/codex/i.test(cmdline)) continue;
      const stat = Deno.readTextFileSync(`/proc/${entry.name}/stat`);
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const name = cmdline.split(' ')[0];
      out.push({ pid: Number(entry.name), ppid, name, cmdline });
    } catch { /* gone, or not ours */ }
  }
  return out;
}

/**
 * The first Codex CLI process (not one of `own`) whose command line names `threadId`, as a Holder ("a terminal": the Codex CLI runs
 * in one); null when there is none. Thread ids are UUIDs, so a command line that names one means that thread.
 */
export function cliHolder(procs: CodexProcess[], threadId: string, own: Set<number>): Holder | null {
  if (!isThreadId(threadId)) return null;
  const id = threadId.toLowerCase();
  for (const p of procs) {
    if (own.has(p.pid) || !isCodexCli(p) || !p.cmdline.toLowerCase().includes(id)) continue;
    return { pid: p.pid, entrypoint: 'codex-cli', status: '', app: 'a terminal' };
  }
  return null;
}

/** The error Codex answers a second writer with (thread/resume, so codex-acp's session/load and session/resume). */
export function activeWriterError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error ?? '');
  return /already has an active writer/i.test(text);
}
