/**
 * Open a project folder, a file at a line, or a workspace in an editor installed on this PC (editors.py).
 *
 * Safety rules (this module is the only place Studio starts a desktop program on request):
 *   - the program comes from a fixed table of known editors, found on disk (never from request text);
 *   - the only request data that reaches a command line is a path that was resolved and found inside a folder Studio already knows
 *     as a project (or a git worktree of one), or a .code-workspace file that sits next to such a project;
 *   - programs start with a list of arguments, never through a shell; the one exception is a vendor .cmd launcher, which Windows
 *     runs through cmd.exe, so paths with cmd metacharacters are refused in that case;
 *   - nothing is read from VS Code's own state database.
 */
import { isDict, isInt, isStr, pyLen } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { isNetworkPath } from '../web/security.ts';
import { expandUser, which as pyWhich } from '../platform/pypath.ts';
import * as osp from '../platform/ospath.ts';

const log = getLogger('editors');

export const MAX_PATH_CHARS = 1024;
export const MAX_LINE = 10_000_000;
export const DETECT_TTL = 30.0;
export const MAX_WORKSPACE_BYTES = 512 * 1024;
export const MAX_WORKSPACES_PER_DIR = 20;
export const PARENT_LEVELS = 3;
export const KINDS = ['folder', 'file', 'workspace'] as const;
export const CMD_UNSAFE = /[&|<>^%!"\r\n]/;

export interface EditorSpec {
  id: string;
  macApp: string;
  name: string;
  commands: readonly string[];
  fileAtLine: boolean;
  workspace: boolean;
  folderOnly?: boolean;
  exes: readonly (readonly [string, string])[];
}

/** id, display name, command names on PATH, install locations (environment variable, relative path to the .exe). */
export const EDITOR_SPECS: readonly EditorSpec[] = [
  {
    id: 'code',
    macApp: 'Visual Studio Code',
    name: 'VS Code',
    commands: ['code.cmd', 'code'],
    fileAtLine: true,
    workspace: true,
    exes: [['LOCALAPPDATA', 'Programs/Microsoft VS Code/Code.exe'], ['ProgramFiles', 'Microsoft VS Code/Code.exe'], [
      'ProgramFiles(x86)',
      'Microsoft VS Code/Code.exe',
    ]],
  },
  {
    id: 'cursor',
    macApp: 'Cursor',
    name: 'Cursor',
    commands: ['cursor.cmd', 'cursor'],
    fileAtLine: true,
    workspace: true,
    exes: [['LOCALAPPDATA', 'Programs/cursor/Cursor.exe'], ['ProgramFiles', 'Cursor/Cursor.exe']],
  },
  {
    id: 'windsurf',
    macApp: 'Windsurf',
    name: 'Windsurf',
    commands: ['windsurf.cmd', 'windsurf'],
    fileAtLine: true,
    workspace: true,
    exes: [['LOCALAPPDATA', 'Programs/Windsurf/Windsurf.exe'], ['ProgramFiles', 'Windsurf/Windsurf.exe']],
  },
  // Devin: its command-line flags are not tested yet, so it only opens folders.
  {
    id: 'devin',
    macApp: 'Devin',
    name: 'Devin',
    commands: [],
    fileAtLine: false,
    workspace: false,
    folderOnly: true,
    exes: [['LOCALAPPDATA', 'Programs/Devin/Devin.exe'], ['ProgramFiles', 'Devin/Devin.exe']],
  },
];
export const MAC_APP_DIRS = ['/Applications', '~/Applications'];
export const LINUX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xfce4-terminal'];
export const DEFAULT_ORDER: readonly string[] = EDITOR_SPECS.map((spec) => spec.id);

export class EditorError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code = 'invalid', status = 400) {
    super(message);
    this.name = 'EditorError';
    this.code = code;
    this.status = status;
  }
}

export interface Capabilities {
  folder: boolean;
  file: boolean;
  fileAtLine: boolean;
  workspace: boolean;
}

/** One detected program, with private launch details (exe, viaCmd, ...). publicEntry() is what goes to the page. */
export interface Entry {
  id: string;
  name: string;
  kind: 'editor' | 'explorer' | 'terminal';
  exe: string;
  viaCmd: boolean;
  capabilities: Capabilities;
  folderOnly?: boolean;
  macApp?: string;
  terminal?: 'wt' | 'powershell' | 'mac' | 'posix';
  opener?: 'open' | 'xdg';
}

