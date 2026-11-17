/**
 * The crash trail (0.12.1 blocker, 2026-11-17: the desktop app exited silently, nothing in studio.log, no Windows crash event).
 * Deno ends the process on an uncaught exception or rejection after printing it to stderr, and the desktop app has no console, so
 * until now such an end left nothing behind. This module makes every end leave a line in <data>/crash.log (and studio.log where the
 * logger still runs):
 *
 *   - uncaught exceptions: logged with their stack, then the process ends as before (exit code 1)
 *   - unhandled promise rejections: logged with their stack; the app keeps running (one orphan promise must never take every
 *     window and chat down)
 *   - Deno.exit(code) and the normal end (unload): the code and who called exit
 *   - worker errors (logWorkerError: the history store worker)
 *   - the desktop app's stderr (Windows): sent to crash.log with SetStdHandle, so whatever the runtime prints there itself (Deno's
 *     own "error: Uncaught" text, a Rust panic, "Deno has panicked") lands in the file
 *   - a heartbeat (crash-run.json, every HEARTBEAT_MS) with RSS and V8 heap use: an end that leaves nothing at all (a V8 out-of-memory
 *     abort, a kill, a native crash) is found at the next start, which logs "the previous run ended without a clean exit" with the
 *     last heartbeat's time and memory; heap use near V8's limit is logged while it happens
 *
 * crash.log is rotated at start (over ROTATE_BYTES: crash.1.log) and while running (the heartbeat, when the runtime's stderr has
 * made it larger than MAX_BYTES). Never throws.
 */
import { getHeapStatistics } from 'node:v8';
import { getLogger } from './log.ts';

const log = getLogger('crash');

export const CRASH_LOG = 'crash.log';
export const CRASH_LOG_OLD = 'crash.1.log';
export const RUN_FILE = 'crash-run.json';
export const HEARTBEAT_MS = 5_000;
/** crash.log is moved to crash.1.log at start once it is this large. */
export const ROTATE_BYTES = 1024 * 1024;
/** ...and while running once it is this large (a chatty stderr). */
export const MAX_BYTES = 8 * 1024 * 1024;
/** Heap use (of V8's limit) worth a warning, logged once per band upwards. */
export const HEAP_WARN = [0.6, 0.75, 0.9];

export interface RunRecord {
  pid: number;
  version: string;
  started: string;
  /** The last heartbeat (ISO time) with the memory then (MB). */
  beat: string;
  rssMb: number;
  heapMb: number;
  heapLimitMb: number;
  /** Set on a known end: the exit code and why. */
  ended?: { at: string; code: number; why: string };
}

export interface CrashTrailOptions {
  stateDir: string;
  version: string;
  /** Send this process's stderr to crash.log (the desktop app on Windows: it has no console to show it). */
  captureStderr?: boolean;
  /** Tests: a shorter heartbeat. */
  heartbeatMs?: number;
}

const sep = Deno.build.os === 'windows' ? '\\' : '/';
let installed: CrashTrail | null = null;

function mb(bytes: number): number {
  return Math.round(bytes / 1048576);
}

