/**
 * The `deno desktop` runtime's own serve address. At launch the runtime sets DENO_SERVE_ADDRESS=tcp:127.0.0.1:<random> and, when a
 * server is announced, sends its startup window there (it may do so again later, e.g. after a webview renderer restart). main.ts
 * drops the variable so AIB's servers bind their own ports, which leaves that port dead: a window sent there shows "127.0.0.1
 * refused to connect". So in desktop mode a tiny listener on that port answers every request with a 302 to the same path on our
 * page: a window the runtime sends there lands on AIB.
 */
import { getLogger } from '../core/log.ts';
import { serve, type Server } from '../platform/http_serve.ts';

const log = getLogger('desktop');

/** The TCP port in a DENO_SERVE_ADDRESS value (`tcp:127.0.0.1:1234`, `127.0.0.1:1234`, `tcp:[::1]:1234`), or null. */
export function servePort(value: string | undefined | null): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^(unix|vsock|tunnel):/i.test(text)) return null;
  const m = /:(\d{1,5})$/.exec(text.replace(/^tcp:/i, ''));
  if (!m) return null;
  const port = Number(m[1]);
  return port > 0 && port <= 65535 ? port : null;
}

/** Where a request to the runtime's port goes: the same path and query on our page. */
export function redirectTarget(requestUrl: string, pageUrl: string): string {
  const from = new URL(requestUrl);
  const to = new URL(pageUrl);
  return `${to.origin}${from.pathname}${from.search}`;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Every request: 302 to our page (loopback callers only). */
export function redirectHandler(pageUrl: string) {
  return (request: Request, info: { remoteAddr: { hostname: string } }): Response => {
    if (!LOOPBACK.has(info.remoteAddr.hostname)) return new Response('Forbidden', { status: 403 });
    return new Response(null, {
      status: 302,
      headers: { Location: redirectTarget(request.url, pageUrl), 'Cache-Control': 'no-store' },
    });
  };
}

/** Listen on 127.0.0.1:port and redirect to pageUrl. Null (logged) when the port can't be bound. */
export function startRedirect(port: number, pageUrl: string): Server | null {
  try {
    const server = serve({ hostname: '127.0.0.1', port }, redirectHandler(pageUrl));
    log.info('runtime serve address 127.0.0.1:%s now redirects to %s', port, new URL(pageUrl).origin);
    return server;
  } catch (error) {
    log.warning(
      'runtime serve address 127.0.0.1:%s could not be bound (%s): a window sent there will not reach AIB',
      port,
      (error as Error)?.message ?? error,
    );
    return null;
  }
}
