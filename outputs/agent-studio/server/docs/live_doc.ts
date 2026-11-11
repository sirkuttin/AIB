/**
 * One live doc in AIB's server: a Y.Doc that every open editor syncs with (y-protocols sync + awareness over a WebSocket), and the
 * guarded agent operations Claude Docs gives its agents (read, changes, edit, undo).
 *
 * Blocks. Every element of the doc except inline atoms is a block with an id (its Yjs id). Leaves (paragraph, heading, code block,
 * placeholder, rule, raw block) hash their content; containers (list, item, quote, table, row, cell) hash their type, attributes and
 * direct child ids, so typing inside an item leaves the list's `h` alone (as in Claude Docs).
 *
 * Revisions. `rev` goes up by one for every transaction that changed a block (a keystroke from the page, an agent's call, a file
 * edit, an undo). Each block keeps `rev` (when it last changed itself), `sub` (when anything inside it last changed) and `born`.
 * Only the blocks a transaction touched are looked at again (per-block dirty tracking from Yjs' changed types), so a keystroke in a
 * 2,000-block doc rehashes one block. Deleted blocks are remembered as gone, so doc_changes can say so.
 *
 * Guards. A whole-block replace/delete/move/set carries ifHash (its h) + ifRev (the rev of the read that showed it): it is refused
 * when the block, or anything inside it, changed after that rev. The user's edit wins; the refusal shows the block as it stands.
 *
 * Who wrote what. Every transaction has an origin: a page socket (the user), an agent's origin object, the file sync, an agent's
 * undo manager. Text an agent writes carries the agentEdit mark with its name. Undo is per author: the page's undo tracks only its
 * own edits; an agent's doc_undo takes back only its own last call, and only if nobody changed those blocks since.
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import {
  applyTextEdits,
  ATOM,
  atomsOf,
  type Attrs,
  diffText,
  FIELD,
  idOf,
  insertNodes,
  jsonOf,
  nodeOf,
  textOf,
  updateNode,
  withMark,
} from './blocks.ts';
import {
  type DocBlock,
  hash8,
  ITEMS,
  LISTS,
  normalize,
  parseBlockMarkdown,
  parseInline,
  type PMJson,
  schema,
  serializeBlock,
  sigOf,
  splitRow,
  TEXTBLOCKS,
} from './markdown.ts';
import type { WsLink } from '../platform/websocket.ts';
import { anyDeleted, Comments } from './comments.ts';

export { FIELD };
// deno-lint-ignore no-explicit-any
type YType = Y.AbstractType<any>;
const MSG_SYNC = 0, MSG_AWARENESS = 1;
export const ROOT = 'root';
const CONTAINERS = new Set([
  'blockquote',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'taskItem',
  'table',
  'tableRow',
  'tableCell',
  'tableHeader',
]);
const CELLS = new Set(['tableCell', 'tableHeader']);
/** Containers that go away with their last child (a list without items, a quote without blocks, a row without cells). */
const EMPTY_GOES = new Set(['blockquote', 'bulletList', 'orderedList', 'taskList', 'table', 'tableRow']);
const MAX_GONE = 5000;

/** Who made a change. One object per author, so Y.UndoManager can track it. */
export interface Origin {
  kind: 'agent' | 'user' | 'file' | 'system';
  name: string;
}

interface Entry {
  id: string;
  el: Y.XmlElement | null;
  parent: string;
  kids: string[] | null;
  h: string;
  /** Leaves: the block's Markdown. */
  md: string;
  rev: number;
  sub: number;
  born: number;
  by?: string;
}

export interface BlockView {
  id: string;
  type: string;
  h: string;
  md?: string;
  kids?: string[];
  attrs?: Attrs;
  parent?: string;
  depth?: number;
  /** Who changed it last: 'user', an agent's name, 'file' (a file tool edited the Markdown copy). */
  by?: string;
}

/** A refused call: nothing changed. `code` mirrors Claude Docs (missing_guard, guard_mismatch, find_none, block_gone, ...). */
export class DocRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
  toJSON(): Record<string, unknown> {
    return { ok: false, code: this.code, message: this.message, ...this.data };
  }
}

export interface Meta {
  rev: number;
  /** id -> [rev, sub, born, by] */
  blocks: Record<string, [number, number, number, string | null]>;
  /** id -> [rev gone, born] */
  gone: Record<string, [number, number]>;
  /** Placeholders an agent planted: id -> intent. */
  pending: Record<string, string>;
}

type Json = Record<string, unknown>;
interface Target {
  kind?: string;
  ids?: unknown;
  text?: unknown;
  nth?: unknown;
}
interface Source {
  from?: { kind?: string; content?: unknown };
  as?: string;
}
export interface Op {
  op: string;
  target: Target;
  side?: string;
  source?: Source;
  with?: Source;
  to?: { target?: Target; side?: string };
  attrs?: Attrs;
  at?: number;
  cells?: unknown;
  ifHash?: unknown;
  ifRev?: unknown;
  force?: boolean;
  /** Let this op remove words a comment thread hangs on (only when the user asked for the change): the thread is detached. */
  allowDetach?: boolean;
}

/** Where ops run: the live doc or the dry-run copy. */
interface Ctx {
  doc: Y.Doc;
  frag: Y.XmlFragment;
  find: (id: string) => Y.XmlElement | null;
  mark: Attrs | null;
  created: string[];
  moved: Record<string, string>;
  planted: Record<string, string>;
  filled: string[];
  touched: Set<Y.XmlFragment>;
}

const OPS = new Set([
  'insert',
  'replace',
  'delete',
  'move',
  'set',
  'table_row_insert',
  'table_row_delete',
  'table_col_insert',
  'table_col_delete',
]);

export class LiveDoc {
  readonly doc: Y.Doc;
  readonly frag: Y.XmlFragment;
  readonly awareness: awarenessProtocol.Awareness;
  /** The doc's comment threads (comments.ts), kept in this Y.Doc. */
  readonly comments: Comments;
  rev: number;
  #entries = new Map<string, Entry>();
  #gone = new Map<string, [number, number]>();
  #pending: Record<string, string>;
  #origins = new Map<string, Origin>();
  #undo = new Map<string, Y.UndoManager>();
  #undoOwner = new Map<Y.UndoManager, string>();
  #calls = new Map<string, { rev: number; ids: string[] }[]>();
  #topCache = new Map<string, { sub: number; json: PMJson; sig: string }>();
  #sockets = new Map<WsLink, { clients: Set<number> }>();
  readonly system: Origin = { kind: 'system', name: 'system' };
  /** Counts for tests: how many leaves were rehashed. */
  readonly stats = { hashed: 0 };
  /** Called after every change with who made it (the store uses it to save, mirror and snapshot on idle). */
  onChange: ((by: string | null) => void) | null = null;
  /** Called before an agent's (or the file sync's) change lands (the store snapshots what other authors did first). */
  beforeEdit: ((by: string) => void) | null = null;

