/**
 * The Files view's routes (Deno only: routes.ts DENO_ONLY). All three take the chat (`id`: a live connection id or a
 * 'provider:sessionId' key) and which of its folders (`root`: 'chat', its own folder or worktree; 'main', the main checkout of a
 * worktree chat). The folder is the one Studio already knows for that chat (chat_folders.changesFolder): nothing from the request is
 * used as a folder, and the paths it sends are relative to that folder and checked to stay inside it (worktrees/files.ts).
 *   GET /api/live/files/list?id&root&dir      one folder: entries with ignored flag, change letter, changed count
 *   GET /api/live/files/search?id&root&q      the best 200 file names from a cached index (rebuilt when the agent writes files)
 *   GET /api/live/files/read?id&root&path     a text file up to 1 MB (binary detected); `viewUrl` for images and pages, served
 *                                             read only by the artifact origin (file_tickets.ts), never as an artifact
 * Needs the Studio token, like the Changes routes.
 */
import { isStr } from '../core/py.ts';
import { parseQs } from '../artifacts/origin.ts';
import { changesFolder } from '../worktrees/chat_folders.ts';
import * as files from '../worktrees/files.ts';
import { mainCheckoutOf, recordForPath } from '../worktrees/worktrees.ts';
import * as osp from '../platform/ospath.ts';
import { isNetworkPath, tokenMatches } from './security.ts';
import { issue } from './file_tickets.ts';
import { chatStudioOf, savedFolders } from './studio_routes.ts';
import type { WebContext } from './server.ts';

type Reply = [number, unknown];
type Handler = (ctx: WebContext, url: URL, body: unknown, request: Request) => Promise<Reply>;

const one = (args: Record<string, string[]>, name: string, fallback = '') => (Object.hasOwn(args, name) ? args[name][0] : fallback);

/** The folder a Files request works in, or a reply that refuses. */
export async function rootFor(ctx: WebContext, args: Record<string, string[]>): Promise<string | Reply> {
  const id = one(args, 'id');
  let cwd: string | null;
  try {
    cwd = await changesFolder(chatStudioOf(ctx, await savedFolders(ctx, id)), id);
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
  const route = (path: string, work: (ctx: WebContext, root: string, args: Record<string, string[]>) => Promise<unknown> | unknown) => {
    routes.set(`GET ${path}`, async (ctx, url, _body, request) => {
      if (!tokenMatches(request.headers.get('X-Studio-Token') ?? '', ctx.token)) return [403, { error: 'Invalid local session token' }];
      const args = parseQs(url.search.slice(1));
      const root = await rootFor(ctx, args);
      if (typeof root !== 'string') return root;
      return guarded(() => work(ctx, root, args));
    });
  };
  route('/api/live/files/list', async (_ctx, root, args) => {
    const base = files.realRoot(root);
    return { root: base, ...(await files.listDir(base, one(args, 'dir'))) };
  });
  route('/api/live/files/search', async (ctx, root, args) => {
    const base = files.realRoot(root);
    return { root: base, ...(await files.search(base, one(args, 'q'), writesSig(ctx, base))) };
  });
  route('/api/live/files/read', (ctx, root, args) => {
    const base = files.realRoot(root);
    const read = files.readFile(base, one(args, 'path'));
    const origin = ctx.artifacts?.store.origin ?? '';
    const viewable = (read.image && !read.tooBig) || (read.page && !read.binary && !read.tooBig);
    const viewUrl = viewable && origin
      ? origin + '/f/' + issue(read.abs) + '/' + encodeURIComponent(read.name) + (/\.(md|markdown)$/i.test(read.name) ? '?view=1' : '')
      : '';
    return { root: base, ...read, viewUrl };
  });
  return routes;
}
