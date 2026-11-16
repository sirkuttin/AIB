/**
 * Decision 6: AIB cleans up its own git leftovers (build plan 1b, section 5). Used by project removal (web/project_routes.ts),
 * the one-time cleanup at the first start after the update (runOnce, after the keeper take-over), "Remove AIB's data from my repos"
 * (Settings; what an uninstaller calls) and, natively inside a distro, the WSL helper (helper/worktrees.ts worktree.cleanup*).
 *
 * Scope, only what THIS install made (5.1): a branch, ref, copy or stash entry is this install's when it is recorded in this state
 * folder (studio-worktrees.json, its removed-notes, swarm-helpers.json, worktree-clashes.json) or its worktree path is under this
 * install's worktrees root. Anything else that matches AIB's names (`studio/*` branches, `refs/studio/*`, `studio-merge-*` /
 * `aib-swarm-undo-*` stashes, a copy of a `studio/*` branch elsewhere) was made by another AIB install on the same repo (a test
 * build, the dev copy, an e2e run): it is listed (own: false) and removed only when the user ticks it in a confirm, never silently.
 *
 * "Unmerged work" (5.2) compares files, never ancestry:
 *   - copy folder present: Manager.hasChanges (touchedPaths against the user base U), so edits live sync carried in do not count;
 *   - copy folder missing: the branch against its U ref (refs/studio/<slug>/user); with no U ref, the files the branch changed since
 *     it left its base, compared with the base branch's tip (content already on the base is merged, whatever the history says);
 *   - a stash entry AIB named that is not already in the working tree, and any kept clash stash (5.5), counts as unmerged.
 * Nothing with unmerged work is ever removed silently: `apply` takes the ids the user ticked for those.
 *
 * Private folders (the local-only `/private` and its exclude line) are never touched: copies go through Manager.remove, which moves
 * local-only files written into a copy back into the main folder first. Transcripts are never touched.
 */
import * as wt from './worktrees.ts';
import { CLASH_FILE, folderState, repoLock } from './merge.ts';
import { readHelpers } from '../swarm/registry.ts';
import { entriesOf, readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { isdir, normcase, normpath, SEP } from '../platform/ospath.ts';
import { isDict, pyStrip } from '../core/py.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('cleanup');

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const lines = (text: string) => text.split(/\r?\n/).filter((l) => l);
const git = (args: string[], cwd: string) => wt.git(args, cwd, { check: false });

/** The stash names AIB gives (merge.ts stashUserWork, swarm/undo.ts applyChange). */
export const STASH_NAMES = /\b(studio-merge-(\S+?)-\d+|aib-swarm-undo-\d+)\b/;

export type ItemKind = 'copy' | 'branch' | 'ref' | 'stash' | 'folder';

export interface CleanupItem {
  /** Stable across a check and the confirm: copy:<key>, branch:<name>, ref:<name>, stash:<sha>, folder:<path>, wt:<path>. */
  id: string;
  kind: ItemKind;
  /** Made by this install (5.1). */
  own: boolean;
  /** Holds work that was never merged (5.2): never removed without the user's tick. */
  unmerged: boolean;
  /** Files with unmerged work (0 when not counted). */
  files: number;
  /** What the confirm calls it: the chat's title when known, else the branch, the stash name or the folder. */
  title: string;
  helper: boolean;
  /** A kept clash stash: the user's own edits after Merge clashed. */
  clash: boolean;
  /** In use by a running chat: never removed. */
  live: boolean;
  branch: string;
  path: string;
  /** The saved chat (provider:sessionId) of a copy, when recorded. */
  session: string;
}

export interface Scan {
  project: string;
  /** Why this repo was skipped this time ('' = scanned): not the repo's top folder, git busy, not a repository. */
  skipped: string;
  items: CleanupItem[];
}

export interface ScanOptions {
  /** Folders (worktree paths) and saved chats (provider:sessionId) of running chats: their copies are never touched. */
  live?: Iterable<string>;
  /** Chat titles by provider:sessionId (the page knows them). */
  titles?: Record<string, string>;
}

const norm = (p: string) => wt.norm(p);

/** The repo's top folder when `project` is it ('' for a subfolder, a non-git folder or a missing one). */
async function repoTop(project: string): Promise<string> {
  if (!project || !isdir(project)) return '';
  const top = await git(['rev-parse', '--show-toplevel'], project);
  if (top.returncode !== 0) return '';
  return wt.same(pyStrip(top.stdout), project) ? project : '';
}

const slugOf = (branch: string) => (branch.startsWith('studio/') ? branch.slice('studio/'.length) : '');
const refSlug = (ref: string) => {
  const m = /^refs\/studio\/(.+)\/[^/]+$/.exec(ref);
  return m ? m[1] : '';
};

interface GitWorktree {
  path: string;
  branch: string;
}

async function gitWorktrees(project: string): Promise<GitWorktree[]> {
  const out: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  for (const line of (await git(['worktree', 'list', '--porcelain'], project)).stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: normpath(line.slice('worktree '.length)), branch: '' };
      out.push(cur);
    } else if (line.startsWith('branch ') && cur) cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
  }
  return out.slice(1); // the main checkout first
}

