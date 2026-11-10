/**
 * Where Agent Studio keeps its data, and who may touch it (state_paths.py; same rules, same messages).
 *
 * Per-user folder (owner-only):
 *   Windows  %LOCALAPPDATA%\AgentStudio
 *   macOS    ~/Library/Application Support/AgentStudio
 *   Linux    $XDG_STATE_HOME/agent-studio, else ~/.local/state/agent-studio
 *
 * Which folder a run uses, first match wins: 1. --state-dir PATH; 2. AGENT_STUDIO_STATE_DIR; 3. default: a git WORKTREE keeps the old
 * folder next to its code (<repo>/work/agent-studio-state); anything else (the main checkout, the installed app) uses the per-user
 * folder. A ".git" FILE above the code means a worktree, as does a path containing .claude/worktrees or .git/worktrees; a ".git"
 * DIRECTORY or no ".git" at all counts as main.
 *
 * Tests never reach the real per-user folder: with AGENT_STUDIO_TEST=1 (or when a Deno test file is the main module, the analogue of
 * Python's "unittest/pytest is loaded") resolving it throws RealFolderBlocked.
 *
 * The per-user folder is created owner-only and a Studio refuses to start if Users, Everyone or Authenticated Users can write to it
 * (Windows: the DACL is read with GetNamedSecurityInfoW and compared by SID, server/platform/acl.ts; POSIX: mode 0700 and no
 * group/other write). A folder chosen with --state-dir or the environment only produces a warning.
 *
 * Moving old data into the per-user folder is server/state/migrate.ts (migrate.py): prepare() and adoptSandboxCopy() call the function
 * given to registerMigrate() (or options.migrate) at exactly the places Python calls migrate.migrate(). Importing migrate.ts registers
 * it (main.ts does); without one (a test that imports only this module) the move reports 'failed' and the run keeps using the old
 * folder, so nothing is lost.
 *
 * Packaged parent apps (Windows): a Studio started from the Claude desktop app (MSIX) has its %LOCALAPPDATA% writes virtualized into
 * %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local. packageContext() detects that; adoptSandboxCopy() moves such a copy to the real
 * folder when Studio runs outside the package.
 */
import { APP_ROOT, testsDir } from '../core/app.ts';
import { type AceEntry, type PackageKernel, packageKernel, windowsCurrentUserSid, windowsDacl } from '../platform/acl.ts';

export const APP_DIR_WINDOWS = 'AgentStudio';
export const APP_DIR_POSIX = 'agent-studio';
export const ENV_STATE_DIR = 'AGENT_STUDIO_STATE_DIR';
export const ENV_TEST = 'AGENT_STUDIO_TEST';
export const MIGRATED_MARKER = '.migrated';

// Well-known SIDs (locale independent).
export const SID_EVERYONE = 'S-1-1-0';
export const SID_AUTH_USERS = 'S-1-5-11';
export const SID_USERS = 'S-1-5-32-545';
export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINS = 'S-1-5-32-544';
export const SID_CREATOR_OWNER = 'S-1-3-0';
export const WIDE_GROUPS: Readonly<Record<string, string>> = {
  [SID_EVERYONE]: 'Everyone',
  [SID_AUTH_USERS]: 'Authenticated Users',
  [SID_USERS]: 'Users',
};
// FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_WRITE_EA, FILE_DELETE_CHILD, FILE_WRITE_ATTRIBUTES, DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE
export const WRITE_MASK = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
export const ALLOW_TYPES: ReadonlySet<number> = new Set([0, 5, 9, 11]); // ACCESS_ALLOWED, _OBJECT, _CALLBACK, _CALLBACK_OBJECT

export class StateDirError extends Error {
  override name = 'StateDirError';
}

/** A test or demo tried to use the real per-user folder. */
export class RealFolderBlocked extends StateDirError {
  override name = 'RealFolderBlocked';
}

/** The per-user folder can be written by someone other than its owner. */
export class StateDirInsecure extends StateDirError {
  override name = 'StateDirInsecure';
}

export type Env = Record<string, string | undefined>;
export type Say = (message: string) => void;

// ---- paths (Python's os.path / pathlib on this OS) ---------------------------------------------
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';

