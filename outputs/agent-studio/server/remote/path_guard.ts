/**
 * The one blocked-folder guard for remote computers (design v2 section 9, architect review MF9 and v2 fix 3). Every route a computer
 * can reach that takes a path (Files, Download, files/outside, artifacts/preview, folders/*, branch, connect, project-add, docs/open,
 * the terminal's cwd) calls this module; nothing builds its own list.
 *
 * Refused, even inside an added project:
 *   AIB's state folder (device store, VAPID private key, artifact-key secret, page sessions), and %LOCALAPPDATA%\AgentStudio
 *   the agents' sign-ins: ~/.claude, ~/.codex, ~/.gemini; and ~/.ssh
 *   internal defaults: ~/.aws, ~/.azure, ~/.config/gh, ~/.docker, ~/.kube, and the files ~/.npmrc and ~/.git-credentials
 * The same home names are refused inside WSL distros (/root/… and /home/<user>/…). UNC and device paths are refused outright.
 *
 * Paths are compared lexically ('..' resolved, '/' and '\' alike, case-folded on Windows) and, when the path exists, again by its
 * real path, so a junction or symlink into a blocked folder is refused too.
 *
 * Also here: the project-root rule (a path must be inside a folder the owner added to AIB) and the "not a home folder or a drive root
 * as a project" rule for the routes that add projects.
 */
import { isNetworkPath } from '../web/security.ts';
import { isForeignPath, wslLocOf } from '../platform/location.ts';
import { BETA_AGENTS } from '../agents/beta_catalog.ts';

const WIN = Deno.build.os === 'windows';

/** Folders under a home folder (Windows or Linux) a remote computer never reaches: the built-in agents' sign-ins (Claude Code, Codex,
 * Gemini, OMP), the internal defaults, and every beta agent's sign-in folders from its catalog entry (agents/beta_catalog.ts). */
export const BLOCKED_HOME_DIRS: readonly string[] = [
  ...new Set([
    '.claude',
    '.codex',
    '.gemini',
    '.omp',
    '.ssh',
    '.aws',
    '.azure',
    '.config/gh',
    '.docker',
    '.kube',
    ...BETA_AGENTS.flatMap((a) => a.signinDirs ?? []),
  ]),
];

/**
 * Environment variables that move an agent's sign-in folder, with the part under them that is the folder ('' : the folder itself).
 * Each one that is set to an absolute path is blocked too (an owner with a custom config folder is covered like ~/.claude).
 * GEMINI_CLI_HOME is the home folder Gemini CLI puts its .gemini folder in.
 */
export const MOVED_SIGNIN_ENV: readonly (readonly [string, string])[] = [
  ['CLAUDE_CONFIG_DIR', ''],
  ['CODEX_HOME', ''],
  ['GEMINI_CLI_HOME', '.gemini'],
  ...BETA_AGENTS.flatMap((a) => (a.signinEnv ?? []).map((name) => [name, ''] as const)),
];

/** The sign-in folders the environment moved, as set now (absolute paths only). */
export function movedSigninDirs(env: (name: string) => string | undefined = (n) => Deno.env.get(n)): string[] {
  const out: string[] = [];
  for (const [name, under] of MOVED_SIGNIN_ENV) {
    const value = (env(name) ?? '').trim();
    if (value && isAbsolute(value)) out.push(under ? `${value}/${under}` : value);
  }
  return out;
}

/**
 * A path a remote computer may name: a drive path (C:\…, also \\?\C:\…) on Windows, a '/' path elsewhere. Anything else (a relative
 * path, 'C:x', '\x') would be resolved against a folder AIB picks (the process's or the chat's), so it is never checked as sent:
 * isBlocked treats it as blocked (security review MF1).
 */
export function isAbsolute(path: string, windows = WIN): boolean {
  const text = path.trim();
  if (windows) return /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]{2}\?[\\/][A-Za-z]:[\\/]/.test(text);
  return text.startsWith('/');
}
/** Files directly in a home folder a remote computer never reads. */
export const BLOCKED_HOME_FILES: readonly string[] = ['.npmrc', '.git-credentials'];

