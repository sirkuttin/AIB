/**
 * Where the agent programs are on this computer (adapters.py). No owner-machine paths: everything is looked up.
 *
 *   Claude Code   the installed `@agentclientprotocol/claude-agent-acp` package (dist/index.js, run with node)
 *   Codex         the installed `@zed-industries/codex-acp` package (bin/codex-acp.js, run with node) or `codex-acp` on PATH
 *   OMP           `omp` on PATH; on Windows also %LOCALAPPDATA%\omp\omp.exe
 *
 * Lookup order for Claude Code and Codex: the command-line flag, then a launcher saved in Settings, then Studio's own install
 * (`<state_dir>/agents/<id>/<version>/`, only a version folder that has a `.complete` marker, newest first), then the globally
 * installed adapter, then missing. A launcher from the flag or Settings is a script file that node runs. The adapter is never
 * started through the npm `.cmd` shim. Studio's own install is read fresh on every lookup, so a new install is seen by the next
 * call in any process (Python or Deno).
 *
 * On macOS and Linux, apps started from the desktop have a short PATH. initEnvironment() asks the user's login shell for the real
 * one once at startup and merges it into the environment. It does nothing on Windows.
 *
 * The lookups are async only because `npm root -g` runs a program (with a timeout). Rows and messages are Python's exactly.
 */
import { commandStatus } from './agent_registry.ts';
import { expandUser, isAbsolute, isFile, pathStr, resolvePath, which } from '../platform/pypath.ts';
import { pathOf, realpath } from '../state/paths.ts';
import { pyCompare } from '../core/py.ts';

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';

export type Package = readonly [name: string, entry: string];
export const CLAUDE_PACKAGE: Package = ['@agentclientprotocol/claude-agent-acp', 'dist/index.js'];
export const CODEX_PACKAGE: Package = ['@zed-industries/codex-acp', 'bin/codex-acp.js'];
/** Studio's own installs: the package names that may sit in <version>/node_modules/, current name first, each with the known entry
 * file that is used only when its package.json has no usable `bin`. */
export const STUDIO_PACKAGES: Readonly<Record<string, readonly Package[]>> = {
  claude: [CLAUDE_PACKAGE],
  codex: [['@agentclientprotocol/codex-acp', 'dist/index.js'], ['@zed-industries/codex-acp', 'bin/codex-acp.js']],
};
export const COMPLETE_MARKER = '.complete';
export const CLAUDE_INSTALL = 'npm i -g @agentclientprotocol/claude-agent-acp';
export const CODEX_INSTALL = 'npm i -g @agentclientprotocol/codex-acp';
export const PATH_START = '__STUDIO_PATH_START__';
export const PATH_END = '__STUDIO_PATH_END__';
export const LOGIN_SHELL_TIMEOUT = 3.0;
export const NPM_ROOT_TIMEOUT = 10.0;
export const CODEX_NEEDS_ADAPTER = 'The Codex app is on this PC, but AIB needs its ACP adapter.';
const NODE_MISSING = 'Node.js was not found. Install Node.js so AIB can start this adapter.';

export function isWindows(): boolean {
  return WIN;
}

/**
 * Test seams (the Python tests mock.patch these functions): when set, they replace the machine lookups. Never set in the app.
 */
export const adapterHooks: {
  globalRoots?: (node?: string, npmRoot?: NpmRoot) => string[] | Promise<string[]>;
  findNode?: (configured?: string) => string;
  codexOnPath?: () => string;
  codexPresent?: () => boolean;
} = {};

/** One way to start an agent: {argv, source, path, found, problem, text}. */
export interface LaunchRow {
  argv: string[];
  source: 'flag' | 'settings' | 'studio' | 'installed' | 'path' | 'missing' | string;
  path: string;
  found: boolean;
  problem: string;
  text: string;
}

// ---- login-shell PATH (macOS / Linux) ---------------------------------------------------------------------------------

