/**
 * Studio's artifact tool (artifact_mcp.py): the `studio_artifact` stdio MCP server that lets an agent show the user a page.
 * Run as `aib mcp-artifact` (main.ts mcp-artifact). Studio adds it to every session. Environment:
 *   STUDIO_ARTIFACT_URL        Studio base URL, e.g. http://127.0.0.1:8767 (may be empty; see STUDIO_ARTIFACT_URL_FILE)
 *   STUDIO_ARTIFACT_URL_FILE   optional JSON file {"url": ...} that Studio rewrites when it restarts on another port
 *   STUDIO_ARTIFACT_KEY        per-conversation key sent as X-Studio-Artifact-Key
 *   STUDIO_CONVERSATION_ID     the Studio conversation this agent belongs to
 *   STUDIO_WORKTREE            '1': also offer the worktree merge tools
 * JSON-RPC 2.0 over stdin/stdout, one JSON message per line, replies byte-identical to the Python server's.
 *
 * HTTP goes over a plain socket to the loopback URL only: never through a proxy (the key is for this machine only) and never
 * following a redirect (it would carry the key header to wherever it points).
 */
import { APP_VERSION, selfCommand } from '../core/app.ts';
import { isDict, pyJsonDumps, pyStr, pyStrip } from '../core/py.ts';
import { pyTypeName, truthy } from '../transcripts/pycompat.ts';
import { expandUser, isAbsolute, isFile, pathStr } from '../platform/pypath.ts';
import { join, normpath } from '../platform/ospath.ts';
import { DOC_TOOL_NAMES, DOC_TOOLS, DOCS_RULE } from '../docs/tool_defs.ts';
import { DRAWING_TOOL_NAMES, DRAWING_TOOLS } from '../docs/drawing/tool_defs.ts';

type Json = Record<string, unknown>;

export const SERVER_NAME = 'studio_artifact';
export const SERVER_VERSION = APP_VERSION;
export const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const KINDS = ['html', 'svg', 'md', 'image', 'pdf', 'csv', 'json', 'text'];
const HTTP_TIMEOUT_MS = 60_000;

export const INSTRUCTIONS = "These are AIB's own tools, for the app the user is chatting in. " + DOCS_RULE + ' Use publish to show the ' +
  "user an HTML page, diagram, chart, image or one-off report in AIB's Artifacts panel; not for source code. When you mention an " +
  'artifact in a reply, write it as a Markdown link [Title](studio-artifact://<id>).';

/**
 * Deno only (the Python reference has no /_lib/): the libraries the artifact origin bundles (libs.ts), appended to publish's
 * description. artifact_mcp_test.ts takes it out before comparing tools/list with Python.
 */
export const OFFLINE_LIBS_NOTE = ' Pages should work offline, and AIB bundles these libraries for charts and diagrams: Mermaid 11, ' +
  'Chart.js 4, Vega 6, Vega-Lite 6 and vega-embed 7. Load them by their usual jsDelivr, unpkg or cdnjs URL (e.g. ' +
  'https://cdn.jsdelivr.net/npm/chart.js@4) or by local path: /_lib/mermaid.min.js, /_lib/mermaid.esm.min.mjs (to import), ' +
  '/_lib/chart.umd.min.js, /_lib/vega.min.js, /_lib/vega-lite.min.js, /_lib/vega-embed.min.js; either way AIB serves its own copy. ' +
  'Any other CDN script (other libraries, plugins, other major versions) does not load offline. In Markdown artifacts a ```mermaid ' +
  'fence is drawn as a diagram.';

