/**
 * AIB-wsl-helper: AIB's file, git and lookup work for WSL projects, run inside the distro (design 1, 3). Built with `deno compile`
 * for Linux (tools/build.ts wslBinaries) and spawned by AIB as a pipe channel of the distro's keeper, label {aib:'wsl-helper', v}.
 *
 *   AIB-wsl-helper [--data <linux data folder>]   JSON-RPC 2.0 lines on stdin/stdout; the first line is `helper.ready`
 *
 * With `--data` it also keeps the WSL projects' worktrees (helper/worktrees.ts: `<data>/worktrees`, registry in `<data>`).
 * It writes the aib-open script next to itself (BROWSER for agents) and serves <data>/helper/open.fifo (helper/browser.ts). It refuses to start (one `helper.failed {code, message}` line, exit 1) on a musl distro, or when the AIB folder or its own folder
 * can be written by group or others. Its state is in files (the worktree registry, the live sync records and the list of chats live sync
 * watches, helper/sync.ts): AIB may kill and respawn it at any time, and a new helper watches the same chats again at its start.
 */
import { APP_VERSION } from '../core/app.ts';
import { HELPER_PROTOCOL, WSL_ROOT_DIR } from './contract.ts';
import { agentEnv, captureLoginEnv, cleanPath, loginShell } from './helper/env.ts';
import { lineWriter, serveLines } from './helper/rpc.ts';
import { makeMethods } from './helper/methods.ts';
import { serveOpenFifo, shimScript } from './helper/browser.ts';
import { worktreeStartup } from './helper/worktrees.ts';
import { HelperSync } from './helper/sync.ts';

const COMPILED = !/^deno(\.exe)?$/i.test(Deno.execPath().replace(/^.*[\\/]/, ''));
const SHIM_NAME = 'aib-open';

/** AIB_WSL_SYNC_POLL (seconds, 0.1 to 3600) from the helper's fixed environment: only AIB's tests set it (to prove inotify wakes the scan). */
export function syncPoll(value: string | undefined): { poll?: number } {
  const poll = Number(value);
  return value && Number.isFinite(poll) && poll >= 0.1 && poll <= 3600 ? { poll } : {};
}

function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : '';
}

/** ~/.aib-server, or AIB_WSL_ROOT (tests: an absolute /tmp path). */
export function wslRoot(env: Record<string, string | undefined>): string {
  const own = env.AIB_WSL_ROOT;
  if (own && own.startsWith('/')) return own.replace(/\/+$/, '');
  return `${env.HOME ?? ''}/${WSL_ROOT_DIR}`;
}

/** Why this distro cannot run the helper, or ''. */
export function refusal(root: string, exeDir: string | null, musl: () => boolean = hasMusl): string {
  if (musl()) return 'musl: this distro uses musl libc (Alpine and similar); AIB needs a glibc distro such as Ubuntu or Debian';
  for (const dir of [root, ...(exeDir ? [exeDir] : [])]) {
    try {
      const mode = Deno.statSync(dir).mode ?? 0;
      if (mode & 0o022) return `perms: ${dir} can be written by other users (mode ${(mode & 0o777).toString(8)}); run chmod 700 on it`;
    } catch { /* not there yet: AIB creates it 0700 */ }
  }
  return '';
}

/** /lib/ld-musl-<arch>.so.1 is musl's loader. */
function hasMusl(): boolean {
  try {
    return [...Deno.readDirSync('/lib')].some((e) => e.name.startsWith('ld-musl'));
  } catch {
    return false;
  }
}

function uid(): number | null {
  try {
    return Deno.uid(); // --allow-sys=uid; /proc itself needs --allow-all in Deno
  } catch {
    return null;
  }
}

function readOr(path: string): string | null {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return null;
  }
}

/**
 * Removes older `<ver>` folders of the AIB folder that no running program comes from (design 3, install and update). `self` must be
 * among the running programs found, else nothing is removed (a /proc it could not read looks like "nothing runs").
 */
export async function cleanOldVersions(
  root: string,
  keep: string,
  self: string,
  procExes: () => Promise<string[] | null> = runningExes,
): Promise<string[]> {
  const removed: string[] = [];
  let names: string[];
  try {
    names = [...Deno.readDirSync(root)].filter((e) => e.isDirectory).map((e) => e.name);
  } catch {
    return removed;
  }
  const old = names.filter((n) => n !== keep && /^\d+\.\d+\.\d+[0-9A-Za-z.+-]*-[0-9a-f]{8}$/.test(n));
  if (!old.length) return removed;
  const exes = await procExes();
  if (!exes || !exes.includes(self)) return removed;
  for (const name of old) {
    const dir = `${root}/${name}`;
    if (exes.some((exe) => exe.startsWith(dir + '/'))) continue;
    try {
      Deno.removeSync(dir, { recursive: true });
      removed.push(name);
    } catch { /* busy or not ours */ }
  }
  return removed;
}

