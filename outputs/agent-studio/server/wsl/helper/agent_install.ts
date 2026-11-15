/**
 * AIB's own agent installs inside the distro (phase 2; docs/wsl/design.md section 11, decision 5): agents/installer.ts run natively by
 * the helper, so a WSL install is the Windows one with Linux paths. Each install goes into `<root>/agents/<id>/<version>/` (root:
 * ~/.aib-server, or AIB_WSL_ROOT under test) with `npm ci` from AIB's reviewed lockfile (every package pinned with its integrity hash),
 * --ignore-scripts, and npm's cache in `<root>/agents/.npm-cache`: nothing is written outside AIB's folder, never `npm i -g`.
 * agents.detect then finds it first (adapters.ts findStudioInstall with the same root).
 *
 * What may be installed comes from AIB (its agent_versions.json entry and lockfile text, sent with every call); the helper still only
 * takes a known agent id, one of that agent's own package names, an exact version, and a lockfile that pins that very package and has
 * an integrity hash for every download. The job's state is on disk (install.json, install.lock with the helper's pid), so it outlives
 * AIB and a helper restart reads it back (a job whose helper died reads as interrupted, as on Windows). Each saved state is also sent
 * to AIB as the notification `agents.installProgress`.
 *
 * Node.js and npm must already be in the distro: the helper never installs system packages. `agents.installCheck` says what is
 * missing; it reads the login shell's PATH again first when asked (Check again) or when Node.js was not found, so a Node.js the user
 * just installed in a terminal is seen without restarting anything.
 */
import * as adapters from '../../agents/adapters.ts';
import {
  findNpmCliFor,
  InstallRefused,
  Installer,
  type InstallView,
  LOCK_NAME,
  MIN_NODE_MAJOR,
  nodeVersion,
  readJson,
} from '../../agents/installer.ts';
import { pidAlive } from '../../host/host_client.ts';
import { isDict } from '../../core/py.ts';
import { isFile } from '../../platform/pypath.ts';
import { BAD_PARAMS, type Handlers, RpcError, str } from './rpc.ts';

/** The agents AIB installs into a distro (the built-ins that ship on npm). */
export const WSL_MANAGED = ['claude', 'codex'] as const;
export const MAX_LOCK_BYTES = 2 * 1024 * 1024;
/** How often a missing Node.js makes the helper read the login PATH again by itself (Check again always does). */
export const PATH_RECHECK_MS = 15_000;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface InstallContext {
  /** AIB's folder in the distro (~/.aib-server or AIB_WSL_ROOT): agents go into <root>/agents. */
  root: string;
  /** Sends a notification line to AIB. */
  notify(method: string, params: Record<string, unknown>): void;
  /** Reads the login shell's PATH again (helper_main.ts); absent in tests. */
  refreshPath?(): Promise<void>;
  /** Tests: the node program, its version probe and a fake npm-cli.js. */
  nodeCommand?: string;
  nodeProbe?: (node: string) => string | Promise<string>;
  npmCli?: string;
  diskFree?: (path: string) => number;
  /** Tests: the distro's processes for the uninstall refusal (default: /proc read by sh); null when they cannot be read. */
  processes?: () => Promise<ProcRow[] | null>;
}

/** One process of the distro: its program (/proc/<pid>/exe) and command line (NULs as spaces). */
export interface ProcRow {
  pid: number;
  exe: string;
  cmdline: string;
}

/**
 * Every process of the distro (all users, as far as /proc shows them) with its program and command line. Read by sh: the compiled
 * helper may not read /proc itself (helper/bgtasks.ts distroProcesses says why). null when the list cannot be read.
 */
