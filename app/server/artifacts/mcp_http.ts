/**
 * AIB's artifact tool over HTTP: the same `studio_artifact` MCP server as `aib mcp-artifact` (mcp.ts), served by AIB
 * process itself as an MCP Streamable HTTP endpoint (JSON-RPC in a POST body, the reply as application/json, 202 for a
 * notification; no SSE stream, so GET is 405 as the spec allows).
 *
 * Why: a built binary cannot be a stdio MCP server. The `deno desktop` launcher prints "Runtime loaded successfully ..." and
 * "Runtime started" to stdout before our code runs, which corrupts the JSON-RPC stream. So when AIB runs from a built binary it
 * gives agents that advertise `mcpCapabilities.http` this entry instead (ACP McpServerHttp: {type: 'http', name, url, headers}),
 * keeping the stdio entry as the fallback for agents that do not (see artifactMcpEntries). Under `deno run` agents keep getting the
 * stdio entry, exactly as the stdio entry gets them.
 *
 * Access: a listener of its own on 127.0.0.1 (random port), never the page's or the artifact origin's port. Every request must
 *   - come from a loopback address with Host exactly 127.0.0.1:<port> or localhost:<port> (no DNS rebinding),
 *   - carry no Origin and no Sec-Fetch-Site header (so no browser page, whatever its origin, can call it),
 *   - carry X-Studio-Conversation-Id and that conversation's key in X-Studio-Artifact-Key (artifacts/keys.ts, the same key the stdio
 *     tool gets), checked before the body is read.
 * The tool then calls AIB's artifact routes with that key exactly as the stdio tool does, so the web server checks it again.
 *
 * WSL (phase 2 tunnel, wsl/mcp_tunnel.ts): a message from an agent in a distro arrives over the helper channel instead of a socket;
 * `tunneled` answers it with the same key check, size limit and reply as a POST (only the loopback, Host and Origin checks, which are
 * about the TCP request, do not apply).
 */
import * as artifactKeys from './keys.ts';
import { reply, SERVER_NAME, type ToolContext, urlFromFile } from './mcp.ts';
import { toolSignature } from './mcp_tools.ts';
import { isDict, pyJsonDumps, pyStrip } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { serve, type Server as HttpServer } from '../platform/http_serve.ts';
import { keyForForwarder } from '../keeper/client.ts';

const log = getLogger('artifact_mcp_http');

export const KEY_HEADER = 'X-Studio-Artifact-Key';
export const CONVERSATION_HEADER = 'X-Studio-Conversation-Id';
export const MCP_PATH = '/mcp';
/** Largest request body: a publish can carry a whole page as `content`. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Claude Code command hooks (subagent worktrees): POST /hooks/claude/<event>, the chat's hook key in this header. */
export const HOOK_KEY_HEADER = 'X-Studio-Hook-Key';
/** The forwarder's fresh random nonce for this call; AIB's answer carries HOOK_PROOF_HEADER over it (artifacts/keys.ts hookProof). */
export const HOOK_NONCE_HEADER = 'X-Studio-Hook-Nonce';
export const HOOK_PROOF_HEADER = 'X-Studio-Hook-Proof';
/** Through the WSL tunnel a hook says which event it is in this header (keeper/hooksocket.go); the HTTP form has it in the path. */
export const HOOK_EVENT_HEADER = 'X-Studio-Hook-Event';
const HOOK_PATH = /^\/hooks\/claude\/(pre-tool|pre-shell|worktree-create|post-agent|subagent-stop)$/;
/** Codex command hooks (subagents/codex.ts): POST /hooks/codex/<event>, handed on as event `codex-<event>`. */
const CODEX_HOOK_PATH = /^\/hooks\/codex\/(pre-tool|subagent-start|subagent-stop)$/;
/** Gemini CLI's BeforeTool (subagents/gemini.ts): POST /hooks/gemini/before-tool, handed on as event `gemini-before-tool`. */
const GEMINI_HOOK_PATH = /^\/hooks\/gemini\/before-tool$/;
/** Qwen Code command hooks (subagents/qwen.ts): POST /hooks/qwen/<event>, handed on as event `qwen-<event>`. */
const QWEN_HOOK_PATH = /^\/hooks\/qwen\/(pre-tool|subagent-start|subagent-stop)$/;
const MAX_HOOK_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;

