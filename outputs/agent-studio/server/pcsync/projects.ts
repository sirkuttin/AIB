/**
 * Which project here is which project on the other PC (sync between PCs, slice V3). Matching only: no file moves yet.
 *
 * Each PC offers its projects over the link as `project.offer` items: a name, the normalized git remote, the project's place in its
 * repo and whether it is a WSL project, under an opaque offer id (random per run). A folder path never leaves the PC. A link is
 * agreed with a random project sync id that both PCs store; the receiver finds its own folder only through its own offer ids and its
 * own table (<state>/pcsync/projects.json), never from anything a frame says.
 *   - Same normalized remote and same place in the repo: linked automatically. The PC whose tailnet name sorts lower makes the id
 *     and proposes (both PCs apply the same rule to the same two names), the other checks the match itself before it agrees.
 *   - Same folder name only: listed as a suggestion for "Link to…", never automatic.
 *   - Link to… by hand: one PC proposes, the other shows it as "needs your OK" (an unconfirmed link) until its owner confirms.
 * Docs and aib-shared are two switches per link, off by default, saved here per PC. Nothing reads them yet (the file engine, V4).
 * Unlink removes the link on both PCs; when the other PC is off, the unlink is kept and sent when it is back.
 */
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import { randomToken } from '../remote/words.ts';
import { PairingError } from '../remote/pairing.ts';
import * as osp from '../platform/ospath.ts';
import { type BatchItem, nameOk, placeOk, REMOTE } from './frames.ts';
import { normalizeRemote, type RepoIdentity } from './repo_id.ts';
import type { Peer } from './peers.ts';

export const PROJECTS_FILE = 'projects.json';
const MAX_OFFERS = 500;
const CHUNK = 100;
const MAX_LINKS = 2000;
const SYNC_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** A project of this PC as the page's list holds it. */
export interface SourceProject {
  path: string;
  wsl?: { distro: string; linuxPath: string };
}

export interface Offer {
  oid: string;
  name: string;
  remote: string | null;
  prefix: string;
  wsl: boolean;
}
interface Local extends Offer {
  path: string;
}

export interface ProjectLink {
  sync: string;
  /** The other PC's tailnet name. */
  peer: string;
  /** This PC's project (the page's key for it). Never sent. */
  folder: string;
  name: string;
  other: { name: string; remote: string | null; prefix: string };
  how: 'remote' | 'manual';
  /** false: the other PC proposed it by hand and this PC's owner has not said yes. Nothing may use an unconfirmed link. */
  confirmed: boolean;
  docs: boolean;
  shared: boolean;
  created: number;
}

export interface ProjectDeps {
  list(): SourceProject[];
  identity(project: SourceProject): Promise<RepoIdentity | null>;
  peers(): Peer[];
  own(): { host: string } | null;
  connected(peerId: string): boolean;
  send(peerId: string, batch: { id: string; project?: string; items: BatchItem[] }): boolean;
  log(message: string): void;
  ttlMs?: number;
}

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const clean = (name: string) => [...name].map((c) => (c < ' ' || c === '\x7f' || c === '/' || c === '\\' ? '_' : c)).join('').slice(0, 80);
const batchId = () => randomToken(9);

export class ProjectSync {
  readonly path: string;
  #links = new Map<string, ProjectLink>();
  /** peer host -> sync ids to tell it about when it is back. */
  #unlinks = new Map<string, Set<string>>();
  #local: Local[] = [];
  #oids = new Map<string, string>();
  #at = 0;
  #sig = '';
  #running: Promise<void> | null = null;
  #theirs = new Map<string, { offers: Map<string, Offer>; complete: boolean }>();
  #queue: Promise<void> = Promise.resolve();

