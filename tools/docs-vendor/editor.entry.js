// The doc editor for AIB's page: TipTap bound to a Y.Doc with @tiptap/y-tiptap (TipTap's Collaboration extension), with the schema
// of server/docs/schema.ts, synced to AIB's server over a WebSocket with the y-protocols sync and awareness messages.
// Exposes window.AIBDocEditor: mount(element, options), plus schema checks the server's tests use (schemaSummary, docJSON, encode).
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Editor, getSchema } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { prosemirrorJSONToYDoc, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { docExtensions, SCHEMA_VERSION, schemaSummary } from '../../outputs/agent-studio/server/docs/schema.ts';

const MSG_SYNC = 0, MSG_AWARENESS = 1;
const FIELD = 'doc';

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
    extensions: [...docExtensions(), Collaboration.configure({ document: doc, field: FIELD })],
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

let schema = null;
const theSchema = () => (schema ??= getSchema(docExtensions()));

globalThis.AIBDocEditor = {
  mount,
  version: 2,
  schemaVersion: SCHEMA_VERSION,
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
