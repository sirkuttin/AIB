/**
 * New project folders: validation, single-level create, smart starting folder, native folder picker (folders.py).
 *
 * Everything a typed path can do goes through validatePath(), the one place an allow-list of locations could be added (see
 * checkLocation). Nothing here deletes or overwrites anything, and nothing runs input from the user as a command: git is started
 * with a fixed argument list inside the new folder, the picker is a fixed script that gets the start folder as plain data (an
 * environment variable or a separate argument, never part of the script text).
 *
 * The picker: Python used tkinter in a child process. Deno has no GUI toolkit, so it is a platform dialog in a child process:
 * Windows: a hidden PowerShell running System.Windows.Forms.FolderBrowserDialog (it inherits the server's windowless console,
 * server/platform/console.ts); macOS: osascript `choose folder`; Linux: zenity, else kdialog. Same (status, payload) contract.
 */
import { isDict, isStr, pyJsonDumps, pyLen, pyStrip } from '../core/py.ts';
import { writeJsonAtomic } from '../core/fs.ts';
import { isNetworkPath } from '../web/security.ts';
import { which } from '../platform/pypath.ts';
import * as osp from '../platform/ospath.ts';
import { nativePath, pureParents, pureStr } from '../transcripts/purepath.ts';

export const RESERVED: ReadonlySet<string> = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);
export const BAD_CHARS = '<>:"|?*';
export const MAX_PATH_CHARS = 400;
export const GIT_TIMEOUT = 20;
export const PICK_TIMEOUT = 600;
export const PICK_UNAVAILABLE = 'Folder picker unavailable, type the path';
export const MAX_KINDS = 300;

export class FolderError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid') {
    super(message);
    this.name = 'FolderError';
    this.code = code;
  }
}

/** Replaceable lookups (tests swap them, as the Python tests patch folders.git_path). */
export const hooks = {
  gitPath: (): string | null => which('git'),
};

export function gitPath(): string | null {
  return hooks.gitPath();
}

function segments(path: unknown): string[] {
  return String(path ?? '').replaceAll('\\', '/').split('/').filter((x) => x);
}

/** Claude desktop scratch folders: a segment starting with scratch- (or a scratch-workspaces folder in the path). */
export function isScratch(path: unknown): boolean {
  return segments(path).some((seg) => seg.toLowerCase().startsWith('scratch-') || seg.toLowerCase() === 'scratch-workspaces');
}

/**
 * A git worktree folder (not the main checkout): under .claude/worktrees or .git/worktrees, or its .git is a FILE pointing into a
 * worktrees folder. Submodules also have a .git file, but theirs points into .git/modules.
 */
export function isWorktree(path: unknown): boolean {
  if (isNetworkPath(path)) return false; // never stat a UNC or device path: Windows would authenticate to that server
  const text = String(path ?? '').replaceAll('\\', '/').toLowerCase();
  if ((text + '/').includes('/.claude/worktrees/') || (text + '/').includes('/.git/worktrees/')) return true;
  try {
    const marker = osp.join(pureStr(nativePath(String(path))), '.git');
    if (osp.isfile(marker)) {
      const head = [...new TextDecoder().decode(Deno.readFileSync(marker))].slice(0, 600).join('').replaceAll('\\', '/').toLowerCase();
      return head.startsWith('gitdir:') && head.includes('/worktrees/');
    }
  } catch { /* unreadable: not a worktree */ }
  return false;
}

/** {path: {worktree, scratch}} for the dropdown filter; cheap (one stat per folder), bounded, read-only. */
export function folderKinds(paths: unknown): Record<string, { worktree: boolean; scratch: boolean }> {
  const out: Record<string, { worktree: boolean; scratch: boolean }> = {};
  for (const raw of (Array.isArray(paths) ? paths : []).slice(0, MAX_KINDS)) {
    if (isStr(raw) && pyLen(raw) > 0 && pyLen(raw) <= MAX_PATH_CHARS && !isNetworkPath(raw)) {
      out[raw] = { worktree: isWorktree(raw), scratch: isScratch(raw) };
    }
  }
  return out;
}

