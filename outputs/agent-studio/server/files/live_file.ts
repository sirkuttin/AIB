/**
 * One open file's live text in the web server (private/designs/file-editor/file-editor-design-v2.md, section 2 and 4; architect review
 * 2026-11-16). The file is a Y.Text that every editor (tab, beside pane, other window) syncs with over the page-only file socket
 * (server/live/ysocket.ts). The disk is the meeting point: agents write the file with their own tools, and AIB merges afterwards.
 *
 *   base       the disk version the live text last took in: its text, raw sha, line ending and BOM. A save writes the live text with
 *              base's line ending and BOM (must-fix 8), and only if the disk's raw bytes still hash to base's sha.
 *   dirty      text !== base.text, computed, never a flag a save clears (must-fix 5).
 *   takeIn     a new disk version merges in as the FILE origin (files/line_merge.ts: by line, time-boxed, code-point safe). The user's
 *              lines are never overwritten; a disk change that touches them is left out and becomes an overlap (a gutter marker and
 *              "1 overlap · Compare" on the page). A disk version AIB can't edit (binary, UTF-16, not UTF-8, over 5 MB, lone CR) is
 *              never merged: the text stays, and a save needs a second press ("Save overwrites").
 *   queue      every piece of work on this file (a poll's take-in, a save, a landing's touch, a restore) runs in one serial queue
 *              (must-fix 4), so a save's new base is in place before the next poll looks.
 * The Y.Doc also holds `meta` (what the footer shows: saved at, updated by, disk state) and `overlaps`, so every window sees the
 * same thing live and the store keeps them. Undo stays per author: the page's undo manager tracks only its own editor origin.
 */
import * as Y from 'yjs';
import { YSocketHub } from '../live/ysocket.ts';
import { decodeDisk, type DiskText, encodeText, type Eol, sha256 } from './file_text.ts';
import { changedRanges, merge3, type MergeResult } from './line_merge.ts';
import type { WsLink } from '../platform/websocket.ts';

/** The disk's changes merged into the live text. */
export const FILE_ORIGIN = { kind: 'file' } as const;
/** AIB's own bookkeeping (meta, overlaps). */
export const SERVER_ORIGIN = { kind: 'server' } as const;
/** A test's stand-in for a page edit (the save route's `text` fallback). */
export const TEST_PAGE_ORIGIN = { kind: 'page-test' } as const;

export interface Base {
  text: string;
  sha: string;
  /** The ending a save writes ('lf' | 'crlf'), and the file's own kind (the footer: LF, CRLF, Mixed). */
  eol: 'lf' | 'crlf';
  eolKind: Eol;
  bom: boolean;
  encoding: string;
  mtime: number;
  size: number;
}

export interface Place {
  /** The registry key: the real path, case-folded on Windows. */
  key: string;
  /** The real path a save writes (a link's target, inside the root). */
  abs: string;
  /** The project folder (resolved) and the path inside it ('/'). */
  root: string;
  rel: string;
}

export interface Stored {
  v: 1;
  id: string;
  lineage: string;
  place: Place;
  base: Base;
  /** Y.encodeStateAsUpdate, base64. */
  update: string;
  at: number;
}

export interface OverlapRecord {
  id: string;
  from: Uint8Array; // Y relative positions (encoded)
  to: Uint8Array;
  theirs: string;
  who: string;
  at: number;
}

export type SaveReply =
  | { ok: true; sha: string; mtime: number; ranges: [number, number][] }
  | { ok: false; status: number; code: string; error: string; overlaps?: number; who?: string };

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export function baseOf(disk: DiskText, mtime: number): Base {
  return {
    text: disk.text ?? '',
    sha: disk.sha,
    eol: disk.majority,
    eolKind: disk.eol,
    bom: disk.bom,
    encoding: disk.encoding,
    mtime,
    size: disk.size,
  };
}

