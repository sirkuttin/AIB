/**
 * The Files view's disk side (Deno only): list one folder of a chat's folder, search its file names, read one file. Every path the
 * page sends is a forward-slash path RELATIVE to a root folder the server resolved itself (a chat's folder, or that chat's main
 * checkout); nothing from the request is ever used as an absolute path. Each answer is checked to stay inside the root after
 * links are resolved, so `..`, absolute paths, drive letters, UNC paths, alternate data streams and links that point out of the
 * root are refused. Read only: nothing here writes.
 *
 * Git rules: .git is never listed; in a git work tree `git check-ignore` marks ignored entries, `git status` gives the change letter
 * of each file (and a changed count per folder), and the search index is `git ls-files --cached --others --exclude-standard`.
 * Outside git, a plain directory walk is used. node_modules is always treated as ignored and never searched.
 *
 * Local-only paths (local_only.ts: AIB's block in .git/info/exclude) always come from the MAIN folder: listLocal lays the main
 * folder's entries over a chat copy's listing (nothing is put on disk in the copy), marks them `local` (not `ignored`, at any depth)
 * and lists a folder inside one from the main folder; localFiles adds them to the search index.
 */
import * as osp from '../platform/ospath.ts';
import { isNetworkPath } from '../web/security.ts';
import { gitPath, locate, parseStatus, runGit, statusLetter } from './changes.ts';
import { isLocalPath, type LocalOnly } from './local_only.ts';

export const LIMITS = {
  readBytes: 1024 * 1024, // the file view shows text files up to 1 MB
  probe: 8192, // a NUL in the first 8 KB means binary
  listEntries: 3000, // entries per folder
  indexFiles: 60000, // files in the search index
  searchTop: 200, // matches per search
  indexTtlMs: 60_000, // the index is rebuilt after a minute, or at once when the agent wrote files
  checkBatch: 150, // paths per `git check-ignore` call (keeps the command line short on Windows)
};
export const ALWAYS_IGNORED = new Set(['node_modules']);
export const NEVER_LISTED = new Set(['.git']);

export class FilesError extends Error {
  constructor(message: string, readonly code: string, readonly status = 400) {
    super(message);
    this.name = 'FilesError';
  }
}

/** A request path -> its parts, or a FilesError. '' (or '.') is the root itself. Only plain relative paths pass. */
export function safeParts(rel: unknown): string[] {
  if (rel === undefined || rel === null || rel === '' || rel === '.') return [];
  if (typeof rel !== 'string' || rel.length > 1024 || rel.includes('\0')) throw new FilesError('Invalid path', 'bad_path');
  if (isNetworkPath(rel)) throw new FilesError('Network and device paths are not supported', 'bad_path');
  const text = rel.replaceAll('\\', '/');
  if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) throw new FilesError('Use a path inside the folder', 'bad_path');
  const parts = text.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new FilesError('Use a path inside the folder', 'bad_path');
    if (p.includes(':')) throw new FilesError('Invalid path', 'bad_path'); // a drive or an alternate data stream on Windows
    if (NEVER_LISTED.has(p.toLowerCase())) throw new FilesError('Not shown', 'hidden');
  }
  return parts;
}

const norm = (p: string) => (osp.WIN ? p.toLowerCase() : p);
/** True when `real` is `root` or inside it (both already resolved). */
export function within(real: string, root: string): boolean {
  const a = norm(osp.normpath(real)), b = norm(osp.normpath(root));
  return a === b || a.startsWith(b.endsWith(osp.SEP) ? b : b + osp.SEP);
}

/** The resolved root folder; refuses network paths and folders that are gone. */
export function realRoot(root: string): string {
  if (!root || isNetworkPath(root)) throw new FilesError('This folder cannot be shown', 'bad_root', 404);
  let real: string;
  try {
    real = osp.realpath(root);
  } catch {
    throw new FilesError('This folder is not there any more', 'missing', 404);
  }
  if (isNetworkPath(real) || !osp.isdir(real)) throw new FilesError('This folder is not there any more', 'missing', 404);
  return real;
}

