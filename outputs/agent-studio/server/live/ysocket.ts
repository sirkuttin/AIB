/**
 * The page-socket part of a server-held Y.Doc, shared by local docs (docs/live_doc.ts) and the file editor (files/live_file.ts):
 * y-protocols sync both ways, awareness both ways, and AIB's JSON control messages as text frames. Each page socket is a WsLink
 * (platform/websocket.ts); the link is the transaction origin of the updates it sends, so the owner can tell the user's typing from
 * its own changes (an agent's, the disk's).
 */
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import type { WsLink } from '../platform/websocket.ts';

export const MSG_SYNC = 0, MSG_AWARENESS = 1;

export class YSocketHub {
  readonly awareness: awarenessProtocol.Awareness;
  #sockets = new Map<WsLink, { clients: Set<number>; tag: string }>();
  /** Called after a link went (closed by the page or by us). */
  onDetach: ((link: WsLink) => void) | null = null;
  /** A JSON control message from a page (a text frame), e.g. the file editor's {type: 'undo'}; unparseable frames are ignored. */
  onControl: ((link: WsLink, message: Record<string, unknown>) => void) | null = null;

  constructor(readonly doc: Y.Doc) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalState(null); // the server has no cursor
    doc.on('update', (update: Uint8Array, origin: unknown) => this.#broadcast(update, origin));
    this.awareness.on(
      'update',
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
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

  /** Connect one page socket: sync both ways, awareness both ways. `tag`: the caller's name for this link (a view id). */
  attach(link: WsLink, tag = ''): void {
    this.#sockets.set(link, { clients: new Set(), tag });
    link.onmessage = (data) => {
      if (typeof data === 'string') {
        let message: unknown = null;
        try {
          message = JSON.parse(data);
        } catch { /* not JSON: ignored */ }
        if (message && typeof message === 'object' && this.onControl) this.onControl(link, message as Record<string, unknown>);
        return;
      }
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
    this.onDetach?.(link);
  }

  /** A JSON control message (a text frame) to every page socket. */
  sendControl(message: Record<string, unknown>): void {
    const text = JSON.stringify(message);
    for (const link of this.#sockets.keys()) link.send(text);
  }

  has(link: WsLink): boolean {
    return this.#sockets.has(link);
  }

  get socketCount(): number {
    return this.#sockets.size;
  }

  /** The tags of the links still attached (the file editor's view ids). */
  tags(): string[] {
    return [...this.#sockets.values()].map((s) => s.tag);
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

  /** Close every link (`reason` goes with the close frame) and stop the awareness. */
  destroy(code = 1001, reason = 'closed'): void {
    for (const link of [...this.#sockets.keys()]) link.close(code, reason);
    this.awareness.destroy();
  }
}
