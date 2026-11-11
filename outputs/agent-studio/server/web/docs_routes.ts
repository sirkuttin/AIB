/**
 * The local docs' routes (Deno only: routes.ts DENO_ONLY). A doc belongs to a project: the folder is always the one Studio
 * knows for the chat (files_routes.rootFor, the main checkout for a worktree chat), never a folder named in the request.
 *
 *   POST /api/live/docs/open {id, name, create?}    the page opens a doc (`create`: Markdown, makes a new one): {doc, name, file,
 *                                                   rev, ...info}. Page token.
 *   GET  /api/live/docs/info?id=<chat>&doc=<doc>    what the UI can show about an open doc: rev, skipped file edits (each with the
 *                                                   block as the mirror had it, as the doc has it, as the file wanted it), lossy
 *                                                   blocks, the linked chat, the comment threads (comments.ts ThreadView) with
 *                                                   `commentSeq`, and the history (versions with n, rev, by, at).
 *   POST /api/live/docs/comment/send {doc, thread, chat?}  "Send to agent": the thread becomes a user message queued to the
 *                                                   doc's linked chat (or `chat`), the same queue the composer uses (live op
 *                                                   `queue`). Sending the same thread state twice is one message. Page token.
 *   GET  /api/live/docs/socket?doc=<doc>            the editor's WebSocket (y-protocols sync + awareness, binary). A browser cannot
 *                                                   set headers on a WebSocket, so the page offers two subprotocols, `aib-docs` and
 *                                                   `aib-token.<page token>`, as the terminal does. The doc must be open already.
 *   POST /api/live/docs/tool {conversationId, tool, args}  an agent's doc_* tool (tools.ts, offered by mcp.ts), with the
 *                                                   conversation's artifact key (own gate, like /api/live/artifacts/publish).
 *                                                   200 {ok, result}: a refusal is ok=false with Claude Docs' code.
 */
import { authorize, Refusal, TOKEN_HEADER } from './security.ts';
import { ROUTES } from './routes.ts';
import { upgradeWebSocket, wantsWebSocket } from '../platform/websocket.ts';
import { rootFor } from './files_routes.ts';
import { runDocTool } from '../docs/tools.ts';
import { DocRefusal } from '../docs/live_doc.ts';
import { commentMessage } from '../docs/comments.ts';
import type { OpenDoc } from '../docs/store.ts';
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
      const create = typeof body?.create === 'string' ? body.create : undefined;
      const doc = await ctx.docs.open(root, body?.name, create);
      ctx.docs.link(doc, ctx.artifacts.chatOf(String(body?.id ?? '')), true);
      return [200, { ok: true, ...ctx.docs.info(doc) }];
    } catch (error) {
      if (error instanceof DocRefusal) return [400, { error: error.message, code: error.code }];
      throw error;
    }
  });
  routes.set('GET /api/live/docs/info', (ctx, url) => {
    const doc = ctx.docs.get(url.searchParams.get('doc') ?? '');
    if (!doc) return Promise.resolve([404, { error: 'Open the doc first', code: 'doc_not_open' }] as Reply);
    return Promise.resolve([200, { ok: true, ...ctx.docs.info(doc), history: ctx.docs.history(doc) }] as Reply);
  });
  routes.set('POST /api/live/docs/comment/send', async (ctx, _url, body) => {
    const doc = ctx.docs.get(String(body?.doc ?? ''));
    if (!doc) return [404, { error: 'Open the doc first', code: 'doc_not_open' }];
    const chat = typeof body?.chat === 'string' && body.chat ? body.chat : doc.chat;
    if (!chat) return [409, { error: 'This doc is not linked to a chat yet: choose the chat to send it to.', code: 'no_chat' }];
    return await sendComment(ctx, doc, body?.thread, chat);
  });
  return routes;
}

/**
 * Turn a comment thread into a user message and queue it to a chat (`chat`: its lasting id or a live connection id), exactly as the
 * composer's queue does (live op `queue`, sent at once when the agent is idle). The message id is the thread's state, so a second
 * send of the same state is a duplicate, not a second message. The thread remembers where it was sent.
 */
export async function sendComment(ctx: WebContext, doc: OpenDoc, thread: unknown, chat: string): Promise<Reply> {
  let view;
  try {
    view = doc.live.comments.get(thread);
  } catch (error) {
    if (error instanceof DocRefusal) return [404, { error: error.message, code: error.code }];
    throw error;
  }
  await ctx.artifacts.refresh().catch(() => {});
  const connection = ctx.artifacts.connectionOf(chat);
  if (!connection) return [409, { error: 'That chat is not open: open it, then send again.', code: 'chat_not_open', chat }];
  const text = commentMessage(doc.name, doc.mirrorPath, view);
  const clientMessageId = `doc-comment-${doc.id}-${view.thread}-${view.replies.length}`;
  const [status, payload] = await ctx.host.liveCall('queue', { id: connection, text, clientMessageId });
  if (status !== 200) return [status, payload];
  doc.live.comments.markSent(view.thread, ctx.artifacts.chatOf(connection), doc.live.system);
  return [200, { ...(payload as Json), ok: true, thread: view.thread, chat: ctx.artifacts.chatOf(connection), text }];
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
  const [ok, result] = await runDocTool(ctx.docs, root, agent, tool, args, chat);
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
