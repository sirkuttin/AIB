/**
 * Best-effort, read-only evidence that another client is using a saved conversation (ownership_probe.py).
 *
 * Verdicts (never "safe"):
 *   owned_by_studio  this Studio holds the conversation (authoritative)
 *   owned_elsewhere  strong evidence another client holds it: a live owner announcement, or a native agent process whose command
 *                    line names the session ID
 *   possibly_active  weak evidence only: transcript written moments ago by someone else, a process holding the transcript open, an
 *                    agent process in the same project folder, an expired or unverifiable announcement
 *   no_evidence      nothing was found; this is NOT proof the conversation is free
 *
 * Every signal is read-only. Nothing here writes to transcripts, kills processes or opens a file for writing outside Studio's own
 * announcement files. See docs/ownership-design.md. Everything is synchronous, as in Python (the Windows facts come from FFI in
 * platform/process_info.ts, POSIX from `ps` and /proc), so assess() can be called from a request handler without awaiting.
 */
import { createHash } from 'node:crypto';
import { getLogger } from '../core/log.ts';
import { clip, isDict, PY_SPACE, pyIsPrintable, pyLen, pyStr, pyStrip, pyTruthy } from '../core/py.ts';
import { basename, home, join, normcase, normpath, WIN } from '../platform/ospath.ts';
import {
  processAlive as winProcessAlive,
  processList,
  processStartTime as winProcessStartTime,
  processStrings,
  restartManagerHolders,
} from '../platform/process_info.ts';
import { findExternalOwner, OwnershipConflict, pyInt } from './ownership.ts';

const log = getLogger('ownership_probe');

export const FORMAT_NAME = 'agent-session-owner';
export const FORMAT_VERSION = 1;
export const MAX_ANNOUNCEMENT_BYTES = 4096;
export const DEFAULT_TTL_SECONDS = 30;
export const HEARTBEAT_SECONDS = 10;
export const ACTIVE_WINDOW_SECONDS = 120; // a transcript written this recently counts as weak evidence
export const RECENT_WINDOW_SECONDS = 900; // hint scans look only at transcripts this fresh
export const RELEASE_GRACE_SECONDS = 3.0; // writes this soon after Studio released it are Studio's own
export const SNAPSHOT_TTL_SECONDS = 4.0;
export const HINT_TTL_SECONDS = 3.0;
export const STATE_ORDER: Record<string, number> = { no_evidence: 0, possibly_active: 1, owned_elsewhere: 2, owned_by_studio: 3 };
export const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
export const PROVIDER_RE = /^[a-z0-9_-]{1,32}$/;

export const NO_EVIDENCE_NOTE = 'AIB found no sign of another app using this conversation, but it cannot see every client ' +
  '(for example an idle session open in another app writes nothing). This is not proof that it is free.';

export type Verdict = 'owned_by_studio' | 'owned_elsewhere' | 'possibly_active' | 'no_evidence';

/** Raised when the evidence blocks (code 'session_in_use') or needs confirmation (code 'possibly_active'). */
export class OwnershipEvidence extends OwnershipConflict {
  override name = 'OwnershipEvidence';
  constructor(message: string, readonly code: string, readonly verdict: unknown) {
    super(message);
  }
}

const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, 'g');

/** str(value) for display: an Error gives its message. */
function strOf(value: unknown): string {
  return value instanceof Error ? value.message : pyStr(value);
}

/** Untrusted text for display: control characters removed, length capped (code points). */
export function cleanText(value: unknown, limit = 120): string {
  let text = '';
  for (const ch of strOf(value)) text += pyIsPrintable(ch) ? ch : ' ';
  text = pyStrip(text.replace(SPACE_RUN, ' '));
  return pyLen(text) <= limit ? text : clip(text, limit - 1) + '…';
}

/** Python's round() of a float: half to even. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const rest = value - floor;
  if (rest > 0.5) return floor + 1;
  if (rest < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function humanizeAge(secondsIn: number): string {
  const seconds = Math.max(0, Math.trunc(secondsIn));
  if (seconds < 90) return `${seconds} second` + (seconds === 1 ? '' : 's');
  const minutes = pyRound(seconds / 60);
  if (minutes < 90) return `${minutes} minutes`;
  const hours = pyRound(seconds / 3600);
  return hours < 48 ? `${hours} hours` : `${pyRound(seconds / 86400)} days`;
}

/** Well-known per-user folder for owner announcements (documented in docs/ownership-design.md). */
export function defaultOwnersDir(): string {
  if (WIN) return join(Deno.env.get('LOCALAPPDATA') || join(home(), 'AppData', 'Local'), 'agent-sessions', 'owners');
  return join(Deno.env.get('XDG_STATE_HOME') || join(home(), '.local', 'state'), 'agent-sessions', 'owners');
}

/** '%Y-%m-%dT%H:%M:%SZ' of an epoch time in UTC (fraction dropped after rounding to microseconds, as datetime does). */
export function iso(when: number): string {
  const seconds = Math.floor(Math.round(when * 1e6) / 1e6);
  return new Date(seconds * 1000).toISOString().slice(0, 19) + 'Z';
}

const TIME_COLON = String.raw`(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?`;
const TIME_BASIC = String.raw`(\d{2})(?:(\d{2})(?:(\d{2})(?:[.,](\d+))?)?)?`;
const ISO_RE = new RegExp(
  String.raw`^(\d{4})(-?)(\d{2})\2(\d{2})(?:[\s\S](?:${TIME_COLON}|${TIME_BASIC})(?:([+-])(?:${TIME_COLON}|${TIME_BASIC}))?)?$`,
  'u',
);