/** Hook for a future allow-list of places projects may be created in. Throw FolderError to refuse. Allows all today. */
export function checkLocation(_normalized: string): void {}

export interface CheckResult {
  valid: boolean;
  reason: string;
  message: string;
  exists: boolean;
  isDir: boolean;
  parentExists: boolean;
  name: string;
  path: string;
  parent: string;
  gitAvailable: boolean;
}

function result(kw: Partial<CheckResult>): CheckResult {
  return {
    valid: false,
    reason: 'empty',
    message: '',
    exists: false,
    isDir: false,
    parentExists: false,
    name: '',
    path: '',
    parent: '',
    gitAvailable: !!gitPath(),
    ...kw,
  };
}

const hasControl = (text: string) => [...text].some((c) => c.codePointAt(0)! < 32);

/** Pure text validation. Returns [normalizedPath, parent, name, segments] or throws FolderError(code). */
export function validatePath(raw: unknown, windows?: boolean | null): [string, string, string, string[]] {
  const win = windows ?? (Deno.build.os === 'windows');
  let text = isStr(raw) ? pyStrip(raw) : '';
  if (!text) throw new FolderError('Type a folder name, or Browse', 'empty');
  if (pyLen(text) > MAX_PATH_CHARS) throw new FolderError('That path is too long', 'invalid_name');
  if (hasControl(text)) throw new FolderError("Folder names can't contain control characters", 'invalid_name');
  let root: string, rest: string, sep: string;
  if (win) {
    text = text.replaceAll('/', '\\');
    if (text.startsWith('\\\\')) throw new FolderError('Network paths are not supported here, use a drive letter', 'relative');
    const m = /^([A-Za-z]:)\\([\s\S]*)$/.exec(text);
    if (!m) throw new FolderError('Type the full path, starting with a drive such as C:\\', 'relative');
    [root, rest, sep] = [m[1] + '\\', m[2], '\\'];
  } else {
    if (!text.startsWith('/')) throw new FolderError('Type the full path, starting with /', 'relative');
    [root, rest, sep] = ['/', text.slice(1), '/'];
  }
  if (rest === '') throw new FolderError('Type a folder name, or Browse', 'partial');
  const trailing = rest.endsWith(sep);
  if (trailing) {
    rest = rest.slice(0, -1);
    if (rest === '') throw new FolderError('Type a folder name, or Browse', 'partial');
  }
  const segs = rest.split(sep);
  for (const seg of segs) {
    if (seg === '') throw new FolderError('The path has an empty folder name (two separators in a row)', 'invalid_name');
    if (seg === '.' || seg === '..') throw new FolderError('Paths with . or .. are not allowed', 'escape');
    if (pyLen(seg) > 255) throw new FolderError('A folder name is too long', 'invalid_name');
    if (win) {
      const bad = [...new Set([...seg].filter((c) => BAD_CHARS.includes(c)))].sort();
      if (bad.length) throw new FolderError(`"${seg}" can't contain ${bad.join(' ')}`, 'invalid_name');
      if (seg.endsWith('.') || seg.endsWith(' ')) throw new FolderError(`"${seg}" can't end with a dot or a space`, 'invalid_name');
      if (RESERVED.has(pyStrip(seg.split('.')[0]).toUpperCase())) {
        throw new FolderError(`"${seg}" is a reserved Windows name`, 'invalid_name');
      }
    }
  }
  if (trailing) throw new FolderError('Type a folder name, or Browse', 'partial');
  const joined = root + segs.join(sep);
  const parent = segs.length > 1 ? root + segs.slice(0, -1).join(sep) : root;
  return [joined, parent, segs[segs.length - 1], segs];
}

