/**
 * One open file's live text in the web server (aib-shared/designs/file-editor/file-editor-design-v2.md, section 2 and 4; architect review
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
 * same thing live and the store keeps them.
 *
 * Undo history (owner 2026-11-17: "I want the undo/redo history to persist across the closing of a file"). The person's history
 * lives HERE, next to the Y.Doc, not in the page: one Y.UndoManager per file that tracks only the page sockets' edits (and a
 * "Don't save" revert), never the disk's (FILE_ORIGIN) or AIB's bookkeeping, so Ctrl+Z never takes an agent's change back. The page
 * sends {type: 'undo' | 'redo'} over the file socket and gets {type: 'undone', at} back (where to put the caret). Because the history
 * is the server's, it outlives closing the tab, a reload, and moving to another window. For a restart it is stored with the Y update
 * (the same lineage, so the Yjs item ids in it still mean the same text): each step as two Yjs delete sets (what it inserted, what it
 * deleted), the way y-prosemirror and Yjs' own UndoManager describe a step, plus the `redone` links Yjs keeps only in memory. Deleted
 * text a step can bring back is kept from Yjs' GC (UndoManager's keepItem; on restore, the doc's gcFilter); everything else is
 * collected when the file is loaded again. At most UNDO_LIMIT steps each way, oldest dropped first; dropping never touches the text.
 */
import * as Y from 'yjs';
import { YSocketHub } from '../live/ysocket.ts';
import { decodeDisk, type DiskText, encodeText, type Eol, sha256 } from './file_text.ts';
import { changedRanges, merge3, type MergeResult, narrowEdit } from './line_merge.ts';
import type { WsLink } from '../platform/websocket.ts';

/** The disk's changes merged into the live text. */
export const FILE_ORIGIN = { kind: 'file' } as const;
/** AIB's own bookkeeping (meta, overlaps). */
export const SERVER_ORIGIN = { kind: 'server' } as const;
/** A test's stand-in for a page edit (the save route's `text` fallback). */
export const TEST_PAGE_ORIGIN = { kind: 'page-test' } as const;
/** "Don't save" in the last view of a file with history: the text goes back to the disk's as one undoable step. */
export const REVERT_ORIGIN = { kind: 'revert' } as const;
/** Undo steps kept per file (and redo steps), oldest dropped first. */
export const UNDO_LIMIT = 500;

/** A Yjs delete set as stored: [client, [clock, len, clock, len, ...]][]. */
export type StoredSet = [number, number[]][];
export interface StoredHistory {
  v: 1;
  /** Oldest first, like Y.UndoManager's stacks. i: what the step inserted; d: what it deleted. */
  undo: { i: StoredSet; d: StoredSet }[];
  redo: { i: StoredSet; d: StoredSet }[];
  /** Yjs' in-memory `redone` links of items the stacks name: [client, clock, len, redoneClient, redoneClock]. */
  redone: [number, number, number, number, number][];
}
type Step = { insertions: DeleteSet; deletions: DeleteSet; meta: Map<unknown, unknown> };
type DeleteSet = ReturnType<typeof Y.createDeleteSet>;
type Ranges = Map<number, number[]>;

const setOut = (ds: DeleteSet): StoredSet =>
  [...ds.clients].map(([client, items]) => [client, items.flatMap((d) => [d.clock, d.len])] as [number, number[]]).filter(([, f]) => f.length > 0);