/** sys.platform for this process: 'win32', 'darwin', 'linux'. */
export function currentPlatform(): string {
  return WIN ? 'win32' : Deno.build.os;
}

function splitRoot(path: string): [string, string] {
  if (WIN) {
    const p = path.replaceAll('/', '\\');
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(p);
    if (unc) return [unc[0] + '\\', p.slice(unc[0].length)];
    const drive = /^[A-Za-z]:\\?/.exec(p);
    if (drive) return [drive[0], p.slice(drive[0].length)];
    if (p.startsWith('\\')) return ['\\', p.slice(1)];
    return ['', p];
  }
  return path.startsWith('/') ? ['/', path.replace(/^\/+/, '')] : ['', path];
}

function isAbsolute(path: string): boolean {
  const [root] = splitRoot(path);
  return WIN ? root.length > 1 && root.endsWith('\\') : root === '/';
}

/** pathlib.Path(*parts) as a string: later absolute parts win, separators normalized, '.' parts dropped, '..' kept. */
export function pathOf(...parts: string[]): string {
  let root = '';
  let names: string[] = [];
  for (const part of parts) {
    const [r, rest] = splitRoot(String(part));
    if (r) {
      root = r;
      names = [];
    }
    names.push(...rest.split(/[\\/]+/).filter((n) => n && n !== '.'));
  }
  return root + names.join(SEP) || '.';
}

/** os.path.abspath: absolute against the working folder, with '.' and '..' resolved. */
export function abspath(path: string): string {
  let full = String(path);
  if (!isAbsolute(full)) {
    const cwd = Deno.cwd();
    full = WIN && /^[\\/](?![\\/])/.test(full) ? splitRoot(cwd)[0].replace(/\\$/, '') + full : cwd + SEP + full;
  }
  const [root, rest] = splitRoot(full);
  const names: string[] = [];
  for (const name of rest.split(/[\\/]+/)) {
    if (!name || name === '.') continue;
    if (name === '..') names.pop();
    else names.push(name);
  }
  return root + names.join(SEP);
}

function normcase(path: string): string {
  return WIN ? path.replaceAll('/', '\\').toLowerCase() : path;
}

function stripVerbatim(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return '\\\\' + path.slice(8);
  return path.startsWith('\\\\?\\') ? path.slice(4) : path;
}

/** os.path.realpath (non-strict): symlinks resolved for the part that exists, the rest appended. */
export function realpath(path: string): string {
  const full = abspath(path);
  const [root, rest] = splitRoot(full);
  const names = rest.split(/[\\/]+/).filter(Boolean);
  for (let count = names.length; count >= 0; count--) {
    try {
      const real = stripVerbatim(Deno.realPathSync(root + names.slice(0, count).join(SEP)));
      return pathOf(real, ...names.slice(count));
    } catch { /* this part does not exist (or cannot be read): try its parent */ }
  }
  return full;
}

function home(): string {
  const env = Deno.env.toObject();
  if (WIN) return env.USERPROFILE || ((env.HOMEDRIVE ?? '') + (env.HOMEPATH ?? '')) || 'C:\\';
  return env.HOME || '/';
}

function expanduser(path: string): string {
  return /^~(?=$|[\\/])/.test(path) ? pathOf(home(), path.slice(1).replace(/^[\\/]+/, '')) : path;
}

function stat(path: string): Deno.FileInfo | null {
  try {
    return Deno.statSync(path);
  } catch {
    return null;
  }
}

const exists = (path: string) => stat(path) !== null;
const isFile = (path: string) => stat(path)?.isFile === true;
const isDir = (path: string) => stat(path)?.isDirectory === true;

function key(path: string): string {
  return normcase(abspath(path));
}

export function samePath(a: string, b: string): boolean {
  try {
    return normcase(realpath(a)) === normcase(realpath(b));
  } catch {
    return key(a) === key(b);
  }
}