  constructor(
    state: Uint8Array | null = null,
    meta: Partial<Meta> | null = null,
  ) {
    this.doc = new Y.Doc();
    this.frag = this.doc.getXmlFragment(FIELD);
    if (state) Y.applyUpdate(this.doc, state, this.system);
    this.comments = new Comments(this.doc);
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server has no cursor
    this.rev = meta?.rev ?? 0;
    this.#pending = { ...(meta?.pending ?? {}) };
    for (const [id, v] of Object.entries(meta?.gone ?? {})) {
      this.#gone.set(id, v);
    }
    const saved = meta?.blocks ?? {};
    this.#entries.set(ROOT, { id: ROOT, el: null, parent: '', kids: [], h: '', md: '', rev: this.rev, sub: this.rev, born: 0 });
    this.#rescan(ROOT, this.rev, null);
    for (const [id, e] of this.#entries) {
      const s = saved[id];
      if (!s) continue;
      [e.rev, e.sub, e.born] = s;
      if (s[3]) e.by = s[3];
      else delete e.by;
    }
    this.doc.on('afterTransaction', (tr: Y.Transaction) => this.#afterTransaction(tr));
    this.doc.on('update', (update: Uint8Array, origin: unknown) => this.#broadcast(update, origin));
    this.awareness.on(
      'update',
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changed = added.concat(updated, removed);
        const socket = this.#sockets.get(origin as WsLink);
        if (socket) {
          for (const c of added.concat(updated)) socket.clients.add(c);
          for (const c of removed) socket.clients.delete(c);
        }
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_AWARENESS);
        encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        const message = encoding.toUint8Array(e);
        for (const link of this.#sockets.keys()) link.send(message);
      },
    );
  }

  meta(): Meta {
    const blocks: Meta['blocks'] = {};
    for (const [id, e] of this.#entries) {
      if (id !== ROOT) blocks[id] = [e.rev, e.sub, e.born, e.by ?? null];
    }
    return { rev: this.rev, blocks, gone: Object.fromEntries(this.#gone), pending: { ...this.#pending } };
  }

  /** The doc's whole state as one compacted update. */
  encode(): Uint8Array {
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** The origin object for an agent (or 'file'): the same object every time, so its undo manager can track it. */
  originFor(kind: 'agent' | 'file', name: string): Origin {
    const key = `${kind}:${name}`;
    let origin = this.#origins.get(key);
    if (!origin) {
      this.#origins.set(key, origin = { kind, name });
      if (kind === 'agent') {
        const um = new Y.UndoManager(this.frag, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
        this.#undo.set(name, um);
        this.#undoOwner.set(um, name);
      }
    }
    return origin;
  }

  // ---------- the block index ----------

  #isDeleted(t: YType | null): boolean {
    for (let x = t; x && x !== this.frag; x = x.parent as YType | null) {
      if (x._item?.deleted) return true;
    }
    return false;
  }

  #childElements(id: string): Y.XmlElement[] {
    const el = id === ROOT ? this.frag : this.#entries.get(id)!.el!;
    return el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  }

  #containerHash(type: string, attrs: Attrs, kids: string[]): string {
    const a = Object.keys(attrs).sort().map((k) => [k, attrs[k]]);
    return hash8(type + '\0' + JSON.stringify(a) + '\0' + kids.join(','));
  }

  #leaf(el: Y.XmlElement): { h: string; md: string } {
    this.stats.hashed++;
    try {
      const json = jsonOf(el);
      return { h: sigOf(json), md: serializeBlock(normalize(json)) };
    } catch {
      return { h: hash8(el.toString()), md: '' };
    }
  }

  /** Register a new element and everything inside it. */
  #add(
    el: Y.XmlElement,
    parent: string,
    rev: number,
    by: string | null,
  ): string {
    const id = idOf(el);
    const container = CONTAINERS.has(el.nodeName);
    const e: Entry = { id, el, parent, kids: container ? [] : null, h: '', md: '', rev, sub: rev, born: rev, ...(by ? { by } : {}) };
    this.#entries.set(id, e);
    if (container) {
      e.kids = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement).map((c) => this.#add(c, id, rev, by));
      e.h = this.#containerHash(el.nodeName, el.getAttributes(), e.kids);
    } else Object.assign(e, this.#leaf(el));
    return id;
  }

  #remove(id: string, rev: number): void {
    const e = this.#entries.get(id);
    if (!e) return;
    for (const k of e.kids ?? []) this.#remove(k, rev);
    this.#entries.delete(id);
    this.#topCache.delete(id);
    this.#gone.set(id, [rev, e.born]);
  }