/** The answer behind GET /api/live/folders/check. */
export function checkPath(raw: unknown, windows?: boolean | null): CheckResult {
  let norm: string, parent: string, name: string;
  try {
    if (isNetworkPath(raw)) { // on every platform, before anything can look at the filesystem
      throw new FolderError('Network paths are not supported here, use a drive letter', 'relative');
    }
    [norm, parent, name] = validatePath(raw, windows);
  } catch (error) {
    if (!(error instanceof FolderError)) throw error;
    return result({ valid: false, reason: error.code, message: error.message });
  }
  try {
    checkLocation(norm);
  } catch (error) {
    if (!(error instanceof FolderError)) throw error;
    return result({ valid: false, reason: 'not_allowed', message: error.message, path: norm, name, parent });
  }
  const exists = osp.exists(norm), isDir = osp.isdir(norm), parentExists = osp.isdir(parent);
  const base = { exists, isDir, parentExists, name, path: norm, parent };
  if (exists && !isDir) return result({ valid: false, reason: 'not_a_folder', message: `"${name}" is a file, not a folder`, ...base });
  if (!exists && !parentExists) return result({ valid: false, reason: 'parent_missing', message: `${parent} doesn't exist`, ...base });
  return result({ valid: true, reason: exists ? 'existing' : 'new', message: '', ...base });
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** subprocess.run for git init: the command, its working folder and a timeout in seconds. Throws when it cannot start. */
export type GitRunner = (command: string[], options: { cwd: string; timeout: number }) => Promise<RunResult>;

/** Thrown by a runner when the child ran past its timeout (subprocess.TimeoutExpired). */
export class TimeoutExpired extends Error {
  constructor(message = 'timed out') {
    super(message);
    this.name = 'TimeoutExpired';
  }
}

/** Run a command to the end with output captured as text, killing it after `timeout` seconds (TimeoutExpired). */
export async function runCommand(
  command: string[],
  options: { cwd?: string; timeout: number; env?: Record<string, string> },
): Promise<RunResult> {
  const child = new Deno.Command(command[0], {
    args: command.slice(1),
    cwd: options.cwd,
    env: options.env,
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGKILL');
    } catch { /* already gone */ }
  }, options.timeout * 1000);
  try {
    const out = await child.output();
    if (timedOut) throw new TimeoutExpired(`${command[0]} timed out after ${options.timeout} seconds`);
    const decoder = new TextDecoder();
    return { code: out.code, stdout: decoder.decode(out.stdout), stderr: decoder.decode(out.stderr) };
  } finally {
    clearTimeout(timer);
  }
}

export interface CreateResult {
  path: string;
  git: boolean;
  gitError?: string;
}

/** One new folder level, never intermediate folders, never an existing one. */
export async function createFolder(raw: unknown, gitInit = false, runner: GitRunner = runCommand): Promise<CreateResult> {
  const info = checkPath(raw);
  if (!info.valid) throw new FolderError(info.message || 'Invalid folder', info.reason);
  if (info.exists) throw new FolderError('That folder already exists', 'exists');
  const path = info.path;
  try {
    Deno.mkdirSync(path);
  } catch (error) {
    if (error instanceof Deno.errors.AlreadyExists) throw new FolderError('That folder already exists', 'exists');
    throw new FolderError(`Could not create the folder: ${osErrorText(error)}`, 'mkdir_failed');
  }
  const out: CreateResult = { path, git: false };
  if (gitInit) {
    const git = gitPath();
    if (!git) {
      out.gitError = 'git not found';
    } else {
      try {
        const done = await runner([git, 'init'], { cwd: path, timeout: GIT_TIMEOUT });
        if (done.code === 0) out.git = true;
        else out.gitError = pyStrip(done.stderr || done.stdout || 'git init failed').slice(0, 300);
      } catch (error) {
        out.gitError = String((error as Error)?.message ?? error).slice(0, 300);
      }
    }
  }
  return out;
}

/** Python's error.strerror: the OS message without Deno's "(os error N)" and call details. */
function osErrorText(error: unknown): string {
  const message = String((error as Error)?.message ?? error);
  return message.replace(/\s*\(os error \d+\).*$/s, '').replace(/:\s*mkdir\s.*$/s, '') || message;
}

/** The parent folder where a project was last created or opened through the New project dialog (one small JSON file). */
export class FolderMemory {
  static readonly FILE = 'studio-folders.json';
  readonly path: string | null;
  _last = '';

  constructor(stateDir: string | null = null) {
    this.path = stateDir ? osp.join(stateDir, FolderMemory.FILE) : null;
  }

