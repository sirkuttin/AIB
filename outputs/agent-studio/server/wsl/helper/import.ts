/**
 * One-off: move the existing chats of a WSL project into their own worktree copies ("import"), the way a new WSL chat gets one
 * (docs/WSL.md "Moving existing chats into their own copies (one-off)"). Run inside the distro by the helper binary:
 *
 *   AIB-wsl-helper import --data <data> --project <linux path> [--apply --confirm-project <path>] [--undo <stamp>]
 *                         [--sessions id,id] [--root <root>] [--claude-dir <dir>] [--codex-dir <dir>] [--json]
 *
 * (tools/wsl-import.ts is the Windows wrapper that finds the helper and the data folder and prints the report.)
 *
 * - The default is a DRY RUN: it reads the saved sessions, the registry and git (read-only commands, GIT_OPTIONAL_LOCKS=0 and
 *   `--no-optional-locks`, so not even the index is refreshed) and writes nothing.
 * - `--apply` (refused while the dry run has a project-level blocker) makes, per eligible chat and independently: the worktree and
 *   branch with the helper's own Manager (same naming, same record, same lock), the record's session `provider:id` (what
 *   Studio.connect's wslRecord finds), and for Claude Code the move of `<id>.jsonl` (and its `<id>/` folder) from the project's
 *   folder under `~/.claude/projects` to the worktree's, after a backup copy under `<root>/import-backup/<stamp>/`.
 * - `--undo <stamp>` puts back what that run did for every chat that has no work of its own in its copy since.
 *
 * Paths use the platform's rules (osp), so the same code runs in Windows unit tests over temp folders; the real use is Linux.
 * Under test (AGENT_STUDIO_TEST=1 or AIB_WSL_TEST=1) --apply and --undo only touch folders under /tmp/aib-wsl-test-*; in a normal
 * run --apply and --undo need the project path typed again (--confirm-project).
 */
import * as osp from '../../platform/ospath.ts';
import * as wt from '../../worktrees/worktrees.ts';
import { encoded } from '../../transcripts/normalize.ts';
import { readJsonFile } from '../../state/json.ts';
import { onWindowsDrive } from './worktrees.ts';
import { openHolders } from './bgtasks.ts';

/** Printed by `import --probe`, and searched for in a helper binary by tools/wsl-import.ts: this helper knows `import`. */
export const IMPORT_MARKER = 'aib-wsl-import-v1';
export const BACKUP_DIR = 'import-backup';
/** A transcript written this recently counts as a chat that is running now. */
export const ACTIVE_MS = 120_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const STAMP = /^\d{8}-\d{6}(-\d{1,3})?$/;
const AGENTISH = /(^|[\s/])(claude|codex)(\s|$)|claude-agent-acp|claude-code-acp|codex-acp|@anthropic-ai\/claude-code|@openai\/codex/i;
const HEAD_BYTES = 4 << 20;
const MARGIN_BYTES = 256 * 1024 * 1024;

export type Provider = 'claude' | 'codex';

export interface Proc {
  pid: number;
  ppid: number;
  cwd: string;
  cmdline: string;
}

export interface ImportOptions {
  data: string;
  project: string;
  /** AIB's folder in the distro (backups); default: the data folder's parent. */
  root?: string;
  claudeDir: string;
  codexDir: string;
  /** Limits the run to these session ids (or unique prefixes of 8+ characters). */
  sessions?: string[] | null;
  now?: () => number;
  processes?: () => Proc[];
  holders?: (path: string) => [number, string][] | null;
  diskFree?: (path: string) => { bytes: number; fs: string } | null;
  writable?: (path: string) => boolean;
  env?: (name: string) => string | undefined;
}

export interface ChatLine {
  provider: Provider;
  id: string;
  /** The transcript file (Claude: <id>.jsonl; Codex: the rollout file). */
  file: string;
  /** The folder the chat was started in ('' = not found). */
  cwd: string;
  /** cwd relative to the project ('' = the project root). */
  rel: string;
  bytes: number;
  modifiedMs: number;
  status: 'eligible' | 'skip';
  code?: 'imported' | 'aib-copy' | 'other-worktree' | 'running' | 'no-cwd' | 'removed';
  reason?: string;
  key?: string;
  slug?: string;
  branch?: string;
  worktree?: string;
  /** Claude: [from, to] pairs the apply moves (the .jsonl and its folder). */
  moves?: [string, string][];
}

export interface Checks {
  projectReal: string;
  headBranch: string;
  base: string;
  baseCommit: string;
  whyInPlace: string;
  clean: boolean;
  dirty: string[];
  gitDir: string;
  gitDirWritable: boolean;
  prune: string[];
  free: { path: string; bytes: number }[];
  needBytes: number;
  backupBytes: number;
  worktreeBytes: number;
  agentsInProject: Proc[];
  registry: string;
}

export interface Applied {
  provider: Provider;
  id: string;
  ok: boolean;
  error?: string;
  worktree?: string;
  branch?: string;
  moved?: [string, string][];
}

export interface Report {
  mode: 'plan' | 'apply' | 'undo';
  project: string;
  data: string;
  root: string;
  claudeDir: string;
  codexDir: string;
  checks: Checks | null;
  blockers: string[];
  notes: string[];
  chats: ChatLine[];
  applied: Applied[];
  stamp?: string;
  backup?: string;
  refused?: string;
}

interface ManifestChat {
  provider: Provider;
  id: string;
  key: string;
  branch: string;
  worktree: string;
  snapshot: string;
  cwd: string;
  /** [original, moved-to, backup copy] */
  files: [string, string, string][];
  step: 'creating' | 'moving' | 'done' | 'failed' | 'undone';
}

interface Manifest {
  version: 1;
  stamp: string;
  project: string;
  data: string;
  claudeDir: string;
  codexDir: string;
  chats: ManifestChat[];
}

// ---- small helpers -----------------------------------------------------------------------------------------------
const text = (error: unknown) => (error instanceof Error ? error.message : String(error));

function stat(path: string): Deno.FileInfo | null {
  try {
    return Deno.statSync(path);
  } catch {
    return null;
  }
}

function lstat(path: string): Deno.FileInfo | null {
  try {
    return Deno.lstatSync(path);
  } catch {
    return null;
  }
}

/** Real path when it exists, else the normalised path; case-folded on Windows (wt.norm). */
function norm(path: string): string {
  return wt.norm(osp.normpath(path));
}

