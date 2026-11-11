/**
 * doc.aibdoc: the doc itself, in the project (docs/<doc-slug>/doc.aibdoc), meant to be committed. Readable, stable JSON (2-space
 * indent, keys in a fixed order, so a git diff shows just the edit):
 *
 *   { "format": "aibdoc", "version": 1, "title": "Plan",
 *     "pages":    [{ "id": "p1", "title": "Page 1", "content": [<ProseMirror JSON, each block with its "id" and "by">] }],
 *     "comments": [{ "id": "t1", "by": "user", ..., "anchor": { "block": "<block id>", "from": 0, "to": 5 }, "replies": [...] }],
 *     "drawings": [{ "id": "flow", "page": "p1", "elements": [{ "id": "b1", "type": "rectangle", ... }] }] }
 *
 * Agent attribution is in the content itself: the agentEdit mark on the words an agent wrote, and `by` on each block (who changed it
 * last). Block ids in the file are stable labels: Yjs gives every block a new id when a doc is rebuilt from this file, so the store
 * keeps a map from the live ids to the file's ids (IdMap) and writes the file's ids back, so they do not churn.
 *
 * AIB's state folder holds only a cache (the Y.Doc binary + the hash of the doc.aibdoc it was saved with) and the history.
 */
import * as Y from 'yjs';
import { CONTAINERS, DocRefusal, fieldOf, type LiveDoc, type Meta, newPageMap, PAGES } from './live_doc.ts';
import { idOf, insertNodes, jsonOf } from './blocks.ts';
import { normalize, type PMJson, schema } from './markdown.ts';
import { type Anchor, anchorOf, COMMENTS, rangeOf } from './comments.ts';
import { drawingsMap, newElementMap, readModels } from './drawing/model.ts';
import { drawingBlocks } from './drawing/assets.ts';

export const AIBDOC = 'doc.aibdoc';
export const FORMAT = 'aibdoc';
export const VERSION = 1;

type Json = Record<string, unknown>;
export type AibNode = PMJson & { id?: string; by?: string };

export interface AibPage {
  id: string;
  title: string;
  content: AibNode[];
}

export interface AibThread extends Json {
  id: string;
  anchor: { block: string; from: number; to: number } | null;
  /** An anchored thread whose words are gone. */
  lost?: true;
  replies: Json[];
}

export interface AibDrawing {
  id: string;
  page: string | null;
  elements: Json[];
}

export interface AibDoc {
  format: string;
  version: number;
  title: string;
  pages: AibPage[];
  comments: AibThread[];
  drawings: AibDrawing[];
}

/** An anchor that points at nothing: a thread on words that are gone (comments.ts reads it as detached). */
const LOST: Anchor = { start: { lost: true }, end: { lost: true } };

/** The live ids (Yjs) and the ids the file uses for the same blocks, where they differ. */
export class IdMap {
  #file = new Map<string, string>();
  #live = new Map<string, string>();

  constructor(saved: Record<string, string> | null | undefined = null) {
    for (const [live, file] of Object.entries(saved ?? {})) this.set(live, file);
  }

  set(live: string, file: string): void {
    if (live === file) return;
    this.#file.set(live, file);
    this.#live.set(file, live);
  }

  fileOf(live: string): string {
    return this.#file.get(live) ?? live;
  }

  liveOf(file: string): string {
    return this.#live.get(file) ?? file;
  }

