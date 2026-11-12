// The doc editor for AIB's doc page (outputs/agent-studio/doc.html): TipTap bound to a Y.Doc with @tiptap/y-tiptap, with the schema
// of server/docs/schema.ts, synced to AIB's server over a WebSocket (y-protocols sync + awareness as binary frames, AIB's control
// messages as JSON text frames).
//
// Exposes window.AIBDocEditor:
//   createSession({url, protocols, user, onStatus, onControl, onReopen, onAwareness, ...}) -> DocSession: one Y.Doc for the whole
//     doc (every page), its socket, and ONE Yjs undo manager over every page's fragment: Ctrl+Z undoes only this page's own
//     keystrokes (y-tiptap's sync origin), on whichever page they were, never an agent's or a server-side change.
//   session.mountPage(element, page, options) -> PageEditor: a TipTap editor bound to one page's fragment (a page switch re-mounts).
//   schemaVersion, schemaSummary(), docJSON(update), encode(json): the server tests' schema checks (work/deno/docs_schema_test.ts).
//   renderNodes(nodes, container): ProseMirror JSON rendered with the doc schema (History's read-only view and Compare).
//
// The page renders a few things differently from schema.ts's toDOM, through node and mark views (the schema's data is unchanged,
// so the server-vs-page check holds):
//   - agentEdit: a bare <span>: no class, no title, no tint. Who wrote what shows only in History.
//   - tables and cells: no inline style and no <colgroup> widths (the page's CSP has no 'unsafe-inline' for styles); a cell's
//     alignment is data-align, styled in docs.css.
// The socket: first message {type:'hello', epoch, rev, doc}; {type:'reopen'} then close 4404/4409 means AIB reloaded the doc (a
// restart, a rebuild): the session stops for good (reconnecting with this copy would merge it in as duplicate blocks) and calls
// onReopen({reason, texts}) so the page re-opens the doc and can name keystrokes that may never have reached AIB.
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Editor, Extension, getSchema } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import {
  absolutePositionToRelativePosition,
  defaultDeleteFilter,
  defaultProtectedNodes,
  prosemirrorJSONToYDoc,
  relativePositionToAbsolutePosition,
  yCursorPlugin,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
} from '@tiptap/y-tiptap';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { DOMSerializer, Node as PMNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';
import { docExtensions, SCHEMA_VERSION, schemaSummary } from '../../outputs/agent-studio/server/docs/schema.ts';

const MSG_SYNC = 0, MSG_AWARENESS = 1;
const FIELD = 'doc';
const FIRST_PAGE = 'p1';
const PAGE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_FIELD = /^(?:doc|page:[A-Za-z0-9_-]{1,40})$/;
const SVGNS = 'http://www.w3.org/2000/svg';

let schema = null;
const theSchema = () => (schema ??= getSchema(docExtensions()));
const idOf = (type) => `${type._item.id.client}.${type._item.id.clock}`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Rendering without inline style: tables, cells, the agent mark.

function cellAttrs(dom, node) {
  const a = node.attrs;
  if (a.colspan > 1) dom.setAttribute('colspan', String(a.colspan));
  else dom.removeAttribute('colspan');
  if (a.rowspan > 1) dom.setAttribute('rowspan', String(a.rowspan));
  else dom.removeAttribute('rowspan');
  if (a.align) dom.setAttribute('data-align', a.align);
  else dom.removeAttribute('data-align');
}

const plainViews = {
  table: (node) => {
    const dom = el('table', 'doc-table');
    const body = document.createElement('tbody');
    dom.append(body);
    return { dom, contentDOM: body, update: (next) => next.type === node.type };
  },
  tableCell: (node) => cellView('td', node),
  tableHeader: (node) => cellView('th', node),
};

function cellView(tag, node) {
  const dom = document.createElement(tag);
  cellAttrs(dom, node);
  return {
    dom,
    contentDOM: dom,
    update(next) {
      if (next.type !== node.type) return false;
      cellAttrs(dom, next);
      return true;
    },
  };
}

const plainMarkViews = { agentEdit: () => ({ dom: document.createElement('span') }) };

/** A serializer for read-only views with the same rules. */
function serializerFor(s) {
  const nodes = { ...DOMSerializer.nodesFromSchema(s) };
  const cell = (tag) => (node) => {
    const attrs = {};
    if (node.attrs.colspan > 1) attrs.colspan = String(node.attrs.colspan);
    if (node.attrs.rowspan > 1) attrs.rowspan = String(node.attrs.rowspan);
    if (node.attrs.align) attrs['data-align'] = node.attrs.align;
    return [tag, attrs, 0];
  };
  nodes.table = () => ['table', { class: 'doc-table' }, ['tbody', 0]];
  nodes.tableCell = cell('td');
  nodes.tableHeader = cell('th');
  const marks = { ...DOMSerializer.marksFromSchema(s), agentEdit: () => ['span', 0] };
  return new DOMSerializer(nodes, marks);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The socket: y-protocols sync and awareness (binary), AIB's control messages (JSON text), the reopen rule.

class DocSocket {
  constructor(session, url, protocols) {
    Object.assign(this, { session, url, protocols, ws: null, closed: false, wait: 500, synced: false, offline: true, reopen: null });
    this.connect();
  }
  send(data) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
  }
  connect() {
    if (this.closed) return;
    const s = this.session;
    let ws;
    try {
      ws = new WebSocket(this.url, this.protocols);
    } catch {
      return this.retry();
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    s.status('connecting');
    ws.onopen = () => {
      this.wait = 500;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, s.doc);
      ws.send(encoding.toUint8Array(e));
      if (s.awareness.getLocalState() !== null) s.sendAwareness([s.doc.clientID]);
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'reopen') {
          this.reopen = msg;
          return;
        }
        if (msg.type === 'hello') {
          this.offline = false;
          s.hello = msg;
          s.status('connected');
        }
        s.control(msg);
        return;
      }
      const d = decoding.createDecoder(new Uint8Array(event.data));
      const type = decoding.readVarUint(d);
      if (type === MSG_SYNC) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        const kind = syncProtocol.readSyncMessage(d, e, s.doc, this);
        if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
        if (kind === syncProtocol.messageYjsSyncStep2) {
          s.unsent = false;
          if (!this.synced) {
            this.synced = true;
            s.syncedNow();
          }
        }
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(s.awareness, decoding.readVarUint8Array(d), this);
      }
    };
    ws.onclose = (event) => {
      this.offline = true;
      if (this.closed) return;
      // the doc was reloaded (restart, rebuild) or is not open: never reconnect with this copy, never loop
      if (this.reopen || event.code === 4404 || event.code === 4409) {
        const reason = this.reopen?.reason ?? (event.code === 4409 ? 'epoch' : 'doc_not_open');
        this.closed = true;
        s.status('reopening');
        s.reopened(reason);
        return;
      }
      s.status('offline');
      this.retry();
    };
  }
  retry() {
    if (this.closed) return;
    setTimeout(() => this.connect(), this.wait);
    this.wait = Math.min(this.wait * 2, 10000);
  }
  destroy() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch { /* already closed */ }
  }
}