/** [absolute resolved path, relative forward-slash path] of `rel` inside root, checked after links are resolved. */
export function resolveInside(root: string, rel: unknown): [string, string] {
  const base = realRoot(root);
  const parts = safeParts(rel);
  const joined = parts.length ? osp.join(base, ...parts) : base;
  let real: string;
  try {
    real = Deno.realPathSync(joined);
  } catch {
    throw new FilesError('Not found', 'not_found', 404);
  }
  if (real.startsWith('\\\\?\\')) real = real.slice(4);
  if (isNetworkPath(real) || !within(real, base)) throw new FilesError('Not found', 'outside', 404);
  return [real, parts.join('/')];
}

// ---- git helpers ------------------------------------------------------------------------------------------------------------
const dec = new TextDecoder();
interface GitInfo {
  top: string;
  prefix: string; // the root's path inside the repository ('' or 'sub/dir/')
}
const gitInfoCache = new Map<string, { at: number; info: GitInfo | null }>();
export async function gitInfo(root: string): Promise<GitInfo | null> {
  const hit = gitInfoCache.get(root);
  if (hit && Date.now() - hit.at < 30_000) return hit.info;
  let info: GitInfo | null = null;
  try {
    const found = await locate(root);
    if (found) info = { top: found[0], prefix: found[1] };
  } catch {
    info = null;
  }
  if (gitInfoCache.size > 200) gitInfoCache.clear();
  gitInfoCache.set(root, { at: Date.now(), info });
  return info;
}

/** Which of `rels` (relative to root; folders end with '/') git ignores. Tracked files are never reported. */
export async function ignoredOf(root: string, rels: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < rels.length; i += LIMITS.checkBatch) {
    const batch = rels.slice(i, i + LIMITS.checkBatch);
    // Not runGit: its --literal-pathspecs is refused by check-ignore.
    const git = gitPath();
    if (!git) return out;
    let raw: Uint8Array, code: number;
    try {
      const r = await new Deno.Command(git, {
        args: ['-c', 'core.quotepath=off', '--no-pager', '--no-optional-locks', 'check-ignore', '--', ...batch],
        cwd: root,
        stdin: 'null',
        stdout: 'piped',
        stderr: 'null',
        env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      }).output();
      raw = r.stdout;
      code = r.code;
    } catch {
      return out;
    }
    if (code !== 0) continue; // 1: none ignored; anything else: treat as not ignored
    for (const p of dec.decode(raw).split(/\r?\n/)) if (p) out.add(p.replace(/^"|"$/g, '').replace(/\/+$/, ''));
  }
  return out;
}

const statusCache = new Map<string, { at: number; map: Map<string, string> }>();
/** {relative path inside root -> status letter} of the changed files under root (git status, untracked files listed one by one). */
export async function statusOf(root: string, info: GitInfo): Promise<Map<string, string>> {
  const hit = statusCache.get(root);
  if (hit && Date.now() - hit.at < 3000) return hit.map;
  const out = new Map<string, string>();
  if (statusCache.size > 40) statusCache.clear();
  statusCache.set(root, { at: Date.now(), map: out });
  const scope = info.prefix ? ['--', info.prefix.replace(/\/+$/, '')] : [];
  const [raw, , code] = await runGit(['status', '--porcelain=v1', '-z', '--untracked-files=all', ...scope], info.top);
  if (code !== 0) return out;
  for (const [xy, path] of parseStatus(raw)) {
    if (info.prefix && !path.startsWith(info.prefix)) continue;
    out.set(path.slice(info.prefix.length), statusLetter(xy));
  }
  return out;
}

// ---- list one folder --------------------------------------------------------------------------------------------------------
export interface Entry {
  name: string;
  path: string; // relative to the root, forward slashes
  dir: boolean;
  ignored: boolean;
  status: string; // change letter of a file ('' unchanged)
  changed: number; // changed files below a folder
  size: number;
  link: boolean;
  local?: true; // a local-only path: shown in normal colour, opens without "Show ignored"
  from?: 'main'; // laid over a chat copy's listing from the main folder
  strays?: number; // files under this local-only entry that sit in the chat's own copy instead (local_strays.ts)
  localWarn?: 'not-ignored'; // in AIB's block, but git does not ignore it (a later negation wins)
  noExclude?: ExcludeRefusal; // why "Git exclude" can't apply to this row (the menu greys the item)
}
export type ExcludeRefusal = 'tracked' | 'docs' | 'reserved' | 'no_git' | 'already';
export interface Listing {
  dir: string;
  git: boolean;
  entries: Entry[];
  truncated: boolean;
}

