/**
 * One WslHost per WSL distro in use (contract.ts; docs/wsl/design.md sections 1, 3 and 11): the Linux keeper link, the WSL helper
 * channel, and the keep-alive.
 *
 * Two wsl.exe processes per distro:
 *   - the transport (AIB's own, lives while AIB runs): `wsl.exe --distribution D --cd ~ --exec <root>/<ver>/AIB-keeper bridge --data
 *     <root>/data-<hash>`, hidden, WSL_UTF8=1 and a minimal environment, in a ProcessTree job (it dies with AIB). Its stdout is
 *     notices, then BRIDGE_MAGIC, the one-line preamble (the Linux keeper's token: it never passes through argv or env), then keeper
 *     frames; KeeperClient runs over its pipes. The KeeperLink reconnects when it ends (keeper/link.ts transport-loss rules).
 *   - the keep-alive, a pipe channel in the WINDOWS keeper, label {"aib":"wsl-hold","distro":d}: the same command with `--hold`. It
 *     keeps the distro running and the WSL agents alive after AIB quits. It is AIB's own channel (isAibInternalLabel): never a chat,
 *     never counted as work. On quit (WslHosts.quit) it is killed unless a WSL agent is live (Studio then sends the Windows `hold`).
 *
 * The helper is a channel in the Linux keeper (label {"aib":"wsl-helper","v":ver}, scrollback 1 MiB) speaking JSON-RPC 2.0 lines:
 * its first line is `helper.ready {helper, protocol, methods}` and call() refuses a method it did not list. It starts with a fixed
 * minimal Linux environment (never the Windows one). A helper of another <ver> is killed and started again (it holds no state in
 * phase 1). Request ids carry this run's random prefix, so the replay of an adopted helper never answers a new request.
 *
 * Version rules for the Linux keeper (KeeperLink options): it must offer WSL_KEEPER_NEEDS; an older or lacking keeper with no live
 * agent is shut down (the helper first) and the bridge starts this AIB's keeper; with live agents it is kept for them and the host
 * says why new chats cannot start there.
 */
import { APP_VERSION } from '../core/app.ts';
import { getLogger } from '../core/log.ts';
import { ProcessTree } from '../platform/process_tree.ts';
import { validDistro } from '../platform/location.ts';
import { KEEPER_NEEDS, KeeperClient, KeeperError, type KeeperRecord, pipeStream, readBridgePreamble } from '../keeper/client.ts';
import {
  aibInternalKind,
  type KeeperChannel,
  type KeeperChannelListener,
  KeeperLink,
  liveUserChannels,
  type ReconnectPolicy,
} from '../keeper/link.ts';
import {
  type BridgePreamble,
  HELPER_PROTOCOL,
  type HelperMethods,
  WSL_HELPER_LABEL,
  WSL_HOLD_LABEL,
  WslHelperError,
  type WslHost,
} from './contract.ts';
import { installWsl, wslEnv, type WslInstall } from './install.ts';
import { detectWsl, wslExePath } from './detect.ts';

const log = getLogger('wsl');
const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** What a Linux keeper must offer for WSL chats (design section 3). */
export const WSL_KEEPER_NEEDS = [...KEEPER_NEEDS, 'scrollback', 'labels', 'hold'];
export const HELPER_SCROLLBACK = 1024 * 1024;
export const HOLD_SCROLLBACK = 65536;
export const CONNECT_TIMEOUT_MS = 60_000;
export const CALL_TIMEOUT_MS = 30_000;
export const READY_TIMEOUT_MS = 30_000;
export const MAX_HELPER_LINE = 32 * 1024 * 1024;
export const MAX_URL = 2048;
export const URLS_PER_MINUTE = 3;
/** PATH of the helper's own environment (the login environment it captures is what agents get: env()). */
export const HELPER_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

type State = WslHost['state'];

/** One transport child: a wsl.exe (or a test's fake bridge). */
export interface TransportProcess {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly status: Promise<{ code: number }>;
  kill(): void;
}

/** Start a transport: `argv` is what follows `wsl.exe --distribution D --cd ~ --exec`. */
export type TransportSpawner = (distro: string, argv: string[]) => TransportProcess;

