/**
 * "AIB removed itself from this distro" (docs/wsl/linking-design.md section 13; wsl/remove.ts sets it), kept in the Windows state
 * folder as `wsl-removed.json` so it outlives an AIB restart:
 *   - distros: {<folded distro>: {at}}: while set, wsl/access.ts wslHost() and peekWslHost() give no host for that distro, so nothing
 *     (a chat, the take-over at start, a Files view) can start it and install AIB into it again. Only an explicit start (Settings'
 *     "Set up again" / "Start Ubuntu and check", or Reconnect) clears it (wsl_routes.ts).
 *   - worktrees: {<folded distro>: [{path, project, branch, session}]}: the chat copies Remove deleted, so a chat that worked in one
 *     reads as "workspace removed" (wsl/worktrees.ts wslIsRemoved) instead of quietly working in its project folder. Kept after Set up
 *     again (the copies stay gone); at most MAX_WORKTREES per distro.
 * Without a state folder (unit tests that set none) the flags live in memory only.
 */
import { wslStateDir } from './hosts.ts';

export const FILE = 'wsl-removed.json';
export const MAX_WORKTREES = 2000;

export interface RemovedWorktree {
  path: string;
  project: string;
  branch: string;
  session: string;
}

interface State {
  distros: Record<string, { at: number }>;
  worktrees: Record<string, RemovedWorktree[]>;
}

let memory: State = { distros: {}, worktrees: {} };
let dirForTests: string | null | undefined;

/** Tests: where the file goes (null: memory only; undefined: the hosts' state folder). Clears the memory copy. */
export function setRemovedDir(dir: string | null | undefined): void {
  dirForTests = dir;
  memory = { distros: {}, worktrees: {} };
}

function file(): string | null {
  const dir = dirForTests === undefined ? wslStateDir() : dirForTests;
  return dir ? `${dir.replace(/[\\/]+$/, '')}${Deno.build.os === 'windows' ? '\\' : '/'}${FILE}` : null;
}

function read(): State {
  const path = file();
  if (!path) return memory;
  try {
    const raw = JSON.parse(Deno.readTextFileSync(path));
    const distros = raw && typeof raw.distros === 'object' && !Array.isArray(raw.distros) ? raw.distros : {};
    const worktrees = raw && typeof raw.worktrees === 'object' && !Array.isArray(raw.worktrees) ? raw.worktrees : {};
    return { distros, worktrees };
  } catch {
    return { distros: {}, worktrees: {} };
  }
}

function write(state: State): void {
  const path = file();
  if (!path) {
    memory = state;
    return;
  }
  const part = `${path}.part`;
  Deno.writeTextFileSync(part, JSON.stringify(state, null, 1));
  Deno.renameSync(part, path);
}

const fold = (distro: string) => String(distro ?? '').toLowerCase();

/** Did this AIB remove itself from the distro (and nobody started it again since)? */
export function isDistroRemoved(distro: string): boolean {
  return Object.hasOwn(read().distros, fold(distro));
}

export function markDistroRemoved(distro: string): void {
  const state = read();
  state.distros[fold(distro)] = { at: Date.now() };
  write(state);
}

/** The explicit start ("Set up again"): the distro may be started and AIB installed into it again. */
export function clearDistroRemoved(distro: string): void {
  const state = read();
  if (!Object.hasOwn(state.distros, fold(distro))) return;
  delete state.distros[fold(distro)];
  write(state);
}

/** Remember the chat copies Remove deleted (newest last, at most MAX_WORKTREES). */
export function addRemovedWorktrees(distro: string, items: RemovedWorktree[]): void {
  if (!items.length) return;
  const state = read();
  const key = fold(distro);
  const list = [...(state.worktrees[key] ?? []).filter((w) => !items.some((i) => i.path === w.path)), ...items];
  state.worktrees[key] = list.slice(-MAX_WORKTREES);
  write(state);
}

/** Was the chat copy at `linuxPath` (or the saved chat `session`, 'provider:id') deleted by Remove? */
export function worktreeRemovedByRemove(distro: string, linuxPath: string, session: string | null): boolean {
  const list = read().worktrees[fold(distro)] ?? [];
  return list.some((w) => w.path === linuxPath || linuxPath.startsWith(w.path + '/') || (!!session && w.session === session));
}
