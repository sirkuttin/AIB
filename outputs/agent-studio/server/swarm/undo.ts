/**
 * Swarm phase 1: Undo of a helper's merge and Merge again (review break 13). Never rewrites history: Undo adds one commit on the main
 * branch that takes back exactly what the merge landed; Merge again adds one that takes back the Undo. Both are built with no work tree
 * (`git merge-tree --write-tree` → `commit-tree`), so a later change to the same lines shows as "can't undo cleanly" and nothing changes.
 * The main branch then moves the way Merge moves it (worktrees/merge.ts): under the repository lock and the "sync paused" flag, a
 * fast-forward in the folder that has it checked out, with the user's uncommitted edits set aside by SHA and put back.
 */
import * as wt from '../worktrees/worktrees.ts';
import { baseCheckout, folderState, gitc, porcelainPaths, repoLock, rev, settings } from '../worktrees/merge.ts';
import { pyStrip } from '../core/py.ts';
import { getLogger } from '../core/log.ts';

const log = getLogger('swarm_undo');

export type Outcome = { state: 'done'; commit: string; tip: string; kept: string } | { state: 'conflicts'; files: string[] } | {
  state: 'refused';
  message: string;
};

const nul = (t: string) => t.split('\0').filter(Boolean);

/**
 * One commit on `branch` that applies the change from tree `from` to tree `to` (Undo: from = landed, to = the tip before the merge),
 * three-way against the branch's tip now. Fast-forwards the branch; returns the commit, or the conflicting files.
 */
export async function applyChange(
  stateDir: string,
  project: string,
  branch: string,
  from: string,
  to: string,
  message: string,
): Promise<Outcome> {
  return await repoLock(project).run(async (): Promise<Outcome> => {
    const tip = await rev(project, `refs/heads/${branch}`);
    if (!tip) return { state: 'refused', message: `The branch ${branch} no longer exists` };
    const built = await wt.git(
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', `--merge-base=${from}`, tip, to],
      project,
      { check: false },
    );
    const lines = built.stdout.split(/\r?\n/);
    if (built.returncode === 1) {
      const files = lines.slice(1).filter(Boolean);
      return { state: 'conflicts', files: files.length ? files : ['(see git status)'] };
    }
    if (built.returncode !== 0) return { state: 'refused', message: 'git merge-tree failed: ' + pyStrip(built.stderr).slice(-300) };
    const tree = pyStrip(lines[0]);
    const commit = pyStrip((await gitc(['commit-tree', tree, '-p', tip, '-m', message], project)).stdout);
    const folder = await baseCheckout(project, branch);
    if (!folder) {
      const done = await wt.git(['update-ref', `refs/heads/${branch}`, commit, tip], project, { check: false });
      return done.returncode === 0
        ? { state: 'done', commit, tip, kept: '' }
        : { state: 'refused', message: `${branch} changed meanwhile` };
    }
    const busy = await folderState(folder);
    if (busy) return { state: 'refused', message: busy[0].toUpperCase() + busy.slice(1) };
    const pause = wt.pauseLock(stateDir, project, settings.LOCK_WAIT);
    try {
      await pause.acquire();
    } catch {
      return { state: 'refused', message: 'AIB is still copying edits for this project; try again' };
    }
    try {
      let stash = '';
      if ((await porcelainPaths(folder)).size) {
        const name = `aib-swarm-undo-${Math.floor(Date.now() / 1000)}`;
        await wt.git(['stash', 'push', '-u', '-m', name], folder);
        stash = pyStrip((await wt.git(['rev-parse', '--verify', '-q', 'stash@{0}'], folder, { check: false })).stdout);
        const subject = pyStrip((await wt.git(['log', '-1', '--format=%s', 'stash@{0}'], folder, { check: false })).stdout);
        if (!stash || !subject.includes(name)) {
          return { state: 'refused', message: 'Could not set aside your uncommitted edits; nothing changed' };
        }
      }
      const ff = await wt.git(['merge', '--ff-only', commit], folder, { check: false });
      let kept = '';
      if (stash) {
        const back = await wt.git(['stash', 'apply', '--index', stash], folder, { check: false });
        if (back.returncode === 0) await dropStash(folder, stash);
        else {
          kept = stash;
          log.warning('Your edits clash with the undo; they are kept in stash %s', stash);
        }
      }
      if (ff.returncode !== 0) {
        return { state: 'refused', message: `Could not move ${branch}: a local edit is in the way. Nothing changed` };
      }
      return { state: 'done', commit, tip, kept };
    } finally {
      pause.release();
    }
  });
}

async function dropStash(folder: string, sha: string): Promise<void> {
  for (const line of (await wt.git(['stash', 'list', '--format=%H %gd'], folder, { check: false })).stdout.split(/\r?\n/)) {
    const [found, ref] = line.split(' ');
    if (found === sha && ref) {
      await wt.git(['stash', 'drop', ref], folder, { check: false });
      return;
    }
  }
}

/** The files a range changed (for the "can't undo cleanly" line when merge-tree names none). */
export async function changedFiles(project: string, a: string, b: string): Promise<string[]> {
  return nul((await wt.git(['diff', '--name-only', '-z', a, b], project, { check: false })).stdout);
}
