/**
 * The project right panel's Changes tab (design project-right-panel, slice S2): ONE read for the whole project.
 *
 *   main      the project folder: its uncommitted changes (what the old per-chat tab showed for a folder chat).
 *   sections  one per worktree in use by an ACTIVE subagent or helper of the project (a running one, or one that finished and waits to
 *             land). The diff base is the worktree's own snapshot S (HEAD plus main's uncommitted edits at the moment it was made), so
 *             main's edits are not repeated in every section. Sources: <state>/subagent-worktrees.json (the Studio's records) and the
 *             swarm registry (swarm-helpers.json: helpers and the landing state of subagents). Spare, preparing and prepared worktrees
 *             hold no work and are never listed; a landed one is gone.
 *   left      worktrees whose work never landed (stopped, refused landing, files kept): shown folded, under "Left over", only with
 *             changes in them. No Merge or Discard: the agent lands or undoes work when asked in chat.
 *
 * A folded section only reads its numbers (changes.ts getCounts); its file list comes when it is unfolded. The runs of git go one after
 * another, never in parallel. A section is named to the page by its record id, never by a path; the page asks a worktree's diff by
 * (section id, repository path) and the path of the worktree comes from the record. A WSL project has no subagent worktrees today: only
 * main, read with ONE helper call (`changes.many`).
 */
import { isDict } from '../core/py.ts';
import * as osp from '../platform/ospath.ts';
import { docRows } from '../docs/rows.ts';
import type { Helper } from '../swarm/registry.ts';
import type { SubagentRecord } from '../subagents/service.ts';
import { notReady, wslHost, wslLoc } from '../wsl/access.ts';
import { WslHelperError } from '../wsl/contract.ts';
import { branchOf, repoBranch } from './chat_folders.ts';
import * as changes from './changes.ts';
import { branchLanded } from './landed.ts';
import * as wt from './worktrees.ts';
import { porcelainPaths } from './merge.ts';

type Json = Record<string, unknown>;

export interface Target {
  /** The record id (the subagent record's id, which is also its swarm entry's id; a helper's swarm id). Never a path. */
  id: string;
  kind: 'subagent' | 'helper';
  name: string;
  parent: { live: string; lasting: string };
  provider: string;
  branch: string;
  path: string;
  /** The diff base: the worktree's snapshot S ('' for an old record: then the worktree's own HEAD). */
  base: string;
  /** 'active': at work, or finished and waiting to land. 'left': its work never landed. */
  state: 'active' | 'left';
  /** Why it is left over: stopped / refused (a landing that did not go through) / kept (files AIB did not land). */
  why: '' | 'stopped' | 'refused' | 'kept';
  /** Still being worked on (not only waiting to land): it is listed even with no changes yet. */
  working: boolean;
}

const same = (a: string, b: string) => !!a && !!b && osp.normcase(osp.normpath(a)) === osp.normcase(osp.normpath(b));
const clean = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

/**
 * The worktrees of this project, in a stable order (oldest first). `folders`: the project folder and its repository root.
 * Spares and not-yet-bound worktrees are left out; so are landed ones and empty orphans.
 */
export function worktreeTargets(
  folders: string[],
  subs: Record<string, SubagentRecord>,
  helpers: Helper[],
  exists: (path: string) => boolean = (p) => osp.isdir(p),
): Target[] {
  const mine = (project: unknown) => folders.some((f) => same(String(project ?? ''), f));
  const out: (Target & { at: number })[] = [];
  const byId = new Map(helpers.map((h) => [h.id, h]));
  for (const rec of Object.values(subs)) {
    if (!isDict(rec) || rec.kind !== 'subagent' || !rec.path || !mine(rec.project || rec.folder)) continue;
    if (rec.state === 'spare' || rec.state === 'preparing' || rec.state === 'prepared') continue; // no work yet
    const h = byId.get(rec.id);
    const verdict = classify(rec.state, h);
    if (!verdict || !exists(rec.path)) continue;
    out.push({
      id: rec.id,
      kind: 'subagent',
      name: clean(rec.description || rec.agentType || 'subagent'),
      parent: { live: rec.chat || '', lasting: rec.lasting || '' },
      provider: '',
      branch: rec.branch || '',
      path: rec.path,
      base: rec.snapshot || '',
      ...verdict,
      at: rec.createdAt || 0,
    });
    byId.delete(rec.id);
  }
  for (const h of helpers) {
    if (h.kind === 'subagent' || !h.worktree?.path || !mine(h.project || h.worktree.landOn)) continue;
    const verdict = classify(h.state === 'starting' || h.state === 'working' || h.state === 'waiting' ? 'running' : 'done', h);
    if (!verdict || !exists(h.worktree.path)) continue;
    out.push({
      id: h.id,
      kind: 'helper',
      name: clean(h.title || 'helper'),
      parent: { live: h.parent?.live || '', lasting: h.parent?.lasting || '' },
      provider: h.chat?.provider || '',
      branch: h.worktree.branch || '',
      path: h.worktree.path,
      base: h.worktree.start || '',
      ...verdict,
      at: h.createdAt || 0,
    });
  }
  out.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  return out.map(({ at: _at, ...t }) => t);
}

