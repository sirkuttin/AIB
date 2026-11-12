/**
 * Worktree per chat, stage E: Merge (worktree_merge.py). Lands a worktree chat's own commits on the project's main branch.
 *
 * Runs in the web process over a small MergeStudio (state folder, liveState, liveCall): the chat's state and the conflict prompt go
 * through liveState / liveCall, every git step is run here. The registry record (worktrees.ts) says which worktree, branch, base
 * branch, snapshot S and diffBase belong to the chat.
 *
 * The target is the project's main branch (main, else master, else the branch the chat started from): `chat.base`.
 *
 *   1. refuse while the chat is busy, has queued messages, running terminals, or subagents that work inside its worktree
 *   2. commit what is uncommitted in the worktree ("Studio: work from chat <title>")
 *   3. base moved past the branch: `git merge <base>` in the worktree; conflicts go to the chat as a prompt, and Studio checks the
 *      answer itself (no unmerged entries, no conflict markers in the files that conflicted, base is an ancestor of HEAD)
 *   4. under one lock per repository: re-read base's tip (moved: back to 3), refuse on index.lock or a merge/rebase in the folder
 *      that has base checked out; the user's uncommitted edits there are stashed (by SHA, never popped) and re-applied after
 *   5. land only the chat's changes: while U is still S the chat's commits are replayed; once live sync moved U past S,
 *      `git merge-tree --merge-base=U <base tip> <chat HEAD>` lands exactly what the chat changed since U. Then fast-forward base
 *   6. the worktree is reset to a new U: the new tip plus whatever the user has unsaved in the project folder; the chat goes on
 *   The project's "sync paused" flag is held from stash to unstash (and the reset), the chat's worktree lock for the whole merge.
 *
 * The read-mostly helpers of worktree_sync.py that Merge calls (settle_conflicts, clash_line, open_clashes, paused_status) live with
 * the live sync in sync.ts and are re-exported at the end of this file.
 */
import { docRows } from '../docs/rows.ts';
import * as wt from './worktrees.ts';
import { GitError, type WorktreeRecord } from './worktrees.ts';
import { isdir, join, normcase } from '../platform/ospath.ts';
import { pathStr } from '../platform/pypath.ts';
import { pathOf, realpath } from '../state/paths.ts';
import { entriesOf, readJsonFile, saveJson } from '../state/json.ts';
import { clip, isDict, PY_SPACE, pyStr, pyStrip, pyTruthy } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { clashLine, openClashes, pausedStatus, settleConflicts } from './sync.ts';
import * as mr from './merge_request.ts';

const log = getLogger('worktree_merge');

export const MAX_ROUNDS = 6;
/** Seconds to wait for another process's lock on the chat's worktree or the project's sync flag (tests lower it). */
export const settings = { LOCK_WAIT: 30 };
export const WAITING = 'Waiting for the chat to resolve conflicts';
export const NOTE_OP = 'worktree-note'; // internal Studio call (not a page route): posts the "Merged into ..." line in the chat
/** Python: re.compile(r'^(?:<{7}|>{7})(?: |\r?$)', re.M). JS's multiline ^/$ also break at \r and U+2028/9, so lines are spelled out. */
export const MARKER = /(?:^|\n)(?:<{7}|>{7})(?: |\r?(?=\n|$))/;
export const GIT_STATES = wt.GIT_STATES;
/** Tests only: name -> function, run at fixed points ('before_lock', 'before_ff'). */
export const HOOKS: Record<string, () => unknown> = {};

const RUNNING = new Set<string>(); // chat keys with a merge running in this process

/** How many merges run in this process now (quitting AIB waits in the tray for them: a cut-off merge would leave a half-done repo). */
export function mergesRunning(): number {
  return RUNNING.size;
}

/** What Merge needs from the server: the state folder, a chat's live state, and the live ops (prompt, worktree-note). */
export interface MergeStudio {
  stateDir: string;
  liveState(chatId: string): unknown;
  liveCall(op: string, payload: Record<string, unknown>): [number, unknown] | Promise<[number, unknown]>;
}