// ---- locations ---------------------------------------------------------------------------------
/** The per-user folder for this OS. Pure: no test guard, no I/O (realUserStateDir() is the guarded one). */
export function userStateDir(env?: Env, platform?: string, homeDir?: string): string {
  env ??= Deno.env.toObject();
  platform ||= currentPlatform();
  const base = homeDir ? pathOf(homeDir) : home();
  if (platform.startsWith('win')) return pathOf(env.LOCALAPPDATA || pathOf(base, 'AppData', 'Local'), APP_DIR_WINDOWS);
  if (platform === 'darwin') return pathOf(base, 'Library', 'Application Support', APP_DIR_WINDOWS);
  return pathOf(env.XDG_STATE_HOME || pathOf(base, '.local', 'state'), APP_DIR_POSIX);
}

/** A Deno test file is the main module: the analogue of Python's "unittest or pytest is loaded". */
function testRunnerLoaded(): boolean {
  return /[._]test\.[cm]?[jt]sx?$/.test(Deno.mainModule);
}

export function underTest(env?: Env): boolean {
  env ??= Deno.env.toObject();
  return env[ENV_TEST] === '1' || testRunnerLoaded();
}

/** userStateDir(), but throws RealFolderBlocked under tests when that is the REAL folder of this machine and user (a fake env/home is fine). */
export function realUserStateDir(env?: Env, platform?: string, homeDir?: string): string {
  const path = userStateDir(env, platform, homeDir);
  if (underTest(env) && samePath(path, userStateDir())) {
    throw new RealFolderBlocked(
      'Refusing to resolve the real per-user Agent Studio folder while running tests ' +
        `(${ENV_TEST}=1 or unittest/pytest is loaded). Pass --state-dir or set ${ENV_STATE_DIR} to a temp folder.`,
    );
  }
  return path;
}

export function oldDefaultDir(codeRoot: string): string {
  return pathOf(testsDir(realpath(codeRoot)), 'agent-studio-state');
}

/** True for a git worktree (see the module comment). A folder with no .git anywhere above it (an installed copy) is not one. */
export function isWorktreeCheckout(codeRoot: string): boolean {
  const path = realpath(codeRoot);
  const text = '/' + path.replaceAll('\\', '/').toLowerCase().replace(/^\/+|\/+$/g, '') + '/';
  if (text.includes('/.claude/worktrees/') || text.includes('/.git/worktrees/')) return true;
  const [root, rest] = splitRoot(path);
  const names = rest.split(/[\\/]+/).filter(Boolean);
  for (let up = 0; up <= 6 && up <= names.length; up++) {
    const folder = root + names.slice(0, names.length - up).join(SEP);
    const git = stat(pathOf(folder, '.git'));
    if (git?.isFile) return true;
    if (git?.isDirectory) return false;
  }
  return false;
}

export class Resolved {
  constructor(readonly path: string, readonly source: 'cli' | 'env' | 'worktree' | 'user', readonly isUserFolder: boolean) {}
}

/** Pick the state folder. Throws RealFolderBlocked when a test would end up on the real per-user folder. */
export function resolve(cliStateDir?: string | null, env?: Env, codeRoot?: string | null, platform?: string, homeDir?: string): Resolved {
  env ??= Deno.env.toObject();
  codeRoot ||= APP_ROOT;
  let chosen: string;
  let source: 'cli' | 'env';
  if (cliStateDir) {
    chosen = pathOf(cliStateDir);
    source = 'cli';
  } else if (env[ENV_STATE_DIR]) {
    chosen = expanduser(pathOf(env[ENV_STATE_DIR]!));
    source = 'env';
  } else if (isWorktreeCheckout(codeRoot)) {
    return new Resolved(oldDefaultDir(codeRoot), 'worktree', false);
  } else {
    return new Resolved(realUserStateDir(env, platform, homeDir), 'user', true);
  }
  chosen = abspath(chosen);
  const isUser = samePath(chosen, userStateDir(env, platform, homeDir));
  if (isUser && underTest(env) && samePath(chosen, userStateDir())) {
    throw new RealFolderBlocked(`Refusing to use the real per-user Agent Studio folder ${chosen} while running tests.`);
  }
  return new Resolved(chosen, source, isUser);
}

