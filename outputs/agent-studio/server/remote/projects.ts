/**
 * The project a chat belongs to, as the phone shows it on chat cards, in the "All projects" filter and in the chat header:
 * a short id (a hash of the PC's project key: no folder path goes to the phone), the project's name as the PC shows it (your
 * name for it, else the folder's name) and its colour.
 *
 * Same rules as the PC page (workspace-state.js, loaded here as it is): a chat in a git worktree is filed under the repository it
 * belongs to; the colour is the one you picked in the project menu, else the automatic one, where projects next to each other in
 * the PC's project order (your saved order first, the rest by name) never share a colour while the palette has room. The order is
 * made from the added projects plus the projects of the chats listed, so it is the PC's list.
 */
import '../../notify-rules.js';
import '../../workspace-state.js';
import { createHash } from 'node:crypto';
import type { WebContext } from '../web/server.ts';
import { projectKey } from '../desktop/project_delete.ts';

export interface PhoneProject {
  /** A hash of the PC's project key (stable, no path). */
  id: string;
  name: string;
  /** A palette id of the PC (blue, sky, teal, indigo, violet, orchid, pink, slate). */
  color: string;
}

interface WorkspaceState {
  applyPrefs(projects: { key: string; name: string; autoName: string }[], prefs: unknown): { key: string; colorId: string }[];
}
const WS = (globalThis as unknown as { AgentWorkspaceState: WorkspaceState }).AgentWorkspaceState;

const leaf = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const last = parts.at(-1) ?? '';
  return /^[a-zA-Z]:$/.test(last) ? '' : last;
};

export const projectId = (key: string): string => createHash('sha256').update('aib-phone-project|' + key).digest('hex').slice(0, 12);

/**
 * A lookup for this answer: folder (a chat's projectRoot, else its cwd) -> its project. `folders` are every folder the answer
 * names, so the colours are given over the whole list at once.
 */
export function projectsFor(ctx: WebContext, folders: string[]): (folder: string) => PhoneProject {
  const prefs = ctx.projectPrefs.public();
  const custom = (key: string) => {
    const p = (prefs.projects as Record<string, { name?: string }>)[key];
    return p && typeof p.name === 'string' ? p.name : '';
  };
  const byKey = new Map<string, { key: string; name: string; autoName: string }>();
  const add = (root: string) => {
    const key = projectKey(root);
    if (!key || byKey.has(key)) return key;
    const auto = leaf(root) || 'No folder';
    byKey.set(key, { key, name: custom(key) || auto, autoName: auto });
    return key;
  };
  let added: Record<string, { path: string }> = {};
  try {
    added = ctx.addedProjects.public().added;
  } catch { /* no added projects */ }
  for (const item of Object.values(added)) if (item && typeof item.path === 'string') add(item.path);
  const rootOf = new Map<string, string>();
  const keyOf = (folder: string): string => {
    if (rootOf.has(folder)) return rootOf.get(folder)!;
    let root = folder;
    try {
      root = ctx.addedProjects.projectFolder(folder);
    } catch { /* the folder itself */ }
    const key = add(root) || 'none';
    rootOf.set(folder, key);
    return key;
  };
  for (const f of folders) if (f) keyOf(f);
  const colors = new Map<string, string>();
  try {
    for (const p of WS.applyPrefs([...byKey.values()], prefs)) colors.set(p.key, p.colorId);
  } catch { /* no colours: the phone draws a neutral mark */ }
  return (folder: string) => {
    const key = folder ? keyOf(folder) : 'none';
    const p = byKey.get(key);
    return { id: projectId(key), name: p ? p.name : 'No folder', color: colors.get(key) ?? '' };
  };
}
