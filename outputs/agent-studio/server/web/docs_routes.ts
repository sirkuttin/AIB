/**
 * The local docs' routes (spike; Deno only: routes.ts DENO_ONLY). A doc belongs to a project: the folder is always the one Studio
 * knows for the chat (files_routes.rootFor, the main checkout for a worktree chat), never a folder named in the request.
 *
 *   POST /api/live/docs/open {id, name}             the page opens (or creates) a doc: {doc, name, file, rev}. Page token.
 *   GET  /api/live/docs/socket?doc=<doc>            the editor's WebSocket (y-protocols sync + awareness, binary). A browser cannot
 *                                                   set headers on a WebSocket, so the page offers two subprotocols, `aib-docs` and
 *                                                   `aib-token.<page token>`, as the terminal does. The doc must be open already.
 *   POST /api/live/docs/tool {conversationId, tool, args}  an agent's doc_read / doc_changes / doc_edit (mcp.ts), with the
 *                                                   conversation's artifact key (own gate, like /api/live/artifacts/publish).
 *                                                   200 {ok, result}: a refusal is ok=false with Claude Docs' code.
 */
import { authorize, Refusal, TOKEN_HEADER } from './security.ts';
import { ROUTES } from './routes.ts';
import { upgradeWebSocket, wantsWebSocket } from '../platform/websocket.ts';
import { rootFor } from './files_routes.ts';
import { runDocTool } from '../docs/tools.ts';
import { DocRefusal } from '../docs/live_doc.ts';
import { TOKEN_PROTOCOL_PREFIX } from './terminal_routes.ts';
import type { WebContext } from './server.ts';

export const DOCS_SOCKET = '/api/live/docs/socket';
export const DOCS_PROTOCOL = 'aib-docs';
export const DOCS_TOOL = '/api/live/docs/tool';

type Json = Record<string, unknown>;
type Reply = [number, unknown];

export function docsRoutes(): Map<string, (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply>> {
  const routes = new Map<string, (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply>>();
  routes.set('POST /api/live/docs/open', async (ctx, _url, body) => {
    const root = await rootFor(ctx, { id: [String(body?.id ?? '')], root: ['main'] });
    if (typeof root !== 'string') return root;
    try {
      const doc = await ctx.docs.open(root, body?.name);
      return [200, { ok: true, doc: doc.id, name: doc.name, file: doc.mirrorPath, rev: doc.live.rev }];
    } catch (error) {
      if (error instanceof DocRefusal) return [400, { error: error.message, code: error.code }];
      throw error;
    }
  });
  return routes;
}

/** POST /api/live/docs/tool, after the own gate checked the conversation's key against the body's conversationId. */
export async function docsTool(ctx: WebContext, body: Json): Promise<Reply> {
  const conversation = String(body.conversationId ?? '');
  const chat = ctx.artifacts.chatOf(conversation);
  const root = await rootFor(ctx, { id: [chat], root: ['main'] });
  if (typeof root !== 'string') return root;
  const tool = typeof body.tool === 'string' ? body.tool : '';
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args as Json : {};
  const agent = chat.includes(':') ? chat.slice(0, chat.indexOf(':')) : 'agent';
  const [ok, result] = await runDocTool(ctx.docs, root, agent, tool, args);
  return [200, { ok, result }];
}

function offered(request: Request): string[] {
  return (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

/** GET /api/live/docs/socket. Refusals happen before the upgrade, so a page that is not ours never gets a socket. */
export function docsSocket(ctx: WebContext, request: Request, url: URL): { refused: Reply } | { response: Response } {
  const protocols = offered(request);
  const token = protocols.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length) ?? '';
  const headers = new Headers(request.headers);
  headers.delete(TOKEN_HEADER);
  if (token) headers.set(TOKEN_HEADER, token);
  const allowed = authorize({ method: 'GET', path: DOCS_SOCKET, headers }, ctx.gate, ROUTES.scopeFor('GET', DOCS_SOCKET));
  if (allowed instanceof Refusal) return { refused: [allowed.status, { error: allowed.message(DOCS_SOCKET) }] };
  if (request.headers.get('Origin') === null) return { refused: [403, { error: 'Request must come from the AIB page' }] };
  if (!wantsWebSocket(request) || !protocols.includes(DOCS_PROTOCOL)) {
    return { refused: [400, { error: 'This address only takes a doc WebSocket.' }] };
  }
  const doc = ctx.docs.get(url.searchParams.get('doc') ?? '');
  if (!doc) return { refused: [404, { error: 'Open the doc first', code: 'doc_not_open' }] };
  const { link, response } = upgradeWebSocket(request, DOCS_PROTOCOL);
  doc.live.attach(link);
  return { response };
}