async function refExists(project: string, ref: string): Promise<boolean> {
  return (await git(['rev-parse', '--verify', '-q', ref], project)).returncode === 0;
}

/**
 * Files whose content differs between two commits, or null when git cannot tell. A file that differs only in line endings (a
 * checkout with core.autocrlf committed back) is the same file: the bytes are compared with CRLF read as LF.
 */
async function diffNames(project: string, a: string, b: string, paths: string[] = []): Promise<string[] | null> {
  const done = await git(['diff', '--name-only', '--no-renames', '-z', a, b, ...(paths.length ? ['--', ...paths] : [])], project);
  if (done.returncode !== 0) return null;
  const out: string[] = [];
  for (const name of done.stdout.split('\0').filter((n) => n)) {
    if (!(await sameText(project, `${a}:${name}`, `${b}:${name}`))) out.push(name);
  }
  return out;
}

const DEC = new TextDecoder();
async function sameText(project: string, x: string, y: string): Promise<boolean> {
  const read = async (spec: string) => {
    const done = await wt.git(['cat-file', 'blob', spec], project, { check: false, binary: true });
    return done.returncode === 0 ? done.out : null;
  };
  const [p, q] = [await read(x), await read(y)];
  if (p === null || q === null) return false;
  if (wt.sameBytes(p, q)) return true;
  const lf = (b: Uint8Array) => DEC.decode(b).replace(/\r\n/g, '\n');
  return lf(p) === lf(q);
}

/**
 * Unmerged files of a branch whose copy folder is gone (5.2): against its U ref; with none, the files the branch changed since it
 * left `base`, compared with base's tip by content. A count (0 = nothing unmerged); -1 when git cannot tell (counts as unmerged).
 */
export async function branchUnmerged(project: string, branch: string, base: string): Promise<number> {
  const head = `refs/heads/${branch}`;
  if (!(await refExists(project, head))) return 0;
  const uref = `refs/studio/${slugOf(branch)}/user`;
  if (slugOf(branch) && (await refExists(project, uref))) {
    const names = await diffNames(project, uref, head);
    return names === null ? -1 : names.length;
  }
  const target = base && (await refExists(project, `refs/heads/${base}`)) ? base : await wt.mainBranch(project, '');
  if (!target || !(await refExists(project, `refs/heads/${target}`))) return -1;
  const fork = pyStrip((await git(['merge-base', `refs/heads/${target}`, head], project)).stdout);
  if (!fork) return -1;
  const changed = await diffNames(project, fork, head);
  if (changed === null) return -1;
  if (!changed.length) return 0;
  const left = await diffNames(project, `refs/heads/${target}`, head, changed);
  return left === null ? -1 : left.length;
}

