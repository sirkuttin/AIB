/**
 * "AIB in <distro>": disk use and Remove AIB from this distro, the helper side (docs/wsl/linking-design.md section 13, the REMOVE
 * RULES; docs/WSL.md "Remove AIB from a distro"). `aib.usage` measures; `aib.remove` 'check' lists and refuses, 'apply' refuses again
 * and deletes. The Windows side (wsl/remove.ts) runs the order around it and the last step.
 *
 * Layout (wsl/install.ts): <root> = ~/.aib-server (AIB_WSL_ROOT under test) holds <ver>/ (the keeper and helper programs), agents/
 * (AIB's agent installs, agents/.npm-cache), helper/ (an old helper's run folder) and one data-<12 hex>/ per Windows AIB data folder.
 * This AIB's own data folder is `--data` (its worktrees/, the worktree registry, keeper/ = the Linux keeper's journals and log,
 * helper/ = this helper's sockets).
 *
 * What is deleted, and the guards (every one is unit-tested in work/deno/wsl_linking_remove_helper_test.ts):
 *   - The root must be a plain absolute path (no `.`, `..`, `//`, trailing `/`) at least two folders deep, named `.aib-server` or
 *     `aib-wsl-test-*`, not on /mnt/<drive>, not the home folder or above it, a real folder (not a link) whose real path is itself.
 *     Under test (AIB_WSL_TEST=1, set by AIB only when it runs under AGENT_STUDIO_TEST) it must also be /tmp/aib-wsl-test-* and never
 *     $HOME/.aib-server. Otherwise nothing is deleted and the reason is a `blocked` line.
 *   - The data folder must be exactly <root>/data-<12 hex>, a real folder.
 *   - Deletion walks the tree itself with Deno's file calls and never follows a link: a link is unlinked as a name inside the root
 *     (its target is never touched), a folder's real path is checked to be itself before its entries are read and again before each
 *     entry goes, nothing outside the root is ever named, nothing on another file system (a mount point) is entered, and every
 *     removal is one name (never a recursive call).
 *   - Only this AIB's data folder is removed (all of it but keeper/ and helper/, which the running keeper and this helper still use:
 *     the Windows side removes those after both have ended). The SHARED parts (agents/ with its npm cache, the <ver>/ folders, an
 *     old helper/) go only when no other data-* folder is there at all (a stopped other AIB build still counts: it would need them
 *     again) and no program outside this AIB runs from them; else they are KEPT and listed with why. The current <ver>/ and the root
 *     itself are left to the Windows side's last step (the root only when empty). Anything AIB does not know in the root is kept.
 *   - Refused (`blocked`) while a chat copy has uncommitted changes (untracked files count) or cannot be checked, a program works in
 *     this data folder (a shell in a chat copy), an agent install runs, or the process list cannot be read. The Windows side adds the
 *     working chats, the keeper's live chats and terminals, and the sign-in and Node.js terminals.
 *   - ~/.claude, ~/.codex, nvm, asdf and project folders are never inside the root, so they are never named; `kept` says so. Chat
 *     branches stay: only `git worktree prune` runs in each project, after its chat copies are gone.
 *
 * Process facts come from /proc read by sh (the compiled helper may not read /proc itself: helper/bgtasks.ts), never a signal.
 */
import * as wt from '../../worktrees/worktrees.ts';
import { LOCK_NAME, readJson } from '../../agents/installer.ts';
import type { AibRemoveResult, AibUsage } from '../contract.ts';
import { BAD_PARAMS, type Handlers, RpcError } from './rpc.ts';

export const DATA_NAME = /^data-[0-9a-f]{12}$/;
/** A <ver> folder (install.ts versionOf: the app version with odd characters as `_`, then 8 hex). */
export const VERSION_NAME = /^\d+\.\d+\.\d+[0-9A-Za-z.+_-]*-[0-9a-f]{8}$/;
export const TEST_ROOT = /^\/tmp\/aib-wsl-test-[A-Za-z0-9_-]+$/;
const ROOT_NAME = /^(\.aib-server|aib-wsl-test-[A-Za-z0-9_-]+)$/;
/** The agents AIB installs (helper/agent_install.ts WSL_MANAGED) and how the page names them. */
const AGENTS: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
/** How long a usage or check walk may take, and how many entries it may look at, before it reports partial sizes. */
export const WALK_MS = 10_000;
export const WALK_ENTRIES = 1_000_000;
const MAX_LEFT = 50;

