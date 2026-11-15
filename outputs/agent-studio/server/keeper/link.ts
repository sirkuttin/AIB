/**
 * A Studio's link to the keeper: one keeper connection per Studio, started on first use, and one KeeperChannel per agent the
 * Studio runs through it. A channel queues its operations until the keeper has spawned it, so a Connection can write right away,
 * exactly as it writes to a child's stdin.
 *
 * The keeper is always on (owner decision): main.ts decides once at start (decideKeeper()) whether it can run: the program is there
 * (next to the app, or built from keeper/ with Go in a source run) and answers `version`. When it cannot, AIB falls back to the split
 * agent host (or plain in-process agents), logs why and Settings > About shows one quiet line (keeperProblem()). AIB_KEEPER=0 in the
 * environment turns it off: an internal escape hatch for tests and debugging, shown nowhere. A Studio built without a decision (unit
 * tests, the split agent host) starts no new chat in the keeper, but still takes over chats a keeper already holds (keeperWanted()).
 *
 * A link can also reach its keeper through a `connector` instead of a data folder: the Linux keeper of a WSL distro, over the
 * stdio of a `wsl.exe … bridge` child (wsl/hosts.ts). With `reconnect`, the end of that transport is not the end of the keeper
 * (docs/wsl/design.md section 11 item 2): the channels are suspended (operations wait), the connector is called again with backoff,
 * and each channel is attached again from the last record it had (claimed again when it was ours). A channel is told `lost` (and
 * onLost fires, so Studio may start the chat again) only when the keeper's `list` shows it ended or gone, or the keeper cannot be
 * reached again: a transport hiccup never starts a second copy of a running agent.
 *
 * AIB's own channels (the WSL keep-alive `wsl-hold` in the Windows keeper, the `wsl-helper` in a Linux keeper; contract.ts labels)
 * are not chats: isAibInternalLabel tells them apart, and they never count as live work (liveUserChannels).
 */
import { announce, getLogger } from '../core/log.ts';
import { pidAlive } from '../host/host_client.ts';
import {
  type ChannelInfo,
  type ChannelListener,
  compareKeeperVersions,
  ensureKeeper,
  type EnsureOptions,
  findKeeper,
  KEEPER_NEEDS,
  keeperBinary,
  type KeeperClient,
  KeeperError,
  type KeeperRecord,
  keeperRunning,
  missingFeatures,
  programVersion,
  type SpawnSpec,
} from './client.ts';
import { WSL_HELPER_LABEL, WSL_HOLD_LABEL } from '../wsl/contract.ts';

const log = getLogger('keeper');
const ENC = new TextEncoder();

/** The label's `aib` of one of AIB's own channels (contract.ts), or '' for anything else (a chat, a terminal, no label). */
export function aibInternalKind(label: unknown): string {
  if (typeof label !== 'string' || !label || label.length > 16384) return '';
  try {
    const value = JSON.parse(label);
    const kind = value && typeof value === 'object' && !Array.isArray(value) ? value.aib : null;
    return kind === WSL_HOLD_LABEL.aib || kind === WSL_HELPER_LABEL.aib ? kind : '';
  } catch {
    return '';
  }
}

/**
 * Is this spawn label one of AIB's own channels (the WSL keep-alive or the WSL helper)? Studio's rebuild, orphan-terminal cleanup
 * and live counts skip these: they are neither chats nor terminals, and must never be stopped as unknown or counted as work.
 */
export function isAibInternalLabel(label: unknown): boolean {
  return aibInternalKind(label) !== '';
}

/** The distro (folded key) a WSL keep-alive label names ({"aib":"wsl-hold","distro":d}), else ''. */
export function heldDistro(label: unknown): string {
  if (aibInternalKind(label) !== WSL_HOLD_LABEL.aib) return '';
  const distro = JSON.parse(String(label)).distro;
  return typeof distro === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(distro) ? distro.toLowerCase() : '';
}

/** The live channels that are real work (agents, terminals): every live one except AIB's own (isAibInternalLabel). */
export function liveUserChannels(listed: readonly ChannelInfo[]): ChannelInfo[] {
  return listed.filter((c) => c.live && !isAibInternalLabel(c.label));
}