/** Unmerged files of a recorded copy (5.2). -1: cannot tell (counts as unmerged). */
async function recordUnmerged(manager: wt.Manager, record: wt.WorktreeRecord): Promise<number> {
  const path = str(record.path), project = str(record.project), branch = str(record.branch);
  if (isdir(path)) {
    if (!(await manager.hasChanges(record))) return 0;
    const base = wt.diffBase(record);
    try {
      return base ? (await wt.touchedPaths(path, base)).length || -1 : -1;
    } catch {
      return -1;
    }
  }
  return branch ? await branchUnmerged(project, branch, str(record.base)) : 0;
}

/** Unmerged files of a copy AIB has no record of (another install's, or an orphan of this one): its edits plus its branch. */
async function folderUnmerged(project: string, path: string, branch: string): Promise<number> {
  if (!isdir(path)) return branch ? await branchUnmerged(project, branch, '') : 0;
  const status = await git(['status', '--porcelain', '-z', '--untracked-files=all'], path);
  if (status.returncode !== 0) return -1;
  const dirty = status.stdout.split('\0').filter((n) => n).length;
  const committed = branch ? await branchUnmerged(project, branch, '') : 0;
  if (committed < 0) return -1;
  return dirty + committed;
}

interface Stash {
  sha: string;
  ref: string;
  subject: string;
}

async function stashes(project: string): Promise<Stash[]> {
  const out: Stash[] = [];
  for (const line of lines((await git(['stash', 'list', '--format=%H %gd %gs'], project)).stdout)) {
    const [sha, ref, ...rest] = line.split(' ');
    if (sha && ref) out.push({ sha, ref, subject: rest.join(' ') });
  }
  return out;
}

/**
 * True when every file the stash entry holds (tracked and untracked) is already the same in the working tree (5.5): dropping it
 * loses nothing. False when anything differs or git cannot tell.
 */
export async function stashApplied(project: string, sha: string): Promise<boolean> {
  const tracked = await diffNames(project, `${sha}^1`, sha);
  if (tracked === null) return false;
  const untracked = (await refExists(project, `${sha}^3`))
    ? (await git(['ls-tree', '-r', '-z', '--name-only', `${sha}^3`], project)).stdout.split('\0').filter((n) => n)
    : [];
  const blob = async (rev: string, path: string) => {
    const done = await git(['rev-parse', '-q', '--verify', `${rev}:${path}`], project);
    return done.returncode === 0 ? pyStrip(done.stdout) : '';
  };
  for (const path of tracked) {
    if (!(await wt.fileMatchesBlob(project, path, await blob(sha, path)))) return false;
  }
  for (const path of untracked) {
    if (!(await wt.fileMatchesBlob(project, path, await blob(`${sha}^3`, path)))) return false;
  }
  return true;
}

/** The stash SHAs this state folder recorded as kept clash stashes (merge.ts worktree-clashes.json). */
function clashShas(stateDir: string): Set<string> {
  const out = new Set<string>();
  const [status, raw] = readJsonFile(pathOf(stateDir, CLASH_FILE));
  if (status !== 'ok' || !isDict(raw)) return out;
  for (const [, rec] of entriesOf(raw)) {
    if (isDict(rec) && isDict(rec.stash) && str(rec.stash.sha)) out.add(str(rec.stash.sha));
  }
  return out;
}

