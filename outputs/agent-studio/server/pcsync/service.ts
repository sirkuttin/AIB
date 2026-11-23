/**
 * Sync between PCs, slice V1: pairing your own AIB installs (Settings > Sync). Brave-sync-like: "Start a sync chain" on PC A opens
 * a pairing (six words, 5 minutes, once; remote/pairing.ts); on PC B you pick PC A from your Tailscale devices and type the words;
 * both show two check words; you click Approve on A. Then each side holds a peer record (pcsync/peers.ts) with one token per
 * direction. Nothing else is shared yet: the listener answers only pairing, hello and remove. Later slices add the sync routes, which
 * a peer token alone may call.
 *
 * The listener is its own loopback port (saved in <state>/pcsync-port.json) that Tailscale Serve sends https 8444 to. It is open
 * only while sync is on. It is not the phone port: turning Phone access off does not stop it and a phone or computer token means
 * nothing on it, as a peer token means nothing on the phone port (peers are not in devices.json).
 */
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import { checkWords, parseCode, randomToken, sha256Hex } from '../remote/words.ts';
import { Pairing, PairingError } from '../remote/pairing.ts';
import { readTailscale, type Runner, type TailscaleState } from '../remote/tailscale.ts';
import { portFree } from '../remote/port.ts';
import { type Peer, PeerStore, type PublicPeer, publicPeer } from './peers.ts';
import { SYNC_REASONS, SyncGate } from './gate.ts';
import { readSyncServe, shareSync, SYNC_HTTPS_PORT, type SyncServe, syncServeCommand, type TailnetPc, tailnetPcs } from './tailnet.ts';

export const PORT_FILE = 'pcsync-port.json';
const FIRST_PORT = 8800;
const SCAN = 100;
const MAX_BODY = 4096;
const DIAL_MS = 8000;
const POLL_MS = 1500;
const JOIN_SECONDS = 10 * 60;
const REACH_MS = 15_000;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface PcSyncOptions {
  runner?: Runner;
  /** Tests: a fixed listener port (0 = the OS picks, not saved). */
  port?: number;
  /** Tests: where a peer's sync listener is dialed (default https://<host>:8444, which is Tailscale Serve). */
  peerUrl?: (host: string) => string;
  /** The wait for a busy pairing poll (tests make it short). */
  pollMs?: number;
  /** How long a peer's reachable / not reachable answer is kept before the next hello (tests make it short). */
  reachMs?: number;
  log?: (message: string) => void;
}

type Json = Record<string, unknown>;

interface Join {
  host: string;
  name: string;
  state: 'waiting' | 'approved' | 'rejected' | 'expired' | 'failed';
  checkWords: [string, string] | null;
  error: string;
  startedAt: number;
}

export interface Reach {
  state: 'online' | 'offline' | 'refused';
  at: number;
}

/** A PC's name as the owner sees it: one line, no control characters. */
export function cleanPcName(value: unknown): string {
  const text = typeof value === 'string'
    ? [...value].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim()
    : '';
  return text.slice(0, 60) || 'Another PC';
}

export class PcSync {
  readonly peers: PeerStore;
  readonly pairing = new Pairing(
    () => Date.now() / 1000,
    'On the first PC, click Start a sync chain again.',
    'That PC is no longer waiting. Start the sync chain again on the first PC.',
  );
  /** What a claim brought that Approve needs: the other PC's tailnet name and the token this PC will present to it. */
  #extras = new Map<string, { host: string; outToken: string }>();
  #join: Join | null = null;
  #joinRun = 0;
  #ts: TailscaleState | null = null;
  #tsAt = 0;
  #serve: SyncServe = { shared: false, other: '', funnel: false };
  #reach = new Map<string, Reach>();
  #pinging = false;
  #failed: number[] = [];
  #server: Deno.HttpServer | null = null;
  #port = 0;
  problem = '';
  #closed = false;
  readonly gate: SyncGate;

