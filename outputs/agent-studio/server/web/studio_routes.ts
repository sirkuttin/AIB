/**
 * The rest of web_handler.py's routes, served by the Deno web server: settings and the conversation marks (studio_shared.py), the
 * editor launcher, the folder routes, the Prompts find box, the Changes view and branch, the worktree Merge / clash routes (Resume of
 * a paused live sync included), the update routes, and the artifact routes with their own gate order (the agent key is checked after
 * the body is read). Payloads and messages are Python's.
 */
import { isDict, ValueError } from '../core/py.ts';
import { conversationAction, settingsView, type StudioContext } from './shared.ts';
import { EditorError, knownRoots, Launcher } from '../desktop/editors.ts';
import * as folders from '../desktop/folders.ts';
import { presence } from '../desktop/folder_presence.ts';
import { pyInt } from '../transcripts/pycompat.ts';
import { findPrompts } from '../transcripts/prompts.ts';
import { changesResponse, type ChatStudio, repoBranch } from '../worktrees/chat_folders.ts';
import * as merge from '../worktrees/merge.ts';
import { FROM_DOC_RESOLVED, MAX_BODY_BYTES } from '../artifacts/artifacts.ts';
import { getUpdate, getUpdateNotes, postUpdateCheck, postUpdateInstall, postUpdateNotes } from '../desktop/updater.ts';
import { parseQs } from '../artifacts/origin.ts';
import { authorize, Refusal, SCOPE_ARTIFACTS_TOOL } from './security.ts';
import { check as checkArtifactKey } from '../artifacts/keys.ts';
import { ROUTES } from './routes.ts';
import type { WebContext } from './server.ts';
import { bringBack, restoreFolders } from './project_routes.ts';
import { DOCS_TOOL, docsTool, resolveFromDoc } from './docs_routes.ts';
import { DocRefusal } from '../docs/live_doc.ts';

type Json = Record<string, unknown>;
export type Reply = [number, unknown];
/** A native route: [status, payload]. */
export type StudioHandler = (ctx: WebContext, url: URL, body: Json | null, request: Request) => Promise<Reply>;

/** parse_qs(query) and args.get(name, [fallback])[0]. */
function argsOf(url: URL): Record<string, string[]> {
  return parseQs(url.search.slice(1));
}
const one = (args: Record<string, string[]>, name: string, fallback = '') => Object.hasOwn(args, name) ? args[name][0] : fallback;

/** The StudioContext the shared helpers read (RemoteStudio's attributes: options, stores, host calls, host info). */
export function studioOf(ctx: WebContext): StudioContext {
  return {
    options: ctx.agentOptions,
    settings: ctx.settings,
    conversations: ctx.conversations,
    liveList: () => ctx.host.liveList(),
    liveCall: (name, body) => ctx.host.liveCall(name, body),
    studioOwns: (provider, sessionId) => ctx.host.studioOwns(provider, sessionId),
    hostInfo: ctx.host.hostInfo,
    waitingChats: ctx.host.waitingChats,
  };
}

/** What chat_folders reads from a Studio. savedCwd: the saved-transcript folder looked up before the call (it is synchronous). */
export function chatStudioOf(ctx: WebContext, saved: Map<string, string> = new Map()): ChatStudio {
  return {
    liveState: (ident, limit) => ctx.host.liveState(ident, limit),
    conversations: ctx.conversations as unknown as ChatStudio['conversations'],
    store: null,
    savedCwd: (provider, sessionId) => saved.get(`${provider}:${sessionId}`) ?? '',
    token: ctx.token,
    stateDir: ctx.stateDir,
  };
}

/** chat_folders.SAVED_CWD (catalog.session_cwd) for a 'provider:sessionId' id, looked up ahead of the synchronous use. */
export async function savedFolders(ctx: WebContext, ident: string): Promise<Map<string, string>> {
  const saved = new Map<string, string>();
  const source = ctx.transcripts as { sessionCwd?: (provider: string, sessionId: string) => Promise<string> };
  if (typeof source.sessionCwd === 'function' && /^[a-z0-9_-]+:/.test(ident) && ident.length <= 600) {
    const at = ident.indexOf(':');
    saved.set(ident, await source.sessionCwd(ident.slice(0, at), ident.slice(at + 1)));
  }
  return saved;
}