function setIn(s: StoredSet): DeleteSet {
  const ds = Y.createDeleteSet();
  for (const [client, flat] of s) {
    const items: { clock: number; len: number }[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i + 1] > 0) items.push({ clock: flat[i], len: flat[i + 1] });
    items.sort((a, b) => a.clock - b.clock);
    if (items.length) ds.clients.set(client, items as never);
  }
  return ds;
}
/** Every clock range the given steps name (client -> [clock, len, ...]), to keep their deleted text and their redone links. */
function rangesOf(sets: StoredSet[]): Ranges {
  const out: Ranges = new Map();
  for (const s of sets) {
    for (const [client, flat] of s) {
      const have = out.get(client) ?? [];
      have.push(...flat);
      out.set(client, have);
    }
  }
  return out;
}
const touches = (r: Ranges, client: number, clock: number, len: number): boolean => {
  const flat = r.get(client);
  if (!flat) return false;
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i] < clock + len && clock < flat[i] + flat[i + 1]) return true;
  return false;
};

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
  /** The person's undo history (absent in stores written before it existed). */
  history?: StoredHistory;
  /** false: kept only for its history (the text is the disk's); loaded when the file is opened again, not at start. */
  unsaved?: boolean;
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

  /** The person's undo history of this file (see the header): every page socket's edits, never the disk's. */
  readonly undo: Y.UndoManager;

  constructor(
    readonly id: string,
    readonly place: Place,
    base: Base,
    readonly lineage: string,
    state: Uint8Array | null = null,
    history: StoredHistory | null = null,
  ) {
    this.doc = new Y.Doc();
    const kept = state && history ? rangesOf([...history.undo, ...history.redo].map((s) => s.d)) : null;
    // loading: deleted text only the stored steps can bring back stays; the rest is collected now (Yjs GC)
    if (kept) this.doc.gcFilter = (item: Y.Item) => !touches(kept, item.id.client, item.id.clock, item.length);
    if (state) Y.applyUpdate(this.doc, state, SERVER_ORIGIN);
    this.doc.gcFilter = () => true;
    this.text = this.doc.getText('file');
    this.meta = this.doc.getMap('meta');
    this.overlaps = this.doc.getArray('overlaps');
    this.undo = new Y.UndoManager(this.text, { trackedOrigins: new Set<unknown>([TEST_PAGE_ORIGIN, REVERT_ORIGIN]) });
    this.undo.on('stack-item-added', () => this.#trim());
    if (state && history) this.#restoreHistory(history);
    this.base = base;
    if (!state) {
      this.doc.transact(() => {
        this.text.insert(0, base.text);
        this.#setMeta({ disk: 'ok', dirty: false });
      }, SERVER_ORIGIN);
    }
    this.#setMeta({ sha: base.sha, eol: base.eolKind, bom: base.bom, encoding: base.encoding });
    this.hub = new YSocketHub(this.doc);
    this.hub.onControl = (link, m) => {
      if (m.type !== 'undo' && m.type !== 'redo') return;
      const r = this.step(m.type);
      link.send(JSON.stringify({ type: 'undone', id: m.id ?? null, op: m.type, ok: r.ok, at: r.at }));
    };
    this.doc.on('afterTransaction', (tr: Y.Transaction) => {
      if (tr.changed.has(this.text as unknown as Y.AbstractType<Y.YEvent<Y.Text>>)) this.#scheduleDirty();
      if (tr.changed.size) this.onChange?.();
    });
  }

  static restore(s: Stored): LiveFile {
    const h = s.history && s.history.v === 1 && Array.isArray(s.history.undo) && Array.isArray(s.history.redo) ? s.history : null;
    return new LiveFile(s.id, s.place, s.base, s.lineage, unb64(s.update), h);
  }

  snapshot(): Stored {
    return {
      v: 1,
      id: this.id,
      lineage: this.lineage,
      place: this.place,
      base: this.base,
      update: b64(Y.encodeStateAsUpdate(this.doc)),
      at: Date.now(),
      history: this.history(),
      unsaved: !this.isClean(),
    };
  }

  // ---- undo history ---------------------------------------------------------------------------------------------------------------
  /** Steps to undo or redo are kept. */
  hasHistory(): boolean {
    return this.undo.undoStack.length > 0 || this.undo.redoStack.length > 0;
  }

  /** Undo or redo one step of the person's edits. `at`: the text offset after the last change it made (the page's caret), or -1. */
  step(kind: 'undo' | 'redo'): { ok: boolean; at: number } {
    let at = -1;
    const watch = (ev: Y.YTextEvent, tr: Y.Transaction) => {
      if (tr.origin !== this.undo) return;
      let pos = 0;
      for (const d of ev.delta) {
        if (typeof d.retain === 'number') pos += d.retain;
        else if (typeof d.insert === 'string') at = pos += d.insert.length;
        else if (typeof d.delete === 'number') at = pos;
      }
    };
    this.text.observe(watch);
    let done: unknown = null;
    try {
      done = kind === 'undo' ? this.undo.undo() : this.undo.redo();
    } finally {
      this.text.unobserve(watch);
      this.undo.stopCapturing(); // the next keystroke is a step of its own
    }
    return { ok: done != null, at };
  }

  /** The history as stored (see StoredHistory). */
  history(): StoredHistory {
    const steps = (stack: Step[]) => stack.map((s) => ({ i: setOut(s.insertions), d: setOut(s.deletions) }));
    const undo = steps(this.undo.undoStack as unknown as Step[]), redo = steps(this.undo.redoStack as unknown as Step[]);
    const named = rangesOf([...undo, ...redo].flatMap((s) => [s.i, s.d]));
    const redone: StoredHistory['redone'] = [];
    if (named.size) {
      for (const [client, structs] of this.doc.store.clients) {
        if (!named.has(client)) continue;
        for (const st of structs) {
          if (st instanceof Y.Item && st.redone && touches(named, client, st.id.clock, st.length)) {
            redone.push([client, st.id.clock, st.length, st.redone.client, st.redone.clock]);
          }
        }
      }
    }
    return { v: 1, undo, redo, redone };
  }

  /** Put a stored history back (the constructor, after the update). A step that names text this doc lacks drops the history. */
  #restoreHistory(h: StoredHistory): void {
    const store = this.doc.store;
    const valid = (s: StoredSet) =>
      Array.isArray(s) && s.every(([client, flat]) => {
        const end = Y.getState(store, client);
        for (let i = 0; i + 1 < flat.length; i += 2) if (!(flat[i] >= 0 && flat[i + 1] >= 0 && flat[i] + flat[i + 1] <= end)) return false;
        return true;
      });
    const all = [...h.undo, ...h.redo];
    if (!all.every((s) => s && valid(s.i) && valid(s.d))) return; // another lineage's history: start empty, the text is untouched
    const make = (s: { i: StoredSet; d: StoredSet }): Step => ({ insertions: setIn(s.i), deletions: setIn(s.d), meta: new Map() });
    const undo = h.undo.slice(-UNDO_LIMIT).map(make), redo = h.redo.slice(-UNDO_LIMIT).map(make);
    try {
      this.doc.transact((tr) => {
        for (const s of [...undo, ...redo]) {
          // what Y.UndoManager does for its own steps: deleted text a step can bring back is never collected
          Y.iterateDeletedStructs(tr, s.deletions, (st) => {
            if (st instanceof Y.Item) st.keep = true;
          });
        }
        for (const [client, clock, len, rc, rclock] of Array.isArray(h.redone) ? h.redone : []) {
          if (!(len > 0) || clock + len > Y.getState(store, client) || rclock >= Y.getState(store, rc)) continue;
          Y.getItemCleanStart(tr, Y.createID(client, clock));
          Y.getItemCleanEnd(tr, store, Y.createID(client, clock + len - 1));
          const it = Y.getItem(store, Y.createID(client, clock));
          if (it instanceof Y.Item && it.id.clock === clock && it.length === len) it.redone = Y.createID(rc, rclock);
        }
      }, SERVER_ORIGIN);
    } catch {
      return; // never risk the text for the history
    }
    this.undo.undoStack = undo as never;
    this.undo.redoStack = redo as never;
  }

  /** Keep at most UNDO_LIMIT steps each way: the oldest go (the text is never touched). */
  #trim(): void {
    for (const stack of [this.undo.undoStack, this.undo.redoStack]) if (stack.length > UNDO_LIMIT) stack.splice(0, stack.length - UNDO_LIMIT);
  }

  /**
   * "Don't save" in the last view of a file with history: the text goes back to the disk version it took in, as one undo step of
   * its own, so Ctrl+Z after opening it again brings the dropped edits back. Overlaps are answered (the disk's text is taken).
   */
  revertToBase(): void {
    const e = narrowEdit(this.text.toString(), this.base.text);
    this.undo.stopCapturing();
    if (e.to > e.from || e.insert) {
      this.doc.transact(() => {
        if (e.to > e.from) this.text.delete(e.from, e.to - e.from);
        if (e.insert) this.text.insert(e.from, e.insert);
      }, REVERT_ORIGIN);
    }
    this.undo.stopCapturing();
    if (this.overlaps.length) this.doc.transact(() => this.overlaps.delete(0, this.overlaps.length), SERVER_ORIGIN);
    this.refreshDirty();
  }

  /** A page socket went: its edits are no longer tracked (the history it made stays). */
  forget(link: WsLink): void {
    this.undo.removeTrackedOrigin(link);
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
    this.undo.addTrackedOrigin(link); // the person's typing (every window, the beside pane, a paired computer): one history
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
      // checked: the state this dirty flag answers (a page clears its own "typed, not yet confirmed" flag once it covers its edits)
      this.#setMeta({ dirty: text !== this.base.text, checked: Y.encodeStateVector(this.doc) });
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
    this.undo.destroy();
    this.doc.destroy();
  }
}
