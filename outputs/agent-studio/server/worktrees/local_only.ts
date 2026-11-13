/**
 * Local-only folders (Deno only). A project's local-only paths are the lines in AIB's own block of the repository's
 * `.git/info/exclude` (the common one, so every worktree obeys it):
 *
 *   # AIB: local only (shown in every chat; never committed)
 *   /private
 *   # AIB: end
 *
 * Only lines inside that block count; the user's own exclude lines are never read as local only and never touched. Lines are
 * anchored at the repository top (`/<prefix><rel>`, prefix = the project's place in its repo), with no trailing slash, and glob
 * characters escaped, so each line names exactly one file or folder.
 *
 * Every git project gets `/private` by default (ensureDefault), unless the project already tracks a `private/` folder, or a
 * `.gitignore` negates it. Files shows local-only paths from the MAIN folder in every chat (nothing is put on disk in chat copies).
 *
 * Writing: one writer at a time across processes (a FileLock on `<exclude>.aib-lock`), only AIB's block changes, a UTF-8 BOM, the
 * file's line ending and every line outside the block are kept byte for byte, and the file is replaced by a rename after checking
 * that nobody wrote it meanwhile (else it starts over, up to 3 times).
 */
import * as osp from '../platform/ospath.ts';
import { FileLock } from '../platform/lock.ts';
import { gitPath } from './changes.ts';

export { findStrays, moveStrays } from './local_strays.ts';

/**
 * The default `/private` line:
 *   on       in AIB's block and git ignores it (agents are told about private/ only in this state)
 *   tracked  the project commits files under private/, so AIB leaves it alone (Files shows a note)
 *   negated  a .gitignore turns it back on (`!private`), so it would not stay local
 *   off      not in AIB's block (the user removed it, or AIB has not set the default up yet)
 *   no-git   not a git project (only from callers that report it; localOnlyOf returns null then)
 */
export type DefaultState = 'on' | 'tracked' | 'negated' | 'off' | 'no-git';
export interface LocalOnly {
  project: string; // the main folder (record.project)
  excludeFile: string; // git rev-parse --git-path info/exclude
  prefix: string; // project's place in the repo ('' or 'sub/')
  entries: string[]; // project-relative, forward slashes, from AIB's block only
  existing: string[]; // absolute paths of entries that exist on disk
  defaultState: DefaultState;
}
export type AddResult =
  | { ok: true; undo: string; moved?: [string, string][]; failed?: string[] }
  | { ok: false; code: 'tracked' | 'docs' | 'reserved' | 'no_git' | 'already'; error: string };

export const BLOCK_START = '# AIB: local only (shown in every chat; never committed)';
export const BLOCK_END = '# AIB: end';
export const DEFAULT_ENTRY = 'private';
export const MESSAGES = {
  tracked: "Git tracks this, so it can't be excluded",
  docs: 'Docs are committed',
  already: 'Already local only',
  no_git: 'Not a git project',
  project: 'This is the project folder itself',
  git: 'The .git folder is never shown',
  modules: 'node_modules is always ignored',
  name: 'This name cannot be written to the exclude file',
};
const CACHE_MS = 10_000;

/** Test hooks: `afterTmp` runs after the new exclude is written to its temp file, before the original is read again. */
export const _hooks: { afterTmp: null | ((excludeFile: string) => void) } = { afterTmp: null };

// ---- git ------------------------------------------------------------------------------------------------------------------
const dec = new TextDecoder();
const enc = new TextEncoder();