/** True when `child` is `parent` or inside it (real paths). */
export function inside(child: string, parent: string): boolean {
  const c = norm(child), p = norm(parent);
  return c === p || c.startsWith(p.endsWith(osp.SEP) ? p : p + osp.SEP);
}

function relTo(child: string, parent: string): string {
  const c = norm(child), p = norm(parent);
  if (c === p) return '';
  return c.slice(p.length + 1).replaceAll('\\', '/');
}

/** Bytes of a file, or of a folder with everything in it (symlinks not followed). */
export function treeBytes(path: string): number {
  const info = lstat(path);
  if (!info) return 0;
  if (!info.isDirectory) return info.size;
  let total = 0;
  try {
    for (const entry of Deno.readDirSync(path)) total += treeBytes(osp.join(path, entry.name));
  } catch { /* unreadable */ }
  return total;
}

function copyTree(from: string, to: string): void {
  const info = Deno.lstatSync(from);
  if (info.isSymlink) {
    Deno.symlinkSync(Deno.readLinkSync(from), to);
  } else if (info.isDirectory) {
    Deno.mkdirSync(to, { recursive: true });
    for (const entry of Deno.readDirSync(from)) copyTree(osp.join(from, entry.name), osp.join(to, entry.name));
  } else {
    Deno.copyFileSync(from, to);
    if (info.atime && info.mtime) {
      try {
        Deno.utimeSync(to, info.atime, info.mtime);
      } catch { /* times are a nicety */ }
    }
  }
}

function readHead(path: string, limit = HEAD_BYTES): string {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(path, { read: true });
  } catch {
    return '';
  }
  try {
    const buf = new Uint8Array(limit);
    let got = 0;
    while (got < limit) {
      const n = file.readSync(buf.subarray(got));
      if (!n) break;
      got += n;
    }
    return new TextDecoder().decode(buf.subarray(0, got));
  } finally {
    file.close();
  }
}

/** The distinct "cwd" values in a transcript's first bytes, in order. */
export function cwdsIn(head: string): string[] {
  const out: string[] = [];
  for (const m of head.matchAll(/"cwd"\s*:\s*("(?:[^"\\\n]|\\.)*")/g)) {
    try {
      const value = JSON.parse(m[1]);
      if (typeof value === 'string' && value && !out.includes(value)) out.push(value);
    } catch { /* cut off */ }
  }
  return out;
}

/** The folder a Claude Code chat was started in: the cwd whose encoding names its folder under projects/, else the first one. */
export function launchCwd(cwds: string[], folderName: string): string {
  return cwds.find((c) => encoded(c) === folderName) ?? cwds[0] ?? '';
}

/** `id,id` -> ids; full ids or unique prefixes of 8+ characters are matched later. */
export function sessionList(value: string): string[] {
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

function shOut(script: string, args: string[]): string | null {
  try {
    const done = new Deno.Command('/bin/sh', { args: ['-c', script, 'sh', ...args], stdin: 'null', stdout: 'piped', stderr: 'null' })
      .outputSync();
    return done.success ? new TextDecoder().decode(done.stdout) : null;
  } catch {
    return null;
  }
}

/** This user's processes from /proc (read by sh: the compiled helper may not read /proc itself). */
export function linuxProcesses(): Proc[] {
  const out = shOut(
    'for p in /proc/[0-9]*; do i=${p#/proc/}; [ "$i" = "$$" ] && continue; c=$(tr "\\0\\t\\n" "   " < "$p/cmdline" 2>/dev/null) || continue; [ -n "$c" ] || continue; ' +
      'pp=$(sed -n "s/^PPid:[[:space:]]*//p" "$p/status" 2>/dev/null); d=$(readlink "$p/cwd" 2>/dev/null); printf "%s\\t%s\\t%s\\t%s\\n" "$i" "${pp:-0}" "$d" "$c"; done',
    [],
  );
  if (out === null) return [];
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const [pid, ppid, cwd, ...rest] = line.split('\t');
    if (/^\d+$/.test(pid ?? '')) procs.push({ pid: Number(pid), ppid: Number(ppid) || 0, cwd: cwd ?? '', cmdline: rest.join(' ').trim() });
  }
  return procs;
}

function linuxDiskFree(path: string): { bytes: number; fs: string } | null {
  let at = path;
  while (at && !stat(at)) at = osp.dirname(at); // a folder not made yet: the nearest one that is
  const out = shOut('df -Pk -- "$1" 2>/dev/null | tail -n 1', [at]);
  const cols = (out ?? '').trim().split(/\s+/);
  return cols.length >= 6 && /^\d+$/.test(cols[3]) ? { bytes: Number(cols[3]) * 1024, fs: cols[0] } : null;
}

function linuxWritable(path: string): boolean {
  return shOut('test -w "$1" && echo yes', [path])?.trim() === 'yes';
}

// ---- the test guard and the confirmation ---------------------------------------------------------------------------
export const TEST_ROOT = /^\/tmp\/aib-wsl-test-[A-Za-z0-9._-]+(\/|$)/;

export function underTest(env: (name: string) => string | undefined): boolean {
  return env('AGENT_STUDIO_TEST') === '1' || env('AIB_WSL_TEST') === '1';
}

/** On Windows (unit tests only: the real tool runs in the distro): a temp folder named aib-wsl-test-*. */
function windowsTestRoot(path: string, env: (name: string) => string | undefined): boolean {
  if (!osp.WIN) return false;
  const tmp = (env('TEMP') || env('TMP') || '').replace(/[\\/]+$/, '');
  if (!tmp) return false;
  const p = osp.normcase(osp.normpath(path)), t = osp.normcase(osp.normpath(tmp));
  return p.startsWith(t + '\\aib-wsl-test-') || norm(path).startsWith(norm(tmp) + '\\aib-wsl-test-');
}

/**
 * '' when `paths` may be written by --apply / --undo; under test (AGENT_STUDIO_TEST=1 or AIB_WSL_TEST=1) only folders under
 * /tmp/aib-wsl-test-* may: a test can never move the owner's chats, whatever it passes.
 */
export function testGuard(paths: string[], env: (name: string) => string | undefined): string {
  if (!underTest(env)) return '';
  for (const path of paths) {
    const n = osp.normpath(path);
    if (!(TEST_ROOT.test(n.replaceAll('\\', '/')) && !n.split(/[\\/]/).includes('..')) && !windowsTestRoot(n, env)) {
      return `Test guard: under test, --apply and --undo only work under /tmp/aib-wsl-test-*; ${path} is not`;
    }
  }
  return '';
}