/** What this install made in one repo, and what another install made there (section 5.1). Changes nothing. */
export async function scanProject(stateDir: string, projectIn: string, options: ScanOptions = {}): Promise<Scan> {
  const project = wt.fsPath(String(projectIn || ''));
  const items: CleanupItem[] = [];
  const skip = (why: string): Scan => ({ project, skipped: why, items: [] });
  if (!(await repoTop(project))) return skip('not the top folder of a git repository');
  const busy = await folderState(project);
  if (busy) return skip(busy);
  const manager = new wt.Manager(stateDir);
  const root = norm(manager.registry.root);
  const underRoot = (p: string) => !!p && norm(p).startsWith(root + SEP);
  const live = new Set([...(options.live ?? [])].map((x) => (x.includes(':') && !/^[a-zA-Z]:[\\/]/.test(x) ? x : norm(x))));
  const titles = options.titles ?? {};
  const inRepo = (p: unknown) => !!str(p) && wt.same(str(p), project);

  // 1. This install's records: the registry, its removed-notes, the helper registry.
  const ownSlugs = new Set<string>();
  const helperBranches = new Map<string, string>(); // branch -> helper title
  const records = Object.entries(manager.registry.all()).filter(([, r]) => inRepo(r.project));
  for (const [, r] of records) if (slugOf(str(r.branch))) ownSlugs.add(slugOf(str(r.branch)));
  for (const note of Object.values(manager.registry.removed())) {
    if (inRepo(note.project) && slugOf(str(note.branch))) ownSlugs.add(slugOf(str(note.branch)));
  }
  for (const h of Object.values(readHelpers(stateDir))) {
    const branch = str(h?.worktree?.branch);
    if (!inRepo(h?.project) || !slugOf(branch)) continue;
    ownSlugs.add(slugOf(branch));
    helperBranches.set(branch, str(h.title));
  }
  const gitWts = await gitWorktrees(project);
  for (const w of gitWts) if (underRoot(w.path) && slugOf(w.branch)) ownSlugs.add(slugOf(w.branch));
  const titleOf = (session: string, branch: string) => titles[session] || helperBranches.get(branch) || branch || '';
  const isLive = (path: string, session: string) => (!!path && live.has(norm(path))) || (!!session && live.has(session));

  // 2. Recorded copies (this install's).
  const handledBranches = new Set<string>();
  const handledPaths = new Set<string>();
  for (const [key, r] of records) {
    const path = str(r.path), branch = str(r.branch), session = str(r.session);
    if (r.status === 'creating') continue; // being made (cleanupIncomplete owns these)
    const files = await recordUnmerged(manager, r);
    handledBranches.add(branch);
    handledPaths.add(norm(path));
    items.push({
      id: `copy:${key}`,
      kind: 'copy',
      own: true,
      unmerged: files !== 0,
      files: Math.max(0, files),
      title: titleOf(session, branch),
      helper: branch.startsWith('studio/helper-') || helperBranches.has(branch),
      clash: false,
      live: isLive(path, session),
      branch,
      path,
      session,
    });
  }

  // 3. Copies git knows that AIB has no record of: under this root (an orphan of this install) or elsewhere on a studio/ branch.
  for (const w of gitWts) {
    if (handledPaths.has(norm(w.path))) continue;
    const mine = underRoot(w.path);
    if (!mine && !slugOf(w.branch)) continue; // the user's own worktree
    const files = await folderUnmerged(project, w.path, w.branch);
    handledBranches.add(w.branch);
    items.push({
      id: `wt:${w.path}`,
      kind: 'copy',
      own: mine,
      unmerged: files !== 0,
      files: Math.max(0, files),
      title: w.branch || w.path,
      helper: w.branch.startsWith('studio/helper-'),
      clash: false,
      live: isLive(w.path, ''),
      branch: w.branch,
      path: w.path,
      session: '',
    });
  }

  // 4. Folders under this install's root for this repo that neither git nor the registry knows (a half-removed copy).
  const repoFolder = pathOf(manager.registry.root, wt.repoHash(project));
  if (isdir(repoFolder)) {
    for (const entry of Deno.readDirSync(repoFolder)) {
      if (!entry.isDirectory || entry.name.startsWith('.')) continue;
      const path = pathOf(repoFolder, entry.name);
      if (handledPaths.has(norm(path)) || gitWts.some((w) => wt.same(w.path, path))) continue;
      if (Object.values(manager.registry.all()).some((r) => wt.same(str(r.path), path))) continue;
      const files = folderFileCount(path);
      items.push({
        id: `folder:${path}`,
        kind: 'folder',
        own: true,
        unmerged: files > 0, // AIB cannot tell what these files are: never removed silently
        files,
        title: entry.name,
        helper: entry.name.startsWith('helper-'),
        clash: false,
        live: isLive(path, ''),
        branch: '',
        path,
        session: '',
      });
    }
  }

  // 5. studio/ branches with no copy: this install's (named in its records) or another's.
  for (const name of lines((await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/studio/'], project)).stdout)) {
    if (handledBranches.has(name)) continue;
    const mine = ownSlugs.has(slugOf(name));
    const files = await branchUnmerged(project, name, '');
    items.push({
      id: `branch:${name}`,
      kind: 'branch',
      own: mine,
      unmerged: files !== 0,
      files: Math.max(0, files),
      title: helperBranches.get(name) || name,
      helper: name.startsWith('studio/helper-') || helperBranches.has(name),
      clash: false,
      live: false,
      branch: name,
      path: '',
      session: '',
    });
    handledBranches.add(name);
  }

  // 6. refs/studio/<slug>/* of a branch that is gone (a U pin left behind). Removed with their branch otherwise.
  for (const ref of lines((await git(['for-each-ref', '--format=%(refname)', 'refs/studio/'], project)).stdout)) {
    const slug = refSlug(ref);
    if (!slug || handledBranches.has(`studio/${slug}`)) continue;
    items.push({
      id: `ref:${ref}`,
      kind: 'ref',
      own: ownSlugs.has(slug),
      unmerged: false,
      files: 0,
      title: ref,
      helper: slug.startsWith('helper-'),
      clash: false,
      live: false,
      branch: '',
      path: '',
      session: '',
    });
  }

  // 7. Stash entries AIB named (5.5).
  const clashes = clashShas(stateDir);
  for (const s of await stashes(project)) {
    const m = STASH_NAMES.exec(s.subject);
    if (!m) continue;
    const slug = m[2] || '';
    const clash = clashes.has(s.sha);
    // studio-merge-<slug>-<time>: this install's when the slug is (or the entry is its recorded clash); an undo stash names no
    // chat, so it is this install's only when recorded (a kept undo stash is logged, never recorded: never dropped silently).
    const mine = clash || (!!slug && ownSlugs.has(slug));
    const applied = !clash && (await stashApplied(project, s.sha));
    items.push({
      id: `stash:${s.sha}`,
      kind: 'stash',
      own: mine,
      unmerged: !applied,
      files: 0,
      title: m[1],
      helper: slug.startsWith('helper-'),
      clash: clash || !applied,
      live: false,
      branch: '',
      path: '',
      session: '',
    });
  }
  return { project, skipped: '', items };
}

function folderFileCount(path: string, limit = 1000): number {
  let n = 0;
  const walk = (dir: string) => {
    for (const e of Deno.readDirSync(dir)) {
      if (n >= limit) return;
      if (e.name === '.git' && !e.isDirectory) continue; // the worktree link file
      if (e.isDirectory && !e.isSymlink) walk(pathOf(dir, e.name));
      else n++;
    }
  };
  try {
    walk(path);
  } catch {
    return limit;
  }
  return n;
}

/** Removed silently: this install's, not running, no unmerged work. */
export const silent = (i: CleanupItem) => i.own && !i.unmerged && !i.live;
/** What the confirm lists: this install's unmerged work (ticked) and another install's items (unticked). Never running ones. */
export const needsConfirm = (i: CleanupItem) => !i.live && (!i.own || i.unmerged);

export interface ApplyResult {
  removed: string[];
  /** id -> why it was left (in use, git refused). */
  left: Record<string, string>;
}

/**
 * Remove the silent items plus the confirm items whose id is in `ticked`, under the repo lock, after scanning again (an id that is
 * no longer found, or is now running, is left). Never a running chat's copy; never the project folder itself.
 */
export async function applyProject(
  stateDir: string,
  project: string,
  ticked: Iterable<string> = [],
  options: ScanOptions & { only?: Iterable<string> } = {},
): Promise<ApplyResult & { scan: Scan }> {
  const want = new Set(ticked);
  const only = options.only ? new Set(options.only) : null;
  return await repoLock(project).run(async () => {
    const scan = await scanProject(stateDir, project, options);
    const result: ApplyResult = { removed: [], left: {} };
    if (scan.skipped) return { ...result, scan };
    const manager = new wt.Manager(stateDir);
    const chosen = scan.items.filter((i) =>
      !i.live && (only ? only.has(i.id) && (silent(i) || want.has(i.id)) : silent(i) || want.has(i.id))
    );
    // copies before branches before refs (a branch checked out in a copy cannot be deleted first); stashes last
    const order: Record<ItemKind, number> = { copy: 0, folder: 1, branch: 2, ref: 3, stash: 4 };
    chosen.sort((a, b) => order[a.kind] - order[b.kind]);
    for (const item of chosen) {
      try {
        const why = await removeItem(manager, scan.project, item);
        if (why) result.left[item.id] = why;
        else result.removed.push(item.id);
      } catch (error) {
        result.left[item.id] = error instanceof Error ? error.message : String(error);
      }
    }
    if (result.removed.length) await git(['worktree', 'prune'], scan.project);
    return { ...result, scan };
  });
}

async function dropRefs(project: string, branch: string): Promise<void> {
  const slug = slugOf(branch);
  if (!slug) return;
  for (const ref of lines((await git(['for-each-ref', '--format=%(refname)', `refs/studio/${slug}/`], project)).stdout)) {
    await git(['update-ref', '-d', ref], project);
  }
}

/** '' when removed, else why not. */
async function removeItem(manager: wt.Manager, project: string, item: CleanupItem): Promise<string> {
  switch (item.kind) {
    case 'copy': {
      if (item.id.startsWith('copy:')) {
        const key = item.id.slice('copy:'.length);
        const outcome = await manager.remove(key, true); // writes the removed-note: the chat reads "workspace removed"
        if (outcome === 'pending') return 'in use; removal is retried at the next start';
        await dropRefs(project, item.branch);
        return '';
      }
      // a copy without a record: git's own removal; only a studio/ branch goes with it
      if (item.own || item.path) {
        if (wt.same(item.path, project)) return 'the project folder itself';
        await git(['worktree', 'remove', '--force', item.path], project);
        if (wt.lexists(item.path) && item.own) {
          try {
            wt.rmtree(item.path);
          } catch { /* in use */ }
        }
        if (wt.lexists(item.path)) return 'in use';
      }
      await git(['worktree', 'prune'], project);
      return await removeBranch(project, item.branch);
    }
    case 'folder': {
      if (!manager.insideRoot(item.path)) return "not under AIB's worktrees folder";
      try {
        wt.rmtree(item.path);
      } catch (error) {
        return error instanceof Error ? error.message : 'in use';
      }
      return '';
    }
    case 'branch':
      return await removeBranch(project, item.branch);
    case 'ref':
      await git(['update-ref', '-d', item.title], project);
      return '';
    case 'stash': {
      const sha = item.id.slice('stash:'.length);
      for (const s of await stashes(project)) {
        if (s.sha === sha) {
          const done = await git(['stash', 'drop', s.ref], project);
          return done.returncode === 0 ? '' : pyStrip(done.stderr) || 'git refused';
        }
      }
      return '';
    }
  }
}

async function removeBranch(project: string, branch: string): Promise<string> {
  if (!branch.startsWith('studio/')) return '';
  if (await refExists(project, `refs/heads/${branch}`)) {
    const done = await git(['branch', '-D', branch], project);
    if (done.returncode !== 0) return pyStrip(done.stderr) || 'git refused';
  }
  await dropRefs(project, branch);
  return '';
}

// ---- what the confirm says -----------------------------------------------------------------------------------------------
/** The public form of an item for a page (the confirm list, the card). */
export function publicItem(i: CleanupItem): Record<string, unknown> {
  return {
    id: i.id,
    kind: i.kind,
    own: i.own,
    unmerged: i.unmerged,
    files: i.files,
    title: i.title,
    helper: i.helper,
    clash: i.clash,
  };
}

/** What a project's confirm needs: the items to tick (own unmerged ticked, another install's unticked) and the silent count. */
export function confirmView(scan: Scan): { items: Record<string, unknown>[]; silent: number; skipped: string } {
  return {
    items: scan.items.filter(needsConfirm).map(publicItem),
    silent: scan.items.filter(silent).length,
    skipped: scan.skipped,
  };
}

// ---- the one-time cleanup (5.6) -------------------------------------------------------------------------------------------
export const ONCE_FILE = 'cleanup-once.json';
export const LOG_FILE = 'cleanup.log';
/** Bump to run the one-time cleanup once more on the next start (a later release with more to tidy). */
export const ONCE_VERSION = 1;

export interface CardItem extends Record<string, unknown> {
  id: string;
  project: string;
  title: string;
  files: number;
  helper: boolean;
}
export interface OnceState {
  version: number;
  doneAt: number;
  /** The card: orphans with unmerged work found by the one-time cleanup; null once answered (or none found). */
  card: { items: CardItem[]; at: number } | null;
  answered: '' | 'removed' | 'kept';
}

export function readOnce(stateDir: string): OnceState | null {
  const [status, raw] = readJsonFile(pathOf(stateDir, ONCE_FILE));
  if (status !== 'ok' || !isDict(raw) || typeof raw.version !== 'number') return null;
  const card = isDict(raw.card) && Array.isArray(raw.card.items)
    ? { items: (raw.card.items as unknown[]).filter(isDict) as CardItem[], at: Number(raw.card.at) || 0 }
    : null;
  return {
    version: raw.version,
    doneAt: Number(raw.doneAt) || 0,
    card,
    answered: raw.answered === 'removed' || raw.answered === 'kept' ? raw.answered : '',
  };
}

function writeOnce(stateDir: string, state: OnceState): void {
  saveJson(pathOf(stateDir, ONCE_FILE), state, '.cleanup-once-');
}

/** One line in <AIB data>\cleanup.log (never throws). */
export function logLine(stateDir: string, text: string): void {
  try {
    Deno.writeTextFileSync(pathOf(stateDir, LOG_FILE), `${new Date().toISOString()} ${text}\n`, { append: true });
  } catch { /* the log is a nicety */ }
  log.info(text);
}

export interface OnceOptions {
  /** Every added project (Windows paths; WSL refs are handled by `wsl`). */
  projects: string[];
  /** Running chats' folders and provider:sessionId (after the keeper take-over). */
  live?: Iterable<string>;
  titles?: Record<string, string>;
  /** WSL projects: scan and remove inside the distro (wsl/worktrees.ts). Absent: WSL refs are skipped. */
  wsl?: (ref: string, ticked: string[], silentOnly: boolean, live: string[]) => Promise<{ scan: Scan; removed: string[] } | null>;
}

/**
 * The one-time cleanup: at the first start after the update (ONCE_VERSION), after the keeper take-over. Removes this install's
 * leftovers without unmerged work silently, and keeps a card for the ones with work (one card for all; "Keep" never brings it back).
 * Returns the state written, or null when it already ran.
 */
export async function runOnce(stateDir: string, options: OnceOptions): Promise<OnceState | null> {
  const before = readOnce(stateDir);
  if (before && before.version >= ONCE_VERSION) return null;
  const manager = new wt.Manager(stateDir);
  const projects = new Map<string, string>();
  for (const p of [...options.projects, ...Object.values(manager.registry.all()).map((r) => str(r.project))]) {
    if (p) projects.set(p.startsWith('wsl://') ? p : normcase(p), p);
  }
  const live = [...(options.live ?? [])];
  const card: CardItem[] = [];
  for (const project of projects.values()) {
    try {
      let scan: Scan, removed: string[];
      if (project.startsWith('wsl://')) {
        const done = options.wsl ? await options.wsl(project, [], true, live) : null;
        if (!done) continue;
        ({ scan, removed } = done);
      } else {
        const done = await applyProject(stateDir, project, [], { live, titles: options.titles });
        scan = done.scan;
        removed = done.removed;
        for (const [id, why] of Object.entries(done.left)) logLine(stateDir, `one-time cleanup: ${project}: left ${id}: ${why}`);
      }
      if (scan.skipped) {
        logLine(stateDir, `one-time cleanup: skipped ${project}: ${scan.skipped}`);
        continue;
      }
      for (const id of removed) logLine(stateDir, `one-time cleanup: ${project}: removed ${id}`);
      for (const i of scan.items) {
        if (i.own && i.unmerged && !i.live) card.push({ id: i.id, project, title: i.title, files: i.files, helper: i.helper });
      }
    } catch (error) {
      logLine(stateDir, `one-time cleanup: ${project} failed: ${error instanceof Error ? error.message : error}`);
    }
  }
  const state: OnceState = {
    version: ONCE_VERSION,
    doneAt: Date.now() / 1000,
    card: card.length ? { items: card, at: Date.now() / 1000 } : null,
    answered: '',
  };
  writeOnce(stateDir, state);
  logLine(stateDir, `one-time cleanup done: ${projects.size} repo(s), ${card.length} old copy(ies) with unmerged work kept for the card`);
  return state;
}

/** The card the page shows (start page / Inbox), or null. */
export function cardOf(stateDir: string): { items: CardItem[]; text: string } | null {
  const state = readOnce(stateDir);
  if (!state || !state.card || state.answered) return null;
  return { items: state.card.items, text: cardText(state.card.items) };
}

/** "AIB found 2 old chat copies with work that was never merged: "Fix login" (4 files), helper "Add tests"." */
export function cardText(items: { title: string; files: number; helper: boolean }[]): string {
  const n = items.length;
  const shown = items.slice(0, 5).map((i) =>
    (i.helper ? 'helper ' : '') + `"${i.title}"` + (i.files ? ` (${i.files} file${i.files === 1 ? '' : 's'})` : '')
  );
  const more = n > 5 ? ` and ${n - 5} more` : '';
  return `AIB found ${n === 1 ? '1 old chat copy' : `${n} old chat copies`} with work that was never merged: ${shown.join(', ')}${more}.`;
}

/**
 * The card's answer. 'keep': nothing is removed and the card never comes back (they come up again only on project removal).
 * 'remove': those items are removed (scanned again first: only this install's, not running).
 */
export async function answerCard(
  stateDir: string,
  action: 'remove' | 'keep',
  options: Pick<OnceOptions, 'live' | 'wsl'> = {},
): Promise<{ removed: string[]; left: Record<string, string> }> {
  const state = readOnce(stateDir);
  const out = { removed: [] as string[], left: {} as Record<string, string> };
  if (!state || !state.card || state.answered) return out;
  if (action === 'remove') {
    const byProject = new Map<string, string[]>();
    for (const i of state.card.items) byProject.set(i.project, [...(byProject.get(i.project) ?? []), i.id]);
    const live = [...(options.live ?? [])];
    for (const [project, ids] of byProject) {
      if (project.startsWith('wsl://')) {
        const done = options.wsl ? await options.wsl(project, ids, false, live) : null;
        if (done) out.removed.push(...done.removed);
        continue;
      }
      const done = await applyProject(stateDir, project, ids, { live, only: ids });
      out.removed.push(...done.removed.filter((id) => ids.includes(id)));
      Object.assign(out.left, done.left);
    }
    for (const id of out.removed) logLine(stateDir, `cleanup card: removed ${id}`);
  } else logLine(stateDir, 'cleanup card: kept');
  writeOnce(stateDir, { ...state, answered: action === 'remove' ? 'removed' : 'kept' });
  return out;
}

// ---- every project (uninstall, 5.7) ---------------------------------------------------------------------------------------
/** The repos this install keeps copies of (its registry), whether or not they are still added projects. */
export function recordedProjects(stateDir: string): string[] {
  const out = new Map<string, string>();
  for (const r of Object.values(new wt.Manager(stateDir).registry.all())) {
    const p = str(r.project);
    if (p && !p.startsWith('wsl://')) out.set(normcase(p), p);
  }
  return [...out.values()];
}

/** Scan every project (the uninstall confirm lists unmerged copies across all projects, once). */
export async function scanAll(stateDir: string, projects: string[], options: ScanOptions = {}): Promise<Scan[]> {
  const manager = new wt.Manager(stateDir);
  const all = new Map<string, string>();
  for (const p of [...projects, ...Object.values(manager.registry.all()).map((r) => str(r.project))]) {
    if (p && !p.startsWith('wsl://')) all.set(normcase(p), p);
  }
  const out: Scan[] = [];
  for (const p of all.values()) out.push(await scanProject(stateDir, p, options));
  return out;
}