/** [stdout, exit code] of git in cwd; code -1 when git can't start or ran out of time. No --literal-pathspecs (check-ignore refuses it). */
async function git(args: string[], cwd: string, timeoutMs = 15_000): Promise<[string, number]> {
  const bin = gitPath();
  if (!bin) return ['', -1];
  try {
    const r = await new Deno.Command(bin, {
      args: ['-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '--no-pager', '--no-optional-locks', ...args],
      cwd,
      stdin: 'null',
      stdout: 'piped',
      stderr: 'null',
      env: { GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      signal: AbortSignal.timeout(timeoutMs),
    }).output();
    return [dec.decode(r.stdout), r.code];
  } catch {
    return ['', -1];
  }
}

/** True when git tracks `rel` (a file, or any file under a folder) in the folder's index. */
export async function isTracked(folder: string, rel: string): Promise<boolean> {
  const [out, code] = await git(['--literal-pathspecs', 'ls-files', '-z', '--', rel], folder);
  return code === 0 && out.split('\0').some((p) => p !== '');
}

/** The pattern git would apply to `rel` (relative to folder): '' when none matches; starts with '!' when it is a negation. */
export async function ignorePattern(folder: string, rel: string): Promise<string> {
  const [out] = await git(['check-ignore', '-v', '-n', '--', rel], folder);
  const left = out.split(/\r?\n/)[0]?.split('\t')[0] ?? '';
  const m = /:(\d+):(.*)$/.exec(left);
  return m ? m[2] : '';
}

interface Base {
  excludeFile: string;
  prefix: string;
}
const baseCache = new Map<string, { at: number; base: Base | null }>();
/** The exclude file and repo prefix of a project folder, or null when it is not in a git work tree. */
async function baseOf(project: string): Promise<Base | null> {
  const key = osp.normcase(osp.normpath(project));
  const hit = baseCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS * 3) return hit.base;
  let base: Base | null = null;
  if (osp.isdir(project)) {
    const [out, code] = await git(['rev-parse', '--show-prefix', '--git-path', 'info/exclude'], project);
    const lines = out.split(/\r?\n/);
    if (code === 0 && lines.length >= 2 && lines[1].trim()) {
      const raw = lines[1].trim();
      base = { prefix: lines[0].trim(), excludeFile: osp.normpath(osp.isabs(raw) ? raw : osp.join(project, raw)) };
    }
  }
  if (baseCache.size > 200) baseCache.clear();
  baseCache.set(key, { at: Date.now(), base });
  return base;
}

// ---- the exclude file's bytes ---------------------------------------------------------------------------------------------
interface Parsed {
  bom: boolean;
  lines: Uint8Array[]; // split on \n; each keeps its \r; the last one is '' when the file ends with a newline
  texts: string[]; // the same lines decoded, without \r
  blocks: [number, number][]; // [start line, end line] of each complete AIB block, in file order
  crlf: boolean;
}

function parse(bytes: Uint8Array): Parsed {
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const body = bom ? bytes.subarray(3) : bytes;
  const lines: Uint8Array[] = [];
  let at = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === 0x0a) {
      lines.push(body.slice(at, i));
      at = i + 1;
    }
  }
  lines.push(body.slice(at));
  const texts = lines.map((l) => dec.decode(l).replace(/\r$/, ''));
  let cr = 0;
  for (let i = 0; i < lines.length - 1; i++) if (lines[i].length && lines[i][lines[i].length - 1] === 0x0d) cr++;
  const blocks: [number, number][] = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim() !== BLOCK_START) continue;
    let end = -1;
    for (let j = i + 1; j < texts.length; j++) {
      const t = texts[j].trim();
      if (t === BLOCK_START) break; // a start with no end: a broken block, left alone
      if (t === BLOCK_END) {
        end = j;
        break;
      }
    }
    if (end > 0) {
      blocks.push([i, end]);
      i = end;
    }
  }
  return { bom, lines, texts, blocks, crlf: cr > 0 && cr * 2 > lines.length - 1 };
}

function join(p: Parsed): Uint8Array {
  const parts: Uint8Array[] = p.bom ? [new Uint8Array([0xef, 0xbb, 0xbf])] : [];
  p.lines.forEach((l, i) => {
    if (i) parts.push(new Uint8Array([0x0a]));
    parts.push(l);
  });
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let at = 0;
  for (const x of parts) {
    out.set(x, at);
    at += x.length;
  }
  return out;
}

const lineBytes = (p: Parsed, text: string) => enc.encode(p.crlf ? text + '\r' : text);