// ---- finding the project's saved sessions ---------------------------------------------------------------------------
interface Found {
  provider: Provider;
  id: string;
  file: string;
  extra: string[];
  cwd: string;
  modifiedMs: number;
  /** Claude: its folder under projects/. */
  folder?: string;
}

type Relation = { kind: 'project'; rel: string } | { kind: 'other-worktree'; where: string } | { kind: 'aib-copy' } | null;

/** The nearest folder at or above `path` (up to `stop`, exclusive) with a .git entry, or null. */
function gitTopBelow(path: string, stop: string | null): string | null {
  let at = osp.normpath(path);
  for (let i = 0; i < 64; i++) {
    if (stop && norm(at) === norm(stop)) return null;
    if (lstat(osp.join(at, '.git'))) return at;
    const up = osp.dirname(at);
    if (up === at) return null;
    at = up;
  }
  return null;
}

/** How a chat's folder relates to the project: inside it (rel), inside another git worktree of it, inside AIB's copies of it. */
export function relation(cwd: string, project: string, aibRoot: string): Relation {
  if (!cwd || !osp.isabs(cwd)) return null;
  if (inside(cwd, aibRoot)) return { kind: 'aib-copy' };
  if (inside(cwd, project)) {
    const rel = relTo(cwd, project);
    if (/^\.claude\/worktrees(\/|$)/.test(rel)) return { kind: 'other-worktree', where: cwd };
    const top = stat(cwd) ? gitTopBelow(cwd, project) : null; // a nested repository or worktree inside the project folder
    if (top) return { kind: 'other-worktree', where: top };
    return { kind: 'project', rel };
  }
  // elsewhere: a linked worktree of this repository made by another tool (its main checkout is the project)
  if (!stat(cwd)) return null;
  const top = gitTopBelow(cwd, null);
  if (top && Deno.lstatSync(osp.join(top, '.git')).isFile) {
    const main = wt.mainCheckoutOf(top);
    if (main && wt.same(main[0], project)) return { kind: 'other-worktree', where: top };
  }
  return null;
}

function claudeSessions(claudeDir: string, project: string, aibRoot: string): (Found & { relation: Relation })[] {
  const root = osp.join(claudeDir, 'projects');
  const near = encoded(project); // the project's real path: what Claude Code names its folder after
  const out: (Found & { relation: Relation })[] = [];
  let folders: string[];
  try {
    folders = [...Deno.readDirSync(root)].filter((e) => e.isDirectory).map((e) => e.name).sort();
  } catch {
    return out;
  }
  for (const folder of folders) {
    const dir = osp.join(root, folder);
    let names: string[];
    try {
      names = [...Deno.readDirSync(dir)].filter((e) => e.isFile && e.name.endsWith('.jsonl') && UUID.test(e.name.slice(0, -6))).map((e) =>
        e.name
      ).sort();
    } catch {
      continue;
    }
    if (!names.length) continue;
    const isNear = folder === near || folder.startsWith(near + '-');
    if (!isNear) {
      // another folder: only looked at when its first chat ran in a worktree of this repository or in AIB's copies of it
      const cwds = cwdsIn(readHead(osp.join(dir, names[0]), 256 * 1024));
      const r = relation(launchCwd(cwds, folder), project, aibRoot);
      if (!r || r.kind === 'project') {
        // a moved (imported) chat: its folder encodes an AIB copy, its records still name the project
        if (!(r?.kind === 'project' && folder.startsWith(encoded(aibRoot)))) continue;
      }
    }
    for (const name of names) {
      const file = osp.join(dir, name);
      const id = name.slice(0, -6);
      const cwds = cwdsIn(readHead(file));
      const cwd = launchCwd(cwds, folder);
      const extraDir = osp.join(dir, id);
      const info = stat(file);
      out.push({
        provider: 'claude',
        id,
        file,
        extra: stat(extraDir)?.isDirectory ? [extraDir] : [],
        cwd,
        modifiedMs: info?.mtime?.getTime() ?? 0,
        folder,
        relation: relation(cwd, project, aibRoot),
      });
    }
  }
  return out;
}

function rolloutFiles(dir: string, depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = osp.join(dir, e.name);
    if (e.isDirectory) rolloutFiles(full, depth + 1, out);
    else if (e.isFile && ROLLOUT.test(e.name)) out.push(full);
  }
  return out;
}

/** {id, cwd} from a Codex rollout's first line (session_meta), else the file name's id and the first cwd seen. */
export function rolloutMeta(head: string, name: string): { id: string; cwd: string } {
  const first = head.split('\n', 1)[0];
  let id = '', cwd = '';
  try {
    const row = JSON.parse(first);
    const payload = row?.payload ?? {};
    if (typeof payload.id === 'string') id = payload.id;
    if (typeof payload.cwd === 'string') cwd = payload.cwd;
  } catch { /* a first line longer than the read: below */ }
  if (!cwd) cwd = cwdsIn(head)[0] ?? '';
  if (!UUID.test(id)) id = ROLLOUT.exec(name)?.[1] ?? '';
  return { id, cwd };
}

function codexSessions(codexDir: string, project: string, aibRoot: string): (Found & { relation: Relation })[] {
  const out: (Found & { relation: Relation })[] = [];
  for (const file of rolloutFiles(osp.join(codexDir, 'sessions'))) {
    const { id, cwd } = rolloutMeta(readHead(file, 1 << 20), osp.basename(file));
    if (!id) continue;
    const r = relation(cwd, project, aibRoot);
    if (!r) continue;
    out.push({ provider: 'codex', id, file, extra: [], cwd, modifiedMs: stat(file)?.mtime?.getTime() ?? 0, relation: r });
  }
  return out;
}

// ---- the plan (dry run) --------------------------------------------------------------------------------------------
function defaults(o: ImportOptions) {
  return {
    now: o.now ?? (() => Date.now()),
    processes: o.processes ?? (osp.WIN ? () => [] : linuxProcesses),
    holders: o.holders ?? (osp.WIN ? () => [] : openHolders),
    diskFree: o.diskFree ?? (osp.WIN ? () => null : linuxDiskFree),
    writable: o.writable ?? (osp.WIN ? () => true : linuxWritable),
    env: o.env ?? ((n: string) => Deno.env.get(n)),
  };
}