// ---- packaged parent app (Windows) -------------------------------------------------------------
export const NO_PACKAGE = 15700; // APPMODEL_ERROR_NO_PACKAGE
export const ERROR_INSUFFICIENT_BUFFER = 122; // the expected answer to a size query
export const SANDBOX_TAIL = ['LocalCache', 'Local', APP_DIR_WINDOWS] as const;
export const SANDBOX_NOTE = 'MIGRATED-TO.txt'; // migrate.NOTE_NAME

/** The family name of the package this very process belongs to (GetCurrentPackageFullName), or null. Children of a packaged app get NO_PACKAGE. */
function packageFamilyFromApi(kernel?: PackageKernel): string | null {
  if (!kernel) {
    if (!WIN) return null;
    kernel = packageKernel();
  }
  const length = new Uint32Array(1);
  const code = kernel.GetCurrentPackageFullName(length, null);
  if (code === NO_PACKAGE || (code !== 0 && code !== ERROR_INSUFFICIENT_BUFFER) || !length[0]) return null;
  const buffer = new Uint16Array(length[0]);
  if (kernel.GetCurrentPackageFullName(length, buffer) !== 0) return null;
  let end = buffer.indexOf(0);
  if (end < 0) end = buffer.length;
  const value = String.fromCharCode(...buffer.subarray(0, end));
  const parts = value.split('_'); // <name>_<version>_<arch>_<resource id>_<publisher id>
  return parts.length >= 2 ? `${parts[0]}_${parts[parts.length - 1]}` : value;
}

function randomSuffix(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 8);
}

/** Children of a packaged app still get their %LOCALAPPDATA% writes redirected into the package: write a marker and look for it there. */
function packageFamilyFromProbe(env?: Env, suffix: () => string = randomSuffix): string | null {
  env ??= Deno.env.toObject();
  const base = env.LOCALAPPDATA;
  if (!base || !isDir(base)) return null;
  const name = `.studio-package-probe-${Deno.pid}-${suffix()}`;
  const marker = pathOf(base, name);
  try {
    Deno.writeFileSync(marker, new Uint8Array());
  } catch {
    return null;
  }
  try {
    const packages = [...Deno.readDirSync(pathOf(base, 'Packages'))].map((e) => e.name)
      .sort((a, b) => (normcase(a) < normcase(b) ? -1 : normcase(a) > normcase(b) ? 1 : 0));
    for (const family of packages) {
      if (exists(pathOf(base, 'Packages', family, 'LocalCache', 'Local', name))) return family;
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      Deno.removeSync(marker);
    } catch { /* already gone */ }
  }
}

export interface PackageOptions {
  env?: Env;
  platform?: string;
  kernel?: PackageKernel;
  /** The random part of the probe file name (tests). */
  probeSuffix?: () => string;
}

/**
 * The family name (e.g. 'Claude_pzs8sxrjxfjjc') of the Windows package whose sandbox this process writes into, or null (not Windows,
 * or outside any package). Asks GetCurrentPackageFullName first, then checks for inherited redirection.
 */
export function packageContext(options: PackageOptions = {}): string | null {
  const platform = options.platform || currentPlatform();
  if (!platform.startsWith('win')) return null;
  try {
    return packageFamilyFromApi(options.kernel) || packageFamilyFromProbe(options.env, options.probeSuffix);
  } catch { // never let detection stop Studio from starting
    return null;
  }
}

/** 'Claude' for 'Claude_pzs8sxrjxfjjc'. */
export function packageLabel(family: string | null | undefined): string {
  return family ? String(family).split('_')[0] : '';
}

function hasData(folder: string): boolean {
  return isFile(pathOf(folder, 'studio-settings.json')) || isFile(pathOf(folder, 'studio-conversations.json'));
}

/**
 * Sandbox copies of the Studio folder that hold user data: [family, folder] newest first. Only Claude_* packages count, or, when no
 * Claude package has one, any package if exactly one does. Copies already moved (note MIGRATED-TO.txt) are ignored.
 */