/** The bytes with `line` added to the first AIB block (a new block at the end when there is none). null = already there. */
export function withLine(bytes: Uint8Array, line: string): Uint8Array | null {
  const p = parse(bytes);
  for (const [s, e] of p.blocks) for (let i = s + 1; i < e; i++) if (p.texts[i] === line) return null;
  if (p.blocks.length) {
    const end = p.blocks[0][1];
    p.lines.splice(end, 0, lineBytes(p, line));
    return join(p);
  }
  const add = [lineBytes(p, BLOCK_START), lineBytes(p, line), lineBytes(p, BLOCK_END)];
  const last = p.lines.length - 1;
  if (p.lines[last].length === 0) p.lines.splice(last, 1, ...add, new Uint8Array());
  else p.lines.push(...add, new Uint8Array()); // the old last line had no newline: it gets one
  return join(p);
}

/** The bytes with `line` taken out of AIB's blocks (and an emptied block dropped when dropEmpty). null = not there. */
export function withoutLine(bytes: Uint8Array, line: string, dropEmpty = false): Uint8Array | null {
  const p = parse(bytes);
  for (const [s, e] of p.blocks) {
    for (let i = s + 1; i < e; i++) {
      if (p.texts[i] !== line) continue;
      if (dropEmpty && e - s === 2) p.lines.splice(s, 3);
      else p.lines.splice(i, 1);
      return join(p);
    }
  }
  return null;
}

/** The raw lines inside AIB's complete blocks. */
export function blockLines(bytes: Uint8Array): string[] {
  const p = parse(bytes);
  const out: string[] = [];
  for (const [s, e] of p.blocks) for (let i = s + 1; i < e; i++) out.push(p.texts[i]);
  return out;
}

// ---- lines <-> paths ------------------------------------------------------------------------------------------------------
/** The exclude line for a project-relative path: anchored, no trailing slash, `* ? [ \` and trailing spaces escaped. */
export function escapeLine(prefix: string, rel: string): string {
  const path = prefix + rel;
  if (/[\r\n]/.test(path)) throw new Error('A name with a line break cannot be excluded');
  let out = '/' + path.replace(/[*?[\\]/g, (c) => '\\' + c);
  const trail = /( +)$/.exec(out);
  if (trail) out = out.slice(0, -trail[1].length) + '\\ '.repeat(trail[1].length);
  return out;
}

/** The repo-relative path an AIB line names, or null when it is not one plain anchored path (a glob, a negation, a comment). */
export function unescapeLine(line: string): string | null {
  let text = line;
  // git drops unescaped trailing spaces
  while (text.endsWith(' ') && !text.endsWith('\\ ')) text = text.slice(0, -1);
  if (!text || text.startsWith('#') || text.startsWith('!') || !text.startsWith('/')) return null;
  let out = '';
  for (let i = 1; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      if (i + 1 >= text.length) return null;
      out += text[++i];
    } else if (c === '*' || c === '?' || c === '[') return null;
    else out += c;
  }
  out = out.replace(/\/+$/, '');
  return out && !out.split('/').some((p) => p === '' || p === '.' || p === '..') ? out : null;
}

const fold = (s: string) => (osp.WIN ? s.toLowerCase() : s);

/** Project-relative entries named by the block lines (lines for other parts of the repo are left out). */
export function entriesOf(lines: string[], prefix: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const path = unescapeLine(line);
    if (!path) continue;
    if (prefix && !fold(path).startsWith(fold(prefix))) continue;
    const rel = path.slice(prefix.length);
    if (!rel || seen.has(fold(rel))) continue;
    seen.add(fold(rel));
    out.push(rel);
  }
  return out;
}

/** A request path as a plain project-relative path ('' = the project), or null when it isn't one. */
export function cleanRel(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel.length > 1024 || rel.includes('\0')) return null;
  const parts = rel.replaceAll('\\', '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..' || p.includes(':'))) return null;
  return parts.join('/');
}

/** True when the project-relative `rel` is a local-only entry or inside one (case-insensitive on Windows). */
export function isLocalPath(lo: LocalOnly, rel: string): boolean {
  const path = fold(cleanRel(rel) ?? '');
  if (!path) return false;
  return lo.entries.some((e) => {
    const f = fold(e);
    return path === f || path.startsWith(f + '/');
  });
}

/** The entry `rel` is (or is inside), or ''. */
export function entryOf(lo: LocalOnly, rel: string): string {
  const path = fold(cleanRel(rel) ?? '');
  return lo.entries.find((e) => path === fold(e) || path.startsWith(fold(e) + '/')) ?? '';
}