/** The text between the last START and the END marker, or '' when the markers are missing. */
export function parseMarkedPath(output: unknown): string {
  if (typeof output !== 'string') return '';
  let start = output.lastIndexOf(PATH_START);
  if (start < 0) return '';
  start += PATH_START.length;
  const end = output.indexOf(PATH_END, start);
  if (end < 0) return '';
  const value = output.slice(start, end).trim();
  return value && !value.includes('\x00') && !value.includes('\n') ? value : '';
}

/** Entries of `login` first (it is the complete one), then anything only `current` has; no repeats, no empties. */
export function mergePaths(login: string, current: string, sep?: string): string {
  const separator = sep || (WIN ? ';' : ':');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...(login || '').split(separator), ...(current || '').split(separator)]) {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      out.push(entry);
    }
  }
  return out.join(separator);
}

export type Env = Record<string, string | undefined>;
/** Runs argv with {timeout seconds, env}; returns stdout. Throws on failure or timeout (tests pass their own). */
export type RunFn = (
  argv: string[],
  options: { timeout: number; env: Record<string, string>; stdin: 'null' },
) => Promise<{ stdout: string }>;

/** Run a program, stdout as text, killed after `timeout` seconds (then it throws). */
export async function runCapture(
  argv: string[],
  options: { timeout: number; env?: Record<string, string> },
): Promise<{ stdout: string; code: number }> {
  const child = new Deno.Command(argv[0], {
    args: argv.slice(1),
    stdin: 'null',
    stdout: 'piped',
    stderr: 'null',
    ...(options.env ? { env: options.env, clearEnv: true } : {}),
  }).spawn();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), options.timeout * 1000)));
  try {
    const result = await Promise.race([child.output(), timedOut]);
    if (result === 'timeout') {
      try {
        child.kill('SIGKILL');
      } catch { /* already gone */ }
      await child.status.catch(() => {});
      throw new Error('timed out');
    }
    return { stdout: new TextDecoder().decode(result.stdout), code: result.code };
  } finally {
    clearTimeout(timer);
  }
}

const defaultRun: RunFn = (argv, options) => runCapture(argv, options);

function currentSystem(): string {
  return WIN ? 'Windows' : Deno.build.os === 'darwin' ? 'Darwin' : 'Linux';
}

/** PATH as the user's login shell sees it, or '' (Windows, no usable $SHELL, a timeout, a failure). Never throws. */
export async function loginShellPath(environ?: Env, system?: string, run?: RunFn, timeout = LOGIN_SHELL_TIMEOUT): Promise<string> {
  const env = environ ?? Deno.env.toObject();
  if ((system || currentSystem()) === 'Windows') return '';
  const shell = env.SHELL || '';
  if (!shell || !isAbsolute(shell) || !isFile(shell)) return '';
  const script = `printf '%s' '${PATH_START}'; printf %s "$PATH"; printf '%s' '${PATH_END}'`;
  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) plain[k] = v;
  try {
    const done = await (run ?? defaultRun)([shell, '-l', '-c', script], { timeout, env: plain, stdin: 'null' });
    return parseMarkedPath(done.stdout || '');
  } catch {
    return '';
  }
}

let envDone = false;

/** Merge the login-shell PATH into the environment. Returns the PATH that was added to ('' when nothing changed).
 * With no `environ`, the real environment is merged once per process. */
export async function initEnvironment(environ?: Env, system?: string, run?: RunFn): Promise<string> {
  let target: Env;
  let real = false;
  if (environ === undefined) {
    if (envDone) return '';
    envDone = true;
    target = Deno.env.toObject();
    real = true;
  } else target = environ;
  const found = await loginShellPath(target, system, run);
  if (!found) return '';
  const merged = mergePaths(found, target.PATH ?? '', ':');
  if (merged === (target.PATH ?? '')) return '';
  target.PATH = merged;
  if (real) Deno.env.set('PATH', merged);
  return merged;
}

// ---- node and the npm global folder -----------------------------------------------------------------------------------

const npmRootCache = new Map<string, string>();

export function resetCache(): void {
  npmRootCache.clear();
}

