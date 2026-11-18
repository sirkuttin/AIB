/**
 * The open files' live texts (files/live_file.ts) in the web server: the registry, the disk poll, the store, the "files changed"
 * events, the save's locks and the notes to agents (private/designs/file-editor/file-editor-design-v2.md 4.2-4.5; architect review
 * 2026-11-16 must-fixes 3-8 and its should-fixes for keys, links, the store and quitting).
 *
 * Registry. One LiveFile per real path, case-folded on Windows (src/A.ts and src/a.ts are one file), created on the first editable
 * open. Only the project folder is editable: a helper's or subagent's worktree, aib-docs/ (Open in Docs), AIB's data folders and
 * .git are refused (editPlace). A save writes the resolved path, so a link inside the folder keeps being a link.
 *
 * Reading the disk (must-fix 4). Every 2 s each open file costs one stat; a changed size or mtime, a recent mtime on a small file,
 * or a "files changed" event (an agent's finished write call, a landing, an Undo) makes it read the file, but only once it has
 * settled: two stats 300 ms apart and a third after the read must agree, so a half-written file is never taken in. Nothing is read
 * while the project's pause lock is held (a landing or an Undo is moving the folder, maybe with the user's work stashed); it is
 * checked again afterwards. All of a file's work runs in its own serial queue.
 *
 * The store (must-fix 5, hot exit). A file whose text is not the disk's (or has an open overlap, or a deleted/unreadable disk) is
 * kept in <stateDir>/editor-live/<folder hash>/<id>.json, one file written atomically ~1 s after the last change and when the
 * server closes: the Y update (so a page that reconnects after a web-server restart merges its unsent edits: same lineage), the
 * base and where the file is. At start every stored file is loaded and checked against the disk. Nothing is ever pruned by age:
 * unsaved text is only dropped by a save, "Don't save" in the last view, or the project's removal. Quitting AIB never asks.
 *
 * Undo history (files/live_file.ts). A file whose text is the disk's but that has undo steps is stored too (`unsaved: false`), with
 * its history, and let go from memory once no view shows it; opening it again loads it back (same lineage, so the steps still
 * apply) and merges what changed on disk meanwhile as the disk's change. It is not loaded at start. The history ends when the file
 * is deleted (checked every few polls, at start and on open) or the project is removed; "Don't save" in the last view keeps it and
 * turns the drop into one undo step.
 *
 * Notes to agents (design 3.8 / 3.9). They go out with the chat's next prompt (Studio's prompt-context), one per file, the newest
 * ranges only: after an overlap to the chat that wrote (else the folder's busy chats), after a save to the chats whose agent wrote
 * that file and the folder's busy chats.
 *
 * WSL projects (AIB 0.13.0). A file of a WSL project (its folder is a wsl:// ref) is the same LiveFile with the same rules; only its
 * disk work goes through AIB's helper inside the distro (files/file_io.ts WslIo, wsl/helper/editor.ts), never through \\wsl$: the
 * place and the guard (links resolved in the distro, .git, AIB's own folders, the agents' sign-in folders such as ~/.claude, ~/.codex
 * and ~/.ssh), the settled read, and the atomic save with its raw-byte check right before the rename. Its key and `abs` are the ref
 * of the real Linux path (case kept); its folder is the project's ref. A distro that is not running is "away": the poll skips the
 * file (never "deleted"), a save fails with code 'wsl_away' and the text stays.
 */
import * as Y from 'yjs';
import { createHash } from 'node:crypto';
import * as osp from '../platform/ospath.ts';
import { type DiskText, readDisk } from './file_text.ts';
import { baseOf, LiveFile, type Place, type SaveReply, type Stored, TEST_PAGE_ORIGIN } from './live_file.ts';
import { narrowEdit, rangesText } from './line_merge.ts';
import { type FilesChanged, onFilesChanged } from './files_changed.ts';
import { FilesError, realRoot, resolveInside, safeParts, within } from '../worktrees/files.ts';
import { LockTimeout, pauseLock, recordForPath, syncPaused } from '../worktrees/worktrees.ts';
import type { WsLink } from '../platform/websocket.ts';
import { AWAY, ioOf, type Read, sameStat, statSync, winIo, WslEditRefused, wslIo } from './file_io.ts';
import { WslHelperError } from '../wsl/contract.ts';
import { isWslRef, refOf, wslLocOf } from '../platform/location.ts';

export type Json = Record<string, unknown>;

/** What the registry needs from the rest of AIB (the web server's context; a test passes a fake). */
export interface LiveFilesHost {
  stateDir: string;
  /** Studio's live calls: 'files-changed', 'folder-chats', 'prompt-context'. */
  liveCall(name: string, body: unknown): Promise<[number, unknown]>;
  /** The open chats by lasting id with the files their agent wrote (absolute paths). */
  conversations(): { id?: string; cwd?: string; writes?: string[] }[];
  connectionOf(id: string): string | null;
}

export const LIVE_TIMING = { pollMs: 2000, tickMs: 1000, settleMs: 300, storeMs: 1000, closeGraceMs: 15_000, saveWaitMs: 3000 };