export type Env = Record<string, string | undefined>;
export type Which = (name: string) => string | null | undefined;
export type Exists = (path: string) => boolean;

const envGetter = (env: Env | undefined) => (name: string) => (env === undefined ? Deno.env.get(name) : env[name]);

// ---- detection ---------------------------------------------------------------------------------

/** [exe path, viaCmd] for one editor, or null. A real .exe is preferred over a .cmd launcher. */
export function findEditor(spec: EditorSpec, env: Env | undefined, which: Which, isfile: Exists): [string, boolean] | null {
  const get = envGetter(env);
  for (const [variable, rel] of spec.exes) {
    const base = get(variable);
    if (base) {
      const candidate = osp.join(base, ...rel.split('/'));
      if (isfile(candidate)) return [candidate, false];
    }
  }
  for (const name of spec.commands) {
    const found = which(name);
    if (!found) continue;
    const lower = found.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
      // <install>\bin\code.cmd sits next to <install>\Code.exe; use the exe when it is there.
      for (const [, rel] of spec.exes) {
        const sibling = osp.join(osp.dirname(osp.dirname(found)), osp.basename(rel));
        if (isfile(sibling)) return [sibling, false];
      }
      return [found, true];
    }
    return [found, false];
  }
  return null;
}

export interface DetectOptions {
  env?: Env;
  which?: Which;
  isfile?: Exists;
  windows?: boolean;
  platform?: string;
  isdir?: Exists;
}

/** sys.platform for this process. */
export function sysPlatform(): string {
  return Deno.build.os === 'windows'
    ? 'win32'
    : Deno.build.os === 'darwin'
    ? 'darwin'
    : Deno.build.os === 'linux'
    ? 'linux'
    : Deno.build.os;
}

const caps = (folder: boolean, file: boolean, fileAtLine: boolean, workspace: boolean): Capabilities => ({
  folder,
  file,
  fileAtLine,
  workspace,
});

/** Editors, Explorer and a terminal found on this PC. */
export function detect(options: DetectOptions = {}): Entry[] {
  const get = envGetter(options.env);
  const which = options.which ?? pyWhich;
  const isfile = options.isfile ?? osp.isfile;
  const windows = options.windows ?? (Deno.build.os === 'windows');
  const platform = options.platform ?? sysPlatform();
  const isdir = options.isdir ?? osp.isdir;
  const found: Entry[] = [];
  for (const spec of EDITOR_SPECS) {
    const hit = findEditor(spec, options.env, which, isfile);
    if (!hit && !windows && platform === 'darwin') {
      const app = macApp(spec.macApp, isdir);
      if (app) { // installed in /Applications but no command-line launcher on PATH: start it with `open -a`
        found.push({
          id: spec.id,
          name: spec.name,
          kind: 'editor',
          exe: 'open',
          viaCmd: false,
          macApp: spec.macApp,
          folderOnly: !!spec.folderOnly,
          capabilities: caps(true, !spec.folderOnly, false, spec.workspace),
        });
        continue;
      }
    }
    if (hit) {
      found.push({
        id: spec.id,
        name: spec.name,
        kind: 'editor',
        exe: hit[0],
        viaCmd: hit[1],
        folderOnly: !!spec.folderOnly,
        capabilities: caps(true, !spec.folderOnly, spec.fileAtLine, spec.workspace),
      });
    }
  }
  if (windows) {
    const root = get('SystemRoot') || get('windir') || 'C:\\Windows';
    const explorer = osp.join(root, 'explorer.exe');
    found.push({
      id: 'explorer',
      name: 'File Explorer',
      kind: 'explorer',
      exe: isfile(explorer) ? explorer : 'explorer.exe',
      viaCmd: false,
      capabilities: caps(true, true, false, false),
    });
    const wt = which('wt.exe') || which('wt');
    if (wt) {
      found.push({
        id: 'terminal',
        name: 'Windows Terminal',
        kind: 'terminal',
        exe: wt,
        viaCmd: false,
        terminal: 'wt',
        capabilities: caps(true, false, false, false),
      });
    } else {
      const shell = which('powershell.exe') || which('powershell');
      if (shell) {
        found.push({
          id: 'terminal',
          name: 'PowerShell',
          kind: 'terminal',
          exe: shell,
          viaCmd: false,
          terminal: 'powershell',
          capabilities: caps(true, false, false, false),
        });
      }
    }
  }
  if (!windows && platform === 'darwin') {
    found.push({
      id: 'explorer',
      name: 'Finder',
      kind: 'explorer',
      exe: 'open',
      viaCmd: false,
      opener: 'open',
      capabilities: caps(true, true, false, false),
    });
    found.push({
      id: 'terminal',
      name: 'Terminal',
      kind: 'terminal',
      exe: 'open',
      viaCmd: false,
      terminal: 'mac',
      capabilities: caps(true, false, false, false),
    });
  } else if (!windows && platform.startsWith('linux')) {
    const opener = which('xdg-open');
    if (opener) {
      found.push({
        id: 'explorer',
        name: 'File manager',
        kind: 'explorer',
        exe: opener,
        viaCmd: false,
        opener: 'xdg',
        capabilities: caps(true, true, false, false),
      });
    }
    for (const name of LINUX_TERMINALS) {
      const terminal = which(name);
      if (terminal) {
        found.push({
          id: 'terminal',
          name: 'Terminal',
          kind: 'terminal',
          exe: terminal,
          viaCmd: false,
          terminal: 'posix',
          capabilities: caps(true, false, false, false),
        });
        break;
      }
    }
  }
  return found;
}

