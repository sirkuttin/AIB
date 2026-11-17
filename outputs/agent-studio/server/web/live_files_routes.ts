/**
 * The file editor's routes (files/live_files.ts). Page session only: never an agent's tool key, never a paired computer or phone
 * (pc_routes.ts lists each one as `never`), so nothing but the AIB page on this PC can change a project file's live text.
 *   POST /api/live/files/open {id|project, root: 'main'|'project', path}   open a file for editing: {editable: true, file, lineage,
 *        sha, eol, bom, encoding, ...} or {editable: false, reason, reasonText} (a helper's worktree, aib-docs, a binary file...)
 *   POST /api/live/files/save {file, sv?, force?, text?}   write the live text (sv: the page's Y state vector, base64; the server waits
 *        for those edits first). 200 {ok, sha, mtime}; 409 {code: merged | unmergeable | deleted | behind | disk_busy | locked |
 *        read_only | access_denied | disk_full | folder_gone}; 423 {code: landing_busy, who}. `text` replaces the live text first
 *        (tests only stand in for the page's typing with it).
 *   POST /api/live/files/close {file, view, discard}   a tab closed; with discard ("Don't save") the unsaved text goes only when no
 *        other view (another window, the beside pane) still shows the file.
 *   GET  /api/live/files/compare?file   the disk's text now, for Compare (read only; a form AIB can't edit is shown as far as it can).
 *   GET  /api/live/files/socket?file&view   the editor's WebSocket: y-protocols sync + awareness (binary) and {type: hello | reopen}
 *        (text). Its own subprotocol `aib-file` (and `aib-token.<page token>`), checked before the upgrade.
 */
import { authorize, pageAllowed, type Principal, Refusal, REMOTE_PC, TOKEN_HEADER } from './security.ts';
import { ROUTES } from './routes.ts';
import { upgradeWebSocket, wantsWebSocket } from '../platform/websocket.ts';
import { TOKEN_PROTOCOL_PREFIX } from './terminal_routes.ts';
import { scopeFor } from './files_routes.ts';
import { FilesError } from '../worktrees/files.ts';
import { REASON_TEXT } from '../files/file_text.ts';
import { type LiveFiles, REFUSED_TEXT } from '../files/live_files.ts';
import { wslLoc } from '../wsl/access.ts';
import type { WebContext } from './server.ts';

export const FILES_SOCKET = '/api/live/files/socket';
export const FILES_PROTOCOL = 'aib-file';

type Reply = [number, unknown];
type Handler = (ctx: WebContext, url: URL, body: Record<string, unknown> | null, request: Request, principal?: Principal) => Promise<Reply>;

const REMOTE_REFUSED: Reply = [403, { error: 'Files are edited on the PC itself.', code: 'remote_refused' }];
const unb64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function liveFilesOf(ctx: WebContext): LiveFiles | null {
  return ctx.liveFiles ?? null;
}

function reasonText(reason: string): string {
  return (REFUSED_TEXT as Record<string, string>)[reason] ?? 'Read-only: ' + ((REASON_TEXT as Record<string, string>)[reason] ?? reason);
}