export class LiveFile {
  readonly doc: Y.Doc;
  readonly text: Y.Text;
  /** What every window shows: sha, eol, bom, encoding, savedAt, updatedBy, updatedAt, disk ('ok' | 'deleted' | 'unmergeable'), ... */
  readonly meta: Y.Map<unknown>;
  readonly overlaps: Y.Array<OverlapRecord>;
  readonly hub: YSocketHub;
  base: Base;
  /** A disk version AIB can't edit that came after base: {sha, reason}; a save then needs force. */
  foreign: { sha: string; reason: string } | null = null;
  /** The last write event naming this file (attribution: "Updated by …" when it is recent). */
  lastWho: { who: string; chat: string; at: number } | null = null;
  /** Called after any change to the text or meta (the registry saves the store on idle). */
  onChange: (() => void) | null = null;
  /** The last stat the poll saw, so an unchanged file costs one stat. */
  seen = { size: -1, mtime: -1 };
  closedAt = 0;
  #queue: Promise<unknown> = Promise.resolve();
  #dirtyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly id: string, readonly place: Place, base: Base, readonly lineage: string, state: Uint8Array | null = null) {
    this.doc = new Y.Doc();
    if (state) Y.applyUpdate(this.doc, state, SERVER_ORIGIN);
    this.text = this.doc.getText('file');
    this.meta = this.doc.getMap('meta');
    this.overlaps = this.doc.getArray('overlaps');
    this.base = base;
    if (!state) {
      this.doc.transact(() => {
        this.text.insert(0, base.text);
        this.#setMeta({ disk: 'ok', dirty: false });
      }, SERVER_ORIGIN);
    }
    this.#setMeta({ sha: base.sha, eol: base.eolKind, bom: base.bom, encoding: base.encoding });
    this.hub = new YSocketHub(this.doc);
    this.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.has(this.text as unknown as Y.AbstractType<Y.YEvent<Y.Text>>)) this.#scheduleDirty();
      if (tr.changed.size) this.onChange?.();
    });
  }

  static restore(s: Stored): LiveFile {
    return new LiveFile(s.id, s.place, s.base, s.lineage, unb64(s.update));
  }

  snapshot(): Stored {
    return { v: 1, id: this.id, lineage: this.lineage, place: this.place, base: this.base, update: b64(Y.encodeStateAsUpdate(this.doc)), at: Date.now() };
  }

  /** Run `work` after every earlier piece of work on this file (one at a time). */
  run<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => {});
    return next;
  }

  isDirty(): boolean {
    return this.text.toString() !== this.base.text;
  }

  /** Nothing would be lost by dropping this file: the text is the disk's, no overlap is open, the disk is in a normal state. */
  isClean(): boolean {
    return !this.isDirty() && this.overlaps.length === 0 && this.meta.get('disk') === 'ok';
  }

  /** The page's editors: true when one is open besides `exceptView`. */
  otherViews(exceptView: string): boolean {
    return this.hub.tags().some((t) => t !== exceptView);
  }

  attach(link: WsLink, view: string): void {
    this.closedAt = 0;
    link.send(JSON.stringify({ type: 'hello', file: this.id, lineage: this.lineage }));
    this.hub.attach(link, view);
  }

  #setMeta(fields: Record<string, unknown>): void {
    const apply = () => {
      for (const [k, v] of Object.entries(fields)) if (this.meta.get(k) !== v) this.meta.set(k, v);
    };
    // inside a transaction already (the constructor's) or a new one as AIB's own origin
    if (this.doc._transaction) apply();
    else this.doc.transact(apply, SERVER_ORIGIN);
  }

  #scheduleDirty(): void {
    if (this.#dirtyTimer !== null) return;
    this.#dirtyTimer = setTimeout(() => {
      this.#dirtyTimer = null;
      this.refreshDirty();
    }, 120);
  }

  /** Recompute dirty (and close overlaps whose lines now equal the disk's: the user took theirs in Compare). */
  refreshDirty(): void {
    if (this.#dirtyTimer !== null) {
      clearTimeout(this.#dirtyTimer);
      this.#dirtyTimer = null;
    }
    const text = this.text.toString();
    const gone: number[] = [];
    this.overlaps.forEach((o, i) => {
      const r = this.overlapRange(o);
      if (!r || text.slice(r.from, r.to) === o.theirs) gone.push(i);
    });
    this.doc.transact(() => {
      for (let i = gone.length - 1; i >= 0; i--) this.overlaps.delete(gone[i], 1);
      this.#setMeta({ dirty: text !== this.base.text });
    }, SERVER_ORIGIN);
  }

  /** An overlap's place in the text now ({from, to} UTF-16 offsets), or null when its text is gone. */
  overlapRange(o: OverlapRecord): { from: number; to: number } | null {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(o.from), this.doc);
    const b = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(o.to), this.doc);
    if (!a || !b) return null;
    return { from: a.index, to: Math.max(a.index, b.index) };
  }

  /** The overlaps as 1-based line ranges of the text now (the notes to agents, tests). */
  overlapLines(): [number, number][] {
    const text = this.text.toString();
    const lineOf = (pos: number) => {
      let n = 1;
      for (let i = text.indexOf('\n'); i >= 0 && i < pos; i = text.indexOf('\n', i + 1)) n++;
      return n;
    };
    const out: [number, number][] = [];
    this.overlaps.forEach((o) => {
      const r = this.overlapRange(o);
      if (r) out.push([lineOf(r.from), Math.max(lineOf(r.from), lineOf(Math.max(r.from, r.to - 1)))]);
    });
    return out;
  }

  /**
   * Take a new disk version in (call inside run()). An editable one merges (line_merge.ts); one AIB can't edit is kept out. `who`:
   * the writer's name when known. Returns the merge, or null when nothing merged.
   */
  takeIn(disk: DiskText, mtime: number, who: string, at = Date.now()): MergeResult | null {
    this.seen = { size: disk.size, mtime };
    if (disk.sha === this.base.sha) {
      this.base.mtime = mtime;
      this.foreign = null;
      if (this.meta.get('disk') !== 'ok') this.#setMeta({ disk: 'ok', diskReason: '' });
      return null;
    }
    if (!disk.editable || disk.text === null) {
      // must-fix 8: never merged; the user's text stays and a save asks for a second press
      this.foreign = { sha: disk.sha, reason: disk.reason };
      this.#setMeta({ disk: 'unmergeable', diskReason: disk.reason, updatedBy: who, updatedAt: at });
      return null;
    }
    const mine = this.text.toString();
    const r = merge3(this.base.text, mine, disk.text);
    this.doc.transact(() => {
      for (let i = r.edits.length - 1; i >= 0; i--) {
        const e = r.edits[i];
        if (e.to > e.from) this.text.delete(e.from, e.to - e.from);
        if (e.insert) this.text.insert(e.from, e.insert);
      }
      for (const o of r.overlaps) {
        const from = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, o.from, 0));
        const to = Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(this.text, o.to, -1));
        this.overlaps.push([{ id: crypto.randomUUID().slice(0, 8), from, to, theirs: o.theirs, who, at }]);
      }
    }, FILE_ORIGIN);
    this.base = baseOf(disk, mtime);
    this.foreign = null;
    this.doc.transact(() => {
      this.#setMeta({
        sha: disk.sha,
        eol: disk.eol,
        bom: disk.bom,
        encoding: disk.encoding,
        disk: 'ok',
        diskReason: '',
        updatedBy: who,
        updatedAt: at,
        rewrite: r.rewrite || this.overlaps.length > 3,
        fallback: r.fallback,
      });
    }, SERVER_ORIGIN);
    this.refreshDirty();
    return r;
  }

  /** The file is gone from disk (two reads apart): a delete is an overlap with everything; Save writes it again. */
  markDeleted(who: string, at = Date.now()): void {
    if (this.meta.get('disk') === 'deleted') return;
    this.#setMeta({ disk: 'deleted', diskReason: '', updatedBy: who, updatedAt: at });
  }

  /**
   * Save (call inside run(), after the page's last keystrokes arrived): write the live text with base's line ending and BOM, only when
   * the disk still has base (raw-byte sha). `readDisk` and `write` are the registry's (locks, atomic write, error words).
   */
  async save(
    readDisk: () => { disk: DiskText; mtime: number } | null,
    write: (bytes: Uint8Array) => Promise<number>,
    force: boolean,
    who = '',
  ): Promise<SaveReply> {
    const now = readDisk();
    const state = this.meta.get('disk');
    if (!now) {
      if (state !== 'deleted') {
        this.markDeleted(who);
        return { ok: false, status: 409, code: 'deleted', error: 'This file was deleted on disk. Save again to write it back.' };
      }
    } else if (now.disk.sha !== this.base.sha) {
      if (!now.disk.editable || now.disk.text === null) {
        if (!force || !this.foreign || this.foreign.sha !== now.disk.sha) {
          this.takeIn(now.disk, now.mtime, who);
          return {
            ok: false,
            status: 409,
            code: 'unmergeable',
            error: 'The file changed on disk to a form AIB can\'t edit. Save again to overwrite it with your text.',
          };
        }
      } else {
        // the disk moved on: merge it in first; with no overlap the save goes on, with one the user sees it and saves again
        const before = this.overlaps.length;
        this.takeIn(now.disk, now.mtime, who || this.lastWhoNow());
        if (this.overlaps.length > before) {
          return {
            ok: false,
            status: 409,
            code: 'merged',
            overlaps: this.overlaps.length,
            error: 'The file changed on disk. Its changes are merged in; some touch lines you edited. Save again to keep yours.',
          };
        }
      }
    }
    const text = this.text.toString();
    const bytes = encodeText(text, this.base.eol, this.base.bom);
    const mtime = await write(bytes);
    const ranges = changedRanges(this.base.text, text);
    const sha = sha256(bytes);
    const fresh = decodeDisk(bytes);
    this.base = { ...baseOf(fresh, mtime), eol: this.base.eol, eolKind: fresh.eol === 'none' ? this.base.eolKind : fresh.eol };
    this.seen = { size: bytes.length, mtime };
    this.foreign = null;
    this.doc.transact(() => {
      if (this.overlaps.length) this.overlaps.delete(0, this.overlaps.length); // "keep mine": the overlaps are answered
      this.#setMeta({ sha, savedAt: Date.now(), disk: 'ok', diskReason: '', rewrite: false, eol: this.base.eolKind, bom: this.base.bom });
    }, SERVER_ORIGIN);
    this.refreshDirty();
    return { ok: true, sha, mtime, ranges };
  }

  /** The writer's name when a write event named this file in the last 10 s, else ''. */
  lastWhoNow(now = Date.now()): string {
    return this.lastWho && now - this.lastWho.at < 10_000 ? this.lastWho.who : '';
  }

  /** Mark the text as restored from the store (the footer: "Restored unsaved edits from 14:02"). */
  markRestored(at: number, changedWhileClosed: boolean): void {
    this.#setMeta({ restoredAt: at, changedWhileClosed });
  }

  destroy(): void {
    if (this.#dirtyTimer !== null) clearTimeout(this.#dirtyTimer);
    this.#dirtyTimer = null;
    this.hub.destroy(4404, 'file closed');
    this.doc.destroy();
  }
}
