/**
 * Studio's own agent installs (agent_installer.py): one npm install per agent into <state_dir>/agents/<id>/<version>/
 * (adapters.ts finds the result).
 *
 * The job runs in the agent host process. Everything the page needs to survive a web-server restart is on disk, in the same files
 * and the same JSON as the Python installer, so a Python host and a Deno web server (or the reverse) read each other's job:
 *
 *   <state_dir>/agents/<id>/install.json   the job's state {state, stage, percent, message, version, pid, updatedAt}; written atomically
 *   <state_dir>/agents/<id>/install.lock   exclusive lock file holding {pid, at} of the process that runs the job (one install per agent)
 *   <state_dir>/agents/<id>/install.log    npm's own output of the last run (kept for the failure line, never shown whole)
 *   <state_dir>/agents/<id>/<version>/     the install; `.complete` is written last, and only a folder that has it is ever used
 *
 * What may be installed is the allow-list agent_versions.json (package, exact reviewed version, lockfile). With a lockfile the job runs
 * `npm ci`, otherwise `npm install <package>@<exact>`; both with --ignore-scripts --omit=dev --no-audit --no-fund. npm is started as
 * `node <npm-cli.js>` (never through npm.cmd), so cancel can kill the whole process tree. Before anything is started the job is
 * refused, with one plain line, when it is bound to fail: Node missing or older than 22, too little disk space, or a path too long.
 */
import * as adapters from './adapters.ts';
import { BUILTIN_NAMES } from './agent_registry.ts';
import { APP_ROOT } from '../core/app.ts';
import { writeJsonAtomic } from '../core/fs.ts';
import { clip, isDict, pyJsonDumps, pyStr, ValueError } from '../core/py.ts';
import { pidAlive } from '../host/host_client.ts';
import { diskFree } from '../platform/disk.ts';
import { ProcessTree, treeSpawnOptions } from '../platform/process_tree.ts';
import { isFile } from '../platform/pypath.ts';
import { abspath, pathOf, realpath } from '../state/paths.ts';

export const MIN_NODE_MAJOR = 22; // the adapters' `engines` field
export const MAX_PATH_CHARS = 240; // Windows stops at 260; leave room for the files npm puts inside
export const ALLOW_LIST = pathOf(APP_ROOT, 'agent_versions.json');
export const STATE_NAME = 'install.json';
export const LOCK_NAME = 'install.lock';
export const LOG_NAME = 'install.log';
export const NPM_ARGS = ['--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'];
export const POLL_SECONDS = 0.4;
export const SIZE_EVERY_SECONDS = 1.5;
export const GIB = 1024 ** 3;
export const NODE_CACHE_SECONDS = 30;

const now = () => Date.now() / 1000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function exists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** int() of a stored number (the files are written by Studio itself). */
function toInt(value: unknown): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : 0;
}

// ---- small shared pieces (agent_signin uses them too) ----------------------------------------------------------------

/** A threading.Event: set once, waited on with a timeout. */
export class Flag {
  #set = false;
  #waiters: (() => void)[] = [];
  set(): void {
    this.#set = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }
  isSet(): boolean {
    return this.#set;
  }
  /** True when set (now or within `ms`). Also returns early, with the flag's state, when `also` settles. Leaves no timer behind. */
  wait(ms: number, also?: Promise<unknown>): Promise<boolean> {
    if (this.#set) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.#waiters = this.#waiters.filter((w) => w !== finish);
        resolve(this.#set);
      };
      const timer = setTimeout(finish, ms);
      this.#waiters.push(finish);
      also?.then(finish, finish);
    });
  }
}

/** One caller at a time (the Python RLock around start/status). */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.#tail.then(fn);
    this.#tail = next.catch(() => {});
    return next;
  }
}

export function agentDir(stateDir: string, agentId: string): string {
  return pathOf(adapters.agentsRoot(stateDir), agentId);
}

/** json.dumps(data) written atomically (Python's spacing, so the bytes match a file the Python job wrote). */
export function writeJson(path: string, data: unknown): void {
  writeJsonAtomic(path, null, { text: pyJsonDumps(data), prefix: '.studio-agent-', suffix: '.tmp' });
}