/** The processes of this run and its parents (their command lines name the sessions given): never "the chat is running". */
function ownTree(procs: Proc[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const own = new Set<number>([Deno.pid]);
  let at = byPid.get(Deno.pid)?.ppid ?? 0;
  for (let i = 0; at > 1 && i < 32; i++) {
    own.add(at);
    at = byPid.get(at)?.ppid ?? 0;
  }
  return own;
}

async function git(args: string[], cwd: string): Promise<wt.GitResult> {
  return await wt.git(args, cwd, { check: false, timeout: 120 });
}

const fmtBytes = (n: number) =>
  n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} GB` : n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`;

/** Bytes of the files at HEAD (a worktree checkout's size, about). */
async function headBytes(project: string): Promise<number> {
  const done = await git(['ls-tree', '-r', '-l', '--full-tree', 'HEAD'], project);
  let total = 0;
  for (const line of done.stdout.split('\n')) {
    const size = line.split(/\s+/)[3];
    if (size && /^\d+$/.test(size)) total += Number(size);
  }
  return total;
}

async function projectChecks(
  o: ImportOptions,
  project: string,
  d: ReturnType<typeof defaults>,
): Promise<{ checks: Checks; blockers: string[]; notes: string[] }> {
  const blockers: string[] = [], notes: string[] = [];
  const checks: Checks = {
    projectReal: project,
    headBranch: '',
    base: '',
    baseCommit: '',
    whyInPlace: '',
    clean: false,
    dirty: [],
    gitDir: '',
    gitDirWritable: false,
    prune: [],
    free: [],
    needBytes: 0,
    backupBytes: 0,
    worktreeBytes: 0,
    agentsInProject: [],
    registry: 'ok',
  };
  if (onWindowsDrive(project)) blockers.push('The project is on a Windows drive (/mnt/...): AIB makes no worktree copies there');
  if (onWindowsDrive(o.data)) blockers.push("AIB's data folder is on a Windows drive (/mnt/...)");
  if (!stat(o.data)?.isDirectory) {
    blockers.push(`AIB's data folder ${o.data} does not exist: is this the data folder of the AIB you use (Settings > About)?`);
  }
  try {
    checks.whyInPlace = await wt.whyInPlace(project);
  } catch (error) {
    checks.whyInPlace = `git could not be read: ${text(error)}`;
  }
  if (checks.whyInPlace) {
    blockers.push(`This project cannot get worktree copies: ${checks.whyInPlace}`);
    return { checks, blockers, notes };
  }
  checks.headBranch = (await git(['symbolic-ref', '--short', 'HEAD'], project)).stdout.trim();
  checks.base = await wt.mainBranch(project, checks.headBranch);
  checks.baseCommit = (await git(['rev-parse', '--verify', '-q', `refs/heads/${checks.base}^{commit}`], project)).stdout.trim();
  if (checks.base !== checks.headBranch) {
    notes.push(`The project folder has ${checks.headBranch} checked out; the copies start from ${checks.base} (as a new chat's would)`);
  }
  const status = await git(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=normal'], project);
  if (status.returncode !== 0) {
    blockers.push(`git status failed: ${status.stderr.trim().slice(0, 300)}`);
  } else {
    const entries: string[] = [];
    const parts = status.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (!entry) continue;
      entries.push(entry);
      if (entry[0] === 'R' || entry[0] === 'C') i++; // a rename's second path
    }
    checks.dirty = entries;
    checks.clean = entries.length === 0;
    if (!checks.clean) {
      blockers.push(
        `The main checkout has uncommitted work (${entries.length} ${
          entries.length === 1 ? 'entry' : 'entries'
        }): commit, merge or remove it on ${checks.headBranch} first`,
      );
    }
  }
  checks.gitDir = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], project)).stdout.trim();
  checks.gitDirWritable = !!checks.gitDir && d.writable(checks.gitDir);
  if (!checks.gitDirWritable) blockers.push(`The repository's .git folder (${checks.gitDir || 'unknown'}) cannot be written by this user`);
  const prune = await git(['worktree', 'prune', '--dry-run', '-v'], project);
  checks.prune = (prune.stdout + prune.stderr).split('\n').map((l) => l.trim()).filter(Boolean);
  if (checks.prune.length) {
    notes.push(
      `git worktree prune would drop ${checks.prune.length} stale worktree entr${
        checks.prune.length === 1 ? 'y' : 'ies'
      } (this tool does not prune)`,
    );
  }
  const [regStatus] = readJsonFile(new wt.Registry(o.data).path);
  if (regStatus !== 'ok' && regStatus !== 'missing') {
    checks.registry = regStatus;
    blockers.push(`AIB's worktree registry cannot be read (${regStatus})`);
  }
  // agents running in the project folder: one of them may be one of these chats (AIB cannot tell which)
  const procs = d.processes();
  const own = ownTree(procs);
  checks.agentsInProject = procs.filter((p) =>
    !own.has(p.pid) && p.cwd && AGENTISH.test(p.cmdline) && inside(p.cwd, project) && !/\.claude\/worktrees\//.test(p.cwd)
  );
  if (checks.agentsInProject.length) {
    blockers.push(
      `${checks.agentsInProject.length} agent process${checks.agentsInProject.length === 1 ? '' : 'es'} run in the project folder (pid ${
        checks.agentsInProject.map((p) => p.pid).join(', ')
      }): stop those chats first (in AIB, VS Code or the terminal); AIB cannot tell which chat each one holds`,
    );
  }
  return { checks, blockers, notes };
}

/** Matches ids given on the command line against the found sessions: full ids, or unique prefixes of 8+ characters. */
export function pickSessions(asked: string[] | null | undefined, ids: string[]): { picked: Set<string> | null; error: string } {
  if (!asked || !asked.length) return { picked: null, error: '' };
  const picked = new Set<string>();
  for (const want of asked) {
    const hits = ids.filter((id) => id === want || (want.length >= 8 && id.startsWith(want)));
    if (hits.length !== 1) {
      return { picked: null, error: hits.length ? `${want} matches more than one chat` : `No chat of this project has the id ${want}` };
    }
    picked.add(hits[0]);
  }
  return { picked, error: '' };
}