function macApp(name: string, isdir: Exists): string | null {
  for (const base of MAC_APP_DIRS) {
    const candidate = osp.join(base.startsWith('~') ? expandUser(base) : base, name + '.app');
    if (isdir(candidate)) return candidate;
  }
  return null;
}

export interface PublicEntry {
  id: string;
  name: string;
  kind: string;
  capabilities: Capabilities;
}

export function publicEntry(entry: Entry): PublicEntry {
  return { id: entry.id, name: entry.name, kind: entry.kind, capabilities: { ...entry.capabilities } };
}

/** First detected of VS Code, Cursor, Windsurf, Devin; '' when none. */
export function defaultEditor(entries: Entry[]): string {
  const ids = entries.filter((e) => e.kind === 'editor').map((e) => e.id);
  return DEFAULT_ORDER.find((wanted) => ids.includes(wanted)) ?? '';
}

// ---- paths -------------------------------------------------------------------------------------

const norm = (path: string) => osp.normcase(osp.normpath(path));

function inside(path: string, root: string): boolean {
  const a = norm(path), b = norm(root);
  if (a === b) return true;
  const prefix = b.endsWith(osp.SEP) ? b : b + osp.SEP;
  return a.startsWith(prefix);
}

const isAnchor = (path: string) => osp.dirname(path) === path;

/** The raw text of a path from a request: a plain absolute-looking string without control characters or UNC forms. */
export function cleanPathText(value: unknown, what = 'path'): string {
  if (!isStr(value) || !value.trim() || pyLen(value) > MAX_PATH_CHARS) throw new EditorError(`Invalid ${what}`);
  if ([...value].some((c) => c.codePointAt(0)! < 32) || value.includes('\x7f')) throw new EditorError(`Invalid ${what}`);
  const text = value.trim();
  if (isNetworkPath(text)) { // \\server\share, \\?\C:\..., \\.\device: network and device paths are never opened
    throw new EditorError('Network and device paths cannot be opened from Studio', 'path_refused', 403);
  }
  return text;
}

function pureParts(path: string): string[] {
  // pathlib.PurePath(path).parts for a normalised absolute path: the anchor, then each name.
  const [drive, rest] = osp.splitdrive(path);
  const root = /^[\\/]/.test(rest) ? osp.SEP : '';
  const names = rest.split(osp.WIN ? /[\\/]+/ : /\/+/).filter((x) => x);
  return drive || root ? [drive + root, ...names] : names;
}

function joinParts(parts: string[]): string {
  if (!parts.length) return '.';
  const [first, ...rest] = parts;
  return osp.join(first, ...rest);
}