export class BlockedPath extends Error {
  readonly status = 403;
  constructor(readonly code: 'blocked_folder' | 'outside_projects' | 'not_a_project' | 'bad_path', message: string) {
    super(message);
  }
}

export const BLOCKED_MESSAGE = 'This folder holds sign-ins or AIB data. Open it on the PC itself.';

function homeDir(): string {
  return (WIN ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME')) ?? Deno.env.get('HOME') ?? '';
}

/** A Windows or POSIX path made comparable: '\' as '/', '..' and '.' resolved, no trailing '/', case-folded on Windows. */
export function normal(path: string, windows = WIN): string {
  let text = path.trim().replace(/\\/g, '/');
  if (windows) text = text.replace(/^\/\/\?\//, '');
  const drive = windows ? /^[A-Za-z]:/.exec(text)?.[0] ?? '' : '';
  const rest = text.slice(drive.length);
  const out: string[] = [];
  for (const part of rest.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  const joined = `${drive}/${out.join('/')}`;
  return windows ? joined.toLowerCase() : joined;
}

/** True when `child` is `root` or inside it (both already normal()). */
export function within(child: string, root: string): boolean {
  if (!root) return false;
  if (child === root) return true;
  return child.startsWith(root.endsWith('/') ? root : root + '/');
}

/**
 * The blocked places of this PC, normal(): AIB's state folders (`states`), the home folders' sign-in folders (`dirs`) and files
 * (`files`). In a state folder, <state>/worktrees is the one open part: the chats' own copies of the projects (a worktree chat works
 * there; worktrees/worktrees.ts), not AIB's data.
 */
export function blockedRoots(stateDir: string | null, home = homeDir()): { states: string[]; dirs: string[]; files: string[] } {
  const states: string[] = [];
  const dirs: string[] = [];
  const files: string[] = [];
  if (stateDir) states.push(normal(stateDir));
  const local = WIN ? Deno.env.get('LOCALAPPDATA') : '';
  if (local) states.push(normal(`${local}/AgentStudio`));
  if (home) {
    for (const d of BLOCKED_HOME_DIRS) dirs.push(normal(`${home}/${d}`));
    for (const f of BLOCKED_HOME_FILES) files.push(normal(`${home}/${f}`));
  }
  for (const d of movedSigninDirs()) dirs.push(normal(d));
  return { states, dirs, files };
}

/** In a state folder and not inside one of its chat worktrees (<state>/worktrees/<name>/…). */
function inState(n: string, state: string): boolean {
  if (!within(n, state)) return false;
  const copies = `${state}/worktrees`;
  return !(within(n, copies) && n !== copies);
}

/** A Linux path inside a WSL distro: blocked when it is in a home folder's blocked names (/root/… or /home/<user>/…). */
export function linuxBlocked(linuxPath: string): boolean {
  const parts = normal(linuxPath, false).split('/').filter(Boolean);
  const homes: number[] = [];
  if (parts[0] === 'root') homes.push(1);
  if (parts[0] === 'home' && parts.length >= 2) homes.push(2);
  for (const at of homes) {
    const rest = parts.slice(at).join('/');
    if (BLOCKED_HOME_DIRS.some((d) => rest === d || rest.startsWith(d + '/'))) return true;
    if (BLOCKED_HOME_FILES.includes(rest)) return true;
  }
  return false;
}

function realOf(path: string): string | null {
  try {
    return Deno.realPathSync(path).replace(/^\\\\\?\\/, '');
  } catch {
    return null;
  }
}

/**
 * Is this path blocked for a remote computer? A WSL ref is checked by Linux rules; anything else as a path on this PC (and again by
 * its real path when it exists). An empty or non-text path is not blocked here (the route itself says what is wrong with it). A
 * path that is not absolute is blocked (fail closed: isAbsolute).
 */
export function isBlocked(path: unknown, stateDir: string | null, home = homeDir()): boolean {
  if (typeof path !== 'string' || !path.trim()) return false;
  if (isNetworkPath(path)) return true;
  const wsl = wslLocOf(path);
  if (wsl) return linuxBlocked(wsl.linuxPath);
  if (isForeignPath(path)) return linuxBlocked(path); // a bare Linux path on Windows: judge it by Linux rules
  if (!isAbsolute(path)) return true;
  const { states, dirs, files } = blockedRoots(stateDir, home);
  const check = (p: string) => {
    const n = normal(p);
    return files.includes(n) || dirs.some((d) => within(n, d)) || states.some((st) => inState(n, st));
  };
  if (check(path)) return true;
  const real = realOf(path);
  return real !== null && check(real);
}

/** Throws BlockedPath when the path is blocked. */
export function guardPath(path: unknown, stateDir: string | null): void {
  if (isBlocked(path, stateDir)) throw new BlockedPath('blocked_folder', BLOCKED_MESSAGE);
}

/** True when `path` is a folder the owner added to AIB or inside one (WSL refs by their ref text, case-sensitive past the distro). */
export function insideProjects(path: unknown, projects: readonly string[]): boolean {
  if (typeof path !== 'string' || !path.trim() || isNetworkPath(path)) return false;
  const wsl = wslLocOf(path);
  for (const root of projects) {
    if (typeof root !== 'string' || !root) continue;
    const rootWsl = wslLocOf(root);
    if (wsl || rootWsl) {
      if (!wsl || !rootWsl || wsl.distro !== rootWsl.distro) continue;
      if (within(normal(wsl.linuxPath, false), normal(rootWsl.linuxPath, false))) return true;
      continue;
    }
    if (isForeignPath(path)) continue;
    if (within(normal(path), normal(root))) return true;
  }
  return false;
}

/** Throws unless the path is inside an added project (and not blocked). */
export function guardProjectPath(path: unknown, stateDir: string | null, projects: readonly string[]): void {
  guardPath(path, stateDir);
  if (!insideProjects(path, projects)) {
    throw new BlockedPath('outside_projects', 'Only folders of projects added to AIB can be used from another computer.');
  }
}

/** A home folder itself, a drive root (C:\) or '/': never added as a project from another computer (design v2 section 7). */
export function isHomeOrRoot(path: unknown, home = homeDir()): boolean {
  if (typeof path !== 'string' || !path.trim()) return false;
  const wsl = wslLocOf(path);
  if (wsl) {
    const parts = normal(wsl.linuxPath, false).split('/').filter(Boolean);
    return parts.length === 0 || (parts.length === 1 && (parts[0] === 'root' || parts[0] === 'home' || parts[0] === 'mnt')) ||
      (parts.length === 2 && (parts[0] === 'home' || parts[0] === 'mnt'));
  }
  const rootOrHome = (p: string) => {
    const n = normal(p);
    return n === '/' || /^[a-z]:\/$/i.test(n) || (!!home && n === normal(home));
  };
  if (rootOrHome(path)) return true;
  // and by real paths (security review SF2): a junction or link to the home folder, an 8.3 short name (C:\Users\LONGNA~1), an
  // NTFS alias (…\name::$INDEX_ALLOCATION) or trailing dots all resolve to the home folder or the drive root itself
  const real = isAbsolute(path) ? realOf(path) : null;
  if (real === null) return false;
  if (rootOrHome(real)) return true;
  const realHome = home ? realOf(home) : null;
  return realHome !== null && normal(real) === normal(realHome);
}

/** Throws when a computer may not add this folder as a project: blocked, a home folder or a drive root. */
export function guardNewProject(path: unknown, stateDir: string | null): void {
  guardPath(path, stateDir);
  if (isHomeOrRoot(path)) throw new BlockedPath('not_a_project', 'A home folder or a whole drive cannot be added from another computer.');
}
