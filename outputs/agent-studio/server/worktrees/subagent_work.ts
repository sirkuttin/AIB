/**
 * The git side of handing unlanded work to the main agent (swarm/service.ts #handOff and the unlanded_work tool), run natively where
 * the repository is: in the web process for a Windows or Linux project, in the distro's helper for a WSL project (`subagent.work`).
 * Read-only except `keepWork`, which only adds a branch. Nothing here touches the worktree's files or the folder.
 *
 *   workStatus  what the copy holds that main does not: the files its work changed (a snapshot of the worktree, uncommitted work
 *               included, against its start S) and whether main has that work already (landed.ts, by content).
 *   workDiff    the same work as a patch: a short stat and the start of the patch for the chat, the whole patch in a file the main
 *               agent can `git apply` in its own folder (merge by hand).
 *   keepWork    discard: the work (uncommitted included) is committed on a branch `studio/discarded/<name>` so it stays recoverable;
 *               the caller then removes the copy through the normal release.
 */
import * as wt from './worktrees.ts';
import { branchLanded } from './landed.ts';
import { porcelainPaths } from './merge.ts';
import { pyStr } from '../core/py.ts';
import { dirname } from '../platform/ospath.ts';

export interface WorkSpec {
  /** The copy's worktree, the repository folder it came from, its start S (the snapshot) and its branch. */
  path: string;
  folder: string;
  start: string;
  branch: string;
  title: string;
  /** A folder for temporary files (AIB's state folder, or the helper's data folder). */
  scratchDir: string;
}

const nul = (t: string) => t.split('\0').filter(Boolean);
/** How much of a patch goes into the chat's tool answer: the rest is in the patch file. */
export const PATCH_SHOWN = 24_000;

async function snapshot<T>(spec: WorkSpec, use: (head: string) => Promise<T>): Promise<T> {
  Deno.mkdirSync(spec.scratchDir, { recursive: true });
  const scratch = Deno.makeTempDirSync({ prefix: '.unlanded-', dir: spec.scratchDir });
  try {
    return await use(await wt.snapshotCommit(spec.path, scratch));
  } finally {
    try {
      Deno.removeSync(scratch, { recursive: true });
    } catch { /* gone */ }
  }
}

/** The start to diff against: S, else the branch's merge-base with main for an old record. */
async function startOf(spec: WorkSpec): Promise<string> {
  if (spec.start) return spec.start;
  const target = await wt.mainBranch(spec.folder, '');
  const base = target ? pyStr((await wt.git(['merge-base', `refs/heads/${target}`, 'HEAD'], spec.path, { check: false })).stdout).trim() : '';
  return base || 'HEAD';
}

export async function workStatus(spec: WorkSpec): Promise<{ files: string[]; landed: boolean; target: string }> {
  if (!spec.path || !wt.lexists(spec.path) || !spec.folder || !wt.lexists(spec.folder)) return { files: [], landed: false, target: '' };
  const start = await startOf(spec);
  const target = await wt.mainBranch(spec.folder, '');
  const blob = async (rev: string, f: string) => pyStr((await wt.git(['rev-parse', '-q', '--verify', `${rev}:${f}`], spec.folder, { check: false })).stdout).trim();
  const { files, same } = await snapshot(spec, async (head) => {
    const files = nul((await wt.git(['diff', '--name-only', '-z', '--no-renames', start, head], spec.path, { check: false })).stdout);
    // every file it changed is in main as the copy holds it now (merged by hand, or landed squashed): its work is in main
    let same = !!target && files.length > 0;
    for (const f of files) {
      if (!same) break;
      same = (await blob(head, f)) === (await blob(`refs/heads/${target}`, f));
    }
    return { files, same };
  });
  let landed = same;
  if (!landed && target && spec.branch) {
    const verdict = await branchLanded(spec.folder, spec.branch, target, { title: spec.title });
    landed = verdict.landed && (await porcelainPaths(spec.path)).size === 0;
  }
  return { files, landed, target };
}

export interface WorkDiff {
  files: string[];
  stat: string;
  /** The first PATCH_SHOWN characters of the patch. */
  patch: string;
  truncated: boolean;
  patchFile: string;
  target: string;
}

export async function workDiff(spec: WorkSpec, patchFile: string): Promise<WorkDiff> {
  const start = await startOf(spec);
  const target = await wt.mainBranch(spec.folder, '');
  return await snapshot(spec, async (head) => {
    const files = nul((await wt.git(['diff', '--name-only', '-z', '--no-renames', start, head], spec.path, { check: false })).stdout);
    const stat = pyStr((await wt.git(['diff', '--stat', '--no-renames', start, head], spec.path, { check: false })).stdout).trim();
    const raw = await wt.rawGit(['diff', '--binary', '--no-renames', start, head], spec.path);
    Deno.mkdirSync(dirname(patchFile), { recursive: true });
    Deno.writeFileSync(patchFile, raw.out);
    const text = new TextDecoder().decode(raw.out);
    return { files, stat, patch: text.slice(0, PATCH_SHOWN), truncated: text.length > PATCH_SHOWN, patchFile, target };
  });
}

/** Commit the copy's work (uncommitted included) on `studio/discarded/<name>`. Returns the branch, or throws. */
export async function keepWork(spec: WorkSpec, name: string): Promise<{ branch: string; sha: string }> {
  const branch = `studio/discarded/${name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80)}`;
  const sha = await snapshot(spec, async (head) => {
    // the snapshot commit is S plus the work as one commit: a branch at it holds everything the copy held
    await wt.git(['branch', '-f', branch, head], spec.folder);
    return head;
  });
  return { branch, sha };
}