/** The dry run: what --apply would do, and why it would refuse. Writes nothing. */
export async function planImport(o: ImportOptions): Promise<Report> {
  const d = defaults(o);
  const root = o.root ?? osp.dirname(osp.normpath(o.data));
  const report: Report = {
    mode: 'plan',
    project: o.project,
    data: o.data,
    root,
    claudeDir: o.claudeDir,
    codexDir: o.codexDir,
    checks: null,
    blockers: [],
    notes: [],
    chats: [],
    applied: [],
  };
  // under test even the dry run reads nothing outside the test root (never the owner's ~/.claude or ~/.codex)
  const guard = testGuard([o.project, o.data, root, o.claudeDir, o.codexDir], d.env);
  if (guard) {
    report.refused = guard;
    return report;
  }
  if (!osp.isabs(o.project) || !stat(o.project)?.isDirectory) {
    report.blockers.push(`${o.project} is not a folder`);
    return report;
  }
  const project = osp.realpath(o.project);
  const { checks, blockers, notes } = await projectChecks(o, project, d);
  report.checks = checks;
  report.blockers.push(...blockers);
  report.notes.push(...notes);
  const manager = new wt.Manager(o.data);
  const aibRoot = osp.join(manager.registry.root, wt.repoHash(project));
  const found = [...claudeSessions(o.claudeDir, project, aibRoot), ...codexSessions(o.codexDir, project, aibRoot)];
  const { picked, error } = pickSessions(o.sessions, found.map((f) => f.id));
  if (error) report.blockers.push(error);
  const records = Object.entries(manager.registry.all());
  const removed = Object.values(manager.registry.removed());
  const procs = d.processes();
  const own = ownTree(procs);
  const now = d.now();
  const slugs = new Set<string>();
  for (const f of found.sort((a, b) => b.modifiedMs - a.modifiedMs)) {
    if (picked && !picked.has(f.id)) continue;
    const bytes = treeBytes(f.file) + f.extra.reduce((n, x) => n + treeBytes(x), 0);
    const line: ChatLine = {
      provider: f.provider,
      id: f.id,
      file: f.file,
      cwd: f.cwd,
      rel: f.relation?.kind === 'project' ? f.relation.rel : '',
      bytes,
      modifiedMs: f.modifiedMs,
      status: 'skip',
    };
    report.chats.push(line);
    const session = `${f.provider}:${f.id}`;
    const record = records.find(([, r]) => r.session === session);
    const holders = (d.holders(f.file) ?? []).filter(([pid]) => !own.has(pid));
    const named = procs.filter((p) => !own.has(p.pid) && p.cmdline.includes(f.id));
    const age = now - f.modifiedMs;
    if (record) {
      const imported = !!(record[1].imported);
      line.code = imported ? 'imported' : 'aib-copy';
      line.reason = `${imported ? 'already imported' : 'already has its own AIB copy'} (${record[1].path}, ${record[1].branch})`;
    } else if (removed.some((r) => r.session === session)) {
      line.code = 'removed';
      line.reason = 'its AIB copy was discarded: AIB keeps it read-only';
    } else if (!f.cwd) {
      line.code = 'no-cwd';
      line.reason = 'no working folder is recorded in its history';
    } else if (f.relation?.kind === 'other-worktree') {
      line.code = 'other-worktree';
      line.reason = `it works in another worktree (${f.relation.where}), not an AIB copy: left alone`;
    } else if (f.relation?.kind === 'aib-copy') {
      line.code = 'aib-copy';
      line.reason = "it ran in one of AIB's copies but has no record (left alone)";
    } else if (named.length || holders.length || age < ACTIVE_MS) {
      line.code = 'running';
      const why = named.length
        ? `process ${named.map((p) => p.pid).join(', ')} names it`
        : holders.length
        ? `process ${holders.map(([pid]) => pid).join(', ')} has its history open`
        : `its history was written ${Math.max(0, Math.round(age / 1000))} s ago`;
      line.reason = `running now (${why}): stop it first`;
    } else if (f.relation?.kind === 'project') {
      line.status = 'eligible';
    } else {
      line.code = 'no-cwd';
      line.reason = `its folder ${f.cwd} is not in the project`;
    }
    if (line.status !== 'eligible' || checks.whyInPlace) continue;
    // what the apply would make: the helper's own plan (key from the session id: branch studio/chat-<first 8 of the id>)
    const key = f.id.replaceAll('-', '');
    const planned = await manager.planWithReason(project, key, 'chat');
    if (!planned.plan) {
      line.status = 'skip';
      line.code = 'no-cwd';
      line.reason = `no worktree can be planned: ${planned.reason}`;
      continue;
    }
    let slug = planned.plan.slug;
    for (let n = 1; slugs.has(slug); n++) slug = `${planned.plan.slug}-${n}`; // two chats whose ids start alike
    slugs.add(slug);
    line.key = key;
    line.slug = slug;
    line.branch = `studio/${slug}`;
    line.worktree = osp.join(osp.dirname(planned.plan.path), slug);
    if (f.provider === 'claude') line.moves = movesFor(o.claudeDir, f, line.worktree);
  }
  const eligible = report.chats.filter((c) => c.status === 'eligible');
  report.notes.push(
    'Git-ignored and excluded folders (.gitignore, .git/info/exclude, e.g. private/) are not copied or touched: they stay in the main ' +
      "folder, as for any new chat's copy (a chat reaches them through AIB's local-only folders)",
  );
  checks.backupBytes = eligible.filter((c) => c.provider === 'claude').reduce((n, c) => n + c.bytes, 0);
  checks.worktreeBytes = checks.baseCommit ? await headBytes(project) : 0;
  checks.needBytes = checks.backupBytes + checks.worktreeBytes * eligible.length;
  const seen = new Set<string>();
  for (const path of [root, o.data]) {
    const free = d.diskFree(path);
    if (!free || seen.has(free.fs)) continue;
    seen.add(free.fs);
    checks.free.push({ path, bytes: free.bytes });
  }
  const least = checks.free.length ? Math.min(...checks.free.map((f) => f.bytes)) : null;
  if (least !== null && least < checks.needBytes + MARGIN_BYTES) {
    report.blockers.push(`Not enough disk space: ${fmtBytes(least)} free, about ${fmtBytes(checks.needBytes + MARGIN_BYTES)} needed`);
  }
  for (const c of eligible) {
    for (const [, to] of c.moves ?? []) if (lstat(to)) report.blockers.push(`${to} already exists (chat ${c.id})`);
  }
  return report;
}