const byKind = (a: Entry, b: Entry) =>
  Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);

export async function listDir(root: string, rel: unknown): Promise<Listing> {
  const base = realRoot(root);
  const [abs, dir] = resolveInside(base, rel);
  let info: Deno.FileInfo;
  try {
    info = Deno.statSync(abs);
  } catch {
    throw new FilesError('Not found', 'not_found', 404);
  }
  if (!info.isDirectory) throw new FilesError('Not a folder', 'not_folder');
  const entries: Entry[] = [];
  let truncated = false;
  for (const e of Deno.readDirSync(abs)) {
    if (NEVER_LISTED.has(e.name.toLowerCase())) continue;
    if (entries.length >= LIMITS.listEntries) {
      truncated = true;
      break;
    }
    const full = osp.join(abs, e.name);
    let isDir = e.isDirectory, size = 0;
    if (e.isSymlink) {
      // A link is shown only when it resolves inside the root (a link out of it is left out, like a missing file).
      try {
        const real = Deno.realPathSync(full);
        if (!within(real.startsWith('\\\\?\\') ? real.slice(4) : real, base)) continue;
        const st = Deno.statSync(real);
        isDir = st.isDirectory;
        size = st.size;
      } catch {
        continue;
      }
    } else if (e.isFile) {
      try {
        size = Deno.statSync(full).size;
      } catch { /* listed without a size */ }
    } else if (!isDir) continue; // sockets, devices
    const path = dir ? dir + '/' + e.name : e.name;
    entries.push({ name: e.name, path, dir: isDir, ignored: ALWAYS_IGNORED.has(e.name), status: '', changed: 0, size, link: e.isSymlink });
  }
  const git = await gitInfo(base);
  if (git) {
    const ask = entries.filter((e) => !e.ignored).map((e) => (e.dir ? e.path + '/' : e.path));
    const ignored = await ignoredOf(base, ask);
    for (const e of entries) if (ignored.has(e.path)) e.ignored = true;
    const status = await statusOf(base, git);
    for (const [path, letter] of status) {
      const e = entries.find((x) => (x.dir ? path.startsWith(x.path + '/') : path === x.path));
      if (!e) continue;
      if (e.dir) e.changed++;
      else e.status = letter;
    }
  }
  entries.sort(byKind);
  return { dir, git: !!git, entries, truncated };
}

// ---- local-only overlay ------------------------------------------------------------------------------------------------------
const sameDir = (a: string, b: string) => norm(osp.normpath(a)) === norm(osp.normpath(b));

/** Marks the local-only entries of a listing: local (and not ignored) when git ignores them, else localWarn. */
function markLocal(entries: Entry[], lo: LocalOnly): void {
  for (const e of entries) {
    if (ALWAYS_IGNORED.has(e.name) || !isLocalPath(lo, e.path)) continue;
    if (e.ignored) {
      e.local = true;
      e.ignored = false;
    } else e.localWarn = 'not-ignored';
  }
}

/** An Entry for `rel` read from the main folder (null when main has no such file or folder). */
function mainEntry(main: string, rel: string): Entry | null {
  let abs: string;
  try {
    [abs] = resolveInside(main, rel);
  } catch {
    return null;
  }
  let st: Deno.FileInfo;
  try {
    st = Deno.statSync(abs);
  } catch {
    return null;
  }
  if (!st.isDirectory && !st.isFile) return null;
  const name = rel.slice(rel.lastIndexOf('/') + 1);
  return { name, path: rel, dir: st.isDirectory, ignored: false, status: '', changed: 0, size: st.isFile ? st.size : 0, link: false, from: 'main' };
}

/** `${count}:${newest mtime}` of the local rows in a listing (read from main): the page lists again when it changes. */
function localSig(main: string, entries: Entry[]): string {
  let n = 0, newest = 0;
  for (const e of entries) {
    if (!e.local) continue;
    n++;
    try {
      newest = Math.max(newest, Deno.statSync(osp.join(main, ...e.path.split('/'))).mtime?.getTime() ?? 0);
    } catch { /* gone meanwhile */ }
  }
  return `${n}:${newest}`;
}

