/**
 * What AIB does to land one subagent's worktree on the folder's branch: its git side, with no registry, no chat and no notes. It runs
 * natively wherever the repository is: in the web process for a Windows or Linux project (swarm/service.ts #landSubagent), and in the
 * distro's helper for a WSL project (wsl/helper/subagents.ts `subagent.land`), so a subagent in WSL lands by exactly the same steps:
 *   a snapshot of its worktree (its uncommitted work included; the worktree is not touched), scratch files and git-ignored files set
 *   aside, work already in the target dropped, the protected-path check, then merge.ts landWorktree (own commits only, no folder
 *   snapshot files), and a clean `-landable` branch when it conflicts.
 * Moved here from swarm/service.ts unchanged in behaviour (owner 2026-11-23: subagents in WSL projects land like the others).
 */
import * as merge from './merge.ts';
import * as wt from './worktrees.ts';
import { pyStr } from '../core/py.ts';
import { pathOf } from '../state/paths.ts';
import { canonicalName } from '../allow/paths.ts';

type Json = Record<string, unknown>;

/** Folders a build or an install makes again on its own: never a reason to keep a subagent's worktree (ignoredFiles). */
export const GENERATED_DIRS = new Set([
  'node_modules', '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', 'dist', 'build', 'target', 'coverage',
  '.cache', '.next', '.turbo', '.parcel-cache', '.gradle', '.deno',
]);
/**
 * Files a subagent made that git ignores (a draft in a git-ignored folder: 2026-11-17, its worktree looked empty, was removed and the
 * draft was lost), as worktree-relative paths: never landed by git, so the worktree that holds them is kept. A worktree starts as a
 * plain `git worktree add` of S plus its `aib-shared` link (no ignored files), so every one is the subagent's; generated folders
 * (GENERATED_DIRS), compiled Python files and anything reached through a link (the `aib-shared` link: those files are already in the main
 * folder) don't count. At most 200 are named.
 */
export async function ignoredFiles(path: string): Promise<string[]> {
  if (!path || !wt.lexists(path)) return [];
  const list = async (extra: string[]) =>
    pyStr((await wt.git(['ls-files', '-z', '--others', '--ignored', '--exclude-standard', ...extra], path, { check: false })).stdout)
      .split('\0').filter((n) => n);
  const generated = (f: string) =>
    f.replace(/\/$/, '').split('/').some((part) => GENERATED_DIRS.has(part)) || /\.py[co]$/.test(f) || throughLink(path, f);
  const out: string[] = [];
  for (const entry of await list(['--directory'])) {
    if (out.length >= 200) break;
    if (generated(entry)) continue;
    if (!entry.endsWith('/')) out.push(entry);
    else for (const f of await list(['--', entry])) if (!generated(f) && out.length < 200) out.push(f);
  }
  return out;
}