/** For a path inside a linked git worktree, the main checkout's folder ('' when it is not one). Reads only the `.git` pointer file. */
export function worktreeMain(path: string, limit = 16): string {
  let current = osp.abspath(path);
  for (let i = 0; i < limit; i++) {
    const marker = osp.join(current, '.git');
    if (osp.isfile(marker)) {
      let head: string;
      try {
        head = readHead(marker, 600);
      } catch {
        return '';
      }
      if (!head.toLowerCase().startsWith('gitdir:')) return '';
      const after = head.slice(7).trim();
      let gitdir = after ? after.split(/\r\n|\r|\n/)[0].trim() : '';
      if (!gitdir) return '';
      if (!osp.isabs(gitdir)) gitdir = osp.join(current, gitdir);
      gitdir = osp.normpath(gitdir);
      const parts = pureParts(gitdir);
      const lowered = parts.map((p) => p.toLowerCase());
      const at = lowered.lastIndexOf('worktrees');
      if (at >= 2 && lowered[at - 1] === '.git') return joinParts(parts.slice(0, at - 1));
      return '';
    }
    const parent = osp.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return '';
}

/** The first `limit` characters of a text file (utf-8, undecodable bytes replaced). Throws when unreadable. */
function readHead(path: string, limit: number): string {
  const file = Deno.openSync(path, { read: true });
  try {
    const buffer = new Uint8Array(limit * 4);
    let total = 0;
    while (total < buffer.length) {
      const n = file.readSync(buffer.subarray(total));
      if (n === null || n === 0) break;
      total += n;
    }
    return [...new TextDecoder().decode(buffer.subarray(0, total))].slice(0, limit).join('');
  } finally {
    file.close();
  }
}

function real(path: string): string {
  try {
    return osp.realpath(path);
  } catch {
    return osp.abspath(path);
  }
}

/**
 * Resolve a request path (relative paths against `base`, which must itself be inside the roots) and require it to be inside one
 * of `roots` or a git worktree of one. Returns the resolved absolute path; throws EditorError.
 */
export function resolveInside(raw: unknown, roots: unknown[], base: string | null = null, what = 'path'): string {
  let text = cleanPathText(raw, what);
  if (!osp.isabs(text)) {
    if (base === null) throw new EditorError(`The ${what} must be a full path`, 'path_refused', 403);
    text = osp.join(base, text);
  }
  if (osp.splitdrive(text)[0] && !osp.isabs(text)) { // C:foo (drive-relative)
    throw new EditorError(`The ${what} must be a full path`, 'path_refused', 403);
  }
  const resolved = real(text);
  const realRoots = roots.filter((r): r is string => isStr(r) && !!r && !isAnchor(real(r))).map(real);
  if (realRoots.some((r) => inside(resolved, r))) return resolved;
  const main = worktreeMain(resolved);
  if (main && realRoots.some((r) => inside(real(main), r))) return resolved;
  throw new EditorError('That location is not inside a project folder Studio knows, so Studio will not open it', 'path_refused', 403);
}

// ---- workspace files ---------------------------------------------------------------------------

function skipString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
  return j;
}