/** Claude Code finds a session in the folder named after the agent's cwd: the worktree's, once the chat runs there. */
function movesFor(claudeDir: string, f: Found, worktree: string): [string, string][] {
  const target = osp.join(claudeDir, 'projects', encoded(worktree));
  return [
    [f.file, osp.join(target, osp.basename(f.file))],
    ...f.extra.map((x): [string, string] => [x, osp.join(target, osp.basename(x))]),
  ];
}

// ---- apply ---------------------------------------------------------------------------------------------------------
export function stampOf(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${
    p(d.getUTCSeconds())
  }`;
}

function saveManifest(path: string, manifest: Manifest): void {
  const tmp = `${path}.part`;
  Deno.writeTextFileSync(tmp, JSON.stringify(manifest, null, 1) + '\n', { mode: 0o600 });
  Deno.renameSync(tmp, path);
}

/** Refusal text when --apply / --undo may not run with these options, else ''. */
export function applyRefusal(o: ImportOptions, confirm: string | null, root: string): string {
  const d = defaults(o);
  const guard = testGuard([o.project, o.data, root, o.claudeDir, o.codexDir], d.env);
  if (guard) return guard;
  if (!underTest(d.env) && (confirm === null || osp.normpath(confirm) !== osp.normpath(o.project))) {
    return `To change anything, type the project path again: --confirm-project ${o.project}`;
  }
  return '';
}

/** --apply: the plan, then each eligible chat on its own. Refused while the plan has a blocker. */
export async function applyImport(o: ImportOptions, confirm: string | null): Promise<Report> {
  const d = defaults(o);
  const report = await planImport(o);
  report.mode = 'apply';
  const refused = applyRefusal(o, confirm, report.root);
  if (refused) {
    report.refused = refused;
    return report;
  }
  if (report.blockers.length) {
    report.refused = 'Nothing was changed: fix the blockers above first';
    return report;
  }
  const eligible = report.chats.filter((c) => c.status === 'eligible');
  if (!eligible.length) return report;
  const project = report.checks!.projectReal;
  let stamp = stampOf(d.now());
  let backup = osp.join(report.root, BACKUP_DIR, stamp);
  for (let n = 1; lstat(backup); n++) backup = osp.join(report.root, BACKUP_DIR, stamp = `${stampOf(d.now())}-${n}`);
  Deno.mkdirSync(backup, { recursive: true, mode: 0o700 });
  report.stamp = stamp;
  report.backup = backup;
  const manifestPath = osp.join(backup, 'manifest.json');
  const manifest: Manifest = { version: 1, stamp, project, data: o.data, claudeDir: o.claudeDir, codexDir: o.codexDir, chats: [] };
  saveManifest(manifestPath, manifest);
  const manager = new wt.Manager(o.data);
  for (const chat of eligible) {
    const done: Applied = { provider: chat.provider, id: chat.id, ok: false };
    report.applied.push(done);
    try {
      await applyOne(o, d, manager, project, chat, backup, manifest, () => saveManifest(manifestPath, manifest), done);
      done.ok = true;
    } catch (error) {
      done.error = text(error);
    }
  }
  saveManifest(manifestPath, manifest);
  return report;
}

async function applyOne(
  o: ImportOptions,
  d: ReturnType<typeof defaults>,
  manager: wt.Manager,
  project: string,
  chat: ChatLine,
  backup: string,
  manifest: Manifest,
  save: () => void,
  done: Applied,
): Promise<void> {
  // checked again just before: still where it was, still not running, still no record
  const info = stat(chat.file);
  if (!info) throw new Error(`its history ${chat.file} is gone`);
  if (d.now() - (info.mtime?.getTime() ?? 0) < ACTIVE_MS) {
    throw new Error('its history was written in the last two minutes: it may be running');
  }
  const procs = d.processes();
  const own = ownTree(procs);
  if (procs.some((p) => !own.has(p.pid) && p.cmdline.includes(chat.id))) throw new Error('a process names it now: it may be running');
  const session = `${chat.provider}:${chat.id}`;
  if (Object.values(manager.registry.all()).some((r) => r.session === session)) throw new Error('it has a worktree record already');
  for (const [, to] of chat.moves ?? []) if (lstat(to)) throw new Error(`${to} already exists`);
  // 1. the backup copies (never under ~/.claude)
  const files: [string, string, string][] = [];
  for (const [from, to] of chat.moves ?? []) {
    const copy = osp.join(backup, chat.provider, osp.basename(osp.dirname(from)), osp.basename(from));
    Deno.mkdirSync(osp.dirname(copy), { recursive: true, mode: 0o700 });
    copyTree(from, copy);
    if (treeBytes(copy) !== treeBytes(from)) throw new Error(`the backup copy of ${from} is incomplete`);
    files.push([from, to, copy]);
  }
  // 2. the worktree, its branch and its record, by the helper's own Manager (the same lock and atomic write as AIB's helper)
  const key = Object.keys(manager.registry.all()).includes(chat.key!) ? crypto.randomUUID().replaceAll('-', '') : chat.key!;
  const planned = await manager.planWithReason(project, key, 'chat');
  if (!planned.plan) throw new Error(`no worktree can be planned: ${planned.reason}`);
  const plan = planned.plan;
  const entry: ManifestChat = {
    provider: chat.provider,
    id: chat.id,
    key,
    branch: plan.branch,
    worktree: plan.path,
    snapshot: '',
    cwd: chat.cwd,
    files: files.map(([from, , copy]) => [from, osp.join(o.claudeDir, 'projects', encoded(plan.path), osp.basename(from)), copy]),
    step: 'creating',
  };
  manifest.chats.push(entry);
  save();
  try {
    await manager.create(plan);
  } catch (error) {
    entry.step = 'failed';
    save();
    throw error;
  }
  const record = manager.registry.get(key)!;
  entry.snapshot = String(record.snapshot ?? '');
  await manager.registry.update(key, { session, imported: { at: Math.round(d.now() / 1000), from: chat.cwd, backup: manifest.stamp } });
  done.worktree = plan.path;
  done.branch = plan.branch;
  // 3. the history moves next to the worktree's folder name (Claude Code looks a session up under the agent's cwd)
  entry.step = 'moving';
  save();
  const moved: [string, string][] = [];
  try {
    for (const [from, to] of entry.files) {
      Deno.mkdirSync(osp.dirname(to), { recursive: true });
      if (lstat(to)) throw new Error(`${to} already exists`);
      Deno.renameSync(from, to);
      moved.push([from, to]);
    }
  } catch (error) {
    for (const [from, to] of moved.reverse()) {
      try {
        Deno.renameSync(to, from);
      } catch { /* the manifest and the backup still have it */ }
    }
    await manager.discard(key);
    entry.step = 'failed';
    save();
    throw new Error(`moving its history failed, so its copy was removed again: ${text(error)}`);
  }
  done.moved = moved;
  entry.step = 'done';
  save();
}

// ---- undo ----------------------------------------------------------------------------------------------------------
function readManifest(root: string, stamp: string): Manifest {
  if (!STAMP.test(stamp)) throw new Error(`${stamp} is not an import stamp (like 20261115-142233)`);
  const path = osp.join(root, BACKUP_DIR, stamp, 'manifest.json');
  const raw = JSON.parse(Deno.readTextFileSync(path));
  if (raw?.version !== 1 || !Array.isArray(raw.chats)) throw new Error(`${path} is not an import manifest`);
  return raw as Manifest;
}

/**
 * --undo <stamp>: for each chat of that run (or the --sessions ones) that has no work of its own in its copy (no commit beyond its
 * start, no changed or new file) and is not running: its worktree, branch and record go, and its history moves back (the moved
 * file, so nothing said since is lost; the backup copy if it is gone). A chat with work of its own is reported and left as it is.
 */
export async function undoImport(o: ImportOptions, stamp: string, confirm: string | null): Promise<Report> {
  const d = defaults(o);
  const root = o.root ?? osp.dirname(osp.normpath(o.data));
  const report: Report = {
    mode: 'undo',
    project: o.project,
    data: o.data,
    root,
    claudeDir: o.claudeDir,
    codexDir: o.codexDir,
    checks: null,
    blockers: [],
    notes: [],
    chats: [],
    applied: [],
    stamp,
    backup: osp.join(root, BACKUP_DIR, stamp),
  };
  const refused = applyRefusal(o, confirm, root);
  if (refused) {
    report.refused = refused;
    return report;
  }
  let manifest: Manifest;
  try {
    manifest = readManifest(root, stamp);
  } catch (error) {
    report.refused = text(error);
    return report;
  }
  if (!stat(o.project) || norm(manifest.project) !== norm(o.project) || norm(manifest.data) !== norm(o.data)) {
    report.refused = `That import was of ${manifest.project} with data folder ${manifest.data}`;
    return report;
  }
  const { picked, error } = pickSessions(o.sessions, manifest.chats.map((c) => c.id));
  if (error) {
    report.refused = error;
    return report;
  }
  const manager = new wt.Manager(o.data);
  const manifestPath = osp.join(root, BACKUP_DIR, stamp, 'manifest.json');
  for (const entry of manifest.chats) {
    if (picked && !picked.has(entry.id)) continue;
    const done: Applied = { provider: entry.provider, id: entry.id, ok: false, worktree: entry.worktree, branch: entry.branch };
    report.applied.push(done);
    try {
      await undoOne(d, manager, manifest.project, entry);
      done.ok = true;
      saveManifest(manifestPath, manifest);
    } catch (error) {
      done.error = text(error);
    }
  }
  return report;
}

async function undoOne(d: ReturnType<typeof defaults>, manager: wt.Manager, project: string, entry: ManifestChat): Promise<void> {
  if (entry.step === 'undone') throw new Error('already undone');
  const record = manager.registry.get(entry.key);
  if (record && record.session !== `${entry.provider}:${entry.id}`) throw new Error('its worktree record now belongs to another chat');
  // never while it runs
  const procs = d.processes();
  const own = ownTree(procs);
  if (procs.some((p) => !own.has(p.pid) && p.cmdline.includes(entry.id))) throw new Error('a process names it: stop the chat first');
  for (const [, to] of entry.files) {
    const info = stat(to);
    if (info?.isFile && d.now() - (info.mtime?.getTime() ?? 0) < ACTIVE_MS) {
      throw new Error('its history was written in the last two minutes: stop the chat first');
    }
  }
  if (procs.some((p) => !own.has(p.pid) && p.cwd && inside(p.cwd, entry.worktree))) {
    throw new Error('a process works in its copy: stop the chat first');
  }
  // nothing of its own in the copy since the import
  if (record && stat(entry.worktree)) {
    const branchHead = (await git(['rev-parse', '--verify', '-q', `refs/heads/${entry.branch}`], project)).stdout.trim();
    if (branchHead && entry.snapshot) {
      const ahead = (await git(['rev-list', '--count', `${entry.snapshot}..${branchHead}`], project)).stdout.trim();
      if (ahead !== '0') throw new Error(`its copy has ${ahead} commit(s) of its own: ask its chat in AIB to merge it into the project first`);
    }
    if (await manager.hasChanges(record)) throw new Error('its copy has changed or new files: ask its chat in AIB to merge it into the project first');
  }
  // every file can go back (checked before anything changes)
  for (const [from, to, copy] of entry.files) {
    if (lstat(from)) throw new Error(`${from} exists again: move it aside by hand first`);
    if (!lstat(to) && !lstat(copy)) throw new Error(`neither ${to} nor its backup ${copy} exists`);
  }
  // the copy goes (no "removed" note: the chat stays continuable in the project folder), then the history comes back
  if (stat(entry.worktree)) {
    if (!manager.insideRoot(entry.worktree)) throw new Error(`${entry.worktree} is not in AIB's worktrees folder`);
    const removed = await git(['worktree', 'remove', entry.worktree], project);
    if (removed.returncode !== 0) throw new Error(`git worktree remove failed: ${removed.stderr.trim().slice(0, 300)}`);
  }
  await git(['worktree', 'prune'], project);
  const tip = (await git(['rev-parse', '--verify', '-q', `refs/heads/${entry.branch}`], project)).stdout.trim();
  if (tip && entry.branch.startsWith('studio/') && (!entry.snapshot || tip === entry.snapshot)) {
    await git(['branch', '-D', entry.branch], project);
  }
  await wt.unpinUserBase(project, { branch: entry.branch });
  await manager.registry.remove(entry.key);
  for (const [from, to, copy] of entry.files) {
    Deno.mkdirSync(osp.dirname(from), { recursive: true });
    if (lstat(to)) Deno.renameSync(to, from);
    else copyTree(copy, from);
  }
  for (const [, to] of entry.files.slice(0, 1)) {
    try {
      Deno.removeSync(osp.dirname(to)); // the worktree's folder under projects/, only when empty
    } catch { /* not empty */ }
  }
  entry.step = 'undone';
}