/** The real transport: wsl.exe, hidden (AIB's console has no window), minimal env, in a job so it ends with AIB. */
export const spawnWslTransport: TransportSpawner = (distro, argv) => {
  const exe = wslExePath();
  if (!exe) throw new Error('WSL is not installed on this PC');
  if (!validDistro(distro)) throw new RangeError(`Not a WSL distro name: ${distro}`);
  const child = new Deno.Command(exe, {
    args: ['--distribution', distro, '--cd', '~', '--exec', ...argv],
    env: wslEnv(),
    clearEnv: true,
    stdin: 'piped',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  const tree = new ProcessTree(child);
  return {
    pid: child.pid,
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    status: child.status.then((s) => ({ code: s.code })),
    kill: () => tree.kill(),
  };
};

/** The keep-alive's argv for the Windows keeper (wsl.exe and its arguments). */
export function holdCommand(wslExe: string, distro: string, install: WslInstall): { command: string; args: string[] } {
  return {
    command: wslExe,
    args: ['--distribution', distro, '--cd', '~', '--exec', install.keeper, 'bridge', '--data', install.data, '--hold'],
  };
}

/** The helper's fixed environment: no Windows variable, PATH without /mnt. */
export function helperEnv(install: WslInstall): Record<string, string> {
  return {
    HOME: install.home,
    USER: install.user,
    LOGNAME: install.user,
    SHELL: install.shell || '/bin/sh',
    PATH: HELPER_PATH,
    LANG: 'C.UTF-8',
    AIB_WSL_ROOT: install.root,
    AIB_WSL_VERSION: install.version,
  };
}

/** A URL a distro may ask Windows to open (http/https, at most MAX_URL bytes, no spaces or control characters); never URL-parsed here. */
export function acceptableUrl(url: unknown): url is string {
  if (
    typeof url !== 'string' || ENC.encode(url).length > MAX_URL ||
    !/^https?:\/\/\S+$/i.test(url)
  ) return false;
  return [...url].every((c) => c.codePointAt(0)! > 0x20 && c !== '\x7f');
}

export interface WslHostOptions {
  /** The distro as Lxss names it ("Ubuntu"). */
  distro: string;
  /** AIB's Windows state folder (the Linux keeper data folder is named after it). */
  stateDir: string;
  /** The Windows keeper link (for the keep-alive); null: none (keeper off), WSL agents then stop ~35 s after AIB quits. */
  windowsLink?: () => KeeperLink | null;
  install?: (distro: string) => Promise<WslInstall>;
  spawnTransport?: TransportSpawner;
  /**
   * The Linux keeper version this AIB ships (a running older one with no live agent is replaced); null: never replaced for age. The
   * Linux keeper is built from the same source as the Windows one, so Studio passes the Windows keeper's version (asked lazily).
   */
  keeperVersion?: string | null | (() => Promise<string | null>);
  reconnect?: ReconnectPolicy;
  connectTimeoutMs?: number;
  /** The wsl.exe the keep-alive runs (default %SystemRoot%\System32\wsl.exe). */
  wslExe?: string | null;
  /** Tests: what the helper channel runs (default the installed helper, no arguments). */
  helperCommand?: (install: WslInstall) => { command: string; args: string[] };
  /** Tests: the helper's environment (default helperEnv). */
  helperEnv?: (install: WslInstall) => Record<string, string>;
  /** Tests: what the keep-alive runs (default holdCommand). */
  holdCommand?: (wslExe: string, distro: string, install: WslInstall) => { command: string; args: string[] };
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Ready {
  helper: string;
  protocol: number;
  methods: string[];
}

export class WslHostImpl implements WslHost {
  readonly distro: string;
  readonly link: KeeperLink;
  #state: State = 'stopped';
  #note = '';
  #install: WslInstall | null = null;
  #preamble: BridgePreamble | null = null;
  #starting: Promise<void> | null = null;
  #transport: TransportProcess | null = null;
  #helper: KeeperChannel | null = null;
  #ready: Promise<Ready> | null = null;
  #readyResolve: ((ready: Ready) => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyValue: Ready | null = null;
  #helperStarting: Promise<Ready> | null = null;
  #pending = new Map<string, Pending>();
  #nextId = 1;
  readonly #run = crypto.randomUUID().slice(0, 8);
  #lineBuffer = new Uint8Array(0);
  #env: Promise<Record<string, string>> | null = null;
  #urlHandlers = new Set<(url: string) => void>();
  #urlTimes: number[] = [];
  #hold: KeeperChannel | null = null;
  #holdTimer: ReturnType<typeof setTimeout> | null = null;
  #stopped = false;
  #begun = false;

  constructor(readonly options: WslHostOptions) {
    this.distro = options.distro;
    this.link = new KeeperLink({
      dataDir: `wsl:${options.distro}`, // never a Windows folder: the connector makes every connection
      connector: (start) => this.#connect(start),
      reconnect: options.reconnect ?? true,
      needs: WSL_KEEPER_NEEDS,
      bundledVersion: () =>
        typeof options.keeperVersion === 'function' ? options.keeperVersion() : Promise.resolve(options.keeperVersion ?? null),
      lostMessage: `${options.distro} stopped (Windows restart or \`wsl --shutdown\`), so this agent stopped.`,
    });
    this.link.onTransport = (state, error) => {
      if (this.#stopped) return;
      if (state === 'lost') {
        this.#setState('reconnecting', `Reconnecting to ${this.distro}…`);
      } else if (state === 'restored') this.#setState('ready', '');
      else {
        this.#setState('stopped', `${this.distro} stopped. Reconnect`);
        this.#helperGone(new WslHelperError(error?.message ?? `${this.distro} stopped`, 'stopped'));
        this.#starting = null;
      }
    };
  }

  get state(): State {
    return this.#state;
  }

  get note(): string {
    return this.#note;
  }

  /** Where AIB is installed in the distro (after start). */
  get install(): WslInstall | null {
    return this.#install;
  }

  /** The bridge's preamble of the current transport (home, uid, arch, keeper version). */
  get preamble(): BridgePreamble | null {
    return this.#preamble;
  }

  #setState(state: State, note: string): void {
    this.#state = state;
    this.#note = note;
  }

  /** Has anything asked this host to start yet (a host is made on first use but starts only when work needs the distro)? */
  get begun(): boolean {
    return this.#begun;
  }

  /** Install if needed, connect, start the helper and the keep-alive. Idempotent; after a failure, the next call tries again. */
  start(): Promise<void> {
    if (this.#stopped) return Promise.reject(new WslHelperError('AIB stopped using this distro', 'stopped'));
    this.#begun = true;
    this.#starting ??= this.#start().catch((error) => {
      this.#starting = null;
      const message = error instanceof Error ? error.message : String(error);
      this.#setState('unavailable', message);
      throw error;
    });
    return this.#starting;
  }

  async #start(): Promise<void> {
    this.#setState('starting', `Starting ${this.distro}…`);
    if (!this.#install) {
      this.#setState('installing', `Setting up AIB in ${this.distro}`);
      this.#install = await (this.options.install ?? ((d) => installWsl(d, { stateDir: this.options.stateDir })))(this.distro);
      this.#setState('starting', `Starting ${this.distro}…`);
    }
    try {
      await this.link.check(); // connect, version rules (an old Linux keeper with no agents is replaced here)
    } catch (error) {
      if (error instanceof KeeperError && error.code === 'unsupported') {
        throw new WslHelperError(this.link.problem || error.message, 'unsupported');
      }
      throw error;
    }
    await this.#ensureHelper();
    this.#setState('ready', '');
    void this.#ensureHold();
  }

  // ---- the transport ------------------------------------------------------------------------------------------------------

  async #connect(_start: boolean): Promise<KeeperClient | null> {
    if (this.#stopped) return null;
    const install = this.#install;
    if (!install) throw new WslHelperError(`AIB is not set up in ${this.distro} yet`, 'not_installed');
    this.#transport?.kill();
    const spawn = this.options.spawnTransport ?? spawnWslTransport;
    const child = spawn(this.distro, [install.keeper, 'bridge', '--data', install.data]);
    this.#transport = child;
    this.#drainStderr(child);
    const stream = pipeStream(child.stdout, child.stdin, () => child.kill());
    const timeoutMs = this.options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new KeeperError('bad_bridge', `${this.distro} did not answer within ${timeoutMs / 1000} s`)),
          timeoutMs,
        );
      });
      const { preamble, rest, notices } = await Promise.race([readBridgePreamble(stream), timeout]);
      if (notices.trim()) log.info('wsl: %s said before the bridge: %s', this.distro, notices.trim().slice(0, 500));
      this.#preamble = preamble;
      const hello = KeeperClient.overStream(stream, preamble.token, {
        initial: rest,
        pid: preamble.pid,
        client: `AIB ${APP_VERSION} (Windows)`,
      });
      return await Promise.race([hello, timeout]);
    } catch (error) {
      stream.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  #drainStderr(child: TransportProcess): void {
    if (!child.stderr) return;
    const reader = child.stderr.getReader();
    let said = 0;
    (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || !value) return;
        if (said < 8192) {
          said += value.length;
          const text = DEC.decode(value).replaceAll('\0', '').trim();
          if (text) log.info('wsl: %s bridge: %s', this.distro, text.slice(0, 1000));
        }
      }
    })().catch(() => {});
  }

  // ---- the helper ---------------------------------------------------------------------------------------------------------

  #ensureHelper(): Promise<Ready> {
    if (this.#helper && !this.#helper.lost && this.#ready) return this.#ready;
    this.#helperStarting ??= this.#startHelper().finally(() => (this.#helperStarting = null));
    return this.#helperStarting;
  }

  async #startHelper(): Promise<Ready> {
    const install = this.#install!;
    const client = await this.link.check();
    const label = JSON.stringify({ ...WSL_HELPER_LABEL, v: install.version });
    const listed = await client.list();
    this.#ready = new Promise<Ready>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    this.#ready.catch(() => {});
    this.#readyValue = null;
    this.#lineBuffer = new Uint8Array(0);
    let adopted: KeeperChannel | null = null;
    for (const info of listed) {
      if (!info.live || aibInternalKind(info.label) !== WSL_HELPER_LABEL.aib) continue;
      if (info.label === label && !adopted) {
        adopted = this.link.adopt(info, this.#helperListener(true));
        continue;
      }
      try {
        await this.link.stopUnknown(client, info.channel); // another version's helper: it holds no state
      } catch (error) {
        log.warning('wsl: could not stop the old helper %s: %s', info.channel, error instanceof Error ? error.message : error);
      }
    }
    if (adopted) {
      this.#helper = adopted;
      await adopted.claim();
    } else {
      this.#helper = this.link.spawn(
        {
          channel: `wsl-helper-${crypto.randomUUID().slice(0, 12)}`,
          ...(this.options.helperCommand?.(install) ??
            { command: install.helper, args: ['--data', install.data] }), // the data folder: open.fifo, worktrees
          cwd: install.home,
          env: (this.options.helperEnv ?? helperEnv)(install),
          label,
          scrollback: HELPER_SCROLLBACK,
        },
        this.#helperListener(false),
        undefined,
        WSL_KEEPER_NEEDS,
      );
    }
    const ready = this.#ready;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new WslHelperError(`The AIB helper in ${this.distro} did not start`, 'helper_timeout')),
            READY_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (error) {
      void this.#helper?.kill();
      this.#helperGone(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  #helperListener(adopted: boolean): KeeperChannelListener {
    return {
      record: (record) => this.#helperRecord(record),
      live: () => {
        // An adopted helper whose ready line is no longer in its (bounded) record cannot be used: start a new one.
        if (adopted && !this.#readyValue) {
          void this.#helper?.kill();
          this.#helperGone(new WslHelperError('the running helper was too old to take over', 'helper_restart'));
        }
      },
      gap: () => {
        this.#lineBuffer = new Uint8Array(0); // a partial line before a gap is not a line
      },
      lost: (error) => this.#helperGone(error ?? new WslHelperError(`${this.distro} stopped`, 'stopped')),
      spawnFailed: (error) => this.#helperGone(error),
      writeFailed: (error) => log.warning('wsl: writing to the helper in %s failed: %s', this.distro, error.message),
    };
  }

  #helperRecord(record: KeeperRecord): void {
    if (record.kind === 'exit') {
      this.#helperGone(new WslHelperError(`The AIB helper in ${this.distro} ended`, 'helper_exited'));
      return;
    }
    if (record.kind === 'err') {
      const text = DEC.decode(record.body).trim();
      if (text) log.info('wsl: %s helper: %s', this.distro, text.slice(0, 1000));
      return;
    }
    if (record.kind !== 'out') return;
    const joined = new Uint8Array(this.#lineBuffer.length + record.body.length);
    joined.set(this.#lineBuffer);
    joined.set(record.body, this.#lineBuffer.length);
    let start = 0;
    for (let at = joined.indexOf(0x0a); at >= 0; at = joined.indexOf(0x0a, start)) {
      this.#helperLine(joined.subarray(start, at));
      start = at + 1;
    }
    this.#lineBuffer = joined.slice(start);
    if (this.#lineBuffer.length > MAX_HELPER_LINE) {
      log.warning('wsl: a helper line in %s was longer than %s bytes; dropped', this.distro, MAX_HELPER_LINE);
      this.#lineBuffer = new Uint8Array(0);
    }
  }

  #helperLine(bytes: Uint8Array): void {
    let message: Record<string, unknown>;
    try {
      const value = JSON.parse(DEC.decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      message = value;
    } catch {
      return; // not a JSON line (nothing the helper should print)
    }
    if (message.method === 'helper.ready') {
      const p = (message.params ?? {}) as Record<string, unknown>;
      const ready: Ready = {
        helper: String(p.helper ?? ''),
        protocol: Number(p.protocol ?? 0),
        methods: Array.isArray(p.methods) ? p.methods.map(String) : [],
      };
      if (ready.protocol !== HELPER_PROTOCOL) {
        this.#readyReject?.(
          new WslHelperError(`The AIB helper speaks protocol ${ready.protocol}, not ${HELPER_PROTOCOL}`, 'helper_protocol'),
        );
        return;
      }
      this.#readyValue = ready;
      this.#readyResolve?.(ready);
      return;
    }
    if (message.method === 'browser.open' && message.id === undefined) {
      this.#openUrl((message.params as Record<string, unknown> | undefined)?.url);
      return;
    }
    if (typeof message.id !== 'string') return; // not an answer to this run's requests (ids carry this run's prefix)
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error && typeof message.error === 'object') {
      const e = message.error as Record<string, unknown>;
      const data = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<
        string,
        unknown
      >;
      pending.reject(new WslHelperError(String(e.message ?? 'the helper failed'), String(data.code ?? e.code ?? 'helper_error')));
    } else pending.resolve(message.result);
  }

  #helperGone(error: Error): void {
    const reason = error instanceof WslHelperError ? error : new WslHelperError(error.message, 'helper_gone');
    this.#helper = null;
    this.#ready = null;
    this.#readyValue = null;
    this.#readyReject?.(reason);
    this.#readyResolve = this.#readyReject = null;
    this.#env = null;
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
      this.#pending.delete(id);
    }
  }

  /** "Reconnect" on a stopped or failed distro: start again now (a ready host is left as it is). */
  async reconnect(): Promise<void> {
    if (this.#state === 'ready' || this.#stopped) return;
    if (this.#state !== 'starting' && this.#state !== 'installing') this.#starting = null;
    await this.start();
  }

  /** The running helper's version (helper.ready), null before it is ready. */
  get helperVersion(): string | null {
    return this.#readyValue?.helper || null;
  }

  /** The methods the running helper offers ([] before it is ready). */
  get methods(): string[] {
    return this.#readyValue ? [...this.#readyValue.methods] : [];
  }

  async call<M extends keyof HelperMethods>(
    method: M,
    params: HelperMethods[M]['params'],
    opts: { timeoutMs?: number } = {},
  ): Promise<HelperMethods[M]['result']> {
    await this.start();
    const ready = await this.#ensureHelper();
    if (!ready.methods.includes(method)) {
      throw new WslHelperError(`The AIB helper in ${this.distro} does not offer ${method}`, 'unknown_method');
    }
    const helper = this.#helper;
    if (!helper) throw new WslHelperError(`The AIB helper in ${this.distro} is not running`, 'helper_gone');
    const id = `${this.#run}-${this.#nextId++}`;
    const answer = new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new WslHelperError(`${method} in ${this.distro} took longer than ${Math.round(timeoutMs / 1000)} s`, 'timeout'));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
    });
    const line = ENC.encode(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} }) + '\n');
    if (!await helper.write(line)) {
      const pending = this.#pending.get(id);
      if (pending) {
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new WslHelperError(`The AIB helper in ${this.distro} could not be reached`, 'helper_gone'));
      }
    }
    return await answer as HelperMethods[M]['result'];
  }

  env(): Promise<Record<string, string>> {
    this.#env ??= this.call('env.get', {}).then((r) => ({ ...r.env }));
    this.#env.catch(() => (this.#env = null));
    return this.#env;
  }

  onOpenUrl(handler: (url: string) => void): () => void {
    this.#urlHandlers.add(handler);
    return () => this.#urlHandlers.delete(handler);
  }

  #openUrl(url: unknown): void {
    if (!acceptableUrl(url)) {
      log.warning('wsl: %s asked to open a URL AIB does not open (only http/https, at most %s bytes)', this.distro, MAX_URL);
      return;
    }
    const now = Date.now();
    this.#urlTimes = this.#urlTimes.filter((t) => now - t < 60_000);
    if (this.#urlTimes.length >= URLS_PER_MINUTE) {
      log.warning('wsl: %s asked to open more than %s URLs in a minute; ignored', this.distro, URLS_PER_MINUTE);
      return;
    }
    this.#urlTimes.push(now);
    for (const handler of this.#urlHandlers) {
      try {
        handler(url);
      } catch (error) {
        log.exception(error, 'A WSL open-URL handler failed');
      }
    }
  }

  // ---- the keep-alive (a channel in the Windows keeper) ---------------------------------------------------------------------

  /** Make sure the Windows keeper holds a keep-alive for this distro (one; never a second). Never throws. */
  async #ensureHold(): Promise<void> {
    if (this.#stopped || (this.#hold && !this.#hold.lost)) return;
    const windows = this.options.windowsLink?.() ?? null;
    const install = this.#install;
    const wslExe = this.options.wslExe === undefined ? wslExePath() : this.options.wslExe;
    if (!windows || !install || !wslExe) return;
    try {
      const client = await windows.client(true);
      if (!client || !client.has('labels')) return;
      const label = JSON.stringify({
        ...WSL_HOLD_LABEL,
        distro: this.distro.toLowerCase(),
      });
      const running = (await client.list()).find((c) => c.live && c.label === label);
      if (running) {
        // An earlier AIB's keep-alive: claimed, so this AIB can stop it at quit (a claim also ends the Windows keeper's `hold`).
        const hold = this.#hold = windows.adopt(running, this.#holdListener());
        await hold.claim();
        return;
      }
      const { command, args } = (this.options.holdCommand ?? holdCommand)(wslExe, this.distro, install);
      this.#hold = windows.spawn(
        {
          channel: `wsl-hold-${crypto.randomUUID().slice(0, 12)}`,
          command,
          args,
          env: wslEnv(),
          label,
          scrollback: HOLD_SCROLLBACK,
        },
        this.#holdListener(),
        undefined,
        ['labels', 'scrollback'],
      );
    } catch (error) {
      log.warning('wsl: the keep-alive for %s could not start: %s', this.distro, error instanceof Error ? error.message : error);
      this.#holdAgain();
    }
  }

  #holdListener(): KeeperChannelListener {
    const gone = () => {
      this.#hold = null;
      this.#holdAgain();
    };
    return {
      record: (record) => {
        if (record.kind === 'exit') gone();
      },
      lost: gone,
      spawnFailed: (error) => {
        log.warning('wsl: the keep-alive for %s did not start: %s', this.distro, error.message);
        gone();
      },
    };
  }

  #holdAgain(): void {
    if (this.#stopped || this.#holdTimer !== null) return;
    this.#holdTimer = setTimeout(() => {
      this.#holdTimer = null;
      if (this.#state === 'ready') void this.#ensureHold();
    }, 5000);
  }

  /** Is the keep-alive running (as far as this AIB knows)? */
  get holding(): boolean {
    return !!this.#hold && !this.#hold.lost;
  }

  /** The live agents and terminals in this distro's keeper (AIB's own channels left out); 0 when not connected. */
  async liveCount(): Promise<number> {
    try {
      const client = await this.link.client(false);
      return client ? liveUserChannels(await client.list()).length : 0;
    } catch {
      return 0;
    }
  }

  /** Kill the keep-alive (quit with nothing running in the distro). */
  async releaseHold(): Promise<void> {
    if (this.#holdTimer !== null) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    const hold = this.#hold;
    this.#hold = null;
    if (!hold) return;
    try {
      await hold.ready;
      if (!hold.owner) await hold.claim();
      await hold.kill();
    } catch (error) {
      log.warning('wsl: could not stop the keep-alive for %s: %s', this.distro, error instanceof Error ? error.message : error);
    }
  }

  /** Stop using the distro: no reconnect, the transport ends; agents and the keep-alive are left as they are. */
  stop(): void {
    this.#stopped = true;
    if (this.#holdTimer !== null) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
    this.#helperGone(new WslHelperError('AIB stopped using this distro', 'stopped'));
    this.link.disconnect();
    this.#transport?.kill();
    this.#transport = null;
    this.#setState('stopped', '');
  }
}

export interface WslHostsOptions extends Omit<WslHostOptions, 'distro'> {
  /** Is this a WSL2 distro of this PC? Returns its Lxss name, or null. Default: wsl/detect.ts. */
  lookup?: (name: string) => string | null;
}

/** Every WslHost of this AIB, one per distro, made on first use. */
export class WslHosts {
  readonly #hosts = new Map<string, WslHostImpl>();

  constructor(readonly options: WslHostsOptions) {}

  #lookup(name: string): string | null {
    if (this.options.lookup) return this.options.lookup(name);
    const folded = name.toLowerCase();
    return detectWsl().distros.find((d) => d.name.toLowerCase() === folded)
      ?.name ?? null;
  }

  /** The host of a distro (case-insensitive; a ref's folded name works). Throws WslHelperError `unknown_distro` when there is none. */
  get(distro: string): WslHostImpl {
    const key = String(distro ?? '').toLowerCase();
    const known = this.#hosts.get(key);
    if (known) return known;
    const name = validDistro(distro) ? this.#lookup(distro) : null;
    if (!name) throw new WslHelperError(`${distro} is not a WSL2 distro of this PC`, 'unknown_distro');
    const host = new WslHostImpl({ ...this.options, distro: name });
    this.#hosts.set(key, host);
    return host;
  }

  /** The host of a distro if one was made. */
  peek(distro: string): WslHostImpl | null {
    return this.#hosts.get(String(distro ?? '').toLowerCase()) ?? null;
  }

  all(): WslHostImpl[] {
    return [...this.#hosts.values()];
  }

  /** Live agents and terminals in every distro in use (the quit dialog's "chats still running" counts them). */
  async liveCount(): Promise<number> {
    let total = 0;
    for (const host of this.all()) total += await host.liveCount();
    return total;
  }

  /**
   * AIB quits (design section 11 item 1): per distro, the keep-alive is killed unless a WSL agent is live; then the transport ends.
   * `live`: the WSL agents left running, held by their keep-alive. When it is above 0, Studio sends the Windows keeper `hold` (so
   * the keep-alive is never stopped as orphaned and AIB is not started again in the tray). `settleMs`: a quit that just stopped every
   * chat waits up to this long for their channels to end, so agents on their way out do not keep the distro held.
   */
  async quit(options: { settleMs?: number } = {}): Promise<{ live: number; held: string[] }> {
    let live = 0;
    const held: string[] = [];
    for (const host of this.all()) {
      let count = await host.liveCount();
      for (const until = Date.now() + (options.settleMs ?? 0); count && Date.now() < until;) {
        await new Promise((r) => setTimeout(r, 200));
        count = await host.liveCount();
      }
      if (count && host.holding) {
        live += count;
        held.push(host.distro);
      } else {
        live += count;
        await host.releaseHold();
      }
      host.stop();
    }
    return { live, held };
  }
}

// ---- the hosts of this AIB --------------------------------------------------------------------------------------------------

let sharedOptions: WslHostsOptions | null = null;
let shared: WslHosts | null = null;

/**
 * Say how this AIB's hosts are made (Studio at start: its data folder and the Windows keeper link). Cheap: nothing is detected or
 * started until a WSL project needs its distro (wslHosts().get). `replace` false: only when nothing was set up yet (a test's own
 * set-up wins over the Studios it makes). Replacing starts a new set of hosts; the ones made so far are left as they are (tests stop
 * them first). null forgets the options.
 */
export function configureWslHosts(options: WslHostsOptions | null, replace = true): void {
  if (!replace && sharedOptions) return;
  sharedOptions = options;
  shared = null;
}

/** This AIB's hosts (made on first use), or null when AIB was not configured for WSL (no data folder: unit tests, the helper). */
export function wslHosts(): WslHosts | null {
  if (!shared && sharedOptions) shared = new WslHosts(sharedOptions);
  return shared;
}

/** The hosts if any were made in this process (quit, status): never makes them. */
export function wslHostsInUse(): WslHosts | null {
  return shared;
}