/** The plain text of a Y type (no marks). */
function plainText(type) {
  if (type instanceof Y.XmlText) {
    return type.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('');
  }
  if (type instanceof Y.XmlElement || type instanceof Y.XmlFragment) {
    const inline = type instanceof Y.XmlElement && /^(paragraph|heading|codeBlock|pending)$/.test(type.nodeName);
    return type.toArray().map((c) => plainText(c)).join(inline ? '' : '\n');
  }
  return '';
}

/** The plain text of every top-level block of every page (what the page shows if the doc is reloaded under it). */
function textsOf(doc) {
  const out = [];
  for (const p of pageList(doc)) {
    for (const t of doc.getXmlFragment(p.field).toArray()) {
      const text = plainText(t).trim();
      if (text) out.push(text);
    }
  }
  return out;
}

/** The doc's pages in order, as the server sorts them (live_doc.ts #pageEntries). */
function pageList(doc) {
  const out = [];
  const seen = new Set(), fields = new Set();
  const arr = doc.getArray('pages').toArray();
  for (let index = 0; index < arr.length; index++) {
    const m = arr[index];
    if (!(m instanceof Y.Map)) continue;
    const id = m.get('id'), title = m.get('title'), f = m.get('field');
    if (typeof id !== 'string' || !PAGE_ID.test(id) || seen.has(id)) continue;
    const field = typeof f === 'string' && PAGE_FIELD.test(f) ? f : id === FIRST_PAGE ? FIELD : `page:${id}`;
    if (fields.has(field)) continue;
    seen.add(id);
    fields.add(field);
    const pos = m.get('pos');
    out.push({
      id,
      title: typeof title === 'string' && title.trim() ? title : id,
      field,
      pos: typeof pos === 'number' && Number.isFinite(pos) ? pos : index,
      index,
    });
  }
  out.sort((a, b) => a.pos - b.pos || a.index - b.index);
  return out.map(({ id, title, field }) => ({ id, title, field }));
}