export function sandboxCopies(env?: Env, platform?: string): [string, string][] {
  env ??= Deno.env.toObject();
  platform ||= currentPlatform();
  const base = env.LOCALAPPDATA;
  if (!platform.startsWith('win') || !base) return [];
  const found: [number, string, string][] = [];
  try {
    for (const entry of Deno.readDirSync(pathOf(base, 'Packages'))) {
      const folder = pathOf(base, 'Packages', entry.name, ...SANDBOX_TAIL);
      if (isDir(folder) && hasData(folder) && !exists(pathOf(folder, SANDBOX_NOTE))) {
        const times = ['studio-settings.json', 'studio-conversations.json'].map((n) => pathOf(folder, n)).filter(isFile)
          .map((p) => Deno.statSync(p).mtime?.getTime() ?? 0);
        found.push([Math.max(...times), entry.name, folder]);
      }
    }
  } catch {
    return [];
  }
  found.sort((a, b) => b[0] - a[0]);
  const claude = found.filter((row) => row[1].toLowerCase().startsWith('claude_'));
  const chosen = claude.length ? claude : found.length === 1 ? found : [];
  return chosen.map(([, family, folder]) => [family, folder]);
}

function countWorktrees(source: string): number {
  try {
    return [...Deno.readDirSync(pathOf(source, 'worktrees'))].filter((e) => e.isDirectory || isDir(pathOf(source, 'worktrees', e.name)))
      .length;
  } catch {
    return 0;
  }
}

/** migrate.migrate's result: {state: 'done'|'waiting'|'blocked'|'failed'|..., reason, source, ...}. */
export type Migration = { state: string; reason: string; source: string | null; [key: string]: unknown };
/** migrate.migrate(source, target, say). */
export type MigrateFn = (source: string, target: string, say: Say) => Migration | Promise<Migration>;

let registeredMigrate: MigrateFn | null = null;

/** server/state/migrate.ts registers its migrate() here when it is imported (migrate imports this module, so no import back). */
export function registerMigrate(fn: MigrateFn | null): void {
  registeredMigrate = fn;
}

function notPorted(source: string): Migration {
  return { state: 'failed', reason: 'moving the data is not available in this build yet (migrate is not ported)', source };
}

function runMigrate(fn: MigrateFn | undefined, source: string, target: string, say: Say): Promise<Migration> {
  const migrate = fn ?? registeredMigrate;
  return Promise.resolve(migrate ? migrate(source, target, say) : notPorted(source));
}

const sayOut: Say = (message) => console.log(message);
const sayErr: Say = (message) => console.error(message);

export interface AdoptOptions {
  env?: Env;
  platform?: string;
  say?: Say;
  attempt?: boolean;
  migrate?: MigrateFn;
}

/**
 * Studio runs OUTSIDE any package and `target` is the real per-user folder: decide what to do about a sandbox copy. Returns
 * [folder to use, migration] where migration.state is
 *   none      no sandbox copy (or already moved): nothing changes.
 *   conflict  target already has user data AND a sandbox copy exists: nothing is merged or overwritten; the owner decides.
 *   done      the copy was moved to target (migrate: copy, verify, note in the sandbox copy, source kept).
 *   waiting   a host or chat in the sandbox copy is still running (or attempt is false): this run keeps using the sandbox copy.
 *   blocked/failed  migrate refused: keep using target.
 */
export async function adoptSandboxCopy(target: string, options: AdoptOptions = {}): Promise<[string, Migration]> {
  const say = options.say ?? sayOut;
  const copies = sandboxCopies(options.env, options.platform);
  if (!copies.length) return [target, { state: 'none', reason: '', source: null, kind: 'sandbox' }];
  const [packageName, source] = copies[0];
  let extra = '';
  if (copies.length > 1) {
    extra = ` (${copies.length} copies were found in app sandboxes; using the newest, from ${packageName})`;
    say(`Several sandbox copies of the Studio data exist; using the newest: ${source}`);
  }
  if (hasData(target) || exists(pathOf(target, MIGRATED_MARKER))) {
    return [target, {
      state: 'conflict',
      reason: `${target} and ${source} both hold Studio data` + extra,
      source,
      package: packageName,
      kind: 'sandbox',
    }];
  }
  if (!(options.attempt ?? true)) {
    return [source, { state: 'waiting', reason: 'not attempted by this command' + extra, source, package: packageName, kind: 'sandbox' }];
  }
  // Python: migrate.migrate(source, target, say=say)
  const result: Migration = { ...(await runMigrate(options.migrate, source, target, say)), kind: 'sandbox', package: packageName };
  result.worktreesLeft = countWorktrees(source); // never moved: a moved git worktree loses its link to the repository
  if (result.state === 'waiting') {
    say(`Studio data will move from ${source} to ${target} at a later start. This run keeps using ${source}: ${result.reason}`);
    return [source, result];
  }
  return [target, result];
}