/** The JSON object in a file, or null (missing, unreadable after a few tries, or not an object). */
export function readJson(path: string): Record<string, unknown> | null {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const data = JSON.parse(Deno.readTextFileSync(path));
      return isDict(data) ? data : null;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      sleepSync(50 * (attempt + 1));
    }
  }
  return null;
}

// ---- Node.js check ---------------------------------------------------------------------------------------------------

const nodeCache = new Map<string, [number, string, boolean]>(); // node command -> (checked at, line, node found)

export function clearNodeCache(): void {
  nodeCache.clear();
}

/** Test seam (Python tests mock.patch agent_installer.node_block): replaces nodeBlock when set. Never set in the app. */
export const installerHooks: { nodeBlock?: (nodeCommand: string, force: boolean) => [string, boolean] | Promise<[string, boolean]> } = {};

/**
 * [line, nodeFound]: why installs cannot run on this PC, as one plain grey line ('' when Node.js 22+ is there). Cached for 30 seconds;
 * force (the "Check again" link) asks again.
 */
export async function nodeBlock(
  nodeCommand = '',
  force = false,
  probe?: (node: string) => string | Promise<string>,
  clock?: () => number,
): Promise<[string, boolean]> {
  if (installerHooks.nodeBlock) return await installerHooks.nodeBlock(nodeCommand, force);
  const key = String(nodeCommand || '');
  const at = (clock ?? now)();
  const hit = nodeCache.get(key);
  if (hit && !force && at - hit[0] < NODE_CACHE_SECONDS) return [hit[1], hit[2]];
  const node = adapters.findNode(nodeCommand);
  let result: [string, boolean];
  if (!node) result = [`Node.js ${MIN_NODE_MAJOR} or newer is needed to install this agent.`, false];
  else {
    const version = await (probe ?? nodeVersion)(node);
    const match = /^(\d+)/.exec(version || '');
    if (!match) result = [`Node.js ${MIN_NODE_MAJOR} or newer is needed to install this agent, but Node.js did not start.`, true];
    else if (parseInt(match[1], 10) < MIN_NODE_MAJOR) {
      result = [`Node.js ${MIN_NODE_MAJOR} or newer is needed to install this agent; this PC has Node.js ${version}.`, true];
    } else result = ['', true];
  }
  nodeCache.set(key, [at, result[0], result[1]]);
  return result;
}

/** The install cannot work here (or the request is not allowed). The message is the one plain line the page shows. */
export class InstallRefused extends ValueError {
  override name = 'InstallRefused';
  readonly code = 'install_refused';
}

export interface AllowEntry {
  package: string;
  version: string;
  lockfile?: string;
  packageBytes?: number;
  minFreeBytes?: number;
  [key: string]: unknown;
}

/** {agent id: {package, version, lockfile?, packageBytes, minFreeBytes}} from agent_versions.json. Throws ValueError when unreadable. */
export function loadAllowList(path?: string): Record<string, unknown> {
  let data: unknown;
  try {
    data = JSON.parse(Deno.readTextFileSync(path || ALLOW_LIST));
  } catch (error) {
    throw new ValueError(`The list of installable agents could not be read: ${error instanceof Error ? error.message : error}`);
  }
  const agents = isDict(data) ? data.agents : null;
  if (!isDict(agents)) throw new ValueError('The list of installable agents is not valid.');
  return agents;
}

export const IDLE = { state: 'idle', stage: '', percent: 0, message: '' } as const;

export interface InstallView {
  agent: string;
  state: string;
  stage: string;
  percent: number;
  message: string;
  version?: string;
  interrupted?: boolean;
  attached?: boolean;
}

/**
 * The job's state as the page should see it, read from disk only (the web server calls this; nothing is changed).
 * A job whose process has died is reported as failed.
 */
