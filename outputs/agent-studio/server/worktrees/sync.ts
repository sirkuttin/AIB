/**
 * Worktree per chat, stage G2/G3 (worktree_sync.py): live sync of the user's saved edits into the chats' worktrees.
 *
 * Runs next to the connections (the agent host). For every project that has at least one open, Studio-owned worktree chat there is
 * one watcher task:
 *
 *   trigger    Deno.watchFs (recursive; ReadDirectoryChangesW underneath on Windows, where Python used ctypes) pokes the task; a 2 s
 *              poll runs as well, and is the only trigger elsewhere (as in Python, the folder watcher is used on Windows only). A burst
 *              of events is debounced for 400 ms.
 *   candidates `git status --porcelain -z -uall` in the project folder (GIT_OPTIONAL_LOCKS=0). `.env*` files are listed by a small walk.
 *   stability  a changed file is synced when its size and mtime are the same in two consecutive scans. Editor temp files, symlinks,
 *              files over 20 MB, unmerged files and files with conflict markers are skipped; a locked file is retried.
 *   no echoes  nothing happens while Merge holds the project's "sync paused" flag; a scan whose project HEAD moved only takes a new
 *              baseline; more than 200 changed files in one scan pause the project until the user presses Resume (worktree-sync.json).
 *
 * Per chat worktree, under its worktree lock (a cross-process lock file shared with Python's worktrees.worktree_lock, so a Python host
 * and a Deno process never write into the same worktree at once): a changed file the chat has not touched is written through a temp
 * file plus rename, then U moves (worktrees.advanceUserBase). A file the chat has touched goes to pendingSync and is merged with
 * `git merge-file` at a turn boundary (stage G3). `.env*` files are only copied into a chat that has not changed them, never merged.
 * A chat whose record names `editsFrom` (every chat made since chats start from main) takes nothing while the project folder has
 * another branch checked out: those edits belong to that branch. It waits as stale and catches up once the folder is back on it.
 *
 * Python's threads are async tasks here: the per-project RLock is an async mutex (the scan's own catch-ups pass it as `held`, which is
 * what re-entrancy gave Python), the turn hooks share one mutex that stopAll waits for, and registry read-modify-writes go through
 * Registry.mutate (Python: `with registry.lock`). catchUp() is the one restart function.
 *
 * The pause-flag helpers (pauseInfo, resumeSync, pausedStatus) and the read-mostly helpers Merge calls (settleConflicts, openClashes,
 * clashLine) live here; merge.ts re-exports them.
 */
import * as wt from './worktrees.ts';
import { GitError, type WorktreeRecord } from './worktrees.ts';
import { GIT_STATES, MARKER, stateIdleReason } from './merge.ts';
import { dirname, isdir, isfile, islink, join, normcase, WIN } from '../platform/ospath.ts';
import { pathStr } from '../platform/pypath.ts';
import { basename } from '../platform/path.ts';
import { pathOf, realpath } from '../state/paths.ts';
import { entriesOf, put, readJsonFile, saveJson } from '../state/json.ts';
import { isDict, pyStr, pyStrip, pyTruthy } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { FileLock, LockTimeout } from '../platform/lock.ts';

const log = getLogger('worktree_sync');

/** Python's module constants, mutable so tests can lower them (the Python tests patch the module or the LiveSync instance). */
export const settings = {
  SETTLE: 0.4, // seconds of quiet before a scan
  MAX_SETTLE: 2.0, // a steady stream of events cannot postpone the scan for longer than this
  POLL: 2.0, // the fallback poll (and the only trigger off Windows)
  STORM: 200, // more changed files than this in one scan pause the project
  MAX_BYTES: 20 * 1024 * 1024,
  ENV_WALK_EVERY: 10.0,
  ENV_WALK_LIMIT: 50000,
  CLOSE_WAIT: 8, // seconds to wait for a project's sync task (and its git commands) to end when it is stopped
  WORKTREE_WAIT: 3, // seconds to wait for a worktree lock held by Merge
};
export const STORM = 200;
export const MAX_NOTE_PATHS = 50;
export const MAX_STORED_PATHS = 200;
export const SYNC_FILE = 'worktree-sync.json';
export const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
/** Python: re.compile(r'(?:\.sw[a-z]$|~$|^\.#|^4913$|\.tmp$|\.tmp\.|^#.*#$|^\.~lock\.|\.crswap$|\.part$|^\.goutputstream-)', re.I) */
const TEMP_NAME = /(?:\.sw[a-z]$|~$|^\.#|^4913$|\.tmp$|\.tmp\.|^#.*#$|^\.~lock\.|\.crswap$|\.part$|^\.goutputstream-)/i;

function lastName(path: unknown): string {
  const text = String(path).replaceAll('\\', '/');
  return text.slice(text.lastIndexOf('/') + 1);
}

/** Editor and atomic-save temp names: vim swap files and its 4913 probe, emacs lock and autosave files, *~, *.tmp and the like. */
export function isTemp(path: unknown): boolean {
  return TEMP_NAME.test(lastName(path));
}

export function isEnv(path: unknown): boolean {
  return lastName(path).startsWith('.env');
}

function projectKey(project: string): string {
  return normcase(realpath(String(project)));
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => list(value).filter((p): p is string => typeof p === 'string');
/** list(dict.fromkeys(items)) */
const unique = <T>(items: T[]): T[] => [...new Set(items)];
const nowMono = () => performance.now() / 1000;

/** A dict field of a record as a Map in file order (a Map keeps every key's place, as Python's dict does). */
function dictOf(value: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (isDict(value)) { for (const [k, v] of entriesOf(value)) out.set(k, v); }
  return out;
}

/** Python OSError: any Deno I/O error, or a lock wait that timed out (Python's TimeoutError). */
function isOSError(error: unknown): boolean {
  if (error instanceof LockTimeout) return true;
  return Object.values(Deno.errors).some((type) => typeof type === 'function' && error instanceof type);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- the project's pause flag for a storm (shared with the web process, which shows the line and takes the Resume) ----------
function flagPath(stateDir: string): string {
  return pathOf(String(stateDir), SYNC_FILE);
}

/** worktree_sync._flag_lock: the cross-process lock around worktree-sync.json (5 s). */
export function syncFlagLock(stateDir: string): FileLock {
  return new FileLock(pathOf(String(stateDir), 'locks', 'sync-state.lock'), 5000);
}

/** worktree_sync._flag_read: the pause flags, {} when the file is missing or unreadable. */
export function syncFlagRead(stateDir: string): Record<string, unknown> {
  const [status, raw] = readJsonFile(flagPath(stateDir));
  return status === 'ok' && isDict(raw) ? raw : {};
}

/** worktree_sync._flag_write: compact JSON, written atomically (temp file '.studio-sync-*.tmp', then replace). */
export function syncFlagWrite(stateDir: string, items: Record<string, unknown> | Map<string, unknown>): void {
  saveJson(flagPath(stateDir), items, '.studio-sync-');
}

async function takeFlagLock(stateDir: string): Promise<FileLock> {
  const lock = syncFlagLock(stateDir);
  try {
    await lock.acquire();
  } catch (error) {
    if (error instanceof LockTimeout) {
      const timeout = new Error('Timed out waiting for the state file lock (sync-state.lock)');
      timeout.name = 'OSError';
      throw timeout;
    }
    throw error;
  }
  return lock;
}

/** The storm pause of a project ({paused, project, count, time}), or null. */
export function pauseInfo(stateDir: string, project: string): Record<string, unknown> | null {
  const items = syncFlagRead(stateDir);
  const key = projectKey(project);
  const found = Object.hasOwn(items, key) ? items[key] : undefined;
  return isDict(found) && pyTruthy(found.paused) ? found : null;
}

export async function setPaused(stateDir: string, project: string, count: number): Promise<void> {
  const lock = await takeFlagLock(stateDir);
  try {
    const items = dictOf(syncFlagRead(stateDir));
    items.set(projectKey(project), { paused: true, project: String(project), count: Math.trunc(Number(count)), time: Date.now() / 1000 });
    syncFlagWrite(stateDir, items);
  } finally {
    lock.release();
  }
}

/**
 * worktree_sync.resume: the user pressed Resume on the amber line. True when the project was paused. The host's watcher sees the flag
 * go and catches up. A lock wait that times out is an OSError (Python's TimeoutError), so the route answers 400.
 */
export async function resumeSync(stateDir: string, project: unknown): Promise<boolean> {
  if (typeof project !== 'string' || !project) return false;
  const lock = await takeFlagLock(stateDir);
  try {
    const items = dictOf(syncFlagRead(stateDir));
    if (!items.delete(projectKey(project))) return false;
    syncFlagWrite(stateDir, items);
    return true;
  } finally {
    lock.release();
  }
}

export const resume = resumeSync;

/** {} when live sync runs, else the fields the amber line needs. Read only. */
export function pausedStatus(stateDir: string, project: unknown): Record<string, unknown> {
  if (typeof project !== 'string' || !project || !stateDir) return {};
  if (!pauseInfo(stateDir, project)) return {};
  const name = basename(pathStr(project)) || project;
  return { syncPaused: true, syncLine: `Lots of files changed in ${name}; live sync paused. Resume?` };
}

// ---- what git and the file system say ---------------------------------------------------------------------------------
/** {path: XY code} of what `git status --porcelain -z -uall` lists (changed, deleted, new and not ignored). Throws GitError. */
export async function statusPaths(project: string): Promise<Map<string, string>> {
  const out =
    (await wt.git(['status', '--porcelain', '-z', '-uall', '--no-renames'], project, { env: { GIT_OPTIONAL_LOCKS: '0' } })).stdout;
  const found = new Map<string, string>();
  for (const entry of out.split('\0')) {
    if (entry.length > 3 && entry[2] === ' ') found.set(entry.slice(3), entry.slice(0, 2));
  }
  return found;
}

/** [kind, size, mtime] of a path in the project folder: 'l' symlink, 'd' folder, 'f' anything else. (Deno gives mtime in ms.) */
export type Sig = [string, number, number];

/** The signature of a path in the project folder, null when it is gone. */
export function sigOf(project: string, path: string): Sig | null {
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(join(String(project), path));
  } catch {
    return null;
  }
  const kind = info.isSymlink ? 'l' : info.isDirectory ? 'd' : 'f';
  return [kind, info.size, info.mtime?.getTime() ?? 0];
}

/** Python's `a != b` for two signatures; undefined is "absent" (never equal to anything). */
function sameSig(a: Sig | null | undefined, b: Sig | null | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === null || b === null) return a === b;
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** Relative names of the .env* files in the project (a small walk; node_modules, .git and symlinked folders are not entered). */
export function envFiles(project: string): string[] {
  const found: string[] = [];
  let seen = 0;
  let stop = false;
  const walk = (folder: string, rel: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(folder)];
    } catch {
      return; // os.walk ignores a folder it cannot list
    }
    const dirs: [string, string][] = [];
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(folder, entry.name);
      const isDir = entry.isDirectory || (entry.isSymlink && isdir(full));
      if (isDir) {
        if (!wt.SKIP_DIRS.has(entry.name) && !entry.isSymlink) dirs.push([full, rel ? `${rel}/${entry.name}` : entry.name]);
      } else files.push(entry.name);
    }
    seen += files.length;
    for (const name of files) {
      if (name.startsWith('.env') && !isTemp(name)) found.push(rel ? `${rel}/${name}` : name);
    }
    if (seen > settings.ENV_WALK_LIMIT) {
      stop = true;
      return;
    }
    for (const [full, sub] of dirs) {
      walk(full, sub);
      if (stop) return;
    }
  };
  walk(pathStr(String(project)), '');
  return found;
}

