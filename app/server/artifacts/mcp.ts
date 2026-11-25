/**
 * AIB's artifact tool (artifact_mcp.py): the `studio_artifact` stdio MCP server that lets an agent show the user a page.
 * Run as `aib mcp-artifact` (main.ts mcp-artifact). AIB adds it to every session. Environment:
 *   STUDIO_ARTIFACT_URL        AIB base URL, e.g. http://127.0.0.1:8767 (may be empty; see STUDIO_ARTIFACT_URL_FILE)
 *   STUDIO_ARTIFACT_URL_FILE   optional JSON file {"url": ...} that AIB rewrites when it restarts on another port
 *   STUDIO_ARTIFACT_KEY        per-conversation key sent as X-Studio-Artifact-Key
 *   STUDIO_CONVERSATION_ID     AIB conversation this agent belongs to
 *   STUDIO_WORKTREE            '1': also offer the worktree merge tools
 *   STUDIO_MAIN                '1': also offer the swarm tools (a main chat; the route checks the role again on every call)
 * JSON-RPC 2.0 over stdin/stdout, one JSON message per line, with fixed reply bytes.
 *
 * HTTP goes over a plain socket to the loopback URL only: never through a proxy (the key is for this machine only) and never
 * following a redirect (it would carry the key header to wherever it points).
 */
import { APP_VERSION, selfCommand } from '../core/app.ts';
import { isDict, pyJsonDumps, pyStr, pyStrip } from '../core/py.ts';
import { pyTypeName, truthy } from '../transcripts/pycompat.ts';
import { expandUser, isAbsolute, isFile, pathStr } from '../platform/pypath.ts';
import { join, normpath } from '../platform/ospath.ts';
import { DOC_TOOL_NAMES, DOCS_RULE } from '../docs/tool_defs.ts';
import { DRAWING_TOOL_NAMES } from '../docs/drawing/tool_defs.ts';
import {
  CallRefused,
  checkCall,
  checkPublish,
  consolidatedTools,
  EDIT_HELP,
  helpText,
  KINDS,
  legacyCall,
  toolSignature,
  OFFLINE_LIBS_NOTE,
  toolPlan,
  WSL_PATH_NOTE,
} from './mcp_tools.ts';
import { newNames } from './tool_ref.ts';
import { openText } from '../state/sealed.ts';

type Json = Record<string, unknown>;

export const SERVER_NAME = 'studio_artifact';
export const SERVER_VERSION = APP_VERSION;
export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const HTTP_TIMEOUT_MS = 60_000;

export const INSTRUCTIONS = "These are AIB's own tools, for the app the user is chatting in. " + DOCS_RULE + ' Use `publish` to show the ' +
  "user an HTML page, diagram, chart, image or one-off report in AIB's Artifacts panel; not for source code. When you mention an " +
  'artifact in a reply, write it as a Markdown link [Title](studio-artifact://<id>).';

/** The old tool names (30 tools) that still answer as hidden aliases: the helper tools. See mcp_tools.ts TODO(remove aliases). */
const SWARM_NAMES = ['helper_providers', 'start_helper', 'helper_status', 'stop_helper', 'merge_helper'];

export { KINDS, OFFLINE_LIBS_NOTE, WSL_PATH_NOTE };

const env = (name: string) => Deno.env.get(name) ?? '';

/**
 * Who is calling and where AIB is. The stdio server reads it from its environment (envContext); the HTTP server
 * (mcp_http.ts) builds it from the verified request headers and AIB that serves it.
 */
export interface ToolContext {
  /** The per-conversation key sent as X-Studio-Artifact-Key. */
  key: string;
  conversation: string;
  /** Offer the worktree merge tools. */
  worktree: boolean;
  /**
   * A chat in a WSL project (docs/wsl/design.md sections 4 and 11): only the tool groups WSL_TOOL_GROUPS switches on, and a publish
   * `path` is passed on as given (a Linux path: the route reads it through the distro's helper, wsl/artifact_read.ts). Today: the artifact tools, the doc and drawing tools (the docs' files
   * are read and written by the distro's helper), and the merge tools when it works in its own worktree (the merge runs in the
   * distro's helper); no swarm tools.
   */
  restricted?: boolean;
  /** Swarm: a main chat, offered the helper tools. */
  main?: boolean;
  /** The session folder relative paths are resolved against, or null when unknown (relative paths are then refused). */
  cwd: string | null;
  /** AIB base URLs to try, in order; each is passed through loopbackUrl before use. */
  roots(): string[];
}

