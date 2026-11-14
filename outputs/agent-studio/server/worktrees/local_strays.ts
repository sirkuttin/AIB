/**
 * Stray copies of local-only files (Deno only): files written under a local-only path inside a chat's own copy (a worktree), where
 * they are not the shared main-folder file and would be lost when the copy is removed (a plain `git worktree remove` deletes ignored
 * files without asking). findStrays lists them; moveStrays moves them into the main folder (a name clash gets
 * "<name> (from chat-…)<ext>"; a byte-identical copy is just deleted). worktrees.ts runs moveStrays before every removal of a copy
 * and keeps the removal pending while a file could not be moved.
 *
 * A stray is:
 *   - an untracked file (ignored or not) under a local-only entry of the copy, unless it is byte-identical to the main folder's
 *     file (an identical copy, such as a `.env` copied in, is not a stray: it goes with the copy, never duplicated);
 *   - a TRACKED file under an entry (a chat made before the path was excluded has it in its snapshot) that the chat changed since
 *     `base` (its snapshot) and that differs from the main folder's file. It is copied, not moved, so the copy stays clean for a plain
 *     `git worktree remove`; a later run finds the copy already saved (identical bytes) and does not save it twice.
 *
 * Whatever goes wrong with git, the safe side is taken: the file counts as a stray and is saved.
 */
import * as osp from '../platform/ospath.ts';
import { gitPath } from './changes.ts';
import { clashName, isLocalPath, type LocalOnly } from './local_only.ts';

/** Test hooks: `beforeMove(src)` runs before a stray is moved or copied; throwing makes that file fail (a locked file). */
export const _strayHooks: { beforeMove: null | ((src: string) => void) } = { beforeMove: null };

const dec = new TextDecoder();

/** stdout of git in cwd, or null when it failed. */
async function git(args: string[], cwd: string): Promise<string | null> {
  const bin = gitPath();
  if (!bin) return null;
  try {
    const r = await new Deno.Command(bin, {
      args: ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '--no-pager', '--no-optional-locks', ...args],
      cwd,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      signal: AbortSignal.timeout(30_000),
    }).output();
    return r.code === 0 ? dec.decode(r.stdout) : null;
  } catch {
    return null;
  }
}

function lexists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const nul = (text: string) => text.split('\0').filter((p) => p !== '');
const fold = (s: string) => (osp.WIN ? s.toLowerCase() : s);

/** Project-relative paths of the regular files under `rel` in `root` (symlinks are not followed and not listed; .git is skipped). */
function filesUnder(root: string, rel: string): string[] {
  const out: string[] = [];
  const walk = (abs: string, r: string) => {
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(abs);
    } catch {
      return;
    }
    if (st.isFile) out.push(r);
    if (!st.isDirectory) return;
    let names: Deno.DirEntry[];
    try {
      names = [...Deno.readDirSync(abs)];
    } catch {
      return;
    }
    for (const e of names) if (e.name !== '.git') walk(osp.join(abs, e.name), `${r}/${e.name}`);
  };
  walk(osp.join(root, ...rel.split('/')), rel);
  return out;
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = Deno.statSync(a), sb = Deno.statSync(b);
    if (!sa.isFile || !sb.isFile || sa.size !== sb.size) return false;
    const x = Deno.readFileSync(a), y = Deno.readFileSync(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  } catch {
    return false;
  }
}

/** The "(from chat-…)" names already next to `dest` ("TASKS (from chat-1).md", "TASKS (from chat-1) 2.md", …). */
function savedNames(dest: string, slug: string): string[] {
  const dir = osp.dirname(dest), name = osp.basename(dest);
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  const out: string[] = [];
  for (let n = 1;; n++) {
    const candidate = osp.join(dir, `${stem} (from ${slug})${n > 1 ? ' ' + n : ''}${ext}`);
    if (!lexists(candidate)) return out;
    out.push(candidate);
  }
}

/** True when `src`'s bytes are already in the main folder: at `dest` itself or under one of its "(from chat-…)" names. */
export function alreadySaved(src: string, dest: string, slug: string): boolean {
  return sameFile(src, dest) || savedNames(dest, slug).some((p) => sameFile(src, p));
}

interface Stray {
  rel: string;
  tracked: boolean;
}