  #bubble(id: string, rev: number): void {
    for (let e = this.#entries.get(id); e; e = this.#entries.get(e.parent)) {
      if (e.sub >= rev) break;
      e.sub = rev;
    }
  }

  /** Look at a container's children again: register new ones, forget removed ones, rehash. True if it changed. */
  #rescan(id: string, rev: number, by: string | null): boolean {
    const e = this.#entries.get(id)!;
    const now: string[] = [];
    const known = new Set(e.kids ?? []);
    let changed = false;
    for (const el of this.#childElements(id)) {
      const kid = idOf(el);
      if (!this.#entries.has(kid)) {
        this.#add(el, id, rev, by);
        changed = true;
      } else known.delete(kid);
      now.push(kid);
    }
    for (const gone of known) {
      this.#remove(gone, rev);
      changed = true;
    }
    const h = id === ROOT ? '' : this.#containerHash(e.el!.nodeName, e.el!.getAttributes(), now);
    if (changed || h !== e.h || now.join() !== (e.kids ?? []).join()) {
      e.kids = now;
      if (id !== ROOT) {
        e.h = h;
        e.rev = rev;
        if (by) e.by = by;
      }
      this.#bubble(id, rev);
      return true;
    }
    return false;
  }

  #authorOf(origin: unknown): string | null {
    if (origin && this.#sockets.has(origin as WsLink)) return 'user';
    if (origin instanceof Y.UndoManager) return this.#undoOwner.get(origin) ?? 'user';
    if (origin && typeof origin === 'object' && 'kind' in origin) {
      const o = origin as Origin;
      if (o.kind === 'system') return null;
      return o.kind === 'file' ? 'file' : o.kind === 'agent' ? o.name : 'user';
    }
    return origin === null || origin === undefined ? null : 'user'; // a test's client, a page undo
  }

  #afterTransaction(tr: Y.Transaction): void {
    if (tr.changed.size === 0) return;
    const by = this.#authorOf(tr.origin);
    const commented = this.comments.touches(tr);
    const next = this.rev + 1;
    const dirty = new Set<string>();
    let rootDirty = false;
    for (const type of tr.changed.keys()) {
      for (let t: YType | null = type; t; t = t.parent as YType | null) {
        if (t === this.frag) {
          rootDirty = true;
          break;
        }
        if (
          t instanceof Y.XmlElement && t._item && this.#entries.has(idOf(t))
        ) {
          dirty.add(idOf(t));
          break;
        }
      }
    }
    let changed = false;
    if (rootDirty && this.#rescan(ROOT, next, by)) changed = true;
    // containers first (they find new and removed children), then leaves
    const order = [...dirty].sort((a, b) => Number(!this.#entries.get(a)?.kids) - Number(!this.#entries.get(b)?.kids));
    for (const id of order) {
      const e = this.#entries.get(id);
      if (!e || this.#isDeleted(e.el)) continue;
      if (e.kids) {
        if (this.#rescan(id, next, by)) changed = true;
        continue;
      }
      const { h, md } = this.#leaf(e.el!);
      if (h === e.h) continue;
      e.h = h;
      e.md = md;
      e.rev = next;
      if (by) e.by = by;
      this.#bubble(id, next);
      changed = true;
    }
    if (!changed) {
      if (commented) this.onChange?.(null); // saved with the doc; no new rev, no history version
      return;
    }
    this.rev = next;
    if (this.comments.map.size) this.comments.recheck(by ?? 'user', this.system);
    if (this.#gone.size > MAX_GONE) { for (const id of [...this.#gone.keys()].slice(0, this.#gone.size - MAX_GONE)) this.#gone.delete(id); }
    this.onChange?.(by);
  }

  // ---------- views ----------

  #attrsOf(e: Entry): Attrs | undefined {
    if (!e.kids || !e.el) return undefined;
    const a = e.el.getAttributes() as Attrs;
    for (const k of ['colspan', 'rowspan', 'colwidth']) {
      if (a[k] === 1 || a[k] === null) delete a[k];
    }
    return Object.keys(a).length ? a : undefined;
  }

  view(id: string, extra = false): BlockView {
    const e = this.#entries.get(id)!;
    const v: BlockView = { id, type: e.el!.nodeName, h: e.h };
    if (e.kids) {
      v.kids = [...e.kids];
      const a = this.#attrsOf(e);
      if (a) v.attrs = a;
    } else v.md = e.md;
    if (extra && e.parent !== ROOT) v.parent = e.parent;
    if (e.by) v.by = e.by;
    return v;
  }

  /** A block's whole Markdown (a container's too). */
  markdownOf(id: string): string {
    const e = this.#entries.get(id);
    if (!e || !e.el) return '';
    if (!e.kids) return e.md;
    try {
      return serializeBlock(normalize(jsonOf(e.el)));
    } catch {
      return '';
    }
  }

  has(id: string): boolean {
    return id !== ROOT && this.#entries.has(id);
  }

  /** All blocks in doc order, with depth (0 = top level). */
  #walk(
    from = ROOT,
    depth = 0,
    out: { id: string; depth: number }[] = [],
  ): { id: string; depth: number }[] {
    for (const kid of this.#entries.get(from)?.kids ?? []) {
      out.push({ id: kid, depth });
      this.#walk(kid, depth + 1, out);
    }
    return out;
  }

  topIds(): string[] {
    return [...(this.#entries.get(ROOT)!.kids ?? [])];
  }

  get blockCount(): number {
    return this.#entries.size - 1;
  }

  /** The top-level blocks as the Markdown writer needs them (JSON cached per block until something inside it changes). */
  topBlocks(): DocBlock[] {
    return this.topIds().map((id) => {
      const e = this.#entries.get(id)!;
      let cached = this.#topCache.get(id);
      if (!cached || cached.sub !== e.sub) {
        const json = jsonOf(e.el!);
        this.#topCache.set(id, cached = { sub: e.sub, json, sig: sigOf(json) });
      }
      const container = e.el!.nodeName === 'table' || LISTS.has(e.el!.nodeName);
      return { id, node: cached.json, sig: cached.sig, ...(container ? { kidIds: [...e.kids!] } : {}) };
    });
  }

  // ---------- agent reads ----------

  /**
   * doc_read. mode "outline": headings and the top-level blocks with a preview; "full" (default): every block in doc order;
   * "block" + id: that block and everything inside it, with its whole Markdown; "search" + query: the text blocks holding the words.
   */
  read(
    opts: { mode?: unknown; id?: unknown; query?: unknown; ids?: unknown } = {},
  ): Json {
    const mode = typeof opts.mode === 'string' ? opts.mode : opts.id ? 'block' : opts.query ? 'search' : 'full';
    const base = { rev: this.rev };
    if (mode === 'outline') {
      const top = this.topIds();
      const outline = this.#walk().filter(({ id }) => this.#entries.get(id)!.el!.nodeName === 'heading').map(({ id, depth }) => {
        const e = this.#entries.get(id)!;
        return { id, level: Number(e.el!.getAttribute('level')) || 1, text: textOf(e.el!), ...(depth ? { parent: e.parent } : {}) };
      });
      return {
        ...base,
        count: top.length,
        outline,
        blocks: top.map((id) => {
          const e = this.#entries.get(id)!;
          const md = e.kids ? this.markdownOf(id) : e.md;
          return { id, type: e.el!.nodeName, h: e.h, preview: md.length > 100 ? md.slice(0, 100) + '…' : md };
        }),
      };
    }
    if (mode === 'block') {
      const id = String(opts.id ?? '');
      if (!this.has(id)) throw this.#goneRefusal(id, 'read');
      return {
        ...base,
        block: this.view(id, true),
        md: this.markdownOf(id),
        blocks: this.#walk(id, 1).map(({ id: k, depth }) => ({ ...this.view(k, true), depth })),
      };
    }
    if (mode === 'search') {
      const q = String(opts.query ?? '').toLowerCase();
      if (!q) throw new DocRefusal('bad_op', 'search needs "query": the words to look for');
      const hits: Json[] = [];
      for (const { id } of this.#walk()) {
        const e = this.#entries.get(id)!;
        if (e.kids) continue;
        const text = TEXTBLOCKS.has(e.el!.nodeName) ? textOf(e.el!) : e.md;
        const lower = text.toLowerCase();
        const at: [number, number][] = [];
        for (
          let i = lower.indexOf(q);
          i >= 0 && at.length < 20;
          i = lower.indexOf(q, i + 1)
        ) at.push([i, i + q.length]);
        if (at.length) hits.push({ ...this.view(id, true), at });
      }
      return { ...base, query: opts.query, hits };
    }
    if (mode !== 'full') throw new DocRefusal('bad_op', '`mode` is outline, full, block (with id) or search (with query)');
    const only = Array.isArray(opts.ids) ? new Set(opts.ids.map(String)) : null;
    return {
      ...base,
      blocks: this.#walk().filter(({ id }) => !only || only.has(id)).map((
        { id, depth },
      ) => ({ ...this.view(id, true), ...(depth ? { depth } : {}) })),
    };
  }

  /** doc_changes: the blocks changed after `sinceRev` (with `after`, the block before each, and `parent`) and the ones gone. */
  changes(sinceRev: number): Json {
    const changed: Json[] = [];
    for (const { id } of this.#walk()) {
      const e = this.#entries.get(id)!;
      if (e.rev <= sinceRev) continue;
      const sibs = this.#entries.get(e.parent)?.kids ?? [];
      const i = sibs.indexOf(id);
      changed.push({ ...this.view(id, true), after: i > 0 ? sibs[i - 1] : null, ...(e.born > sinceRev ? { new: true } : {}) });
    }
    const gone = [...this.#gone].filter(([, [rev, born]]) => rev > sinceRev && born <= sinceRev).map(([id]) => id);
    return { rev: this.rev, sinceRev, changed, gone };
  }

  // ---------- agent edits ----------

  /**
   * doc_edit: run the ops in order, all or nothing. Guards are judged on the doc as it stood before the first op; the ops are then
   * tried on a copy of the doc (and the result checked against the schema), and only when every op succeeds there are they applied
   * to the live doc, in the same synchronous turn, so nothing can come in between. Returns the ack: the new rev and what changed.
   */
  edit(ops: unknown, origin: Origin): Json {
    if (!Array.isArray(ops) || !ops.length) throw new DocRefusal('bad_op', '`ops` must be a non-empty list of ops');
    (ops as Op[]).forEach((op, i) => this.#checkGuard(op, i));
    const mark = origin.kind === 'agent' ? { by: origin.name } : origin.kind === 'file' ? { by: 'file' } : null;
    // dry run on a copy
    const copy = new Y.Doc();
    Y.applyUpdate(copy, this.encode());
    const copyFrag = copy.getXmlFragment(FIELD);
    const lookup = new Map<string, Y.XmlElement>();
    const index = (p: Y.XmlFragment) => {
      for (const c of p.toArray()) {
        if (c instanceof Y.XmlElement) {
          lookup.set(idOf(c), c);
          if (CONTAINERS.has(c.nodeName)) index(c);
        }
      }
    };
    index(copyFrag);
    const dry = ctxFor(copy, copyFrag, (id) => lookup.get(id) ?? null, mark);
    // the words open comment threads hang on: an agent op that would remove any of them is refused unless it allows detaching
    const guards = origin.kind === 'agent' ? this.comments.guards() : [];
    const hits: { thread: string; quote: string; by: string; op: number }[] = [];
    const afterOp = guards.length
      ? (index: number) => {
        for (const g of guards) {
          if (!hits.some((h) => h.thread === g.thread) && anyDeleted(copy, g.ids)) {
            hits.push({ thread: g.thread, quote: g.quote, by: g.by, op: index });
          }
        }
      }
      : undefined;
    try {
      copy.transact(() => applyOps(dry, ops as Op[], afterOp));
      validate(dry);
    } finally {
      copy.destroy();
    }
    const refused = hits.filter((h) => (ops as Op[])[h.op].allowDetach !== true);
    if (refused.length) {
      const list = refused.map((h) => `${h.thread} on "${h.quote}" (op ${h.op})`).join(', ');
      throw new DocRefusal(
        'anchors_affected',
        `Not changed: that would remove words a comment thread hangs on: ${list}. Keep those words (re-word around them). Only when ` +
          'the user asked for this change, resend those ops with "allowDetach": true: the thread stays, marked detached.',
        { op: refused[0].op, threads: refused },
      );
    }
    // for real
    const before = this.rev;
    const um = origin.kind === 'agent' ? this.#undo.get(origin.name) : undefined;
    const stack = um?.undoStack.length ?? 0;
    if (origin.kind === 'agent' || origin.kind === 'file') this.beforeEdit?.(origin.kind === 'file' ? 'file' : origin.name);
    const live = ctxFor(this.doc, this.frag, (id) => {
      const e = this.#entries.get(id);
      return e && e.el && !this.#isDeleted(e.el) ? e.el : null;
    }, mark);
    this.doc.transact(() => applyOps(live, ops as Op[]), origin);
    if (hits.length) this.comments.detach(hits.map((h) => h.thread), origin.name, 'edited', origin);
    for (const id of live.filled) delete this.#pending[id];
    Object.assign(this.#pending, live.planted);
    const ack = this.changes(before);
    const changedIds = (ack.changed as { id: string }[]).map((c) => c.id);
    if (um && um.undoStack.length > stack) {
      const calls = this.#calls.get(origin.name) ?? [];
      calls.push({ rev: this.rev, ids: changedIds });
      if (calls.length > 100) calls.shift();
      this.#calls.set(origin.name, calls);
    }
    return {
      ok: true,
      rev: this.rev,
      changed: ack.changed,
      gone: ack.gone,
      ...(hits.length ? { detached: hits.map((h) => h.thread) } : {}),
      ...(live.created.length ? { created: live.created } : {}),
      ...(Object.keys(live.moved).length ? { moved: live.moved } : {}),
    };
  }

  /** doc_undo: take back this agent's last call, unless somebody changed what it wrote since. */
  undo(origin: Origin): Json {
    const um = this.#undo.get(origin.name);
    const calls = this.#calls.get(origin.name) ?? [];
    const last = calls[calls.length - 1];
    if (!um || !last || !um.undoStack.length) {
      throw new DocRefusal('nothing_to_undo', 'You have no call of yours to undo on this doc (doc_undo takes back your own calls only).');
    }
    const conflicts = last.ids.filter((id) => (this.#entries.get(id)?.sub ?? 0) > last.rev);
    if (conflicts.length) {
      throw new DocRefusal(
        'undo_conflict',
        'Not undone: the user (or another agent) changed blocks your last call wrote, after it. Their edit wins, so nothing was undone. ' +
          'If your change must still go, edit those blocks from what stands now (guarded), keeping their words.',
        { rev: this.rev, blocks: conflicts.map((id) => ({ ...this.view(id, true), md: this.markdownOf(id) })) },
      );
    }
    const before = this.rev;
    um.undo();
    calls.pop();
    const ack = this.changes(before);
    return { ok: true, undone: true, rev: this.rev, changed: ack.changed, gone: ack.gone };
  }

  /**
   * The words a comment goes on: a find target (the exact words, `nth`) or one textblock's id (all its text). Refused like
   * doc_edit's targets (find_none, block_gone).
   */
  range(target: unknown): { el: Y.XmlElement; from: number; to: number } {
    const t = (target && typeof target === 'object' ? target : {}) as Target;
    if (t.kind === 'find') {
      const ctx = ctxFor(this.doc, this.frag, () => null, null);
      try {
        const { el, at, text } = locate(ctx, t, 0);
        return { el, from: at, to: at + text.length };
      } catch (error) {
        if (error instanceof DocRefusal) throw new DocRefusal(error.code, error.message.replace(/^op 0: /, ''), { text: t.text });
        throw error;
      }
    }
    if (t.kind !== 'blocks') {
      throw new DocRefusal(
        'bad_op',
        'target is {"kind":"find","text":"<exact words>"} or {"kind":"blocks","ids":["<id>"]}; none = a note on the whole doc',
      );
    }
    const ids = Array.isArray(t.ids) ? t.ids : [];
    if (ids.length !== 1 || typeof ids[0] !== 'string') throw new DocRefusal('bad_op', 'a blocks target names one block id');
    if (!this.has(ids[0])) throw this.#goneRefusal(ids[0], 'comment');
    const el = this.#entries.get(ids[0])!.el!;
    if (!TEXTBLOCKS.has(el.nodeName) || !textOf(el).length) {
      throw new DocRefusal(
        'bad_op',
        `block ${ids[0]} is a ${el.nodeName} without words of its own: comment on its words with a find target`,
      );
    }
    return { el, from: 0, to: textOf(el).length };
  }

  /** Replace the whole content (restore from history, a doc made from a file). Not guarded: callers check. */
  replaceAll(nodes: PMJson[], origin: Origin): void {
    if (origin.kind === 'agent' || origin.kind === 'file') this.beforeEdit?.(origin.kind === 'file' ? 'file' : origin.name);
    this.doc.transact(() => {
      if (this.frag.length) this.frag.delete(0, this.frag.length);
      insertNodes(this.doc, this.frag, 0, nodes.length ? nodes : [{ type: 'paragraph' }]);
    }, origin);
  }

  #goneRefusal(id: string, op: number | string): DocRefusal {
    const label = typeof op === 'number' ? `op ${op}: ` : '';
    if (Object.hasOwn(this.#pending, id)) {
      return new DocRefusal(
        'block_gone',
        `${label}the placeholder ${id} ("${this.#pending[id]}") is gone: the user deleted it, so they do not want that section. ` +
          'Drop it; never re-create it.',
        { ...(typeof op === 'number' ? { op } : {}), id, data: { op: 'remove' } },
      );
    }
    return new DocRefusal(
      'block_gone',
      `${label}block ${id} is gone (deleted, or never in this doc). Catch up with doc_changes {sinceRev} and work with what stands.`,
      { ...(typeof op === 'number' ? { op } : {}), id },
    );
  }

  #mismatch(index: number, id: string): DocRefusal {
    const e = this.#entries.get(id)!;
    const block = { ...this.view(id, true), md: this.markdownOf(id) };
    if (e.el!.nodeName === 'pending') {
      return new DocRefusal(
        'guard_mismatch',
        `op ${index}: the user typed into the placeholder ${id}. Keep their text; add yours below it only if it still adds something, ` +
          'and say you kept their text.',
        { op: index, block, rev: this.rev },
      );
    }
    return new DocRefusal(
      'guard_mismatch',
      `op ${index}: block ${id} changed after your read; it is shown as it stands now. Their edit wins: redo yours from what stands, ` +
        `guarded on this h and rev ${this.rev}. Never your text over theirs, never resend with force.`,
      { op: index, block, rev: this.rev },
    );
  }

  #checkGuard(op: Op, index: number): void {
    if (!op || typeof op !== 'object' || !OPS.has(op.op)) {
      throw new DocRefusal('bad_op', `op ${index}: "op" must be one of ${[...OPS].join(', ')}`, { op: index });
    }
    const target = op.target;
    if (!target || typeof target !== 'object') throw new DocRefusal('bad_op', `op ${index}: missing "target"`, { op: index });
    if (
      op.op === 'insert' || op.op === 'table_row_insert' || op.op === 'table_col_insert'
    ) {
      if (target.kind === 'blocks') {
        for (const id of idsOf(target, index)) {
          if (!this.has(id)) throw this.#goneRefusal(id, index);
        }
      }
      return;
    }
    if (target.kind === 'find') {
      if (op.op !== 'replace' && op.op !== 'delete') {
        throw new DocRefusal(
          'bad_op',
          `op ${index}: a find target is for replace (re-word) and delete; ${op.op} takes block ids`,
          { op: index },
        );
      }
      return;
    }
    if (target.kind !== 'blocks') throw new DocRefusal('bad_op', `op ${index}: target.kind must be "blocks" or "find"`, { op: index });
    const ids = idsOf(target, index);
    for (const id of ids) if (!this.has(id)) throw this.#goneRefusal(id, index);
    if (op.op === 'move') {
      const dest = op.to?.target;
      if (dest?.kind === 'blocks') {
        for (const id of idsOf(dest, index)) {
          if (!this.has(id)) throw this.#goneRefusal(id, index);
        }
      }
    }
    if (op.force === true) return;
    const tableOp = op.op === 'table_row_delete' || op.op === 'table_col_delete';
    const needsHash = ids.length === 1 && !tableOp;
    if (
      typeof op.ifRev !== 'number' || (needsHash && typeof op.ifHash !== 'string')
    ) {
      throw new DocRefusal(
        'missing_guard',
        `op ${index}: ${op.op} of a whole block needs ${needsHash ? '"ifHash" (the block\'s h) and ' : ''}"ifRev" (the rev of the read ` +
          "that showed it; an ack's rev only for blocks that ack wrote whole). Use a find target to re-word without guards.",
        { op: index },
      );
    }
    const ifRev = op.ifRev as number;
    if (ifRev > this.rev) {
      throw new DocRefusal(
        'guard_mismatch',
        `op ${index}: ifRev ${ifRev} is newer than the doc (rev ${this.rev}); use a rev you read`,
        { op: index, rev: this.rev },
      );
    }
    if (tableOp) {
      const table = this.#entries.get(ids[0])!;
      if (table.el!.nodeName !== 'table') throw new DocRefusal('bad_op', `op ${index}: ${op.op} targets a table's id`, { op: index });
      const rows = table.kids!;
      const at = Number(op.at);
      const watched = op.op === 'table_row_delete'
        ? [rows[at]].filter(Boolean)
        : rows.map((r) => this.#entries.get(r)!.kids![at]).filter(Boolean);
      for (const id of watched) {
        if (this.#entries.get(id)!.sub > ifRev) {
          throw new DocRefusal(
            'guard_mismatch',
            `op ${index}: the table changed there after your read (rev ${ifRev}); it is shown as it stands. Re-aim and resend.`,
            { op: index, rev: this.rev, block: { ...this.view(ids[0], true), md: this.markdownOf(ids[0]) } },
          );
        }
      }
      return;
    }
    for (const id of ids) {
      const e = this.#entries.get(id)!;
      if (e.sub > ifRev || (needsHash && e.h !== op.ifHash)) throw this.#mismatch(index, id);
    }
  }

  // ---------- page sockets ----------

  /** Connect one page socket: sync both ways, awareness both ways. */
  attach(link: WsLink): void {
    this.#sockets.set(link, { clients: new Set() });
    link.onmessage = (data) => {
      if (typeof data === 'string') return;
      try {
        this.#receive(link, data);
      } catch {
        link.close(1003, 'bad message');
      }
    };
    link.onclose = () => this.detach(link);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeSyncStep1(e, this.doc);
    link.send(encoding.toUint8Array(e));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const a = encoding.createEncoder();
      encoding.writeVarUint(a, MSG_AWARENESS);
      encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(this.awareness, states));
      link.send(encoding.toUint8Array(a));
    }
  }

  detach(link: WsLink): void {
    const socket = this.#sockets.get(link);
    if (!socket) return;
    this.#sockets.delete(link);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...socket.clients], null);
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  #receive(link: WsLink, data: Uint8Array): void {
    const d = decoding.createDecoder(data);
    const type = decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.readSyncMessage(d, e, this.doc, link);
      if (encoding.length(e) > 1) link.send(encoding.toUint8Array(e));
    } else if (type === MSG_AWARENESS) awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), link);
  }

  #broadcast(update: Uint8Array, origin: unknown): void {
    if (!this.#sockets.size) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_SYNC);
    syncProtocol.writeUpdate(e, update);
    const message = encoding.toUint8Array(e);
    for (const link of this.#sockets.keys()) {
      if (link !== origin) link.send(message);
    }
  }

  destroy(): void {
    for (const link of [...this.#sockets.keys()]) {
      link.close(1001, 'doc closed');
    }
    for (const um of this.#undo.values()) um.destroy();
    this.awareness.destroy();
    this.doc.destroy();
  }
}

// =====================================================================================================================================
// The ops (run on the dry-run copy, then on the live doc)
// =====================================================================================================================================

function ctxFor(
  doc: Y.Doc,
  frag: Y.XmlFragment,
  find: Ctx['find'],
  mark: Attrs | null,
): Ctx {
  return { doc, frag, find, mark, created: [], moved: {}, planted: {}, filled: [], touched: new Set() };
}

function idsOf(target: Target, index: number): string[] {
  const ids = Array.isArray(target.ids) ? target.ids.filter((x): x is string => typeof x === 'string') : [];
  if (!ids.length) throw new DocRefusal('bad_op', `op ${index}: target.ids must list block ids`, { op: index });
  return ids;
}

function nameOf(ctx: Ctx, parent: Y.XmlFragment): string {
  return parent === ctx.frag ? 'doc' : (parent as Y.XmlElement).nodeName;
}

function parentOf(el: Y.XmlElement): { parent: Y.XmlFragment; at: number } {
  const parent = el.parent as Y.XmlFragment;
  return { parent, at: parent.toArray().indexOf(el) };
}

function need(ctx: Ctx, id: string, index: number): Y.XmlElement {
  const el = ctx.find(id);
  if (!el || el._item?.deleted) {
    throw new DocRefusal('block_gone', `op ${index}: block ${id} is gone (an earlier op of this call removed it)`, { op: index, id });
  }
  return el;
}

function textSource(source: Source | undefined, index: number): string {
  const from = source?.from;
  if (
    !from || typeof from !== 'object' || from.kind !== 'inline' || typeof from.content !== 'string'
  ) {
    throw new DocRefusal(
      'bad_op',
      `op ${index}: give the content as {"from":{"kind":"inline","content":"…"},"as":"markdown"|"text"}`,
      { op: index },
    );
  }
  return from.content;
}

const para = (text: string): PMJson => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });

/** The nodes a source gives (`as`: markdown, text, pending, blocks), shaped for the parent they go into. */
function sourceNodes(
  source: Source | undefined,
  index: number,
  parentType: string,
): PMJson[] {
  const as = source?.as ?? 'markdown';
  if (as === 'pending') {
    const content = source?.from?.content;
    const intents = Array.isArray(content) ? content : [content];
    if (
      !intents.length || !intents.every((x) => typeof x === 'string' && x.trim())
    ) {
      throw new DocRefusal(
        'bad_op',
        `op ${index}: "as":"pending" takes content = the section's intent (a string, or a list of them)`,
        { op: index },
      );
    }
    return fit(parentType, (intents as string[]).map((intent) => ({ type: 'pending', attrs: { intent: intent.trim() } })), index);
  }
  if (as === 'blocks') {
    const content = source?.from?.content;
    if (!Array.isArray(content) || !content.length) {
      throw new DocRefusal(
        'bad_op',
        `op ${index}: "as":"blocks" takes content = a list of nodes ({"type":"paragraph",...})`,
        { op: index },
      );
    }
    try {
      for (const n of content) schema.nodeFromJSON(n);
    } catch (error) {
      throw new DocRefusal('bad_op', `op ${index}: not a node of this doc's schema: ${(error as Error).message}`, { op: index });
    }
    return fit(parentType, content as PMJson[], index);
  }
  const text = textSource(source, index);
  if (as === 'text') return fit(parentType, [para(text)], index);
  if (as !== 'markdown') throw new DocRefusal('bad_op', `op ${index}: "as" must be markdown, text, pending or blocks`, { op: index });
  const lines = text.trim().split(/\r?\n/);
  if (
    parentType === 'table' && text.trim() && lines.every((l) => /^\s*\|/.test(l)) && !lines.some((l) => /^\s*\|?\s*:?-{3,}/.test(l))
  ) {
    // bare rows: "| a | b |" lines
    return fit(
      parentType,
      lines.map((l) => ({
        type: 'tableRow',
        content: splitRow(l).map((c) => {
          const inline = parseInline(c.replace(/\\\|/g, '|'));
          return { type: 'tableCell', content: [inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' }] };
        }),
      })),
      index,
    );
  }
  const nodes = parseBlockMarkdown(text);
  if (!nodes.length) throw new DocRefusal('bad_op', `op ${index}: the Markdown has no blocks`, { op: index });
  return fit(parentType, nodes, index);
}

/** Shape nodes for a parent: items for a list, rows for a table, blocks elsewhere. */
function fit(parentType: string, nodes: PMJson[], index: number): PMJson[] {
  if (LISTS.has(parentType)) {
    const itemType = parentType === 'taskList' ? 'taskItem' : 'listItem';
    const out: PMJson[] = [];
    for (const n of nodes) {
      if (LISTS.has(n.type)) {
        for (const item of n.content ?? []) {
          out.push(convertItem(item, itemType));
        }
      } else if (ITEMS.has(n.type)) out.push(convertItem(n, itemType));
      else if (n.type === 'paragraph') {
        out.push(convertItem({ type: 'listItem', content: [n] }, itemType));
      } else if (n.type === 'pending') {
        out.push(convertItem({ type: 'listItem', content: [{ type: 'paragraph' }, n] }, itemType));
      } else {throw new DocRefusal(
          'bad_op',
          `op ${index}: a list holds items: give them as "- item" lines (got a ${n.type})`,
          { op: index },
        );}
    }
    return out;
  }
  if (parentType === 'table') {
    const out: PMJson[] = [];
    for (const n of nodes) {
      const rows = n.type === 'table' ? n.content ?? [] : n.type === 'tableRow' ? [n] : null;
      if (!rows) {
        throw new DocRefusal(
          'bad_op',
          `op ${index}: a table holds rows: give them as "| a | b |" lines, one cell per column`,
          { op: index },
        );
      }
      for (const r of rows) {
        out.push({ ...r, content: (r.content ?? []).map((c) => ({ ...c, type: 'tableCell' })) });
      }
    }
    return out;
  }
  if (parentType === 'tableRow') {
    throw new DocRefusal(
      'bad_op',
      `op ${index}: cells come and go a column at a time: use table_col_insert / table_col_delete`,
      { op: index },
    );
  }
  for (const n of nodes) {
    if (ITEMS.has(n.type) || n.type === 'tableRow' || CELLS.has(n.type)) {
      throw new DocRefusal(
        'bad_op',
        `op ${index}: a ${n.type} goes only inside its list or table, not into a ${parentType}`,
        { op: index },
      );
    }
  }
  return nodes;
}

function convertItem(item: PMJson, itemType: string): PMJson {
  let content = item.content ?? [];
  if (!content.length || content[0].type !== 'paragraph') content = [{ type: 'paragraph' }, ...content];
  return itemType === 'taskItem'
    ? { type: 'taskItem', attrs: { checked: item.type === 'taskItem' ? !!item.attrs?.checked : false }, content }
    : { type: 'listItem', content };
}

/** The place an insert (or a move's `to`) points at. */
function place(
  ctx: Ctx,
  target: Target | undefined,
  side: string | undefined,
  index: number,
): { parent: Y.XmlFragment; at: number } {
  if (!target || typeof target !== 'object') throw new DocRefusal('bad_op', `op ${index}: missing target`, { op: index });
  if (target.kind === 'root') return { parent: ctx.frag, at: side === 'start' ? 0 : ctx.frag.length };
  if (target.kind !== 'blocks') {
    throw new DocRefusal('bad_op', `op ${index}: insert targets {"kind":"blocks","ids":[one id]} or {"kind":"root"}`, { op: index });
  }
  const ids = idsOf(target, index);
  if (ids.length !== 1) throw new DocRefusal('bad_op', `op ${index}: insert targets one block id`, { op: index });
  const el = need(ctx, ids[0], index);
  const s = side ?? 'after';
  if (s === 'before' || s === 'after') {
    const { parent, at } = parentOf(el);
    return { parent, at: s === 'after' ? at + 1 : at };
  }
  if (s === 'start' || s === 'end') {
    if (!CONTAINERS.has(el.nodeName)) {
      throw new DocRefusal(
        'bad_op',
        `op ${index}: side "${s}" puts blocks inside a list, item, quote, table or cell; a ${el.nodeName} takes "before" or "after"`,
        { op: index },
      );
    }
    if (el.nodeName === 'tableRow') {
      throw new DocRefusal('bad_op', `op ${index}: cells come and go a column at a time: use table_col_insert`, { op: index });
    }
    return { parent: el, at: s === 'start' ? 0 : el.length };
  }
  throw new DocRefusal('bad_op', `op ${index}: "side" must be before, after, start or end`, { op: index });
}

function insertAt(
  ctx: Ctx,
  parent: Y.XmlFragment,
  at: number,
  nodes: PMJson[],
  mark: boolean,
): Y.XmlElement[] {
  const parentType = nameOf(ctx, parent);
  const ready = mark ? nodes.map((n) => withMark(n, ctx.mark, parentType)) : nodes;
  for (const n of ready) {
    try {
      schema.nodeFromJSON(n).check();
    } catch (error) {
      throw new DocRefusal('bad_op', `a ${n.type} that the editor cannot hold: ${(error as Error).message}`);
    }
  }
  const els = insertNodes(ctx.doc, parent, at, ready);
  ctx.touched.add(parent);
  for (const el of els) {
    ctx.created.push(idOf(el));
    if (el.nodeName === 'pending') ctx.planted[idOf(el)] = String(el.getAttribute('intent') ?? '');
  }
  return els;
}

/** Remove an element; a list, quote, table or row left empty goes too; the doc keeps one block. */
function removeEl(ctx: Ctx, el: Y.XmlElement, index: number): void {
  if (CELLS.has(el.nodeName)) {
    throw new DocRefusal('bad_op', `op ${index}: cells go a column at a time: use table_col_delete`, { op: index });
  }
  let { parent, at } = parentOf(el);
  parent.delete(at, 1);
  while (
    parent !== ctx.frag && parent.length === 0 && EMPTY_GOES.has((parent as Y.XmlElement).nodeName)
  ) {
    const up = parentOf(parent as Y.XmlElement);
    up.parent.delete(up.at, 1);
    parent = up.parent;
  }
  if (parent === ctx.frag && ctx.frag.length === 0) {
    throw new DocRefusal(
      'last_block',
      `op ${index}: a doc keeps at least one block. To clear it, replace the last block (guarded) with an empty paragraph instead.`,
      { op: index },
    );
  }
  if (parent !== ctx.frag && parent.length === 0) {
    throw new DocRefusal(
      'bad_op',
      `op ${index}: a ${(parent as Y.XmlElement).nodeName} keeps at least one block; replace its words instead`,
      { op: index },
    );
  }
  ctx.touched.add(parent);
}

function locate(
  ctx: Ctx,
  target: Target,
  index: number,
): { el: Y.XmlElement; at: number; text: string } {
  const text = target.text;
  if (typeof text !== 'string' || !text) {
    throw new DocRefusal('bad_op', `op ${index}: a find target needs "text": the exact words`, { op: index });
  }
  let left = typeof target.nth === 'number' && target.nth > 0 ? target.nth : 1;
  const walk = (p: Y.XmlFragment): { el: Y.XmlElement; at: number } | null => {
    for (const c of p.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      if (TEXTBLOCKS.has(c.nodeName)) {
        const t = textOf(c);
        for (let at = t.indexOf(text); at >= 0; at = t.indexOf(text, at + 1)) {
          if (--left === 0) return { el: c, at };
        }
      } else if (CONTAINERS.has(c.nodeName)) {
        const r = walk(c);
        if (r) return r;
      }
    }
    return null;
  };
  const found = walk(ctx.frag);
  if (!found) {
    throw new DocRefusal(
      'find_none',
      `op ${index}: the words "${text}" are not in the doc as it stands (the user may have changed them). Read that block again ` +
        '(doc_read mode "search") and quote what it says now; keep their words.',
      { op: index, text },
    );
  }
  return { ...found, text };
}

function checkAtoms(
  el: Y.XmlElement,
  edits: { at: number; del: number }[],
  index: number,
): void {
  const atoms = atomsOf(el);
  for (const e of edits) {
    if (atoms.some((p) => p >= e.at && p < e.at + e.del)) {
      throw new DocRefusal(
        'atom_in_range',
        `op ${index}: the words you change hold a line break, image or HTML tag that the edit would remove; quote the words around it ` +
          'instead (or replace the whole block as markdown, guarded).',
        { op: index },
      );
    }
  }
}

/** Inline runs (text with its Markdown marks, or an atom) of a textblock node, without agent marks. */
function runsOfJson(node: PMJson): { text: string; key: string }[] {
  const out: { text: string; key: string }[] = [];
  for (const c of normalize(node).content ?? []) {
    const key = c.type === 'text' ? JSON.stringify(c.marks ?? []) : JSON.stringify(c);
    const last = out[out.length - 1];
    if (c.type === 'text' && last && last.key === key) last.text += c.text;
    else out.push({ text: c.type === 'text' ? c.text! : ATOM, key });
  }
  return out;
}

/** Replace a block with a node of the same type, keeping ids (and the marks of what did not change). */
function replaceInPlace(
  ctx: Ctx,
  el: Y.XmlElement,
  node: PMJson,
  index: number,
): void {
  const old = jsonOf(el);
  if (TEXTBLOCKS.has(el.nodeName)) {
    const attrsOfNode = (n: PMJson) => JSON.stringify(normalize({ ...n, content: [] }).attrs ?? {});
    const a = runsOfJson(old), b = runsOfJson(node);
    if (
      attrsOfNode(old) === attrsOfNode(node) && a.length === b.length &&
      a.every((r, k) => r.key === b[k].key && (r.text === ATOM) === (b[k].text === ATOM))
    ) {
      const edits = [];
      let base = 0;
      for (let k = 0; k < a.length; k++) {
        if (a[k].text !== ATOM) edits.push(...diffText(a[k].text, b[k].text).map((e) => ({ ...e, at: e.at + base })));
        base += a[k].text.length;
      }
      checkAtoms(el, edits, index);
      applyTextEdits(el, edits, ctx.mark);
      return;
    }
    updateNode(ctx.doc, el, withMark(node, ctx.mark, nameOf(ctx, el.parent as Y.XmlFragment)));
    ctx.touched.add(el);
    return;
  }
  // a container: children that stay keep their element (and ids); new ones carry the agent's mark
  const oldKids = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  const oldSigs = oldKids.map((k) => sigOf(jsonOf(k)));
  let from = 0;
  const content = (node.content ?? []).map((kid) => {
    const sig = sigOf(kid);
    for (let k = from; k < oldKids.length; k++) {
      if (oldSigs[k] === sig) {
        from = k + 1;
        return jsonOf(oldKids[k]);
      }
    }
    return withMark(kid, ctx.mark, node.type);
  });
  updateNode(ctx.doc, el, { ...node, content });
  ctx.touched.add(el);
}

function cellsOf(value: unknown, index: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((c) => typeof c === 'string')) {
    throw new DocRefusal('bad_op', `op ${index}: "cells" is a list of strings (Markdown), one per cell`, { op: index });
  }
  return value as string[];
}

const cellNode = (
  type: string,
  text: string,
  align: unknown = null,
): PMJson => {
  const inline = text.trim() ? parseInline(text.trim()) : [];
  return {
    type,
    attrs: { align: align ?? null },
    content: [inline.length ? { type: 'paragraph', content: inline } : { type: 'paragraph' }],
  };
};

const SET_CHECKS: Record<string, (v: unknown) => boolean> = {
  level: (v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 6,
  checked: (v) => typeof v === 'boolean',
  start: (v) => Number.isInteger(v) && (v as number) >= 0,
  language: (v) => v === null || typeof v === 'string',
  align: (v) => v === null || v === 'left' || v === 'center' || v === 'right',
  intent: (v) => typeof v === 'string',
};
const KINDS: Record<string, string> = { bullet: 'bulletList', ordered: 'orderedList', check: 'taskList' };

function applyOps(ctx: Ctx, ops: Op[], afterOp?: (index: number) => void): void {
  ops.forEach((op, index) => {
    applyOp(ctx, op, index);
    afterOp?.(index);
  });
}

function applyOp(ctx: Ctx, op: Op, index: number): void {
  {
    const t = op.target;
    switch (op.op) {
      case 'insert': {
        const { parent, at } = place(ctx, t, op.side, index);
        insertAt(ctx, parent, at, sourceNodes(op.source, index, nameOf(ctx, parent)), true);
        return;
      }
      case 'replace':
        return replaceOp(ctx, op, index);
      case 'delete': {
        if (t.kind === 'find') {
          const { el, at, text } = locate(ctx, t, index);
          const edits = [{ at, del: text.length, ins: '' }];
          checkAtoms(el, edits, index);
          applyTextEdits(el, edits, null);
          return;
        }
        for (const id of idsOf(t, index)) {
          const el = ctx.find(id);
          if (!el || el.parent === null || isGone(el)) continue; // inside a block this op already removed
          removeEl(ctx, el, index);
        }
        return;
      }
      case 'move':
        return moveOp(ctx, op, index);
      case 'set':
        return setOp(ctx, op, index);
      default:
        return tableOp(ctx, op, index);
    }
  }
}

function isGone(el: Y.XmlElement): boolean {
  for (let x: YType | null = el; x; x = x.parent as YType | null) {
    if (x._item?.deleted) return true;
  }
  return false;
}

function replaceOp(ctx: Ctx, op: Op, index: number): void {
  const t = op.target;
  if (t.kind === 'find') {
    const { el, at, text } = locate(ctx, t, index);
    const as = op.with?.as ?? 'text';
    if (as !== 'text') throw new DocRefusal('bad_op', `op ${index}: a find target is re-worded with "as":"text"`, { op: index });
    const edits = diffText(text, textSource(op.with, index)).map((e) => ({ ...e, at: e.at + at }));
    checkAtoms(el, edits, index);
    applyTextEdits(el, edits, ctx.mark);
    return;
  }
  const ids = idsOf(t, index);
  if (ids.length !== 1) throw new DocRefusal('bad_op', `op ${index}: replace one block at a time`, { op: index });
  const el = need(ctx, ids[0], index);
  const { parent, at } = parentOf(el);
  const as = op.with?.as ?? 'markdown';
  if (el.nodeName === 'pending') {
    const nodes = sourceNodes(op.with, index, nameOf(ctx, parent));
    parent.delete(at, 1);
    insertAt(ctx, parent, at, nodes, true);
    ctx.filled.push(ids[0]);
    return;
  }
  if (as === 'text') {
    if (!TEXTBLOCKS.has(el.nodeName)) {
      throw new DocRefusal(
        'bad_op',
        `op ${index}: "as":"text" re-words a paragraph, heading or code block; a ${el.nodeName} takes "as":"markdown" ` +
          '(or re-word the words inside it with a find target)',
        { op: index },
      );
    }
    const text = textSource(op.with, index);
    if (!text) throw new DocRefusal('bad_op', `op ${index}: never replace with empty content; delete the block instead`, { op: index });
    const edits = diffText(textOf(el), text);
    checkAtoms(el, edits, index);
    applyTextEdits(el, edits, ctx.mark);
    return;
  }
  const nodes = sourceNodes(op.with, index, nameOf(ctx, parent));
  if (nodes.length === 1 && nodes[0].type === el.nodeName) {
    replaceInPlace(ctx, el, nodes[0], index);
    return;
  }
  parent.delete(at, 1);
  insertAt(ctx, parent, at, nodes, true);
}

function moveOp(ctx: Ctx, op: Op, index: number): void {
  const els = idsOf(op.target, index).map((id) => need(ctx, id, index));
  const to = op.to;
  if (!to || typeof to !== 'object') {
    throw new DocRefusal('bad_op', `op ${index}: move needs "to": {"target":{…},"side":"before"|"after"|"start"|"end"}`, { op: index });
  }
  const dest = to.target?.kind === 'blocks' ? idsOf(to.target, index)[0] : null;
  if (dest) {
    for (
      let x: YType | null = ctx.find(dest);
      x && x !== ctx.frag;
      x = x.parent as YType | null
    ) {
      if (els.includes(x as Y.XmlElement)) throw new DocRefusal('bad_op', `op ${index}: cannot move a block into itself`, { op: index });
    }
  }
  const jsons = els.map((el) => jsonOf(el));
  const oldIds = els.map((el) => idOf(el));
  for (const el of els) removeEl(ctx, el, index);
  const { parent, at } = place(ctx, to.target, to.side, index);
  const before = ctx.created.length;
  insertAt(ctx, parent, at, fit(nameOf(ctx, parent), jsons, index), false);
  const made = ctx.created.splice(before);
  oldIds.forEach((id, k) => {
    if (made[k]) ctx.moved[id] = made[k];
  });
}

function setOp(ctx: Ctx, op: Op, index: number): void {
  const attrs = op.attrs;
  if (!attrs || typeof attrs !== 'object' || !Object.keys(attrs).length) {
    throw new DocRefusal('bad_op', `op ${index}: set needs "attrs", e.g. {"level":2}, {"checked":true}, {"kind":"check"}`, { op: index });
  }
  for (const id of idsOf(op.target, index)) {
    const el = need(ctx, id, index);
    if ('kind' in attrs) {
      const type = KINDS[String(attrs.kind)];
      if (!LISTS.has(el.nodeName) || !type) {
        throw new DocRefusal('bad_op', `op ${index}: "kind" (bullet, ordered, check) is set on a list's id`, { op: index });
      }
      if (type === el.nodeName) continue;
      const json = jsonOf(el);
      const itemType = type === 'taskList' ? 'taskItem' : 'listItem';
      const node: PMJson = { type, content: (json.content ?? []).map((it) => convertItem(it, itemType)) };
      const { parent, at } = parentOf(el);
      parent.delete(at, 1);
      const before = ctx.created.length;
      insertAt(ctx, parent, at, [node], false);
      ctx.moved[id] = ctx.created.splice(before)[0];
      continue;
    }
    const spec = (schema.nodes[el.nodeName]?.spec.attrs ?? {}) as Record<
      string,
      unknown
    >;
    for (const [k, v] of Object.entries(attrs)) {
      if (!(k in spec) || (SET_CHECKS[k] && !SET_CHECKS[k](v))) {
        throw new DocRefusal(
          'bad_op',
          `op ${index}: a ${el.nodeName} has no settable "${k}"${SET_CHECKS[k] ? ' with that value' : ''}; it has: ${
            Object.keys(spec).join(', ') || 'none'
          }`,
          { op: index },
        );
      }
      if (v === null) el.removeAttribute(k);
      else el.setAttribute(k, v as string);
    }
    ctx.touched.add(el.parent as Y.XmlFragment);
  }
}

function tableOp(ctx: Ctx, op: Op, index: number): void {
  const ids = idsOf(op.target, index);
  const table = need(ctx, ids[0], index);
  if (table.nodeName !== 'table') throw new DocRefusal('bad_op', `op ${index}: ${op.op} targets a table's id`, { op: index });
  const rows = table.toArray() as Y.XmlElement[];
  const cols = rows[0]?.length ?? 0;
  const headerCells = (rows[0]?.toArray() ?? []) as Y.XmlElement[];
  const at = op.at;
  if (at !== undefined && (!Number.isInteger(at) || at < 0)) {
    throw new DocRefusal('bad_op', `op ${index}: "at" is a 0-based index`, { op: index });
  }
  if (op.op === 'table_row_insert') {
    const where = at ?? rows.length;
    if (where < 1 || where > rows.length) {
      throw new DocRefusal('bad_op', `op ${index}: rows go at 1…${rows.length} (row 0 is the header)`, { op: index });
    }
    const cells = cellsOf(op.cells, index);
    if (cells.length > cols) {
      throw new DocRefusal('cell_count', `op ${index}: the table has ${cols} columns; you gave ${cells.length} cells`, { op: index });
    }
    const row: PMJson = {
      type: 'tableRow',
      content: Array.from({ length: cols }, (_, k) => cellNode('tableCell', cells[k] ?? '', headerCells[k]?.getAttribute('align'))),
    };
    insertAt(ctx, table, where, [row], true);
  } else if (op.op === 'table_row_delete') {
    if (at === undefined || at < 1 || at >= rows.length) {
      throw new DocRefusal('bad_op', `op ${index}: "at" is the row to delete, 1…${rows.length - 1} (the header stays)`, { op: index });
    }
    table.delete(at, 1);
    ctx.touched.add(table);
  } else if (op.op === 'table_col_insert') {
    const where = at ?? cols;
    if (where > cols) throw new DocRefusal('bad_op', `op ${index}: columns go at 0…${cols}`, { op: index });
    const cells = cellsOf(op.cells, index);
    if (cells.length > rows.length) {
      throw new DocRefusal('cell_count', `op ${index}: the table has ${rows.length} rows; you gave ${cells.length} cells`, { op: index });
    }
    rows.forEach((row, r) => {
      const first = row.get(0) as Y.XmlElement | undefined;
      insertAt(ctx, row, where, [cellNode(first?.nodeName === 'tableHeader' ? 'tableHeader' : 'tableCell', cells[r] ?? '')], true);
    });
  } else {
    if (at === undefined || at >= cols) {
      throw new DocRefusal('bad_op', `op ${index}: "at" is the column to delete, 0…${cols - 1}`, { op: index });
    }
    if (cols < 2) throw new DocRefusal('bad_op', `op ${index}: a table keeps one column; delete the table instead`, { op: index });
    for (const row of rows) row.delete(at, 1);
    ctx.touched.add(table);
  }
}

/** After the dry run: every container the ops touched still fits the schema (else the call is refused with why). */
function validate(ctx: Ctx): void {
  for (const parent of ctx.touched) {
    if (parent === ctx.frag) {
      if (!ctx.frag.length) throw new DocRefusal('last_block', 'a doc keeps at least one block');
      continue;
    }
    const el = parent as Y.XmlElement;
    if (isGone(el)) continue;
    try {
      nodeOf(el).check();
    } catch (error) {
      throw new DocRefusal(
        'bad_op',
        `that would leave a ${el.nodeName} the editor cannot hold (${(error as Error).message}). A list item starts with its words; ` +
          'a table row has one cell per column; cells and items hold blocks.',
      );
    }
  }
}
