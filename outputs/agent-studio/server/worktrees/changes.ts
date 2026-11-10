/**
 * Read-only "Changes" data for a chat's folder: what git sees as uncommitted (status + diff against HEAD) (changes.py).
 *
 * Everything here only reads. git is run with an argument list (never a shell), a timeout and an output cap, with hooks, external
 * diff drivers and optional index locks switched off. Paths from the page must match a path git itself reported.
 */
import { clip } from '../core/py.ts';
import { which } from '../platform/pypath.ts';
import * as osp from '../platform/ospath.ts';

export const MAX_FILES = 300; // files listed; the rest only counted
export const MAX_DIFF_BYTES = 200 * 1024; // per-file diff (and untracked file read) cap
export const MAX_LIST_BYTES = 4 * 1024 * 1024; // status / numstat output cap
export const MAX_LINE_CHARS = 2000; // a diff line longer than this is cut
export const GIT_TIMEOUT = 15;
export const BINARY_PROBE = 8192;
export const EMPTY_TREE = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};
const BASE = [
  '-c',
  'core.quotepath=off',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.pager=cat',
  '--no-pager',
  '--no-optional-locks',
  '--literal-pathspecs',
];

export class ChangesError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid') {
    super(message);
    this.name = 'ChangesError';
    this.code = code;
  }
}

/** Replaceable lookups (tests swap them). */
export const hooks = {
  gitPath: (): string | null => which('git'),
};

export function gitPath(): string | null {
  return hooks.gitPath();
}

const decoder = new TextDecoder();
const decode = (bytes: Uint8Array) => decoder.decode(bytes);

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** [stdout bytes up to cap, truncated, returncode]. returncode is null on timeout or when git cannot start. */
export async function runGit(
  args: string[],
  cwd: string,
  timeout = GIT_TIMEOUT,
  cap = MAX_LIST_BYTES,
): Promise<[Uint8Array, boolean, number | null]> {
  const git = gitPath();
  if (!git) return [new Uint8Array(), false, null];
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(git, {
      args: [...BASE, ...args],
      cwd,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_EXTERNAL_DIFF: '', LC_ALL: 'C' },
    }).spawn();
  } catch {
    return [new Uint8Array(), false, null];
  }
  const kill = () => {
    try {
      child.kill('SIGKILL');
    } catch { /* already exited */ }
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    kill();
  }, timeout * 1000);
  const reader = child.stdout.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > cap) break;
    }
  } catch { /* the pipe broke: keep what was read */ }
  clearTimeout(timer);
  const data = concat(chunks, total);
  if (timedOut) {
    await reader.cancel().catch(() => {});
    await child.status;
    return [data.slice(0, cap), true, null];
  }
  if (total > cap) {
    kill();
    await reader.cancel().catch(() => {});
    const status = await child.status;
    return [data.slice(0, cap), true, status.code];
  }
  reader.releaseLock();
  let waitKilled = false; // Python: proc.wait(timeout=5) raised TimeoutExpired, the child was killed and no code is reported
  const waitTimer = setTimeout(() => {
    waitKilled = true;
    kill();
  }, 5000);
  const status = await child.status;
  clearTimeout(waitTimer);
  return [data, false, waitKilled ? null : status.code];
}

/** True for a plain repository-relative path as git prints it (forward slashes, no '..', not absolute). */
export function safeRelpath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.includes('\0') || path.includes('\\') || path.startsWith('/')) {
    return false;
  }
  if (osp.WIN && path.split('/')[0].includes(':')) return false; // ':' only means a drive on Windows
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

/**
 * [toplevel, prefix, base] for a folder inside a git work tree, or null when it is not one. prefix is the folder's path inside the
 * repository ('' at the top or 'sub/dir/'); base is HEAD or the empty tree.
 */
export async function locate(cwd: string): Promise<[string, string, string] | null> {
  const folder = String(cwd);
  if (!osp.isdir(folder) || !gitPath()) return null;
  const [out, , code] = await runGit(['rev-parse', '--show-toplevel', '--show-prefix'], folder, GIT_TIMEOUT, 8192);
  if (code !== 0) return null;
  const lines = decode(out).split('\n');
  if (lines.length < 2 || !lines[0].trim()) return null;
  const top = osp.normpath(lines[0].trim());
  const prefix = lines[1].trim();
  const [, , head] = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], top, GIT_TIMEOUT, 1024);
  let base: string;
  if (head === 0) {
    base = 'HEAD';
  } else {
    const [fmt] = await runGit(['rev-parse', '--show-object-format'], top, GIT_TIMEOUT, 64);
    base = EMPTY_TREE[decode(fmt).trim() === 'sha256' ? 'sha256' : 'sha1'];
  }
  return [top, prefix, base];
}

