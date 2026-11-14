/**
 * Worktree per chat (worktrees.py): a new chat in a git project may run in its own git worktree, made under the Studio state folder
 * (never inside the repo):
 *
 *     <state dir>/worktrees/<repo-hash>/<chat-slug>        branch studio/<chat-slug>, started from a snapshot commit S
 *
 * The chat starts from the project's main branch (main, else master, else the branch the folder has checked out; mainBranch), whatever
 * branch the project folder is on. When the folder is on that branch, S is its HEAD plus the user's uncommitted work (tracked edits and
 * untracked, non-ignored files), built with a temporary index so the user's own index and files are never touched. When the folder is
 * on another branch, S is main's tip: the folder's uncommitted edits belong to that other branch and are not copied (Plan.note says
 * so in the chat), and live sync only copies the user's edits into the chat while the folder has the chat's base checked out
 * (record.editsFrom). `.env*` files (usually ignored) are copied over afterwards. A project
 * that cannot safely get a worktree is used in place, and the reason is logged. Every worktree Studio makes is recorded in
 * <state dir>/studio-worktrees.json (chat key -> path, branch, base branch, snapshot commit) and only those are ever cleaned up.
 *
 * Python and Deno share the registry during the transition: it is re-read from disk on every access (as Python does), written whole
 * with writeJsonAtomic in Python's exact layout (json.dump ensure_ascii=False, compact separators, the '.studio-worktrees-' temp
 * prefix), and every read-modify-write holds the in-process queue plus the cross-process lock '<file>.lock' (server/platform/lock.ts;
 * the Python Registry only has a thread lock, so this guards Deno against Deno). git runs as a subprocess with Python's arguments and
 * environment: GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_COMMON_DIR removed, GIT_OPTIONAL_LOCKS=0, GIT_TERMINAL_PROMPT=0,
 * `-c core.longpaths=true`, and Studio's identity only where Python passes it. Text output gets Python's universal-newline
 * translation. (CREATE_NO_WINDOW cannot be passed by Deno.Command; server/platform/console.ts gives the process a hidden console.)
 */
import { FileLock, LOCK_TIMEOUT_MS, LockTimeout } from '../platform/lock.ts';
import { basename, dirname, isabs, isdir, isfile, islink, join, normcase, normpath, SEP, splitdrive, WIN } from '../platform/ospath.ts';
import { pathStr, which } from '../platform/pypath.ts';
import { pathOf, realpath } from '../state/paths.ts';
import { entriesOf, put, readJsonFile, saveJson } from '../state/json.ts';
import { clip, isDict, pyStrip, ValueError } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { pidAlive } from '../host/host_client.ts';
import { localOnlyOf } from './local_only.ts';
import { moveStrays } from './local_strays.ts';

const log = getLogger('worktrees');

/** Mutable so tests can lower them (Python's tests patch the module constants). */
export const limits = {
  MAX_SNAPSHOT_BYTES: 200 * 1024 * 1024, // what the snapshot would add beyond HEAD; more and the chat works in place
  MAX_UNTRACKED_FILES: 5000,
  MAX_REMOVED_NOTES: 500,
};
export const PENDING = 'removal-pending'; // registry status of a worktree whose removal started (or failed); retried at startup
export const GONE_MESSAGE = "This chat's workspace was removed; it can be read but not continued";
export const SKIP_DIRS = new Set(['node_modules', '.git']);
export const LFS_MAGIC = new TextEncoder().encode(
  'version https://git-lfs.github.com/spec',
);
export const SNAPSHOT_IDENTITY = ['-c', 'user.name=AIB', '-c', 'user.email=studio@localhost', '-c', 'commit.gpgsign=false'];

const ACTIVE = new Set<string>(); // keys being created by this process right now (startup cleanup must not touch them)

/** This chat works in place; message says why. */
export class Fallback extends Error {
  override name = 'Fallback';
}

/** The chat's worktree folder and branch are both gone: it can be read but not continued. */
export class WorktreeGone extends ValueError {
  override name = 'WorktreeGone';
}

export class GitError extends Error {
  override name = 'GitError';
}

export function say(text: string): void {
  log.info(text);
  console.error(text);
}

// ---- git ---------------------------------------------------------------------------------------------------------
export interface GitResult {
  returncode: number;
  /** Decoded output (UTF-8, errors replaced; universal newlines unless binary). */
  stdout: string;
  stderr: string;
  /** The raw stdout bytes (Python's binary=True stdout). */
  out: Uint8Array;
}

export interface GitOptions {
  env?: Record<string, string>;
  check?: boolean;
  /** Seconds (Python's timeout=600). */
  timeout?: number;
  identity?: boolean;
  /** Bytes in, bytes out: no newline translation either way. */
  binary?: boolean;
  input?: string | Uint8Array;
}

export type GitFn = (args: string[], cwd: string, options?: GitOptions) => Promise<GitResult>;

/** Test seams (Python's tests patch worktrees.git and worktrees._rmtree). */
export const testing: { git: GitFn | null; rmtree: ((path: string) => void) | null } = { git: null, rmtree: null };

const DECODER = new TextDecoder('utf-8');

function universal(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** The environment git runs with (worktrees.git): the inherited one minus the repository overrides, plus `env`. */
export function gitEnv(env: Record<string, string> = {}): Record<string, string> {
  const drop = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(Deno.env.toObject())) {
    if (!drop.has(WIN ? k.toUpperCase() : k)) out[k] = v;
  }
  out.GIT_OPTIONAL_LOCKS = '0'; // read-only commands must not refresh the user's index
  out.GIT_TERMINAL_PROMPT = '0';
  return Object.assign(out, env);
}

function encodeInput(input: string | Uint8Array | undefined, binary: boolean): Uint8Array | null {
  if (input === undefined) return null;
  if (input instanceof Uint8Array) return input;
  return new TextEncoder().encode(!binary && WIN ? input.replaceAll('\n', '\r\n') : input);
}