export const TOOLS: Json[] = [
  {
    name: 'publish',
    title: 'Publish an artifact',
    description:
      'Show the user an HTML page, diagram (SVG), image, PDF, CSV, JSON, or a one-off Markdown report in the Artifacts panel next to the chat: ' +
      'something to look at or click through. Do NOT use it when the user asks for a doc or a document, or for a plan, spec, notes, checklist ' +
      'or anything the user will want to edit or keep in the project: make an AIB doc with doc_create. If the page shows content from a doc (a timeline of its Rollout page, a chart of its table), pass ' +
      '"fromDoc": {"doc": "<name>", "page": "<page>"} so the user can rebuild it when the doc changes. Do NOT use it for source code or files the user ' +
      'only needs on disk. Give either `path` (an existing file; relative paths are resolved against the session folder) or `content` (the text itself, with ' +
      '`filename` such as "report.html" so AIB knows the kind). HTML pages are shown sandboxed: scripts from cdnjs.cloudflare.com, cdn.jsdelivr.net and ' +
      'unpkg.com are allowed, but the page cannot make network requests, so embed its data inline. To change a page you already published, call `update` with its id ' +
      'instead of publishing a new one. After publishing, mention it in your reply as a Markdown link: [Title](studio-artifact://<id>).' +
      OFFLINE_LIBS_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short human title shown in the Artifacts picker, e.g. "Drop rates by tier".' },
        path: {
          type: 'string',
          description:
            'Path of an existing file to publish (absolute, or relative to the session folder). Give this or `content`, not both.',
        },
        content: {
          type: 'string',
          description: 'The file text to publish (HTML, SVG, Markdown, CSV, JSON, ...). Give this or `path`, not both.',
        },
        filename: {
          type: 'string',
          description: 'With `content`: the file name including extension, e.g. "chart.html". Decides the kind when `kind` is omitted.',
        },
        kind: { type: 'string', enum: KINDS, description: 'Optional. Derived from the file extension when omitted.' },
        fromDoc: {
          type: 'object',
          description: 'Optional. The doc page this artifact shows, e.g. {"doc": "release-plan", "page": "Rollout"}: the user sees ' +
            '"Built from" with a link to it, and "Rebuild from the doc" once the page changes.',
          properties: {
            doc: { type: 'string', description: 'The doc\'s name, as doc_list gives it.' },
            page: { type: 'string', description: "The page's title or id. Default: the doc's first page." },
          },
          required: ['doc'],
          additionalProperties: false,
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update',
    title: 'Update an artifact',
    description:
      'Publish a new version of an artifact you already published in this conversation (the user can compare and restore versions). Pass its `id` and the ' +
      'new `path` or `content`. Use this instead of `publish` when revising a page. Identical content creates no new version. Keep referring to it as ' +
      '[Title](studio-artifact://<id>). When the user asks to rebuild an artifact from its doc, read that page with doc_read first, then update.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The artifact id returned by `publish` or `list`.' },
        path: {
          type: 'string',
          description:
            'Path of the file with the new version (absolute, or relative to the session folder). Give this or `content`, not both.',
        },
        content: { type: 'string', description: 'The new file text. Give this or `path`, not both.' },
        note: { type: 'string', description: 'Optional one-line description of what changed, shown in the version list.' },
        fromDoc: {
          type: 'object',
          description: 'Optional. The doc page this artifact shows, e.g. {"doc": "release-plan", "page": "Rollout"}: the user sees ' +
            '"Built from" with a link to it, and "Rebuild from the doc" once the page changes.',
          properties: {
            doc: { type: 'string', description: 'The doc\'s name, as doc_list gives it.' },
            page: { type: 'string', description: "The page's title or id. Default: the doc's first page." },
          },
          required: ['doc'],
          additionalProperties: false,
        },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'list',
    title: 'List artifacts',
    description:
      'List the artifacts published in this conversation (id, title, kind, version, link). Use it to find an id to `update`, or to check what the user already has.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'archive',
    title: 'Archive artifacts',
    description:
      "Archive (or unarchive) artifacts published in this conversation. Archive only when the user asks. An archived artifact leaves the " +
      "Artifacts picker's main list for its Archived group; it stays whole (links, versions and downloads keep working) and the user " +
      'unarchives it in one click. Pass the ids from `list` (which marks archived ones). You cannot delete artifacts: only the user can.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 100,
          description: 'The artifact ids to archive or unarchive (from `publish` or `list`).',
        },
        archived: { type: 'boolean', description: 'true to archive (the default), false to unarchive.' },
      },
      required: ['ids'],
      additionalProperties: false,
    },
  },
];