export function readStatus(stateDir: string, agentId: string): InstallView {
  const saved = readJson(pathOf(agentDir(stateDir, agentId), STATE_NAME));
  if (!saved || !['running', 'failed', 'done'].includes(saved.state as string)) return { ...IDLE, agent: agentId };
  const out: InstallView = {
    agent: agentId,
    state: saved.state as string,
    stage: saved.stage ? pyStr(saved.stage) : '',
    percent: saved.percent ? toInt(saved.percent) : 0,
    message: saved.message ? pyStr(saved.message) : '',
    version: saved.version ? pyStr(saved.version) : '',
  };
  if (out.state === 'running' && !pidAlive(saved.pid)) {
    Object.assign(out, {
      state: 'failed',
      stage: '',
      message: 'The install was interrupted before it finished. Try again.',
      interrupted: true,
    });
  }
  return out;
}

/** npm-cli.js next to a node program (Windows layout, or the macOS / Linux prefix layout). '' when absent. */
export function findNpmCli(node: string): string {
  const real = realpath(node);
  const base = real.slice(0, Math.max(real.lastIndexOf('/'), real.lastIndexOf('\\'))) || real;
  const parent = base.slice(0, Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'))) || base;
  for (
    const candidate of [
      pathOf(base, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
      pathOf(parent, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ]
  ) {
    if (isFile(candidate)) return candidate;
  }
  return '';
}

/** '22.4.0' from `node --version`, or '' when it does not run. */
export async function nodeVersion(node: string, run?: adapters.RunFn): Promise<string> {
  let stdout = '';
  try {
    stdout = run
      ? (await run([node, '--version'], { timeout: 15, env: Deno.env.toObject(), stdin: 'null' })).stdout
      : (await adapters.runCapture([node, '--version'], { timeout: 15 })).stdout;
  } catch {
    return '';
  }
  const match = /v?(\d+\.\d+\.\d+\S*)/.exec(stdout || '');
  return match ? match[1] : '';
}

/** Python's round(): halves go to the even neighbour. */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function sizeText(num: number): string {
  if (num < GIB) return `${Math.max(1, pyRound(num / 1024 ** 2))} MB`;
  // f'{num / GIB:.1f}': num / GIB is exact (GIB is a power of two), and Python rounds an exact half to even
  const scaled = Math.trunc(num) * 10;
  let tenths = Math.floor(scaled / GIB);
  const twice = 2 * (scaled - tenths * GIB);
  if (twice > GIB || (twice === GIB && tenths % 2 === 1)) tenths += 1;
  return `${Math.floor(tenths / 10)}.${tenths % 10} GB`;
}

/** Bytes under a folder (best effort, never throws): the install's progress is measured from it. */
export async function folderBytes(path: string): Promise<number> {
  let total = 0;
  const stack = [path];
  while (stack.length) {
    const folder = stack.pop()!;
    try {
      for await (const entry of Deno.readDir(folder)) {
        const child = pathOf(folder, entry.name);
        try {
          if (entry.isDirectory) stack.push(child);
          else total += (await Deno.lstat(child)).size;
        } catch { /* gone meanwhile */ }
      }
    } catch { /* unreadable */ }
  }
  return total;
}

async function makeWritable(path: string): Promise<void> {
  try {
    await Deno.chmod(path, 0o700);
  } catch { /* not supported or gone */ }
  try {
    if ((await Deno.lstat(path)).isDirectory) {
      for await (const entry of Deno.readDir(path)) await makeWritable(pathOf(path, entry.name));
    }
  } catch { /* gone */ }
}

/** Delete a folder, retrying while Windows still holds files of a process that was just killed. True when it is gone. */
export async function removeTree(path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await Deno.remove(path, { recursive: true });
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return true;
      await makeWritable(path);
    }
    if (!exists(path)) return true;
    await sleep(250 * (attempt + 1));
  }
  return !exists(path);
}

const FAILURES: [RegExp, string][] = [
  [
    /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|network|EPROTO|ESOCKETTIMEDOUT/i,
    'Could not reach the npm registry. Check the internet connection and try again.',
  ],
  [/ENOSPC/i, 'The disk is full.'],
  [/EACCES|EPERM|EBUSY/i, 'AIB could not write to its install folder. Close programs that may be using it and try again.'],
  [/E404|E403/i, 'npm could not find that exact version of the adapter.'],
  [/EINTEGRITY/i, 'npm rejected the download because its checksum did not match.'],
  [/ENOENT.*package-lock|EUSAGE|lock file/i, 'The saved lockfile does not match the package. This is an AIB bug.'],
];
// deno-lint-ignore no-control-regex
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;
const SKIP_PREFIXES = ['A complete log', 'code ', 'path ', 'errno ', 'syscall '];

/** One plain line saying why npm failed, from the tail of its output. */
export function failureLine(logText: string, code: number | string): string {
  const text = logText || '';
  for (const [pattern, line] of FAILURES) if (pattern.test(text)) return line;
  const lines = text.split(LINE_BREAK).filter((l) => /^\s*npm (?:error|ERR!)/.test(l)).map((l) =>
    l.trim().replace(/^npm (?:error|ERR!)\s*/, '')
  )
    .filter((l) => l && !SKIP_PREFIXES.some((p) => l.startsWith(p)));
  if (lines.length) return clip('npm said: ' + lines[0], 160);
  return `npm stopped with exit code ${code}.`;
}

class Job {
  readonly cancelEvent = new Flag();
  tree: ProcessTree | null = null;
  alive = true;
  done: Promise<void> = Promise.resolve();
  percent = 0;
  cancelled = false;
  constructor(readonly agentId: string, readonly version: string, readonly folder: string) {}
}

export interface InstallerOptions {
  nodeCommand?: string;
  allowList?: Record<string, unknown> | null;
  nodeProbe?: (node: string) => string | Promise<string>;
  /** A fixed npm-cli.js (tests use a fake); unset means: look next to node. */
  npmCli?: string | null;
  diskFree?: (path: string) => number;
}

type Outcome = 'done' | 'cancelled' | 'failed';

/** One per process that runs installs (the agent host; the in-process Studio of tests and demos). */
export class Installer {
  readonly stateDir: string;
  readonly nodeCommand: string;
  readonly nodeProbe: (node: string) => string | Promise<string>;
  readonly npmCli: string | null;
  readonly diskFree: (path: string) => number;
  readonly jobs = new Map<string, Job>();
  readonly #allow: Record<string, unknown> | null;
  readonly #guard = new Mutex();

  constructor(stateDir: string, options: InstallerOptions = {}) {
    this.stateDir = pathOf(stateDir);
    this.nodeCommand = options.nodeCommand || '';
    this.#allow = options.allowList ?? null;
    this.nodeProbe = options.nodeProbe ?? ((node) => nodeVersion(node));
    this.npmCli = options.npmCli ?? null;
    this.diskFree = options.diskFree ?? diskFree;
  }

  // ---- what can be installed --------------------------------------------------------------------------------------
  allowList(): Record<string, unknown> {
    return this.#allow !== null ? this.#allow : loadAllowList();
  }

  /** The allow-list entry for an agent id. Only ids that are known agents are looked at, so an id never becomes part of a path. */
  entry(agentId: unknown, verb = ''): AllowEntry {
    const known = typeof agentId === 'string' && Object.prototype.hasOwnProperty.call(adapters.STUDIO_PACKAGES, agentId);
    const found = known ? this.allowList()[agentId as string] : null;
    if (!isDict(found) || !found.package || !found.version) {
      // (Python's wording for an install; an uninstall says what was asked.)
      throw new InstallRefused(verb ? `AIB cannot ${verb} that agent.` : 'AIB cannot install that agent.');
    }
    return found as AllowEntry;
  }

  versionDir(agentId: string, version: string): string {
    return pathOf(agentDir(this.stateDir, agentId), version);
  }

  // ---- checks before anything starts (each refusal is one plain line) -----------------------------------------------
  /** [node, npmCli]. Throws InstallRefused. Nothing has been created or started yet. */
  async preflight(agentId: string, entry: AllowEntry): Promise<[string, string]> {
    const name = BUILTIN_NAMES[agentId] ?? agentId;
    const shown = abspath(this.versionDir(agentId, String(entry.version)));
    const length = [...shown].length;
    if (length > MAX_PATH_CHARS) {
      throw new InstallRefused(
        `The install folder path is ${length} characters long, over the ${MAX_PATH_CHARS} Windows can handle. Start AIB with a shorter --state-dir.`,
      );
    }
    const node = adapters.findNode(this.nodeCommand);
    if (!node) {
      throw new InstallRefused(
        `Node.js ${MIN_NODE_MAJOR} or newer is needed to install ${name}, and Node.js was not found. Install it from nodejs.org and try again.`,
      );
    }
    const version = await this.nodeProbe(node);
    const match = /^(\d+)/.exec(version || '');
    if (!match) throw new InstallRefused(`Node.js ${MIN_NODE_MAJOR} or newer is needed to install ${name}, but Node.js did not start.`);
    if (parseInt(match[1], 10) < MIN_NODE_MAJOR) {
      throw new InstallRefused(
        `Node.js ${MIN_NODE_MAJOR} or newer is needed to install ${name}; this PC has Node.js ${version}. Update Node.js and try again.`,
      );
    }
    const npmCli = this.npmCli || findNpmCli(node);
    if (!npmCli || !isFile(npmCli)) {
      throw new InstallRefused('npm was not found next to Node.js. Reinstall Node.js from nodejs.org and try again.');
    }
    const need = Math.max(2 * toInt(entry.packageBytes || 0), toInt(entry.minFreeBytes || 0));
    let probe = shown;
    for (;;) {
      if (exists(probe)) break;
      const parent = pathOf(probe, '..');
      const up = abspath(parent);
      if (up === probe) break;
      probe = up;
    }
    let free: number | null;
    try {
      free = this.diskFree(probe);
    } catch {
      free = null;
    }
    if (free !== null && need && free < need) {
      throw new InstallRefused(
        `Not enough free disk space for ${name}: it needs about ${sizeText(need)} and this drive has ${sizeText(free)} free.`,
      );
    }
    return [node, npmCli];
  }

  // ---- the three calls ----------------------------------------------------------------------------------------------
  /** The job's state. A job that died with its process (a host restart) is cleaned up and reported as failed. */
  status(agentId: unknown): Promise<InstallView> {
    try {
      this.entry(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = agentId as string;
    return this.#guard.run(async () => {
      const view = readStatus(this.stateDir, id);
      const job = this.jobs.get(id);
      if (view.interrupted && !(job && job.alive)) await this.#finishDead(id, view);
      return view;
    });
  }

  async #finishDead(agentId: string, view: InstallView): Promise<void> {
    const saved = readJson(pathOf(agentDir(this.stateDir, agentId), STATE_NAME)) ?? {};
    if (saved.version) await removeTree(this.versionDir(agentId, pyStr(saved.version)));
    this.save(agentId, 'failed', '', 0, view.message, 'version' in saved ? saved.version : '', Deno.pid);
  }

  /**
   * Start the install, or attach to the one already running. Returns the status (with `attached` true when it was already running).
   * Throws InstallRefused with one plain line when it cannot work.
   */
  start(agentId: unknown): Promise<InstallView> {
    let entry: AllowEntry;
    try {
      entry = this.entry(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
    const id = agentId as string;
    const version = String(entry.version);
    return this.#guard.run(async () => {
      const running = this.jobs.get(id);
      if (running && running.alive) return { ...readStatus(this.stateDir, id), attached: true };
      const folder = this.versionDir(id, version);
      if (isFile(pathOf(folder, adapters.COMPLETE_MARKER))) return this.save(id, 'done', 'done', 100, '', version, Deno.pid);
      const [node, npmCli] = await this.preflight(id, entry);
      if (!this.#takeLock(id)) return { ...readStatus(this.stateDir, id), attached: true }; // another process runs it: join that job
      let status: InstallView;
      try {
        if (exists(folder) && !(await removeTree(folder))) {
          throw new InstallRefused(
            'The folder of an earlier unfinished install could not be removed. Close programs that use it and try again.',
          );
        }
        const job = new Job(id, version, folder);
        this.jobs.set(id, job);
        status = this.save(id, 'running', 'preparing', 2, '', version, Deno.pid);
        job.done = this.#run(job, entry, node, npmCli);
      } catch (error) {
        this.#dropLock(id);
        throw error;
      }
      return { ...status, attached: false };
    });
  }

  /** Kill the install's whole process tree and delete its half-made folder. Returns the status (idle after a cancel). */
  async cancel(agentId: unknown): Promise<InstallView> {
    this.entry(agentId);
    const id = agentId as string;
    const job = this.jobs.get(id);
    if (!job || !job.alive) return await this.status(id);
    job.cancelled = true;
    job.cancelEvent.set();
    job.tree?.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([job.done, new Promise<void>((resolve) => (timer = setTimeout(resolve, 60_000)))]);
    clearTimeout(timer);
    return readStatus(this.stateDir, id);
  }

  /**
   * Remove AIB's own install of an agent: every version folder under <state>/agents/<id>/ (its `.complete` marker first, so a
   * half-removed folder is never used), and the install job, log and sign-in cache that describe it. Nothing outside that folder is
   * touched: an entry that is a link, or that resolves outside it, is left alone, and an install AIB did not make (a global npm
   * package, a launcher in Settings) is never looked at. Refused, with one plain line, while chats with the agent are open
   * (`openChats`, counted by the caller), while its sign-in runs (`signinRunning`), or while an install of it runs.
   * `check`: run every refusal but remove nothing (the page asks first, so a refusal it can know shows before its confirm question).
   * (No Python counterpart: the Python server has no uninstall.)
   */
  uninstall(agentId: unknown, openChats = 0, signinRunning = false, check = false): Promise<InstallView & { removed: string[] }> {
    try {
      this.entry(agentId, 'uninstall');
    } catch (error) {
      return Promise.reject(error);
    }
    const id = agentId as string;
    const name = BUILTIN_NAMES[id] ?? id;
    return this.#guard.run(async () => {
      const job = this.jobs.get(id);
      const holder = (readJson(this.#lockPath(id)) ?? {}).pid;
      if ((job && job.alive) || (holder !== Deno.pid && pidAlive(holder))) {
        throw new InstallRefused(`${name} is being installed right now. Wait for it to finish, or cancel it, then uninstall.`);
      }
      if (openChats > 0) {
        throw new InstallRefused(
          `${name} has ${openChats === 1 ? 'a chat' : `${openChats} chats`} open in AIB. End ${
            openChats === 1 ? "that chat's session" : 'their sessions'
          } first (in the chat list, the chat's menu: End this chat's session; wait for any work to finish), then uninstall.`,
        );
      }
      if (signinRunning) throw new InstallRefused(`A sign-in to ${name} is running. Finish or cancel it, then uninstall.`);
      const base = agentDir(this.stateDir, id);
      const folders: [string, string][] = [];
      try {
        for (const item of Deno.readDirSync(base)) {
          if (!item.isDirectory || item.isSymlink) continue; // a link (or junction) is never followed or removed
          const folder = pathOf(base, item.name);
          let info: Deno.FileInfo;
          try {
            info = Deno.lstatSync(folder);
          } catch {
            continue;
          }
          if (!info.isDirectory || info.isSymlink || !adapters.inside(folder, base)) continue;
          folders.push([item.name, folder]);
        }
      } catch { /* no folder: nothing installed */ }
      if (!folders.length) throw new InstallRefused(`AIB has not installed ${name} itself, so there is nothing to uninstall.`);
      if (check) return { ...IDLE, agent: id, removed: [] };
      const removed: string[] = [];
      for (const [version, folder] of folders) {
        try {
          Deno.removeSync(pathOf(folder, adapters.COMPLETE_MARKER)); // first: from now on this folder is never used
        } catch { /* not complete, or already gone */ }
        if (!(await removeTree(folder))) {
          throw new InstallRefused(
            `${name} ${version} could not be removed completely. Close programs that may be using it and try again.`,
          );
        }
        removed.push(version);
      }
      for (const file of [STATE_NAME, LOG_NAME, 'signin.json', 'signin-job.json']) {
        try {
          Deno.removeSync(pathOf(base, file));
        } catch { /* already gone */ }
      }
      this.#dropLock(id);
      return { ...IDLE, agent: id, removed };
    });
  }

  // ---- the lock file ------------------------------------------------------------------------------------------------
  #lockPath(agentId: string): string {
    return pathOf(agentDir(this.stateDir, agentId), LOCK_NAME);
  }

  /** Create install.lock exclusively with our pid. False when a live process holds it. A lock of a dead process is taken over. */
  #takeLock(agentId: string): boolean {
    const path = this.#lockPath(agentId);
    Deno.mkdirSync(agentDir(this.stateDir, agentId), { recursive: true });
    for (let i = 0; i < 3; i++) {
      let handle: Deno.FsFile;
      try {
        handle = Deno.openSync(path, { write: true, createNew: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
        const holder = (readJson(path) ?? {}).pid;
        const job = this.jobs.get(agentId);
        const mineIdle = holder === Deno.pid && !(job && job.alive);
        if (pidAlive(holder) && !mineIdle) return false;
        try {
          Deno.removeSync(path);
        } catch {
          sleepSync(100);
        }
        continue;
      }
      try {
        handle.writeSync(new TextEncoder().encode(pyJsonDumps({ pid: Deno.pid, at: now() })));
      } finally {
        handle.close();
      }
      return true;
    }
    return false;
  }

  #dropLock(agentId: string): void {
    const path = this.#lockPath(agentId);
    if ((readJson(path) ?? {}).pid === Deno.pid) {
      try {
        Deno.removeSync(path);
      } catch { /* already gone */ }
    }
  }

  // ---- the job ------------------------------------------------------------------------------------------------------
  save(agentId: string, state: string, stage: string, percent: number, message: string, version: unknown, pid: number): InstallView {
    const data = { state, stage, percent: Math.trunc(percent), message, version, pid, updatedAt: now() };
    writeJson(pathOf(agentDir(this.stateDir, agentId), STATE_NAME), data);
    return { agent: agentId, state, stage, percent: Math.trunc(percent), message, version: version as string };
  }

  #progress(job: Job, stage: string, percent: number): void {
    job.percent = Math.max(job.percent, Math.trunc(percent)); // never goes backwards
    this.save(job.agentId, 'running', stage, job.percent, '', job.version, Deno.pid);
  }

  async #run(job: Job, entry: AllowEntry, node: string, npmCli: string): Promise<void> {
    const { agentId, folder } = job;
    let outcome: Outcome = 'failed';
    let message = 'The install stopped unexpectedly.';
    try {
      [outcome, message] = await this.#install(job, entry, node, npmCli);
    } catch (error) { // a job never takes the host down
      console.error(`Installing ${agentId} failed`, error);
      outcome = 'failed';
      message = `The install stopped unexpectedly: ${error instanceof Error ? error.message : error}`;
    } finally {
      try {
        if (outcome === 'cancelled') {
          if (await removeTree(folder)) {
            try {
              Deno.removeSync(pathOf(agentDir(this.stateDir, agentId), STATE_NAME)); // nothing left: the row is back to Install
            } catch { /* already gone */ }
          } else {this.save(
              agentId,
              'failed',
              '',
              0,
              'The cancelled install left a folder that could not be removed.',
              job.version,
              Deno.pid,
            );}
        } else if (outcome === 'failed') {
          await removeTree(folder);
          this.save(agentId, 'failed', '', job.percent, message, job.version, Deno.pid);
        } else this.save(agentId, 'done', 'done', 100, '', job.version, Deno.pid);
      } finally {
        this.#dropLock(agentId);
        job.alive = false;
      }
    }
  }

  async #install(job: Job, entry: AllowEntry, node: string, npmCli: string): Promise<[Outcome, string]> {
    const { agentId, folder, version } = job;
    const pkg = String(entry.package);
    const lockSource = entry.lockfile ? pathOf(APP_ROOT, String(entry.lockfile)) : null;
    const useLock = !!lockSource && isFile(lockSource);
    Deno.mkdirSync(folder, { recursive: true });
    const manifest = { name: `studio-agent-${agentId}`, version: '1.0.0', private: true, dependencies: { [pkg]: version } };
    Deno.writeTextFileSync(pathOf(folder, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    let args: string[];
    if (useLock) {
      Deno.copyFileSync(lockSource!, pathOf(folder, 'package-lock.json'));
      args = [npmCli, 'ci', '--prefix', folder, ...NPM_ARGS];
    } else args = [npmCli, 'install', `${pkg}@${version}`, '--prefix', folder, ...NPM_ARGS];
    if (job.cancelEvent.isSet()) return ['cancelled', ''];
    this.#progress(job, 'downloading', 8);
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(Deno.env.toObject())) {
      if (!['npm_config_prefix', 'npm_config_global', 'npm_config_location'].includes(k.toLowerCase())) env[k] = v;
    }
    Object.assign(env, {
      npm_config_loglevel: 'error',
      npm_config_progress: 'false',
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
    });
    const logFile = pathOf(agentDir(this.stateDir, agentId), LOG_NAME);
    const out = Deno.openSync(logFile, { write: true, create: true, truncate: true });
    let code: number | null = null;
    try {
      const child = new Deno.Command(node, {
        args,
        cwd: folder,
        env,
        clearEnv: true,
        stdin: 'null',
        stdout: 'piped',
        stderr: 'piped',
        ...treeSpawnOptions(),
      }).spawn();
      const pump = async (stream: ReadableStream<Uint8Array>) => {
        try {
          for await (const chunk of stream) {
            let written = 0;
            while (written < chunk.length) written += out.writeSync(chunk.subarray(written));
          }
        } catch { /* the process was killed */ }
      };
      const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
      const exited = child.status.then((s) => (code = s.code));
      job.tree = new ProcessTree(child);
      if (job.cancelEvent.isSet()) job.tree.kill();
      const expected = Math.max(1, toInt(entry.packageBytes || 0));
      let lastSize = 0;
      while (code === null) {
        await job.cancelEvent.wait(POLL_SECONDS * 1000, exited);
        if (job.cancelEvent.isSet()) break;
        if (code !== null) break;
        if (now() - lastSize >= SIZE_EVERY_SECONDS) {
          lastSize = now();
          this.#progress(job, 'downloading', 8 + 80 * Math.min(1.0, (await folderBytes(folder)) / expected));
        }
      }
      // a killed tree is gone quickly; Windows needs a moment before its files can be deleted
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finished = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(false), 20_000))),
      ]);
      clearTimeout(timer);
      if (!finished) job.tree.kill();
      await exited;
      await pumps;
    } finally {
      out.close();
    }
    if (job.cancelEvent.isSet()) return ['cancelled', ''];
    if (code !== 0) {
      let tail = '';
      try {
        const text = new TextDecoder().decode(Deno.readFileSync(logFile));
        const chars = [...text];
        tail = chars.slice(Math.max(0, chars.length - 6000)).join('');
      } catch { /* unreadable */ }
      return ['failed', failureLine(tail, code ?? -1)];
    }
    this.#progress(job, 'verifying', 92);
    const problem = Installer.verify(folder, pkg, version);
    if (problem) return ['failed', problem];
    if (job.cancelled) return ['cancelled', '']; // the marker is written last, and never after a cancel was accepted
    Deno.writeTextFileSync(pathOf(folder, adapters.COMPLETE_MARKER), pyJsonDumps({ package: pkg, version, finishedAt: now() }));
    return ['done', ''];
  }

  /** '' when the installed package is the pinned one and has a usable entry file inside the folder, else one plain line. */
  static verify(folder: string, pkg: string, version: string): string {
    const dir = pathOf(folder, 'node_modules', ...pkg.split('/'));
    const all = [...(adapters.STUDIO_PACKAGES.codex ?? []), ...(adapters.STUDIO_PACKAGES.claude ?? [])];
    const known: adapters.Package = all.find((p) => p[0] === pkg) ?? [pkg, ''];
    let installed: unknown;
    try {
      const data = JSON.parse(Deno.readTextFileSync(pathOf(dir, 'package.json')));
      if (!isDict(data)) throw new Error('not an object');
      installed = data.version ?? null;
    } catch {
      return 'The download finished, but the adapter was not in it.';
    }
    if (installed !== version) {
      return `npm installed version ${installed === null ? 'None' : pyStr(installed)}, not the reviewed version ${version}.`;
    }
    if (!adapters.packageEntry(folder, known)) return "The download finished, but the adapter's start file was not found.";
    return '';
  }
}
