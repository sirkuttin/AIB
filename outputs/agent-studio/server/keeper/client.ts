/**
 * The keeper client: AIB's side of keeper/PROTOCOL.md (protocol 1). The keeper (AIB-keeper, Go) holds agent processes, records
 * everything they say and everything written to them, and serves that record; see the protocol file for every op and event.
 *
 * One KeeperClient is one authenticated connection. Requests are answered in order on a connection, events can come in between;
 * events are routed to the listener registered for their channel. ensureKeeper() finds the keeper for a data folder, or starts one
 * (detached and hidden) when none answers.
 *
 * Compatibility (the protocol's rule 4: AIB carries the burden): unknown events, response fields and record kinds are ignored, and a
 * feature is used only when hello's `features` lists it.
 */
import { createHash } from 'node:crypto';
import { APP_ROOT, APP_VERSION, isCompiled } from '../core/app.ts';
import { getLogger } from '../core/log.ts';
import { spawnDetached } from '../platform/spawn_detached.ts';
import { pidAlive } from '../host/host_client.ts';

const log = getLogger('keeper');
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
const ENC = new TextEncoder();
const DEC = new TextDecoder();

export const PROTOCOL = 1;
/**
 * What this AIB needs of a running keeper to run chats in it and to take them over after an update or restart (hello's
 * `features`). release.json carries it (tools/build.ts), so a running AIB can tell before Install now whether the new version can
 * drive the keeper that holds its chats. Every keeper ever released must keep satisfying the AIB that shipped with it (rule 4).
 */
export const KEEPER_NEEDS = ['notes', 'once', 'channel-ids'];
export const MAX_HEADER = 65536;
export const MAX_BODY = 16 * 1024 * 1024;
export const KEEPER_NAME = 'AIB-keeper';

type Json = Record<string, unknown>;

/** `<data>/keeper/keeper.json`, written by the keeper once it listens. */
export interface KeeperInfo {
  pid: number;
  protocol: number;
  keeper: string;
  transport: 'tcp' | 'unix';
  address: string;
  token: string;
  started: number;
  orphanCommand: OrphanCommand | null;
}

export interface OrphanCommand {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface SpawnSpec {
  channel?: string;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  windowsCommandLine?: string;
  pty?: { cols: number; rows: number };
}

/** One `list` entry. */
export interface ChannelInfo {
  channel: string;
  kind: 'pipe' | 'pty' | string;
  pid: number;
  command: string;
  args?: string[];
  cwd?: string;
  created: number;
  live: boolean;
  ended?: number;
  exitCode: number | null;
  reason?: string;
  epoch: number;
  first: number;
  last: number;
  owner: boolean;
}

export type RecordKind = 'out' | 'err' | 'in' | 'note' | 'exit' | 'resize' | string;

export interface KeeperRecord {
  channel: string;
  seq: number;
  kind: RecordKind;
  time: number;
  body: Uint8Array;
}

/** What a channel's listener gets: records, then `live` once the replay caught up; gap, fenced and removed when they happen. */
export interface ChannelListener {
  record?(record: KeeperRecord): void;
  live?(seq: number): void;
  gap?(from: number, next: number): void;
  fenced?(epoch: number): void;
  removed?(): void;
}

/** An `{"ok":false}` answer. `code` is the protocol's error code (section 7). */
export class KeeperError extends Error {
  override name = 'KeeperError';
  constructor(readonly code: string, message = '', readonly header: Json = {}) {
    super(message ? `${code}: ${message}` : code);
  }
}

// ---- framing ----------------------------------------------------------------------------------------------------------------

export function encodeFrame(header: Json, body: Uint8Array = new Uint8Array(0)): Uint8Array {
  const head = ENC.encode(JSON.stringify(header));
  if (head.length < 1 || head.length > MAX_HEADER) throw new RangeError('keeper frame header too large');
  if (body.length > MAX_BODY) throw new RangeError('keeper frame body too large');
  const frame = new Uint8Array(8 + head.length + body.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, head.length, true);
  frame.set(head, 4);
  view.setUint32(4 + head.length, body.length, true);
  frame.set(body, 8 + head.length);
  return frame;
}

/** Collects bytes and yields whole frames. Throws on a frame the protocol forbids (the connection is then closed). */
export class FrameReader {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): [Json, Uint8Array][] {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    const out: [Json, Uint8Array][] = [];
    let at = 0;
    while (true) {
      if (joined.length - at < 4) break;
      const view = new DataView(joined.buffer, joined.byteOffset + at);
      const headLength = view.getUint32(0, true);
      if (headLength < 1 || headLength > MAX_HEADER) throw new RangeError(`bad keeper frame header length ${headLength}`);
      if (joined.length - at < 8 + headLength) break;
      const bodyLength = view.getUint32(4 + headLength, true);
      if (bodyLength > MAX_BODY) throw new RangeError(`bad keeper frame body length ${bodyLength}`);
      const end = at + 8 + headLength + bodyLength;
      if (joined.length < end) break;
      const header = JSON.parse(DEC.decode(joined.subarray(at + 4, at + 4 + headLength)));
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new RangeError('keeper frame header is not an object');
      out.push([header as Json, joined.slice(at + 8 + headLength, end)]);
      at = end;
    }
    this.#buffer = joined.slice(at);
    return out;
  }
}