  get(): string {
    if (this.path !== null) {
      try {
        const data = JSON.parse(new TextDecoder().decode(Deno.readFileSync(this.path)));
        const value = isDict(data) ? data.lastParent : '';
        return isStr(value) ? value : '';
      } catch {
        return '';
      }
    }
    return this._last;
  }

  /** Store the parent of an existing project folder. Returns the stored parent. */
  rememberProject(projectPath: unknown): string {
    const [norm, parent] = validatePath(projectPath);
    if (!osp.isdir(norm)) throw new FolderError('That folder does not exist', 'parent_missing');
    this._last = parent;
    if (this.path !== null) {
      writeJsonAtomic(this.path, null, {
        prefix: '.studio-folders-',
        suffix: '.tmp',
        text: pyJsonDumps({ version: 1, lastParent: parent }),
      });
    }
    return parent;
  }
}

export interface StartFolder {
  start: string;
  home: string;
  source: 'last' | 'home';
}

/**
 * GET /api/live/folders/start. 'last' when the remembered parent still exists, else the home folder; the page then prefers the
 * parent holding most of its projects before falling back to home.
 */
export function startFolder(memory: FolderMemory | null, home?: string | null): StartFolder {
  const homeDir = home || osp.home();
  const last = memory ? memory.get() : '';
  if (last && osp.isdir(last)) return { start: last, home: homeDir, source: 'last' };
  return { start: homeDir, home: homeDir, source: 'home' };
}

// ---- native folder picker ----------------------------------------------------------------------

/** Nearest existing folder at or above the typed path, as plain data for the picker (never executed). */
export function startDir(raw: unknown): string {
  const text = isStr(raw) ? pyStrip(raw) : '';
  if (!text || pyLen(text) > MAX_PATH_CHARS || hasControl(text)) return '';
  const probe = nativePath(text);
  for (const candidate of [probe, ...pureParents(probe)]) {
    const path = pureStr(candidate);
    try {
      if (Deno.statSync(path).isDirectory) return path;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound || error instanceof Deno.errors.NotADirectory)) return '';
    }
  }
  return '';
}

/** One way to show a folder dialog: the command, the environment it needs, and how to read its answer. */
export interface PickerPlan {
  name: 'powershell' | 'osascript' | 'zenity' | 'kdialog';
  command: string[];
  env?: Record<string, string>;
  /** {path} (null when cancelled), or null when the dialog failed (503). */
  parse(code: number, stdout: string): { path: string | null } | null;
}

export const START_ENV = 'AIB_PICK_START';
const TITLE = 'Choose a project folder';

/** The PowerShell script. The start folder arrives in $env:AIB_PICK_START, as data. Prints one JSON line. */
export const POWERSHELL_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '${TITLE}'
  $dialog.ShowNewFolderButton = $true
  $start = $env:${START_ENV}
  if ($start) { $dialog.SelectedPath = $start }
  $owner = New-Object System.Windows.Forms.Form
  $owner.TopMost = $true
  $owner.ShowInTaskbar = $false
  $answer = $dialog.ShowDialog($owner)
  $owner.Dispose()
  if ($answer -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {
    ConvertTo-Json -Compress -InputObject @{ path = $dialog.SelectedPath }
  } else {
    '{"path": null}'
  }
} catch {
  '{"error": "unavailable"}'
}
`;

/** The AppleScript. The start folder is the first argument of the run handler, as data. Prints the folder, or nothing on Cancel. */
export const OSASCRIPT = `on run argv
  try
    if (count of argv) > 0 and (item 1 of argv) is not "" then
      set chosen to choose folder with prompt "${TITLE}" default location (POSIX file (item 1 of argv))
    else
      set chosen to choose folder with prompt "${TITLE}"
    end if
    return POSIX path of chosen
  on error number -128
    return ""
  end try
