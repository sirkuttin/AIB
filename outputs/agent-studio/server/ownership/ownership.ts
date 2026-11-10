/**
 * Cross-process session ownership and conservative external-process detection (ownership.py).
 *
 * SessionLease is an advisory, nonblocking lease per (provider, session id). The lease file name and the lock are the Python server's
 * (sha256 of the compact JSON [provider, session] under <state>/session-leases/; msvcrt byte-0 lock on Windows, flock elsewhere,
 * through platform/lock.ts tryLockNow), so a Python host and a Deno host exclude each other.
 */
import { createHash } from 'node:crypto';
import { LockHeld, tryLockNow } from '../platform/lock.ts';
import { basename, join, WIN } from '../platform/ospath.ts';
import { isDict, pyRepr, pyStr, pyStrip } from '../core/py.ts';

/** Raised when another process already owns a provider/session lease. */
export class OwnershipConflict extends Error {
  override name = 'OwnershipConflict';
}

/** An advisory, nonblocking lease held for this process lifetime. */
export class SessionLease {
  readonly stateDir: string;
  readonly provider: string;
  readonly sessionId: string;
  path: string;
  #file: Deno.FsFile | null = null;

  constructor(stateDir: string, provider: string, sessionId: string) {
    this.stateDir = String(stateDir);
    this.provider = String(provider);
    this.sessionId = String(sessionId);
    const key = JSON.stringify([this.provider, this.sessionId]); // json.dumps(..., ensure_ascii=False, separators=(",", ":"))
    const digest = createHash('sha256').update(new TextEncoder().encode(key)).digest('hex');
    this.path = join(this.stateDir, 'session-leases', digest + '.lock');
  }

  /**
   * A lease for an existing lease file whose provider and session id are unknown (the file name is only their hash).
   * Use acquire(false) so that probing never changes the file.
   */
  static atPath(path: string): SessionLease {
    const lease = new SessionLease('', '', '');
    lease.path = String(path);
    return lease;
  }

  get held(): boolean {
    return this.#file !== null;
  }

  /** Take the lease or throw OwnershipConflict. create=false only opens an existing file and never writes to it. */
  async acquire(create = true): Promise<this> {
    if (this.#file !== null) return this;
    try {
      this.#file = await tryLockNow(this.path, create);
    } catch (error) {
      if (error instanceof LockHeld) {
        throw new OwnershipConflict(`Session ${pyRepr(this.sessionId)} is already owned for provider ${pyRepr(this.provider)}`);
      }
      if (create) throw error;
      throw new OwnershipConflict(`Lease file ${this.path} cannot be opened: ${error instanceof Error ? error.message : error}`);
    }
    return this;
  }

  release(): void {
    const file = this.#file;
    this.#file = null;
    if (file === null) return;
    try {
      file.unlockSync();
    } finally {
      file.close();
    }
  }

  [Symbol.dispose](): void {
    this.release();
  }
}

/** Python's shlex.split(command, posix=...) (comments off, whitespace split). Throws on an unclosed quote or a trailing escape. */
export function shlexSplit(text: string, posix: boolean): string[] {
  const WHITESPACE = ' \t\r\n';
  const QUOTES = `'"`;
  const out: string[] = [];
  let state: string | null = ' ';
  let token = '';
  let quoted = false;
  let escaped = 'a';
  let i = 0;
  const emit = () => {
    if (posix && !quoted && token === '') return;
    out.push(token);
  };
  while (state !== null) {
    const ch = i < text.length ? text[i] : '';
    i++;
    if (state === ' ') {
      if (!ch) {
        state = null;
      } else if (WHITESPACE.includes(ch)) {
        if (token || (posix && quoted)) {
          emit();
          token = '';
          quoted = false;
        }
      } else if (posix && ch === '\\') {
        escaped = 'a';
        state = ch;
      } else if (QUOTES.includes(ch)) {
        if (!posix) token = ch;
        state = ch;
      } else {
        token = ch;
        state = 'a';
      }
    } else if (QUOTES.includes(state)) {
      quoted = true;
      if (!ch) throw new Error('No closing quotation');
      if (ch === state) {
        if (!posix) {
          token += ch;
          emit();
          token = '';
          quoted = false;
          state = ' ';
        } else state = 'a';
      } else if (posix && ch === '\\' && state === '"') {
        escaped = state;
        state = ch;
      } else token += ch;
    } else if (state === '\\') {
      if (!ch) throw new Error('No escaped character');
      if (QUOTES.includes(escaped) && ch !== state && ch !== escaped) token += state;
      token += ch;
      state = escaped;
    } else { // 'a'
      if (!ch) {
        state = null;
      } else if (WHITESPACE.includes(ch)) {
        state = ' ';
        if (token || (posix && quoted)) {
          emit();
          token = '';
          quoted = false;
        }
      } else if (posix && QUOTES.includes(ch)) {
        state = ch;
      } else if (posix && ch === '\\') {
        escaped = 'a';
        state = ch;
      } else token += ch;
    }
  }
  if (token || (posix && quoted)) emit();
  return out;
}

type Mapping = Record<string, unknown>;

/** dict.get(key, default) */
function get(proc: Mapping, key: string, fallback: unknown): unknown {
  return Object.hasOwn(proc, key) ? proc[key] : fallback;
}

/** int(value) for the values a process list holds; null where Python raises. */
export function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string') {
    const text = pyStrip(value);
    return /^[+-]?\d+(?:_\d+)*$/.test(text) ? parseInt(text.replaceAll('_', ''), 10) : null;
  }
  return null;
}