function readTextReplace(full: string): string | null {
  try {
    return new TextDecoder('utf-8').decode(Deno.readFileSync(full));
  } catch {
    return null;
  }
}

function fileTextHasMarkers(full: string): boolean {
  const text = readTextReplace(full);
  return text !== null && MARKER.test(text);
}

/** True when the file cannot be read right now (an editor or a scanner holds it). */
function locked(full: string): boolean {
  try {
    const file = Deno.openSync(full, { read: true });
    try {
      file.readSync(new Uint8Array(1));
    } finally {
      file.close();
    }
    return false;
  } catch {
    return true;
  }
}

/** 'ok' (sync it), 'skip' (never this content) or 'retry' (look again later) for a changed project file. A gone file is 'ok'. */
export function judge(project: string, path: string, sig: Sig | null, unmerged = false): 'ok' | 'skip' | 'retry' {
  if (wt.safeRelative(path) === '' || isTemp(path)) return 'skip';
  if (sig === null) return 'ok';
  if (sig[0] !== 'f' || sig[1] > settings.MAX_BYTES || unmerged) return 'skip';
  const full = join(String(project), path);
  if (locked(full)) return 'retry';
  if (fileTextHasMarkers(full)) return 'skip';
  return 'ok';
}

function sameBytesOf(a: string, b: string): boolean {
  try {
    if (Deno.statSync(a).size !== Deno.statSync(b).size) return false;
    return wt.sameBytes(Deno.readFileSync(a), Deno.readFileSync(b));
  } catch {
    return false;
  }
}

async function sha(full: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = Deno.readFileSync(full);
  } catch {
    return null;
  }
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes as Uint8Array<ArrayBuffer>));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** state_store.replace_with_retry: os.replace, retried for a moment on Windows while another process has the target open. */
async function replaceWithRetry(source: string, target: string): Promise<void> {
  let pause = 20;
  for (let attempt = 0;; attempt++) {
    try {
      Deno.renameSync(source, target);
      return;
    } catch (error) {
      const transient = WIN && (error instanceof Deno.errors.PermissionDenied || error instanceof Deno.errors.Busy);
      if (!transient || attempt >= 7) throw error;
      await sleep(pause);
      pause = Math.min(pause * 2, 400);
    }
  }
}

/** tempfile.mkstemp(prefix='.studio-sync-', suffix='.tmp', dir=folder): a new, empty file. */
function mkstemp(folder: string): string {
  for (let attempt = 0;; attempt++) {
    const name = join(folder, `.studio-sync-${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}.tmp`);
    try {
      Deno.openSync(name, { write: true, createNew: true, mode: 0o600 }).close();
      return name;
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists) || attempt > 50) throw error;
    }
  }
}

/** shutil.copymode: the permission bits (on Windows only the read-only flag, which Studio never sets: nothing to do). */
function copyMode(source: string, target: string): void {
  if (WIN) return;
  try {
    Deno.chmodSync(target, (Deno.statSync(source).mode ?? 0o644) & 0o7777);
  } catch { /* ignored, as Python's OSError */ }
}

/** Write `data` (or the bytes of `source`) over `target` through a temp file in the same folder and a rename. */
async function writeAtomicBytes(target: string, data: Uint8Array, modeFrom: string): Promise<void> {
  const folder = dirname(target);
  Deno.mkdirSync(folder, { recursive: true });
  const temporary = mkstemp(folder);
  try {
    Deno.writeFileSync(temporary, data);
    copyMode(modeFrom, temporary);
    await replaceWithRetry(temporary, target);
  } catch (error) {
    try {
      Deno.removeSync(temporary);
    } catch { /* gone */ }
    throw error;
  }
}

/** Write `source` over `target` (shutil.copyfile: the bytes, not the times). */
async function copyAtomic(source: string, target: string): Promise<void> {
  await writeAtomicBytes(target, Deno.readFileSync(source), source);
}

/** Bytes into wt/path through a temp file and a rename (the mode of an existing file is kept). */
async function writeAtomic(folder: string, path: string, data: Uint8Array): Promise<void> {
  const target = join(folder, path);
  await writeAtomicBytes(target, data, target);
}

/** Delete a synced-away file and the folders that became empty (never the worktree itself). */
function removeFile(root: string, target: string): void {
  Deno.removeSync(target);
  const top = wt.norm(root);
  let folder = dirname(target);
  while (folder && wt.norm(folder) !== top) {
    try {
      Deno.removeSync(folder);
    } catch {
      break;
    }
    const parent = dirname(folder);
    if (parent === folder) break;
    folder = parent;
  }
}

