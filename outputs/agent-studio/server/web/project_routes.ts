/**
 * POST /api/live/project-remove (Deno only, routes.ts DENO_ONLY): "Delete project…" from the project menu.
 *   {check: true, path, projects}   what the dialog needs before it asks: does the folder exist, would a disk delete be refused
 *                                   (and why), Recycle Bin / Trash / permanent, is it a git worktree of another repo. Changes nothing.
 *   {path, disk, expect, projects}  remember the folder as removed from AIB; with disk: true also delete the folder (to the trash
 *                                   inspect() named, `expect` must match a permanent delete). The page has already stopped the
 *                                   project's running chats and moves its chats to Recently deleted itself.
 * `projects` are the other project folders the page knows (a disk delete never touches a folder holding or inside one of them).
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

type Json = Record<string, unknown>;

export interface ProjectRemoveContext {
  stateDir: string;
  conversations: ConversationState;
  removedProjects: RemovedProjects;
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
  return [200, { ok: true, disk, removed: ctx.removedProjects.public().removed }];
}

/** A new chat started in a removed folder brings the project back. */
export async function afterConnect(removed: RemovedProjects, body: unknown, status: number): Promise<void> {
  if (status === 200 && isDict(body)) await bringBack(removed, [body.cwd, body.projectRoot]);
}

/** Restoring a chat from Recently deleted brings its project back. Read the chat's folders before the restore (a restored mark with
 * nothing else on it is dropped), then call bringBack() with them once it succeeded. */
export function restoreFolders(conversations: ConversationState, body: unknown): unknown[] {
  if (!isDict(body) || body.action !== 'restore' || !isStr(body.provider) || !isStr(body.sessionId)) return [];
  const entry = conversations.public().entries[`${body.provider}:${body.sessionId}`];
  return [body.projectRoot, body.cwd, entry?.projectRoot, entry?.cwd];
}
export async function bringBack(removed: RemovedProjects, folders: unknown[]): Promise<void> {
  if (!folders.length) return;
  try {
    await removed.forget(...folders);
  } catch (error) {
    console.error('Bringing a removed project back failed', error);
  }
}