/** Reconnect timing for a link with a connector (design section 3: 0.5, 1, 2, 4 s ... for up to 30 s in all). */
export interface ReconnectPolicy {
  delaysMs: readonly number[];
  totalMs: number;
}
export const DEFAULT_RECONNECT: ReconnectPolicy = { delaysMs: [500, 1000, 2000, 4000, 8000], totalMs: 30_000 };

/** AIB_KEEPER=0 in the environment: the keeper is off (internal escape hatch for tests and debugging; never shown in the page). */
export function keeperDisabled(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): boolean {
  try {
    return env('AIB_KEEPER') === '0';
  } catch {
    return false;
  }
}

let decided: boolean | null = null;
let problem = '';

/**
 * Decide once at start whether new chats run in the keeper (main.ts; the agent host when started with --keeper). On unless
 * AIB_KEEPER=0, or the keeper program cannot be found, built or run: then off, the reason logged and kept for Settings > About
 * (keeperProblem). A keeper that already runs for the folder counts as usable.
 */
export async function decideKeeper(
  dataDir: string | null,
  options: { env?: (name: string) => string | undefined; binary?: () => Promise<string> } = {},
): Promise<boolean> {
  problem = '';
  if (keeperDisabled(options.env)) {
    announce('keeper', 'keeper: off (AIB_KEEPER=0 is set)');
    return (decided = false);
  }
  if (dataDir && keeperRunning(dataDir)) return (decided = true);
  try {
    const binary = await (options.binary ?? (() => keeperBinary(dataDir ?? undefined)))();
    if (!await programVersion(binary)) throw new Error(`${binary} could not be run (it did not answer "version")`);
    return (decided = true);
  } catch (error) {
    noteKeeperProblem(error instanceof Error ? error.message : String(error));
    announce('keeper', 'keeper: cannot run the keeper (%s); falling back to running agents without it', problem);
    return (decided = false);
  }
}

/** Set the decision directly (tests; the agent host told to use the keeper). */
export function setKeeperDecision(on: boolean | null, why = ''): void {
  decided = on;
  problem = why;
}

/** Why the keeper is not used although it should be ('' = it is, or AIB_KEEPER=0 turned it off). Settings > About shows it. */
export function keeperProblem(): string {
  return problem;
}

let takeover = '';

/**
 * The page's banner while chats left running in the keeper (an earlier AIB quit or crashed) cannot be taken over by this AIB: the
 * running keeper refuses it or lacks what it needs ('' = nothing to say). Nothing is stopped: the chats keep running in the keeper.
 */
export function keeperTakeoverProblem(): string {
  return takeover;
}

/** Set (or with '' clear) the takeover banner: `why` is the reason, in a few words. */
export function noteKeeperTakeoverProblem(why: string): void {
  takeover = why
    ? `AIB could not take over the chats still running in the keeper (${
      why.replace(/\s+/g, ' ').trim().slice(0, 200)
    }). Nothing was stopped: they keep running there. Open them with the AIB version that started them.`
    : '';
}

/** A chat could not start in the keeper (spawn failed): remember why for Settings > About; '' clears it. */
export function noteKeeperProblem(why: string): void {
  problem = why.replace(/\s+/g, ' ').trim().slice(0, 300);
}

/** New chats start in the keeper: decideKeeper() said so in this process. False when nothing decided (unit tests, a split host). */
export function keeperSetting(): boolean {
  return decided === true;
}

/**
 * Use the keeper for this data folder at all: new chats go there (keeperSetting), or a keeper already runs there holding chats from
 * an earlier AIB: those are taken over and stay in the keeper until they end, while new chats start outside it.
 */
export function keeperWanted(dataDir: string | null): boolean {
  return keeperSetting() || (!!dataDir && keeperRunning(dataDir));
}