/** datetime.fromisoformat(str(value).replace('Z', '+00:00')).timestamp(), naive times taken as UTC; null where Python raises. */
export function parseIso(value: unknown): number | null {
  const text = pyStr(value).replaceAll('Z', '+00:00');
  const m = ISO_RE.exec(text);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[3]), Number(m[4])];
  const pick = (a: number) => (m[a] !== undefined ? m.slice(a, a + 4) : m.slice(a + 4, a + 8));
  const [hh, mm, ss, frac] = pick(5);
  const fraction = (digits: string | undefined) => (digits ? Number(digits.slice(0, 6).padEnd(6, '0')) / 1e6 : 0);
  const hour = Number(hh ?? 0), minute = Number(mm ?? 0), second = Number(ss ?? 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  date.setUTCHours(0, 0, 0, 0);
  let stamp = date.getTime() / 1000 + hour * 3600 + minute * 60 + second + fraction(frac);
  if (m[13]) {
    const [th, tm, ts, tf] = pick(14);
    const offset = Number(th ?? 0) * 3600 + Number(tm ?? 0) * 60 + Number(ts ?? 0) + fraction(tf);
    if (Number(tm ?? 0) > 59 || Number(ts ?? 0) > 59 || offset >= 86400) return null;
    stamp -= m[13] === '-' ? -offset : offset;
  }
  return stamp;
}

// ---------------------------------------------------------------------------------------------
// Process facts. Windows: FFI (platform/process_info.ts). POSIX: os.kill(pid, 0) equivalents; no start times.
// ---------------------------------------------------------------------------------------------

/** Process creation time as epoch seconds, or null (always null off Windows, as in Python). */
export function processStartTime(pid: number): number | null {
  if (!WIN) return null;
  try {
    return winProcessStartTime(pid);
  } catch {
    return null;
  }
}

/** true/false when it can be told, null when unknown. A differing start time means PID reuse. */
export function processAlive(pidIn: unknown, expectedStart: number | null = null): boolean | null {
  const pid = pyInt(pidIn);
  if (pid === null) return null;
  if (pid <= 0) return false;
  if (WIN) {
    try {
      return winProcessAlive(pid, expectedStart);
    } catch {
      return null;
    }
  }
  // os.kill(pid, 0): Deno.kill takes no signal 0. /proc/<pid> answers the same question on Linux; elsewhere ask `kill -0`.
  try {
    if (Deno.statSync('/proc').isDirectory) {
      try {
        Deno.statSync(`/proc/${pid}`);
        return true;
      } catch (error) {
        return error instanceof Deno.errors.NotFound ? false : null;
      }
    }
  } catch { /* no /proc */ }
  try {
    const done = new Deno.Command('/bin/sh', {
      args: ['-c', 'kill -0 "$1"', 'sh', String(pid)],
      stdin: 'null',
      stdout: 'null',
      stderr: 'piped',
    })
      .outputSync();
    if (done.success) return true;
    return /no such process/i.test(new TextDecoder().decode(done.stderr)) ? false : null;
  } catch {
    return null;
  }
}