// ---- reading --------------------------------------------------------------------------------------------------------------
interface Cached {
  at: number;
  stamp: string;
  base: Base;
  entries: string[];
  state: DefaultState;
}
const cache = new Map<string, Cached>();
export const _cache = cache;

function stampOf(file: string): string {
  try {
    const st = Deno.statSync(file);
    return `${st.mtime?.getTime() ?? 0}:${st.size}`;
  } catch {
    return 'none';
  }
}

function readBytes(file: string): Uint8Array | null {
  try {
    return Deno.readFileSync(file);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

async function stateOf(project: string, entries: string[]): Promise<DefaultState> {
  if (await isTracked(project, DEFAULT_ENTRY)) return 'tracked';
  const pattern = await ignorePattern(project, DEFAULT_ENTRY + '/aib-probe');
  const listed = entries.some((e) => fold(e) === DEFAULT_ENTRY);
  if (pattern.startsWith('!')) return 'negated';
  if (!listed) return 'off';
  return pattern ? 'on' : 'negated';
}

function forget(excludeFile: string): void {
  for (const [key, c] of cache) if (fold(c.base.excludeFile) === fold(excludeFile)) cache.delete(key);
}

/** The project's local-only paths; cached on the exclude file's mtime (and for 10 s); null when the folder is not in git. */
export async function localOnlyOf(project: string): Promise<LocalOnly | null> {
  const key = osp.normcase(osp.normpath(project));
  const base = await baseOf(project);
  if (!base) return null;
  const stamp = stampOf(base.excludeFile);
  let hit = cache.get(key);
  if (!hit || hit.stamp !== stamp || Date.now() - hit.at > CACHE_MS || hit.base.excludeFile !== base.excludeFile) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = readBytes(base.excludeFile);
    } catch { /* unreadable: no entries */ }
    const entries = bytes ? entriesOf(blockLines(bytes), base.prefix) : [];
    hit = { at: Date.now(), stamp, base, entries, state: await stateOf(project, entries) };
    if (cache.size > 200) cache.clear();
    cache.set(key, hit);
  }
  const existing = hit.entries.map((e) => osp.join(project, ...e.split('/'))).filter((p) => osp.exists(p));
  return { project, excludeFile: base.excludeFile, prefix: base.prefix, entries: [...hit.entries], existing, defaultState: hit.state };
}