/** Run a process to the end, feeding `input`; {code, out, err} or throws (spawn failure, timeout). */
async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string> | null,
  input: Uint8Array | null,
  timeoutMs: number | null,
): Promise<{ code: number; out: Uint8Array; err: Uint8Array }> {
  const child = new Deno.Command(command, {
    args,
    cwd,
    ...(env ? { env, clearEnv: true } : {}),
    stdin: input ? 'piped' : 'null',
    stdout: 'piped',
    stderr: 'piped',
    ...(timeoutMs !== null ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  }).spawn();
  if (input) {
    const writer = child.stdin.getWriter();
    writer.write(input).catch(() => {}).finally(() => writer.close().catch(() => {}));
  }
  const done = await child.output();
  if (done.signal !== null && timeoutMs !== null && done.code !== 0) {
    throw new Error(`Command '${[command, ...args].join(' ')}' timed out after ${timeoutMs / 1000} seconds`);
  }
  return { code: done.code, out: done.stdout, err: done.stderr };
}

/** worktrees.git without the test seam. */
export async function realGit(args: string[], cwd: string, options: GitOptions = {}): Promise<GitResult> {
  const {
    env,
    check = true,
    timeout = 600,
    identity = false,
    binary = false,
    input,
  } = options;
  const command = ['-c', 'core.longpaths=true', ...(identity ? SNAPSHOT_IDENTITY : []), ...args];
  let done: { code: number; out: Uint8Array; err: Uint8Array };
  try {
    done = await runProcess('git', command, String(cwd), gitEnv(env), encodeInput(input, binary), timeout * 1000);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (check) throw new GitError(`git ${args[0]} failed: ${text}`);
    return { returncode: 1, stdout: '', stderr: text, out: new Uint8Array() };
  }
  const decode = (bytes: Uint8Array) => (binary ? DECODER.decode(bytes) : universal(DECODER.decode(bytes)));
  const result = { returncode: done.code, stdout: decode(done.out), stderr: decode(done.err), out: done.out };
  if (check && result.returncode !== 0) {
    const detail = result.stderr || result.stdout;
    throw new GitError(`git ${args.slice(0, 2).join(' ')} failed: ${clip(pyStrip(detail), 400)}`);
  }
  return result;
}

export function git(args: string[], cwd: string, options: GitOptions = {}): Promise<GitResult> {
  return (testing.git ?? realGit)(args, cwd, options);
}

/** A plain `git` subprocess with the inherited environment and no -c options (Python's direct subprocess.run calls). */
export async function rawGit(args: string[], cwd: string, env: Record<string, string> = {}, input?: Uint8Array): Promise<GitResult> {
  const merged = Object.keys(env).length ? Object.assign(Deno.env.toObject(), env) : null;
  const done = await runProcess('git', args, cwd, merged, input ?? null, null);
  return { returncode: done.code, stdout: universal(DECODER.decode(done.out)), stderr: universal(DECODER.decode(done.err)), out: done.out };
}

// ---- paths -------------------------------------------------------------------------------------------------------
/** os.path.normcase(os.path.realpath(path)), or the normcased path when it cannot be resolved. */
export function norm(path: string): string {
  try {
    return normcase(realpath(String(path)));
  } catch {
    return normcase(String(path));
  }
}

export function same(a: string, b: string): boolean {
  try {
    return normcase(realpath(String(a))) === normcase(realpath(String(b)));
  } catch {
    return false;
  }
}

/** Python's _fs: Deno (Rust std) already opens paths beyond 260 characters on Windows, so the path is used as it is. */
export function fsPath(path: string): string {
  return String(path);
}

export function lexists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

/** os.path.relpath (ntpath / posixpath). Throws ValueError for paths on different drives. */
export function relpath(path: string, start: string): string {
  const abs = (p: string) => normpath(isabs(p) ? p : join(Deno.cwd(), p));
  const [startDrive, startRest] = splitdrive(abs(start));
  const [pathDrive, pathRest] = splitdrive(abs(path));
  if (normcase(startDrive) !== normcase(pathDrive)) {
    throw new ValueError(`path is on mount '${pathDrive}', start on mount '${startDrive}'`);
  }
  const startList = startRest.split(SEP).filter(Boolean);
  const pathList = pathRest.split(SEP).filter(Boolean);
  let i = 0;
  while (i < Math.min(startList.length, pathList.length) && normcase(startList[i]) === normcase(pathList[i])) i++;
  const rel = [...Array(startList.length - i).fill('..'), ...pathList.slice(i)];
  return rel.length ? join(rel[0], ...rel.slice(1)) : '.';
}

/** shutil.rmtree with an onerror that makes the item writable, tries again and otherwise moves on. */
export function rmtree(path: string): void {
  if (testing.rmtree) return testing.rmtree(path);
  const remove = (target: string, recursive: boolean) => {
    try {
      Deno.removeSync(target, { recursive });
    } catch {
      try {
        if (!WIN) Deno.chmodSync(target, 0o700);
        Deno.removeSync(target, { recursive });
      } catch { /* moves on, as Python's onerror */ }
    }
  };
  let info: Deno.FileInfo;
  try {
    info = Deno.lstatSync(path);
  } catch {
    return;
  }
  if (info.isDirectory && !info.isSymlink) {
    try {
      for (const entry of Deno.readDirSync(path)) {
        const child = join(path, entry.name);
        if (entry.isDirectory && !entry.isSymlink) rmtree(child);
        else remove(child, false);
      }
    } catch { /* unreadable folder: try removing it whole below */ }
    remove(path, true);
  } else remove(path, false);
}

function removeQuietly(path: string): void {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch { /* shutil.rmtree(ignore_errors=True) */ }
}

function nowSeconds(): number {
  return Date.now() / 1000;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export type WorktreeRecord = Record<string, unknown>;

// ---- the record --------------------------------------------------------------------------------------------------
/** <state dir>/studio-worktrees.json: {"version":1,"worktrees":{chatKey: {...}}}. Small, rewritten whole and atomically. */
export class Registry {
  static readonly FILE = 'studio-worktrees.json';
  readonly stateDir: string;
  readonly path: string;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.stateDir = pathStr(String(stateDir));
    this.path = pathOf(this.stateDir, Registry.FILE);
  }

  get root(): string {
    return pathOf(this.stateDir, 'worktrees');
  }

  /** (items, removed) as Maps in file order; anything malformed reads as empty. */
  read(): [Map<string, WorktreeRecord>, Map<string, WorktreeRecord>] {
    const [status, raw] = readJsonFile(this.path);
    const doc = status === 'ok' && isDict(raw) ? raw : {};
    const pick = (value: unknown) => {
      const out = new Map<string, WorktreeRecord>();
      if (isDict(value)) {
        for (const [k, v] of entriesOf(value)) if (isDict(v)) out.set(k, v);
      }
      return out;
    };
    return [pick(doc.worktrees), pick(doc.removed)];
  }

  #save(items: Map<string, WorktreeRecord>, removed?: Map<string, WorktreeRecord>): void {
    removed ??= this.read()[1];
    const payload = new Map<string, unknown>([['version', 1], ['worktrees', items]]);
    if (removed.size) payload.set('removed', removed);
    saveJson(this.path, payload, '.studio-worktrees-');
  }

  /** Run `work` (synchronous) holding the in-process queue and the cross-process '<file>.lock'. */
  locked<T>(work: () => T): Promise<T> {
    const run = this.#queue.then(async () => {
      const lock = new FileLock(this.path + '.lock', LOCK_TIMEOUT_MS);
      await lock.acquire();
      try {
        return work();
      } finally {
        lock.release();
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Read, change and save under the lock (Python: `with registry.lock:` around get + update). `work` returns false to skip saving. */
  mutate(work: (items: Map<string, WorktreeRecord>) => boolean): Promise<boolean> {
    return this.locked(() => {
      const items = this.read()[0];
      const changed = work(items);
      if (changed) this.#save(items);
      return changed;
    });
  }

  /**
   * Worktrees Studio removed on purpose: {normalised path: {project, branch, base}}. Only so the chat can say "workspace removed" and
   * stay under its project; nothing here points at a folder.
   */
  removed(): Record<string, WorktreeRecord> {
    return toObject(this.read()[1]);
  }

  /** The worktree and branch are gone: drop the record and leave a small note of where it was. */
  finishRemoval(key: string): Promise<void> {
    return this.locked(() => {
      const [items, removed] = this.read();
      const record = items.get(key);
      items.delete(key);
      if (record && record.path) {
        const at = norm(str(record.path));
        removed.set(at, { // Map.set, like a dict assignment, keeps an existing key's place
          project: record.project ?? '',
          branch: record.branch ?? '',
          base: record.base ?? '',
          session: record.session ?? '',
          time: nowSeconds(),
        });
        const order = [...removed.keys()].sort((a, b) => noteTime(removed.get(a)) - noteTime(removed.get(b)));
        for (const old of order.slice(0, Math.max(0, order.length - limits.MAX_REMOVED_NOTES))) removed.delete(old);
      }
      this.#save(items, removed);
    });
  }

  all(): Record<string, WorktreeRecord> {
    return toObject(this.read()[0]);
  }

  get(key: string): WorktreeRecord | undefined {
    return this.read()[0].get(key);
  }

  put(key: string, record: WorktreeRecord): Promise<void> {
    return this.mutate((items) => {
      items.set(key, record);
      return true;
    }).then(() => {});
  }

  update(key: string, fields: WorktreeRecord): Promise<void> {
    return this.locked(() => {
      const items = this.read()[0];
      const current = items.get(key);
      if (current) {
        const merged: WorktreeRecord = {};
        for (const [k, v] of entriesOf(current)) put(merged, k, v);
        for (const [k, v] of Object.entries(fields)) put(merged, k, v);
        items.set(key, merged);
        this.#save(items);
      }
    });
  }

  remove(key: string): Promise<void> {
    return this.locked(() => {
      const items = this.read()[0];
      if (items.delete(key)) this.#save(items);
    });
  }

  /** The record for a worktree path, else the only record of a saved session ('provider:sessionId'). Only finished ones. */
  find(path?: string | null, session?: string | null): (WorktreeRecord & { key: string }) | null {
    const items = [...this.read()[0]].filter(([, v]) => v.status === 'ready');
    if (path !== undefined && path !== null) {
      for (const [key, record] of items) {
        if (same(str(record.path), path)) return { ...record, key };
      }
    }
    if (session) {
      const hits = items.filter(([, v]) => v.session === session);
      if (hits.length === 1) return { ...hits[0][1], key: hits[0][0] };
    }
    return null;
  }
}

function noteTime(note: WorktreeRecord | undefined): number {
  return typeof note?.time === 'number' ? note.time : 0;
}

function toObject(map: Map<string, WorktreeRecord>): Record<string, WorktreeRecord> {
  const out: Record<string, WorktreeRecord> = {};
  for (const [k, v] of map) put(out, k, v);
  return out;
}

/**
 * The commit a worktree chat's "branch" view compares against: the user base U (S at the start, then the project's saved edits copied
 * in by live sync). The registry field diffBase always equals U; the snapshot S is the fallback for old records.
 */
export function diffBase(record: unknown): string {
  if (!isDict(record)) return '';
  return str(record.diffBase) || str(record.user) || str(record.snapshot) || '';
}

/** refs/studio/<slug>/user: pins the user base U so `git gc` never prunes it ('' for a record without a studio/ branch). */
export function userRef(record: unknown): string {
  const branch = isDict(record) ? str(record.branch) : '';
  return branch.startsWith('studio/') && branch.length > 'studio/'.length ? `refs/studio/${branch.slice('studio/'.length)}/user` : '';
}

export async function pinUserBase(project: string, record: unknown, commit: string): Promise<void> {
  const ref = userRef(record);
  if (ref && commit) await git(['update-ref', ref, commit], project);
}

export async function unpinUserBase(project: string, record: unknown): Promise<void> {
  const ref = userRef(record);
  if (ref && project) {
    await git(['update-ref', '-d', ref], project, { check: false });
  }
}

/** The finished registry record of the Studio worktree at `path` (with its key), or null. Read only. */
export function recordForPath(stateDir: string | null | undefined, path: unknown): (WorktreeRecord & { key: string }) | null {
  if (!stateDir || !path || typeof path !== 'string') return null;
  return new Registry(stateDir).find(path);
}

/** The first `limit` bytes of a file as text, stripped; '' when it cannot be read. */
export const readers = {
  read(path: string, limit = 4096): string {
    try {
      const file = Deno.openSync(path, { read: true });
      try {
        const buffer = new Uint8Array(limit);
        let got = 0;
        while (got < limit) {
          const n = file.readSync(buffer.subarray(got));
          if (n === null || n === 0) break;
          got += n;
        }
        return pyStrip(DECODER.decode(buffer.subarray(0, got)));
      } finally {
        file.close();
      }
    } catch {
      return '';
    }
  },
};

/** For a linked worktree folder: [main checkout folder, branch] read from its .git file, gitdir and commondir; null otherwise. */
export function mainCheckoutOf(path: string): [string, string] | null {
  const marker = join(String(path), '.git');
  if (!isfile(marker)) return null;
  const text = readers.read(marker);
  if (!text.startsWith('gitdir:')) return null;
  let gitdir = pyStrip(text.slice('gitdir:'.length));
  if (!isabs(gitdir)) gitdir = join(String(path), gitdir);
  gitdir = normpath(gitdir);
  if (!isdir(gitdir) || basename(dirname(gitdir)) !== 'worktrees') return null; // missing, or not <repo>/.git/worktrees/<name>
  let common = readers.read(join(gitdir, 'commondir'));
  if (common) {
    common = normpath(isabs(common) ? common : join(gitdir, common));
  } else {
    const parent = dirname(gitdir);
    if (basename(parent) !== 'worktrees') return null;
    common = dirname(parent);
  }
  if (basename(common) !== '.git' || !isdir(common) || !same(dirname(dirname(gitdir)), common)) return null;
  const head = readers.read(join(gitdir, 'HEAD'));
  const branch = head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : head.slice(0, 7);
  return [dirname(common), branch];
}

const PATTERN = /^(.+?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?:[\\/][\s\S]*)?$/i;
/** cwd -> [project, branch, relative location inside the worktree] or null. */
export const WT_CACHE = new Map<string, [string, string, string] | null>();
/** A callable returning the folders Studio knows as projects; set by the server at startup (Python: KNOWN_PROJECTS). */
export const known: { projects: (() => string[]) | null } = { projects: null };

/** pathlib's Path(cwd) and its first 12 parents. */
function selfAndParents(cwd: string): string[] {
  const out = [pathStr(cwd)];
  for (let i = 0; i < 12; i++) {
    const current = out[out.length - 1];
    const parent = pathStr(dirname(current));
    if (parent === current) break;
    out.push(parent);
  }
  return out;
}

/** [worktree top folder, main checkout, branch] for a cwd inside a linked git worktree; null. Reads files only. */
function worktreeRoot(cwd: string): [string, string, string] | null {
  for (const candidate of selfAndParents(cwd)) {
    const marker = join(candidate, '.git');
    if (isdir(marker)) return null; // an ordinary checkout
    if (isfile(marker)) {
      const found = mainCheckoutOf(candidate);
      return found ? [candidate, found[0], found[1]] : null;
    }
  }
  return null;
}

function cachedLookup(cwd: string): [string, string, string] | null {
  if (WT_CACHE.has(cwd)) return WT_CACHE.get(cwd)!;
  let result: [string, string, string] | null = null;
  let present = false;
  try {
    present = exists(cwd);
    if (present) {
      const found = worktreeRoot(cwd);
      if (found) {
        const [top, main, branch] = found;
        const rel = relpath(normpath(cwd), top);
        result = [normpath(main), branch, rel === '.' ? '' : rel];
      }
    } else {
      const match = PATTERN.exec(cwd);
      if (match) result = [match[1], '', ''];
    }
  } catch {
    result = null;
  }
  if (result === null && !present) return null; // not cached: a worktree folder Studio is about to create must be found once it exists
  if (WT_CACHE.size > 5000) WT_CACHE.clear();
  WT_CACHE.set(cwd, result);
  return result;
}

export interface ProjectInfo {
  project: string;
  branch: string;
  base: string;
}

/**
 * {project, branch, base} when cwd lies in a git worktree made by any app (the main checkout is the project; a known Studio project
 * folder inside the repo that holds the worktree's relative location wins); null for anything else. Cached per cwd.
 */
export function projectOfWorktree(cwd: unknown): ProjectInfo | null {
  if (!cwd || typeof cwd !== 'string') return null;
  const found = cachedLookup(cwd);
  if (!found) return null;
  let [project] = found;
  const [, branch, rel] = found;
  if (rel) {
    try {
      const relative = normcase(rel).replaceAll('\\', '/');
      let best = '';
      let chosen: string | null = null;
      for (const folder of known.projects ? known.projects() : []) {
        const inner = normcase(relpath(folder, project)).replaceAll('\\', '/');
        if (
          inner !== '.' && inner !== '' && !inner.startsWith('..') &&
          !isabs(inner) &&
          (relative === inner || relative.startsWith(inner + '/')) &&
          inner.length > best.length
        ) {
          best = inner;
          chosen = folder;
        }
      }
      if (chosen) project = normpath(chosen);
    } catch {
      /* ValueError (another drive) or a bad entry: keep the main checkout */
    }
  }
  return { project, branch, base: '' };
}

/**
 * cwd -> {project, branch, base} when `cwd` is a worktree Studio made (registry entry, else a removed one, else any app's worktree),
 * else null. Used for saved chats, which only know their cwd.
 */
export class ProjectResolver {
  readonly registry: Registry;
  #sig: string | null | undefined = undefined;
  #records: WorktreeRecord[] = [];

  constructor(readonly stateDir: string) {
    this.registry = new Registry(stateDir);
  }

  #all(): WorktreeRecord[] {
    let sig: string | null;
    try {
      const info = Deno.statSync(this.registry.path);
      sig = `${info.mtime?.getTime() ?? 0}:${info.size}`;
    } catch {
      sig = null;
    }
    if (sig !== this.#sig) {
      this.#records = Object.values(this.registry.all());
      this.#sig = sig;
    }
    return this.#records;
  }

  resolve(cwd: unknown): ProjectInfo | null {
    if (!cwd || typeof cwd !== 'string') return null;
    for (const record of this.#all()) {
      if (record.path && record.project && same(str(record.path), cwd)) {
        return { project: str(record.project), branch: str(record.branch), base: str(record.base) };
      }
    }
    const here = normcase(realpath(cwd));
    const removed = this.registry.removed();
    const gone = Object.hasOwn(removed, here) ? removed[here] : undefined; // a worktree Studio removed: the chat stays under its project
    if (gone && gone.project) {
      return { project: str(gone.project), branch: str(gone.branch), base: str(gone.base) };
    }
    return projectOfWorktree(cwd);
  }
}

// ---- deciding ----------------------------------------------------------------------------------------------------
export class Plan {
  readonly project: string;
  readonly path: string;
  /** The branch the project folder has checked out (the chat starts from `base`, the project's main branch). */
  declare readonly folderBranch: string;
  /** The line for the chat's start note ('' when there is nothing to say); create() may set it. */
  declare note: string;
  constructor(
    project: string,
    readonly base: string,
    readonly key: string,
    readonly slug: string,
    readonly branch: string,
    path: string,
    folderBranch = '',
    note = '',
  ) {
    this.project = String(project);
    this.path = String(path);
    // Not enumerable: a Plan spreads to the six fields Python's Plan has (the parity tests compare them).
    Object.defineProperty(this, 'folderBranch', { value: folderBranch || base, enumerable: false });
    Object.defineProperty(this, 'note', { value: note, enumerable: false, writable: true });
  }
}

/** The project's main branch: main, else master, else `fallback`. A new chat starts from it and Merge lands on it (merge.ts). */
export async function mainBranch(project: string, fallback: string): Promise<string> {
  for (const name of ['main', 'master']) {
    if (!project) break;
    const done = await git(['rev-parse', '--verify', '-q', `refs/heads/${name}^{commit}`], project, { check: false });
    if (done.returncode === 0) return name;
  }
  return fallback;
}

/** The start note of a chat that works in place because of `reason` ('' when that is not worth a note in the chat). */
export function inPlaceNote(reason: string): string {
  return reason === 'the repository has no commits yet'
    ? 'This chat works in the project folder itself, not in its own copy: the repository has no commits yet, so there is no main branch to start from.'
    : '';
}

/** hashlib.sha1(normcase(realpath(project))).hexdigest()[:10] */
export function repoHash(project: string): string {
  return sha1Hex(new TextEncoder().encode(normcase(realpath(String(project)))))
    .slice(0, 10);
}

/** '' when the project can get a worktree, else the reason it is used in place. Cheap: a few read-only git calls. */
export async function whyInPlace(projectIn: string): Promise<string> {
  const project = pathStr(String(projectIn));
  if (which('git') === null) return 'git is not installed';
  const bare = await git(['rev-parse', '--is-bare-repository'], project, { check: false });
  if (bare.returncode !== 0) return 'not a git repository';
  if (pyStrip(bare.stdout) === 'true') return 'bare repository';
  const top = await git(['rev-parse', '--show-toplevel'], project, { check: false });
  if (top.returncode !== 0 || !same(pyStrip(top.stdout), project)) {
    return 'the folder is not the root of its git repository';
  }
  const gitdir = pathStr(pyStrip((await git(['rev-parse', '--absolute-git-dir'], project)).stdout));
  for (const [name, label] of GIT_STATES) {
    if (exists(join(gitdir, name))) return `${label} is in progress`;
  }
  if ((await git(['symbolic-ref', '-q', 'HEAD'], project, { check: false })).returncode !== 0) return 'detached HEAD';
  if ((await git(['rev-parse', '--verify', '-q', 'HEAD'], project, { check: false })).returncode !== 0) {
    return 'the repository has no commits yet';
  }
  if (exists(join(project, '.gitmodules'))) {
    return 'the repository has submodules';
  }
  return '';
}

export const GIT_STATES: [string, string][] = [
  ['MERGE_HEAD', 'a merge'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
];

function nulList(text: string): string[] {
  return text.split('\0').filter((n) => n);
}

/** [untracked file count, bytes the snapshot adds beyond HEAD: untracked files and tracked files that differ from HEAD]. */
export async function snapshotSize(project: string): Promise<[number, number]> {
  const untracked = nulList((await git(['ls-files', '-o', '--exclude-standard', '-z'], project)).stdout);
  const changed = nulList((await git(['diff', '--name-only', '-z', 'HEAD'], project)).stdout);
  let total = 0;
  for (const name of [...untracked, ...changed]) {
    try {
      total += Deno.lstatSync(pathOf(project, name)).size;
    } catch { /* gone */ }
  }
  return [untracked.length, total];
}

// ---- making one --------------------------------------------------------------------------------------------------
/** True when the folder has uncommitted work: tracked edits (staged or not) or untracked, non-ignored files. */
export async function hasUncommitted(project: string): Promise<boolean> {
  return !!pyStrip((await git(['status', '--porcelain', '-uall'], project)).stdout);
}

/** The commit S: HEAD plus the working tree, built in a temporary index. The project's own index and files are not touched. */
export async function snapshotCommit(project: string, scratch: string): Promise<string> {
  const env = { GIT_INDEX_FILE: pathOf(scratch, 'snapshot-index') };
  await git(['read-tree', 'HEAD'], project, { env });
  await git(['add', '-A'], project, { env });
  const tree = pyStrip((await git(['write-tree'], project, { env })).stdout);
  return pyStrip((await git(['commit-tree', tree, '-p', 'HEAD', '-m', 'AIB snapshot'], project, { env, identity: true })).stdout);
}

// ---- the user base U ---------------------------------------------------------------------------------------------
export async function gitDirOf(cwd: string): Promise<string> {
  return pathStr(pyStrip((await git(['rev-parse', '--absolute-git-dir'], cwd)).stdout));
}

/** The forward-slash relative form of a project path, or '' when it is not a plain path inside the project. */
export function safeRelative(path: unknown): string {
  const text = String(path || '').replaceAll('\\', '/');
  const parts = text.split('/');
  if (!text || text.startsWith('/') || parts[0].includes(':') || parts.some((p) => p === '' || p === '.' || p === '..')) return '';
  if (parts[0].toLowerCase() === '.git') return '';
  return text;
}

/**
 * A new user base U from the previous U plus the current content of `paths` (relative names) in the project folder: files that exist
 * are added or replaced, files that are gone are removed. Built in a temporary index. U is pinned by refs/studio/<slug>/user and
 * recorded (user, diffBase, userHead) when `registry` and record.key are given. Returns the new U (the previous one when nothing differs).
 */
export async function advanceUserBase(record: WorktreeRecord, paths: unknown[] | null, registry: Registry | null = null): Promise<string> {
  const project = str(record.project);
  const previous = str(record.user) || str(record.snapshot);
  if (!previous) {
    throw new GitError('This worktree has no user base to advance');
  }
  const names: string[] = [];
  for (const path of paths ?? []) {
    const name = safeRelative(path);
    if (name && !names.includes(name)) names.push(name);
  }
  const scratch = Deno.makeTempDirSync({ prefix: '.studio-user-', dir: await gitDirOf(project) });
  let tree: string;
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    await git(['read-tree', previous], project, { env });
    const modes = new Map<string, string>();
    if (names.length) {
      for (const line of (await git(['ls-files', '-s', '-z', '--', ...names], project, { env })).stdout.split('\0')) {
        const tab = line.indexOf('\t');
        const name = tab >= 0 ? line.slice(tab + 1) : '';
        if (name) modes.set(name, line.slice(0, tab).split(' ')[0]);
      }
    }
    const lines: string[] = [];
    for (const name of names) {
      const full = pathOf(project, name);
      if (islink(full)) {
        const target = new TextEncoder().encode(Deno.readLinkSync(full));
        const sha = pyStrip(DECODER.decode((await git(['hash-object', '-w', '--stdin'], project, { binary: true, input: target })).out));
        lines.push(`120000 ${sha}\t${name}\n`);
      } else if (isfile(full)) {
        const sha = pyStrip((await git(['hash-object', '-w', `--path=${name}`, '--', full], project)).stdout);
        const mode = modes.get(name) ||
          (!WIN && ((Deno.statSync(full).mode ?? 0) & 0o111) ? '100755' : '100644');
        lines.push(`${mode} ${sha}\t${name}\n`);
      } else if (!isdir(full)) {
        lines.push('0 ' + '0'.repeat(40) + `\t${name}\n`);
      }
    }
    if (lines.length) {
      await git(['update-index', '--index-info'], project, { env, binary: true, input: new TextEncoder().encode(lines.join('')) });
    }
    tree = pyStrip((await git(['write-tree'], project, { env })).stdout);
  } finally {
    removeQuietly(scratch);
  }
  let result = previous;
  if (tree !== pyStrip((await git(['rev-parse', previous + '^{tree}'], project)).stdout)) {
    result = pyStrip((await git(['commit-tree', tree, '-p', previous, '-m', 'AIB: user edits'], project, { identity: true })).stdout);
  }
  await pinUserBase(project, record, result);
  if (registry !== null && record.key) {
    const head = pyStrip((await git(['rev-parse', '--verify', '-q', 'HEAD'], project, { check: false })).stdout);
    await registry.update(str(record.key), { user: result, diffBase: result, userHead: head });
  }
  return result;
}

// ---- locks across processes: the web process, the host and the live sync all use these ------------------------------------
function lockFile(stateDir: string, name: string): string {
  return pathOf(String(stateDir), 'locks', name);
}

function seconds(timeout: number | null | undefined): number {
  return timeout === null || timeout === undefined ? LOCK_TIMEOUT_MS : timeout * 1000;
}

/** The project-level "sync paused" flag. Merge holds it from stash to unstash; live sync must not copy into a worktree meanwhile. */
export function pauseLock(stateDir: string, project: string, timeout: number | null = null): FileLock {
  return new FileLock(lockFile(stateDir, `sync-paused-${repoHash(project)}.lock`), seconds(timeout));
}

/** One lock per worktree: Merge holds it while it commits, lands and resets the worktree; live sync takes it to write into it. */
export function worktreeLock(stateDir: string, record: WorktreeRecord, timeout: number | null = null): FileLock {
  const parts = (str(record.branch) || str(record.path) || 'worktree')
    .replaceAll('\\', '/').replace(/\/+$/, '').split('/');
  const slug = parts[parts.length - 1];
  return new FileLock(lockFile(stateDir, `worktree-${repoHash(str(record.project) || '')}-${slug}.lock`), seconds(timeout));
}

/** True when another holder (any process) has the project's pause flag right now. Takes and drops the lock at once. */
export async function syncPaused(stateDir: string, project: string): Promise<boolean> {
  const lock = pauseLock(stateDir, project, 0);
  try {
    await lock.acquire();
  } catch {
    return true;
  }
  lock.release();
  return false;
}

export { LockTimeout };

// ---- comparing a file with a blob without CRLF noise -------------------------------------------------------------
/**
 * True when the file `path` (relative to `cwd`) is the same as git blob `blob`, as git itself would store it (clean filters via
 * `hash-object --path`, or byte-equal to `cat-file --filters --path`). An empty `blob` means "the file does not exist".
 */
export async function fileMatchesBlob(cwd: string, path: string, blob: string): Promise<boolean> {
  const full = pathOf(String(cwd), path);
  if (!lexists(full)) return !blob;
  if (!blob || islink(full) || !isfile(full)) return false;
  if (pyStrip((await git(['hash-object', `--path=${path}`, '--', full], cwd, { check: false })).stdout) === blob) return true;
  const smudged = await git(['cat-file', '--filters', `--path=${path}`, blob], cwd, { check: false, binary: true });
  if (smudged.returncode !== 0) return false;
  try {
    return sameBytes(Deno.readFileSync(full), smudged.out);
  } catch {
    return false;
  }
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Paths whose working-tree content differs from commit `base` (changed, deleted, or new and not ignored), CRLF-safe. */
export async function touchedPaths(cwd: string, base: string): Promise<string[]> {
  const names = nulList((await git(['diff', '--name-only', '-z', '--no-renames', base, '--'], cwd)).stdout);
  const touched: string[] = [];
  for (const name of names) {
    const blob = pyStrip((await git(['rev-parse', '--verify', '-q', `${base}:${name}`], cwd, { check: false })).stdout);
    if (!(await fileMatchesBlob(cwd, name, blob))) touched.push(name);
  }
  for (const name of nulList((await git(['ls-files', '-o', '--exclude-standard', '-z'], cwd)).stdout)) {
    if (!touched.includes(name)) touched.push(name);
  }
  return touched;
}

/**
 * Copy .env* files at the same relative paths; skip symlinks, node_modules and .git; never overwrite. `localOnly` (project-relative
 * local-only entries) are skipped too: they are read from the main folder in every chat, and a copy would only be a stray.
 */
export function copyEnvFiles(projectIn: string, target: string, localOnly: string[] = []): void {
  const project = pathStr(String(projectIn));
  const fold = (p: string) => (WIN ? p.toLowerCase() : p);
  const skip = localOnly.map(fold);
  const local = (full: string) => {
    if (!skip.length) return false;
    const rel = fold(relpath(full, project).replaceAll('\\', '/'));
    return skip.some((e) => rel === e || rel.startsWith(e + '/'));
  };
  const walk = (folder: string) => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(folder)];
    } catch {
      return;
    }
    const dirs: string[] = [];
    for (const entry of entries) {
      const full = join(folder, entry.name);
      if (entry.isDirectory || (entry.isSymlink && isdir(full))) {
        if (!SKIP_DIRS.has(entry.name) && !islink(full) && !local(full)) dirs.push(full);
        continue;
      }
      if (!entry.name.startsWith('.env')) continue;
      if (islink(full) || !isfile(full) || local(full)) continue;
      const relative = relpath(full, project);
      const destination = join(String(target), relative);
      if (lexists(destination)) continue;
      try {
        Deno.mkdirSync(dirname(destination), { recursive: true });
        Deno.copyFileSync(full, destination);
        const info = Deno.statSync(full);
        if (info.atime && info.mtime) {
          Deno.utimeSync(destination, info.atime, info.mtime); // shutil.copy2 keeps the times
        }
      } catch (error) {
        log.exception(error, 'Could not copy %s into the worktree', relative);
      }
    }
    for (const dir of dirs) walk(dir);
  };
  walk(project);
}