/** [[xy, path, oldPath]] from `git status --porcelain=v1 -z`. */
export function parseStatus(raw: Uint8Array): [string, string, string][] {
  const parts = decode(raw).split('\0');
  const out: [string, string, string][] = [];
  let i = 0;
  while (i < parts.length) {
    const item = parts[i];
    i++;
    if (item.length < 4) continue;
    const xy = item.slice(0, 2), path = item.slice(3);
    let old = '';
    if ((xy.includes('R') || xy.includes('C')) && i < parts.length) {
      old = parts[i];
      i++;
    }
    out.push([xy, path, old]);
  }
  return out;
}

/** One letter: C conflict, U untracked, R renamed, D deleted, A added, M modified. */
export function statusLetter(xy: string): string {
  if (xy === '??') return 'U';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'C';
  for (const letter of 'RDA') if (xy.includes(letter)) return letter;
  if (xy.includes('C')) return 'A';
  return 'M';
}

export type Stat = [number, number, boolean];

/** {path: [added, removed, binary]} from `git diff --numstat -z` (renames are keyed by the new path). */
export function parseNumstat(raw: Uint8Array): Map<string, Stat> {
  const parts = decode(raw).split('\0');
  const out = new Map<string, Stat>();
  let i = 0;
  while (i < parts.length) {
    const item = parts[i];
    i++;
    const tab1 = item.indexOf('\t');
    const tab2 = tab1 < 0 ? -1 : item.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const added = item.slice(0, tab1), removed = item.slice(tab1 + 1, tab2);
    let path = item.slice(tab2 + 1);
    if (path === '' && i + 1 < parts.length) {
      path = parts[i + 1];
      i += 2;
    }
    const binary = added === '-' || removed === '-';
    out.set(path, [binary ? 0 : parseInt(added || '0', 10), binary ? 0 : parseInt(removed || '0', 10), binary]);
  }
  return out;
}

function realInside(root: string, rel: string): string | null {
  const full = osp.join(root, ...rel.split('/'));
  try {
    if (osp.islink(full)) return null;
    const real = osp.realpath(full);
    const base = osp.realpath(root);
    if (osp.commonpath(real, base) !== base || !osp.isfile(real)) return null;
    return real;
  } catch {
    return null;
  }
}

function readUpTo(path: string, limit: number): Uint8Array {
  const file = Deno.openSync(path, { read: true });
  try {
    const buffer = new Uint8Array(limit);
    let total = 0;
    while (total < limit) {
      const n = file.readSync(buffer.subarray(total));
      if (n === null || n === 0) break;
      total += n;
    }
    return buffer.subarray(0, total);
  } finally {
    file.close();
  }
}

/** [text lines, truncated, binary] for an untracked file; binary or special files give no lines. */
export function readUntracked(root: string, rel: string, cap = MAX_DIFF_BYTES): [string[], boolean, boolean] {
  const real = realInside(root, rel);
  if (real === null) return [[], false, true];
  let data: Uint8Array;
  try {
    data = readUpTo(real, cap + 1);
  } catch {
    return [[], false, true];
  }
  if (data.subarray(0, BINARY_PROBE).includes(0)) return [[], false, true];
  const truncated = data.length > cap;
  const lines = decode(data.subarray(0, cap)).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  else if (truncated && lines.length) lines.pop(); // drop the line cut by the cap
  return [lines.map((line) => clip(line.replace(/\r+$/, ''), MAX_LINE_CHARS)), truncated, false];
}

/** [[letter, path, oldPath]] from `git diff --name-status -z -M`. */
export function parseNameStatus(raw: Uint8Array): [string, string, string][] {
  const parts = decode(raw).split('\0');
  const out: [string, string, string][] = [];
  let i = 0;
  while (i < parts.length) {
    const code = parts[i];
    i++;
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      if (i + 1 >= parts.length) break;
      const old = parts[i], path = parts[i + 1];
      i += 2;
      out.push([letter === 'R' ? 'R' : 'A', path, letter === 'R' ? old : '']);
    } else {
      if (i >= parts.length) break;
      const path = parts[i];
      i++;
      out.push([letter === 'U' ? 'C' : letter === 'D' ? 'D' : letter === 'A' ? 'A' : 'M', path, '']);
    }
  }
  return out;
}