function mergeStudio(ctx: WebContext): merge.MergeStudio {
  return {
    stateDir: ctx.stateDir,
    liveState: (chatId) => ctx.host.liveState(chatId, 0),
    liveCall: (op, payload) => ctx.host.liveCall(op, payload),
  };
}

/** '' or why the Merge button may not ask this chat: archived, or running in another app (the page shows the same reasons). */
function requestBlockedHere(ctx: WebContext, state: Record<string, unknown>): string {
  const provider = typeof state.provider === 'string' ? state.provider : '';
  const sessionId = typeof state.sessionId === 'string' ? state.sessionId : '';
  if (provider && sessionId) {
    try {
      const entry = ctx.conversations.public().entries[`${provider}:${sessionId}`];
      if (entry && entry.archivedAt) return 'This chat is archived. Unarchive it to merge its work';
    } catch { /* the marks could not be read: the page's own check still holds */ }
  }
  return '';
}

/** The editor launcher, as studio.create_server builds it: roots are the folders Studio knows, preferred the Settings default. */
export function makeLauncher(ctx: () => WebContext, listing: () => Json): Launcher {
  return new Launcher(
    () => knownRoots({ liveList: () => listing(), conversations: ctx().conversations as never, projectPrefs: ctx().projectPrefs }),
    { preferred: () => ctx().settings.snapshot().editors.default },
  );
}

async function refusedReply<T>(work: () => Promise<T> | T): Promise<Reply> {
  try {
    return [200, await work()];
  } catch (error) {
    if (error instanceof merge.Refused) return [error.status, { ...error.extra, error: error.message, code: error.code }];
    if (error instanceof EditorError) return [error.status, { error: error.message, code: error.code }];
    throw error;
  }
}

/** The live list for the editor roots (known_roots reads it synchronously): refreshed before each editor request. */
async function refreshList(ctx: WebContext): Promise<void> {
  try {
    ctx.editorList = await ctx.host.liveList();
  } catch (error) { // a host problem must not hide the roots we do have
    console.error('Listing live conversations for editor roots failed', error);
    ctx.editorList = {};
  }
}