/** True when the worktree holds Git LFS pointer files instead of the real content (git-lfs was not there to fetch it). */
export async function hasLfsPointers(path: string): Promise<boolean> {
  const attributes = await git(['grep', '-l', '-e', 'filter=lfs', '--', '.gitattributes', '*.gitattributes'], path, { check: false });
  if (attributes.returncode !== 0) return false;
  const names = nulList((await git(['ls-files', '-z'], path)).stdout);
  if (!names.length) return false;
  const input = new TextEncoder().encode(names.join('\0') + '\0');
  const process = await rawGit(['check-attr', '-z', 'filter', '--stdin'], String(path), {}, input);
  const parts = process.stdout.split('\0');
  for (let index = 0; index < parts.length - 2; index += 3) {
    if (parts[index + 2] !== 'lfs') continue;
    try {
      const file = Deno.openSync(pathOf(String(path), parts[index]), { read: true });
      try {
        const head = new Uint8Array(LFS_MAGIC.length);
        let got = 0;
        while (got < head.length) {
          const n = file.readSync(head.subarray(got));
          if (!n) break;
          got += n;
        }
        if (got === head.length && sameBytes(head, LFS_MAGIC)) return true;
      } finally {
        file.close();
      }
    } catch {
      continue;
    }
  }
  return false;
}