export function liveFilesRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  const guard = (handler: Handler): Handler => async (ctx, url, body, request, principal) => {
    if (principal?.kind === REMOTE_PC) return REMOTE_REFUSED;
    if (!pageAllowed(principal, request.headers, ctx.token)) return [403, { error: 'Invalid local session token' }];
    const files = liveFilesOf(ctx);
    if (!files) return [503, { error: 'The file editor is not running', code: 'no_editor' }];
    try {
      return await handler(ctx, url, body, request, principal);
    } catch (error) {
      if (error instanceof FilesError) return [error.status, { error: error.message, code: error.code }];
      throw error;
    }
  };
  routes.set('POST /api/live/files/open', guard(async (ctx, _url, body) => {
    const b = body ?? {};
    const root = String(b.root ?? '');
    if (root === 'chat') return [200, { editable: false, reason: 'worktree', reasonText: reasonText('worktree') }];
    if (root !== 'main' && root !== 'project') return [400, { error: 'Unknown folder', code: 'bad_root' }];
    const args: Record<string, string[]> = { root: [root] };
    for (const k of ['id', 'project']) if (typeof b[k] === 'string') args[k] = [b[k] as string];
    const scope = await scopeFor(ctx, args);
    if (Array.isArray(scope)) return scope;
    if (wslLoc(scope.root)) return [200, { editable: false, reason: 'wsl', reasonText: reasonText('wsl') }];
    const got = liveFilesOf(ctx)!.open(scope.root, b.path);
    if ('refused' in got) return [200, { editable: false, reason: got.refused, reasonText: reasonText(got.refused) }];
    const lf = got.file;
    lf.refreshDirty();
    return [200, {
      editable: true,
      file: lf.id,
      lineage: lf.lineage,
      path: lf.place.rel,
      abs: lf.place.abs,
      root: lf.place.root,
      name: lf.place.rel.slice(lf.place.rel.lastIndexOf('/') + 1),
      sha: lf.base.sha,
      eol: lf.base.eolKind,
      bom: lf.base.bom,
      encoding: lf.base.encoding,
      size: lf.base.size,
      dirty: lf.isDirty(),
    }];
  }));
  routes.set('POST /api/live/files/save', guard(async (ctx, _url, body) => {
    const b = body ?? {};
    let sv: Uint8Array | null = null;
    try {
      sv = typeof b.sv === 'string' && b.sv ? unb64(b.sv) : null;
    } catch {
      return [400, { error: 'Invalid request', code: 'bad_sv' }];
    }
    const reply = await liveFilesOf(ctx)!.save(String(b.file ?? ''), { sv, force: b.force === true, text: typeof b.text === 'string' ? b.text : null });
    if (reply.ok) return [200, reply];
    const { status, ...rest } = reply;
    return [status, rest];
  }));
  routes.set('POST /api/live/files/close', guard((ctx, _url, body) => {
    const b = body ?? {};
    return Promise.resolve([200, liveFilesOf(ctx)!.closeView(String(b.file ?? ''), String(b.view ?? ''), b.discard === true)]);
  }));
  routes.set('GET /api/live/files/compare', guard((ctx, url) => {
    const lf = liveFilesOf(ctx)!.get(url.searchParams.get('file') ?? '');
    if (!lf) return Promise.resolve([404, { error: 'Open the file first', code: 'not_open' }]);
    let bytes: Uint8Array;
    try {
      bytes = Deno.readFileSync(lf.place.abs);
    } catch {
      return Promise.resolve([200, { disk: null, reason: 'deleted' }]);
    }
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : '';
    const binary = !utf16 && bytes.subarray(0, 8192).includes(0);
    const text = binary ? null : new TextDecoder(utf16 || 'utf-8').decode(bytes).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    return Promise.resolve([200, { disk: text, reason: binary ? 'binary' : '', base: lf.base.sha }]);
  }));
  return routes;
}

function offered(request: Request): string[] {
  return (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * GET /api/live/files/socket (review must-fix 6): the page's token only, checked before the upgrade; a paired computer never gets here
 * (the bridge only opens the sockets it lists, and pc_routes.ts says `never`). A file that is not open here (the web server
 * restarted and it had nothing unsaved) is told {type: "reopen"}: the page opens it again and rebases its text on the new one.
 */
export function filesSocket(ctx: WebContext, request: Request, url: URL, principal: Principal | null = null): { refused: Reply } | { response: Response } {
  if (principal?.kind === REMOTE_PC) return { refused: REMOTE_REFUSED };
  const protocols = offered(request);
  const token = protocols.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length) ?? '';
  const headers = new Headers(request.headers);
  headers.delete(TOKEN_HEADER);
  if (token) headers.set(TOKEN_HEADER, token);
  const allowed = authorize({ method: 'GET', path: FILES_SOCKET, headers }, ctx.gate, ROUTES.scopeFor('GET', FILES_SOCKET));
  if (allowed instanceof Refusal) return { refused: [allowed.status, { error: allowed.message(FILES_SOCKET) }] };
  if ((allowed as Principal).kind === REMOTE_PC) return { refused: REMOTE_REFUSED };
  if (request.headers.get('Origin') === null) return { refused: [403, { error: 'Request must come from the AIB page' }] };
  if (!wantsWebSocket(request) || !protocols.includes(FILES_PROTOCOL)) {
    return { refused: [400, { error: 'This address only takes a file editor WebSocket.' }] };
  }
  const files = liveFilesOf(ctx);
  const id = url.searchParams.get('file') ?? '';
  const view = (url.searchParams.get('view') ?? '').slice(0, 64);
  const { response, link } = upgradeWebSocket(request, FILES_PROTOCOL);
  if (!files || !files.attach(id, link, view)) {
    link.onmessage = () => {};
    link.send(JSON.stringify({ type: 'reopen', reason: 'not_open' }));
    link.close(4404, 'file not open');
  }
  return { response };
}
