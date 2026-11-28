/**
 * The project's shared folder, `aib-shared/` (Deno only; owner decision 2026-11-17). It lives ONLY in the project's main folder; every
 * chat, helper and subagent reads and writes that one folder, also from its own worktree: each worktree AIB makes gets a link named
 * `aib-shared` at the project's place in it, pointing at the main folder's real `aib-shared`:
 *   Windows        a directory junction (no admin rights needed)
 *   WSL / Linux    a symbolic link (made in the distro by its helper, which runs this same module)
 * No copies, no sync: a file written through the link is in the main folder at once. The common .git/info/exclude holds `/aib-shared`
 * in AIB's block (local_only.ts ensureDefault), and the line has no trailing slash, so git ignores the link (a symlink is a file to
 * git) and the junction (a folder to Git for Windows) in every worktree and branch alike.
 *
 * The link is made only while that line is in force (local_only.ts DefaultState 'on'): a project that commits `aib-shared/`, or
 * whose .gitignore turns it back on, gets no link, as it would be committed.
 *
 * Removal: `git worktree remove` and a recursive delete FOLLOW a junction on Windows and empty the real folder. Every removal of a
 * worktree AIB made calls unlinkShared first (the link only, never what it points at) and stops when the link stays.
 */
import * as osp from '../platform/ospath.ts';
import { DEFAULT_ENTRY, type LocalOnly, localOnlyOf } from './local_only.ts';

/** The folder's name (the default local-only entry). */
export const SHARED_DIR = DEFAULT_ENTRY;

export type LinkOutcome = 'linked' | 'kept' | 'off' | 'blocked';

function lstat(path: string): Deno.FileInfo | null {
  try {
    return Deno.lstatSync(path);
  } catch {
    return null;
  }
}

const strip = (p: string) => (p.startsWith('\\\\?\\') ? p.slice(4) : p);
const key = (p: string) => osp.normcase(osp.normpath(strip(p))).replace(/[\\/]+$/, '');

/** Where a worktree's link goes: the project's place in the checkout (`prefix`, '' or 'sub/dir/'), then `aib-shared`. */
export function sharedLinkPath(worktree: string, prefix = ''): string {
  const parts = prefix.split('/').filter(Boolean);
  return osp.join(worktree, ...parts, SHARED_DIR);
}

/** The main folder's real shared folder, '' when the project has none in force (not git, tracked, negated or removed by the user). */
export function sharedDirOf(lo: LocalOnly | null): string {
  if (!lo || lo.defaultState !== 'on') return '';
  const entry = lo.entries.find((e) => e.toLowerCase() === SHARED_DIR) ?? SHARED_DIR;
  return osp.join(lo.project, ...entry.split('/'));
}

/** True when `link` is a link (junction or symlink) whose target is `target`. */
export function linksTo(link: string, target: string): boolean {
  const st = lstat(link);
  if (!st?.isSymlink) return false;
  try {
    let to = Deno.readLinkSync(link);
    if (!osp.isabs(to)) to = osp.join(osp.dirname(link), to);
    return key(to) === key(target);
  } catch {
    return false;
  }
}

/**
 * An OLD build (0.16 betas) gave a Claude builder's worktree a REAL aib-shared/ copy with this note inside (`.aib-seed.json`); that
 * feature is gone (aib-shared is always a link to the main folder's one). Such a folder (a real folder, never a link or junction, with
 * the note in it) is AIB's own copy and is retired with its worktree, or replaced by the link when the worktree is reused. It is moved
 * out of the worktree at once and deleted in the background (it can be gigabytes). A real folder without the note is never touched.
 */
const OLD_COPY_NOTE = '.aib-seed.json';
function retireOldCopy(path: string): boolean {
  const st = lstat(path);
  if (!st?.isDirectory || st.isSymlink || !lstat(osp.join(path, OLD_COPY_NOTE))?.isFile) return false;
  try {
    const trash = `${path}.old-${crypto.randomUUID().slice(0, 8)}`;
    Deno.renameSync(path, trash);
    void Deno.remove(trash, { recursive: true }).catch(() => {}); // a recursive remove never follows a link inside it
    return true;
  } catch {
    return false;
  }
}

