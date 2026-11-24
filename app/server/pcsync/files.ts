/**
 * The file engine for aib-shared (sync between PCs, slice V4). Two paired PCs keep the real `aib-shared/` folder of a linked project
 * the same, over the sync link (link.ts). Lean on purpose (architect review): two PCs, so one "last synced" hash per file instead
 * of version vectors.
 *
 * Which projects: only confirmed links (projects.ts), and only while BOTH PCs have the project's aib-shared switch on (each PC
 * sends a `project.switch` item). The folder is resolved only from this PC's own link table, never from a frame; every file frame
 * carries the project sync id, and one that names a project this peer is not linked to is dropped. The folder is the project's
 * real `aib-shared/` in its main folder (never a worktree link), only while git keeps it local-only (local_only.ts 'on').
 * Links (symlinks, junctions) are never followed, listed or written through. Every file access goes through the project's disk (disk.ts,
 * diskops.ts): this PC's own, or for a WSL project its distro's (the helper's `pcsync.fs`), with the same rules; a distro that is not
 * running is never started: the project waits ("Waiting: Ubuntu is not running.") and is polled.
 *
 * Per file the engine knows three hashes: base (what both PCs last agreed on, saved), local (the file now) and remote (what the
 * peer last announced). Both PCs run the same rule on the same three values:
 *   local = remote            agreed: base = it
 *   remote = base             only this PC changed: the peer pulls
 *   local = base              only the peer changed: pull its version (or delete, when it deleted)
 *   both changed              an edit beats a delete; a version that says it replaces the other (a merge, or "kept against a
 *                             delete") wins; else the newest mtime wins and the OLDER side resolves: .md and .txt get a 3-way line
 *                             merge (git merge-file, the base kept from the last agreement); a merge that conflicts, and any other
 *                             file, keeps the loser's version beside the winner as `<name>.sync-conflict-<date>-<time>-<pc>.<ext>`.
 * A pull asks for 512 KB chunks (one at a time, each under the link's 1 MB frame cap), writes a temp file in <git dir>/aib-sync/tmp,
 * checks the sha256 and renames it over the file. Whatever sync replaces or deletes is moved to <git dir>/aib-sync/bin (30 days), which is
 * outside aib-shared. A batch of remote deletes that is more than half the folder, or over 200 files, is paused until the owner
 * clicks Allow or Keep files (a wiped folder, e.g. through a worktree link, would otherwise empty the other PC).
 *
 * Changes are noticed by a file watcher (a trigger only), debounced, plus a slow rescan; a rescan stats every file and hashes only
 * those whose size or mtime changed.
 */
import { createHash } from 'node:crypto';
import * as osp from '../platform/ospath.ts';
import { inDir } from '../state/base.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import { randomToken } from '../remote/words.ts';
import { runGit } from '../worktrees/changes.ts';
import { type Area, type BatchItem, checkPath } from './frames.ts';
import { canonAib, mergeAibdocs } from './aibmerge.ts';
import { pageNodes, parseAib } from '../docs/aibdoc.ts';
import { DiskDown, type SyncDisk } from './disk.ts';
import { fromB64, toB64 } from './diskops.ts';
import type { Peer } from './peers.ts';
import type { ProjectLink } from './projects.ts';
import {
  BIN_DAYS,
  BIN_MAX_BYTES,
  conflictName,
  conflictOriginal,
  GUARD_COUNT,
  GUARD_MIN,
  GUARD_SHARE,
  GUARD_WINDOW_MS,
  isAibdoc,
  isConflictCopy,
  isMergeable,
  isSecretPath,
  MAX_DOC_BASE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_FOLDER_BYTES,
  MAX_MERGE_BYTES,
} from './rules.ts';

type Timer = ReturnType<typeof setTimeout>;

export interface FileTimings {
  /** A burst of watcher events is answered with one scan this long after the last one. */
  debounceMs: number;
  /** The slow rescan of every active project (the watcher can miss things). */
  rescanMs: number;
  /** A WSL project has no watcher: its folder in the distro is looked at this often (never more rarely than rescanMs). */
  wslRescanMs: number;
  /** A pull that hears nothing for this long is dropped and retried. */
  stallMs: number;
  /** A file that failed to pull is left alone this long. */
  retryMs: number;
  /** Files that land within this long of each other are one received batch (one Device activity line). */
  batchMs: number;
  /** The mass-delete guard counts deletes of this long together. */
  guardWindowMs: number;
  /** The sync bin of one project is kept under this size (oldest first out). */
  binMaxBytes: number;
}
export const DEFAULT_FILE_TIMINGS: FileTimings = { debounceMs: 1500, rescanMs: 60_000, wslRescanMs: 8000, stallMs: 20_000, retryMs: 10_000, batchMs: 2000, guardWindowMs: GUARD_WINDOW_MS, binMaxBytes: BIN_MAX_BYTES };
const CHUNK = 512 * 1024;
const MAX_REMOTE = 60_000;
const SAVE_MS = 1500;
const PRUNE_MS = 6 * 3600_000;
const STATE_BATCH = 300;

/** What the docs store does for the docs sync (DocStore.landSynced and dropSynced). */
export interface DocsHooks {
  /** Put the other PC's doc.aibdoc in place (refused unless it parses); returns the file's text afterwards. */
  land(folder: string, name: string, text: string, from: string): Promise<string>;
  /** Before a delete: write an open doc's unsaved edits. True when there were any (the delete then waits: an edit beats a delete). */
  settle(folder: string, name: string): Promise<boolean>;
  /** The other PC deleted the doc: close it if it is open and remove its page copies. */
  drop(folder: string, name: string): Promise<void>;
}

export interface FileDeps {
  /** Confirmed links only. */
  links(): ProjectLink[];
  peers(): Peer[];
  connected(peerId: string): boolean;
  send(peerId: string, batch: { id: string; project?: string; items: BatchItem[] }): boolean;
  /** This PC's tailnet name and machine name (null until Tailscale was read). */
  own(): { host: string; name: string } | null;
  /** The disk of a project's aib-shared or aib-docs: this PC's own, or the project's WSL distro through its helper (slice V7). */
  disk(link: ProjectLink, area: Area): SyncDisk;
  log(message: string): void;
  /** aib-docs (slice V5): the docs store, which writes and merges every doc.aibdoc that arrives (docs_hooks in server.ts). */
  docs?: DocsHooks;
  /** Resolves when the project matching has applied every item it was given (a link may arrive just before a switch). */
  settled?(): Promise<void>;
  /** One call per received batch: `count` files from the other PC were put in place (or deleted here) in this project (Device activity). */
  applied?(peer: Peer, link: ProjectLink, area: Area, count: number): void;
}

interface Entry {
  /** What both PCs last agreed on (null: never agreed). */
  base: string | null;
  /** The file here now (null: deleted here). */
  hash: string | null;
  size: number;
  mtime: number;
  /** Hashes this version replaces (a merge), or 'del' (kept against a delete). Cleared when the peer agrees. */
  sup: string[];
}
interface Remote {
  hash: string | null;
  size: number;
  mtime: number;
  sup: string[];
}
interface Pull {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  kind: 'replace' | 'conflict';
}
interface Xfer extends Pull {
  /** This PC's hash of the file when the pull was decided (null: none). */
  local: string | null;
  /** The pull's temp file in the sync temp folder (a name only: the disk knows where). */
  tmp: string;
  hasher: ReturnType<typeof createHash>;
  offset: number;
  timer: Timer | undefined;
}
export interface Held {
  path: string;
  why: string;
}
interface Proj {
  sync: string;
  files: Map<string, Entry>;
  dirty: boolean;
  theirs: { shared: boolean; docs: boolean; branch: string | null } | null;
  sentSwitch: string;
  active: boolean;
  reason: string;
  /** This project's disk (this PC's, or its WSL distro's); made once from the link. */
  disk: SyncDisk | null;
  /** An opaque id of the project's git folder (it keys the bin cap and prune); the disk knows the real folder. */
  gitDir: string;
  /** What git is doing here and the branch, as last read (git.busy / branch), and when. */
  busy: string | null;
  branch: string | null;
  gitAt: number;
  /** Why the disk cannot be reached now (a stopped distro), '' when it can. */
  down: string;
  scanned: boolean;
  total: number;
  remote: Map<string, Remote> | null;
  remoteDone: boolean;
  announced: Map<string, string>;
  held: Held[];
  heldIn: Map<string, string>;
  /** Docs: a doc.aibdoc version that did not open as a doc (never written), and why. */
  bad: Map<string, { hash: string; why: string }>;
  skip: Map<string, number>;
  queue: Pull[];
  xfer: Xfer | null;
  pause: { paths: string[]; total: number } | null;
  allow: boolean;
  /** Deletes applied here lately (the guard counts them with the next ones: a wipe that arrives in halves is one wipe). */
  delLog: { at: number; path: string }[];
  /** Why this project waits (git is busy here, or the PCs are on different branches); '' when it does not. */
  wait: string;
  /** The complete file list went to the peer (it is held back while this project waits). */
  indexSent: boolean;
  recheck: Timer | undefined;
  /** Is the volume case-insensitive (Windows, macOS)? null: not tested yet. */
  insensitive: boolean | null;
  pending: number;
  watcher: Deno.FsWatcher | null;
  debounce: Timer | undefined;
}