// ---- owner-only access -------------------------------------------------------------------------
/** List of reasons somebody other than the owner can write to path (empty = private). Throws when it cannot be read. */
export function aclProblems(path: string, platform?: string): string[] {
  platform ||= currentPlatform();
  if (platform.startsWith('win')) {
    const entries: AceEntry[] | null = windowsDacl(path);
    if (entries === null) return ['the folder has no access list, so everyone can write to it'];
    const found = new Set<string>();
    for (const [sid, aceType, mask] of entries) {
      if (ALLOW_TYPES.has(aceType) && sid in WIDE_GROUPS && (mask & WRITE_MASK) !== 0) found.add(`${WIDE_GROUPS[sid]} (${sid}) can write`);
    }
    return [...found].sort();
  }
  const info = Deno.statSync(path);
  const found: string[] = [];
  const mode = info.mode ?? 0;
  if (mode & 0o022) found.push(`group or others can write (mode ${(mode & 0o777).toString(8).padStart(3, '0')})`);
  const uid = Deno.uid();
  if (uid !== null && info.uid !== null && info.uid !== uid) found.push('the folder belongs to another user');
  return found;
}

/** Restrict a folder we just created: Windows keeps owner + SYSTEM + Administrators (by SID), POSIX uses mode 0700. */
export function makeOwnerOnly(path: string): void {
  if (WIN) {
    const grants = [`*${SID_SYSTEM}:(OI)(CI)F`, `*${SID_ADMINS}:(OI)(CI)F`, `*${windowsCurrentUserSid()}:(OI)(CI)F`];
    const result = new Deno.Command('icacls', { args: [path, '/inheritance:r', '/grant:r', ...grants], stdout: 'null', stderr: 'null' })
      .outputSync();
    if (result.code !== 0) throw new StateDirError(`Could not restrict ${path} to its owner (icacls exit code ${result.code}).`);
    try {
      for (const _ of Deno.readDirSync(path)) break; // never lock ourselves out
    } catch (error) {
      throw new StateDirError(`Restricting ${path} locked this user out: ${(error as Error).message}`);
    }
  } else {
    Deno.chmodSync(path, 0o700);
  }
}

function dirnameOf(path: string): string {
  const [root, rest] = splitRoot(path);
  const names = rest.split(/[\\/]+/).filter(Boolean);
  return names.length ? root + names.slice(0, -1).join(SEP) || '.' : path;
}

/**
 * Create path owner-only if it does not exist, then check it. strict=true throws StateDirInsecure when others can write;
 * strict=false prints a warning instead. An existing folder is checked but never changed. Returns whether it was created.
 */
