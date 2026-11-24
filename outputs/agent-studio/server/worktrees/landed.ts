/**
 * Is a builder branch's work already in the project's main branch? Decided by CONTENT, never by commit ancestry (owner 2026-11-24:
 * the Changes tab's "Left over" listed 80 builders whose work had landed). Ancestry fails because AIB lands a builder as ONE squashed
 * "AIB: subagent <title>" commit, the lead may cherry-pick a builder's commit by hand, and every builder branch starts with an
 * "AIB snapshot" commit (a copy of the folder's untracked files) that never lands.
 *
 * A branch is landed when ANY of these holds (read-only; git only reads):
 *   ancestor        its tip is in main.
 *   snapshot-only   every commit it has beyond main is an "AIB snapshot" commit: no work of its own.
 *   cherry          every one of its own commits (snapshots left out) has its patch-id in main (`git cherry`): a cherry-pick.
 *   content         for every path its own commits touched, main has the branch's file now, or had it at some commit since the branch
 *                   left main (a squashed landing, or one main has rewritten since).
 *   lines           for the paths that differ, the lines the branch's own commits added are still in main's file (a hand-made
 *                   cherry-pick with conflicts resolved, or main edited the file since); a path the branch only deleted from is
 *                   landed when those lines are gone from main.
 *   rewritten       a squashed landing commit "AIB: subagent <title>" is in main and main has touched every path the branch's own
 *                   commits touched since (the landing's text was later edited, so no file matches any more).
 */
import * as wt from './worktrees.ts';

export const SNAPSHOT_SUBJECT = 'AIB snapshot';

export type LandedWhy = 'ancestor' | 'snapshot-only' | 'cherry' | 'content' | 'lines' | 'rewritten' | 'unlanded' | 'unknown';

export interface Verdict {
  landed: boolean;
  why: LandedWhy;
  /** Its own commits (snapshots left out) that are not in main by patch-id. */
  own: number;
  /** The paths its unlanded own commits touched and main does not have as the branch does (empty when landed). */
  files: string[];
}

const nul = (t: string) => t.split('\0').filter(Boolean);
const word = (t: string) => t.trim();

async function out(cwd: string, args: string[]): Promise<string | null> {
  const done = await wt.git(args, cwd, { check: false });
  return done.returncode === 0 ? done.stdout : null;
}

/** blob id of each path in `rev` ('' for a missing path), by one ls-tree call. */
async function blobs(cwd: string, rev: string, paths: string[]): Promise<Map<string, string> | null> {
  const map = new Map<string, string>(paths.map((p) => [p, '']));
  for (let i = 0; i < paths.length; i += 200) {
    const text = await out(cwd, ['ls-tree', '-z', rev, '--', ...paths.slice(i, i + 200)]);
    if (text === null) return null;
    for (const entry of nul(text)) {
      const tab = entry.indexOf('\t');
      if (tab < 0) continue;
      map.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[2] ?? '');
    }
  }
  return map;
}

/** A line worth comparing: not blank, not just punctuation or a brace. */
const meaningful = (l: string) => l.replace(/[\s{}()[\];,]/g, '').length > 3;

/**
 * The paths among `paths` whose own changes are still in `base`: the lines the commits `shas` added (meaningful ones) are in main's
 * file for at least 90% of them; or, for a path with no such lines (only deletions), the lines they removed are gone from main.
 * Null when git cannot say.
 */
async function linesStillIn(repo: string, base: string, shas: string[], paths: string[]): Promise<Set<string> | null> {
  const added = new Map<string, Set<string>>(), removed = new Map<string, Set<string>>();
  for (const sha of shas) {
    const text = await out(repo, ['diff-tree', '-p', '-U0', '--no-commit-id', '--no-renames', '--no-color', sha, '--', ...paths.slice(0, 400)]);
    if (text === null) return null;
    let path = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('+++ ')) path = line.startsWith('+++ b/') ? line.slice(6) : '';
      else if (line.startsWith('--- ')) continue;
      else if (!path) continue;
      else if (line.startsWith('+') && meaningful(line.slice(1))) (added.get(path) ?? added.set(path, new Set()).get(path)!).add(line.slice(1).trim());
      else if (line.startsWith('-') && meaningful(line.slice(1))) (removed.get(path) ?? removed.set(path, new Set()).get(path)!).add(line.slice(1).trim());
    }
  }
  const ok = new Set<string>();
  for (const path of paths) {
    const file = await out(repo, ['show', `${base}:${path}`]); // null: the path is not in main
    const have = new Set((file ?? '').split('\n').map((l) => l.trim()));
    const add = [...(added.get(path) ?? [])], rem = [...(removed.get(path) ?? [])].filter((l) => !(added.get(path)?.has(l)));
    if (add.length) {
      if (file !== null && add.filter((l) => have.has(l)).length >= Math.ceil(add.length * 0.9)) ok.add(path);
    } else if (file === null || rem.filter((l) => have.has(l)).length <= Math.floor(rem.length * 0.1)) ok.add(path);
  }
  return ok;
}

