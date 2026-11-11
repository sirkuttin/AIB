/**
 * "Delete project…": the server side. Removing a project from AIB is remembered here (studio-removed-projects.json in the data
 * folder) so old saved chats do not bring it back; a new chat in the folder, or restoring one of its chats, does. Deleting the
 * folder from disk is done only here, never by the page: to the Recycle Bin (Windows, SHFileOperationW with FOF_ALLOWUNDO and no
 * UI at all), the Trash (macOS) or `gio trash` (Linux); a permanent delete only when there is no trash, and the page says so
 * before you confirm (inspect() tells it which one applies).
 *
 * Refused for disk delete: a drive root, the home folder (and its parents) or its Documents / Desktop / Downloads, AIB's data or
 * app folder, a folder holding another project or inside another project's folder, and network paths. A folder that does not
 * exist is only removed from AIB.
 */
import { isDict, isStr, ValueError } from '../core/py.ts';
import { APP_ROOT } from '../core/app.ts';
import { isNetworkPath } from '../web/security.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson, VERSION } from '../state/base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from '../state/json.ts';

const WINDOWS = Deno.build.os === 'windows';

// ---- project keys (sidebar-ui.js pathKey, so the server and the page name a folder the same way) --------------------------
export function projectKey(cwd: unknown): string {
  let p = isStr(cwd) ? cwd.trim() : '';
  const raw = p;
  p = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/');
  const unc = p.startsWith('//');
  p = p.replace(/\/{2,}/g, '/');
  const segments = p.split('/').filter(Boolean);
  if (!segments.length) return '';
  const windows = /^[a-zA-Z]:/.test(p) || unc || raw.includes('\\');
  const joined = segments.join('/');
  return windows ? 'w:' + joined.toLowerCase() : 'p:' + joined;
}

// ---- the removed-projects store ---------------------------------------------------------------------------------------------
export interface Removed {
  path: string;
  at: number;
}

export class RemovedProjects extends JsonFileStore {
  static FILE = 'studio-removed-projects.json';
  static MAX = 500;
  removed = new Map<string, Removed>();

  constructor(stateDir: string | null = null) {
    super();
    this.path = stateDir ? inDir(stateDir, RemovedProjects.FILE) : null;
    this.reload();
  }

  protected reload(): void {
    this.removed = new Map();
    if (this.path === null) return;
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === 'busy') {
      this.unreadableNow('Removed projects could not be read just now; changes are paused.');
      return;
    }
    this.unreadable = false;
    if (status === 'missing') return;
    if (status === 'corrupt') {
      this.warning = 'The list of removed projects was unreadable and was ignored.';
      quarantine(this.path);
      this.seen = this.stamp();
      return;
    }
    if (!isDict(raw) || raw.version !== VERSION || !isDict(raw.removed)) return;
    for (const [key, item] of entriesOf(raw.removed).slice(0, RemovedProjects.MAX)) {
      if (!isDict(item) || !isStr(item.path) || projectKey(item.path) !== key) continue;
      this.removed.set(key, { path: item.path, at: typeof item.at === 'number' && item.at > 0 ? item.at : 0 });
    }
  }

  public(): { revision: string; removed: Record<string, Removed> } {
    this.sync();
    const removed: Record<string, Removed> = {};
    for (const [key, value] of this.removed) {
      Object.defineProperty(removed, key, { value: { ...value }, enumerable: true, writable: true, configurable: true });
    }
    return { revision: `${this.nonce}.${this.counter}`, removed };
  }

  has(path: string): boolean {
    this.sync();
    return this.removed.has(projectKey(path));
  }

  #change(work: (map: Map<string, Removed>) => void): Promise<boolean> {
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.removed);
      work(this.removed);
      while (this.removed.size > RemovedProjects.MAX) this.removed.delete(this.removed.keys().next().value!);
      if (sameJson(this.removed, before)) return false;
      if (this.path !== null) {
        this.requireReadable();
        try {
          saveJson(this.path, { version: VERSION, savedAt: now(), removed: this.removed }, '.studio-removed-projects-');
        } catch (error) {
          if (!isOSError(error)) throw error;
          this.removed = before;
          throw new ValueError(`AIB could not save the removed project: ${errorText(error)}`);
        }
        this.seen = this.stamp();
      }
      this.counter++;
      return true;
    });
  }

  /** Remember a folder as removed from AIB. */
  remove(path: string): Promise<boolean> {
    const key = projectKey(path);
    if (!key) return Promise.reject(new ValueError('Choose a project folder'));
    return this.#change((map) => {
      map.delete(key);
      map.set(key, { path, at: now() });
    });
  }

  /** The project comes back (a new chat in its folder, or one of its chats restored). Folders that are not removed: no change. */
  forget(...paths: unknown[]): Promise<boolean> {
    const keys = paths.map(projectKey).filter((k) => k);
    this.sync();
    if (!keys.some((k) => this.removed.has(k))) return Promise.resolve(false);
    return this.#change((map) => {
      for (const k of keys) map.delete(k);
    });
  }
}

