/**
 * AIB-wsl-helper: AIB's file, git and lookup work for WSL projects, run inside the distro (design 1, 3). Built with `deno compile`
 * for Linux (tools/build.ts wslBinaries) and spawned by AIB as a pipe channel of the distro's keeper, label {aib:'wsl-helper', v}.
 *
 *   AIB-wsl-helper [--data <linux data folder>] [--keeper <AIB-keeper>]   JSON-RPC 2.0 lines on stdin/stdout; the first line is `helper.ready`
 *   AIB-wsl-helper import --data <data> --project <path> [...]            the one-off chat import (helper/import.ts; tools/wsl-import.ts)
 *
 * With `--data` it also keeps the WSL projects' worktrees (helper/worktrees.ts: `<data>/worktrees`, registry in `<data>`).
 * It installs AIB's own copies of agents into <root>/agents (helper/agent_install.ts).
 * It runs the MCP tunnel (helper/mcp_tunnel.ts): `<keeper> mcp-relay` serves <data>/helper/mcp.sock for agents' forwarders (the keeper
 * program from --keeper, else the AIB-keeper next to this program); helper.ready then carries `mcp: {socket}`.
 * It writes the aib-open script next to itself (BROWSER for agents) and serves <data>/helper/open.fifo (helper/browser.ts). It refuses to start (one `helper.failed {code, message}` line, exit 1) on a musl distro, or when the AIB folder or its own folder
 * can be written by group or others. Its state is in files (the worktree registry, the live sync records and the list of chats live sync
 * watches, helper/sync.ts): AIB may kill and respawn it at any time, and a new helper watches the same chats again at its start.
 */
import { APP_VERSION } from '../core/app.ts';
import { HELPER_PROTOCOL, WSL_ROOT_DIR } from './contract.ts';
import { agentEnv, captureLoginEnv, cleanPath, loginShell } from './helper/env.ts';
import { type Handlers, lineWriter, serveLines } from './helper/rpc.ts';
import { makeMethods } from './helper/methods.ts';
import { type EnvMode, envModeOf } from './helper/prereqs.ts';
import { serveOpenFifo, shimScript } from './helper/browser.ts';
import { worktreeStartup } from './helper/worktrees.ts';
import { subagentStartup } from './helper/subagents.ts';
import { HelperSync } from './helper/sync.ts';
import { McpTunnel, SOCKET_NAME, spawnKeeperRelay } from './helper/mcp_tunnel.ts';
import { importMain } from './helper/import.ts';

const COMPILED = !/^deno(\.exe)?$/i.test(Deno.execPath().replace(/^.*[\\/]/, ''));
const SHIM_NAME = 'aib-open';
const KEEPER_NAME = 'AIB-keeper';

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

/**
 * The helper answers AIB while the distro's cores are busy with something else (a game build used 11 cores: its calls took minutes).
 * A better scheduling priority than the busy work's helps, and only what the system allows without root is tried: a lower nice
 * value is refused for a normal user (the answer is ignored, nothing else changes). Never throws, never waits for the answer.
 */