/** The node program: the configured one if it exists, else PATH. '' when missing. */
export function findNode(configured?: string | null): string {
  if (adapterHooks.findNode) return adapterHooks.findNode(configured ?? '');
  for (const candidate of [configured, 'node']) {
    if (candidate) {
      const [found] = commandStatus(candidate);
      if (found) return found;
    }
  }
  return '';
}

function parentOf(path: string): string {
  const text = pathStr(path);
  const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'));
  if (index < 0) return '.';
  const head = text.slice(0, index);
  if (WIN && /^[A-Za-z]:$/.test(head)) return head + '\\';
  return head || text.slice(0, 1);
}

/** `npm root -g`, cached per node. '' when npm is missing or slow. */
export async function npmRootFromCommand(node?: string, run?: RunFn): Promise<string> {
  const key = String(node || '');
  const hit = npmRootCache.get(key);
  if (hit !== undefined) return hit;
  let npm: string | null = null;
  if (node) {
    const folder = parentOf(node);
    for (const name of WIN ? ['npm.cmd', 'npm'] : ['npm']) {
      if (isFile(pathOf(folder, name))) {
        npm = pathOf(folder, name);
        break;
      }
    }
  }
  npm = npm || which('npm');
  let value = '';
  if (npm) {
    try {
      // npm.cmd is a batch file: Deno starts .cmd files through cmd.exe itself, with its own quoting (only fixed arguments here).
      const plain = Deno.env.toObject();
      const done = await (run ?? defaultRun)([npm, 'root', '-g'], { timeout: NPM_ROOT_TIMEOUT, env: plain, stdin: 'null' });
      const lines = (done.stdout || '').split(/\r\n|\r|\n/).map((line) => line.trim()).filter((line) => line);
      value = lines.length ? lines[lines.length - 1] : '';
    } catch {
      value = '';
    }
  }
  npmRootCache.set(key, value);
  return value;
}

export type NpmRoot = (node?: string) => string | Promise<string>;

/** Folders that can hold globally installed npm packages, best guess first, without repeats. */
export async function globalRoots(node?: string, npmRoot?: NpmRoot): Promise<string[]> {
  if (adapterHooks.globalRoots) return await adapterHooks.globalRoots(node, npmRoot);
  const out: string[] = [];
  const add = (path: string | null | undefined) => {
    if (path) {
      const text = String(path);
      if (!out.includes(text)) out.push(text);
    }
  };
  if (node) {
    const base = parentOf(node);
    add(pathOf(base, 'node_modules')); // Windows installers, fnm aliases
    add(pathOf(parentOf(base), 'lib', 'node_modules')); // macOS / Linux prefix layout
  }
  add(await (npmRoot ?? ((n?: string) => npmRootFromCommand(n)))(node));
  const prefix = Deno.env.get('npm_config_prefix') || Deno.env.get('NPM_CONFIG_PREFIX');
  if (prefix) add(pathOf(prefix, WIN ? 'node_modules' : 'lib/node_modules'));
  const appdata = Deno.env.get('APPDATA');
  if (WIN && appdata) add(pathOf(appdata, 'npm', 'node_modules'));
  if (!WIN) { for (const fixed of ['/usr/local/lib/node_modules', '/opt/homebrew/lib/node_modules', '/usr/lib/node_modules']) add(fixed); }
  return out;
}

/** The entry file of a globally installed npm package, or ''. */
export async function findPackageFile(pkg: Package, node?: string, npmRoot?: NpmRoot): Promise<string> {
  const [name, entry] = pkg;
  for (const root of await globalRoots(node, npmRoot)) {
    const candidate = pathOf(root, ...name.split('/'), ...entry.split('/'));
    if (isFile(candidate)) return candidate;
  }
  return '';
}

// ---- Studio's own installs --------------------------------------------------------------------------------------------

/** <state_dir>/agents: one folder per agent id, one subfolder per version. */
export function agentsRoot(stateDir: string): string {
  return pathOf(stateDir, 'agents');
}

type VersionKey = [number, number[], number, string];

