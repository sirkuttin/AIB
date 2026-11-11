/**
 * A standalone server for trying the drawing spike: one DrawingHub, the page, its WebSocket, and the agent tools over HTTP.
 * Not wired into AIB's server (the doc core merge does that). Listens on 127.0.0.1 only.
 *
 *   deno run -A server/docs/drawing/demo_server.ts --port 8791
 *   open http://127.0.0.1:8791/?drawing=d1
 *   POST /api/read {drawing}   POST /api/edit {drawing, ops}   POST /api/mermaid {drawing, mermaid}
 *   GET  /api/export?drawing=d1&as=json|svg
 *
 * WebSocket frames: byte 0 = Yjs update, byte 1 = awareness update (y-protocols encoding), rest = payload.
 */
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from './deps.ts';
import { Y } from './model.ts';
import { drawing_edit, drawing_from_mermaid, drawing_read, DrawingHub } from './tools.ts';
import { exportJson, exportSvg } from './files.ts';

const VENDOR = new URL('../../../vendor/excalidraw/', import.meta.url);
const PAGE = new URL('./page/drawing.html', import.meta.url);
const TYPES: Record<string, string> = { js: 'text/javascript', css: 'text/css', woff2: 'font/woff2', ttf: 'font/ttf', html: 'text/html' };

function frame(kind: number, bytes: Uint8Array) {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = kind;
  out.set(bytes, 1);
  return out;
}

export function startDemo(hub: DrawingHub, port: number, signal?: AbortSignal) {
  const sockets = new Map<WebSocket, Set<number>>();
  const broadcast = (data: Uint8Array, except?: unknown) => {
    for (const s of sockets.keys()) if (s !== except && s.readyState === WebSocket.OPEN) s.send(data);
  };
  hub.doc.on('update', (u: Uint8Array, origin: unknown) => broadcast(frame(0, u), origin));
  hub.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const ids = [...added, ...updated, ...removed];
    const owner = sockets.get(origin as WebSocket);
    if (owner) { for (const id of [...added, ...updated]) owner.add(id); }
    broadcast(frame(1, encodeAwarenessUpdate(hub.awareness, ids)), origin);
  });

  return Deno.serve({ hostname: '127.0.0.1', port, signal, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    if (url.pathname === '/ws') {
      const { socket, response } = Deno.upgradeWebSocket(req);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        sockets.set(socket, new Set());
        socket.send(frame(0, Y.encodeStateAsUpdate(hub.doc)));
        const ids = [...hub.awareness.getStates().keys()];
        if (ids.length) socket.send(frame(1, encodeAwarenessUpdate(hub.awareness, ids)));
      };
      socket.onmessage = (ev) => {
        const data = new Uint8Array(ev.data as ArrayBuffer);
        if (data[0] === 0) Y.applyUpdate(hub.doc, data.subarray(1), socket);
        else if (data[0] === 1) applyAwarenessUpdate(hub.awareness, data.subarray(1), socket);
      };
      socket.onclose = () => {
        const ids = sockets.get(socket);
        sockets.delete(socket);
        if (ids?.size) removeAwarenessStates(hub.awareness, [...ids], 'closed');
      };
      return response;
    }
    if (url.pathname === '/' || url.pathname === '/drawing') {
      return new Response(await Deno.readFile(PAGE), { headers: { 'content-type': 'text/html' } });
    }
    if (url.pathname.startsWith('/vendor/excalidraw/')) {
      const rel = url.pathname.slice('/vendor/excalidraw/'.length);
      if (rel.includes('..')) return new Response('no', { status: 400 });
      try {
        const body = await Deno.readFile(new URL(rel, VENDOR));
        return new Response(body, { headers: { 'content-type': TYPES[rel.split('.').pop()!] ?? 'application/octet-stream' } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    }
    const json = (v: unknown) => new Response(JSON.stringify(v, null, 1), { headers: { 'content-type': 'application/json' } });
    if (req.method === 'POST' && url.pathname === '/api/log') {
      console.log(`page: ${await req.text()}`);
      return new Response('ok');
    }
    if (req.method === 'POST' && url.pathname === '/api/read') return json(drawing_read(hub, await req.json()));
    if (req.method === 'POST' && url.pathname === '/api/edit') return json(drawing_edit(hub, await req.json()));
    if (req.method === 'POST' && url.pathname === '/api/mermaid') return json(await drawing_from_mermaid(hub, await req.json()));
    if (url.pathname === '/api/export') {
      const d = url.searchParams.get('drawing') ?? 'd1';
      return url.searchParams.get('as') === 'svg'
        ? new Response(exportSvg(hub, d), { headers: { 'content-type': 'image/svg+xml' } })
        : new Response(exportJson(hub, d), { headers: { 'content-type': 'application/json' } });
    }
    return new Response('not found', { status: 404 });
  });
}

if (import.meta.main) {
  const i = Deno.args.indexOf('--port');
  const port = i >= 0 ? Number(Deno.args[i + 1]) : 8791;
  if ([8767, 8768, 8777, 8778].includes(port)) throw new Error(`Port ${port} belongs to a live Studio.`);
  startDemo(new DrawingHub(), port);
  console.log(`drawing demo on http://127.0.0.1:${port}/?drawing=d1`);
}
