/**
 * Everything git ignores in a project's MAIN folder, for a chat working in its own copy (Deno only). Git never copies ignored or
 * excluded files into a worktree, so a copy lacks the main folder's `private/`, `game/review/`, `.env`, `node_modules/`… The owner
 * wants all of them visible, traversable and openable from a chat copy's Files tab, and editable by its agent:
 *   overlayIgnored  lays the main folder's ignored entries the copy does not have over a copy's listing (from: 'main'), lists a folder
 *                   that exists only ignored in main from main, and shows paths excluded through `.git/info/exclude` (AIB's block or
 *                   the user's own lines) in normal colour (`excluded`, not `ignored`); `.gitignore` ones stay dimmed
 *   ignoredInMain   true when `rel` (or a folder above it) is ignored in main: a read the copy can't answer comes from main
 *   ignoredTops     the top-level ignored folders and files of main (`git status --ignored`, collapsed by git to the highest ignored
 *                   folder), minus `.git`, other worktrees of the repo and AIB's own folders: what the chat's agent is granted
 * Used only by the WSL helper (wsl/helper/local_only.ts); a Windows chat would get the same with one call in files_routes.ts' list.
 * Never writes anything (no .gitignore, no exclude line).
 */
import * as osp from '../platform/ospath.ts';
import { gitPath, runGit } from './changes.ts';
import { FilesError, ignoredOf, type Listing, listDir, resolveInside } from './files.ts';

const dec = new TextDecoder();
const fold = (s: string) => (osp.WIN ? s.toLowerCase() : s);

/** git check-ignore -v -n of `rels` in `cwd`: rel -> [source file, pattern] ('' pattern: no match). */
async function checkIgnoreV(cwd: string, rels: string[]): Promise<Map<string, [string, string]>> {
  const out = new Map<string, [string, string]>();
  const bin = gitPath();
  if (!bin || !rels.length) return out;
  for (let i = 0; i < rels.length; i += 200) {
    const batch = rels.slice(i, i + 200);
    try {
      const r = await new Deno.Command(bin, {
        args: ['-c', 'core.quotepath=off', '--no-pager', '--no-optional-locks', 'check-ignore', '-v', '-n', '--', ...batch],
        cwd,
        stdin: 'null',
        stdout: 'piped',
        stderr: 'null',
        env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
        signal: AbortSignal.timeout(15_000),
      }).output();
      for (const line of dec.decode(r.stdout).split(/\r?\n/)) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const left = line.slice(0, tab), path = line.slice(tab + 1).replace(/\/+$/, '');
        const m = /^(.*):(\d+):(.*)$/.exec(left);
        out.set(path, m ? [m[1], m[3]] : ['', '']);
      }
    } catch { /* git missing or slow: nothing known */ }
  }
  return out;
}

/** The folders above `rel` and `rel` itself as folder paths ('a/', 'a/b/'), outermost first. */
function prefixes(rel: string): string[] {
  const parts = rel.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
}

/** True when `rel` or a folder above it is ignored in `main` (any source). */
export async function ignoredInMain(main: string, rel: string, file = true): Promise<boolean> {
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return false;
  const asks = prefixes(rel).slice(0, file ? -1 : undefined);
  if (file) asks.push(parts.join('/'));
  return (await ignoredOf(main, asks)).size > 0;
}

/** Which of `rels` (or a folder above the listing `dir`) git ignores through `.git/info/exclude` (not .gitignore, not a negation). */
async function excludedOf(base: string, dir: string, rels: string[]): Promise<{ all: boolean; some: Set<string> }> {
  const viaExclude = ([source, pattern]: [string, string]) => !!pattern && !pattern.startsWith('!') && /(^|[\\/])info[\\/]exclude$/.test(source);
  const above = dir ? await checkIgnoreV(base, prefixes(dir)) : new Map();
  for (const hit of above.values()) if (viaExclude(hit)) return { all: true, some: new Set() };
  const some = new Set<string>();
  for (const [path, hit] of await checkIgnoreV(base, rels)) if (viaExclude(hit)) some.add(path);
  return { all: false, some };
}

const byKind = (a: { dir: boolean; name: string }, b: { dir: boolean; name: string }) =>
  Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);

/**
 * The folder `dir` of a chat copy `root` (its listing `listing`, null when the copy has no such folder) with the main folder's ignored
 * entries laid over it; `same`: root is main (only the excluded marking applies). Throws FilesError not_found when neither has it.
 */