export function ensurePrivateDir(path: string, strict = true, say: Say = sayErr): boolean {
  let created = !exists(path);
  if (created) {
    Deno.mkdirSync(dirnameOf(path), { recursive: true });
    try {
      Deno.mkdirSync(path, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
      created = false;
    }
    if (created) makeOwnerOnly(path);
  }
  let problems: string[];
  try {
    problems = aclProblems(path);
  } catch (error) {
    problems = [`its permissions could not be read (${(error as Error).message})`];
  }
  if (problems.length) {
    const text = `${path} is not private: ` + problems.join('; ') + '.';
    if (strict) {
      throw new StateDirInsecure(
        text + ' Agent Studio will not keep its data there. Fix the folder permissions or choose another --state-dir.',
      );
    }
    say('WARNING: ' + text);
  }
  return created;
}

// ---- choosing the folder for this run ----------------------------------------------------------
/** stateDir: the folder to run on. migration: {state: 'none'|'done'|'waiting'|'blocked'|'failed'|'conflict', reason, source}. */
export class Plan {
  constructor(readonly stateDir: string, readonly resolved: Resolved, readonly migration: Migration, readonly warnings: string[]) {}
}

export interface PrepareOptions {
  cliStateDir?: string | null;
  migrateFrom?: string | null;
  codeRoot?: string | null;
  env?: Env;
  attemptMigration?: boolean;
  say?: Say;
  /** Instead of the registered migrate (tests; Python's migrate through the parity bridge). */
  migrate?: MigrateFn;
  /** Instead of packageContext (tests: Python mocks state_paths.package_context). */
  packageContext?: (options: PackageOptions) => string | null;
}

/** Decide the state folder for this run, moving the old data first when that is due. Throws StateDirError on a refusal. */
export async function prepare(options: PrepareOptions = {}): Promise<Plan> {
  const say = options.say ?? sayOut;
  const env = options.env;
  const codeRoot = options.codeRoot || APP_ROOT;
  const attempt = options.attemptMigration ?? true;
  const resolved = resolve(options.cliStateDir, env, codeRoot);
  const warnings: string[] = [];
  let target = resolved.path;
  let migration: Migration = { state: 'none', reason: '', source: null };
  const explicitOverride = resolved.source === 'cli' || resolved.source === 'env';
  const wants = resolved.isUserFolder || (options.migrateFrom !== null && options.migrateFrom !== undefined && explicitOverride);
  if (resolved.source === 'user' && (options.packageContext ?? packageContext)({ env }) === null) {
    // outside any package: take over a copy the Claude app's sandbox holds
    const [use, sandbox] = await adoptSandboxCopy(target, { env, attempt, say, migrate: options.migrate });
    target = use;
    if (sandbox.state !== 'none') migration = sandbox;
  }
  if (wants && !exists(pathOf(target, MIGRATED_MARKER)) && migration.kind !== 'sandbox') {
    const source = options.migrateFrom ? abspath(options.migrateFrom) : oldDefaultDir(codeRoot);
    if (samePath(source, target)) {
      // nothing to move
    } else if (hasData(source)) {
      migration.source = source;
      if (!attempt) { // e.g. --stop-host: just look where the data still is
        migration = { ...migration, state: 'waiting', reason: 'migration not attempted by this command' };
        target = source;
      } else {
        // Python: migrate.migrate(source, target, say=say)
        migration = await runMigrate(options.migrate, source, target, say);
        if (migration.state !== 'done') {
          say(`Agent Studio data will move to ${target} at a later start. This run uses ${source}: ${migration.reason}`);
          target = source;
        }
      }
    }
  }
  const finalIsUser = samePath(target, resolved.path) && resolved.isUserFolder;
  if (finalIsUser) {
    ensurePrivateDir(target, true);
  } else if (exists(target)) {
    let problems: string[] = [];
    try {
      problems = aclProblems(target);
    } catch {
      problems = [];
    }
    if (problems.length) warnings.push(`${target} is not private: ` + problems.join('; ') + '.');
  }
  return new Plan(target, resolved, migration, warnings);
}

/** What apply() reads and fills in (Python: the argparse namespace). */
export interface StateOptions {
  stateDir?: string | null;
  migrateFrom?: string | null;
  migration?: Migration;
  stateWarnings?: string[];
}

/**
 * Resolve options.stateDir (null means the default) and set options.stateDir, options.migration and options.stateWarnings.
 * A refusal goes to `fail` (Python: parser.error, which prints the message and exits with code 2).
 */
export async function apply(
  options: StateOptions,
  fail: (message: string) => never,
  codeRoot?: string | null,
  attemptMigration = true,
): Promise<Plan> {
  let plan: Plan;
  try {
    plan = await prepare({ cliStateDir: options.stateDir, migrateFrom: options.migrateFrom, codeRoot, attemptMigration });
  } catch (error) {
    if (error instanceof StateDirError) fail(error.message);
    throw error;
  }
  options.stateDir = plan.stateDir;
  options.migration = plan.migration;
  options.stateWarnings = plan.warnings;
  for (const line of plan.warnings) console.error('WARNING: ' + line);
  return plan;
}