/** Active, left over, or neither (landed / nothing there). `recState`: the Studio record's state; h: the swarm entry. */
function classify(recState: string, h: Helper | undefined): Pick<Target, 'state' | 'why' | 'working'> | null {
  const kept = !!h?.sub?.kept?.length;
  if (h?.state === 'merged') return kept ? { state: 'left', why: 'kept', working: false } : null; // landed: gone
  if (recState === 'running' || recState === 'user-hook') return { state: 'active', why: '', working: true };
  if (h?.state === 'failed') return { state: 'left', why: 'refused', working: false };
  if (h?.state === 'stopped' || recState === 'stopped') return { state: 'left', why: 'stopped', working: false };
  if (kept) return { state: 'left', why: 'kept', working: false };
  return { state: 'active', why: '', working: false }; // finished, waits to land
}

export interface Args {
  /** The chat the page names (any chat of the project): the project folder comes from it, never from a path. */
  folder: string;
  stateDir: string | null;
  subs: Record<string, SubagentRecord>;
  helpers: Helper[];
  /** Sections the user folded (default open), and left-over ones the user unfolded (default folded). Main is always read in full. */
  fold: Set<string>;
  unfold: Set<string>;
  /** Main only ("Show the next 300" asks for main's next page: no worktree is read). */
  onlyMain?: boolean;
}

interface Counts {
  files: number;
  added: number;
  removed: number;
  partial?: boolean;
}

function countsOf(r: Json | null | undefined): Counts {
  const t = isDict(r) && isDict(r.totals) ? r.totals : isDict(r) ? r : {};
  const n = (v: unknown) => Math.max(0, Number(v) || 0);
  const out: Counts = { files: n(t.files), added: n(t.added), removed: n(t.removed) };
  if (t.partial) out.partial = true;
  return out;
}

/** One section of the answer: its head facts, its numbers, and (unfolded) its files. */
function section(t: Omit<Partial<Target>, 'kind'> & { id: string; kind: string; name: string }, expanded: boolean, result: Json | null): Json {
  const out: Json = {
    id: t.id,
    kind: t.kind,
    name: t.name,
    parent: t.parent ?? null,
    provider: t.provider ?? '',
    branch: t.branch ?? '',
    state: t.state ?? 'active',
    why: t.why ?? '',
    working: !!t.working,
    expanded,
    git: !!(result && result.git),
    counts: countsOf(result),
  };
  if (expanded && result) out.changes = result;
  return out;
}

/** Left-over worktrees' counts, by worktree path: valid while the signature (its HEAD, its index time, its folder time) stays. */
const LEFT = new Map<string, { sig: string; base: string; result: Awaited<ReturnType<typeof changes.getCounts>> | null }>();
/** Git runs made for left-over worktrees (a test reads it: an unchanged one is not counted again). */
export const leftCounted = { n: 0 };

/** What changes when a worktree's work does: where HEAD points, the index's mtime, the folder's mtime. '' when it cannot be read. */
export function leftSignature(path: string): string {
  try {
    const dotgit = osp.join(path, '.git');
    let gitdir = dotgit;
    if (Deno.statSync(dotgit).isFile) {
      const m = /^gitdir:\s*(.+)$/m.exec(Deno.readTextFileSync(dotgit));
      if (!m) return '';
      gitdir = osp.isabs(m[1].trim()) ? m[1].trim() : osp.join(path, m[1].trim());
    }
    const time = (p: string) => {
      try {
        return String(Deno.statSync(p).mtime?.getTime() ?? 0);
      } catch {
        return '0';
      }
    };
    let head = '';
    try {
      head = Deno.readTextFileSync(osp.join(gitdir, 'HEAD')).trim();
      const ref = /^ref:\s*(.+)$/.exec(head);
      if (ref) head += '=' + Deno.readTextFileSync(osp.join(gitdir, ref[1].trim())).trim();
    } catch { /* a ref in packed-refs: the HEAD text alone then */ }
    return [head, time(osp.join(gitdir, 'index')), time(path)].join('|');
  } catch {
    return '';
  }
}

/** Landed verdicts of left-over worktrees, by worktree path: valid while its signature and main's tip stay. */
const LANDED = new Map<string, { sig: string; tip: string; landed: boolean }>();
/** Landed checks made for left-over worktrees (a test reads it: an unchanged one is not checked again). */
export const landedChecked = { n: 0 };

/**
 * True when a left-over worktree's work is provably in the project's main branch (landed.ts: by content, never by ancestry) and its
 * folder holds nothing more: a landed one is not "left over". A folder with edits of its own (uncommitted or untracked) is never
 * judged landed. `top`: the repository's top folder.
 */