/** One open doc: its Y.Doc (every page), awareness, socket and the one undo manager. */
class DocSession {
  constructor(options) {
    this.options = options;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.awareness.setLocalStateField('user', { name: options.user?.name ?? 'You', color: '#0f766e' });
    this.hello = null;
    this.unsent = false;
    this.lastLocal = 0;
    this.editor = null;
    this.socket = null;
    this.synced = new Promise((resolve) => (this._synced = resolve));
    // ONE undo manager over every page's fragment; it tracks only this page's own keystrokes (y-tiptap's sync origin)
    this.undo = new Y.UndoManager([], {
      doc: this.doc,
      trackedOrigins: new Set([ySyncPluginKey]),
      deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
      captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
    });
    this.undo.on('stack-item-popped', ({ changedParentTypes }) => this.#undidElsewhere(changedParentTypes));
    this.onUpdate = (update, origin) => {
      if (origin === this.socket) return;
      if (origin === ySyncPluginKey) {
        this.lastLocal = Date.now();
        if (!this.socket || this.socket.offline) this.unsent = true;
      }
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.socket?.send(encoding.toUint8Array(e));
      this.options.onLocalUpdate?.(origin === ySyncPluginKey);
    };
    this.onAwareness = ({ added, updated, removed }, origin) => {
      if (origin === this.socket) return;
      this.sendAwareness(added.concat(updated, removed));
    };
    this.onAwarenessChange = () => this.options.onAwareness?.();
    this.doc.on('update', this.onUpdate);
    this.awareness.on('update', this.onAwareness);
    this.awareness.on('change', this.onAwarenessChange);
    this.doc.getArray('pages').observeDeep(() => this.#scopePages());
    this.socket = new DocSocket(this, options.url, options.protocols);
  }
  sendAwareness(clients) {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients));
    this.socket?.send(encoding.toUint8Array(e));
  }
  get connected() {
    return !!this.socket && !this.socket.offline;
  }
  status(s) {
    this.options.onStatus?.(s);
  }
  control(msg) {
    this.options.onControl?.(msg);
  }
  syncedNow() {
    this.#scopePages();
    this._synced();
  }
  reopened(reason) {
    // keystrokes that may not have reached AIB: typed while offline, or in the moment before the socket went
    const recent = this.unsent || Date.now() - this.lastLocal < 2000;
    this.options.onReopen?.({ reason, texts: recent ? textsOf(this.doc) : [] });
  }
  /** Give up this copy (AIB restarted with a new page token): stop the socket for good and re-open, as on a reopen frame. */
  abandon(reason = 'doc_not_open') {
    if (!this.socket || this.socket.closed) return;
    this.socket.destroy();
    this.status('reopening');
    this.reopened(reason);
  }
  #scopePages() {
    for (const p of pageList(this.doc)) {
      const frag = this.doc.getXmlFragment(p.field);
      if (!this.undo.scope.includes(frag)) this.undo.addToScope(frag);
    }
  }
  /** An undo changed another page than the one shown: the page follows it there. */
  #undidElsewhere(changed) {
    const shown = this.editor?.page;
    if (!shown || !changed) return;
    const roots = new Set();
    for (const type of changed.keys()) {
      let t = type;
      while (t._item) t = t._item.parent;
      roots.add(t);
    }
    for (const p of pageList(this.doc)) {
      if (p.id !== shown && roots.has(this.doc.getXmlFragment(p.field))) {
        this.options.onUndoElsewhere?.(p.id);
        return;
      }
    }
  }
  pages() {
    return pageList(this.doc);
  }
  fragmentOf(page) {
    const p = pageList(this.doc).find((x) => x.id === page);
    return p ? this.doc.getXmlFragment(p.field) : null;
  }
  /** The Y element with this server id ("client.clock"), or null. */
  typeOf(id) {
    const m = /^(\d+)\.(\d+)$/.exec(String(id || ''));
    if (!m) return null;
    try {
      const item = Y.getItem(this.doc.store, Y.createID(Number(m[1]), Number(m[2])));
      if (!item || item.deleted || !(item.content instanceof Y.ContentType)) return null;
      let t = item.content.type;
      for (let x = t; x._item; x = x._item.parent) if (x._item.deleted) return null;
      return t;
    } catch {
      return null;
    }
  }
  /** The page a block (server id) is on, or null. */
  pageOfBlock(id) {
    let t = this.typeOf(id);
    if (!t) return null;
    while (t._item) t = t._item.parent;
    const p = pageList(this.doc).find((x) => this.doc.getXmlFragment(x.field) === t);
    return p ? p.id : null;
  }
  /** The plain text of a block (server id), or ''. */
  blockText(id) {
    const t = this.typeOf(id);
    return t ? plainText(t) : '';
  }
  /** The page a comment anchor is on, or null. */
  pageOfAnchor(anchor) {
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start), this.doc);
      if (!abs) return null;
      let t = abs.type;
      for (let x = t; x._item; x = x._item.parent) if (x._item.deleted) return null;
      while (t._item) t = t._item.parent;
      const p = pageList(this.doc).find((x) => this.doc.getXmlFragment(x.field) === t);
      return p ? p.id : null;
    } catch {
      return null;
    }
  }
  /** The plain text of every top-level block of every page. */
  texts() {
    return textsOf(this.doc);
  }
  /**
   * Where a comment anchor's words are now (as the server's comments.ts rangeOf reads it): {page, block, from, to, quote}, or null
   * when the words are gone (the thread reads "Text removed").
   */
  anchorInfo(anchor) {
    if (!anchor) return null;
    try {
      const s = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.start), this.doc);
      const e = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.end), this.doc);
      if (!s || !e || !(s.type instanceof Y.XmlText) || !(e.type instanceof Y.XmlText)) return null;
      const block = s.type.parent;
      if (!(block instanceof Y.XmlElement) || e.type.parent !== block) return null;
      for (let x = block; x._item; x = x._item.parent) if (x._item.deleted) return null;
      if (s.type._item?.deleted || e.type._item?.deleted) return null;
      const offset = (text, index) => {
        let at = 0;
        for (const c of block.toArray()) {
          if (c === text) return at + index;
          at += c instanceof Y.XmlText ? c.length : 1;
        }
        return null;
      };
      const from = offset(s.type, s.index), to = offset(e.type, e.index);
      if (from === null || to === null || to <= from) return null;
      let root = block;
      while (root._item) root = root._item.parent;
      const page = pageList(this.doc).find((x) => this.doc.getXmlFragment(x.field) === root);
      const text = block.toArray().map((c) => (c instanceof Y.XmlText ? plainText(c) : '￼')).join('');
      return { page: page ? page.id : null, block: idOf(block), from, to, quote: text.slice(from, to) };
    } catch {
      return null;
    }
  }
  /** Every page as ProseMirror JSON (Compare against now). */
  pagesJSON() {
    return pageList(this.doc).map((p) => ({
      id: p.id,
      title: p.title,
      nodes: yXmlFragmentToProseMirrorRootNode(this.doc.getXmlFragment(p.field), theSchema()).toJSON().content ?? [],
    }));
  }
  /** This page's Yjs client and clock (History's restore sends them: refused while keystrokes are in flight). */
  clock() {
    return { client: this.doc.clientID, clock: Y.decodeStateVector(Y.encodeStateVector(this.doc)).get(this.doc.clientID) ?? 0 };
  }
  mountPage(element, page, options = {}) {
    this.editor?.destroy();
    this.editor = null;
    const frag = this.fragmentOf(page);
    if (!frag) return null;
    this.editor = new PageEditor(this, element, page, frag, options);
    return this.editor;
  }
  destroy() {
    this.editor?.destroy();
    this.editor = null;
    this.socket?.destroy();
    this.doc.off('update', this.onUpdate);
    this.awareness.off('update', this.onAwareness);
    this.awareness.off('change', this.onAwarenessChange);
    this.awareness.destroy();
    this.undo.destroy();
    this.doc.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The page's decorations: agent presence (outline on the block it edits), claimed blocks (dimmed, with the label and "Stop and
// keep the text"), comment anchors, refused-edit notes under their block. Classes only.

const marksKey = new PluginKey('aib-marks');

/** The ProseMirror position of the node for a Y element on this page, or null. */
function posOfType(state, frag, type) {
  const sync = ySyncPluginKey.getState(state);
  if (!sync?.binding || !type) return null;
  const want = sync.binding.mapping.get(type);
  if (!want || Array.isArray(want)) return null;
  try {
    const rel = Y.createRelativePositionFromTypeIndex(type, 0);
    const inside = relativePositionToAbsolutePosition(sync.doc, frag, rel, sync.binding.mapping);
    if (inside !== null && inside > 0 && inside <= state.doc.content.size) {
      const $pos = state.doc.resolve(inside);
      for (let d = $pos.depth; d > 0; d--) if ($pos.node(d) === want) return $pos.before(d);
    }
  } catch { /* fall through */ }
  let found = null;
  state.doc.descendants((node, pos) => {
    if (found !== null) return false;
    if (node === want) found = pos;
    return found === null;
  });
  return found;
}

/** The Y element of the node starting at `pos`, or null. */
function typeAtPos(state, pos) {
  const sync = ySyncPluginKey.getState(state);
  const node = state.doc.nodeAt(pos);
  if (!sync?.binding || !node) return null;
  let found = null;
  sync.binding.mapping.forEach((v, k) => {
    if (found === null && v === node && k instanceof Y.XmlElement) found = k;
  });
  return found;
}

function marksPlugin(page) {
  return new Plugin({
    key: marksKey,
    state: {
      init: () => ({ data: null, set: DecorationSet.empty }),
      apply(tr, value, _old, state) {
        const data = tr.getMeta(marksKey) ?? value.data;
        if (!data) return { data, set: DecorationSet.empty };
        try {
          return { data, set: buildMarks(state, page, data) };
        } catch {
          return { data, set: DecorationSet.empty };
        }
      },
    },
    props: { decorations: (state) => marksKey.getState(state)?.set ?? DecorationSet.empty },
  });
}

function buildMarks(state, page, data) {
  const decos = [];
  const sync = ySyncPluginKey.getState(state);
  if (!sync?.binding || sync.binding.mapping.size === 0) return DecorationSet.empty;
  const nodeAt = (id) => {
    const type = page.session.typeOf(id);
    const pos = type ? posOfType(state, page.frag, type) : null;
    const node = pos !== null ? state.doc.nodeAt(pos) : null;
    return node ? { pos, node } : null;
  };
  for (const p of data.presence ?? []) {
    if (!p.block || p.page !== page.page) continue;
    const at = nodeAt(p.block);
    if (at) decos.push(Decoration.node(at.pos, at.pos + at.node.nodeSize, { class: `agent-here agent-${p.slot}` }));
  }
  for (const c of data.claims ?? []) {
    const found = (c.ids ?? []).map(nodeAt).filter(Boolean).sort((a, b) => a.pos - b.pos);
    if (!found.length) continue;
    for (const at of found) decos.push(Decoration.node(at.pos, at.pos + at.node.nodeSize, { class: 'is-claimed' }));
    decos.push(Decoration.widget(found[0].pos, () => claimLabel(c, data.onStopClaim), {
      key: `claim-${c.chat}-${c.ids.join(',')}-${c.intent ?? ''}`,
      side: -1,
      ignoreSelection: true,
      stopEvent: () => true,
    }));
  }
  for (const t of data.threads ?? []) {
    if (!t.anchor || t.resolved || t.detached) continue;
    try {
      const a = relativePositionToAbsolutePosition(sync.doc, page.frag, Y.createRelativePositionFromJSON(t.anchor.start), sync.binding.mapping);
      const b = relativePositionToAbsolutePosition(sync.doc, page.frag, Y.createRelativePositionFromJSON(t.anchor.end), sync.binding.mapping);
      if (a === null || b === null || b <= a) continue;
      decos.push(Decoration.inline(a, Math.min(b, state.doc.content.size), {
        class: t.thread === data.activeThread ? 'anch act' : 'anch',
        'data-thread': t.thread,
      }));
    } catch { /* not on this page */ }
  }
  for (const n of data.notes ?? []) {
    const at = (n.blocks ?? []).map(nodeAt).filter(Boolean).sort((a, b) => b.pos - a.pos)[0];
    if (!at || !data.noteView) continue;
    decos.push(Decoration.widget(at.pos + at.node.nodeSize, () => data.noteView(n), {
      key: `note-${n.id}-${data.noteOpen?.has(n.id) ? 'open' : 'shut'}`,
      side: 1,
      ignoreSelection: true,
      stopEvent: () => true,
    }));
  }
  return DecorationSet.create(state.doc, decos);
}

function claimLabel(c, onStop) {
  const box = el('div', 'claim-label');
  box.contentEditable = 'false';
  const text = el('span', 'claim-text', `${c.name} is rewriting this`);
  if (c.intent) text.append(el('span', 'claim-intent', ` · ${c.intent}`));
  const stop = el('button', 'btn sm', 'Stop and keep the text');
  stop.type = 'button';
  stop.dataset.claimStop = c.chat;
  stop.addEventListener('mousedown', (e) => e.preventDefault());
  stop.addEventListener('click', (e) => {
    e.preventDefault();
    onStop?.(c);
  });
  box.append(el('span', 'spin'), text, stop);
  return box;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Node views for the rich blocks (class-only DOM).

const ICONS = {
  info: 'M8 1.7a6.3 6.3 0 1 0 0 12.6A6.3 6.3 0 0 0 8 1.7zM8 7.2v4M8 4.6v.6',
  warning: 'M8 1.8L15 14H1zM8 6.2v3.6M8 11.5v.6',
  success: 'M8 1.7a6.3 6.3 0 1 0 0 12.6A6.3 6.3 0 0 0 8 1.7zM5 8.2l2 2 4-4.2',
};
function svgIcon(d, cls) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', d);
  s.append(p);
  return s;
}

const CALLOUT_NEXT = { info: 'warning', warning: 'success', success: 'info' };
const CALLOUT_NAME = { info: 'Info', warning: 'Warning', success: 'Success' };

function calloutView(page, node, getPos) {
  const dom = el('div', `callout callout-${node.attrs.variant}`);
  dom.dataset.callout = '';
  dom.dataset.variant = node.attrs.variant;
  const icon = el('button', 'callout-icon');
  icon.type = 'button';
  icon.contentEditable = 'false';
  icon.title = `${CALLOUT_NAME[node.attrs.variant] ?? 'Info'}: click to change the type`;
  icon.append(svgIcon(ICONS[node.attrs.variant] ?? ICONS.info, 'ci'));
  icon.addEventListener('mousedown', (e) => e.preventDefault());
  icon.addEventListener('click', () => {
    const view = page.view, pos = getPos();
    if (typeof pos !== 'number' || !view.editable) return;
    const cur = view.state.doc.nodeAt(pos);
    view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...cur.attrs, variant: CALLOUT_NEXT[cur.attrs.variant] ?? 'info' }));
  });
  const content = el('div', 'callout-body');
  dom.append(icon, content);
  return {
    dom,
    contentDOM: content,
    update: (next) => next.type === node.type && next.attrs.variant === node.attrs.variant,
    stopEvent: (e) => icon.contains(e.target),
  };
}