/**
 * Keep the worktree's own index in step, so `git diff <U>` sees a synced new file as the same as U and a synced deletion of a file
 * that was never in HEAD as gone: a new file gets an intent-to-add entry, a removed one loses it.
 */
export async function tellIndex(folder: string, copied: string[], removed: string[], chunk = 100): Promise<void> {
  for (let start = 0; start < copied.length; start += chunk) {
    const part = copied.slice(start, start + chunk);
    const tracked = new Set(
      (await wt.git(['ls-files', '-z', '--', ...part], folder, { check: false })).stdout.split('\0').filter((n) => n),
    );
    const fresh = part.filter((p) => !tracked.has(p));
    if (fresh.length) await wt.git(['add', '-N', '--', ...fresh], folder, { check: false });
  }
  for (const path of removed) {
    if ((await wt.git(['cat-file', '-e', `HEAD:${path}`], folder, { check: false })).returncode !== 0) {
      await wt.git(['update-index', '--force-remove', '--', path], folder, { check: false });
    }
  }
}

// ---- merging what both sides changed (stage G3) -----------------------------------------------------------------------
/** The bytes of a regular file, null when there is none (or it is a symlink or a folder). */
function readBytes(path: string): Uint8Array | null {
  if (islink(path) || !isfile(path)) return null;
  return Deno.readFileSync(path);
}

/** The content of a blob as a checkout in `cwd` would write it (filters applied), null for no blob. */
async function blobBytes(cwd: string, path: string, blob: string): Promise<Uint8Array | null> {
  if (!blob) return null;
  let done = await wt.git(['cat-file', '--filters', `--path=${path}`, blob], cwd, { check: false, binary: true });
  if (done.returncode !== 0) done = await wt.git(['cat-file', 'blob', blob], cwd, { binary: true });
  return done.out;
}

/** The blob id git would store for the file ('' when it is not a regular file). */
async function hashOf(cwd: string, path: string): Promise<string> {
  const full = join(String(cwd), path);
  if (islink(full) || !isfile(full)) return '';
  return pyStrip((await wt.git(['hash-object', `--path=${path}`, '--', full], cwd, { check: false })).stdout);
}

function crlfToLf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) continue;
    out[n++] = bytes[i];
  }
  return out.subarray(0, n);
}

/** Same content, line-ending noise (CRLF against LF) ignored. */
function equalBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (a === null || b === null) return a === b;
  return wt.sameBytes(a, b) || wt.sameBytes(crlfToLf(a), crlfToLf(b));
}

function isBinary(...parts: (Uint8Array | null)[]): boolean {
  return parts.some((p) => p !== null && p.subarray(0, 8000).includes(0));
}

export type MergeKind = 'same' | 'take' | 'delete' | 'clean' | 'conflict' | 'binary' | 'keep_chat_deleted' | 'keep_user_deleted';

/**
 * Combine two versions of a file. base/current/other are bytes or null (no file). Returns [kind, bytes]: same (current stays), take
 * (other replaces it), delete (the file goes), clean / conflict (merged bytes; conflict has markers), binary (cannot merge: keep
 * current), keep_chat_deleted / keep_user_deleted (the chat's side wins). `git merge-file`, no base = empty.
 */
export async function threeWay(
  base: Uint8Array | null,
  current: Uint8Array | null,
  other: Uint8Array | null,
  scratch: string,
): Promise<[MergeKind, Uint8Array | null]> {
  if (current === null && other === null) return ['same', null];
  if (current !== null && other !== null && equalBytes(current, other)) return ['same', current];
  if (other === null) { // the user deleted it
    if (base === null) return ['same', current];
    return equalBytes(current, base) ? ['delete', null] : ['keep_user_deleted', current];
  }
  if (current === null) { // the chat deleted it
    return base !== null && equalBytes(other, base) ? ['same', null] : ['keep_chat_deleted', null];
  }
  if (base !== null && equalBytes(current, base)) return ['take', other];
  if (base !== null && equalBytes(other, base)) return ['same', current];
  if (isBinary(base, current, other)) return ['binary', null];
  for (const [name, data] of [['cur', current], ['base', base ?? new Uint8Array()], ['other', other]] as const) {
    Deno.writeFileSync(join(scratch, name), data);
  }
  const done = await wt.git(
    ['merge-file', '-L', 'chat (your copy)', '-L', 'base', '-L', 'user (project folder)', 'cur', 'base', 'other'],
    scratch,
    { check: false, binary: true },
  );
  if (done.returncode < 0 || done.returncode > 127) {
    throw new GitError('git merge-file failed: ' + done.stderr.slice(0, 200));
  }
  const merged = Deno.readFileSync(join(scratch, 'cur'));
  return [done.returncode ? 'conflict' : 'clean', merged];
}

type Note = [string, string];

function notesOf(value: unknown): Note[] {
  return list(value).filter((n): n is unknown[] => Array.isArray(n) && n.length === 2).map((n) => [n[0], n[1]] as Note);
}

function addNotes(existing: unknown, fresh: Note[]): Note[] {
  const found = notesOf(existing);
  const key = (n: unknown[]) => JSON.stringify(n);
  for (const item of fresh) {
    if (!found.some((n) => key(n) === key(item))) found.push([item[0], item[1]]);
  }
  return found.slice(-MAX_STORED_PATHS);
}

/** The files of the record's syncConflicts that still have conflict markers in the chat's copy (read only). */
export function openClashes(record: WorktreeRecord): string[] {
  const folder = str(record.path);
  return strings(record.syncConflicts).filter((p) => fileTextHasMarkers(join(folder, p)));
}

function shownList(files: string[], limit: number): string {
  return files.slice(0, limit).join(', ') + (files.length > limit ? ' and more' : '');
}

export function clashLine(files: string[]): string {
  return `Waiting for the chat to resolve a clash with your edits in ${shownList(files, 12)}. ` +
    'It was asked to combine your version and its own in its copy; Merge is available once the conflict markers are gone.';
}

/**
 * Registry update under its lock (Python: `with registry.lock: now = registry.get(key) or {}; ...; registry.update(key, **fields)`).
 * `build` gets the current record and returns the fields to set ({} or null: nothing to save). A missing record is left alone.
 */
async function amend(
  registry: wt.Registry,
  key: string,
  build: (now: WorktreeRecord) => Record<string, unknown> | null,
): Promise<void> {
  await registry.mutate((items) => {
    const now = items.get(key);
    const fields = build(now ?? {});
    if (!now || !fields || !Object.keys(fields).length) return false;
    const next: WorktreeRecord = {};
    for (const [k, v] of entriesOf(now)) put(next, k, v);
    for (const [k, v] of Object.entries(fields)) put(next, k, v);
    items.set(key, next);
    return true;
  });
}

/**
 * Clear the syncConflicts whose markers are gone from the chat's copy and move U to include the user's version of them. Call with the
 * worktree lock held. Returns the paths still unresolved. If the project's file changed again since, U is not moved: the path goes
 * back to pendingSync to be merged again.
 */
export async function settleConflicts(registry: wt.Registry, record: WorktreeRecord & { key: string }): Promise<string[]> {
  const key = record.key;
  const left = list(record.syncConflicts) as string[];
  if (!left.length) return [];
  const still = openClashes(record);
  const done = left.filter((p) => !still.includes(p));
  if (!done.length) return still;
  const merged = isDict(record.syncMerged) ? record.syncMerged : {};
  const advance: string[] = [];
  const again: string[] = [];
  for (const path of done) {
    const blob = Object.hasOwn(merged, path) ? merged[path] : undefined;
    const matches = blob !== undefined && blob !== null &&
      (await wt.fileMatchesBlob(str(record.project), path, blob === '-' ? '' : pyStr(blob)));
    (matches ? advance : again).push(path);
  }
  if (advance.length) await wt.advanceUserBase(record, advance, registry);
  await amend(registry, key, (now) => {
    const syncMerged = dictOf(now.syncMerged);
    for (const path of done) syncMerged.delete(path);
    return {
      syncConflicts: list(now.syncConflicts).filter((p) => !done.includes(p as string)),
      syncMerged,
      pendingSync: unique([...list(now.pendingSync), ...again]),
    };
  });
  return still;
}

