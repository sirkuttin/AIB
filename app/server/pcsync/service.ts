/**
 * Sync between PCs, slice V1: pairing your own AIB installs (Settings > Sync). Brave-sync-like: "Start a sync chain" on PC A opens
 * a pairing (six words, 5 minutes, once; remote/pairing.ts); on PC B you pick PC A from your Tailscale devices and type the words;
 * both show two check words; you click Approve on A. Then each side holds a peer record (pcsync/peers.ts) with one token per
 * direction. V2 adds the link: one authenticated WebSocket per peer at /pcsync/sync (pcsync/link.ts, frames.ts), dialed by both PCs,
 * reconnecting. Nothing else is shared yet: the listener answers pairing, hello, remove and that socket. Later slices add what travels
 * over the link.
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
import { type LinkHost, LinkManager, type LinkTimings } from './link.ts';
import { type ProjectLink, ProjectSync, type SourceProject } from './projects.ts';
import type { Area } from './frames.ts';
import { type DocsHooks, FileSync, type FileTimings } from './files.ts';
import { readRepoIdentity, type RepoIdentity } from './repo_id.ts';
import { notReady, peekWslHost } from '../wsl/access.ts';
import { wslDisk } from '../wsl/pcsync.ts';
import { localDisk } from './disk.ts';
import {
  otherAibListens,
  readSyncServe,
  shareSync,
  SYNC_HTTPS_PORT,
  type SyncServe,
  syncServeCommand,
  type TailnetPc,
  tailnetPcs,
} from './tailnet.ts';

export const PORT_FILE = 'pcsync-port.json';
const FIRST_PORT = 8800;
const SCAN = 100;
const MAX_BODY = 4096;

/** The request body as text, read at most `max` bytes: null when it is longer (the rest is never read). */
async function readLimited(request: Request, max: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) all.set(c, at), at += c.length;
  return new TextDecoder().decode(all);
}
const DIAL_MS = 8000;
const POLL_MS = 1500;
export const BUSY_TEXT = 'Sync runs in another AIB on this PC.';
const JOIN_SECONDS = 10 * 60;
const HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export interface PcSyncOptions {
  runner?: Runner;
  /** Tests: a fixed listener port (0 = the OS picks, not saved). */
  port?: number;
  /** Tests: where a peer's sync listener is dialed (default https://<host>:8444, which is Tailscale Serve). */
  peerUrl?: (host: string) => string;
  /** The wait for a busy pairing poll (tests make it short). */
  pollMs?: number;
  /** Link timings (tests make them short): ping, idle, backoff, Tailscale poll. */
  link?: Partial<LinkTimings>;
  /** This PC's projects (server.ts passes the page's list). Default: none. */
  projects?: () => SourceProject[];
  /** Tests: how a project's git remote is read (default: git here, or the WSL helper's `git.identity` for a WSL project). */
  identity?: (project: SourceProject) => Promise<RepoIdentity | null>;
  /** How long a read of the projects' remotes is trusted (ms). */
  projectsTtlMs?: number;
  /** Tests: the file engine's timings. */
  files?: Partial<FileTimings>;
  /** The docs store's hooks for the aib-docs sync (slice V5); without them docs are not synced. */
  docs?: DocsHooks;
  /** Device activity (slice V6): one call per received batch of files, for the activity line "ubuntu-pc synced 3 files to shop". */
  applied?: (peer: Peer, link: ProjectLink, area: Area, count: number) => void;
  /** Later slices: what a peer's batch frame goes to. */
  onBatch?: LinkHost['onBatch'];
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

/** A PC's name as the owner sees it: one line, no control characters. */
export function cleanPcName(value: unknown): string {
  const text = typeof value === 'string'
    ? [...value].map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c)).join('').replace(/\s+/g, ' ').trim()
    : '';
  return text.slice(0, 60) || 'Another PC';
}

