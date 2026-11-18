/**
 * POST /api/live/project-remove (Deno only, routes.ts DENO_ONLY): "Delete project…" from the project menu.
 *   {check: true, path, projects}   what the dialog needs before it asks: does the folder exist, would a disk delete be refused
 *                                   (and why), Recycle Bin / Trash / permanent, is it a git worktree of another repo. Changes nothing.
 *   {path, disk, expect, projects}  remember the folder as removed from AIB; with disk: true also delete the folder (to the trash
 *                                   inspect() named, `expect` must match a permanent delete). The page has already stopped the
 *                                   project's running chats and moves its chats to Recently deleted itself.
 * `projects` are the other project folders the page knows (a disk delete never touches a folder holding or inside one of them).
 *
 * Decision 6 (build plan 1b, 5.4; worktrees/cleanup.ts): the check also answers `cleanup` {items, silent, skipped}: the chat copies
 * with work that was never merged (this install's, ticked by default in the dialog) and what another AIB install made in the repo
 * (unticked). Removing the project then removes everything this install made there (branches, refs, copies, records, stash entries
 * already in the working tree) plus the ids in `cleanup.remove` (`titles` {provider:sessionId: title} name the chats); never the
 * project's aib-shared/ folder, never a transcript. It runs before a disk delete. An older page sends no `cleanup`: nothing with unmerged
 * work is removed then.
 *
 * POST /api/live/project-add (Deno only): {path} or {paths: [...]}: add projects to AIB (the New project dialog; a page's projects
 * made with that dialog before this version, kept in its own storage). Answers the project preferences view. A git project gets AIB's
 * default local-only `/aib-shared` in its .git/info/exclude (worktrees/local_only.ts ensureDefault; skipped when it commits aib-shared/).
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
import { wslLocOf } from '../platform/location.ts';
import { distroName, hostWhenReady, wslTestHomeEnv } from '../wsl/access.ts';
import { WslHelperError } from '../wsl/contract.ts';
import { realRoot } from '../worktrees/files.ts';
import { defaultsAllowed, ensureDefault } from '../worktrees/local_only.ts';
import { cleanupApply, cleanupScan, liveOf, titlesOf } from './cleanup_routes.ts';
import { confirmView } from '../worktrees/cleanup.ts';
import { Registry as SwarmRegistry } from '../swarm/registry.ts';
import { wslDefaultsAllowed, wslEnsureLocalOnly } from '../wsl/local_only.ts';

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
  /** The running chats (their copies are never removed); absent in older tests. */
  host?: { liveList(): Promise<Record<string, unknown>> | Record<string, unknown> };
  /** The file editor's open texts: a removed project's stored unsaved text goes with it (absent in older tests). */
  liveFiles?: { forgetProject(root: string): void } | null;
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
  const wsl = wslLocOf(path);
  const guard = ctx.guard ? ctx.guard(projects) : defaultGuard(ctx.stateDir, projects);
  const live = await liveOf(ctx.host);
  const titles = titlesOf(body.titles);
  if (body.check === true) {
    const scan = await cleanupScan(ctx.stateDir, path, live, titles);
    const cleanup = scan ? confirmView(scan) : { items: [], silent: 0, skipped: '' };
    if (wsl) return [200, { ok: true, ...await wslCheck(wsl, projects), cleanup }];
    return [200, { ok: true, ...(await inspect(path, guard, ctx.trashLayer)), cleanup }];
  }
  // what AIB made in the repo goes first (a disk delete would leave the copies' links pointing at nothing)
  const ticked = isDict(body.cleanup) && Array.isArray(body.cleanup.remove) ? body.cleanup.remove.filter(isStr).slice(0, 5000) : [];
  let cleaned: { removed: string[]; left: Record<string, string> } = { removed: [], left: {} };
  try {
    cleaned = (await cleanupApply(ctx.stateDir, path, ticked, live, titles)) ?? cleaned;
  } catch (error) {
    console.error('Cleaning up what AIB made in the project failed', error);
  }
  let realPath = '';
  try { // the editor's store names the resolved folder; resolve it before a disk delete takes the folder away
    realPath = realRoot(path);
  } catch { /* not there, or not a local folder: the typed path is all there is */ }
  let disk: string = 'kept';
  if (body.disk === true) {
    try {
      disk = wsl ? await wslTrash(wsl, projects) : await deleteFolder(path, guard, body.expect, ctx.trashLayer);
    } catch (error) {
      if (error instanceof Refused) return [409, { error: error.message, code: 'refused' }];
      return [500, { error: `The folder could not be deleted: ${(error as Error).message}`, code: 'delete_failed' }];
    }
  }
  await ctx.removedProjects.remove(path);
  try { // only AIB's own stored editor text; never the project folder or its aib-shared/ folder
    for (const root of new Set([path, realPath].filter(Boolean))) ctx.liveFiles?.forgetProject(root);
  } catch (error) {
    console.error("Dropping the removed project's stored editor text failed", error);
  }
  if (ctx.addedProjects) await ctx.addedProjects.remove(path);
  try { // the project's helpers whose copies are gone leave swarm-helpers.json (a kept copy keeps its helper's record)
    await new SwarmRegistry(ctx.stateDir).dropProject(path, live);
  } catch (error) {
    console.error("Dropping the removed project's helper records failed", error);
  }
  return [200, { ok: true, disk, removed: ctx.removedProjects.public().removed, cleanup: cleaned }];
}

