/**
 * The link between paired PCs (sync between PCs, slice V2): one WebSocket per peer, authenticated, reconnecting, with a small message
 * protocol (pcsync/frames.ts: hello, ping, and a generic batch envelope later slices fill). Nothing here knows projects or files.
 *
 * Both PCs dial each other. The dialing PC's first frame carries its token (never the URL or a header, which Serve may log); the
 * listening PC checks it against the hash it keeps and answers with its own hello. If both dial at once, exactly one link is kept:
 * the one dialed by the PC whose tailnet name sorts lower (both PCs apply the same rule to the same two names). Peer ids are local to
 * each PC, so names are what the rule compares.
 *
 * A dial that fails is retried after 30 s, doubling to 5 min; a peer that Tailscale newly shows as online is dialed at once. A link
 * that stays quiet is pinged, and one that stays silent longer is dropped and dialed again.
 */
import { type BatchItem, type Frame, MAX_FRAME_BYTES, MAX_HELLO_BYTES, parseFrame, PROTOCOL } from './frames.ts';
import type { Peer } from './peers.ts';

type Timer = ReturnType<typeof setTimeout>;
export type LinkState = 'connected' | 'connecting' | 'offline' | 'refused';
export type Direction = 'out' | 'in';

/** Close codes of this protocol (4000-4999 are free for applications). */
export const CLOSE = {
  badToken: 4401,
  tooMany: 4429,
  duplicate: 4409,
  removed: 4410,
  idle: 4408,
  off: 4411,
  badFrame: 4400,
  tooBig: 4413,
  binary: 4415,
} as const;

export interface LinkTimings {
  /** A ping goes out when nothing was heard for this long. */
  pingMs: number;
  /** A link silent for this long is dropped. */
  idleMs: number;
  /** The first frame must come within this. */
  helloMs: number;
  /** A dial that gets no answer in this time fails. */
  connectMs: number;
  backoffMin: number;
  backoffMax: number;
  /** How often `tailscale status --json` is read to see which peers are online. */
  pollMs: number;
  /** An existing link that must answer a ping this fast to keep its place against a duplicate. */
  probeMs: number;
}

export const DEFAULT_TIMINGS: LinkTimings = {
  pingMs: 25_000,
  idleMs: 75_000,
  helloMs: 5_000,
  connectMs: 8_000,
  backoffMin: 30_000,
  backoffMax: 300_000,
  pollMs: 30_000,
  probeMs: 3_000,
};

export interface LinkHost {
  peers(): Peer[];
  outToken(peer: Peer): string | null;
  /** This PC's tailnet name and machine name (null until Tailscale was read). */
  own(): { host: string; name: string } | null;
  /** Where a peer's sync socket is dialed: `ws(s)://…/pcsync/sync`. */
  url(host: string): string;
  /** A presented token: its peer, 'many' when too many wrong ones came lately, or null. */
  authenticate(token: unknown): Peer | 'many' | null;
  /** Which of the owner's tailnet PCs show as online right now, by tailnet name. */
  online(): Promise<Map<string, boolean>>;
  touch(peer: Peer): void;
  /** A link to this peer just came up (called after the hello exchange is on the wire, so a frame sent from here follows it). */
  onUp?(peer: Peer): void;
  onBatch?(peer: Peer, batch: { id: string; project?: string; items: BatchItem[] }): void;
  log(message: string): void;
}

interface Link {
  peer: Peer;
  ws: WebSocket;
  dir: Direction;
  since: number;
  lastRx: number;
  timer: Timer | undefined;
  probe: Timer | undefined;
  gone: boolean;
}

interface Dialer {
  peerId: string;
  timer: Timer | undefined;
  fails: number;
  connecting: boolean;
  refused: boolean;
}