/** [[pid, app name]] of processes that hold `path` open (Windows Restart Manager); null when unavailable (always off Windows). */
export function lockHolders(path: string): [number, string][] | null {
  if (!WIN) return null;
  try {
    return restartManagerHolders(String(path));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Process snapshot (cached) and classification of agent clients
// ---------------------------------------------------------------------------------------------
export interface ProcInfo {
  pid: number;
  ppid: number;
  name: string;
  cmdline: string | null;
  cwd: string | null;
}

const INTERESTING = new Set(['claude.exe', 'omp.exe', 'node.exe', 'devin.exe', 'claude', 'omp', 'node', 'devin']);
const PARENT_LABELS: Record<string, string> = {
  'devin.exe': 'Devin',
  'code.exe': 'VS Code',
  'claude.exe': 'Claude app or CLI',
  'windowsterminal.exe': 'a terminal',
  'cmd.exe': 'a terminal',
  'powershell.exe': 'a terminal',
  'pwsh.exe': 'a terminal',
  'python.exe': 'a Python program (possibly another AIB)',
  'pythonw.exe': 'a Python program (possibly another AIB)',
  'cursor.exe': 'Cursor',
  'windsurf.exe': 'Windsurf',
};

/** What a `ps` run returns (subprocess.run's returncode and stdout). Throws when the program cannot run or times out. */
export interface RunResult {
  returncode: number;
  stdout: Uint8Array | string;
}
export type Runner = (argv: string[]) => RunResult;

function defaultRun(argv: string[]): RunResult {
  // Deno has no timeout for a synchronous run; `ps` returns at once on every system it exists on.
  const done = new Deno.Command(argv[0], { args: argv.slice(1), stdin: 'null', stdout: 'piped', stderr: 'null' }).outputSync();
  return { returncode: done.code, stdout: done.stdout };
}

/** Lines of `ps -axww -o <columns>`; throws when ps is missing, fails or times out (never returns a guess). */
function psLines(run: Runner, columns: string): string[] {
  let done: RunResult;
  try {
    done = run(['ps', '-axww', '-o', columns]);
  } catch (error) {
    throw new Error('ps is not available: ' + cleanText(error));
  }
  if (done.returncode !== 0) throw new Error('ps failed');
  const out = done.stdout;
  const text = typeof out === 'string' ? out : new TextDecoder().decode(out ?? new Uint8Array());
  return splitLines(text);
}

/** str.splitlines() */
function splitLines(text: string): string[] {
  // deno-lint-ignore no-control-regex
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const isDigits = (value: string | undefined) => !!value && /^\d+$/.test(value);

/** str.split(None, maxsplit) */
function splitMax(line: string, max: number): string[] {
  const parts: string[] = [];
  let rest = line.replace(new RegExp(`^[${PY_SPACE}]+`), '');
  while (rest && parts.length < max) {
    const match = new RegExp(`[${PY_SPACE}]+`).exec(rest);
    if (!match) break;
    parts.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }
  if (rest) parts.push(rest);
  return parts;
}

/**
 * macOS: [{pid, ppid, name, cmdline, cwd}] from `ps`. cwd is null (ps does not report it). Any failure throws, which the caller
 * reports as "process check unavailable", never as "no process found".
 */
export function fetchProcessesPs(run: Runner = defaultRun): ProcInfo[] {
  const names = new Map<number, [number, string]>();
  for (const line of psLines(run, 'pid=,ppid=,comm=')) {
    const parts = splitMax(line, 2);
    if (parts.length === 3 && isDigits(parts[0]) && isDigits(parts[1])) names.set(Number(parts[0]), [Number(parts[1]), pyStrip(parts[2])]);
  }
  if (!names.size) throw new Error('ps returned no processes');
  const commands = new Map<number, string>();
  try {
    for (const line of psLines(run, 'pid=,command=')) {
      const parts = splitMax(line, 1);
      if (parts.length === 2 && isDigits(parts[0])) commands.set(Number(parts[0]), pyStrip(parts[1]));
    }
  } catch (error) {
    log.warning('ps command lines unavailable: %s', cleanText(error)); // names alone still identify some clients; no session ids though
  }
  const result: ProcInfo[] = [];
  for (const [pid, [ppid, comm]] of names) {
    const name = comm.slice(comm.lastIndexOf('/') + 1);
    result.push({ pid, ppid, name, cmdline: INTERESTING.has(name.toLowerCase()) ? commands.get(pid) ?? null : null, cwd: null });
  }
  return result;
}

function isDirSync(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/** Windows: [{pid, ppid, name, cmdline, cwd}] for agent-relevant executables plus names of the rest. Linux: /proc. macOS: ps. */
export function fetchProcesses(): ProcInfo[] {
  if (WIN) {
    const result: ProcInfo[] = [];
    for (const entry of processList()) {
      const item: ProcInfo = { pid: entry.pid, ppid: entry.parentPid, name: entry.exe, cmdline: null, cwd: null };
      if (INTERESTING.has(entry.exe.toLowerCase())) {
        const strings = processStrings(entry.pid);
        if (strings) [item.cmdline, item.cwd] = [strings.commandLine, strings.cwd];
      }
      result.push(item);
    }
    return result;
  }
  if (!isDirSync('/proc')) {
    if (Deno.build.os === 'darwin') return fetchProcessesPs();
    throw new Error('Process inspection is not available on this platform');
  }
  const result: ProcInfo[] = [];
  const decoder = new TextDecoder();
  for (const entry of Deno.readDirSync('/proc')) {
    if (!isDigits(entry.name)) continue;
    const dir = `/proc/${entry.name}`;
    try {
      const raw = Deno.readFileSync(`${dir}/cmdline`);
      let name: string;
      let exeExists = false;
      try {
        Deno.statSync(`${dir}/exe`);
        exeExists = true;
      } catch { /* missing or not ours */ }
      if (exeExists) {
        const target = Deno.readLinkSync(`${dir}/exe`);
        name = target.slice(target.lastIndexOf('/') + 1);
      } else name = pyStrip(Deno.readTextFileSync(`${dir}/comm`));
      const statText = Deno.readTextFileSync(`${dir}/stat`);
      const close = statText.lastIndexOf(')');
      if (close < 0) continue;
      const stat = splitMax(statText.slice(close + 1), Infinity);
      if (stat.length < 2) continue;
      const cwd = Deno.readLinkSync(`${dir}/cwd`);
      const parts: string[] = [];
      let start = 0;
      for (let i = 0; i <= raw.length; i++) {
        if (i === raw.length || raw[i] === 0) {
          if (i > start) parts.push(decoder.decode(raw.subarray(start, i)));
          start = i + 1;
        }
      }
      result.push({ pid: Number(entry.name), ppid: parseInt(stat[1], 10), name, cmdline: parts.join(' '), cwd });
    } catch {
      continue;
    }
  }
  return result;
}

/** A cached process snapshot. One read serves every probe for SNAPSHOT_TTL_SECONDS. */
export class ProcessSource {
  #data: ProcInfo[] | null = null;
  #at: number | null = null;
  #error = '';
  fetches = 0;

  constructor(
    readonly fetch: () => Iterable<ProcInfo> = fetchProcesses,
    readonly ttl = SNAPSHOT_TTL_SECONDS,
    readonly clock: () => number = () => performance.now() / 1000,
  ) {}

  /** True when the last real read of the process list failed (it stays true until a later read succeeds). */
  get failed(): boolean {
    return !!this.#error;
  }

  /** [snapshot or null, error]. refresh=false returns only what is already cached. */
  get(maxAge: number | null = null, refresh = true): [ProcInfo[] | null, string] {
    const limit = maxAge === null ? this.ttl : maxAge;
    const now = this.clock();
    if (this.#at !== null && now - this.#at < limit) return [this.#data, this.#error];
    if (!refresh) return [null, 'not sampled recently'];
    this.fetches += 1;
    try {
      this.#data = [...this.fetch()];
      this.#error = '';
    } catch (error) { // an unreadable process list must never break a continue
      log.warning('Process list unavailable: %s', cleanText(error));
      this.#data = null;
      this.#error = cleanText(error) || 'Process list unavailable';
    }
    this.#at = this.clock();
    return [this.#data, this.#error];
  }
}

interface DirEntryInfo {
  name: string;
  path: string;
  isDir(): boolean;
  mtime(): number;
}

/** os.scandir entries, fully read (is_dir follows links, like DirEntry.is_dir()). Throws when the folder cannot be listed. */
function listdir(path: string): DirEntryInfo[] {
  return [...Deno.readDirSync(path)].map((entry) => {
    const full = join(path, entry.name);
    return {
      name: entry.name,
      path: full,
      isDir: () => entry.isDirectory || (entry.isSymlink && isDirSync(full)),
      mtime: () => mtimeOf(Deno.statSync(full)),
    };
  });
}

function mtimeOf(info: Deno.FileInfo): number {
  return (info.mtime?.getTime() ?? 0) / 1000;
}

function lowBase(value: unknown): string {
  const text = pyStr(value).replaceAll('\\', '/');
  return text.slice(text.lastIndexOf('/') + 1).toLowerCase();
}

export interface ProcessKind {
  provider: string | null;
  kind: string;
  label: string;
  session: string | null;
}

/** {provider, kind, label, session} for a known agent client process, else null. 'session' is the session ID in its command line. */
export function classify(proc: { name?: unknown; cmdline?: unknown }): ProcessKind | null {
  const name = lowBase(proc.name || '');
  const command = typeof proc.cmdline === 'string' ? proc.cmdline : proc.cmdline ? pyStr(proc.cmdline) : '';
  const low = command.toLowerCase();
  if (low.includes('--type=')) return null; // Electron helper process (renderer, gpu, utility): not an agent
  const match = /--(?:resume|session-id)[= ]"?([A-Za-z0-9._-]+)"?/.exec(command);
  const session = match ? match[1] : null;
  if (name === 'omp.exe' || name === 'omp') return { provider: 'omp', kind: 'omp', label: 'OMP', session };
  if ((name === 'node.exe' || name === 'node') && low.includes('claude-agent-acp')) {
    return { provider: 'claude', kind: 'claude-adapter', label: 'Claude Code ACP adapter', session };
  }
  if (
    (name === 'claude.exe' || name === 'claude') &&
    (low.includes('stream-json') || low.includes('@anthropic-ai') || low.includes('claude-code'))
  ) {
    return { provider: 'claude', kind: 'claude-engine', label: 'Claude Code', session };
  }
  if ((name === 'devin.exe' || name === 'devin') && low.includes(' acp') && !low.includes('--agent-type')) {
    return { provider: null, kind: 'devin', label: 'Devin agent', session };
  }
  return null;
}

function sameFolder(a: unknown, b: unknown): boolean {
  const norm = (value: unknown) => {
    const text = value ? normcase(normpath(pyStr(value))) : '';
    return text.length > 3 ? text.replace(/[\\/]+$/, '') : text;
  };
  return !!a && !!b && norm(a) === norm(b);
}

// ---------------------------------------------------------------------------------------------
// Cooperative registry: owner announcements
// ---------------------------------------------------------------------------------------------
export function announcementPrefix(provider: unknown, sessionId: unknown): string {
  return createHash('sha256').update(new TextEncoder().encode(pyStr(provider) + '\0' + pyStr(sessionId))).digest('hex').slice(0, 32);
}

export interface Announcement {
  provider: string;
  sessionId: string;
  clientName: string;
  clientVersion: string;
  instanceId: string;
  pid: number;
  pidStart: number | null;
  hostname: string;
  cwd: string;
  state: string;
  heartbeat: number;
  ttl: number;
}

export interface RegistryEntry extends Announcement {
  own: boolean;
  age: number;
  status: 'live' | 'stale' | 'dead' | 'remote' | 'expired';
}

export class AnnouncementError extends Error {
  override name = 'ValueError';
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** A normalized announcement, or throws AnnouncementError (Python: ValueError). Every field is untrusted. */
export function validateAnnouncement(data: unknown, prefix: string | null = null): Announcement {
  if (!isDict(data) || data.format !== FORMAT_NAME) throw new AnnouncementError('not an owner announcement');
  const version = data.version;
  if (!isInt(version) || version !== FORMAT_VERSION) throw new AnnouncementError('unsupported announcement version');
  const provider = data.provider;
  const sessionId = data.sessionId;
  if (typeof provider !== 'string' || !PROVIDER_RE.test(provider)) throw new AnnouncementError('bad provider');
  if (typeof sessionId !== 'string' || !(pyLen(sessionId) > 0 && pyLen(sessionId) <= 512)) throw new AnnouncementError('bad sessionId');
  if (prefix !== null && announcementPrefix(provider, sessionId) !== prefix) {
    throw new AnnouncementError('announcement does not match its file name');
  }
  const client = isDict(data.client) ? data.client : {};
  const pid = data.pid;
  if (!isInt(pid) || pid <= 0) throw new AnnouncementError('bad pid');
  const heartbeat = parseIso(data.heartbeatAt);
  if (heartbeat === null) throw new AnnouncementError('bad heartbeatAt');
  const ttl = Object.hasOwn(data, 'ttlSeconds') ? data.ttlSeconds : DEFAULT_TTL_SECONDS;
  if (typeof ttl !== 'number' || !(ttl >= 5 && ttl <= 300)) throw new AnnouncementError('bad ttlSeconds');
  const or = (value: unknown, fallback: string) => (pyTruthy(value) ? value : fallback);
  return {
    provider,
    sessionId,
    clientName: cleanText(or(client.name, 'unknown client'), 60),
    clientVersion: cleanText(or(client.version, ''), 30),
    instanceId: cleanText(or(client.instanceId, ''), 64),
    pid,
    pidStart: pyTruthy(data.pidStart) ? parseIso(data.pidStart) : null,
    hostname: cleanText(or(data.hostname, ''), 80),
    cwd: cleanText(or(data.cwd, ''), 300),
    state: cleanText(or(data.state, ''), 20),
    heartbeat,
    ttl,
  };
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hostName(): string {
  try {
    return Deno.hostname();
  } catch {
    return '';
  }
}

export interface RegistryOptions {
  clientName?: string;
  clientVersion?: string;
  instanceId?: string | null;
  ttl?: number;
  clock?: () => number;
  hostname?: string | null;
  pid?: number | null;
}

interface Claim {
  announcedAt: string;
  cwd: string;
  state: string;
}

const claimKey = (provider: string, sessionId: string) => JSON.stringify([provider, sessionId]);

/**
 * Writes announcements for sessions this client owns and reads everyone's. One file per (session, instance):
 * <sha256(provider NUL session)[:32]>--<instanceId>.json, so two clients can never overwrite each other's claim and a conflict
 * stays visible to both.
 */
export class OwnerRegistry {
  readonly directory: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly instanceId: string;
  readonly ttl: number;
  readonly clock: () => number;
  readonly hostname: string;
  readonly pid: number;
  readonly #start: number | null;
  #claimed = new Map<string, Claim>();
  writeError = '';

  constructor(directory: string, options: RegistryOptions = {}) {
    this.directory = String(directory);
    this.clientName = options.clientName ?? 'agent-studio';
    this.clientVersion = options.clientVersion ?? '0.1.0';
    this.instanceId = options.instanceId || randomHex(8);
    this.ttl = options.ttl ?? DEFAULT_TTL_SECONDS;
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.hostname = options.hostname || hostName();
    this.pid = options.pid ?? Deno.pid;
    this.#start = options.pid == null ? processStartTime(this.pid) : null;
  }

  #path(provider: string, sessionId: string): string {
    return join(
      this.directory,
      `${announcementPrefix(provider, sessionId)}--${this.instanceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}.json`,
    );
  }

  /** Create or refresh our announcement (atomic replace). Returns false if it could not be written. */
  announce(provider: string, sessionId: unknown, cwd: unknown = '', state = 'ready'): boolean {
    if (typeof sessionId !== 'string' || !sessionId || !PROVIDER_RE.test(String(provider))) return false;
    const now = this.clock();
    const previous = this.#claimed.get(claimKey(provider, sessionId));
    const body = {
      format: FORMAT_NAME,
      version: FORMAT_VERSION,
      provider,
      sessionId,
      client: { name: this.clientName, version: this.clientVersion, instanceId: this.instanceId },
      pid: this.pid,
      pidStart: this.#start ? iso(this.#start) : null,
      hostname: this.hostname,
      cwd: String(cwd || ''),
      state,
      announcedAt: previous?.announcedAt || iso(now),
      heartbeatAt: iso(now),
      ttlSeconds: this.ttl,
    };
    const path = this.#path(provider, sessionId);
    try {
      Deno.mkdirSync(this.directory, { recursive: true });
      const temporary = `${path}.${Deno.pid}.tmp`;
      Deno.writeTextFileSync(temporary, JSON.stringify(body));
      Deno.renameSync(temporary, path);
    } catch (error) {
      this.writeError = cleanText(error);
      return false;
    }
    this.#claimed.set(claimKey(provider, sessionId), { announcedAt: body.announcedAt, cwd: body.cwd, state });
    this.writeError = '';
    return true;
  }

  withdraw(provider: string, sessionId: string): void {
    this.#claimed.delete(claimKey(provider, sessionId));
    try {
      Deno.removeSync(this.#path(provider, sessionId));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) this.writeError = cleanText(error);
    }
  }

  withdrawAll(): void {
    for (const key of [...this.#claimed.keys()]) {
      const [provider, sessionId] = JSON.parse(key) as [string, string];
      this.withdraw(provider, sessionId);
    }
  }

  /** [[provider, sessionId], claim] pairs this registry announces. */
  claimed(): [[string, string], Claim][] {
    return [...this.#claimed].map(([key, claim]) => [JSON.parse(key) as [string, string], { ...claim }]);
  }

  /** [entries, problems]. Each entry: validated announcement + own/age/status. Never throws. */
  read(provider: string | null = null, sessionId: string | null = null): [RegistryEntry[], number] {
    const entries: RegistryEntry[] = [];
    let problems = 0;
    let names: string[];
    try {
      names = [...Deno.readDirSync(this.directory)].map((e) => e.name).filter((name) => name.endsWith('.json'));
    } catch {
      return [entries, problems];
    }
    const prefix = provider && sessionId ? announcementPrefix(provider, sessionId) : null;
    const now = this.clock();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    for (const name of names) {
      if (prefix && !name.startsWith(prefix + '--')) continue;
      const path = join(this.directory, name);
      let item: RegistryEntry;
      try {
        if (Deno.statSync(path).size > MAX_ANNOUNCEMENT_BYTES) throw new AnnouncementError('oversized');
        const separator = name.indexOf('--');
        item = validateAnnouncement(
          JSON.parse(decoder.decode(Deno.readFileSync(path))),
          separator >= 0 ? name.slice(0, separator) : name,
        ) as RegistryEntry;
      } catch {
        problems += 1;
        continue;
      }
      item.own = item.instanceId === this.instanceId;
      item.age = Math.max(0.0, now - item.heartbeat);
      if (item.heartbeat - now > 300) {
        problems += 1; // a heartbeat far in the future means a wrong clock; not trusted
        continue;
      }
      const fresh = item.age <= item.ttl + 5;
      const sameHost = !item.hostname || item.hostname.toLowerCase() === this.hostname.toLowerCase();
      if (sameHost) {
        const alive = processAlive(item.pid, item.pidStart);
        item.status = alive === false ? 'dead' : fresh ? 'live' : 'stale';
      } else {
        item.status = fresh ? 'remote' : 'expired';
      }
      entries.push(item);
    }
    return [entries, problems];
  }
}

// ---------------------------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------------------------
export interface Reason {
  signal: string;
  strength: 'strong' | 'weak';
  text: string;
  pid?: number;
}

export interface Assessment {
  provider: string;
  sessionId: string;
  reasons: Reason[];
  notes: string[];
  unavailable: string[];
  checkedAt: number;
  verdict: Verdict;
  summary: string;
  elapsedMs?: number;
  certainty?: 'unknown' | 'checked' | 'evidence';
}

export interface Hint {
  verdict: Verdict;
  reasons: Reason[];
}

export interface AssessOptions {
  cwd?: string | null;
  deep?: boolean;
  skipCmdline?: boolean;
  fresh?: boolean;
  projectRoot?: string | null;
}

export type LockProbe = (path: string) => [number, string][] | null;

export interface ProbeOptions {
  ompRoot?: string | null;
  claudeRoot?: string | null;
  registry?: OwnerRegistry | null;
  processes?: ProcessSource | null;
  ownedByStudio?: (provider: string, sessionId: string) => boolean;
  ownPids?: () => Iterable<unknown> | null | undefined;
  lockProbe?: LockProbe;
  clock?: () => number;
  inspectProcesses?: boolean;
}

const SUMMARIES: Record<Exclude<Verdict, 'owned_by_studio'>, string> = {
  owned_elsewhere: 'Another app is running this conversation. AIB will not continue it from here.',
  possibly_active: 'Another app may be using this conversation. AIB cannot be sure either way.',
  no_evidence: NO_EVIDENCE_NOTE,
};

const AGENT_NAMES = new Set(['omp.exe', 'claude.exe', 'omp', 'claude']);

/** f'{n:,}' */
function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Path.with_suffix(''): drop the last suffix of the file name. */
function withoutSuffix(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return path;
  return path.slice(0, path.length - (name.length - dot));
}

/** Path.rglob('*.jsonl') (case-insensitive on Windows, like pathlib there): files and folders below `folder`, its own level first. */
function* rglobJsonl(folder: string): Generator<string> {
  const pattern = WIN ? /\.jsonl$/i : /\.jsonl$/;
  const ordered: string[] = [];
  // pathlib lists the matches of each folder in the order it walks them: the folder, then each subfolder depth-first.
  const walk = (dir: string) => {
    ordered.push(dir);
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      return;
    }
    for (const entry of entries) if (entry.isDirectory) walk(join(dir, entry.name));
  };
  walk(folder);
  for (const dir of ordered) {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(dir)];
    } catch {
      continue;
    }
    for (const entry of entries) if (pattern.test(entry.name)) yield join(dir, entry.name);
  }
}

export class OwnershipProbe {
  readonly roots: Record<string, string | null>;
  registry: OwnerRegistry | null;
  processes: ProcessSource;
  ownedByStudio: (provider: string, sessionId: string) => boolean;
  ownPids: () => Iterable<unknown> | null | undefined;
  lockProbe: LockProbe;
  clock: () => number;
  inspectProcesses: boolean;
  #released = new Map<string, number>();
  #seen = new Map<string, [number, number, number]>();
  #hintCache: [number, Record<string, Hint>] = [0.0, {}];

  constructor(options: ProbeOptions = {}) {
    this.roots = { omp: options.ompRoot ? String(options.ompRoot) : null, claude: options.claudeRoot ? String(options.claudeRoot) : null };
    this.registry = options.registry ?? null;
    this.processes = options.processes ?? new ProcessSource();
    this.ownedByStudio = options.ownedByStudio ?? (() => false);
    this.ownPids = options.ownPids ?? (() => []);
    this.lockProbe = options.lockProbe ?? lockHolders;
    this.clock = options.clock ?? (() => Date.now() / 1000);
    this.inspectProcesses = options.inspectProcesses ?? true;
  }

  // -- bookkeeping -------------------------------------------------------------------------
  /** Studio just stopped running this conversation: transcript writes up to now are Studio's own. */
  noteReleased(provider: string, sessionId: string): void {
    this.#released.set(claimKey(provider, sessionId), this.clock());
    if (this.#released.size > 256) {
      const oldest = [...this.#released].sort((a, b) => a[1] - b[1]).slice(0, this.#released.size - 256);
      for (const [key] of oldest) this.#released.delete(key);
    }
  }

  // -- transcripts -------------------------------------------------------------------------
  findTranscript(provider: string, sessionId: unknown): string | null {
    const root = this.roots[provider] ?? null;
    if (root === null || typeof sessionId !== 'string' || !SESSION_ID_RE.test(sessionId)) return null;
    try {
      for (const folder of listdir(root)) {
        if (!folder.isDir()) continue;
        if (provider === 'claude') {
          const candidate = join(folder.path, `${sessionId}.jsonl`);
          try {
            if (Deno.statSync(candidate).isFile) return candidate;
          } catch { /* not here */ }
        } else {
          for (const entry of listdir(folder.path)) {
            const stem = entry.name.endsWith('.jsonl') ? entry.name.slice(0, -6) : null;
            if (stem && (stem === sessionId || stem.endsWith('_' + sessionId))) return entry.path;
          }
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  static stemToId(provider: string, name: string): string {
    const stem = name.slice(0, -6);
    return provider === 'omp' ? stem.slice(stem.lastIndexOf('_') + 1) : stem;
  }

  /** Weak reason when the transcript was written moments ago by someone other than Studio. */
  #transcriptSignal(provider: string, sessionId: string, path: string, deep: boolean): [Reason | null, string | null] {
    let stat: Deno.FileInfo;
    try {
      stat = Deno.statSync(path);
    } catch {
      return [null, null];
    }
    const now = this.clock();
    const modified = mtimeOf(stat);
    const age = Math.max(0.0, now - modified);
    const released = this.#released.get(claimKey(provider, sessionId));
    const before = this.#seen.get(path);
    this.#seen.delete(path);
    this.#seen.set(path, [stat.size, modified, now]);
    if (this.#seen.size > 512) {
      const oldest = [...this.#seen].sort((a, b) => a[1][2] - b[1][2]).slice(0, this.#seen.size - 512);
      for (const [key] of oldest) this.#seen.delete(key);
    }
    const info = `Transcript last written ${humanizeAge(age)} ago`;
    if (released !== undefined && modified <= released + RELEASE_GRACE_SECONDS) {
      return [null, info + ' (by AIB itself, before it released the conversation)'];
    }
    let newest = age;
    let label = 'Transcript';
    if (deep) { // Claude subagents and OMP artifacts live in a sibling folder named like the transcript
      const folder = withoutSuffix(path);
      try {
        if (isDirSync(folder)) {
          let seen = 0;
          for (const child of rglobJsonl(folder)) {
            seen += 1;
            if (seen > 200) break;
            const childAge = now - mtimeOf(Deno.statSync(child));
            if (childAge < newest) {
              newest = Math.max(0.0, childAge);
              label = 'A subagent transcript of this conversation';
            }
          }
        }
      } catch { /* OSError: stop looking */ }
    }
    if (newest > ACTIVE_WINDOW_SECONDS) return [null, info + ' (an idle session open in another app would not write anything)'];
    let text = `${label} was written ${humanizeAge(newest)} ago, and AIB is not the app writing it`;
    if (before && stat.size > before[0]) text += ` (it grew by ${thousands(stat.size - before[0])} bytes since AIB last looked)`;
    return [{ signal: 'transcript', strength: 'weak', text: text + '.' }, null];
  }

  // -- processes ---------------------------------------------------------------------------
  ownProcessIds(snapshot: ProcInfo[] | null): Set<number> {
    const own = new Set<number>([Deno.pid]);
    for (const pid of this.ownPids() ?? []) if (isInt(pid)) own.add(pid);
    if (snapshot && snapshot.length) {
      const children = new Map<number, number[]>();
      for (const proc of snapshot) {
        const list = children.get(proc.ppid) ?? [];
        list.push(proc.pid);
        children.set(proc.ppid, list);
      }
      const todo = [...own];
      while (todo.length) {
        for (const child of children.get(todo.pop()!) ?? []) {
          if (!own.has(child)) {
            own.add(child);
            todo.push(child);
          }
        }
      }
    }
    return own;
  }

  static startedBy(snapshot: ProcInfo[], proc: ProcInfo): string {
    const byPid = new Map(snapshot.map((p) => [p.pid, p]));
    const seen = new Set<number>();
    let current: ProcInfo | undefined = proc;
    for (let i = 0; i < 6; i++) {
      current = byPid.get(current!.ppid);
      if (current === undefined || seen.has(current.pid)) return '';
      seen.add(current.pid);
      const label = PARENT_LABELS[lowBase(current.name)];
      if (label) return label;
    }
    return '';
  }

  #processSignals(
    provider: string,
    sessionId: string,
    cwd: string | null,
    snapshot: ProcInfo[],
    own: Set<number>,
    skipCmdline: boolean,
    projectRoot: string | null,
  ): Reason[] {
    const reasons: Reason[] = [];
    if (!snapshot.length) return reasons;
    if (!skipCmdline) {
      const wanted = snapshot.filter((p) => p.cmdline && AGENT_NAMES.has(lowBase(p.name))).map((p) => ({
        pid: p.pid,
        name: p.name,
        commandline: p.cmdline,
      }));
      const pid = findExternalOwner(wanted, provider, sessionId, own);
      if (pid !== null) {
        reasons.push({
          signal: 'command-line',
          strength: 'strong',
          pid,
          text: `A ${provider} process (PID ${pid}) was started with this exact session ID.`,
        });
      }
    }
    if (!(cwd || projectRoot)) return reasons;
    const candidates: [ProcInfo, ProcessKind][] = [];
    for (const proc of snapshot) {
      if (own.has(proc.pid)) continue;
      const kind = classify(proc);
      if (!kind || (kind.provider && kind.provider !== provider)) continue;
      if (kind.session && kind.session !== sessionId) continue; // it names a different session
      if (!(sameFolder(proc.cwd, cwd) || sameFolder(proc.cwd, projectRoot))) continue; // the chat's cwd or its project root
      candidates.push([proc, kind]);
    }
    const pids = new Set(candidates.map(([proc]) => proc.pid));
    const shown = candidates.filter(([proc]) => !pids.has(proc.ppid)); // collapse adapter -> engine chains
    for (const [proc, kind] of shown.slice(0, 3)) {
      const parent = OwnershipProbe.startedBy(snapshot, proc);
      reasons.push({
        signal: 'process-folder',
        strength: 'weak',
        pid: proc.pid,
        text: `${kind.label} (PID ${proc.pid}${parent ? ', started by ' + parent : ''}) is running in this project folder. ` +
          'Agent processes do not reveal which conversation they hold, so AIB cannot tell whether it is this one.',
      });
    }
    if (shown.length > 3) {
      reasons.push({
        signal: 'process-folder',
        strength: 'weak',
        text: `${shown.length - 3} more agent processes are running in this folder.`,
      });
    }
    return reasons;
  }

  // -- registry ----------------------------------------------------------------------------
  #registrySignals(provider: string, sessionId: string): [Reason[], string[], number] {
    const reasons: Reason[] = [];
    const info: string[] = [];
    if (!this.registry) return [reasons, info, 0];
    const [entries, problems] = this.registry.read(provider, sessionId);
    for (const entry of entries) {
      if (entry.own) continue;
      const who = `${entry.clientName} (PID ${entry.pid})`;
      if (entry.status === 'live') {
        reasons.push({
          signal: 'announcement',
          strength: 'strong',
          pid: entry.pid,
          text: `${who} announced that it is running this conversation (heartbeat ${humanizeAge(entry.age)} ago).`,
        });
      } else if (entry.status === 'stale') {
        reasons.push({
          signal: 'announcement',
          strength: 'weak',
          pid: entry.pid,
          text: `${who} announced this conversation but has not refreshed the announcement for ${
            humanizeAge(entry.age)
          }, although that process is still running.`,
        });
      } else if (entry.status === 'remote') {
        reasons.push({
          signal: 'announcement',
          strength: 'weak',
          text:
            `${entry.clientName} on ${entry.hostname || 'another computer'} announced this conversation ${humanizeAge(entry.age)} ago. ` +
            'AIB cannot check a process on another computer.',
        });
      } else {
        info.push(
          `${entry.clientName} once announced this conversation, but the announcement is no longer live (${
            entry.status === 'dead' ? 'process ended' : 'expired'
          }).`,
        );
      }
    }
    return [reasons, info, problems];
  }

  // -- the verdict -------------------------------------------------------------------------
  /** Full evidence for one conversation. deep=true also asks Windows who holds the transcript open. */
  assess(provider: string, sessionId: string, options: AssessOptions = {}): Assessment {
    const { cwd = null, deep = true, skipCmdline = false, fresh = false, projectRoot = null } = options;
    const started = this.clock();
    const reasons: Reason[] = [];
    const notes: string[] = [];
    const unavailable: string[] = [];
    const base = { provider, sessionId, reasons, notes, unavailable, checkedAt: started };
    if (this.ownedByStudio(provider, sessionId)) {
      return { ...base, verdict: 'owned_by_studio', summary: 'This conversation is running in this AIB.' };
    }
    const [extra, info, problems] = this.#registrySignals(provider, sessionId);
    reasons.push(...extra);
    notes.push(...info);
    if (problems) notes.push(`${problems} unreadable owner announcement file(s) were ignored.`);
    const path = this.findTranscript(provider, sessionId);
    if (path === null) {
      if (this.roots[provider]) notes.push('No local transcript was found for this conversation.');
    } else {
      const [reason, note] = this.#transcriptSignal(provider, sessionId, path, deep);
      if (reason) reasons.push(reason);
      if (note) notes.push(note);
    }
    let [snapshot, error]: [ProcInfo[] | null, string] = [null, 'process inspection is off'];
    if (this.inspectProcesses) [snapshot, error] = this.processes.get(fresh ? 0 : null);
    const own = this.ownProcessIds(snapshot);
    if (snapshot === null) {
      unavailable.push('running-process check (' + error + ')');
    } else {
      reasons.push(...this.#processSignals(provider, sessionId, cwd, snapshot, own, skipCmdline, projectRoot));
      const unreadable = snapshot.filter((p) => AGENT_NAMES.has(lowBase(p.name)) && p.cmdline == null && !own.has(p.pid)).length;
      if (unreadable) notes.push(`${unreadable} agent process(es) could not be inspected (different user or elevated).`);
    }
    if (deep && path !== null) {
      const holders = this.lockProbe(path);
      if (holders === null) {
        unavailable.push('open-file check');
      } else {
        const others = holders.filter(([pid]) => !own.has(pid));
        if (others.length) {
          const [pid, name] = others[0];
          reasons.push({
            signal: 'file-handle',
            strength: 'weak',
            pid,
            text: `${cleanText(name, 60)} (PID ${pid}) has the transcript file open right now.`,
          });
        }
      }
    }
    const verdict: Exclude<Verdict, 'owned_by_studio'> = reasons.some((r) => r.strength === 'strong')
      ? 'owned_elsewhere'
      : reasons.length
      ? 'possibly_active'
      : 'no_evidence';
    // 'unknown' is a separate field so the verdict names stay stable: with no evidence found AND a probe that could not run
    // (process list, open-file check), the honest answer is "unknown", never "free".
    return {
      ...base,
      verdict,
      summary: SUMMARIES[verdict],
      elapsedMs: pyRound((this.clock() - started) * 1000),
      certainty: verdict === 'no_evidence' && unavailable.length ? 'unknown' : verdict === 'no_evidence' ? 'checked' : 'evidence',
    };
  }

  // -- cheap hints for the conversation list -----------------------------------------------
  /**
   * What a conversation WITHOUT a hint means in the list: 'unknown' when a check this probe relies on cannot run on this system (no
   * open-file check off Windows, process list off or unreadable), else 'checked'. The list-wide counterpart of assess()'s certainty.
   */
  listCertainty(): 'unknown' | 'checked' {
    if (this.lockProbe === lockHolders && !WIN) return 'unknown';
    if (!this.inspectProcesses || this.processes.failed) return 'unknown';
    return 'checked';
  }

  /**
   * {'provider:id': {verdict, reasons}} for conversations with evidence. Cheap: no new process scan, no per-row stat beyond
   * directory listings, cached for HINT_TTL_SECONDS.
   */
  hints(): Record<string, Hint> {
    const [stamp, cached] = this.#hintCache;
    const now = this.clock();
    if (cached !== null && now - stamp < HINT_TTL_SECONDS && stamp) return cached;
    const found = new Map<string, Reason[]>();
    const add = (provider: string, sessionId: string, reason: Reason) => {
      const key = claimKey(provider, sessionId);
      const list = found.get(key) ?? [];
      list.push(reason);
      found.set(key, list);
    };
    const [snapshot] = this.inspectProcesses ? this.processes.get(null, false) : [null, ''];
    const own = this.ownProcessIds(snapshot);
    for (const [provider, root] of Object.entries(this.roots)) {
      if (root === null) continue;
      let folders: DirEntryInfo[];
      try {
        folders = listdir(root).filter((f) => f.isDir());
      } catch {
        continue;
      }
      for (const folder of folders) {
        let entries: DirEntryInfo[];
        try {
          entries = listdir(folder.path);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.name.endsWith('.jsonl')) continue;
          let modified: number;
          try {
            modified = entry.mtime();
          } catch {
            continue;
          }
          if (now - modified > ACTIVE_WINDOW_SECONDS) continue;
          const sessionId = OwnershipProbe.stemToId(provider, entry.name);
          if (this.ownedByStudio(provider, sessionId)) continue;
          const [reason] = this.#transcriptSignal(provider, sessionId, entry.path, false);
          if (reason) add(provider, sessionId, reason);
        }
      }
    }
    if (this.registry) {
      const [entries] = this.registry.read();
      for (const entry of entries) {
        if (entry.own || !['live', 'stale', 'remote'].includes(entry.status)) continue;
        const strong = entry.status === 'live';
        add(entry.provider, entry.sessionId, {
          signal: 'announcement',
          strength: strong ? 'strong' : 'weak',
          text: `${entry.clientName} (PID ${entry.pid}) announced this conversation ${humanizeAge(entry.age)} ago.`,
        });
      }
    }
    if (snapshot && snapshot.length) {
      for (const proc of snapshot.filter((p) => !own.has(p.pid) && p.cmdline)) {
        const kind = classify(proc);
        if (kind && kind.session && kind.provider) {
          add(kind.provider, kind.session, {
            signal: 'command-line',
            strength: 'strong',
            pid: proc.pid,
            text: `${kind.label} (PID ${proc.pid}) was started with this exact session ID.`,
          });
        }
      }
    }
    const hints: Record<string, Hint> = {};
    for (const [key, reasons] of found) {
      const [provider, sessionId] = JSON.parse(key) as [string, string];
      if (this.ownedByStudio(provider, sessionId)) continue;
      const verdict = reasons.some((r) => r.strength === 'strong') ? 'owned_elsewhere' : 'possibly_active';
      hints[`${provider}:${sessionId}`] = { verdict, reasons: reasons.slice(0, 3) };
    }
    this.#hintCache = [now, hints];
    return hints;
  }

  /** Warm the process snapshot without blocking the current request (used by the list endpoint). */
  refreshProcessesAsync(maxAge = 20.0): void {
    if (!this.inspectProcesses) return;
    const [snapshot] = this.processes.get(maxAge, false);
    if (snapshot === null) setTimeout(() => this.processes.get(0), 0);
  }
}

if (import.meta.main) {
  const args = Deno.args;
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const provider = value('--provider');
  const session = value('--session');
  if (!provider || !['omp', 'claude'].includes(provider) || !session) {
    console.error(
      'usage: probe.ts --provider {omp,claude} --session ID [--cwd DIR] [--omp-sessions DIR] [--claude-projects DIR] [--owners-dir DIR]',
    );
    Deno.exit(2);
  }
  const probe = new OwnershipProbe({
    ompRoot: value('--omp-sessions') ?? join(home(), '.omp', 'agent', 'sessions'),
    claudeRoot: value('--claude-projects') ?? join(home(), '.claude', 'projects'),
    registry: new OwnerRegistry(value('--owners-dir') ?? defaultOwnersDir(), { clientName: 'ownership-probe-cli' }),
  });
  console.log(JSON.stringify(probe.assess(provider, session, { cwd: value('--cwd') ?? null }), null, 2));
}