export async function commitExists(top: string, commit: unknown): Promise<boolean> {
  if (typeof commit !== 'string' || !commit || commit.startsWith('-')) return false;
  const [, , code] = await runGit(['cat-file', '-e', commit + '^{commit}'], top, GIT_TIMEOUT, 64);
  return code === 0;
}

export type BranchEntry = [string, string, string, boolean];

/**
 * [[letter, path, old, untracked]], cut: the working tree against `base`: committed, uncommitted and untracked (not ignored) files.
 * cut is true when git's output was cut at the cap.
 */
export async function branchEntries(top: string, prefix: string, base: string): Promise<[BranchEntry[], boolean]> {
  const scope = prefix ? ['--', prefix.replace(/\/+$/, '')] : [];
  const [raw, cut, code] = await runGit(['diff', base, '--name-status', '-z', '-M', '--no-ext-diff', '--no-textconv', ...scope], top);
  if (code !== 0 && code !== 1 && !cut) throw new ChangesError('git diff failed', 'git_failed');
  const entries: BranchEntry[] = parseNameStatus(raw).map(([letter, path, old]) => [letter, path, old, false]);
  const seen = new Set(entries.map((e) => e[1]));
  const [raw2, cut2, code2] = await runGit(['ls-files', '--others', '--exclude-standard', '-z', ...scope], top);
  if (code2 !== 0 && !cut2) throw new ChangesError('git ls-files failed', 'git_failed');
  for (const path of decode(raw2).split('\0')) if (path && !seen.has(path)) entries.push(['U', path, '', true]);
  entries.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return [entries, cut || cut2];
}

export interface FileItem {
  path: string;
  status: string;
  added: number;
  removed: number;
  binary: boolean;
  oldPath?: string;
  partial?: boolean;
}

export interface ChangesResult {
  git: boolean;
  scope?: 'uncommitted' | 'branch';
  root?: string;
  prefix?: string;
  files?: FileItem[];
  totals?: { files: number; added: number; removed: number };
  filesTotal?: number;
  truncated?: boolean;
  worktree?: { branch: string };
}

function untrackedItem(item: FileItem, top: string, path: string): void {
  const [lines, cutFile, binary] = readUntracked(top, path);
  item.added = lines.length;
  item.binary = binary;
  if (cutFile) item.partial = true;
}

function summary(
  scope: 'uncommitted' | 'branch',
  top: string,
  prefix: string,
  files: FileItem[],
  total: number,
  truncated: boolean,
): ChangesResult {
  const totals = { files: files.length, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) };
  return { git: true, scope, root: top, prefix, files, totals, filesTotal: total, truncated };
}

/**
 * The file list for the folder's uncommitted changes. {git: false} when the folder is not in a git work tree. With baseCommit (a
 * worktree chat's recorded base) the scope is 'branch': the working tree against that commit.
 */
export async function getChanges(cwd: string, baseCommit: string | null = null): Promise<ChangesResult> {
  const found = await locate(cwd);
  if (!found) return { git: false };
  const [top, prefix, base] = found;
  if (baseCommit && await commitExists(top, baseCommit)) return await getBranchChanges(top, prefix, baseCommit);
  const scope = prefix ? ['--', prefix.replace(/\/+$/, '')] : [];
  const [raw, cut, code] = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...scope], top);
  if (code !== 0 && !cut) throw new ChangesError('git status failed', 'git_failed');
  const entries = parseStatus(raw);
  const [nums, , ncode] = await runGit(['diff', base, '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', ...scope], top);
  const stats = ncode === 0 || ncode === 1 || ncode === null ? parseNumstat(nums) : new Map<string, Stat>();
  let truncated = cut;
  const files: FileItem[] = [];
  let total = 0;
  for (const [xy, path, old] of entries) {
    const letter = statusLetter(xy);
    if (letter !== 'U' && !stats.has(path)) continue; // e.g. added then deleted again: nothing against HEAD
    total++;
    if (files.length >= MAX_FILES) {
      truncated = true;
      continue;
    }
    const item: FileItem = { path, status: letter, added: 0, removed: 0, binary: false };
    if (old) item.oldPath = old;
    if (letter === 'U') untrackedItem(item, top, path);
    else [item.added, item.removed, item.binary] = stats.get(path)!;
    files.push(item);
  }
  return summary('uncommitted', top, prefix, files, total, truncated);
}