// ---- local-only folders ------------------------------------------------------------------------------------------
/** The project's local-only entries (project-relative), [] when it has none or they cannot be read. */
async function localEntries(project: string): Promise<string[]> {
  try {
    return (await localOnlyOf(project))?.entries ?? [];
  } catch {
    return [];
  }
}

/**
 * Before a worktree is removed: move the files written into its local-only folders into the main folder (a clash gets
 * "<name> (from chat-…)<ext>"). True when nothing is left to save; false when a file could not be moved (the removal must wait).
 */
export async function rescueStrays(record: WorktreeRecord): Promise<boolean> {
  const path = str(record.path), project = str(record.project);
  let lo;
  try {
    lo = await localOnlyOf(project);
  } catch (error) {
    log.exception(error, 'Reading the local-only folders of %s failed', project);
    return false;
  }
  if (!lo || !lo.entries.length) return true;
  const copy = lo.prefix ? join(path, ...lo.prefix.replace(/\/+$/, '').split('/')) : path;
  const { moved, failed } = await hooks.moveStrays(copy, lo, basename(normpath(path)), str(record.snapshot));
  for (const [from, to] of moved) say(`Worktree: moved ${from} from ${path} into ${project} as ${to} (local only)`);
  if (failed.length) {
    log.warning('Could not move local-only files out of %s: %s', path, failed.slice(0, 20).join(', '));
    return false;
  }
  return true;
}