  constructor(readonly stateDir: string, readonly deps: ProjectDeps) {
    this.path = inDir(inDir(stateDir, 'pcsync'), PROJECTS_FILE);
    const [status, data] = readJsonFile(this.path);
    if (status !== 'ok' || !data || typeof data !== 'object') return;
    const d = data as { links?: unknown; unlinks?: unknown };
    for (const raw of Array.isArray(d.links) ? d.links.slice(0, MAX_LINKS) : []) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const o = (r.other && typeof r.other === 'object' ? r.other : {}) as Record<string, unknown>;
      const sync = str(r.sync, 64), peer = str(r.peer, 253), folder = str(r.folder, 1100);
      if (!SYNC_ID.test(sync) || !peer || !folder) continue;
      this.#links.set(sync, {
        sync,
        peer,
        folder,
        name: str(r.name, 80),
        other: { name: str(o.name, 80), remote: typeof o.remote === 'string' ? o.remote.slice(0, 300) : null, prefix: str(o.prefix) },
        how: r.how === 'manual' ? 'manual' : 'remote',
        confirmed: r.confirmed !== false,
        docs: r.docs === true,
        shared: r.shared === true,
        created: Number(r.created) || 0,
      });
    }
    if (d.unlinks && typeof d.unlinks === 'object') {
      for (const [host, ids] of Object.entries(d.unlinks as Record<string, unknown>)) {
        const set = new Set((Array.isArray(ids) ? ids : []).filter((i): i is string => typeof i === 'string' && SYNC_ID.test(i)));
        if (set.size) this.#unlinks.set(host, set);
      }
    }
  }

  #save(): void {
    Deno.mkdirSync(inDir(this.stateDir, 'pcsync'), { recursive: true });
    const unlinks: Record<string, string[]> = {};
    for (const [host, ids] of this.#unlinks) unlinks[host] = [...ids];
    saveJson(this.path, { version: 1, links: [...this.#links.values()], unlinks }, 'pcsync-projects-');
  }

  /** The links as the other slices read them (V4: the file engine). Confirmed links only, with this PC's own folder. */
  confirmedLinks(): ProjectLink[] {
    return [...this.#links.values()].filter((l) => l.confirmed);
  }

  link(sync: string): ProjectLink | null {
    return this.#links.get(sync) ?? null;
  }

  // ---- this PC's projects ------------------------------------------------------------------------------------------------------
  #oidOf(path: string): string {
    let oid = this.#oids.get(path);
    if (!oid) {
      oid = randomToken(9);
      this.#oids.set(path, oid);
    }
    return oid;
  }

  /** Read every project's identity again (at most every ttlMs unless forced); new offers go to the connected peers. */
  refresh(force = false): Promise<void> {
    if (this.#running) return this.#running;
    const ttl = this.deps.ttlMs ?? 30_000;
    if (!force && Date.now() - this.#at < ttl) return Promise.resolve();
    this.#running = this.#read().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #read(): Promise<void> {
    const known = new Map(this.#local.map((l) => [l.path, l]));
    const local: Local[] = [];
    for (const project of this.deps.list().slice(0, MAX_OFFERS)) {
      const name = clean(project.wsl ? osp.basename(project.wsl.linuxPath.replace(/\/+$/, '')) : osp.basename(project.path));
      if (!name || !nameOk(name)) continue;
      let identity: RepoIdentity | null = null;
      try {
        identity = await this.deps.identity(project);
      } catch { /* unreadable now */ }
      const before = known.get(project.path);
      // an unknown answer (a WSL distro that is off) keeps the last one
      const remote = identity ? normalizeRemote(identity.url) : before?.remote ?? null;
      const prefix = identity ? identity.prefix : before?.prefix ?? '';
      local.push({
        oid: this.#oidOf(project.path),
        path: project.path,
        name,
        remote: remote && REMOTE.test(remote) ? remote : null,
        prefix: placeOk(prefix) ? prefix : '',
        wsl: !!project.wsl,
      });
    }
    this.#at = Date.now();
    this.#local = local;
    const sig = JSON.stringify(local.map((l) => [l.oid, l.name, l.remote, l.prefix, l.wsl]));
    if (sig === this.#sig) return;
    this.#sig = sig;
    for (const peer of this.deps.peers()) {
      if (!this.deps.connected(peer.id)) continue;
      this.#sendOffers(peer);
      void this.#autoMatch(peer);
    }
  }

  // ---- talking to a peer -------------------------------------------------------------------------------------------------------
  #sendOffers(peer: Peer): void {
    const items: BatchItem[] = this.#local.map((l) => ({
      op: 'project.offer',
      id: l.oid,
      name: l.name,
      remote: l.remote,
      prefix: l.prefix,
      wsl: l.wsl,
    }));
    const batches: BatchItem[][] = [];
    for (let i = 0; i < items.length; i += CHUNK) batches.push(items.slice(i, i + CHUNK));
    if (!batches.length) batches.push([]);
    batches[0].unshift({ op: 'project.begin' });
    batches[batches.length - 1].push({ op: 'project.end' });
    for (const batch of batches) this.deps.send(peer.id, { id: batchId(), items: batch });
  }

  /** A link to a peer came up: send this PC's offers and the unlinks that were waiting for it. */
  async onUp(peer: Peer): Promise<void> {
    this.#theirs.delete(peer.host);
    await this.refresh(true).catch(() => {});
    this.#sendOffers(peer);
    const waiting = this.#unlinks.get(peer.host);
    if (waiting) {
      for (const sync of [...waiting]) {
        if (this.deps.send(peer.id, { id: batchId(), project: sync, items: [{ op: 'project.unlink' }] })) waiting.delete(sync);
      }
      if (!waiting.size) this.#unlinks.delete(peer.host);
      this.#save();
    }
  }

  /** A batch from a peer (the link already checked its shape). Handled one at a time, in order. */
  onBatch(peer: Peer, batch: { id: string; project?: string; items: BatchItem[] }): void {
    if (!batch.items.some((i) => i.op.startsWith('project.'))) return;
    this.#queue = this.#queue.then(() => this.#handle(peer, batch)).catch((e) => this.deps.log(`project matching: ${e}`));
  }

  async #handle(peer: Peer, batch: { id: string; project?: string; items: BatchItem[] }): Promise<void> {
    for (const item of batch.items) {
      switch (item.op) {
        case 'project.begin':
          this.#theirs.set(peer.host, { offers: new Map(), complete: false });
          break;
        case 'project.offer': {
          const state = this.#theirs.get(peer.host) ?? { offers: new Map<string, Offer>(), complete: false };
          this.#theirs.set(peer.host, state);
          if (state.offers.size < MAX_OFFERS) {
            state.offers.set(String(item.id), {
              oid: String(item.id),
              name: String(item.name),
              remote: typeof item.remote === 'string' ? item.remote : null,
              prefix: String(item.prefix),
              wsl: item.wsl === true,
            });
          }
          break;
        }
        case 'project.end': {
          const state = this.#theirs.get(peer.host);
          if (state) state.complete = true;
          await this.#autoMatch(peer);
          break;
        }
        case 'project.link':
          await this.#onLink(peer, batch.project, item);
          break;
        case 'project.unlink': {
          const link = batch.project ? this.#links.get(batch.project) : undefined;
          if (link && link.peer === peer.host) {
            this.#links.delete(link.sync);
            this.#save();
            this.deps.log(`${peer.name} unlinked ${link.name}`);
          }
          break;
        }
      }
    }
  }

  // ---- matching ----------------------------------------------------------------------------------------------------------------
  #localLinked(path: string, host: string): boolean {
    for (const l of this.#links.values()) if (l.peer === host && l.folder === path) return true;
    return false;
  }
  #offerLinked(host: string, o: Offer): boolean {
    for (const l of this.#links.values()) {
      if (l.peer === host && l.other.name === o.name && l.other.remote === o.remote && l.other.prefix === o.prefix) return true;
    }
    return false;
  }
  #sameRepo(l: Local, o: Offer): boolean {
    return !!l.remote && l.remote === o.remote && l.prefix === o.prefix;
  }

  /** The PC whose tailnet name sorts lower proposes the links that match by remote. */
  async #autoMatch(peer: Peer): Promise<void> {
    const own = this.deps.own();
    const state = this.#theirs.get(peer.host);
    if (!own || !state?.complete || own.host >= peer.host || !this.deps.connected(peer.id)) return;
    await this.refresh();
    for (const l of this.#local) {
      if (!l.remote || this.#localLinked(l.path, peer.host)) continue;
      const offer = [...state.offers.values()].find((o) => this.#sameRepo(l, o) && !this.#offerLinked(peer.host, o));
      if (!offer) continue;
      if (this.#links.size >= MAX_LINKS) return;
      const link = this.#add(peer, l, offer, 'remote', true);
      const sent = this.deps.send(peer.id, {
        id: batchId(),
        project: link.sync,
        items: [{ op: 'project.link', mine: l.oid, theirs: offer.oid, how: 'remote' }],
      });
      if (!sent) {
        this.#links.delete(link.sync);
        this.#save();
      }
    }
  }

  #add(peer: Peer, l: Local, offer: Offer, how: 'remote' | 'manual', confirmed: boolean, sync = randomToken(12)): ProjectLink {
    const link: ProjectLink = {
      sync,
      peer: peer.host,
      folder: l.path,
      name: l.name,
      other: { name: offer.name, remote: offer.remote, prefix: offer.prefix },
      how,
      confirmed,
      docs: false,
      shared: false,
      created: Date.now() / 1000,
    };
    this.#links.set(sync, link);
    this.#save();
    this.deps.log(`linked ${l.name} with ${offer.name} on ${peer.name} (${how})`);
    return link;
  }

  async #onLink(peer: Peer, sync: string | undefined, item: BatchItem): Promise<void> {
    const refuse = () => this.deps.send(peer.id, { id: batchId(), project: sync, items: [{ op: 'project.unlink' }] });
    if (!sync || !SYNC_ID.test(sync)) return;
    const existing = this.#links.get(sync);
    if (existing) {
      if (existing.peer !== peer.host) refuse();
      return;
    }
    await this.refresh();
    const local = this.#local.find((l) => l.oid === item.theirs);
    const offer = this.#theirs.get(peer.host)?.offers.get(String(item.mine));
    if (!local || !offer || this.#localLinked(local.path, peer.host) || this.#offerLinked(peer.host, offer)) return void refuse();
    const same = this.#sameRepo(local, offer);
    if (item.how === 'remote' && !same) return void refuse(); // this PC does not see the match the other one claims
    if (this.#links.size >= MAX_LINKS) return void refuse();
    this.#add(peer, local, offer, item.how === 'manual' ? 'manual' : 'remote', same, sync);
  }

  // ---- the owner's actions -----------------------------------------------------------------------------------------------------
  /** "Link to…": link one of this PC's unlinked projects with one of the peer's by hand. */
  async linkByHand(peerId: unknown, mine: unknown, theirs: unknown): Promise<ProjectLink> {
    const peer = this.deps.peers().find((p) => p.id === peerId);
    if (!peer) throw new PairingError(404, 'no_peer', 'That PC is not paired.');
    const state = this.#theirs.get(peer.host);
    if (!this.deps.connected(peer.id) || !state?.complete) {
      throw new PairingError(409, 'not_connected', `${peer.name} is not connected. Link when it is.`);
    }
    await this.refresh();
    const local = this.#local.find((l) => l.oid === mine);
    const offer = typeof theirs === 'string' ? state.offers.get(theirs) : undefined;
    if (!local || !offer) throw new PairingError(404, 'no_project', 'One of the two projects is no longer listed. Try again.');
    if (this.#localLinked(local.path, peer.host) || this.#offerLinked(peer.host, offer)) {
      throw new PairingError(409, 'already_linked', 'One of the two projects is already linked.');
    }
    if (this.#links.size >= MAX_LINKS) throw new PairingError(409, 'too_many', 'Too many linked projects.');
    const link = this.#add(peer, local, offer, 'manual', true);
    const sent = this.deps.send(peer.id, {
      id: batchId(),
      project: link.sync,
      items: [{ op: 'project.link', mine: local.oid, theirs: offer.oid, how: 'manual' }],
    });
    if (!sent) {
      this.#links.delete(link.sync);
      this.#save();
      throw new PairingError(409, 'not_connected', `${peer.name} is not connected. Link when it is.`);
    }
    return link;
  }

  /** The owner says yes to a link the other PC proposed by hand. */
  confirm(sync: unknown): ProjectLink {
    const link = typeof sync === 'string' ? this.#links.get(sync) : undefined;
    if (!link) throw new PairingError(404, 'no_link', 'That link is gone.');
    if (!link.confirmed) {
      link.confirmed = true;
      this.#save();
    }
    return link;
  }

  /** Unlink here and on the other PC (told now, or when it is back). */
  unlink(sync: unknown): boolean {
    const link = typeof sync === 'string' ? this.#links.get(sync) : undefined;
    if (!link) return false;
    this.#links.delete(link.sync);
    const peer = this.deps.peers().find((p) => p.host === link.peer);
    const sent = !!peer && this.deps.connected(peer.id) &&
      this.deps.send(peer.id, { id: batchId(), project: link.sync, items: [{ op: 'project.unlink' }] });
    if (!sent) {
      const set = this.#unlinks.get(link.peer) ?? new Set<string>();
      set.add(link.sync);
      this.#unlinks.set(link.peer, set);
    }
    this.#save();
    return true;
  }

  setSwitch(sync: unknown, which: unknown, on: unknown): ProjectLink {
    const link = typeof sync === 'string' ? this.#links.get(sync) : undefined;
    if (!link) throw new PairingError(404, 'no_link', 'That link is gone.');
    if (which !== 'docs' && which !== 'shared') throw new PairingError(400, 'bad_switch', 'Docs or aib-shared.');
    if (typeof on !== 'boolean') throw new PairingError(400, 'bad_switch', 'on must be true or false.');
    if (!link.confirmed) throw new PairingError(409, 'not_confirmed', 'Confirm the link first.');
    if (link[which] !== on) {
      link[which] = on;
      this.#save();
    }
    return link;
  }

  /** A removed peer takes its links and waiting unlinks with it. */
  dropPeer(host: string): void {
    let changed = this.#unlinks.delete(host);
    for (const l of [...this.#links.values()]) {
      if (l.peer === host) {
        this.#links.delete(l.sync);
        changed = true;
      }
    }
    this.#theirs.delete(host);
    if (changed) this.#save();
  }

  // ---- what the card shows -----------------------------------------------------------------------------------------------------
  view(peer: Peer): Record<string, unknown> {
    const here = new Set(this.#local.map((l) => l.path));
    const links = [...this.#links.values()].filter((l) => l.peer === peer.host).map((l) => ({
      sync: l.sync,
      name: l.name,
      otherName: l.other.name,
      how: l.how,
      confirmed: l.confirmed,
      docs: l.docs,
      shared: l.shared,
      missing: !here.has(l.folder),
    }));
    const state = this.#theirs.get(peer.host);
    const mine = this.#local.filter((l) => !this.#localLinked(l.path, peer.host));
    const theirs = state?.complete ? [...state.offers.values()].filter((o) => !this.#offerLinked(peer.host, o)) : [];
    const suggestions: { mine: string; theirs: string; name: string }[] = [];
    for (const l of mine) {
      for (const o of theirs) {
        if (l.name.toLowerCase() === o.name.toLowerCase() && !this.#sameRepo(l, o)) suggestions.push({ mine: l.oid, theirs: o.oid, name: l.name });
      }
    }
    return {
      links,
      known: !!state?.complete,
      mine: mine.map((l) => ({ oid: l.oid, name: l.name })),
      theirs: theirs.map((o) => ({ oid: o.oid, name: o.name })),
      suggestions,
    };
  }
}

/** The page's list of this PC's projects, as the project sync wants it (folders that are gone from the disk are left out). */
export function sourceProjects(
  added: Record<string, { path: string; wsl?: { distro: string; linuxPath: string } }>,
  isGone: (path: string) => boolean,
): SourceProject[] {
  return Object.values(added).filter((a) => a && typeof a.path === 'string' && !isGone(a.path)).map((a) => ({ path: a.path, wsl: a.wsl }));
}