// ---- the report ----------------------------------------------------------------------------------------------------
export function formatReport(r: Report, command = 'AIB-wsl-helper import'): string {
  const out: string[] = [];
  const title = r.mode === 'plan'
    ? 'DRY RUN: nothing was changed'
    : r.mode === 'apply'
    ? (r.refused ? 'APPLY refused: nothing was changed' : 'APPLY')
    : (r.refused ? 'UNDO refused: nothing was changed' : 'UNDO');
  out.push(`AIB: move existing chats into their own copies (${title})`);
  out.push(`Project    ${r.project}`);
  out.push(`AIB data   ${r.data}`);
  const c = r.checks;
  if (c) {
    if (c.base) out.push(`Base       ${c.base} at ${c.baseCommit.slice(0, 10)} (the project folder has ${c.headBranch} checked out)`);
    out.push('Checks');
    out.push(`  ${c.clean ? 'ok   ' : 'BLOCK'} main checkout ${c.clean ? 'is clean' : `has uncommitted work (${c.dirty.length})`}`);
    for (const e of c.dirty.slice(0, 30)) out.push(`          ${e}`);
    if (c.dirty.length > 30) out.push(`          ... and ${c.dirty.length - 30} more`);
    if (c.gitDir) out.push(`  ${c.gitDirWritable ? 'ok   ' : 'BLOCK'} ${c.gitDir} ${c.gitDirWritable ? 'is writable' : 'is not writable'}`);
    for (const f of c.free) out.push(`  disk ${fmtBytes(f.bytes)} free at ${f.path}`);
    out.push(
      `  disk needs about ${fmtBytes(c.needBytes)} (backups ${fmtBytes(c.backupBytes)} + a ${fmtBytes(c.worktreeBytes)} checkout per copy)`,
    );
    for (const p of c.agentsInProject) out.push(`  BLOCK agent pid ${p.pid} in ${p.cwd}: ${p.cmdline.slice(0, 120)}`);
    for (const p of c.prune.slice(0, 10)) out.push(`  note ${p}`);
  }
  for (const b of r.blockers) out.push(`BLOCKER: ${b}`);
  for (const n of r.notes) out.push(`Note: ${n}`);
  if (r.mode !== 'undo') {
    const eligible = r.chats.filter((x) => x.status === 'eligible');
    out.push(`Chats (${eligible.length} eligible, ${r.chats.length - eligible.length} skipped)`);
    for (const x of r.chats) {
      const when = x.modifiedMs ? new Date(x.modifiedMs).toISOString().slice(0, 16).replace('T', ' ') : '?';
      const head = `${x.provider.padEnd(6)} ${x.id}  ${fmtBytes(x.bytes).padStart(8)}  ${when}`;
      if (x.status === 'eligible') {
        out.push(`  MOVE ${head}`);
        out.push(
          `         copy ${x.worktree}  branch ${x.branch}${x.rel ? `  (it started in ${x.rel}/: it opens at the copy's root)` : ''}`,
        );
        for (const [from, to] of x.moves ?? []) out.push(`         move ${from}\n           -> ${to}`);
        if (x.provider === 'codex') out.push('         history stays where it is (Codex finds a session by its id)');
      } else {
        out.push(`  SKIP ${head}  ${x.reason ?? ''}`);
      }
    }
  }
  for (const a of r.applied) {
    out.push(
      `  ${a.ok ? 'DONE' : 'FAIL'} ${a.provider} ${a.id}${a.ok ? (a.branch ? `  ${a.branch}  ${a.worktree}` : '') : `  ${a.error}`}`,
    );
  }
  if (r.refused) out.push(`REFUSED: ${r.refused}`);
  if (r.backup && r.mode === 'apply' && r.applied.length) {
    out.push(`Backup copies: ${r.backup}`);
    out.push(`To undo: ${command} --project ${r.project} --undo ${r.stamp} --confirm-project ${r.project}`);
  }
  if (r.mode === 'plan') {
    const n = r.chats.filter((x) => x.status === 'eligible').length;
    out.push(
      r.blockers.length
        ? `Result: ${n} chat(s) would get their own copy once the ${r.blockers.length} blocker(s) are fixed.`
        : `Result: ${n} chat(s) would get their own copy. To do it: ${command} --project ${r.project} --apply --confirm-project ${r.project}`,
    );
  }
  return out.join('\n');
}

// ---- the subcommand ------------------------------------------------------------------------------------------------
function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

/** `AIB-wsl-helper import ...`: exit 0 done (or a clean plan), 2 refused or blocked, 3 a chat failed, 1 bad arguments. */
export async function importMain(args: string[]): Promise<number> {
  if (args.includes('--probe')) {
    console.log(IMPORT_MARKER);
    return 0;
  }
  const data = flag(args, '--data'), project = flag(args, '--project');
  if (!data || !project || !osp.isabs(data) || !osp.isabs(project)) {
    console.error(
      'usage: AIB-wsl-helper import --data <AIB data folder> --project <project folder> [--apply --confirm-project <project folder>]',
    );
    console.error(
      '       [--undo <stamp> --confirm-project <project folder>] [--sessions id,id] [--root <AIB folder>] [--claude-dir D] [--codex-dir D] [--json]',
    );
    return 1;
  }
  const home = Deno.env.get('HOME') ?? '/';
  const options: ImportOptions = {
    data: osp.normpath(data),
    project: osp.normpath(project),
    ...(flag(args, '--root') ? { root: osp.normpath(flag(args, '--root')!) } : {}),
    claudeDir: osp.normpath(flag(args, '--claude-dir') || Deno.env.get('CLAUDE_CONFIG_DIR') || osp.join(home, '.claude')),
    codexDir: osp.normpath(flag(args, '--codex-dir') || Deno.env.get('CODEX_HOME') || osp.join(home, '.codex')),
    sessions: flag(args, '--sessions') ? sessionList(flag(args, '--sessions')!) : null,
  };
  const confirm = flag(args, '--confirm-project');
  const undo = flag(args, '--undo');
  let report: Report;
  if (undo) report = await undoImport(options, undo, confirm);
  else if (args.includes('--apply')) report = await applyImport(options, confirm);
  else report = await planImport(options);
  console.log(args.includes('--json') ? JSON.stringify(report) : formatReport(report));
  if (report.refused || (report.mode === 'plan' && report.blockers.length)) return 2;
  return report.applied.some((a) => !a.ok) ? 3 : 0;
}