function stackOf(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
  try {
    return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** Memory now: RSS, V8 heap used and V8's heap limit (MB). Never throws. */
export function memoryNow(): { rssMb: number; heapMb: number; heapLimitMb: number } {
  let rssMb = 0, heapMb = 0, heapLimitMb = 0;
  try {
    const m = Deno.memoryUsage();
    rssMb = mb(m.rss);
    heapMb = mb(m.heapUsed);
  } catch { /* no memory info */ }
  try {
    heapLimitMb = mb(getHeapStatistics().heap_size_limit);
  } catch { /* no heap statistics */ }
  return { rssMb, heapMb, heapLimitMb };
}

export class CrashTrail {
  readonly file: string;
  readonly runFile: string;
  readonly record: RunRecord;
  /** What the start found about the previous run ('' when it ended cleanly or there was none). */
  readonly previous: string;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stderr: Deno.PointerObject | null = null;
  #heapBand = 0;
  #ended = false;

  constructor(readonly options: CrashTrailOptions) {
    this.file = options.stateDir + sep + CRASH_LOG;
    this.runFile = options.stateDir + sep + RUN_FILE;
    this.#rotate(ROTATE_BYTES);
    const now = new Date().toISOString();
    this.record = { pid: Deno.pid, version: options.version, started: now, beat: now, ...memoryNow() };
    this.previous = this.#checkPrevious();
    this.line(`run start: AIB ${options.version}, pid ${Deno.pid}, heap limit ${this.record.heapLimitMb} MB`);
    if (this.previous) {
      this.line(this.previous);
      log.warning('%s', this.previous);
    }
    this.#writeRun();
  }

  /** One line in crash.log, written at once (it may be the last thing this process does). Never throws. */
  line(text: string): void {
    try {
      Deno.writeTextFileSync(this.file, `${new Date().toISOString()} pid ${Deno.pid}: ${text}\n`, { append: true });
    } catch { /* the data folder is gone or unwritable */ }
  }

  /** A known end: the code and why go in crash.log and the run file (the next start then finds a clean end). */
  ended(code: number, why: string): void {
    if (this.#ended) return;
    this.#ended = true;
    const m = memoryNow();
    this.line(`run end: exit code ${code} (${why}); rss ${m.rssMb} MB, heap ${m.heapMb} of ${m.heapLimitMb} MB`);
    this.record.ended = { at: new Date().toISOString(), code, why };
    Object.assign(this.record, m);
    this.#writeRun();
  }

  #checkPrevious(): string {
    let prev: RunRecord | null = null;
    try {
      prev = JSON.parse(Deno.readTextFileSync(this.runFile)) as RunRecord;
    } catch {
      return '';
    }
    if (!prev || typeof prev.pid !== 'number' || prev.ended || prev.pid === Deno.pid) return '';
    return `the previous run (AIB ${prev.version}, pid ${prev.pid}, started ${prev.started}) ended without a clean exit (a crash, ` +
      `an out-of-memory abort or a kill); its last sign of life was ${prev.beat}, with rss ${prev.rssMb} MB and heap ${prev.heapMb} of ` +
      `${prev.heapLimitMb} MB. Anything it printed is in ${CRASH_LOG} (or ${CRASH_LOG_OLD}).`;
  }

  #writeRun(): void {
    try {
      Deno.writeTextFileSync(this.runFile, JSON.stringify(this.record));
    } catch { /* unwritable */ }
  }

  #rotate(limit: number): boolean {
    try {
      if (Deno.statSync(this.file).size < limit) return false;
      Deno.renameSync(this.file, this.options.stateDir + sep + CRASH_LOG_OLD);
      return true;
    } catch {
      return false;
    }
  }

  /** Windows: this process's stderr into crash.log (appended; the runtime's own writes read the handle each time). */
  captureStderr(): boolean {
    const handle = stderrFile?.stderrToFile(this.file) ?? null;
    if (!handle) return false;
    const old = this.#stderr;
    this.#stderr = handle;
    if (old) stderrFile?.closeStderrFile(old);
    return true;
  }

  /** The heartbeat: memory in the run file; heap use near the limit logged; crash.log rotated when stderr made it large. */
  beat(): void {
    const m = memoryNow();
    Object.assign(this.record, m, { beat: new Date().toISOString() });
    this.#writeRun();
    const share = m.heapLimitMb ? m.heapMb / m.heapLimitMb : 0;
    const band = HEAP_WARN.filter((w) => share >= w).length;
    if (band > this.#heapBand) {
      const text = `memory: V8 heap ${m.heapMb} MB of its ${m.heapLimitMb} MB limit (${Math.round(share * 100)}%), rss ${m.rssMb} MB`;
      this.line(text);
      log.warning('%s', text);
    }
    this.#heapBand = band;
    if (this.#stderr && this.#rotate(MAX_BYTES)) {
      this.captureStderr();
      this.line('crash.log rotated (stderr was large)');
    }
  }

  start(): void {
    if (this.#timer !== null) return;
    const timer = setInterval(() => this.beat(), this.options.heartbeatMs ?? HEARTBEAT_MS);
    Deno.unrefTimer(timer);
    this.#timer = timer;
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}

/** platform/stderr_file.ts (FFI lives in platform/), loaded only when stderr is captured. */
let stderrFile: typeof import('../platform/stderr_file.ts') | null = null;

/**
 * Installs the crash trail once for this process (the app's main: after logging is set up, after the hidden console). Returns it
 * (the same one on a second call).
 */
export async function installCrashTrail(options: CrashTrailOptions): Promise<CrashTrail> {
  if (installed) return installed;
  if (Deno.build.os === 'windows' && options.captureStderr) {
    try {
      stderrFile = await import('../platform/stderr_file.ts');
    } catch { /* no FFI */ }
  }
  const trail = installed = new CrashTrail(options);
  if (options.captureStderr && trail.captureStderr()) trail.line(`stderr now goes to ${CRASH_LOG}`);
  globalThis.addEventListener('error', (e: ErrorEvent) => {
    const text = `uncaught exception (AIB ends): ${stackOf(e.error ?? e.message)}`;
    trail.line(text);
    try {
      log.critical('%s', text);
    } catch { /* logging is gone */ }
    trail.ended(1, 'uncaught exception');
  });
  globalThis.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    e.preventDefault(); // logged, and AIB keeps running: one orphan promise must not end every window and chat
    const text = `unhandled promise rejection (AIB keeps running): ${stackOf(e.reason)}`;
    trail.line(text);
    try {
      log.error('%s', text);
    } catch { /* logging is gone */ }
  });
  globalThis.addEventListener('unload', () => trail.ended(Deno.exitCode, 'the event loop ended'));
  const exit = Deno.exit;
  try {
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = (code?: number): never => {
      const caller = (new Error().stack ?? '').split('\n').slice(2, 5).map((s) => s.trim()).join(' < ');
      trail.ended(code ?? Deno.exitCode, `Deno.exit from ${caller}`);
      return exit(code);
    };
  } catch { /* not writable here */ }
  trail.start();
  return trail;
}

/** The crash trail of this process, or null (tests, the agent host, before main installed it). */
export function crashTrail(): CrashTrail | null {
  return installed;
}

/** A worker's error (it may have died with it): in studio.log and crash.log. */
export function logWorkerError(worker: string, e: ErrorEvent | Event): void {
  const ee = e as ErrorEvent;
  const where = ee.filename ? ` at ${ee.filename}:${ee.lineno}:${ee.colno}` : '';
  const text = `worker ${worker}: ${e.type === 'messageerror' ? 'a message could not be read' : 'error'}: ${
    stackOf(ee.error ?? ee.message ?? e.type)
  }${where}`;
  try {
    log.error('%s', text);
  } catch { /* logging is gone */ }
  installed?.line(text);
}
