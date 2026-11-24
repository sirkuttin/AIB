/**
 * Swarm phase 1: Undo of a helper's merge and Merge again (review break 13). Never rewrites history: Undo adds one commit on the main
 * branch that takes back exactly what the merge landed; Merge again adds one that takes back the Undo. Both are built with no work tree
 * (`git merge-tree --write-tree` → `commit-tree`), so a later change to the same lines shows as "can't undo cleanly" and nothing changes.
 * The main branch then moves the way Merge moves it (worktrees/merge.ts): under the repository lock and the "sync paused" flag, a
 * fast-forward in the folder that has it checked out, with the user's uncommitted edits set aside by SHA and put back.
 */
import * as wt from '../worktrees/worktrees.ts';
import {
  baseCheckout,
  folderState,
  gitc,
  holdFolderChats,
  type MergeHost,
  porcelainPaths,
  Refused,
  repoLock,
  rev,
  settings,
  touchedDirty,
} from '../worktrees/merge.ts';
import type { Held } from '../worktrees/landing_lock.ts';
import { pyStrip } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { emitFilesChanged } from '../files/files_changed.ts';

const log = getLogger('swarm_undo');

export type Outcome =
  | { state: 'done'; commit: string; tip: string; kept: string; files: string[] }
  | { state: 'conflicts'; files: string[] }
  | { state: 'refused'; message: string; code?: string }
  | { state: 'dirty'; files: string[] };

/**
 * Build plan 2.3 / 2.5 (MF 8):
 * - noStash: the helper's parent works in the project folder: never stash its files. Refused ('dirty') when the change touches a file
 *   the folder has uncommitted; otherwise git keeps the dirty files the fast-forward doesn't touch.
 * - host / held: the chats that work in the folder are held (the landing lock) while the branch moves; refused when one works.
 */
export interface ApplyOptions {
  noStash?: boolean;
  host?: MergeHost;
  held?: string[];
  title?: string;
}

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
  options: ApplyOptions = {},
): Promise<Outcome> {
  return await repoLock(project).run(async (): Promise<Outcome> => {
    const folder = await baseCheckout(project, branch);
    let holds: Held | null = null;
    if (folder && options.host) {
      try {
        holds = await holdFolderChats(options.host, folder, options.title ?? '', options.held ?? [], `undo:${project}`);
      } catch (error) {
        if (error instanceof Refused) return { state: 'refused', message: error.message, code: error.code };
        throw error;
      }
    }
    let out: Outcome;
    try {
      out = await applyHeld(stateDir, project, branch, from, to, message, folder, options);
    } finally {
      await holds?.release();
    }
    // the file editor's open files in that folder take the new version in (files/files_changed.ts; review must-fix 7)
    if (folder && out.state === 'done') emitFilesChanged({ folder, paths: out.files, who: options.title ?? '', kind: 'undo' });
    return out;
  });
}

async function applyHeld(
  stateDir: string,
  project: string,
  branch: string,
  from: string,
  to: string,
  message: string,
  folder: string | null,
  options: ApplyOptions,
): Promise<Outcome> {
  {
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
    const files = await changedFiles(project, tip, commit);
    if (!folder) {
      const done = await wt.git(['update-ref', `refs/heads/${branch}`, commit, tip], project, { check: false });
      return done.returncode === 0
        ? { state: 'done', commit, tip, kept: '', files }
        : { state: 'refused', message: `${branch} changed meanwhile` };
    }
    const busy = await folderState(folder);
    if (busy) return { state: 'refused', message: busy[0].toUpperCase() + busy.slice(1), code: 'locked' };
    if (options.noStash) {
      const hit = await touchedDirty(folder, tip, commit);
      if (hit.length) return { state: 'dirty', files: hit };
      const pause = wt.pauseLock(stateDir, project, settings.LOCK_WAIT);
      try {
        await pause.acquire();
      } catch {
        return { state: 'refused', message: 'AIB is still copying edits for this project; try again', code: 'busy' };
      }
      try {
        const ff = await wt.git(['merge', '--ff-only', commit], folder, { check: false });
        if (ff.returncode !== 0) {
          return { state: 'refused', message: `Could not move ${branch}: a local edit is in the way. Nothing changed`, code: 'ff_failed' };
        }
        return { state: 'done', commit, tip, kept: '', files };
      } finally {
        pause.release();
      }
    }
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
      return { state: 'done', commit, tip, kept, files };
    } finally {
      pause.release();
    }
  }
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