/** Test hooks: `make` replaces the link call; `unlink` runs before a link is removed (throwing makes it stay: a locked junction). */
export const _linkHooks: { make: null | ((target: string, link: string) => void); unlink: null | ((link: string) => void) } = {
  make: null,
  unlink: null,
};

function makeLink(target: string, link: string): void {
  if (_linkHooks.make) return _linkHooks.make(target, link);
  // a junction needs no admin rights or developer mode; its target must be absolute (it is: the main folder's path)
  Deno.symlinkSync(target, link, osp.WIN ? { type: 'junction' } : undefined);
}

/**
 * Gives the worktree at `worktree` (its checkout root) its `aib-shared` link to the main folder's real one, made (empty) first when
 * missing. Idempotent: a correct link is kept, a wrong or broken link is replaced, an empty real folder (an agent's mkdir before the
 * link existed) is replaced. A non-empty real folder is never deleted: 'blocked' (and logged by the caller). Never throws.
 */
export function linkShared(worktree: string, lo: LocalOnly | null, warn: (text: string) => void = () => {}): LinkOutcome {
  const target = sharedDirOf(lo);
  if (!target || !lo) return 'off';
  const link = sharedLinkPath(worktree, lo.prefix);
  try {
    if (key(link) === key(target)) return 'off'; // the main folder itself (never a worktree of its own)
    Deno.mkdirSync(target, { recursive: true });
    if (linksTo(link, target)) return 'kept';
    const st = lstat(link);
    if (st?.isSymlink) Deno.removeSync(link); // a link elsewhere (an old main folder) or a broken one: the link only
    else if (st?.isDirectory) {
      if (!retireOldCopy(link)) { // an old build's seeded copy is moved out of the worktree; the link comes next
        if ([...Deno.readDirSync(link)].length) {
          warn(`${link} is a folder with files, not a link to ${target}: left as it is`);
          return 'blocked';
        }
        Deno.removeSync(link);
      }
    } else if (st) {
      warn(`${link} is a file, not a link to ${target}: left as it is`);
      return 'blocked';
    }
    Deno.mkdirSync(osp.dirname(link), { recursive: true });
    makeLink(target, link);
    return 'linked';
  } catch (error) {
    warn(`Could not link ${link} to ${target}: ${error instanceof Error ? error.message : error}`);
    return 'blocked';
  }
}

/** linkShared for a worktree of `project` (its local-only lookup is read first). Never throws. */
export async function linkSharedFor(worktree: string, project: string, warn: (text: string) => void = () => {}): Promise<LinkOutcome> {
  let lo: LocalOnly | null = null;
  try {
    lo = await localOnlyOf(project);
  } catch { /* not readable: no link */ }
  return linkShared(worktree, lo, warn);
}

/**
 * Before a worktree is removed: takes its `aib-shared` link away (the link only). `prefixes`: the project's place in the checkout
 * when known (the root is always checked). True when no link is left at those places; false when one could not be removed (the
 * caller must not delete the tree then). A real folder of that name is left alone (it belongs to the worktree).
 */
export function unlinkShared(worktree: string, prefixes: string[] = []): boolean {
  let ok = true;
  const seen = new Set<string>();
  for (const prefix of ['', ...prefixes]) {
    const link = sharedLinkPath(worktree, prefix);
    if (seen.has(key(link))) continue;
    seen.add(key(link));
    if (retireOldCopy(link)) continue; // an old seeded copy (AIB's own) goes with its worktree; never a link's target
    if (!lstat(link)?.isSymlink) continue;
    try {
      _linkHooks.unlink?.(link);
      Deno.removeSync(link); // non-recursive: a junction or symlink itself, never its target's files
    } catch { /* checked below */ }
    if (lstat(link)) ok = false;
  }
  return ok;
}

/** unlinkShared for a worktree of `project`: the project's prefix is read from git when it can be. */
export async function unlinkSharedFor(worktree: string, project: string): Promise<boolean> {
  let prefix = '';
  try {
    prefix = (await localOnlyOf(project))?.prefix ?? '';
  } catch { /* the root is still checked */ }
  return unlinkShared(worktree, prefix ? [prefix] : []);
}