function toggleView(page, node, getPos) {
  const dom = el('div', 'toggle');
  dom.dataset.toggle = '';
  const caret = el('button', 'tg-car', '▶');
  caret.type = 'button';
  caret.contentEditable = 'false';
  const content = el('div', 'toggle-body');
  dom.append(caret, content);
  const key = () => {
    const pos = getPos();
    const type = typeof pos === 'number' ? typeAtPos(page.view.state, pos) : null;
    return type ? idOf(type) : null;
  };
  const paint = () => {
    const open = page.options.toggleOpen?.(key()) ?? true;
    dom.classList.toggle('open', open);
    caret.setAttribute('aria-expanded', String(open));
    caret.setAttribute('aria-label', open ? 'Close' : 'Open');
  };
  caret.addEventListener('mousedown', (e) => e.preventDefault());
  caret.addEventListener('click', () => {
    page.options.setToggle?.(key(), !dom.classList.contains('open'));
    paint();
  });
  queueMicrotask(paint);
  return {
    dom,
    contentDOM: content,
    update: (next) => next.type === node.type,
    stopEvent: (e) => caret.contains(e.target),
    // open/closed is a class on the view's own element: not a change to the doc
    ignoreMutation: (m) => (m.type === 'attributes' && m.target === dom) || caret.contains(m.target),
  };
}