/** Why a file opens read-only (the page's footer and its one button). */
export type PlaceRefusal = 'worktree' | 'docs' | 'data' | 'blocked';

const sha1 = (text: string) => createHash('sha1').update(text).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The registry key: a Windows path case-folded; a WSL ref as it is (Linux names are case-sensitive). */
const keyOf = (real: string) => (isWslRef(real) ? real : osp.WIN ? osp.normcase(osp.normpath(real)) : osp.normpath(real));
const SAVE_TEMP = /^\.aib-save-[0-9a-f]{8}\.tmp$/i;

/** AIB's own data folders: never edited (the state dir, and %LOCALAPPDATA%\AgentStudio where worktrees live). */
function dataDirs(stateDir: string): string[] {
  const out = [stateDir];
  const local = osp.WIN ? Deno.env.get('LOCALAPPDATA') : '';
  if (local) out.push(osp.join(local, 'AgentStudio'));
  return out.filter(Boolean);
}

/**
 * Where an edit of `rel` in folder `root` goes, or why it can't (design 3.3, review should-fixes). Throws FilesError for a path that
 * is not there or not allowed at all (outside, .git: the same rules as reading).
 */
export function editPlace(stateDir: string, root: string, rel: unknown): { place: { key: string; abs: string; root: string; rel: string } } | { refused: PlaceRefusal } {
  const base = realRoot(root);
  if (recordForPath(stateDir, base) || dataDirs(stateDir).some((d) => within(base, d))) return { refused: 'worktree' };
  const [real, clean] = resolveInside(base, rel);
  if (!clean) throw new FilesError('Choose a file', 'not_file');
  if (clean.split('/')[0].toLowerCase() === 'aib-docs') return { refused: 'docs' };
  if (dataDirs(stateDir).some((d) => within(real, d))) return { refused: 'data' };
  if (SAVE_TEMP.test(clean.slice(clean.lastIndexOf('/') + 1))) return { refused: 'data' };
  return { place: { key: keyOf(real), abs: real, root: base, rel: clean } };
}

/** The save-failed row's words for a write error (design 3.4). */
export function saveFailure(error: unknown, abs: string): { code: string; error: string } {
  const msg = error instanceof Error ? error.message : String(error);
  // a WSL file: the helper in the distro answered with its code (wsl/helper/editor.ts)
  if (error instanceof WslEditRefused) {
    return { code: error.code === 'blocked' ? 'blocked_folder' : 'access_denied', error: error.code === 'blocked' ? 'This folder holds sign-ins' : 'Access denied' };
  }
  if (error instanceof FilesError) return { code: 'access_denied', error: 'Access denied: ' + error.message };
  if (error instanceof WslHelperError) {
    const words: Record<string, string> = {
      folder_gone: 'Folder gone',
      disk_full: 'Disk full',
      read_only: 'Read-only file',
      access_denied: 'Access denied',
      owner: "Owned by another Linux user: AIB can't keep its owner",
      too_big: 'Over 5 MB',
    };
    if (words[error.code]) return { code: error.code, error: words[error.code] };
    if (['stopped', 'helper_gone', 'helper_exited', 'helper_restart', 'helper_timeout', 'not_installed', 'unsupported', 'timeout'].includes(error.code)) {
      return { code: 'wsl_away', error: 'WSL is not reachable: ' + msg.slice(0, 120) + '. Your text is kept; save again when it is back.' };
    }
    return { code: 'write_failed', error: 'Could not save: ' + msg.slice(0, 160) };
  }
  const os = /os error (\d+)/.exec(msg)?.[1] ?? '';
  if (error instanceof Deno.errors.NotFound || os === '3') return { code: 'folder_gone', error: 'Folder gone' };
  if (os === '32' || os === '33' || error instanceof Deno.errors.Busy) return { code: 'locked', error: 'Locked by another program' };
  if (os === '112' || os === '39' || /ENOSPC|No space left/i.test(msg)) return { code: 'disk_full', error: 'Disk full' };
  if (error instanceof Deno.errors.PermissionDenied || os === '5') {
    try {
      if (((Deno.statSync(abs).mode ?? 0o644) & 0o222) === 0) return { code: 'read_only', error: 'Read-only file' };
    } catch { /* gone: access denied below */ }
    return { code: 'access_denied', error: 'Access denied' };
  }
  return { code: 'write_failed', error: 'Could not save: ' + msg.slice(0, 160) };
}

const statOf = statSync;

/** A closed file kept only for its undo history: its registry key, path, folder, path inside it and store id. */
interface Kept {
  key: string;
  abs: string;
  root: string;
  rel: string;
  id: string;
}

/** A WSL file's place from the helper's answer: the key and `abs` are the ref of the real Linux path, `root` the project's ref. */
function wslPlace(root: string, real: string, rel: string): Place {
  const loc = wslLocOf(root)!;
  const abs = refOf({ kind: 'wsl', distro: loc.distro, linuxPath: real });
  return { key: keyOf(abs), abs, root, rel };
}

