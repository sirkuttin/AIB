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
 * Rich blocks. Callouts, columns (and each column) and toggles are containers like quotes: every block inside has its own id and
 * guard, so typing in a callout moves the callout's `sub` and an agent's guarded rewrite of it is refused. Colour, highlight and
 * alignment are part of a block's content (its h); a merge or split of table cells is guarded by every cell it touches.
 *
 * Charts (charts.ts) hold their numbers in a table inside the chart block, so every number is a cell with its own id and guard: an
 * agent's change to a number the user changed after the agent's read is refused (the user's number stays), changes to other cells
 * land with the agent's mark (the page tints them). An agent's (or a file's) edit that leaves a chart that is not one (a word in a
 * number cell, more than MAX_SERIES series, merged cells) is refused; the user's own typing never is. chart_from_table copies a
 * table's numbers once into a new chart.
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
  formatText,
  stylesOf,
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
  alertsToCallouts,
  type DocBlock,
  hash8,
  hasSpans,
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
  tableGrid,
  TEXTBLOCKS,
} from './markdown.ts';
import { ALIGNS, CALLOUT_VARIANTS, CHART_TYPES, HIGHLIGHTS, TEXT_COLORS } from './schema.ts';
import { CHART_ID, chartFromTable, chartProblem, chartRows, chartTable, newChartId } from './charts.ts';
import type { WsLink } from '../platform/websocket.ts';
import { anyDeleted, Comments } from './comments.ts';

export { FIELD };
// deno-lint-ignore no-explicit-any
type YType = Y.AbstractType<any>;
const MSG_SYNC = 0, MSG_AWARENESS = 1;
export const ROOT = 'root';
/** The doc's pages, in order: one Y.Map per page ({id, title, field}); `field` names the page's root XmlFragment. */
export const PAGES = 'pages';
/** The first page of a doc made before pages existed keeps the old fragment (FIELD), so its blocks keep their ids. */
export const FIRST_PAGE = 'p1';
const MAX_TITLE = 100;
const PAGE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_FIELD = /^(?:doc|page:[A-Za-z0-9_-]{1,40})$/;

export interface PageInfo {
  id: string;
  title: string;
  field: string;
}

/** The fragment a page's blocks live in. */
export function fieldOf(page: string): string {
  return page === FIRST_PAGE ? FIELD : `page:${page}`;
}

export function newPageMap(id: string, title: string, field = fieldOf(id), pos?: number): Y.Map<unknown> {
  const m = new Y.Map<unknown>();
  m.set('id', id);
  m.set('title', title);
  m.set('field', field);
  if (pos !== undefined) m.set('pos', pos);
  return m;
}

function newPageId(taken: (id: string) => boolean): string {
  for (;;) {
    const id = 'p' + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
    if (!taken(id)) return id;
  }
}

/** A page title as given: trimmed, one line, 1-100 characters. */
export function pageTitle(value: unknown): string {
  const t = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  if (!t || t.length > MAX_TITLE) throw new DocRefusal('bad_op', `\`title\` is the page's title: 1-${MAX_TITLE} characters`);
  return t;
}

const rootOf = (page: string) => `${ROOT}:${page}`;
export const CONTAINERS = new Set([
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
  'callout',
  'columns',
  'column',
  'toggle',
  'chart',
]);
const CELLS = new Set(['tableCell', 'tableHeader']);
/** Containers that go away with their last child (a list without items, a quote without blocks, a row without cells). */
const EMPTY_GOES = new Set(['blockquote', 'bulletList', 'orderedList', 'taskList', 'table', 'tableRow', 'callout', 'chart']);
const MAX_GONE = 5000;

/** Who made a change. One object per author, so Y.UndoManager can track it. */
export interface Origin {
  kind: 'agent' | 'user' | 'file' | 'system';
  /** An agent's origin name is its chat's lasting id ("claude:<session>"), so undo and guards are per chat; tests may use a bare name. */
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
  /** Text blocks: coloured or highlighted stretches (char ranges in the block's text). */
  styles?: { from: number; to: number; color?: string; highlight?: string }[];
  parent?: string;
  depth?: number;
  /** Who changed it last: 'user', an agent's name, 'file' (a file tool edited the Markdown copy). */
  by?: string;
  /** A chart: its numbers as they stand, row 0 the series names, column 0 the labels (each cell is a block of the chart's table). */
  data?: string[][];
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
  /** page id -> [rev (title or place last changed), born] */
  pages?: Record<string, [number, number]>;
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
  at?: unknown;
  cells?: unknown;
  /** style: the text colour / highlight by name, null to clear. */
  color?: unknown;
  highlight?: unknown;
  /** table_header: header row / header column on or off. */
  row?: unknown;
  col?: unknown;
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
  'style',
  'table_merge',
  'table_split',
  'table_header',
  'chart_from_table',
]);
/** Table ops guarded by ifRev on the cells they touch (no ifHash). */
const TABLE_GUARDED = new Set(['table_row_delete', 'table_col_delete', 'table_merge', 'table_split', 'table_header']);

