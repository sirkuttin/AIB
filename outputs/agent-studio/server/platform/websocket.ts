/**
 * Server-side WebSockets for both listener kinds http_serve.ts runs:
 *   Deno.serve (deno run, tests)   Deno.upgradeWebSocket
 *   node:http (the desktop binary) the 'upgrade' event hands us the raw socket; the RFC 6455 handshake and framing are done here
 *                                  (small: text, binary, close, ping/pong, fragments; client frames must be masked).
 * Route code sees one shape, WsLink, either way.
 */
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';

export interface WsLink {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onmessage: ((data: string | Uint8Array) => void) | null;
  onclose: (() => void) | null;
  readonly isOpen: boolean;
}

/** Largest message accepted from a client (terminal input and control messages are small). */
export const MAX_MESSAGE = 1024 * 1024;

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** One server frame (FIN set, never masked). */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const head = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const out = new Uint8Array(head + n);
  out[0] = 0x80 | opcode;
  if (n < 126) out[1] = n;
  else if (n < 65536) {
    out[1] = 126;
    out[2] = n >> 8;
    out[3] = n & 0xff;
  } else {
    out[1] = 127;
    new DataView(out.buffer).setBigUint64(2, BigInt(n));
  }
  out.set(payload, head);
  return out;
}

export interface Frame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** Splits a byte stream from a client into frames. Throws on a protocol error (unmasked frame, oversized message). */
export class FrameReader {
  #buffer = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    const joined = new Uint8Array(this.#buffer.length + chunk.length);
    joined.set(this.#buffer);
    joined.set(chunk, this.#buffer.length);
    this.#buffer = joined;
    const frames: Frame[] = [];
    while (true) {
      const b = this.#buffer;
      if (b.length < 2) break;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      if ((b[1] & 0x80) === 0) throw new Error('client frame not masked');
      let length = b[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (b.length < 4) break;
        length = (b[2] << 8) | b[3];
        offset = 4;
      } else if (length === 127) {
        if (b.length < 10) break;
        const big = new DataView(b.buffer, b.byteOffset).getBigUint64(2);
        if (big > BigInt(MAX_MESSAGE)) throw new Error('message too large');
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_MESSAGE) throw new Error('message too large');
      if (b.length < offset + 4 + length) break;
      const mask = b.subarray(offset, offset + 4);
      const payload = b.slice(offset + 4, offset + 4 + length);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      frames.push({ fin, opcode, payload });
      this.#buffer = b.slice(offset + 4 + length);
    }
    return frames;
  }
}

/** A WsLink over a raw socket whose handshake has been answered. */
export function nodeLink(socket: Duplex, head: Uint8Array): WsLink {
  const reader = new FrameReader();
  let open = true;
  let parts: Uint8Array[] = [];
  let partOpcode = 0;
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const link: WsLink = {
    onmessage: null,
    onclose: null,
    get isOpen() {
      return open;
    },
    send(data) {
      if (!open) return;
      const text = typeof data === 'string';
      socket.write(encodeFrame(text ? 0x1 : 0x2, text ? new TextEncoder().encode(data) : data));
    },
    close(code = 1000, reason = '') {
      if (!open) return;
      const r = new TextEncoder().encode(reason).slice(0, 120);
      const body = new Uint8Array(2 + r.length);
      body[0] = code >> 8;
      body[1] = code & 0xff;
      body.set(r, 2);
      try {
        socket.write(encodeFrame(0x8, body));
      } catch { /* gone */ }
      finish();
      setTimeout(() => socket.destroy(), 1000).unref?.();
      socket.end();
    },
  };
  const finish = () => {
    if (!open) return;
    open = false;
    try {
      link.onclose?.();
    } catch { /* listener */ }
  };
  const take = (chunk: Uint8Array) => {
    let frames: Frame[];
    try {
      frames = reader.push(chunk);
    } catch {
      link.close(1009, 'protocol error');
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        link.close(1000);
        return;
      }
      if (frame.opcode === 0x9) {
        if (open) socket.write(encodeFrame(0xa, frame.payload));
        continue;
      }
      if (frame.opcode === 0xa) continue;
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        partOpcode = frame.opcode;
        parts = [];
      } else if (frame.opcode !== 0x0) {
        link.close(1003, 'unsupported');
        return;
      }
      parts.push(frame.payload);
      if (parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) {
        link.close(1009, 'message too large');
        return;
      }
      if (!frame.fin) continue;
      const whole = parts.length === 1 ? parts[0] : concat(parts);
      parts = [];
      try {
        link.onmessage?.(partOpcode === 0x1 ? decoder.decode(whole) : whole);
      } catch { /* listener */ }
    }
  };
  socket.on('data', (chunk: Uint8Array) => take(new Uint8Array(chunk)));
  socket.on('close', finish);
  socket.on('error', finish);
  if (head.length) queueMicrotask(() => take(head));
  return link;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A WsLink over a Deno WebSocket. */