// ---- writing --------------------------------------------------------------------------------------------------------------
const same = (a: Uint8Array | null, b: Uint8Array | null) => {
  if (a === null || b === null) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

async function renameOver(from: string, to: string): Promise<void> {
  for (let i = 0;; i++) {
    try {
      Deno.renameSync(from, to);
      return;
    } catch (error) {
      if (i >= 20) throw error; // a Windows sharing error lasts a moment (a reader holds the file)
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

/** Rewrites the exclude file under the lock with change(current bytes); returns what change returned (null = nothing written). */
async function rewrite<T>(excludeFile: string, change: (bytes: Uint8Array) => { bytes: Uint8Array; value: T } | null): Promise<T | null> {
  return await new FileLock(excludeFile + '.aib-lock').run(async () => {
    Deno.mkdirSync(osp.dirname(excludeFile), { recursive: true });
    const tmp = excludeFile + '.aib-tmp';
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = readBytes(excludeFile);
        const next = change(before ?? new Uint8Array());
        if (!next) return null;
        Deno.writeFileSync(tmp, next.bytes);
        _hooks.afterTmp?.(excludeFile);
        if (!same(before, readBytes(excludeFile))) continue; // someone wrote it meanwhile: start over from their version
        await renameOver(tmp, excludeFile);
        return next.value;
      }
      throw new Error('The exclude file kept changing; try again');
    } finally {
      try {
        Deno.removeSync(tmp);
      } catch { /* renamed, or never written */ }
      forget(excludeFile);
    }
  });
}

/**
 * Sets the default `/private` up once: only when AIB's block does not exist yet, the project does not track private/, and no
 * .gitignore negates it. Idempotent (a block that exists, even empty, means it was done: a user who removed the line keeps it
 * removed), never throws, takes the lock. null = not a git project.
 */
export async function ensureDefault(project: string): Promise<LocalOnly | null> {
  try {
    const base = await baseOf(project);
    if (!base) return null;
    const known = readBytes(base.excludeFile);
    if (!known || !parse(known).blocks.length) {
      const tracked = await isTracked(project, DEFAULT_ENTRY);
      const negated = !tracked && (await ignorePattern(project, DEFAULT_ENTRY + '/aib-probe')).startsWith('!');
      if (!tracked && !negated) {
        const line = escapeLine(base.prefix, DEFAULT_ENTRY);
        await rewrite(base.excludeFile, (bytes) => (parse(bytes).blocks.length ? null : { bytes: withLine(bytes, line)!, value: true }));
      }
    }
  } catch { /* never throws: the project simply has no default */ }
  try {
    return await localOnlyOf(project);
  } catch {
    return null;
  }
}

/** Why `rel` can't be excluded (a refusal), or null when it may be. Shared by addEntry and the Files menu. */
export async function refusalOf(
  project: string,
  rel: string,
): Promise<{ code: 'tracked' | 'docs' | 'reserved' | 'no_git' | 'already'; error: string } | null> {
  const clean = cleanRel(rel);
  if (clean === null || /[\r\n]/.test(clean)) return { code: 'reserved', error: MESSAGES.name };
  if (!clean) return { code: 'reserved', error: MESSAGES.project };
  const parts = clean.split('/');
  if (parts[0].toLowerCase() === '.git') return { code: 'reserved', error: MESSAGES.git };
  if (parts.some((p) => p === 'node_modules')) return { code: 'reserved', error: MESSAGES.modules };
  if (parts[0].toLowerCase() === 'aib-docs') return { code: 'docs', error: MESSAGES.docs };
  const lo = await localOnlyOf(project);
  if (!lo) return { code: 'no_git', error: MESSAGES.no_git };
  if (isLocalPath(lo, clean)) return { code: 'already', error: MESSAGES.already };
  if (await isTracked(project, clean)) return { code: 'tracked', error: MESSAGES.tracked };
  return null;
}

/**
 * Marks `rel` (project-relative) local only: adds its line to AIB's block. Refuses the project itself, .git, node_modules, aib-docs,
 * paths git tracks in the main folder, and paths already local only. With `chatRoot` (a chat's own copy, not the main folder), the
 * file or folder in that copy is first moved into the main folder (owner Q3: a clash gets "<name> (from chat-…)<ext>", a byte-identical
 * copy is deleted), so every chat sees it at once. `undo` is the token undoEntry takes.
 */
export async function addEntry(project: string, rel: string, chatRoot?: string): Promise<AddResult> {
  const refused = await refusalOf(project, rel);
  if (refused) return { ok: false, ...refused };
  const clean = cleanRel(rel)!;
  const base = (await baseOf(project))!;
  let moved: [string, string][] = [], failed: string[] = [];
  if (chatRoot && !samePath(chatRoot, project)) {
    const src = osp.join(chatRoot, ...clean.split('/'));
    if (lexists(src)) {
      const slug = slugOf(chatRoot);
      ({ moved, failed } = await moveInto(src, osp.join(project, ...clean.split('/')), slug, clean));
    }
  }
  const line = escapeLine(base.prefix, clean);
  const existedBefore = await rewrite(base.excludeFile, (bytes) => {
    const had = parse(bytes).blocks.length > 0;
    const next = withLine(bytes, line);
    return next ? { bytes: next, value: had } : null;
  });
  const undo = JSON.stringify({ line, existedBefore: existedBefore ?? true });
  return moved.length || failed.length ? { ok: true, undo, moved, failed } : { ok: true, undo };
}

/** Takes back one addEntry: removes only that AIB line, and only while it is still there. True when it was removed. */
export async function undoEntry(project: string, undo: string): Promise<boolean> {
  let token: { line?: unknown; existedBefore?: unknown };
  try {
    token = JSON.parse(String(undo));
  } catch {
    return false;
  }
  const line = token?.line;
  if (typeof line !== 'string' || !line.startsWith('/') || line.length > 2100 || /[\r\n]/.test(line) || unescapeLine(line) === null) {
    return false;
  }
  const base = await baseOf(project);
  if (!base) return false;
  const done = await rewrite(base.excludeFile, (bytes) => {
    const next = withoutLine(bytes, line, token.existedBefore === false);
    return next ? { bytes: next, value: true } : null;
  });
  return done === true;
}

// ---- moving a chat copy's file into the main folder ------------------------------------------------------------------------
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return osp.normcase(osp.realpath(p));
    } catch {
      return osp.normcase(osp.normpath(p));
    }
  };
  return real(a) === real(b);
}

