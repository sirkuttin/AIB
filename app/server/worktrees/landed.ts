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
 *   rewritten       a commit with the branch's own subject, or a squashed landing "AIB: subagent <title>", is in main and main has every
 *                   path the branch's own commits touched (under its mapped name), or has touched it since (the landing's text was later
 *                   edited, so no file matches any more).
 *
 * Renames: main may have moved files since the branch left it (2026-11-24: outputs/agent-studio -> app, page files -> app/page, studio.ts
 * -> aib.ts). Every path the branch touched that main no longer has is mapped to its new name (git's rename detection between the fork
 * and main, then the known moves), and the content, lines and rewritten checks read the mapped path.
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

/** Where the 2026-11-24 folder move put a path of the old layout, best guess first (the caller keeps the first that main has). */
export function movedCandidates(path: string): string[] {
  const prefix = 'outputs/agent-studio/';
  if (!path.startsWith(prefix)) return [];
  const rest = path.slice(prefix.length)
    .replace(/^server\/host\/studio\.ts$/, 'server/host/aib.ts')
    .replace(/^server\/web\/studio_routes\.ts$/, 'server/web/aib_routes.ts');
  return rest.includes('/') ? [`app/${rest}`] : [`app/page/${rest}`, `app/${rest}`];
}

/**
 * Each of `paths` (branch names) as main names it now. Only paths main lacks are looked up: git's renames between `fork` and `base`,
 * else the known moves; a path with no new name stays as it is (main has deleted it).
 */