  /** For the cache: only the blocks that still exist. */
  toJSON(has?: (live: string) => boolean): Record<string, string> {
    return Object.fromEntries([...this.#file].filter(([live]) => !has || has(live)));
  }
}

// ---------- writing ----------

const ORDER = [
  'format',
  'version',
  'title',
  'pages',
  'comments',
  'drawings',
  'id',
  'type',
  'page',
  'by',
  'at',
  'seq',
  'attrs',
  'text',
  'marks',
  'anchor',
  'block',
  'from',
  'to',
  'content',
  'elements',
  'replies',
];
const RANK = new Map(ORDER.map((k, i) => [k, i]));

/** Objects with their keys in the fixed order: the known ones first (ORDER), the rest alphabetical. */
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (!value || typeof value !== 'object') return value;
  const keys = Object.keys(value).sort((a, b) => (RANK.get(a) ?? 999) - (RANK.get(b) ?? 999) || (a < b ? -1 : a > b ? 1 : 0));
  const out: Json = {};
  for (const k of keys) {
    const v = (value as Json)[k];
    if (v !== undefined) out[k] = ordered(v);
  }
  return out;
}

export function stringifyAib(doc: AibDoc): string {
  return JSON.stringify(ordered(doc), null, 2) + '\n';
}

export async function hashText(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The doc as a doc.aibdoc. */
export function exportAib(live: LiveDoc, title: string, ids: IdMap): AibDoc {
  const used = new Set<string>();
  const fileId = (live: string): string => {
    let id = ids.fileOf(live);
    if (used.has(id)) {
      let n = 2;
      while (used.has(`${live}~${n}`)) n++;
      id = `${live}~${n}`;
      ids.set(live, id);
    }
    used.add(id);
    return id;
  };
  const annotate = (json: PMJson, el: Y.XmlElement): AibNode => {
    const id = idOf(el);
    const by = live.byOf(id);
    const out: AibNode = { ...json, id: fileId(id), ...(by ? { by } : {}) };
    if (CONTAINERS.has(el.nodeName) && json.content) {
      const kids = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
      out.content = json.content.map((c, k) => (kids[k] ? annotate(c, kids[k]) : c));
    }
    return out;
  };
  const pages: AibPage[] = live.pageList().map((p) => {
    const blocks = live.topBlocks(p.id);
    const els = live.fragOf(p.id).toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
    return { id: p.id, title: p.title, content: blocks.map((b, k) => annotate(b.node, els[k])) };
  });
  const comments: AibThread[] = [];
  const map = live.doc.getMap(COMMENTS) as Y.Map<Y.Map<unknown>>;
  for (const [id, t] of map) {
    if (!(t instanceof Y.Map)) continue;
    const fields = t.toJSON() as Json;
    const anchor = fields.anchor as Anchor | null;
    delete fields.anchor;
    const replies = Array.isArray(fields.replies) ? fields.replies as Json[] : [];
    delete fields.replies;
    const range = anchor ? rangeOf(live.doc, anchor) : null;
    const thread: AibThread = {
      id,
      ...fields,
      anchor: range ? { block: ids.fileOf(idOf(range.el)), from: range.from, to: range.to } : null,
      replies,
    };
    if (range && live.has(idOf(range.el))) thread.page = live.pageOf(idOf(range.el));
    if (anchor && !range) thread.lost = true;
    comments.push(thread);
  }
  comments.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0) || (a.id < b.id ? -1 : 1));
  const pageOfDrawing = new Map(drawingBlocks(live).map((d) => [d.drawing, d.page]));
  const drawings: AibDrawing[] = [...drawingsMap(live.doc).keys()].sort().map((id) => ({
    id,
    page: pageOfDrawing.get(id) ?? null,
    elements: readModels(live.doc, id).map((m) => ({ ...m })),
  }));
  return { format: FORMAT, version: VERSION, title, pages, comments, drawings };
}

// ---------- reading ----------

function bad(message: string): DocRefusal {
  return new DocRefusal('bad_aibdoc', `doc.aibdoc: ${message}`);
}