/** The merge did not happen; message is the one line to show. `code` is a short machine word. */
export class Refused extends Error {
  override name = 'Refused';
  /** `extra`: more fields for the reply (the tool's target branch). */
  constructor(message: string, readonly code = 'refused', readonly status = 409, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

async function hook(name: string): Promise<void> {
  const fn = HOOKS[name];
  if (fn) await fn();
}

/** One in-process lock per repository (threading.Lock per realpath). */
class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
const LOCKS = new Map<string, Mutex>();

export function repoLock(project: string): Mutex {
  const key = normcase(realpath(String(project)));
  let lock = LOCKS.get(key);
  if (!lock) LOCKS.set(key, lock = new Mutex());
  return lock;
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strip = pyStrip;
const nul = (text: string) => text.split('\0').filter((n) => n);
const git = (args: string[], cwd: string, options?: wt.GitOptions) => wt.git(args, cwd, options);

// ---- git helpers -------------------------------------------------------------------------------------------------
async function configured(cwd: string): Promise<boolean> {
  for (const name of ['user.name', 'user.email']) {
    if (!strip((await git(['config', '--get', name], cwd, { check: false })).stdout)) return false;
  }
  return true;
}

/** git that may commit: Studio's own identity only when the user has none configured. */
export async function gitc(args: string[], cwd: string, options: wt.GitOptions = {}): Promise<wt.GitResult> {
  return git(args, cwd, { ...options, identity: !(await configured(cwd)) });
}

export async function rev(cwd: string, name: string): Promise<string> {
  const done = await git(['rev-parse', '--verify', '-q', name + '^{commit}'], cwd, { check: false });
  return done.returncode === 0 ? strip(done.stdout) : '';
}

export async function isAncestor(cwd: string, older: string, newer: string): Promise<boolean> {
  return (await git(['merge-base', '--is-ancestor', older, newer], cwd, { check: false })).returncode === 0;
}

export async function gitDir(cwd: string): Promise<string> {
  return pathStr(strip((await git(['rev-parse', '--absolute-git-dir'], cwd)).stdout));
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function mergeInProgress(cwd: string): Promise<boolean> {
  return exists(pathOf(await gitDir(cwd), 'MERGE_HEAD'));
}

/** '' or why git work in this folder must wait (a lock file, a merge or rebase in progress). */
export async function folderState(cwd: string): Promise<string> {
  const gd = await gitDir(cwd);
  if (exists(pathOf(gd, 'index.lock'))) {
    return 'git is busy in the folder that has the base branch (index.lock exists)';
  }
  for (const [name, label] of GIT_STATES) {
    if (exists(pathOf(gd, name))) {
      return `${label} is in progress in the folder that has the base branch`;
    }
  }
  return '';
}

/** Paths git status lists in `cwd` (changed, staged and untracked; both names of a rename). */
export async function porcelainPaths(cwd: string): Promise<Set<string>> {
  const parts = (await git(['status', '--porcelain=v1', '-z', '-uall'], cwd))
    .stdout.split('\0');
  const names = new Set<string>();
  let index = 0;
  while (index < parts.length) {
    const entry = parts[index];
    index++;
    if (entry.length < 4) continue;
    names.add(entry.slice(3));
    if ('RC'.includes(entry[0]) || 'RC'.includes(entry[1])) {
      if (index < parts.length && parts[index]) names.add(parts[index]);
      index++;
    }
  }
  return names;
}

export type RawEntry = [string, string, string]; // new mode, new sha, status letter

/** {path: [new mode, new sha, status]} between two commits, no rename detection. */
export async function rawDiff(cwd: string, a: string, b: string): Promise<Map<string, RawEntry>> {
  const parts = (await git(['diff-tree', '-r', '--raw', '--no-abbrev', '-z', '--no-renames', a, b], cwd)).stdout.split('\0');
  const out = new Map<string, RawEntry>();
  let index = 0;
  while (index + 1 < parts.length) {
    const meta = parts[index];
    if (!meta.startsWith(':')) {
      index++;
      continue;
    }
    const fields = meta.slice(1).split(' ');
    out.set(parts[index + 1], [fields[1], fields[3], fields[4].slice(0, 1)]);
    index += 2;
  }
  return out;
}

/** What the chat adds on top of `tip`: files whose content at `head` differs from both the snapshot S and `tip`. */
export async function landingFiles(folder: string, snapshot: string, head: string, tip: string): Promise<Map<string, RawEntry>> {
  const fromSnapshot = await rawDiff(folder, snapshot, head);
  const fromTip = await rawDiff(folder, tip, head);
  const out = new Map<string, RawEntry>();
  for (const path of fromSnapshot.keys()) {
    if (fromTip.has(path)) out.set(path, fromTip.get(path)!);
  }
  return out;
}

/** The folder that has branch `base` checked out (the main folder, or another worktree), or null. */
export async function baseCheckout(project: string, base: string): Promise<string | null> {
  const text = (await git(['worktree', 'list', '--porcelain'], project)).stdout;
  let current: Record<string, string> = {};
  for (const line of [...splitlines(text), '']) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    } else if (!line) {
      if (current.branch === `refs/heads/${base}`) return current.path;
      current = {};
    }
  }
  return null;
}

/** str.splitlines() for git output (already newline-translated). */
function splitlines(text: string): string[] {
  // deno-lint-ignore no-control-regex
  const lines = text.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function plural(count: number, word: string): string {
  return `${count} ${word}` + (count === 1 ? '' : 's');
}

export function commitMessage(title: unknown): string {
  const text = clip(pyStrip(pyStr(title || '').replace(new RegExp(`[${PY_SPACE}]+`, 'g'), ' ')), 80);
  return text ? `AIB: work from chat ${text}` : 'AIB: work from chat';
}

const RUNNING_STATE = /^(running|working|in[-_ ]progress|active|starting|queued|busy|streaming)$/i;

/** The folder a subagent says it works in ('' when it did not say). */
function helperFolder(info: Record<string, unknown>): string {
  for (const name of ['cwd', 'worktree', 'worktreePath', 'workingDirectory']) {
    const value = info[name];
    if (typeof value === 'string' && pyStrip(value)) return pyStrip(value);
  }
  return '';
}

/** True when `folder` is `root` or lies inside it. */
export function insideFolder(folder: string, root: string): boolean {
  if (!folder || !root) return false;
  const a = normcase(realpath(folder)).replace(/[\\/]+$/, '');
  const b = normcase(realpath(root)).replace(/[\\/]+$/, '');
  return a === b || a.startsWith(b + '\\') || a.startsWith(b + '/');
}

/** The running subagents of a chat: [name, folder it works in or ''] each. */
export function runningHelpers(state: Record<string, unknown>): [string, string][] {
  const subagents = pyTruthy(state.subagents) && isDict(state.subagents) ? Object.entries(state.subagents) : [];
  return subagents.filter(([, v]) => isDict(v) && RUNNING_STATE.test(pyStr(v.state || ''))).map(([key, v]) => {
    const info = v as Record<string, unknown>;
    return [clip(pyStrip(pyStr(info.title || info.name || key)), 80), helperFolder(info)];
  });
}

/** The running subagents that did not say where they work (Merge does not wait for them; the tool's reply names them). */
export function unplacedHelpers(state: Record<string, unknown>): string[] {
  return runningHelpers(state).filter(([, folder]) => !folder).map(([name]) => name);
}

/**
 * '' when a chat's public state says it is idle, else one line saying what it is still doing. checkBusy=false is for the moment a
 * turn has just ended (or is about to start) on the caller's own thread; checkQueue=false ignores messages that wait for that moment.
 * With `worktree` (Merge), a running subagent only counts when it says it works inside that folder: a helper in its own worktree, or
 * one that did not say where it works, cannot be told to touch the chat's copy. Without it (live sync) every running one counts.
 */
export function stateIdleReason(
  state: Record<string, unknown>,
  checkBusy = true,
  checkQueue = true,
  forAgent = false,
  worktree = '',
): string {
  if (pyTruthy(state.closed)) return 'The chat is closed; reopen it to merge';
  if (checkBusy && (state.state !== 'ready' || pyTruthy(state.busy))) {
    return 'Wait for the chat to finish its turn';
  }
  const queue = pyTruthy(state.queue) && isDict(state.queue) ? state.queue : {};
  if (checkQueue && pyTruthy(queue.items)) {
    return 'Messages are queued in this chat';
  }
  const caps = pyTruthy(state.clientCaps) && isDict(state.clientCaps) ? state.clientCaps : {};
  const terminals = Array.isArray(caps.terminals) ? caps.terminals : [];
  const terminal = terminals.find((t) => isDict(t) && t.status === 'running') as Record<string, unknown> | undefined;
  if (terminal) {
    if (!forAgent) return 'A terminal of this chat is still running';
    const command = clip(pyStrip(pyStr(terminal.command || '')), 80);
    return `A terminal you started is still running${command ? ` (${command})` : ''}${terminal.id ? `, terminal ${pyStr(terminal.id)}` : ''}. ` +
      'Stop it first (kill or release that terminal; ask the user if they want it kept running), then call merge_into_project again';
  }
  const running = runningHelpers(state).find(([, folder]) => !worktree || insideFolder(folder, worktree));
  if (running) {
    if (!forAgent) return 'A subagent of this chat is still running';
    const where = worktree ? " in this chat's worktree" : '';
    return `Your subagent ${running[0]} is still running${where}. Wait for it to finish or stop it, then call merge_into_project again`;
  }
  return '';
}

// ---- the chat ----------------------------------------------------------------------------------------------------
/** What Merge needs to know about one worktree chat. */
export class Chat {
  state: Record<string, unknown> = {};
  registry!: wt.Registry;
  key = '';
  record: WorktreeRecord = {};
  wt = '';
  project = '';
  branch = '';
  /** Where the merge lands: the project's main branch (main, else master, else the branch the chat started from). */
  base = '';
  /** The branch the chat started from (the project folder's branch when the chat was made). */
  startBase = '';
  /** The target found when the chat was opened ('' until then). */
  target = '';
  snapshot = '';
  user = '';

  private constructor(readonly studio: MergeStudio, readonly id: string, readonly fromTool: boolean) {}

  static async open(studio: MergeStudio, chatId: unknown, fromTool = false): Promise<Chat> {
    if (typeof chatId !== 'string' || !chatId) {
      throw new Refused('Choose a chat', 'bad_request', 400);
    }
    let state: unknown;
    try {
      state = await studio.liveState(chatId);
    } catch {
      state = null;
    }
    if (!isDict(state)) {
      throw new Refused('Open the chat to merge its work', 'unknown_chat', 404);
    }
    const chat = new Chat(studio, chatId, fromTool);
    chat.state = state;
    const record = wt.recordForPath(studio.stateDir, state.cwd);
    if (!record) {
      throw new Refused('This chat does not work in its own worktree', 'no_worktree', 404);
    }
    chat.registry = new wt.Registry(studio.stateDir);
    chat.key = record.key;
    chat.reload();
    chat.target = await targetBranch(chat.project, chat.startBase);
    chat.base = chat.target;
    return chat;
  }

  reload(): void {
    const record = this.registry.get(this.key) ?? {};
    if (!record.path || !isdir(str(record.path))) {
      throw new Refused("This chat's workspace was removed", 'gone', 404);
    }
    this.record = record;
    this.wt = str(record.path);
    this.project = str(record.project);
    this.branch = str(record.branch);
    this.startBase = str(record.base) || '';
    this.base = this.target || this.startBase;
    this.snapshot = str(record.snapshot) || '';
    this.user = str(record.user) || this.snapshot; // the user base U; S while live sync has not moved it
    if (!(this.startBase && this.snapshot)) {
      throw new Refused('This chat has no base branch to merge into', 'no_base', 400);
    }
  }

  async refreshState(): Promise<Record<string, unknown>> {
    let state: unknown;
    try {
      state = await this.studio.liveState(this.id);
    } catch {
      state = null;
    }
    if (isDict(state)) this.state = state;
    return this.state;
  }

  /** '' when the chat is idle, else one line saying what it is still doing. */
  async idleReason(): Promise<string> {
    // The agent's own tool runs mid-turn, and the button's message (or the user's next one) may wait in the queue behind it.
    return stateIdleReason(await this.refreshState(), !this.fromTool, !this.fromTool, this.fromTool, this.wt);
  }
}

/** The branch a chat's work merges into: the project's main branch (main, else master), else the branch it started from. */
export function targetBranch(project: string, startBase: string): Promise<string> {
  return wt.mainBranch(project, startBase); // the same rule picks where a new chat starts (worktrees.ts)
}

// ---- the pieces --------------------------------------------------------------------------------------------------
export async function unmergedNames(folder: string): Promise<string[]> {
  return nul((await git(['diff', '--name-only', '--diff-filter=U', '-z'], folder)).stdout);
}

export async function unmerged(folder: string): Promise<string[]> {
  return nul((await git(['ls-files', '-u', '-z'], folder)).stdout);
}

function readText(path: string): string {
  try {
    return new TextDecoder('utf-8').decode(Deno.readFileSync(path));
  } catch {
    return '';
  }
}

function isFile(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

/** '' when the conflicts are resolved for real, else the line to show. Studio looks itself; the agent's word is not taken. */
export async function checkResolution(chat: Chat, files: string[]): Promise<string> {
  if ((await unmerged(chat.wt)).length) return WAITING;
  for (const name of files) {
    const path = pathOf(chat.wt, name);
    if (MARKER.test(isFile(path) ? readText(path) : '')) return WAITING;
  }
  if (!(await isAncestor(chat.wt, chat.base, 'HEAD'))) return WAITING;
  return '';
}

/** Commit what is uncommitted in the worktree. Returns true when a commit was made. */
export async function commitPending(chat: Chat, title: unknown): Promise<boolean> {
  if (!strip((await git(['status', '--porcelain=v1', '-uall'], chat.wt)).stdout)) return false;
  if (!(await wt.touchedPaths(chat.wt, 'HEAD')).length) return false; // only line-ending noise: the chat touched nothing
  await git(['add', '-A'], chat.wt);
  if (!strip((await git(['diff', '--cached', '--name-only'], chat.wt)).stdout)) return false;
  await gitc(['commit', '-m', commitMessage(title)], chat.wt);
  return true;
}

/** `git merge <base>` in the worktree. Returns [] when it went through, else the files that conflict. */
export async function updateFromBase(chat: Chat, _tip: string): Promise<string[]> {
  const done = await gitc(['merge', '--no-ff', '--no-edit', chat.base], chat.wt, { check: false });
  if (done.returncode === 0) return [];
  if (await mergeInProgress(chat.wt)) {
    const files = nul((await git(['diff', '--name-only', '--diff-filter=U', '-z'], chat.wt)).stdout);
    return files.length ? files : ['(see git status)'];
  }
  const detail = splitlines(strip(done.stderr || done.stdout));
  throw new Refused(
    'Could not bring ' + chat.base + ' into the chat: ' +
      (detail.length ? clip(detail[0], 160) : 'git failed'),
    'update_failed',
  );
}

function shownList(files: string[], limit: number): string {
  return files.slice(0, limit).join(', ') +
    (files.length > limit ? ' and more' : '');
}

export function conflictLine(chat: { base: string }, files: string[]): string {
  const shown = shownList(files, 12);
  return `Bringing ${chat.base} into this branch left merge conflicts in: ${shown}. Resolve them: keep what both sides intended and remove every ` +
    `conflict marker (<<<<<<<, =======, >>>>>>>). Then stage the files and commit to finish the merge (git commit --no-edit). ` +
    `Do not abort the merge and do not change anything else.`;
}

function newId(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

function payloadError(payload: unknown, fallback: string): string {
  return clip(pyStr(isDict(payload) && 'error' in payload ? payload.error : fallback), 160);
}

async function askChatToResolve(chat: Chat, files: string[]): Promise<void> {
  const text = conflictLine(chat, files);
  const [status, payload] = await chat.studio.liveCall('prompt', { id: chat.id, text, clientMessageId: 'merge-' + newId() });
  if (status !== 200) {
    throw new Refused(
      'Could not ask the chat to resolve the conflicts: ' +
        payloadError(payload, 'it did not accept the message'),
      'prompt_failed',
    );
  }
}

/** One commit on `tip` with the chat's version of each landing file; no checkout, no touch to the worktree. */
async function squash(chat: Chat, tip: string, files: Map<string, RawEntry>, title: unknown): Promise<string> {
  const scratch = Deno.makeTempDirSync({ prefix: '.studio-merge-', dir: await gitDir(chat.wt) });
  const env = { GIT_INDEX_FILE: join(scratch, 'index') };
  let tree: string;
  try {
    await git(['read-tree', tip], chat.wt, { env });
    const lines: string[] = [];
    for (const [path, [mode, sha, status]] of files) {
      lines.push((status === 'D' ? '0 ' + '0'.repeat(40) : `${mode} ${sha}`) + '\t' + path + '\n');
    }
    if (lines.length) {
      const done = await wt.rawGit(['update-index', '--index-info'], chat.wt, env, new TextEncoder().encode(lines.join('')));
      if (done.returncode !== 0) {
        throw new GitError('git update-index failed: ' + pyStrip(done.stderr + done.stdout).slice(-600));
      }
    }
    tree = strip((await git(['write-tree'], chat.wt, { env })).stdout);
  } finally {
    try {
      Deno.removeSync(scratch, { recursive: true });
    } catch { /* ignore_errors */ }
  }
  return strip((await gitc(['commit-tree', tree, '-p', tip, '-m', commitMessage(title)], chat.wt)).stdout);
}

/** The commit to fast-forward base to, built on `tip` from the chat's own commits only: [sha, number of commits]. */
export async function prepareLanding(
  chat: Chat,
  tip: string,
  head: string,
  files: Map<string, RawEntry>,
  title: unknown,
): Promise<[string, number]> {
  const own = pySplitWords(
    (await git(['rev-list', '--no-merges', '--reverse', '--topo-order', `${chat.snapshot}..${head}`, `^${tip}`], chat.wt)).stdout,
  );
  const hasMerge = !!strip((await git(['rev-list', '--merges', '--max-count=1', `${chat.snapshot}..${head}`], chat.wt)).stdout);
  let landed = '';
  try {
    if (own.length && !hasMerge) {
      const done = await git(
        ['rebase', '--onto', tip, chat.snapshot, head],
        chat.wt,
        { check: false, identity: !(await configured(chat.wt)) },
      );
      if (done.returncode === 0) landed = await rev(chat.wt, 'HEAD');
      else {
        log.warning(
          "Replaying the chat's commits failed, landing them as one commit: %s",
          pyStrip((done.stderr || '') + (done.stdout || '')).slice(-600),
        );
        await git(['rebase', '--abort'], chat.wt, { check: false });
      }
    } else if (own.length) { // base was brought into the branch: replay only the chat's commits, they are not in base
      await git(['switch', '--detach', tip], chat.wt);
      if ((await gitc(['cherry-pick', ...own], chat.wt, { check: false })).returncode === 0) landed = await rev(chat.wt, 'HEAD');
      else await git(['cherry-pick', '--abort'], chat.wt, { check: false });
    }
  } finally {
    if (strip((await git(['symbolic-ref', '-q', 'HEAD'], chat.wt, { check: false })).stdout) !== `refs/heads/${chat.branch}`) {
      await git(['switch', chat.branch], chat.wt);
    }
  }
  if (landed && !(await rawDiff(chat.wt, tip, landed)).size) landed = '';
  if (!landed) { // a replay that conflicts (or a resolved merge): the same result as one commit
    landed = await squash(chat, tip, files, title);
    return [landed, Math.max(1, own.length)];
  }
  return [landed, own.length];
}

function pySplitWords(text: string): string[] {
  return text.split(new RegExp(`[${PY_SPACE}]+`)).filter((w) => w);
}

async function fastForward(chat: Chat, folder: string | null, tip: string, landed: string): Promise<void> {
  if (folder) {
    const done = await git(['merge', '--ff-only', landed], folder, { check: false });
    if (done.returncode !== 0) {
      throw new Refused(`Could not fast-forward ${chat.base}: it changed or a local edit is in the way. Nothing was merged`, 'ff_failed');
    }
  } else {
    const done = await git(['update-ref', `refs/heads/${chat.base}`, landed, tip], chat.project, { check: false });
    if (done.returncode !== 0) {
      throw new Refused(`${chat.base} changed while merging. Nothing was merged`, 'ff_failed');
    }
  }
}

/**
 * The new user base after a merge: a snapshot of the project folder on the new tip (so it carries what the user has unsaved), or the
 * tip itself when the folder is clean, does not hold the base branch, or the user's edits clashed (they are in the stash).
 */
async function rebuildUserBase(chat: Chat, tip: string, folder: string | null, clash: boolean): Promise<string> {
  if (clash || !folder || !wt.same(folder, chat.project)) return tip;
  const scratch = Deno.makeTempDirSync({ prefix: '.studio-user-', dir: await gitDir(chat.project) });
  let snap: string;
  try {
    snap = await wt.snapshotCommit(chat.project, scratch);
  } finally {
    try {
      Deno.removeSync(scratch, { recursive: true });
    } catch { /* ignore_errors */ }
  }
  const sameTree = strip((await git(['rev-parse', snap + '^{tree}'], chat.project)).stdout) ===
    strip((await git(['rev-parse', tip + '^{tree}'], chat.project)).stdout);
  return sameTree ? tip : snap;
}

/** After a merge: the worktree branch is checked out at a new user base U (new tip + the project folder's unsaved edits). */
async function resetTo(chat: Chat, tip: string, folder: string | null = null, clash = false): Promise<void> {
  const root = normcase(realpath(chat.registry.root));
  const here = normcase(realpath(chat.wt));
  if (
    !here.startsWith(root + (Deno.build.os === 'windows' ? '\\' : '/')) ||
    strip((await git(['symbolic-ref', '-q', 'HEAD'], chat.wt, { check: false })).stdout) !== `refs/heads/${chat.branch}`
  ) {
    throw new Refused("The chat's worktree is not where AIB left it; it was not reset", 'reset_refused');
  }
  const user = await rebuildUserBase(chat, tip, folder, clash);
  await git(['reset', '--hard', user], chat.wt);
  await wt.pinUserBase(chat.project, chat.record, user);
  const turnUser = (chat.registry.get(chat.key) ?? {}).turnUser ? user : '';
  await chat.registry.update(chat.key, {
    snapshot: tip,
    user,
    diffBase: user,
    userHead: await rev(chat.project, 'HEAD'),
    mergeConflicts: [],
    pendingSync: [],
    syncConflicts: [],
    syncMerged: {},
    syncKept: {},
    syncNotes: [],
    turnUser,
    turnSynced: [],
  }); // the worktree is U again: nothing left to merge
}

// ---- the whole thing ---------------------------------------------------------------------------------------------
export type MergeResult = Record<string, unknown>;

/** Merge a worktree chat into its base branch: {ok, state: 'merged'|'conflicts', message, ...}; throws Refused with the line to show. */
export async function merge(studio: MergeStudio, chatId: unknown, title: unknown = '', fromTool = false): Promise<MergeResult> {
  const chat = await Chat.open(studio, chatId, fromTool);
  if (RUNNING.has(chat.key)) {
    throw new Refused('A merge of this chat is already running', 'running');
  }
  RUNNING.add(chat.key);
  const lock = wt.worktreeLock(chat.studio.stateDir, chat.record, settings.LOCK_WAIT);
  try {
    try {
      await lock.acquire();
    } catch {
      throw new Refused("AIB is busy with this chat's workspace; try Merge again", 'busy');
    }
    try {
      return await mergeRounds(chat, title);
    } finally {
      lock.release();
    }
  } catch (error) {
    if (error instanceof GitError) {
      log.exception(error, 'Merge failed');
      throw new Refused(clip(error.message, 200), 'git_failed');
    }
    throw error;
  } finally {
    RUNNING.delete(chat.key);
  }
}

async function mergeRounds(chat: Chat, title: unknown): Promise<MergeResult> {
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reason = await chat.idleReason();
    if (reason) throw new Refused(reason, 'busy');
    chat.reload();
    const clashes = await settleConflicts(chat.registry, {
      ...chat.record,
      key: chat.key,
    }); // the chat resolved a clash: clear it, advance U
    if (clashes.length) throw new Refused(clashLine(clashes), 'conflicts');
    chat.reload();
    const recorded = Array.isArray(chat.record.mergeConflicts) ? (chat.record.mergeConflicts as string[]) : [];
    if (recorded.length || await mergeInProgress(chat.wt)) {
      if ((await mergeInProgress(chat.wt)) || (await checkResolution(chat, recorded))) {
        throw new Refused(chat.fromTool ? conflictLine(chat, recorded) : WAITING, 'conflicts');
      }
      await chat.registry.update(chat.key, { mergeConflicts: [] });
    }
    await commitPending(chat, title); // a reworked change after a tree-landing conflict may still be uncommitted
    const tip = await rev(chat.project, `refs/heads/${chat.base}`);
    if (!tip) {
      throw new Refused(`The branch ${chat.base} no longer exists`, 'no_base');
    }
    if (!(await isAncestor(chat.wt, tip, 'HEAD'))) { // base moved past the branch: bring it in while the chat is idle
      const files = await updateFromBase(chat, tip);
      if (files.length) {
        await chat.registry.update(chat.key, { mergeConflicts: files });
        if (chat.fromTool) {
          return { ok: true, state: 'conflicts', message: conflictLine(chat, files), files };
        }
        await askChatToResolve(chat, files);
        return { ok: true, state: 'conflicts', message: WAITING, files };
      }
      continue;
    }
    await hook('before_lock');
    const outcome = await repoLock(chat.project).run(
      async (): Promise<MergeResult | null> => {
        if ((await rev(chat.project, `refs/heads/${chat.base}`)) !== tip) {
          return null; // base moved since the check above: look again
        }
        const busy = await chat.idleReason();
        if (busy) throw new Refused(await chat.idleReason(), 'busy');
        return await land(chat, tip, title);
      },
    );
    if (outcome) return outcome;
  }
  throw new Refused(`${chat.base} keeps changing; try Merge again`, 'moving');
}

export interface StashRef {
  sha: string;
  name: string;
}

/** Stash the uncommitted work of the folder that has base: {sha, name} or null when clean. Found again by SHA, never popped. */
async function stashUserWork(chat: Chat, folder: string): Promise<StashRef | null> {
  if (!(await porcelainPaths(folder)).size) return null;
  const parts = chat.branch.split('/');
  const name = `studio-merge-${parts[parts.length - 1]}-${Math.floor(Date.now() / 1000)}`;
  await git(['stash', 'push', '-u', '-m', name], folder);
  const sha = strip((await git(['rev-parse', '--verify', '-q', 'stash@{0}'], folder, { check: false })).stdout);
  const subject = strip((await git(['log', '-1', '--format=%s', 'stash@{0}'], folder, { check: false })).stdout);
  if (!sha || !subject.includes(name)) {
    throw new Refused('Could not set aside the uncommitted edits in ' + chat.base + '; nothing was merged', 'stash_failed');
  }
  return { sha, name };
}

async function dropStash(folder: string, stash: StashRef): Promise<void> {
  for (const line of splitlines((await git(['stash', 'list', '--format=%H %gd'], folder, { check: false })).stdout)) {
    const space = line.indexOf(' ');
    const found = space >= 0 ? line.slice(0, space) : line;
    if (found === stash.sha) {
      await git(['stash', 'drop', space >= 0 ? line.slice(space + 1) : ''], folder, { check: false });
      return;
    }
  }
}

/** Re-apply by SHA. Returns [] when it applied and that entry was dropped, else the clashing files (the entry is kept). */
async function unstash(folder: string, stash: StashRef): Promise<string[]> {
  const done = await git(['stash', 'apply', '--index', stash.sha], folder, { check: false });
  if (done.returncode === 0) {
    await dropStash(folder, stash);
    return [];
  }
  const files = nul((await git(['diff', '--name-only', '--diff-filter=U', '-z'], folder, { check: false })).stdout);
  return files.length ? files : ['(see git status)'];
}

export function treeConflictLine(chat: { base: string; startBase?: string } | null, files: string[]): string {
  const shown = shownList(files, 12);
  if (chat && chat.startBase && chat.startBase !== chat.base) {
    return `Merging stopped: in ${shown} your changes touch lines that are not the same in ${chat.base} as in ${chat.startBase} (where this ` +
      `chat started), or that the user edited in the project folder. AIB will not decide between them. Rework your change in those files ` +
      `so it applies to ${chat.base} and keeps what both sides intended, commit it, then call merge_into_project again.`;
  }
  return `Merging stopped: your changes touch the same lines the user edited in the project folder, in: ${shown}. AIB will not decide ` +
    `between the two. Rework your change in those files so it keeps what both sides intended, commit it, then merge again. ` +
    `Do not discard the user's lines.`;
}

type TreeLanding = ['landed', string, number] | ['empty'] | ['conflicts', string[]];

/** U is past S: land exactly what the chat changed since U, by a three-way merge of the trees (U as the base). */
async function treeLanding(chat: Chat, tip: string, head: string, title: unknown): Promise<TreeLanding> {
  const done = await git(
    ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${chat.user}`, tip, head],
    chat.wt,
    {
      check: false,
    },
  );
  const lines = splitlines(done.stdout);
  if (done.returncode === 1) {
    const names: string[] = [];
    for (const name of lines.slice(1)) {
      if (!name) break;
      names.push(name);
    }
    return ['conflicts', names.length ? names : ['(see git status)']];
  }
  if (done.returncode !== 0 || !lines.length) {
    throw new GitError('git merge-tree failed: ' + strip(done.stderr || done.stdout).slice(-400));
  }
  const tree = strip(lines[0]);
  if (tree === strip((await git(['rev-parse', tip + '^{tree}'], chat.wt)).stdout)) return ['empty'];
  const own = splitlines(
    (await git(['log', '--no-merges', '--reverse', '--format=%s', `${chat.user}..${head}`, `^${tip}`], chat.wt)).stdout,
  );
  const body = own.length
    ? 'Chat commits:\n' +
      own.slice(0, 30).map((subject) => '- ' + clip(subject, 120)).join('\n')
    : '';
  const message = [commitMessage(title), ...(body ? [body] : [])];
  const sha = strip((await gitc(['commit-tree', tree, '-p', tip, ...message.flatMap((m) => ['-m', m])], chat.wt)).stdout);
  return ['landed', sha, Math.max(1, own.length)];
}

async function land(chat: Chat, tip: string, title: unknown): Promise<MergeResult> {
  const folder = await baseCheckout(chat.project, chat.base);
  if (folder) {
    const why = await folderState(folder);
    if (why) throw new Refused(why[0].toUpperCase() + why.slice(1), 'locked');
  }
  const head = await rev(chat.wt, 'HEAD');
  const byTree = chat.user !== chat.snapshot;
  let files: Map<string, RawEntry> | null = null;
  let landed = '';
  let count = 0;
  if (byTree) {
    const built = await treeLanding(chat, tip, head, title);
    if (built[0] === 'conflicts') {
      const line = treeConflictLine(chat, built[1]);
      await chat.registry.update(chat.key, { mergeConflicts: built[1] }); // as the base-merge path: live sync waits for the fix
      if (chat.fromTool) {
        return { ok: true, state: 'conflicts', message: line, files: built[1] };
      }
      const [code, payload] = await chat.studio.liveCall('prompt', { id: chat.id, text: line, clientMessageId: 'merge-' + newId() });
      if (code !== 200) {
        throw new Refused(
          'Could not ask the chat to rework its change: ' +
            payloadError(payload, 'it did not accept the message'),
          'prompt_failed',
        );
      }
      return { ok: true, state: 'conflicts', message: WAITING, files: built[1] };
    }
    if (built[0] === 'empty') {
      throw new Refused(`Nothing to merge into ${chat.base}`, 'empty');
    }
    [, landed, count] = built;
  } else {
    files = await landingFiles(chat.wt, chat.snapshot, head, tip);
    if (!files.size) {
      throw new Refused(`Nothing to merge into ${chat.base}`, 'empty');
    }
  }
  const pause = wt.pauseLock(chat.studio.stateDir, chat.project, settings.LOCK_WAIT);
  try {
    await pause.acquire(); // "sync paused": nothing copies the user's edits into a worktree while the project folder is being changed
  } catch {
    throw new Refused('AIB is still copying edits for this project; try Merge again', 'busy');
  }
  let stash: StashRef | null = null;
  let clash: string[] = [];
  try {
    stash = folder ? await stashUserWork(chat, folder) : null;
    try {
      if (!byTree) {
        [landed, count] = await prepareLanding(chat, tip, head, files!, title);
      }
      await hook('before_ff');
      await fastForward(chat, folder, tip, landed);
    } catch (error) {
      if (stash && folder && (await unstash(folder, stash)).length) { // nothing landed: the folder ends as it started
        log.error('Could not re-apply the stash %s after a failed merge; it is kept', stash.name);
      }
      throw error;
    }
    clash = stash && folder ? await unstash(folder, stash) : [];
    await resetTo(chat, landed, folder, clash.length > 0);
  } finally {
    pause.release();
  }
  const message = `Merged into ${chat.base} (${plural(count, 'commit')})`;
  const out: MergeResult = {
    ok: true,
    state: 'merged',
    message,
    commits: count,
    base: chat.base,
    tip: landed,
    clash,
    stash: clash.length ? stash!.name : '',
  };
  const notes: Record<string, unknown>[] = [{ message }];
  if (clash.length) {
    const canEdit = canEditProject(chat.state);
    recordClash(chat, folder!, clash, stash!);
    notes.push({ message: clashNote(clash, stash!.name), actions: clashActions() });
    out.guidance = clashGuidance(chat, clash, stash!.name, canEdit);
  }
  for (const item of notes) {
    try {
      await chat.studio.liveCall(NOTE_OP, { ...item, id: chat.id });
    } catch (error) {
      log.exception(error, 'Could not post the merge note');
    }
  }
  if (clash.length && !chat.fromTool) { // the chat is idle: tell it, so it explains and offers to combine
    try {
      await chat.studio.liveCall('prompt', { id: chat.id, text: out.guidance, clientMessageId: 'merge-clash-' + newId() });
    } catch (error) {
      log.exception(error, 'Could not tell the chat about the clash');
    }
  }
  return out;
}

// ---- when re-applying the user's edits clashes (stage E2) ---------------------------------------------------------
export const CLASH_FILE = 'worktree-clashes.json';
export const KEEP_MINE = 'keep-mine', LEAVE = 'leave', CHECK = 'check';

/** Whether this chat's agent may write in the project folder (outside its own worktree). Codex chats may not. */
export function canEditProject(state: unknown): boolean {
  const provider = pyStr((isDict(state) ? state.provider : null) || '')
    .toLowerCase();
  return !provider.includes('codex');
}

export function clashActions(): { id: string; label: string }[] {
  return [{ id: KEEP_MINE, label: 'Keep my version' }, { id: LEAVE, label: "I'll sort it myself" }];
}

export function clashNote(files: string[], stashName: string): string {
  return `Your edits clash with the merge in: ${shownList(files, 6)}. They are saved in the stash named ${stashName}`;
}

export function clashGuidance(chat: { base: string; project: string }, files: string[], stashName: string, canEdit: boolean): string {
  const shown = shownList(files, 12);
  let text =
    `AIB merged this chat into ${chat.base}, but the user also had unsaved edits in the project folder, and they clash with the merge in: ${shown}. ` +
    `The user's edits are safe: they are saved in the git stash named ${stashName}. Explain this to the user in plain words, naming the files. `;
  if (canEdit) {
    text +=
      `Offer to combine the two versions. If the user agrees, edit those files in the project folder (${chat.project}) so they keep what both sides ` +
      'intended and contain no conflict markers (<<<<<<<, =======, >>>>>>>), show the user the result, then call the resolve_edit_clash tool with action "check". ';
  }
  text +=
    'Otherwise the user can choose "Keep my version" (their edits win in those files; call resolve_edit_clash with action "keep_mine" only when they say so) ' +
    'or "I\'ll sort it myself" (change nothing; call resolve_edit_clash with action "leave" and tell them the stash name). Do not choose for them.';
  return text;
}

function clashPath(stateDir: string): string {
  return pathOf(stateDir, CLASH_FILE);
}

function clashRead(stateDir: string): Map<string, Record<string, unknown>> {
  const [status, raw] = readJsonFile(clashPath(stateDir));
  const out = new Map<string, Record<string, unknown>>();
  if (status === 'ok' && isDict(raw)) {
    for (const [k, v] of entriesOf(raw)) if (isDict(v)) out.set(k, v);
  }
  return out;
}

function clashWrite(stateDir: string, items: Map<string, Record<string, unknown>>): void {
  saveJson(clashPath(stateDir), items, '.studio-clashes-');
}

function projectKey(project: string): string {
  return normcase(realpath(String(project)));
}

function recordClash(chat: Chat, folder: string, files: string[], stash: StashRef): void {
  const items = clashRead(chat.studio.stateDir);
  items.set(projectKey(chat.project), {
    project: chat.project,
    folder,
    base: chat.base,
    files: [...files],
    stash: { sha: stash.sha, name: stash.name },
    chat: chat.id,
    time: Date.now() / 1000,
  });
  clashWrite(chat.studio.stateDir, items);
}

function clashDrop(stateDir: string, project: string): void {
  const items = clashRead(stateDir);
  if (items.delete(projectKey(project))) clashWrite(stateDir, items);
}

function hasMarkers(folder: string, name: string): boolean {
  const path = pathOf(folder, name);
  return isFile(path) && MARKER.test(readText(path));
}

export interface Unresolved {
  files: string[];
  stash: string;
  line: string;
  folder: string;
  record: Record<string, unknown>;
}

/** null when the project has no clash left (the record is dropped once resolved), else what is still open. */
export async function unresolved(stateDir: string, project: string): Promise<Unresolved | null> {
  const rec = clashRead(stateDir).get(projectKey(project));
  if (!rec) return null;
  const folder = str(rec.folder) || str(rec.project) || '';
  if (!folder || !isdir(folder)) {
    clashDrop(stateDir, project);
    return null;
  }
  let openFiles: string[];
  try {
    openFiles = await unmergedNames(folder);
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
    openFiles = [];
  }
  const names: string[] = [];
  const recorded = Array.isArray(rec.files) ? rec.files.filter((f): f is string => typeof f === 'string' && f !== '(see git status)') : [];
  for (const name of new Set([...openFiles, ...recorded])) {
    if (openFiles.includes(name) || hasMarkers(folder, name)) names.push(name);
  }
  if (!names.length) {
    clashDrop(stateDir, project);
    return null;
  }
  const first = names[0];
  const line = names.length === 1
    ? `${first} has unresolved edits. Ask the chat to fix it.`
    : `${first} and ${names.length - 1} more have unresolved edits. Ask the chat to fix it.`;
  const stash = isDict(rec.stash) ? rec.stash : {};
  return { files: names, stash: str(stash.name ?? ''), line, folder, record: rec };
}

/** What the amber line shows for a project folder: {unresolved, line, files, stash} plus syncPaused/syncLine. Read only. */
export async function clashStatus(studio: { stateDir: string }, project: unknown): Promise<Record<string, unknown>> {
  if (typeof project !== 'string' || !project) return { unresolved: false };
  const found = await unresolved(studio.stateDir, project);
  const paused = pausedStatus(studio.stateDir, project);
  if (!found) return { unresolved: false, ...paused };
  return { unresolved: true, line: found.line, files: found.files, stash: found.stash, ...paused };
}

async function stashRefOf(folder: string, stash: Record<string, unknown>): Promise<string> {
  for (const line of splitlines((await git(['stash', 'list', '--format=%H %gd'], folder, { check: false })).stdout)) {
    const space = line.indexOf(' ');
    if ((space >= 0 ? line.slice(0, space) : line) === stash.sha) {
      return space >= 0 ? line.slice(space + 1) : '';
    }
  }
  return '';
}

const ACTIONS: Record<string, string> = { keep_mine: KEEP_MINE, 'keep-mine': KEEP_MINE, leave: LEAVE, check: CHECK };

/**
 * What the user (a button) or the chat (a tool) can do about a clash in this chat's project: 'keep-mine', 'leave' or 'check'.
 * Returns {ok, message, ...}; throws Refused.
 */
export async function resolveClash(
  studio: MergeStudio,
  chatId: unknown,
  actionIn: unknown,
  fromTool = false,
): Promise<Record<string, unknown>> {
  const action = typeof actionIn === 'string' && Object.hasOwn(ACTIONS, actionIn) ? ACTIONS[actionIn] : '';
  if (!action) {
    throw new Refused('The action must be keep_mine, leave or check', 'bad_request', 400);
  }
  const chat = await Chat.open(studio, chatId, fromTool);
  const found = await unresolved(studio.stateDir, chat.project);
  if (!found) {
    throw new Refused('There are no unresolved edits in this project', 'no_clash', 404);
  }
  const name = found.stash;
  if (action === LEAVE) {
    return {
      ok: true,
      message: `Left as it is. Your edits are saved in the stash named ${name}; the conflicting files are ${found.files.join(', ')}`,
      stash: name,
    };
  }
  const why = await folderState(found.folder);
  if (why) throw new Refused(why[0].toUpperCase() + why.slice(1), 'locked');
  return action === CHECK ? await checkCombined(chat, found) : await keepMine(chat, found);
}

async function keepMine(chat: Chat, found: Unresolved): Promise<Record<string, unknown>> {
  const folder = found.folder;
  const stash = isDict(found.record.stash) ? found.record.stash : {};
  const name = found.stash;
  if (!(await stashRefOf(folder, stash))) {
    throw new Refused(`The stash ${name} is gone, so AIB cannot restore your version. Nothing was changed`, 'stash_gone');
  }
  const files = [...found.files];
  const done: string[] = [];
  const fully = await repoLock(chat.project).run(async () => {
    for (const path of files) {
      let step: wt.GitResult;
      if ((await git(['cat-file', '-e', `${stash.sha}:${path}`], folder, { check: false })).returncode === 0) {
        step = await git(['checkout', str(stash.sha), '--', path], folder, { check: false });
        if (step.returncode === 0) {
          await git(['reset', '-q', '--', path], folder, { check: false }); // leave it as an edit, not staged
        }
      } else { // the user deleted the file
        step = await git(['rm', '-q', '-f', '--', path], folder, { check: false });
      }
      if (step.returncode === 0) done.push(path);
    }
    const all = done.length === files.length &&
      !(await unresolved(chat.studio.stateDir, chat.project));
    if (all) {
      const ref = await stashRefOf(folder, stash);
      if (ref) await git(['stash', 'drop', ref], folder, { check: false });
    }
    return all;
  });
  const shown = done.join(', ') || 'none';
  const message = fully
    ? `Kept your version of ${shown}. The stash ${name} was dropped.`
    : `Kept your version of ${shown}, but not everything could be restored. The stash ${name} is kept.`;
  await note(chat, message);
  return { ok: true, message, files: done, stash: name, dropped: fully };
}

/** The chat says it combined the files in the project folder. Studio looks for itself: no markers, no unmerged entries. */
async function checkCombined(chat: Chat, found: Unresolved): Promise<Record<string, unknown>> {
  const folder = found.folder;
  const left = found.files.filter((n) => hasMarkers(folder, n));
  if (left.length) {
    throw new Refused('These files still have conflict markers: ' + left.join(', ') + '. Remove them and call again', 'markers');
  }
  const openFiles = new Set(await unmergedNames(folder));
  const stuck = found.files.filter((n) => openFiles.has(n));
  if (stuck.length) {
    await git(['reset', '-q', '--', ...stuck], folder, { check: false }); // marks them resolved; content stays
  }
  const still = await unresolved(chat.studio.stateDir, chat.project);
  if (still) {
    throw new Refused('Still unresolved: ' + still.files.join(', '), 'unresolved');
  }
  const message = `Your edits are combined in ${found.files.join(', ')}. The stash ${found.stash} is kept as a backup`;
  await note(chat, message);
  return { ok: true, message, files: found.files, stash: found.stash };
}

async function note(chat: Chat, message: string): Promise<void> {
  try {
    await chat.studio.liveCall(NOTE_OP, { id: chat.id, message });
  } catch (error) {
    log.exception(error, 'Could not post the note');
  }
}

// ---- what the button shows ---------------------------------------------------------------------------------------
/** {worktree, enabled, state, message, base, label}: the Merge button's state for a chat. Read only. */
export async function status(studio: MergeStudio, chatId: unknown): Promise<Record<string, unknown>> {
  let chat: Chat;
  try {
    chat = await Chat.open(studio, chatId);
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    if (error.code === 'no_worktree' || error.code === 'unknown_chat') {
      return { worktree: false };
    }
    return { worktree: true, enabled: false, state: 'unavailable', message: error.message, base: '' };
  }
  const out = { worktree: true, base: chat.base, label: `Merge into ${chat.base}` };
  try {
    if (RUNNING.has(chat.key)) {
      return { ...out, enabled: false, state: 'merging', message: 'Merging…' };
    }
    const recorded = Array.isArray(chat.record.mergeConflicts) ? (chat.record.mergeConflicts as string[]) : [];
    if ((await mergeInProgress(chat.wt)) || (recorded.length && (await checkResolution(chat, recorded)))) {
      return { ...out, enabled: false, state: 'conflicts', message: WAITING, files: recorded };
    }
    const clashes = openClashes(chat.record); // read only: Merge itself clears the resolved ones
    if (clashes.length) {
      return { ...out, enabled: false, state: 'conflicts', message: clashLine(clashes), files: clashes };
    }
    const touched = await wt.touchedPaths(chat.wt, chat.user);
    if (!touched.length) {
      return { ...out, enabled: false, state: 'nochanges', message: 'Nothing to merge yet' };
    }
    const docs = docRows(chat.wt, touched); // a doc's files as one row each (docs/rows.ts)
    if (docs.length) Object.assign(out, { docs });
    const blocked = requestBlocked(chat.state);
    if (blocked) {
      return { ...out, enabled: false, state: 'unavailable', message: blocked };
    }
    // A busy chat is no reason to wait: the button's message is queued, and the agent merges when it gets to it.
    return { ...out, enabled: true, state: 'ready', message: '' };
  } catch (error) {
    if (error instanceof GitError) {
      return { ...out, enabled: false, state: 'unavailable', message: clip(error.message, 160) };
    }
    throw error;
  }
}

// ---- the button asks the agent (merge_request.ts) -------------------------------------------------------------------
/** '' or why the button cannot ask this chat now (closed, read only). Archived and Elsewhere chats are checked by the route. */
export function requestBlocked(state: Record<string, unknown>): string {
  if (pyTruthy(state.closed)) return 'This chat is closed. Continue it to merge its work';
  if (pyTruthy(state.readOnly)) return "This chat is read only, so it can't merge";
  return '';
}

export interface RequestOptions {
  /** The route's own checks (archived, open in another app): '' or the reason. */
  blocked?: (state: Record<string, unknown>) => string;
}

/**
 * The Merge button: a shortcut that sends the chat the fixed merge message as from the user (queued while the agent works). The
 * agent then merges with its tool, as it does after a "yes" typed in the chat. Returns {ok, state: 'requested', queued, message};
 * throws Refused with the line to show.
 */
export async function requestMerge(studio: MergeStudio, chatId: unknown, options: RequestOptions = {}): Promise<MergeResult> {
  const chat = await Chat.open(studio, chatId);
  const blocked = requestBlocked(chat.state) || (options.blocked ? options.blocked(chat.state) : '');
  if (blocked) throw new Refused(blocked, 'unavailable');
  if (RUNNING.has(chat.key)) throw new Refused('A merge of this chat is already running', 'running');
  if (!(await wt.touchedPaths(chat.wt, chat.user)).length) throw new Refused('Nothing to merge yet', 'nochanges');
  const text = mr.mergeRequestText(chat.base);
  let status: number, payload: unknown;
  try {
    [status, payload] = await studio.liveCall('queue', { id: chat.id, text, clientMessageId: mr.REQUEST_ID_PREFIX + newId() });
  } catch (error) {
    [status, payload] = [500, { error: error instanceof Error ? error.message : String(error) }];
  }
  if (status !== 200) {
    throw new Refused('Could not ask the chat to merge: ' + payloadError(payload, 'it did not accept the message'), 'prompt_failed');
  }
  const queued = isDict(payload) && payload.queued === true;
  return {
    ok: true,
    state: 'requested',
    queued,
    message: queued ? 'Merge requested. The chat merges when it finishes its turn' : 'Merge requested. The chat is merging',
  };
}

/**
 * The agent's merge_into_project tool. The owner decides in the chat (a typed "yes" is enough, as is the Merge button's message);
 * every merge that lands posts AIB's own "Merged into <main> ..." line in the chat, so each one is on the record. The reply (and a
 * refusal) names the target branch (`target`) and the branch the chat started from (`started`); a merged reply also names running
 * helpers Merge did not wait for because they did not say where they work (`helpers`).
 */
export async function mergeFromTool(studio: MergeStudio, chatId: unknown): Promise<MergeResult> {
  let chat: Chat | null = null;
  try {
    chat = await Chat.open(studio, chatId, true);
    const result = await merge(studio, chatId, '', true);
    const out: MergeResult = { ...result, target: chat.base, started: chat.startBase };
    const helpers = unplacedHelpers(await chat.refreshState());
    if (helpers.length) out.helpers = helpers;
    return out;
  } catch (error) {
    if (error instanceof Refused && chat) {
      throw new Refused(error.message, error.code, error.status, { ...error.extra, target: chat.base, started: chat.startBase });
    }
    throw error;
  }
}

// ---- the pieces of worktree_sync.py that Merge and the amber line use: they live in sync.ts ----------------------------
export {
  clashLine,
  openClashes,
  pausedStatus,
  pauseInfo,
  resumeSync,
  settleConflicts,
  SYNC_FILE,
  syncFlagLock,
  syncFlagRead,
  syncFlagWrite,
} from './sync.ts';