// ---- the connection ---------------------------------------------------------------------------------------------------------

interface Waiting {
  resolve(header: Json): void;
  reject(error: Error): void;
}

export class KeeperClient {
  readonly listeners = new Map<string, ChannelListener>();
  features: string[] = [];
  keeperVersion = '';
  keeperPid = 0;
  /** Called once when the connection ends (the keeper died, or close()). */
  onClose: ((error: Error | null) => void) | null = null;
  #conn: Deno.Conn;
  #nextId = 1;
  #waiting = new Map<number, Waiting>();
  #writes: Promise<void> = Promise.resolve();
  #closed = false;
  #closeError: Error | null = null;
  readonly done: Promise<void>;

  private constructor(conn: Deno.Conn) {
    this.#conn = conn;
    this.done = this.#readLoop();
  }

  /** Dial and authenticate. Throws KeeperError (bad_token, unsupported_protocol, ...) or a connection error. */
  static async connect(info: KeeperInfo, client = `AIB ${APP_VERSION}`): Promise<KeeperClient> {
    let conn: Deno.Conn;
    if (info.transport === 'unix') {
      conn = await Deno.connect({ transport: 'unix', path: info.address });
    } else {
      const at = info.address.lastIndexOf(':');
      conn = await Deno.connect({ hostname: info.address.slice(0, at) || '127.0.0.1', port: Number(info.address.slice(at + 1)) });
    }
    const keeper = new KeeperClient(conn);
    try {
      const hello = await keeper.request({ op: 'hello', token: info.token, min: PROTOCOL, max: PROTOCOL, client });
      keeper.features = Array.isArray(hello.features) ? hello.features.map(String) : [];
      keeper.keeperVersion = String(hello.keeper ?? '');
      keeper.keeperPid = Number(hello.pid ?? info.pid) || 0;
    } catch (error) {
      keeper.close();
      throw error;
    }
    return keeper;
  }

  get closed(): boolean {
    return this.#closed;
  }

  has(feature: string): boolean {
    return this.features.includes(feature);
  }