export function studioRoutes(): Map<string, StudioHandler> {
  const routes = new Map<string, StudioHandler>();
  // ---- settings and conversation marks ----
  routes.set('GET /api/live/settings', async (ctx, url) => [200, await settingsView(studioOf(ctx), one(argsOf(url), 'recheck') === '1')]);
  routes.set('POST /api/live/settings', async (ctx, _url, body) => {
    await ctx.settings.update(body);
    return [200, { ...(await settingsView(studioOf(ctx))), ok: true }];
  });
  routes.set('POST /api/live/conversation-state', async (ctx, _url, body) => {
    const folders = restoreFolders(ctx.conversations, body);
    const reply = await conversationAction(studioOf(ctx), body);
    if (reply[0] === 200) await bringBack(ctx.removedProjects, folders, ctx.addedProjects); // restoring a chat brings its removed project back
    return reply;
  });
  // ---- editors ----
  routes.set('GET /api/live/editors', async (ctx, url) => {
    await refreshList(ctx);
    return refusedReply(() => ctx.launcher.listing(one(argsOf(url), 'project') || null));
  });
  routes.set('POST /api/live/open', async (ctx, _url, body) => {
    await refreshList(ctx);
    return refusedReply(() => ctx.launcher.open(body));
  });
  // ---- folders ----
  routes.set('GET /api/live/folders/check', (_ctx, url) => {
    const args = argsOf(url);
    return Promise.resolve([200, folders.checkProject(one(args, 'path'), one(args, 'name'))]);
  });
  routes.set('GET /api/live/folders/kinds', (_ctx, url) => {
    const args = argsOf(url);
    const wanted: unknown[] = [...(args.path ?? [])];
    try { // the page sends one JSON list in `paths`; repeated `path` parameters work too
      const extra = JSON.parse(one(args, 'paths', '[]'));
      if (Array.isArray(extra)) wanted.push(...extra);
    } catch { /* ignored, as Python's ValueError */ }
    return Promise.resolve([200, { kinds: folders.folderKinds(wanted, one(args, 'parents') === '1') }]);
  });
  // Project folders that no longer exist (cached on the server, read-only): the page leaves their projects out of the list.
  routes.set('GET /api/live/folders/gone', (_ctx, url) => {
    const args = argsOf(url);
    const wanted: unknown[] = [...(args.path ?? [])];
    try {
      const extra = JSON.parse(one(args, 'paths', '[]'));
      if (Array.isArray(extra)) wanted.push(...extra);
    } catch { /* not JSON: nothing asked */ }
    return Promise.resolve([200, { gone: presence.gone(wanted) }]);
  });
  routes.set('GET /api/live/folders/start', (ctx) => Promise.resolve([200, folders.startFolder(ctx.folderMemory)]));
  routes.set('POST /api/live/folders/create', async (ctx, _url, body) => {
    const gitInit = body && Object.hasOwn(body, 'gitInit') ? body.gitInit : false;
    if (typeof body?.path !== 'string' || typeof gitInit !== 'boolean') throw new ValueError('Invalid request');
    const named = Object.hasOwn(body, 'name'); // with a name: <path>\<name>, made or used; without: <path> itself, made
    if (named && typeof body.name !== 'string') throw new ValueError('Invalid request');
    let result: folders.CreateResult;
    try {
      result = named
        ? await folders.createProject(body.path, body.name, gitInit)
        : await folders.createFolder(folders.normalizeFolder(body.path), gitInit);
    } catch (error) {
      if (error instanceof folders.FolderError) return [400, { error: error.message, code: error.code }];
      throw error;
    }
    ctx.folderMemory.rememberProject(result.path);
    return [200, result];
  });
  routes.set('POST /api/live/folders/remember', (ctx, _url, body) => {
    try {
      return Promise.resolve([200, { ok: true, parent: ctx.folderMemory.rememberProject(body?.path) }]);
    } catch (error) {
      if (error instanceof folders.FolderError) return Promise.resolve([400, { error: error.message, code: error.code }]);
      throw error;
    }
  });
  routes.set('POST /api/live/folders/pick', async (_ctx, _url, body) => {
    const start = body && Object.hasOwn(body, 'start') ? body.start : '';
    if (typeof start !== 'string') throw new ValueError('Invalid request');
    return await folders.pickFolder(start);
  });
  // ---- the Prompts view's find box ----
  routes.set('GET /api/live/prompts', async (ctx, url) => {
    const args = argsOf(url);
    const key = one(args, 'key');
    if (!key) return [400, { error: 'Name the chat to search' }];
    const limit = Math.min(1000, Math.max(1, pyInt(one(args, 'limit', '200'))));
    const source = ctx.transcripts;
    const transcript = await source.load(await source.resolve(key) as never);
    return await transcript.lock.run(() => {
      let events = transcript.events as Json[];
      if (one(args, 'thinking') !== '1') events = events.filter((e) => e.kind !== 'thinking'); // the same filter /api/transcript applies
      return [200, findPrompts(events, one(args, 'q'), limit)] as Reply;
    });
  });
  // ---- Changes view, branch, worktree Merge and clashes ----
  for (const path of ['/api/live/changes', '/api/live/changes/file']) {
    routes.set(`GET ${path}`, async (ctx, url, _body, request) => {
      const args = argsOf(url);
      return await changesResponse(chatStudioOf(ctx, await savedFolders(ctx, one(args, 'id'))), path, args, request.headers);
    });
  }
  routes.set('GET /api/live/branch', (_ctx, url) => Promise.resolve([200, { branch: repoBranch(one(argsOf(url), 'cwd')) }]));
  routes.set('GET /api/live/worktree', async (ctx, url) => [200, await merge.status(mergeStudio(ctx), one(argsOf(url), 'id'))]);
  routes.set('GET /api/live/worktree/clash', async (ctx, url) => [200, await merge.clashStatus(ctx, one(argsOf(url), 'project'))]);
  routes.set('POST /api/live/worktree/merge', (ctx, _url, body) => {
    const title = typeof body?.title === 'string' ? body.title : '';
    return refusedReply(() => merge.merge(mergeStudio(ctx), body?.id, title));
  });
  // The Changes tab's Merge button: a one-shot merge permission for this chat, then the chat is asked to merge (merge_request.ts).
  routes.set('POST /api/live/worktree/merge-request', (ctx, _url, body) => {
    return refusedReply(() => merge.requestMerge(mergeStudio(ctx), body?.id, { blocked: (state) => requestBlockedHere(ctx, state) }));
  });
  routes.set('POST /api/live/worktree/clash', async (ctx, _url, body) => {
    if (body?.action === 'resume-sync') return [200, { ok: true, resumed: await merge.resumeSync(ctx.stateDir, body.project) }];
    return refusedReply(() => merge.resolveClash(mergeStudio(ctx), body?.id, typeof body?.action === 'string' ? body.action : ''));
  });
  // ---- updates ----
  routes.set('GET /api/live/update', (ctx) => Promise.resolve(getUpdate(ctx.updates)));
  routes.set('POST /api/live/update/check', (ctx, _url, body) => Promise.resolve(postUpdateCheck(ctx.updates, body ?? {})));
  routes.set('POST /api/live/update/install', (ctx, _url, body) => postUpdateInstall(ctx.updates, body ?? {}));
  routes.set('GET /api/live/update/notes', (ctx) => Promise.resolve(getUpdateNotes(ctx.updates)));
  routes.set('POST /api/live/update/notes', (ctx, _url, body) => Promise.resolve(postUpdateNotes(ctx.updates, body ?? {})));
  // ---- artifacts (GET; the gate already ran, with the agent key for the list) ----
  for (const path of ['/api/live/artifacts', '/api/live/artifacts/item', '/api/live/artifacts/source', '/api/live/artifacts/diff']) {
    routes.set(`GET ${path}`, async (ctx, url, _body, request) => {
      const args = argsOf(url);
      await ctx.artifacts.prepare(path === '/api/live/artifacts', null);
      return artifactCall(() => ctx.artifacts.service.handleGet(request, path, args));
    });
  }
  return routes;
}