async function mapPaths(repo: string, fork: string, base: string, paths: string[], now: Map<string, string>): Promise<Map<string, string>> {
  const map = new Map<string, string>(paths.map((p) => [p, p]));
  const lost = paths.filter((p) => !now.get(p));
  if (!lost.length) return map;
  // every rename main made since the fork, oldest first (a later edit can rewrite a moved file past what rename detection sees at the tip)
  const renames: [string, string][] = [];
  if (fork) {
    const text = await out(repo, ['log', '-M', '-l0', '--reverse', '--diff-filter=R', '--name-status', '-z', '--format=', `${fork}..${base}`]);
    if (text !== null) {
      const parts = text.split('\0').map((x) => x.replace(/^\n+/, ''));
      for (let i = 0; i + 2 < parts.length; i++) {
        if (/^R\d*$/.test(parts[i])) {
          renames.push([parts[i + 1], parts[i + 2]]);
          i += 2;
        }
      }
    }
  }
  const options = new Map<string, string[]>();
  for (const p of lost) {
    // follow the renames in order (a file may move twice)
    let cur = p;
    for (const [from, to] of renames) if (from === cur) cur = to;
    options.set(p, [...(cur !== p ? [cur] : []), ...movedCandidates(p)]);
  }
  const all = [...new Set([...options.values()].flat())];
  const there = all.length ? await blobs(repo, base, all) : new Map<string, string>();
  for (const [p, list] of options) {
    const hit = list.find((c) => !!there?.get(c));
    if (hit) map.set(p, hit);
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
async function linesStillIn(repo: string, base: string, shas: string[], paths: string[], mapped: Map<string, string>): Promise<Set<string> | null> {
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
    const file = await out(repo, ['show', `${base}:${mapped.get(path) ?? path}`]); // null: the path is not in main
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
async function computeLanded(
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
  const here0 = await blobs(repo, base, list);
  if (!mine || !here0) return unknown;
  // main may have renamed what is missing under the branch's name: read it under its new one
  const mapped = await mapPaths(repo, fork, base, list, here0);
  const moved = list.filter((p) => mapped.get(p) !== p);
  const now = new Map<string, string>(here0);
  if (moved.length) {
    const there = await blobs(repo, base, moved.map((p) => mapped.get(p)!));
    if (!there) return unknown;
    for (const p of moved) now.set(p, there.get(mapped.get(p)!) ?? '');
  }
  // every blob main held for a path since the branch left it
  const seen = new Map<string, Set<string>>(list.map((p) => [p, new Set<string>()]));
  const touched = new Set<string>();
  if (fork) {
    const back = new Map<string, string>(list.map((p) => [mapped.get(p)!, p]));
    const raw = await out(repo, ['log', '--no-renames', '--raw', '--no-abbrev', '-z', '--format=', `${fork}..${base}`, '--', ...[...back.keys()].slice(0, 400)]);
    if (raw !== null) {
      const parts = raw.split('\0');
      for (let i = 0; i < parts.length; i++) {
        const meta = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) \w/.exec(parts[i].replace(/^\n+/, ''));
        if (!meta || i + 1 >= parts.length) continue;
        const path = back.get(parts[++i]) ?? parts[i];
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
  const still = await linesStillIn(repo, base, open, missing, mapped);
  if (still) {
    missing = missing.filter((p) => !still.has(p));
    if (!missing.length) return { landed: true, why: 'lines', own: open.length, files: [] };
  }
  // a cherry-pick keeps its subject, a squashed landing is "AIB: subagent <title>": main has such a commit, and has touched every path
  const title = (options.title ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  // (main has the path, under its mapped name or its own, or has touched it since: the squash was edited or the folder moved)
  if (fork && missing.every((p) => touched.has(p) || (!!now.get(p) && !!mine.get(p)) || (!mine.get(p) && !now.get(p)))) {
    const text = await out(repo, ['log', '--format=%s', `${fork}..${base}`]);
    const subjects = (text ?? '').split('\n').map((x) => x.replace(/\s+/g, ' ').trim().toLowerCase()).filter(Boolean);
    const inMain = (wanted: string) => subjects.some((x) => x === wanted || x.startsWith('aib: subagent ' + wanted));
    // a stacked branch carries the lower builders' commits: its newest own commit landing means theirs landed with it
    const newest = subjectOf.get(ownAll[0]) ?? '';
    if ((title && inMain(title)) || (!!newest && inMain(newest)) || open.every((sha) => !!subjectOf.get(sha) && inMain(subjectOf.get(sha)!))) {
      return { landed: true, why: 'rewritten', own: open.length, files: [] };
    }
  }
  return { landed: false, why: 'unlanded', own: open.length, files: missing };
}

// ---- the memo ---------------------------------------------------------------------------------------------------------------
// A verdict reads the repository for seconds (115 branches of the AIB repo: 62 s in all), and the project panel, the swarm's sweeps and
// the hand-off all ask again and again. So a verdict is kept by the branch's tip and main's tip, on disk too (a restart asks nothing
// again): it holds while both tips stay; a LANDED one also holds when main moves on (landed work does not come back unlanded by main
// growing). 'unknown' (it could not be decided) is never kept.

interface Memo {
  tip: string;
  main: string;
  verdict: Verdict;
}

const MEMO = new Map<string, Memo>();
const MEMO_MAX = 2000;
let memoFile: string | null = null;
let memoTimer: ReturnType<typeof setTimeout> | null = null;
export const landedReads = { computed: 0, memo: 0 };

/** Keep verdicts in `file` (loaded now, written a moment after a change); null: memory only. */
export function useLandedMemo(file: string | null): void {
  memoFile = file;
  MEMO.clear();
  if (!file) return;
  try {
    const raw = JSON.parse(Deno.readTextFileSync(file));
    if (raw && typeof raw === 'object' && raw.v === 1 && raw.items && typeof raw.items === 'object') {
      for (const [k, m] of Object.entries(raw.items as Record<string, Memo>)) {
        if (m && typeof m.tip === 'string' && typeof m.main === 'string' && m.verdict && typeof m.verdict.landed === 'boolean') MEMO.set(k, m);
      }
    }
  } catch { /* none yet, or unreadable: start empty */ }
}

/** Forget every kept verdict (tests). */
export function clearLandedMemo(): void {
  MEMO.clear();
}

function saveMemo(): void {
  if (!memoFile || memoTimer) return;
  memoTimer = setTimeout(() => {
    memoTimer = null;
    try {
      const file = memoFile;
      if (!file) return;
      const tmp = `${file}.${Deno.pid}.tmp`;
      Deno.writeTextFileSync(tmp, JSON.stringify({ v: 1, items: Object.fromEntries(MEMO) }));
      Deno.renameSync(tmp, file);
    } catch { /* a hint: the next verdict is computed again */ }
  }, 1500);
  Deno.unrefTimer(memoTimer as unknown as number);
}

/** The commit ids of `branch` and `target` (empty when gone), by ONE call. */
export async function refTips(repo: string, branch: string, target: string): Promise<{ tip: string; main: string }> {
  const text = await out(repo, ['for-each-ref', '--format=%(refname) %(objectname)', `refs/heads/${branch}`, `refs/heads/${target}`]);
  const ids = new Map<string, string>();
  for (const line of (text ?? '').split('\n')) {
    const [ref, id] = line.trim().split(' ');
    if (ref && id) ids.set(ref, id);
  }
  return { tip: ids.get(`refs/heads/${branch}`) ?? '', main: ids.get(`refs/heads/${target}`) ?? '' };
}

const memoKey = (repo: string, branch: string, target: string, title: string) => `${repo}\0${branch}\0${target}\0${title}`;
const squashTitle = (t: string | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();

/** The kept verdict for these tips, if it still holds. */
export function memoOf(repo: string, branch: string, target: string, title: string | undefined, tips: { tip: string; main: string }): Verdict | null {
  const m = MEMO.get(memoKey(repo, branch, target, squashTitle(title)));
  if (!m || !tips.tip || m.tip !== tips.tip) return null;
  return m.main === tips.main || m.verdict.landed ? m.verdict : null;
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
  if (options.landedByRecord) return { landed: true, why: 'ancestor', own: 0, files: [] };
  const tips = await refTips(repo, branch, target);
  if (!tips.tip || !tips.main) return { landed: false, why: 'unknown', own: 0, files: [] };
  const kept = memoOf(repo, branch, target, options.title, tips);
  if (kept) {
    landedReads.memo++;
    return kept;
  }
  landedReads.computed++;
  const verdict = await computeLanded(repo, branch, target, options);
  if (verdict.why !== 'unknown') {
    MEMO.set(memoKey(repo, branch, target, squashTitle(options.title)), { tip: tips.tip, main: tips.main, verdict });
    while (MEMO.size > MEMO_MAX) MEMO.delete(MEMO.keys().next().value as string);
    saveMemo();
  }
  return verdict;
}

/** Write the kept verdicts to their file now (tests; a restart reads it). */
export function flushLandedMemo(): void {
  if (memoTimer) {
    clearTimeout(memoTimer);
    memoTimer = null;
  }
  const file = memoFile;
  if (!file) return;
  try {
    const tmp = `${file}.${Deno.pid}.tmp`;
    Deno.writeTextFileSync(tmp, JSON.stringify({ v: 1, items: Object.fromEntries(MEMO) }));
    Deno.renameSync(tmp, file);
  } catch { /* a hint */ }
}