/**
 * One folder of `root` with the local-only paths of `main` laid over it. root === main (the main folder, or a chat working in it):
 * the plain listing with local rows marked. A chat's copy: a folder inside a local-only entry is listed from main; above one, each
 * entry that exists in main replaces the copy's same-name row (`strays` counts the copy's own files under it), and folders that
 * lead to a deeper entry are shown even when the copy lacks them.
 */
export async function listLocal(
  root: string,
  main: string,
  lo: LocalOnly | null,
  rel: unknown,
  strays: string[] = [],
): Promise<Listing & { sig: string }> {
  const dir = safeParts(rel).join('/');
  if (!lo) return { ...(await listDir(root, dir)), sig: '' };
  const same = sameDir(realRoot(root), realRoot(main));
  if (!same && isLocalPath(lo, dir)) {
    const listing = await listDir(main, dir);
    for (const e of listing.entries) e.from = 'main';
    markLocal(listing.entries, lo);
    return { ...listing, sig: localSig(main, listing.entries) };
  }
  const leadsTo = (e: string) => (dir ? norm(e).startsWith(norm(dir) + '/') : true);
  let listing: Listing;
  try {
    listing = await listDir(root, dir);
  } catch (error) {
    // a folder the copy does not have, on the way to a local-only entry of main
    if (!same && error instanceof FilesError && error.code === 'not_found' && lo.entries.some(leadsTo) && mainEntry(main, dir)?.dir) {
      listing = { dir, git: !!(await gitInfo(realRoot(root))), entries: [], truncated: false };
    } else throw error;
  }
  if (same) markLocal(listing.entries, lo);
  else {
    const at = (name: string) => listing.entries.findIndex((e) => norm(e.name) === norm(name));
    for (const entry of lo.entries) {
      if (!leadsTo(entry)) continue;
      const deeper = entry.slice(dir ? dir.length + 1 : 0);
      const child = deeper.split('/')[0];
      const i = at(child);
      if (child === deeper) {
        const own = strays.filter((s) => norm(s) === norm(entry) || norm(s).startsWith(norm(entry) + '/')).length;
        const fromMain = mainEntry(main, entry);
        if (fromMain) {
          fromMain.local = true;
          if (own) fromMain.strays = own;
          if (i >= 0) listing.entries[i] = fromMain;
          else listing.entries.push(fromMain);
        } else if (i >= 0 && own) listing.entries[i].strays = own; // only the copy has it: a stray
      } else if (i < 0) {
        const pass = mainEntry(main, dir ? dir + '/' + child : child);
        if (pass?.dir) listing.entries.push(pass);
      }
    }
    listing.entries.sort(byKind);
  }
  return { ...listing, sig: localSig(main, listing.entries) };
}

/** Child names of `dir` (main-relative) that git tracks in main's HEAD (a folder counts when it holds a tracked file). */
export async function trackedNames(main: string, dir: string): Promise<Set<string>> {
  const out = new Set<string>();
  const [raw, , code] = await runGit(['ls-tree', '-z', '--name-only', 'HEAD', '--', dir ? dir + '/' : '.'], main, 15, 8 * 1024 * 1024);
  if (code !== 0) return out;
  for (const p of dec.decode(raw).split('\0')) if (p) out.add(norm(p.slice(p.lastIndexOf('/') + 1)));
  return out;
}

/** Fills `noExclude` on every entry: why "Git exclude" can't apply (the same rules as local_only.refusalOf). */
export async function excludeHints(main: string, lo: LocalOnly | null, listing: Listing, same: boolean): Promise<void> {
  if (!lo) {
    for (const e of listing.entries) e.noExclude = 'no_git';
    return;
  }
  const tracked = await trackedNames(main, listing.dir);
  for (const e of listing.entries) {
    const parts = e.path.split('/');
    if (e.local || isLocalPath(lo, e.path)) e.noExclude = 'already';
    else if (parts[0].toLowerCase() === 'aib-docs') e.noExclude = 'docs';
    else if (parts.includes('node_modules')) e.noExclude = 'reserved';
    else if (tracked.has(norm(e.name)) || (same && e.status && e.status !== 'U')) e.noExclude = 'tracked';
  }
}