export class LiveFiles {
  readonly #byKey = new Map<string, LiveFile>();
  readonly #byId = new Map<string, LiveFile>();
  readonly #storeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #checking = new Set<string>();
  #tick: ReturnType<typeof setInterval> | null = null;
  #ticks = 0;
  #feed: { instance: string; seq: number } | null = null;
  #feeding = false;
  #off: (() => void) | null = null;
  /** The last note per file (one line per file, newest ranges only). */
  readonly #noted = new Map<string, string>();
  /** Closed files kept only for their undo history (stored, not in memory): key -> where. */
  readonly #history = new Map<string, Kept>();
  readonly timing: typeof LIVE_TIMING;

  constructor(readonly host: LiveFilesHost, timing: Partial<typeof LIVE_TIMING> = {}) {
    this.timing = { ...LIVE_TIMING, ...timing };
  }

  get storeDir(): string {
    return osp.join(this.host.stateDir, 'editor-live');
  }

  /** Load the stored files, start the poll and listen for landings. */
  start(): void {
    this.#off = onFilesChanged((e) => this.touched(e));
    this.#loadStored();
    this.#tick = setInterval(() => this.#onTick(), this.timing.tickMs);
    Deno.unrefTimer(this.#tick);
  }

  /** Stop, and write every unsaved file to the store now (quitting never asks "Save changes?"). */
  close(): void {
    this.#off?.();
    this.#off = null;
    if (this.#tick !== null) clearInterval(this.#tick);
    this.#tick = null;
    for (const t of this.#storeTimers.values()) clearTimeout(t);
    this.#storeTimers.clear();
    for (const lf of this.#byId.values()) {
      lf.refreshDirty();
      this.#store(lf);
      lf.destroy();
    }
    this.#byId.clear();
    this.#byKey.clear();
  }

  get(id: string): LiveFile | null {
    return this.#byId.get(id) ?? null;
  }

  all(): LiveFile[] {
    return [...this.#byId.values()];
  }

  // ---- open -------------------------------------------------------------------------------------------------------------
  /** Open `rel` in folder `root` for editing: the live file, or why it opens read-only (with what the disk is). */
  open(root: string, rel: unknown): { file: LiveFile } | { refused: PlaceRefusal | DiskText['reason']; disk?: DiskText } {
    const at = editPlace(this.host.stateDir, root, rel);
    if ('refused' in at) return at;
    const have = this.#byKey.get(at.place.key);
    if (have) return { file: have };
    this.#sweepTemps(at.place.abs);
    const id = sha1(at.place.key).slice(0, 16);
    const kept = this.#history.get(at.place.key) ?? null;
    const { disk, mtime } = readDisk(at.place.abs);
    if (!disk.editable) {
      if (kept) this.#forgetHistory(at.place.key); // the file is no longer text AIB edits: its history ends
      return { refused: disk.reason, disk };
    }
    if (kept) {
      // closed with undo steps: the same lineage again, then what changed on disk meanwhile merges in as the disk's change
      const back = this.#loadHistory(kept);
      if (back) {
        this.#add(back);
        back.takeIn(disk, mtime, '');
        back.refreshDirty();
        return { file: back };
      }
    }
    const lf = new LiveFile(id, at.place, baseOf(disk, mtime), crypto.randomUUID());
    lf.seen = { size: disk.size, mtime };
    this.#add(lf);
    return { file: lf };
  }

  /** open() for any project: a WSL project's file through its distro's helper (the routes use this one). */
  async openFile(root: string, rel: unknown): Promise<{ file: LiveFile } | { refused: PlaceRefusal | DiskText['reason']; disk?: DiskText }> {
    return wslLocOf(root) ? await this.#openWsl(root, rel) : this.open(root, rel);
  }

  async #openWsl(root: string, rel: unknown): Promise<{ file: LiveFile } | { refused: PlaceRefusal | DiskText['reason']; disk?: DiskText }> {
    const parts = safeParts(rel); // the same shape rules as a Windows path (FilesError)
    if (!parts.length) throw new FilesError('Choose a file', 'not_file');
    if (parts[0].toLowerCase() === 'aib-docs') return { refused: 'docs' };
    const asked = { abs: root, root, rel: parts.join('/') };
    let got;
    try {
      got = await wslIo.read(asked, 0, true);
    } catch (error) {
      if (error instanceof WslEditRefused) return { refused: error.code as PlaceRefusal };
      throw error;
    }
    if (got === AWAY) throw new FilesError(`${wslIo.distroOf(asked)} is not running. Open the file again when it is.`, 'wsl_away', 503);
    if (got === 'moving') {
      // being written: one settled read
      const again = await wslIo.read(asked, this.timing.settleMs, true).catch(() => AWAY);
      if (again === AWAY || again === 'moving') throw new FilesError('The file is being written; open it again in a moment.', 'disk_busy', 409);
      got = again;
    }
    if ('gone' in got) throw new FilesError('Not found', 'not_found', 404);
    const place = wslPlace(root, got.real, got.rel);
    if (place.rel.split('/')[0].toLowerCase() === 'aib-docs') return { refused: 'docs' };
    const have = this.#byKey.get(place.key);
    if (have) return { file: have };
    void wslIo.sweep(place);
    const kept = this.#history.get(place.key) ?? null;
    if (!got.disk.editable) {
      if (kept) this.#forgetHistory(place.key);
      return { refused: got.disk.reason, disk: got.disk };
    }
    if (kept) {
      const back = this.#loadHistory(kept);
      if (back) {
        this.#add(back);
        back.takeIn(got.disk, got.mtime, '');
        back.refreshDirty();
        return { file: back };
      }
    }
    const lf = new LiveFile(sha1(place.key).slice(0, 16), place, baseOf(got.disk, got.mtime), crypto.randomUUID());
    lf.seen = { size: got.disk.size, mtime: got.mtime };
    this.#add(lf);
    return { file: lf };
  }

  #add(lf: LiveFile): void {
    this.#history.delete(lf.place.key);
    this.#byKey.set(lf.place.key, lf);
    this.#byId.set(lf.id, lf);
    lf.onChange = () => this.#scheduleStore(lf);
    lf.hub.onDetach = (link) => {
      lf.forget(link);
      if (!lf.hub.socketCount) lf.closedAt = Date.now();
    };
  }

  /** Let go of a file: its text, its store and its undo history. */
  #drop(lf: LiveFile): void {
    this.#release(lf);
    this.#unstore(lf);
  }

  #release(lf: LiveFile): void {
    this.#byKey.delete(lf.place.key);
    this.#byId.delete(lf.id);
    const t = this.#storeTimers.get(lf.id);
    if (t !== undefined) clearTimeout(t);
    this.#storeTimers.delete(lf.id);
    lf.destroy();
  }