export const NOTE_TEXT: Record<string, string> = {
  binary: 'These binary files were changed by both you and the user. They cannot be merged, so your version was kept',
  keep_chat_deleted: 'The user edited these files, which you deleted. Your deletion was kept',
  keep_user_deleted: 'The user deleted these files, which you edited. Your copy was kept',
  env: 'The user changed these .env files, which you also changed. Env files are never merged, so your version was kept',
};

// ---- small async primitives (Python's threading.Event and RLock) -------------------------------------------------------
/** threading.Event: set / clear / isSet / wait(seconds) -> whether it is set. */
export class Flag {
  #set = false;
  #waiters = new Set<() => void>();

  set(): void {
    this.#set = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  clear(): void {
    this.#set = false;
  }

  isSet(): boolean {
    return this.#set;
  }

  wait(seconds: number): Promise<boolean> {
    if (this.#set) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve(this.#set);
      };
      const timer = setTimeout(done, Math.max(0, seconds * 1000));
      this.#waiters.add(done);
    });
  }
}

/** One holder at a time, in arrival order. */
export class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

/** Wait for `promise` at most `seconds` (thread.join(timeout)); true when it ended. */
async function within(promise: Promise<unknown> | null | undefined, seconds: number): Promise<boolean> {
  if (!promise) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), seconds * 1000)));
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ---- watching a folder ------------------------------------------------------------------------------------------------
/**
 * Deno.watchFs on a folder tree (ReadDirectoryChangesW on Windows). Calls poke(name) for each changed path relative to the folder
 * ('' when the watcher asks for a rescan). Never throws; if the folder cannot be watched it ends and the caller's poll carries on.
 */
export class DirWatcher {
  #watcher: Deno.FsWatcher | null = null;
  #stopped = false;
  done: Promise<void> | null = null;
  alive = false;

  constructor(readonly folder: string, readonly poke: (name: string) => void) {}

  start(): void {
    try {
      this.#watcher = Deno.watchFs(this.folder, { recursive: true });
    } catch (error) {
      log.warning('The folder watcher of %s could not start; the poll carries on: %s', this.folder, errorText(error));
      return;
    }
    this.alive = true;
    const watcher = this.#watcher;
    const root = normcase(this.folder).replace(/[\\/]+$/, '');
    const relative = (path: string): string => {
      const here = normcase(path.replace(/^\\\\\?\\/, ''));
      if (here.startsWith(root + (WIN ? '\\' : '/'))) return path.replace(/^\\\\\?\\/, '').slice(root.length + 1);
      return '';
    };
    this.done = (async () => {
      try {
        for await (const event of watcher) {
          if (this.#stopped) break;
          if (event.flag === 'rescan') {
            this.poke('');
            continue;
          }
          if (event.kind === 'access') continue; // Python's filter: names, size, last write, creation
          for (const path of event.paths) this.poke(relative(path));
        }
      } catch (error) {
        if (!this.#stopped) log.exception(error, 'The folder watcher stopped; the poll carries on');
      } finally {
        this.alive = false;
      }
    })();
  }

  /** Close the watch (and its directory handle) and wait until the reading task has ended. */
  async stop(timeout = 5): Promise<void> {
    this.#stopped = true;
    try {
      this.#watcher?.close();
    } catch { /* already closed */ }
    if (!(await within(this.done, timeout))) {
      log.warning('The folder watcher of %s did not stop in %s s', this.folder, timeout);
    }
  }
}

// ---- one project ---------------------------------------------------------------------------------------------------
export class ProjectSync {
  readonly project: string;
  readonly lock = new Mutex();
  readonly stop = new Flag();
  readonly event = new Flag();
  readonly baselined = new Flag();
  head: string | null = null;
  files = new Map<string, Sig | null>();
  seen = new Map<string, Sig | null>();
  unmerged = new Set<string>();
  reset = true;
  wasPaused = false;
  waiting = 0; // seconds until the next scan the unfinished work wants (0: none)
  envPaths: string[] = [];
  envNext = 0;
  envDirty = true;
  notifier: DirWatcher | null = null;
  done: Promise<void> | null = null;

  constructor(readonly live: LiveSync, project: string) {
    this.project = String(project);
  }

  // -- triggers
  poke = (name?: string | null): void => {
    const base = (name || '').replaceAll('\\', '/');
    if (name && (base === '.git' || base.startsWith('.git/') || ('/' + base).includes('/node_modules/') || isTemp(base))) return;
    if (name && isEnv(base)) this.envDirty = true;
    this.event.set();
  };

  start(): void {
    this.ensureNotifier();
    this.done = this.run();
  }

  /** The folder watcher runs only while the project is being synced (not after stop, not while paused). */
  ensureNotifier(): void {
    if (!WIN || !this.live.watchFolders) return;
    if (this.stop.isSet() || (this.notifier !== null && this.notifier.alive)) return;
    this.notifier = new DirWatcher(this.project, this.poke);
    this.notifier.start();
  }

  /** Close the project folder's watch: the folder can be renamed or deleted afterwards. */
  async releaseNotifier(): Promise<void> {
    const notifier = this.notifier;
    this.notifier = null;
    if (notifier) await notifier.stop();
  }

  /** Stop syncing this project: the watch is closed and (with wait) the sync task has ended when this resolves (up to a timeout). */
  async close(wait = true): Promise<void> {
    this.stop.set();
    this.event.set();
    this.baselined.set(); // a chat-open catch-up waiting for the baseline goes on (Python: its 10 s wait ran out)
    await this.releaseNotifier();
    if (wait) await within(this.done, settings.CLOSE_WAIT);
  }

  // -- the loop
  async run(): Promise<void> {
    const live = this.live;
    let wait = 0;
    try {
      while (!this.stop.isSet()) {
        const poked = await this.event.wait(wait);
        if (this.stop.isSet()) break;
        if (poked) {
          const began = nowMono();
          for (;;) {
            this.event.clear();
            if (await this.stop.wait(live.settle)) return;
            if (!this.event.isSet() || nowMono() - began > live.maxSettle) break;
          }
        }
        if (!live.wanted(this.project)) break;
        try {
          await this.lock.run(() => this.scan());
        } catch (error) {
          log.exception(error, 'Live sync of %s failed', this.project);
        }
        wait = this.waiting ? Math.min(this.waiting, live.poll) : live.poll;
      }
    } finally {
      await this.releaseNotifier();
      live.forget(this);
    }
  }

  // -- one scan
  /** {path: sig} of the candidates now: what git status lists, plus the .env* files. */
  async listing(): Promise<Map<string, Sig | null>> {
    const statuses = await statusPaths(this.project);
    this.unmerged = new Set([...statuses].filter(([, code]) => UNMERGED.has(code)).map(([p]) => p));
    const found = new Map<string, Sig | null>();
    for (const path of statuses.keys()) found.set(path, sigOf(this.project, path));
    const now = nowMono();
    if (this.envDirty || now >= this.envNext) {
      this.envPaths = envFiles(this.project);
      this.envNext = now + settings.ENV_WALK_EVERY;
      this.envDirty = false;
    }
    for (const path of this.envPaths) {
      if (!found.has(path)) found.set(path, sigOf(this.project, path));
    }
    return found;
  }

  /** One scan (call with this.lock held, as run() does). */
  async scan(): Promise<void> {
    const live = this.live, project = this.project, stateDir = this.live.stateDir;
    this.waiting = 0;
    if (await wt.syncPaused(stateDir, project)) {
      this.reset = true; // Merge is stashing: whatever the folder looks like now is not the user's saving
      return;
    }
    if (pauseInfo(stateDir, project)) {
      this.wasPaused = true;
      this.reset = true;
      await this.releaseNotifier(); // paused: nothing is watched, no handle on the folder
      return;
    }
    const head = pyStrip((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], project, { check: false })).stdout);
    const current = await this.listing();
    if (this.wasPaused) { // Resume: the chats catch up on what happened meanwhile, then the baseline restarts
      this.wasPaused = false;
      this.ensureNotifier();
      await live.catchUpProject(project, this.stop, this.lock);
      this.reset = true;
    }
    await live.retryStale(this.lock);
    if (this.reset || this.head === null || head !== this.head) {
      this.head = head;
      this.files = current;
      this.seen = new Map();
      this.reset = false;
      this.baselined.set();
      return;
    }
    let changed = new Map<string, Sig | null>();
    for (const [path, sig] of current) {
      if (!sameSig(this.files.has(path) ? this.files.get(path) : undefined, sig)) changed.set(path, sig);
    }
    for (const [path, old] of this.files) {
      if (!current.has(path)) {
        const sig = sigOf(project, path);
        if (!sameSig(sig, old)) changed.set(path, sig);
      }
    }
    changed = new Map([...changed].filter(([p]) => !isTemp(p)));
    for (const path of [...this.seen.keys()].filter((p) => !changed.has(p))) this.seen.delete(path);
    if (changed.size > live.storm) {
      await setPaused(stateDir, project, changed.size);
      await this.releaseNotifier();
      this.wasPaused = true; // Resume restarts the watcher and catches the chats up
      this.head = head;
      this.files = current;
      this.seen = new Map();
      this.reset = true;
      log.warning('Live sync of %s paused: %s files changed at once', project, changed.size);
      return;
    }
    const ready = new Map<string, Sig | null>();
    const handled = new Set<string>();
    for (const [path, sig] of changed) {
      if (!sameSig(this.seen.has(path) ? this.seen.get(path) : null, sig)) {
        this.seen.set(path, sig);
        this.waiting = live.settle; // the same size and mtime on two scans in a row
        continue;
      }
      const verdict = judge(project, path, sig, this.unmerged.has(path));
      if (verdict === 'retry') {
        this.waiting = Math.max(this.waiting, live.poll);
        continue;
      }
      handled.add(path);
      if (verdict === 'ok') ready.set(path, sig);
    }
    if (ready.size) await live.syncReady(project, ready);
    const files = new Map(current);
    for (const path of changed.keys()) {
      if (!handled.has(path)) { // not decided yet: it stays "changed" for the next scan
        if (this.files.has(path)) files.set(path, this.files.get(path)!);
        else files.delete(path);
      }
    }
    for (const path of handled) this.seen.delete(path);
    this.files = files;
  }
}