/** The stdio server's context: the STUDIO_* environment variables and this process's folder. */
export function envContext(): ToolContext {
  return {
    key: openText('artifact-key', env('STUDIO_ARTIFACT_KEY')) ?? '', // aib.ts seals it on Windows (state/sealed.ts)
    conversation: env('STUDIO_CONVERSATION_ID'),
    worktree: Deno.env.get('STUDIO_WORKTREE') === '1',
    main: Deno.env.get('STUDIO_MAIN') === '1',
    cwd: Deno.cwd(),
    roots: () => [baseUrl(), urlFromFile(env('STUDIO_ARTIFACT_URL_FILE'))],
  };
}

/** A failure to report to the agent as an MCP tool error (isError), not a protocol error. */
export class ToolError extends Error {}

/** An exception with this type name (shown as "Artifact tool failed: <Type>: <message>"). */
class PyError extends Error {
  constructor(readonly pyType: string, message: string) {
    super(message);
  }
}

function pyGet(value: unknown, key: string): unknown {
  if (!isDict(value)) throw new PyError('AttributeError', `'${pyTypeName(value)}' object has no attribute 'get'`);
  return Object.hasOwn(value, key) ? value[key] : null;
}

/** str(value) for a non-str truthy value used as `str(value or '')`. */
function loose(value: unknown): string {
  return truthy(value) ? pyStr(value) : '';
}

const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})$/;

/**
 * The URL when it is exactly http://127.0.0.1:<port> or http://localhost:<port> (no path, userinfo or other host); else ''.
 * The artifact key travels in a header, so it must never be sent anywhere but this machine's AIB.
 */
export function loopbackUrl(value: unknown): string {
  let text = pyStrip(loose(value));
  while (text.endsWith('/')) text = text.slice(0, -1);
  const match = LOOPBACK_URL.exec(text);
  return match && Number(match[1]) > 0 && Number(match[1]) < 65536 ? text : '';
}

function baseUrl(): string {
  return loopbackUrl(env('STUDIO_ARTIFACT_URL'));
}

/** The loopback URL in AIB's URL file ({"url": ...}), or ''. */
export function urlFromFile(file: string): string {
  const path = pyStrip(file);
  if (!path) return '';
  try {
    const data = JSON.parse(Deno.readTextFileSync(path));
    if (!isDict(data)) return '';
    return loopbackUrl(data.url);
  } catch {
    return '';
  }
}

/** Absolute path for a path argument; relative paths are relative to the session folder (this process's cwd). */
function resolvePath(ctx: ToolContext, value: unknown): string {
  if (typeof value !== 'string' || !pyStrip(value)) throw new ToolError('`path` must be a non-empty string');
  let path = pathStr(expandUser(pyStrip(value)));
  if (!isAbsolute(path)) {
    if (ctx.cwd === null) throw new ToolError('Give an absolute `path`: the session folder of this conversation is not known');
    path = pathStr(join(ctx.cwd, path));
  }
  path = pathStr(normpath(path));
  if (!isFile(path)) throw new ToolError(`File not found: ${path}`);
  return path;
}