// ---- the manager -------------------------------------------------------------------------------------------------
export type RemoveOutcome = 'removed' | 'pending' | 'gone';

export class Manager {
  readonly registry: Registry;

  constructor(stateDir: string) {
    this.registry = new Registry(stateDir);
  }

  /** A Plan for a new chat in `project`, or null (the chat works in place; the reason is logged). */
  async plan(projectIn: string, key?: string | null): Promise<Plan | null> {
    return (await this.planWithReason(projectIn, key)).plan;
  }

  /** plan() plus, when the chat works in place, why ('' when it gets a worktree). */
  async planWithReason(projectIn: string, key?: string | null): Promise<{ plan: Plan | null; reason: string }> {
    const project = pathStr(String(projectIn));
    let reason: string;
    try {
      reason = await whyInPlace(project);
    } catch (error) {
      reason = `git could not be read: ${error instanceof Error ? error.message : error}`;
    }
    if (reason) {
      say(`Worktree: ${project} works in place: ${reason}`);
      return { plan: null, reason };
    }
    key = key || crypto.randomUUID().replaceAll('-', '');
    const folderBranch = pyStrip((await git(['symbolic-ref', '--short', 'HEAD'], project)).stdout);
    const base = await mainBranch(project, folderBranch);
    const note = base === folderBranch && !['main', 'master'].includes(base)
      ? `Started from ${base}: this project has no main or master branch.`
      : '';
    const folder = pathOf(this.registry.root, repoHash(project));
    for (let number = 0;; number++) {
      const slug = `chat-${key.slice(0, 8)}` + (number ? `-${number}` : '');
      const branch = `studio/${slug}`;
      const taken = (await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], project, { check: false })).returncode === 0 ||
        lexists(pathOf(folder, slug));
      if (!taken) {
        return { plan: new Plan(project, base, key, slug, branch, pathOf(folder, slug), folderBranch, note), reason: '' };
      }
    }
  }

  /**
   * Make the worktree of `plan`. Throws Fallback(reason) when the chat must work in place; whatever was made is removed first.
   * A crash (the process dying) leaves a 'creating' record that cleanupIncomplete() removes at the next start.
   */
  async create(plan: Plan): Promise<void> {
    const record: WorktreeRecord = {
      path: plan.path,
      project: plan.project,
      branch: plan.branch,
      base: plan.base,
      snapshot: '',
      status: 'creating',
      pid: Deno.pid,
      created: nowSeconds(),
      editsFrom: plan.base, // live sync copies the folder's edits only while the folder has this branch checked out
    };
    ACTIVE.add(plan.key);
    try {
      await this.registry.put(plan.key, record);
      try {
        let snapshot: string;
        if (plan.folderBranch === plan.base) { // the folder is on main: its uncommitted edits come along, in S
          const [untracked, size] = await snapshotSize(plan.project);
          if (untracked > limits.MAX_UNTRACKED_FILES || size > limits.MAX_SNAPSHOT_BYTES) {
            throw new Fallback(`too much uncommitted work to copy (${untracked} untracked files, ${Math.floor(size / (1024 * 1024))} MB)`);
          }
          Deno.mkdirSync(this.registry.root, { recursive: true });
          const scratch = Deno.makeTempDirSync({ prefix: '.snapshot-', dir: this.registry.root });
          try {
            snapshot = await snapshotCommit(plan.project, scratch);
          } finally {
            removeQuietly(scratch);
          }
        } else { // the folder is on another branch: S is main's tip; the folder's edits belong to that branch and stay out
          snapshot = pyStrip((await git(['rev-parse', '--verify', `refs/heads/${plan.base}^{commit}`], plan.project)).stdout);
          if (await hasUncommitted(plan.project)) {
            plan.note = `Started from ${plan.base}. Your uncommitted edits in the project folder are on another branch ` +
              `(${plan.folderBranch}), so they're not in this chat's copy.`;
          }
        }
        record.snapshot = snapshot;
        const head = pyStrip((await git(['rev-parse', 'HEAD'], plan.project)).stdout);
        await pinUserBase(plan.project, { branch: plan.branch }, snapshot); // U = S at the start; the ref keeps it from `git gc`
        await this.registry.update(plan.key, { snapshot, user: snapshot, userHead: head });
        Deno.mkdirSync(dirname(plan.path), { recursive: true });
        await git(['worktree', 'add', '-b', plan.branch, plan.path, snapshot], plan.project);
        hooks.copyEnvFiles(plan.project, plan.path, await localEntries(plan.project));
        if (await hasLfsPointers(plan.path)) {
          throw new Fallback('the worktree would hold Git LFS pointer files');
        }
      } catch (error) {
        if (error instanceof Died) throw error; // tests: the process "dies" here and leaves the 'creating' record
        if (error instanceof Fallback) {
          await this.#discardOrKeep(plan.key, record);
          say(`Worktree: ${plan.project} works in place: ${error.message}`);
          throw error;
        }
        const text = error instanceof Error ? error.message : String(error);
        log.exception(error, 'Making the worktree failed');
        await this.#discardOrKeep(plan.key, record);
        say(`Worktree: ${plan.project} works in place: could not make the worktree (${text})`);
        throw new Fallback(`could not make the worktree: ${text}`);
      }
      await this.registry.update(plan.key, { status: 'ready' });
    } finally {
      ACTIVE.delete(plan.key);
    }
  }

  /**
   * Remove a worktree Studio made, its branch and its git registration. Refuses anything outside Studio's own worktrees folder.
   * Files written into the copy's local-only folders are moved into the main folder first; false when one could not be moved
   * (nothing was removed then).
   */
  async #discard(record: WorktreeRecord): Promise<boolean> {
    const path = str(record.path),
      project = str(record.project),
      branch = str(record.branch);
    const root = norm(this.registry.root);
    const inside = !!path && normcase(realpath(path)).startsWith(root + SEP);
    if (!inside) {
      log.warning("Not removing %s: it is not under AIB's worktrees folder", path);
      return true;
    }
    const projectOk = !!project && isdir(project);
    if (projectOk && lexists(path) && !(await rescueStrays(record))) return false;
    if (projectOk) {
      await git(['worktree', 'remove', '--force', path], project, { check: false });
    }
    if (lexists(path)) rmtree(path);
    if (projectOk) {
      await git(['worktree', 'prune'], project, { check: false });
      if (branch.startsWith('studio/')) {
        await git(['branch', '-D', branch], project, { check: false });
      }
      await unpinUserBase(project, record);
    }
    return true;
  }

  /** #discard, then forget the record; when a stray could not be moved, the record stays as a pending (confirmed) removal instead. */
  async #discardOrKeep(key: string, record: WorktreeRecord): Promise<boolean> {
    if (await this.#discard(record)) {
      await this.registry.remove(key);
      return true;
    }
    await this.registry.update(key, { status: PENDING, confirmed: true });
    say(`Worktree: ${record.path ?? 'None'} holds local-only files that could not be moved; removal is pending and retried at the next start`);
    return false;
  }

  async discard(key: string): Promise<void> {
    const record = this.registry.get(key);
    if (record) await this.#discardOrKeep(key, record);
  }

  async setSession(key: string, provider: string, sessionId: string): Promise<void> {
    if (this.registry.get(key)) {
      await this.registry.update(key, { session: `${provider}:${sessionId}` });
    }
  }

  /** At startup: remove worktrees a previous process died in the middle of making. Returns the keys cleaned. */
  async cleanupIncomplete(): Promise<string[]> {
    const done: string[] = [];
    for (const [key, record] of Object.entries(this.registry.all())) {
      if (record.status !== 'creating') continue;
      if (ACTIVE.has(key)) continue;
      const pid = record.pid;
      if (pid !== Deno.pid && hooks.pidAlive(pid)) continue; // another running Studio is making it
      if (!(await this.#discardOrKeep(key, record))) continue;
      done.push(key);
      say(`Worktree: removed a half-made worktree of an earlier run: ${record.path ?? 'None'}`);
    }
    return done;
  }

  /**
   * True when the worktree differs from its diff base (committed, edited or new files) or that cannot be told: then nothing is removed
   * without the user's say. A missing folder has no changes to lose.
   */
  async hasChanges(record: WorktreeRecord): Promise<boolean> {
    const path = str(record.path), base = diffBase(record);
    if (!isdir(path)) return false;
    if (!base || (await git(['cat-file', '-e', base + '^{commit}'], path, { check: false })).returncode !== 0) return true;
    try {
      return (await touchedPaths(path, base)).length > 0; // against U, ignoring line-ending noise
    } catch (error) {
      if (error instanceof GitError) return true;
      throw error;
    }
  }

  insideRoot(path: string): boolean {
    const root = norm(this.registry.root);
    return !!path && norm(path).startsWith(root + SEP);
  }

  /** One try at removing a worktree (--force only when `force`), then its branch. True when both are gone. */
  async #attemptRemoval(record: WorktreeRecord, force: boolean): Promise<boolean> {
    const path = str(record.path),
      project = str(record.project),
      branch = str(record.branch);
    if (!this.insideRoot(path)) {
      log.warning('Not removing %s: it is not under the AIB worktrees folder', path);
      return true; // nothing of Studio's to remove; do not keep a record forever
    }
    const projectOk = !!project && isdir(project) &&
      (await git(['rev-parse', '--git-dir'], project, { check: false }))
          .returncode === 0;
    if (lexists(path)) {
      // local-only files written into the copy go to the main folder first (a plain remove deletes them, ignored or not)
      if (projectOk && !(await rescueStrays(record))) return false;
      if (projectOk) {
        await git(['worktree', 'remove', ...(force ? ['--force'] : []), path], project, { check: false });
      }
      if (force && lexists(path)) {
        try {
          rmtree(path); // the user confirmed discarding: what git left behind goes too
        } catch { /* in use */ }
      }
      if (lexists(path)) return false; // in use (Windows) or git refused: pending
    }
    if (projectOk) {
      await git(['worktree', 'prune'], project, { check: false });
      if (
        branch.startsWith('studio/') &&
        (await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], project, { check: false })).returncode === 0
      ) {
        if ((await git(['branch', '-D', branch], project, { check: false })).returncode !== 0) return false;
      }
      await unpinUserBase(project, record);
    }
    return true;
  }

  /**
   * Remove a chat's worktree, its branch and its registry entry. `confirmed` is the user's yes to discarding it: only then is --force
   * used. Returns 'removed', 'pending' (retried at the next start) or 'gone' (no such record). The record is marked pending first.
   */
  async remove(key: string, confirmed = false): Promise<RemoveOutcome> {
    const record = this.registry.get(key);
    if (!record) return 'gone';
    await this.registry.update(key, { status: PENDING, confirmed: !!confirmed || !!record.confirmed });
    let done: boolean;
    try {
      done = await this.#attemptRemoval(record, !!confirmed);
    } catch (error) {
      log.exception(error, 'Removing the worktree %s failed', record.path);
      done = false;
    }
    if (done) {
      await this.registry.finishRemoval(key);
      say(`Worktree: removed ${record.path ?? 'None'} and ${record.branch ?? 'None'}`);
      return 'removed';
    }
    say(`Worktree: ${record.path ?? 'None'} is in use; removal is pending and retried at the next start`);
    return 'pending';
  }

  /** At startup: finish pending removals, then `git worktree prune` for every project Studio keeps worktrees of. */
  async retryPending(): Promise<string[]> {
    const done: string[] = [];
    const projects = new Set<string>();
    for (const [key, record] of Object.entries(this.registry.all())) {
      if (record.project) projects.add(str(record.project));
      if (record.status !== PENDING) continue;
      let finished: boolean;
      try {
        finished = await this.#attemptRemoval(record, !!record.confirmed);
      } catch (error) {
        log.exception(error, 'Retrying the removal of %s failed', record.path);
        finished = false;
      }
      if (finished) {
        await this.registry.finishRemoval(key);
        done.push(key);
        say(`Worktree: finished removing ${record.path ?? 'None'}`);
      }
    }
    for (const project of projects) {
      if (isdir(project)) {
        await git(['worktree', 'prune'], project, { check: false });
      }
    }
    return done;
  }

  /** True when `workspace` (or the saved chat `session`) belongs to a Studio worktree that was removed or is being removed. */
  isRemoved(workspace: string, session?: string | null): boolean {
    const here = norm(workspace);
    const removed = this.registry.removed();
    if (session && Object.values(removed).some((r) => r.session === session)) {
      return true;
    }
    const items = Object.values(this.registry.all());
    if (session && items.some((r) => r.session === session && r.status === PENDING)) return true;
    if (!this.insideRoot(workspace)) return false;
    if (Object.hasOwn(removed, here)) return true;
    return items.some((r) => norm(str(r.path)) === here && r.status === PENDING);
  }

  forChat(provider: string, sessionId: string | null, workspace: string): (WorktreeRecord & { key: string }) | null {
    return this.registry.find(workspace, sessionId ? `${provider}:${sessionId}` : null);
  }

  /**
   * The folder of a recorded worktree, made again from its branch when it was deleted outside Studio. Throws WorktreeGone when the
   * branch is gone as well. Never returns another folder.
   */
  async ensure(record: WorktreeRecord): Promise<string> {
    const path = str(record.path),
      project = str(record.project),
      branch = str(record.branch);
    if (isdir(path)) return path;
    if (!(project && isdir(project)) || (await git(['rev-parse', '--git-dir'], project, { check: false })).returncode !== 0) {
      throw new WorktreeGone(GONE_MESSAGE);
    }
    await git(['worktree', 'prune'], project, { check: false }); // forget the registration of the deleted folder
    if ((await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], project, { check: false })).returncode !== 0) {
      throw new WorktreeGone(GONE_MESSAGE);
    }
    Deno.mkdirSync(dirname(path), { recursive: true });
    try {
      await git(['worktree', 'add', path, branch], project);
    } catch (error) {
      if (error instanceof GitError) {
        throw new WorktreeGone(`${GONE_MESSAGE} (${error.message})`);
      }
      throw error;
    }
    hooks.copyEnvFiles(project, path, await localEntries(project));
    say(`Worktree: recreated ${path} from ${branch}`);
    return path;
  }
}

/** Tests only: thrown from a hook, it is not caught by create() (Python: a BaseException, the process dying). */
export class Died extends Error {}

/** Swappable pieces (tests). */
export const hooks = { copyEnvFiles, moveStrays, pidAlive: (pid: unknown) => pidAlive(pid) };

// ---- sha1 (sync: repo hashes are needed in synchronous lock-path code) -------------------------------------------
export function sha1Hex(data: Uint8Array): string {
  const length = data.length;
  const words = new Uint32Array((((length + 8) >> 6) + 1) * 16);
  for (let i = 0; i < length; i++) {
    words[i >> 2] |= data[i] << (24 - (i % 4) * 8);
  }
  words[length >> 2] |= 0x80 << (24 - (length % 4) * 8);
  words[words.length - 1] = length * 8;
  words[words.length - 2] = Math.floor((length * 8) / 0x100000000);
  let h0 = 0x67452301,
    h1 = 0xefcdab89,
    h2 = 0x98badcfe,
    h3 = 0x10325476,
    h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let block = 0; block < words.length; block += 16) {
    for (let t = 0; t < 16; t++) w[t] = words[block + t];
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) >>> 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}