async function strays(worktree: string, lo: LocalOnly, base = ''): Promise<Stray[]> {
  if (!lo.entries.length || !osp.isdir(worktree)) return [];
  const files: string[] = [];
  for (const entry of lo.entries) files.push(...filesUnder(worktree, entry));
  if (!files.length) return [];
  const listed = await git(['--literal-pathspecs', 'ls-files', '-z', '--cached', '--', ...lo.entries], worktree);
  const tracked = new Set(listed === null ? [] : nul(listed).map(fold));
  let changed: Set<string> | null = null; // tracked files the chat changed since base; null = not known (all count)
  if (tracked.size) {
    let since = base;
    if (!since) { // no snapshot given: where the chat's branch left the main folder's branch
      const mainHead = (await git(['rev-parse', '--verify', '-q', 'HEAD'], lo.project))?.trim() ?? '';
      if (mainHead) since = (await git(['merge-base', 'HEAD', mainHead], worktree))?.trim() ?? '';
    }
    if (since) {
      const diff = await git(['--literal-pathspecs', 'diff', '--name-only', '-z', '--no-renames', since, '--', ...lo.entries], worktree);
      if (diff !== null) changed = new Set(nul(diff).map(fold));
    }
  }
  const out: Stray[] = [];
  const seen = new Set<string>();
  for (const rel of files) {
    if (seen.has(fold(rel)) || !isLocalPath(lo, rel)) continue;
    seen.add(fold(rel));
    const isTracked = tracked.has(fold(rel));
    if (isTracked && changed && !changed.has(fold(rel))) continue; // the chat never changed it: just the snapshot's copy
    // the main folder has the same bytes: nothing to save (the copy goes with the worktree)
    if (sameFile(osp.join(worktree, ...rel.split('/')), osp.join(lo.project, ...rel.split('/')))) continue;
    out.push({ rel, tracked: isTracked });
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/**
 * Project-relative forward-slash paths of the stray files under local-only entries in `worktree` (a chat's copy of the project
 * folder). `base` (optional, the chat's snapshot commit) tells which tracked files the chat changed; without it, the point where the
 * chat's branch left the main folder's branch is used.
 */
export async function findStrays(worktree: string, lo: LocalOnly, base = ''): Promise<string[]> {
  return (await strays(worktree, lo, base)).map((s) => s.rel);
}

function moveFile(src: string, dest: string, copyOnly: boolean): void {
  _strayHooks.beforeMove?.(src);
  Deno.mkdirSync(osp.dirname(dest), { recursive: true });
  if (!copyOnly) {
    try {
      Deno.renameSync(src, dest);
      return;
    } catch { /* another drive (or a sharing error): copy, check, delete */ }
  }
  Deno.copyFileSync(src, dest);
  if (Deno.statSync(dest).size !== Deno.statSync(src).size) {
    try {
      Deno.removeSync(dest);
    } catch { /* left for the next try, which finds it is not the same */ }
    throw new Error('copy incomplete');
  }
  if (!copyOnly) Deno.removeSync(src); // throws when locked: the copy stays, and the next try sees it is already saved
}

/**
 * Moves every stray of `worktree` into lo.project. `moved` = [from (worktree-relative), to (project-relative)]; `failed` = paths left.
 * Never overwrites: a name clash gets "<name> (from <slug>)<ext>", then " 2", …; a file whose bytes are already in the main folder
 * (at its own name or a "(from <slug>)" name) is deleted from the copy, or, when tracked, left alone.
 */
export async function moveStrays(
  worktree: string,
  lo: LocalOnly,
  slug: string,
  base = '',
): Promise<{ moved: [string, string][]; failed: string[] }> {
  const moved: [string, string][] = [], failed: string[] = [];
  for (const { rel, tracked } of await strays(worktree, lo, base)) {
    const src = osp.join(worktree, ...rel.split('/'));
    const dest = osp.join(lo.project, ...rel.split('/'));
    try {
      if (alreadySaved(src, dest, slug)) {
        if (!tracked) {
          _strayHooks.beforeMove?.(src);
          Deno.removeSync(src);
        }
        continue;
      }
      const target = lexists(dest) ? clashName(dest, slug) : dest;
      moveFile(src, target, tracked);
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
      moved.push([rel, dir + osp.basename(target)]);
    } catch {
      failed.push(rel);
    }
  }
  return { moved, failed };
}

/**
 * True when AIB may write local-only defaults (the `/private` exclude line, an empty private/) for `project`. A Studio whose state
 * folder is under the temp folder (or that has none) is a test or a demo: it only touches projects under the temp folder, so a test
 * that opens a chat in a fixture folder inside a real repository never writes that repository's exclude file.
 */
export function defaultsAllowed(stateDir: string, project: string): boolean {
  // '' = a Studio made without a state folder (tests): treated like a temp one
  const temp = (() => {
    try {
      return osp.normcase(osp.realpath(Deno.env.get('TMPDIR') || Deno.env.get('TEMP') || Deno.env.get('TMP') || '/tmp'));
    } catch {
      return '';
    }
  })();
  if (!temp) return !!stateDir;
  const inside = (p: string) => {
    let real: string;
    try {
      real = osp.normcase(osp.realpath(p));
    } catch {
      real = osp.normcase(osp.normpath(p));
    }
    return real === temp || real.startsWith(temp.replace(/[\\/]+$/, '') + osp.SEP);
  };
  return (!!stateDir && !inside(stateDir)) || inside(project);
}