// ---- the file system (Deno's, or a test's) ---------------------------------------------------------------------------------

export interface FsInfo {
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  size: number;
  /** 512-byte blocks in use (Linux), null when unknown. */
  blocks: number | null;
  /** The device (file system) it is on, null when unknown. */
  dev: number | null;
}

/** The only file calls removal makes: lstat (never follows), realPath, the names in a folder, and removing ONE name. */
export interface RemoveFs {
  lstat(path: string): Promise<FsInfo | null>;
  realPath(path: string): Promise<string | null>;
  readDir(path: string): Promise<string[]>;
  /** One file, link or EMPTY folder; never recursive. A missing name is not an error. */
  remove(path: string): Promise<void>;
}

export const denoFs: RemoveFs = {
  async lstat(path) {
    try {
      const i = await Deno.lstat(path);
      return { isFile: i.isFile, isDirectory: i.isDirectory, isSymlink: i.isSymlink, size: i.size, blocks: i.blocks ?? null, dev: i.dev ?? null };
    } catch {
      return null;
    }
  },
  async realPath(path) {
    try {
      return await Deno.realPath(path);
    } catch {
      return null;
    }
  },
  async readDir(path) {
    const names: string[] = [];
    for await (const entry of Deno.readDir(path)) names.push(entry.name);
    return names;
  },
  async remove(path) {
    try {
      await Deno.remove(path); // recursive: false (the default): one name
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  },
};

// ---- paths (POSIX, pure) -----------------------------------------------------------------------------------------------------

/** An absolute Linux path with no `.`, `..` or empty part and no trailing `/` (never normalised: anything else is refused). */
export function plainAbs(path: unknown): path is string {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/' || path.length > 4096 || /[\0\n\r]/.test(path)) return false;
  return path.slice(1).split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/** `child` is strictly below `parent` (string prefix with a `/`: both are plain). */
export function isBelow(child: string, parent: string): boolean {
  return child.startsWith(parent + '/');
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Why `root` is not a folder AIB may delete in ('' when it may). Pure: the file checks are rootFsProblem. */
export function rootProblem(root: unknown, home: string, test: boolean): string {
  if (!plainAbs(root)) return 'it is not a plain absolute Linux path';
  if (root.split('/').length < 3) return 'it is a top-level folder';
  if (!ROOT_NAME.test(baseOf(root))) return 'it is not named like an AIB folder (.aib-server)';
  if (/^\/mnt\/[A-Za-z](\/|$)/.test(root)) return 'it is on a Windows drive';
  if (home) {
    if (root === home) return 'it is your home folder';
    if (isBelow(home, root)) return 'your home folder is inside it';
  }
  if (test) {
    if (!TEST_ROOT.test(root)) return 'test guard: under test AIB only removes a /tmp/aib-wsl-test-* folder';
    if (home && root === `${home}/.aib-server`) return 'test guard: under test AIB never removes ~/.aib-server';
  }
  return '';
}

/** The file checks of the root: 'gone' when it is not there, else why it is unsafe ('' when it is a real folder at its own path). */
export async function rootFsProblem(fs: RemoveFs, root: string): Promise<string> {
  const info = await fs.lstat(root);
  if (!info) return 'gone';
  if (info.isSymlink) return 'it is a link';
  if (!info.isDirectory) return 'it is not a folder';
  if ((await fs.realPath(root)) !== root) return 'its path goes through a link';
  return '';
}

/** Why `data` is not this AIB's data folder in `root` ('' when it is: exactly <root>/data-<12 hex>, a real folder or not there). */
export async function dataProblem(fs: RemoveFs, root: string, data: unknown): Promise<string> {
  if (!plainAbs(data) || dirOf(data) !== root || !DATA_NAME.test(baseOf(data))) return 'it is not a data-<id> folder directly in the AIB folder';
  const info = await fs.lstat(data);
  if (!info) return '';
  if (info.isSymlink || !info.isDirectory) return 'it is not a plain folder';
  if ((await fs.realPath(data)) !== data) return 'its path goes through a link';
  return '';
}

// ---- removal -------------------------------------------------------------------------------------------------------------------

/**
 * Delete `target` (a file, a link or a whole folder) inside `root`, never following a link and never leaving the root. Returns true
 * when it is gone (or was never there); what could not go is added to `left` as "<path>: <why>".
 */
export async function removeInside(fs: RemoveFs, root: string, target: string, left: string[]): Promise<boolean> {
  if (!plainAbs(root) || !plainAbs(target) || !isBelow(target, root)) {
    note(left, `${target}: it is not inside ${root}, so AIB leaves it`);
    return false;
  }
  const parent = dirOf(target);
  if ((await fs.realPath(parent)) !== parent) {
    if (!(await fs.lstat(target))) return true; // gone, and nothing to remove
    note(left, `${target}: the path to it goes through a link, so AIB leaves it`);
    return false;
  }
  const rootInfo = await fs.lstat(root);
  return await removeNode(fs, root, rootInfo?.dev ?? null, target, left);
}

async function removeNode(fs: RemoveFs, root: string, dev: number | null, path: string, left: string[]): Promise<boolean> {
  if (!isBelow(path, root)) { // never reached (names are checked below); a second line of defence
    note(left, `${path}: not inside ${root}`);
    return false;
  }
  const info = await fs.lstat(path);
  if (!info) return true;
  if (info.isDirectory && !info.isSymlink) {
    if (dev !== null && info.dev !== null && info.dev !== dev) {
      note(left, `${path}: another file system is mounted there, so AIB leaves it`);
      return false;
    }
    if ((await fs.realPath(path)) !== path) {
      note(left, `${path}: it is reached through a link, so AIB leaves it`);
      return false;
    }
    let names: string[];
    try {
      names = await fs.readDir(path);
    } catch (error) {
      note(left, `${path}: ${message(error)}`);
      return false;
    }
    let all = true;
    for (const name of names) {
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
        all = false;
        continue;
      }
      if ((await fs.realPath(path)) !== path) { // it was swapped for a link while its entries went
        note(left, `${path}: it changed into a link, so AIB stopped there`);
        return false;
      }
      if (!(await removeNode(fs, root, dev, `${path}/${name}`, left))) all = false;
    }
    if (!all) return false;
  }
  try {
    await fs.remove(path); // a link: the link itself; a folder: now empty
    return true;
  } catch (error) {
    note(left, `${path}: ${message(error)}`);
    return false;
  }
}

function note(left: string[], line: string): void {
  if (left.length < MAX_LEFT) left.push(line);
  else if (left.length === MAX_LEFT) left.push('(and more)');
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- sizes ---------------------------------------------------------------------------------------------------------------------

/** One walk's limits: a deadline and an entry count. `cut` once either ran out (the sizes are then lower bounds). */
export class Budget {
  cut = false;
  #entries: number;
  readonly #until: number;
  constructor(ms = WALK_MS, entries = WALK_ENTRIES, now: () => number = Date.now) {
    this.#until = now() + ms;
    this.#entries = entries;
    this.now = now;
  }
  readonly now: () => number;
  spend(): boolean {
    if (this.cut) return false;
    if (--this.#entries < 0 || this.now() > this.#until) this.cut = true;
    return !this.cut;
  }
}

/** Disk use of `path` like `du -s`: never follows a link, never crosses into another file system, stops when the budget is spent. */
export async function sizeOf(fs: RemoveFs, path: string, budget: Budget, dev: number | null = null): Promise<number> {
  if (!budget.spend()) return 0;
  const info = await fs.lstat(path);
  if (!info) return 0;
  const own = info.blocks !== null ? info.blocks * 512 : info.size;
  if (!info.isDirectory || info.isSymlink) return own;
  if (dev !== null && info.dev !== null && info.dev !== dev) return 0;
  let names: string[];
  try {
    names = await fs.readDir(path);
  } catch {
    return own;
  }
  let total = own;
  for (const name of names) {
    if (budget.cut) break;
    total += await sizeOf(fs, `${path}/${name}`, budget, info.dev ?? dev);
  }
  return total;
}

// ---- processes -----------------------------------------------------------------------------------------------------------------

/** One process of the distro: its program, folder and arguments (as far as /proc shows them to this user). */
export interface ProcRow {
  pid: number;
  exe: string;
  cwd: string;
  args: string[];
}

const PROC_SCRIPT = 'for p in /proc/[0-9]*; do e=$(readlink "$p/exe" 2>/dev/null); w=$(readlink "$p/cwd" 2>/dev/null); ' +
  'c=$(tr "\\000" "\\001" < "$p/cmdline" 2>/dev/null); printf "%s\\t%s\\t%s\\t%s\\n" "${p#/proc/}" "$e" "$w" "$c"; done; exit 0';

/** Every process of the distro, read by sh from /proc (no signal is ever sent); null when the list cannot be read. */
export async function procRows(): Promise<ProcRow[] | null> {
  try {
    const out = await new Deno.Command('/bin/sh', { args: ['-c', PROC_SCRIPT], stdin: 'null', stdout: 'piped', stderr: 'null' }).output();
    if (!out.success) return null;
    const rows = parseProcRows(new TextDecoder().decode(out.stdout));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

export function parseProcRows(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    const [pid, exe = '', cwd = '', ...rest] = line.split('\t');
    if (!/^\d+$/.test(pid ?? '')) continue;
    rows.push({ pid: Number(pid), exe, cwd, args: rest.join('\t').split('\x01').filter(Boolean) });
  }
  return rows;
}

/**
 * This AIB's own processes in the distro, which end with its keeper: this helper, the keeper, the bridges and this helper (all started
 * with `--data <data>`), and the MCP relay (`--socket <data>/helper/mcp.sock`). An agent or shell working in a chat copy is not.
 */
export function isOurs(row: ProcRow, data: string, self: number): boolean {
  if (row.pid === self) return true;
  return row.args.some((a, i) => (a === data && row.args[i - 1] === '--data') || (a === `${data}/helper/mcp.sock` && row.args[i - 1] === '--socket'));
}

/** Does the process run from, work in, or name a path inside `dir`? */
export function uses(row: ProcRow, dir: string): boolean {
  const inside = (p: string) => p === dir || p.startsWith(dir + '/');
  return inside(row.exe) || inside(row.cwd) || row.args.some((a) => inside(a) || a.includes(dir + '/'));
}

function describe(rows: ProcRow[]): string {
  const shown = rows.slice(0, 3).map((r) => `${r.pid} ${(r.args[0] ?? r.exe).split('/').pop() || '?'}`).join(', ');
  return rows.length === 1 ? `process ${shown}` : `${rows.length} processes: ${shown}${rows.length > 3 ? ', …' : ''}`;
}

// ---- the plan ------------------------------------------------------------------------------------------------------------------

export interface RemoveDeps {
  fs: RemoveFs;
  /** AIB's folder in the distro and this AIB's data folder in it (helper_main: AIB_WSL_ROOT / --data). */
  root: string;
  data: string;
  /** This AIB's <ver> ('' when unknown: then no <ver> folder is the current one). */
  version: string;
  /** The distro user's home folder. */
  home: string;
  /** AIB runs under test (AIB_WSL_TEST=1): the test guard is on. */
  test: boolean;
  /** This helper's pid. */
  self: number;
  procs(): Promise<ProcRow[] | null>;
  /** Is the keeper of a data folder running (its keeper.sock answers a connect)? */
  keeperAlive(dataDir: string): Promise<boolean>;
  /** Uncommitted changes in a chat copy (untracked files count); null when git cannot tell. */
  dirty(path: string): Promise<boolean | null>;
  /** `git worktree prune` in a project; false when it failed. */
  prune(project: string): Promise<boolean>;
  /** The chat copies of this data folder (the worktree registry): their folder and project. */
  worktrees(): { path: string; project: string; branch?: string; session?: string }[];
  /** The walk's limits (tests). */
  budget?: () => Budget;
}

interface Part {
  path: string;
  what: string;
  /** Deleted by the helper (false: the current <ver>, left to the Windows side's last step). */
  now: boolean;
}

interface Plan {
  gone: boolean;
  blocked: string[];
  wouldRemove: { path: string; what: string; bytes: number }[];
  kept: { path: string; why: string }[];
  /** The shared parts the helper deletes now. */
  shared: Part[];
  copies: { path: string; project: string; branch?: string; session?: string }[];
  finalVersion: string | null;
  rootMayGo: boolean;
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Everything Remove would do and every reason it cannot (nothing is deleted here). */
export async function planRemoval(d: RemoveDeps): Promise<Plan> {
  const plan: Plan = { gone: false, blocked: [], wouldRemove: [], kept: [], shared: [], copies: [], finalVersion: null, rootMayGo: false };
  const { fs, root, data } = d;
  const pure = rootProblem(root, d.home, d.test);
  if (pure) {
    plan.blocked.push(`AIB will not delete ${String(root)}: ${pure}.`);
    return plan;
  }
  const onDisk = await rootFsProblem(fs, root);
  if (onDisk === 'gone') {
    plan.gone = true;
    return plan;
  }
  if (onDisk) {
    plan.blocked.push(`AIB will not delete ${root}: ${onDisk}.`);
    return plan;
  }
  const dataWhy = await dataProblem(fs, root, data);
  if (dataWhy) {
    plan.blocked.push(`AIB will not delete its data folder ${String(data)}: ${dataWhy}.`);
    return plan;
  }
  const budget = d.budget?.() ?? new Budget();
  const procs = await d.procs();
  if (!procs) plan.blocked.push('AIB could not list the programs running in this distro, so it deletes nothing. Try again.');
  const rows = procs ?? [];
  const others = (dir: string) => rows.filter((r) => !isOurs(r, data, d.self) && uses(r, dir));

  // this AIB's chat copies: refused while one has uncommitted work or cannot be checked
  const worktreeRoot = `${data}/worktrees`;
  const copies = d.worktrees().filter((c) => plainAbs(c.path) && isBelow(c.path, worktreeRoot));
  plan.copies = copies;
  for (const copy of copies) {
    const info = await fs.lstat(copy.path);
    if (!info || !info.isDirectory || info.isSymlink) continue;
    const dirty = await d.dirty(copy.path);
    if (dirty === true) {
      plan.blocked.push(
        `The chat copy ${copy.path} has changes that are not committed (new files count too). Commit them in that chat or discard them, then remove.`,
      );
    } else if (dirty === null) {
      plan.blocked.push(`AIB could not check the chat copy ${copy.path} for changes (is its project ${copy.project} still there?), so it deletes nothing.`);
    }
  }
  const inData = others(data);
  if (inData.length) plan.blocked.push(`A program works in this AIB's data folder (${describe(inData)}). End it, then remove.`);
  for (const [id, name] of Object.entries(AGENTS)) {
    const pid = (readJson(`${root}/agents/${id}/${LOCK_NAME}`) ?? {}).pid;
    if (typeof pid === 'number' && pid !== d.self && rows.some((r) => r.pid === pid)) {
      plan.blocked.push(`${name} is being installed in this distro right now. Wait for it to finish, or cancel it, then remove.`);
    }
  }

  // what is in the root
  let names: string[] = [];
  try {
    names = (await fs.readDir(root)).sort();
  } catch (error) {
    plan.blocked.push(`AIB could not read ${root} (${message(error)}).`);
    return plan;
  }
  const otherData: { path: string; alive: boolean }[] = [];
  const sharedCandidates: Part[] = [];
  let unknown = 0;
  for (const name of names) {
    const path = `${root}/${name}`;
    const info = await fs.lstat(path);
    if (!info) continue;
    const plainDir = info.isDirectory && !info.isSymlink;
    if (path === data) continue;
    if (DATA_NAME.test(name) && plainDir) {
      otherData.push({ path, alive: await d.keeperAlive(path) });
    } else if (name === 'agents' && plainDir) {
      sharedCandidates.push({ path, what: 'installed agents and their npm cache (shared by every AIB on this PC)', now: true });
    } else if (VERSION_NAME.test(name) && plainDir) {
      const current = name === d.version;
      sharedCandidates.push({ path, what: `AIB helper and keeper ${name}${current ? ' (this AIB)' : ''}`, now: !current });
    } else if (name === 'helper' && plainDir) {
      sharedCandidates.push({ path, what: "an older AIB helper's files", now: true });
    } else {
      unknown++;
      plan.kept.push({ path, why: info.isSymlink ? 'it is a link AIB did not make; AIB never follows links' : 'AIB did not make it, so it leaves it' });
    }
  }
  for (const other of otherData) {
    plan.kept.push({ path: other.path, why: other.alive ? 'another AIB on this PC uses it (its keeper is running)' : 'it belongs to another AIB on this PC' });
  }
  const sharedBlock = otherData.some((o) => o.alive)
    ? 'another AIB on this PC uses it (its keeper is running)'
    : otherData.length
    ? 'another AIB data folder is here, and that AIB needs it'
    : '';
  let sharedKept = unknown > 0;
  for (const part of sharedCandidates) {
    const users = others(part.path);
    const why = sharedBlock || (users.length ? `a program runs from it (${describe(users)})` : '');
    if (why) {
      sharedKept = true;
      plan.kept.push({ path: part.path, why });
      continue;
    }
    plan.wouldRemove.push({ path: part.path, what: part.what, bytes: await sizeOf(fs, part.path, budget) });
    if (part.now) plan.shared.push(part);
    else plan.finalVersion = baseOf(part.path);
  }

  // this AIB's own data folder: first, so the confirm dialog lists it first
  const own: { path: string; what: string; bytes: number }[] = [];
  const wtBytes = (await fs.lstat(worktreeRoot)) ? await sizeOf(fs, worktreeRoot, budget) : 0;
  if (copies.length || wtBytes) {
    own.push({
      path: worktreeRoot,
      what: `chat copies (${plural(copies.length, 'worktree')}; committed work stays on each chat's studio/ branch in its project)`,
      bytes: wtBytes,
    });
  }
  if (await fs.lstat(data)) {
    own.push({
      path: data,
      what: "this AIB's data folder: the keeper's chat records and log, the helper's files",
      bytes: Math.max(0, (await sizeOf(fs, data, budget)) - wtBytes),
    });
  }
  plan.wouldRemove.unshift(...own);
  plan.rootMayGo = !sharedKept && otherData.length === 0;
  if (plan.rootMayGo) plan.wouldRemove.push({ path: root, what: "AIB's folder itself (empty by then)", bytes: 0 });
  else plan.kept.push({ path: root, why: 'something in it stays' });

  // never inside the root, so never touched: said for the confirm dialog
  if (d.home) {
    plan.kept.push({ path: `${d.home}/.claude`, why: "Claude Code's own settings and sign-in: AIB never touches them" });
    plan.kept.push({ path: `${d.home}/.codex`, why: "Codex's own settings and sign-in: AIB never touches them" });
  }
  for (const project of [...new Set(copies.map((c) => c.project))].filter(plainAbs).sort()) {
    plan.kept.push({ path: project, why: 'your project, its files and its branches stay as they are' });
  }
  if (budget.cut) {
    for (const item of plan.wouldRemove) if (item.bytes) item.what += ' (at least this size: measuring took too long)';
  }
  return plan;
}

/** `aib.remove` 'check' and 'apply'. */
export async function aibRemove(d: RemoveDeps, mode: 'check' | 'apply'): Promise<AibRemoveResult> {
  const plan = await planRemoval(d);
  const base = { mode, blocked: plan.blocked, wouldRemove: plan.wouldRemove, kept: plan.kept, removed: [] as string[], left: [] as string[] };
  if (plan.gone) return { ...base, ok: true, message: `${d.root} is not there: nothing to remove.` };
  if (plan.blocked.length) return { ...base, ok: false };
  if (mode === 'check') return { ...base, ok: true };
  const { fs, root, data } = d;
  const removed: string[] = [], left: string[] = [];
  const del = async (path: string) => {
    if (!(await fs.lstat(path))) return;
    if (await removeInside(fs, root, path, left)) removed.push(path);
  };
  // 1. the chat copies, then `git worktree prune` in their projects (their branches stay)
  await del(`${data}/worktrees`);
  const notes: string[] = [];
  for (const project of [...new Set(plan.copies.map((c) => c.project))].filter(plainAbs)) {
    const info = await fs.lstat(project);
    if (!info?.isDirectory) continue;
    if (!(await d.prune(project))) notes.push(`git worktree prune did not finish in ${project}; run it there yourself.`);
  }
  // 2. the rest of this AIB's data folder but keeper/ and helper/ (the running keeper and this helper use them)
  let entries: string[] = [];
  try {
    entries = (await fs.readDir(data)).sort();
  } catch { /* already gone */ }
  for (const name of entries) if (name !== 'keeper' && name !== 'helper' && name !== 'worktrees') await del(`${data}/${name}`);
  // 3. the shared parts nothing else uses (the current <ver> is the last step's)
  for (const part of plan.shared) await del(part.path);
  return {
    ...base,
    ok: left.length === 0,
    removed,
    left,
    final: {
      data: baseOf(data),
      version: plan.finalVersion,
      root: plan.rootMayGo && left.length === 0,
      copies: plan.copies.map((c) => ({ path: c.path, project: c.project, branch: c.branch ?? '', session: c.session ?? '' })),
    },
    ...(notes.length || left.length ? { message: [...(left.length ? ['Some files could not be deleted.'] : []), ...notes].join(' ') } : {}),
  };
}

// ---- usage ---------------------------------------------------------------------------------------------------------------------

/** `aib.usage`: disk use by part, the other data folders and whether their keeper runs, versions, agents, chat copies. Read-only. */
export async function aibUsage(d: RemoveDeps): Promise<AibUsage> {
  const { fs, root, data } = d;
  const budget = d.budget?.() ?? new Budget();
  const usage: AibUsage = {
    root,
    totalBytes: 0,
    current: d.version,
    parts: [],
    versions: [],
    agents: [],
    dataFolders: [],
    worktrees: { count: 0, dirty: 0 },
    chatsWorking: 0,
  };
  if (!plainAbs(root) || (await rootFsProblem(fs, root))) return usage;
  let names: string[] = [];
  try {
    names = (await fs.readDir(root)).sort();
  } catch {
    return usage;
  }
  const sum = { versions: 0, agents: 0, npmCache: 0, data: 0, worktrees: 0, logs: 0, other: 0 };
  for (const name of names) {
    const path = `${root}/${name}`;
    const info = await fs.lstat(path);
    if (!info) continue;
    const plainDir = info.isDirectory && !info.isSymlink;
    if (path === data && plainDir) {
      const all = await sizeOf(fs, path, budget);
      sum.worktrees = (await fs.lstat(`${path}/worktrees`)) ? await sizeOf(fs, `${path}/worktrees`, budget) : 0;
      sum.logs = (await fs.lstat(`${path}/keeper`)) ? await sizeOf(fs, `${path}/keeper`, budget) : 0;
      sum.data = Math.max(0, all - sum.worktrees - sum.logs);
      usage.dataFolders.push({ name, mine: true, keeperAlive: await d.keeperAlive(path), bytes: all });
    } else if (DATA_NAME.test(name) && plainDir) {
      const bytes = await sizeOf(fs, path, budget);
      sum.other += bytes;
      usage.dataFolders.push({ name, mine: false, keeperAlive: await d.keeperAlive(path), bytes });
    } else if (name === 'agents' && plainDir) {
      const cache = `${path}/.npm-cache`;
      sum.npmCache = (await fs.lstat(cache)) ? await sizeOf(fs, cache, budget) : 0;
      sum.agents = Math.max(0, (await sizeOf(fs, path, budget)) - sum.npmCache);
      for (const id of (await fs.readDir(path).catch(() => [] as string[])).sort()) {
        const dir = `${path}/${id}`;
        const at = await fs.lstat(dir);
        if (id.startsWith('.') || !at?.isDirectory || at.isSymlink) continue;
        const versions: string[] = [];
        for (const v of (await fs.readDir(dir).catch(() => [] as string[])).sort()) {
          const vi = await fs.lstat(`${dir}/${v}`);
          if (vi?.isDirectory && !vi.isSymlink && !v.startsWith('.')) versions.push(v);
        }
        usage.agents.push({ id, versions, bytes: await sizeOf(fs, dir, budget) });
      }
    } else if (VERSION_NAME.test(name) && plainDir) {
      usage.versions.push(name);
      sum.versions += await sizeOf(fs, path, budget);
    } else {
      sum.other += await sizeOf(fs, path, budget);
    }
  }
  const worktreeRoot = `${data}/worktrees`;
  for (const copy of d.worktrees()) {
    if (!plainAbs(copy.path) || !isBelow(copy.path, worktreeRoot)) continue;
    const info = await fs.lstat(copy.path);
    if (!info?.isDirectory || info.isSymlink) continue;
    usage.worktrees.count++;
    if ((await d.dirty(copy.path)) !== false) usage.worktrees.dirty++; // one that cannot be checked counts as changed
  }
  const parts: [AibUsage['parts'][number]['key'], string, string][] = [
    ['versions', 'AIB helper and keeper', root],
    ['agents', 'Installed agents', `${root}/agents`],
    ['npmCache', 'npm cache', `${root}/agents/.npm-cache`],
    ['data', "This AIB's data", data],
    ['worktrees', 'Chat copies (worktrees)', worktreeRoot],
    ['logs', 'Chat records and logs', `${data}/keeper`],
    ['other', 'Other AIB data folders and files', root],
  ];
  usage.parts = parts.map(([key, label, path]) => ({ key, label, bytes: sum[key], path }));
  usage.totalBytes = Object.values(sum).reduce((a, b) => a + b, 0);
  if (budget.cut) usage.partial = true;
  return usage;
}

// ---- the helper methods ----------------------------------------------------------------------------------------------------

/** Is a keeper listening on <dataDir>/keeper/keeper.sock? A connect, closed at once (no hello, no signal). */
export async function keeperListening(dataDir: string, timeoutMs = 1500): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const conn = await Promise.race([
      Deno.connect({ transport: 'unix', path: `${dataDir}/keeper/keeper.sock` }),
      new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('timeout')), timeoutMs))),
    ]);
    conn.close();
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** git status --porcelain (untracked files included, ignored ones not): true when anything is listed, null when git failed. */
export async function gitDirty(path: string): Promise<boolean | null> {
  const done = await wt.git(['status', '--porcelain', '--untracked-files=all'], path, { check: false, timeout: 120 });
  if (done.returncode !== 0) return null;
  return done.stdout.trim() !== '';
}

export async function gitPrune(project: string): Promise<boolean> {
  return (await wt.git(['worktree', 'prune'], project, { check: false, timeout: 120 })).returncode === 0;
}

export interface AibContext {
  root: string;
  data: string;
  env(): Promise<{ home: string; env: Record<string, string> }>;
  /** Tests: everything else (RemoveDeps). */
  deps?: Partial<RemoveDeps>;
}

/** `aib.usage` and `aib.remove` over this helper's root and data folder. */
export function aibMethods(ctx: AibContext): Handlers {
  const deps = async (): Promise<RemoveDeps> => {
    const login = await ctx.env();
    const version = Deno.env.get('AIB_WSL_VERSION') ?? '';
    return {
      fs: denoFs,
      root: ctx.root,
      data: ctx.data,
      version: VERSION_NAME.test(version) ? version : '',
      home: login.home || login.env.HOME || '',
      test: Deno.env.get('AIB_WSL_TEST') === '1',
      self: Deno.pid,
      procs: procRows,
      keeperAlive: (dir) => keeperListening(dir),
      dirty: gitDirty,
      prune: gitPrune,
      worktrees: () => {
        try {
          return Object.values(new wt.Registry(ctx.data).all()).map((r) => ({
            path: String(r.path ?? ''),
            project: String(r.project ?? ''),
            branch: String(r.branch ?? ''),
            session: String(r.session ?? ''),
          }));
        } catch {
          return [];
        }
      },
      ...ctx.deps,
    };
  };
  return {
    'aib.usage': async () => ({ ...await aibUsage(await deps()) }),
    'aib.remove': async (p) => {
      if (p.mode !== 'check' && p.mode !== 'apply') throw new RpcError("mode must be 'check' or 'apply'", BAD_PARAMS);
      return { ...await aibRemove(await deps(), p.mode) };
    },
  };
}