  /** One request; resolves with the `ok` header (and its body), rejects with KeeperError. Frames go out in call order. */
  request(header: Json, body?: Uint8Array): Promise<Json & { body?: Uint8Array }> {
    if (this.#closed) return Promise.reject(this.#closeError ?? new KeeperError('closed', 'the keeper connection is closed'));
    const id = this.#nextId++;
    let frame: Uint8Array;
    try {
      frame = encodeFrame({ ...header, id }, body);
    } catch (error) {
      return Promise.reject(error);
    }
    const answer = new Promise<Json>((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
    this.#writes = this.#writes.then(() => this.#writeAll(frame)).catch((error) => this.#fail(error));
    return answer;
  }

  async #writeAll(frame: Uint8Array): Promise<void> {
    let at = 0;
    while (at < frame.length) at += await this.#conn.write(frame.subarray(at));
  }

  async #readLoop(): Promise<void> {
    const frames = new FrameReader();
    const buffer = new Uint8Array(65536);
    let error: Error | null = null;
    try {
      while (true) {
        const n = await this.#conn.read(buffer);
        if (n === null) break;
        for (const [header, body] of frames.push(buffer.subarray(0, n))) this.#dispatch(header, body);
      }
    } catch (caught) {
      if (!this.#closed) error = caught instanceof Error ? caught : new Error(String(caught));
    }
    this.#fail(error ?? new KeeperError('closed', 'the keeper closed the connection'));
  }

  #dispatch(header: Json, body: Uint8Array): void {
    if (typeof header.ev === 'string') {
      const listener = this.listeners.get(String(header.channel ?? ''));
      if (!listener) return;
      try {
        if (header.ev === 'record') {
          listener.record?.({
            channel: String(header.channel),
            seq: Number(header.seq),
            kind: String(header.kind),
            time: Number(header.time),
            body,
          });
        } else if (header.ev === 'live') listener.live?.(Number(header.seq));
        else if (header.ev === 'gap') listener.gap?.(Number(header.from), Number(header.next));
        else if (header.ev === 'fenced') listener.fenced?.(Number(header.epoch));
        else if (header.ev === 'removed') listener.removed?.();
        // any other event: ignored (constitution rule 1)
      } catch (error) {
        log.exception(error, 'A keeper channel listener failed');
      }
      return;
    }
    const re = typeof header.re === 'number' ? header.re : Number(header.re);
    const waiting = this.#waiting.get(re);
    if (!waiting) {
      if (header.ok === false) log.warning('keeper: %s %s', header.error, header.message ?? '');
      return;
    }
    this.#waiting.delete(re);
    if (header.ok === true) waiting.resolve(body.length ? { ...header, body } : header);
    else waiting.reject(new KeeperError(String(header.error ?? 'failed'), String(header.message ?? ''), header));
  }

  #fail(error: Error | null): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = error;
    try {
      this.#conn.close();
    } catch { /* already closed */ }
    const reason = error ?? new KeeperError('closed', 'the keeper connection is closed');
    for (const waiting of this.#waiting.values()) waiting.reject(reason);
    this.#waiting.clear();
    const hook = this.onClose;
    this.onClose = null;
    if (hook) {
      try {
        hook(error);
      } catch (caught) {
        log.exception(caught, 'keeper onClose hook failed');
      }
    }
  }

  close(): void {
    this.#fail(null);
  }

  // ---- operations (section 4) ---------------------------------------------------------------------------------------------
  async list(): Promise<ChannelInfo[]> {
    const answer = await this.request({ op: 'list' });
    return Array.isArray(answer.channels) ? answer.channels as ChannelInfo[] : [];
  }

  status(): Promise<Json> {
    return this.request({ op: 'status' });
  }

  async spawn(spec: SpawnSpec): Promise<{ channel: string; pid: number; epoch: number; kind: string }> {
    const answer = await this.request({ op: 'spawn', ...spec });
    return { channel: String(answer.channel), pid: Number(answer.pid), epoch: Number(answer.epoch), kind: String(answer.kind) };
  }

  /** Follow a channel from `from` (0 = the start): the listener gets the records, then `live`. A new attach replaces the old one. */
  async attach(channel: string, from: number, listener: ChannelListener): Promise<{ first: number; last: number; live: boolean }> {
    // Only this attach's records, in order: a detached or replaced attach can still have records in flight (the keeper sends a
    // read batch to the end), and those must not reach the new listener. Records of one attach come in seq order without holes,
    // except after a `gap` event, which says where they go on.
    let next = Math.max(1, from);
    const target = listener;
    const filtered: ChannelListener = {
      record(record) {
        if (record.seq !== next) return;
        next = record.seq + 1;
        target.record?.(record);
      },
      live(seq) {
        if (seq === next - 1) target.live?.(seq);
      },
      gap(gapFrom, gapNext) {
        if (gapFrom !== next) return;
        next = gapNext;
        target.gap?.(gapFrom, gapNext);
      },
      fenced: (epoch) => target.fenced?.(epoch),
      removed: () => target.removed?.(),
    };
    this.listeners.set(channel, filtered);
    try {
      const answer = await this.request({ op: 'attach', channel, from });
      return { first: Number(answer.first), last: Number(answer.last), live: !!answer.live };
    } catch (error) {
      if (this.listeners.get(channel) === filtered) this.listeners.delete(channel);
      throw error;
    }
  }

  async detach(channel: string): Promise<void> {
    this.listeners.delete(channel);
    await this.request({ op: 'detach', channel });
  }

  async claim(channel: string): Promise<number> {
    return Number((await this.request({ op: 'claim', channel })).epoch);
  }

  /** Write to the child's stdin. A `duplicate` once-key resolves as `{duplicate: true}`: the write was already done. */
  async write(channel: string, epoch: number, body: Uint8Array, once?: string): Promise<{ seq: number; duplicate: boolean }> {
    try {
      const answer = await this.request({ op: 'write', channel, epoch, ...(once ? { once } : {}) }, body);
      return { seq: Number(answer.seq), duplicate: false };
    } catch (error) {
      if (error instanceof KeeperError && error.code === 'duplicate') return { seq: 0, duplicate: true };
      throw error;
    }
  }

  async note(channel: string, epoch: number, body: Uint8Array, once?: string): Promise<{ seq: number; duplicate: boolean }> {
    try {
      const answer = await this.request({ op: 'note', channel, epoch, ...(once ? { once } : {}) }, body);
      return { seq: Number(answer.seq), duplicate: false };
    } catch (error) {
      if (error instanceof KeeperError && error.code === 'duplicate') return { seq: 0, duplicate: true };
      throw error;
    }
  }

  async closeStdin(channel: string, epoch: number): Promise<void> {
    await this.request({ op: 'closeStdin', channel, epoch });
  }

  async resize(channel: string, epoch: number, cols: number, rows: number): Promise<number> {
    return Number((await this.request({ op: 'resize', channel, epoch, cols, rows })).seq);
  }

  async signal(channel: string, epoch: number, signal: string): Promise<void> {
    await this.request({ op: 'signal', channel, epoch, signal });
  }

  async kill(channel: string, epoch: number): Promise<void> {
    await this.request({ op: 'kill', channel, epoch });
  }

  /** Delete old journal segments; on an ended channel with `before` past its end, remove the channel (returns removed: true). */
  async truncate(channel: string, epoch: number, before: number): Promise<{ first?: number; removed: boolean }> {
    const answer = await this.request({ op: 'truncate', channel, epoch, before });
    return { first: answer.first === undefined ? undefined : Number(answer.first), removed: !!answer.removed };
  }

  async setOrphanCommand(orphan: OrphanCommand | null): Promise<void> {
    await this.request({ op: 'setOrphanCommand', orphan });
  }

  async shutdown(force = false): Promise<void> {
    await this.request({ op: 'shutdown', force });
  }
}

// ---- versions and compatibility ---------------------------------------------------------------------------------------------

/** The needed features a keeper does not offer ([] = it can be used). */
export function missingFeatures(features: readonly string[], needs: readonly string[] = KEEPER_NEEDS): string[] {
  return needs.filter((f) => !features.includes(f));
}

/** Dotted keeper versions ("1.0.0" < "1.0.10" < "1.1"); anything unreadable sorts first. */
export function compareKeeperVersions(a: string, b: string): number {
  const parse = (v: string) => (/^\d+(\.\d+)*$/.test(v.trim()) ? v.trim().split('.').map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const versions = new Map<string, Promise<string | null>>();

/** `AIB-keeper version` of a keeper program ("AIB keeper 1.0.0, protocol 1" -> "1.0.0"), cached per path; null when unknown. */
export function programVersion(binary: string): Promise<string | null> {
  let known = versions.get(binary);
  if (!known) {
    known = new Deno.Command(binary, { args: ['version'], stdin: 'null', stdout: 'piped', stderr: 'null' }).output().then(
      (out) => /AIB keeper (\S+?),/.exec(DEC.decode(out.stdout))?.[1] ?? null,
      () => null,
    );
    versions.set(binary, known);
  }
  return known;
}

/** True when a keeper process runs for this data folder (its keeper.json names a live pid). Cheap: no connection. */
export function keeperRunning(dataDir: string): boolean {
  const info = readKeeperInfo(dataDir);
  return !!info && pidAlive(info.pid);
}

// ---- finding and starting the keeper ----------------------------------------------------------------------------------------

export function keeperDir(dataDir: string): string {
  return `${dataDir.replace(/[\\/]+$/, '')}${SEP}keeper`;
}

export function readKeeperInfo(dataDir: string): KeeperInfo | null {
  try {
    const raw = JSON.parse(Deno.readTextFileSync(`${keeperDir(dataDir)}${SEP}keeper.json`));
    if (!raw || typeof raw !== 'object' || typeof raw.token !== 'string' || typeof raw.address !== 'string') return null;
    return raw as KeeperInfo;
  } catch {
    return null;
  }
}

/** Connect to the running keeper of this data folder, or null when none answers. */
export async function findKeeper(dataDir: string, pid: number | null = null): Promise<KeeperClient | null> {
  const info = readKeeperInfo(dataDir);
  // A dead keeper's file is left behind by a crash; dialling its port would take seconds on Windows, so check the pid first.
  if (!info || !pidAlive(info.pid) || (pid !== null && info.pid !== pid)) return null;
  try {
    return await KeeperClient.connect(info);
  } catch (error) {
    if (error instanceof KeeperError && error.code !== 'closed') throw error; // a keeper that answers but refuses us
    return null; // stale file: the keeper is gone
  }
}

export interface EnsureOptions {
  /** The keeper program; default keeperBinary(). */
  binary?: string;
  /** What the keeper runs when no client is attached while it has live channels (section 6). */
  orphan?: OrphanCommand | null;
  /** Extra `serve` flags (tests: shorter timers). */
  extraArgs?: string[];
  waitSeconds?: number;
}

/** Connect to the keeper of `dataDir`, starting one (detached, hidden) when none answers. */
export async function ensureKeeper(dataDir: string, options: EnsureOptions = {}): Promise<KeeperClient> {
  const found = await findKeeper(dataDir);
  if (found) return found;
  const binary = options.binary ?? await keeperBinary(dataDir);
  Deno.mkdirSync(dataDir, { recursive: true });
  const logFile = `${dataDir.replace(/[\\/]+$/, '')}${SEP}keeper-launch.log`;
  const args = ['serve', '--data', dataDir, ...(options.orphan ? ['--orphan-command', JSON.stringify(options.orphan)] : [])];
  const env = Object.fromEntries(Object.entries(Deno.env.toObject()).filter(([k]) => k !== 'DENO_SERVE_ADDRESS'));
  const child = await spawnDetached([binary, ...args, ...(options.extraArgs ?? [])], logFile, dataDir, env);
  log.info('started the keeper (pid %s) for %s', child.pid, dataDir);
  try {
    const deadline = Date.now() + (options.waitSeconds ?? 15) * 1000;
    let exited: number | null = null;
    while (Date.now() < deadline) {
      exited ??= child.exitCode();
      // Ours, or (exit code 3) the one that won a start race.
      const client = await findKeeper(dataDir, exited === 3 ? null : child.pid);
      if (client) return client;
      if (exited !== null && exited !== 3) {
        throw new Error(`The keeper exited with code ${exited} before it was ready (see ${logFile})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`The keeper did not become ready within ${options.waitSeconds ?? 15} s (see ${logFile})`);
  } finally {
    child.close();
  }
}

// ---- the keeper program -----------------------------------------------------------------------------------------------------

function exists(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** The repository's keeper/ folder (a source run), or null. */
export function keeperSourceDir(): string | null {
  const dir = `${APP_ROOT}${SEP}..${SEP}..${SEP}keeper`;
  return exists(`${dir}${SEP}go.mod`) ? dir : null;
}

function goCommand(): string {
  const env = Deno.env.get('GO');
  if (env) return env;
  if (WIN && exists('C:/Program Files/Go/bin/go.exe')) return 'C:/Program Files/Go/bin/go.exe';
  return 'go';
}

let built: Promise<string> | null = null;

/**
 * The keeper program: $AIB_KEEPER_BIN; in a built app AIB-keeper next to the app's program (the build puts it there), copied out to
 * `<data>/keeper-bin/<hash>/` first when the data folder is given (placeKeeper: a running keeper never runs from files an update
 * replaces); in a source run a binary built from keeper/ with Go into the temp folder (cached by a hash of the sources, so it is
 * built once per change).
 */
export function keeperBinary(dataDir?: string): Promise<string> {
  const given = Deno.env.get('AIB_KEEPER_BIN');
  if (given) return Promise.resolve(given);
  const name = WIN ? `${KEEPER_NAME}.exe` : KEEPER_NAME;
  if (isCompiled()) {
    const beside = Deno.execPath().replace(/[\\/][^\\/]*$/, '') + SEP + name;
    if (exists(beside)) return Promise.resolve(dataDir ? placeKeeper(beside, dataDir) : beside);
  }
  const source = keeperSourceDir();
  if (!source) return Promise.reject(new Error(`${name} was not found next to ${Deno.execPath()}`));
  built ??= buildFromSource(source, name).catch((error) => {
    built = null;
    throw error;
  });
  return built;
}

/**
 * Copy the keeper program shipped with the app to `<data>/keeper-bin/<first 16 hex of its SHA-256>/` and return that path. The keeper
 * outlives the app (it holds the chats through an update), so it must not run from the app's folder: the update helper renames the
 * files there (Windows: `.old-<stamp>` files that could not be cleaned up while it runs), replaces the macOS bundle, and on Linux the
 * old AppImage's mount goes away (SIGBUS). A copy with the same hash is reused; other copies are deleted when nothing runs from them
 * (Windows refuses to delete a running exe; elsewhere a running program keeps its deleted file). Falls back to `beside` on error.
 */
export function placeKeeper(beside: string, dataDir: string): string {
  try {
    const bytes = Deno.readFileSync(beside);
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    const root = `${dataDir.replace(/[\\/]+$/, '')}${SEP}keeper-bin`;
    const folder = `${root}${SEP}${hash}`;
    const target = `${folder}${SEP}${beside.split(/[\\/]/).pop()}`;
    if (!exists(target)) {
      Deno.mkdirSync(folder, { recursive: true });
      const partial = `${target}.${Deno.pid}.part`;
      Deno.writeFileSync(partial, bytes, { mode: 0o755 });
      try {
        Deno.renameSync(partial, target);
      } catch {
        try {
          Deno.removeSync(partial);
        } catch { /* gone */ }
        if (!exists(target)) throw new Error(`could not place the keeper at ${target}`);
      }
    }
    for (const entry of Deno.readDirSync(root)) {
      if (entry.name === hash || !entry.isDirectory) continue;
      try {
        Deno.removeSync(`${root}${SEP}${entry.name}`, { recursive: true });
      } catch { /* in use: next time */ }
    }
    return target;
  } catch (error) {
    log.warning(
      'keeper: could not copy %s out of the app folder (%s); running it from there',
      beside,
      error instanceof Error ? error.message : error,
    );
    return beside;
  }
}

async function buildFromSource(source: string, name: string): Promise<string> {
  const hash = createHash('sha256');
  const files: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const entry of [...Deno.readDirSync(dir)].sort((a, b) => a.name < b.name ? -1 : 1)) {
      if (entry.isDirectory) walk(`${dir}${SEP}${entry.name}`, `${rel}${entry.name}/`);
      else if (/\.(go|mod|sum)$/.test(entry.name)) files.push(`${rel}${entry.name}`);
    }
  };
  walk(source, '');
  for (const file of files) hash.update(file).update(Deno.readFileSync(`${source}${SEP}${file.replaceAll('/', SEP)}`));
  const folder = `${Deno.env.get(WIN ? 'TEMP' : 'TMPDIR') || (WIN ? 'C:\\Windows\\Temp' : '/tmp')}${SEP}aib-keeper-${
    hash.digest('hex').slice(0, 16)
  }`;
  const exe = `${folder}${SEP}${name}`;
  if (exists(exe)) return exe;
  Deno.mkdirSync(folder, { recursive: true });
  const partial = `${exe}.${Deno.pid}.part${WIN ? '.exe' : ''}`;
  const out = await new Deno.Command(goCommand(), {
    args: ['build', '-trimpath', '-ldflags', WIN ? '-s -w -H windowsgui' : '-s -w', '-o', partial, '.'],
    cwd: source,
    env: { CGO_ENABLED: '0' },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(`Building the keeper failed: ${DEC.decode(out.stderr).slice(-1500)}`);
  try {
    Deno.renameSync(partial, exe);
  } catch {
    if (!exists(exe)) throw new Error(`Could not place the keeper at ${exe}`);
    try {
      Deno.removeSync(partial);
    } catch { /* another process won the race */ }
  }
  return exe;
}