// ---- the OS trash layer (mockable) ------------------------------------------------------------------------------------------
/** recycle: Windows Recycle Bin; trash: macOS Trash; gio: Linux `gio trash`; permanent: no trash, the folder is deleted for good. */
export type TrashKind = 'recycle' | 'trash' | 'gio' | 'permanent';
export interface TrashLayer {
  kind(path: string): Promise<TrashKind>;
  /** Move to the trash kind() named (never called for 'permanent'). Throws with a readable message when it fails. */
  trash(path: string, kind: TrashKind): Promise<void>;
}

const wide = (s: string) => {
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};
/** Path list for SHFileOperationW: one path, then two NULs. */
const doubleNul = (s: string) => {
  const a = new Uint16Array(s.length + 2);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
};

function driveRoot(path: string): string {
  const m = /^([a-zA-Z]:)[\\/]?/.exec(path);
  return m ? m[1] + '\\' : '';
}

/** Windows: does the drive have a Recycle Bin (SHQueryRecycleBinW answers S_OK)? */
function hasRecycleBin(path: string): boolean {
  const root = driveRoot(path);
  if (!root) return false;
  const lib = Deno.dlopen('shell32.dll', { SHQueryRecycleBinW: { parameters: ['buffer', 'buffer'], result: 'i32' } });
  try {
    const info = new Uint8Array(24);
    new DataView(info.buffer).setUint32(0, 24, true);
    return lib.symbols.SHQueryRecycleBinW(wide(root), info) === 0;
  } finally {
    lib.close();
  }
}

const FO_DELETE = 3;
const FOF_SILENT = 0x4;
const FOF_NOCONFIRMATION = 0x10;
const FOF_ALLOWUNDO = 0x40;
const FOF_NOERRORUI = 0x400;

/** Windows: SHFileOperationW(FO_DELETE, FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI): no window, no dialog. */
function recycle(path: string): void {
  const lib = Deno.dlopen('shell32.dll', { SHFileOperationW: { parameters: ['buffer'], result: 'i32' } });
  try {
    const from = doubleNul(path);
    // SHFILEOPSTRUCTW (x64): hwnd 0, wFunc 8, pFrom 16, pTo 24, fFlags 32 (u16), fAnyOperationsAborted 36, hNameMappings 40, title 48.
    const op = new Uint8Array(56);
    const dv = new DataView(op.buffer);
    dv.setUint32(8, FO_DELETE, true);
    dv.setBigUint64(16, BigInt(Deno.UnsafePointer.value(Deno.UnsafePointer.of(from))), true);
    dv.setUint16(32, FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI, true);
    const result = lib.symbols.SHFileOperationW(op);
    const aborted = dv.getInt32(36, true) !== 0;
    if (result !== 0 || aborted) {
      throw new Error(`Windows could not move the folder to the Recycle Bin (code ${result}${aborted ? ', aborted' : ''})`);
    }
    // keep `from` alive until here
    void from.length;
  } finally {
    lib.close();
  }
}