/** Remove // and /* *\/ comments and trailing commas from JSON-with-comments, leaving strings untouched. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      const j = skipString(text, i);
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (text.startsWith('//', i)) {
      const j = text.indexOf('\n', i);
      i = j < 0 ? n : j;
    } else if (text.startsWith('/*', i)) {
      const j = text.indexOf('*/', i + 2);
      i = j < 0 ? n : j + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // trailing commas: a comma followed only by whitespace and a closing bracket (outside strings)
  let result = '';
  i = 0;
  const m = out.length;
  while (i < m) {
    const ch = out[i];
    if (ch === '"') {
      const j = skipString(out, i);
      result += out.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ',') {
      let j = i + 1;
      while (j < m && ' \t\r\n'.includes(out[j])) j++;
      if (!(j < m && ']}'.includes(out[j]))) result += ch;
      i++;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

/** Absolute folders listed by one .code-workspace file (local `path` entries only), or null when unreadable. */
export function workspaceFolders(filePath: string): string[] | null {
  let data: unknown;
  try {
    if (osp.getsize(filePath) > MAX_WORKSPACE_BYTES) return null;
    let text = new TextDecoder().decode(Deno.readFileSync(filePath));
    if (text.startsWith('\ufeff')) text = text.slice(1);
    data = JSON.parse(stripJsonc(text));
  } catch {
    return null;
  }
  if (!isDict(data) || !Array.isArray(data.folders)) return null;
  const base = osp.dirname(osp.abspath(filePath));
  const out: string[] = [];
  for (const item of data.folders.slice(0, 200)) {
    const value = isDict(item) ? item.path : isStr(item) ? item : null;
    if (isStr(value) && value && !value.includes('://')) out.push(osp.normpath(osp.isabs(value) ? value : osp.join(base, value)));
  }
  return out;
}

export interface WorkspaceMatch {
  path: string;
  name: string;
  folders: number;
  others: number;
}

function sortedNames(folder: string): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(folder)) names.push(entry.name);
  // Python sorts str by code point; JS default sort compares UTF-16 units (same for the BMP).
  return names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * *.code-workspace files in the project folder and up to `parents` parent folders that list the project as one of their folders.
 * Plain files only; VS Code's own state is never read.
 */
export function findWorkspaces(project: string, parents = PARENT_LEVELS): WorkspaceMatch[] {
  const here = real(project);
  const matches: WorkspaceMatch[] = [];
  let current = here;
  for (let level = 0; level <= parents; level++) {
    let names: string[];
    try {
      names = sortedNames(current).filter((n) => n.toLowerCase().endsWith('.code-workspace')).slice(0, MAX_WORKSPACES_PER_DIR);
    } catch {
      names = [];
    }
    for (const name of names) {
      const filePath = osp.join(current, name);
      if (!osp.isfile(filePath)) continue;
      const folders = workspaceFolders(filePath);
      if (folders === null) continue;
      const reals = folders.map(real);
      if (reals.some((r) => norm(r) === norm(here))) {
        matches.push({
          path: filePath,
          name: name.slice(0, -'.code-workspace'.length) || name,
          folders: reals.length,
          others: reals.length - 1,
        });
      }
    }
    const parent = osp.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return matches;
}

// ---- commands ----------------------------------------------------------------------------------

export type Kind = typeof KINDS[number];

/** The argument list (never a shell string) that opens `path` with this program. `path` is already validated. null: see Launcher. */
export function buildCommand(entry: Entry, kind: Kind, path: string, line: number | null = null): string[] | null {
  const exe = entry.exe, program = entry.kind;
  if (entry.macApp) { // an installed app without a command-line launcher: `open -a <App> <path>`
    if (program === 'editor' && kind === 'file' && !entry.capabilities.file) {
      throw new EditorError(`${entry.name} can only open folders from Studio for now`, 'unsupported', 400);
    }
    if (kind === 'workspace' && !entry.capabilities.workspace) {
      throw new EditorError(`${entry.name} cannot open workspace files from Studio`, 'unsupported', 400);
    }
    return [exe, '-a', entry.macApp, path];
  }
  if (program === 'editor') {
    if (kind === 'file') {
      if (!entry.capabilities.file) throw new EditorError(`${entry.name} can only open folders from Studio for now`, 'unsupported', 400);
      return line ? [exe, '-r', '--goto', `${path}:${line}`] : [exe, '-r', path];
    }
    if (kind === 'workspace') {
      if (!entry.capabilities.workspace) throw new EditorError(`${entry.name} cannot open workspace files from Studio`, 'unsupported', 400);
      return [exe, '-r', path];
    }
    return entry.folderOnly ? [exe, path] : [exe, '-r', path];
  }
  if (program === 'explorer' && entry.opener === 'open') { // macOS Finder: reveal a file, open a folder
    if (kind === 'workspace') throw new EditorError('Finder opens folders and files only', 'unsupported', 400);
    return kind === 'file' ? [exe, '-R', path] : [exe, path];
  }
  if (program === 'explorer' && entry.opener === 'xdg') { // Linux has no portable "select this file": open its folder
    if (kind === 'workspace') throw new EditorError('The file manager opens folders and files only', 'unsupported', 400);
    return [exe, kind === 'file' ? osp.dirname(path) : path];
  }
  if (program === 'explorer') {
    if (kind === 'workspace') throw new EditorError('Explorer opens folders and files only', 'unsupported', 400);
    return kind === 'file' ? [exe, '/select,', path] : [exe, path];
  }
  if (program === 'terminal') {
    if (kind !== 'folder') throw new EditorError('The terminal opens in a folder', 'unsupported', 400);
    if (entry.terminal === 'mac') return [exe, '-a', 'Terminal', path];
    if (entry.terminal === 'wt' && !path.includes(';')) return [exe, '-d', path]; // wt treats ';' as a command separator
    return null; // handled by the caller: start the shell with the folder as its working directory
  }
  throw new EditorError('Unknown program', 'unsupported', 400);
}

/** What Launcher passes to popen next to the argument list (subprocess.Popen keyword arguments of the Python server). */
export interface PopenOptions {
  stdin: 'null';
  stdout: 'null';
  stderr: 'null';
  /** Windows: CREATE_NEW_CONSOLE (0x10) for PowerShell, DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP (0x208) for others, 0 for Explorer. */
  creationflags?: number;
  /** POSIX: the program gets its own session so it outlives Studio. */
  start_new_session?: boolean;
  cwd?: string;
}

export type Popen = (command: string[], options: PopenOptions) => void;

const CREATE_NEW_CONSOLE = 0x10;
const DETACHED_PROCESS = 0x8;
const CREATE_NEW_PROCESS_GROUP = 0x200;

/**
 * The real launcher. Deno.Command cannot pass creation flags: a detached child (detached: true) gets no console, which suits
 * editors and Explorer; PowerShell needs a console window of its own, so it is started through `cmd /c start`, which opens one.
 * The command line of that case holds only the shell's own path (from PATH lookup), never request data (the folder is the cwd).
 */
export function realPopen(command: string[], options: PopenOptions): void {
  let cmd = command;
  if (Deno.build.os === 'windows' && options.creationflags === CREATE_NEW_CONSOLE) {
    cmd = ['cmd.exe', '/d', '/c', 'start', '""', ...command];
  }
  const child = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: options.cwd,
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
    detached: Deno.build.os !== 'windows' || options.creationflags !== 0,
  }).spawn();
  child.unref();
  child.status.catch(() => {});
}