function parseNumber(text) {
  const t = String(text ?? '').replace(/[\s,%$€£]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** A chart's numbers: row 0 the series names, column 0 the labels. */
function chartData(node) {
  const rows = [];
  node.firstChild?.forEach((row) => {
    const cells = [];
    row.forEach((cell) => cells.push(cell.textContent));
    rows.push(cells);
  });
  const head = rows[0] ?? [];
  const body = rows.slice(1);
  return {
    labels: body.map((r) => r[0] ?? ''),
    series: head.slice(1).map((name, k) => ({ name: name || `Series ${k + 1}`, values: body.map((r) => parseNumber(r[k + 1])) })),
  };
}

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** The chart picture, drawn from its own table; classes only (docs.css colours the series per theme). */
function drawChart(svg, data, type) {
  svg.replaceChildren();
  const W = 600, H = 210, L = 50, R = 585, T = 16, B = 180;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const all = data.series.flatMap((s) => s.values).filter((v) => v !== null);
  const min = Math.min(0, ...all), max = niceMax(Math.max(0, ...all));
  const span = max - min || 1;
  const y = (v) => B - ((v - min) / span) * (B - T);
  const grid = svgEl('g', {});
  for (let k = 0; k <= 4; k++) {
    const v = min + (span * k) / 4;
    grid.append(svgEl('line', { x1: L, y1: y(v), x2: R, y2: y(v), class: 'ch-grid' }));
    const t = svgEl('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'ch-ax' });
    t.textContent = String(Math.round(v * 100) / 100);
    grid.append(t);
  }
  const n = Math.max(data.labels.length, 1);
  const slot = (R - L) / n;
  data.labels.forEach((label, i) => {
    const t = svgEl('text', { x: L + slot * (i + 0.5), y: B + 18, 'text-anchor': 'middle', class: 'ch-ax' });
    t.textContent = label.length > 14 ? label.slice(0, 13) + '…' : label;
    grid.append(t);
  });
  svg.append(grid);
  const S = Math.max(data.series.length, 1);
  if (type === 'line') {
    data.series.forEach((s, k) => {
      const pts = s.values.map((v, i) => (v === null ? null : [L + slot * (i + 0.5), y(v)])).filter(Boolean);
      if (pts.length > 1) svg.append(svgEl('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: `ch-line ch-s${k + 1}` }));
      for (const p of pts) svg.append(svgEl('circle', { cx: p[0], cy: p[1], r: 4.5, class: `ch-dot ch-s${k + 1}` }));
    });
  } else {
    const bw = Math.max(4, Math.min(36, (slot * 0.8) / S));
    data.series.forEach((s, k) => {
      s.values.forEach((v, i) => {
        if (v === null) return;
        const x = L + slot * (i + 0.5) - (bw * S) / 2 + bw * k;
        const top = y(Math.max(v, 0)), bottom = y(Math.min(v, 0));
        svg.append(svgEl('rect', { x, y: top, width: Math.max(bw - 2, 1), height: Math.max(bottom - top, 0.5), rx: 2, class: `ch-bar ch-s${k + 1}` }));
      });
    });
  }
}

function chartView(page, node, getPos) {
  let current = node;
  const dom = el('figure', `chart chart-${node.attrs.chartType}`);
  const head = el('div', 'chart-h');
  head.contentEditable = 'false';
  const title = el('b', 'chart-title');
  const seg = el('span', 'seg');
  seg.setAttribute('role', 'group');
  seg.setAttribute('aria-label', 'Chart type');
  const kinds = ['bar', 'line'].map((kind) => {
    const b = el('button', '', kind === 'bar' ? 'Bar' : 'Line');
    b.type = 'button';
    b.dataset.chartType = kind;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const view = page.view, pos = getPos();
      if (typeof pos !== 'number' || !view.editable) return;
      const cur = view.state.doc.nodeAt(pos);
      if (cur.attrs.chartType !== kind) view.dispatch(view.state.tr.setNodeMarkup(pos, null, { ...cur.attrs, chartType: kind }));
    });
    seg.append(b);
    return b;
  });
  const dataBtn = el('button', 'btn sm chart-data-btn', 'Data ▾');
  dataBtn.type = 'button';
  dataBtn.setAttribute('aria-expanded', 'false');
  dataBtn.addEventListener('mousedown', (e) => e.preventDefault());
  dataBtn.addEventListener('click', () => {
    const open = !dom.classList.contains('data-open');
    dom.classList.toggle('data-open', open);
    dataBtn.textContent = open ? 'Data ▴' : 'Data ▾';
    dataBtn.setAttribute('aria-expanded', String(open));
  });
  head.append(svgIcon('M1.5 14.5h13M3.8 13V8M8 13V4.5M12.2 13V2', 'chart-ico'), title, el('span', 'sp'), seg, dataBtn);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'chart-svg');
  svg.setAttribute('role', 'img');
  const legend = el('div', 'ch-leg');
  legend.contentEditable = 'false';
  const data = el('div', 'ch-data');
  const lab = el('div', 'lab', 'Data: edit a number and the chart redraws as you type');
  lab.contentEditable = 'false';
  const content = el('div', 'ch-table');
  data.append(lab, content);
  const caption = el('figcaption', 'figcap');
  caption.contentEditable = 'false';
  const picture = el('div', 'chart-pic');
  picture.contentEditable = 'false';
  picture.append(svg, legend);
  dom.append(head, picture, data, caption);
  const paint = () => {
    const a = current.attrs;
    dom.classList.toggle('chart-bar', a.chartType !== 'line');
    dom.classList.toggle('chart-line', a.chartType === 'line');
    title.textContent = a.title || 'Chart';
    caption.textContent = a.caption || '';
    caption.hidden = !a.caption;
    kinds.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.chartType === a.chartType)));
    const d = chartData(current);
    svg.setAttribute('aria-label', `${a.title || 'Chart'}: ${d.series.map((s) => s.name).join(', ')}`);
    drawChart(svg, d, a.chartType);
    legend.replaceChildren(...d.series.map((s, k) => {
      const item = el('span', '');
      item.append(el('i', `ch-key ch-s${k + 1}`), document.createTextNode(s.name));
      return item;
    }));
  };
  paint();
  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== node.type) return false;
      current = next;
      paint();
      return true;
    },
    ignoreMutation: (m) => !content.contains(m.target),
    stopEvent: (e) => head.contains(e.target) || picture.contains(e.target),
  };
}