/** urllib.parse.urlencode for str values (quote_plus: letters, digits and _.-~ stay, space becomes +). */
function urlencode(query: Record<string, string>): string {
  const quote = (text: string) =>
    [...new TextEncoder().encode(text)].map((b) => {
      const c = String.fromCharCode(b);
      if (/[A-Za-z0-9_.\-~]/.test(c)) return c;
      return b === 0x20 ? '+' : '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }).join('');
  return Object.entries(query).map(([k, v]) => quote(k) + '=' + quote(v)).join('&');
}

/** The text for an OSError from a socket: "[WinError N] message" (Windows) or "[Errno N] message". */
function socketReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const found = /^(.*?)\.? \(os error (\d+)\)$/s.exec(text);
  if (!found) return text;
  return Deno.build.os === 'windows' ? `[WinError ${found[2]}] ${found[1]}` : `[Errno ${found[2]}] ${found[1]}`;
}

/** A connection-level failure, with its reason text. */
export class NetError extends Error {}

export interface RawResponse {
  status: number;
  reason: string;
  body: Uint8Array;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function dechunk(data: Uint8Array): Uint8Array {
  const parts: Uint8Array[] = [];
  let at = 0;
  const latin = new TextDecoder('latin1');
  while (at < data.length) {
    let end = at;
    while (end + 1 < data.length && !(data[end] === 13 && data[end + 1] === 10)) end++;
    const size = parseInt(latin.decode(data.subarray(at, end)).split(';')[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(data.subarray(end + 2, end + 2 + size));
    at = end + 2 + size + 2;
  }
  return concat(parts);
}

/** One HTTP/1.1 request over a plain TCP connection to a loopback URL (Connection: close; the whole reply is read). */
export async function rawRequest(
  root: string,
  method: string,
  path: string,
  headers: Record<string, string>,
  body: Uint8Array | null,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<RawResponse> {
  const match = /^http:\/\/([^:/]+):(\d+)$/.exec(root)!;
  const hostname = match[1], port = Number(match[2]);
  let conn: Deno.TcpConn;
  try {
    conn = await Deno.connect({ hostname, port });
  } catch (error) {
    throw new NetError(socketReason(error));
  }
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      try {
        conn.close();
      } catch { /* closed */ }
    }, timeoutMs);
  };
  const chunks: Uint8Array[] = [];
  try {
    arm();
    const head = `${method} ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n` +
      Object.entries({ ...headers, ...(body ? { 'Content-Length': String(body.length) } : {}), Connection: 'close' })
        .map(([k, v]) => `${k}: ${v}\r\n`).join('') +
      '\r\n';
    const out = concat([new TextEncoder().encode(head), body ?? new Uint8Array(0)]);
    for (let at = 0; at < out.length;) at += await conn.write(out.subarray(at));
    const buffer = new Uint8Array(65536);
    while (true) {
      arm();
      const n = await conn.read(buffer);
      if (n === null) break;
      chunks.push(buffer.slice(0, n));
    }
  } catch (error) {
    if (timedOut) throw new NetError('timed out');
    // A peer that hangs up at once: http.client sends, then finds no status line (RemoteDisconnected). The socket here can see the
    // reset first (WSAECONNABORTED / WSAECONNRESET), which says the same thing.
    const hungUp = error instanceof Deno.errors.ConnectionAborted || error instanceof Deno.errors.ConnectionReset ||
      error instanceof Deno.errors.BrokenPipe;
    if (hungUp && !chunks.length) throw new NetError('Remote end closed connection without response');
    throw new NetError(socketReason(error));
  } finally {
    clearTimeout(timer);
    try {
      conn.close();
    } catch { /* closed */ }
  }
  const data = concat(chunks);
  if (!data.length) throw new NetError('Remote end closed connection without response'); // http.client.RemoteDisconnected
  let split = -1;
  for (let i = 0; i + 3 < data.length; i++) {
    if (data[i] === 13 && data[i + 1] === 10 && data[i + 2] === 13 && data[i + 3] === 10) {
      split = i;
      break;
    }
  }
  const headText = new TextDecoder('latin1').decode(split < 0 ? data : data.subarray(0, split));
  const lines = headText.split('\r\n');
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/.exec(lines[0]);
  if (!status) throw new NetError(`Remote end closed connection without response`);
  let payload = split < 0 ? new Uint8Array(0) : data.subarray(split + 4);
  const fields = new Map(lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
  if ((fields.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) payload = dechunk(payload);
  else if (fields.has('content-length')) payload = payload.subarray(0, Number(fields.get('content-length')));
  return { status: Number(status[1]), reason: status[2] ?? '', body: payload } as RawResponse;
}

/** soft: an HTTP error that carries AIB's own reason (not a refused key) comes back as {error, status}, not as a ToolError. */
async function http(
  ctx: ToolContext,
  method: string,
  route: string,
  query: Record<string, string> | null = null,
  body: unknown = null,
  soft = false,
) {
  const key = ctx.key;
  const conversation = ctx.conversation;
  if (!key || !conversation) {
    throw new ToolError('The artifact tool is not configured for this conversation (missing key or conversation id).');
  }
  let last = '';
  const roots: string[] = [];
  for (const root of ctx.roots().map(loopbackUrl)) { // the file wins on retry: AIB may have restarted on another port
    if (root && !roots.includes(root)) roots.push(root);
  }
  if (!roots.length) throw new ToolError('AIB did not tell the artifact tool where it is running.');
  for (const root of roots.slice(0, 2)) {
    const path = route + (query ? '?' + urlencode(query) : '');
    const data = body !== null ? new TextEncoder().encode(pyJsonDumps(body)) : null;
    const headers: Record<string, string> = {
      'Accept-Encoding': 'identity',
      'User-Agent': `AIB-artifact-tool/${SERVER_VERSION}`,
      'X-Studio-Artifact-Key': key,
      Accept: 'application/json',
      ...(data !== null ? { 'Content-Type': 'application/json' } : {}),
    };
    let response: RawResponse;
    try {
      response = await rawRequest(root, method, path, headers, data);
    } catch (error) {
      if (!(error instanceof NetError)) throw error;
      last = error.message;
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      let message: unknown = null;
      let target: unknown = null; // the merge tool's target branch, named in its refusal
      try {
        const parsed = JSON.parse(new TextDecoder().decode(response.body));
        message = isDict(parsed) ? (Object.hasOwn(parsed, 'error') ? parsed.error : null) : null;
        target = isDict(parsed) && typeof parsed.target === 'string' ? parsed.target : null;
      } catch {
        message = null;
      }
      if (response.status === 401 || response.status === 403) {
        message = truthy(message) ? message : 'AIB refused the artifact key for this conversation';
      } else if (soft && truthy(message)) {
        return { error: message, status: response.status, ...(target ? { target } : {}) } as Json;
      }
      throw new ToolError(`AIB returned ${response.status}: ${pyStr(truthy(message) ? message : response.reason)}`);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.body)) as unknown;
    } catch {
      throw new ToolError('AIB returned a reply that is not JSON');
    }
  }
  throw new ToolError(`Could not reach AIB (${last}). It may be restarting; try again in a moment.`);
}

function textResult(sentence: string, data: unknown): Json {
  return { content: [{ type: 'text', text: sentence + '\n' + pyJsonDumps(data, false) }] };
}

function sourceArgs(ctx: ToolContext, args: Json): Json {
  const path = Object.hasOwn(args, 'path') ? args.path : null;
  const content = Object.hasOwn(args, 'content') ? args.content : null;
  const hasPath = path !== null && path !== '', hasContent = content !== null;
  if (hasPath && hasContent) throw new ToolError('Give either `path` or `content`, not both');
  if (!(hasPath || hasContent)) throw new ToolError('Give either `path` (a file) or `content` (the text to publish)');
  if (hasPath && ctx.restricted) { // a WSL chat: the path is a Linux one, read and checked in the distro (wsl/artifact_read.ts)
    if (typeof path !== 'string' || !pyStrip(path)) throw new ToolError('`path` must be a non-empty string');
    return { path: pyStrip(path) };
  }
  if (hasPath) return { path: resolvePath(ctx, path) };
  if (typeof content !== 'string') throw new ToolError('`content` must be a string');
  return { content };
}

function optionalString(args: Json, name: string): string | null {
  const value = Object.hasOwn(args, name) ? args[name] : null;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new ToolError(`\`${name}\` must be a string`);
  return value;
}

const pick = (item: unknown, keys: string[]) => Object.fromEntries(keys.map((k) => [k, pyGet(item, k)]));

async function toolPublish(ctx: ToolContext, args: Json): Promise<Json> {
  const title = optionalString(args, 'title');
  if (!title || !pyStrip(title)) throw new ToolError('`title` is required');
  const body: Json = { conversationId: ctx.conversation, title: pyStrip(title), ...sourceArgs(ctx, args) };
  const filename = optionalString(args, 'filename');
  if (filename) body.filename = filename;
  const kind = optionalString(args, 'kind');
  if (kind) {
    if (!KINDS.includes(kind)) throw new ToolError('`kind` must be one of: ' + KINDS.join(', '));
    body.kind = kind;
  }
  if (isDict(args.fromDoc)) body.fromDoc = args.fromDoc;
  const item = await http(ctx, 'POST', '/api/live/artifacts/publish', null, body);
  const out = pick(item, ['id', 'version', 'link', 'url']);
  const name = truthy(pyGet(item, 'title')) ? pyGet(item, 'title') : title;
  return textResult(
    `Published "${pyStr(name)}" as artifact ${pyStr(out.id)} (v${pyStr(out.version)}). Mention it in your reply as [${pyStr(name)}](${
      pyStr(out.link)
    }).`,
    out,
  );
}

async function toolUpdate(ctx: ToolContext, args: Json): Promise<Json> {
  const identifier = optionalString(args, 'id');
  if (!identifier) throw new ToolError('`id` is required (from `publish` or `list`)');
  const body: Json = { conversationId: ctx.conversation, id: identifier, ...sourceArgs(ctx, args) };
  const note = optionalString(args, 'note');
  if (note) body.note = note;
  if (isDict(args.fromDoc)) body.fromDoc = args.fromDoc;
  const item = await http(ctx, 'POST', '/api/live/artifacts/publish', null, body);
  const out = pick(item, ['id', 'version', 'link']);
  const title = pyGet(item, 'title');
  return textResult(`Updated "${pyStr(truthy(title) ? title : identifier)}" (artifact ${pyStr(out.id)}), now v${pyStr(out.version)}.`, out);
}

/** Iteration of `reply.get('artifacts') or []`: a list's items, a str's characters, a dict's keys; a number raises. */
function iterate(value: unknown): unknown[] {
  if (!truthy(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PyError('TypeError', `'${pyTypeName(value)}' object is not iterable`);
}

async function toolList(ctx: ToolContext, _args: Json): Promise<Json> {
  const reply = await http(ctx, 'GET', '/api/live/artifacts', { conversationId: ctx.conversation });
  // archived ones carry archived: true (Deno only; the key stays out otherwise, so the reply stays as before)
  const items = iterate(pyGet(reply, 'artifacts')).filter(isDict).map((a) => ({
    ...pick(a, ['id', 'title', 'kind', 'version', 'link']),
    ...(a.archivedAt !== undefined && a.archivedAt !== null ? { archived: true } : {}),
  }));
  return textResult(items.length ? `${items.length} artifact(s) in this conversation.` : 'No artifacts in this conversation yet.', items);
}

/** Deno only: archive or unarchive this chat's artifacts (the server refuses another chat's, and deleted ones). */
async function toolArchive(ctx: ToolContext, args: Json): Promise<Json> {
  const ids = Object.hasOwn(args, 'ids') ? args.ids : null;
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id)) {
    throw new ToolError('`ids` must be a list of artifact ids (from `list`)');
  }
  if (ids.length > 100) throw new ToolError('At most 100 ids at a time');
  const archived = Object.hasOwn(args, 'archived') && args.archived !== null ? args.archived : true;
  if (typeof archived !== 'boolean') throw new ToolError('`archived` must be true or false');
  const reply = await http(ctx, 'POST', '/api/live/artifacts/archive', null, { conversationId: ctx.conversation, ids, archived }, true);
  const done = isDict(reply) && Array.isArray(reply.artifacts) ? reply.artifacts.filter(isDict) : [];
  const refused = isDict(reply) && Array.isArray(reply.refused) ? reply.refused.filter(isDict) : [];
  const verb = archived ? 'Archived' : 'Unarchived';
  const out = { [archived ? 'archived' : 'unarchived']: done.map((a) => pick(a, ['id', 'title', 'link'])), refused };
  if (!done.length) {
    const why = refused.length ? refused.map((r) => `${pyStr(r.id)}: ${pyStr(r.error)}`).join('; ') : pyStr(pyGet(reply, 'error'));
    return { content: [{ type: 'text', text: `Nothing ${verb.toLowerCase()}: ${why}` }], isError: true };
  }
  let sentence = `${verb} ${done.length} artifact(s).`;
  const unpinned = isDict(reply) && Array.isArray(reply.unpinned) ? reply.unpinned.length : 0;
  if (unpinned) sentence += ` ${unpinned} of them were pinned and are unpinned now.`;
  if (refused.length) sentence += ` Not ${verb.toLowerCase()}: ${refused.length} (see refused).`;
  return textResult(sentence, out);
}

/** Plain text for the agent: what happened, or the exact reason nothing did. */
async function worktreeCall(ctx: ToolContext, action: string): Promise<Json> {
  const reply = await http(ctx, 'POST', '/api/live/worktree/tool', null, { conversationId: ctx.conversation, action }, true);
  const target = truthy(pyGet(reply, 'target')) ? pyStr(pyGet(reply, 'target')) : '';
  if (truthy(pyGet(reply, 'error'))) {
    const what = action === 'merge' ? (target ? `Not merged into ${target}` : 'Not merged') : 'Not done';
    return { content: [{ type: 'text', text: `${what}: ${pyStr(pyGet(reply, 'error'))}` }], isError: true };
  }
  if (action === 'merge') {
    if (pyGet(reply, 'state') === 'queued') { // build plan 2.3: a chat that works in the project folder is busy; it merges when it pauses
      return { content: [{ type: 'text', text: pyStr(pyGet(reply, 'message')) }] };
    }
    if (pyGet(reply, 'state') === 'conflicts') {
      return {
        content: [{
          type: 'text',
          text: `Not merged${target ? ` into ${target}` : ''} yet. ` + loose(pyGet(reply, 'message')) + ' Then call merge_into_project again.',
        }],
      };
    }
    let text = `${pyStr(pyGet(reply, 'message'))}. Your copy now continues from the new ${pyStr(pyGet(reply, 'base'))}.`;
    const started = truthy(pyGet(reply, 'started')) ? pyStr(pyGet(reply, 'started')) : '';
    if (target && started && started !== target) text += ` This chat started from ${started}; its work landed on ${target}.`;
    const helpers = pyGet(reply, 'helpers');
    if (Array.isArray(helpers) && helpers.length) {
      text += ` Still running, not waited for (AIB cannot tell where they work): ${helpers.map((h) => pyStr(h)).join(', ')}. ` +
        'If one works in your worktree, check that its changes landed as you meant.';
    }
    if (truthy(pyGet(reply, 'guidance'))) text += '\n' + pyStr(pyGet(reply, 'guidance'));
    return { content: [{ type: 'text', text }] };
  }
  const message = pyGet(reply, 'message');
  return { content: [{ type: 'text', text: truthy(message) ? pyStr(message) : 'Done.' }] };
}

function toolResolveClash(ctx: ToolContext, args: Json): Promise<Json> {
  const action = Object.hasOwn(args, 'action') ? args.action : null;
  if (typeof action !== 'string' || !['check', 'keep_mine', 'leave'].includes(action)) {
    throw new ToolError('`action` must be one of: check, keep_mine, leave');
  }
  return worktreeCall(ctx, action);
}

/** A swarm tool: POST /api/live/swarm/tool with this chat's key; AIB checks the caller's role and the caps there. */
async function swarmTool(ctx: ToolContext, name: string, args: Json): Promise<Json> {
  const reply = await http(ctx, 'POST', '/api/live/swarm/tool', null, { conversationId: ctx.conversation, action: name, args }, true);
  if (isDict(reply) && Object.hasOwn(reply, 'status') && Object.hasOwn(reply, 'error')) {
    return { content: [{ type: 'text', text: `Refused: ${pyStr(reply.error)}` }], isError: true };
  }
  const refused = isDict(reply) && reply.ok === false;
  return { content: [{ type: 'text', text: JSON.stringify(reply) }], ...(refused ? { isError: true } : {}) };
}

type Handler = (ctx: ToolContext, args: Json) => Promise<Json>;

/** The doc tools run in AIB (POST /api/live/docs/tool, with this conversation's key); a refusal is the agent's to act on. */
async function docTool(ctx: ToolContext, name: string, args: Json): Promise<Json> {
  const reply = await http(ctx, 'POST', '/api/live/docs/tool', null, { conversationId: ctx.conversation, tool: name, args }, true);
  if (isDict(reply) && Object.hasOwn(reply, 'error') && Object.hasOwn(reply, 'status')) throw new ToolError(`AIB: ${pyStr(reply.error)}`);
  const ok = isDict(reply) && reply.ok !== false;
  const result = isDict(reply) && isDict(reply.result) ? reply.result : reply;
  return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(ok ? {} : { isError: true }) };
}

/**
 * A tool result with the tool names in its words (message, note, error, help) in the new names: the tool was called by its new name,
 * so its caller knows only those. Document content in the result is left alone.
 */
const WORD_FIELDS = new Set(['message', 'note', 'error', 'help']);
function namedForNew(result: Json): Json {
  const content = result.content;
  if (!Array.isArray(content)) return result;
  const fix = (text: string): string => {
    try {
      const data = JSON.parse(text);
      if (!isDict(data)) return text;
      let changed = false;
      for (const [k, v] of Object.entries(data)) {
        if (WORD_FIELDS.has(k) && typeof v === 'string') {
          const n = newNames(v);
          if (n !== v) { data[k] = n; changed = true; }
        }
      }
      return changed ? JSON.stringify(data) : text;
    } catch {
      return result.isError ? newNames(text) : text; // a plain-text refusal
    }
  };
  return { ...result, content: content.map((c) => (isDict(c) && typeof c.text === 'string' ? { ...c, text: fix(c.text) } : c)) };
}

/** The refusals that say the op itself was malformed: the edit rules come back with them (an agent that skipped doc help learns them here). */
const EDIT_GRAMMAR_REFUSALS = new Set(['bad_op', 'missing_guard']);
function withEditHelp(result: Json): Json {
  if (!result.isError) return result;
  try {
    const data = JSON.parse(String((result.content as Json[])[0].text));
    if (isDict(data) && EDIT_GRAMMAR_REFUSALS.has(String(data.code))) {
      return { ...result, content: [{ type: 'text', text: JSON.stringify({ ...data, help: EDIT_HELP }) }] };
    }
  } catch { /* not a JSON refusal */ }
  return result;
}

// ---- the old 30 names: hidden aliases (not listed; answered, gated by the same context as before) -------------------------------
// TODO(remove aliases): see mcp_tools.ts (keep >= 2 releases; remove after 14 days with no chat on the old names).

const LEGACY_HANDLERS: Record<string, Handler> = { publish: toolPublish, update: toolUpdate, list: toolList, archive: toolArchive };
const LEGACY_WORKTREE_HANDLERS: Record<string, Handler> = {
  merge_into_project: (ctx) => worktreeCall(ctx, 'merge'),
  resolve_edit_clash: toolResolveClash,
};
const LEGACY_DOC_HANDLERS: Record<string, Handler> = Object.fromEntries(
  [...DOC_TOOL_NAMES, ...DRAWING_TOOL_NAMES].map((name) => [name, (ctx, args) => docTool(ctx, name, args)]),
);
const LEGACY_UNLANDED_HANDLERS: Record<string, Handler> = { unlanded_work: (ctx, args) => swarmTool(ctx, 'unlanded_work', args) };
const LEGACY_SWARM_HANDLERS: Record<string, Handler> = Object.fromEntries(
  SWARM_NAMES.map((name) => [name, (ctx: ToolContext, args: Json) => swarmTool(ctx, name, args)]),
);

/**
 * The AIB tools of a chat in a WSL project, by group: the one place to switch a group on once its feature works for WSL projects
 * (wsl/access.ts wslToolsNotice words the chat's note from it too). Both ways in reach the same list: the phase 2 tunnel
 * (wsl/mcp_tunnel.ts) and the phase 1 interop entry.
 *   - artifacts: publish and artifacts (list, archive). A `path` is a Linux path inside the chat's or project's folder, read (never
 *     written) through the distro's helper as a snapshot (wsl/artifact_read.ts).
 *   - merge: merge_into_project, for a chat in its own worktree (run in the distro's helper: wsl/merge.ts).
 *   - swarm: the helper actions providers, start, status, stop, merge. On (2026-11-25): a helper of a WSL project works in its own worktree in the distro and lands there (wsl/helpers.ts). Off: helper chats are not made in WSL projects (AIB gives
 *     a WSL chat no main role while this is off). `helper` is still listed there with the work_* actions only: they are not helper
 *     tools, a WSL chat is a main chat for unlanded work.
 *   - docs: doc and drawing. On: the open doc lives in AIB as for a Windows project, its files in the project folder in the
 *     distro, read and written by the helper (docs/doc_fs.ts, wsl/docs.ts); the answers name Linux paths.
 */
export const WSL_TOOL_GROUPS: Readonly<Record<'artifacts' | 'merge' | 'swarm' | 'docs', boolean>> = {
  artifacts: true,
  merge: true,
  swarm: true,
  docs: true,
};

/** The artifact tools a WSL chat gets with the `artifacts` group on (old names). */
export const RESTRICTED_TOOLS: ReadonlySet<string> = new Set(WSL_TOOL_GROUPS.artifacts ? ['publish', 'update', 'list', 'archive'] : []);

/** The old names a context still answers (what it was offered before the consolidation). */
function legacyHandlers(ctx: ToolContext): Record<string, Handler> {
  if (ctx.restricted) {
    const g = WSL_TOOL_GROUPS;
    return {
      ...Object.fromEntries(Object.entries(LEGACY_HANDLERS).filter(([name]) => RESTRICTED_TOOLS.has(name))),
      ...(ctx.worktree && g.merge ? LEGACY_WORKTREE_HANDLERS : {}),
      ...(ctx.main && g.swarm ? LEGACY_SWARM_HANDLERS : {}),
      ...LEGACY_UNLANDED_HANDLERS, // a WSL chat is a main chat for unlanded work
      ...(g.docs ? LEGACY_DOC_HANDLERS : {}),
    };
  }
  return {
    ...LEGACY_HANDLERS,
    ...(ctx.worktree ? LEGACY_WORKTREE_HANDLERS : {}),
    ...(ctx.main ? { ...LEGACY_SWARM_HANDLERS, ...LEGACY_UNLANDED_HANDLERS } : {}),
    ...LEGACY_DOC_HANDLERS,
  };
}

// ---- the six tools: checked per action, then run by the handler they always had ------------------------------------------------

function consolidatedHandlers(ctx: ToolContext): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const { name, actions } of toolPlan(ctx, WSL_TOOL_GROUPS)) {
    if (name === 'publish') {
      out.publish = (c, args) => {
        const checked = checkPublish(args);
        return checked.update ? toolUpdate(c, checked.args) : toolPublish(c, checked.args);
      };
      continue;
    }
    out[name] = async (c, args) => {
      const { action, args: clean } = checkCall(name, actions!, args);
      if (name === 'artifacts') return action === 'list' ? toolList(c, {}) : toolArchive(c, clean);
      if (name === 'merge_into_project') return worktreeCall(c, action);
      if (name === 'doc' && action === 'help') return { content: [{ type: 'text', text: helpText(clean.topic) }] };
      const call = legacyCall(name, action, clean);
      // refusals and notes are written with the old names: a caller of the new names is told the new ones
      if (name === 'helper') return namedForNew(await swarmTool(c, call.tool, call.args));
      const result = await docTool(c, call.tool, call.args);
      return namedForNew(name === 'doc' && action === 'edit' ? withEditHelp(result) : result);
    };
  }
  return out;
}

