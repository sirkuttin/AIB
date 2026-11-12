/**
 * POST /api/live/project-remove (Deno only, routes.ts DENO_ONLY): "Delete project…" from the project menu.
 *   {check: true, path, projects}   what the dialog needs before it asks: does the folder exist, would a disk delete be refused
 *                                   (and why), Recycle Bin / Trash / permanent, is it a git worktree of another repo. Changes nothing.
 *   {path, disk, expect, projects}  remember the folder as removed from AIB; with disk: true also delete the folder (to the trash
 *                                   inspect() named, `expect` must match a permanent delete). The page has already stopped the
 *                                   project's running chats and moves its chats to Recently deleted itself.
 * `projects` are the other project folders the page knows (a disk delete never touches a folder holding or inside one of them).
 *
 * POST /api/live/project-add (Deno only): {path} or {paths: [...]}: add projects to AIB (the New project dialog; a page's projects
 * made with that dialog before this version, kept in its own storage). Answers the project preferences view.
 *
 * The added-projects list (desktop/added_projects.ts): a project is in AIB only when the user added it. Saved chats of other
 * folders are left out of /api/sessions and of the agent's session/list answer ("Find more chats via agent") by filterSessions.
 */
import { isDict, isStr, ValueError } from '../core/py.ts';
import {
  defaultGuard,
  deleteFolder,
  type Guard,
  inspect,
  projectKey,
  Refused,
  type RemovedProjects,
  type TrashLayer,
} from '../desktop/project_delete.ts';
import type { ConversationState } from '../state/store.ts';
import type { AddedProjects } from '../desktop/added_projects.ts';

type Json = Record<string, unknown>;

export interface ProjectRemoveContext {
  stateDir: string;
  conversations: ConversationState;
  removedProjects: RemovedProjects;
  /** The projects the user added: a removed project leaves it (absent in older tests). */
  addedProjects?: AddedProjects;
  /** Tests pass a mocked trash layer and guard. */
  trashLayer?: TrashLayer;
  guard?: (projects: string[]) => Guard;
}

function otherProjects(ctx: ProjectRemoveContext, body: Json, path: string): string[] {
  const own = projectKey(path);
  const out = new Set<string>();
  for (const p of Array.isArray(body.projects) ? body.projects.slice(0, 500) : []) if (isStr(p) && p.length < 1024) out.add(p);
  for (const entry of Object.values(ctx.conversations.public().entries)) {
    if (!entry.deletedAt && entry.projectRoot) out.add(entry.projectRoot);
  }
  return [...out].filter((p) => projectKey(p) && projectKey(p) !== own);
}

export async function projectRemove(ctx: ProjectRemoveContext, body: unknown): Promise<[number, Json]> {
  if (!isDict(body)) throw new ValueError('Invalid request');
  const path = isStr(body.path) ? body.path.trim() : '';
  if (!path || path.length > 1024 || !projectKey(path)) throw new ValueError('Choose a project folder');
  const projects = otherProjects(ctx, body, path);
  const guard = ctx.guard ? ctx.guard(projects) : defaultGuard(ctx.stateDir, projects);
  if (body.check === true) return [200, { ok: true, ...(await inspect(path, guard, ctx.trashLayer)) }];
  let disk: string = 'kept';
  if (body.disk === true) {
    try {
      disk = await deleteFolder(path, guard, body.expect, ctx.trashLayer);
    } catch (error) {
      if (error instanceof Refused) return [409, { error: error.message, code: 'refused' }];
      return [500, { error: `The folder could not be deleted: ${(error as Error).message}`, code: 'delete_failed' }];
    }
  }
  await ctx.removedProjects.remove(path);
  if (ctx.addedProjects) await ctx.addedProjects.remove(path);
  return [200, { ok: true, disk, removed: ctx.removedProjects.public().removed }];
}

/** A new chat started in a folder adds it as a project (a worktree chat adds its main checkout), and brings a removed one back. */
export async function afterConnect(
  removed: RemovedProjects,
  body: unknown,
  status: number,
  added: AddedProjects | null = null,
  payload: unknown = null,
): Promise<void> {
  if (status !== 200 || !isDict(body)) return;
  const root = isDict(payload) && isStr(payload.projectRoot) && payload.projectRoot ? payload.projectRoot : body.projectRoot;
  await bringBack(removed, [body.cwd, body.projectRoot, root]);
  if (added) await addQuietly(added, [isStr(root) && root ? root : body.cwd]);
}