/** What a channel's owner hears: the keeper's records and events, plus `lost` when the keeper connection ends. */
export interface KeeperChannelListener extends ChannelListener {
  /** The keeper connection ended (the keeper died): the agent has ended with it. */
  lost?(error: Error | null): void;
  /** spawn failed (the agent never started). */
  spawnFailed?(error: Error): void;
  /** A write or note was refused (fenced, ended, busy, ...). */
  writeFailed?(error: Error): void;
}

export interface KeeperLinkOptions extends EnsureOptions {
  /** The keeper's data folder (ignored by the connection itself when `connector` is given). */
  dataDir: string;
  /**
   * Make a new authenticated connection instead of finding or starting the keeper of `dataDir` (a WSL distro's Linux keeper over a
   * bridge). `start` false: the caller only wants a keeper that already runs (null when there is none, if the connector can tell).
   */
  connector?: (start: boolean) => Promise<KeeperClient | null>;
  /** With a connector: a closed connection is a lost transport, reconnected as described above (true = DEFAULT_RECONNECT). */
  reconnect?: boolean | ReconnectPolicy;
  /** The features new chats need of this keeper (default KEEPER_NEEDS; WSL: WSL_KEEPER_NEEDS). */
  needs?: readonly string[];
  /** The version of the keeper this AIB ships for this link (default: `version` of keeperBinary(dataDir)); null when unknown. */
  bundledVersion?: () => Promise<string | null>;
  /** The `lost` error message when the keeper is gone after a transport loss (e.g. "Ubuntu stopped …, so this agent stopped."). */
  lostMessage?: string;
}

/** The transport of a reconnecting link: 'lost' (suspended, reconnecting), 'restored', or 'gone' (the keeper could not be reached). */
export type TransportState = 'lost' | 'restored' | 'gone';

export class KeeperLink {
  readonly channels = new Map<string, KeeperChannel>();
  /** Called after the keeper connection ended, with the channels that were attached (each already told `lost`). */
  onLost: ((channels: KeeperChannel[]) => void) | null = null;
  /** Called each time a keeper connection is made (Studio remembers which keeper its instance id belongs to). */
  onClient: ((client: KeeperClient) => void) | null = null;
  /** A reconnecting link's transport changed (wsl/hosts.ts shows "reconnecting" / "stopped"). */
  onTransport: ((state: TransportState, error: Error | null) => void) | null = null;
  /** Why the running keeper cannot take new chats ('' = it can); new chats then run as children of AIB (Studio checks it). */
  problem = '';
  #client: KeeperClient | null = null;
  #connecting: Promise<KeeperClient | null> | null = null;
  #reconnecting: Promise<KeeperClient | null> | null = null;
  #closed = false;
  /** The connection that passed check() with nothing left to do (current version, every needed feature). */
  #checked: KeeperClient | null = null;
  #renewing: Promise<KeeperClient> | null = null;
  #waitLogged = '';

  constructor(readonly options: KeeperLinkOptions) {}

  /**
   * The keeper a new chat starts in, after the version rules:
   *   - it lacks a feature this AIB needs (an older keeper): with no live channel it is replaced by the keeper shipped with this AIB;
   *     while it holds running agents it is kept for them and `problem` says why new chats run without it (throws `unsupported`).
   *   - the keeper shipped with this AIB is newer: it replaces the running one as soon as that holds no live channel (never while it
   *     holds chats: they would die with it). Until then the running one is used.
   */
  async check(): Promise<KeeperClient> {
    const client = await this.client(true);
    if (!client) throw new KeeperError('closed', 'the keeper could not be reached');
    if (this.#checked === client) return client;
    this.#renewing ??= this.#renew(client).finally(() => (this.#renewing = null));
    return await this.#renewing;
  }

  async #bundledVersion(): Promise<string | null> {
    try {
      if (this.options.bundledVersion) return await this.options.bundledVersion();
      return await programVersion(this.options.binary ?? await keeperBinary(this.options.dataDir));
    } catch {
      return null;
    }
  }