export async function distroProcRows(): Promise<ProcRow[] | null> {
  try {
    const out = await new Deno.Command('/bin/sh', {
      args: ['-c', 'for p in /proc/[0-9]*; do e=$(readlink "$p/exe" 2>/dev/null); c=$(tr "\\000" " " < "$p/cmdline" 2>/dev/null); printf "%s\\t%s\\t%s\\n" "${p#/proc/}" "$e" "$c"; done; exit 0'],
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
    }).output();
    if (!out.success) return null;
    const rows: ProcRow[] = [];
    for (const line of new TextDecoder().decode(out.stdout).split('\n')) {
      const [pid, exe = '', ...rest] = line.split('\t');
      if (/^\d+$/.test(pid ?? '')) rows.push({ pid: Number(pid), exe, cmdline: rest.join('\t').trim() });
    }
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/** The processes (not this helper) whose program or command line is inside one of `folders`. */
export function procsUsing(rows: ProcRow[], folders: string[], self = Deno.pid): ProcRow[] {
  const prefixes = [...new Set(folders.filter(Boolean).map((f) => f.replace(/\/+$/, '') + '/'))];
  return rows.filter((r) => r.pid !== self && prefixes.some((p) => r.exe.startsWith(p) || r.cmdline.includes(p)));
}

export interface WireEntry {
  package: string;
  version: string;
  packageBytes?: number;
  minFreeBytes?: number;
}

/** {agent, entry, lock} of a call, checked: a known agent, one of its own packages, an exact version, a lockfile that pins it. */
export function checkRequest(p: Record<string, unknown>): { agent: string; entry: WireEntry; lock: string | null } {
  const agent = str(p, 'agent');
  if (!(WSL_MANAGED as readonly string[]).includes(agent)) throw new RpcError('AIB cannot install that agent in WSL.', BAD_PARAMS, { code: 'install_refused' });
  const e = p.entry;
  if (!isDict(e)) throw new RpcError('entry must be an object', BAD_PARAMS);
  const pkg = e.package, version = e.version;
  const names = (adapters.installPackages(agent) ?? []).map((x) => x[0]);
  if (typeof pkg !== 'string' || !names.includes(pkg)) throw new RpcError(`entry.package is not a package of ${agent}`, BAD_PARAMS);
  if (typeof version !== 'string' || !VERSION.test(version)) throw new RpcError('entry.version must be an exact version', BAD_PARAMS);
  const size = (key: string) => {
    const v = e[key];
    if (v === undefined) return 0;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new RpcError(`entry.${key} must be a whole number`, BAD_PARAMS);
    return v;
  };
  const entry: WireEntry = { package: pkg, version, packageBytes: size('packageBytes'), minFreeBytes: size('minFreeBytes') };
  const lock = p.lock === undefined || p.lock === null ? null : str(p, 'lock');
  if (lock !== null) checkLock(lock, pkg, version);
  return { agent, entry, lock };
}

/** Throws unless `text` is an npm lockfile (v2/v3) whose root depends on exactly pkg@version and pins every download by integrity. */
export function checkLock(text: string, pkg: string, version: string): void {
  const bad = (why: string) => new RpcError(`The lockfile AIB sent is not usable: ${why}`, BAD_PARAMS, { code: 'install_refused' });
  if (new TextEncoder().encode(text).length > MAX_LOCK_BYTES) throw bad('too big');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw bad('not JSON');
  }
  if (!isDict(data) || !isDict(data.packages) || Number(data.lockfileVersion) < 2) throw bad('not an npm lockfile (version 2 or 3)');
  const packages = data.packages as Record<string, unknown>;
  const top = packages[''];
  const deps = isDict(top) && isDict(top.dependencies) ? top.dependencies : null;
  if (!deps || deps[pkg] !== version) throw bad(`it does not depend on ${pkg}@${version}`);
  const own = packages[`node_modules/${pkg}`];
  if (!isDict(own) || own.version !== version) throw bad(`it does not pin ${pkg} to ${version}`);
  for (const [path, item] of Object.entries(packages)) {
    if (!path || !isDict(item) || item.link === true || item.resolved === undefined) continue;
    if (typeof item.integrity !== 'string' || !/^sha(512|384|256)-/.test(item.integrity)) throw bad(`${path} has no integrity hash`);
  }
}

/** Why installs cannot run in this distro: {code, node, nodeVersion, npm}; code '' when Node.js 22+ and npm are there. */
export type NodeCode = '' | 'node_missing' | 'node_broken' | 'node_old' | 'npm_missing';

export function installMethods(ctx: InstallContext): Handlers {
  const allow: Record<string, unknown> = {};
  const locks = new Map<string, string | null>();
  const installer = new Installer(ctx.root, {
    nodeCommand: ctx.nodeCommand ?? '',
    allowList: allow,
    ...(ctx.nodeProbe ? { nodeProbe: ctx.nodeProbe } : {}),
    ...(ctx.npmCli ? { npmCli: ctx.npmCli } : {}),
    ...(ctx.diskFree ? { diskFree: ctx.diskFree } : {}),
    readLock: (entry) => locks.get(`${entry.package}@${entry.version}`) ?? null,
    npmEnv: { npm_config_cache: `${ctx.root}/agents/.npm-cache` },
    onSave: (view) => ctx.notify('agents.installProgress', { ...view }),
  });
  let refreshedAt = 0;

  const take = (p: Record<string, unknown>) => {
    const { agent, entry, lock } = checkRequest(p);
    allow[agent] = { ...entry };
    locks.set(`${entry.package}@${entry.version}`, lock);
    return agent;
  };

  const check = async (force: boolean) => {
    const look = async () => {
      const node = adapters.findNode(ctx.nodeCommand ?? '');
      if (!node) return { code: 'node_missing' as NodeCode, node: '', nodeVersion: '', npm: false };
      const version = await (ctx.nodeProbe ?? ((n: string) => nodeVersion(n)))(node);
      const major = /^(\d+)/.exec(version || '');
      const npm = !!(ctx.npmCli ? isFile(ctx.npmCli) : await findNpmCliFor(node));
      const code: NodeCode = !major ? 'node_broken' : parseInt(major[1], 10) < MIN_NODE_MAJOR ? 'node_old' : !npm ? 'npm_missing' : '';
      return { code, node, nodeVersion: version, npm };
    };
    let found = await look();
    const stale = Date.now() - refreshedAt >= PATH_RECHECK_MS;
    if (ctx.refreshPath && (force || (found.code !== '' && stale))) {
      refreshedAt = Date.now();
      await ctx.refreshPath().catch(() => {});
      found = await look();
    }
    return found;
  };

  const refused = (error: unknown): never => {
    if (error instanceof InstallRefused) throw new RpcError(error.message, undefined, { code: 'install_refused' });
    throw error;
  };

  return {
    'agents.installCheck': async (p) => ({ ...await check(p.force === true), minNode: MIN_NODE_MAJOR }),

    'agents.install': async (p) => {
      const agent = take(p);
      const node = await check(false);
      if (node.code) throw new RpcError(`Node.js ${MIN_NODE_MAJOR} or newer and npm are needed`, undefined, { code: node.code });
      return { ...await installer.start(agent).catch(refused) };
    },

    'agents.installStatus': async (p) => ({ ...await installer.status(take(p)).catch(refused) }),

    'agents.installCancel': async (p) => ({ ...await installer.cancel(take(p)).catch(refused) }),

    'agents.uninstall': (p) => uninstall(ctx, installer, allow, str(p, 'id')),
  };
}

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };

/** The version folders AIB installed under `base` (real folders inside it, never a link), as [name, path]. */
function versionFolders(base: string): string[] {
  const out: string[] = [];
  try {
    for (const item of Deno.readDirSync(base)) {
      if (!item.isDirectory || item.isSymlink) continue;
      const folder = `${base}/${item.name}`;
      if (adapters.inside(folder, base)) out.push(folder);
    }
  } catch { /* nothing installed */ }
  return out;
}

/**
 * `agents.uninstall {id}`: removes AIB's own copy of one agent, every <root>/agents/<id>/<version> (installer.ts uninstall does the
 * deleting, marker first). Idempotent: nothing installed is ok with removed []. A refusal is an answer ({ok: false, blocked, message}):
 * 'installing' while an install of it runs (this helper's job or another live process holding install.lock), 'running' while any
 * process of the distro runs from that folder (a chat or sign-in of any AIB data folder: /proc exe and command lines), 'unchecked'
 * when the process list cannot be read. Only known managed agents; <root>/agents/<id> must be a real folder inside the root (no link
 * anywhere on the way), so nothing outside it, the user's own installs, ~/.claude and ~/.codex are never touched.
 */
async function uninstall(ctx: InstallContext, installer: Installer, allow: Record<string, unknown>, id: string) {
  if (!(WSL_MANAGED as readonly string[]).includes(id)) {
    throw new RpcError('AIB cannot uninstall that agent in WSL.', BAD_PARAMS, { code: 'install_refused' });
  }
  const name = AGENT_NAMES[id] ?? id;
  const root = ctx.root.replace(/[\\/]+$/, '');
  const agents = `${root}/agents`;
  const base = `${agents}/${id}`;
  for (const path of [agents, base]) {
    let info: Deno.FileInfo;
    try {
      info = Deno.lstatSync(path);
    } catch {
      return { ok: true, removed: [] as string[] }; // not there: nothing installed
    }
    if (info.isSymlink || !info.isDirectory) {
      return { ok: false, removed: [] as string[], blocked: 'unsafe', message: `${path} is not a plain folder, so AIB leaves it alone.` };
    }
  }
  if (!adapters.inside(base, root) || adapters.inside(root, base)) {
    return { ok: false, removed: [] as string[], blocked: 'unsafe', message: `${base} is not inside AIB's folder, so AIB leaves it alone.` };
  }
  const folders = versionFolders(base);
  if (!folders.length) return { ok: true, removed: [] as string[] };
  const job = installer.jobs.get(id);
  const holder = (readJson(`${base}/${LOCK_NAME}`) ?? {}).pid;
  if ((job && job.alive) || (holder !== Deno.pid && pidAlive(holder))) {
    return {
      ok: false,
      removed: [] as string[],
      blocked: 'installing',
      message: `${name} is being installed right now. Wait for it to finish, or cancel it, then uninstall.`,
    };
  }
  const rows = await (ctx.processes ?? distroProcRows)();
  if (!rows) {
    return {
      ok: false,
      removed: [] as string[],
      blocked: 'unchecked',
      message: `AIB could not check whether ${name} is running, so it did not uninstall it. Try again.`,
    };
  }
  let real = base;
  try {
    real = Deno.realPathSync(base);
  } catch { /* the plain path */ }
  const using = procsUsing(rows, [base, real]);
  if (using.length) {
    const n = using.length;
    return {
      ok: false,
      removed: [] as string[],
      blocked: 'running',
      message: `${name} is running from AIB's copy (${n === 1 ? 'process' : `${n} processes`} ${using.slice(0, 3).map((r) => r.pid).join(', ')}): ` +
        'a chat or a sign-in uses it. End those chats or the sign-in first, then uninstall.',
    };
  }
  // installer.ts uninstall needs an allow-list entry for the id; its version is never used there
  if (!allow[id]) allow[id] = { package: (adapters.installPackages(id) ?? [['']])[0][0], version: '0.0.0' };
  try {
    const done = await installer.uninstall(id);
    return { ok: true, removed: done.removed };
  } catch (error) {
    if (error instanceof InstallRefused) return { ok: false, removed: [] as string[], blocked: 'failed', message: error.message };
    throw error;
  }
}

export type { InstallView };