/** Sort key for version folder names: 1.10.0 above 1.9.0, a release above its prerelease, anything unparsable lowest. */
export function versionKey(name: string): VersionKey {
  // Python's re.match with '$' also matches before one final newline.
  const match = /^v?(\d+(?:\.\d+)*)(?:-(.*))?\n?$/.exec(name);
  if (!match) return [0, [], 0, name];
  return [1, match[1].split('.').map((part) => parseInt(part, 10)), match[2] !== undefined && match[2] !== '' ? 0 : 1, match[2] ?? ''];
}

function compareKeys(a: VersionKey, b: VersionKey): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  for (let i = 0; i < Math.min(a[1].length, b[1].length); i++) if (a[1][i] !== b[1][i]) return a[1][i] - b[1][i];
  if (a[1].length !== b[1].length) return a[1].length - b[1].length;
  if (a[2] !== b[2]) return a[2] - b[2];
  return pyCompare(a[3], b[3]);
}

function isDirSync(path: string): boolean {
  try {
    return Deno.statSync(path).isDirectory;
  } catch {
    return false;
  }
}

/** Version folders of an agent that finished installing (they hold the `.complete` marker, written last), newest first. */
export function completeVersions(stateDir: string, agentId: string): string[] {
  const base = pathOf(agentsRoot(stateDir), agentId);
  const folders: string[] = [];
  try {
    for (const entry of Deno.readDirSync(base)) {
      const folder = pathOf(base, entry.name);
      if (isDirSync(folder) && isFile(pathOf(folder, COMPLETE_MARKER))) folders.push(folder);
    }
  } catch {
    return [];
  }
  const name = (path: string) => path.slice(path.lastIndexOf(SEP) + 1);
  // sorted(reverse=True) keeps equal keys in their listed order
  return folders.map((folder, index) => ({ folder, index, key: versionKey(name(folder)) }))
    .sort((a, b) => compareKeys(b.key, a.key) || a.index - b.index)
    .map((item) => item.folder);
}

function normcase(path: string): string {
  return WIN ? path.replaceAll('/', '\\').toLowerCase() : path;
}

/** Path.resolve().relative_to(folder.resolve()) succeeds. */
export function inside(path: string, folder: string): boolean {
  try {
    const target = normcase(realpath(path));
    const base = normcase(realpath(folder)).replace(/[\\/]+$/, '');
    return target === base || target.startsWith(base + SEP);
  } catch {
    return false;
  }
}

/** The entry file of one package in a version folder, from its package.json `bin` (else the known path), or ''. */
export function packageEntry(versionDir: string, pkg: Package): string {
  const [name, known] = pkg;
  const folder = pathOf(versionDir, 'node_modules', ...name.split('/'));
  let data: unknown;
  try {
    data = JSON.parse(Deno.readTextFileSync(pathOf(folder, 'package.json')));
  } catch {
    return '';
  }
  let declared: unknown = typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>).bin : null;
  if (typeof declared === 'object' && declared !== null && !Array.isArray(declared)) {
    const bins = declared as Record<string, unknown>;
    const short = name.split('/').pop()!;
    declared = (Object.prototype.hasOwnProperty.call(bins, short) && bins[short]) ||
      Object.values(bins).find((v) => typeof v === 'string' && v) || null;
  }
  const relative = typeof declared === 'string' && declared ? declared : known;
  const candidate = pathOf(folder, relative);
  if (!inside(candidate, versionDir)) {
    console.warn(`Ignoring ${name}: its entry file ${relative} is outside ${versionDir}`);
    return '';
  }
  return isFile(candidate) ? realpath(candidate) : '';
}

export interface StudioInstall {
  entry: string;
  version: string;
  dir: string;
  package: string;
}