export async function overlayIgnored<L extends Listing>(listing: L | null, root: string, main: string, dir: string, same: boolean): Promise<Listing> {
  let out: Listing;
  if (same) {
    if (!listing) throw new FilesError('Not found', 'not_found', 404);
    out = listing;
  } else if (!listing) {
    // a folder the copy lacks: shown from main when main ignores it (or a folder above it), else it is simply not there
    if (!(await ignoredInMain(main, dir, false))) throw new FilesError('Not found', 'not_found', 404);
    out = await listDir(main, dir);
    for (const e of out.entries) {
      e.from = 'main';
      e.ignored = true;
    }
  } else {
    out = listing;
    let fromMain: Listing | null = null;
    try {
      fromMain = await listDir(main, dir);
    } catch { /* main has no such folder */ }
    if (fromMain) {
      const have = new Set(out.entries.map((e) => fold(e.name)));
      for (const e of fromMain.entries) {
        if (!e.ignored || have.has(fold(e.name))) continue;
        out.entries.push({ ...e, from: 'main' });
      }
      out.entries.sort(byKind);
    }
  }
  // excluded (info/exclude) rows read in normal colour; ask in the folder each row comes from
  const fromMainRows = out.entries.filter((e) => e.from === 'main' && !e.local), own = out.entries.filter((e) => e.from !== 'main' && !e.local);
  for (const [base, rows] of [[main, fromMainRows], [same ? main : root, own]] as const) {
    if (!rows.length) continue;
    const ask = rows.filter((e) => e.ignored && e.name !== 'node_modules').map((e) => e.path);
    if (!ask.length) continue;
    const { all, some } = await excludedOf(base, dir, ask);
    for (const e of rows) {
      if (e.ignored && e.name !== 'node_modules' && (all || some.has(e.path))) {
        e.ignored = false;
        (e as { excluded?: true }).excluded = true;
      }
    }
  }
  return out;
}

/** AIB's own folders and the repo's other worktrees: never granted. */
function insideAny(abs: string, roots: string[]): boolean {
  const a = fold(osp.normpath(abs));
  return roots.some((r) => {
    const b = fold(osp.normpath(r));
    return a === b || a.startsWith(b + osp.SEP) || b.startsWith(a + osp.SEP);
  });
}

export const IGNORED_CAP = 60;

/**
 * The top-level ignored folders and files of `main` as absolute paths (git collapses an ignored folder to its highest ignored
 * folder), leaving out `.git`, anything holding or inside another worktree of the repository, and `own` (AIB's folders). At most
 * IGNORED_CAP of each.
 */
export async function ignoredTops(main: string, own: string[] = []): Promise<{ dirs: string[]; files: string[] }> {
  const dirs: string[] = [], files: string[] = [];
  const [raw, , code] = await runGit(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal', '--', '.'], main, 30);
  if (code !== 0) return { dirs, files };
  const [wt] = await runGit(['worktree', 'list', '--porcelain'], main, 15);
  const realMain = (() => {
    try {
      return osp.realpath(main);
    } catch {
      return osp.normpath(main);
    }
  })();
  const others = dec.decode(wt).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => osp.normpath(l.slice(9).trim()))
    .filter((p) => fold(p) !== fold(realMain) && fold(p) !== fold(osp.normpath(main)));
  const skip = [...others, ...own];
  const [top] = await runGit(['rev-parse', '--show-prefix'], main, 15);
  const prefix = dec.decode(top).trim();
  for (const item of dec.decode(raw).split('\0')) {
    if (!item.startsWith('!! ')) continue;
    let rel = item.slice(3);
    if (prefix) {
      if (!rel.startsWith(prefix)) continue;
      rel = rel.slice(prefix.length);
    }
    const isDir = rel.endsWith('/');
    rel = rel.replace(/\/+$/, '');
    if (!rel || rel.split('/').some((p) => p === '..' || fold(p) === '.git')) continue;
    let abs: string;
    try {
      [abs] = resolveInside(main, rel);
    } catch {
      continue; // a link out of the project, or gone
    }
    if (insideAny(abs, skip)) continue;
    if (isDir) {
      if (dirs.length < IGNORED_CAP) dirs.push(abs);
    } else if (files.length < IGNORED_CAP) files.push(abs);
  }
  return { dirs, files };
}