function handlers(ctx: ToolContext): Record<string, Handler> {
  return { ...legacyHandlers(ctx), ...consolidatedHandlers(ctx) };
}

async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<Json> {
  try {
    return await handlers(ctx)[name](ctx, isDict(args) ? args : {});
  } catch (error) {
    if (error instanceof ToolError || error instanceof CallRefused) return { content: [{ type: 'text', text: error.message }], isError: true };
    // never crash the server on a tool
    const type = error instanceof PyError ? error.pyType : error instanceof Error ? error.name : 'Exception';
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Artifact tool failed: ${type}: ${message}` }], isError: true };
  }
}

/** The tools/list answer for a chat's context (the stdio server, the HTTP server and AIB's stale-chat check all use it). */
export function servedToolList(ctx: Partial<Pick<ToolContext, 'restricted' | 'worktree' | 'main'>>): Json[] {
  return consolidatedTools(ctx, WSL_TOOL_GROUPS);
}

/** The names tools/list would serve a chat now. */
export function toolNames(ctx: Partial<Pick<ToolContext, 'restricted' | 'worktree' | 'main'>>): string[] {
  return servedToolList(ctx).map((t) => String(t.name));
}

/** Each served tool with its action list ("helper:work_diff,work_land,..."): what the served-tools hash is made of (served.ts). */
export function toolSignatures(ctx: Partial<Pick<ToolContext, 'restricted' | 'worktree' | 'main'>>): string[] {
  return servedToolList(ctx).map(toolSignature);
}

/** The response object for a request, or null for notifications and responses. */
export async function handle(message: unknown, ctx: ToolContext = envContext()): Promise<Json | null> {
  if (!isDict(message)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  const method = Object.hasOwn(message, 'method') ? message.method : null;
  if (method === null || !Object.hasOwn(message, 'id')) return null; // notification (notifications/initialized, cancelled, ...) or a response
  const ident = message.id;
  const params = isDict(message.params) ? message.params : {};
  const ok = (result: unknown): Json => ({ jsonrpc: '2.0', id: ident, result });
  const fail = (code: number, text: string): Json => ({ jsonrpc: '2.0', id: ident, error: { code, message: text } });

  if (method === 'initialize') {
    const asked = Object.hasOwn(params, 'protocolVersion') ? params.protocolVersion : null;
    const version = typeof asked === 'string' && SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0];
    return ok({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, title: 'AIB artifacts', version: SERVER_VERSION },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    return ok({ tools: servedToolList(ctx) });
  }
  if (method === 'tools/call') {
    const name = Object.hasOwn(params, 'name') ? params.name : null;
    if (Array.isArray(name) || isDict(name)) throw new PyError('TypeError', `unhashable type: '${pyTypeName(name)}'`);
    if (typeof name !== 'string' || !Object.hasOwn(handlers(ctx), name)) return fail(-32602, `Unknown tool: ${pyStr(name)}`);
    return ok(await callTool(ctx, name, Object.hasOwn(params, 'arguments') ? params.arguments : null));
  }
  return fail(-32601, `Method not found: ${pyStr(method)}`);
}

/** The reply to one message's text (one stdio line, or one HTTP request body), or null when none is due. */
export async function reply(line: string, ctx: ToolContext = envContext()): Promise<Json | null> {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
  }
  try {
    return await handle(message, ctx);
  } catch (error) {
    const ident = isDict(message) && Object.hasOwn(message, 'id') ? message.id : null;
    return {
      jsonrpc: '2.0',
      id: ident,
      error: { code: -32603, message: `Internal error: ${error instanceof Error ? error.message : error}` },
    };
  }
}

function writeAll(data: Uint8Array): void {
  for (let at = 0; at < data.length;) at += Deno.stdout.writeSync(data.subarray(at));
}

/** `aib mcp-artifact`: serve stdin until it closes. Returns the exit code. */
export async function main(): Promise<number> {
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true }); // errors='replace', a BOM kept
  const encoder = new TextEncoder();
  let pending = new Uint8Array(0);
  const serveLine = async (raw: Uint8Array) => {
    const line = pyStrip(decoder.decode(raw));
    if (!line) return;
    const answer = await reply(line);
    if (answer !== null) writeAll(encoder.encode(pyJsonDumps(answer, false) + '\n'));
  };
  for await (const chunk of Deno.stdin.readable) {
    const data = concat([pending, chunk]);
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 10) continue;
      await serveLine(data.subarray(start, i + 1));
      start = i + 1;
    }
    pending = data.slice(start);
  }
  if (pending.length) await serveLine(pending);
  return 0;
}

/** The `studio_artifact` MCP entry's program and arguments: this same code with the mcp-artifact subcommand. */
export function artifactToolCommand(): { command: string; args: string[] } {
  const [command, ...args] = selfCommand();
  return { command, args: [...args, 'mcp-artifact'] };
}

if (import.meta.main) Deno.exit(await main());