/** A project's repo identity: git on this PC, or the WSL helper's for a WSL project (never starts a distro; null when it is off). */
export async function projectIdentity(project: SourceProject): Promise<RepoIdentity | null> {
  const wsl = project.wsl;
  if (!wsl) return await readRepoIdentity(project.path);
  const host = peekWslHost(wsl.distro);
  if (!host || notReady(host, wsl.distro)) return null;
  try {
    return await host.call('git.identity', { folder: wsl.linuxPath });
  } catch {
    return null;
  }
}

export class PcSync {
  readonly peers: PeerStore;
  readonly projects: ProjectSync;
  /** The aib-shared file engine (files.ts). */
  readonly files: FileSync;
  /** The aib-docs engine: the same engine on each project's aib-docs/ (docs only; the docs store writes what arrives). */
  readonly docsSync: FileSync;
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
  /** Wrong tokens in the last minute, per source (see #source): one program's guessing never locks the real peer out. */
  #failed = new Map<string, number[]>();
  #source = '';
  #server: Deno.HttpServer | null = null;
  #port = 0;
  problem = '';
  #closed = false;
  readonly gate: SyncGate;
  readonly links: LinkManager;

  constructor(readonly stateDir: string, readonly options: PcSyncOptions = {}) {
    this.peers = new PeerStore(stateDir);
    this.links = new LinkManager({
      peers: () => this.peers.list(),
      outToken: (peer) => this.peers.outToken(peer),
      own: () => (this.#ts?.name ? { host: this.#ts.name, name: this.#ts.machine } : null),
      url: (host) =>
        (this.options.peerUrl ? this.options.peerUrl(host) : `https://${host}:${SYNC_HTTPS_PORT}`).replace(/^http/i, 'ws') +
        '/pcsync/sync',
      authenticate: (token) => this.#checkToken(token),
      online: async () => new Map((await tailnetPcs(this.options.runner)).map((p) => [p.host, p.online])),
      touch: (peer) => this.peers.touch(peer.id),
      log: (message) => this.options.log?.(message),
      onUp: (peer) => {
        void this.projects.onUp(peer);
        this.files.onUp(peer);
        this.docsSync.onUp(peer);
      },
      onDown: (peer) => {
        this.files.onDown(peer);
        this.docsSync.onDown(peer);
      },
      onBatch: (peer, batch) => {
        this.projects.onBatch(peer, batch);
        this.files.onBatch(peer, batch);
        this.docsSync.onBatch(peer, batch);
        this.options.onBatch?.(peer, batch);
      },
    }, options.link);
    this.projects = new ProjectSync(stateDir, {
      list: () => this.options.projects?.() ?? [],
      identity: (project) => (this.options.identity ?? projectIdentity)(project),
      peers: () => this.peers.list(),
      own: () => (this.#ts?.name ? { host: this.#ts.name } : null),
      connected: (peerId) => this.links.state(peerId) === 'connected',
      send: (peerId, batch) => this.links.sendBatch(peerId, batch),
      log: (message) => this.options.log?.(message),
      ttlMs: options.projectsTtlMs,
      changed: () => {
        void this.files.refresh();
        void this.docsSync.refresh();
      },
      fileStatus: (sync, area) => (area === 'docs' ? this.docsSync : this.files).status(sync),
    });
    const engineDeps = {
      links: () => this.projects.confirmedLinks(),
      peers: () => this.peers.list(),
      connected: (peerId: string) => this.links.state(peerId) === 'connected',
      send: (peerId: string, batch: Parameters<LinkManager['sendBatch']>[1]) => this.links.sendBatch(peerId, batch),
      own: () => (this.#ts?.name ? { host: this.#ts.name, name: this.#ts.machine } : null),
      // a WSL project's files are read and written in its distro by the helper (wsl/pcsync.ts); every other project's on this PC
      disk: (link: ProjectLink, area: Area) => wslDisk(link.folder, area, link.sync) ?? localDisk(link.folder, area, link.sync),
      log: (message: string) => this.options.log?.(message),
      settled: () => this.projects.settled(),
      applied: (peer: Peer, link: ProjectLink, area: Area, count: number) => this.options.applied?.(peer, link, area, count),
    };
    this.files = new FileSync(stateDir, engineDeps, options.files);
    this.docsSync = new FileSync(stateDir, { ...engineDeps, docs: options.docs }, options.files, 'docs');
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
    this.#links();
  }

  /** The links run exactly while sync is on and this PC owns the listener (one owner per state folder). */
  #links(): void {
    if (this.peers.on && this.listening && !this.#closed) {
      this.links.start();
      this.links.ensure();
      this.files.start();
      this.docsSync.start();
    } else {
      this.links.stop();
      this.files.stop();
      this.docsSync.stop();
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#joinRun++;
    this.links.stop();
    this.files.stop();
    this.docsSync.stop();
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
    if (!this.#serve.shared && (await otherAibListens(this.#serve.other, this.#port))) {
      throw new PairingError(409, 'another_aib', `${BUSY_TEXT} Its share of https ${SYNC_HTTPS_PORT} is left as it is.`);
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
      }, (request, info) => this.#handle(request, info.remoteAddr?.hostname ?? ''));
      this.#server = server;
      this.#port = (server.addr as Deno.NetAddr).port;
      this.problem = '';
    } catch (error) {
      this.problem = /address already in use|AddrInUse|10048/i.test(String(error))
        ? BUSY_TEXT
        : `The sync listener could not start: ${error instanceof Error ? error.message : error}`;
    }
    await this.#read(0).catch(() => {});
    this.#links();
  }

  async #unlisten(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#port = 0;
    this.links.stop();
    this.files.stop();
    this.docsSync.stop();
    if (server) await server.shutdown().catch(() => {});
  }

  #json(status: number, body: Json): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  }

  async #handle(request: Request, remote = ''): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/pcsync/')) return this.#json(404, { error: 'Not found' });
    await this.#read().catch(() => {});
    const socketPath = url.pathname === '/pcsync/sync';
    const why = this.gate.check(request.headers, socketPath);
    if (why) return this.#json(SYNC_REASONS[why][0], { error: SYNC_REASONS[why][1], code: why });
    if (socketPath) return this.#socket(request);
    const login = (request.headers.get('Tailscale-User-Login') ?? '').trim();
    if (request.method !== 'POST') return this.#json(405, { error: 'POST only' });
    if (Number(request.headers.get('Content-Length') ?? '0') > MAX_BODY) return this.#json(413, { error: 'Too big' });
    // at most MAX_BODY bytes are read, whatever the headers say (a chunked body has no Content-Length)
    const text = await readLimited(request, MAX_BODY);
    if (text === null) return this.#json(413, { error: 'Too big' });
    // who is asking: the address Tailscale Serve saw (X-Forwarded-For), else the connection's own
    this.#source = (request.headers.get('X-Forwarded-For') ?? '').split(',')[0].trim().slice(0, 64) || remote || 'local';
    let body: Json;
    try {
      const parsed = JSON.parse(text);
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
          this.projects.dropPeer(peer.host);
          this.links.forget(peer.id);
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

  /** The sync WebSocket: only a GET upgrade; the token comes in the first frame (link.ts), so nothing is checked here beyond the gate. */
  #socket(request: Request): Response {
    if (request.method !== 'GET' || (request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
      return this.#json(426, { error: 'This address is a WebSocket for other AIB installs.', code: 'websocket_only' });
    }
    if (!this.links.canAccept()) return this.#json(503, { error: 'Sync is off or busy.', code: 'busy' });
    const { socket, response } = Deno.upgradeWebSocket(request, { idleTimeout: 0 });
    this.links.accept(socket);
    return response;
  }

  /**
   * The peer a token belongs to, 'many' after a flood of wrong ones from the same source (20 a minute; a few hundred a minute across
   * all sources), or null. A right token is never refused for someone else's guessing: it is checked first.
   */
  #checkToken(token: unknown): Peer | 'many' | null {
    const peer = this.peers.byToken(token);
    if (peer) return peer;
    const at = Date.now();
    const mine = (this.#failed.get(this.#source) ?? []).filter((t) => at - t < 60_000);
    let all = 0;
    for (const [key, list] of this.#failed) {
      const fresh = key === this.#source ? mine : list.filter((t) => at - t < 60_000);
      if (!fresh.length && key !== this.#source) this.#failed.delete(key);
      else all += fresh.length;
    }
    if (mine.length >= 20 || all >= 300) {
      this.#failed.set(this.#source, mine);
      return 'many';
    }
    mine.push(at);
    this.#failed.set(this.#source, mine);
    if (this.#failed.size > 500) this.#failed.delete(this.#failed.keys().next().value as string);
    return null;
  }

  /** The peer a body's token belongs to, or a refusal (failed tries are counted: a flood of wrong tokens is answered 429). */
  #authenticate(token: unknown): Peer | Response {
    const peer = this.#checkToken(token);
    if (peer === 'many') return this.#json(429, { error: 'Too many wrong tokens. Wait a minute.', code: 'too_many' });
    if (!peer) return this.#json(401, { error: 'This PC is not paired for sync.', code: 'not_paired' });
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
    this.links.ensure();
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
          this.#links();
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
    this.projects.dropPeer(peer.host);
    this.links.forget(peer.id);
    const token = this.peers.outToken(peer);
    let notified = false;
    if (token) {
      try {
        notified = (await this.#post(peer.host, '/pcsync/peer/remove', { token }, 4000)).status === 200;
      } catch { /* not reachable: the owner is told to remove it there too */ }
    }
    return { removed: true, notified, name: peer.name };
  }

  async setOn(on: boolean): Promise<void> {
    this.peers.setOn(on);
    if (on) {
      await this.#listen();
      this.#links();
    } else {
      this.cancelPairing();
      await this.#unlisten();
    }
  }

  // ---- the page's view ---------------------------------------------------------------------------------------------------------
  async view(): Promise<Json> {
    const ts = await this.#read(5000).catch(() => null);
    if (this.peers.on) await this.projects.refresh().catch(() => {});
    if (this.peers.on && this.#port && ts?.signedIn) this.#serve = await readSyncServe(ts.name, this.#port, this.options.runner);
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
      peers: this.peers.list().map((p) => ({
        ...publicPeer(p),
        reach: this.links.state(p.id) === 'connected' ? 'online' : this.links.state(p.id),
        projects: this.projects.view(p),
      })),
    };
  }

  /** The recent sync-bin entries of a project, both folders (aib-shared and aib-docs), newest first. */
  async binEntries(sync: string): Promise<unknown[]> {
    const all = [...await this.files.binEntries(sync), ...await this.docsSync.binEntries(sync)];
    return all.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, 40);
  }

  /** Restore one bin entry (the id says which folder it came from). */
  restoreBin(sync: string, entry: string): Promise<void> {
    return (/^\d{8}-\d{6}-docs\//.test(entry) ? this.docsSync : this.files).restore(sync, entry);
  }

  /** The sidebar marks' data (slice V6): the paired PCs with their projects' file states. Cheap: no Tailscale read, polled by the page. */
  marks(): Json {
    return {
      on: this.peers.on,
      peers: this.peers.list().map((p) => ({
        id: p.id,
        name: p.name,
        reach: this.links.state(p.id) === 'connected' ? 'online' : this.links.state(p.id),
        projects: this.projects.view(p),
      })),
    };
  }

  /** Test seam: the sha256 of a token, as the peer store keeps it. */
  static hash(token: string): string {
    return sha256Hex(token);
  }
}