export const WORKTREE_TOOLS: Json[] = [
  {
    name: 'merge_into_project',
    title: "Merge this chat's work into the project's main branch",
    description:
      "Merge this chat's work (done in its own worktree, on its own branch) into the project's main branch: main, else master, else the " +
      'branch the chat started from. You may merge on your own, without asking: the user has authorized it. Merge when your work is done ' +
      'and tested (for example before a release is cut), or whenever the user asks; no button press is needed (the Merge button in the ' +
      "Changes tab only sends you that request). It lands this chat's own changes " +
      'and nothing else, and AIB posts a "Merged into ..." line in the chat for every merge. If main has moved, AIB first merges main into ' +
      'your worktree; if that conflicts, nothing lands on main and the reply lists the files: resolve them in your worktree (keep what both ' +
      "sides intended, remove the conflict markers, commit), then call this again. The user's uncommitted edits in the main checkout are " +
      "set aside and put back. To take in a helper's work from another worktree, run `git merge <their branch>` in your worktree first " +
      '(all worktrees share the branches). Helpers in other worktrees never block a merge; a terminal still running in your worktree does. ' +
      'The reply names the target branch, then says what landed or exactly why nothing did and what to do.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'resolve_edit_clash',
    title: "Resolve a clash with the user's own edits",
    description:
      "After a merge, the user's own unsaved edits in the project folder can clash with it; AIB then tells you which files and the name of the stash " +
      'that keeps their edits. Use `check` after you combined those files yourself in the project folder (AIB looks for leftover conflict markers), ' +
      '`keep_mine` only when the user says to keep their version (their edits win in those files), `leave` when the user says they will sort it out themselves.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['check', 'keep_mine', 'leave'], description: 'What the user decided.' } },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

const env = (name: string) => Deno.env.get(name) ?? '';

/**
 * Who is calling and where Studio is. The stdio server reads it from its environment (envContext); the HTTP server
 * (mcp_http.ts) builds it from the verified request headers and the Studio that serves it.
 */
export interface ToolContext {
  /** The per-conversation key sent as X-Studio-Artifact-Key. */
  key: string;
  conversation: string;
  /** Offer the worktree merge tools. */
  worktree: boolean;
  /** The session folder relative paths are resolved against, or null when unknown (relative paths are then refused). */
  cwd: string | null;
  /** Studio base URLs to try, in order; each is passed through loopbackUrl before use. */
  roots(): string[];
}

/** The stdio server's context: the STUDIO_* environment variables and this process's folder. */
export function envContext(): ToolContext {
  return {
    key: env('STUDIO_ARTIFACT_KEY'),
    conversation: env('STUDIO_CONVERSATION_ID'),
    worktree: Deno.env.get('STUDIO_WORKTREE') === '1',
    cwd: Deno.cwd(),
    roots: () => [baseUrl(), urlFromFile(env('STUDIO_ARTIFACT_URL_FILE'))],
  };
}

/** A failure to report to the agent as an MCP tool error (isError), not a protocol error. */
export class ToolError extends Error {}

/** An exception Python would raise with this type name (shown as "Artifact tool failed: <Type>: <message>"). */
class PyError extends Error {
  constructor(readonly pyType: string, message: string) {
    super(message);
  }
}

function pyGet(value: unknown, key: string): unknown {
  if (!isDict(value)) throw new PyError('AttributeError', `'${pyTypeName(value)}' object has no attribute 'get'`);
  return Object.hasOwn(value, key) ? value[key] : null;
}

/** Python's str(value) for a non-str truthy value used as `str(value or '')`. */
function loose(value: unknown): string {
  return truthy(value) ? pyStr(value) : '';
}

const LOOPBACK_URL = /^http:\/\/(?:127\.0\.0\.1|localhost):([0-9]{1,5})$/;

/**
 * The URL when it is exactly http://127.0.0.1:<port> or http://localhost:<port> (no path, userinfo or other host); else ''.
 * The artifact key travels in a header, so it must never be sent anywhere but this machine's Studio.
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

/** The loopback URL in Studio's URL file ({"url": ...}), or ''. */
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

/** Python's text for an OSError from a socket: "[WinError N] message" (Windows) or "[Errno N] message". */
function socketReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const found = /^(.*?)\.? \(os error (\d+)\)$/s.exec(text);
  if (!found) return text;
  return Deno.build.os === 'windows' ? `[WinError ${found[2]}] ${found[1]}` : `[Errno ${found[2]}] ${found[1]}`;
}

/** A connection-level failure (Python: URLError / OSError), with Python's reason text. */
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

/** soft: an HTTP error that carries Studio's own reason (not a refused key) comes back as {error, status}, not as a ToolError. */
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
  for (const root of ctx.roots().map(loopbackUrl)) { // the file wins on retry: Studio may have restarted on another port
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

/** Python's iteration of `reply.get('artifacts') or []`: a list's items, a str's characters, a dict's keys; a number raises. */
function iterate(value: unknown): unknown[] {
  if (!truthy(value)) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (isDict(value)) return Object.keys(value);
  throw new PyError('TypeError', `'${pyTypeName(value)}' object is not iterable`);
}

async function toolList(ctx: ToolContext, _args: Json): Promise<Json> {
  const reply = await http(ctx, 'GET', '/api/live/artifacts', { conversationId: ctx.conversation });
  // archived ones carry archived: true (Deno only; the key stays out otherwise, so the reply matches Python's)
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

type Handler = (ctx: ToolContext, args: Json) => Promise<Json>;
const HANDLERS: Record<string, Handler> = { publish: toolPublish, update: toolUpdate, list: toolList, archive: toolArchive };
const WORKTREE_HANDLERS: Record<string, Handler> = {
  merge_into_project: (ctx) => worktreeCall(ctx, 'merge'),
  resolve_edit_clash: toolResolveClash,
};

/** The doc tools run in Studio (POST /api/live/docs/tool, with this conversation's key); a refusal is the agent's to act on. */
async function docTool(ctx: ToolContext, name: string, args: Json): Promise<Json> {
  const reply = await http(ctx, 'POST', '/api/live/docs/tool', null, { conversationId: ctx.conversation, tool: name, args }, true);
  if (isDict(reply) && Object.hasOwn(reply, 'error') && Object.hasOwn(reply, 'status')) throw new ToolError(`AIB: ${pyStr(reply.error)}`);
  const ok = isDict(reply) && reply.ok !== false;
  const result = isDict(reply) && isDict(reply.result) ? reply.result : reply;
  return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(ok ? {} : { isError: true }) };
}
const DOC_HANDLERS: Record<string, Handler> = Object.fromEntries(
  [...DOC_TOOL_NAMES, ...DRAWING_TOOL_NAMES].map((name) => [name, (ctx, args) => docTool(ctx, name, args)]),
);

function handlers(ctx: ToolContext): Record<string, Handler> {
  return { ...HANDLERS, ...(ctx.worktree ? WORKTREE_HANDLERS : {}), ...DOC_HANDLERS };
}

async function callTool(ctx: ToolContext, name: string, args: unknown): Promise<Json> {
  try {
    return await handlers(ctx)[name](ctx, isDict(args) ? args : {});
  } catch (error) {
    if (error instanceof ToolError) return { content: [{ type: 'text', text: error.message }], isError: true };
    // never crash the server on a tool
    const type = error instanceof PyError ? error.pyType : error instanceof Error ? error.name : 'Exception';
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text', text: `Artifact tool failed: ${type}: ${message}` }], isError: true };
  }
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
  if (method === 'tools/list') return ok({ tools: [...TOOLS, ...(ctx.worktree ? WORKTREE_TOOLS : []), ...DOC_TOOLS, ...DRAWING_TOOLS] });
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
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true }); // errors='replace', a BOM kept (Python then fails to parse)
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
