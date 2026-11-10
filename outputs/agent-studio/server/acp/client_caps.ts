/**
 * Opt-in ACP client capabilities for Agent Studio: terminals and text-file access (client_caps.py).
 *
 * Everything here is OFF by default. A ClientCaps object only answers the methods whose capability was switched on with
 * --enable-client-terminal / --enable-client-fs; any other method is left to Studio's normal "capability not advertised" error.
 *
 * Boundaries (see docs/client-capabilities.md):
 *   * file paths must be absolute and, after realpath (symlinks/junctions followed), inside the connection's workspace folder;
 *   * terminals run argv lists without a shell, only inside the workspace, with a minimal environment plus whatever env entries the
 *     agent explicitly asks for;
 *   * every process is tracked per connection and killed (with everything it started) on release / connection close.
 *
 * Differences forced by Deno: stdout and stderr arrive on two pipes (Python merges them into one), so the output buffer interleaves
 * their chunks in arrival order; terminals are killed through platform/process_tree.ts (a Job Object on Windows, the process group
 * elsewhere) instead of taskkill /T; the window is hidden by the server's console (platform/console.ts), not CREATE_NO_WINDOW.
 */
import { getLogger } from '../core/log.ts';
import { writeJsonAtomic } from '../core/fs.ts';
import { clip, isDict, pyLen, pyRepr, pyStrip, ValueError } from '../core/py.ts';
import {
  commonpath,
  dirname,
  exists,
  getsize,
  isdir,
  isfile,
  normcase,
  normpath,
  realpath,
  SEP,
  splitdrive,
  WIN,
} from '../platform/ospath.ts';
import { executable } from '../platform/pypath.ts';
import { ProcessTree, treeSpawnOptions } from '../platform/process_tree.ts';

const log = getLogger('client_caps');

export const MAX_READ_BYTES = 2 * 1024 * 1024; // largest slice returned by fs/read_text_file
export const MAX_SCAN_BYTES = 64 * 1024 * 1024; // most we will scan to reach a requested start line
export const MAX_WRITE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_OUTPUT_LIMIT = 1024 * 1024; // terminal output kept when the agent gives no limit
export const MAX_OUTPUT_LIMIT = 4 * 1024 * 1024; // hard server-side cap, whatever the agent asks for
export const MAX_TERMINALS = 8;
export const MAX_ENV = 64;
export const MAX_ARGS = 256;
export const MAX_ARG_CHARS = 32768;
export const TAIL_CHARS = 4000; // output tail shown in public state
export const RECENT_WRITES = 50;
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const BASE_ENV_NAMES = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'TEMP',
  'TMP',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'LANG',
  'LC_ALL',
  'TERM',
  'TZ',
];
export const RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'CONIN$',
  'CONOUT$',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
export const TERMINAL_METHODS = ['terminal/create', 'terminal/output', 'terminal/wait_for_exit', 'terminal/kill', 'terminal/release'];
export const FS_READ_METHODS = ['fs/read_text_file'];
export const FS_WRITE_METHODS = ['fs/write_text_file'];

export type FsMode = null | 'read' | 'readwrite';

export class CapError extends Error {
  override name = 'CapError';
  constructor(message: string, readonly code = -32602) {
    super(message);
  }
}

/** os.path.isabs of Python 3.11 (ntpath keeps the legacy rule that '\x' and '/x' are absolute; posixpath: starts with '/'). */
function isabs311(path: string): boolean {
  if (!WIN) return path.startsWith('/');
  const s = path.slice(0, 3).replaceAll('/', '\\');
  return s.startsWith('\\') || s.slice(1).startsWith(':\\');
}

function norm(path: string): string {
  return normcase(normpath(path));
}

/** True if path is root or below it (both already real paths); never throws. */
export function inside(path: string, root: string): boolean {
  try {
    const a = norm(path);
    const b = norm(root);
    if (isabs311(a) !== isabs311(b)) return false;
    return commonpath(a, b) === b;
  } catch {
    return false;
  }
}