type WslRef = { distro: string; linuxPath: string };

/** What the delete dialog needs for a folder in a distro (the helper's project.inspect). A distro that is not ready is a refusal line. */
async function wslCheck(wsl: WslRef, projects: string[]): Promise<Json> {
  try {
    const host = await hostWhenReady(wsl.distro);
    return { ...await host.call('project.inspect', wslArgs(wsl, projects)) };
  } catch (error) {
    return { exists: true, refusal: error instanceof Error ? error.message : String(error), trash: 'permanent', worktreeOf: '' };
  }
}

/** "Move folder to trash in Ubuntu": the helper's project.trash (never a permanent delete). Refused when it says no. */
async function wslTrash(wsl: WslRef, projects: string[]): Promise<string> {
  const host = await hostWhenReady(wsl.distro).catch((error) => {
    throw new Refused(error instanceof Error ? error.message : `${distroName(wsl.distro)} is not available to AIB.`);
  });
  try {
    return (await host.call('project.trash', wslArgs(wsl, projects))).disk;
  } catch (error) {
    if (error instanceof WslHelperError && error.code === 'refused') throw new Refused(error.message);
    throw error;
  }
}

/** The helper's params: the folder's Linux path, the other projects of the same distro, and (under test) the trash inside AIB_WSL_ROOT. */
function wslArgs(wsl: WslRef, projects: string[]): { path: string; projects: string[]; dataHome?: string } {
  const others = projects.map((p) => wslLocOf(p)).filter((l): l is NonNullable<typeof l> => !!l && l.distro === wsl.distro).map((l) => l.linuxPath);
  let dataHome: string | undefined;
  try {
    dataHome = wslTestHomeEnv().XDG_DATA_HOME; // under test: never the owner's own trash
  } catch {
    throw new Refused('Test guard: a WSL delete under test needs AIB_WSL_ROOT');
  }
  return { path: wsl.linuxPath, projects: others, ...(dataHome ? { dataHome } : {}) };
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
export async function projectAdd(
  added: AddedProjects,
  body: unknown,
  removed: RemovedProjects | null = null,
  stateDir = '',
): Promise<void> {
  if (!isDict(body)) throw new ValueError('Invalid request');
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 100) : [body.path];
  if (!paths.length || !paths.every((p) => isStr(p) && p.trim() && p.length <= 1024 && projectKey(p))) {
    throw new ValueError('Choose a project folder');
  }
  await added.add(...paths);
  // the default local-only /aib-shared (idempotent, never throws; not a git folder: nothing). A test Studio (temp or no state folder)
  // writes it only for projects in the temp folder, never into a real repo's .git/info/exclude (local_only.defaultsAllowed).
  await Promise.all(paths.filter((p) => defaultsAllowed(stateDir, String(p))).map((p) => ensureDefault(String(p))));
  // a WSL project: the same in its distro, by the helper (wsl/local_only.ts; never throws), without holding the reply up
  for (const p of paths) if (wslLocOf(String(p)) && wslDefaultsAllowed(stateDir, String(p))) void wslEnsureLocalOnly(String(p));
  if (removed) await bringBack(removed, paths); // adding a removed project again brings its chats back too
}

/** The folder a saved chat is filed under (sidebar-ui.js rootOf before the worktree step): its projectRoot, else its cwd. */
export const folderOfSession = (item: unknown): unknown => isDict(item) ? (item.projectRoot || item.cwd) : '';

/**
 * Saved chats of added projects only (the rest of the agents' history is not shown in AIB). `conversations` keeps the chats in
 * Recently deleted listed there (a removed project's chats, so restoring one still brings its project back).
 */
export function filterSessions<T>(added: AddedProjects, sessions: T[], conversations: ConversationState | null = null): T[] {
  const entries = conversations ? conversations.public().entries : {};
  const deleted = (item: unknown) => {
    if (!isDict(item) || !isStr(item.provider)) return false;
    const id = isStr(item.id) ? item.id : isStr(item.sessionId) ? item.sessionId : '';
    return !!id && !!entries[`${item.provider}:${id}`]?.deletedAt;
  };
  return sessions.filter((item) => added.shows(folderOfSession(item)) || deleted(item));
}

/** The pages "Find more chats via agent" reads at most per click, skipping pages that had no chat of an added project. */
export const DISCOVER_PAGES = 5;

/**
 * POST /api/live/discover: the agent's session/list, chats of added projects only. A page whose chats are all elsewhere is
 * skipped (the next one is asked, up to DISCOVER_PAGES), so the button never answers "0 more" while more exist.
 */
export async function discoverAdded(
  call: (body: Json) => Promise<[number, unknown]>,
  added: AddedProjects,
  body: Json | null,
): Promise<[number, unknown]> {
  let request: Json = { ...(body ?? {}) };
  for (let page = 1;; page++) {
    const [status, payload] = await call(request);
    if (status !== 200 || !isDict(payload) || !Array.isArray(payload.sessions)) return [status, payload];
    payload.sessions = filterSessions(added, payload.sessions);
    const next = payload.nextCursor;
    if ((payload.sessions as unknown[]).length || !isStr(next) || !next || page >= DISCOVER_PAGES) return [status, payload];
    request = { ...request, cursor: next };
  }
}
