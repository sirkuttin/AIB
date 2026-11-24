/**
 * Where the app lives and which version it is. APP_ROOT is the app folder (app/ in the repo). APP_VERSION is the one version
 * number.
 */

function folderOf(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  const native = Deno.build.os === 'windows' ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
  return native.replace(/[\\/]+$/, '');
}

/** The app folder (two levels above this file: server/core/ -> app root). */
export const APP_ROOT = folderOf(new URL('../../', import.meta.url));

/** The browser's files (JS, CSS, HTML): app/page/. They are served at the top level (/chat.js), not under /page/. */
export const PAGE_ROOT = APP_ROOT + (Deno.build.os === 'windows' ? '\\' : '/') + 'page';

/** Folders of APP_ROOT whose files are served from there; every other served name is a page file in PAGE_ROOT. */
const APP_FOLDERS = new Set(['pwa', 'icons', 'vendor']);

/** The file on disk for a served name: vendor/xterm/x.js, pwa/sw.js and icons/x.png are under APP_ROOT; any other name (chat.js) is a page file under PAGE_ROOT. */
export function servedFile(name: string): string {
  const sep = Deno.build.os === 'windows' ? '\\' : '/';
  const parts = name.split(/[\\/]+/);
  return (APP_FOLDERS.has(parts[0]) ? APP_ROOT : PAGE_ROOT) + sep + parts.join(sep);
}

export const APP_VERSION = '0.1.0-beta.11';
const [core, pre] = APP_VERSION.split(/-(.*)/s);
/** What people see: "AIB 0.1.0 beta". */
export const VERSION_LABEL = 'AIB ' + core + (pre ? ' ' + pre.split('.')[0] : '');
export const ABOUT_LINE = 'All your agents. One place. Nothing hidden.';

function parent(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, '');
}

/** The repository root: the folder above app/. */
export function repoRoot(codeRoot: string): string {
  return parent(codeRoot);
}

/** The folder with the tests and their fixtures: work/ in the repo root. */
export function testsDir(codeRoot: string): string {
  const sep = Deno.build.os === 'windows' ? '\\' : '/';
  return repoRoot(codeRoot) + sep + 'work';
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