end run`;

function encodePowerShell(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let i = 0; i < script.length; i++) {
    const code = script.charCodeAt(i);
    bytes[i * 2] = code & 0xff;
    bytes[i * 2 + 1] = code >> 8;
  }
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function lastJsonLine(stdout: string): unknown {
  const lines = stdout.trim().split(/\r\n|\r|\n/).filter((l) => l.trim());
  if (!lines.length) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

function firstLine(stdout: string): string {
  return stdout.split(/\r\n|\r|\n/)[0].trim();
}

/** The folder dialog this platform offers, or null when there is none (503). `os` and `whichFn` are injectable for tests. */
export function pickerPlan(start: string, os: string = Deno.build.os, whichFn: (name: string) => string | null = which): PickerPlan | null {
  if (start.startsWith('-')) start = './' + start; // a relative folder named like an option stays a folder for osascript and kdialog
  if (os === 'windows') {
    const shell = whichFn('powershell.exe') ?? whichFn('pwsh.exe');
    if (!shell) return null;
    return {
      name: 'powershell',
      command: [
        shell,
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        encodePowerShell(POWERSHELL_SCRIPT),
      ],
      env: { [START_ENV]: start },
      parse(code, stdout) {
        const data = lastJsonLine(stdout);
        if (!isDict(data) || data.error || code !== 0) return null;
        return { path: isStr(data.path) && data.path ? data.path : null };
      },
    };
  }
  if (os === 'darwin') {
    const osa = whichFn('osascript') ?? '/usr/bin/osascript';
    return {
      name: 'osascript',
      command: [osa, '-e', OSASCRIPT, start],
      parse(code, stdout) {
        if (code !== 0) return null;
        let path = firstLine(stdout);
        if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1); // POSIX path of a folder ends with '/'
        return { path: path || null };
      },
    };
  }
  const zenity = whichFn('zenity');
  if (zenity) {
    return {
      name: 'zenity',
      command: [
        zenity,
        '--file-selection',
        '--directory',
        `--title=${TITLE}`,
        ...(start ? [`--filename=${start.endsWith('/') ? start : start + '/'}`] : []),
      ],
      parse(code, stdout) {
        if (code === 1) return { path: null }; // Cancel
        if (code !== 0) return null;
        return { path: firstLine(stdout) || null };
      },
    };
  }
  const kdialog = whichFn('kdialog');
  if (kdialog) {
    return {
      name: 'kdialog',
      command: [kdialog, '--title', TITLE, '--getexistingdirectory', start || osp.home()],
      parse(code, stdout) {
        if (code === 1) return { path: null };
        if (code !== 0) return null;
        return { path: firstLine(stdout) || null };
      },
    };
  }
  return null;
}

/** Runs the picker child to the end: subprocess.run(capture_output, text, timeout). Throws TimeoutExpired, or any error when it cannot start. */
export type PickRunner = (
  command: string[],
  options: { timeout: number; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string }>;

export interface PickOptions {
  runner?: PickRunner;
  /** Which dialog to use; defaults to pickerPlan() for this platform. */
  plan?: (start: string) => PickerPlan | null;
}

let pickOpen = false;

export type PickReply = [200, { path: string | null }] | [409 | 503 | 504, { error: string; code: string }];

/** Native folder dialog in a short-lived child process. (status, payload): 200 {path|null}, 409 one is already open, 503 no picker. */
export async function pickFolder(start: unknown, options: PickOptions = {}): Promise<PickReply> {
  if (pickOpen) return [409, { error: 'A folder picker is already open', code: 'picker_busy' }];
  pickOpen = true;
  try {
    const unavailable: PickReply = [503, { error: PICK_UNAVAILABLE, code: 'picker_unavailable' }];
    const plan = (options.plan ?? ((s: string) => pickerPlan(s)))(startDir(start));
    if (!plan) return unavailable;
    const runner = options.runner ?? ((command, opts) => runCommand(command, opts));
    let done: { code: number; stdout: string };
    try {
      done = await runner(plan.command, { timeout: PICK_TIMEOUT, env: plan.env });
    } catch (error) {
      if (error instanceof TimeoutExpired) return [504, { error: 'The folder picker timed out', code: 'picker_timeout' }];
      return unavailable;
    }
    const answer = plan.parse(done.code, done.stdout ?? '');
    if (!answer) return unavailable;
    return [200, { path: answer.path }];
  } finally {
    pickOpen = false;
  }
}