function drawingView(page, node) {
  let current = node;
  const dom = el('figure', 'drawing drw');
  dom.contentEditable = 'false';
  const bar = el('div', 'drw-bar');
  const full = el('button', 'btn sm', 'Full screen');
  full.type = 'button';
  full.addEventListener('click', () => page.options.openDrawing?.(current.attrs));
  bar.append(full);
  const img = el('img', 'drw-img');
  const empty = el('div', 'drw-empty', 'Drawing');
  const cap = el('figcaption', 'figcap');
  dom.append(bar, img, empty, cap);
  const paint = () => {
    cap.textContent = current.attrs.caption || '';
    cap.hidden = !current.attrs.caption;
    img.alt = current.attrs.caption || 'Drawing';
    img.hidden = true;
    empty.hidden = false;
    Promise.resolve(page.options.drawingSrc?.(current.attrs)).then((src) => {
      if (!src) return;
      img.src = src;
      img.hidden = false;
      empty.hidden = true;
    });
  };
  paint();
  dom.addEventListener('dblclick', () => page.options.openDrawing?.(current.attrs));
  // the page says when the drawings changed (their pictures are written again): show the new one
  const again = () => paint();
  document.addEventListener('aib-drawings', again);
  return {
    dom,
    update(next) {
      if (next.type !== node.type) return false;
      const changed = next.attrs.src !== current.attrs.src || next.attrs.caption !== current.attrs.caption;
      current = next;
      if (changed) paint();
      return true;
    },
    stopEvent: (e) => bar.contains(e.target),
    ignoreMutation: () => true,
    destroy: () => document.removeEventListener('aib-drawings', again),
  };
}

