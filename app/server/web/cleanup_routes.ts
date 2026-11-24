/**
 * Decision 6 cleanup, the web side (worktrees/cleanup.ts does the git work; a WSL project's runs in its distro's helper through
 * wsl/worktrees.ts). Build plan 1b, sections 5.4, 5.6 and 5.7.
 *
 *   POST /api/live/cleanup/all {mode: 'check'}      "Remove AIB's data from my repos" (Settings; what an uninstaller calls): for every
 *                                                   added project, what would go silently and what has unmerged work. Changes nothing.
 *   POST /api/live/cleanup/all {mode: 'apply', remove: {<project>: [ids]}}
 *                                                   project removal's cleanup for every added project (5.7): this install's items
 *                                                   without unmerged work plus the ticked ids. aib-shared/ folders stay; the projects
 *                                                   stay in AIB.
 *
 * Running chats' copies are never touched (the live list). Old copy chats and the leftovers from before folder chats are tidied by
 * the owner's one-off migration script (work/migrate/folder_chats_migrate.ts), not by the app.
 */
import { isDict, isStr, ValueError } from '../core/py.ts';
import * as cleanup from '../worktrees/cleanup.ts';
import { wslCleanupApply, wslCleanupScan } from '../wsl/worktrees.ts';

type Json = Record<string, unknown>;
type Lister = {
  liveList(): Promise<Record<string, unknown>> | Record<string, unknown>;
  liveCall?(op: string, body: Record<string, unknown>): Promise<[number, unknown]> | [number, unknown];
};

/** Folders and provider:sessionId of the chats that run now. */
export async function liveOf(host: Lister | undefined | null): Promise<string[]> {
  if (!host) return [];
  try {
    const listing = await host.liveList();
    const out: string[] = [];
    for (const c of Array.isArray(listing.connections) ? listing.connections : []) {
      if (!isDict(c) || c.closed) continue;
      if (isStr(c.cwd) && c.cwd) out.push(c.cwd);
      if (isStr(c.provider) && isStr(c.sessionId) && c.sessionId) out.push(`${c.provider}:${c.sessionId}`);
    }
    return out;
  } catch {
    return [];
  }
}

/** The page's chat titles {provider:sessionId: title} (bounded). */
export function titlesOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isDict(raw)) return out;
  for (const [k, v] of Object.entries(raw).slice(0, 2000)) {
    if (isStr(v) && k.length < 600) Object.defineProperty(out, k, { value: v.slice(0, 200), enumerable: true, writable: true });
  }
  return out;
}

function named(scan: cleanup.Scan, titles: Record<string, string>): cleanup.Scan {
  return {
    ...scan,
    items: scan.items.map((i) => (i.session && Object.hasOwn(titles, i.session) ? { ...i, title: titles[i.session] } : i)),
  };
}

/** One project's scan (WSL: in its distro; null when the distro cannot be asked). */
export async function cleanupScan(
  stateDir: string,
  project: string,
  live: string[],
  titles: Record<string, string> = {},
): Promise<cleanup.Scan | null> {
  if (project.startsWith('wsl://')) {
    const scan = await wslCleanupScan(project, live);
    return scan ? named(scan as unknown as cleanup.Scan, titles) : null;
  }
  return await cleanup.scanProject(stateDir, project, { live, titles });
}

/** One project's removal: this install's items without unmerged work plus `ticked`. */
export async function cleanupApply(
  stateDir: string,
  project: string,
  ticked: string[],
  live: string[],
  titles: Record<string, string> = {},
  only?: string[],
): Promise<{ removed: string[]; left: Record<string, string>; scan: cleanup.Scan } | null> {
  if (project.startsWith('wsl://')) {
    const done = await wslCleanupApply(project, ticked, false, live, only);
    return done ? { ...done, scan: done.scan as unknown as cleanup.Scan } : null;
  }
  const done = await cleanup.applyProject(stateDir, project, ticked, { live, titles, ...(only ? { only } : {}) });
  for (const id of done.removed) cleanup.logLine(stateDir, `project cleanup: ${project}: removed ${id}`);
  for (const [id, why] of Object.entries(done.left)) cleanup.logLine(stateDir, `project cleanup: ${project}: left ${id}: ${why}`);
  return done;
}

export interface CleanupContext {
  stateDir: string;
  host: Lister;
  addedProjects: { public(): { added: Record<string, unknown> } };
}

/** Every added project's folder (and WSL ref). */
export function addedPaths(ctx: CleanupContext): string[] {
  return Object.values(ctx.addedProjects.public().added)
    .map((a) => (isDict(a) && isStr(a.path) ? a.path : ''))
    .filter(Boolean);
}

/**
 * Once the keeper take-over at start is done (main.ts): merged helpers' copies of closed chats go, and stopped helpers' copies after
 * 7 days (the agent host does it: it knows which chats run anywhere). Never throws.
 */
export async function retireAtStart(ctx: CleanupContext): Promise<void> {
  try {
    if (ctx.host.liveCall) await ctx.host.liveCall('worktree-retire', {});
  } catch (error) {
    cleanup.logLine(ctx.stateDir, `retiring helper copies failed: ${error instanceof Error ? error.message : error}`);
  }
}

/** "Remove AIB's data from my repos" (5.7). */
export async function allRoute(ctx: CleanupContext, body: unknown): Promise<[number, Json]> {
  if (!isDict(body) || (body.mode !== 'check' && body.mode !== 'apply')) throw new ValueError('The mode must be check or apply');
  const live = await liveOf(ctx.host);
  const titles = titlesOf(body.titles);
  const projects = [...new Set([...addedPaths(ctx), ...cleanup.recordedProjects(ctx.stateDir)])];
  const out: Json[] = [];
  const remove = isDict(body.remove) ? body.remove : {};
  for (const project of projects) {
    if (body.mode === 'check') {
      const scan = await cleanupScan(ctx.stateDir, project, live, titles);
      if (scan) out.push({ project, ...cleanup.confirmView(scan) });
      continue;
    }
    const raw = Object.hasOwn(remove, project) ? remove[project] : [];
    const ticked = Array.isArray(raw) ? raw.filter(isStr).slice(0, 5000) : [];
    const done = await cleanupApply(ctx.stateDir, project, ticked, live, titles);
    if (done) out.push({ project, removed: done.removed, left: done.left, skipped: done.scan.skipped });
  }
  return [200, { ok: true, mode: body.mode, projects: out }];
}
