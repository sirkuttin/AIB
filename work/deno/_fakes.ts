/**
 * The one place that says how a test starts a fake agent (work/fakes/*.mjs). The fakes are plain ES modules that need only
 * node, the way the real agents (claude-agent-acp, codex-acp) are node programs, so a test starts one as `[NODE, script, ...flags]`
 * and passes NODE where it used to pass python as the "node command". No Python anywhere.
 */
const WIN = Deno.build.os === 'windows';

function nativePath(url: URL): string {
  const path = decodeURIComponent(url.pathname);
  return WIN ? path.replace(/^\/([A-Za-z]:)/, '$1').replaceAll('/', '\\') : path;
}

/** work/fakes/ as a native path (with a trailing separator). */
export const FAKES_DIR: string = nativePath(new URL('../fakes/', import.meta.url));

/** The absolute path of the node program (AIB_NODE, else the `node` on PATH). */
export const NODE: string = (() => {
  const named = Deno.env.get('AIB_NODE');
  if (named) return named;
  const out = new Deno.Command('node', { args: ['-p', 'process.execPath'], stdout: 'piped', stderr: 'null' }).outputSync();
  const path = new TextDecoder().decode(out.stdout).trim();
  if (!path) throw new Error('node is needed to run the fake agents (work/fakes); put node on PATH or set AIB_NODE');
  return path;
})();

/** The path of work/fakes/<name> (a file name with its extension, e.g. 'fake_acp.mjs'). */
export function fakePath(name: string): string {
  return `${FAKES_DIR}${name.replaceAll('/', WIN ? '\\' : '/')}`;
}

/** The command line that starts work/fakes/<name> with these flags. */
export function fakeArgv(name: string, ...flags: string[]): string[] {
  return [NODE, fakePath(name), ...flags];
}

/**
 * work/fakes/lock_helper.ts (a foreign process that holds or tries a file lock) runs as `new Deno.Command(Deno.execPath(),
 * { args: lockHelperArgs('hold' | 'try', path, seconds?) })`.
 */
export function lockHelperArgs(...args: string[]): string[] {
  return ['run', '-A', '--quiet', fakePath('lock_helper.ts'), ...args];
}