export interface LauncherOptions {
  popen?: Popen;
  detectFn?: () => Entry[];
  windows?: boolean;
  preferred?: () => string;
  platform?: string;
}

export interface Listing {
  editors: PublicEntry[];
  default: string;
  detectedDefault: string;
  workspaces: WorkspaceMatch[];
  project?: string;
}

/** Detection cache and the one place a program is started. `popen` is injectable so tests never launch anything. */
export class Launcher {
  readonly #roots: () => unknown[];
  readonly #preferred: () => string;
  readonly #popen: Popen;
  readonly #detect: () => Entry[];
  readonly #windows: boolean;
  #cache: Entry[] = [];
  #at = 0;

  /** roots: returns the folders Studio knows as projects. preferred: the default editor id saved in Settings. */
  constructor(roots: () => unknown[], options: LauncherOptions = {}) {
    this.#roots = roots;
    this.#preferred = options.preferred ?? (() => '');
    this.#popen = options.popen ?? realPopen;
    this.#detect = options.detectFn ?? (() => detect({ windows: options.windows, platform: options.platform }));
    this.#windows = options.windows ?? (Deno.build.os === 'windows');
  }

  entries(fresh = false): Entry[] {
    const now = Date.now() / 1000;
    if (fresh || !this.#at || now - this.#at > DETECT_TTL) {
      this.#cache = this.#detect();
      this.#at = Date.now() / 1000;
    }
    return [...this.#cache];
  }

  listing(project: string | null = null): Listing {
    const entries = this.entries();
    const saved = this.#preferred();
    const chosen = entries.some((e) => e.id === saved && e.kind === 'editor') ? saved : defaultEditor(entries);
    const out: Listing = { editors: entries.map(publicEntry), default: chosen, detectedDefault: defaultEditor(entries), workspaces: [] };
    if (project) {
      const folder = resolveInside(project, this.#roots(), null, 'project folder');
      out.project = folder;
      out.workspaces = findWorkspaces(folder);
    }
    return out;
  }

  open(body: unknown): { ok: true; editor: string; name: string; kind: Kind } {
    if (!isDict(body)) throw new EditorError('Invalid request');
    const editorId = body.editor;
    const kind = (body.kind === undefined ? 'folder' : body.kind) as Kind;
    if (!isStr(editorId) || !(KINDS as readonly unknown[]).includes(kind)) throw new EditorError('Choose an editor and what to open');
    const line = body.line ?? null;
    if (line !== null && (!isInt(line) || line < 1 || line > MAX_LINE)) throw new EditorError('Invalid line number');
    const entry = this.entries().find((e) => e.id === editorId);
    if (entry === undefined) throw new EditorError('That program was not found on this PC', 'not_found', 404);
    const roots = this.#roots();
    let base: string | null = null;
    if (body.cwd !== undefined && body.cwd !== null) base = resolveInside(body.cwd, roots, null, 'folder');
    const path = kind !== 'workspace' ? resolveInside(body.path, roots, base) : this.#workspacePath(body.path, roots, base);
    if (kind === 'folder' && !osp.isdir(path)) throw new EditorError('That folder no longer exists', 'missing', 404);
    if (kind === 'file' && (osp.isdir(path) || !osp.exists(path))) throw new EditorError('That file no longer exists', 'missing', 404);
    const command = buildCommand(entry, kind, path, line as number | null);
    if (entry.viaCmd && (command ?? []).slice(1).some((part) => CMD_UNSAFE.test(part))) {
      throw new EditorError('That path has characters that cannot be passed safely to the editor launcher', 'unsafe_path', 400);
    }
    this.#start(entry, command, path);
    return { ok: true, editor: entry.id, name: entry.name, kind };
  }

  #workspacePath(raw: unknown, roots: unknown[], base: string | null): string {
    const text = cleanPathText(raw, 'workspace file');
    if (!text.toLowerCase().endsWith('.code-workspace')) throw new EditorError('That is not a workspace file', 'path_refused', 403);
    const candidate = real(osp.isabs(text) ? text : osp.join(base ?? '', text));
    if (!osp.isfile(candidate)) throw new EditorError('That workspace file no longer exists', 'missing', 404);
    for (const root of roots) {
      if (isStr(root) && root && !isAnchor(real(root))) {
        if (findWorkspaces(root).some((m) => norm(m.path) === norm(candidate)) || inside(candidate, real(root))) return candidate;
      }
    }
    throw new EditorError('That workspace file does not belong to a project Studio knows', 'path_refused', 403);
  }

  #start(entry: Entry, command: string[] | null, path: string): void {
    const options: PopenOptions = { stdin: 'null', stdout: 'null', stderr: 'null' };
    let cwd: string | null = null;
    if (command === null) { // PowerShell (or wt with a ';' path): the folder is the working directory, so no path is in the command text
      command = entry.terminal === 'powershell' ? [entry.exe, '-NoExit'] : [entry.exe];
      cwd = path;
    }
    if (this.#windows) {
      let flags = 0;
      if (entry.kind === 'terminal' && entry.terminal === 'powershell') flags = CREATE_NEW_CONSOLE;
      else if (entry.kind !== 'explorer') flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
      options.creationflags = flags;
    } else {
      options.start_new_session = true; // the program must outlive Studio and not share its process group
    }
    if (cwd) options.cwd = cwd;
    try {
      this.#popen(command, options);
    } catch (error) {
      throw new EditorError(`Could not start ${entry.name}: ${(error as Error).message}`, 'launch_failed', 500);
    }
  }
}

