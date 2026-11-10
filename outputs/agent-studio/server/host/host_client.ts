/**
 * Client side of the agent host protocol: find, start, call and stop the long-lived agent host (host_client.py, docs/agent-host.md).
 * Same file (agent-host.json), token header, protocol number, takeover rules and messages as the Python client, so during the
 * rewrite a Deno web server attaches to the Python agent host and vice versa.
 */
import { spawnDetached } from '../platform/spawn_detached.ts';
import { processAlive } from '../platform/process_info.ts';
import { APP_ROOT, APP_VERSION, isCompiled, launchDir } from '../core/app.ts';
import { pyJsonDumps } from '../core/py.ts';

export const PROTOCOL_VERSION = 4;
export const HOST_FORMAT = 'agent-studio-host';
export const INFO_NAME = 'agent-host.json';
export const LOG_NAME = 'agent-host.log';
export const TOKEN_HEADER = 'X-Agent-Host-Token';
export const MAX_RPC_BYTES = 64 * 1024 * 1024;
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP = 2;
export const APP_ID = Deno.env.get('AIB_APP_ID') || 'studio-dev';
export { APP_VERSION };

const isWindows = Deno.build.os === 'windows';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sep = isWindows ? '\\' : '/';
const joinPath = (dir: string, name: string) => dir.replace(/[\\/]+$/, '') + sep + name;

/** os.path.normcase: lower case and backslashes on Windows, unchanged elsewhere. */
export function normcase(path: string): string {
  return isWindows ? path.replaceAll('/', '\\').toLowerCase() : path;
}

/**
 * Where the running code comes from, as hosts publish it (codeRoot) for the takeover rule: the app folder under `deno run`; for a
 * built binary its own path (APP_ROOT is then a folder inside the binary, and differs between builds and runs).
 */
export function codeRootFor(exe: string = Deno.execPath()): string {
  return normcase(isCompiled(exe) ? exe : APP_ROOT);
}
export const CODE_ROOT = codeRootFor();
const HASH_SKIP_DIRS = new Set(['__pycache__', 'docs', 'node_modules', '.git']);

/**
 * Every file ending in `ext` under root/<under> outside HASH_SKIP_DIRS as (posix name relative to root, path), sorted like Python's
 * sorted() on the names.
 */
async function sourceFiles(root: string, ext = '.py', under: string[] = []): Promise<[string, string][]> {
  const found: [string, string][] = [];
  async function walk(dir: string, rel: string[]) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory) {
        if (!HASH_SKIP_DIRS.has(entry.name)) await walk(joinPath(dir, entry.name), [...rel, entry.name]);
      } else if (entry.name.endsWith(ext)) found.push([[...rel, entry.name].join('/'), joinPath(dir, entry.name)]);
    }
  }
  try {
    await walk(under.reduce(joinPath, root), under);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * sha256 over the relative names and bytes of the .py files under the app folder: identifies the code a Python host loaded. A Deno
 * web server that meets a Python host computes the same value, so code_warning compares like with like.
 */
export function sourceHash(root = APP_ROOT): Promise<string> {
  return hashFiles(sourceFiles(root));
}

/**
 * The same digest over the .ts files under <app>/server/ (names like "server/host/studio.ts"): identifies the code a Deno host
 * loaded. A Deno web server and a Deno host started from the same folder compute the same value.
 */
export function denoSourceHash(root = APP_ROOT): Promise<string> {
  return hashFiles(sourceFiles(root, '.ts', ['server']));
}

async function hashFiles(listing: Promise<[string, string][]>): Promise<string> {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, path] of await listing) {
    try {
      parts.push(enc.encode(name), new Uint8Array([0]), await Deno.readFile(path), new Uint8Array([0]));
    } catch {
      parts.push(enc.encode(name + '\0?'));
    }
  }
  const total = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) total.set(p, (offset += p.byteLength) - p.byteLength);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', total))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let sourceHashCache: Promise<string> | null = null;
