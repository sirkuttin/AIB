/**
 * The Files view's routes (Deno only: routes.ts DENO_ONLY). All three take the chat (`id`: a live connection id or a
 * 'provider:sessionId' key) and which of its folders (`root`: 'chat', its own folder or worktree; 'main', the main checkout of a
 * worktree chat). The folder is the one Studio already knows for that chat (chat_folders.changesFolder): nothing from the request is
 * used as a folder, and the paths it sends are relative to that folder and checked to stay inside it (worktrees/files.ts).
 *   GET /api/live/files/list?id&root&dir      one folder: entries with ignored flag, change letter, changed count
 *   GET /api/live/files/search?id&root&q      the best 200 file names from a cached index (rebuilt when the agent writes files)
 *   GET /api/live/files/read?id&root&path     a text file up to 1 MB (binary detected); `viewUrl` for images and pages, served
 *                                             read only by the artifact origin (file_tickets.ts), never as an artifact
 *   GET /api/live/files/outside?id&path[&peek=1]  a file OUTSIDE the chat's folder, by absolute path, only when the chat's own tool
 *                                             calls or messages name it (worktrees/outside_files.ts); same answer as read plus
 *                                             `outside: {kind, branch, repo, folder, text}`; peek=1 leaves out the text
 * With no chat open, `root=project&project=<folder>` (no `id`) shows the folder of a project the user added, nothing else.
 *
 * Local-only paths (worktrees/local_only.ts) always come from the main folder, in every scope: list, read and search lay them over
 * a chat's copy (files.listLocal), and every list and search reply carries `localOnly: {main, entries, defaultState, sig}`.
 *   POST /api/live/files/exclude {id|project, root, path, action: 'add'|'undo', undo?}   "Git exclude" on a row, and its Undo
 *   POST /api/live/files/strays/move {id, root}   moves what a chat's copy holds under local-only paths into the main folder
 * Needs the Studio token, like the Changes routes.
 */
import { isStr } from '../core/py.ts';
import { parseQs } from '../artifacts/origin.ts';
import { projectKey } from '../desktop/project_delete.ts';
import { changesFolder } from '../worktrees/chat_folders.ts';
import * as files from '../worktrees/files.ts';
import * as local from '../worktrees/local_only.ts';
import { mainCheckoutOf, recordForPath } from '../worktrees/worktrees.ts';
import * as osp from '../platform/ospath.ts';
import { isNetworkPath, tokenMatches } from './security.ts';
import { issue } from './file_tickets.ts';
import { chatStudioOf, savedFolders } from './studio_routes.ts';
import * as outside from '../worktrees/outside_files.ts';
import { findSessionFile } from '../transcripts/store.ts';
import type { WebContext } from './server.ts';

type Reply = [number, unknown];
type Handler = (ctx: WebContext, url: URL, body: unknown, request: Request) => Promise<Reply>;

const one = (args: Record<string, string[]>, name: string, fallback = '') => (Object.hasOwn(args, name) ? args[name][0] : fallback);

/** Files.js's id for a project with no chat: 'project:<folder>' (files-state.js projectScope). */
const PROJECT_ID = 'project:';

