/**
 * Test helpers for the local docs: the page's side as a second Yjs client over the y-protocols messages (an in-memory socket whose
 * up direction can be held, so a test can keep the user's keystrokes "in flight" while an agent's call lands), and seeded docs.
 */
import { assert } from './_assert.ts';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { FIELD, LiveDoc } from '../../outputs/agent-studio/server/docs/live_doc.ts';
import { parseDoc, writeDoc } from '../../outputs/agent-studio/server/docs/markdown.ts';
import { MD_NOTE } from '../../outputs/agent-studio/server/docs/store.ts';
import type { WsLink } from '../../outputs/agent-studio/server/platform/websocket.ts';

/** The page's side: a Y.Doc synced with the server through y-protocols over a socket whose up direction can be held. */
export class UserClient {
  readonly doc = new Y.Doc();
  readonly frag: Y.XmlFragment;
  /** The origin of the user's own keystrokes (what y-tiptap's undo tracks in the page). */
  readonly typing = { kind: 'typing' };
  readonly undo: Y.UndoManager;
  holdUp = false;
  /** AIB's control messages the page got (JSON text frames: refused notes, history marks...). */
  readonly control: Record<string, unknown>[] = [];
  #up: Uint8Array[] = [];
  readonly link: WsLink;

  constructor(readonly live: LiveDoc) {
    this.frag = this.doc.getXmlFragment(FIELD);
    this.undo = new Y.UndoManager(this.frag, { trackedOrigins: new Set([this.typing]), captureTimeout: 0 });
    this.link = { onmessage: null, onclose: null, isOpen: true, send: (data) => (typeof data === 'string' ? void this.control.push(JSON.parse(data)) : this.#receive(data)), close: () => {} };
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      syncProtocol.writeUpdate(e, update);
      this.#send(encoding.toUint8Array(e));
    });
    live.attach(this.link);
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.writeSyncStep1(e, this.doc);
    this.#send(encoding.toUint8Array(e));
  }

  #send(data: Uint8Array): void {
    if (this.holdUp) this.#up.push(data);
    else this.link.onmessage!(data);
  }

  /** Deliver the held keystrokes to the server. */
  release(): void {
    this.holdUp = false;
    for (const data of this.#up.splice(0)) this.link.onmessage!(data);
  }

  #receive(data: Uint8Array): void {
    const d = decoding.createDecoder(data);
    if (decoding.readVarUint(d) !== 0) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 0);
    syncProtocol.readSyncMessage(d, e, this.doc, this);
    if (encoding.length(e) > 1) this.#send(encoding.toUint8Array(e));
  }

  /** The element with this server id, anywhere in the doc. */
  block(id: string): Y.XmlElement {
    const find = (p: Y.XmlFragment): Y.XmlElement | null => {
      for (const c of p.toArray()) {
        if (!(c instanceof Y.XmlElement)) continue;
        if (`${c._item!.id.client}.${c._item!.id.clock}` === id) return c;
        const r = find(c);
        if (r) return r;
      }
      return null;
    };
    let el = find(this.frag);
    for (const m of this.doc.getArray<Y.Map<unknown>>('pages').toArray()) {
      if (el) break;
      el = find(this.doc.getXmlFragment(String(m.get('field'))));
    }
    assert(el, `no block ${id} in the user's copy`);
    return el;
  }

  /** Type `text` at `offset` in a textblock, as the editor would (one local transaction). */
  type(id: string, offset: number, text: string): void {
    this.doc.transact(() => {
      const el = this.block(id);
      if (!(el.get(0) instanceof Y.XmlText)) el.insert(0, [new Y.XmlText()]);
      (el.get(0) as Y.XmlText).insert(offset, text);
    }, this.typing);
  }

  /** Delete a block, as the editor would. */
  remove(id: string): void {
    this.doc.transact(() => {
      const el = this.block(id);
      const parent = el.parent as Y.XmlFragment;
      parent.delete(parent.toArray().indexOf(el), 1);
    }, this.typing);
  }

  text(id: string): string {
    return (this.block(id).get(0) as Y.XmlText).toString().replace(/<[^>]+>/g, '');
  }
}

/** A docs/<name>.md of the old layout: AIB wrote it, so it starts with AIB's note (a user's own docs/x.md is never a doc). */
export function legacyMd(text: string): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return MD_NOTE + eol + eol + text;
}

export function seeded(md: string): LiveDoc {
  const live = new LiveDoc();
  live.replaceAll(parseDoc(md).blocks.map((b) => b.node), live.system);
  return live;
}

/** The doc's Markdown, written fresh (no original text kept). */
export function markdown(live: LiveDoc): string {
  return writeDoc(live.topBlocks(), {}, '\n', '\n').text;
}