/** artifact_route's error mapping: Python answers KeyError/ValueError/TypeError/OSError/RuntimeError with 400 (the Service already maps its own). */
function artifactCall(work: () => Reply): Reply {
  try {
    return work();
  } catch (error) {
    if (error instanceof Error && ['KeyError', 'ValueError', 'TypeError', 'OSError', 'RuntimeError', 'RangeError'].includes(error.name)) {
      return [400, { error: error.message }];
    }
    throw error;
  }
}

/** Python's json.loads error for a body that is not JSON (only the status is a contract; the text is close). */
function jsonError(error: unknown): string {
  return `Expecting value: ${error instanceof Error ? error.message : String(error)}`;
}

/** Read a JSON body within (0, limit] bytes for the own-gate routes: [body or {}, null] or [null, 400 reply]. */
async function ownGateBody(request: Request, limit: number): Promise<[Json, null] | [null, Reply]> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (!(declared > 0 && declared <= limit)) {
    await request.body?.cancel().catch(() => {});
    return [null, [400, { error: 'Invalid request size' }]];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await request.arrayBuffer()));
  } catch (error) {
    return [null, [400, { error: jsonError(error) }]];
  }
  return [isDict(parsed) ? parsed : {}, null];
}

/** The gate for one route, as web_handler.Handler.gate: security.authorize with this route's scope (and the agent key check). */
export function gateFor(ctx: WebContext, request: Request, path: string, conversationId: unknown): Refusal | object {
  return authorize(
    { method: 'POST', path, headers: request.headers },
    ctx.gate,
    ROUTES.scopeFor('POST', path),
    typeof conversationId === 'string'
      ? conversationId
      : conversationId === null || conversationId === undefined
      ? null
      : String(conversationId),
    checkArtifactKey,
  );
}