/** Restoring a chat from Recently deleted brings its project back. Read the chat's folders before the restore (a restored mark with
 * nothing else on it is dropped), then call bringBack() with them once it succeeded. */
export function restoreFolders(conversations: ConversationState, body: unknown): unknown[] {
  if (!isDict(body) || body.action !== 'restore' || !isStr(body.provider) || !isStr(body.sessionId)) return [];
  const entry = conversations.public().entries[`${body.provider}:${body.sessionId}`];
  return [body.projectRoot, body.cwd, entry?.projectRoot, entry?.cwd];
}
export async function bringBack(removed: RemovedProjects, folders: unknown[], added: AddedProjects | null = null): Promise<void> {
  if (!folders.length) return;
  try {
    await removed.forget(...folders);
  } catch (error) {
    console.error('Bringing a removed project back failed', error);
  }
  // A restored chat's project is added again (its project folder: the first folder named).
  if (added) await addQuietly(added, [folders.find((f) => isStr(f) && f)]);
}

async function addQuietly(added: AddedProjects, folders: unknown[]): Promise<void> {
  try {
    await added.add(...folders);
  } catch (error) {
    console.error('Adding the project failed', error);
  }
}

/** POST /api/live/project-add: {path} or {paths}. */
export async function projectAdd(added: AddedProjects, body: unknown, removed: RemovedProjects | null = null): Promise<void> {
  if (!isDict(body)) throw new ValueError('Invalid request');
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 100) : [body.path];
  if (!paths.length || !paths.every((p) => isStr(p) && p.trim() && p.length <= 1024 && projectKey(p))) {
    throw new ValueError('Choose a project folder');
  }
  await added.add(...paths);
  if (removed) await bringBack(removed, paths); // adding a removed project again brings its chats back too
}

/** The folder a saved chat is filed under (sidebar-ui.js rootOf before the worktree step): its projectRoot, else its cwd. */
export const folderOfSession = (item: unknown): unknown => isDict(item) ? (item.projectRoot || item.cwd) : '';

/**
 * Saved chats of added projects only (the rest of the agents' history is not shown in AIB). `conversations` keeps the chats in
 * Recently deleted listed there (a removed project's chats, so restoring one still brings its project back).
 */
export async function filterSessions<T>(added: AddedProjects, sessions: T[], conversations: ConversationState | null = null): Promise<T[]> {
  try {
    await added.ready();
  } catch (error) {
    console.error('The added-projects list could not be made; every saved chat is listed for now', error);
    return sessions;
  }
  const entries = conversations ? conversations.public().entries : {};
  const deleted = (item: unknown) => {
    if (!isDict(item) || !isStr(item.provider)) return false;
    const id = isStr(item.id) ? item.id : isStr(item.sessionId) ? item.sessionId : '';
    return !!id && !!entries[`${item.provider}:${id}`]?.deletedAt;
  };
  return sessions.filter((item) => added.shows(folderOfSession(item)) || deleted(item));
}

/**
 * The folders of every project the page listed before this version (an existing user's first list): saved chats with messages,
 * AIB's own chat records that are not deleted, the open and recovered chats; minus the projects removed with "Delete project…".
 */
export async function visibleFolders(ctx: {
  transcripts: { sessions(): Promise<Record<string, unknown>[]> };
  conversations: ConversationState;
  removedProjects: RemovedProjects;
  host: { liveList(): Promise<unknown> };
}): Promise<string[]> {
  const out: unknown[] = [];
  for (const item of await ctx.transcripts.sessions()) if (item.hasMessages) out.push(folderOfSession(item));
  for (const entry of Object.values(ctx.conversations.public().entries)) if (!entry.deletedAt) out.push(entry.projectRoot || entry.cwd);
  try {
    const live = await ctx.host.liveList();
    if (isDict(live)) {
      for (const c of Array.isArray(live.connections) ? live.connections : []) if (isDict(c) && !c.closed) out.push(c.projectRoot || c.cwd);
      for (const r of Array.isArray(live.recovered) ? live.recovered : []) if (isDict(r)) out.push(r.projectRoot || r.cwd);
    }
  } catch { /* the agent host is not up: its chats are AIB's own and get added when they connect */ }
  const removed = ctx.removedProjects.public().removed;
  return out.filter((f): f is string => isStr(f) && !!f.trim() && !Object.hasOwn(removed, projectKey(f)));
}