  /** A closed file whose text is the disk's but which has undo steps: store it (with them) and let it go from memory. */
  #unload(lf: LiveFile): void {
    if (!this.#store(lf)) return; // not written: keep it in memory rather than lose the history
    this.#release(lf);
    this.#history.set(lf.place.key, { key: lf.place.key, abs: lf.place.abs, root: lf.place.root, rel: lf.place.rel, id: lf.id });
  }

  /** Load a file kept for its history back from the store (null: unreadable, and then forgotten). */
  #loadHistory(k: Kept): LiveFile | null {
    try {
      const s = JSON.parse(Deno.readTextFileSync(this.#storePath(k.root, k.id))) as Stored;
      if (s && s.v === 1 && keyOf(s.place.key) === keyOf(k.key)) {
        const lf = LiveFile.restore(s);
        lf.closedAt = Date.now();
        return lf;
      }
    } catch { /* unreadable: the history is gone, the file opens fresh */ }
    this.#forgetHistory(k.key);
    return null;
  }

  /** The history of a closed file ends (the file was deleted, or is no longer text AIB edits). */
  #forgetHistory(key: string): void {
    const k = this.#history.get(key);
    if (!k) return;
    this.#history.delete(key);
    try {
      Deno.removeSync(this.#storePath(k.root, k.id));
    } catch { /* gone */ }
  }

  /** Leftover save temp files (a crash between write and rename) next to the file, older than a minute. */
  #sweepTemps(abs: string): void {
    void winIo.sweep({ abs, root: '', rel: '' }); // synchronous underneath
  }

  // ---- the page socket and closing views ------------------------------------------------------------------------------------------
  /** Attach a page socket; false when the file is not open here (the page opens it again). */
  attach(id: string, link: WsLink, view: string): boolean {
    const lf = this.#byId.get(id);
    if (!lf) return false;
    lf.attach(link, view);
    return true;
  }

  /**
   * A tab closed. With `discard` ("Don't save"): only when no other view has the file open (another window, the beside pane) is the
   * unsaved text dropped; otherwise only this view closes (review must-fix 5).
   */
  closeView(id: string, view: string, discard: boolean): { closed: true; kept?: boolean; discarded?: boolean } {
    const lf = this.#byId.get(id);
    if (!lf) return { closed: true };
    if (lf.otherViews(view)) return { closed: true, kept: true };
    if (discard) {
      if (lf.hasHistory() && lf.meta.get('disk') === 'ok') {
        // the text goes back to the disk's as one more undo step: opening the file again, Ctrl+Z brings the edits back
        lf.revertToBase();
        lf.closedAt = Date.now();
        this.#scheduleStore(lf, 0);
      } else this.#drop(lf);
      return { closed: true, discarded: true };
    }
    lf.closedAt = Date.now();
    return { closed: true };
  }

  // ---- reading the disk -----------------------------------------------------------------------------------------------------------
  /** A settled read: the stat before, 300 ms later and after the read agree. null when the file is gone; 'moving' while it changes. */
  async readSettled(abs: string): Promise<{ disk: DiskText; mtime: number } | null | 'moving'> {
    return await winIo.readSettled({ abs, root: '', rel: '' }, this.timing.settleMs) as Read | null | 'moving';
  }