export interface FileStatus {
  /** off: this PC's switch is off. offline, blocked (reason), other_off (the peer's switch), waiting (reason: git is busy, another branch, or the WSL distro is not running), checking, ok. */
  state: 'off' | 'offline' | 'blocked' | 'other_off' | 'waiting' | 'checking' | 'ok';
  reason: string;
  /** Files that still differ between the PCs (being copied, or waiting for the other PC to copy them). */
  pending: number;
  /** Conflict copies in the folder (paths, at most 20) and how many there are. */
  conflicts: string[];
  conflictCount: number;
  held: Held[];
  pause: { deletes: number; total: number } | null;
}

const batchId = () => randomToken(9);

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const sig = (e: Entry) => (e.hash === null ? 'null' : `${e.hash}|${e.size}|${e.mtime}|${e.sup.join(',')}`);

export class FileSync {
  readonly timings: FileTimings;
  readonly stats = { scans: 0, hashed: 0, events: 0, rejected: 0 };
  #projs = new Map<string, Proj>();
  #q: Promise<void> = Promise.resolve();
  #running = false;
  #timer: Timer | undefined;
  #saver: Timer | undefined;
  /** The poll of the projects that cannot be watched (WSL), and of a project whose distro was not running. */
  #poller: Timer | undefined;
  #pruned = new Map<string, number>();
  /** Per git dir: bytes put in the bin since the size cap was last checked. */
  #binAdded = new Map<string, number>();
  /** Per project: files received since the last Device activity line, and the quiet-period timer that writes it. */
  #landed = new Map<string, { n: number; timer: Timer }>();

  /** 'shared': the project's aib-shared/ (V4). 'docs': its aib-docs/ (V5): only each doc's doc.aibdoc and assets/, through the docs store. */
  readonly label: string;

  constructor(
    readonly stateDir: string,
    readonly deps: FileDeps,
    timings: Partial<FileTimings> = {},
    readonly area: Area = 'shared',
  ) {
    this.timings = { ...DEFAULT_FILE_TIMINGS, ...timings };
    this.label = area === 'docs' ? 'aib-docs' : 'aib-shared';
  }