/** Validate an agent-supplied absolute path and return its real location inside workspace. */
export function resolveInside(path: unknown, workspace: string, what = 'path'): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || pyLen(path) > 4096) {
    throw new CapError(`${what} must be a non-empty string`);
  }
  if (!isabs311(path)) throw new CapError(`${what} must be an absolute path`);
  if (['\\\\?\\', '\\\\.\\', '//?/', '//./'].some((p) => path.startsWith(p))) {
    throw new CapError(`${what} uses a device or extended-length prefix, which is not allowed`);
  }
  if (path.startsWith('\\\\') || path.startsWith('//')) throw new CapError(`${what} is a network (UNC) path, which is not allowed`);
  if (splitdrive(path)[1].includes(':')) throw new CapError(`${what} contains a colon (alternate data stream), which is not allowed`);
  if (WIN) {
    for (const part of splitdrive(path)[1].replaceAll('/', '\\').split('\\')) {
      if (
        part &&
        (RESERVED_NAMES.has(pyStrip(part.split('.')[0]).toUpperCase()) ||
          (part !== '.' && part !== '..' && '. '.includes(part[part.length - 1])))
      ) {
        throw new CapError(`${what} contains a reserved Windows device name or trailing dot/space`);
      }
    }
  }
  const real = realpath(path);
  const root = realpath(workspace);
  if (!inside(real, root)) throw new CapError(`${what} is outside the workspace folder`);
  return real;
}

/** Drop the oldest bytes beyond limit without leaving a split UTF-8 character at the start. Returns [buffer, trimmed]. */
export function trimToLimit(buffer: Uint8Array, limit: number): [Uint8Array, boolean] {
  if (buffer.length <= limit) return [buffer, false];
  let start = buffer.length - limit;
  while (start < buffer.length && buffer[start] >= 0x80 && buffer[start] <= 0xbf) start++;
  return [buffer.slice(start), true];
}

const SIGNALS: Record<string, number> = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

export interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Terminal {
  buffer: Uint8Array = new Uint8Array(0);
  truncated = false;
  exitCode: number | null = null;
  signal: string | null = null;
  killed = false;
  released = false;
  readonly created = Date.now() / 1000;
  readonly tree: ProcessTree;
  #exited = false;
  #processDone = false;
  readonly exited: Promise<void>;

  constructor(
    readonly id: string,
    readonly sessionId: string,
    readonly argv: string[],
    readonly cwd: string,
    readonly process: Deno.ChildProcess,
    readonly limit: number,
  ) {
    this.tree = new ProcessTree(process);
    const pumps = [this.#pump(process.stdout), this.#pump(process.stderr)];
    const status = process.status.then((s) => {
      this.#processDone = true;
      return s;
    }, () => null);
    this.exited = Promise.all([status, ...pumps]).then(([s]) => {
      if (s) {
        if (s.signal) {
          this.exitCode = null;
          this.signal = String(SIGNALS[s.signal] ?? s.signal);
        } else this.exitCode = s.code;
      }
      this.#exited = true;
    });
  }

  async #pump(stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stream) {
        const joined = new Uint8Array(this.buffer.length + chunk.length);
        joined.set(this.buffer);
        joined.set(chunk, this.buffer.length);
        const [kept, trimmed] = trimToLimit(joined, this.limit);
        this.buffer = kept;
        if (trimmed) this.truncated = true;
      }
    } catch { /* the pipe broke: the process is gone */ }
  }

  get isExited(): boolean {
    return this.#exited;
  }

  status(): 'released' | 'running' | 'killed' | 'exited' {
    if (this.released) return 'released';
    if (!this.#exited) return 'running';
    return this.killed ? 'killed' : 'exited';
  }

  exitStatus(): ExitStatus | null {
    if (!this.#exited) return null;
    if (this.signal !== null) return { exitCode: null, signal: this.signal };
    return { exitCode: this.exitCode, signal: null };
  }

  snapshot(): [string, boolean] {
    return [new TextDecoder().decode(this.buffer), this.truncated];
  }

  /** Kill the process and everything it started; waits up to 5 s for it to end. */
  async kill(): Promise<void> {
    if (this.#processDone) return;
    this.killed = true;
    this.tree.kill();
    await Promise.race([this.exited, sleep(5000)]);
  }
}

/** shutil.which(cmd, path=...) of Python 3.11 (Windows: the current folder first, PATHEXT). */
export function whichIn(cmd: string, pathVar: string): string | null {
  const access = (name: string) => executable(name) && !isdir(name);
  if (!pathVar) return null;
  const dirs = pathVar.split(WIN ? ';' : ':');
  let files = [cmd];
  if (WIN) {
    if (!dirs.includes('.')) dirs.unshift('.');
    const pathext = (Deno.env.get('PATHEXT') || '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WS;.MSC').split(';').filter((ext) => ext);
    files = pathext.some((ext) => cmd.toLowerCase().endsWith(ext.toLowerCase())) ? [cmd] : pathext.map((ext) => cmd + ext);
  }
  const seen = new Set<string>();
  for (const dir of dirs) {
    const key = normcase(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const file of files) {
      const name = !dir
        ? file
        : WIN
        ? (/[\\/:]$/.test(dir) ? dir + file : `${dir}\\${file}`)
        : dir.endsWith('/')
        ? dir + file
        : `${dir}/${file}`;
      if (access(name)) return name;
    }
  }
  return null;
}

export interface WriteEntry {
  path: string;
  bytes: number;
  created: boolean;
  sessionId: unknown;
  time: number;
}

export interface ClientCapsOptions {
  terminal?: boolean;
  fs?: FsMode;
  knownSession?: (sessionId: string) => boolean;
  record?: (kind: string, data: Record<string, unknown>) => void;
  writeResponse?: (reply: Record<string, unknown>) => void;
}

type Params = Record<string, unknown>;

function checkFs(fs: unknown): FsMode {
  if (fs !== null && fs !== undefined && fs !== 'read' && fs !== 'readwrite') {
    throw new ValueError("fs must be None, 'read' or 'readwrite'");
  }
  return (fs ?? null) as FsMode;
}

const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** Per-connection capability handler. `fs` is null, 'read' or 'readwrite'. */
export class ClientCaps {
  readonly workspace: string;
  terminalEnabled: boolean;
  fsMode: FsMode;
  knownSession: (sessionId: string) => boolean;
  record: (kind: string, data: Record<string, unknown>) => void;
  writeResponse: ((reply: Record<string, unknown>) => void) | undefined;
  readonly terminals = new Map<string, Terminal>();
  readonly writes: WriteEntry[] = [];
  shut = false;
  #queue: Promise<void> = Promise.resolve();

  constructor(workspace: string, options: ClientCapsOptions = {}) {
    this.workspace = String(workspace);
    this.terminalEnabled = !!options.terminal;
    this.fsMode = checkFs(options.fs);
    this.knownSession = options.knownSession ?? (() => true);
    this.record = options.record ?? (() => {});
    this.writeResponse = options.writeResponse;
  }

  /** Switch capabilities on; call before the initialize request is sent. */
  configure(terminal = false, fs: FsMode = null): void {
    const mode = checkFs(fs);
    this.terminalEnabled = !!terminal;
    this.fsMode = mode;
  }

  // --- advertised capabilities -------------------------------------------------
  capabilities(): { fs: { readTextFile: boolean; writeTextFile: boolean }; terminal: boolean } {
    return {
      fs: { readTextFile: this.fsMode === 'read' || this.fsMode === 'readwrite', writeTextFile: this.fsMode === 'readwrite' },
      terminal: this.terminalEnabled,
    };
  }

  handles(method: string): boolean {
    if (TERMINAL_METHODS.includes(method)) return this.terminalEnabled;
    if (FS_READ_METHODS.includes(method)) return this.fsMode === 'read' || this.fsMode === 'readwrite';
    if (FS_WRITE_METHODS.includes(method)) return this.fsMode === 'readwrite';
    return false;
  }

  // --- dispatch -----------------------------------------------------------------
  /**
   * Answer one agent->client request. Requests are answered one after another in arrival order, as Python's reader thread does;
   * terminal/wait_for_exit runs on its own (Python: a worker thread) so it never holds up the others. Resolves when answered.
   */
  dispatch(message: Params): Promise<void> {
    if (message.method === 'terminal/wait_for_exit') return this.#respond(message);
    const next = this.#queue.then(() => this.#respond(message));
    this.#queue = next.catch(() => {});
    return next;
  }

  async #respond(message: Params): Promise<void> {
    let reply: Record<string, unknown>;
    try {
      const params = message.params;
      if (!isDict(params)) throw new CapError('params must be an object');
      const sid = params.sessionId;
      if (typeof sid !== 'string' || !this.knownSession(sid)) throw new CapError('Unknown sessionId');
      const result = await this.call(String(message.method), params);
      reply = { jsonrpc: '2.0', id: message.id, result: result ?? null };
    } catch (error) {
      if (error instanceof CapError) {
        reply = { jsonrpc: '2.0', id: message.id, error: { code: error.code, message: error.message } };
      } else { // never let a bad request take down the reader
        log.exception(error, 'Client capability request failed');
        const name = error instanceof Error ? error.name : 'Error';
        reply = {
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32603, message: `Client capability failed: ${name}: ${error instanceof Error ? error.message : error}` },
        };
      }
    }
    try {
      this.writeResponse?.(reply);
    } catch { /* the connection is gone */ }
  }

  call(method: string, params: Params): Promise<unknown> {
    if (!this.handles(method)) return Promise.reject(new CapError(`Client capability not advertised: ${method}`, -32601));
    try {
      switch (method) {
        case 'fs/read_text_file':
          return Promise.resolve(this.fsReadTextFile(params));
        case 'fs/write_text_file':
          return Promise.resolve(this.fsWriteTextFile(params));
        case 'terminal/create':
          return Promise.resolve(this.terminalCreate(params));
        case 'terminal/output':
          return Promise.resolve(this.terminalOutput(params));
        case 'terminal/wait_for_exit':
          return this.terminalWaitForExit(params);
        case 'terminal/kill':
          return this.terminalKill(params);
        case 'terminal/release':
          return this.terminalRelease(params);
      }
    } catch (error) {
      return Promise.reject(error);
    }
    return Promise.reject(new CapError(`Client capability not advertised: ${method}`, -32601));
  }

  // --- filesystem ----------------------------------------------------------------
  static #positiveInt(value: unknown, name: string): number | null {
    if (value === null || value === undefined) return null;
    if (!isInt(value) || value < 1) throw new CapError(`${name} must be a positive integer`);
    return value;
  }

  fsReadTextFile(params: Params): { content: string } {
    const real = resolveInside(params.path, this.workspace);
    const line = ClientCaps.#positiveInt(params.line, 'line');
    const limit = ClientCaps.#positiveInt(params.limit, 'limit');
    if (!isfile(real)) throw new CapError('path is not a regular file');
    if (line === null && limit === null && getsize(real) > MAX_READ_BYTES) {
      throw new CapError(`File is larger than ${MAX_READ_BYTES} bytes; request a slice with line and limit`);
    }
    const start = (line ?? 1) - 1;
    const out: Uint8Array[] = [];
    let size = 0;
    let scanned = 0;
    let index = 0;
    const file = Deno.openSync(real, { read: true });
    try {
      const chunk = new Uint8Array(65536);
      let pending: Uint8Array[] = [];
      let pendingSize = 0;
      let eof = false;
      // Returns false to stop reading.
      const take = (raw: Uint8Array): boolean => {
        scanned += raw.length;
        if (index === 0 && raw.subarray(0, 8192).includes(0)) throw new CapError('File looks binary, not text');
        if (index < start) {
          if (scanned > MAX_SCAN_BYTES) throw new CapError('File is too large to seek to that line');
          index++;
          return true;
        }
        if (limit !== null && out.length >= limit) return false;
        size += raw.length;
        if (size > MAX_READ_BYTES) throw new CapError(`Requested text exceeds ${MAX_READ_BYTES} bytes; request fewer lines`);
        out.push(raw);
        index++;
        return true;
      };
      const joinPending = (tail: Uint8Array): Uint8Array => {
        const raw = new Uint8Array(pendingSize + tail.length);
        let at = 0;
        for (const part of pending) {
          raw.set(part, at);
          at += part.length;
        }
        raw.set(tail, at);
        pending = [];
        pendingSize = 0;
        return raw;
      };
      reading: while (!eof) {
        const got = file.readSync(chunk);
        if (got === null || got === 0) {
          eof = true;
          if (pendingSize) take(joinPending(new Uint8Array(0)));
          break;
        }
        let from = 0;
        const data = chunk.subarray(0, got);
        for (;;) {
          const nl = data.indexOf(10, from);
          if (nl < 0) {
            const rest = data.slice(from);
            pending.push(rest);
            pendingSize += rest.length;
            // A line longer than every cap is refused as soon as it is known to be too long (Python reads it whole first).
            if (index === 0 && pendingSize >= 8192 && joinPeek(pending).includes(0)) throw new CapError('File looks binary, not text');
            if (index < start && scanned + pendingSize > MAX_SCAN_BYTES) throw new CapError('File is too large to seek to that line');
            if (index >= start && size + pendingSize > MAX_READ_BYTES) {
              throw new CapError(`Requested text exceeds ${MAX_READ_BYTES} bytes; request fewer lines`);
            }
            break;
          }
          if (!take(joinPending(data.subarray(from, nl + 1))) || (limit !== null && out.length >= limit)) break reading;
          from = nl + 1;
        }
      }
    } finally {
      file.close();
    }
    let total = 0;
    for (const part of out) total += part.length;
    const all = new Uint8Array(total);
    let at = 0;
    for (const part of out) {
      all.set(part, at);
      at += part.length;
    }
    return { content: new TextDecoder().decode(all) };
  }

  fsWriteTextFile(params: Params): null {
    const content = params.content;
    if (typeof content !== 'string') throw new CapError('content must be a string');
    const data = new TextEncoder().encode(content);
    if (data.length > MAX_WRITE_BYTES) throw new CapError(`content exceeds ${MAX_WRITE_BYTES} bytes`);
    const real = resolveInside(params.path, this.workspace);
    if (normpath(real).split(SEP).some((part) => part.toLowerCase() === '.git')) {
      throw new CapError('Writing inside a .git folder is not allowed');
    }
    if (isdir(real)) throw new CapError('path is a directory');
    const created = !exists(real);
    // real is already inside the workspace, so any directories created here are too.
    Deno.mkdirSync(dirname(real), { recursive: true });
    writeJsonAtomic(real, null, { text: content, prefix: '.studio-write-', suffix: '.tmp' });
    const entry: WriteEntry = { path: real, bytes: data.length, created, sessionId: params.sessionId ?? null, time: Date.now() / 1000 };
    this.writes.push(entry);
    if (this.writes.length > RECENT_WRITES) this.writes.splice(0, this.writes.length - RECENT_WRITES);
    this.record('client_fs', { ...entry, op: 'write' });
    return null;
  }

  // --- terminals -----------------------------------------------------------------
  #terminal(params: Params): Terminal {
    const id = params.terminalId;
    const terminal = typeof id === 'string' ? this.terminals.get(id) : undefined;
    if (terminal === undefined || terminal.sessionId !== params.sessionId || terminal.released) throw new CapError('Unknown terminalId');
    return terminal;
  }

  #environment(requested: unknown): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(Deno.env.toObject())) {
      // Python's os.environ has upper-case names on Windows.
      if (BASE_ENV_NAMES.includes(key.toUpperCase())) env[WIN ? key.toUpperCase() : key] = value;
    }
    if (requested === null || requested === undefined) return env;
    if (!Array.isArray(requested) || requested.length > MAX_ENV) {
      throw new CapError(`env must be a list of at most ${MAX_ENV} name/value objects`);
    }
    for (const item of requested) {
      if (!isDict(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
        throw new CapError('Each env entry needs string name and value');
      }
      if (!ENV_NAME.test(item.name) || item.value.includes('\0') || pyLen(item.value) > MAX_ARG_CHARS) {
        throw new CapError(`Invalid environment variable: ${pyRepr(clip(item.name, 40))}`);
      }
      env[item.name] = item.value;
    }
    return env;
  }

  terminalCreate(params: Params): { terminalId: string } {
    const command = params.command;
    let args = Object.hasOwn(params, 'args') ? params.args : [];
    if (typeof command !== 'string' || !pyStrip(command) || command.includes('\0') || pyLen(command) > 4096) {
      throw new CapError('command must be a non-empty string');
    }
    if (args === null || args === undefined) args = [];
    if (
      !Array.isArray(args) || args.length > MAX_ARGS ||
      args.some((a) => typeof a !== 'string' || a.includes('\0') || pyLen(a) > MAX_ARG_CHARS)
    ) throw new CapError(`args must be a list of at most ${MAX_ARGS} strings`);
    const argList = args as string[];
    const cwd = params.cwd === null || params.cwd === undefined ? this.workspace : resolveInside(params.cwd, this.workspace, 'cwd');
    if (!isdir(cwd)) throw new CapError('cwd is not an existing directory');
    let limit = params.outputByteLimit;
    if (limit === null || limit === undefined) limit = DEFAULT_OUTPUT_LIMIT;
    else if (!isInt(limit) || limit < 0) throw new CapError('outputByteLimit must be a non-negative integer');
    const byteLimit = Math.min(limit as number, MAX_OUTPUT_LIMIT);
    const env = this.#environment(params.env);
    const program = dirname(command) ? command : whichIn(command, env.PATH || (WIN ? '.;C:\\bin' : '/bin:/usr/bin'));
    if (!program || !isfile(program)) throw new CapError(`Command not found: ${clip(command, 80)}`);
    if (WIN && /\.(bat|cmd)$/i.test(program)) {
      throw new CapError('Batch files (.bat/.cmd) are not allowed because cmd.exe would reinterpret the arguments');
    }
    if (this.shut) throw new CapError('Connection is closing', -32603);
    if ([...this.terminals.values()].filter((t) => !t.released).length >= MAX_TERMINALS) {
      throw new CapError(`At most ${MAX_TERMINALS} terminals may be open at once; release one first`);
    }
    let process: Deno.ChildProcess;
    try {
      process = new Deno.Command(program, {
        args: argList,
        cwd,
        env,
        clearEnv: true,
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
        ...treeSpawnOptions(),
      }).spawn();
    } catch (error) {
      throw new CapError(`Could not start command: ${error instanceof Error ? error.message : error}`, -32603);
    }
    const id = 'term_' + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.terminals.set(id, new Terminal(id, params.sessionId as string, [command, ...argList], cwd, process, byteLimit));
    this.record('client_terminal', { op: 'create', terminalId: id, command, args: argList.slice(0, 20), cwd });
    return { terminalId: id };
  }

  terminalOutput(params: Params): { output: string; truncated: boolean; exitStatus?: ExitStatus } {
    const terminal = this.#terminal(params);
    const [output, truncated] = terminal.snapshot();
    const result: { output: string; truncated: boolean; exitStatus?: ExitStatus } = { output, truncated };
    const status = terminal.exitStatus();
    if (status) result.exitStatus = status;
    return result;
  }

  async terminalWaitForExit(params: Params): Promise<ExitStatus> {
    const terminal = this.#terminal(params);
    await terminal.exited;
    return terminal.exitStatus() ?? { exitCode: null, signal: null };
  }

  async terminalKill(params: Params): Promise<null> {
    await this.#terminal(params).kill();
    return null;
  }

  async terminalRelease(params: Params): Promise<null> {
    const terminal = this.#terminal(params);
    terminal.released = true;
    await terminal.kill();
    this.terminals.delete(terminal.id);
    this.record('client_terminal', { op: 'release', terminalId: terminal.id });
    return null;
  }

  // --- cleanup and state ---------------------------------------------------------
  async closeSession(sessionId: string): Promise<void> {
    const victims = [...this.terminals.values()].filter((t) => t.sessionId === sessionId);
    for (const t of victims) {
      t.released = true;
      this.terminals.delete(t.id);
    }
    await Promise.all(victims.map((t) => t.kill()));
  }

  async shutdown(): Promise<void> {
    this.shut = true;
    const victims = [...this.terminals.values()];
    this.terminals.clear();
    for (const t of victims) t.released = true;
    await Promise.all(victims.map((t) => t.kill()));
  }

  public(): Record<string, unknown> {
    const rows = [...this.terminals.values()].map((t) => {
      const [output, truncated] = t.snapshot();
      const status = t.exitStatus();
      const chars = [...output];
      return {
        id: t.id,
        sessionId: t.sessionId,
        command: clip([t.argv[0], ...t.argv.slice(1)].join(' '), 500),
        cwd: t.cwd,
        status: t.status(),
        exitCode: status ? status.exitCode : null,
        signal: status ? status.signal : null,
        truncated: truncated || chars.length > TAIL_CHARS,
        outputTail: chars.slice(-TAIL_CHARS).join(''),
      };
    });
    return { terminal: this.terminalEnabled, fs: this.fsMode, terminals: rows, writes: this.writes.map((w) => ({ ...w })) };
  }
}

function joinPeek(parts: Uint8Array[]): Uint8Array {
  const first = parts[0] ?? new Uint8Array(0);
  if (first.length >= 8192 || parts.length === 1) return first.subarray(0, 8192);
  const out = new Uint8Array(8192);
  let at = 0;
  for (const part of parts) {
    const take = Math.min(part.length, 8192 - at);
    out.set(part.subarray(0, take), at);
    at += take;
    if (at >= 8192) break;
  }
  return out.subarray(0, at);
}