/** Project-relative files under main's existing local-only entries (no node_modules, .git or links), at most `cap`. */
export function localFiles(main: string, lo: LocalOnly | null, cap = 5000): string[] {
  const out: string[] = [];
  if (!lo) return out;
  const stack: string[] = [];
  for (const entry of lo.entries) {
    try {
      const [abs] = resolveInside(main, entry);
      const st = Deno.statSync(abs);
      if (st.isFile) out.push(entry);
      else if (st.isDirectory) stack.push(entry);
    } catch { /* not in main */ }
  }
  while (stack.length && out.length < cap) {
    const dir = stack.pop()!;
    let list: Deno.DirEntry[];
    try {
      list = [...Deno.readDirSync(osp.join(main, ...dir.split('/')))];
    } catch {
      continue;
    }
    for (const e of list) {
      if (ALWAYS_IGNORED.has(e.name) || NEVER_LISTED.has(e.name.toLowerCase()) || e.isSymlink) continue;
      const rel = dir + '/' + e.name;
      if (e.isDirectory) stack.push(rel);
      else if (e.isFile && out.length < cap) out.push(rel);
    }
  }
  return out;
}

// ---- search index -----------------------------------------------------------------------------------------------------------
interface Index {
  at: number;
  sig: string;
  files: string[];
  truncated: boolean;
}
const indexes = new Map<string, Index>();
export const _indexes = indexes;

function skipPath(rel: string): boolean {
  return rel.split('/').some((p) => ALWAYS_IGNORED.has(p) || NEVER_LISTED.has(p.toLowerCase()));
}

async function buildIndex(base: string): Promise<[string[], boolean]> {
  const git = await gitInfo(base);
  if (git) {
    const [raw, cut, code] = await runGit(
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--full-name'],
      base,
      20,
      16 * 1024 * 1024,
    );
    if (code === 0 || cut) {
      const files: string[] = [];
      for (const p of dec.decode(raw).split('\0')) {
        if (!p) continue;
        const rel = git.prefix && p.startsWith(git.prefix) ? p.slice(git.prefix.length) : git.prefix ? '' : p;
        if (!rel || skipPath(rel)) continue;
        files.push(rel);
        if (files.length >= LIMITS.indexFiles) return [files, true];
      }
      return [files, cut];
    }
  }
  // No git: walk the folder, skipping node_modules and .git.
  const files: string[] = [];
  const stack: string[] = [''];
  while (stack.length) {
    const dir = stack.pop()!;
    let list: Deno.DirEntry[];
    try {
      list = [...Deno.readDirSync(dir ? osp.join(base, ...dir.split('/')) : base)];
    } catch {
      continue;
    }
    for (const e of list) {
      if (ALWAYS_IGNORED.has(e.name) || NEVER_LISTED.has(e.name.toLowerCase()) || e.isSymlink) continue;
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory) stack.push(rel);
      else if (e.isFile) {
        files.push(rel);
        if (files.length >= LIMITS.indexFiles) return [files, true];
      }
    }
  }
  return [files, false];
}

/** The cached file list of a root; rebuilt when `sig` (the agent's writes) changed or the cache is older than indexTtlMs. */
export async function indexOf(root: string, sig = ''): Promise<Index> {
  const base = realRoot(root);
  const hit = indexes.get(base);
  if (hit && hit.sig === sig && Date.now() - hit.at < LIMITS.indexTtlMs) return hit;
  const [files, truncated] = await buildIndex(base);
  const index = { at: Date.now(), sig, files, truncated };
  if (indexes.size > 40) indexes.clear();
  indexes.set(base, index);
  return index;
}

/** Score of a file for a query: name hits rank above folder hits, earlier and tighter hits higher; -1 = no match. */
export function score(rel: string, q: string): number {
  const lower = rel.toLowerCase(), query = q.toLowerCase().trim();
  if (!query) return -1;
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  const at = name.indexOf(query);
  if (at >= 0) return 1000 - at * 4 - (name.length - query.length) - (name.startsWith(query) ? 0 : 50);
  const inPath = lower.indexOf(query);
  if (inPath >= 0) return 400 - Math.min(300, inPath) - Math.min(90, lower.length / 4);
  // all words, any order
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length > 1 && words.every((w) => lower.includes(w))) return 100 - Math.min(90, lower.length / 4);
  return -1;
}