  async #renew(client: KeeperClient, again = true): Promise<KeeperClient> {
    const missing = missingFeatures(client.features, this.options.needs ?? KEEPER_NEEDS);
    const bundled = await this.#bundledVersion();
    const older = bundled !== null && compareKeeperVersions(bundled, client.keeperVersion) > 0;
    if (!missing.length && !older) {
      this.problem = '';
      this.#checked = client;
      return client;
    }
    const listed = await client.list();
    const live = liveUserChannels(listed).length; // AIB's own channels (hold, helper) never keep an old keeper
    if (live) {
      if (missing.length) {
        this.problem = `The running keeper (${client.keeperVersion || 'unknown version'}) lacks ${missing.join(', ')} and holds ${live} ` +
          'running agent(s); new chats run without it until those have ended.';
        throw new KeeperError('unsupported', this.problem);
      }
      const why = `${client.keeperVersion}->${bundled}:${live}`;
      if (this.#waitLogged !== why) {
        announce(
          'keeper',
          'keeper: the newer keeper %s is used once the running one (%s) holds no chats (%s now)',
          bundled,
          client.keeperVersion,
          live,
        );
        this.#waitLogged = why;
      }
      this.problem = '';
      return client;
    }
    if (!again) return client; // the replacement is no better (an odd install): use it rather than loop
    announce(
      'keeper',
      'keeper: replacing the running keeper %s (pid %s) with %s: it holds no chats%s',
      client.keeperVersion,
      client.keeperPid,
      bundled ?? 'the shipped one',
      missing.length ? ` and lacks ${missing.join(', ')}` : '',
    );
    // Its channels have all ended: let them go quietly (no "keeper lost" for chats that are already over).
    client.onClose = null;
    if (this.#client === client) this.#client = null;
    const dropped = new Map<string, KeeperChannel>();
    for (const [id, channel] of this.channels) {
      if (channel.client !== client) continue;
      this.channels.delete(id);
      dropped.set(id, channel);
    }
    const pid = client.keeperPid;
    // AIB's own live channels go first (a plain shutdown refuses while anything is live): the WSL helper holds no state, and the
    // owner of a WSL keep-alive (wsl/hosts.ts) hears `lost` and starts it again in the new keeper.
    for (const info of listed) {
      if (!info.live || !isAibInternalLabel(info.label)) continue;
      try {
        await this.stopUnknown(client, info.channel);
      } catch (error) {
        log.warning('keeper: could not stop %s before the update: %s', info.channel, error instanceof Error ? error.message : error);
      }
      dropped.get(info.channel)?.markLost(null);
    }
    try {
      await client.shutdown(false);
    } catch (error) {
      log.warning('keeper: the old keeper refused to stop (%s); keeping it', error instanceof Error ? error.message : error);
      if (!client.closed) return await this.#adoptClient(client);
    }
    client.close();
    if (!this.options.connector) {
      for (let waited = 0; pid && pidAlive(pid) && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
      return await this.#renew((await this.client(true))!, false);
    }
    // A keeper behind a connector (WSL) has a pid of another system: ask again until the old one is gone and a new one answers.
    for (let attempt = 0;; attempt++) {
      await new Promise((r) => setTimeout(r, 300));
      try {
        const next = await this.client(true);
        if (next) return await this.#renew(next, false);
      } catch (error) {
        if (attempt >= 9) throw error;
      }
      if (attempt >= 9) throw new KeeperError('closed', 'the new keeper did not answer');
    }
  }

  /** The keeper connection, starting a keeper when none runs (start=false: only an already running one, else null). */
  async client(start = true): Promise<KeeperClient | null> {
    if (this.#closed) throw new KeeperError('closed', 'this AIB no longer uses the keeper');
    if (this.#client && !this.#client.closed) return this.#client;
    if (this.#reconnecting) return await this.#reconnecting;
    const connector = this.options.connector;
    if (connector) {
      this.#connecting ??= connector(start).then((c) => (c ? this.#adoptClient(c) : null)).finally(() => {
        this.#connecting = null;
      });
      return await this.#connecting;
    }
    if (!start) {
      if (this.#connecting) return await this.#connecting;
      const found = await findKeeper(this.options.dataDir);
      return found ? this.#adoptClient(found) : null;
    }
    this.#connecting ??= ensureKeeper(this.options.dataDir, this.options).then((c) => this.#adoptClient(c)).finally(() => {
      this.#connecting = null;
    });
    return await this.#connecting;
  }

  async #adoptClient(client: KeeperClient): Promise<KeeperClient> {
    if (this.#client && !this.#client.closed && this.#client !== client) {
      client.close();
      return this.#client;
    }
    this.#client = client;
    client.onClose = (error) => this.#lost(client, error);
    try {
      this.onClient?.(client);
    } catch (error) {
      log.exception(error, 'keeper onClient hook failed');
    }
    if (this.options.orphan !== undefined && client.has('orphan')) {
      try {
        await client.setOrphanCommand(this.options.orphan); // the newest AIB says how to start AIB again
      } catch (error) {
        log.warning('keeper: setOrphanCommand failed: %s', error instanceof Error ? error.message : error);
      }
    }
    return client;
  }