export async function leftIsLanded(t: Target, top: string): Promise<boolean> {
  if (!top || !t.branch || t.why === 'kept') return false;
  const target = await wt.mainBranch(top, '');
  if (!target) return false;
  const sig = leftSignature(t.path);
  const tip = ((await wt.git(['rev-parse', '--verify', '-q', `refs/heads/${target}`], top, { check: false })).stdout || '').trim();
  const hit = LANDED.get(t.path);
  if (sig && tip && hit && hit.sig === sig && hit.tip === tip) return hit.landed;
  landedChecked.n++;
  let landed = false;
  try {
    const verdict = await branchLanded(top, t.branch, target, { title: t.name });
    landed = verdict.landed && (await porcelainPaths(t.path)).size === 0;
  } catch { /* cannot tell: it stays listed */ }
  if (sig && tip) LANDED.set(t.path, { sig, tip, landed });
  while (LANDED.size > 400) LANDED.delete(LANDED.keys().next().value as string);
  return landed;
}

async function leftCounts(t: Target) {
  const sig = leftSignature(t.path);
  const hit = LEFT.get(t.path);
  if (sig && hit && hit.sig === sig && hit.base === t.base) return hit.result;
  leftCounted.n++;
  const result = await changes.getCounts(t.path, t.base || null).catch(() => null);
  if (sig) LEFT.set(t.path, { sig, base: t.base, result });
  while (LEFT.size > 200) LEFT.delete(LEFT.keys().next().value as string);
  return result;
}

/** The answer of GET /api/live/project/changes. `offset`: the first file of main's page (the page's "Show the next 300"). */
export async function projectChanges(args: Args, offset = 0): Promise<Json> {
  const wsl = wslLoc(args.folder);
  if (wsl) return await wslProject(args, wsl, offset);
  // main is always read in full: the Files view's change marks come from it. Folding it is the page's own (nothing is fetched less).
  const main = await changes.getChanges(args.folder, null, offset);
  if (main.git && Array.isArray(main.files)) {
    const docs = docRows(String(main.root), main.files.map((f) => f.path));
    if (docs.length) (main as unknown as Json).docs = docs;
  }
  const top = main.git ? String(main.root || '') : '';
  const mainSection = section(
    { id: 'main', kind: 'main', name: 'Project folder', branch: repoBranch(args.folder) },
    true,
    main as unknown as Json,
  );
  if (args.onlyMain) return { git: !!main.git, main: mainSection, sections: [], left: [] };
  const sections: Json[] = [], left: Json[] = [];
  for (const t of worktreeTargets([args.folder, top], args.subs, args.helpers)) {
    if (t.state === 'left' && (await leftIsLanded(t, top))) continue; // its work is in main already: not left over
    const open = t.state === 'active' ? !args.fold.has(t.id) : args.unfold.has(t.id);
    // one at a time: the git runs of a project never overlap
    const result = open
      ? await changes.getChanges(t.path, t.base || null, 0).catch(() => null)
      : t.state === 'left'
      ? await leftCounts(t) // a left-over worktree rarely changes: counted again only when its HEAD or files' times move
      : await changes.getCounts(t.path, t.base || null).catch(() => null);
    const sec = section(t, open, result as unknown as Json | null);
    const c = sec.counts as Counts;
    if (!c.files && !t.working) continue; // nothing in it: finished and nothing to land, or nothing to lose
    (t.state === 'active' ? sections : left).push(sec);
  }
  left.reverse(); // newest first (worktreeTargets lists the oldest first)
  return { git: !!main.git, main: mainSection, sections, left };
}

/** A WSL project: main only, through ONE batched helper call (`changes.many`; no worktrees of subagents exist there today). */
async function wslProject(args: Args, wsl: { distro: string; linuxPath: string }, offset: number): Promise<Json> {
  const host = wslHost(wsl.distro);
  const why = notReady(host, wsl.distro);
  if (why) throw new WslHelperError(why, 'wsl_unavailable');
  const folders = [{ folder: wsl.linuxPath, offset }];
  const reply = await host!.call('changes.many', { folders });
  const first = (reply.results?.[0] ?? { git: false }) as Json;
  if (typeof first.error === 'string') throw new WslHelperError(first.error, String(first.code ?? 'failed'));
  const branch = await branchOf(args.folder);
  return {
    git: !!first.git,
    main: section({ id: 'main', kind: 'main', name: 'Project folder', branch }, true, first),
    sections: [],
    left: [],
  };
}

/** The diff of one file of a worktree section: by record id; null when no worktree of this project has that id. */
export async function sectionDiff(args: Args, id: string, path: string): Promise<Json | null> {
  // main: the project folder's own uncommitted file (never the open chat's worktree: the folder is the project's)
  if (id === 'main') {
    const wsl = wslLoc(args.folder);
    if (!wsl) return await changes.getFileDiff(args.folder, path, null) as unknown as Json;
    const host = wslHost(wsl.distro);
    const why = notReady(host, wsl.distro);
    if (why) throw new WslHelperError(why, 'wsl_unavailable');
    return await host!.call('changes.diff', { folder: wsl.linuxPath, path }) as Json;
  }
  const top = wslLoc(args.folder) ? '' : ((await changes.locate(args.folder)) ?? [''])[0];
  const t = worktreeTargets([args.folder, top], args.subs, args.helpers).find((x) => x.id === id);
  if (!t) return null;
  return await changes.getFileDiff(t.path, path, t.base || null) as unknown as Json;
}