/** True when `rel` (worktree-relative, git's form) is a link or lies under one: the `aib-shared` link and what git lists through it. */
function throughLink(path: string, rel: string): boolean {
  const parts = rel.replace(/\/$/, '').split('/').filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    try {
      if (Deno.lstatSync(pathOf(path, ...parts.slice(0, i))).isSymlink) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Pages, notes and pictures: what a read-only or design subagent writes for the main agent to read (a mockup, a review), not a change
 * to the project. Plain .txt and code are never scratch.
 */
export const SCRATCH_EXT = /\.(html?|md|markdown|png|jpe?g|gif|webp|svg|pdf|log)$/i;

/**
 * Bug 2026-11-16 (scratch files landed: inbox-v31-design.html, hidden-actions-audit.html, architect-review-v2.md, file-editor-design-v2.md
 * went into the project's main as "AIB: subagent ..." commits). Of a subagent's changes (`changed`, S to its head), the scratch files:
 * new since S, at the top of its worktree (no folder), with a page / note / picture extension (SCRATCH_EXT), and never committed by
 * the subagent (a file it committed is work it meant to keep). They never land by themselves and are never lost: they stay in its
 * worktree, which is kept while they are there, and the main agent is told (copy them, or merge_helper lands them too).
 */
export async function scratchFiles(path: string, start: string, changed: string[]): Promise<string[]> {
  const top = changed.filter((f) => !f.includes('/') && SCRATCH_EXT.test(f));
  if (!top.length) return [];
  const listed = async (rev: string) =>
    new Set(pyStr((await wt.git(['ls-tree', '--name-only', '-z', rev, '--', ...top], path, { check: false })).stdout).split('\0').filter((n) => n));
  const inStart = await listed(start), committed = await listed('HEAD');
  return top.filter((f) => !inStart.has(f) && !committed.has(f));
}

/** `head` without `paths` (a commit on the same parent, built in a temporary index): what lands when scratch files stay behind. */
async function withoutPaths(path: string, head: string, paths: string[], scratchDir: string): Promise<string> {
  const env = { GIT_INDEX_FILE: pathOf(scratchDir, 'scratch-index') };
  await wt.git(['read-tree', head], path, { env });
  await wt.git(['update-index', '--force-remove', '--', ...paths], path, { env });
  const tree = pyStr((await wt.git(['write-tree'], path, { env })).stdout).trim();
  return pyStr((await wt.git(['commit-tree', tree, '-p', `${head}^`, '-m', 'AIB snapshot'], path, { env, identity: true })).stdout).trim();
}

/**
 * Design 2.4: paths a subagent's landing never carries by itself (git hooks, agent and editor configs; a Bash redirect could plant
 * one): any folder segment named so, or a git attributes / modules / config file at any depth.
 */
const PROTECTED_DIRS = new Set(['.git', '.claude', '.husky', '.githooks', '.vscode', '.codex', '.gemini', '.cursor', '.idea']);
const PROTECTED_FILES = new Set(['.gitattributes', '.gitmodules', '.gitconfig']);
export function protectedPath(path: string): boolean {
  const parts = path.split(/[\\/]/).map(canonicalName);
  const last = parts[parts.length - 1];
  return parts.slice(0, -1).some((p) => PROTECTED_DIRS.has(p)) || PROTECTED_DIRS.has(last) || PROTECTED_FILES.has(last);
}


const nulList = (t: string) => t.split('\0').filter(Boolean);
async function changedBetween(project: string, a: string, b: string): Promise<string[]> {
  return nulList((await wt.git(['diff', '--name-only', '-z', a, b], project, { check: false })).stdout);
}

/** The stable patch-id of a diff (git patch-id --stable), '' when git can't say. */
async function patchIdOf(cwd: string, diff: Uint8Array): Promise<string> {
  if (!diff.length) return '';
  const out = await wt.rawGit(['patch-id', '--stable'], cwd, {}, diff).catch(() => null);
  return out && out.returncode === 0 ? pyStr(out.stdout).trim().split(/\s+/)[0] ?? '' : '';
}

/**
 * True when the changes `start..head` are already on `target` as a commit with the same patch-id (the main agent landed the work by
 * hand, and other commits touched the same files since, so a file comparison sees a difference and a merge sees a conflict;
 * 2026-11-23: a builder's late landing reported a conflict with its own hand-made landing). Looks at the last 200 commits since `start`.
 */
export async function landedByHand(folder: string, path: string, start: string, head: string, target: string): Promise<boolean> {
  const mine = await wt.rawGit(['diff', '--no-renames', start, head], path).catch(() => null);
  if (!mine || mine.returncode !== 0) return false;
  const want = await patchIdOf(folder, mine.out);
  if (!want) return false;
  const list = await wt.git(['rev-list', '--no-merges', '-n', '200', `${start}..refs/heads/${target}`], folder, { check: false });
  for (const c of pyStr(list.stdout).split('\n').map((l) => l.trim()).filter(Boolean)) {
    const theirs = await wt.rawGit(['diff', '--no-renames', `${c}^`, c], folder).catch(() => null);
    if (theirs && theirs.returncode === 0 && (await patchIdOf(folder, theirs.out)) === want) return true;
  }
  return false;
}

/** What the landing needs of one subagent. */
export interface LandSpec {
  /** A folder for this landing's temporary files (AIB's state folder, or the helper's data folder). */
  scratchDir: string;
  path: string;
  folder: string;
  target: string;
  branch: string;
  parent: string;
  key: string;
  title: string;
  start: string;
  held: string[];
  /** Its scratch files that an earlier landing left behind and merge_helper asked for: only they land now (null: the normal landing). */
  landKept: string[] | null;
  landScratch: boolean;
}

/**
 * One landing. The outcome is the swarm's: {state: 'scratch' | 'empty' | 'refused' | 'conflicts' | 'merged', ...}. A `merged` outcome
 * also carries `tipBefore` and `landed` (the caller records them); `refused` carries the code and message of merge.ts' Refused.
 */
export async function landSubagentWork(
  studio: merge.MergeStudio,
  spec: LandSpec,
  journal: (stage: string, data: Record<string, unknown>) => void | Promise<void>,
): Promise<Json> {
  const { path, folder, target } = spec;
  if (!path || !wt.lexists(path)) return { state: 'refused', code: 'gone', message: 'its worktree is gone' };
  Deno.mkdirSync(spec.scratchDir, { recursive: true });
  const scratch = Deno.makeTempDirSync({ prefix: '.subagent-land-', dir: spec.scratchDir });
  let head: string;
  let start = spec.start;
  let changed: string[];
  let kept: string[] = [];
  let ignored: string[] = []; // files it made that git ignores: they can't land, so its worktree is kept for them
  try {
    head = await wt.snapshotCommit(path, scratch);
    const diff = async (from: string) =>
      (await wt.git(['diff', '--name-only', '-z', '--no-renames', from, head], path)).stdout.split('\0').filter((n) => n);
    changed = await diff(start);
    if (spec.landKept) {
      start = await withoutPaths(path, head, spec.landKept.filter((f) => changed.includes(f)), scratch);
      changed = await diff(start);
    } else if (!spec.landScratch) {
      ignored = await ignoredFiles(path);
      kept = await scratchFiles(path, start, changed);
      if (kept.length && kept.length === changed.length) return { state: 'scratch', files: [...kept, ...ignored] };
      if (kept.length) {
        head = await withoutPaths(path, head, kept, scratch);
        changed = changed.filter((f) => !kept.includes(f));
      }
    }
  } finally {
    try {
      Deno.removeSync(scratch, { recursive: true });
    } catch { /* gone */ }
  }
  // Work already in the target (the main agent merged the branch by hand, or made the same change): nothing to land, no conflict to
  // report. A branch tip that is an ancestor of the target is landed already, so only what the worktree added after it can still land.
  const branchTip = spec.branch ? await merge.rev(folder, `refs/heads/${spec.branch}`) : '';
  if (branchTip && (await merge.isAncestor(folder, branchTip, `refs/heads/${target}`))) {
    start = branchTip;
    changed = (await wt.git(['diff', '--name-only', '-z', '--no-renames', start, head], path)).stdout.split('\0').filter((n) => n);
  }
  if (changed.length) {
    const blob = async (rev: string, f: string) => pyStr((await wt.git(['rev-parse', '-q', '--verify', `${rev}:${f}`], folder, { check: false })).stdout).trim();
    let same = true;
    for (const f of changed) {
      if ((await blob(head, f)) !== (await blob(`refs/heads/${target}`, f))) {
        same = false;
        break;
      }
    }
    if (same) changed = [];
  }
  if (!changed.length) return { state: 'empty', kept: [...kept, ...ignored] };
  const hit = changed.filter(protectedPath);
  if (hit.length) return { state: 'refused', code: 'protected', message: 'it changed protected files', files: hit };
  // design 3.5: it changed a file the folder has uncommitted (changed, staged or untracked): nothing lands, nothing is stashed. Checked
  // by merge.ts landHeld on what would really land (touchedDirty, tip to landed): files that only came from the folder's own
  // uncommitted state (the worktree's snapshot, a builder branch it merged) are left out of the landing and are not a reason to refuse.
  // Only a first guess: the tip the landing really built on is the one read under the repository lock, which the journal tells
  // (owner 2026-11-23: another merge landing between this read and the lock was undone with this one).
  let tipBefore = await merge.rev(folder, `refs/heads/${target}`);
  let result: Json;
  try {
    result = await merge.landWorktree(
      studio,
      { parent: spec.held[0] ?? spec.parent, key: spec.key, worktree: path, project: folder, start, head, landOn: target },
      spec.title,
      {
        held: spec.held,
        journal: (stage, data) => {
          if (typeof data.tipBefore === 'string' && data.tipBefore) tipBefore = data.tipBefore;
          return journal(stage, data);
        },
      },
    );
  } catch (error) {
    if (error instanceof merge.Refused) {
      if (error.code === 'empty') return { state: 'empty', kept: [...kept, ...ignored] };
      const files = error instanceof merge.TouchedDirty ? error.files : undefined;
      return { state: 'refused', code: error.code, message: error.message, ...(files ? { files } : {}) };
    }
    throw error;
  }
  if (result.state === 'conflicts') {
    if (await landedByHand(folder, path, start, head, target)) return { state: 'empty', alreadyLanded: true, kept: [...kept, ...ignored] };
    // the main agent merges it by hand: the builder's own branch starts with a snapshot of the folder's uncommitted files, so a
    // clean branch of only its own changes is made for that
    const landable = spec.branch
      ? await merge.landableBranch({ project: folder, worktree: path, start, head, branch: spec.branch }, spec.title).catch(() => '')
      : '';
    return { state: 'conflicts', files: result.files, target, landable };
  }
  const landed = typeof result.tip === 'string' ? result.tip : '';
  const files = tipBefore && landed ? await changedBetween(folder, tipBefore, landed) : [];
  return { state: 'merged', commits: 1, range: [tipBefore, landed], target, files, kept: [...kept, ...ignored], tipBefore, landed };
}