  get #policy(): ReconnectPolicy | null {
    const r = this.options.reconnect;
    if (!this.options.connector || !r) return null;
    return r === true ? DEFAULT_RECONNECT : r;
  }

  /** Is the transport down and being reconnected right now? */
  get reconnecting(): boolean {
    return this.#reconnecting !== null;
  }

  #lost(client: KeeperClient, error: Error | null): void {
    if (this.#client === client) this.#client = null;
    if (this.#policy && !this.#closed) {
      this.#transportLost(client, error);
      return;
    }
    const lost = [...this.channels.values()].filter((c) => c.client === client);
    for (const channel of lost) {
      this.channels.delete(channel.id);
      channel.markLost(error);
    }
    if (!this.#closed && lost.length) {
      log.warning('keeper: the keeper connection ended (%s); %s agent(s) ended with it', error?.message ?? 'closed', lost.length);
      try {
        this.onLost?.(lost);
      } catch (caught) {
        log.exception(caught, 'keeper onLost hook failed');
      }
    }
  }

  /** The transport ended (not necessarily the keeper): suspend its channels and reconnect in the background. */
  #transportLost(client: KeeperClient, error: Error | null): void {
    const affected = [...this.channels.values()].filter((c) => c.client === client && !c.lost);
    for (const channel of affected) channel.suspend();
    log.warning('keeper: the transport ended (%s); reconnecting %s channel(s)', error?.message ?? 'closed', affected.length);
    this.#tell('lost', error);
    if (!affected.length) return; // nothing waits: the next use connects again
    const work = this.#reconnect(affected, error);
    this.#reconnecting = work;
    work.finally(() => {
      if (this.#reconnecting === work) this.#reconnecting = null;
    }).catch(() => {});
  }

  #tell(state: TransportState, error: Error | null): void {
    try {
      this.onTransport?.(state, error);
    } catch (caught) {
      log.exception(caught, 'keeper onTransport hook failed');
    }
  }

  async #reconnect(affected: KeeperChannel[], cause: Error | null): Promise<KeeperClient | null> {
    const policy = this.#policy ?? DEFAULT_RECONNECT;
    const deadline = Date.now() + policy.totalMs;
    let last: Error | null = cause;
    let client: KeeperClient | null = null;
    for (let attempt = 0; !this.#closed; attempt++) {
      try {
        client = await this.options.connector!(true);
        if (client) break;
      } catch (error) {
        last = error instanceof Error ? error : new Error(String(error));
      }
      const wait = policy.delaysMs[Math.min(attempt, policy.delaysMs.length - 1)] ?? 1000;
      if (Date.now() + wait > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    if (this.#closed) {
      client?.close();
      return null;
    }
    if (!client) {
      log.warning('keeper: could not reach the keeper again (%s)', last?.message ?? 'no answer');
      this.#endLost(affected, last);
      this.#tell('gone', last);
      return null;
    }
    // Adopt it as the link's connection first (onClose, onClient), then put every waiting channel back where it was.
    await this.#adoptClient(client);
    let listed: ChannelInfo[] | null = null;
    try {
      listed = await client.list();
    } catch (error) {
      last = error instanceof Error ? error : new Error(String(error));
    }
    const byId = new Map((listed ?? []).map((info) => [info.channel, info]));
    const lost: KeeperChannel[] = [];
    for (const channel of affected) {
      if (channel.lost) continue;
      const info = byId.get(channel.id);
      if (!listed || !info || !info.live || client.closed) {
        lost.push(channel); // ended or gone while the transport was down (the keeper itself stopped): this is a real loss
        continue;
      }
      try {
        channel.client = client;
        if (channel.owner) channel.epoch = await client.claim(channel.id); // the old connection's claim ended with it
        await client.attach(channel.id, channel.lastSeq + 1, channel.relay());
        channel.resume();
      } catch (error) {
        log.warning('keeper: could not re-attach %s: %s', channel.id, error instanceof Error ? error.message : error);
        lost.push(channel);
      }
    }
    if (lost.length) this.#endLost(lost, last);
    this.#tell('restored', null);
    return client;
  }

  #endLost(channels: KeeperChannel[], cause: Error | null): void {
    const error = new KeeperError('keeper_lost', this.options.lostMessage ?? cause?.message ?? 'the keeper is gone');
    const lost = channels.filter((c) => !c.lost);
    for (const channel of lost) {
      if (this.channels.get(channel.id) === channel) this.channels.delete(channel.id);
      channel.markLost(error);
    }
    if (this.#closed || !lost.length) return;
    try {
      this.onLost?.(lost);
    } catch (caught) {
      log.exception(caught, 'keeper onLost hook failed');
    }
  }

  /**
   * Start an agent (or a terminal) in the keeper. Returns at once; operations wait for the spawn. `first` runs right after it (the
   * chat note). `needs`: features the keeper must offer for this spawn; without them it fails with KeeperError `unsupported` (the
   * listener's spawnFailed) and nothing is started.
   */
  spawn(
    spec: SpawnSpec & { channel: string },
    listener: KeeperChannelListener,
    first?: () => Json | null,
    needs?: readonly string[],
  ): KeeperChannel {
    const channel = new KeeperChannel(spec.channel, listener);
    this.channels.set(channel.id, channel);
    channel.start(async () => {
      const client = await this.check();
      const missing = needs ? missingFeatures(client.features, needs) : [];
      if (missing.length) {
        throw new KeeperError(
          'unsupported',
          `the running keeper (${client.keeperVersion || 'unknown version'}) lacks ${missing.join(', ')}`,
        );
      }
      channel.client = client;
      const answer = await client.spawn(spec);
      channel.pid = answer.pid;
      channel.epoch = answer.epoch;
      const note = first?.();
      if (note) void channel.sendNote(note, undefined, true);
      await client.attach(channel.id, 0, channel.relay());
    });
    return channel;
  }

  /** Take over a channel an earlier AIB started: attach from the start (replay); claim() makes it writable. */
  adopt(info: ChannelInfo, listener: KeeperChannelListener): KeeperChannel {
    const channel = new KeeperChannel(info.channel, listener);
    channel.pid = info.pid;
    this.channels.set(channel.id, channel);
    channel.start(async () => {
      const client = await this.client(false);
      if (!client) throw new KeeperError('closed', 'no keeper runs');
      channel.client = client;
      await client.attach(channel.id, 0, channel.relay());
    }, false);
    return channel;
  }

  /**
   * Read a channel from the start until its chat note (or a snapshot's copy of it, when the journal was truncated after a snapshot),
   * then detach. null when it has none.
   */
  async firstNote(client: KeeperClient, channel: string, timeoutMs = 10000): Promise<Json | null> {
    let done: (value: Json | null) => void = () => {};
    const result = new Promise<Json | null>((resolve) => (done = resolve));
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      await client.attach(channel, 0, {
        record(record) {
          if (record.kind !== 'note') return;
          const note = parseNote(record.body);
          if (note?.t === 'chat') done(note);
          else if (note?.t === 'snapshot' && note.chat && typeof note.chat === 'object') done({ ...(note.chat as Json), t: 'chat' });
          else if (!note || (note.t !== 'receipt' && note.t !== 'event' && note.t !== 'fsWrite' && note.t !== 'clientTerminal')) {
            done(note); // not AIB's: the caller decides (it stops a channel without a chat record)
          }
        },
        live() {
          done(null);
        },
        removed() {
          done(null);
        },
      });
      return await result;
    } finally {
      clearTimeout(timer);
      try {
        await client.detach(channel);
      } catch { /* gone */ }
    }
  }

  /** Remove an ended channel of an earlier AIB (claim it, then truncate past its end). */
  async removeEnded(client: KeeperClient, channel: string): Promise<void> {
    const epoch = await client.claim(channel);
    await client.truncate(channel, epoch, Number.MAX_SAFE_INTEGER);
  }

  /** Stop a live channel nobody can take over (no chat note): claim it and kill its tree. */
  async stopUnknown(client: KeeperClient, channel: string): Promise<void> {
    const epoch = await client.claim(channel);
    await client.kill(channel, epoch);
  }

  /** Stop using the keeper connection without touching any agent (what a crashed AIB looks like to the keeper). Tests use it. */
  disconnect(): void {
    this.#closed = true;
    const client = this.#client;
    this.#client = null;
    this.channels.clear();
    client?.close();
  }
}