/** The parts of Studio known_roots reads (all optional, so a partial Studio still gives the roots it has). */
export interface RootsSource {
  liveList?: () => { connections?: unknown[]; recovered?: unknown[] } | Record<string, unknown>;
  conversations?: { entries?: Record<string, Record<string, unknown>> | Map<string, Record<string, unknown>> };
  projectPrefs?: { projects?: Record<string, unknown> | Map<string, unknown> };
}

function valuesOf<T>(value: Record<string, T> | Map<string, T> | undefined): T[] {
  if (value instanceof Map) return [...value.values()];
  return value ? Object.values(value) : [];
}

function keysOf(value: Record<string, unknown> | Map<string, unknown> | undefined): string[] {
  if (value instanceof Map) return [...value.keys()];
  return value ? Object.keys(value) : [];
}

/** Folders Studio knows as projects: open and recovered chats, saved conversation marks, and projects with saved prefs. */
export function knownRoots(studio: RootsSource): string[] {
  const roots: string[] = [];
  const add = (value: unknown) => {
    if (isStr(value) && value && osp.isabs(value) && !roots.includes(value)) roots.push(value);
  };
  try {
    const listed = studio.liveList?.() ?? {};
    const items = [
      ...(Array.isArray(listed.connections) ? listed.connections : []),
      ...(Array.isArray(listed.recovered) ? listed.recovered : []),
    ];
    for (const item of items) add(isDict(item) ? item.cwd : null);
  } catch (error) { // a host problem must not hide the roots we do have
    log.exception(error, 'Listing live conversations for editor roots failed');
  }
  try {
    for (const entry of valuesOf(studio.conversations?.entries)) add(isDict(entry) ? entry.cwd : null);
  } catch (error) {
    log.exception(error, 'Reading saved conversation folders for editor roots failed');
  }
  try {
    for (const key of keysOf(studio.projectPrefs?.projects)) if (key.startsWith('w:')) add(key.slice(2));
  } catch (error) {
    log.exception(error, 'Reading project folders for editor roots failed');
  }
  return roots;
}