// ---- all projects ----------------------------------------------------------------------------------------------------
/** A chat connection as live sync sees it. public(0) is the chat's public state (the idle check). */
export interface SyncConnection {
  cwd: string;
  closed?: boolean;
  worktree?: unknown;
  public(since?: number): unknown;
}

/** What live sync needs from the Studio of the agent host. */
export interface SyncStudio {
  stateDir: string;
  worktrees: { registry: wt.Registry } | null;
  settings: { worktreePerChat(): boolean };
  connections: { values(): Iterable<SyncConnection> };
}

export type Outcome = 'ok' | 'busy' | 'blocked' | 'paused' | 'gone' | 'off';

/**
 * True when the chat takes the folder's edits only from one branch (record.editsFrom) and the project folder has another one checked
 * out now. Records from before (no editsFrom) are never held back.
 */
export async function folderOffBranch(record: WorktreeRecord): Promise<boolean> {
  const wanted = str(record.editsFrom);
  if (!wanted) return false;
  const done = await wt.git(['symbolic-ref', '-q', '--short', 'HEAD'], str(record.project), { check: false });
  return done.returncode !== 0 || pyStrip(done.stdout) !== wanted;
}
export type Items = Map<string, Sig | null>;

export class LiveSync {
  settle: number;
  poll: number;
  maxSettle = settings.MAX_SETTLE;
  storm = settings.STORM;
  readonly watchFolders: boolean;
  readonly projects = new Map<string, ProjectSync>();
  workers: Promise<void>[] = []; // the catch-up tasks of chats that just opened
  readonly stale = new Set<string>(); // chat keys that could not take a sync (a merge in progress, a lock): caught up later
  closed = false;
  readonly hooks = new Mutex(); // the turn hooks run under it; stopAll waits for the ones in flight

  constructor(readonly studio: SyncStudio, settle = settings.SETTLE, poll = settings.POLL, watchFolders = true) {
    this.settle = settle;
    this.poll = poll;
    this.watchFolders = watchFolders;
  }

  // -- who is watched
  get stateDir(): string {
    return this.studio.stateDir;
  }

  get registry(): wt.Registry {
    return this.studio.worktrees!.registry;
  }

  enabled(): boolean {
    return !!(this.studio.worktrees && this.studio.settings.worktreePerChat() && !this.closed);
  }

  /** [key, record] of the open, Studio-owned worktree chats (of one project). */
  chats(project: string | null = null): [string, WorktreeRecord & { key: string }][] {
    const found: [string, WorktreeRecord & { key: string }][] = [];
    const seen = new Set<string>();
    if (!this.studio.worktrees) return found;
    const connections = [...this.studio.connections.values()].filter((c) => !c.closed && pyTruthy(c.worktree ?? null));
    for (const connection of connections) {
      const record = this.registry.find(connection.cwd);
      if (!record || seen.has(record.key) || (project !== null && !wt.same(str(record.project), project))) continue;
      seen.add(record.key);
      found.push([record.key, record]);
    }
    return found;
  }

  wanted(project: string): boolean {
    return this.enabled() && this.chats(project).length > 0;
  }

  /** Start a watcher for each project that has an open worktree chat, stop the others. Cheap; called when a chat opens or closes. */
  async refresh(): Promise<void> {
    const wanted = new Map<string, string>();
    if (this.enabled()) {
      for (const [, record] of this.chats()) {
        const key = projectKey(str(record.project));
        if (!wanted.has(key)) wanted.set(key, str(record.project));
      }
    }
    const gone: ProjectSync[] = [];
    for (const key of [...this.projects.keys()]) {
      if (!wanted.has(key)) {
        gone.push(this.projects.get(key)!);
        this.projects.delete(key);
      }
    }
    for (const [key, project] of wanted) {
      if (!this.projects.has(key)) {
        const sync = new ProjectSync(this, project);
        this.projects.set(key, sync);
        sync.start();
      }
    }
    for (const sync of gone) await sync.close();
  }

  forget(sync: ProjectSync): void {
    const key = projectKey(sync.project);
    if (this.projects.get(key) === sync) this.projects.delete(key);
  }

  async stopAll(): Promise<void> {
    this.closed = true;
    await this.hooks.run(() => {}); // a turn hook that is merging finishes first
    const items = [...this.projects.values()];
    this.projects.clear();
    await Promise.all(items.map((sync) => sync.close(false)));
    for (const sync of items) await within(sync.done, settings.CLOSE_WAIT);
    for (const worker of [...this.workers]) await within(worker, 5);
  }

  /** Run `work` under the project's scan lock (Python's RLock: `held` is the lock the caller already holds). */
  async underProjectLock<T>(project: string, work: () => Promise<T>, held: Mutex | null = null): Promise<T> {
    const sync = this.projects.get(projectKey(project));
    if (!sync || sync.lock === held) return await work();
    return await sync.lock.run(work);
  }

  // -- hooks from Studio
  /**
   * A worktree chat is ready (new, resumed or reconnected at host start): watch its project and catch it up on what the user saved
   * while it was closed (in the background: opening a chat never waits for this).
   */
  async chatOpened(connection: SyncConnection): Promise<void> {
    if (!this.enabled() || !pyTruthy(connection.worktree ?? null)) return;
    await this.refresh();
    const record = this.registry.find(connection.cwd);
    if (!record) return;
    const work = async () => {
      const sync = this.projects.get(projectKey(str(record.project)));
      if (sync) await sync.baselined.wait(10); // the baseline first, so a save between the two is seen by one or the other
      try {
        await this.catchUp(record.key);
      } catch (error) {
        log.exception(error, 'Live sync catch-up of %s failed', record.path);
      }
    };
    const task = work();
    this.workers = [...this.workers, task];
    task.finally(() => (this.workers = this.workers.filter((t) => t !== task)));
  }