function denoLink(socket: WebSocket): WsLink {
  socket.binaryType = 'arraybuffer';
  let early: (string | Uint8Array)[] = []; // sent before the handshake finished
  const link: WsLink = {
    onmessage: null,
    onclose: null,
    get isOpen() {
      return socket.readyState === WebSocket.OPEN;
    },
    send(data) {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
      else if (socket.readyState === WebSocket.CONNECTING) early.push(data);
    },
    close(code = 1000, reason = '') {
      if (socket.readyState === WebSocket.CONNECTING) {
        const opened = socket.onopen; // what was sent before the handshake goes first
        socket.onopen = (event) => {
          opened?.call(socket, event);
          socket.close(code, reason);
        };
      }
      else if (socket.readyState === WebSocket.OPEN) socket.close(code, reason);
    },
  };
  socket.onopen = () => {
    for (const data of early) socket.send(data);
    early = [];
  };
  // Messages that arrive before the socket opens are kept (the route attaches its handlers right after upgrading).
  socket.onmessage = (event) => {
    const data = event.data;
    try {
      link.onmessage?.(typeof data === 'string' ? data : new Uint8Array(data as ArrayBuffer));
    } catch { /* listener */ }
  };
  socket.onclose = () => link.onclose?.();
  socket.onerror = () => {};
  return link;
}

interface NodeUpgrade {
  socket: Duplex;
  head: Uint8Array;
}
const nodeUpgrades = new WeakMap<Request, NodeUpgrade>();
const pendingResponses = new WeakMap<Response, () => void>();

/** http_serve.ts: this Request came in through node's 'upgrade' event on `socket`. */
export function registerNodeUpgrade(request: Request, socket: Duplex, head: Uint8Array): void {
  nodeUpgrades.set(request, { socket, head });
}

/**
 * http_serve.ts, after the handler answered an upgrade request: true when the answer was upgradeWebSocket's (the 101 has now been
 * written and the link is live); false when it is an ordinary response the caller must write itself.
 */
export function completeNodeUpgrade(response: Response): boolean {
  const done = pendingResponses.get(response);
  if (!done) return false;
  pendingResponses.delete(response);
  done();
  return true;
}

/** True when the request asks for a WebSocket. */
export function wantsWebSocket(request: Request): boolean {
  return (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket' && !!request.headers.get('sec-websocket-key');
}

/**
 * Accept a WebSocket request. `protocol` is echoed when given (the client offered it). Return `response` from the handler; attach
 * onmessage / onclose to `link` right away.
 */
export function upgradeWebSocket(request: Request, protocol: string | null = null): { link: WsLink; response: Response } {
  const node = nodeUpgrades.get(request);
  if (!node) {
    const { socket, response } = Deno.upgradeWebSocket(request, protocol ? { protocol } : {});
    return { link: denoLink(socket), response };
  }
  const key = request.headers.get('sec-websocket-key') ?? '';
  const holder: { link: WsLink | null } = { link: null };
  let early: (string | Uint8Array)[] = []; // sent before the handshake is written
  let closeEarly: [number | undefined, string | undefined] | null = null;
  // A link that buffers until the handshake is written (the route sets its handlers before that).
  const proxy: WsLink = {
    onmessage: null,
    onclose: null,
    get isOpen() {
      return holder.link?.isOpen ?? false;
    },
    send: (data) => (holder.link ? holder.link.send(data) : early.push(data)),
    close: (code, reason) => (holder.link ? holder.link.close(code, reason) : (closeEarly = [code, reason])),
  };
  const response = new Response(null, { status: 200 });
  pendingResponses.set(response, () => {
    node.socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` + (protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : '') + '\r\n',
    );
    const link = nodeLink(node.socket, node.head);
    holder.link = link;
    link.onmessage = (data) => proxy.onmessage?.(data);
    link.onclose = () => proxy.onclose?.();
    for (const data of early) link.send(data);
    early = [];
    if (closeEarly) link.close(...closeEarly);
  });
  return { link: proxy, response };
}