async function betterPriority(): Promise<void> {
  const stat = Deno.readTextFileSync('/proc/self/stat');
  const nice = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[16]); // field 19: nice
  if (!Number.isFinite(nice)) return;
  const want = nice > 0 ? 0 : -5;
  const out = await new Deno.Command('renice', { args: ['-n', String(want), '-p', String(Deno.pid)], stdin: 'null', stdout: 'null', stderr: 'null' }).output();
  if (out.code !== 0) console.error(`AIB-wsl-helper: kept its scheduling priority (nice ${nice}): the system does not allow a better one without root`);
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

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** Every call from AIB but `mcp.closed` says an AIB is there (the tunnel stops answering "AIB is closed"). */
function withTouch(methods: Handlers, tunnel: McpTunnel): Handlers {
  return Object.fromEntries(
    Object.entries(methods).map(([name, fn]) => [name, name === 'mcp.closed' ? fn : (params: Record<string, unknown>) => {
      tunnel.touch();
      return fn(params);
    }]),
  );
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
  let mode: EnvMode = 'plain'; // how the login environment was captured (env.prereqs)
  const captured = captureLoginEnv(shell, base).then((c) => {
    mode = envModeOf(c.how);
    const env = agentEnv(c.env, { browser: shim, ...(open ? { openFifo: open.path } : {}) });
    for (const [k, v] of Object.entries(env)) Deno.env.set(k, v); // git, which and the module's own spawns use it from here on
    for (const k of Object.keys(base)) if (!(k in env)) Deno.env.delete(k);
    return { env, shell, home: env.HOME ?? base.HOME ?? '', arch: Deno.build.arch === 'x86_64' ? 'amd64' : 'arm64' };
  });
  // worktrees only with the data folder named (one per Windows AIB): `<data>/worktrees`, its registry `<data>/studio-worktrees.json`
  const named = argValue(args, '--data').startsWith('/') ? data : '';
  // live sync of the WSL chats' worktrees (helper/sync.ts), over the same data folder; its poll can be stretched by AIB's tests only
  const sync = named ? new HelperSync(named, syncPoll(base.AIB_WSL_SYNC_POLL)) : null;
  // A Node.js installed in a terminal after this start (agent install's Check again): read the login PATH again, keep the rest.
  const refreshPath = async () => {
    const login = await captured;
    const again = await captureLoginEnv(shell, base);
    if (again.how === 'none') return;
    mode = envModeOf(again.how);
    const path = agentEnv(again.env).PATH;
    login.env.PATH = path;
    Deno.env.set('PATH', path);
    // nvm's folder too, so env.prereqs sees an nvm installed since this start
    if (again.env.NVM_DIR) {
      login.env.NVM_DIR = again.env.NVM_DIR;
      Deno.env.set('NVM_DIR', again.env.NVM_DIR);
    }
  };
  const own = makeMethods({
    env: () => captured,
    own: [root, data, ...(exeDir ? [exeDir] : [])],
    ...(named ? { data: named } : {}),
    ...(sync ? { sync } : {}),
    root, // AIB's own agent installs: <root>/agents/<id>/<version>
    notify: (method, params) => void send({ jsonrpc: '2.0', method, params }).catch(() => {}),
    refreshPath,
    envMode: () => mode,
    // read from the start environment: the login environment replaces it (aib.remove's test guard must not get lost)
    aibStart: { version: base.AIB_WSL_VERSION ?? '', test: base.AIB_WSL_TEST === '1' },
  });
  // The MCP tunnel: only with a keeper program to run the relay (one that knows `mcp-relay`; an older one exits at once: no tunnel).
  const keeper = argValue(args, '--keeper') || (exeDir ? `${exeDir}/${KEEPER_NAME}` : '');
  let tunnel: McpTunnel | null = null;
  let socket: string | null = null;
  if (keeper.startsWith('/') && isFile(keeper)) {
    tunnel = new McpTunnel({
      socket: `${run}/${SOCKET_NAME}`,
      notify: (method, params) => void send({ jsonrpc: '2.0', method, params }).catch(() => {}),
      spawnRelay: spawnKeeperRelay(keeper),
      log: (text) => console.error(`AIB-wsl-helper: ${text}`),
    });
    socket = await tunnel.start();
    if (!socket) {
      tunnel.stop();
      tunnel = null;
    }
  }
  const methods = tunnel ? withTouch({ ...own, ...tunnel.methods() }, tunnel) : own;
  // git needs the login PATH first; then the chats the last helper synced are watched again and caught up
  if (named) void captured.then(() => worktreeStartup(named)).then(() => subagentStartup(named)).then(() => sync?.resumeSaved()).catch(() => {});
  if (COMPILED && exeDir) {
    const keep = exeDir.slice(exeDir.lastIndexOf('/') + 1);
    setTimeout(() => void cleanOldVersions(root, keep, Deno.execPath()).catch(() => {}), 30_000);
  }
  if (COMPILED && base.AIB_WSL_NO_RENICE !== '1') void betterPriority().catch(() => {});
  await send({
    jsonrpc: '2.0',
    method: 'helper.ready',
    params: { helper: APP_VERSION, protocol: HELPER_PROTOCOL, methods: Object.keys(methods), ...(socket ? { mcp: { socket } } : {}) },
  });
  await serveLines(Deno.stdin.readable, send, methods);
  open?.close();
  tunnel?.stop();
  return 0;
}

if (import.meta.main) {
  // `import ...`: the one-off move of a project's existing chats into their own copies (helper/import.ts); it starts nothing of the
  // helper's own (no shim, no open.fifo, no tunnel), so it can run next to a running AIB
  Deno.exit(Deno.args[0] === 'import' ? await importMain(Deno.args.slice(1)) : await helperMain(Deno.args));
}