function imageView(page, node) {
  const img = el('img', 'doc-img');
  img.alt = node.attrs.alt || '';
  if (node.attrs.title) img.title = node.attrs.title;
  const src = String(node.attrs.src || '');
  if (/^(data:|blob:)/i.test(src)) img.src = src;
  else Promise.resolve(page.options.assetSrc?.(src)).then((u) => u && (img.src = u));
  return { dom: img, ignoreMutation: () => true };
}

function pendingView(page, node, getPos) {
  const dom = el('div', 'pending ph-block');
  dom.dataset.pending = '';
  const head = el('div', 'ph-head');
  head.contentEditable = 'false';
  const title = el('b', 'ph-title');
  const who = el('span', 'ph-who');
  const skip = el('button', 'btn sm ghost ph-skip', 'Skip this section');
  skip.type = 'button';
  skip.addEventListener('mousedown', (e) => e.preventDefault());
  skip.addEventListener('click', () => {
    const view = page.view, pos = getPos();
    if (typeof pos !== 'number' || !view.editable) return;
    const cur = view.state.doc.nodeAt(pos);
    const tr = view.state.tr;
    if (view.state.doc.childCount === 1 && pos === 0) tr.replaceWith(pos, pos + cur.nodeSize, view.state.schema.nodes.paragraph.create());
    else tr.delete(pos, pos + cur.nodeSize);
    view.dispatch(tr);
  });
  head.append(el('span', 'spin'), title, who, el('span', 'sp'), skip);
  const lines = el('div', 'ph-lines');
  lines.contentEditable = 'false';
  lines.append(el('div', 'ph-line'), el('div', 'ph-line short'));
  const content = el('div', 'ph-text');
  dom.append(head, lines, content);
  const paint = (n) => {
    title.textContent = n.attrs.intent || 'Planned section';
    who.textContent = ` · ${page.options.pendingName?.() ?? 'The agent'} will write this next`;
    dom.classList.toggle('has-text', n.content.size > 0);
  };
  paint(node);
  return {
    dom,
    contentDOM: content,
    update(next) {
      if (next.type !== node.type) return false;
      paint(next);
      return true;
    },
    stopEvent: (e) => head.contains(e.target),
    ignoreMutation: (m) => !content.contains(m.target),
  };
}

function viewsPlugin(page) {
  const wrap = (fn) => (node, _view, getPos) => fn(page, node, getPos);
  return new Plugin({
    key: new PluginKey('aib-views'),
    props: {
      nodeViews: {
        ...plainViews,
        callout: wrap(calloutView),
        toggle: wrap(toggleView),
        chart: wrap(chartView),
        drawing: wrap(drawingView),
        image: wrap(imageView),
        pending: wrap(pendingView),
      },
      markViews: plainMarkViews,
    },
  });
}

// Agents' cursors: a caret with the agent's name on a flag, by class (agent-a / agent-b), only where the agent works on this page.
function cursorPlugin(page) {
  return yCursorPlugin(page.session.awareness, {
    awarenessStateFilter: (mine, client, aw) => mine !== client && !!aw?.agent && aw.agent.page === page.page,
    cursorBuilder: (user, client) => {
      const aw = page.session.awareness.getStates().get(client);
      const slot = page.options.slotOf?.(aw?.agent?.chat) ?? 'a';
      const caret = el('span', `agent-caret agent-${slot}`);
      caret.setAttribute('aria-hidden', 'true');
      caret.append(document.createTextNode('⁠'), el('span', 'agent-flag', user.name), document.createTextNode('⁠'));
      return caret;
    },
    selectionBuilder: () => ({ class: 'agent-sel' }),
  });
}

