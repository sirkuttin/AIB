/**
 * One live doc in AIB's server: a Y.Doc that every open editor syncs with (y-protocols sync + awareness over a WebSocket), and the
 * guarded agent operations (doc_read, doc_changes, doc_edit) that Claude Docs gives its agents.
 *
 * Revisions: `rev` goes up by one for every transaction that changed a block (a keystroke from the page, an agent's call, a file
 * edit). Each block remembers the rev it last changed at, so a guard is "this block's hash is still ifHash and it has not changed
 * after rev ifRev". Deleted blocks are remembered as gone (with the rev), so doc_changes can say so.
 *
 * Who wrote what: every transaction has an origin. The page's edits arrive with their socket as the origin (the user); an agent's
 * edits run with that agent's own origin object, and the text it writes carries the agentEdit mark with its name. Undo is per author:
 * a Y.UndoManager that tracks only one origin (undoFor), and the page's own undo (y-prosemirror) tracks only its own local edits, so
 * the user's Ctrl+Z never takes back an agent's words.
 */
import * as Y from './vendor/yjs.js';
import {
  AGENT_MARK,
  applyTextEdits,
  type Attrs,
  type BlockSpec,
  blockText,
  diffText,
  elementToSpec,
  hash8,
  idOf,
  parseMarkdown,
  specToElement,
  specToMarkdown,
  TEXTBLOCKS,
} from './blocks.ts';
import type { WsLink } from '../platform/websocket.ts';

export const FIELD = 'doc';
const MSG_SYNC = 0, MSG_AWARENESS = 1;

/** Who made a change. One object per author, so Y.UndoManager can track it. */
export interface Origin {
  kind: 'agent' | 'user' | 'file' | 'system';
  name: string;
}

export interface BlockView {
  id: string;
  type: string;
  h: string;
  md: string;
  /** Who changed it last: 'user', an agent's name, 'file' (a file tool edited the Markdown copy). */
  by?: string;
}

/** A refused call: nothing changed. `code` mirrors Claude Docs (missing_guard, guard_mismatch, find_none, block_gone, ...). */
export class DocRefusal extends Error {
  constructor(readonly code: string, message: string, readonly data: Record<string, unknown> = {}) {
    super(message);
  }
  toJSON(): Record<string, unknown> {
    return { ok: false, code: this.code, message: this.message, ...this.data };
  }
}

export interface Meta {
  rev: number;
  blockRev: Record<string, number>;
  born: Record<string, number>;
  gone: Record<string, number>;
  by: Record<string, string>;
}

type Target = { kind: 'blocks'; ids: string[] } | { kind: 'find'; text: string; nth?: number } | { kind: 'root' };
interface Source {
  from?: { kind?: string; content?: unknown };
  as?: string;
}
export interface Op {
  op: 'insert' | 'replace' | 'delete';
  target: Target;
  side?: 'before' | 'after' | 'start' | 'end';
  source?: Source;
  with?: Source;
  ifHash?: string;
  ifRev?: number;
  force?: boolean;
}

export class LiveDoc {
  readonly doc: Y.Doc;
  readonly frag: Y.XmlFragment;
  readonly awareness: Y.awareness.Awareness;
  rev: number;
  #blockRev: Map<string, number>;
  #born: Map<string, number>;
  #gone: Map<string, number>;
  #by: Map<string, string>;
  #hashes = new Map<string, string>();
  #origins = new Map<string, Origin>();
  #sockets = new Map<WsLink, { origin: Origin; clients: Set<number> }>();
  readonly user: Origin = { kind: 'user', name: 'user' };
  readonly system: Origin = { kind: 'system', name: 'system' };
  /** Called after every change (the store uses it to save and mirror on idle). */
  onChange: (() => void) | null = null;