function lexists(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** "chat-53e6dc57" for a chat copy's folder (its folder name when it looks like one), else "chat". */
export function slugOf(chatRoot: string): string {
  const name = osp.basename(osp.normpath(chatRoot));
  return /^chat-[\w-]+$/i.test(name) ? name : 'chat';
}

/** A free name next to `dest`: "TASKS (from chat-1).md", then "TASKS (from chat-1) 2.md", … (folders and dotfiles: no extension split). */
export function clashName(dest: string, slug: string, folder = false): string {
  const dir = osp.dirname(dest), name = osp.basename(dest);
  const dot = folder ? -1 : name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1;; n++) {
    const candidate = osp.join(dir, `${stem} (from ${slug})${n > 1 ? ' ' + n : ''}${ext}`);
    if (!lexists(candidate)) return candidate;
  }
}

function sameBytes(a: string, b: string): boolean {
  try {
    if (Deno.statSync(a).size !== Deno.statSync(b).size) return false;
    return same(Deno.readFileSync(a), Deno.readFileSync(b));
  } catch {
    return false;
  }
}

function moveFile(src: string, dest: string): void {
  Deno.mkdirSync(osp.dirname(dest), { recursive: true });
  try {
    Deno.renameSync(src, dest);
    return;
  } catch { /* another drive: copy, check, delete */ }
  Deno.copyFileSync(src, dest);
  if (Deno.statSync(dest).size !== Deno.statSync(src).size) {
    Deno.removeSync(dest);
    throw new Error('copy incomplete');
  }
  Deno.removeSync(src);
}

/**
 * Moves `src` (a file or folder in a chat's copy) to `dest` in the main folder without overwriting anything: a folder is merged file
 * by file, a clashing file gets the "(from chat-…)" name, a byte-identical one is deleted. Reports project-relative paths.
 */
export async function moveInto(
  src: string,
  dest: string,
  slug: string,
  rel: string,
): Promise<{ moved: [string, string][]; failed: string[] }> {
  const moved: [string, string][] = [], failed: string[] = [];
  // dest and src both end with rel, so cutting rel's length off gives each side's top folder
  const destTop = dest.length - rel.length, srcTop = src.length - rel.length;
  const relOf = (p: string) => p.slice(destTop).replaceAll('\\', '/');
  const fromRelOf = (p: string) => p.slice(srcTop).replaceAll('\\', '/');
  const walk = (from: string, to: string) => {
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(from);
    } catch {
      return;
    }
    const fromRel = fromRelOf(from);
    if (st.isDirectory) {
      if (!lexists(to)) {
        try {
          Deno.mkdirSync(osp.dirname(to), { recursive: true });
          Deno.renameSync(from, to);
          moved.push([fromRel, relOf(to)]);
          return;
        } catch { /* another drive: file by file below */ }
        try {
          Deno.mkdirSync(to, { recursive: true });
        } catch {
          failed.push(fromRel);
          return;
        }
      } else if (!osp.isdir(to)) {
        to = clashName(to, slug, true);
        Deno.mkdirSync(to, { recursive: true });
      }
      for (const e of [...Deno.readDirSync(from)]) walk(osp.join(from, e.name), osp.join(to, e.name));
      try {
        Deno.removeSync(from); // only when empty
      } catch { /* something stayed */ }
      return;
    }
    try {
      if (lexists(to)) {
        if (st.isFile && sameBytes(from, to)) {
          Deno.removeSync(from);
          return;
        }
        const target = clashName(to, slug);
        moveFile(from, target);
        moved.push([fromRel, relOf(target)]);
      } else {
        moveFile(from, to);
        moved.push([fromRel, relOf(to)]);
      }
    } catch {
      failed.push(fromRel);
    }
  };
  walk(src, dest);
  return await Promise.resolve({ moved, failed });
}