let denoHashCache: Promise<string> | null = null;
/** The .py digest (what a Python host reports), computed once per process. */
export function SOURCE_HASH(): Promise<string> {
  return (sourceHashCache ??= sourceHash());
}
/**
 * The digest a built binary reports instead of the .ts digest: sha256 over its path, APP_VERSION, size and modification time. The
 * web server and the host it starts are the same file, so they agree; a rebuilt or updated binary differs (the updater replaces
 * the file, which changes size or mtime). Hashing the whole binary (~100 MB) on every start would cost more than it tells.
 */
export async function binaryHash(exe: string = Deno.execPath()): Promise<string> {
  let size = -1, mtime = -1;
  try {
    const stat = await Deno.stat(exe);
    size = stat.size;
    mtime = stat.mtime?.getTime() ?? -1;
  } catch { /* unreadable: still a stable value for this process */ }
  const text = ['aib-binary/v1', normcase(exe), APP_VERSION, String(size), String(mtime)].join('\0');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The .ts digest (what a Deno host reports; for a built binary its binaryHash), computed once per process. */
export function DENO_SOURCE_HASH(): Promise<string> {
  return (denoHashCache ??= isCompiled() ? binaryHash() : denoSourceHash());
}

/**
 * Which program an agent host is. A Deno host writes `runtime: "deno"` into agent-host.json and its info; the Python host
 * (agent_host.py) writes no runtime field, so a missing one means Python. A host of the other runtime from the same folder is
 * treated like a host from another code folder (HostForeignRoot): taken over when no chat works there, waited for otherwise.
 */
export const RUNTIME = 'deno';
export function hostRuntime(info: unknown): string {
  const value = info && typeof info === 'object' ? (info as Record<string, unknown>).runtime : undefined;
  return typeof value === 'string' && value ? value : 'python';
}

/** The digest of the code a host of this runtime loads, computed from this folder (for code_warning). */
export function sourceHashFor(runtime: string): Promise<string> {
  return runtime === 'deno' ? DENO_SOURCE_HASH() : SOURCE_HASH();
}

export type HostCode = 'host_unreachable' | 'host_incompatible' | 'host_auth' | 'host_waiting' | 'host_stopped' | string;

/** The agent host cannot be used right now. `code` says why; `delivered` is false only when the request never left. */
export class HostUnavailable extends Error {
  constructor(message: string, readonly code: HostCode = 'host_unreachable', readonly delivered = true) {
    super(message);
  }
}

export class HostIncompatible extends HostUnavailable {
  constructor(message: string, readonly info: Record<string, unknown> = {}) {
    super(message, 'host_incompatible', false);
  }
}

/** A live host was started from a different code folder (see takeOver). */
export class HostForeignRoot extends HostIncompatible {}

/** A host from another code folder still has chats working. It is left running; the caller waits and retries. */
export class HostBusy extends HostUnavailable {
  constructor(message: string, readonly info: Record<string, unknown> = {}, readonly chats = 0) {
    super(message, 'host_waiting', false);
  }
}

/** Errors the host reports by Python exception type, mapped like host_client.HostClient.call. */
export class HostValueError extends Error {}
export class HostOSError extends Error {}

export type HostInfo = Record<string, unknown> & { port: number; token: string; pid?: number };

/** A sentence when the running host loaded different code than this process, else ''. */
export async function codeWarning(hostInfo: unknown): Promise<string> {
  if (typeof hostInfo !== 'object' || hostInfo === null) return '';
  const info = hostInfo as Record<string, unknown>;
  if (!info.pid && !info.hostId) return '';
  const theirs = info.sourceHash;
  if (theirs === undefined || theirs === null) {
    return 'The running agent host was started by an older version of Agent Studio. Restart it (python studio.py --stop-host) to use the current code.';
  }
  if (theirs !== await sourceHashFor(hostRuntime(info))) {
    return 'The running agent host is running older code than this web server. Restart it (python studio.py --stop-host) when no conversation is working.';
  }
  return '';
}

export const infoPath = (stateDir: string) => joinPath(stateDir, INFO_NAME);
export const logPath = (stateDir: string) => joinPath(stateDir, LOG_NAME);

/** The host's published address and token, or null when no host file exists. Retries a half-replaced file. */
export async function readInfo(stateDir: string): Promise<HostInfo | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let data: unknown;
    try {
      data = JSON.parse(await Deno.readTextFile(infoPath(stateDir)));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      await sleep(50 * (attempt + 1));
      continue;
    }
    const d = data as Record<string, unknown>;
    if (d && typeof d === 'object' && d.format === HOST_FORMAT && Number.isInteger(d.port) && typeof d.token === 'string') {
      return d as HostInfo;
    }
    return null;
  }
  return null;
}