/** The folder a Files request works in, or a reply that refuses. */
export async function rootFor(ctx: WebContext, args: Record<string, string[]>): Promise<string | Reply> {
  // `root=project&project=<folder>`: a project with no chat open. Only a folder the user added to AIB (exactly, by its key) is
  // shown; nothing else from the request is ever a folder.
  if (one(args, 'root') === 'project') {
    const path = one(args, 'project');
    if (!path || path.length > 1024 || path.includes(String.fromCharCode(0)) || isNetworkPath(path)) return [404, { error: 'This folder cannot be shown', code: 'bad_root' }];
    const added = ctx.addedProjects?.public().added;
    const known = added && Object.hasOwn(added, projectKey(path)) ? added[projectKey(path)].path : '';
    if (!known || !osp.isdir(known) || isNetworkPath(known)) return [404, { error: 'This project has no folder AIB knows.', code: 'unknown_folder' }];
    return known;
  }
  const id = one(args, 'id');
  // A doc tab whose chat is gone names its project instead ('project:<folder>', doc-ui.js): the same rules as root=project.
  if (id.startsWith(PROJECT_ID) && one(args, 'root') !== 'project') {
    return rootFor(ctx, { root: ['project'], project: [id.slice(PROJECT_ID.length)] });
  }
  let cwd: string | null;
  try {
    // A lasting 'provider:session' id (the doc tools name the chat that way) is looked up by the live connection behind it: only that
    // knows a chat that works in its own worktree (its transcript may not be filed yet).
    const live = ctx.artifacts?.connectionOf?.(id) || id;
    cwd = await changesFolder(chatStudioOf(ctx, await savedFolders(ctx, id)), live);
    if (!cwd && live !== id) cwd = await changesFolder(chatStudioOf(ctx, await savedFolders(ctx, id)), id);
  } catch {
    return [400, { error: 'Choose a chat', code: 'bad_chat' }];
  }
  if (!cwd || isNetworkPath(cwd)) return [404, { error: 'This chat has no known project folder.', code: 'unknown_folder' }];
  const which = one(args, 'root', 'chat');
  if (which === 'main') {
    const record = recordForPath(ctx.stateDir ?? null, cwd);
    const project = record && isStr(record.project) ? record.project : '';
    const main = project && osp.isdir(project) ? project : files.mainFolderOf(cwd, mainCheckoutOf);
    if (isNetworkPath(main)) return [404, { error: 'This folder cannot be shown', code: 'bad_root' }];
    return main;
  }
  if (which !== 'chat') return [400, { error: 'Unknown folder', code: 'bad_root' }];
  return cwd;
}

/** The folder a Files request works in and the main folder its local-only paths come from, or a reply that refuses. */
export async function scopeFor(ctx: WebContext, args: Record<string, string[]>): Promise<{ root: string; main: string } | Reply> {
  const root = await rootFor(ctx, args);
  if (typeof root !== 'string') return root;
  if (one(args, 'root', 'chat') !== 'chat') return { root, main: root };
  // A chat's own copy: the main folder is the project its worktree record names (never mainFolderOf: for a project that is itself a
  // user-made worktree that would be the user's other checkout). No record: the chat works in its folder itself.
  const record = recordForPath(ctx.stateDir ?? null, root);
  const project = record && isStr(record.project) ? record.project : '';
  return { root, main: project && osp.isdir(project) && !isNetworkPath(project) ? project : root };
}

const samePath = (a: string, b: string) => osp.normcase(osp.normpath(a)) === osp.normcase(osp.normpath(b));

/** The localOnly part of a list / search reply. */
function localPart(main: string, lo: local.LocalOnly | null, sig = '') {
  return { main, entries: lo ? lo.entries : [], defaultState: lo ? lo.defaultState : 'no-git', sig };
}

/** How many files the agents working in `root` have written so far: the search index is rebuilt when this changes. */
function writesSig(ctx: WebContext, root: string): string {
  try {
    let n = 0;
    for (const c of ctx.artifacts?.conversations() ?? []) {
      if (c.cwd && files.within(osp.normpath(String(c.cwd)), osp.normpath(root))) n += (c as { writes?: string[] }).writes?.length ?? 0;
    }
    return String(n);
  } catch {
    return '';
  }
}

async function guarded(work: () => Promise<unknown> | unknown): Promise<Reply> {
  try {
    return [200, await work()];
  } catch (error) {
    if (error instanceof files.FilesError) return [error.status, { error: error.message, code: error.code }];
    throw error;
  }
}

