/**
 * Deno.serve, minus the desktop runtime's window. Every loopback HTTP listener AIB opens (the page server, the artifact origin, the
 * agent host's RPC, the artifact MCP endpoint, the desktop redirect) goes through serve() here.
 *
 * Why: inside a `deno desktop` binary (Deno 2.9.8) every Deno.serve call ends in op_http_notify_serving, which tells the runtime a
 * server is up; the runtime has its own startup-window logic around its DENO_SERVE_ADDRESS port (strings in the runtime: "Server
 * ready after N attempts, navigating to", "Server not ready after 15s, navigating anyway"). main.ts drops DENO_SERVE_ADDRESS so our
 * listeners bind their own ports, so nothing answers on that port, and a window sent there shows "127.0.0.1 refused to connect"
 * (the owner saw it in the app window and in a second window owned by `AIB.exe host`). node:http only notifies when the address
 * override is active, which it is not once the variable is gone, so in a desktop binary the listeners are node:http servers driving
 * the same (Request) => Response handlers and the runtime is never told. Everywhere else (deno run, deno compile, tests) it is
 * Deno.serve as before; AIB_HTTP_IMPL=node runs the node path under deno test.
 *
 * The node path keeps Deno.serve's synchronous contract (callers read `addr.port` at once, and a busy port throws): the port is
 * claimed and released with Deno.listen first (port 0 becomes a concrete free port), then node binds it. A loss of that tiny race
 * is logged, not thrown.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { isDesktopApp } from '../core/app.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('http_serve');

export interface ServeInfo {
  remoteAddr: { hostname: string; port: number; transport: 'tcp' };
}

export type ServeHandler = (request: Request, info: ServeInfo) => Response | Promise<Response>;

export interface ServeOptions {
  hostname?: string;
  port?: number;
  onListen?: (addr: { hostname: string; port: number; transport: 'tcp' }) => void;
  onError?: (error: unknown) => Response | Promise<Response>;
}

export interface Server {
  readonly addr: { hostname: string; port: number; transport: 'tcp' };
  readonly finished: Promise<void>;
  shutdown(): Promise<void>;
}

/** 'node' in a desktop binary, 'deno' elsewhere; AIB_HTTP_IMPL=node|deno overrides it (tests run the node path with it). */
export function implementation(): 'node' | 'deno' {
  let forced: string | undefined;
  try {
    forced = Deno.env.get('AIB_HTTP_IMPL');
  } catch { /* no env access */ }
  if (forced === 'node' || forced === 'deno') return forced;
  return isDesktopApp() ? 'node' : 'deno';
}

export function serve(options: ServeOptions, handler: ServeHandler): Server {
  return implementation() === 'node' ? nodeServe(options, handler) : denoServe(options, handler);
}

function denoServe(options: ServeOptions, handler: ServeHandler): Server {
  const server = Deno.serve(
    {
      hostname: options.hostname ?? '127.0.0.1',
      port: options.port ?? 0,
      onListen: (addr) => options.onListen?.({ hostname: addr.hostname, port: addr.port, transport: 'tcp' }),
      ...(options.onError ? { onError: options.onError } : {}),
    },
    (request, info) => handler(request, info as unknown as ServeInfo),
  );
  return {
    addr: { hostname: server.addr.hostname, port: server.addr.port, transport: 'tcp' },
    finished: server.finished,
    shutdown: () => server.shutdown(),
  };
}

const NO_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Ports this process's node listeners hold or are about to bind (node binds a moment later; a second claim must throw now). */
const claimed = new Set<string>();

const plainAddress = (a: string | undefined): string => (a ?? '').replace(/^::ffff:/i, '');

