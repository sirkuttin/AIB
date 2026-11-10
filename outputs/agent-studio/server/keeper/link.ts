/**
 * A Studio's link to the keeper: one keeper connection per Studio, started on first use, and one KeeperChannel per agent the
 * Studio runs through it. A channel queues its operations until the keeper has spawned it, so a Connection can write right away,
 * exactly as it writes to a child's stdin.
 *
 * The switch (off by default): AIB_KEEPER=1 makes Studio start agents through the keeper (keeperEnabled()). With it off nothing here
 * runs and agents are children of AIB as before.
 */
import { getLogger } from '../core/log.ts';
import {
  type ChannelInfo,
  type ChannelListener,
  ensureKeeper,
  type EnsureOptions,
  findKeeper,
  type KeeperClient,
  KeeperError,
  type KeeperRecord,
  type SpawnSpec,
} from './client.ts';

const log = getLogger('keeper');
const ENC = new TextEncoder();

/** The switch: agents run under the keeper only with AIB_KEEPER=1 (default off, so the app behaves as before). */
export function keeperEnabled(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): boolean {
  return env('AIB_KEEPER') === '1';
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
  #client: KeeperClient | null = null;
  #connecting: Promise<KeeperClient> | null = null;
  #closed = false;

  constructor(readonly options: KeeperLinkOptions) {}

  /** The keeper connection, starting a keeper when none runs (start=false: only an already running one, else null). */
  async client(start = true): Promise<KeeperClient | null> {
    if (this.#closed) throw new KeeperError('closed', 'this Studio no longer uses the keeper');
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
      const client = (await this.client(true))!;
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

  /** Read a channel from the start until its first note (the chat note), then detach. null when it has none. */
  async firstNote(client: KeeperClient, channel: string, timeoutMs = 10000): Promise<Json | null> {
    let done: (value: Json | null) => void = () => {};
    const result = new Promise<Json | null>((resolve) => (done = resolve));
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      await client.attach(channel, 0, {
        record(record) {
          if (record.kind === 'note') done(parseNote(record.body));
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