async function getBranchChanges(top: string, prefix: string, base: string): Promise<ChangesResult> {
  const scope = prefix ? ['--', prefix.replace(/\/+$/, '')] : [];
  const [entries, cut] = await branchEntries(top, prefix, base);
  let truncated = cut;
  const [nums, , ncode] = await runGit(['diff', base, '--numstat', '-z', '-M', '--no-ext-diff', '--no-textconv', ...scope], top);
  const stats = ncode === 0 || ncode === 1 || ncode === null ? parseNumstat(nums) : new Map<string, Stat>();
  const files: FileItem[] = [];
  let total = 0;
  for (const [letter, path, old, untracked] of entries) {
    total++;
    if (files.length >= MAX_FILES) {
      truncated = true;
      continue;
    }
    const item: FileItem = { path, status: letter, added: 0, removed: 0, binary: false };
    if (old) item.oldPath = old;
    if (untracked) untrackedItem(item, top, path);
    else [item.added, item.removed, item.binary] = stats.get(path) ?? [0, 0, false];
    files.push(item);
  }
  return summary('branch', top, prefix, files, total, truncated);
}

export interface Hunk {
  header: string;
  lines: string[];
}

/** Hunks from one file's unified diff text. */
export function parseHunks(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('@@ ')) {
      current = { header: clip(line, 300), lines: [] };
      hunks.push(current);
    } else if (current !== null && line.length && ' +-\\'.includes(line[0])) {
      current.lines.push(clip(line.replace(/\r+$/, ''), MAX_LINE_CHARS));
    }
  }
  return hunks;
}

export interface FileDiff {
  git: boolean;
  path?: string;
  status?: string;
  binary?: boolean;
  truncated?: boolean;
  hunks?: Hunk[];
  abs?: string;
  oldPath?: string;
  added?: number;
  removed?: number;
}

/** Hunks for one file that is currently reported as changed. Throws ChangesError for unknown or unsafe paths. */
export async function getFileDiff(cwd: string, path: unknown, baseCommit: string | null = null): Promise<FileDiff> {
  if (!safeRelpath(path)) throw new ChangesError('Not a repository path', 'bad_path');
  const found = await locate(cwd);
  if (!found) return { git: false };
  const [top, prefix, base] = found;
  if (prefix && !path.startsWith(prefix)) throw new ChangesError('That file is outside this folder', 'outside');
  if (baseCommit && await commitExists(top, baseCommit)) {
    const entries = (await branchEntries(top, prefix, baseCommit))[0].filter((e) => e[1] === path);
    if (!entries.length) throw new ChangesError('That file has no changes in this chat', 'not_changed');
    const [letter, , old, untracked] = entries[0];
    return await fileDiff(top, baseCommit, path, letter, old, untracked);
  }
  const [raw, , code] = await runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', ...(prefix ? ['--', prefix.replace(/\/+$/, '')] : [])],
    top,
  );
  const entries = code === 0 ? parseStatus(raw).filter((e) => e[1] === path) : [];
  if (!entries.length) throw new ChangesError('That file has no uncommitted changes', 'not_changed');
  const [xy, , old] = entries[0];
  return await fileDiff(top, base, path, statusLetter(xy), old, xy === '??');
}

async function fileDiff(top: string, base: string, path: string, letter: string, old: string, untracked: boolean): Promise<FileDiff> {
  const result: FileDiff = {
    git: true,
    path,
    status: letter,
    binary: false,
    truncated: false,
    hunks: [],
    abs: osp.normpath(osp.join(top, ...path.split('/'))),
  };
  if (old) result.oldPath = old;
  if (untracked) {
    const [lines, cut, binary] = readUntracked(top, path);
    result.binary = binary;
    result.truncated = cut;
    if (lines.length) result.hunks = [{ header: `@@ -0,0 +1,${lines.length} @@`, lines: lines.map((line) => '+' + line) }];
    result.added = lines.length;
    result.removed = 0;
    return result;
  }
  const specs = [path, ...(old ? [old] : [])];
  const [out, cut] = await runGit(
    ['diff', base, '--unified=3', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--', ...specs],
    top,
    GIT_TIMEOUT,
    MAX_DIFF_BYTES,
  );
  const text = decode(out);
  const hunks = parseHunks(text);
  result.hunks = hunks;
  result.truncated = !!cut;
  if (!hunks.length && (text.includes('Binary files') || text.includes('GIT binary patch'))) result.binary = true;
  result.added = hunks.reduce((s, h) => s + h.lines.filter((l) => l.startsWith('+')).length, 0);
  result.removed = hunks.reduce((s, h) => s + h.lines.filter((l) => l.startsWith('-')).length, 0);
  return result;
}