function nodeServe(options: ServeOptions, handler: ServeHandler): Server {
  const hostname = options.hostname ?? '127.0.0.1';
  // Deno.serve's contract: bind now, throw now. Claim the port (0: any free one) and release it for node to take.
  if (options.port && claimed.has(`${hostname}:${options.port}`)) {
    throw new Deno.errors.AddrInUse(`Address already in use (os error 10048): ${hostname}:${options.port}`);
  }
  const probe = Deno.listen({ hostname, port: options.port ?? 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const key = `${hostname}:${port}`;
  claimed.add(key);
  const addr = { hostname, port, transport: 'tcp' as const };
  const onError = options.onError ?? ((error: unknown) => {
    log.exception(error, 'request handler failed');
    return new Response('Internal Server Error', { status: 500 });
  });

  const server = http.createServer({ requireHostHeader: false }, (req, res) => void answer(req, res)); // the handlers judge Host
  async function answer(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort();
    });
    let response: Response;
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const headers = new Headers();
      for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1]);
      const target = req.url ?? '/';
      const url = /^https?:\/\//i.test(target) ? target : `http://${headers.get('host') || `${hostname}:${port}`}${target}`;
      const hasBody = method !== 'GET' && method !== 'HEAD';
      const request = new Request(url, {
        method,
        headers,
        signal: abort.signal,
        ...(hasBody ? { body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>, duplex: 'half' } : {}),
      } as RequestInit);
      // Deno.serve leaves request.url as sent (`/a/.%2e/x` stays); new Request() would resolve the dot segments. Keep it raw, so
      // handlers that refuse such paths see what they would see under Deno.serve.
      Object.defineProperty(request, 'url', { value: url, enumerable: true });
      const info: ServeInfo = {
        remoteAddr: { hostname: plainAddress(req.socket.remoteAddress), port: req.socket.remotePort ?? 0, transport: 'tcp' },
      };
      try {
        response = await handler(request, info);
      } catch (error) {
        response = await onError(error);
      }
    } catch (error) {
      log.exception(error, 'request could not be read');
      response = new Response('Bad Request', { status: 400 });
    }
    await send(req, res, response);
  }

  let failed = false;
  server.on('error', (error) => {
    if (!server.listening) { // lost the race for the port to another process between the probe and node's bind
      failed = true;
      claimed.delete(key);
      resolveFinished();
    }
    log.error('listener on %s failed: %s', key, (error as Error)?.message ?? error);
  });
  server.on('clientError', (_error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch { /* gone */ }
  });
  let resolveFinished!: () => void;
  const finished = new Promise<void>((resolve) => (resolveFinished = resolve));
  server.on('close', () => {
    claimed.delete(key);
    resolveFinished();
  });
  server.listen({ port, host: hostname }, () => options.onListen?.(addr));
  let closing: Promise<void> | null = null;
  return {
    addr,
    finished,
    shutdown() {
      if (closing) return closing;
      closing = new Promise<void>((resolve) => {
        const close = () => {
          if (failed) {
            resolve();
            return;
          }
          // Deno.serve's shutdown: stop accepting, let requests in flight finish, drop idle keep-alive connections.
          const force = setTimeout(() => server.closeAllConnections(), 2000);
          server.close(() => {
            clearTimeout(force);
            resolve();
          });
          server.closeIdleConnections();
        };
        if (server.listening || failed) close();
        else server.once('listening', close).once('error', () => resolve()); // node binds a moment after serve() returns
      });
      return closing;
    },
  };
}

async function send(req: http.IncomingMessage, res: http.ServerResponse, response: Response): Promise<void> {
  if (res.destroyed) {
    await response.body?.cancel().catch(() => {});
    return;
  }
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) headers['set-cookie'] = cookies;
  const noBody = req.method?.toUpperCase() === 'HEAD' || NO_BODY_STATUS.has(response.status);
  if (noBody || !response.body) {
    if (!noBody && !response.body) headers['content-length'] = '0';
    res.writeHead(response.status, response.statusText || undefined, headers);
    await response.body?.cancel().catch(() => {});
    res.end();
    return;
  }
  const reader = response.body.getReader();
  // Deno.serve sends a body it already has whole (a string, bytes, a file read) with Content-Length, and only a live stream chunked.
  // Read what is ready at once; if that ends the body, send it with its length.
  const ready: Uint8Array[] = [];
  let size = 0;
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  let ended = false;
  try {
    while (size < 16 * 1024 * 1024) {
      const read = reader.read();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const later = new Promise<'later'>((r) => (timer = setTimeout(() => r('later'), 0)));
      const next = await Promise.race([read, later]);
      clearTimeout(timer);
      if (next === 'later') { // still being produced: stream it, starting with this read
        pending = read;
        break;
      }
      if (next.done) {
        ended = true;
        break;
      }
      ready.push(next.value);
      size += next.value.length;
    }
  } catch (error) {
    log.warning('response body failed: %s', (error as Error)?.message ?? error);
    res.destroy();
    return;
  }
  if (ended) {
    if (!('content-length' in headers)) headers['content-length'] = String(size);
    res.writeHead(response.status, response.statusText || undefined, headers);
    for (const chunk of ready) res.write(chunk);
    res.end();
    reader.releaseLock();
    return;
  }
  res.writeHead(response.status, response.statusText || undefined, headers);
  for (const chunk of ready) res.write(chunk);
  try {
    while (true) {
      const { done, value } = await (pending ?? reader.read());
      pending = null;
      if (done) break;
      if (res.destroyed) {
        await reader.cancel().catch(() => {});
        break;
      }
      if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve).once('close', resolve));
    }
  } catch (error) {
    log.warning('response body failed: %s', (error as Error)?.message ?? error);
    res.destroy();
    return;
  } finally {
    reader.releaseLock();
  }
  res.end();
}