/** Studio's own install of an agent: the newest complete version that has a usable entry file, or null. Reads the disk every call. */
export function findStudioInstall(agentId: string, stateDir: string | null | undefined): StudioInstall | null {
  if (!stateDir || !Object.prototype.hasOwnProperty.call(STUDIO_PACKAGES, agentId)) return null;
  for (const folder of completeVersions(stateDir, agentId)) {
    for (const pkg of STUDIO_PACKAGES[agentId]) {
      const entry = packageEntry(folder, pkg);
      if (entry) return { entry, version: folder.slice(folder.lastIndexOf(SEP) + 1), dir: folder, package: pkg[0] };
    }
  }
  return null;
}

function studioLaunch(agentId: string, nodeCommand: string, stateDir: string | null | undefined): LaunchRow | null {
  const found = findStudioInstall(agentId, stateDir);
  if (!found) return null;
  const node = findNode(nodeCommand);
  if (!node) return row([], 'studio', found.entry, NODE_MISSING, `AIB's own install: ${found.entry}`);
  return row([node, found.entry], 'studio', found.entry, '', `AIB's own install ${found.version}: ${found.entry} (run with node)`);
}

// ---- agent lookups ----------------------------------------------------------------------------------------------------

function row(argv: string[], source: string, path: string, problem = '', note = ''): LaunchRow {
  return { argv: [...argv], source, path, found: argv.length > 0 && !problem, problem, text: note || (argv.length ? argv.join(' ') : '') };
}

/** flag / settings launcher: a script file that node runs. */
function scriptLaunch(source: 'flag' | 'settings', script: string, nodeCommand: string): LaunchRow {
  const path = expandUser(pathStr(String(script)));
  const node = findNode(nodeCommand) || String(nodeCommand || ''); // a node the caller named explicitly is used as given
  const label = { flag: 'Command-line launcher', settings: 'Launcher saved in Settings' }[source];
  if (!isFile(path)) return row([], source, path, `${label} not found: ${path}`, `${label}: ${path}`);
  if (!node) return row([], source, path, NODE_MISSING, `${label}: ${path}`);
  const resolved = resolvePath(path);
  return row([node, resolved], source, resolved, '', `${label}: ${resolved} (run with node)`);
}

async function installedLaunch(pkg: Package, nodeCommand: string, npmRoot?: NpmRoot): Promise<LaunchRow | null> {
  const node = findNode(nodeCommand);
  const entry = await findPackageFile(pkg, node || undefined, npmRoot);
  if (!entry) return null;
  if (!node) return row([], 'installed', entry, NODE_MISSING, `Installed adapter: ${entry}`);
  return row([node, entry], 'installed', entry, '', `Installed adapter: ${entry} (run with node)`);
}

export interface ResolveOptions {
  flag?: string;
  saved?: string;
  nodeCommand?: string;
  npmRoot?: NpmRoot;
  stateDir?: string | null;
}

/** How to start Claude Code. Never throws. */
export async function resolveClaude(options: ResolveOptions = {}): Promise<LaunchRow> {
  const { flag = '', saved = '', nodeCommand = '', npmRoot, stateDir } = options;
  if (flag) return scriptLaunch('flag', flag, nodeCommand);
  if (saved) return scriptLaunch('settings', saved, nodeCommand);
  const found = studioLaunch('claude', nodeCommand, stateDir) ?? await installedLaunch(CLAUDE_PACKAGE, nodeCommand, npmRoot);
  return found ?? row([], 'missing', '', 'Not installed. Install the adapter with: ' + CLAUDE_INSTALL, 'Not installed');
}

/** A native `codex-acp` program on PATH. The Windows .cmd/.bat shims are skipped: they cannot be started directly. */
export function codexOnPath(): string {
  if (adapterHooks.codexOnPath) return adapterHooks.codexOnPath();
  for (const name of WIN ? ['codex-acp.exe', 'codex-acp.com'] : ['codex-acp']) {
    const found = which(name);
    if (found) {
      try {
        return resolvePath(found);
      } catch {
        return found;
      }
    }
  }
  return '';
}

function homeDir(): string {
  return (WIN ? Deno.env.get('USERPROFILE') : Deno.env.get('HOME')) ?? Deno.env.get('HOME') ?? '.';
}

