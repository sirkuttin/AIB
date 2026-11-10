/**
 * Studio's artifact tool over HTTP: the same `studio_artifact` MCP server as `aib mcp-artifact` (mcp.ts), served by the Studio
 * process itself as an MCP Streamable HTTP endpoint (JSON-RPC in a POST body, the reply as application/json, 202 for a
 * notification; no SSE stream, so GET is 405 as the spec allows).
 *
 * Why: a built binary cannot be a stdio MCP server. The `deno desktop` launcher prints "Runtime loaded successfully ..." and
 * "Runtime started" to stdout before our code runs, which corrupts the JSON-RPC stream. So when Studio runs from a built binary it
 * gives agents that advertise `mcpCapabilities.http` this entry instead (ACP McpServerHttp: {type: 'http', name, url, headers}),
 * keeping the stdio entry as the fallback for agents that do not (see artifactMcpEntries). Under `deno run` agents keep getting the
 * stdio entry, exactly as the Python Studio gives them artifact_mcp.py.
 *
 * Access: a listener of its own on 127.0.0.1 (random port), never the page's or the artifact origin's port. Every request must
 *   - come from a loopback address with Host exactly 127.0.0.1:<port> or localhost:<port> (no DNS rebinding),
 *   - carry no Origin and no Sec-Fetch-Site header (so no browser page, whatever its origin, can call it),
 *   - carry X-Studio-Conversation-Id and that conversation's key in X-Studio-Artifact-Key (artifacts/keys.ts, the same key the stdio
 *     tool gets), checked before the body is read.
 * The tool then calls Studio's artifact routes with that key exactly as the stdio tool does, so the web server checks it again.
 */
import * as artifactKeys from './keys.ts';
import { reply, SERVER_NAME, type ToolContext, urlFromFile } from './mcp.ts';
import { pyJsonDumps, pyStrip } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { serve, type Server as HttpServer } from '../platform/http_serve.ts';

const log = getLogger('artifact_mcp_http');

export const KEY_HEADER = 'X-Studio-Artifact-Key';
export const CONVERSATION_HEADER = 'X-Studio-Conversation-Id';
export const MCP_PATH = '/mcp';
/** Largest request body: a publish can carry a whole page as `content`. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

type Json = Record<string, unknown>;

/** What the server needs from the Studio that runs it. */
export interface McpHttpStudio {
  /** The conversation's session folder and whether it works in its own worktree; null for a conversation not open here. */
  conversation(id: string): { cwd: string; worktree: boolean } | null;
  /** The web server's base URL ('' when unknown). */
  baseUrl(): string;
  /** Path of the URL file the web server rewrites when it restarts on another port (artifact-web.json). */
  urlFile: string;
  /** Key check; default artifacts/keys.ts check. */
  check?(key: string, conversationId: string): boolean;
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Every URL a server in this process serves: an http entry naming one of them is Studio's own (connection.ts). */
const OWN_URLS = new Set<string>();

/** True when url is the endpoint of an HTTP artifact server running in this process. */
export function isOwnMcpUrl(url: unknown): boolean {
  return typeof url === 'string' && OWN_URLS.has(url);
}

function json(status: number, payload: unknown, extra: Record<string, string> = {}): Response {
  return new Response(pyJsonDumps(payload, false), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra },
  });
}

/** A JSON-RPC error with no id, for requests refused before their message is read. */
function refused(status: number, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { jsonrpc: '2.0', id: null, error: { code: -32000, message } }, extra);
}

async function drain(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch { /* nothing to read */ }
}

/** The body, or null when it is larger than limit (stops reading there). */
async function readLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) out.set(c, (at += c.length) - c.length);
  return out;
}

export class ArtifactMcpHttp {
  #server: HttpServer | null = null;
  #url = '';

  constructor(readonly studio: McpHttpStudio) {}

  /** Start listening (once) and return the endpoint URL, http://127.0.0.1:<port>/mcp. */
  start(): string {
    if (this.#server) return this.#url;
    this.#server = serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      (request, info) => this.handle(request, info),
    );
    this.#url = `http://127.0.0.1:${this.#server.addr.port}${MCP_PATH}`;
    OWN_URLS.add(this.#url);
    return this.#url;
  }

  get url(): string {
    return this.#url;
  }

  get port(): number {
    return this.#server?.addr.port ?? 0;
  }

  async close(): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    OWN_URLS.delete(this.#url);
    await Promise.race([server.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
  }

  /** One request. Exported for tests (info.remoteAddr.hostname is all it reads of info). */
  async handle(request: Request, info: { remoteAddr: { hostname: string } }): Promise<Response> {
    const headers = request.headers;
    const port = this.port;
    const fromLoopback = LOOPBACK_PEERS.has(info.remoteAddr.hostname) &&
      [`127.0.0.1:${port}`, `localhost:${port}`].includes(headers.get('host') ?? '');
    if (!fromLoopback || headers.get('origin') !== null || headers.get('sec-fetch-site') !== null) {
      await drain(request);
      return refused(403, 'Forbidden');
    }
    if (new URL(request.url).pathname !== MCP_PATH) {
      await drain(request);
      return refused(404, 'Not found');
    }
    if (request.method !== 'POST') { // no SSE stream and no sessions to end: GET and DELETE are 405 (Streamable HTTP allows it)
      await drain(request);
      return refused(405, 'Method not allowed', { Allow: 'POST' });
    }
    const key = headers.get(KEY_HEADER) ?? '';
    const conversation = headers.get(CONVERSATION_HEADER) ?? '';
    const check = this.studio.check ?? artifactKeys.check;
    if (!key || !conversation || !check(key, conversation)) {
      await drain(request);
      return refused(401, 'Studio refused the artifact key for this conversation');
    }
    if (!/^application\/json\b/i.test(pyStrip(headers.get('content-type') ?? ''))) {
      await drain(request);
      return refused(415, 'Send the JSON-RPC message as application/json');
    }
    const declared = headers.get('content-length');
    if (declared !== null && !(Number(declared) <= MAX_BODY_BYTES)) {
      await drain(request);
      return refused(413, 'Request too large');
    }
    const raw = await readLimited(request, MAX_BODY_BYTES);
    if (raw === null) return refused(413, 'Request too large');
    // Decoded as the stdio server decodes a line (replacement characters, a BOM kept), so the same bytes get the same reply.
    const text = pyStrip(new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw));
    if (!text) return refused(400, 'Empty request');
    const open = this.studio.conversation(conversation);
    const studio = this.studio;
    const ctx: ToolContext = {
      key,
      conversation,
      worktree: !!open?.worktree,
      cwd: open ? open.cwd : null,
      roots: () => [studio.baseUrl(), urlFromFile(studio.urlFile)],
    };
    let answer: Json | null;
    try {
      answer = await reply(text, ctx);
    } catch (error) { // reply never throws; a bug here must not take the Studio down
      log.exception(error, 'The HTTP artifact tool failed');
      return refused(500, 'Internal error');
    }
    if (answer === null) return new Response(null, { status: 202 }); // a notification or a response
    return json(200, answer);
  }
}

/** The ACP McpServerHttp entry for one conversation (headers as ACP name/value pairs). */
export function httpEntry(url: string, key: string, conversationId: string): Json {
  return {
    type: 'http',
    name: SERVER_NAME,
    url,
    headers: [{ name: KEY_HEADER, value: key }, { name: CONVERSATION_HEADER, value: conversationId }],
  };
}