  /**
   * A prompt is about to go to the agent: finish the last turn's guard if it could not run, catch up on what the user saved, merge the
   * files both sides changed, and remember U as the turn's starting point for the lost-update guard.
   */
  turnStarted(connection: SyncConnection): Promise<void> {
    return this.hooks.run(() => this.#turnStarted(connection));
  }

  async #turnStarted(connection: SyncConnection): Promise<void> {
    if (!pyTruthy(connection.worktree ?? null) || !this.enabled()) return;
    const record = this.registry.find(connection.cwd);
    if (!record) return;
    const key = record.key;
    await this.finishTurn(connection);
    await this.catchUp(key);
    await this.mergePending(connection, true);
    await this.withWorktree(key, async (rec) => {
      if (!rec.turnUser) {
        await this.registry.update(key, { turnUser: rec.user || rec.snapshot || '', turnSynced: [] });
      }
      return 'ok';
    });
  }

  /** The agent finished a turn: the lost-update guard, then the files both sides changed. */
  turnEnded(connection: SyncConnection): Promise<void> {
    return this.hooks.run(async () => {
      if (!pyTruthy(connection.worktree ?? null) || !this.enabled()) return;
      await this.finishTurn(connection);
      await this.mergePending(connection, true);
    });
  }

  // -- merging what both sides changed (stage G3)
  /**
   * True when nothing of the chat is running. At a turn boundary 'busy' and queued messages do not count (the queued message starts
   * only after the hook returns); a terminal or subagent that is still running does.
   */
  async chatIdle(connection: SyncConnection, atTurnBoundary: boolean): Promise<boolean> {
    let state: unknown;
    try {
      state = await connection.public(0);
    } catch {
      return false;
    }
    return !stateIdleReason(isDict(state) ? state : {}, !atTurnBoundary, !atTurnBoundary);
  }

  /**
   * Run work(record) with the worktree's lock held, unless sync is paused or the worktree cannot take files. Returns work's result,
   * or 'gone', 'busy', 'paused' or 'blocked'.
   */
  async withWorktree(key: string, work: (record: WorktreeRecord & { key: string }) => Promise<Outcome>): Promise<Outcome> {
    const registry = this.registry;
    const found = registry.get(key);
    if (!found || found.status !== 'ready') return 'gone';
    const record: WorktreeRecord & { key: string } = { ...found, key };
    const lock = wt.worktreeLock(this.stateDir, record, settings.WORKTREE_WAIT);
    try {
      await lock.acquire();
    } catch {
      return 'busy';
    }
    try {
      if (await wt.syncPaused(this.stateDir, str(record.project))) return 'paused';
      if (await this.blocked(record, true)) return 'blocked';
      return await work({ ...(registry.get(key) ?? record), key });
    } catch (error) {
      if (!(error instanceof GitError) && !isOSError(error)) throw error;
      log.warning("Merging the user's edits into %s failed: %s", record.path, errorText(error));
      return 'blocked';
    } finally {
      lock.release();
    }
  }

  /**
   * Merge the files in pendingSync (both the chat and the user changed them): `git merge-file` with current = the chat's file, base =
   * U's version, other = the project's. Only while the chat is idle, under the worktree lock, never while sync is paused.
   */
  async mergePending(connection: SyncConnection, atTurnBoundary = false): Promise<Outcome> {
    if (!pyTruthy(connection.worktree ?? null) || !this.enabled()) return 'off';
    const record = this.registry.find(connection.cwd);
    if (!record) return 'gone';
    if (!(await this.chatIdle(connection, atTurnBoundary))) return 'busy';
    if (await folderOffBranch(record)) return 'blocked'; // the folder's version is another branch's: the pending files wait
    return await this.withWorktree(record.key, async (rec) => {
      await settleConflicts(this.registry, rec);
      const fresh: WorktreeRecord & { key: string } = { ...(this.registry.get(rec.key) ?? rec), key: rec.key };
      const paths = strings(fresh.pendingSync);
      if (paths.length) await this.combine(fresh, paths);
      return 'ok';
    });
  }

  /**
   * The lost-update guard. Live sync may have written the user's version of a file during the turn that the agent had already read;
   * if it then wrote its stale copy back, the user's edit would be undone. For every path synced during the turn: merge again with
   * current = the worktree, base = U at the turn's start, other = U now. Running it twice changes nothing.
   */
  async finishTurn(connection: SyncConnection): Promise<Outcome> {
    if (!pyTruthy(connection.worktree ?? null) || !this.enabled()) return 'off';
    const record = this.registry.find(connection.cwd);
    if (!record || !record.turnUser) return 'ok';
    if (!(await this.chatIdle(connection, true))) return 'busy';
    return await this.withWorktree(record.key, async (rec) => {
      const start = str(rec.turnUser);
      const paths = strings(rec.turnSynced);
      if (paths.length && (await wt.git(['cat-file', '-e', start + '^{commit}'], str(rec.path), { check: false })).returncode === 0) {
        await this.combine(rec, paths, start);
      }
      await this.registry.update(rec.key, { turnUser: '', turnSynced: [] });
      return 'ok';
    });
  }

  /**
   * The 3-way merge of `paths` into the chat's worktree (worktree lock held). Pending files (no guardBase): base = U's version, other =
   * the project folder's. The guard: base = guardBase's version, other = U's. Records the outcome in the registry.
   */
  async combine(
    record: WorktreeRecord & { key: string },
    paths: string[],
    guardBase: string | null = null,
  ): Promise<{ written: string[]; conflicts: string[]; notes: Note[] }> {
    const registry = this.registry, key = record.key;
    const project = str(record.project), folder = str(record.path);
    const user = str(record.user) || str(record.snapshot);
    const done: string[] = [], advance: string[] = [], written: string[] = [], notes: Note[] = [];
    const conflicts = new Map<string, string>(), kept = new Map<string, string>(), mergedWith = new Map<string, string>();
    const knownKept = isDict(record.syncKept) ? record.syncKept : {};
    const scratch = Deno.makeTempDirSync({ prefix: '.studio-merge-', dir: await wt.gitDirOf(folder) });
    const revParse = async (spec: string) =>
      pyStrip((await wt.git(['rev-parse', '--verify', '-q', spec], folder, { check: false })).stdout);
    try {
      for (const path of paths) {
        if (wt.safeRelative(path) === '') {
          done.push(path);
          continue;
        }
        const full = join(folder, path);
        if (isEnv(path)) {
          done.push(path); // never merged: the chat's version stays
          continue;
        }
        if (islink(full) || isdir(full)) {
          done.push(path);
          continue;
        }
        const current = readBytes(full);
        let base: Uint8Array | null, other: Uint8Array | null, blob: string;
        if (guardBase === null) {
          const source = join(project, path);
          if (islink(source) || isdir(source)) {
            done.push(path);
            continue;
          }
          other = readBytes(source);
          if (other !== null && (other.length > settings.MAX_BYTES || MARKER.test(new TextDecoder('utf-8').decode(other)))) {
            continue; // not something to merge now: stays pending
          }
          blob = other !== null ? await hashOf(project, path) : '';
          base = await blobBytes(folder, path, await revParse(`${user}:${path}`));
          if (Object.hasOwn(knownKept, path) && knownKept[path] === (blob || '-')) {
            done.push(path); // kept the chat's way already, and the user's file has not changed since
            continue;
          }
        } else {
          const startBlob = await revParse(`${guardBase}:${path}`);
          const nowBlob = await revParse(`${user}:${path}`);
          if (!startBlob) continue; // the file did not exist when the turn began: the agent cannot have read an older version
          base = await blobBytes(folder, path, startBlob);
          other = await blobBytes(folder, path, nowBlob);
          blob = nowBlob;
        }
        const [kind, data] = await threeWay(base, current, other, scratch);
        if (kind === 'same') {
          if (guardBase === null) {
            advance.push(path);
            mergedWith.set(path, blob);
          }
        } else if (kind === 'take' || kind === 'clean') {
          await writeAtomic(folder, path, data!);
          written.push(path);
          if (guardBase === null) {
            advance.push(path);
            mergedWith.set(path, blob);
          }
        } else if (kind === 'delete') {
          if (isfile(full)) removeFile(folder, full);
          written.push(path);
          if (guardBase === null) {
            advance.push(path);
            mergedWith.set(path, blob);
          }
        } else if (kind === 'conflict') {
          await writeAtomic(folder, path, data!);
          conflicts.set(path, blob || '-');
        } else { // binary, keep_chat_deleted, keep_user_deleted
          notes.push([path, kind]);
          kept.set(path, blob || '-');
        }
        if (guardBase === null) done.push(path);
      }
    } finally {
      try {
        Deno.removeSync(scratch, { recursive: true });
      } catch { /* ignore_errors */ }
    }
    let landed: string[] = [];
    if (advance.length) landed = await this.advanceChecked(record, advance, mergedWith);
    if (written.length) await tellIndex(folder, written.filter((p) => wt.lexists(join(folder, p))), []);
    await amend(registry, key, (now) => {
      const fields: Record<string, unknown> = {};
      const keepPending = list(now.pendingSync).filter((p) =>
        !done.includes(p as string) || (advance.includes(p as string) && !landed.includes(p as string))
      );
      if (guardBase === null) fields.pendingSync = keepPending;
      if (conflicts.size) {
        fields.syncConflicts = unique([...list(now.syncConflicts), ...conflicts.keys()]);
        const merged = dictOf(now.syncMerged);
        for (const [k, v] of conflicts) merged.set(k, v);
        fields.syncMerged = merged;
      }
      if (kept.size) {
        const keptNow = dictOf(now.syncKept);
        for (const [k, v] of kept) keptNow.set(k, v);
        fields.syncKept = keptNow;
      }
      if (notes.length) fields.syncNotes = addNotes(now.syncNotes, notes);
      const told = written.filter((p) => !conflicts.has(p));
      if (told.length) fields.syncedPaths = unique([...list(now.syncedPaths), ...told]).slice(-MAX_STORED_PATHS);
      return fields;
    });
    return { written, conflicts: [...conflicts.keys()], notes };
  }

