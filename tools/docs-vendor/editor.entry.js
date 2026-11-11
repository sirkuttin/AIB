// The doc editor for AIB's page: TipTap (ProseMirror) bound to a Y.Doc with y-prosemirror, synced to AIB's server over a WebSocket
// with the y-protocols sync and awareness messages. Exposes window.AIBDocEditor.mount(element, options).
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Editor, Mark, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';

const MSG_SYNC = 0, MSG_AWARENESS = 1;

/** Text an agent wrote: the server sets this mark on it; shown tinted, with the agent's name as a tooltip. Never extends to typing. */
const AgentEdit = Mark.create({
  name: 'agentEdit',
  inclusive: false,
  addAttributes() {
    return { by: { default: 'agent', parseHTML: (el) => el.getAttribute('data-by'), renderHTML: (a) => ({ 'data-by': a.by, title: 'Written by ' + a.by }) } };
  },
  parseHTML: () => [{ tag: 'span[data-agent-edit]' }],
  renderHTML: ({ HTMLAttributes }) => ['span', mergeAttributes({ 'data-agent-edit': '', class: 'agent-edit' }, HTMLAttributes), 0],
});

/** One doc's socket: sync step 1/2 and updates both ways, awareness both ways, reconnect with backoff. */
class DocSocket {
  constructor(url, protocols, doc, awareness, onStatus) {
    Object.assign(this, { url, protocols, doc, awareness, onStatus, ws: null, closed: false, wait: 500 });
    this.onUpdate = (update, origin) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeUpdate(e, update);
      this.send(encoding.toUint8Array(e));
    };
    this.onAwareness = ({ added, updated, removed }) => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_AWARENESS);
      encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed)));
      this.send(encoding.toUint8Array(e));
    };
    doc.on('update', this.onUpdate);
    awareness.on('update', this.onAwareness);
    this.connect();
  }
  send(data) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(data);
  }
  connect() {
    if (this.closed) return;
    const ws = new WebSocket(this.url, this.protocols);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.onStatus?.('connecting');
    ws.onopen = () => {
      this.wait = 500;
      this.onStatus?.('connected');
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MSG_SYNC);
      syncProtocol.writeSyncStep1(e, this.doc);
      ws.send(encoding.toUint8Array(e));
      if (this.awareness.getLocalState() !== null) this.onAwareness({ added: [this.doc.clientID], updated: [], removed: [] });
    };
    ws.onmessage = (event) => {
      const d = decoding.createDecoder(new Uint8Array(event.data));
      const type = decoding.readVarUint(d);
      if (type === MSG_SYNC) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, MSG_SYNC);
        syncProtocol.readSyncMessage(d, e, this.doc, this);
        if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
      } else if (type === MSG_AWARENESS) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this);
      }
    };
    ws.onclose = () => {
      this.onStatus?.('offline');
      if (this.closed) return;
      setTimeout(() => this.connect(), this.wait);
      this.wait = Math.min(this.wait * 2, 10000);
    };
  }
  destroy() {
    this.closed = true;
    this.doc.off('update', this.onUpdate);
    this.awareness.off('update', this.onAwareness);
    this.ws?.close();
  }
}

/**
 * mount(element, {url, protocols, user, onStatus}) -> {editor, doc, destroy}. `url` is the doc's socket address; `protocols` the
 * WebSocket subprotocols (AIB passes its page token as one).
 */
function mount(element, options) {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalStateField('user', options.user ?? { name: 'You' });
  const socket = new DocSocket(options.url, options.protocols, doc, awareness, options.onStatus);
  const editor = new Editor({
    element,
    injectCSS: false,
    extensions: [StarterKit.configure({ history: false }), AgentEdit, Collaboration.configure({ document: doc, field: 'doc' })],
  });
  return {
    editor,
    doc,
    destroy() {
      editor.destroy();
      socket.destroy();
      awareness.destroy();
      doc.destroy();
    },
  };
}

globalThis.AIBDocEditor = { mount, version: 1 };