async function onPath(cmd: string): Promise<string> {
  for (const dir of (Deno.env.get('PATH') ?? '').split(WINDOWS ? ';' : ':')) {
    if (!dir) continue;
    const full = `${dir.replace(/[\\/]+$/, '')}/${cmd}`;
    try {
      if ((await Deno.stat(full)).isFile) return full;
    } catch { /* not here */ }
  }
  return '';
}

async function run(cmd: string, args: string[]): Promise<void> {
  const out = await new Deno.Command(cmd, { args, stdin: 'null', stdout: 'null', stderr: 'piped' }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr).trim() || `${cmd} failed`);
}

export const osTrash: TrashLayer = {
  async kind(path) {
    if (WINDOWS) return hasRecycleBin(path) ? 'recycle' : 'permanent';
    if (Deno.build.os === 'darwin') return 'trash';
    return (await onPath('gio')) ? 'gio' : 'permanent';
  },
  async trash(path, kind) {
    if (kind === 'recycle') return recycle(path);
    if (kind === 'trash') {
      try {
        if ((await Deno.stat('/usr/bin/trash')).isFile) return await run('/usr/bin/trash', [path]);
      } catch { /* older macOS: ask Finder */ }
      const quoted = path.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return await run('/usr/bin/osascript', ['-e', `tell application "Finder" to delete POSIX file "${quoted}"`]);
    }
    if (kind === 'gio') return await run(await onPath('gio') || 'gio', ['trash', '--', path]);
    throw new Error('No trash is available');
  },
};

// ---- the refusals -----------------------------------------------------------------------------------------------------------
export interface Guard {
  /** The home folder (USERPROFILE / HOME). */
  home: string;
  /** AIB's data folder and app folder(s). */
  own: string[];
  /** Every other AIB project folder (the page's list plus the folders the server knows). */
  projects: string[];
  /** Windows only: is this drive a network drive (GetDriveTypeW == DRIVE_REMOTE)? Mockable. */
  remoteDrive?: (root: string) => boolean;
}

const norm = (p: string) => {
  let s = p.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && !/^[a-zA-Z]:\/$/.test(s)) s = s.replace(/\/+$/, '');
  return WINDOWS || /^[a-zA-Z]:/.test(s) ? s.toLowerCase() : s;
};
const inside = (child: string, parent: string) => {
  const c = norm(child), p = norm(parent);
  return c !== p && c.startsWith(p.endsWith('/') ? p : p + '/');
};
const same = (a: string, b: string) => norm(a) === norm(b);

function remoteDrive(root: string): boolean {
  if (!WINDOWS || !root) return false;
  const lib = Deno.dlopen('kernel32.dll', { GetDriveTypeW: { parameters: ['buffer'], result: 'u32' } });
  try {
    return lib.symbols.GetDriveTypeW(wide(root)) === 4; // DRIVE_REMOTE
  } finally {
    lib.close();
  }
}

export function defaultGuard(stateDir: string, projects: string[]): Guard {
  const home = Deno.env.get(WINDOWS ? 'USERPROFILE' : 'HOME') ?? '';
  const own = [stateDir, APP_ROOT];
  try {
    const exe = Deno.execPath();
    if (!/[\\/]deno(\.exe)?$/i.test(exe)) own.push(exe.replace(/[\\/][^\\/]*$/, '')); // the installed app's folder (not a dev deno)
  } catch { /* no exec path */ }
  return { home, own: own.filter(Boolean), projects, remoteDrive };
}

