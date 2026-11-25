/**
 * The sync peers: your other AIB installs this one is paired with (sync between PCs, slice V1). Their own file,
 * <state>/pcsync/peers.json, never remote/devices.json: devices.ts loads any record that is not a "computer" as a phone with
 * phone.read, so a peer kept there would read every chat. A peer here gets no access to anything but the sync routes (pcsync/service.ts).
 *
 * Each pair has two random tokens, one per direction. The receiving side keeps only a SHA-256 hash of the token the peer presents
 * (`inHash`); the dialing side keeps the token it presents sealed (`out`: DPAPI on Windows, a plain data-folder file elsewhere,
 * the way other data-folder secrets are kept; state/sealed.ts).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import { forgetSealed, openText, sealOrPlain, wantsServiceMove } from '../state/sealed.ts';
import { randomToken, sha256Hex } from '../remote/words.ts';

export const PEERS_DIR = 'pcsync';
export const PEERS_FILE = 'peers.json';
export const MAX_PEERS = 8;

export interface Peer {
  id: string;
  /** What the owner sees: the other PC's name. */
  name: string;
  /** The other PC's tailnet name (where this PC dials it). */
  host: string;
  /** The Tailscale login both PCs were signed in with when they paired. */
  login: string;
  /** SHA-256 of the token the peer presents to this PC. */
  inHash: string;
  /** The token this PC presents to the peer, sealed. */
  out: string;
  created: number;
  lastSeen: number;
}

export interface PublicPeer {
  id: string;
  name: string;
  host: string;
  created: number;
  lastSeen: number;
}

export const publicPeer = (p: Peer): PublicPeer => ({ id: p.id, name: p.name, host: p.host, created: p.created, lastSeen: p.lastSeen });

const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');

export class PeerStore {
  readonly path: string;
  on = false;
  peers = new Map<string, Peer>();

  constructor(readonly stateDir: string, readonly clock: () => number = () => Date.now() / 1000) {
    this.path = inDir(inDir(stateDir, PEERS_DIR), PEERS_FILE);
    const [status, data] = readJsonFile(this.path);
    if (status !== 'ok' || !data || typeof data !== 'object') return;
    const d = data as { on?: unknown; peers?: unknown };
    this.on = d.on === true;
    for (const raw of Array.isArray(d.peers) ? d.peers : []) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const id = str(r.id, 40), inHash = str(r.inHash, 64), out = str(r.out, 2000);
      if (!id || !/^[0-9a-f]{64}$/.test(inHash) || !out) continue;
      this.peers.set(id, {
        id,
        name: str(r.name, 80),
        host: str(r.host),
        login: str(r.login),
        inHash,
        out,
        created: Number(r.created) || 0,
        lastSeen: Number(r.lastSeen) || 0,
      });
    }
    // Linux with a Secret Service: a token an older AIB left plain moves into it, and the file is rewritten without it. A store
    // that refuses leaves the token as it was (sealOrPlain hands back the plain text).
    let moved = false;
    for (const p of this.peers.values()) {
      if (!wantsServiceMove('pcsync-peer-token', p.out)) continue;
      const sealed = sealOrPlain('pcsync-peer-token', p.out);
      if (sealed !== p.out) {
        p.out = sealed;
        moved = true;
      }
    }
    if (moved) this.#save();
  }

  #save(): void {
    Deno.mkdirSync(inDir(this.stateDir, PEERS_DIR), { recursive: true });
    saveJson(this.path, { version: 1, on: this.on, peers: [...this.peers.values()] }, 'pcsync-peers-');
  }

  setOn(on: boolean): void {
    if (this.on === on) return;
    this.on = on;
    this.#save();
  }

  list(): Peer[] {
    return [...this.peers.values()];
  }

  /** A paired peer; `outToken` is the token this PC will present to it, `inToken` the one it will accept (only its hash is kept). */
  add(options: { name: string; host: string; login: string; inToken: string; outToken: string }): Peer {
    if (this.peers.size >= MAX_PEERS) throw new RangeError(`At most ${MAX_PEERS} PCs can be paired for sync`);
    // the same PC paired again replaces its old record (its old tokens stop working)
    for (const p of [...this.peers.values()]) {
      if (p.host !== options.host) continue;
      forgetSealed(p.out);
      this.peers.delete(p.id);
    }
    const peer: Peer = {
      id: randomToken(9),
      name: options.name,
      host: options.host,
      login: options.login,
      inHash: sha256Hex(options.inToken),
      out: sealOrPlain('pcsync-peer-token', options.outToken),
      created: this.clock(),
      lastSeen: 0,
    };
    this.peers.set(peer.id, peer);
    this.#save();
    return peer;
  }

  /** The peer a presented token belongs to (constant-time over the hashes), or null. */
  byToken(token: unknown): Peer | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const hash = createHash('sha256').update(token).digest();
    let found: Peer | null = null;
    for (const p of this.peers.values()) {
      if (timingSafeEqual(hash, Buffer.from(p.inHash, 'hex'))) found = p;
    }
    return found;
  }

  /** The token to present to a peer (null when it cannot be opened: another Windows user, a damaged value). */
  outToken(peer: Peer): string | null {
    return openText('pcsync-peer-token', peer.out);
  }

  touch(id: string): void {
    const p = this.peers.get(id);
    if (!p) return;
    const at = this.clock();
    if (at - p.lastSeen < 60) return;
    p.lastSeen = at;
    this.#save();
  }

  remove(id: string): Peer | null {
    const p = this.peers.get(id);
    if (!p) return null;
    forgetSealed(this.peers.get(id)?.out);
    this.peers.delete(id);
    this.#save();
    return p;
  }
}