function listNames(folder: string): string[] {
  try {
    return [...Deno.readDirSync(folder)].map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** fnmatch of `prefix*suffix` (case-insensitive on Windows, as glob is there). */
function globMatch(name: string, prefix: string, suffix: string): boolean {
  const [n, p, s] = WIN ? [name.toLowerCase(), prefix.toLowerCase(), suffix.toLowerCase()] : [name, prefix, suffix];
  return n.length >= p.length + s.length && n.startsWith(p) && n.endsWith(s);
}

export interface CodexLookOptions {
  which?: (name: string) => string | null | undefined;
  home?: string;
  localAppdata?: string;
  systemWindows?: boolean;
}

/** Cheap signs that Codex itself (not its ACP adapter) is installed. Filesystem lookups only, no subprocess. */
export function codexLooksInstalled(options: CodexLookOptions = {}): boolean {
  const look = options.which ?? which;
  const windows = options.systemWindows ?? WIN;
  try {
    if (look('codex') || (windows && look('codex.exe'))) return true;
    const home = options.home || homeDir();
    if (isDirSync(pathOf(home, '.codex'))) return true;
    if (windows) {
      const base = options.localAppdata || Deno.env.get('LOCALAPPDATA') || pathOf(home, 'AppData', 'Local');
      const apps = pathOf(base, 'Microsoft', 'WindowsApps');
      if (listNames(apps).some((name) => globMatch(name, 'codex-', '.exe'))) return true;
      if (listNames(pathOf(base, 'Packages')).some((name) => globMatch(name, 'OpenAI.Codex_', ''))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

export interface ResolveCodexOptions extends ResolveOptions {
  onPath?: () => string;
  codexPresent?: () => boolean;
}

/** How to start Codex through codex-acp: same shape as resolveClaude. */
export async function resolveCodex(options: ResolveCodexOptions = {}): Promise<LaunchRow> {
  const { flag = '', saved = '', nodeCommand = '', npmRoot, stateDir } = options;
  if (flag) return scriptLaunch('flag', flag, nodeCommand);
  if (saved) return scriptLaunch('settings', saved, nodeCommand);
  const found = studioLaunch('codex', nodeCommand, stateDir) ?? await installedLaunch(CODEX_PACKAGE, nodeCommand, npmRoot);
  if (found) return found;
  const path = (options.onPath ?? codexOnPath)();
  if (path) return row([path], 'path', path, '', `codex-acp on PATH: ${path}`);
  const present = (options.codexPresent ?? adapterHooks.codexPresent ?? (() => codexLooksInstalled()))();
  const problem = present ? CODEX_NEEDS_ADAPTER : 'Not installed. Install the adapter with: ' + CODEX_INSTALL;
  return row([], 'missing', '', problem, 'Not installed');
}

export interface OmpLookOptions {
  which?: (name: string) => string | null | undefined;
  systemWindows?: boolean;
  home?: string;
  localAppdata?: string;
}

/** The OMP program: `omp` on PATH; on Windows also %LOCALAPPDATA%\omp\omp.exe. '' when not installed. */
export function defaultOmpCommand(options: OmpLookOptions = {}): string {
  const look = options.which ?? which;
  const windows = options.systemWindows ?? WIN;
  for (const name of windows ? ['omp.exe', 'omp'] : ['omp']) {
    const found = look(name);
    if (found) return found;
  }
  if (windows) {
    const base = options.localAppdata || Deno.env.get('LOCALAPPDATA') || pathOf(options.home || homeDir(), 'AppData', 'Local');
    const fallback = pathOf(base, 'omp', 'omp.exe');
    if (isFile(fallback)) return fallback;
  }
  return '';
}

export function resolveOmp(command: string): LaunchRow {
  if (!command) return row([], 'missing', '', 'Not installed. OMP was not found on PATH.', 'Not installed');
  const [found, problem] = commandStatus(command);
  if (!found) return row([], 'flag', String(command), problem, `${command} acp`);
  return row([found, 'acp'], 'path', found, '', `${found} acp`);
}