/**
 * `repo`: any folder of the repository. `title`: the builder's title, for the squashed-landing subject ('' when not known).
 * `landedByRecord`: AIB's own landing record says it landed (then nothing is read).
 */
export async function branchLanded(
  repo: string,
  branch: string,
  target: string,
  options: { title?: string; landedByRecord?: boolean } = {},
): Promise<Verdict> {
  const unknown: Verdict = { landed: false, why: 'unknown', own: 0, files: [] };
  if (options.landedByRecord) return { landed: true, why: 'ancestor', own: 0, files: [] };
  const head = `refs/heads/${branch}`, base = `refs/heads/${target}`;
  const tip = word(await out(repo, ['rev-parse', '--verify', '-q', head + '^{commit}']) ?? '');
  const mainTip = word(await out(repo, ['rev-parse', '--verify', '-q', base + '^{commit}']) ?? '');
  if (!tip || !mainTip) return unknown;
  if ((await wt.git(['merge-base', '--is-ancestor', tip, mainTip], repo, { check: false })).returncode === 0) {
    return { landed: true, why: 'ancestor', own: 0, files: [] };
  }
  // its own commits: those beyond main, merges and snapshots left out
  const log = await out(repo, ['log', '--no-merges', '--format=%H%x09%s', `${base}..${head}`]);
  if (log === null) return unknown;
  const snapshots = new Set<string>();
  const ownAll: string[] = [];
  const subjectOf = new Map<string, string>();
  for (const line of log.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const [sha, ...subject] = line.split('\t');
    const text = subject.join('\t').replace(/\s+/g, ' ').trim();
    if (text === SNAPSHOT_SUBJECT) snapshots.add(sha);
    else {
      ownAll.push(sha);
      subjectOf.set(sha, text.toLowerCase());
    }
  }
  if (!ownAll.length) return { landed: true, why: 'snapshot-only', own: 0, files: [] };
  const cherry = await out(repo, ['cherry', base, head]);
  if (cherry === null) return unknown;
  const open = cherry.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('+ ')).map((l) => l.slice(2).trim())
    .filter((sha) => !snapshots.has(sha));
  if (!open.length) return { landed: true, why: 'cherry', own: 0, files: [] };
  // the paths the not-yet-matched commits touched
  const paths = new Set<string>();
  for (const sha of open) {
    const text = await out(repo, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', '--no-renames', sha]);
    if (text === null) return unknown;
    for (const p of nul(text)) paths.add(p);
  }
  const list = [...paths];
  if (!list.length) return { landed: true, why: 'content', own: open.length, files: [] }; // empty commits
  const fork = word(await out(repo, ['merge-base', base, head]) ?? '');
  const mine = await blobs(repo, head, list);
  const now = await blobs(repo, base, list);
  if (!mine || !now) return unknown;
  // every blob main held for a path since the branch left it
  const seen = new Map<string, Set<string>>(list.map((p) => [p, new Set<string>()]));
  const touched = new Set<string>();
  if (fork) {
    const raw = await out(repo, ['log', '--no-renames', '--raw', '--no-abbrev', '-z', '--format=', `${fork}..${base}`, '--', ...list.slice(0, 400)]);
    if (raw !== null) {
      const parts = raw.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const meta = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) \w/.exec(parts[i].replace(/^\n+/, ''));
        if (!meta || i + 1 >= parts.length) continue;
        const path = parts[++i];
        touched.add(path);
        seen.get(path)?.add(/^0+$/.test(meta[1]) ? '' : meta[1]);
      }
    }
  }
  let missing = list.filter((p) => {
    const m = mine.get(p) ?? '';
    const here = now.get(p) ?? '';
    // main has it too, had it once, or has deleted the file since (it landed and was removed later)
    return !(m === here || seen.get(p)?.has(m) || (m && !here && seen.get(p)?.has('')));
  });
  if (!missing.length) return { landed: true, why: 'content', own: open.length, files: [] };
  const still = await linesStillIn(repo, base, open, missing);
  if (still) {
    missing = missing.filter((p) => !still.has(p));
    if (!missing.length) return { landed: true, why: 'lines', own: open.length, files: [] };
  }
  // a cherry-pick keeps its subject, a squashed landing is "AIB: subagent <title>": main has such a commit, and has touched every path
  const title = (options.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (fork && missing.every((p) => touched.has(p))) {
    const text = await out(repo, ['log', '--format=%s', `${fork}..${base}`]);
    const subjects = (text ?? '').split('\n').map((x) => x.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
    const inMain = (wanted: string) => subjects.some((x) => x === wanted || x.startsWith('aib: subagent ' + wanted));
    if ((title && inMain(title)) || open.every((sha) => !!subjectOf.get(sha) && inMain(subjectOf.get(sha)!))) {
      return { landed: true, why: 'rewritten', own: open.length, files: [] };
    }
  }
  return { landed: false, why: 'unlanded', own: open.length, files: missing };
}