/** Why this folder may not be deleted from disk, or '' when it may. `path` is the real (resolved) folder. */
export function refusal(path: string, guard: Guard): string {
  const p = path.trim();
  if (!p) return 'There is no folder to delete.';
  if (isNetworkPath(p) || (WINDOWS && (guard.remoteDrive ?? remoteDrive)(driveRoot(p)))) {
    return 'AIB does not delete folders on a network drive. Delete it yourself if you mean to.';
  }
  const n = norm(p);
  if (n === '/' || /^[a-z]:\/?$/i.test(n) || !/^([a-z]:)?\//i.test(n)) return 'This is a drive root. AIB will not delete it.';
  const home = guard.home;
  if (home) {
    if (same(p, home) || inside(home, p)) return 'This is your home folder (or holds it). AIB will not delete it.';
    for (const name of ['Documents', 'Desktop', 'Downloads']) {
      if (same(p, `${home}/${name}`)) return `This is your ${name} folder. AIB will not delete it.`;
    }
  }
  for (const own of guard.own) {
    if (same(p, own) || inside(p, own) || inside(own, p)) return "This folder holds AIB's own data or app files. AIB will not delete it.";
  }
  for (const other of guard.projects) {
    if (!other || same(p, other)) continue;
    if (inside(other, p)) return `This folder holds another AIB project (${other}). Remove that project first.`;
    if (inside(p, other)) return `This folder is inside another AIB project (${other}). AIB will not delete part of a project.`;
  }
  return '';
}

/** A git worktree's main repository ('' when the folder is not a linked worktree): `.git` is a file "gitdir: <repo>/.git/worktrees/<name>". */
export async function worktreeOf(path: string): Promise<string> {
  try {
    const text = (await Deno.readTextFile(`${path}/.git`)).trim();
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m) return '';
    const dir = m[1].trim().replace(/\\/g, '/');
    const at = dir.toLowerCase().lastIndexOf('/.git/worktrees/');
    if (at < 0) return '';
    const repo = dir.slice(0, at);
    return WINDOWS ? repo.replace(/\//g, '\\') : repo;
  } catch {
    return '';
  }
}

export interface Inspection {
  exists: boolean;
  /** Why disk delete is refused ('' = allowed). */
  refusal: string;
  /** What a disk delete would do. */
  trash: TrashKind;
  /** The repository this folder is a linked git worktree of, or ''. */
  worktreeOf: string;
}

async function realDir(path: string): Promise<string | null> {
  try {
    const real = await Deno.realPath(path);
    return (await Deno.stat(real)).isDirectory ? real.replace(/^\\\\\?\\/, '') : null;
  } catch {
    return null;
  }
}

/** What the dialog shows before you tick "Delete from disk as well". */
export async function inspect(path: string, guard: Guard, layer: TrashLayer = osTrash): Promise<Inspection> {
  if (isNetworkPath(path)) return { exists: false, refusal: refusal(path, guard), trash: 'permanent', worktreeOf: '' };
  const real = await realDir(path);
  if (real === null) return { exists: false, refusal: '', trash: 'permanent', worktreeOf: '' };
  const refused = refusal(real, guard) || (same(real, path) ? '' : refusal(path, guard));
  let trash: TrashKind = 'permanent';
  try {
    trash = await layer.kind(real);
  } catch {
    trash = 'permanent';
  }
  return { exists: true, refusal: refused, trash, worktreeOf: await worktreeOf(real) };
}

export class Refused extends Error {}

/**
 * Delete the folder from disk: refused (Refused) when a rule says no; 'missing' when it does not exist (nothing to delete);
 * else the trash kind used. `expect` is what the page showed: a permanent delete is never done when the page said trash.
 */
export async function deleteFolder(
  path: string,
  guard: Guard,
  expect: unknown,
  layer: TrashLayer = osTrash,
): Promise<TrashKind | 'missing'> {
  const seen = await inspect(path, guard, layer);
  if (!seen.exists) return 'missing';
  if (seen.refusal) throw new Refused(seen.refusal);
  if (seen.trash === 'permanent' && expect !== 'permanent') {
    throw new Refused(
      'This folder cannot go to a trash here, so it would be deleted permanently. Nothing was deleted; try again to confirm.',
    );
  }
  const real = (await realDir(path))!;
  if (seen.trash === 'permanent') await Deno.remove(real, { recursive: true });
  else await layer.trash(real, seen.trash);
  if (await realDir(real) !== null) throw new Refused('The folder is still there: something may be using it. Nothing more was deleted.');
  return seen.trash;
}
