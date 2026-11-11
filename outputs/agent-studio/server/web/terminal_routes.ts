/**
 * The per-chat terminal's routes (Deno only: routes.ts DENO_ONLY). Same gate as every route (security.ts authorize: loopback Host,
 * this server's Origin, Sec-Fetch-Site same-origin or absent, the page token), so the artifact origin can never reach them.
 *
 *   GET  /api/live/terminal?key=&cwd=&cols=&rows=[&shell=]  WebSocket (scope write). A browser cannot set headers on a WebSocket, so the page
 *                                                   offers two subprotocols: `aib-terminal` and `aib-token.<page token>`; the token is
 *                                                   checked as X-Studio-Token. An Origin header is required (browsers always send one).
 *   GET  /api/live/terminal/list                    {terminals: [TerminalInfo], max} (sessions.ts)
 *   POST /api/live/terminal/end {key}               ends that conversation's shell: {ok, ended}
 */
import { ValueError } from '../core/py.ts';
import { authorize, Refusal, TOKEN_HEADER } from './security.ts';
import { ROUTES } from './routes.ts';
import { upgradeWebSocket, wantsWebSocket } from '../platform/websocket.ts';
import type { WebContext } from './server.ts';

export const TERMINAL_SOCKET = '/api/live/terminal';
export const TERMINAL_PROTOCOL = 'aib-terminal';
export const TOKEN_PROTOCOL_PREFIX = 'aib-token.';

type Json = Record<string, unknown>;
type Reply = [number, unknown];

export function terminalRoutes(): Map<string, (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply> | Reply> {
  const routes = new Map<string, (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply> | Reply>();
  routes.set('GET /api/live/terminal/list', (ctx) => [200, { terminals: ctx.terminals.list(), max: ctx.terminals.max }]);
  routes.set('POST /api/live/terminal/end', async (ctx, _url, body) => {
    const key = body?.key;
    if (typeof key !== 'string' || !key) throw new ValueError('key must be text');
    return [200, { ok: true, ended: await ctx.terminals.end(key) }];
  });
  return routes;
}

/** The subprotocols a client offered. */
function offered(request: Request): string[] {
  return (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * GET /api/live/terminal. Returns the refusal (as [status, body]) or the 101 response. Refusals happen before the upgrade, so a page
 * that is not ours never gets a socket.
 */
export function terminalSocket(ctx: WebContext, request: Request, url: URL): { refused: Reply } | { response: Response } {
  const protocols = offered(request);
  const token = protocols.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length) ?? '';
  const headers = new Headers(request.headers);
  headers.delete(TOKEN_HEADER);
  if (token) headers.set(TOKEN_HEADER, token);
  const allowed = authorize(
    { method: 'GET', path: TERMINAL_SOCKET, headers },
    ctx.gate,
    ROUTES.scopeFor('GET', TERMINAL_SOCKET),
  );
  if (allowed instanceof Refusal) return { refused: [allowed.status, { error: allowed.message(TERMINAL_SOCKET) }] };
  if (request.headers.get('Origin') === null) return { refused: [403, { error: 'Request must come from the AIB page' }] };
  if (!wantsWebSocket(request) || !protocols.includes(TERMINAL_PROTOCOL)) {
    return { refused: [400, { error: 'This address only takes a terminal WebSocket.' }] };
  }
  const { link, response } = upgradeWebSocket(request, TERMINAL_PROTOCOL);
  const q = url.searchParams;
  ctx.terminals.attach(link, q.get('key'), q.get('cwd'), q.get('cols'), q.get('rows'), q.get('shell') ?? '');
  return { response };
}