  constructor(readonly stateDir: string, readonly options: PcSyncOptions = {}) {
    this.peers = new PeerStore(stateDir);
    this.gate = new SyncGate(() => this.#ts?.name ?? '', () => this.#ts?.login ?? '');
  }

  get on(): boolean {
    return this.peers.on;
  }
  get listening(): boolean {
    return this.#server !== null;
  }
  get port(): number {
    return this.#port;
  }

  /** At startup: listen again when sync was on. */
  async start(): Promise<void> {
    if (this.peers.on) await this.#listen();
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#joinRun++;
    await this.#unlisten();
  }

  // ---- Tailscale ---------------------------------------------------------------------------------------------------------------
  async #read(maxAgeMs = 20_000): Promise<TailscaleState> {
    if (!this.#ts || Date.now() - this.#tsAt > maxAgeMs) {
      this.#ts = await readTailscale(0, this.options.runner);
      this.#tsAt = Date.now();
    }
    return this.#ts;
  }

  /** The tailnet PCs the owner can join (same Tailscale login), for "Join a sync chain". */
  async devices(): Promise<TailnetPc[]> {
    const paired = new Set(this.peers.list().map((p) => p.host));
    return (await tailnetPcs(this.options.runner)).filter((p) => !paired.has(p.host));
  }

  /** The owner clicked Share sync: AIB runs the one `tailscale serve` command it shows. */
  async share(): Promise<Json> {
    const ts = await this.#read(0);
    if (!ts.signedIn) throw new PairingError(409, 'no_tailscale', 'Tailscale is not running and signed in on this PC.');
    await this.#listen();
    if (!this.#port) throw new PairingError(409, 'not_listening', this.problem || 'The sync listener is not running.');
    this.#serve = await readSyncServe(ts.name, this.#port, this.options.runner);
    if (this.#serve.funnel) {
      throw new PairingError(409, 'funnel', `Funnel is on for https ${SYNC_HTTPS_PORT} of this PC. Turn it off first.`);
    }
    if (!this.#serve.shared && !(await shareSync(this.#port, this.options.runner))) {
      throw new PairingError(
        502,
        'share_failed',
        `Tailscale could not share the sync port. Run it yourself: ${syncServeCommand(this.#port)}`,
      );
    }
    this.#serve = await readSyncServe(ts.name, this.#port, this.options.runner);
    return { ok: true };
  }

  // ---- the listener ------------------------------------------------------------------------------------------------------------
  #choosePort(): number {
    if (this.options.port !== undefined) return this.options.port;
    const file = inDir(this.stateDir, PORT_FILE);
    const [status, data] = readJsonFile(file);
    const saved = status === 'ok' ? Number((data as { port?: unknown } | null)?.port) : 0;
    if (Number.isInteger(saved) && saved > 0 && saved < 65536) return saved;
    for (let port = FIRST_PORT; port < FIRST_PORT + SCAN; port++) {
      if (!portFree(port)) continue;
      saveJson(file, { version: 1, port }, 'pcsync-port-');
      return port;
    }
    return 0;
  }

  async #listen(): Promise<void> {
    if (this.#server || this.#closed) return;
    try {
      const server = Deno.serve({
        hostname: '127.0.0.1',
        port: this.#choosePort(),
        onListen: () => {},
        onError: () => new Response('error', { status: 500 }),
      }, (request) => this.#handle(request));
      this.#server = server;
      this.#port = (server.addr as Deno.NetAddr).port;
      this.problem = '';
    } catch (error) {
      this.problem = /address already in use|AddrInUse|10048/i.test(String(error))
        ? 'The sync port is busy. Another AIB on this PC may be running sync.'
        : `The sync listener could not start: ${error instanceof Error ? error.message : error}`;
    }
    await this.#read(0).catch(() => {});
  }

  async #unlisten(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    if (server) await server.shutdown().catch(() => {});
  }