  /**
   * advanceUserBase for `paths`, but only for the content that was merged (`expected` maps a path to the blob id of the user's version,
   * '' or '-' for gone): a file the user saved again meanwhile is left for the next merge, and U goes back if it took such a version.
   */
  async advanceChecked(record: WorktreeRecord & { key: string }, paths: string[], expected: Map<string, string>): Promise<string[]> {
    const registry = this.registry;
    const project = str(record.project), previous = str(record.user) || str(record.snapshot);
    const want = (path: string) => {
      const value = expected.get(path);
      return value === undefined || value === '' || value === '-' ? '' : value;
    };
    const stable: string[] = [];
    for (const path of paths) if ((await hashOf(project, path)) === want(path)) stable.push(path);
    if (!stable.length) return [];
    const fresh = await wt.advanceUserBase(record, stable, registry);
    for (const path of stable) {
      const blob = pyStrip((await wt.git(['rev-parse', '--verify', '-q', `${fresh}:${path}`], project, { check: false })).stdout);
      if (blob !== want(path)) { // saved again while U was built
        await wt.pinUserBase(project, record, previous);
        await registry.update(record.key, { user: previous, diffBase: previous });
        return [];
      }
    }
    return stable;
  }

  /**
   * [text, token] of the note for the chat's next prompt, or null. One <studio-context> block: the files the user changed, then what
   * clashed (every prompt, until the chat has resolved it), then what could not be merged and was kept the chat's way.
   */
  contextFor(connection: SyncConnection): [string, { paths: string[]; notes: Note[] }] | null {
    if (!pyTruthy(connection.worktree ?? null) || !this.enabled()) return null;
    const record = this.registry.find(connection.cwd);
    if (!record) return null;
    // deno-lint-ignore no-control-regex
    const clean = (items: string[]) => items.slice(0, MAX_NOTE_PATHS).map((p) => String(p).replace(/[<>\x00-\x1f]/g, '?'));
    const listing = (items: string[]) =>
      clean(items).join(', ') + (items.length > MAX_NOTE_PATHS ? ` and ${items.length - MAX_NOTE_PATHS} more` : '');
    const paths = strings(record.syncedPaths);
    const notes = notesOf(record.syncNotes).filter((n) => typeof n[0] === 'string');
    const clashes = strings(record.syncConflicts);
    const lines: string[] = [];
    if (paths.length) lines.push(`The user changed these files since your last turn: ${listing(paths)}`);
    if (clashes.length) {
      lines.push(
        `These files have a clash between your edit and the user's: ${listing(clashes)}. AIB put conflict markers in them. ` +
          'Resolve each in your own copy: keep what both intended, remove every conflict marker and save the file. ' +
          'AIB clears the clash once the markers are gone.',
      );
    }
    for (const [kind, text] of Object.entries(NOTE_TEXT)) {
      const named = notes.filter((n) => n[1] === kind).map((n) => n[0]);
      if (named.length) lines.push(`${text}: ${listing(named)}`);
    }
    if (!lines.length) return null;
    return ['<studio-context>' + lines.join('\n') + '</studio-context>', { paths, notes }];
  }

  async contextSent(connection: SyncConnection, tokenIn: unknown): Promise<void> {
    const record = this.studio.worktrees ? this.registry.find(connection.cwd) : null;
    if (!record) return;
    const token = isDict(tokenIn) ? tokenIn : { paths: tokenIn, notes: [] };
    const sent = new Set(strings(token.paths));
    const noted = list(token.notes).map((n) => JSON.stringify(list(n)));
    await amend(this.registry, record.key, (now) => ({
      syncedPaths: list(now.syncedPaths).filter((p) => !sent.has(p as string)),
      syncNotes: list(now.syncNotes).filter((n) => !noted.includes(JSON.stringify(list(n)))),
    }));
  }

  // -- syncing
  /** The watcher found stable changes in the project: every open chat of it takes them. */
  async syncReady(project: string, items: Items): Promise<void> {
    for (const [key] of this.chats(project)) {
      const outcome = await this.syncChat(key, items);
      if (outcome === 'busy' || outcome === 'blocked') this.stale.add(key);
    }
  }

  async retryStale(held: Mutex | null = null): Promise<void> {
    for (const key of [...this.stale]) {
      const outcome = await this.catchUp(key, null, held);
      if (outcome !== 'busy' && outcome !== 'blocked' && outcome !== 'paused') this.stale.delete(key);
    }
  }

  async catchUpProject(project: string, stop: Flag | null = null, held: Mutex | null = null): Promise<void> {
    for (const [key] of this.chats(project)) {
      if (stop !== null && stop.isSet()) return;
      await this.catchUp(key, stop, held);
    }
  }

  /** Why this worktree cannot take files now ('' when it can). `merging`: a clash with the user's edits does not stop merging others. */
  async blocked(record: WorktreeRecord, merging = false): Promise<string> {
    const path = str(record.path);
    if (!isdir(path)) return 'the folder is gone';
    if (pyTruthy(record.mergeConflicts ?? null) || (pyTruthy(record.syncConflicts ?? null) && !merging)) return 'conflicts to resolve';
    let head: string;
    try {
      const gitdir = await wt.gitDirOf(path);
      for (const [name, label] of GIT_STATES) {
        if (wt.lexists(join(gitdir, name))) return `${label} is in progress`;
      }
      if (wt.lexists(join(gitdir, 'index.lock'))) return 'git is busy there';
      head = pyStrip((await wt.git(['symbolic-ref', '-q', 'HEAD'], path, { check: false })).stdout);
    } catch (error) {
      if (error instanceof GitError) return 'git cannot be read there';
      throw error;
    }
    if (head !== 'refs/heads/' + str(record.branch)) return 'its HEAD is not on its own branch';
    return '';
  }

