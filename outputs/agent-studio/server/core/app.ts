/**
 * Where the app lives and which version it is. APP_ROOT is the app folder: outputs/agent-studio in the private repo, aib/ in the
 * public one. APP_VERSION is the one version number; the Python reference server (work/python-reference/version.py) must match it,
 * which host_client_test.ts checks, so a Python host reports the same version.
 */

function folderOf(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  const native = Deno.build.os === 'windows' ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
  return native.replace(/[\\/]+$/, '');
}

/** The app folder (two levels above this file: server/core/ -> app root). */
export const APP_ROOT = folderOf(new URL('../../', import.meta.url));

export const APP_VERSION = '0.1.0-beta.6';
const [core, pre] = APP_VERSION.split(/-(.*)/s);
/** What people see: "AIB 0.1.0 beta". */
export const VERSION_LABEL = 'AIB ' + core + (pre ? ' ' + pre.split('.')[0] : '');
export const ABOUT_LINE = 'All your agents. One place. Nothing hidden.';

function parentName(path: string): string {
  const parts = path.split(/[\\/]+/);
  return parts[parts.length - 2] ?? '';
}

function parent(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}

/** The repository root: two levels above outputs/agent-studio (private repo), one level above aib/ (public repo). */
export function repoRoot(codeRoot: string): string {
  return parentName(codeRoot) === 'outputs' ? parent(parent(codeRoot)) : parent(codeRoot);
}

/** The folder with the tests and their fixtures: work/ in the private repo, tests/ in the public one. */
export function testsDir(codeRoot: string): string {
  const sep = Deno.build.os === 'windows' ? '\\' : '/';
  return repoRoot(codeRoot) + sep + (parentName(codeRoot) === 'outputs' ? 'work' : 'tests');
}

export const REPO_ROOT = repoRoot(APP_ROOT);
export const TESTS_DIR = testsDir(APP_ROOT);

/** True inside a binary built with `deno desktop` (it has Deno.BrowserWindow); false under `deno run` and `deno compile`. */
export function isDesktopApp(): boolean {
  return typeof (Deno as unknown as { BrowserWindow?: unknown }).BrowserWindow === 'function';
}

/**
 * True when this code runs from a built binary (`deno compile` or `deno desktop`): the program is not deno itself. Then APP_ROOT
 * is a folder inside the binary's embedded file system, which does not exist on disk (no process can start in it).
 */
export function isCompiled(exe: string = Deno.execPath()): boolean {
  return !/^deno(\.exe)?$/i.test(exe.split(/[\\/]/).pop() ?? '');
}

/** A real folder to start our own child processes in: APP_ROOT under `deno run`, the binary's folder when compiled. */
export function launchDir(exe: string = Deno.execPath()): string {
  if (!isCompiled(exe)) return APP_ROOT;
  const folder = exe.replace(/[\\/][^\\/]*$/, '');
  return folder && folder !== exe ? folder : '.';
}

/** The program and leading arguments that run this same code with a subcommand: `deno run -A --quiet main.ts` or a compiled binary. */
export function selfCommand(): string[] {
  const exe = Deno.execPath();
  const sep = Deno.build.os === 'windows' ? '\\' : '/';
  if (!isCompiled(exe)) return [exe, 'run', '-A', '--quiet', `${APP_ROOT}${sep}server${sep}main.ts`];
  return [exe]; // deno compile / deno desktop: the binary is the program
}