export function filesRoutes(): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  type Work = (ctx: WebContext, root: string, args: Record<string, string[]>, main: string) => Promise<unknown> | unknown;
  const route = (path: string, work: Work) => {
    routes.set(`GET ${path}`, async (ctx, url, _body, request) => {
      if (!tokenMatches(request.headers.get('X-Studio-Token') ?? '', ctx.token)) return [403, { error: 'Invalid local session token' }];
      const args = parseQs(url.search.slice(1));
      const scope = await scopeFor(ctx, args);
      if (Array.isArray(scope)) return scope;
      return guarded(() => work(ctx, scope.root, args, scope.main));
    });
  };
  const post = (path: string, work: (ctx: WebContext, body: Record<string, unknown>) => Promise<Reply>) => {
    routes.set(`POST ${path}`, async (ctx, _url, body, request) => {
      if (!tokenMatches(request.headers.get('X-Studio-Token') ?? '', ctx.token)) return [403, { error: 'Invalid local session token' }];
      if (!body || typeof body !== 'object' || Array.isArray(body)) return [400, { error: 'Invalid request' }];
      try {
        return await work(ctx, body as Record<string, unknown>);
      } catch (error) {
        if (error instanceof files.FilesError) return [error.status, { error: error.message, code: error.code }];
        throw error;
      }
    });
  };
  const bodyArgs = (body: Record<string, unknown>) => {
    const args: Record<string, string[]> = {};
    for (const k of ['id', 'root', 'project']) if (typeof body[k] === 'string') args[k] = [body[k] as string];
    return args;
  };
  route('/api/live/files/list', async (_ctx, root, args, main) => {
    const base = files.realRoot(root);
    const lo = await local.localOnlyOf(main);
    const same = samePath(base, files.realRoot(main));
    const strays = lo && !same ? await local.findStrays(base, lo) : [];
    const listing = await files.listLocal(base, main, lo, one(args, 'dir'), strays);
    await files.excludeHints(main, lo, listing, same);
    const { sig, ...rest } = listing;
    return { root: base, ...rest, localOnly: localPart(main, lo, sig) };
  });
  route('/api/live/files/search', async (ctx, root, args, main) => {
    const base = files.realRoot(root);
    const lo = await local.localOnlyOf(main);
    // rebuilt when an agent working in the folder, or in the main folder (where the local-only files are), wrote files
    const sig = writesSig(ctx, base) + (samePath(base, main) ? '' : '|' + writesSig(ctx, main));
    const found = await files.search(base, one(args, 'q'), sig, files.localFiles(main, lo));
    return { root: base, ...found, localOnly: localPart(main, lo) };
  });
  route('/api/live/files/read', async (ctx, root, args, main) => {
    const base = files.realRoot(root);
    const path = one(args, 'path');
    const lo = await local.localOnlyOf(main);
    const isLocal = !!lo && local.isLocalPath(lo, String(path));
    let read: files.FileRead & { local?: true; from?: 'main' };
    if (isLocal && !samePath(base, files.realRoot(main))) {
      // a local-only file is the main folder's own (a copy's stray shows only while main has none)
      try {
        read = { ...files.readFile(main, path), local: true, from: 'main' };
      } catch (error) {
        if (!(error instanceof files.FilesError) || error.status !== 404) throw error;
        read = files.readFile(base, path);
      }
    } else {
      read = files.readFile(base, path);
      if (isLocal) read.local = true;
    }
    const origin = ctx.artifacts?.store.origin ?? '';
    const viewable = (read.image && !read.tooBig) || (read.page && !read.binary && !read.tooBig);
    const viewUrl = viewable && origin
      ? origin + '/f/' + issue(read.abs) + '/' + encodeURIComponent(read.name) + (/\.(md|markdown)$/i.test(read.name) ? '?view=1' : '')
      : '';
    return { root: base, ...read, viewUrl };
  });
  // "Git exclude" on a row (owner decision 3), and its Undo. In a chat's copy, what is there moves into the main folder first (owner
  // Q3); local_only.addEntry does the refusals, the lock and the move.
  post('/api/live/files/exclude', async (ctx, body) => {
    const scope = await scopeFor(ctx, bodyArgs(body));
    if (Array.isArray(scope)) return scope;
    const action = body.action === 'undo' ? 'undo' : body.action === 'add' ? 'add' : '';
    if (!action) return [400, { error: 'Unknown action', code: 'bad_action' }];
    if (action === 'undo') {
      const done = await local.undoEntry(scope.main, String(body.undo ?? ''));
      return [200, { ok: done, localOnly: localPart(scope.main, await local.localOnlyOf(scope.main)) }];
    }
    const path = local.cleanRel(body.path);
    if (path === null) return [400, { error: 'Invalid path', code: 'bad_path' }];
    if (path) files.safeParts(path); // the same path rules as every Files request
    const chatRoot = samePath(scope.root, scope.main) ? undefined : scope.root;
    const result = await local.addEntry(scope.main, path, chatRoot);
    const localOnly = localPart(scope.main, await local.localOnlyOf(scope.main));
    return result.ok ? [200, { ...result, path, localOnly }] : [409, { ...result, localOnly }];
  });
  // The stray warning row's "Move to the shared folder": this chat copy's files under local-only paths go to the main folder now.
  post('/api/live/files/strays/move', async (ctx, body) => {
    const scope = await scopeFor(ctx, bodyArgs(body));
    if (Array.isArray(scope)) return scope;
    const lo = samePath(scope.root, scope.main) ? null : await local.localOnlyOf(scope.main);
    if (!lo) return [200, { moved: [], failed: [] }];
    return [200, await local.moveStrays(scope.root, lo, local.slugOf(scope.root))];
  });
  routes.set('GET /api/live/files/outside', (ctx, url, _body, request) => {
    if (!tokenMatches(request.headers.get('X-Studio-Token') ?? '', ctx.token)) {
      return Promise.resolve([403, { error: 'Invalid local session token' }]);
    }
    const args = parseQs(url.search.slice(1));
    const id = one(args, 'id');
    if (!id || id.length > 600) return Promise.resolve([400, { error: 'Choose a chat', code: 'bad_chat' }]);
    return guarded(async () => {
      const given = outside.checkShape(one(args, 'path'));
      // The guard first, so an unnamed path never tells whether it exists.
      if (!(await mentionedBy(ctx, id, given))) throw new files.FilesError('This chat never named that file', 'not_mentioned', 403);
      const real = outside.resolveOutside(given, dataDirs(ctx));
      const read = outside.readOutside(real, one(args, 'peek') === '1');
      const origin = ctx.artifacts?.store.origin ?? '';
      const viewable = !read.tooBig && (read.image || (read.page && !read.binary)) && one(args, 'peek') !== '1';
      const viewUrl = viewable && origin
        ? origin + '/f/' + issue(read.abs) + '/' + encodeURIComponent(read.name) + (/\.(md|markdown)$/i.test(read.name) ? '?view=1' : '')
        : '';
      return { root: '', ...read, viewUrl, outside: outside.folderLabel(real) };
    });
  });
  return routes;
}