/** What the server needs from AIB that runs it. */
export interface McpHttpHost {
  /** The conversation's session folder and whether it works in its own worktree; null for a conversation not open here. */
  conversation(id: string): { cwd: string; worktree: boolean; restricted?: boolean; main?: boolean } | null;
  /** The web server's base URL ('' when unknown). */
  baseUrl(): string;
  /** Path of the URL file the web server rewrites when it restarts on another port (artifact-web.json). */
  urlFile: string;
  /** Key check; default artifacts/keys.ts check. */
  check?(key: string, conversationId: string): boolean;
  /**
   * Where to publish this server's URL for the keeper's MCP forwarder (`AIB-keeper mcp-forward <file>`, design 3.7): written when
   * the server starts, removed when it closes. Agents in the keeper reach the tool through the forwarder, so the tool answers from
   * whichever AIB runs now (after a restart or an update, on another port).
   */
  addressFile?: string;
  /** A tools/list answered a chat these tool names (artifacts/served.ts keeps them per chat); absent: not recorded. */
  servedTools?(conversation: string, names: string[]): void;
  /** A Claude chat's command hook (key already checked for `conversation`); absent: the hook routes answer 503. */
  hook?(event: string, conversation: string, body: unknown): Promise<{ status: number; body: string; type: string }>;
}

/** The address file's name in the state folder (FORWARD_FILE): {"url": ..., "pid": ...}. */
export const FORWARD_FILE = 'artifact-mcp.json';
/** Address files this process publishes: an `mcp-forward <file>` entry naming one of them is AIB's own tool (connection.ts). */
const OWN_FORWARD_FILES = new Set<string>();

/** Register an address file as AIB's own (an AIB that gives agents the forwarder, before its server has started). */
export function ownForwardFile(path: string): void {
  OWN_FORWARD_FILES.add(path);
}

/** Tunnel sockets (in WSL distros) this process gave chats: an `mcp-forward --helper-socket <socket>` entry naming one is AIB's own. */
const OWN_TUNNEL_SOCKETS = new Set<string>();

/**
 * True for a stdio entry `<keeper program> mcp-forward <file>` whose file is one this process publishes, or a WSL chat's
 * `<keeper program> mcp-forward --helper-socket <socket>` whose socket this process handed out (tunnelEntry).
 */
export function isOwnForwardEntry(command: unknown, args: string[]): boolean {
  if (typeof command !== 'string' || args[0] !== 'mcp-forward') return false;
  if (args.length === 3 && args[1] === '--helper-socket') return OWN_TUNNEL_SOCKETS.has(args[2]);
  return args.length === 2 && OWN_FORWARD_FILES.has(args[1]);
}

/**
 * The stdio entry an agent in the keeper gets for the artifact tool: the keeper's forwarder (its program lives outside every AIB
 * version folder), posting to this AIB's HTTP endpoint with the conversation's key, whichever AIB version serves it now.
 * On Windows, with a keeper program that opens them (keeper 1.7.0), the headers are sealed with DPAPI (keyForForwarder): this entry
 * is in the agent's keeper journal and its chat note, which any other agent of this user can read. `program` is the forwarder as
 * this process ran its --check (a WSL chat's entry names the same program by its /mnt/c path).
 */
export function forwardEntry(forwarder: string, addressFile: string, key: string, conversationId: string, program = forwarder): Json {
  const headers = JSON.stringify({ [KEY_HEADER]: key, [CONVERSATION_HEADER]: conversationId });
  return {
    name: SERVER_NAME,
    command: forwarder,
    args: ['mcp-forward', addressFile],
    env: [{ name: 'MCP_FORWARD_HEADERS', value: keyForForwarder(program, 'mcp-forward-headers', headers) }],
  };
}

/**
 * The stdio entry of a WSL chat with the tunnel: the distro's keeper program as forwarder, posting each message to the WSL helper's
 * tunnel socket (wsl/mcp_tunnel.ts), with the conversation's key in its environment (a Linux process; nothing crosses WSL interop).
 */
export function tunnelEntry(forwarder: string, socket: string, key: string, conversationId: string): Json {
  OWN_TUNNEL_SOCKETS.add(socket);
  return {
    name: SERVER_NAME,
    command: forwarder,
    args: ['mcp-forward', '--helper-socket', socket],
    env: [{ name: 'MCP_FORWARD_HEADERS', value: JSON.stringify({ [KEY_HEADER]: key, [CONVERSATION_HEADER]: conversationId }) }],
  };
}