  /** The project's switch for this folder (both PCs must have it on). */
  #on(link: ProjectLink): boolean {
    return this.area === 'docs' ? link.docs : link.shared;
  }
  #theirOn(p: Proj): boolean {
    return (this.area === 'docs' ? p.theirs?.docs : p.theirs?.shared) === true;
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------------------
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#timer = setInterval(() => this.#rescanAll(), this.timings.rescanMs);
    Deno.unrefTimer(this.#timer as unknown as number);
    this.#poller = setInterval(() => this.#pollAll(), Math.max(200, Math.min(this.timings.wslRescanMs, this.timings.rescanMs)));
    Deno.unrefTimer(this.#poller as unknown as number);
    void this.refresh();
  }

  stop(): void {
    this.#running = false;
    clearInterval(this.#timer);
    clearInterval(this.#poller);
    for (const p of this.#projs.values()) this.#deactivate(p);
    for (const l of this.#landed.values()) clearTimeout(l.timer);
    this.#landed.clear();
    this.#flush();
  }

  /** One more file came from the other PC: when no more arrive for batchMs, the batch is reported once (not one line per file). */
  #received(p: Proj): void {
    if (!this.deps.applied) return;
    const entry = this.#landed.get(p.sync) ?? { n: 0, timer: 0 as unknown as Timer };
    clearTimeout(entry.timer);
    entry.n++;
    entry.timer = setTimeout(() => {
      this.#landed.delete(p.sync);
      const link = this.#link(p.sync);
      const peer = link && this.#peer(link);
      if (link && peer) this.deps.applied?.(peer, link, this.area, entry.n);
    }, this.timings.batchMs);
    Deno.unrefTimer(entry.timer as unknown as number);
    this.#landed.set(p.sync, entry);
  }

  /** Tests: resolves when the queued work is done. */
  idle(): Promise<void> {
    return this.#q;
  }

  /** Tests and "Rescan": look at every active project's folder now. */
  rescanNow(): Promise<void> {
    this.#rescanAll();
    return this.#q;
  }

  #run(fn: () => Promise<void>): Promise<void> {
    this.#q = this.#q.then(fn).catch((e) => {
      if (!(e instanceof DiskDown)) this.deps.log(`${this.label} sync: ${e instanceof Error ? e.message : e}`); // a stopped distro: the poll tries again
    });
    return this.#q;
  }

  // ---- paths and state ---------------------------------------------------------------------------------------------------------
  #stateFile(sync: string) {
    return inDir(inDir(inDir(this.stateDir, 'pcsync'), this.#filesName), `${sync}.json`);
  }
  #baseDir(sync: string) {
    return inDir(inDir(inDir(this.stateDir, 'pcsync'), this.area === 'docs' ? 'docs-base' : 'base'), sync);
  }
  /** The per-area table of last-synced hashes. */
  get #filesName() {
    return this.area === 'docs' ? 'docs-files' : 'files';
  }

  #proj(sync: string): Proj {
    let p = this.#projs.get(sync);
    if (p) return p;
    p = {
      sync,
      files: new Map(),
      dirty: false,
      theirs: null,
      sentSwitch: '',
      active: false,
      reason: '',
      disk: null,
      gitDir: '',
      busy: null,
      branch: null,
      gitAt: 0,
      down: '',
      scanned: false,
      total: 0,
      remote: null,
      remoteDone: false,
      announced: new Map(),
      held: [],
      heldIn: new Map(),
      bad: new Map(),
      skip: new Map(),
      queue: [],
      xfer: null,
      pause: null,
      allow: false,
      delLog: [],
      wait: '',
      indexSent: false,
      recheck: undefined,
      insensitive: null,
      pending: 0,
      watcher: null,
      debounce: undefined,
    };
    const [status, data] = readJsonFile(this.#stateFile(sync));
    const files = status === 'ok' && data && typeof data === 'object' ? (data as { files?: unknown }).files : null;
    if (files && typeof files === 'object') {
      for (const [path, raw] of Object.entries(files as Record<string, Record<string, unknown>>).slice(0, MAX_REMOTE)) {
        if (!raw || typeof raw !== 'object' || !checkPath(path, this.area).ok) continue;
        const hex = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);
        p.files.set(path, {
          base: hex(raw.base),
          hash: hex(raw.hash),
          size: Number(raw.size) || 0,
          mtime: Number(raw.mtime) || 0,
          // a "Keep files" decision (or a merge) the other PC has not answered yet survives a restart
          sup: Array.isArray(raw.sup) ? raw.sup.filter((x): x is string => x === 'del' || hex(x) !== null).slice(0, 8) : [],
        });
      }
    }
    this.#projs.set(sync, p);
    return p;
  }

  #dirty(p: Proj): void {
    p.dirty = true;
    if (this.#saver) return;
    this.#saver = setTimeout(() => this.#flush(), SAVE_MS);
    Deno.unrefTimer(this.#saver as unknown as number);
  }

  #flush(): void {
    clearTimeout(this.#saver);
    this.#saver = undefined;
    for (const p of this.#projs.values()) {
      if (!p.dirty) continue;
      p.dirty = false;
      try {
        Deno.mkdirSync(inDir(inDir(this.stateDir, 'pcsync'), this.#filesName), { recursive: true });
        const files: Record<string, { base: string | null; hash: string | null; size: number; mtime: number; sup?: string[] }> = {};
        for (const [path, e] of p.files) files[path] = { base: e.base, hash: e.hash, size: e.size, mtime: e.mtime, ...(e.sup.length ? { sup: e.sup } : {}) };
        saveJson(this.#stateFile(p.sync), { version: 1, files }, 'pcsync-files-');
      } catch (error) {
        this.deps.log(`${this.label} sync could not save its state: ${error instanceof Error ? error.message : error}`);
      }
    }
  }

  #link(sync: string): ProjectLink | undefined {
    return this.deps.links().find((l) => l.sync === sync);
  }
  #peer(link: ProjectLink): Peer | undefined {
    return this.deps.peers().find((p) => p.host === link.peer);
  }

  // ---- what the other PC says --------------------------------------------------------------------------------------------------
  /** A link is up: tell the peer this PC's switches. (What the peer sent is kept: its first frames can come before this runs.) */
  onUp(peer: Peer): void {
    for (const p of this.#projs.values()) {
      if (this.#link(p.sync)?.peer === peer.host) p.sentSwitch = '';
    }
    void this.refresh();
  }

  onDown(peer: Peer): void {
    for (const p of this.#projs.values()) {
      if (this.#link(p.sync)?.peer !== peer.host) continue;
      this.#deactivate(p);
      p.theirs = null;
      p.sentSwitch = '';
    }
  }

  /** A batch from a peer (the link checked its shape). Items for a project this peer is not linked to are dropped. */
  onBatch(peer: Peer, batch: { id: string; project?: string; items: BatchItem[] }): void {
    const mine = batch.items.filter((i) => i.op === 'project.switch' || (i.op.startsWith('file.') && i.area === this.area));
    if (!mine.length) return;
    void this.#run(async () => {
      await this.deps.settled?.(); // a project.link that came just before is still being applied
      const link = batch.project ? this.deps.links().find((l) => l.sync === batch.project && l.peer === peer.host) : undefined;
      if (!link) {
        this.stats.rejected++;
        this.deps.log(`ignored ${mine.length} sync item(s) from ${peer.name}: not a project it is linked to`);
        return;
      }
      await this.#handle(peer, link, mine);
    });
  }

  async #handle(peer: Peer, link: ProjectLink, items: BatchItem[]): Promise<void> {
    if (!this.#running) return;
    const p = this.#proj(link.sync);
    let switched = false;
    let changed = false;
    for (const item of items) {
      switch (item.op) {
        case 'project.switch':
          p.theirs = { shared: item.shared === true, docs: item.docs === true, branch: typeof item.branch === 'string' ? item.branch : null };
          switched = true;
          break;
        case 'file.begin':
          p.remote = new Map();
          p.remoteDone = false;
          break;
        case 'file.state': {
          const path = String(item.path);
          if (isSecretPath(path)) break;
          p.remote ??= new Map();
          if (p.remote.size >= MAX_REMOTE && !p.remote.has(path)) break;
          p.remote.set(path, {
            hash: typeof item.hash === 'string' ? item.hash : null,
            size: Number(item.size) || 0,
            mtime: Number(item.mtime) || 0,
            sup: Array.isArray(item.sup) ? (item.sup as string[]) : [],
          });
          changed = true;
          break;
        }
        case 'file.end':
          p.remoteDone = true;
          changed = true;
          break;
        case 'file.get':
          await this.#serve(p, peer, item);
          break;
        case 'file.data':
          await this.#onData(p, peer, item);
          break;
        case 'file.gone':
          if (p.xfer && p.xfer.path === item.path && p.xfer.hash === item.hash) this.#abort(p, 'the other PC no longer has it', 2000);
          changed = true;
          break;
      }
    }
    if (switched) {
      await this.#refreshNow();
      if (p.active) this.#touch(p); // the other PC's branch may have changed: look again
    }
    if (changed && p.active) await this.#reconcile(p);
  }

  // ---- projects: switches, activation ------------------------------------------------------------------------------------------
  /** Look at every link again: send the switches, start what both PCs want, stop what not (a switch, a link, a peer changed). */
  refresh(): Promise<void> {
    return this.#run(() => this.#refreshNow());
  }

  async #refreshNow(): Promise<void> {
    if (!this.#running) return;
    const links = this.deps.links();
    const ids = new Set(links.map((l) => l.sync));
    for (const [sync, p] of [...this.#projs]) {
      if (ids.has(sync)) continue;
      this.#deactivate(p);
      this.#projs.delete(sync);
      this.#forget(sync);
    }
    for (const link of links) {
      const peer = this.#peer(link);
      const connected = !!peer && this.deps.connected(peer.id);
      let p = this.#projs.get(link.sync);
      if (!p) p = this.#proj(link.sync); // also with the switch off: the other PC is told so
      p.disk ??= this.deps.disk(link, this.area);
      if (connected && peer) {
        await this.#gitRefresh(p, 0);
        this.#sendSwitch(p, link, peer);
      }
      const want = this.#on(link) && connected && this.#theirOn(p) && (this.area !== 'docs' || !!this.deps.docs);
      if (want && !p.active && peer) await this.#activate(p, link, peer);
      else if (!want && p.active) this.#deactivate(p);
    }
  }

  /** Read what git is doing in the project and its branch (a disk that cannot be reached keeps the last look; never starts a distro). */
  async #gitRefresh(p: Proj, maxAgeMs: number): Promise<void> {
    const disk = p.disk;
    if (!disk || Date.now() - p.gitAt < maxAgeMs || disk.available()) return;
    try {
      const g = await disk.git();
      p.busy = g.busy;
      p.branch = g.branch;
      p.gitAt = Date.now();
    } catch { /* the last look stands */ }
  }

  #sendSwitch(p: Proj, link: ProjectLink, peer: Peer): void {
    const branch = p.branch;
    const now = `${link.shared}/${link.docs}/${branch ?? ''}`;
    if (p.sentSwitch === now) return;
    const sent = this.deps.send(peer.id, {
      id: batchId(),
      project: link.sync,
      items: [{ op: 'project.switch', shared: link.shared, docs: link.docs, ...(branch ? { branch } : {}) }],
    });
    if (sent) p.sentSwitch = now;
  }

  #forget(sync: string): void {
    for (const path of [this.#stateFile(sync)]) {
      try {
        Deno.removeSync(path);
      } catch { /* none */ }
    }
    try {
      Deno.removeSync(this.#baseDir(sync), { recursive: true });
    } catch { /* none */ }
  }

  async #activate(p: Proj, link: ProjectLink, peer: Peer): Promise<void> {
    const disk = p.disk!;
    // the folder to sync, or why not: only the project's own real aib-shared, only while git keeps it local-only (the disk looks)
    let found: { reason: string } | { key: string };
    try {
      const why = disk.available();
      if (why) {
        p.down = why;
        return;
      }
      found = await disk.resolve();
    } catch (error) {
      if (error instanceof DiskDown) {
        p.down = error.message;
        return;
      }
      throw error;
    }
    p.down = '';
    if ('reason' in found) {
      p.reason = found.reason;
      return;
    }
    p.reason = '';
    p.gitDir = found.key;
    p.active = true;
    p.scanned = false;
    p.indexSent = false;
    p.announced.clear();
    p.queue = [];
    p.pause = null;
    p.heldIn.clear();
    try {
      await disk.tmpClean();
    } catch { /* the first write says */ }
    await this.#scan(p);
    if (!p.scanned) {
      p.active = false;
      return;
    }
    this.#watch(p); // after the scan: the folder exists by then
    await this.#gitRefresh(p, 0);
    this.#sendSwitch(p, link, peer); // with the branch (the git folder is known now)
    this.#sendIndex(p, peer);
    await this.#maintain(p);
    await this.#reconcile(p);
  }

  #deactivate(p: Proj): void {
    if (p.xfer) this.#abort(p, '', 0);
    p.active = false;
    p.scanned = false;
    p.remote = null;
    p.remoteDone = false;
    p.queue = [];
    p.pause = null;
    p.pending = 0;
    clearTimeout(p.debounce);
    p.debounce = undefined;
    clearTimeout(p.recheck);
    p.recheck = undefined;
    p.wait = '';
    p.indexSent = false;
    const watcher = p.watcher;
    p.watcher = null;
    try {
      watcher?.close();
    } catch { /* closed */ }
  }

  // ---- watching and scanning ---------------------------------------------------------------------------------------------------
  #watch(p: Proj): void {
    const root = p.disk?.watchRoot; // a WSL project has none: it is polled (#pollAll)
    if (p.watcher || !root || !osp.isdir(root)) return;
    try {
      const watcher = Deno.watchFs(root, { recursive: true });
      p.watcher = watcher;
      void (async () => {
        try {
          for await (const event of watcher) {
            if (p.watcher !== watcher) break;
            if (event.kind === 'access') continue; // our own reads (serving a file) are not changes
            this.stats.events++;
            this.#touch(p);
          }
        } catch {
          /* closed or failed: the slow rescan starts it again */
        } finally {
          if (p.watcher === watcher) p.watcher = null;
        }
      })();
    } catch { /* not watchable: the slow rescan covers it */ }
  }

  #touch(p: Proj): void {
    if (!p.active) return;
    clearTimeout(p.debounce);
    p.debounce = setTimeout(() => {
      p.debounce = undefined;
      void this.#run(() => this.#rescan(p));
    }, this.timings.debounceMs);
    Deno.unrefTimer(p.debounce as unknown as number);
  }

  #rescanAll(): void {
    if (!this.#running) return;
    for (const p of this.#projs.values()) {
      if (!p.active || !p.disk?.watchRoot) continue; // a WSL project is polled by #pollAll
      if (!p.watcher) this.#watch(p);
      void this.#run(() => this.#rescan(p));
    }
  }

  /** The projects that cannot be watched (WSL) are looked at on a short timer; a project whose distro was not running is tried again. */
  #pollAll(): void {
    if (!this.#running) return;
    let again = false;
    for (const p of this.#projs.values()) {
      if (p.active && !p.disk?.watchRoot) void this.#run(() => this.#rescan(p));
      else if (!p.active && p.down) again = true;
    }
    if (again) void this.refresh();
  }

  async #rescan(p: Proj): Promise<void> {
    if (!p.active) return;
    const link = this.#link(p.sync);
    const peer = link && this.#peer(link);
    if (!peer || !this.deps.connected(peer.id)) return;
    const why = p.disk!.available();
    if (why) { // a stopped distro is never started: nothing is called until it runs again
      p.down = why;
      return;
    }
    await this.#scan(p);
    if (!p.scanned) return;
    await this.#gitRefresh(p, 0);
    this.#sendSwitch(p, link, peer); // a branch change on this PC is told before any file state
    p.wait = this.#waitReason(p, link, peer);
    if (p.indexSent) this.#announce(p, peer);
    else this.#sendIndex(p, peer);
    await this.#maintain(p);
    await this.#reconcile(p);
  }

  /**
   * Why this project must not sync now, or ''. Docs only: git rewrites tracked docs on purpose while it merges, rebases, cherry-picks,
   * stashes or switches branch, and that must not travel as an edit; and two PCs on different branches hold different docs.
   */
  #waitReason(p: Proj, _link: ProjectLink, peer: Peer): string {
    if (this.area !== 'docs') return '';
    const busy = p.busy;
    if (busy) return `Waiting: ${busy} is in progress here. Docs sync resumes when it is done.`;
    const mine = p.branch;
    const theirs = p.theirs?.branch ?? null;
    if (mine && theirs && mine !== theirs) return `Waiting: ${peer.name} is on branch ${theirs}; this PC is on ${mine}. Docs sync when both are on the same branch.`;
    return '';
  }

  /** Check again soon (a git operation or a branch difference ends without any file changing here). */
  #recheckSoon(p: Proj): void {
    if (p.recheck) return;
    p.recheck = setTimeout(() => {
      p.recheck = undefined;
      void this.#run(() => this.#rescan(p));
    }, Math.max(500, Math.floor(this.timings.retryMs / 2)));
    Deno.unrefTimer(p.recheck as unknown as number);
  }

  /** Stat every file; hash only those whose size or mtime changed; note deletions. Sets p.scanned, p.held, p.total, p.reason. A disk that cannot be reached (a stopped distro) sets p.down. */
  async #scan(p: Proj): Promise<void> {
    this.stats.scans++;
    try {
      await this.#scanDisk(p, p.disk!);
      p.down = '';
    } catch (error) {
      if (!(error instanceof DiskDown)) throw error;
      p.down = error.message;
      p.scanned = false;
    }
  }

  async #scanDisk(p: Proj, disk: SyncDisk): Promise<void> {
    const kind = await disk.rootKind();
    if (kind === 'missing') {
      if ([...p.files.values()].some((e) => e.base !== null || e.hash !== null)) {
        p.reason = `The ${this.label} folder is missing here. Nothing is synced until it is back.`;
        p.scanned = false;
        return;
      }
      try {
        await disk.mkRoot();
      } catch (error) {
        if (error instanceof DiskDown) throw error;
        p.reason = `The ${this.label} folder could not be made: ${error instanceof Error ? error.message : error}`;
        p.scanned = false;
        return;
      }
    } else if (kind !== 'dir') {
      p.reason = `${this.label} here is a link or a file, not the real folder.`;
      p.scanned = false;
      return;
    }
    p.reason = '';
    const present = new Set<string>();
    const held: Held[] = [];
    const found: { path: string; size: number; mtime: number }[] = [];
    const walked = await disk.walk(); // the whole folder in one call (links are listed, never followed)
    let incomplete = walked.incomplete;
    for (const [path, k, size, mtime] of walked.entries) {
      present.add(path);
      if (k !== 'f') continue;
      if (isSecretPath(path)) {
        held.push({ path, why: 'Not synced: the name looks like a secret.' });
        continue;
      }
      const ok = checkPath(path, this.area);
      if (!ok.ok) {
        held.push({ path, why: `Not synced: ${ok.error}.` });
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        held.push({ path, why: 'Held: over 100 MB.' });
        continue;
      }
      found.push({ path, size, mtime });
    }
    found.sort((a, b) => (a.path < b.path ? -1 : 1));
    let total = 0;
    let count = 0;
    const synced: typeof found = [];
    for (const f of found) {
      if (count >= MAX_FILES || total + f.size > MAX_FOLDER_BYTES) {
        held.push({ path: f.path, why: count >= MAX_FILES ? 'Held: too many files in the folder.' : 'Held: the folder is over 2 GB.' });
        continue;
      }
      count++;
      total += f.size;
      synced.push(f);
    }
    // hash only what changed: plain files in batches by the disk (a read in the distro stays there), a doc.aibdoc by its canonical form
    const todo = synced.filter((f) => {
      const e = p.files.get(f.path);
      return !(e && e.hash !== null && e.size === f.size && e.mtime === f.mtime);
    });
    const plain = todo.filter((f) => !this.#docFile(f.path));
    const plainResults = await disk.hashFiles(plain.map((f) => ({ rel: f.path, size: f.size, mtime: f.mtime })));
    const plainBy = new Map(plain.map((f, i) => [f.path, plainResults[i]]));
    for (const f of todo) {
      const e = p.files.get(f.path);
      this.stats.hashed++;
      let hash: string;
      if (this.#docFile(f.path)) {
        try {
          const r = await disk.readAll(f.path);
          if (!r) {
            incomplete = true;
            continue;
          }
          if (r.size !== f.size || r.mtime !== f.mtime) continue; // written while read: the next scan
          hash = this.#hashBytes(f.path, r.bytes);
        } catch (error) {
          if (error instanceof DiskDown) throw error;
          incomplete = true;
          continue;
        }
      } else {
        const r = plainBy.get(f.path)!;
        if (r.failed) {
          incomplete = true;
          continue;
        }
        if (r.hash === null) continue; // written while read: the next scan
        hash = r.hash;
      }
      if (!e) p.files.set(f.path, { base: null, hash, size: f.size, mtime: f.mtime, sup: [] });
      else {
        if (e.hash !== hash) e.sup = [];
        Object.assign(e, { hash, size: f.size, mtime: f.mtime });
      }
      p.dirty = true;
    }
    if (!incomplete) {
      for (const [path, e] of [...p.files]) {
        if (present.has(path) || e.hash === null) continue;
        // gone from the disk: deleted here (a held or link-replaced file is "present" and is left as it was)
        e.hash = null;
        e.size = 0;
        e.sup = [];
        p.dirty = true;
      }
    }
    p.held = held;
    p.total = total;
    p.scanned = true;
    if (p.dirty) this.#dirty(p);
  }

  // ---- announcing --------------------------------------------------------------------------------------------------------------
  #stateItem(path: string, e: Entry): BatchItem {
    return { op: 'file.state', area: this.area, path, hash: e.hash, size: e.size, mtime: e.mtime, sup: e.sup };
  }

  #sendItems(peer: Peer, sync: string, items: BatchItem[]): boolean {
    for (let i = 0; i < items.length || i === 0; i += STATE_BATCH) {
      if (!this.deps.send(peer.id, { id: batchId(), project: sync, items: items.slice(i, i + STATE_BATCH) })) return false;
      if (!items.length) break;
    }
    return true;
  }

  /** The complete list of this PC's files (a peer treats what is not in it as deleted), sent when the project starts. */
  #sendIndex(p: Proj, peer: Peer): void {
    const link = this.#link(p.sync);
    p.wait = link ? this.#waitReason(p, link, peer) : '';
    if (p.wait) return this.#recheckSoon(p);
    const items: BatchItem[] = [{ op: 'file.begin', area: this.area }];
    p.announced.clear();
    for (const [path, e] of p.files) {
      if (e.hash === null) continue;
      items.push(this.#stateItem(path, e));
      p.announced.set(path, sig(e));
    }
    items.push({ op: 'file.end', area: this.area });
    this.#sendItems(peer, p.sync, items);
    p.indexSent = true;
  }

  /** What changed since the last announcement. */
  #announce(p: Proj, peer: Peer): void {
    if (p.wait) return; // git is busy or the PCs are on different branches: nothing is announced
    const items: BatchItem[] = [];
    const done: [string, string][] = [];
    for (const [path, e] of p.files) {
      const now = sig(e);
      if ((p.announced.get(path) ?? 'null') === now) continue;
      items.push(this.#stateItem(path, e));
      done.push([path, now]);
    }
    if (!items.length) return;
    if (!this.#sendItems(peer, p.sync, items)) return;
    for (const [path, now] of done) p.announced.set(path, now);
  }

  // ---- the rule ----------------------------------------------------------------------------------------------------------------
  async #reconcile(p: Proj): Promise<void> {
    if (!p.active || !p.scanned || !p.remote || !p.remoteDone) return;
    const link = this.#link(p.sync);
    const peer = link && this.#peer(link);
    const own = this.deps.own();
    if (!link || !peer || !own) return;
    await this.#gitRefresh(p, p.disk!.watchRoot ? 0 : 1500);
    p.wait = this.#waitReason(p, link, peer);
    if (p.wait) {
      p.queue = [];
      p.pending = 0;
      if (p.xfer) this.#abort(p, '', 0);
      this.#recheckSoon(p);
      return;
    }
    const now = Date.now();
    const pulls: Pull[] = [];
    const deletes: string[] = [];
    const agreed: string[] = [];
    p.heldIn.clear();
    let pending = 0;
    // a volume that ignores case (Windows, macOS) holds one of `notes.md` and `Notes.md`, never both: the second is held, not pulled
    const taken = new Map<string, string>();
    const insensitive = await this.#caseInsensitive(p);
    if (insensitive) {
      for (const [path, e] of p.files) if (e.hash !== null) taken.set(path.toLowerCase(), path);
    }
    const want = (path: string, rem: Remote, kind: Pull['kind']) => {
      const holder = insensitive ? taken.get(path.toLowerCase()) : undefined;
      if (holder !== undefined && holder !== path) {
        p.heldIn.set(path, `Held: the name differs only in case from ${holder}, and this PC's disk treats them as one file.`);
        return;
      }
      if (insensitive) taken.set(path.toLowerCase(), path);
      const bad = p.bad.get(path);
      if (bad && bad.hash === rem.hash) {
        p.heldIn.set(path, bad.why); // that version did not open as a doc: it is not written, and not asked for again
        return;
      }
      pending++;
      if ((p.skip.get(path) ?? 0) > now) return;
      const why = isSecretPath(path)
        ? 'Not synced: the name looks like a secret.'
        : !checkPath(path, this.area).ok
        ? 'Not synced: the name is not allowed here.'
        : rem.size > MAX_FILE_BYTES
        ? 'Held: over 100 MB (on the other PC).'
        : p.total + rem.size > MAX_FOLDER_BYTES
        ? 'Held: the folder would be over 2 GB.'
        : '';
      if (why) {
        p.heldIn.set(path, why);
        pending--;
        return;
      }
      pulls.push({ path, hash: rem.hash!, size: rem.size, mtime: rem.mtime, kind });
    };
    for (const path of new Set([...p.files.keys(), ...p.remote.keys()])) {
      const e = p.files.get(path);
      const rem = p.remote.get(path);
      const l = e?.hash ?? null;
      const b = e?.base ?? null;
      const r = rem?.hash ?? null;
      if (l === r) {
        if (e && (e.base !== l || e.sup.length || l === null)) agreed.push(path);
        continue;
      }
      if (l === null && r !== null && rem!.sup.includes('del')) {
        want(path, rem!, 'replace'); // the other PC kept its file against my delete
        continue;
      }
      if (r === b) {
        pending++; // only this PC changed: the other PC pulls
        continue;
      }
      if (l === b) {
        if (r === null) {
          deletes.push(path);
          pending++;
        } else want(path, rem!, 'replace');
        continue;
      }
      // both changed
      if (r === null) {
        pending++; // an edit beats a delete: this PC's file stays and the other PC pulls it
        continue;
      }
      if (l === null) {
        want(path, rem!, 'replace');
        continue;
      }
      if (rem!.sup.includes(l)) {
        want(path, rem!, 'replace'); // the other PC merged this PC's version in
        continue;
      }
      if (e!.sup.includes(r)) {
        pending++;
        continue;
      }
      const mine = e!.mtime > rem!.mtime || (e!.mtime === rem!.mtime && own.host < peer.host);
      if (mine) pending++; // this PC's version is newer: the other PC resolves
      else want(path, rem!, 'conflict');
    }
    for (const path of agreed) {
      const e = p.files.get(path)!;
      if (e.hash === null) {
        p.files.delete(path);
        p.announced.delete(path);
      } else {
        e.base = e.hash;
        e.sup = [];
        await this.#keepBase(p, path, e);
      }
      p.dirty = true;
    }
    if (p.dirty) this.#dirty(p);
    // the mass-delete guard
    let apply = true;
    p.delLog = p.delLog.filter((d) => now - d.at < this.timings.guardWindowMs);
    if (deletes.length) {
      const total = [...p.files.values()].filter((e) => e.hash !== null).length;
      // deletes of the last minute count with these (a wipe that arrives in halves, over two scans or frames, is one wipe), and the
      // folder they came from is as big as it was before them
      const lately = p.delLog.filter((d) => !deletes.includes(d.path)).length;
      const count = deletes.length + lately, before = total + lately;
      const empties = deletes.length >= total; // whatever the count: the folder would end up empty
      const big = empties || (count >= GUARD_MIN && (count > GUARD_COUNT || count > before * GUARD_SHARE));
      if (big && !p.allow) {
        p.pause = { paths: deletes, total };
        apply = false;
      } else p.pause = null;
    } else p.pause = null;
    p.pending = pending;
    if (!apply) {
      p.queue = [];
      return;
    }
    p.allow = false;
    for (const path of deletes) {
      const doc = this.area === 'docs' && isAibdoc(path) ? this.deps.docs : undefined;
      const name = path.slice(0, path.indexOf('/'));
      if (doc && await doc.settle(link.folder, name).catch(() => false)) {
        this.#touch(p); // the doc was being edited here: the file is written now, and it is looked at again (an edit beats a delete)
        continue;
      }
      await this.#removeLocal(p, path);
      if (p.files.get(path)?.hash === null) p.delLog.push({ at: Date.now(), path });
      if (doc && p.files.get(path)?.hash === null) await doc.drop(link.folder, name).catch(() => {});
    }
    if (deletes.length) this.#announce(p, peer);
    p.queue = pulls.filter((x) => !(p.xfer && p.xfer.path === x.path && p.xfer.hash === x.hash));
    await this.#pump(p);
  }

  /**
   * The owner's choice on a conflict copy (Files: Keep this / Keep other). 'this': the original stays and the copy goes to the bin.
   * 'other': the copy replaces the original, the replaced version goes to the bin (and the copy's own file too). Both changes then
   * travel like any edit: the next scan sees them and the other PC gets the new file and the delete. Throws a plain sentence on refusal.
   */
  resolveConflict(sync: string, path: string, keep: 'this' | 'other'): Promise<void> {
    let failure: Error | null = null;
    const done = this.#run(async () => {
      try {
        const p = this.#projs.get(sync);
        const original = conflictOriginal(path);
        if (!p?.active || !p.scanned) throw new Error('Sync is not running for this project right now.');
        if (!original || !checkPath(path, this.area).ok) throw new Error('That is not a sync conflict copy.');
        const disk = p.disk!;
        const st = await disk.stat(path);
        if (!st || st.k !== 'f') throw new Error('The conflict copy is already gone.');
        if (keep === 'other') {
          const oldSt = await disk.stat(original);
          if (oldSt && oldSt.k !== 'f') throw new Error('The original is not a plain file.');
          const t = `k-${randomToken(6)}`;
          try {
            await disk.copyToTmp(path, t);
            await this.#binned(p, (await disk.install(t, original, { bin: !!oldSt })).binned); // the replaced version goes to the bin
          } catch (error) {
            disk.tmpRemove(t);
            throw error;
          }
        }
        await this.#bin(p, path, true);
        await this.#rescan(p);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    return done.then(() => {
      if (failure) throw failure;
    });
  }


  /** The owner's choice on a paused batch of deletes: 'allow' applies it, 'keep' keeps the files and sends them back. */
  decide(sync: string, action: 'allow' | 'keep'): boolean {
    const p = this.#projs.get(sync);
    if (!p?.pause) return false;
    const paths = p.pause.paths;
    if (action === 'allow') p.allow = true;
    else {
      for (const path of paths) {
        const e = p.files.get(path);
        if (!e || e.hash === null) continue;
        e.base = null; // forget the agreement: this PC's file now counts as new, and says it replaces the delete
        e.sup = ['del'];
        p.announced.delete(path);
      }
      p.pause = null;
      p.dirty = true;
      this.#dirty(p);
    }
    void this.#run(async () => {
      const link = this.#link(sync);
      const peer = link && this.#peer(link);
      if (peer && p.active) this.#announce(p, peer);
      await this.#reconcile(p);
    });
    return true;
  }

  // ---- writing safely ----------------------------------------------------------------------------------------------------------
  // Every read, write, delete and bin move goes through the project's disk (disk.ts): the disk refuses a path through a link, makes the
  // sync's temp files and bin in the git folder (never inside the synced folder) and, for a WSL project, does it all inside the distro.

  /** Is this project's volume case-insensitive? Tested once on the project's own disk (a Windows folder, or the distro's). */
  async #caseInsensitive(p: Proj): Promise<boolean> {
    if (p.insensitive !== null) return p.insensitive;
    try {
      p.insensitive = await p.disk!.caseInsensitive();
    } catch (error) {
      if (error instanceof DiskDown) throw error; // asked again when the distro runs
      p.insensitive = Deno.build.os !== 'linux'; // the OS default stands
    }
    return p.insensitive;
  }

  /** Move or copy a file into the bin (never inside aib-shared); the bin stays under its size cap. */
  async #bin(p: Proj, rel: string, move: boolean): Promise<void> {
    await this.#binned(p, await p.disk!.bin(rel, move));
  }

  /** `size` bytes went into the bin: the cap is checked once enough has been added since the last check. */
  async #binned(p: Proj, size: number): Promise<void> {
    const added = (this.#binAdded.get(p.gitDir) ?? 0) + size;
    if (added >= Math.min(64 * 1024 * 1024, Math.max(1, Math.floor(this.timings.binMaxBytes / 4)))) {
      this.#binAdded.set(p.gitDir, 0);
      await p.disk!.capBin(this.timings.binMaxBytes).catch(() => {}); // the oldest bin folders go first; the newest always stays
    } else this.#binAdded.set(p.gitDir, added);
  }

  /**
   * The recent bin entries of a project for this area, newest first: what sync replaced or deleted here, with when. `id` is what
   * restore() takes. A project that is not a git project, or whose distro is not running, has none.
   */
  async binEntries(sync: string, limit = 40): Promise<{ id: string; area: Area; path: string; at: string; size: number }[]> {
    const link = this.#link(sync);
    if (!link) return [];
    const disk = this.#projs.get(sync)?.disk ?? this.deps.disk(link, this.area);
    if (disk.available()) return [];
    try {
      return (await disk.binList(limit)).map((e) => ({ ...e, area: this.area }));
    } catch {
      return []; // no bin yet
    }
  }

  /**
   * Put a bin entry back (Restore). The file returns to its old place in this project's folder; a file that is there now goes to the bin
   * first. It then travels to the other PC like any edit. Throws a plain sentence on refusal.
   */
  restore(sync: string, id: string): Promise<void> {
    let failure: Error | null = null;
    const done = this.#run(async () => {
      try {
        const link = this.#link(sync);
        const p = this.#projs.get(sync);
        if (!link || !p?.active || !p.scanned) throw new Error('Sync is not running for this project right now.');
        const m = /^(\d{8}-\d{6}(?:-docs)?)\/(.+)$/.exec(id);
        if (!m || (m[1].endsWith('-docs') ? 'docs' : 'shared') !== this.area) throw new Error('That bin entry is not here.');
        const rel = m[2].replace(/\.\d+$/, '');
        if (!checkPath(rel, this.area).ok || isSecretPath(rel)) throw new Error('That name is not allowed here.');
        const t = `r-${randomToken(6)}`;
        try {
          await p.disk!.binToTmp(id, t);
          await this.#binned(p, (await p.disk!.install(t, rel, { bin: true })).binned); // a file there now goes to the bin first
        } catch (error) {
          p.disk!.tmpRemove(t);
          throw error;
        }
        await this.#rescan(p);
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
    });
    return done.then(() => {
      if (failure) throw failure;
    });
  }

  async #maintain(p: Proj): Promise<void> {
    const last = this.#pruned.get(p.gitDir) ?? 0;
    if (Date.now() - last > PRUNE_MS) {
      this.#pruned.set(p.gitDir, Date.now());
      await p.disk!.binPrune(BIN_DAYS, this.timings.binMaxBytes).catch(() => {}); // 30 days, and the size cap
    }
    try {
      const keep = new Set([...p.files.values()].map((e) => e.base).filter((b): b is string => !!b));
      for (const e of Deno.readDirSync(this.#baseDir(p.sync))) {
        if (!keep.has(e.name)) Deno.removeSync(osp.join(this.#baseDir(p.sync), e.name));
      }
    } catch { /* no base files yet */ }
  }

  #docFile(rel: string): boolean {
    return this.area === 'docs' && isAibdoc(rel);
  }

  /**
   * The hash a file is known by. Plain files: sha256 of the bytes. A doc.aibdoc: sha256 of its canonical form (aibmerge.ts canonAib:
   * who typed what is not part of it), because each PC's docs store writes the same doc with its own authorship marks. Two PCs
   * holding the same content then agree, and the store's rewrite after a merge is not an edit (no echo, no ping-pong). A file that
   * does not parse is known by its plain hash.
   */
  #hashBytes(rel: string, bytes: Uint8Array): string {
    if (this.#docFile(rel)) {
      try {
        return sha(new TextEncoder().encode(canonAib(new TextDecoder('utf-8', { fatal: true }).decode(bytes))));
      } catch { /* not a doc: plain */ }
    }
    return sha(bytes);
  }

  /** Files whose agreed content is kept as the base of a later merge: .md and .txt (line merge); in aib-docs, each doc.aibdoc (block merge). */
  #baseable(path: string): boolean {
    return this.area === 'docs' ? isAibdoc(path) : isMergeable(path);
  }

  /** The content of an agreed .md or .txt file (a doc.aibdoc in aib-docs) is kept (by hash) as the base of a later merge. */
  async #keepBase(p: Proj, path: string, e: Entry): Promise<void> {
    if (!this.#baseable(path) || e.hash === null || e.size > (this.area === 'docs' ? MAX_DOC_BASE_BYTES : MAX_MERGE_BYTES)) return;
    const file = osp.join(this.#baseDir(p.sync), e.hash);
    if (osp.exists(file)) return;
    try {
      const bytes = (await p.disk!.readAll(path))?.bytes;
      if (!bytes || this.#hashBytes(path, bytes) !== e.hash) return;
      Deno.mkdirSync(this.#baseDir(p.sync), { recursive: true });
      Deno.writeFileSync(file, bytes, { mode: 0o600 });
    } catch { /* no base: a clash of this file will get a conflict copy */ }
  }

  async #removeLocal(p: Proj, path: string): Promise<void> {
    const e = p.files.get(path);
    if (!e || e.hash === null) return;
    try {
      // the file goes to the bin and the empty folders above it go; refused when it changed since the scan
      const done = await p.disk!.deleteFile(path, e.size, e.mtime);
      if (done.changed) {
        this.#touch(p); // changed since the scan: look again before deleting anything
        return;
      }
      await this.#binned(p, done.binned);
      this.#received(p);
      // the entry stays as a delete (hash null): it is announced, so the other PC sees the delete was applied, then both drop it
      Object.assign(e, { hash: null, size: 0, sup: [] });
      p.dirty = true;
    } catch (error) {
      p.heldIn.set(path, `Not deleted: ${error instanceof Error ? error.message : error}.`);
    }
  }

  // ---- pulling -----------------------------------------------------------------------------------------------------------------
  async #pump(p: Proj): Promise<void> {
    if (p.xfer || p.pause || !p.active) return;
    const link = this.#link(p.sync);
    const peer = link && this.#peer(link);
    if (!peer) return;
    while (p.queue.length && !p.xfer) {
      const next = p.queue.shift()!;
      const e = p.files.get(next.path);
      try {
        await p.disk!.safe(next.path, true);
        const tmp = `x-${randomToken(6)}`;
        await p.disk!.tmpWrite(tmp, new Uint8Array(), true); // an empty temp file; the chunks are appended to it
        const xfer: Xfer = { ...next, local: e?.hash ?? null, tmp, hasher: createHash('sha256'), offset: 0, timer: undefined };
        p.xfer = xfer;
        this.#arm(p, xfer);
        if (!this.#get(p, peer, xfer)) this.#abort(p, 'the link is down', 0);
      } catch (error) {
        p.skip.set(next.path, Date.now() + this.timings.retryMs);
        p.heldIn.set(next.path, `Held: ${error instanceof Error ? error.message : error}.`);
      }
    }
  }

  #get(p: Proj, peer: Peer, x: Xfer): boolean {
    return this.deps.send(peer.id, {
      id: batchId(),
      project: p.sync,
      items: [{ op: 'file.get', area: this.area, path: x.path, hash: x.hash, offset: x.offset }],
    });
  }

  #arm(p: Proj, x: Xfer): void {
    clearTimeout(x.timer);
    x.timer = setTimeout(() => {
      if (p.xfer === x) this.#abort(p, 'no answer', this.timings.retryMs);
    }, this.timings.stallMs);
    Deno.unrefTimer(x.timer as unknown as number);
  }

  #abort(p: Proj, why: string, skipMs: number): void {
    const x = p.xfer;
    if (!x) return;
    p.xfer = null;
    clearTimeout(x.timer);
    p.disk?.tmpRemove(x.tmp);
    if (skipMs) {
      p.skip.set(x.path, Date.now() + skipMs);
      this.#later(p, skipMs);
    }
    if (why) this.deps.log(`${this.label} sync: ${x.path}: ${why}`);
  }

  /** Look at a project again after a pause (a file that failed to pull is retried). */
  #later(p: Proj, ms: number): void {
    const timer = setTimeout(() => void this.#run(() => this.#rescan(p)), ms + 20);
    Deno.unrefTimer(timer as unknown as number);
  }

  async #onData(p: Proj, peer: Peer, item: BatchItem): Promise<void> {
    const x = p.xfer;
    if (!x || !p.active || item.path !== x.path || item.hash !== x.hash || item.offset !== x.offset) return;
    const bytes = fromB64(String(item.data));
    const size = Number(item.size);
    if (size !== x.size || x.offset + bytes.length > size || size > MAX_FILE_BYTES || (!bytes.length && item.last !== true)) {
      return this.#abort(p, 'the other PC sent something that does not fit', this.timings.retryMs);
    }
    try {
      await p.disk!.tmpWrite(x.tmp, bytes, x.offset === 0); // appended to the temp file in the sync temp folder
    } catch (error) {
      if (p.xfer !== x) return; // dropped meanwhile
      return this.#abort(p, `could not write: ${error instanceof Error ? error.message : error}`, this.timings.retryMs);
    }
    x.hasher.update(bytes);
    x.offset += bytes.length;
    this.#arm(p, x);
    if (item.last !== true) {
      if (!this.#get(p, peer, x)) this.#abort(p, 'the link is down', 0);
      return;
    }
    if (x.offset !== size) return this.#abort(p, 'the file ended early', this.timings.retryMs);
    await this.#finish(p, peer, x);
  }

  /** The whole file is in the temp file: check it, then put it in place (merging or keeping a conflict copy when both PCs changed it). */
  async #finish(p: Proj, peer: Peer, x: Xfer): Promise<void> {
    clearTimeout(x.timer);
    p.xfer = null;
    const disk = p.disk!;
    const drop = (why: string, skipMs: number) => {
      disk.tmpRemove(x.tmp);
      if (skipMs) {
        p.skip.set(x.path, Date.now() + skipMs);
        this.#later(p, skipMs);
      }
      if (why) this.deps.log(`${this.label} sync: ${x.path}: ${why}`);
    };
    try {
      if ((this.#docFile(x.path) ? this.#hashBytes(x.path, await disk.tmpRead(x.tmp)) : x.hasher.digest('hex')) !== x.hash) {
        drop('the copy does not match its hash', this.timings.retryMs);
        return this.#again(p);
      }
    } catch (error) {
      drop(`${error instanceof Error ? error.message : error}`, this.timings.retryMs);
      return this.#again(p);
    }
    const e = p.files.get(x.path);
    if (p.remote?.get(x.path)?.hash !== x.hash) {
      drop('the other PC changed it meanwhile', 0);
      return this.#again(p);
    }
    try {
      await disk.safe(x.path, true);
      const st = await disk.stat(x.path);
      const here = e?.hash ?? null;
      if (here !== x.local || (here === null ? !!st : !st || st.size !== e!.size || st.mtime !== e!.mtime)) {
        drop('changed here meanwhile', 0);
        this.#touch(p);
        return this.#again(p);
      }
      if (this.area === 'docs' && isAibdoc(x.path)) {
        // a doc.aibdoc never goes in by a rename: the docs store takes it (checked, merged with an open doc, page copies rendered)
        const done = await this.#landDoc(p, x, e, here);
        if (!done) {
          drop('', 0);
          return this.#again(p);
        }
        this.#received(p);
        this.#announce(p, peer);
        await this.#reconcile(p);
        return;
      }
      let sup: string[] = [];
      let keepBin = here !== null;
      let base: string | null = x.hash;
      if (here !== null && x.kind === 'conflict') {
        const merged = await this.#merge(p, x, e!);
        if (merged) {
          await disk.tmpWrite(x.tmp, merged, true);
          const mh = sha(merged);
          sup = mh === x.hash ? [] : [here, x.hash];
          base = mh === x.hash ? x.hash : e!.base;
          this.deps.log(`${this.label} sync: merged ${x.path} from both PCs`);
        } else {
          const own = this.deps.own();
          const copy = conflictName(x.path, own?.name ?? 'pc');
          await disk.safe(copy, true);
          const copyRel = (await disk.stat(copy)) ? conflictName(x.path, `${own?.name ?? 'pc'}-${randomToken(2)}`) : copy;
          const info = await disk.copy(x.path, copyRel);
          p.files.set(copyRel, {
            base: null,
            hash: here,
            size: info.size,
            mtime: info.mtime,
            sup: [],
          });
          keepBin = false; // the loser's version stays beside the winner: nothing to bin
          this.deps.log(`${this.label} sync: ${x.path} changed on both PCs: the older version is kept as a conflict copy`);
        }
      }
      // the old version goes to the bin (a copy), then the temp file is renamed over the file (atomic); a plain pull keeps the other PC's mtime
      const mtime = x.mtime > 0 && x.mtime < Date.now() + 86_400_000 ? x.mtime : Date.now();
      const info = await disk.install(x.tmp, x.path, { bin: keepBin, ...(sup.length ? { hash: true } : { mtime }) });
      await this.#binned(p, info.binned);
      const finalHash = sup.length ? info.hash ?? x.hash : x.hash;
      p.files.set(x.path, {
        base: sup.length ? base : x.hash,
        hash: finalHash,
        size: info.size,
        mtime: info.mtime,
        sup,
      });
      p.dirty = true;
      this.#dirty(p);
      await this.#keepBase(p, x.path, p.files.get(x.path)!);
      this.#received(p);
    } catch (error) {
      drop(`${error instanceof Error ? error.message : error}`, this.timings.retryMs);
      const why = `Held: ${error instanceof Error ? error.message : error}.`;
      p.heldIn.set(x.path, why);
      return this.#again(p);
    }
    this.#announce(p, peer);
    await this.#reconcile(p);
  }

  /**
   * A doc.aibdoc from the other PC is in the temp file. Both PCs changed it: a block merge (aibmerge.ts) against the last agreed copy,
   * else the newer version wins and this PC's goes to the bin. The result must parse as a doc (nothing else is ever written); the
   * docs store then writes it (an open doc merges it like an outside edit). false: it was refused (held, nothing written).
   */
  async #landDoc(p: Proj, x: Xfer, e: Entry | undefined, here: string | null): Promise<boolean> {
    const link = this.#link(p.sync);
    const docs = this.deps.docs;
    if (!link || !docs) throw new Error('the docs store is not ready');
    const from = this.#peer(link)?.name ?? 'the other PC';
    const bytes = await p.disk!.tmpRead(x.tmp);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      for (const page of parseAib(text).pages) pageNodes(page);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      p.bad.set(x.path, { hash: x.hash, why: `Not written: ${from}'s doc.aibdoc does not open as a doc (${why}).` });
      this.deps.log(`${this.label} sync: ${x.path}: not a valid doc.aibdoc, not written`);
      return false;
    }
    p.bad.delete(x.path);
    let sup: string[] = [];
    let base: string | null = x.hash;
    if (here !== null && x.kind === 'conflict') {
      const merged = await this.#merge(p, x, e!);
      if (merged) {
        text = new TextDecoder().decode(merged);
        sup = [here, x.hash];
        base = e!.base;
        this.deps.log(`${this.label} sync: merged ${x.path} from both PCs`);
      } else this.deps.log(`${this.label} sync: ${x.path} changed on both PCs and could not be merged: the newer version is used`);
    }
    if (bytes.length <= MAX_DOC_BASE_BYTES) {
      // what both PCs agreed on (the other PC's version): the base of the next merge
      const file = osp.join(this.#baseDir(p.sync), x.hash);
      if (!osp.exists(file)) {
        Deno.mkdirSync(this.#baseDir(p.sync), { recursive: true });
        Deno.writeFileSync(file, bytes, { mode: 0o600 });
      }
    }
    if (here !== null) await this.#bin(p, x.path, false);
    // the docs store writes it (through its own WSL path for a WSL project), then this looks at what it left on the disk
    await docs.land(link.folder, x.path.slice(0, x.path.indexOf('/')), text, from);
    p.disk!.tmpRemove(x.tmp);
    const now = await p.disk!.readAll(x.path);
    if (!now) throw new Error('the doc is not there after the docs store wrote it');
    p.files.set(x.path, { base: sup.length ? base : x.hash, hash: this.#hashBytes(x.path, now.bytes), size: now.size, mtime: now.mtime, sup });
    p.dirty = true;
    this.#dirty(p);
    await this.#keepBase(p, x.path, p.files.get(x.path)!);
    return true;
  }

  #again(p: Proj): Promise<void> {
    const link = this.#link(p.sync);
    const peer = link && this.#peer(link);
    if (peer && p.active) this.#announce(p, peer);
    return this.#reconcile(p);
  }

  /** A 3-way line merge of an .md or .txt file against the last agreed version (git merge-file). null: not mergeable or it conflicts. */
  async #merge(p: Proj, x: Xfer, e: Entry): Promise<Uint8Array | null> {
    if (this.area === 'docs') {
      // a doc.aibdoc: a 3-way merge by block id (aibmerge.ts); no base (never agreed) merges as two PCs that made the same doc
      if (!isAibdoc(x.path) || e.size > MAX_DOC_BASE_BYTES || x.size > MAX_DOC_BASE_BYTES) return null;
      try {
        const link = this.#link(p.sync);
        let base: string | null = null;
        if (e.base) {
          const bytes = await Deno.readFile(osp.join(this.#baseDir(p.sync), e.base)).catch(() => null);
          if (bytes && this.#hashBytes(x.path, bytes) === e.base) base = new TextDecoder().decode(bytes);
        }
        const ours = (await p.disk!.readAll(x.path))?.bytes;
        if (!ours || this.#hashBytes(x.path, ours) !== e.hash) return null;
        const theirs = await p.disk!.tmpRead(x.tmp);
        const from = (link && this.#peer(link)?.name) || 'the other PC';
        const text = mergeAibdocs(base, new TextDecoder().decode(ours), new TextDecoder().decode(theirs), from);
        return text === null ? null : new TextEncoder().encode(text);
      } catch {
        return null;
      }
    }
    if (!isMergeable(x.path) || !e.base || e.size > MAX_MERGE_BYTES || x.size > MAX_MERGE_BYTES) return null;
    // git merge-file runs here, on this PC, on three copies in a scratch folder in AIB's own state (the files are read from the disk)
    const dir = inDir(inDir(this.stateDir, 'pcsync'), 'merge-tmp');
    const names = [0, 1, 2].map((i) => osp.join(dir, `m-${randomToken(6)}-${i}`));
    try {
      Deno.mkdirSync(dir, { recursive: true });
      const base = await Deno.readFile(osp.join(this.#baseDir(p.sync), e.base));
      if (sha(base) !== e.base) return null;
      const ours = (await p.disk!.readAll(x.path))?.bytes;
      const theirs = await p.disk!.tmpRead(x.tmp);
      if (!ours || sha(ours) !== e.hash) return null;
      await Deno.writeFile(names[0], ours);
      await Deno.writeFile(names[1], base);
      await Deno.writeFile(names[2], theirs);
      const [out, truncated, code] = await runGit(['merge-file', '-p', names[0], names[1], names[2]], dir, 30, MAX_MERGE_BYTES * 2 + 4096);
      return code === 0 && !truncated ? out : null;
    } catch {
      return null;
    } finally {
      for (const name of names) {
        try {
          Deno.removeSync(name);
        } catch { /* none */ }
      }
    }
  }

  // ---- serving -----------------------------------------------------------------------------------------------------------------
  /** The other PC asks for a chunk of a file: only a file in this PC's own list, at the hash asked for, read without crossing a link. */
  async #serve(p: Proj, peer: Peer, item: BatchItem): Promise<void> {
    if (!p.active || !p.scanned) return;
    const path = String(item.path);
    const hash = String(item.hash);
    const offset = Number(item.offset);
    const gone = () =>
      this.deps.send(peer.id, { id: batchId(), project: p.sync, items: [{ op: 'file.gone', area: this.area, path, hash }] });
    if (p.wait || p.down) return void gone(); // git is busy here, another branch, or the distro is down: what is on disk is not what was announced
    const e = p.files.get(path);
    if (!e || e.hash !== hash || offset > e.size || isSecretPath(path)) return void gone();
    try {
      // the disk reads the chunk only when the file is still what was announced (size and mtime), and never through a link
      const buf = await p.disk!.readChunk(path, offset, Math.min(CHUNK, e.size - offset), e.size, e.mtime);
      if (!buf) {
        this.#touch(p);
        return void gone();
      }
      const got = buf.length;
      this.deps.send(peer.id, {
        id: batchId(),
        project: p.sync,
        items: [{
          op: 'file.data',
          area: this.area,
          path,
          hash,
          offset,
          size: e.size,
          last: offset + got >= e.size,
          data: toB64(buf.subarray(0, got)),
        }],
      });
    } catch {
      gone();
    }
  }

  // ---- what the card shows -----------------------------------------------------------------------------------------------------
  status(sync: string): FileStatus | null {
    const link = this.#link(sync);
    if (!link) return null;
    const empty: FileStatus = { state: 'off', reason: '', pending: 0, conflicts: [], conflictCount: 0, held: [], pause: null };
    if (!this.#on(link)) return empty;
    const peer = this.#peer(link);
    if (!peer || !this.deps.connected(peer.id)) return { ...empty, state: 'offline' };
    const p = this.#projs.get(sync);
    if (!p) return { ...empty, state: 'checking' };
    // a WSL project whose distro is not running: waiting (nothing is started or called until it runs)
    if (p.down) return { ...empty, state: 'waiting', reason: p.down };
    if (p.reason && !p.active) return { ...empty, state: 'blocked', reason: p.reason };
    if (!this.#theirOn(p)) return { ...empty, state: p.theirs ? 'other_off' : 'checking' };
    if (p.active && p.wait) return { ...empty, state: 'waiting', reason: p.wait };
    const conflicts = [...p.files].filter(([path, e]) => e.hash !== null && isConflictCopy(path)).map(([path]) => path);
    const held = [...p.held, ...[...p.heldIn].map(([path, why]) => ({ path, why }))].slice(0, 50);
    const ready = p.active && p.scanned && p.remoteDone;
    return {
      state: ready ? 'ok' : 'checking',
      reason: '',
      pending: ready ? p.pending : 0,
      conflicts: conflicts.slice(0, 20),
      conflictCount: conflicts.length,
      held,
      pause: p.pause ? { deletes: p.pause.paths.length, total: p.pause.total } : null,
    };
  }

  /** Tests: the engine's own view of a project. */
  debug(sync: string): Record<string, unknown> | null {
    const p = this.#projs.get(sync);
    return p
      ? {
        active: p.active,
        scanned: p.scanned,
        remoteDone: p.remoteDone,
        remote: p.remote?.size ?? -1,
        theirs: p.theirs,
        xfer: p.xfer?.path ?? null,
        queue: p.queue.map((x) => x.path),
        skip: [...p.skip.keys()],
        pause: !!p.pause,
        reason: p.reason,
      }
      : null;
  }

  /** Tests: the last-synced hash of a file. */
  baseOf(sync: string, path: string): string | null {
    return this.#projs.get(sync)?.files.get(path)?.base ?? null;
  }
}