export class LiveDoc {
  readonly doc: Y.Doc;
  /** The pages, in order (PAGES). */
  readonly pagesArr: Y.Array<Y.Map<unknown>>;
  readonly awareness: awarenessProtocol.Awareness;
  /** The doc's comment threads (comments.ts), kept in this Y.Doc. */
  readonly comments: Comments;
  rev: number;
  #entries = new Map<string, Entry>();
  /** Per page: its root entry id (rootOf) -> the page and its fragment. */
  #roots = new Map<string, { page: string; frag: Y.XmlFragment }>();
  #fragRoot = new Map<Y.XmlFragment, string>();
  /** Per page: [rev its title or place last changed, born]. */
  #pageRevs = new Map<string, [number, number]>();
  /** The pages as last seen (id, title, place), to tell what changed. */
  #pageSeen = new Map<string, { title: string; index: number }>();
  #gonePages = new Map<string, number>();
  #gone = new Map<string, [number, number]>();
  #pending: Record<string, string>;
  #origins = new Map<string, Origin>();
  #undo = new Map<string, Y.UndoManager>();
  #undoOwner = new Map<Y.UndoManager, string>();
  #calls = new Map<string, { rev: number; ids: string[] }[]>();
  #topCache = new Map<string, { sub: number; json: PMJson; sig: string }>();
  #sockets = new Map<WsLink, { clients: Set<number> }>();
  readonly system: Origin = { kind: 'system', name: 'system' };
  /** The user's changes made through the server (page operations, restore, comments from the page's routes). */
  readonly user: Origin = { kind: 'user', name: 'user' };
  /** Per page: the rev its title last changed and who changed it (an agent's rename is refused over a newer user rename). */
  readonly titles = new Map<string, { rev: number; by: string | null }>();
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
    if (state) Y.applyUpdate(this.doc, state, this.system);
    this.pagesArr = this.doc.getArray(PAGES) as Y.Array<Y.Map<unknown>>;
    // A doc from before pages (or a new one): its blocks are the first page.
    if (!this.pageList().length) this.doc.transact(() => this.pagesArr.push([newPageMap(FIRST_PAGE, 'Page 1', FIELD)]), this.system);
    this.comments = new Comments(this.doc);
    this.comments.pageOf = (id) => (this.has(id) ? this.pageOf(id) : null);
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server has no cursor
    this.rev = meta?.rev ?? 0;
    this.#pending = { ...(meta?.pending ?? {}) };
    for (const [id, v] of Object.entries(meta?.gone ?? {})) {
      this.#gone.set(id, v);
    }
    const saved = meta?.blocks ?? {};
    this.#syncPages(this.rev, null);
    for (const [id, v] of Object.entries(meta?.pages ?? {})) {
      if (this.#pageRevs.has(id)) this.#pageRevs.set(id, v);
    }
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
      if (!this.#roots.has(id)) blocks[id] = [e.rev, e.sub, e.born, e.by ?? null];
    }
    return {
      rev: this.rev,
      blocks,
      gone: Object.fromEntries(this.#gone),
      pending: { ...this.#pending },
      pages: Object.fromEntries(this.#pageRevs),
    };
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
        const scope = [...this.#roots.values()].map((r) => r.frag);
        const um = new Y.UndoManager(scope, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
        this.#undo.set(name, um);
        this.#undoOwner.set(um, name);
      }
    }
    return origin;
  }

  // ---------- pages ----------

  /** The pages in order, as stored (a malformed or repeated entry is left out). */
  pageList(): PageInfo[] {
    return this.#pageEntries().map(({ info }) => info);
  }

  /**
   * The pages with their place: a page map's `pos` (a number; moves set it, so a move and a concurrent rename both land), else its
   * index in PAGES (docs from before `pos`). Sorted by place, then index.
   */
  #pageEntries(): { info: PageInfo; pos: number; map: Y.Map<unknown> }[] {
    const out: { info: PageInfo; pos: number; map: Y.Map<unknown>; index: number }[] = [];
    const seen = new Set<string>(), fields = new Set<string>();
    const arr = this.pagesArr.toArray();
    for (let index = 0; index < arr.length; index++) {
      const m = arr[index];
      if (!(m instanceof Y.Map)) continue;
      const id = m.get('id'), title = m.get('title'), f = m.get('field');
      if (typeof id !== 'string' || !PAGE_ID.test(id) || seen.has(id)) continue;
      // a page's blocks live in `doc` or `page:<id>`: never another root type, never one another page uses
      const field = typeof f === 'string' && PAGE_FIELD.test(f) ? f : fieldOf(id);
      if (fields.has(field)) continue;
      seen.add(id);
      fields.add(field);
      const pos = m.get('pos');
      out.push({
        info: { id, title: typeof title === 'string' && title.trim() ? title : id, field },
        pos: typeof pos === 'number' && Number.isFinite(pos) ? pos : index,
        map: m,
        index,
      });
    }
    return out.sort((a, b) => a.pos - b.pos || a.index - b.index);
  }

  /** The place for a page that goes at `at` in the page list (without `except`): between its neighbours. */
  #posAt(at: number, except?: string): number {
    const list = this.#pageEntries().filter((e) => e.info.id !== except);
    if (!list.length) return 0;
    if (at <= 0) return list[0].pos - 1;
    if (at >= list.length) return list[list.length - 1].pos + 1;
    return (list[at - 1].pos + list[at].pos) / 2;
  }

  /** The pages for an agent: id, title, how many blocks (all levels). */
  pages(): { id: string; title: string; blocks: number }[] {
    return this.pageList().map((p) => ({ id: p.id, title: p.title, blocks: this.#walk(rootOf(p.id)).length }));
  }

  get firstPage(): string {
    return this.pageList()[0].id;
  }

  /** The first page's fragment (the whole doc before pages). */
  get frag(): Y.XmlFragment {
    return this.fragOf(this.firstPage);
  }

  fragOf(page: string): Y.XmlFragment {
    const r = this.#roots.get(rootOf(page));
    if (!r) throw new DocRefusal('no_page', `There is no page ${JSON.stringify(page)} in this doc. Its pages: ${this.#pageNames()}.`);
    return r.frag;
  }

  /** Every page's fragment, in page order. */
  pageFrags(): { page: string; frag: Y.XmlFragment }[] {
    return this.pageList().filter((p) => this.#roots.has(rootOf(p.id))).map((p) => ({ page: p.id, frag: this.#roots.get(rootOf(p.id))!.frag }));
  }

  #pageNames(): string {
    return this.pageList().map((p) => `${p.id} ("${p.title}")`).join(', ');
  }

  /** A page from what an agent gave: its id or its title (case does not matter). Nothing given: the first page. */
  resolvePage(value: unknown): string {
    if (value === undefined || value === null || value === '') return this.firstPage;
    const list = this.pageList();
    if (typeof value === 'string') {
      const v = value.trim();
      const byId = list.find((p) => p.id === v);
      if (byId) return byId.id;
      const byTitle = list.filter((p) => p.title.toLowerCase() === v.toLowerCase());
      if (byTitle.length === 1) return byTitle[0].id;
      if (byTitle.length > 1) {
        throw new DocRefusal('bad_page', `Several pages are titled "${v}": name the page by its id. Pages: ${this.#pageNames()}.`);
      }
    }
    throw new DocRefusal('no_page', `There is no page ${JSON.stringify(value)} in this doc. Its pages: ${this.#pageNames()}.`);
  }

  /** The page a block is on. */
  pageOf(id: string): string {
    let e = this.#entries.get(id);
    while (e && !this.#roots.has(e.id)) e = this.#entries.get(e.parent);
    return e ? this.#roots.get(e.id)!.page : this.firstPage;
  }

  #pageEntry(page: string): Y.Map<unknown> | null {
    return this.pagesArr.toArray().find((m) => m instanceof Y.Map && m.get('id') === page) ?? null;
  }

  /** A transaction origin for page operations: the author is the agent, but its doc_undo does not track them. */
  #pageOrigin(origin: Origin): Origin {
    return { kind: origin.kind, name: origin.name };
  }

  /** Register pages that appeared, forget pages that went, note titles and places that changed. True if any did. */
  #syncPages(rev: number, by: string | null): boolean {
    const list = this.pageList();
    let changed = false;
    const ids = new Set(list.map((p) => p.id));
    for (const [rid, r] of [...this.#roots]) {
      if (ids.has(r.page)) continue;
      const root = this.#entries.get(rid)!;
      for (const k of root.kids ?? []) this.#remove(k, rev);
      this.#entries.delete(rid);
      this.#roots.delete(rid);
      this.#fragRoot.delete(r.frag);
      this.#pageRevs.delete(r.page);
      this.#pageSeen.delete(r.page);
      this.#gonePages.set(r.page, rev);
      changed = true;
    }
    list.forEach((p, index) => {
      const rid = rootOf(p.id);
      if (!this.#roots.has(rid)) {
        const frag = this.doc.getXmlFragment(p.field);
        this.#roots.set(rid, { page: p.id, frag });
        this.#fragRoot.set(frag, rid);
        this.#entries.set(rid, { id: rid, el: null, parent: '', kids: [], h: '', md: '', rev, sub: rev, born: rev });
        this.#rescan(rid, rev, by);
        for (const um of this.#undo.values()) um.addToScope(frag);
        this.#pageRevs.set(p.id, [rev, rev]);
        this.#gonePages.delete(p.id);
        changed = true;
      }
      const seen = this.#pageSeen.get(p.id);
      if (!seen || seen.title !== p.title || seen.index !== index) {
        if (seen) {
          this.#pageRevs.set(p.id, [rev, this.#pageRevs.get(p.id)?.[1] ?? rev]);
          if (seen.title !== p.title) this.titles.set(p.id, { rev, by });
          changed = true;
        }
        this.#pageSeen.set(p.id, { title: p.title, index });
      }
    });
    return changed;
  }

  // ---------- the block index ----------

  #isDeleted(t: YType | null): boolean {
    for (let x = t; x; x = x.parent as YType | null) {
      if (x._item?.deleted) return true;
    }
    return false;
  }

  #childElements(id: string): Y.XmlElement[] {
    const el = this.#roots.get(id)?.frag ?? this.#entries.get(id)!.el!;
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
    const isRoot = this.#roots.has(id);
    const now: string[] = [];
    const known = new Set(e.kids ?? []);
    let changed = false;
    for (const el of this.#childElements(id)) {
      const kid = idOf(el);
      const had = this.#entries.get(kid);
      if (!had) {
        this.#add(el, id, rev, by);
        changed = true;
      } else known.delete(kid);
      now.push(kid);
    }
    for (const gone of known) {
      this.#remove(gone, rev);
      changed = true;
    }
    const h = isRoot ? '' : this.#containerHash(e.el!.nodeName, e.el!.getAttributes(), now);
    if (changed || h !== e.h || now.join() !== (e.kids ?? []).join()) {
      e.kids = now;
      if (!isRoot) {
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
    let changed = false;
    const pagesTouched = [...tr.changed.keys()].some((t) =>
      t === (this.pagesArr as unknown as YType) || t.parent === (this.pagesArr as unknown as YType)
    );
    if (pagesTouched && this.#syncPages(next, by)) changed = true;
    const dirty = new Set<string>();
    const rootsDirty = new Set<string>();
    for (const type of tr.changed.keys()) {
      for (let t: YType | null = type; t; t = t.parent as YType | null) {
        const rid = this.#fragRoot.get(t as Y.XmlFragment);
        if (rid) {
          rootsDirty.add(rid);
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
    for (const rid of rootsDirty) if (this.#rescan(rid, next, by)) changed = true;
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
      if (e.el!.nodeName === 'chart') {
        try {
          v.data = chartRows(jsonOf(e.el!).content?.[0] ?? { type: 'table' });
        } catch { /* unreadable mid-change */ }
      }
    } else {
      v.md = e.md;
      const align = e.el!.getAttribute('align');
      if (align) v.attrs = { align };
      if (TEXTBLOCKS.has(e.el!.nodeName)) {
        const styles = stylesOf(e.el!);
        if (styles.length) v.styles = styles;
      }
    }
    if (extra && !this.#roots.has(e.parent)) v.parent = e.parent;
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

  /** Who changed a block last ('user', an agent's name, 'file'), if known. */
  byOf(id: string): string | undefined {
    return this.#entries.get(id)?.by;
  }

  /** When a block (or anything inside it) last changed; null when it is gone. */
  subOf(id: string): number | null {
    const e = this.#entries.get(id);
    return e && e.el && !this.#isDeleted(e.el) ? e.sub : null;
  }

  /** A live block's element (null when gone). */
  elementOf(id: string): Y.XmlElement | null {
    const e = this.#entries.get(id);
    return e && e.el && !this.#isDeleted(e.el) ? e.el : null;
  }

  has(id: string): boolean {
    return this.#entries.has(id) && !this.#roots.has(id);
  }

  /**
   * The rev a page last changed at (a block on it, its title or place), and how many of its blocks changed after `sinceRev`: an
   * artifact built from the page ("Built from Release plan › Rollout") is stale once this moves past the rev it was built at.
   */
  pageRev(page: string, sinceRev = Infinity): { rev: number; edits: number } {
    let rev = this.#pageRevs.get(page)?.[0] ?? 0, edits = 0;
    for (const { id } of this.#walk(rootOf(page))) {
      const e = this.#entries.get(id)!;
      if (e.rev > rev) rev = e.rev;
      if (e.rev > sinceRev) edits++;
    }
    return { rev, edits };
  }

  /** All blocks in doc order, with depth (0 = top level). */
  #walk(
    from: string,
    depth = 0,
    out: { id: string; depth: number }[] = [],
  ): { id: string; depth: number }[] {
    for (const kid of this.#entries.get(from)?.kids ?? []) {
      out.push({ id: kid, depth });
      this.#walk(kid, depth + 1, out);
    }
    return out;
  }

  /** A page's top-level block ids (default: the first page). */
  topIds(page?: string): string[] {
    return [...(this.#entries.get(rootOf(page ?? this.firstPage))?.kids ?? [])];
  }

  /** Blocks of the whole doc (all pages, all levels). */
  get blockCount(): number {
    return this.#entries.size - this.#roots.size;
  }

  /** A page's top-level blocks as the Markdown writer needs them (JSON cached per block until something inside it changes). */
  topBlocks(page?: string): DocBlock[] {
    return this.topIds(page).map((id) => {
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
   * doc_read, on one page (`page`: its id or title; default the first page). mode "outline": the pages, the page's headings and its
   * top-level blocks with a preview; "full" (default): every block of the page in order; "block" + id: that block (on whatever page)
   * and everything inside it, with its whole Markdown; "search" + query: the text blocks holding the words (every page unless `page`).
   */
  read(
    opts: { mode?: unknown; id?: unknown; query?: unknown; ids?: unknown; page?: unknown } = {},
  ): Json {
    const mode = typeof opts.mode === 'string' ? opts.mode : opts.id ? 'block' : opts.query ? 'search' : 'full';
    const base = { rev: this.rev };
    if (mode === 'block') {
      const id = String(opts.id ?? '');
      if (!this.has(id)) throw this.#goneRefusal(id, 'read');
      return {
        ...base,
        page: this.pageOf(id),
        block: this.view(id, true),
        md: this.markdownOf(id),
        blocks: this.#walk(id, 1).map(({ id: k, depth }) => ({ ...this.view(k, true), depth })),
      };
    }
    if (mode === 'search') {
      const q = String(opts.query ?? '').toLowerCase();
      if (!q) throw new DocRefusal('bad_op', 'search needs "query": the words to look for');
      const pages = opts.page === undefined || opts.page === null || opts.page === ''
        ? this.pageList().map((p) => p.id)
        : [this.resolvePage(opts.page)];
      const hits: Json[] = [];
      for (const page of pages) {
        for (const { id } of this.#walk(rootOf(page))) {
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
          if (at.length) hits.push({ ...this.view(id, true), page, at });
        }
      }
      return { ...base, query: opts.query, hits };
    }
    const page = this.resolvePage(opts.page);
    const root = rootOf(page);
    if (mode === 'outline') {
      const top = this.topIds(page);
      const outline = this.#walk(root).filter(({ id }) => this.#entries.get(id)!.el!.nodeName === 'heading').map(({ id, depth }) => {
        const e = this.#entries.get(id)!;
        return { id, level: Number(e.el!.getAttribute('level')) || 1, text: textOf(e.el!), ...(depth ? { parent: e.parent } : {}) };
      });
      return {
        ...base,
        pages: this.pages(),
        page,
        count: top.length,
        outline,
        blocks: top.map((id) => {
          const e = this.#entries.get(id)!;
          const md = e.kids ? this.markdownOf(id) : e.md;
          return { id, type: e.el!.nodeName, h: e.h, preview: md.length > 100 ? md.slice(0, 100) + '…' : md };
        }),
      };
    }
    if (mode !== 'full') throw new DocRefusal('bad_op', '`mode` is outline, full, block (with id) or search (with query)');
    const only = Array.isArray(opts.ids) ? new Set(opts.ids.map(String)) : null;
    return {
      ...base,
      page,
      ...(this.#roots.size > 1 ? { pages: this.pages() } : {}),
      blocks: this.#walk(root).filter(({ id }) => !only || only.has(id)).map((
        { id, depth },
      ) => ({ ...this.view(id, true), ...(depth ? { depth } : {}) })),
    };
  }

  /**
   * doc_changes: the blocks changed after `sinceRev` on every page (each with its `page`, `after`, the block before it, and
   * `parent`), the ones gone, and the pages added, renamed or moved (`pagesChanged`) or deleted (`pagesGone`) since.
   */
  changes(sinceRev: number): Json {
    const changed: Json[] = [];
    for (const { id: page } of this.pageList()) {
      for (const { id } of this.#walk(rootOf(page))) {
        const e = this.#entries.get(id)!;
        if (e.rev <= sinceRev) continue;
        const sibs = this.#entries.get(e.parent)?.kids ?? [];
        const i = sibs.indexOf(id);
        changed.push({
          ...this.view(id, true),
          page,
          after: i > 0 ? sibs[i - 1] : null,
          ...(e.born > sinceRev ? { new: true } : {}),
        });
      }
    }
    const gone = [...this.#gone].filter(([, [rev, born]]) => rev > sinceRev && born <= sinceRev).map(([id]) => id);
    const list = this.pageList();
    const pagesChanged = list.flatMap((p, index) => {
      const [rev, born] = this.#pageRevs.get(p.id) ?? [0, 0];
      return rev > sinceRev ? [{ id: p.id, title: p.title, index, ...(born > sinceRev ? { new: true } : {}) }] : [];
    });
    const pagesGone = [...this.#gonePages].filter(([, rev]) => rev > sinceRev).map(([id]) => id);
    return {
      rev: this.rev,
      sinceRev,
      changed,
      gone,
      ...(pagesChanged.length ? { pagesChanged } : {}),
      ...(pagesGone.length ? { pagesGone } : {}),
    };
  }

  // ---------- agent edits ----------

  /**
   * doc_edit: run the ops in order, all or nothing. Guards are judged on the doc as it stood before the first op; the ops are then
   * tried on a copy of the doc (and the result checked against the schema), and only when every op succeeds there are they applied
   * to the live doc, in the same synchronous turn, so nothing can come in between. Returns the ack: the new rev and what changed.
   * The ops work on one page: `page` (id or title), else the page of the first block id they name, else the first page.
   */
  edit(ops: unknown, origin: Origin, pageValue?: unknown): Json {
    if (!Array.isArray(ops) || !ops.length) throw new DocRefusal('bad_op', '`ops` must be a non-empty list of ops');
    const page = this.#pageForOps(ops as Op[], pageValue);
    (ops as Op[]).forEach((op, i) => this.#checkGuard(op, i, page));
    const mark = origin.kind === 'agent' ? { by: origin.name } : origin.kind === 'file' ? { by: 'file' } : null;
    const field = this.#roots.get(rootOf(page))!.frag;
    const fieldName = this.pageList().find((p) => p.id === page)!.field;
    // dry run on a copy
    const copy = new Y.Doc();
    Y.applyUpdate(copy, this.encode());
    const copyFrag = copy.getXmlFragment(fieldName);
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
    const chartsBefore = chartsIn(copyFrag);
    try {
      copy.transact(() => applyOps(dry, ops as Op[], afterOp));
      validate(dry);
      checkCharts(copyFrag, chartsBefore);
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
    const live = ctxFor(this.doc, field, (id) => {
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
      page,
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
  range(target: unknown, page?: unknown): { el: Y.XmlElement; from: number; to: number } {
    const t = (target && typeof target === 'object' ? target : {}) as Target;
    if (t.kind === 'find') {
      const ctx = ctxFor(this.doc, this.fragOf(this.resolvePage(page)), () => null, null);
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

  /** Replace a page's whole content (default the first page; restore from history, a doc made from a file). Not guarded: callers check. */
  replaceAll(nodes: PMJson[], origin: Origin, page?: string): void {
    if (origin.kind === 'agent' || origin.kind === 'file') this.beforeEdit?.(origin.kind === 'file' ? 'file' : origin.name);
    const frag = this.fragOf(page ?? this.firstPage);
    this.doc.transact(() => {
      if (frag.length) frag.delete(0, frag.length);
      insertNodes(this.doc, frag, 0, nodes.length ? nodes : [{ type: 'paragraph' }]);
    }, origin);
  }

  /**
   * Set the pages to exactly these, in this order (restore from history): a page that exists keeps its id and gets this content; a
   * new one is made; one not listed goes. Not guarded: callers check.
   */
  setPages(pages: { id: string; title: string; nodes: PMJson[] }[], origin: Origin): void {
    if (!pages.length) return;
    if (origin.kind === 'agent' || origin.kind === 'file') this.beforeEdit?.(origin.kind === 'file' ? 'file' : origin.name);
    const fields = new Map(this.pageList().map((p) => [p.id, p.field]));
    const frags = pages.map((p) => this.doc.getXmlFragment(fields.get(p.id) ?? fieldOf(p.id)));
    for (const f of frags) for (const um of this.#undo.values()) um.addToScope(f);
    const keep = new Set(pages.map((p) => p.id));
    this.doc.transact(() => {
      for (const p of this.pageList()) {
        if (keep.has(p.id)) continue;
        const f = this.doc.getXmlFragment(p.field);
        if (f.length) f.delete(0, f.length);
      }
      pages.forEach((p, k) => {
        const f = frags[k];
        if (f.length) f.delete(0, f.length);
        insertNodes(this.doc, f, 0, p.nodes.length ? p.nodes : [{ type: 'paragraph' }]);
      });
      this.pagesArr.delete(0, this.pagesArr.length);
      this.pagesArr.insert(0, pages.map((p, k) => newPageMap(p.id, p.title, fields.get(p.id) ?? fieldOf(p.id), k)));
    }, origin);
  }

  // ---------- page operations (agents; the page's own editor changes PAGES directly) ----------

  #checkTitle(title: string, except?: string): void {
    const clash = this.pageList().find((p) => p.id !== except && p.title.toLowerCase() === title.toLowerCase());
    if (clash) throw new DocRefusal('page_exists', `A page titled "${clash.title}" exists already (${clash.id}): pick another title.`);
  }

  /**
   * A new page titled `title`, after `after` (a page; default: at the end), holding `markdown` (default one empty paragraph). The
   * agent's words carry its mark. Its doc_undo does not take page operations back: delete_page does.
   */
  addPage(title: unknown, origin: Origin, opts: { after?: unknown; markdown?: unknown; nodes?: PMJson[]; id?: string } = {}): Json {
    const t = pageTitle(title);
    this.#checkTitle(t);
    const list = this.pageList();
    const at = opts.after === undefined || opts.after === null
      ? list.length
      : list.findIndex((p) => p.id === this.resolvePage(opts.after)) + 1;
    let nodes: PMJson[] = opts.nodes?.length ? opts.nodes : [{ type: 'paragraph' }];
    if (!opts.nodes && opts.markdown !== undefined && opts.markdown !== '') {
      if (typeof opts.markdown !== 'string') throw new DocRefusal('bad_op', "`markdown` is the page's first content, as a string");
      nodes = sourceNodes({ from: { kind: 'inline', content: opts.markdown }, as: 'markdown' }, 0, 'doc');
    }
    const mark = origin.kind === 'agent' ? { by: origin.name } : origin.kind === 'file' ? { by: 'file' } : null;
    const ready = nodes.map((n) => withMark(n, mark, 'doc'));
    for (const n of ready) {
      try {
        schema.nodeFromJSON(n).check();
      } catch (error) {
        throw new DocRefusal('bad_op', `a ${n.type} that the editor cannot hold: ${(error as Error).message}`);
      }
    }
    const free = (x: string) => !list.some((p) => p.id === x) && !this.#gonePages.has(x);
    const id = opts.id && /^[A-Za-z0-9_-]{1,40}$/.test(opts.id) && free(opts.id)
      ? opts.id
      : newPageId((x) => !free(x) || x === FIRST_PAGE);
    const frag = this.doc.getXmlFragment(fieldOf(id));
    if (origin.kind === 'agent' || origin.kind === 'file') this.beforeEdit?.(origin.kind === 'file' ? 'file' : origin.name);
    this.doc.transact(() => {
      this.pagesArr.push([newPageMap(id, t, fieldOf(id), this.#posAt(at))]);
      insertNodes(this.doc, frag, 0, ready);
    }, this.#pageOrigin(origin));
    return { ok: true, rev: this.rev, page: id, title: t, created: this.topIds(id), pages: this.pages() };
  }

  /**
   * Rename a page. With `ifRev`: refused if the page changed after that rev. An agent's rename (`seenRev`: the rev of its last read)
   * is refused when the user renamed the page after that read: the user's title stays.
   */
  renamePage(pageValue: unknown, title: unknown, origin: Origin, ifRev?: unknown, seenRev?: number): Json {
    const page = this.resolvePage(pageValue);
    const t = pageTitle(title);
    this.#checkTitle(t, page);
    this.#pageGuard(page, ifRev, false);
    const renamed = this.titles.get(page);
    const seen = typeof ifRev === 'number' ? ifRev : seenRev;
    if (origin.kind === 'agent' && renamed?.by === 'user' && seen !== undefined && renamed.rev > seen) {
      const now = this.pageList().find((p) => p.id === page)!.title;
      throw new DocRefusal(
        'user_renamed',
        `Not renamed: the user renamed this page to "${now}" after your read (rev ${seen}). Their title stays; keep it.`,
        { rev: this.rev, page, title: now },
      );
    }
    const m = this.#pageEntry(page)!;
    if (m.get('title') !== t) this.doc.transact(() => m.set('title', t), this.#pageOrigin(origin));
    return { ok: true, rev: this.rev, page, title: t, pages: this.pages() };
  }

  /** Move a page: after `after` (a page), or to the start when `after` is null or left out. */
  movePage(pageValue: unknown, after: unknown, origin: Origin): Json {
    const page = this.resolvePage(pageValue);
    const list = this.pageList();
    const target = after === null || after === undefined || after === '' ? null : this.resolvePage(after);
    if (target === page) throw new DocRefusal('bad_op', 'a page cannot go after itself');
    const rest = list.filter((p) => p.id !== page);
    const at = target === null ? 0 : rest.findIndex((p) => p.id === target) + 1;
    const from = list.findIndex((p) => p.id === page);
    if (at !== from) {
      // by place, not delete + insert: the page's map stays, so a rename made meanwhile is kept
      const pos = this.#posAt(at, page);
      this.doc.transact(() => this.#pageEntry(page)!.set('pos', pos), this.#pageOrigin(origin));
    }
    return { ok: true, rev: this.rev, page, index: this.pageList().findIndex((p) => p.id === page), pages: this.pages() };
  }

  /** Refused when the page (its blocks, title or place) changed after `ifRev`. `need`: ifRev must be given. */
  #pageGuard(page: string, ifRev: unknown, need: boolean): void {
    if (ifRev === undefined && !need) return;
    if (typeof ifRev !== 'number') {
      throw new DocRefusal('missing_guard', 'deleting a page needs "ifRev": the rev of the read that showed it (doc_read outline lists pages).');
    }
    if (ifRev > this.rev) {
      throw new DocRefusal('guard_mismatch', `ifRev ${ifRev} is newer than the doc (rev ${this.rev}); use a rev you read`, { rev: this.rev });
    }
    const root = this.#entries.get(rootOf(page))!;
    const [prev] = this.#pageRevs.get(page) ?? [0, 0];
    if (root.sub > ifRev || prev > ifRev) {
      throw new DocRefusal(
        'guard_mismatch',
        `page ${page} changed after your read (rev ${ifRev}); read it again (doc_read with its page) and decide from what stands.`,
        { rev: this.rev, page },
      );
    }
  }

  /** Blocks on the page with words in them that the user (or a file edit) wrote, or that came in with the doc. */
  #userMade(page: string): string[] {
    return this.#walk(rootOf(page)).map(({ id }) => this.#entries.get(id)!).filter((e) => {
      if (e.by && e.by !== 'user' && e.by !== 'file') return false;
      return e.kids ? false : e.md.trim() !== '';
    }).map((e) => e.id);
  }

  /**
   * Delete a page, guarded by `ifRev` (nothing on it changed since your read). A page with the user's words on it also needs
   * `allowUserContent` (only when the user asked for it); one with open comment threads on its words needs `allowDetach`.
   */
  deletePage(
    pageValue: unknown,
    origin: Origin,
    opts: { ifRev?: unknown; allowUserContent?: unknown; allowDetach?: unknown; check?: boolean } = {},
  ): Json {
    const page = this.resolvePage(pageValue);
    const list = this.pageList();
    if (list.length < 2) {
      throw new DocRefusal('last_page', 'a doc keeps at least one page. To clear it, replace its blocks instead.');
    }
    this.#pageGuard(page, opts.ifRev, true);
    const user = this.#userMade(page);
    if (user.length && opts.allowUserContent !== true) {
      throw new DocRefusal(
        'user_content',
        `Not deleted: page "${list.find((p) => p.id === page)!.title}" holds the user's words (${user.length} block(s)). Delete it ` +
          'only when the user asked for that: then resend with "allowUserContent": true.',
        { page, blocks: user.slice(0, 10).map((id) => ({ ...this.view(id, true), md: this.markdownOf(id) })) },
      );
    }
    const threads = this.comments.guards().filter((g) => {
      const block = this.comments.view(g.thread).block;
      return block !== undefined && this.has(block) && this.pageOf(block) === page;
    });
    if (threads.length && opts.allowDetach !== true) {
      throw new DocRefusal(
        'anchors_affected',
        `Not deleted: comment threads hang on words of this page: ${threads.map((t) => `${t.thread} on "${t.quote}"`).join(', ')}. ` +
          'Only when the user asked for this, resend with "allowDetach": true: the threads stay, marked detached.',
        { page, threads: threads.map((t) => ({ thread: t.thread, quote: t.quote, by: t.by })) },
      );
    }
    if (opts.check) return { ok: true, rev: this.rev, page, title: list.find((p) => p.id === page)!.title };
    const frag = this.fragOf(page);
    if (origin.kind === 'agent' || origin.kind === 'file') this.beforeEdit?.(origin.kind === 'file' ? 'file' : origin.name);
    const o = this.#pageOrigin(origin);
    this.doc.transact(() => {
      const i = this.pagesArr.toArray().findIndex((m) => m instanceof Y.Map && m.get('id') === page);
      this.pagesArr.delete(i, 1);
      if (frag.length) frag.delete(0, frag.length);
    }, o);
    if (threads.length) this.comments.detach(threads.map((t) => t.thread), origin.name, 'edited', o);
    return { ok: true, rev: this.rev, deleted: page, pages: this.pages() };
  }

  #pageForOps(ops: Op[], value: unknown): string {
    if (value !== undefined && value !== null && value !== '') return this.resolvePage(value);
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      for (const t of [op.target, op.to?.target]) {
        if (t && typeof t === 'object' && t.kind === 'blocks' && Array.isArray(t.ids)) {
          for (const id of t.ids) if (typeof id === 'string' && this.has(id)) return this.pageOf(id);
        }
      }
    }
    return this.firstPage;
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

  #onPage(id: string, page: string, index: number): void {
    if (!this.has(id)) throw this.#goneRefusal(id, index);
    const on = this.pageOf(id);
    if (on !== page) {
      const title = (p: string) => this.pageList().find((x) => x.id === p)?.title ?? p;
      throw new DocRefusal(
        'wrong_page',
        `op ${index}: block ${id} is on page ${on} ("${title(on)}"), not on ${page} ("${title(page)}"). One call edits one page: ` +
          'send "page" with the block\'s page (blocks do not move between pages).',
        { op: index, id, page: on },
      );
    }
  }

  #checkGuard(op: Op, index: number, page: string): void {
    if (!op || typeof op !== 'object' || !OPS.has(op.op)) {
      throw new DocRefusal('bad_op', `op ${index}: "op" must be one of ${[...OPS].join(', ')}`, { op: index });
    }
    const target = op.target;
    if (!target || typeof target !== 'object') throw new DocRefusal('bad_op', `op ${index}: missing "target"`, { op: index });
    if (
      op.op === 'insert' || op.op === 'table_row_insert' || op.op === 'table_col_insert' || op.op === 'chart_from_table'
    ) {
      if (target.kind === 'blocks') {
        for (const id of idsOf(target, index)) this.#onPage(id, page, index);
      }
      return;
    }
    if (target.kind === 'find') {
      if (op.op !== 'replace' && op.op !== 'delete' && op.op !== 'style') {
        throw new DocRefusal(
          'bad_op',
          `op ${index}: a find target is for replace (re-word), delete and style; ${op.op} takes block ids`,
          { op: index },
        );
      }
      return;
    }
    if (target.kind !== 'blocks') throw new DocRefusal('bad_op', `op ${index}: target.kind must be "blocks" or "find"`, { op: index });
    const ids = idsOf(target, index);
    for (const id of ids) this.#onPage(id, page, index);
    if (op.op === 'move') {
      const dest = op.to?.target;
      if (dest?.kind === 'blocks') {
        for (const id of idsOf(dest, index)) this.#onPage(id, page, index);
      }
    }
    if (op.force === true) return;
    const tableOp = TABLE_GUARDED.has(op.op);
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
      const watched = this.#tableWatched(ids[0], op);
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

  /** The ids of the rows or cells a guarded table op touches (judged on the doc as it stands). */
  #tableWatched(table: string, op: Op): string[] {
    const rows = this.#entries.get(table)!.kids!;
    const cellId = (r: number, i: number) => this.#entries.get(rows[r])?.kids?.[i];
    if (op.op === 'table_row_delete') return [rows[Number(op.at)]].filter(Boolean);
    const { grid } = tableGrid(jsonOf(this.#entries.get(table)!.el!));
    const ids = new Set<string>();
    const add = (r: number, c: number) => {
      const at = grid[r]?.[c];
      const id = at ? cellId(at.r, at.i) : undefined;
      if (id) ids.add(id);
    };
    if (op.op === 'table_col_delete') grid.forEach((_, r) => add(r, Number(op.at)));
    else if (op.op === 'table_merge') {
      const box = cornersOf(op.cells);
      if (box) for (let r = box[0]; r <= box[2]; r++) for (let c = box[1]; c <= box[3]; c++) add(r, c);
    } else if (op.op === 'table_split') {
      const at = pairOf(op.at);
      if (at) add(at[0], at[1]);
    } else {
      // table_header: the first row and the first column
      grid.forEach((g, r) => g.forEach((_, c) => (r === 0 || c === 0) && add(r, c)));
    }
    return [...ids];
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

  /** A JSON control message (a text frame) to every page socket: hello, reopen, refused notes, history marks, requests. */
  sendControl(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    for (const link of this.#sockets.keys()) link.send(text);
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
    let nodes: PMJson[];
    try {
      nodes = (content as PMJson[]).map((n) => shorthand(n, index));
      for (const n of nodes) schema.nodeFromJSON(n);
    } catch (error) {
      if (error instanceof DocRefusal) throw error;
      throw new DocRefusal('bad_op', `op ${index}: not a node of this doc's schema: ${(error as Error).message}`, { op: index });
    }
    return fit(parentType, nodes, index);
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
  const nodes = alertsToCallouts(parseBlockMarkdown(text));
  if (!nodes.length) throw new DocRefusal('bad_op', `op ${index}: the Markdown has no blocks`, { op: index });
  return fit(parentType, nodes, index);
}

/**
 * "as":"blocks" nodes may give their content as Markdown: {"type":"callout","attrs":{"variant":"warning"},"md":"…"},
 * {"type":"toggle","summary":"Rollback steps","md":"1. Turn it off"}, {"type":"columns","content":[{"type":"column","md":"…"},…]},
 * a textblock {"type":"paragraph","md":"**bold** words"}. Expanded here into plain nodes.
 */
function shorthand(node: unknown, index: number): PMJson {
  if (!node || typeof node !== 'object' || typeof (node as PMJson).type !== 'string') {
    throw new DocRefusal('bad_op', `op ${index}: each block is an object with a "type"`, { op: index });
  }
  const { md, summary, data, ...rest } = node as PMJson & { md?: unknown; summary?: unknown; data?: unknown };
  const out: PMJson = { ...rest };
  if (data !== undefined) {
    if (out.type !== 'chart' || !Array.isArray(data) || !data.length || !data.every((r) => Array.isArray(r))) {
      throw new DocRefusal(
        'bad_op',
        `op ${index}: "data" is a chart's numbers: rows, the first one the series names ([["Week","Old","New"],["Week 1",3.1,3.3]])`,
        { op: index },
      );
    }
    out.content = [chartTable(data as unknown[][])];
  }
  if (md !== undefined) {
    if (typeof md !== 'string') throw new DocRefusal('bad_op', `op ${index}: "md" is Markdown, a string`, { op: index });
    if (TEXTBLOCKS.has(out.type)) out.content = md ? parseInline(md) : [];
    else out.content = md.trim() ? alertsToCallouts(parseBlockMarkdown(md)) : [{ type: 'paragraph' }];
  } else if (Array.isArray(out.content)) out.content = out.content.map((c) => shorthand(c, index));
  if (summary !== undefined) {
    if (out.type !== 'toggle' || typeof summary !== 'string') {
      throw new DocRefusal('bad_op', `op ${index}: "summary" is a toggle's line, a string`, { op: index });
    }
    const line = parseInline(summary);
    out.content = [line.length ? { type: 'paragraph', content: line } : { type: 'paragraph' }, ...(out.content ?? [])];
  }
  if (out.content && !out.content.length) delete out.content;
  return out;
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
  if (parentType === 'columns') {
    // into columns: whole columns, or blocks that make one new column
    if (nodes.every((n) => n.type === 'column')) return nodes;
    if (nodes.some((n) => n.type === 'column')) throw new DocRefusal('bad_op', `op ${index}: give columns or blocks, not both`, { op: index });
    return [{ type: 'column', content: fit('column', nodes, index) }];
  }
  if (parentType === 'tableRow') {
    throw new DocRefusal(
      'bad_op',
      `op ${index}: cells come and go a column at a time: use table_col_insert / table_col_delete`,
      { op: index },
    );
  }
  for (const n of nodes) {
    if (n.type === 'column') {
      throw new DocRefusal('bad_op', `op ${index}: a column goes only inside columns (side "start"/"end" of a columns id)`, { op: index });
    }
    if (n.type === 'columns' && parentType !== 'doc') {
      throw new DocRefusal('bad_op', `op ${index}: columns sit only at the top of a page, not inside a ${parentType}`, { op: index });
    }
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
        `op ${index}: side "${s}" puts blocks inside a list, item, quote, table, cell, callout, columns, column or toggle; a ` +
          `${el.nodeName} takes "before" or "after"`,
        { op: index },
      );
    }
    if (el.nodeName === 'tableRow') {
      throw new DocRefusal('bad_op', `op ${index}: cells come and go a column at a time: use table_col_insert`, { op: index });
    }
    // a toggle's first paragraph is its line: "start" is the top of what it opens
    return { parent: el, at: s === 'start' ? (el.nodeName === 'toggle' ? 1 : 0) : el.length };
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
  const ready = (mark ? nodes.map((n) => withMark(n, ctx.mark, parentType)) : nodes).map(withChartIds);
  for (const n of ready) {
    try {
      schema.nodeFromJSON(n).check();
    } catch (error) {
      throw new DocRefusal('bad_op', `a ${n.type} that the editor cannot hold: ${(error as Error).message}`);
    }
  }
  const els = insertNodes(ctx.doc, parent, at, ready);
  if (els.some(nestedCallout)) throw new DocRefusal('bad_op', 'a callout cannot hold another callout');
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
  align: (v) => v === null || ALIGNS.includes(v as string),
  intent: (v) => typeof v === 'string',
  variant: (v) => CALLOUT_VARIANTS.includes(v as string),
  width: (v) => v === null || (typeof v === 'number' && v >= 0.1 && v <= 0.9),
  chartType: (v) => CHART_TYPES.includes(v as string),
  title: (v) => typeof v === 'string' && v.length <= 200,
  caption: (v) => typeof v === 'string' && v.length <= 500,
  chart: () => false, // a chart's id is AIB's
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
      case 'style':
        return styleOp(ctx, op, index);
      case 'chart_from_table':
        return chartFromTableOp(ctx, op, index);
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
  if (op.op === 'table_merge' || op.op === 'table_split' || op.op === 'table_header') return cellsOp(ctx, table, op, index);
  if (hasSpans(jsonOf(table))) {
    throw new DocRefusal(
      'bad_op',
      `op ${index}: this table has merged cells; split them first (table_split), then add or remove rows and columns`,
      { op: index },
    );
  }
  const rows = table.toArray() as Y.XmlElement[];
  const cols = rows[0]?.length ?? 0;
  const headerCells = (rows[0]?.toArray() ?? []) as Y.XmlElement[];
  const at = op.at as number | undefined;
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

/** [row, col] from an agent's value. */
function pairOf(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x >= 0) ? [v[0], v[1]] : null;
}

/** The box two corners [[r1,c1],[r2,c2]] span: [top, left, bottom, right]. */
function cornersOf(v: unknown): [number, number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = pairOf(v[0]), b = pairOf(v[1]);
  if (!a || !b) return null;
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

const emptyBlock = (n: PMJson) => n.type === 'paragraph' && !n.content?.length;

/**
 * Merge cells (table_merge: "cells" = two corners [[row, col], [row, col]], 0-based squares of the grid, row 0 the first row), split
 * a merged cell (table_split: "at" = [row, col] of any square it covers), header row / column on or off (table_header: "row",
 * "col"). The table is rewritten through y-tiptap's reconciliation, so rows and cells it does not change keep their ids.
 */
function cellsOp(ctx: Ctx, table: Y.XmlElement, op: Op, index: number): void {
  const json = jsonOf(table);
  const rows = json.content ?? [];
  const { grid, cols, start } = tableGrid(json);
  const cellAt = (r: number, i: number) => rows[r].content![i];
  const out: PMJson[][] = rows.map(() => []);
  const bad = (message: string) => new DocRefusal('bad_op', `op ${index}: ${message}`, { op: index });
  if (op.op === 'table_merge') {
    const box = cornersOf(op.cells);
    if (!box) throw bad('table_merge takes "cells": two corners [[row, col], [row, col]] (0-based)');
    const [top, left, bottom, right] = box;
    if (bottom >= rows.length || right >= cols) throw bad(`the table has ${rows.length} rows and ${cols} columns`);
    const inside = new Set<string>();
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        const at = grid[r][c];
        if (!at) throw bad(`no cell at [${r}, ${c}]`);
        inside.add(`${at.r},${at.i}`);
      }
    }
    if (inside.size < 2) throw bad('that is one cell already; give two corners further apart');
    for (const key of inside) {
      const [r, i] = key.split(',').map(Number);
      const [sr, sc] = start.get(key)!;
      const cell = cellAt(r, i);
      const er = sr + (Number(cell.attrs?.rowspan) || 1) - 1, ec = sc + (Number(cell.attrs?.colspan) || 1) - 1;
      if (sr < top || sc < left || er > bottom || ec > right) throw bad(`a merged cell crosses the edge of that box: split it first`);
    }
    const first = grid[top][left]!;
    const kept: PMJson[] = [];
    rows.forEach((row, r) => {
      (row.content ?? []).forEach((cell, i) => {
        const key = `${r},${i}`;
        if (!inside.has(key)) return void out[r].push(cell);
        if (r === first.r && i === first.i) return void out[r].push(cell); // filled below
        kept.push(...(cell.content ?? []).filter((n) => !emptyBlock(n)));
      });
    });
    const host = cellAt(first.r, first.i);
    const own = (host.content ?? []).filter((n) => !emptyBlock(n));
    const merged: PMJson = {
      ...host,
      attrs: { ...(host.attrs ?? {}), colspan: right - left + 1, rowspan: bottom - top + 1, colwidth: null },
      content: own.length || kept.length ? [...own, ...kept] : [{ type: 'paragraph' }],
    };
    out[first.r][out[first.r].indexOf(host)] = merged;
  } else if (op.op === 'table_split') {
    const at = pairOf(op.at);
    if (!at || at[0] >= rows.length || at[1] >= cols || !grid[at[0]][at[1]]) {
      throw bad('table_split takes "at": [row, col] of the merged cell (0-based)');
    }
    const target = grid[at[0]][at[1]]!;
    const cell = cellAt(target.r, target.i);
    if ((Number(cell.attrs?.colspan) || 1) === 1 && (Number(cell.attrs?.rowspan) || 1) === 1) throw bad('that cell is not merged');
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols; c++) {
        const g = grid[r][c];
        if (!g) continue;
        const [sr, sc] = start.get(`${g.r},${g.i}`)!;
        if (g.r === target.r && g.i === target.i) {
          out[r].push(
            sr === r && sc === c
              ? { ...cell, attrs: { ...(cell.attrs ?? {}), colspan: 1, rowspan: 1, colwidth: null } }
              : { type: cell.type, attrs: { align: cell.attrs?.align ?? null }, content: [{ type: 'paragraph' }] },
          );
        } else if (sr === r && sc === c) out[r].push(cellAt(g.r, g.i));
      }
    }
  } else {
    const isHeaderRow = (rows[0]?.content ?? []).every((c) => c.type === 'tableHeader');
    const isHeaderCol = rows.length > 0 && grid.every((g) => !g[0] || cellAt(g[0].r, g[0].i).type === 'tableHeader');
    if (op.row === undefined && op.col === undefined) throw bad('table_header takes "row" and/or "col": true or false');
    if ((op.row !== undefined && typeof op.row !== 'boolean') || (op.col !== undefined && typeof op.col !== 'boolean')) {
      throw bad('"row" and "col" are true or false');
    }
    const row = op.row === undefined ? isHeaderRow : op.row as boolean;
    const col = op.col === undefined ? isHeaderCol : op.col as boolean;
    rows.forEach((r, ri) => {
      (r.content ?? []).forEach((cell, i) => {
        const [sr, sc] = start.get(`${ri},${i}`)!;
        const type = (row && sr === 0) || (col && sc === 0) ? 'tableHeader' : 'tableCell';
        out[ri].push(type === cell.type ? cell : { ...cell, type });
      });
    });
  }
  updateNode(ctx.doc, table, { ...json, content: rows.map((r, k) => ({ ...r, content: out[k] })) });
  ctx.touched.add(table);
}

/**
 * style: colour or highlight words ("color": a TEXT_COLORS name, "highlight": a HIGHLIGHTS name, null clears), on a find target
 * (those words) or on blocks (all their text, every text block inside them). The words themselves do not change.
 */
function styleOp(ctx: Ctx, op: Op, index: number): void {
  const marks: Record<string, Attrs | null> = {};
  const pick = (key: 'color' | 'highlight', mark: string, names: string[]) => {
    const v = op[key];
    if (v === undefined) return;
    if (v !== null && !names.includes(v as string)) {
      throw new DocRefusal('bad_op', `op ${index}: "${key}" is one of ${names.join(', ')} (or null to clear)`, { op: index });
    }
    marks[mark] = v === null ? null : { color: v };
  };
  pick('color', 'textColor', TEXT_COLORS);
  pick('highlight', 'highlight', HIGHLIGHTS);
  if (!Object.keys(marks).length) {
    throw new DocRefusal('bad_op', `op ${index}: style needs "color" and/or "highlight"`, { op: index });
  }
  const styleable = (el: Y.XmlElement) => TEXTBLOCKS.has(el.nodeName) && schema.nodes[el.nodeName]?.spec.marks !== '';
  if (op.target.kind === 'find') {
    const { el, at, text } = locate(ctx, op.target, index);
    if (!styleable(el)) throw new DocRefusal('bad_op', `op ${index}: text in a code block takes no colour`, { op: index });
    formatText(el, at, at + text.length, marks);
    ctx.touched.add(el);
    return;
  }
  for (const id of idsOf(op.target, index)) {
    const el = need(ctx, id, index);
    const walk = (x: Y.XmlElement) => {
      if (styleable(x)) formatText(x, 0, textOf(x).length, marks);
      else if (CONTAINERS.has(x.nodeName)) for (const c of x.toArray()) if (c instanceof Y.XmlElement) walk(c);
    };
    walk(el);
    ctx.touched.add(el);
  }
}

/** A callout inside a callout (directly, or through a list or toggle in it)? */
function nestedCallout(el: Y.XmlElement): boolean {
  const inCallout = (x: Y.XmlElement) => {
    for (let p = x.parent as YType | null; p; p = p.parent as YType | null) {
      if (p instanceof Y.XmlElement && p.nodeName === 'callout') return true;
    }
    return false;
  };
  const walk = (x: Y.XmlElement): boolean =>
    (x.nodeName === 'callout' && inCallout(x)) || x.toArray().some((c) => c instanceof Y.XmlElement && walk(c));
  return walk(el);
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
    if (nestedCallout(el)) throw new DocRefusal('bad_op', 'a callout cannot hold another callout');
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

/** A chart without an id gets one (the file of its picture is named by it). */
function withChartIds(n: PMJson): PMJson {
  if (n.type === 'chart') {
    const id = String(n.attrs?.chart ?? '');
    return CHART_ID.test(id) ? n : { ...n, attrs: { ...(n.attrs ?? {}), chart: newChartId() } };
  }
  return n.content ? { ...n, content: n.content.map(withChartIds) } : n;
}

/** The charts of a page (element -> its content), to tell which ones a call made or changed. */
function chartsIn(frag: Y.XmlFragment): Map<Y.XmlElement, string> {
  const out = new Map<Y.XmlElement, string>();
  const walk = (p: Y.XmlFragment) => {
    for (const c of p.toArray()) {
      if (!(c instanceof Y.XmlElement)) continue;
      if (c.nodeName === 'chart') out.set(c, c.toString());
      else if (CONTAINERS.has(c.nodeName)) walk(c);
    }
  };
  walk(frag);
  return out;
}

/** After the dry run: every chart the ops made or changed is still a chart (numbers in its number cells, up to MAX_SERIES series). */
function checkCharts(frag: Y.XmlFragment, before: Map<Y.XmlElement, string>): void {
  for (const [el, now] of chartsIn(frag)) {
    if (before.get(el) === now) continue;
    const problem = chartProblem(jsonOf(el));
    if (problem) throw new DocRefusal('bad_chart', `Not changed: ${problem}.`);
  }
}

/**
 * chart_from_table: a new chart right after the table (after the callout it sits in: a callout holds no chart), with a copy of the
 * table's cells as they stand. A copy, once: the chart keeps its own numbers; later edits to the table leave it alone.
 */
function chartFromTableOp(ctx: Ctx, op: Op, index: number): void {
  const ids = idsOf(op.target, index);
  const table = need(ctx, ids[0], index);
  if (table.nodeName !== 'table') throw new DocRefusal('bad_op', `op ${index}: chart_from_table targets a table's id`, { op: index });
  if ((table.parent as Y.XmlElement | null)?.nodeName === 'chart') {
    throw new DocRefusal('bad_op', `op ${index}: that table is a chart's numbers already`, { op: index });
  }
  const a = (op.attrs ?? {}) as Attrs;
  for (const k of Object.keys(a)) {
    if (!['title', 'chartType', 'caption'].includes(k) || !SET_CHECKS[k](a[k])) {
      throw new DocRefusal('bad_op', `op ${index}: chart_from_table takes "attrs" title, chartType (bar|line), caption`, { op: index });
    }
  }
  let anchor: Y.XmlElement = table;
  for (let p = anchor.parent; p instanceof Y.XmlElement && p.nodeName === 'callout'; p = anchor.parent) anchor = p;
  const { parent, at } = parentOf(anchor);
  const chart = chartFromTable(jsonOf(table), a as { title?: string; chartType?: string; caption?: string });
  insertAt(ctx, parent, op.side === 'before' ? at : at + 1, [chart], true);
}