type Json = Record<string, unknown>;

export function parseNote(body: Uint8Array): Json | null {
  try {
    const value = JSON.parse(new TextDecoder().decode(body));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
  } catch {
    return null;
  }
}

/** One agent in the keeper, as its Connection sees it. Operations go out in call order. */
export class KeeperChannel {
  client: KeeperClient | null = null;
  pid = 0;
  epoch = 0;
  lost = false;
  /** The newest record seq this channel's listener got (a reconnect attaches again from the one after). */
  lastSeq = 0;
  #ready: Promise<void> = Promise.resolve();
  #owner = true;
  #suspended: { resolve(): void; reject(error: Error): void } | null = null;

  constructor(readonly id: string, readonly listener: KeeperChannelListener) {}

  /** This connection's side writes the channel (it spawned or claimed it, and was not fenced since). */
  get owner(): boolean {
    return this.#owner;
  }

  /** Is the channel waiting for its transport to come back (operations wait meanwhile)? */
  get suspended(): boolean {
    return this.#suspended !== null;
  }

  /** The transport is gone for now: operations wait until resume(), or fail when the channel is lost. */
  suspend(): void {
    if (this.#suspended || this.lost) return;
    const waiting = new Promise<void>((resolve, reject) => (this.#suspended = { resolve, reject }));
    waiting.catch(() => {}); // a lost channel's waiting operations fail one by one; this copy is never awaited
    this.#ready = waiting;
  }

  /** Attached again (KeeperLink's reconnect): the waiting operations go out on the new connection. */
  resume(): void {
    const waiting = this.#suspended;
    this.#suspended = null;
    waiting?.resolve();
  }

  start(work: () => Promise<void>, owner = true): void {
    this.#owner = owner;
    this.#ready = work();
    this.#ready.catch((error) => {
      if (this.lost) return;
      this.listener.spawnFailed?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  get ready(): Promise<void> {
    return this.#ready;
  }

  /** Relays the keeper's events for this channel to the listener (bound once per attach). */
  relay(): ChannelListener {
    const l = this.listener;
    return {
      record: (record: KeeperRecord) => {
        this.lastSeq = Math.max(this.lastSeq, record.seq);
        l.record?.(record);
      },
      live: (seq: number) => l.live?.(seq),
      gap: (from: number, next: number) => {
        this.lastSeq = Math.max(this.lastSeq, next - 1);
        l.gap?.(from, next);
      },
      fenced: (epoch: number) => {
        this.#owner = false;
        l.fenced?.(epoch);
      },
      removed: () => l.removed?.(),
    };
  }

  markLost(error: Error | null): void {
    if (this.lost) return;
    this.lost = true;
    const waiting = this.#suspended;
    this.#suspended = null;
    waiting?.reject(error ?? new KeeperError('closed', 'the keeper connection is closed'));
    this.listener.lost?.(error);
  }

  /** Become the only writer (a rebuilt chat, after its replay). */
  async claim(): Promise<number> {
    await this.#ready;
    this.epoch = await this.client!.claim(this.id);
    this.#owner = true;
    return this.epoch;
  }

  /**
   * One operation once the channel is ready. `retry` (an op the keeper deduplicates: a once-key): when the transport ended under it
   * and the channel was suspended for a reconnect, it is sent once more after resume() instead of failing.
   */
  #op<T>(work: (client: KeeperClient) => Promise<T>, retry = false): Promise<T> {
    const run = () =>
      this.#ready.then(() => {
        if (!this.client || this.client.closed) throw new KeeperError('closed', 'the keeper connection is closed');
        return work(this.client);
      });
    if (!retry) return run();
    return run().catch(async (error) => {
      await Promise.resolve(); // the link's onClose (which suspends) runs before this
      if (!(error instanceof KeeperError && error.code === 'closed') || !this.suspended) throw error;
      return run();
    });
  }

  #reportFailure(error: unknown): void {
    if (this.lost) return;
    this.listener.writeFailed?.(error instanceof Error ? error : new Error(String(error)));
  }