/** Read a doc.aibdoc; refused (bad_aibdoc) when it is not one. */
export function parseAib(text: string): AibDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw bad(`not JSON (${(error as Error).message})`);
  }
  const d = raw as Partial<AibDoc>;
  if (!d || typeof d !== 'object' || d.format !== FORMAT) throw bad('"format" must be "aibdoc"');
  if (typeof d.version !== 'number' || d.version > VERSION) throw bad(`version ${d.version} is newer than this AIB reads (${VERSION})`);
  if (!Array.isArray(d.pages) || !d.pages.length) throw bad('"pages" must list at least one page');
  const seen = new Set<string>();
  for (const p of d.pages) {
    if (!p || typeof p.id !== 'string' || !p.id || seen.has(p.id)) throw bad('every page needs its own "id"');
    seen.add(p.id);
    if (typeof p.title !== 'string') throw bad(`page ${p.id} needs a "title"`);
    if (!Array.isArray(p.content)) throw bad(`page ${p.id} needs "content", a list of blocks`);
  }
  return {
    format: FORMAT,
    version: d.version,
    title: typeof d.title === 'string' ? d.title : '',
    pages: d.pages as AibPage[],
    comments: Array.isArray(d.comments) ? d.comments as AibThread[] : [],
    drawings: Array.isArray(d.drawings) ? d.drawings as AibDrawing[] : [],
  };
}

/** A block without the file's bookkeeping (ids, by): plain ProseMirror JSON. */
export function stripIds(node: AibNode): PMJson {
  const { id: _id, by: _by, ...rest } = node;
  const out = rest as PMJson;
  if (Array.isArray(out.content)) out.content = out.content.map((c) => stripIds(c as AibNode));
  return out;
}

/** A page's blocks for the doc: each checked against the schema (bad_aibdoc names the first one that does not fit). */
export function pageNodes(page: AibPage): PMJson[] {
  return page.content.map((n, k) => {
    const node = stripIds(n);
    try {
      schema.nodeFromJSON(node).check();
    } catch (error) {
      throw bad(`page ${page.id}, block ${k} (${String(n?.type)}): ${(error as Error).message}`);
    }
    return node;
  });
}

/** The content key a block is compared by (agent marks do not count, as in sigOf). */
export function blockKey(node: PMJson): string {
  return JSON.stringify(normalize(node));
}

/**
 * A Y.Doc from a doc.aibdoc: pages with their blocks, comments (anchors rebuilt from block id + offsets), drawings. Returns the state,
 * the meta LiveDoc starts from (who changed each block) and the map from the new live ids to the file's ids.
 */
export function buildFromAib(aib: AibDoc, rev: number): { state: Uint8Array; meta: Partial<Meta>; ids: IdMap } {
  const ydoc = new Y.Doc();
  const ids = new IdMap();
  const byFile = new Map<string, Y.XmlElement>();
  const blocks: Meta['blocks'] = {};
  const bind = (n: AibNode, el: Y.XmlElement) => {
    const live = idOf(el);
    if (typeof n.id === 'string' && n.id && !byFile.has(n.id)) {
      ids.set(live, n.id);
      byFile.set(n.id, el);
    }
    blocks[live] = [rev, rev, rev, typeof n.by === 'string' && n.by ? n.by : null];
    if (CONTAINERS.has(el.nodeName) && Array.isArray(n.content)) {
      const kids = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
      n.content.forEach((c, k) => kids[k] && bind(c as AibNode, kids[k]));
    }
  };
  const pages = aib.pages.map((p) => ({ page: p, nodes: pageNodes(p) }));
  ydoc.transact(() => {
    const arr = ydoc.getArray(PAGES);
    for (const { page, nodes } of pages) {
      const frag = ydoc.getXmlFragment(fieldOf(page.id));
      const els = insertNodes(ydoc, frag, 0, nodes.length ? nodes : [{ type: 'paragraph' }]);
      els.forEach((el, k) => page.content[k] && bind(page.content[k], el));
      arr.push([newPageMap(page.id, page.title.trim() || page.id)]);
    }
    restoreThreads(ydoc, aib.comments, byFile);
    restoreDrawings(ydoc, aib.drawings);
  });
  const state = Y.encodeStateAsUpdate(ydoc);
  ydoc.destroy();
  return { state, meta: { rev, blocks }, ids };
}

