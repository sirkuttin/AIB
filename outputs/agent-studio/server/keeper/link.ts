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
  keeperBinary,
  type KeeperClient,
  KeeperError,
  type KeeperRecord,
  keeperRunning,
  missingFeatures,
  programVersion,
  type SpawnSpec,
} from './client.ts';

const log = getLogger('keeper');
const ENC = new TextEncoder();

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
  dataDir: string;
}

export class KeeperLink {
  readonly channels = new Map<string, KeeperChannel>();
  /** Called after the keeper connection ended, with the channels that were attached (each already told `lost`). */
  onLost: ((channels: KeeperChannel[]) => void) | null = null;
  /** Called each time a keeper connection is made (Studio remembers which keeper its instance id belongs to). */
  onClient: ((client: KeeperClient) => void) | null = null;
  /** Why the running keeper cannot take new chats ('' = it can); new chats then run as children of AIB (Studio checks it). */
  problem = '';
  #client: KeeperClient | null = null;
  #connecting: Promise<KeeperClient> | null = null;
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
    const client = (await this.client(true))!;
    if (this.#checked === client) return client;
    this.#renewing ??= this.#renew(client).finally(() => (this.#renewing = null));
    return await this.#renewing;
  }

  async #bundledVersion(): Promise<string | null> {
    try {
      return await programVersion(this.options.binary ?? await keeperBinary(this.options.dataDir));
    } catch {
      return null;
    }
  }

  async #renew(client: KeeperClient, again = true): Promise<KeeperClient> {
    const missing = missingFeatures(client.features);
    const bundled = await this.#bundledVersion();
    const older = bundled !== null && compareKeeperVersions(bundled, client.keeperVersion) > 0;
    if (!missing.length && !older) {
      this.problem = '';
      this.#checked = client;
      return client;
    }
    const live = (await client.list()).filter((c) => c.live).length;
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
    for (const [id, channel] of this.channels) if (channel.client === client) this.channels.delete(id);
    const pid = client.keeperPid;
    try {
      await client.shutdown(false);
    } catch (error) {
      log.warning('keeper: the old keeper refused to stop (%s); keeping it', error instanceof Error ? error.message : error);
      if (!client.closed) return await this.#adoptClient(client);
    }
    client.close();
    for (let waited = 0; pid && pidAlive(pid) && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
    return await this.#renew((await this.client(true))!, false);
  }

  /** The keeper connection, starting a keeper when none runs (start=false: only an already running one, else null). */
  async client(start = true): Promise<KeeperClient | null> {
    if (this.#closed) throw new KeeperError('closed', 'this AIB no longer uses the keeper');
    if (this.#client && !this.#client.closed) return this.#client;
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

  #lost(client: KeeperClient, error: Error | null): void {
    if (this.#client === client) this.#client = null;
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

  /** Start an agent in the keeper. Returns at once; operations wait for the spawn. `first` runs right after it (the chat note). */
  spawn(spec: SpawnSpec & { channel: string }, listener: KeeperChannelListener, first?: () => Json | null): KeeperChannel {
    const channel = new KeeperChannel(spec.channel, listener);
    this.channels.set(channel.id, channel);
    channel.start(async () => {
      const client = await this.check();
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
  #ready: Promise<void> = Promise.resolve();
  #owner = true;

  constructor(readonly id: string, readonly listener: KeeperChannelListener) {}

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
      record: (record: KeeperRecord) => l.record?.(record),
      live: (seq: number) => l.live?.(seq),
      gap: (from: number, next: number) => l.gap?.(from, next),
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
    this.listener.lost?.(error);
  }

  /** Become the only writer (a rebuilt chat, after its replay). */
  async claim(): Promise<number> {
    await this.#ready;
    this.epoch = await this.client!.claim(this.id);
    this.#owner = true;
    return this.epoch;
  }

  #op<T>(work: (client: KeeperClient) => Promise<T>): Promise<T> {
    return this.#ready.then(() => {
      if (!this.client || this.client.closed) throw new KeeperError('closed', 'the keeper connection is closed');
      return work(this.client);
    });
  }

  #reportFailure(error: unknown): void {
    if (this.lost) return;
    this.listener.writeFailed?.(error instanceof Error ? error : new Error(String(error)));
  }

  /** Bytes to the agent's stdin. A once-key already used is treated as done. Failures go to listener.writeFailed. */
  write(body: Uint8Array, once?: string): Promise<boolean> {
    const done = this.#op((c) => c.write(this.id, this.epoch, body, once)).then(() => true);
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