/** A WSL chat taken over from its keeper: its recorded tunnel entry (AIB wrote it) is AIB's own again. */
export function ownTunnelEntry(entry: unknown): void {
  const e = entry as { name?: unknown; args?: unknown };
  const args = Array.isArray(e?.args) ? e.args : [];
  if (e?.name === SERVER_NAME && args.length === 3 && args[0] === 'mcp-forward' && args[1] === '--helper-socket' && typeof args[2] === 'string') {
    OWN_TUNNEL_SOCKETS.add(args[2]);
  }
}

const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
/** Every URL a server in this process serves: an http entry naming one of them is AIB's own (connection.ts). */
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

  constructor(readonly aib: McpHttpHost) {}

  /** Start listening (once) and return the endpoint URL, http://127.0.0.1:<port>/mcp. */
  start(): string {
    if (this.#server) return this.#url;
    this.#server = serve(
      { hostname: '127.0.0.1', port: 0, onListen: () => {} },
      (request, info) => this.handle(request, info),
    );
    this.#url = `http://127.0.0.1:${this.#server.addr.port}${MCP_PATH}`;
    OWN_URLS.add(this.#url);
    const file = this.aib.addressFile;
    if (file) {
      OWN_FORWARD_FILES.add(file);
      try {
        Deno.writeTextFileSync(`${file}.${Deno.pid}.tmp`, JSON.stringify({ url: this.#url, pid: Deno.pid }));
        Deno.renameSync(`${file}.${Deno.pid}.tmp`, file);
      } catch (error) {
        log.warning('Could not publish the artifact tool address in %s: %s', file, error instanceof Error ? error.message : error);
      }
    }
    return this.#url;
  }

  get url(): string {
    return this.#url;
  }

  get port(): number {
    return this.#server?.addr.port ?? 0;
  }

  /**
   * Stop listening and take the published address back (only our own: a newer AIB may have written its address already). `closed`:
   * the person quit AIB while its chats keep running in the keeper; the address file then says {"closed": true}, so the keeper's
   * forwarder answers a tool call at once with "AIB is closed; try again later" instead of waiting for an AIB that is not coming.
   */
  async close(closed = false): Promise<void> {
    const server = this.#server;
    if (!server) return;
    this.#server = null;
    OWN_URLS.delete(this.#url);
    const file = this.aib.addressFile;
    if (file) {
      try {
        if (JSON.parse(Deno.readTextFileSync(file)).pid === Deno.pid) {
          if (!closed) Deno.removeSync(file);
          else {
            Deno.writeTextFileSync(`${file}.${Deno.pid}.tmp`, JSON.stringify({ closed: true, pid: Deno.pid }));
            Deno.renameSync(`${file}.${Deno.pid}.tmp`, file);
          }
        }
      } catch { /* gone */ }
    }
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
    const hook = HOOK_PATH.exec(new URL(request.url).pathname);
    if (hook) return await this.#hook(request, hook[1]);
    const codexHook = CODEX_HOOK_PATH.exec(new URL(request.url).pathname);
    if (codexHook) return await this.#hook(request, `codex-${codexHook[1]}`);
    const qwenHook = QWEN_HOOK_PATH.exec(new URL(request.url).pathname);
    if (qwenHook) return await this.#hook(request, `qwen-${qwenHook[1]}`);
    if (GEMINI_HOOK_PATH.test(new URL(request.url).pathname)) return await this.#hook(request, 'gemini-before-tool');
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
    if (!this.#keyOk(key, conversation)) {
      await drain(request);
      return refused(401, 'AIB refused the artifact key for this conversation');
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
    return await this.#answer(key, conversation, raw);
  }

  /**
   * A Claude chat's command hook, through the keeper's forwarder (`AIB-keeper hook <event> <address file>`; subagents/service.ts).
   * Same listener checks as /mcp (loopback, Host, no Origin, no Sec-Fetch-Site: done by handle), plus the chat's hook key (its own
   * HMAC label, not the artifact key) in X-Studio-Hook-Key, checked before the body is read. Never served by the page's or the phone
   * server: this listener is AIB's loopback-only MCP endpoint.
   */
  async #hook(request: Request, event: string): Promise<Response> {
    let key = '';
    const nonce = request.headers.get(HOOK_NONCE_HEADER) ?? '';
    // every answer after the key check is signed (security review P1, MF 1): the forwarder trusts no other
    const answer = (status: number, text: string, type: string) => {
      const body = new TextEncoder().encode(text);
      const headers: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'no-store' };
      if (key && /^[0-9a-f]{16,128}$/.test(nonce)) headers[HOOK_PROOF_HEADER] = artifactKeys.hookProof(key, nonce, status, body);
      return new Response(body, { status, headers });
    };
    const plain = (status: number, body: string) => answer(status, body, 'text/plain; charset=utf-8');
    if (request.method !== 'POST') {
      await drain(request);
      return plain(405, 'Method not allowed');
    }
    const conversation = request.headers.get(CONVERSATION_HEADER) ?? '';
    if (!artifactKeys.checkHookKey(request.headers.get(HOOK_KEY_HEADER) ?? '', conversation)) {
      await drain(request);
      return plain(401, 'AIB refused the hook key for this conversation');
    }
    key = request.headers.get(HOOK_KEY_HEADER) ?? '';
    if (!this.aib.hook) {
      await drain(request);
      return plain(503, 'AIB has no subagent hooks');
    }
    const raw = await readLimited(request, MAX_HOOK_BYTES);
    if (raw === null) return plain(413, 'Request too large');
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return plain(400, 'The hook input is not JSON');
    }
    const result = await this.aib.hook(event, conversation, body);
    return answer(result.status, result.body, result.type);
  }

  #keyOk(key: string, conversation: string): boolean {
    const check = this.aib.check ?? artifactKeys.check;
    return !!key && !!conversation && check(key, conversation);
  }

  /**
   * A message that came through the WSL tunnel (wsl/mcp_tunnel.ts): the same key check, size limit and reply as a POST, as an
   * HTTP-like status and body.
   */
  async tunneled(key: string, conversation: string, body: string): Promise<{ status: number; body: string }> {
    let response: Response;
    if (!this.#keyOk(key, conversation)) response = refused(401, 'AIB refused the artifact key for this conversation');
    else {
      const raw = new TextEncoder().encode(body);
      response = raw.length > MAX_BODY_BYTES ? refused(413, 'Request too large') : await this.#answer(key, conversation, raw);
    }
    return { status: response.status, body: response.status === 202 ? '' : await response.text() };
  }

  /** The reply to a checked request's body. */
  async #answer(key: string, conversation: string, raw: Uint8Array): Promise<Response> {
    // Decoded as the stdio server decodes a line (replacement characters, a BOM kept), so the same bytes get the same reply.
    const text = pyStrip(new TextDecoder('utf-8', { ignoreBOM: true }).decode(raw));
    if (!text) return refused(400, 'Empty request');
    const open = this.aib.conversation(conversation);
    const aib = this.aib;
    const ctx: ToolContext = {
      key,
      conversation,
      worktree: !!open?.worktree,
      restricted: !!open?.restricted, // a WSL chat: the tool groups of mcp.ts WSL_TOOL_GROUPS
      main: !!open?.main, // swarm helper tools (a WSL chat: only while mcp.ts WSL_TOOL_GROUPS.swarm is on)
      cwd: open && !open.restricted ? open.cwd : null,
      roots: () => [aib.baseUrl(), urlFromFile(aib.urlFile)],
    };
    let answer: Json | null;
    try {
      answer = await reply(text, ctx);
    } catch (error) { // reply never throws; a bug here must not take AIB down
      log.exception(error, 'The HTTP artifact tool failed');
      return refused(500, 'Internal error');
    }
    if (answer === null) return new Response(null, { status: 202 }); // a notification or a response
    this.#recordServed(conversation, text, answer);
    return json(200, answer);
  }

  /** A tools/list reply: tell AIB which tool names this chat was just served (never fails the call). */
  #recordServed(conversation: string, text: string, answer: Json): void {
    if (!this.aib.servedTools || !text.includes('tools/list')) return;
    try {
      const result = answer.result;
      const message = JSON.parse(text);
      if (!isDict(result) || !Array.isArray(result.tools) || !isDict(message) || message.method !== 'tools/list') return;
      this.aib.servedTools(conversation, result.tools.map((t) => (isDict(t) ? toolSignature(t) : '')));
    } catch (error) {
      log.exception(error, 'Recording the served tools failed');
    }
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