/** Bind a page's elements to the file's block ids (the same walk as buildFromAib): `ids` learns them, `byFile` finds the elements. */
export function bindIds(content: AibNode[], frag: Y.XmlFragment, ids: IdMap, byFile: Map<string, Y.XmlElement>): void {
  const bind = (n: AibNode, el: Y.XmlElement) => {
    if (typeof n.id === 'string' && n.id && !byFile.has(n.id)) {
      ids.set(idOf(el), n.id);
      byFile.set(n.id, el);
    }
    if (CONTAINERS.has(el.nodeName) && Array.isArray(n.content)) {
      const kids = el.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
      n.content.forEach((c, k) => kids[k] && bind(c as AibNode, kids[k]));
    }
  };
  const els = frag.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  content.forEach((n, k) => els[k] && bind(n, els[k]));
}

/**
 * Comment threads of a doc.aibdoc into a Y.Doc (inside a transaction), anchored through `byFile`. A thread the doc has already keeps
 * everything it has now (its replies, resolved state); it only takes the file's anchor when its own words are gone or it was
 * detached (and is no longer detached when the file's thread was not).
 */
export function restoreThreads(ydoc: Y.Doc, threads: AibThread[], byFile: Map<string, Y.XmlElement>): void {
  const comments = ydoc.getMap(COMMENTS);
  for (const t of threads) {
    if (!t || typeof t.id !== 'string') continue;
    let anchor: Anchor | null = null;
    const a = t.anchor;
    if (a && typeof a === 'object') {
      const el = byFile.get(String(a.block));
      try {
        anchor = el ? anchorOf(el, Number(a.from), Number(a.to)) : LOST;
      } catch {
        anchor = LOST;
      }
    } else if (t.lost) anchor = LOST;
    const had = comments.get(t.id);
    if (had instanceof Y.Map) {
      // the version's words are back: a thread whose own words went (or that an edit detached) hangs on them again
      if (anchor && anchor !== LOST && (had.get('detached') || !rangeOf(ydoc, had.get('anchor') as Anchor | null))) {
        had.set('anchor', anchor);
        if (!t.detached) had.delete('detached');
      }
      continue;
    }
    const m = new Y.Map<unknown>();
    comments.set(t.id, m);
    for (const [k, v] of Object.entries(t)) {
      if (['id', 'anchor', 'lost', 'replies', 'page'].includes(k) || v === undefined) continue;
      m.set(k, v);
    }
    m.set('anchor', anchor);
    const replies = new Y.Array<unknown>();
    m.set('replies', replies);
    replies.push(Array.isArray(t.replies) ? t.replies : []);
  }
}

/** Drawings of a doc.aibdoc into a Y.Doc (inside a transaction): each one listed is set to exactly the file's elements. */
export function restoreDrawings(ydoc: Y.Doc, drawings: AibDrawing[]): void {
  const map = drawingsMap(ydoc);
  for (const d of drawings) {
    if (!d || typeof d.id !== 'string') continue;
    const dm = new Y.Map<unknown>();
    const els = new Y.Map<Y.Map<unknown>>();
    dm.set('elements', els);
    map.set(d.id, dm as Y.Map<unknown>);
    for (const e of Array.isArray(d.elements) ? d.elements : []) {
      if (e && typeof e.id === 'string') els.set(e.id, newElementMap(e));
    }
  }
}

/** A history version's text as a doc.aibdoc, or null when it is Markdown (versions from before history kept doc.aibdoc). */
export function versionAib(text: string): AibDoc | null {
  if (!text.trimStart().startsWith('{')) return null;
  try {
    return parseAib(text);
  } catch {
    return null;
  }
}

/** Rebuilt pages keep their content ids: a doc from a file, read back, gives the same file. For tests and the merge. */
export function contentOf(live: LiveDoc, page: string): PMJson[] {
  return live.fragOf(page).toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement).map((el) => jsonOf(el));
}