/** os.path.basename(str(value)) */
function pathBase(value: unknown): string {
  return basename(pyStr(value));
}

function argvForProcess(proc: Mapping): string[] {
  const argv = proc.argv;
  if (Array.isArray(argv)) return argv.map(pyStr);
  const command = get(proc, 'commandline', get(proc, 'CommandLine', proc.cmdline));
  if (Array.isArray(command)) return command.map(pyStr);
  if (typeof command !== 'string') return [];
  try {
    return shlexSplit(command, !WIN);
  } catch {
    return [];
  }
}

function isAgent(proc: Mapping, argv: string[]): boolean {
  let rawName = get(proc, 'name', get(proc, 'Name', get(proc, 'executable', '')));
  if (!rawName && argv.length) rawName = argv[0];
  let name = pathBase(rawName).toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -4);
  return name === 'claude' || name === 'omp';
}

function* sessionArguments(argv: string[]): Generator<string> {
  // Require an explicit session selector and compare its complete value.
  let index = 1;
  while (index < argv.length) {
    const token = argv[index];
    if (token === '--resume' || token === '--session-id') {
      if (index + 1 < argv.length) yield pyStrip(argv[index + 1], '"');
      index += 2;
      continue;
    }
    for (const option of ['--resume=', '--session-id=']) {
      if (token.startsWith(option)) {
        yield pyStrip(token.slice(option.length), '"');
        break;
      }
    }
    index += 1;
  }
}

/** A matching external PID, or null when no ownership evidence exists. */
export function findExternalOwner(
  processes: Iterable<unknown>,
  provider: unknown,
  sessionId: unknown,
  excludedPids: Iterable<unknown> = [],
): number | null {
  const providerKey = String(provider).toLowerCase();
  if (providerKey !== 'claude' && providerKey !== 'omp') return null;
  const excluded = new Set<number>();
  for (const pid of excludedPids) {
    const value = pyInt(pid);
    if (value === null) throw new TypeError(`invalid excluded pid: ${pyRepr(pid)}`);
    excluded.add(value);
  }
  const wanted = pyStr(sessionId);
  for (const proc of processes) {
    if (!isDict(proc)) continue;
    const pid = pyInt(get(proc, 'pid', get(proc, 'ProcessId', proc.process_id)));
    if (pid === null || excluded.has(pid)) continue;
    const argv = argvForProcess(proc);
    if (!isAgent(proc, argv)) continue;
    const rawName = get(proc, 'name', get(proc, 'Name', get(proc, 'executable', argv.length ? argv[0] : '')));
    let image = pathBase(rawName).toLowerCase();
    if (image.endsWith('.exe')) image = image.slice(0, -4);
    if (image !== providerKey) continue;
    for (const value of sessionArguments(argv)) if (value === wanted) return pid;
  }
  return null;
}

/** Read-only Windows process probe. null means probe unavailable or no evidence. */
export async function probeExternalOwner(
  provider: unknown,
  sessionId: unknown,
  excludedPids: Iterable<unknown> = [],
): Promise<number | null> {
  if (!WIN || !['claude', 'omp'].includes(String(provider).toLowerCase())) return null;
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('claude.exe','omp.exe') } | Select-Object ProcessId,Name,CommandLine | " +
    'ConvertTo-Json -Compress';
  try {
    const done = await new Deno.Command('powershell.exe', {
      args: ['-NoProfile', '-NonInteractive', '-Command', script],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'piped',
      signal: AbortSignal.timeout(8000),
    }).output();
    if (!done.success) return null;
    let data = JSON.parse(new TextDecoder().decode(done.stdout) || '[]');
    if (isDict(data)) data = [data];
    if (!Array.isArray(data)) return null;
    return findExternalOwner(data, provider, sessionId, excludedPids);
  } catch {
    return null;
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
    console.error('usage: ownership.ts --provider {omp,claude} --session ID');
    Deno.exit(2);
  }
  const owner = await probeExternalOwner(provider, session);
  console.log(JSON.stringify({ ownerPid: owner, state: owner !== null ? 'external_owner_found' : 'unknown' }));
}