/** Best effort: make a secrets file readable by the current user only. */
export async function restrictToUser(path: string): Promise<void> {
  try {
    if (isWindows) {
      const user = Deno.env.get('USERNAME');
      if (!user) return;
      await new Deno.Command('icacls', { args: [path, '/inheritance:r', '/grant:r', `${user}:F`], stdout: 'null', stderr: 'null' })
        .output();
      try {
        await Deno.readFile(path);
      } catch { // never lock ourselves out
        await new Deno.Command('icacls', { args: [path, '/reset'], stdout: 'null', stderr: 'null' }).output();
      }
    } else {
      await Deno.chmod(path, 0o600);
    }
  } catch { /* best effort */ }
}

/** Keep a log under about maxBytes: path -> path.1 -> path.2; the oldest beyond `keep` is dropped. True when rotated. */
export async function rotateLog(path: string, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP, copyTruncate = false): Promise<boolean> {
  try {
    if ((await Deno.stat(path)).size < maxBytes) return false;
  } catch {
    return false;
  }
  try {
    for (let number = keep; number >= 1; number--) {
      const older = `${path}.${number}`;
      if (number === keep) await Deno.remove(older).catch(() => {});
      const newer = number === 1 ? path : `${path}.${number - 1}`;
      if (number === 1 && copyTruncate) {
        await Deno.copyFile(path, older);
        await Deno.truncate(path, 0);
      } else if (await exists(newer)) await Deno.rename(newer, older);
    }
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Atomically publish the host file (address + token), restricted to the current user. */
export async function writeInfo(stateDir: string, info: Record<string, unknown>): Promise<void> {
  await Deno.mkdir(stateDir, { recursive: true });
  const path = infoPath(stateDir);
  const temporary = `${path}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(temporary, JSON.stringify(info, null, 1));
  await restrictToUser(temporary);
  await Deno.rename(temporary, path);
}

/** Remove the host file, but only ours when a pid is given. */
export async function removeInfo(stateDir: string, pid: number | null = null): Promise<boolean> {
  const current = await readInfo(stateDir);
  if (current === null || (pid !== null && current.pid !== pid)) return false;
  try {
    await Deno.remove(infoPath(stateDir));
    return true;
  } catch {
    return false;
  }
}

export function pidAlive(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  if (isWindows) return processAlive(pid as number) === true;
  try {
    Deno.kill(pid as number, 'SIGCONT');
    return true;
  } catch (error) {
    return error instanceof Deno.errors.PermissionDenied;
  }
}

/** One authenticated channel to a host: JSON over loopback HTTP, one request per connection. */
export class HostClient {
  readonly port: number;
  readonly token: string;
  readonly pid: number | undefined;
  constructor(readonly info: HostInfo) {
    this.port = info.port;
    this.token = info.token;
    this.pid = info.pid;
  }

  /**
   * One RPC. Like http.client in the Python client, connecting and sending are separate steps: a failure while connecting means the
   * request never left (delivered=false, safe to retry), a failure after that may have reached the host (delivered=true).
   * Raw HTTP/1.0 over TCP: the host answers one request per connection and closes it.
   */
  async call(op: string, args: unknown = null, timeoutSeconds = 30): Promise<unknown> {
    const body = new TextEncoder().encode(JSON.stringify({ op, args: args ?? {} }));
    const deadline = Date.now() + timeoutSeconds * 1000;
    const timeout = <T>(work: Promise<T>, onTimeout: () => void): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(new Error('timed out'));
          }, Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
    };
    let conn: Deno.TcpConn;
    try {
      const connecting = Deno.connect({ hostname: '127.0.0.1', port: this.port });
      conn = await timeout(connecting, () => connecting.then((c) => c.close(), () => {}));
    } catch (error) {
      throw new HostUnavailable(`The agent host is not accepting connections (${errorText(error)}).`, 'host_unreachable', false);
    }
    let raw: Uint8Array;
    try {
      const head =
        `POST /rpc HTTP/1.0\r\nHost: 127.0.0.1:${this.port}\r\nContent-Type: application/json\r\n${TOKEN_HEADER}: ${this.token}\r\n` +
        `Content-Length: ${body.byteLength}\r\n\r\n`;
      raw = await timeout(
        (async () => {
          const writer = conn.writable.getWriter();
          await writer.write(new TextEncoder().encode(head));
          await writer.write(body);
          writer.releaseLock();
          return new Uint8Array(await new Response(conn.readable).arrayBuffer());
        })(),
        () => {
          try {
            conn.close();
          } catch { /* closed */ }
        },
      );
    } catch (error) {
      throw new HostUnavailable(`The agent host stopped answering (${errorText(error)}).`, 'host_unreachable', true);
    } finally {
      try {
        conn.close();
      } catch { /* already closed by the reader */ }
    }
    const split = indexOfCrlfCrlf(raw);
    const statusMatch = split < 0 ? null : new TextDecoder().decode(raw.subarray(0, split)).match(/^HTTP\/\d\.\d (\d{3})/);
    if (!statusMatch) throw new HostUnavailable('The agent host stopped answering (no HTTP response).', 'host_unreachable', true);
    const status = Number(statusMatch[1]);
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(split + 4)));
    } catch {
      throw new HostUnavailable('The agent host sent an unreadable answer.', 'host_unreachable');
    }
    const dict = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
    if (status === 200 && dict) return dict.result ?? null;
    if (status === 403) {
      throw new HostUnavailable('The agent host refused this web server (token or peer check failed).', 'host_auth', false);
    }
    const response = { status };
    const message = dict ? String(dict.error || `HTTP ${response.status}`) : `HTTP ${response.status}`;
    const kind = dict?.errorType;
    if (kind === 'KeyError' || kind === 'ValueError' || kind === 'TypeError') throw new HostValueError(message);
    if (kind === 'OSError' || kind === 'TimeoutError') throw new HostOSError(message);
    throw new Error(message);
  }
}

function indexOfCrlfCrlf(data: Uint8Array): number {
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) return i;
  }
  return -1;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function incompatible(live: Record<string, unknown>, info: HostInfo): HostIncompatible {
  const busy = Array.isArray(live.active) ? live.active : [];
  const note = busy.length
    ? ` It has ${busy.length} conversation(s) that are working or waiting, so it was left running.`
    : live.open
    ? ` It has ${live.open} open conversation(s), so it was left running.`
    : '';
  return new HostIncompatible(
    `The running agent host (process ${pyStr(info.pid)}) speaks protocol ${
      pyStr(live.protocol)
    }; this web server needs protocol ${PROTOCOL_VERSION}.${note} ` +
      'Finish or interrupt the work, then run "python studio.py --stop-host" (or deploy.py --host) and restart the web server.',
    live,
  );
}

/** str() of a JSON value the way Python prints it in these messages (None for null/missing). */
function pyStr(value: unknown): string {
  return value === undefined || value === null ? 'None' : String(value);
}

function who(info: Record<string, unknown>): string {
  return `${info.appId || 'an older build'} ${info.version || ''}`.trim();
}

function article(runtime: string): string {
  return runtime === 'deno' ? 'a Deno' : runtime === 'python' ? 'a Python' : `a ${runtime}`;
}

/**
 * [client, liveInfo] for a reachable compatible host, null if there is none (or only a stale file).
 * Throws HostIncompatible for a different protocol and HostUnavailable for a live host that does not answer.
 */
export async function findHost(stateDir: string, runtime: string | null = null): Promise<[HostClient, Record<string, unknown>] | null> {
  const info = await readInfo(stateDir);
  if (!info) return null;
  const root = info.codeRoot;
  if (root && normcase(String(root)) !== CODE_ROOT && pidAlive(info.pid)) {
    throw new HostForeignRoot(
      `The agent host for this state folder (process ${pyStr(info.pid)}, ${
        who(info)
      }) was started from a different code folder (${root}); ` +
        `this web server runs from ${CODE_ROOT}.`,
      info,
    );
  }
  // runtime: the kind of host this web server starts. A host of the other kind (a Python host met by a Deno web server, or the
  // reverse) counts as foreign even from the same folder, so one kind owns the host file: the takeover path stops it when no chat
  // works there and starts ours; while chats work, it is left running and waited for (the banner).
  if (runtime && hostRuntime(info) !== runtime && pidAlive(info.pid)) {
    throw new HostForeignRoot(
      `The agent host for this state folder (process ${pyStr(info.pid)}, ${who(info)}) is ${article(hostRuntime(info))} agent host; ` +
        `this web server runs ${article(runtime)} one.`,
      info,
    );
  }
  const client = new HostClient(info);
  let live: unknown;
  try {
    live = await client.call('info', null, 5);
  } catch (error) {
    if (!(error instanceof HostUnavailable)) throw error;
    if (error.code === 'host_auth') throw error;
    if (pidAlive(info.pid) && error.delivered) {
      throw new HostUnavailable(
        `An agent host (process ${pyStr(info.pid)}) is running but did not answer: ${error.message}`,
        'host_unreachable',
      );
    }
    return null;
  }
  const liveDict = typeof live === 'object' && live !== null && !Array.isArray(live) ? live as Record<string, unknown> : null;
  if (!liveDict || liveDict.protocol !== PROTOCOL_VERSION) throw incompatible(liveDict ?? {}, info);
  return [client, liveDict];
}

async function waitGone(pid: unknown, seconds: number): Promise<boolean> {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return !pidAlive(pid);
}

async function takeOver(stateDir: string, foreign: HostForeignRoot, say: (m: string) => void): Promise<void> {
  const info = foreign.info as HostInfo;
  let result: unknown;
  try {
    result = await new HostClient(info).call('stop', { force: false }, 15);
  } catch (error) {
    if (!(error instanceof HostUnavailable)) throw error;
    if (error.code === 'host_auth' || (pidAlive(info.pid) && error.delivered)) {
      throw new HostUnavailable(
        `The agent host of ${who(info)} (process ${pyStr(info.pid)}) did not answer: ${error.message}`,
        'host_unreachable',
        false,
      );
    }
    await removeInfo(stateDir, (info.pid as number) ?? null);
    return;
  }
  const r = (result ?? {}) as Record<string, unknown>;
  if (!r.stopping) {
    const active = Array.isArray(r.active) ? r.active : [];
    const chats = active.length || 1;
    throw new HostBusy(
      `Another AIB version (${who(info)}) is running ${chats} chat(s); it will switch over when they finish.`,
      info,
      chats,
    );
  }
  say(`Took over from the agent host of ${who(info)} (process ${pyStr(info.pid)}): it had no chat working.`);
  if (!await waitGone(info.pid, 20)) {
    throw new HostUnavailable(
      `The previous agent host (process ${pyStr(info.pid)}) was told to stop but is still exiting.`,
      'host_unreachable',
      false,
    );
  }
}

export interface FindOrStartOptions {
  waitSeconds?: number;
  say?: (message: string) => void;
  replaceIdleIncompatible?: boolean;
  takeover?: boolean;
  /** Folder the host starts in. Default: launchDir() (the app folder, or a built binary's own folder: APP_ROOT is virtual there). */
  cwd?: string;
  /** The kind of host `command` starts ('deno' or 'python'); a live host of another kind is taken over like a foreign root. */
  runtime?: string | null;
}

/** Attach to the host for this state dir, starting one (detached) when none runs. Returns [client, liveInfo]. */
export async function findOrStart(
  stateDir: string,
  command: string[],
  options: FindOrStartOptions = {},
): Promise<[HostClient, Record<string, unknown>]> {
  const { waitSeconds = 40, say = () => {}, replaceIdleIncompatible = true, takeover = true, cwd = launchDir(), runtime = null } = options;
  let found: [HostClient, Record<string, unknown>] | null;
  try {
    found = await findHost(stateDir, runtime);
  } catch (error) {
    if (!(error instanceof HostIncompatible)) throw error;
    const live = error.info;
    if (error instanceof HostForeignRoot) {
      if (!takeover) throw error;
      await takeOver(stateDir, error, say);
      return findOrStart(stateDir, command, { ...options, takeover: false });
    }
    if (!(replaceIdleIncompatible && (live.open ?? 1) === 0)) throw error;
    say(`Replacing idle agent host with protocol ${pyStr(live.protocol)}.`);
    let stopped: unknown;
    try {
      const current = await readInfo(stateDir);
      if (!current) throw error;
      stopped = await new HostClient(current).call('stop', {}, 10);
    } catch {
      throw error;
    }
    if (!(stopped as Record<string, unknown> | null)?.stopping) throw error;
    await waitGone((await readInfo(stateDir))?.pid ?? live.pid, 20);
    found = null;
  }
  if (found) return found;
  await rotateLog(logPath(stateDir));
  const process = await spawnDetached(command, logPath(stateDir), cwd);
  say(`Started agent host process ${process.pid}.`);
  try {
    const deadline = Date.now() + waitSeconds * 1000;
    let exitedAt: number | null = null;
    while (Date.now() < deadline) {
      try {
        found = await findHost(stateDir, runtime);
      } catch (error) {
        if (error instanceof HostIncompatible) throw error;
        if (!(error instanceof HostUnavailable)) throw error;
        found = null;
      }
      if (found) return found;
      const code = process.exitCode();
      if (code !== null) {
        exitedAt ??= Date.now();
        if (Date.now() - exitedAt > 5000) { // a loser of a start race exits quietly; give the winner time to publish
          let tail = '';
          try {
            tail = (await Deno.readTextFile(logPath(stateDir))).slice(-600);
          } catch { /* no log */ }
          throw new HostUnavailable(
            `The agent host exited with code ${code} before it was ready. ${tail.trim()}`.trim(),
            'host_unreachable',
            false,
          );
        }
      }
      await sleep(150);
    }
    throw new HostUnavailable(
      `The agent host did not become ready within ${waitSeconds} seconds; see ${logPath(stateDir)}.`,
      'host_unreachable',
      false,
    );
  } finally {
    process.close();
  }
}

export interface StopResult {
  stopped: boolean;
  running?: boolean;
  refused?: boolean;
  active?: unknown[];
  message: string;
}

/** Ask the host to stop. Never kills a process. */
export async function stopHost(stateDir: string, force = false, waitSeconds = 20): Promise<StopResult> {
  const info = await readInfo(stateDir);
  if (!info) return { stopped: false, message: `No agent host is running for ${stateDir}.`, running: false };
  let result: unknown;
  try {
    result = await new HostClient(info).call('stop', { force }, 15);
  } catch (error) {
    if (!(error instanceof HostUnavailable)) throw error;
    if (pidAlive(info.pid) && error.delivered) {
      return {
        stopped: false,
        running: true,
        refused: true,
        message: `Agent host process ${pyStr(info.pid)} is running but did not answer: ${error.message}`,
      };
    }
    await removeInfo(stateDir, info.pid ?? null);
    return { stopped: true, running: false, message: `Agent host process ${pyStr(info.pid)} was not running; removed its stale file.` };
  }
  const r = (result ?? {}) as Record<string, unknown>;
  if (!r.stopping) {
    return {
      stopped: false,
      running: true,
      refused: true,
      active: Array.isArray(r.active) ? r.active : [],
      message: String(r.message ?? 'The agent host did not stop.'),
    };
  }
  const gone = await waitGone(info.pid, waitSeconds);
  return {
    stopped: gone,
    running: !gone,
    message: gone ? 'Agent host stopped.' : `Agent host process ${pyStr(info.pid)} was told to stop but is still exiting.`,
  };
}

// Kept for callers that log the JSON exactly as Python would.
export { pyJsonDumps };