  /** Bytes to the agent's stdin. A once-key already used is treated as done. Failures go to listener.writeFailed. */
  write(body: Uint8Array, once?: string): Promise<boolean> {
    const done = this.#op((c) => c.write(this.id, this.epoch, body, once), !!once).then(() => true);
    done.catch((error) => this.#reportFailure(error));
    return done.catch(() => false);
  }

  /** A note in the journal (AIB's own record of a decision, written before acting on it). Resolves true once stored. */
  sendNote(note: Json, once?: string, quiet = false): Promise<boolean> {
    const body = ENC.encode(JSON.stringify({ v: 1, ...note }));
    const done = this.client && quiet
      ? this.client.note(this.id, this.epoch, body, once).then(() => true) // inside the spawn step itself: no waiting on #ready
      : this.#op((c) => c.note(this.id, this.epoch, body, once)).then(() => true);
    done.catch((error) => log.warning('keeper note on %s failed: %s', this.id, error instanceof Error ? error.message : error));
    return done.catch(() => false);
  }

  /** A snapshot note (AIB's whole state of the chat at a quiet moment): its seq once stored, null when it could not be stored. */
  snapshot(note: Json): Promise<number | null> {
    const body = ENC.encode(JSON.stringify({ v: 1, ...note }));
    return this.#op((c) => c.note(this.id, this.epoch, body)).then((r) => r.seq || null).catch((error) => {
      log.warning('keeper snapshot on %s failed: %s', this.id, error instanceof Error ? error.message : error);
      return null;
    });
  }

  /** Let the keeper delete the journal segments wholly before `before` (only after a snapshot covering them). Never throws. */
  truncate(before: number): Promise<void> {
    return this.#op(async (c) => {
      if (!c.has('truncate')) return;
      await c.truncate(this.id, this.epoch, before);
    }).catch((error) => log.warning('keeper truncate on %s failed: %s', this.id, error instanceof Error ? error.message : error));
  }

  closeStdin(): Promise<void> {
    return this.#op((c) => c.closeStdin(this.id, this.epoch)).catch(() => {});
  }

  /** A terminal's new size (ptys). Never throws. */
  resize(cols: number, rows: number): Promise<void> {
    return this.#op(async (c) => {
      await c.resize(this.id, this.epoch, cols, rows);
    }).catch(() => {});
  }

  /** Kill the whole process tree (Windows: its Job Object). */
  kill(): Promise<void> {
    if (!this.#owner) return Promise.resolve();
    return this.#op((c) => c.kill(this.id, this.epoch)).catch(() => {});
  }

  /** Remove an ended channel and its journal (the chat was closed: its record is no longer needed). */
  remove(): Promise<void> {
    return this.#op(async (c) => {
      await c.truncate(this.id, this.epoch, Number.MAX_SAFE_INTEGER);
      c.listeners.delete(this.id);
    }).catch(() => {});
  }

  /** Stop following the channel (it keeps running). */
  detach(): Promise<void> {
    return this.#op((c) => c.detach(this.id)).catch(() => {});
  }
}