export interface Match {
  path: string;
  name: string;
  dir: string;
}
export async function search(
  root: string,
  q: unknown,
  sig = '',
  extra: string[] = [],
): Promise<{ matches: Match[]; total: number; truncated: boolean }> {
  const query = typeof q === 'string' ? q.slice(0, 200) : '';
  if (!query.trim()) return { matches: [], total: 0, truncated: false };
  const index = await indexOf(root, sig);
  const scored: [number, string][] = [];
  const all = extra.length ? [...new Set([...index.files, ...extra])] : index.files;
  for (const f of all) {
    const s = score(f, query);
    if (s >= 0) scored.push([s, f]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  const matches = scored.slice(0, LIMITS.searchTop).map(([, path]) => {
    const at = path.lastIndexOf('/');
    return { path, name: path.slice(at + 1), dir: at >= 0 ? path.slice(0, at) : '' };
  });
  return { matches, total: scored.length, truncated: index.truncated || scored.length > LIMITS.searchTop };
}

// ---- read one file ----------------------------------------------------------------------------------------------------------
export const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
export const PAGE_EXT = new Set(['.html', '.htm', '.svg', '.md', '.markdown']);

export interface FileRead {
  path: string; // relative to the root
  abs: string; // the file on disk (for Open in editor / Show in Explorer / Copy path)
  name: string;
  size: number;
  mtime: number;
  binary: boolean;
  tooBig: boolean;
  image: boolean;
  page: boolean; // has a rendered Page view (html, svg, md)
  text: string | null;
  lines: number;
}

export function extOf(name: string): string {
  const at = name.lastIndexOf('.');
  return at > 0 ? name.slice(at).toLowerCase() : '';
}

export function readFile(root: string, rel: unknown): FileRead {
  const [abs, path] = resolveInside(root, rel);
  if (!path) throw new FilesError('Choose a file', 'not_file');
  let st: Deno.FileInfo;
  try {
    st = Deno.statSync(abs);
  } catch {
    throw new FilesError('Not found', 'not_found', 404);
  }
  if (!st.isFile) throw new FilesError('Not a file', 'not_file');
  const name = path.slice(path.lastIndexOf('/') + 1), ext = extOf(name);
  const out: FileRead = {
    path,
    abs,
    name,
    size: st.size,
    mtime: st.mtime ? st.mtime.getTime() / 1000 : 0,
    binary: false,
    tooBig: st.size > LIMITS.readBytes,
    image: IMAGE_EXT.has(ext),
    page: PAGE_EXT.has(ext),
    text: null,
    lines: 0,
  };
  const file = Deno.openSync(abs, { read: true });
  try {
    const want = out.tooBig ? LIMITS.probe : st.size;
    const buf = new Uint8Array(Math.max(0, want));
    let got = 0;
    while (got < buf.length) {
      const n = file.readSync(buf.subarray(got));
      if (n === null) break;
      got += n;
    }
    const data = buf.subarray(0, got);
    out.binary = data.subarray(0, LIMITS.probe).includes(0);
    if (!out.binary && !out.tooBig && !(out.image && ext !== '.svg')) {
      out.text = new TextDecoder().decode(data);
      out.lines = out.text ? out.text.split('\n').length - (out.text.endsWith('\n') ? 1 : 0) : 0;
    }
  } finally {
    file.close();
  }
  return out;
}

// ---- the folder behind a chat -----------------------------------------------------------------------------------------------
/** The main checkout of a worktree folder (via its .git file), else the folder itself. */
export function mainFolderOf(cwd: string, mainCheckout: (path: string) => [string, string] | null): string {
  let dir = osp.normpath(cwd);
  for (let i = 0; i < 12; i++) {
    const marker = osp.join(dir, '.git');
    if (osp.isdir(marker)) return cwd; // an ordinary checkout
    if (osp.isfile(marker)) {
      const found = mainCheckout(dir);
      if (!found) return cwd;
      const rel = osp.normpath(cwd).slice(dir.length).replace(/^[\\/]+/, '');
      const main = rel ? osp.join(found[0], rel) : found[0];
      return osp.isdir(main) ? main : found[0];
    }
    const parent = osp.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return cwd;
}