/** AIB's own data folder(s): never shown through the outside route. */
function dataDirs(ctx: WebContext): string[] {
  const out: string[] = [];
  if (ctx.stateDir) out.push(String(ctx.stateDir));
  const local = osp.WIN ? Deno.env.get('LOCALAPPDATA') : '';
  if (local) out.push(osp.join(local, 'AgentStudio'));
  return out;
}

const mentioned = new Map<string, boolean>(); // chat id + path -> named (records only grow, so a yes stays a yes)
/** True when the chat's own record (live events, saved transcript and its subagents) names `path`. */
async function mentionedBy(ctx: WebContext, id: string, path: string): Promise<boolean> {
  const key = id + '|' + osp.normcase(osp.normpath(path));
  if (mentioned.get(key)) return true;
  const stores = (ctx.transcripts as unknown as { stores?: Map<string, { root: string }> }).stores;
  const texts = await outside.chatTexts({
    liveState: (chat) => ctx.host.liveState(chat, 0),
    sessionFile: async (provider, sessionId) => {
      const store = stores?.get(provider);
      return store ? await findSessionFile(provider, store.root, sessionId) : null;
    },
  }, id);
  const yes = outside.mentions(texts, path);
  if (yes) {
    if (mentioned.size > 2000) mentioned.clear();
    mentioned.set(key, true);
  }
  return yes;
}
export const _mentioned = mentioned;
