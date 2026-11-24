/**
 * Where AIB keeps its data, and who may touch it (state_paths.py; same rules, same messages).
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
 * the older "test runner is loaded" rule) resolving it throws RealFolderBlocked.
 *
 * The per-user folder is created owner-only and an AIB refuses to start if Users, Everyone or Authenticated Users can write to it
 * (Windows: the DACL is read with GetNamedSecurityInfoW and compared by SID, server/platform/acl.ts; POSIX: mode 0700 and no
 * group/other write). A folder chosen with --state-dir or the environment only produces a warning.
 *
 * Packaged parent apps (Windows): an AIB started from the Claude desktop app (MSIX) has its %LOCALAPPDATA% writes virtualized into
 * %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Local. packageContext() detects that so the page can say so.
 */
import { APP_ROOT, testsDir } from '../core/app.ts';
import { type AceEntry, type PackageKernel, packageKernel, windowsCurrentUserSid, windowsDacl } from '../platform/acl.ts';

export const APP_DIR_WINDOWS = 'AgentStudio';
export const APP_DIR_POSIX = 'agent-studio';
export const ENV_STATE_DIR = 'AGENT_STUDIO_STATE_DIR';
export const ENV_TEST = 'AGENT_STUDIO_TEST';

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

// ---- paths ---------------------------------------------
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

/** A Deno test file is the main module: the signal that a test runner is loaded. */
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
      'Refusing to resolve the real per-user AIB folder while running tests ' +
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
    throw new RealFolderBlocked(`Refusing to use the real per-user AIB folder ${chosen} while running tests.`);
  }
  return new Resolved(chosen, source, isUser);
}

// ---- packaged parent app (Windows) -------------------------------------------------------------
export const NO_PACKAGE = 15700; // APPMODEL_ERROR_NO_PACKAGE
export const ERROR_INSUFFICIENT_BUFFER = 122; // the expected answer to a size query

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
  } catch { // never let detection stop AIB from starting
    return null;
  }
}

/** 'Claude' for 'Claude_pzs8sxrjxfjjc'. */
export function packageLabel(family: string | null | undefined): string {
  return family ? String(family).split('_')[0] : '';
}

const sayErr: Say = (message) => console.error(message);

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
        text + ' AIB will not keep its data there. Fix the folder permissions or choose another --state-dir.',
      );
    }
    say('WARNING: ' + text);
  }
  return created;
}

// ---- choosing the folder for this run ----------------------------------------------------------
/** stateDir: the folder to run on. */
export class Plan {
  constructor(readonly stateDir: string, readonly resolved: Resolved, readonly warnings: string[]) {}
}

export interface PrepareOptions {
  cliStateDir?: string | null;
  codeRoot?: string | null;
  env?: Env;
}

/** Decide the state folder for this run and check that it is private. Throws StateDirError on a refusal. */
// deno-lint-ignore require-await -- stays async: callers await it
export async function prepare(options: PrepareOptions = {}): Promise<Plan> {
  const env = options.env;
  const codeRoot = options.codeRoot || APP_ROOT;
  const resolved = resolve(options.cliStateDir, env, codeRoot);
  const warnings: string[] = [];
  const target = resolved.path;
  if (resolved.isUserFolder) {
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
  return new Plan(target, resolved, warnings);
}

/** What apply() reads and fills in. */
export interface StateOptions {
  stateDir?: string | null;
  stateWarnings?: string[];
}

/**
 * Resolve options.stateDir (null means the default) and set options.stateDir and options.stateWarnings.
 * A refusal goes to `fail` (it prints the message and exits with code 2).
 */
export async function apply(
  options: StateOptions,
  fail: (message: string) => never,
  codeRoot?: string | null,
): Promise<Plan> {
  let plan: Plan;
  try {
    plan = await prepare({ cliStateDir: options.stateDir, codeRoot });
  } catch (error) {
    if (error instanceof StateDirError) fail(error.message);
    throw error;
  }
  options.stateDir = plan.stateDir;
  options.stateWarnings = plan.warnings;
  for (const line of plan.warnings) console.error('WARNING: ' + line);
  return plan;
}