  #json(status: number, body: Json): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/pcsync/')) return this.#json(404, { error: 'Not found' });
    await this.#read().catch(() => {});
    const why = this.gate.check(request.headers);
    if (why) return this.#json(SYNC_REASONS[why][0], { error: SYNC_REASONS[why][1], code: why });
    const login = (request.headers.get('Tailscale-User-Login') ?? '').trim();
    if (request.method !== 'POST') return this.#json(405, { error: 'POST only' });
    if (Number(request.headers.get('Content-Length') ?? '0') > MAX_BODY) return this.#json(413, { error: 'Too big' });
    const text = (await request.text()).slice(0, MAX_BODY + 1);
    let body: Json;
    try {
      const parsed = text.length > MAX_BODY ? null : JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shape');
      body = parsed as Json;
    } catch {
      return this.#json(400, { error: 'Invalid request' });
    }
    try {
      switch (url.pathname) {
        case '/pcsync/pair/claim':
          return this.#claim(body, login);
        case '/pcsync/pair/status':
          return this.#status(body, login);
        case '/pcsync/hello':
        case '/pcsync/peer/remove': {
          const peer = this.#authenticate(body.token);
          if (peer instanceof Response) return peer;
          if (url.pathname === '/pcsync/hello') {
            this.peers.touch(peer.id);
            return this.#json(200, { ok: true, name: this.#ts?.machine ?? '' });
          }
          this.peers.remove(peer.id);
          this.#reach.delete(peer.id);
          return this.#json(200, { ok: true });
        }
        default:
          return this.#json(404, { error: 'Not found' });
      }
    } catch (error) {
      if (error instanceof PairingError) return this.#json(error.status, { error: error.message, code: error.code });
      throw error;
    }
  }

  /** The peer a body's token belongs to, or a refusal (failed tries are counted: a flood of wrong tokens is answered 429). */
  #authenticate(token: unknown): Peer | Response {
    const at = Date.now();
    this.#failed = this.#failed.filter((t) => at - t < 60_000);
    if (this.#failed.length >= 20) return this.#json(429, { error: 'Too many wrong tokens. Wait a minute.', code: 'too_many' });
    const peer = this.peers.byToken(token);
    if (!peer) {
      this.#failed.push(at);
      return this.#json(401, { error: 'This PC is not paired for sync.', code: 'not_paired' });
    }
    return peer;
  }

  #claim(body: Json, login: string): Response {
    const host = typeof body.host === 'string' ? body.host.trim().toLowerCase() : '';
    const token = typeof body.token === 'string' ? body.token : '';
    const name = cleanPcName(body.name);
    const sameTailnet = host.endsWith('.' + (this.#ts?.tailnet ?? '\u0000'));
    // the pairing code is checked first (and counted); the address and token are taken only with a right code
    const { claim, claimSecret } = this.pairing.claim({ code: body.code, name, login, phoneNonce: body.nonce });
    if (!HOST.test(host) || !sameTailnet || !/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
      this.pairing.claims.delete(claim.id);
      throw new PairingError(400, 'bad_request', 'The other PC sent an incomplete request. Try again.');
    }
    this.#extras.set(claim.id, { host, outToken: token });
    return this.#json(200, {
      claim: claim.id,
      claimSecret,
      pcNonce: claim.pcNonce,
      checkWords: claim.checkWords,
      pcName: this.#ts?.machine ?? '',
    });
  }

  #status(body: Json, login: string): Response {
    const claim = this.pairing.status(body.claim, body.claimSecret);
    if (!claim || claim.login !== login) {
      return this.#json(404, { error: 'This pairing is no longer open. Start again.', code: 'no_claim' });
    }
    if (claim.state === 'pending') return this.#json(200, { state: 'pending' });
    this.#extras.delete(claim.id);
    if (claim.state === 'rejected') return this.#json(200, { state: 'rejected' });
    return this.#json(200, { state: 'approved', token: claim.handover!.token, host: this.#ts?.name ?? '' });
  }

  // ---- PC A: start a chain, approve --------------------------------------------------------------------------------------------
  async startChain(): Promise<Json> {
    const ts = await this.#read(0);
    if (!ts.signedIn) throw new PairingError(409, 'no_tailscale', 'Tailscale is not running and signed in on this PC.');
    this.peers.setOn(true);
    await this.#listen();
    if (!this.listening) throw new PairingError(409, 'not_listening', this.problem || 'The sync listener is not running.');
    const code = this.pairing.start();
    this.#extras.clear();
    return { words: code.words, expiresAt: code.expiresAt };
  }

  cancelPairing(): void {
    this.pairing.cancel();
    this.#extras.clear();
    this.#joinRun++;
    this.#join = null;
  }

  approve(id: unknown): PublicPeer {
    const claim = this.pairing.get(id);
    const extra = claim ? this.#extras.get(claim.id) : undefined;
    if (!claim || !extra) throw new PairingError(404, 'no_claim', 'That PC is no longer waiting. Start the sync chain again.');
    const inToken = randomToken();
    const peer = this.peers.add({ name: claim.name, host: extra.host, login: claim.login, inToken, outToken: extra.outToken });
    this.pairing.approve(claim.id, { token: inToken, cookie: '', device: { id: peer.id, name: peer.name, scopes: [] } });
    this.#extras.delete(claim.id);
    return publicPeer(peer);
  }

  reject(id: unknown): boolean {
    const claim = this.pairing.reject(id);
    if (claim) this.#extras.delete(claim.id);
    return !!claim;
  }

  // ---- PC B: join --------------------------------------------------------------------------------------------------------------
  async #post(host: string, path: string, body: Json, ms = DIAL_MS): Promise<{ status: number; json: Json }> {
    const base = this.options.peerUrl ? this.options.peerUrl(host) : `https://${host}:${SYNC_HTTPS_PORT}`;
    const response = await fetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    });
    let json: Json = {};
    try {
      json = await response.json();
    } catch { /* no body */ }
    return { status: response.status, json };
  }

  async join(hostValue: unknown, code: unknown): Promise<Json> {
    const ts = await this.#read(0);
    if (!ts.signedIn) throw new PairingError(409, 'no_tailscale', 'Tailscale is not running and signed in on this PC.');
    const host = typeof hostValue === 'string' ? hostValue.trim().toLowerCase() : '';
    const pc = (await tailnetPcs(this.options.runner)).find((p) => p.host === host);
    if (!pc) throw new PairingError(404, 'no_such_pc', 'That PC is not on your Tailscale devices. Pick one from the list.');
    const secret = parseCode(code);
    if (!secret) throw new PairingError(400, 'bad_code', 'Type the six words shown on the first PC.');
    this.peers.setOn(true);
    await this.#listen();
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const token = randomToken(); // what the first PC will present to this one: only its hash is kept here
    let reply: { status: number; json: Json };
    try {
      reply = await this.#post(pc.host, '/pcsync/pair/claim', { code, name: ts.machine, nonce, host: ts.name, token });
    } catch {
      throw new PairingError(
        502,
        'unreachable',
        `${pc.name} did not answer. Is AIB running there, with sync shared on Tailscale (Share sync)?`,
      );
    }
    if (reply.status !== 200) {
      throw new PairingError(
        reply.status >= 400 && reply.status < 600 ? reply.status : 502,
        String(reply.json.code ?? 'refused'),
        String(reply.json.error ?? `${pc.name} refused the code.`),
      );
    }
    const words = reply.json.checkWords;
    const mine = checkWords(secret, nonce, String(reply.json.pcNonce ?? ''));
    if (!Array.isArray(words) || words[0] !== mine[0] || words[1] !== mine[1]) {
      throw new PairingError(
        409,
        'check_failed',
        'The check words do not match, so this is not the PC that showed the code. Nothing was paired.',
      );
    }
    const run = ++this.#joinRun;
    this.#join = { host: pc.host, name: pc.name, state: 'waiting', checkWords: mine, error: '', startedAt: Date.now() };
    void this.#poll(
      run,
      pc,
      String(reply.json.claim),
      String(reply.json.claimSecret),
      token,
      cleanPcName(reply.json.pcName || pc.name),
      ts.login,
    );
    return { ok: true, checkWords: mine, pcName: pc.name };
  }

  async #poll(run: number, pc: TailnetPc, claim: string, claimSecret: string, inToken: string, name: string, login: string): Promise<void> {
    const end = (state: Join['state'], error = '') => {
      if (this.#joinRun === run && this.#join) Object.assign(this.#join, { state, error });
    };
    const wait = this.options.pollMs ?? POLL_MS;
    while (this.#joinRun === run && !this.#closed) {
      if (Date.now() - this.#join!.startedAt > JOIN_SECONDS * 1000) return end('expired', 'Nobody approved it in time. Start again.');
      try {
        const { status, json } = await this.#post(pc.host, '/pcsync/pair/status', { claim, claimSecret });
        if (status === 404) return end('expired', 'The first PC no longer has this pairing open.');
        if (status === 200 && json.state === 'rejected') return end('rejected', `${pc.name} did not approve it.`);
        if (status === 200 && json.state === 'approved' && typeof json.token === 'string') {
          if (this.#joinRun !== run) return;
          this.peers.add({ name, host: pc.host, login, inToken, outToken: json.token });
          this.#reach.set(this.peers.list().at(-1)!.id, { state: 'online', at: Date.now() });
          return end('approved');
        }
      } catch { /* not answering this second: keep trying until the time is up */ }
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  // ---- peers -------------------------------------------------------------------------------------------------------------------
  /** Remove a peer: its token stops working here at once; the other PC is told when it answers (it then drops this PC too). */
  async remove(id: unknown): Promise<{ removed: boolean; notified: boolean; name: string }> {
    const peer = typeof id === 'string' ? this.peers.remove(id) : null;
    if (!peer) return { removed: false, notified: false, name: '' };
    this.#reach.delete(peer.id);
    const token = this.peers.outToken(peer);
    let notified = false;
    if (token) {
      try {
        notified = (await this.#post(peer.host, '/pcsync/peer/remove', { token }, 4000)).status === 200;
      } catch { /* not reachable: the owner is told to remove it there too */ }
    }
    return { removed: true, notified, name: peer.name };
  }

  /** Ask each peer hello with this PC's token: online, offline, or refused (it no longer trusts this PC). */
  async #pingAll(): Promise<void> {
    if (this.#pinging) return;
    this.#pinging = true;
    try {
      await Promise.all(
        this.peers.list().map(async (peer) => {
          const token = this.peers.outToken(peer);
          let state: Reach['state'] = 'offline';
          if (token) {
            try {
              const { status } = await this.#post(peer.host, '/pcsync/hello', { token }, 4000);
              state = status === 200 ? 'online' : status === 401 ? 'refused' : 'offline';
            } catch { /* offline */ }
          }
          this.#reach.set(peer.id, { state, at: Date.now() });
        }),
      );
    } finally {
      this.#pinging = false;
    }
  }

  async setOn(on: boolean): Promise<void> {
    this.peers.setOn(on);
    if (on) {
      await this.#listen();
    } else {
      this.cancelPairing();
      await this.#unlisten();
    }
  }

  // ---- the page's view ---------------------------------------------------------------------------------------------------------
  async view(): Promise<Json> {
    const ts = await this.#read(5000).catch(() => null);
    if (this.peers.on && this.#port && ts?.signedIn) this.#serve = await readSyncServe(ts.name, this.#port, this.options.runner);
    if (this.peers.list().some((p) => Date.now() - (this.#reach.get(p.id)?.at ?? 0) > (this.options.reachMs ?? REACH_MS))) {
      void this.#pingAll();
    }
    const code = this.pairing.open();
    const pending = this.pairing.pending().filter((c) => this.#extras.has(c.id)).map((c) => ({
      id: c.id,
      name: c.name,
      host: this.#extras.get(c.id)!.host,
      checkWords: c.checkWords,
    }));
    return {
      on: this.peers.on,
      listening: this.listening,
      problem: this.problem,
      pc: { name: ts?.machine ?? '', signedIn: !!ts?.signedIn, problem: ts?.problem ?? '' },
      serve: { ...this.#serve, command: this.#port ? syncServeCommand(this.#port) : '' },
      pairing: code || pending.length
        ? { words: code?.words ?? [], expiresAt: code?.expiresAt ?? 0, pending, anotherTried: !!this.pairing.code?.anotherTried }
        : null,
      join: this.#join ? { ...this.#join } : null,
      peers: this.peers.list().map((p) => ({ ...publicPeer(p), reach: this.#reach.get(p.id)?.state ?? 'unknown' })),
    };
  }

  /** Test seam: the sha256 of a token, as the peer store keeps it. */
  static hash(token: string): string {
    return sha256Hex(token);
  }
}