/** One page of the doc in the editor. */
class PageEditor {
  constructor(session, element, page, frag, options) {
    Object.assign(this, { session, element, page, frag, options, data: null });
    const self = this;
    this.editor = new Editor({
      element,
      injectCSS: false,
      editable: options.editable !== false,
      extensions: [
        ...docExtensions(),
        Collaboration.configure({ fragment: frag, yUndoOptions: { undoManager: session.undo } }),
        Extension.create({
          name: 'aibPage',
          addProseMirrorPlugins: () => [viewsPlugin(self), cursorPlugin(self), marksPlugin(self)],
          addKeyboardShortcuts() {
            const align = (a) => () =>
              this.editor.chain().focus().updateAttributes('paragraph', { align: a }).updateAttributes('heading', { align: a }).run();
            return {
              'Mod-Shift-1': () => this.editor.chain().focus().toggleHeading({ level: 1 }).run(),
              'Mod-Shift-2': () => this.editor.chain().focus().toggleHeading({ level: 2 }).run(),
              'Mod-Shift-3': () => this.editor.chain().focus().toggleHeading({ level: 3 }).run(),
              'Mod-Shift-l': align(null),
              'Mod-Shift-e': align('center'),
              'Mod-Shift-r': align('right'),
              'Mod-Alt-m': () => (self.options.onCommentKey?.(), true),
              'Mod-y': () => this.editor.commands.redo(),
            };
          },
        }),
      ],
      editorProps: { attributes: { class: 'doc-body', spellcheck: 'true', 'aria-label': 'Page text' } },
      onTransaction: ({ transaction }) => options.onTransaction?.(transaction),
      onSelectionUpdate: () => options.onSelection?.(),
      onFocus: () => options.onFocus?.(),
      onBlur: () => options.onBlur?.(),
    });
  }
  get view() {
    return this.editor.view;
  }
  get destroyed() {
    return this.editor.isDestroyed;
  }
  /** Agents' presence, claims, comment anchors and refused notes, drawn as decorations. */
  setMarks(data) {
    this.data = data;
    if (!this.editor.isDestroyed) this.view.dispatch(this.view.state.tr.setMeta(marksKey, data).setMeta('addToHistory', false));
  }
  /** The server id of the node that starts at `pos`, or null. */
  blockIdAt(pos) {
    const type = typeAtPos(this.view.state, pos);
    return type ? idOf(type) : null;
  }
  /** The selection as a comment range: its textblock's id and the offsets in its text (an atom counts one), or null. */
  selectionRange() {
    const { from, to, $from, $to } = this.view.state.selection;
    if (from === to || !$from.parent.isTextblock || $from.parent !== $to.parent) return null;
    const start = $from.start();
    const block = this.blockIdAt($from.before());
    if (!block) return null;
    return { block, from: from - start, to: to - start, text: this.view.state.doc.textBetween(from, to, ' ', '￼') };
  }
  /** Where a block (server id) is on this page: {pos, node}, or null. */
  findBlock(id) {
    const type = this.session.typeOf(id);
    const pos = type ? posOfType(this.view.state, this.frag, type) : null;
    const node = pos !== null ? this.view.state.doc.nodeAt(pos) : null;
    return node ? { pos, node } : null;
  }
  /** The top-level block around a position: {pos, node, index}. */
  topBlockAt(pos) {
    const doc = this.view.state.doc;
    const $p = doc.resolve(Math.max(0, Math.min(pos, doc.content.size)));
    if ($p.depth === 0) {
      const index = Math.min($p.index(0), doc.childCount - 1);
      let at = 0;
      for (let i = 0; i < index; i++) at += doc.child(i).nodeSize;
      return { pos: at, node: doc.child(index), index };
    }
    return { pos: $p.before(1), node: $p.node(1), index: $p.index(0) };
  }
  /** Scroll a block (server id) into view; true when it is on this page. */
  reveal(id) {
    const at = this.findBlock(id);
    if (!at) return false;
    const dom = this.view.nodeDOM(at.pos);
    if (dom && dom.scrollIntoView) dom.scrollIntoView({ block: 'center' });
    return true;
  }
  /** The PM position where a comment anchor starts on this page, or null. */
  anchorPos(anchor) {
    const sync = ySyncPluginKey.getState(this.view.state);
    try {
      return relativePositionToAbsolutePosition(sync.doc, this.frag, Y.createRelativePositionFromJSON(anchor.start), sync.binding.mapping);
    } catch {
      return null;
    }
  }
  /** A Yjs relative position for a PM position. */
  relativeAt(pos) {
    const sync = ySyncPluginKey.getState(this.view.state);
    return Y.relativePositionToJSON(absolutePositionToRelativePosition(pos, this.frag, sync.binding.mapping));
  }
  destroy() {
    if (!this.editor.isDestroyed) this.editor.destroy();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Read-only rendering for History and Compare.

let serializer = null;
/** ProseMirror JSON nodes rendered with the doc's schema into `container` (no editor, no inline style). */
function renderNodes(nodes, container) {
  const s = theSchema();
  serializer ??= serializerFor(s);
  for (const json of nodes ?? []) {
    let node;
    try {
      node = PMNode.fromJSON(s, json);
    } catch {
      continue;
    }
    container.append(renderNode(node));
  }
  return container;
}

function renderNode(node) {
  if (node.type.name === 'chart') {
    const fig = el('figure', `chart chart-${node.attrs.chartType}`);
    const head = el('div', 'chart-h');
    head.append(el('b', 'chart-title', node.attrs.title || 'Chart'));
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('class', 'chart-svg');
    drawChart(svg, chartData(node), node.attrs.chartType);
    fig.append(head, svg);
    return fig;
  }
  if (node.type.name === 'drawing') return el('figure', 'drawing drw drw-ro', node.attrs.caption || 'Drawing');
  if (node.type.name === 'image') return el('span', 'doc-img-ro', node.attrs.alt || 'Image');
  if (node.type.name === 'pending') {
    const box = el('div', 'pending ph-block');
    box.append(el('b', 'ph-title', node.attrs.intent || 'Planned section'));
    return box;
  }
  if (node.isTextblock || node.type.name === 'rawBlock') return serializer.serializeNode(node);
  // containers: their children through this same function (charts and drawings inside callouts or columns)
  const dom = serializer.serializeNode(node.type.create(node.attrs));
  const hole = dom.querySelector?.('tbody') ?? dom;
  node.forEach((child) => hole.append(renderNode(child)));
  return dom;
}

// ---------------------------------------------------------------------------------------------------------------------------------

globalThis.AIBDocEditor = {
  version: 3,
  schemaVersion: SCHEMA_VERSION,
  createSession: (options) => new DocSession(options),
  renderNodes,
  selections: { TextSelection, NodeSelection, CellSelection },
  /** The schema's plain-data fingerprint (schema.ts schemaSummary), for the server-vs-page check. */
  schemaSummary: () => schemaSummary(theSchema()),
  /** A Y.Doc update (the server's state) as the page reads it: ProseMirror JSON, checked against the schema. */
  docJSON(update) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const node = yXmlFragmentToProseMirrorRootNode(doc.getXmlFragment(FIELD), theSchema());
    node.check();
    return node.toJSON();
  },
  /** ProseMirror JSON as the page would write it into a fresh Y.Doc: the update. */
  encode(json) {
    return Y.encodeStateAsUpdate(prosemirrorJSONToYDoc(theSchema(), json, FIELD));
  },
};