  /** A settled read of an open file, on its own disk (a WSL file in its distro; 'away' while the distro is not reachable). */
  #readSettled(place: Place): Promise<Read | null | 'moving' | typeof AWAY> {
    return ioOf(place.abs).readSettled(place, this.timing.settleMs);
  }

  /** Check one file against the disk (in its queue). `hint`: an event named it, so read even when the stat looks the same. */
  check(lf: LiveFile, hint = false): Promise<void> {
    if (this.#checking.has(lf.id)) return Promise.resolve();
    this.#checking.add(lf.id);
    return lf.run(async () => {
      try {
        await this.#checkNow(lf, hint);
      } finally {
        this.#checking.delete(lf.id);
      }
    });
  }

  async #checkNow(lf: LiveFile, hint: boolean): Promise<void> {
    if (!this.#byId.has(lf.id)) return;
    const st = await ioOf(lf.place.abs).stat(lf.place);
    if (st === AWAY) return; // the distro is not reachable: nothing is known, the next poll looks again
    const fresh = st && st.size < 1024 * 1024 && Date.now() - st.mtime < 3000;
    if (st && sameStat(st, lf.seen) && sameStat(st, { size: lf.base.size, mtime: lf.base.mtime }) && !hint && !fresh) return;
    if (!st && lf.meta.get('disk') === 'deleted') return;
    if (await syncPaused(this.host.stateDir, lf.place.root)) return void this.#later(lf, hint); // a landing or Undo is moving the folder
    const got = await this.#readSettled(lf.place);
    if (got === AWAY) return;
    if (got === 'moving') return void this.#later(lf, true);
    if (await syncPaused(this.host.stateDir, lf.place.root)) return void this.#later(lf, true);
    const who = lf.lastWhoNow();
    if (!got) {
      lf.seen = { size: -1, mtime: -1 };
      lf.markDeleted(who);
      return;
    }
    lf.seen = { size: got.disk.size, mtime: got.mtime };
    const before = lf.overlaps.length;
    const r = lf.takeIn(got.disk, got.mtime, who);
    if (r && lf.overlaps.length > before) await this.#noteOverlap(lf, who, lf.lastWho?.chat ?? '');
  }

  #later(lf: LiveFile, hint: boolean): void {
    setTimeout(() => void this.check(lf, hint), this.timing.settleMs * 2);
  }

  /** A "files changed" event (a landing, an Undo, an agent's write): the named open files are read when settled. */
  touched(e: FilesChanged): void {
    for (const p of e.paths) {
      const wsl = this.#wslTouched(e.folder, p);
      if (wsl !== undefined) {
        // a WSL file: the event names a Linux path (a WSL chat's write) or a path in a WSL folder (a landing, an Undo)
        if (wsl) {
          wsl.lastWho = { who: e.who, chat: e.chat ?? '', at: Date.now() };
          void this.check(wsl, true);
        }
        continue;
      }
      const abs = e.folder ? osp.join(e.folder, ...p.split('/')) : p;
      let lf = this.#byKey.get(keyOf(abs));
      if (!lf) {
        try {
          lf = this.#byKey.get(keyOf(osp.realpath(abs)));
        } catch { /* gone */ }
      }
      if (!lf) continue;
      lf.lastWho = { who: e.who, chat: e.chat ?? '', at: Date.now() };
      void this.check(lf, true);
    }
  }

  /**
   * The open WSL file an event path names (null: none is open), or undefined when the path is not a WSL one. A bare Linux path
   * (a WSL chat's write) matches by its Linux path in any distro: the real path or the project folder's path plus `rel`.
   */
  #wslTouched(folder: string, p: string): LiveFile | null | undefined {
    const inFolder = folder ? wslLocOf(folder) : null;
    const direct = !folder ? wslLocOf(p) : null;
    const linux = inFolder ? `${inFolder.linuxPath.replace(/\/+$/, '')}/${p.replace(/^\/+/, '')}` : direct ? direct.linuxPath : p.startsWith('/') && !/^\/\/|^\/[A-Za-z]:/.test(p) && osp.WIN ? p : null;
    if (linux === null) return undefined;
    const distro = inFolder?.distro ?? direct?.distro ?? null;
    for (const lf of this.#byId.values()) {
      const at = wslLocOf(lf.place.abs), root = wslLocOf(lf.place.root);
      if (!at || !root || (distro && at.distro !== distro)) continue;
      if (at.linuxPath === linux || `${root.linuxPath.replace(/\/+$/, '')}/${lf.place.rel}` === linux) return lf;
    }
    return null;
  }

  #onTick(): void {
    this.#ticks++;
    // the history of a closed file ends when the file is deleted (one stat per closed file every few polls)
    if (this.#history.size && (this.#ticks * this.timing.tickMs) % (this.timing.pollMs * 5) === 0) this.#sweepHistory();
    if (!this.#byId.size) return;
    void this.#pollFeed();
    if ((this.#ticks * this.timing.tickMs) % this.timing.pollMs === 0) {
      for (const lf of this.#byId.values()) void this.check(lf);
    }
    // a file no view shows, whose text is the disk's: let go after a grace (a reload reattaches within it); with undo steps it is
    // stored first. A deleted file with nothing unsaved goes with its history.
    const now = Date.now();
    for (const lf of [...this.#byId.values()]) {
      if (lf.hub.socketCount || !lf.closedAt || now - lf.closedAt <= this.timing.closeGraceMs) continue;
      if (lf.isClean()) lf.hasHistory() ? this.#unload(lf) : this.#drop(lf);
      else if (lf.meta.get('disk') === 'deleted' && !lf.isDirty() && lf.overlaps.length === 0) this.#drop(lf);
    }
  }

  /** Closed files kept for their history whose file is gone: the history goes with them. */
  #sweepHistory(): void {
    for (const k of [...this.#history.values()]) {
      if (!wslLocOf(k.abs)) {
        if (!statOf(k.abs)) this.#forgetHistory(k.key);
        continue;
      }
      // a WSL file: only a distro that answers "gone" ends the history (away: nothing is known)
      void wslIo.stat({ abs: k.abs, root: k.root, rel: k.rel }).then((st) => {
        if (st === null && this.#history.get(k.key) === k) this.#forgetHistory(k.key);
      });
    }
  }

  /** The agent host's finished write calls since the last look (host/studio.ts files-changed). */
  async #pollFeed(): Promise<void> {
    if (this.#feeding) return;
    this.#feeding = true;
    try {
      const [status, payload] = await this.host.liveCall('files-changed', { after: this.#feed?.seq ?? 0 });
      if (status !== 200 || !payload || typeof payload !== 'object') return;
      const p = payload as { instance?: string; seq?: number; events?: { seq: number; paths: string[]; who: string; chat: string }[] };
      const instance = String(p.instance ?? '');
      if (!this.#feed || this.#feed.instance !== instance) {
        this.#feed = { instance, seq: Number(p.seq) || 0 }; // the first look (or a new host): only what comes next
        return;
      }
      for (const e of p.events ?? []) {
        this.#feed.seq = Math.max(this.#feed.seq, e.seq);
        this.touched({ folder: '', paths: e.paths, who: e.who, chat: e.chat, kind: 'write' });
      }
    } catch { /* the agent host is away: the stat poll still runs */ } finally {
      this.#feeding = false;
    }
  }

  // ---- saving ---------------------------------------------------------------------------------------------------------------------
  /**
   * Save: wait until the page's last keystrokes have arrived (its state vector, must-fix 5), take the project's pause lock (a landing
   * holds it while it moves the folder: 423 landing_busy, the page retries by itself), check the disk's raw bytes, write atomically.
   * `text` is a test's stand-in for the page's edits. `force`: overwrite a disk version AIB can't edit (the second press).
   */
  async save(id: string, opts: { sv?: Uint8Array | null; text?: string | null; force?: boolean }): Promise<SaveReply> {
    const lf = this.#byId.get(id);
    if (!lf) return { ok: false, status: 404, code: 'not_open', error: 'Open the file first' };
    const reply = await lf.run(async (): Promise<SaveReply> => {
      if (typeof opts.text === 'string') {
        const now = lf.text.toString();
        const e = narrowEdit(now, opts.text);
        lf.doc.transact(() => {
          if (e.to > e.from) lf.text.delete(e.from, e.to - e.from);
          if (e.insert) lf.text.insert(e.from, e.insert);
        }, TEST_PAGE_ORIGIN);
      }
      if (opts.sv && !(await this.#covered(lf, opts.sv))) {
        return { ok: false, status: 409, code: 'behind', error: 'Your last changes are still on their way; saving again.' };
      }
      const lock = pauseLock(this.host.stateDir, lf.place.root, this.timing.saveWaitMs / 1000);
      try {
        await lock.acquire();
      } catch (error) {
        if (!(error instanceof LockTimeout)) throw error;
        const who = await this.#landingTitle(lf.place.root);
        return { ok: false, status: 423, code: 'landing_busy', who, error: `Landing ${who || 'a helper'} · saving when it ends` };
      }
      try {
        const read = async () => {
          for (let i = 0; i < 4; i++) {
            const got = await this.readSettledQuick(lf);
            if (got !== 'moving') return got;
          }
          return 'moving' as const;
        };
        const now = await read();
        if (now === 'moving') return { ok: false, status: 409, code: 'disk_busy', error: 'The file is being written; saving again.' };
        if (now === AWAY) {
          return { ok: false, status: 409, code: 'wsl_away', error: `${wslIo.distroOf(lf.place)} is not reachable. Your text is kept; save again when it is back.` };
        }
        const expect = now ? now.disk.sha : null;
        return await lf.save(() => now, (bytes) => ioOf(lf.place.abs).write(lf.place, bytes, expect), !!opts.force);
      } catch (error) {
        // a WSL save whose check right before the rename found other bytes: read again (the page saves again, and merges)
        if (error instanceof WslHelperError && error.code === 'changed') {
          return { ok: false, status: 409, code: 'disk_busy', error: 'The file is being written; saving again.' };
        }
        const f = saveFailure(error, lf.place.abs);
        return { ok: false, status: 409, ...f };
      } finally {
        lock.release();
      }
    });
    if (reply.ok) {
      this.#scheduleStore(lf, 0);
      void this.#noteSave(lf, reply.ranges);
    }
    return reply;
  }

  /** The save's read: the disk now, settled only when it differs from base (an unchanged file costs one read). */
  async readSettledQuick(lf: LiveFile): Promise<Read | null | 'moving' | typeof AWAY> {
    if (wslLocOf(lf.place.abs)) {
      // a WSL file: one helper read (it carries its own before/after stat); settled only when it differs from base
      const got = await wslIo.readNow(lf.place);
      if (got === null || got === 'moving' || got === AWAY) return got === 'moving' ? await this.#readSettled(lf.place) : got;
      if (got.disk.sha === lf.base.sha) return got;
      return await this.#readSettled(lf.place);
    }
    const st = statOf(lf.place.abs);
    if (!st) return null;
    try {
      const { disk, mtime } = readDisk(lf.place.abs);
      if (disk.sha === lf.base.sha && mtime === st.mtime) return { disk, mtime };
    } catch {
      return 'moving';
    }
    return await this.readSettled(lf.place.abs);
  }

  /** The disk's bytes of an open file now (Compare), null when gone or unreadable. */
  diskBytes(lf: LiveFile): Promise<Uint8Array | null> {
    return ioOf(lf.place.abs).bytes(lf.place);
  }

  /** Wait (up to saveWaitMs) until the page's edits up to its state vector `sv` arrived ("Don't save" after the last keystrokes). */
  covered(id: string, sv: Uint8Array): Promise<boolean> {
    const lf = this.#byId.get(id);
    return lf ? this.#covered(lf, sv) : Promise.resolve(true);
  }

  async #covered(lf: LiveFile, sv: Uint8Array): Promise<boolean> {
    let want: Map<number, number>;
    try {
      want = Y.decodeStateVector(sv);
    } catch {
      return true; // a broken vector: save what is here
    }
    const deadline = Date.now() + this.timing.saveWaitMs;
    while (true) {
      const have = Y.decodeStateVector(Y.encodeStateVector(lf.doc));
      if ([...want].every(([client, clock]) => (have.get(client) ?? 0) >= clock)) return true;
      if (Date.now() > deadline) return false;
      await sleep(20);
    }
  }

  async #landingTitle(folder: string): Promise<string> {
    try {
      const [status, payload] = await this.host.liveCall('folder-chats', { folder });
      const chats = status === 200 && payload && typeof payload === 'object' ? (payload as { chats?: { landing?: string }[] }).chats ?? [] : [];
      return chats.find((c) => c.landing)?.landing ?? '';
    } catch {
      return '';
    }
  }

  // ---- notes to agents ------------------------------------------------------------------------------------------------------------
  async #folderChats(folder: string): Promise<{ id: string; idle: string }[]> {
    try {
      const [status, payload] = await this.host.liveCall('folder-chats', { folder });
      return status === 200 && payload && typeof payload === 'object' ? (payload as { chats?: { id: string; idle: string }[] }).chats ?? [] : [];
    } catch {
      return [];
    }
  }

  async #tell(lf: LiveFile, ids: string[], line: string): Promise<void> {
    const prefix = line.slice(0, line.indexOf(lf.place.rel) + lf.place.rel.length);
    for (const id of new Set(ids)) {
      await this.host.liveCall('prompt-context', { id, line, replace: prefix }).catch(() => {});
    }
  }

  async #noteOverlap(lf: LiveFile, who: string, chat: string): Promise<void> {
    const lines = rangesText(lf.overlapLines());
    const line = `The user has unsaved edits in ${lf.place.rel}, lines ${lines}, which overlap what ${who || 'an agent'} changed. ` +
      "Their text stays in the editor. Don't rewrite those lines; re-read the file after they save.";
    const busy = (await this.#folderChats(lf.place.root)).filter((c) => c.idle && c.idle !== 'the chat is not open').map((c) => c.id);
    await this.#tell(lf, chat ? [chat] : busy, line);
  }

  async #noteSave(lf: LiveFile, ranges: [number, number][]): Promise<void> {
    if (!ranges.length) return;
    const line = `The user edited ${lf.place.rel}, lines ${rangesText(ranges)} (saved); re-read it before changing it.`;
    if (this.#noted.get(lf.id) === line) return;
    this.#noted.set(lf.id, line);
    const ids: string[] = [];
    for (const c of this.host.conversations()) {
      if (!c.id || !(c.writes ?? []).some((w) => keyOf(w) === lf.place.key || this.#wslTouched('', w) === lf)) continue;
      const live = this.host.connectionOf(c.id);
      if (live) ids.push(live);
    }
    for (const c of await this.#folderChats(lf.place.root)) if (c.idle && c.idle !== 'the chat is not open') ids.push(c.id);
    await this.#tell(lf, ids, line);
  }

  // ---- the store ------------------------------------------------------------------------------------------------------------------
  #fileOf(lf: LiveFile): string {
    return this.#storePath(lf.place.root, lf.id);
  }

  #storePath(root: string, id: string): string {
    return osp.join(this.storeDir, sha1(root.toLowerCase()).slice(0, 12), id + '.json');
  }

  #scheduleStore(lf: LiveFile, delay = this.timing.storeMs): void {
    const old = this.#storeTimers.get(lf.id);
    if (old !== undefined && delay > 0) return; // one write per idle second
    if (old !== undefined) clearTimeout(old);
    const t = setTimeout(() => {
      this.#storeTimers.delete(lf.id);
      if (this.#byId.get(lf.id) === lf) this.#store(lf);
    }, delay);
    Deno.unrefTimer(t);
    this.#storeTimers.set(lf.id, t);
  }

  /** Write the file's store now (atomically), or remove it when nothing would be lost. false: it could not be written. */
  #store(lf: LiveFile): boolean {
    if (lf.isClean() && !lf.hasHistory()) {
      this.#unstore(lf);
      return true;
    }
    const path = this.#fileOf(lf);
    try {
      Deno.mkdirSync(osp.dirname(path), { recursive: true });
      const bytes = new TextEncoder().encode(JSON.stringify(lf.snapshot()));
      // sync on purpose: close() runs while the process ends
      const tmp = path + '.' + crypto.randomUUID().slice(0, 8) + '.tmp';
      const f = Deno.openSync(tmp, { write: true, createNew: true });
      try {
        let at = 0;
        while (at < bytes.length) at += f.writeSync(bytes.subarray(at));
        f.syncSync();
      } finally {
        f.close();
      }
      Deno.renameSync(tmp, path);
      return true;
    } catch (error) {
      console.error('Could not keep the unsaved text of', lf.place.rel, error);
      return false;
    }
  }

  #unstore(lf: LiveFile): void {
    try {
      Deno.removeSync(this.#fileOf(lf));
    } catch { /* not stored */ }
  }

  /** Stored files whose folder is `root` (the project's removal drops them; tests). */
  stored(root?: string): Stored[] {
    const out: Stored[] = [];
    try {
      for (const dir of Deno.readDirSync(this.storeDir)) {
        if (!dir.isDirectory) continue;
        for (const f of Deno.readDirSync(osp.join(this.storeDir, dir.name))) {
          if (!f.isFile || !f.name.endsWith('.json')) continue;
          try {
            const s = JSON.parse(Deno.readTextFileSync(osp.join(this.storeDir, dir.name, f.name))) as Stored;
            if (s && s.v === 1 && (!root || keyOf(s.place.root) === keyOf(root))) out.push(s);
          } catch { /* a broken store file is left as it is */ }
        }
      }
    } catch { /* no store yet */ }
    return out;
  }

  /** A project was removed from AIB (desktop/project_delete.ts): its stored unsaved text goes with it. */
  forgetProject(root: string): void {
    for (const lf of [...this.#byId.values()]) if (keyOf(lf.place.root) === keyOf(root)) this.#drop(lf);
    for (const k of [...this.#history.values()]) if (keyOf(k.root) === keyOf(root)) this.#history.delete(k.key);
    for (const s of this.stored(root)) {
      try {
        Deno.removeSync(osp.join(this.storeDir, sha1(s.place.root.toLowerCase()).slice(0, 12), s.id + '.json'));
      } catch { /* gone */ }
    }
  }

  #loadStored(): void {
    for (const s of this.stored()) {
      if (this.#byKey.has(s.place.key)) continue;
      if (s.unsaved === false) {
        // kept only for its undo history: loaded when the file is opened again; a deleted file's history ends
        const k = { key: s.place.key, abs: s.place.abs, root: s.place.root, rel: s.place.rel, id: s.id };
        this.#history.set(k.key, k);
        if (!wslLocOf(k.abs) && !statOf(k.abs)) this.#forgetHistory(k.key); // a WSL file: the history sweep asks its distro later
        continue;
      }
      let lf: LiveFile;
      try {
        lf = LiveFile.restore(s);
      } catch {
        continue;
      }
      lf.closedAt = Date.now();
      this.#add(lf);
      // the restore merge: what changed on disk while AIB was closed merges in like any disk change
      void lf.run(async () => {
        const got = await this.#readSettled(lf.place);
        if (got === AWAY) return void lf.markRestored(s.at, false); // a WSL file whose distro is away: the poll merges it later
        const changed = got !== 'moving' && (!got || got.disk.sha !== lf.base.sha);
        if (got && got !== 'moving') lf.takeIn(got.disk, got.mtime, '');
        else if (got === null) lf.markDeleted('');
        lf.markRestored(s.at, changed);
      });
    }
  }
}

/** The routes' answer for a refused open (the page's read-only footer and its button). */
export const REFUSED_TEXT: Record<PlaceRefusal, string> = {
  worktree: "Read-only: a helper's or subagent's copy",
  docs: 'Read-only: AIB docs are edited in Docs',
  data: "Read-only: AIB's own data",
  blocked: 'Read-only: this folder holds sign-ins',
};
