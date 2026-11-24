/**
 * What git is doing in a project folder, for the docs sync (sync between PCs): a docs file that git rewrites on purpose (a checkout, a
 * merge, a rebase, a stash) must not travel to the other PC as if somebody had edited it. Reads only files under .git; never runs git
 * except for the one-time autostash setting.
 */
import * as osp from '../platform/ospath.ts';
import { runGit } from '../worktrees/changes.ts';

/** The folders that hold this project's git state: the common git dir, and the work tree's own (a linked worktree has one). */
export function gitDirsOf(folder: string, common = ''): string[] {
  const out: string[] = [];
  if (common) out.push(common);
  try {
    const dot = osp.join(folder, '.git');
    const st = Deno.statSync(dot);
    if (st.isFile) {
      const m = /^gitdir:\s*(.+)$/m.exec(Deno.readTextFileSync(dot));
      if (m) {
        const dir = osp.isabs(m[1].trim()) ? m[1].trim() : osp.join(folder, m[1].trim());
        if (osp.isdir(dir)) out.push(osp.normpath(dir));
      }
    } else if (!common && st.isDirectory) out.push(dot);
  } catch { /* no .git here: the common dir only */ }
  return out;
}

const BUSY: [string, string][] = [
  ['MERGE_HEAD', 'a git merge'],
  ['CHERRY_PICK_HEAD', 'a git cherry-pick'],
  ['REVERT_HEAD', 'a git revert'],
  ['rebase-merge', 'a git rebase'],
  ['rebase-apply', 'a git rebase or am'],
  ['BISECT_LOG', 'a git bisect'],
  ['index.lock', 'a git command'],
];

/** A plain name of what git is in the middle of here ("a git merge"), or null when it is idle. */
export function gitBusy(folder: string, common = ''): string | null {
  for (const dir of gitDirsOf(folder, common)) {
    for (const [name, what] of BUSY) if (osp.exists(osp.join(dir, name))) return what;
  }
  return null;
}

/** The branch this project folder is on (`main`), `detached <sha7>` for a detached HEAD, or null when unreadable. */
export function branchOf(folder: string, common = ''): string | null {
  const dirs = gitDirsOf(folder, common);
  for (const dir of [...dirs].reverse()) {
    try {
      const head = Deno.readTextFileSync(osp.join(dir, 'HEAD')).trim();
      const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      if (m) return m[1].slice(0, 200);
      if (/^[0-9a-f]{7,64}$/.test(head)) return `detached ${head.slice(0, 7)}`;
      if (head.startsWith('ref:')) return head.slice(4).trim().slice(0, 200);
    } catch { /* try the next */ }
  }
  return null;
}

/** True when git tracks something under aib-docs/ in this repo. */
export async function tracksDocs(folder: string): Promise<boolean> {
  const [out, , code] = await runGit(['ls-files', '--', 'aib-docs'], folder, 15, 4096);
  return code === 0 && out.length > 0;
}

/**
 * Turn on repo-local `merge.autoStash` and `rebase.autoStash` when git tracks aib-docs here: both PCs hold the same uncommitted
 * doc, so a `git pull` would otherwise be refused ("local changes would be overwritten"). Only the repo's own config is touched
 * (never the global one); a value the owner already set (true or false) is left as it is. Returns the settings AIB turned on.
 */
export async function ensureAutoStash(folder: string): Promise<string[]> {
  if (!(await tracksDocs(folder))) return [];
  const turned: string[] = [];
  for (const key of ['merge.autoStash', 'rebase.autoStash']) {
    const [cur, , code] = await runGit(['config', '--local', '--get', key], folder, 15, 256);
    if (code === 0 && new TextDecoder().decode(cur).trim() !== '') continue; // the owner already chose
    const [, , set] = await runGit(['config', '--local', key, 'true'], folder, 15, 256);
    if (set === 0) turned.push(key);
  }
  return turned;
}