/**
 * The POST routes that run their own gate (web_handler.post_artifacts and post_worktree_tool): the agent key is bound to the body's
 * conversation, so the body is read before the key is checked. Returns [status, payload].
 */
export async function ownGatePost(ctx: WebContext, request: Request, url: URL): Promise<Reply> {
  const path = url.pathname;
  if (path === '/api/live/worktree/tool') {
    const [body, bad] = await ownGateBody(request, 100000);
    if (bad) return bad;
    const conversation = body.conversationId;
    const allowed = gateFor(ctx, request, path, conversation);
    if (allowed instanceof Refusal) return [allowed.status, { error: allowed.message(path) }];
    const action = typeof body.action === 'string' ? body.action : 'merge';
    if (action === 'merge') return await refusedReply(() => merge.mergeFromTool(mergeStudio(ctx), conversation));
    return await refusedReply(() => merge.resolveClash(mergeStudio(ctx), conversation, action, true));
  }
  if (path === DOCS_TOOL) { // an agent's doc tool: the key is bound to the body's conversation, as for publish
    const [body, bad] = await ownGateBody(request, 4 * 1024 * 1024);
    if (bad) return bad;
    const allowed = gateFor(ctx, request, path, body.conversationId);
    if (allowed instanceof Refusal) return [allowed.status, { error: allowed.message(path) }];
    await ctx.artifacts.prepare(true, body.conversationId);
    return await docsTool(ctx, body);
  }
  // /api/live/artifacts/*: publish is for the agent tool (its key, bound to the body's conversation), the rest for the page.
  const toolRoute = ROUTES.scopeFor('POST', path) === SCOPE_ARTIFACTS_TOOL;
  if (!toolRoute) {
    const allowed = gateFor(ctx, request, path, null);
    if (allowed instanceof Refusal) {
      await request.body?.cancel().catch(() => {});
      return [allowed.status, { error: allowed.message(path) }];
    }
  }
  const [body, bad] = await ownGateBody(request, MAX_BODY_BYTES);
  if (bad) return bad;
  if (toolRoute) {
    const allowed = gateFor(ctx, request, path, body.conversationId);
    if (allowed instanceof Refusal) return [allowed.status, { error: allowed.message(path) }];
  }
  const publishing = path === '/api/live/artifacts/publish' || path === '/api/live/artifacts/preview';
  await ctx.artifacts.prepare(publishing, publishing ? body.conversationId : null);
  delete body[FROM_DOC_RESOLVED];
  if (path === '/api/live/artifacts/publish') {
    // "Built from <doc › page>": the tool's fromDoc, or (an update without one) the link the artifact has, at the page's rev now
    let from: unknown = body.fromDoc;
    if (from === undefined && typeof body.id === 'string') {
      try {
        from = ctx.artifacts.service.store.get(body.id).fromDoc;
      } catch { /* the publish says what is wrong */ }
      if (from && typeof from === 'object') from = { doc: (from as Json).doc, page: (from as Json).page };
    }
    if (from !== undefined && from !== null) {
      try {
        body[FROM_DOC_RESOLVED] = await resolveFromDoc(ctx, String(body.conversationId ?? ''), from);
      } catch (error) {
        if (!(error instanceof DocRefusal)) throw error;
        if (body.fromDoc !== undefined) return [400, { error: error.message, code: error.code }];
        // an update of an artifact whose doc page is gone: published, the old link kept
      }
    }
    delete body.fromDoc;
  }
  return artifactCall(() => ctx.artifacts.service.handlePost(request, path, body));
}