  constructor(state: Uint8Array | null = null, meta: Meta | null = null) {
    this.doc = new Y.Doc();
    this.frag = this.doc.getXmlFragment(FIELD);
    if (state) Y.applyUpdate(this.doc, state, this.system);
    this.awareness = new Y.awareness.Awareness(this.doc);
    this.awareness.setLocalState(null); // the server has no cursor
    this.rev = meta?.rev ?? 0;
    this.#blockRev = new Map(Object.entries(meta?.blockRev ?? {}));
    this.#born = new Map(Object.entries(meta?.born ?? {}));
    this.#gone = new Map(Object.entries(meta?.gone ?? {}));
    this.#by = new Map(Object.entries(meta?.by ?? {}));
    for (const el of this.elements()) {
      const id = idOf(el);
      this.#hashes.set(id, this.#hash(el));
      if (!this.#blockRev.has(id)) this.#blockRev.set(id, this.rev);
      if (!this.#born.has(id)) this.#born.set(id, this.rev);
    }
    this.doc.on('afterTransaction', (tr) => this.#afterTransaction(tr));
    this.doc.on('update', (update, origin) => this.#broadcast(update, origin));
    this.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed);
      const socket = this.#sockets.get(origin as WsLink);
      if (socket) {
        for (const c of added.concat(updated)) socket.clients.add(c);
        for (const c of removed) socket.clients.delete(c);
      }
      const e = Y.encoding.createEncoder();
      Y.encoding.writeVarUint(e, MSG_AWARENESS);
      Y.encoding.writeVarUint8Array(e, Y.awareness.encodeAwarenessUpdate(this.awareness, changed));
      const message = Y.encoding.toUint8Array(e);
      for (const link of this.#sockets.keys()) link.send(message);
    });
  }

  meta(): Meta {
    return {
      rev: this.rev,
      blockRev: Object.fromEntries(this.#blockRev),
      born: Object.fromEntries(this.#born),
      gone: Object.fromEntries(this.#gone),
      by: Object.fromEntries(this.#by),
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
    if (!origin) this.#origins.set(key, origin = { kind, name });
    return origin;
  }

  /** An undo manager for one author's edits only. */
  undoFor(origin: Origin): Y.UndoManager {
    return new Y.UndoManager(this.frag, { trackedOrigins: new Set([origin]), captureTimeout: 0 });
  }

  elements(): Y.XmlElement[] {
    return this.frag.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
  }

  specs(): BlockSpec[] {
    return this.elements().map(elementToSpec);
  }

  #hash(el: Y.XmlElement): string {
    return hash8(specToMarkdown(elementToSpec(el)));
  }

  view(el: Y.XmlElement): BlockView {
    const id = idOf(el);
    const md = specToMarkdown(elementToSpec(el));
    const by = this.#by.get(id);
    return { id, type: el.nodeName, h: hash8(md), md, ...(by ? { by } : {}) };
  }

  blockRev(id: string): number | undefined {
    return this.#blockRev.get(id);
  }

  #afterTransaction(tr: Y.Transaction): void {
    if (tr.changed.size === 0 && tr.deleteSet.clients.size === 0) return;
    const origin = tr.origin as Origin | WsLink | null;
    const by = origin && this.#sockets.has(origin as WsLink) ? 'user' : origin && typeof origin === 'object' && 'kind' in origin &&
        (origin.kind === 'agent' || origin.kind === 'file' || origin.kind === 'user')
      ? (origin.kind === 'file' ? 'file' : origin.name)
      : origin === null || (origin as Origin)?.kind === 'system'
      ? null
      : 'user'; // an undo manager's origin, or a test's client
    const next = this.rev + 1;
    let changed = false;
    const seen = new Set<string>();
    for (const el of this.elements()) {
      const id = idOf(el);
      seen.add(id);
      const h = this.#hash(el);
      if (this.#hashes.get(id) === h) continue;
      if (!this.#hashes.has(id)) this.#born.set(id, next);
      this.#hashes.set(id, h);
      this.#blockRev.set(id, next);
      if (by) this.#by.set(id, by);
      changed = true;
    }
    for (const id of [...this.#hashes.keys()]) {
      if (seen.has(id)) continue;
      this.#hashes.delete(id);
      this.#blockRev.delete(id);
      this.#by.delete(id);
      this.#gone.set(id, next);
      changed = true;
    }
    if (!changed) return;
    this.rev = next;
    this.onChange?.();
  }

  // ---------- agent reads ----------

  /** doc_read: the outline (headings), every block (or just `ids`) with id, hash and Markdown, and the rev of this read. */
  read(ids: string[] | null = null): Record<string, unknown> {
    const els = this.elements();
    const blocks = els.filter((el) => !ids || ids.includes(idOf(el))).map((el) => this.view(el));
    const outline = els.filter((el) => el.nodeName === 'heading').map((el) => ({
      id: idOf(el),
      level: Number(el.getAttribute('level')) || 1,
      text: blockText(elementToSpec(el)),
    }));
    return { rev: this.rev, outline, blocks };
  }

  /** doc_changes: the blocks changed after `sinceRev` (with `after` = the block before each, for placing it) and the ones gone. */
  changes(sinceRev: number): Record<string, unknown> {
    const els = this.elements();
    const changed: (BlockView & { after: string | null })[] = [];
    els.forEach((el, i) => {
      if ((this.#blockRev.get(idOf(el)) ?? 0) > sinceRev) changed.push({ ...this.view(el), after: i ? idOf(els[i - 1]) : null });
    });
    const gone = [...this.#gone].filter(([id, rev]) => rev > sinceRev && (this.#born.get(id) ?? 0) <= sinceRev).map(([id]) => id);
    return { rev: this.rev, sinceRev, changed, gone };
  }

  // ---------- agent edits ----------

  /**
   * doc_edit: run the ops in order, all or nothing. Guards are judged on the doc as it stood before the first op; the ops are then
   * tried on a copy of the doc, and only when every op succeeds there are they applied to the live doc (in the same synchronous turn,
   * so nothing can come in between). Returns the ack: the new rev and the blocks this call changed.
   */
  edit(ops: unknown, origin: Origin): Record<string, unknown> {
    if (!Array.isArray(ops) || !ops.length) throw new DocRefusal('bad_op', '`ops` must be a non-empty list');
    ops.forEach((op, i) => this.#checkGuard(op as Op, i));
    const copy = new Y.Doc();
    Y.applyUpdate(copy, this.encode());
    applyOps(copy.getXmlFragment(FIELD), ops as Op[], null);
    copy.destroy();
    const before = this.rev;
    const mark = { [AGENT_MARK]: { by: origin.name } };
    this.doc.transact(() => applyOps(this.frag, ops as Op[], mark), origin);
    const ack = this.changes(before);
    return { ok: true, rev: this.rev, changed: ack.changed, gone: ack.gone };
  }

  #checkGuard(op: Op, index: number): void {
    if (!op || typeof op !== 'object' || !['insert', 'replace', 'delete'].includes(op.op)) {
      throw new DocRefusal('bad_op', `op ${index}: "op" must be insert, replace or delete`, { op: index });
    }
    const target = op.target;
    if (!target || typeof target !== 'object') throw new DocRefusal('bad_op', `op ${index}: missing target`, { op: index });
    if (op.op === 'insert' || target.kind !== 'blocks' || op.force === true) return;
    const ids = Array.isArray(target.ids) ? target.ids : [];
    if (!ids.length) throw new DocRefusal('bad_op', `op ${index}: target.ids is empty`, { op: index });
    const needsHash = ids.length === 1;
    if (typeof op.ifRev !== 'number' || (needsHash && typeof op.ifHash !== 'string')) {
      throw new DocRefusal(
        'missing_guard',
        `op ${index}: a whole-block ${op.op} needs ${
          needsHash ? '"ifHash" (the block\'s h) and ' : ''
        }"ifRev" (the rev of the read that showed it)`,
        { op: index },
      );
    }
    for (const id of ids) {
      const el = this.elements().find((e) => idOf(e) === id);
      if (!el) throw new DocRefusal('block_gone', `op ${index}: block ${id} is gone`, { op: index, id });
      const view = this.view(el);
      const changedAfter = (this.#blockRev.get(id) ?? 0) > op.ifRev || op.ifRev > this.rev;
      if (changedAfter || (needsHash && view.h !== op.ifHash)) {
        throw new DocRefusal(
          'guard_mismatch',
          `op ${index}: block ${id} changed after your read; it is shown as it stands now. Their edit wins.`,
          {
            op: index,
            block: view,
            rev: this.rev,
          },
        );
      }
    }
  }

  // ---------- page sockets ----------

  /** Connect one page socket: sync both ways, awareness both ways. */
  attach(link: WsLink): void {
    this.#sockets.set(link, { origin: this.user, clients: new Set() });
    link.onmessage = (data) => {
      if (typeof data === 'string') return;
      try {
        this.#receive(link, data);
      } catch {
        link.close(1003, 'bad message');
      }
    };
    link.onclose = () => this.detach(link);
    const e = Y.encoding.createEncoder();
    Y.encoding.writeVarUint(e, MSG_SYNC);
    Y.sync.writeSyncStep1(e, this.doc);
    link.send(Y.encoding.toUint8Array(e));
    const states = [...this.awareness.getStates().keys()];
    if (states.length) {
      const a = Y.encoding.createEncoder();
      Y.encoding.writeVarUint(a, MSG_AWARENESS);
      Y.encoding.writeVarUint8Array(a, Y.awareness.encodeAwarenessUpdate(this.awareness, states));
      link.send(Y.encoding.toUint8Array(a));
    }
  }

  detach(link: WsLink): void {
    const socket = this.#sockets.get(link);
    if (!socket) return;
    this.#sockets.delete(link);
    Y.awareness.removeAwarenessStates(this.awareness, [...socket.clients], null);
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  #receive(link: WsLink, data: Uint8Array): void {
    const d = Y.decoding.createDecoder(data);
    const type = Y.decoding.readVarUint(d);
    if (type === MSG_SYNC) {
      const e = Y.encoding.createEncoder();
      Y.encoding.writeVarUint(e, MSG_SYNC);
      Y.sync.readSyncMessage(d, e, this.doc, link);
      if (Y.encoding.length(e) > 1) link.send(Y.encoding.toUint8Array(e));
    } else if (type === MSG_AWARENESS) {
      Y.awareness.applyAwarenessUpdate(this.awareness, Y.decoding.readVarUint8Array(d), link);
    }
  }

  #broadcast(update: Uint8Array, origin: unknown): void {
    if (!this.#sockets.size) return;
    const e = Y.encoding.createEncoder();
    Y.encoding.writeVarUint(e, MSG_SYNC);
    Y.sync.writeUpdate(e, update);
    const message = Y.encoding.toUint8Array(e);
    for (const link of this.#sockets.keys()) if (link !== origin) link.send(message);
  }

  destroy(): void {
    for (const link of [...this.#sockets.keys()]) link.close(1001, 'doc closed');
    this.awareness.destroy();
    this.doc.destroy();
  }
}

// ---------- the ops ----------

function textOfSource(source: Source | undefined, index: number): { text: string; as: string } {
  const from = source?.from;
  if (!from || typeof from !== 'object' || from.kind !== 'inline' || typeof from.content !== 'string') {
    throw new DocRefusal('bad_op', `op ${index}: give the text as {"from":{"kind":"inline","content":"…"},"as":"text"|"markdown"}`, {
      op: index,
    });
  }
  const as = source!.as ?? 'markdown';
  if (as !== 'text' && as !== 'markdown') throw new DocRefusal('bad_op', `op ${index}: "as" must be "text" or "markdown"`, { op: index });
  return { text: from.content, as };
}

function topLevel(frag: Y.XmlFragment): Y.XmlElement[] {
  return frag.toArray().filter((c): c is Y.XmlElement => c instanceof Y.XmlElement);
}

function findBlock(frag: Y.XmlFragment, id: string, index: number): { el: Y.XmlElement; at: number } {
  const els = frag.toArray();
  const at = els.findIndex((e) => e instanceof Y.XmlElement && idOf(e) === id);
  if (at < 0) throw new DocRefusal('block_gone', `op ${index}: block ${id} is gone`, { op: index, id });
  return { el: els[at] as Y.XmlElement, at };
}

/** Every textblock in doc order (inside lists and quotes too), for find targets. */
function textblocks(parent: Y.XmlFragment, out: Y.XmlElement[] = []): Y.XmlElement[] {
  for (const c of parent.toArray()) {
    if (!(c instanceof Y.XmlElement)) continue;
    if (TEXTBLOCKS.has(c.nodeName)) out.push(c);
    else textblocks(c, out);
  }
  return out;
}

function locate(frag: Y.XmlFragment, target: { text: string; nth?: number }, index: number): { el: Y.XmlElement; at: number } {
  if (typeof target.text !== 'string' || !target.text) throw new DocRefusal('bad_op', `op ${index}: find needs "text"`, { op: index });
  let left = typeof target.nth === 'number' && target.nth > 0 ? target.nth : 1;
  for (const el of textblocks(frag)) {
    const text = blockText(elementToSpec(el));
    for (let at = text.indexOf(target.text); at >= 0; at = text.indexOf(target.text, at + 1)) {
      if (--left === 0) return { el, at };
    }
  }
  throw new DocRefusal(
    'find_none',
    `op ${index}: the words "${target.text}" are not in the doc as it stands; read that block again and quote what it says now`,
    {
      op: index,
      text: target.text,
    },
  );
}

function sourceSpecs(source: Source | undefined, index: number): BlockSpec[] {
  const { text, as } = textOfSource(source, index);
  if (as === 'text') return [{ type: 'paragraph', inline: text ? [{ insert: text }] : [] }];
  const specs = parseMarkdown(text);
  if (!specs.length) throw new DocRefusal('bad_op', `op ${index}: the Markdown has no blocks`, { op: index });
  return specs;
}

function applyOps(frag: Y.XmlFragment, ops: Op[], mark: Attrs | null): void {
  ops.forEach((op, index) => {
    const t = op.target;
    if (op.op === 'insert') {
      const specs = sourceSpecs(op.source, index);
      let at: number;
      if (t.kind === 'root') at = op.side === 'start' ? 0 : frag.length;
      else if (t.kind === 'blocks' && Array.isArray(t.ids) && t.ids.length === 1) {
        const found = findBlock(frag, t.ids[0], index);
        at = op.side === 'before' ? found.at : found.at + 1;
      } else throw new DocRefusal('bad_op', `op ${index}: insert targets one block id (with "side") or {"kind":"root"}`, { op: index });
      frag.insert(at, specs.map((s) => specToElement(s, mark)));
      return;
    }
    if (t.kind === 'find') {
      const { el, at } = locate(frag, t, index);
      if (op.op === 'delete') applyTextEdits(el, [{ at, del: t.text.length, ins: '' }], mark);
      else {
        const { text, as } = textOfSource(op.with, index);
        if (as !== 'text') throw new DocRefusal('bad_op', `op ${index}: a find target is re-worded with "as":"text"`, { op: index });
        applyTextEdits(el, diffText(t.text, text).map((e) => ({ ...e, at: e.at + at })), mark);
      }
      return;
    }
    if (t.kind !== 'blocks' || !Array.isArray(t.ids) || !t.ids.length) {
      throw new DocRefusal('bad_op', `op ${index}: unknown target`, { op: index });
    }
    if (op.op === 'delete') {
      const found = t.ids.map((id) => findBlock(frag, id, index)).sort((a, b) => b.at - a.at);
      if (topLevel(frag).length - found.length < 1) {
        throw new DocRefusal('last_block', `op ${index}: a doc keeps at least one block`, { op: index });
      }
      for (const f of found) frag.delete(f.at, 1);
      return;
    }
    if (t.ids.length !== 1) throw new DocRefusal('bad_op', `op ${index}: replace one block at a time`, { op: index });
    const { el, at } = findBlock(frag, t.ids[0], index);
    const { text, as } = textOfSource(op.with, index);
    if (as === 'text') {
      if (!TEXTBLOCKS.has(el.nodeName)) {
        throw new DocRefusal(
          'bad_op',
          `op ${index}: "as":"text" re-words a paragraph, heading or code block; use "as":"markdown" for a ${el.nodeName}`,
          { op: index },
        );
      }
      if (!text) throw new DocRefusal('bad_op', `op ${index}: never replace with empty content; delete the block instead`, { op: index });
      applyTextEdits(el, diffText(blockText(elementToSpec(el)), text), mark);
    } else {
      const specs = parseMarkdown(text);
      if (!specs.length) {
        throw new DocRefusal('bad_op', `op ${index}: never replace with empty content; delete the block instead`, { op: index });
      }
      frag.delete(at, 1);
      frag.insert(at, specs.map((s) => specToElement(s, mark)));
    }
  });
}