  /**
   * Copy the project's current version of `items` ({path: sig or null}) into the chat's worktree where the chat has not touched them.
   * Returns 'ok', 'busy' (lock held), 'blocked', 'paused' or 'gone'.
   */
  async syncChat(key: string, items: Items, envExtra: string[] = [], stop: Flag | null = null): Promise<Outcome> {
    const registry = this.registry;
    const found = registry.get(key);
    if (!found || found.status !== 'ready') return 'gone';
    let record: WorktreeRecord & { key: string } = { ...found, key };
    const project = str(record.project), folder = str(record.path);
    if (await folderOffBranch(record)) return 'blocked'; // edits on another branch are not this chat's; caught up when the folder is back
    const lock = wt.worktreeLock(this.stateDir, record, settings.WORKTREE_WAIT);
    try {
      await lock.acquire();
    } catch {
      return 'busy';
    }
    try {
      if (await wt.syncPaused(this.stateDir, project)) return 'paused';
      if (pyTruthy(record.syncConflicts ?? null)) {
        await settleConflicts(registry, record); // the chat may have resolved a clash since
        record = { ...(registry.get(key) ?? record), key };
      }
      const why = await this.blocked(record);
      if (why) {
        log.info('Live sync skips %s: %s', folder, why);
        return 'blocked';
      }
      const user = str(record.user) || str(record.snapshot);
      if (!user) return 'blocked';
      const synced: string[] = [], moved: string[] = [], pending: string[] = [], notes: Note[] = [];
      const env = dictOf(record.env);
      const copied: string[] = [], removed: string[] = [];
      let envChanged = false;
      for (const path of [...items.keys(), ...envExtra.filter((p) => !items.has(p))]) {
        if (this.closed || (stop !== null && stop.isSet())) break; // stopped meanwhile: what is left is caught up at the next start
        if (wt.safeRelative(path) === '') continue;
        const src = join(project, path), dst = join(folder, path);
        const sig = items.has(path) ? items.get(path)! : null;
        if (sig !== null && !sameSig(sigOf(project, path), sig)) continue; // saved again while we looked: the next scan has it
        const blob = pyStrip((await wt.git(['rev-parse', '--verify', '-q', `${user}:${path}`], folder, { check: false })).stdout);
        const envRoute = isEnv(path) && !blob &&
          (await wt.git(['check-ignore', '-q', '--', path], project, { check: false })).returncode === 0;
        if (envExtra.includes(path) && !items.has(path) && !envRoute) continue;
        try {
          if (envRoute) {
            const outcome = await this.syncEnv(project, folder, path, env);
            if (outcome === 'synced') synced.push(path);
            envChanged = envChanged || outcome === 'synced' || outcome === 'seen' || outcome === 'kept_new';
            if (outcome === 'kept_new') notes.push([path, 'env']);
            continue;
          }
          if (!(await wt.fileMatchesBlob(folder, path, blob))) {
            pending.push(path); // the chat has changed it: stage G3
            continue;
          }
          if (wt.lexists(src)) {
            if (islink(src) || !isfile(src)) continue;
            if (wt.lexists(dst) && sameBytesOf(src, dst)) continue;
            await copyAtomic(src, dst);
            copied.push(path);
          } else if (isfile(dst) && !islink(dst)) {
            removeFile(folder, dst);
            removed.push(path);
          } else continue;
          synced.push(path);
          moved.push(path);
        } catch (error) {
          if (!isOSError(error)) throw error;
          log.warning('Live sync could not write %s into %s: %s', path, folder, errorText(error));
        }
      }
      if (moved.length) {
        await tellIndex(folder, copied, removed);
        await wt.advanceUserBase(record, moved, registry);
      }
      await amend(registry, key, (now) => {
        const fields: Record<string, unknown> = {};
        if (pending.length) fields.pendingSync = unique([...list(now.pendingSync), ...pending]).slice(0, MAX_STORED_PATHS);
        if (synced.length) fields.syncedPaths = unique([...list(now.syncedPaths), ...synced]).slice(-MAX_STORED_PATHS);
        if (envChanged) fields.env = env;
        if (moved.length && now.turnUser) { // written during a turn: the lost-update guard looks at it when the turn ends
          fields.turnSynced = unique([...list(now.turnSynced), ...moved]).slice(-MAX_STORED_PATHS);
        }
        if (notes.length) fields.syncNotes = addNotes(now.syncNotes, notes);
        return fields;
      });
      return 'ok';
    } catch (error) {
      if (!(error instanceof GitError)) throw error;
      log.warning('Live sync into %s failed: %s', folder, errorText(error));
      return 'blocked';
    } finally {
      lock.release();
    }
  }

  /**
   * A .env* file (ignored by git, never merged): copied into the chat only when the chat has not changed it. `env` maps a path to the
   * sha1 of the project's content when it was last seen here ('-' when it was gone). Returns 'synced', 'seen', 'kept' or 'kept_new'.
   */
  async syncEnv(project: string, folder: string, path: string, env: Map<string, unknown>): Promise<string> {
    const src = join(project, path), dst = join(folder, path);
    const there = isfile(src) && !islink(src) ? await sha(src) : null;
    const mine = isfile(dst) ? await sha(dst) : null;
    const knownRaw = env.get(path);
    const known = knownRaw === undefined || knownRaw === null || knownRaw === '-' ? null : knownRaw;
    const untouched = env.has(path) ? mine === known : mine === null || mine === there;
    if (!untouched) {
      if (env.has(path) && env.get(path) !== (there || '-') && mine !== there) { // the user changed it since the chat last saw it
        env.set(path, there || '-');
        return 'kept_new';
      }
      return 'kept';
    }
    if (mine === there) {
      env.set(path, there || '-');
      return 'seen';
    }
    if (there === null) removeFile(folder, dst);
    else await copyAtomic(src, dst);
    env.set(path, there || '-');
    return 'synced';
  }

  // -- catching up
  /**
   * Paths whose content in the project's working tree differs from the chat's user base U. If the project HEAD is not the one U was
   * made against, only files that are dirty now (the user's own edits, not what a checkout or merge brought).
   */
  async diffAgainstUser(record: WorktreeRecord): Promise<[Items, string[]]> {
    const project = str(record.project);
    const user = str(record.user) || str(record.snapshot);
    const head = pyStrip((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], project, { check: false })).stdout);
    const scratch = Deno.makeTempDirSync({ prefix: '.studio-catch-', dir: await wt.gitDirOf(project) });
    let tree: string;
    try {
      const env = { GIT_INDEX_FILE: join(scratch, 'index') };
      await wt.git(['read-tree', 'HEAD'], project, { env });
      await wt.git(['add', '-A'], project, { env });
      tree = pyStrip((await wt.git(['write-tree'], project, { env })).stdout);
    } finally {
      try {
        Deno.removeSync(scratch, { recursive: true });
      } catch { /* ignore_errors */ }
    }
    let names = (await wt.git(['diff-tree', '-r', '--no-renames', '--name-only', '-z', user + '^{tree}', tree], project)).stdout
      .split('\0').filter((n) => n);
    const statuses = await statusPaths(project);
    if (head !== record.userHead) names = names.filter((n) => statuses.has(n));
    const items: Items = new Map();
    for (const name of names) {
      const sig = sigOf(project, name);
      if (judge(project, name, sig, UNMERGED.has(statuses.get(name) ?? '')) === 'ok') items.set(name, null);
    }
    return [items, envFiles(project)];
  }

  /** The one restart function (chat opened, host start, turn start, Resume): sync what differs between the project folder and U. */
  async catchUp(key: string, stop: Flag | null = null, held: Mutex | null = null): Promise<Outcome> {
    if (!this.enabled()) return 'paused';
    const found = this.registry.get(key);
    if (!found || found.status !== 'ready') return 'gone';
    const project = str(found.project);
    if ((await wt.syncPaused(this.stateDir, project)) || pauseInfo(this.stateDir, project)) return 'paused';
    if (await folderOffBranch(found)) { // the folder is on another branch: retried each scan, caught up once it is back
      this.stale.add(key);
      return 'blocked';
    }
    return await this.underProjectLock(project, async () => {
      try {
        const [items, envs] = await this.diffAgainstUser({ ...found, key });
        return await this.syncChat(key, items, envs, stop);
      } catch (error) {
        if (!(error instanceof GitError) && !isOSError(error)) throw error;
        log.warning('Live sync catch-up of %s failed: %s', found.path, errorText(error));
        return 'blocked';
      }
    }, held);
  }
}