/** The programs this user runs, from /proc/<pid>/exe. Read by sh: Deno lets only --allow-all programs read /proc. */
async function runningExes(): Promise<string[] | null> {
  try {
    const out = await new Deno.Command('/bin/sh', {
      args: ['-c', 'for p in /proc/[0-9]*; do readlink "$p/exe"; done 2>/dev/null; exit 0'],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).output();
    return out.success ? new TextDecoder().decode(out.stdout).split('\n').filter(Boolean) : null;
  } catch {
    return null;
  }
}

async function writeOut(bytes: Uint8Array): Promise<void> {
  for (let at = 0; at < bytes.length;) at += await Deno.stdout.write(bytes.subarray(at));
}

async function helperMain(args: string[]): Promise<number> {
  const send = lineWriter(writeOut);
  const base = Deno.env.toObject();
  const root = wslRoot(base);
  const exeDir = COMPILED ? Deno.execPath().replace(/\/[^/]*$/, '') : null;
  const refused = refusal(root, exeDir);
  if (refused) {
    const [code, message] = [refused.slice(0, refused.indexOf(':')), refused.slice(refused.indexOf(':') + 2)];
    await send({ jsonrpc: '2.0', method: 'helper.failed', params: { code, message } });
    return 1;
  }
  Deno.env.set('PATH', cleanPath(base.PATH ?? '') || '/usr/local/bin:/usr/bin:/bin'); // no Windows folder, even before the capture
  const data = argValue(args, '--data') || root;
  const run = `${data}/helper`;
  const me = uid();
  let open: { path: string; close(): void } | null = null;
  try {
    open = await serveOpenFifo(
      run,
      (url) => void send({ jsonrpc: '2.0', method: 'browser.open', params: { url } }).catch(() => {}),
      (reason) => console.error(`AIB-wsl-helper: a link was not passed on (${reason})`),
    );
  } catch (error) {
    console.error(`AIB-wsl-helper: no open.fifo (${error instanceof Error ? error.message : error}); links stay in the distro`);
  }
  const shim = `${exeDir ?? run}/${SHIM_NAME}`;
  try {
    const text = shimScript();
    if (readOr(shim) !== text) {
      Deno.writeTextFileSync(`${shim}.part`, text, { mode: 0o755 });
      Deno.chmodSync(`${shim}.part`, 0o755);
      Deno.renameSync(`${shim}.part`, shim);
    }
  } catch (error) {
    console.error(`AIB-wsl-helper: could not write ${shim} (${error instanceof Error ? error.message : error})`);
  }
  const shell = loginShell(base, readOr('/etc/passwd'), me);
  const captured = captureLoginEnv(shell, base).then((c) => {
    const env = agentEnv(c.env, { browser: shim, ...(open ? { openFifo: open.path } : {}) });
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v); // git, which and the module's own spawns use it from here on
    for (const k of Object.keys(base)) if (!(k in env)) Deno.env.delete(k);
    return { env, shell, home: env.HOME ?? base.HOME ?? '', arch: Deno.build.arch === 'x86_64' ? 'amd64' : 'arm64' };
  });
  // worktrees only with the data folder named (one per Windows AIB): `<data>/worktrees`, its registry `<data>/studio-worktrees.json`
  const named = argValue(args, '--data').startsWith('/') ? data : '';
  // live sync of the WSL chats' worktrees (helper/sync.ts), over the same data folder; its poll can be stretched by AIB's tests only
  const sync = named ? new HelperSync(named, syncPoll(base.AIB_WSL_SYNC_POLL)) : null;
  const methods = makeMethods({
    env: () => captured,
    own: [root, data, ...(exeDir ? [exeDir] : [])],
    ...(named ? { data: named } : {}),
    ...(sync ? { sync } : {}),
  });
  // git needs the login PATH first; then the chats the last helper synced are watched again and caught up
  if (named) void captured.then(() => worktreeStartup(named)).then(() => sync?.resumeSaved()).catch(() => {});
  if (COMPILED && exeDir) {
    const keep = exeDir.slice(exeDir.lastIndexOf('/') + 1);
    setTimeout(() => void cleanOldVersions(root, keep, Deno.execPath()).catch(() => {}), 30_000);
  }
  await send({
    jsonrpc: '2.0',
    method: 'helper.ready',
    params: { helper: APP_VERSION, protocol: HELPER_PROTOCOL, methods: Object.keys(methods) },
  });
  await serveLines(Deno.stdin.readable, send, methods);
  open?.close();
  return 0;
}

if (import.meta.main) {
  Deno.exit(await helperMain(Deno.args));
}