const sendText = (ws: WebSocket, frame: Frame): boolean => {
  try {
    if (ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
};

const closeSocket = (ws: WebSocket, code: number, reason: string): void => {
  try {
    ws.close(code, reason);
  } catch { /* already closing */ }
};

export class LinkManager {
  readonly timings: LinkTimings;
  #links = new Map<string, Link>();
  #dialers = new Map<string, Dialer>();
  #pending = new Set<WebSocket>();
  #running = false;
  #poller: Timer | undefined;
  #seenOnline = new Map<string, boolean>();

  constructor(readonly host: LinkHost, timings: Partial<LinkTimings> = {}) {
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
  }

  get running(): boolean {
    return this.#running;
  }

  /** The state a peer's row shows: Connected, Connecting (a dial is under way), Offline, or Refused (it no longer trusts this PC). */
  state(peerId: string): LinkState {
    if (this.#links.has(peerId)) return 'connected';
    const d = this.#dialers.get(peerId);
    if (!d) return 'offline';
    if (d.connecting) return 'connecting';
    return d.refused ? 'refused' : 'offline';
  }

  /** Tests: which links exist and who dialed them. */
  links(): { peerId: string; dir: Direction }[] {
    return [...this.#links.values()].map((l) => ({ peerId: l.peer.id, dir: l.dir }));
  }

  /** Send a batch to a peer; false when there is no link. */
  sendBatch(peerId: string, batch: { id: string; project?: string; items: BatchItem[] }): boolean {
    const link = this.#links.get(peerId);
    return !!link && sendText(link.ws, { t: 'batch', ...batch });
  }

  // ---- start, stop -------------------------------------------------------------------------------------------------------------
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.ensure();
    this.#poller = setInterval(() => void this.#poll(), this.timings.pollMs);
    Deno.unrefTimer?.(this.#poller);
  }

  stop(): void {
    this.#running = false;
    clearInterval(this.#poller);
    for (const d of this.#dialers.values()) clearTimeout(d.timer);
    this.#dialers.clear();
    for (const link of [...this.#links.values()]) this.#drop(link, CLOSE.off, 'sync is off');
    for (const ws of this.#pending) closeSocket(ws, CLOSE.off, 'sync is off');
    this.#pending.clear();
    this.#seenOnline.clear();
  }

  /** Make sure every paired peer has a dialer (a new pairing) and forget the dialers of peers that are gone. */
  ensure(): void {
    if (!this.#running) return;
    const ids = new Set(this.host.peers().map((p) => p.id));
    for (const id of [...this.#dialers.keys()]) if (!ids.has(id)) this.forget(id);
    for (const id of ids) {
      if (this.#dialers.has(id)) continue;
      this.#dialers.set(id, { peerId: id, timer: undefined, fails: 0, connecting: false, refused: false });
      this.#schedule(id, 0);
    }
  }

  /** A peer was removed: its link closes at once and it is not dialed again. */
  forget(peerId: string): void {
    const d = this.#dialers.get(peerId);
    if (d) clearTimeout(d.timer);
    this.#dialers.delete(peerId);
    const link = this.#links.get(peerId);
    if (link) this.#drop(link, CLOSE.removed, 'removed');
  }

  /** Dial this peer now (Tailscale shows it online), whatever the backoff says. */
  wake(peerId: string): void {
    const d = this.#dialers.get(peerId);
    if (!d || d.connecting || this.#links.has(peerId)) return;
    d.fails = 0;
    this.#schedule(peerId, 0);
  }

  async #poll(): Promise<void> {
    if (!this.#running) return;
    let online: Map<string, boolean>;
    try {
      online = await this.host.online();
    } catch {
      return;
    }
    if (!this.#running) return;
    for (const peer of this.host.peers()) {
      const now = online.get(peer.host) === true;
      const before = this.#seenOnline.get(peer.host) === true;
      this.#seenOnline.set(peer.host, now);
      if (now && !before) this.wake(peer.id);
    }
  }

  // ---- dialing -----------------------------------------------------------------------------------------------------------------
  #backoff(fails: number): number {
    return Math.min(this.timings.backoffMax, this.timings.backoffMin * 2 ** Math.max(0, fails - 1));
  }

  #schedule(peerId: string, ms: number): void {
    const d = this.#dialers.get(peerId);
    if (!d || !this.#running) return;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => void this.#attempt(peerId), ms);
    Deno.unrefTimer(d.timer as unknown as number);
  }

  async #attempt(peerId: string): Promise<void> {
    const d = this.#dialers.get(peerId);
    const peer = this.host.peers().find((p) => p.id === peerId);
    if (!d || !peer || !this.#running || d.connecting || this.#links.has(peerId)) return;
    const own = this.host.own();
    const token = this.host.outToken(peer);
    if (!own || !token) {
      d.fails++;
      return this.#schedule(peerId, this.#backoff(d.fails));
    }
    d.connecting = true;
    const result = await this.#dial(peer, own, token);
    d.connecting = false;
    if (this.#dialers.get(peerId) !== d || !this.#running) return;
    d.refused = result === 'refused';
    if (result === 'linked') {
      d.fails = 0;
      return;
    }
    d.fails = result === 'refused' ? Math.max(d.fails + 1, 6) : d.fails + 1;
    this.#schedule(peerId, result === 'duplicate' ? this.timings.backoffMin : this.#backoff(d.fails));
  }

  /** One dial: open, send the token, read the other PC's hello, register the link. */
  #dial(peer: Peer, own: { host: string; name: string }, token: string): Promise<'linked' | 'failed' | 'refused' | 'duplicate'> {
    return new Promise((resolve) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.host.url(peer.host));
      } catch {
        return resolve('failed');
      }
      let settled = false;
      const timer = setTimeout(() => done('failed', 4408, 'no answer'), this.timings.connectMs);
      const done = (result: 'linked' | 'failed' | 'refused' | 'duplicate', code = 0, reason = '') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code) closeSocket(ws, code, reason);
        resolve(result);
      };
      ws.onopen = () => {
        sendText(ws, { t: 'hello', v: PROTOCOL, token, name: own.name, host: own.host });
      };
      ws.onerror = () => done('failed');
      ws.onclose = (event) => {
        if (settled) return;
        done(event.code === CLOSE.badToken ? 'refused' : event.code === CLOSE.duplicate ? 'duplicate' : 'failed');
      };
      ws.onmessage = (event) => {
        if (settled) return;
        if (typeof event.data !== 'string' || event.data.length > MAX_HELLO_BYTES) return done('failed', CLOSE.badFrame, 'bad hello');
        const frame = parseFrame(event.data, true);
        if (!frame.ok || frame.value.t !== 'hello' || frame.value.host !== peer.host) return done('failed', CLOSE.badFrame, 'bad hello');
        const link = this.#register(peer, ws, 'out', own.host);
        done(link ? 'linked' : 'duplicate', link ? 0 : CLOSE.duplicate, 'duplicate');
      };
    });
  }

  // ---- listening ---------------------------------------------------------------------------------------------------------------
  /** Room for one more socket that has not said hello yet. */
  canAccept(): boolean {
    return this.#running && this.#pending.size < 8;
  }

  /** A socket a peer opened on the listener (the gate already passed). Its first frame must be a hello with a good token. */
  accept(ws: WebSocket): void {
    this.#pending.add(ws);
    let handled = false;
    const timer = setTimeout(() => finish(null, CLOSE.idle, 'no hello'), this.timings.helloMs);
    const finish = (peer: Peer | null, code = 0, reason = '') => {
      clearTimeout(timer);
      this.#pending.delete(ws);
      if (peer || !code) return;
      closeSocket(ws, code, reason);
    };
    ws.onclose = () => finish(null);
    ws.onerror = () => finish(null);
    ws.onmessage = (event) => {
      if (handled) return;
      handled = true;
      if (typeof event.data !== 'string' || event.data.length > MAX_HELLO_BYTES) return finish(null, CLOSE.tooBig, 'first frame too big');
      const frame = parseFrame(event.data, true);
      if (!frame.ok || frame.value.t !== 'hello') return finish(null, CLOSE.badFrame, 'bad hello');
      const peer = this.host.authenticate(frame.value.token);
      if (peer === 'many') return finish(null, CLOSE.tooMany, 'too many wrong tokens');
      if (!peer || peer.host !== frame.value.host) return finish(null, CLOSE.badToken, 'not paired');
      const own = this.host.own();
      if (!own || !this.#running) return finish(null, CLOSE.off, 'sync is off');
      this.#pending.delete(ws);
      clearTimeout(timer);
      const link = this.#register(peer, ws, 'in', own.host);
      if (!link) return closeSocket(ws, CLOSE.duplicate, 'duplicate');
      sendText(ws, { t: 'hello', v: PROTOCOL, name: own.name, host: own.host });
    };
  }

  // ---- links -------------------------------------------------------------------------------------------------------------------
  /** Keep exactly one link per peer. Returns the new link, or null when the existing one keeps its place. */
  #register(peer: Peer, ws: WebSocket, dir: Direction, ownHost: string): Link | null {
    const existing = this.#links.get(peer.id);
    if (existing) {
      const winner: Direction = ownHost < peer.host ? 'out' : 'in';
      if (dir !== existing.dir && dir !== winner) {
        this.#probe(existing); // the other PC dialed while this one holds a link: is that link still alive?
        return null;
      }
      this.#drop(existing, CLOSE.duplicate, 'replaced');
    }
    const now = Date.now();
    const link: Link = { peer, ws, dir, since: now, lastRx: now, timer: undefined, probe: undefined, gone: false };
    this.#links.set(peer.id, link);
    const d = this.#dialers.get(peer.id);
    if (d) {
      d.refused = false;
      d.fails = 0;
    }
    ws.onmessage = (event) => this.#message(link, event.data);
    ws.onclose = () => this.#drop(link);
    ws.onerror = () => this.#drop(link);
    const tick = Math.max(20, Math.floor(this.timings.pingMs / 2));
    link.timer = setInterval(() => {
      if (Date.now() - link.lastRx > this.timings.idleMs) return this.#drop(link, CLOSE.idle, 'silent');
      if (Date.now() - link.lastRx >= this.timings.pingMs) sendText(ws, { t: 'ping' });
    }, tick);
    Deno.unrefTimer(link.timer as unknown as number);
    this.host.touch(peer);
    this.host.log(`sync link to ${peer.name} is up (${dir})`);
    // after this tick: the listening side sends its hello right after registering, and nothing may be sent before it
    setTimeout(() => {
      if (!link.gone) this.host.onUp?.(peer);
    }, 0);
    return link;
  }

  /** An existing link must show it is alive within probeMs, or a newcomer may take its place. */
  #probe(link: Link): void {
    if (link.probe || link.gone) return;
    const asked = Date.now();
    sendText(link.ws, { t: 'ping' });
    link.probe = setTimeout(() => {
      link.probe = undefined;
      if (!link.gone && link.lastRx <= asked) this.#drop(link, CLOSE.idle, 'silent');
    }, this.timings.probeMs);
    Deno.unrefTimer(link.probe as unknown as number);
  }

  /** The link ends (a close, an error, or a drop on purpose). Only the registered link of a peer counts. */
  #drop(link: Link, code = 0, reason = ''): void {
    if (link.gone) return;
    link.gone = true;
    clearInterval(link.timer);
    clearTimeout(link.probe);
    if (this.#links.get(link.peer.id) === link) this.#links.delete(link.peer.id);
    if (code) closeSocket(link.ws, code, reason);
    else closeSocket(link.ws, 1000, '');
    const wasCurrent = this.#running && this.#dialers.has(link.peer.id) && !this.#links.has(link.peer.id);
    if (!wasCurrent || code === CLOSE.removed || code === CLOSE.off) return;
    // lost: dial again at once, unless this link did not even last a few seconds (then back off)
    const d = this.#dialers.get(link.peer.id)!;
    if (Date.now() - link.since < 3000) d.fails++;
    else d.fails = 0;
    this.#schedule(link.peer.id, d.fails ? this.#backoff(d.fails) : 0);
  }

  #message(link: Link, data: unknown): void {
    if (link.gone) return;
    link.lastRx = Date.now();
    if (typeof data !== 'string') return this.#drop(link, CLOSE.binary, 'text only');
    if (data.length > MAX_FRAME_BYTES) return this.#drop(link, CLOSE.tooBig, 'frame too big');
    const frame = parseFrame(data);
    if (!frame.ok) {
      this.host.log(`sync link to ${link.peer.name} closed: ${frame.error}`);
      return this.#drop(link, frame.error === 'frame too big' ? CLOSE.tooBig : CLOSE.badFrame, frame.error.slice(0, 100));
    }
    switch (frame.value.t) {
      case 'ping':
        sendText(link.ws, { t: 'pong' });
        break;
      case 'pong':
        break;
      case 'hello':
        this.#drop(link, CLOSE.badFrame, 'hello twice');
        break;
      case 'batch':
        this.host.onBatch?.(link.peer, frame.value);
        break;
    }
  }
}
