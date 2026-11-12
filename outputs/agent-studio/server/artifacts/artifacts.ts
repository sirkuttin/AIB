/**
 * Artifacts (artifacts.py): files (HTML pages, diagrams, reports...) the agent made or the user chose to preview, kept as versioned
 * snapshots.
 *
 * Layout: <state_dir>/artifacts/<id>/manifest.json plus v1/, v2/... (each a snapshot of the artifact's entry file). The layout, the
 * file names, the manifest JSON (json.dumps(ensure_ascii=False, indent=1), times written as Python floats) and the versioning rules
 * are those of the Python server byte for byte, so a store written by either server is read and extended by the other while both
 * share the state folder (interop tests in work/deno/artifacts_test.ts).
 * The pages themselves are served by origin.ts on a separate origin; nothing here runs artifact content.
 *
 * Everything that touches the disk is synchronous on purpose: an operation then runs to the end without yielding, which gives the
 * same atomicity the Python store gets from its RLock.
 */
import { createHash } from 'node:crypto';
import { getLogger } from '../core/log.ts';
import { clip, isDict, isInt, isStr, PY_SPACE, pyLen, pyOr, pyRepr, pyStrip, pyTruthy } from '../core/py.ts';
import { writeJsonAtomic } from '../core/fs.ts';
import { isOSError, OSError } from '../state/base.ts';
import { abspath, pathOf, realpath } from '../state/paths.ts';
import { tokenMatches } from '../web/security.ts';
import { check as checkArtifactKey } from './keys.ts';

const log = getLogger('artifacts');

const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';

export const KIND_BY_EXT: Readonly<Record<string, string>> = {
  '.html': 'html',
  '.htm': 'html',
  '.svg': 'svg',
  '.md': 'md',
  '.markdown': 'md',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.pdf': 'pdf',
  '.csv': 'csv',
  '.json': 'json',
  '.txt': 'text',
  '.log': 'text',
};
export const KINDS = ['html', 'svg', 'md', 'image', 'pdf', 'csv', 'json', 'text'] as const;
export const TEXT_KINDS = ['html', 'svg', 'md', 'csv', 'json', 'text'] as const;
export const DEFAULT_EXT: Readonly<Record<string, string>> = {
  html: '.html',
  svg: '.svg',
  md: '.md',
  csv: '.csv',
  json: '.json',
  text: '.txt',
};
export const MAX_VERSIONS = 30;
export const MAX_BYTES = 200 * 1024 * 1024;
export const FOLD_SECONDS = 3.0;
export const SETTLE_SECONDS = 0.6;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_DIFF_CHARS = 1024 * 1024;
export const MAX_BODY_BYTES = 40 * 1024 * 1024;
export const MAX_TRACKED_WRITES = 500;
/** Python's ID_RE (`$` there also matches before one trailing newline). */
export const ID_RE = /^[0-9a-f]{16}\n?$/;
export const WRITE_TOOLS = ['write', 'edit', 'multiedit', 'notebookedit']; // Claude Code's own tool names (lower case)
export const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath', 'filename'];

/** A local doc's history (isDocHistory) keeps every version this young, plus v1: a snapshot every 10 s would fill MAX_VERSIONS in 5 min. */
export const DOC_HISTORY_SECONDS = 30 * 24 * 3600;
/** Recently deleted: an artifact the user deleted is removed for good this long after (owner decision 2a, 2026-11-12). */
export const PURGE_SECONDS = 30 * 24 * 3600;
/** The retention limits, mutable so tests can lower them (the Python tests patch artifacts.MAX_VERSIONS / MAX_BYTES). */
export const limits = { maxVersions: MAX_VERSIONS, maxBytes: MAX_BYTES, docHistorySeconds: DOC_HISTORY_SECONDS, purgeSeconds: PURGE_SECONDS };
/** At most this many ids in one archive call or one states lookup. */
export const MAX_ARCHIVE_IDS = 100;
export const MAX_STATE_IDS = 200;
/** The folder inside artifacts/<id>/ that keeps a deleted artifact's source file until Restore or the purge (never served). */
export const BIN_FOLDER = 'deleted-source';

export type Json = Record<string, unknown>;
export interface Version extends Json {
  n: number;
  at: number;
  hash: string;
  size: number;
  by: string;
  toolCallId: string | null;
  note: string;
  entry: string;
}
export interface Manifest extends Json {
  id: string;
  title: string;
  kind: string;
  entry: string;
  updatedAt: number;
  versions: Version[];
}

export class ArtifactError extends Error {
  override name = 'ArtifactError';
  constructor(message: string, readonly status = 400, readonly code = 'invalid') {
    super(message);
  }
}

// ---- Python path helpers (pathlib / os.path on this OS) -------------------------------------------

function normcase(path: string): string {
  return WIN ? path.replaceAll('/', '\\').toLowerCase() : path;
}

/** pathlib.PurePath(path).name */
export function pureName(path: string): string {
  const parts = String(path).split(WIN ? /[\\/]/ : /\//).filter((part) => part !== '' && part !== '.');
  if (!parts.length) return '';
  let name = parts[parts.length - 1];
  if (WIN && parts.length === 1) name = name.replace(/^[A-Za-z]:/, '');
  return name;
}

function suffixIndex(name: string): number {
  const index = name.lastIndexOf('.');
  return index > 0 && index < name.length - 1 ? index : -1;
}

/** pathlib.PurePath(path).suffix */
export function pureSuffix(path: string): string {
  const name = pureName(path);
  const index = suffixIndex(name);
  return index < 0 ? '' : name.slice(index);
}

/** pathlib.PurePath(path).stem */
export function pureStem(path: string): string {
  const name = pureName(path);
  const index = suffixIndex(name);
  return index < 0 ? name : name.slice(0, index);
}

/** os.path.basename */
export function osBasename(path: string): string {
  const text = WIN ? String(path).replace(/^[A-Za-z]:/, '') : String(path);
  const index = WIN ? Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) : text.lastIndexOf('/');
  return text.slice(index + 1);
}

/** os.path.isabs (Python 3.11: on Windows a path starting with a slash counts too). */
export function osIsAbs(path: string): boolean {
  if (!WIN) return path.startsWith('/');
  const head = path.slice(0, 3).replaceAll('/', '\\');
  return head.startsWith('\\') || head.slice(1).startsWith(':\\');
}

function splitDrive(path: string): [string, string] {
  const p = path.replaceAll('/', '\\');
  if (WIN) {
    const unc = /^\\\\[^\\]+\\[^\\]+/.exec(p);
    if (unc && !p.startsWith('\\\\\\')) return [path.slice(0, unc[0].length), path.slice(unc[0].length)];
    if (/^[A-Za-z]:/.test(path)) return [path.slice(0, 2), path.slice(2)];
  }
  return ['', path];
}

/** os.path.join(a, b) for two parts. */
export function osJoin(a: string, b: string): string {
  if (!WIN) return b.startsWith('/') || !a ? b : a.endsWith('/') ? a + b : a + '/' + b;
  const [driveA, restA] = splitDrive(a);
  const [driveB, restB] = splitDrive(b);
  if (driveB && driveB.toLowerCase() !== driveA.toLowerCase()) return b;
  if (restB.startsWith('\\') || restB.startsWith('/')) return (driveB || driveA) + restB;
  if (driveB && !restA) return driveB + restB;
  const head = driveA + restA;
  return head && !head.endsWith('\\') && !head.endsWith('/') && !/^[A-Za-z]:$/.test(head) ? head + '\\' + restB : head + restB;
}

/** os.path.normpath */
export function osNormpath(path: string): string {
  if (WIN) {
    if (path.startsWith('\\\\.\\') || path.startsWith('\\\\?\\')) return path;
    const replaced = path.replaceAll('/', '\\');
    let [prefix, rest] = splitDrive(replaced);
    if (rest.startsWith('\\')) {
      prefix += '\\';
      rest = rest.replace(/^\\+/, '');
    }
    const comps = collapse(rest.split('\\'), prefix.endsWith('\\'));
    if (!prefix && !comps.length) comps.push('.');
    return prefix + comps.join('\\');
  }
  if (path === '') return '.';
  let initial = path.startsWith('/') ? 1 : 0;
  if (initial && path.startsWith('//') && !path.startsWith('///')) initial = 2;
  const comps = collapse(path.split('/'), initial > 0);
  const out = '/'.repeat(initial) + comps.join('/');
  return out || '.';
}

function collapse(parts: string[], rooted: boolean): string[] {
  const comps: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (comps.length && comps[comps.length - 1] !== '..') comps.pop();
      else if (!rooted) comps.push(part);
      continue;
    }
    comps.push(part);
  }
  return comps;
}

/** Path.is_absolute() */
function pathIsAbsolute(path: string): boolean {
  if (!WIN) return path.startsWith('/');
  const p = path.replaceAll('/', '\\');
  return /^[A-Za-z]:\\/.test(p) || /^\\\\[^\\]+\\[^\\]+/.test(p);
}

function statOrNull(path: string): Deno.FileInfo | null {
  try {
    return Deno.statSync(path);
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  return statOrNull(path)?.isFile === true;
}

function exists(path: string): boolean {
  return statOrNull(path) !== null;
}

function rmtree(path: string): void {
  try {
    Deno.removeSync(path, { recursive: true });
  } catch { /* shutil.rmtree(ignore_errors=True) */ }
}

/** The text Python's str(OSError) gives for a failed open() / os.stat() of `path` (the HTTP routes answer it with a 400). */
export function pyOSError(error: unknown, path: string, op: 'open' | 'stat' = 'open'): OSError {
  const name = pyRepr(path);
  let text: string;
  if (error instanceof Deno.errors.NotFound) {
    text = WIN && op === 'stat'
      ? `[WinError 2] The system cannot find the file specified: ${name}`
      : `[Errno 2] No such file or directory: ${name}`;
  } else if (error instanceof Deno.errors.PermissionDenied) {
    text = WIN && op === 'stat' ? `[WinError 5] Access is denied: ${name}` : `[Errno 13] Permission denied: ${name}`;
  } else {
    text = `${error instanceof Error ? error.message : String(error)}: ${name}`;
  }
  const out = new OSError(text);
  out.cause = error;
  return out;
}

function readBytes(path: string): Uint8Array {
  try {
    return Deno.readFileSync(path);
  } catch (error) {
    throw pyOSError(error, path);
  }
}

/** open(path, 'rb').read(limit) */
function readPrefix(path: string, limit: number): Uint8Array {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync(path, { read: true });
  } catch (error) {
    throw pyOSError(error, path);
  }
  try {
    const out = new Uint8Array(limit);
    let filled = 0;
    while (filled < limit) {
      const count = file.readSync(out.subarray(filled));
      if (count === null) break;
      filled += count;
    }
    return out.subarray(0, filled);
  } catch (error) {
    throw pyOSError(error, path);
  } finally {
    file.close();
  }
}

/** bytes.decode('utf-8', 'replace') (a BOM is kept, as Python keeps it). */
export function decodeReplace(data: Uint8Array): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(data);
}

// ---- small module functions ----------------------------------------------------------------------

export function kindFor(name: unknown): string | null {
  const ext = pureSuffix(String(name)).toLowerCase();
  return Object.hasOwn(KIND_BY_EXT, ext) ? KIND_BY_EXT[ext] : null;
}

export function previewable(name: unknown): boolean {
  return kindFor(name) !== null;
}

/** Comparison key for a file path (Windows is case-insensitive). */
export function pathKey(path: unknown): string {
  try {
    return normcase(realpath(String(path)));
  } catch {
    return normcase(abspath(String(path)));
  }
}

/** True when path resolves to a location at or below folder. */
export function inside(path: unknown, folder: unknown): boolean {
  const a = pathKey(path);
  const b = pathKey(folder);
  if (a === b) return true;
  return a.startsWith(b.endsWith(SEP) ? b : b + SEP);
}

const UNSAFE_ENTRY = /[^\p{L}\p{N}_.\- ()[\]]+/gu;

export function safeEntryName(name: unknown, fallback = 'artifact'): string {
  const text = pyTruthy(name) ? String(name) : '';
  const base = osBasename(text.replaceAll('\\', '/'));
  const cleaned = pyStrip(base.replace(UNSAFE_ENTRY, '_'), ' .');
  return clip(cleaned, 120) || fallback;
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** urllib.parse.quote(text) (safe='/'). */
export function pyQuote(text: string): string {
  let out = '';
  for (const byte of new TextEncoder().encode(text)) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9_.\-~/]/.test(ch) ? ch : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// ---- the manifest's JSON, as json.dumps(manifest, ensure_ascii=False, indent=1) writes it ---------------------------------

const FLOAT_KEYS = new Set(['at', 'createdAt', 'updatedAt', 'archivedAt', 'deletedAt']); // time.time() values: always Python floats in a Python-written file

function pyNumber(value: number, float: boolean): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? 'Infinity' : '-Infinity';
  if (Number.isInteger(value)) return float && Math.abs(value) < 1e16 ? `${value}.0` : String(value);
  return pyRepr(value);
}

function dumpIndented(value: unknown, depth: number, key: string | null): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return pyNumber(value, key !== null && FLOAT_KEYS.has(key));
  if (typeof value === 'string') return JSON.stringify(value);
  const pad = '\n' + ' '.repeat(depth + 1);
  const close = '\n' + ' '.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return '[' + value.map((item) => pad + dumpIndented(item, depth + 1, null)).join(',') + close + ']';
  }
  const entries = Object.entries(value as Json).filter(([, v]) => v !== undefined);
  if (!entries.length) return '{}';
  return '{' + entries.map(([k, v]) => pad + JSON.stringify(k) + ': ' + dumpIndented(v, depth + 1, k)).join(',') + close + '}';
}

/** json.dumps(manifest, ensure_ascii=False, indent=1) */
export function dumpManifest(manifest: unknown): string {
  return dumpIndented(manifest, 0, null);
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// ---- the store ------------------------------------------------------------------------------------

export type Clock = () => number;

/**
 * A local doc's history (docs/history.ts): no chat, no source file, versions noted "rev <n>", entry <doc>.aibdoc.json (or <doc>.md
 * before that). The Artifacts panel and picker never list these; the doc's History panel shows them.
 */
export function isDocHistory(m: { conversationId?: unknown; sourcePath?: unknown; entry?: unknown; versions?: { note?: unknown }[] }): boolean {
  if (m.conversationId || m.sourcePath) return false;
  if (typeof m.entry === 'string' && m.entry.endsWith('.aibdoc.json')) return true;
  return /^rev \d+/.test(String(m.versions?.[0]?.note ?? ''));
}

/**
 * In Recently deleted (the user deleted it; Restore or the 30-day purge comes next). A deleted artifact is invisible to everything that
 * looks artifacts up by file (findBySource, the watcher), so a rewrite of its old path makes a new artifact, and every write refuses it.
 */
export function isDeleted(m: Json): boolean {
  return typeof m.deletedAt === 'number';
}

/** Archived: out of the picker's main list, otherwise whole (versions, links, the watcher's new versions all keep working). */
export function isArchived(m: Json): boolean {
  return typeof m.archivedAt === 'number';
}

/** 'live' | 'archived' | 'deleted' for a manifest (a link's label in chat messages; 'gone' is for an id with no manifest). */
export function artifactState(m: Manifest): 'live' | 'archived' | 'deleted' {
  return isDeleted(m) ? 'deleted' : isArchived(m) ? 'archived' : 'live';
}

/**
 * Who made the artifact, from its v1 (never pruned): 'agent' (the agent's publish {path} or the watcher: by 'tool' / 'watch'), 'user'
 * (Files "Open in Artifacts": by 'preview'), or 'content' (published from text, no file on disk).
 */
export function artifactOrigin(m: Manifest): 'agent' | 'user' | 'content' {
  if (!pyTruthy(m.sourcePath)) return 'content';
  return m.versions?.[0]?.by === 'preview' ? 'user' : 'agent';
}

/**
 * Question A (owner, 2026-11-12, answer c): does Delete take an artifact's source file with it, by who made the artifact? Every
 * source file goes: the agent's and the ones the user turned into artifacts with "Open in Artifacts" (README.md too). It is moved
 * into the artifact's bin, so Restore brings it back for 30 days. USER_OPENED_FILES_GO is the one switch; this is the only place that
 * decides it. The safety checks (owner folder, links, aib-docs, .git, shared files, locks) apply on top, whatever this says.
 */
export const USER_OPENED_FILES_GO = true;
export function sourceFileGoesWithDelete(origin: 'agent' | 'user' | 'content'): { goes: true } | { goes: false; code: string; reason: string } {
  if (origin === 'agent') return { goes: true };
  if (origin === 'user' && USER_OPENED_FILES_GO) return { goes: true };
  if (origin === 'user') return { goes: false, code: 'user_opened', reason: 'you opened it from Files, so it stays in the project' };
  return { goes: false, code: 'no_file', reason: 'it has no file on disk' };
}

export class ArtifactStore {
  readonly root: string;
  /** 'http://127.0.0.1:<port>' once the artifact origin listener is up */
  origin = '';
  #cache = new Map<string, [string, Manifest]>(); // id -> (stamp, manifest)

  constructor(root: string, readonly clock: Clock = () => Date.now() / 1000) {
    this.root = pathOf(String(root));
    Deno.mkdirSync(this.root, { recursive: true });
  }

  /** Kept for callers ported from Python (`with store.lock:`); every operation here is synchronous, so it is a no-op. */
  readonly lock = { run: <T>(work: () => T): T => work() };

  // ---- reading -------------------------------------------------------------------------------
  folder(artifactId: unknown): string {
    if (typeof artifactId !== 'string' || !ID_RE.test(artifactId)) throw new ArtifactError('Unknown artifact', 404, 'not_found');
    return pathOf(this.root, artifactId);
  }

  get(artifactId: unknown): Manifest {
    const folder = this.folder(artifactId);
    const manifestPath = pathOf(folder, 'manifest.json');
    const stat = statOrNull(manifestPath);
    if (stat === null) throw new ArtifactError('Unknown artifact', 404, 'not_found');
    const stamp = `${stat.mtime?.getTime() ?? 0}:${stat.size}:${stat.ino ?? ''}:${stat.ctime?.getTime() ?? ''}`;
    const id = artifactId as string;
    const cached = this.#cache.get(id);
    if (cached && cached[0] === stamp) return copy(cached[1]);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Deno.readFileSync(manifestPath)));
    } catch {
      throw new ArtifactError('Unknown artifact', 404, 'not_found');
    }
    this.#cache.set(id, [stamp, manifest]);
    return copy(manifest);
  }

  all(): Manifest[] {
    const found: Manifest[] = [];
    const names: string[] = [];
    try {
      for (const entry of Deno.readDirSync(this.root)) {
        const dir = entry.isDirectory || (entry.isSymlink && statOrNull(pathOf(this.root, entry.name))?.isDirectory === true);
        if (dir && ID_RE.test(entry.name)) names.push(entry.name);
      }
    } catch {
      return found;
    }
    for (const name of names) {
      try {
        found.push(this.get(name));
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
      }
    }
    return found;
  }

  versionUrl(manifest: Manifest, version: Json): string {
    const entry = pyOr(version.entry, manifest.entry) as string;
    return `${this.origin}/a/${manifest.id}/v${version.n}/${pyQuote(String(entry))}`;
  }

  summary(manifest: Manifest): Json {
    const latest = manifest.versions[manifest.versions.length - 1];
    const out: Json = {
      id: manifest.id,
      title: manifest.title,
      kind: manifest.kind,
      version: latest.n,
      versions: manifest.versions.length,
      updatedAt: manifest.updatedAt,
      pinned: pyTruthy(manifest.pinned),
      sourcePath: manifest.sourcePath ?? null,
      conversationId: manifest.conversationId ?? null,
      url: this.versionUrl(manifest, latest),
      link: 'studio-artifact://' + manifest.id,
    };
    if (manifest.kind === 'md') out.viewUrl = out.url + '?view=1';
    if (pyTruthy(manifest.sourceMissing)) out.sourceMissing = true;
    if (isDict(manifest.fromDoc)) out.fromDoc = manifest.fromDoc; // AIB's own field (Deno only): "Built from <doc › page>"
    if (isStr(manifest.becameDoc) && manifest.becameDoc) out.becameDoc = manifest.becameDoc; // Edit made it a doc (Deno only)
    Object.assign(out, this.binFields(manifest)); // archive and Recently deleted (Deno only): present only when set
    return out;
  }

  /** archivedAt, deletedAt, purgeAt, deletedFile {path, kept?, code?} and sourceCopy, each only when set (summary and item). */
  binFields(manifest: Manifest): Json {
    const out: Json = {};
    if (isArchived(manifest)) out.archivedAt = manifest.archivedAt;
    if (isDeleted(manifest)) {
      out.deletedAt = manifest.deletedAt;
      out.purgeAt = (manifest.deletedAt as number) + limits.purgeSeconds;
      const ds = manifest.deletedSource;
      if (isDict(ds)) {
        const file: Json = { path: ds.rel ?? ds.path ?? null };
        if (isStr(ds.kept)) {
          file.kept = ds.kept;
          file.code = ds.code ?? null;
        }
        out.deletedFile = file;
      }
    }
    if (isStr(manifest.sourceCopy) && manifest.sourceCopy) out.sourceCopy = pathOf(this.root, manifest.id, manifest.sourceCopy);
    return out;
  }

  /**
   * Edit on a Markdown artifact: it became the doc `name` (made at doc rev `rev`, so Undo knows nobody typed since), or null when
   * Undo took it back. An extra manifest field, like fromDoc: the Python server keeps it when it rewrites the manifest.
   */
  setBecameDoc(artifactId: unknown, name: string | null, rev = 0): Manifest {
    const manifest = this.get(artifactId);
    if (name) {
      manifest.becameDoc = name;
      manifest.becameDocRev = rev;
    } else {
      delete manifest.becameDoc;
      delete manifest.becameDocRev;
    }
    this.#save(manifest);
    return manifest;
  }

  /**
   * "Built from <doc › page>": the doc page an artifact shows (`fromDoc`: {doc, title, page, pageTitle, rev}, the page's rev when it
   * was published), or null to drop the link. An extra manifest field: the Python server keeps it when it rewrites the manifest.
   */
  setFromDoc(artifactId: unknown, fromDoc: Json | null): Manifest {
    const manifest = this.get(artifactId);
    if (JSON.stringify(manifest.fromDoc ?? null) === JSON.stringify(fromDoc)) return manifest;
    if (fromDoc) manifest.fromDoc = fromDoc;
    else delete manifest.fromDoc;
    this.#save(manifest);
    return manifest;
  }

  item(artifactId: unknown): Json {
    const manifest = this.get(artifactId);
    const out = manifest as Json;
    out.url = this.versionUrl(manifest, manifest.versions[manifest.versions.length - 1]);
    out.link = 'studio-artifact://' + manifest.id;
    for (const version of manifest.versions) version.url = this.versionUrl(manifest, version);
    Object.assign(out, this.binFields(manifest));
    return out;
  }

  /** A chat's artifacts (all chats with null). Deleted ones (Recently deleted) only with `deleted`: the Artifacts panel asks. */
  list(conversationId: string | null = null, also: readonly string[] = [], options: { deleted?: boolean } = {}): Json[] {
    const wanted = [conversationId, ...also];
    const items = this.all().filter((m) =>
      !isDocHistory(m) && (options.deleted || !isDeleted(m)) &&
      (conversationId === null || wanted.includes((m.conversationId ?? null) as string | null))
    );
    items.sort((a, b) => (Number(!pyTruthy(a.pinned)) - Number(!pyTruthy(b.pinned))) || (b.updatedAt - a.updatedAt));
    return items.map((m) => this.summary(m));
  }

  /** The chat's (non-deleted) artifact of this file. A deleted one never matches: a rewrite of its path is a new artifact. */
  findBySource(conversationId: unknown, path: unknown): Manifest | null {
    const key = pathKey(path);
    for (const manifest of this.all()) {
      if (isDeleted(manifest)) continue;
      if (manifest.conversationId === conversationId && pyTruthy(manifest.sourcePath) && pathKey(manifest.sourcePath) === key) {
        return manifest;
      }
    }
    return null;
  }

  /** {id: 'live' | 'archived' | 'deleted' | 'gone'} for chat-message link labels (one stat per id: get() caches by stat). */
  states(ids: readonly unknown[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const id of ids.slice(0, MAX_STATE_IDS)) {
      if (typeof id !== 'string' || !id) continue;
      try {
        const m = this.get(id);
        out[id] = isDocHistory(m) ? 'gone' : artifactState(m);
      } catch {
        out[id] = 'gone';
      }
    }
    return out;
  }

  /** Other non-deleted artifacts (any chat) whose source is this file. */
  sharing(artifactId: string, path: unknown): Manifest[] {
    const key = pathKey(path);
    return this.all().filter((m) => m.id !== artifactId && !isDeleted(m) && pyTruthy(m.sourcePath) && pathKey(m.sourcePath) === key);
  }

  // ---- writing -------------------------------------------------------------------------------
  /** Write a manifest as it is (the Service's archive / delete / restore steps). */
  save(manifest: Manifest): void {
    this.#save(manifest);
  }

  /**
   * Archive (archivedAt = now) or unarchive. Archiving a pinned artifact unpins it (owner decision 6a), which also ends its
   * keep-every-version protection. Returns [manifest, changed, unpinned].
   */
  setArchived(artifactId: unknown, archived: boolean): [Manifest, boolean, boolean] {
    const manifest = this.get(artifactId);
    if (isArchived(manifest) === !!archived) return [manifest, false, false];
    let unpinned = false;
    if (archived) {
      manifest.archivedAt = this.clock();
      if (pyTruthy(manifest.pinned)) {
        manifest.pinned = false;
        unpinned = true;
      }
    } else delete manifest.archivedAt;
    this.#save(manifest);
    return [manifest, true, unpinned];
  }

  /**
   * Remove a deleted artifact for good: its bin copy and versions first, the manifest last (a removal that fails leaves the manifest,
   * so the next sweep tries again). Never a doc's history, never an artifact that is not deleted. Returns true when it is gone.
   */
  purge(artifactId: unknown): boolean {
    const manifest = this.get(artifactId);
    if (!isDeleted(manifest) || isDocHistory(manifest)) return false;
    const folder = this.folder(artifactId);
    try {
      for (const entry of Deno.readDirSync(folder)) {
        if (entry.name !== 'manifest.json') Deno.removeSync(pathOf(folder, entry.name), { recursive: true });
      }
      Deno.removeSync(pathOf(folder, 'manifest.json'));
      Deno.removeSync(folder, { recursive: true });
    } catch (error) {
      log.exception(error, 'Purging artifact %s failed; the next sweep tries again', String(artifactId));
      return !exists(pathOf(folder, 'manifest.json'));
    }
    this.#cache.delete(artifactId as string);
    return true;
  }

  /** The 30-day sweep: purge every deleted artifact whose time is up (deletedAt checked again just before). Returns the purged. */
  sweep(): Manifest[] {
    const cutoff = this.clock() - limits.purgeSeconds;
    const purged: Manifest[] = [];
    for (const m of this.all()) {
      if (!isDeleted(m) || isDocHistory(m) || (m.deletedAt as number) > cutoff) continue;
      try {
        const fresh = this.get(m.id);
        if (isDeleted(fresh) && (fresh.deletedAt as number) <= cutoff && this.purge(fresh.id)) purged.push(fresh);
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
      }
    }
    return purged;
  }

  #save(manifest: Manifest): void {
    const path = pathOf(this.folder(manifest.id), 'manifest.json');
    writeJsonAtomic(path, null, { prefix: '.manifest.json.', suffix: '.tmp', text: dumpManifest(manifest) });
    this.#cache.delete(manifest.id);
  }

  /** Write v<number>/<entry> atomically (temp folder, then rename over any previous one). */
  #writeVersion(artifactId: string, number: number, entry: string, data: Uint8Array): void {
    const folder = this.folder(artifactId);
    const tmp = pathOf(folder, `.v${number}.${randomHex(4)}.tmp`);
    Deno.mkdirSync(tmp, { recursive: true });
    try {
      Deno.writeFileSync(pathOf(tmp, entry), data);
      const final = pathOf(folder, `v${number}`);
      if (exists(final)) {
        const old = pathOf(folder, `.v${number}.${randomHex(4)}.old`);
        Deno.renameSync(final, old);
        Deno.renameSync(tmp, final);
        rmtree(old);
      } else {
        Deno.renameSync(tmp, final);
      }
    } catch (error) {
      rmtree(tmp);
      throw error;
    }
  }

  /** New artifact with version 1. Returns the manifest. */
  create(
    conversationId: string | null,
    title: string | null,
    kind: string,
    entry: string,
    data: Uint8Array,
    options: { project?: string | null; sourcePath?: string | null; by?: string; toolCallId?: string | null; note?: string } = {},
  ): Manifest {
    if (!(KINDS as readonly string[]).includes(kind)) throw new ArtifactError('Unsupported kind');
    const now = this.clock();
    let artifactId: string;
    do artifactId = randomHex(8); while (exists(this.folder(artifactId)));
    Deno.mkdirSync(this.folder(artifactId), { recursive: true });
    const version: Version = {
      n: 1,
      at: now,
      hash: sha256Hex(data),
      size: data.length,
      by: options.by ?? 'tool',
      toolCallId: options.toolCallId ?? null,
      note: options.note || '',
      entry,
    };
    const manifest: Manifest = {
      id: artifactId,
      title: clip(pyOr(title, entry) as string, 200),
      kind,
      project: options.project ?? null,
      conversationId,
      sourcePath: options.sourcePath ? String(options.sourcePath) : null,
      entry,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      versions: [version],
    };
    this.#writeVersion(artifactId, 1, entry, data);
    this.#save(manifest);
    return manifest;
  }

  /**
   * Returns [manifest, changed]. Identical content to the latest version adds nothing; a watcher change within FOLD_SECONDS of the
   * latest version replaces it instead of adding one.
   */
  addVersion(
    artifactId: unknown,
    data: Uint8Array,
    options: {
      entry?: string | null;
      by?: string;
      toolCallId?: string | null;
      note?: string;
      title?: string | null;
      sourcePath?: string | null;
    } = {},
  ): [Manifest, boolean] {
    const by = options.by ?? 'tool';
    const note = options.note ?? '';
    const digest = sha256Hex(data);
    const manifest = this.get(artifactId);
    const latest = manifest.versions[manifest.versions.length - 1];
    const entry = (options.entry || latest.entry || manifest.entry) as string;
    let dirty = false;
    if (options.title && options.title !== manifest.title) {
      manifest.title = clip(options.title, 200);
      dirty = true;
    }
    if (options.sourcePath && String(options.sourcePath) !== manifest.sourcePath) {
      manifest.sourcePath = String(options.sourcePath);
      dirty = true;
    }
    const missing = manifest.sourceMissing;
    delete manifest.sourceMissing;
    if (pyTruthy(missing)) dirty = true;
    if (digest === latest.hash) {
      if (dirty) this.#save(manifest);
      return [manifest, dirty];
    }
    const now = this.clock();
    if (by === 'watch' && now - latest.at < FOLD_SECONDS) {
      this.#writeVersion(manifest.id, latest.n, entry, data);
      Object.assign(latest, { at: now, hash: digest, size: data.length, entry });
      if (note) latest.note = note;
    } else {
      const number = Math.max(...manifest.versions.map((v) => v.n)) + 1;
      this.#writeVersion(manifest.id, number, entry, data);
      manifest.versions.push({
        n: number,
        at: now,
        hash: digest,
        size: data.length,
        by,
        toolCallId: options.toolCallId ?? null,
        note: note || '',
        entry,
      });
    }
    manifest.entry = entry;
    manifest.updatedAt = now;
    this.#retain(manifest);
    this.#save(manifest);
    return [manifest, true];
  }

  /**
   * Keep the newest MAX_VERSIONS / MAX_BYTES; v1 and the latest stay; pinned artifacts keep everything. A doc's history has its own
   * limit instead: every version from the last DOC_HISTORY_SECONDS (30 days), plus v1 and the latest.
   */
  #retain(manifest: Manifest): void {
    if (pyTruthy(manifest.pinned)) return;
    const versions = manifest.versions;
    if (isDocHistory(manifest)) {
      const cutoff = this.clock() - limits.docHistorySeconds;
      for (let k = versions.length - 2; k >= 1; k--) {
        if (versions[k].at >= cutoff) continue;
        const [victim] = versions.splice(k, 1);
        rmtree(pathOf(this.folder(manifest.id), `v${victim.n}`));
      }
      return;
    }
    for (;;) {
      const total = versions.reduce((sum, v) => sum + (v.size ?? 0), 0);
      if (versions.length <= limits.maxVersions && total <= limits.maxBytes) return;
      if (versions.length <= 2) return;
      const [victim] = versions.splice(1, 1);
      rmtree(pathOf(this.folder(manifest.id), `v${victim.n}`));
    }
  }

  setPinned(artifactId: unknown, pinned: boolean): [Manifest, boolean] {
    const manifest = this.get(artifactId);
    if (pyTruthy(manifest.pinned) === !!pinned) return [manifest, false];
    manifest.pinned = !!pinned;
    this.#save(manifest);
    return [manifest, true];
  }

  setSourceMissing(artifactId: unknown, missing: boolean): [Manifest, boolean] {
    const manifest = this.get(artifactId);
    if (pyTruthy(manifest.sourceMissing) === !!missing) return [manifest, false];
    if (missing) manifest.sourceMissing = true;
    else delete manifest.sourceMissing;
    this.#save(manifest);
    return [manifest, true];
  }

  restore(artifactId: unknown, number: number): [Manifest, boolean] {
    const manifest = this.get(artifactId);
    const version = manifest.versions.find((v) => v.n === number);
    if (version === undefined) throw new ArtifactError('That version no longer exists', 404, 'not_found');
    const entry = (version.entry || manifest.entry) as string;
    const data = readBytes(pathOf(this.folder(artifactId), `v${number}`, entry));
    return this.addVersion(artifactId, data, { entry, by: 'tool', note: `Restored from v${number}` });
  }

  versionFile(manifest: Manifest, number: number): string {
    const version = manifest.versions.find((v) => v.n === number);
    if (version === undefined) throw new ArtifactError('That version does not exist', 404, 'not_found');
    return pathOf(this.folder(manifest.id), `v${number}`, (version.entry || manifest.entry) as string);
  }

  source(artifactId: unknown, number: number | null = null): { text: string; truncated: boolean } {
    const manifest = this.get(artifactId);
    if (!(TEXT_KINDS as readonly string[]).includes(manifest.kind)) {
      throw new ArtifactError('Only text artifacts have a source view', 400, 'not_text');
    }
    const n = number || manifest.versions[manifest.versions.length - 1].n;
    const data = readPrefix(this.versionFile(manifest, n), MAX_SOURCE_BYTES + 1);
    return { text: decodeReplace(data.subarray(0, MAX_SOURCE_BYTES)), truncated: data.length > MAX_SOURCE_BYTES };
  }

  diff(artifactId: unknown, a: number, b: number): { diff: string; truncated: boolean } {
    const manifest = this.get(artifactId);
    if (!(TEXT_KINDS as readonly string[]).includes(manifest.kind)) {
      throw new ArtifactError('Only text artifacts can be compared', 400, 'not_text');
    }
    const texts: string[][] = [];
    for (const number of [a, b]) {
      texts.push(splitlinesKeepends(decodeReplace(readPrefix(this.versionFile(manifest, number), MAX_SOURCE_BYTES))));
    }
    let text = withNoEolMarkers(unifiedDiff(texts[0], texts[1], `v${a}`, `v${b}`)).join('');
    if (text && !text.endsWith('\n')) text += '\n';
    return { diff: clip(text, MAX_DIFF_CHARS), truncated: pyLen(text) > MAX_DIFF_CHARS };
  }
}

// ---- difflib (Python 3.11's SequenceMatcher with autojunk, and unified_diff) ----------------------

const BREAKS = '\n\r\v\f\x1c-\x1e\x85' + String.fromCharCode(0x2028, 0x2029); // what str.splitlines() splits on
const LINE_BREAKS = new RegExp(`[^${BREAKS}]*(?:\r\n|[${BREAKS}])?`, 'g');

/** str.splitlines(keepends=True) */
export function splitlinesKeepends(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(LINE_BREAKS)) if (match[0]) out.push(match[0]);
  return out;
}

const ENDS_WITH_BREAK = new RegExp(`[${BREAKS}]$`);

/**
 * A last line without a line break gets one, followed by the "\ No newline at end of file" line, as `diff -u` writes it. Without
 * this the old and the new last line were glued into one line ("-old+new") and the counts were wrong (Python: the same in diff()).
 */
export function withNoEolMarkers(lines: string[]): string[] {
  return lines.map((line) => (line && !ENDS_WITH_BREAK.test(line) ? line + '\n\\ No newline at end of file\n' : line));
}

type Block = [number, number, number];
type Opcode = [string, number, number, number, number];

class SequenceMatcher {
  #b2j = new Map<string, number[]>();
  constructor(readonly a: string[], readonly b: string[]) {
    b.forEach((line, i) => {
      const list = this.#b2j.get(line);
      if (list) list.push(i);
      else this.#b2j.set(line, [i]);
    });
    const n = b.length;
    if (n >= 200) {
      const ntest = Math.floor(n / 100) + 1;
      for (const [line, indices] of [...this.#b2j]) if (indices.length > ntest) this.#b2j.delete(line);
    }
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): Block {
    const { a, b } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of this.#b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // no junk function, so bjunk is empty: only the non-junk extensions apply (popular lines extend a match too)
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && a[besti + bestsize] === b[bestj + bestsize]) bestsize++;
    return [besti, bestj, bestsize];
  }

  matchingBlocks(): Block[] {
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Block[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const out: Block[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) out.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }
    }
    if (k1) out.push([i1, j1, k1]);
    out.push([la, lb, 0]);
    return out;
  }

  opcodes(): Opcode[] {
    let i = 0, j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.matchingBlocks()) {
      let tag = '';
      if (i < ai && j < bj) tag = 'replace';
      else if (i < ai) tag = 'delete';
      else if (j < bj) tag = 'insert';
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(['equal', ai, i, bj, j]);
    }
    return answer;
  }

  groupedOpcodes(n = 3): Opcode[][] {
    let codes = this.opcodes();
    if (!codes.length) codes = [['equal', 0, 1, 0, 1]];
    if (codes[0][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[0];
      codes[0] = [tag, Math.max(i1, i2 - n), i2, Math.max(j1, j2 - n), j2];
    }
    const last = codes.length - 1;
    if (codes[last][0] === 'equal') {
      const [tag, i1, i2, j1, j2] = codes[last];
      codes[last] = [tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)];
    }
    const nn = n + n;
    const groups: Opcode[][] = [];
    let group: Opcode[] = [];
    for (const code of codes) {
      let [tag, i1, i2, j1, j2] = code;
      if (tag === 'equal' && i2 - i1 > nn) {
        group.push([tag, i1, Math.min(i2, i1 + n), j1, Math.min(j2, j1 + n)]);
        groups.push(group);
        group = [];
        i1 = Math.max(i1, i2 - n);
        j1 = Math.max(j1, j2 - n);
      }
      group.push([tag, i1, i2, j1, j2]);
    }
    if (group.length && !(group.length === 1 && group[0][0] === 'equal')) groups.push(group);
    return groups;
  }
}

function formatRangeUnified(start: number, stop: number): string {
  let beginning = start + 1;
  const length = stop - start;
  if (length === 1) return String(beginning);
  if (!length) beginning -= 1;
  return `${beginning},${length}`;
}

/** difflib.unified_diff(a, b, fromfile, tofile) with n=3 and lineterm '\n'. */
export function unifiedDiff(a: string[], b: string[], fromfile: string, tofile: string, n = 3): string[] {
  const out: string[] = [];
  let started = false;
  for (const group of new SequenceMatcher(a, b).groupedOpcodes(n)) {
    if (!started) {
      started = true;
      out.push(`--- ${fromfile}\n`, `+++ ${tofile}\n`);
    }
    const first = group[0], last = group[group.length - 1];
    out.push(`@@ -${formatRangeUnified(first[1], last[2])} +${formatRangeUnified(first[3], last[4])} @@\n`);
    for (const [tag, i1, i2, j1, j2] of group) {
      if (tag === 'equal') {
        for (const line of a.slice(i1, i2)) out.push(' ' + line);
        continue;
      }
      if (tag === 'replace' || tag === 'delete') { for (const line of a.slice(i1, i2)) out.push('-' + line); }
      if (tag === 'replace' || tag === 'insert') { for (const line of b.slice(j1, j2)) out.push('+' + line); }
    }
  }
  return out;
}

// ---- agent tool key hook ---------------------------------------------------------------------------

/** Request headers, case-insensitive like Python's message headers (a Fetch `Headers` works). */
export interface HeaderBag {
  get(name: string): string | null | undefined;
}
export interface RequestLike {
  headers: HeaderBag;
}

/**
 * True when the request carries a valid X-Studio-Artifact-Key for exactly this conversation. The publish and list routes accept
 * either the Studio page token or this returning true. Keys come from keys.ts (an HMAC of the conversation id, shared by the web
 * server and the agent host through the state folder).
 */
export function authorizeToolKey(handler: RequestLike, conversationId: string): boolean {
  try {
    return checkArtifactKey(handler.headers.get('X-Studio-Artifact-Key') ?? null, conversationId);
  } catch (error) { // a missing or unreadable secret means "no", never a crash
    log.exception(error, 'Artifact key authorization failed; treated as not authorized');
    return false;
  }
}

const SPACES = new RegExp(`[${PY_SPACE}]+`, 'g');

/** The <title> of an HTML file (bytes regex over the first 64 KiB), else the file name made readable. */
export function guessTitle(path: unknown, kind: string, data: Uint8Array): string {
  const name = pyStrip(pureStem(String(path)).replaceAll('_', ' ').replaceAll('-', ' ')) || 'Artifact';
  if (kind === 'html') {
    const head = data.subarray(0, 65536);
    let latin = '';
    for (let i = 0; i < head.length; i += 8192) latin += String.fromCharCode(...head.subarray(i, i + 8192));
    const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(latin);
    if (match) {
      const bytes = Uint8Array.from(match[1], (c) => c.charCodeAt(0));
      const text = pyStrip(decodeReplace(bytes).replace(SPACES, ' '));
      if (text) return clip(text, 200);
    }
  }
  return clip(name, 200);
}

export function readCapped(path: string): Uint8Array {
  let size: number;
  try {
    size = Deno.statSync(path).size;
  } catch (error) {
    throw pyOSError(error, path, 'stat');
  }
  if (size > MAX_FILE_BYTES) throw new ArtifactError('That file is too large to preview (limit 25 MB)', 413, 'too_large');
  return readBytes(path);
}

// ---- the routes and sync logic ------------------------------------------------------------------

export type Emit = (conversationId: string, event: Json) => unknown;
export type Reply = [number, unknown];
/** Query arguments as urllib.parse.parse_qs gives them: name -> values. */
export type QueryArgs = Record<string, string[]>;

// ---- the bin: moving a deleted artifact's source file aside and back -------------------------------

/** The file moves the bin does (tests swap `rename` to force the cross-drive path or a lock). */
export interface FileOps {
  rename(from: string, to: string): void;
}
export const realFileOps: FileOps = { rename: (from, to) => Deno.renameSync(from, to) };

/** A file another program holds open (Windows sharing violation, os error 32/33; EBUSY elsewhere). */
export function isLocked(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return !!e && (e.code === 'EBUSY' || /\(os error (32|33)\)/.test(String(e.message ?? '')));
}

/** A rename across drives or file systems (Windows os error 17, EXDEV os error 18). */
export function isCrossDevice(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return !!e && (e.code === 'EXDEV' || /\(os error (17|18)\)/.test(String(e.message ?? '')));
}

/** The 409 for a file another program holds: nothing was changed. */
function lockedError(path: string): ArtifactError {
  return new ArtifactError(`Close ${pureName(path)} in the other program, then try again.`, 409, 'locked');
}

/**
 * Move a file: a rename, or on another drive copy, check size and hash, then remove the original (the copy goes again if that
 * fails). A lock anywhere throws `locked` with nothing changed.
 */
function moveFile(ops: FileOps, from: string, to: string, hash: string | null): void {
  try {
    ops.rename(from, to);
    return;
  } catch (error) {
    if (isLocked(error)) throw lockedError(from);
    if (!isCrossDevice(error)) throw error;
  }
  let data: Uint8Array;
  try {
    data = Deno.readFileSync(from);
  } catch (error) {
    if (isLocked(error)) throw lockedError(from);
    throw error;
  }
  const want = hash || sha256Hex(data);
  Deno.writeFileSync(to, data);
  const copied = Deno.readFileSync(to);
  if (copied.length !== data.length || sha256Hex(copied) !== want) {
    rmtree(to);
    throw new ArtifactError('The file could not be copied safely, so nothing was changed.', 500, 'copy_failed');
  }
  try {
    Deno.removeSync(from);
  } catch (error) {
    rmtree(to);
    if (isLocked(error)) throw lockedError(from);
    throw error;
  }
}

/** `path` relative to `folder` with forward slashes, or null when it is not inside. */
function relativeTo(path: string, folder: string): string | null {
  const real = pathOf(realpath(path));
  const base = pathOf(realpath(folder));
  const a = normcase(real), b = normcase(base);
  if (a === b) return '';
  const head = b.endsWith(SEP) ? b : b + SEP;
  return a.startsWith(head) ? real.slice(head.length).replaceAll('\\', '/') : null;
}

/** The parent folder of a path. */
function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}

/** "<stem> (restored)<ext>" next to `path`, then "(restored 2)"... the first name that is free. */
export function restoredName(path: string): string {
  const folder = parentOf(path);
  const stem = pureStem(path).replace(/ \(restored(?: \d+)?\)$/, ''), ext = pureSuffix(path); // never "(restored) (restored)"
  for (let k = 1;; k++) {
    const name = pathOf(folder, `${stem} (restored${k > 1 ? ' ' + k : ''})${ext}`);
    if (!exists(name)) return name;
  }
}

type Kept = { code: string; reason: string };

export interface ServiceOptions {
  emit?: Emit | null;
  /** turns a live connection id into the chat's lasting id ("provider:sessionId"); unknown ids pass through */
  chatOf?: ((ident: string) => unknown) | null;
  /** the chat's projectRoot, which artifacts are tagged with; today the cwd */
  rootFor?: ((conversationId: string) => string | null | undefined) | null;
}

/**
 * Routes and sync logic (artifacts.Service). `cwdFor(conversationId)` returns the project folder or null; `emit(conversationId,
 * event)` pushes a live event to the page. `chatOf(id)` turns a live connection id into the chat's lasting id, so a chat keeps its
 * artifacts when it reconnects under a new connection.
 */
export class Service {
  readonly emit: Emit | null;
  readonly rootFor: (conversationId: string) => string | null | undefined;
  readonly chatOf: (ident: string) => unknown;
  /** How the bin moves files (tests force a cross-drive copy or a lock through it). */
  fileOps: FileOps = realFileOps;

  constructor(
    readonly store: ArtifactStore,
    readonly tokenGetter: () => string,
    readonly cwdFor: (conversationId: string) => string | null | undefined,
    options: ServiceOptions = {},
  ) {
    this.emit = options.emit ?? null;
    this.rootFor = options.rootFor ?? cwdFor;
    this.chatOf = options.chatOf ?? ((ident) => ident);
  }

  projectRootFor(conversationId: string): string | null {
    return (this.rootFor(conversationId) || this.cwdFor(conversationId)) ?? null;
  }

  chat(ident: string): string {
    let chat: unknown;
    try {
      chat = this.chatOf(ident);
    } catch (error) {
      log.exception(error, 'Looking up the chat for conversation %s failed', ident);
      chat = null;
    }
    return typeof chat === 'string' && chat ? chat : ident;
  }

  event(manifest: Manifest): Json {
    const summary = this.store.summary(manifest);
    if (this.emit && pyTruthy(manifest.conversationId)) {
      try {
        this.emit(manifest.conversationId as string, { type: 'artifact', conversationId: manifest.conversationId, artifact: summary });
      } catch (error) {
        log.exception(error, 'Emitting the artifact event failed');
      }
    }
    return summary;
  }

  #tokenOk(handler: RequestLike): boolean {
    return tokenMatches(handler.headers.get('X-Studio-Token') ?? '', this.tokenGetter());
  }

  /** The 403 when neither token nor key passed: name the key when one was sent. */
  static denied(handler: RequestLike): Reply {
    const sent = handler.headers.get('X-Studio-Artifact-Key');
    return [403, { error: sent !== null && sent !== undefined ? 'Invalid artifact key' : 'Invalid local session token' }];
  }

  #authorized(handler: RequestLike, conversationId: unknown, toolRoute: boolean): boolean {
    if (this.#tokenOk(handler)) return true;
    return toolRoute && typeof conversationId === 'string' && !!conversationId && authorizeToolKey(handler, conversationId);
  }

  resolvePath(conversationId: string, raw: unknown): [string, string] {
    const cwd = this.cwdFor(conversationId);
    if (!cwd) throw new ArtifactError('This chat has no known project folder.', 404, 'unknown_folder');
    if (typeof raw !== 'string' || !raw || raw.includes('\0') || pyLen(raw) > 2000) throw new ArtifactError('Choose a file');
    let candidate = pathOf(raw);
    if (!pathIsAbsolute(candidate)) candidate = pathOf(cwd, candidate);
    if (!inside(candidate, cwd)) throw new ArtifactError("That file is outside the chat's project folder.", 403, 'outside_project');
    const real = pathOf(realpath(candidate));
    if (!isFile(real)) throw new ArtifactError('That file does not exist.', 404, 'not_found');
    if (kindFor(pureName(real)) === null) throw new ArtifactError('That kind of file cannot be previewed.', 400, 'unsupported_kind');
    return [cwd, real];
  }

  /** Create the artifact for a file in this chat, or add a version if its content changed. Returns [manifest, changed]. */
  syncFile(
    conversationId: string,
    real: string,
    by: string,
    options: { cwd?: string | null; title?: string | null; toolCallId?: string | null; note?: string; projectRoot?: string | null } = {},
  ): [Manifest, boolean] {
    const data = readCapped(real);
    const kind = kindFor(pureName(real))!;
    const existing = this.store.findBySource(conversationId, real);
    if (existing) {
      return this.store.addVersion(existing.id, data, {
        entry: safeEntryName(pureName(real)),
        by,
        toolCallId: options.toolCallId ?? null,
        note: options.note ?? '',
        title: options.title ?? null,
      });
    }
    const manifest = this.store.create(
      conversationId,
      options.title || guessTitle(real, kind, data),
      kind,
      safeEntryName(pureName(real)),
      data,
      {
        project: pyOr(options.projectRoot, options.cwd ?? null) as string | null,
        sourcePath: String(real),
        by,
        toolCallId: options.toolCallId ?? null,
        note: options.note ?? '',
      },
    );
    return [manifest, true];
  }

  static int(value: unknown): number {
    const text = typeof value === 'string' ? pyStrip(value) : '';
    if (!/^[+-]?[0-9]+(?:_[0-9]+)*$/.test(text)) throw new ArtifactError('Invalid version');
    return Number(text.replaceAll('_', ''));
  }

  // ---- GET ----
  handleGet(handler: RequestLike, path: string, args: QueryArgs): Reply {
    const one = (name: string, fallback = '') => (Object.hasOwn(args, name) ? args[name][0] : fallback);
    if (path === '/api/live/artifacts') {
      const conversationId = one('conversationId');
      if (!this.#authorized(handler, conversationId, true)) return Service.denied(handler);
      if (!conversationId) return [400, { error: 'Choose a chat', code: 'invalid' }];
      // Recently deleted only for the page (its picker's foot group); the agent's list and the Files marks never see deleted ones
      const deleted = one('deleted') === '1' && this.#tokenOk(handler);
      return [200, { artifacts: this.store.list(this.chat(conversationId), [conversationId], { deleted }) }];
    }
    if (!this.#tokenOk(handler)) return [403, { error: 'Invalid local session token' }];
    try {
      if (path === '/api/live/artifacts/states') {
        const ids = one('ids').split(',').map((id) => id.trim()).filter(Boolean);
        if (ids.length > MAX_STATE_IDS) return [400, { error: `At most ${MAX_STATE_IDS} ids`, code: 'invalid' }];
        return [200, { states: this.store.states(ids) }];
      }
      if (path === '/api/live/artifacts/item') return [200, this.store.item(one('id'))];
      if (path === '/api/live/artifacts/source') {
        return [200, this.store.source(one('id'), one('version') ? Service.int(one('version')) : null)];
      }
      if (path === '/api/live/artifacts/diff') {
        const manifest = this.store.get(one('id'));
        const to = one('to') ? Service.int(one('to')) : manifest.versions[manifest.versions.length - 1].n;
        const from = one('from') ? Service.int(one('from')) : Math.max(1, to - 1);
        return [200, this.store.diff(one('id'), from, to)];
      }
    } catch (error) {
      return errorReply(error);
    }
    return [404, { error: 'Not found' }];
  }

  // ---- POST ----
  handlePost(handler: RequestLike, path: string, body: unknown): Reply {
    if (!isDict(body)) return [400, { error: 'Invalid request' }];
    const publish = path === '/api/live/artifacts/publish';
    const archive = path === '/api/live/artifacts/archive'; // the agent may archive its own chat's artifacts (decision 5a)
    const tool = publish || archive;
    if (!this.#authorized(handler, tool ? body.conversationId : null, tool)) return Service.denied(handler);
    try {
      if (path === '/api/live/artifacts/preview') return [200, this.#preview(body)];
      if (publish) return [200, this.#publish(body)];
      if (archive) return this.#archive(body, this.#tokenOk(handler));
      if (path === '/api/live/artifacts/delete') return [200, this.deleteArtifact(body.id)];
      if (path === '/api/live/artifacts/undelete') return [200, this.undeleteArtifact(body.id)];
      if (path === '/api/live/artifacts/purge') return [200, this.purgeArtifact(body.id)];
      if (path === '/api/live/artifacts/pin') {
        if (typeof body.pinned !== 'boolean') throw new ArtifactError('pinned must be true or false');
        this.liveOnly(body.id);
        const [manifest, changed] = this.store.setPinned(body.id, body.pinned);
        return [200, changed ? this.event(manifest) : this.store.summary(manifest)];
      }
      if (path === '/api/live/artifacts/restore') {
        const number = body.version;
        if (!isInt(number)) throw new ArtifactError('Choose a version');
        this.liveOnly(body.id);
        const [manifest, changed] = this.store.restore(body.id, number);
        return [200, changed ? this.event(manifest) : this.store.summary(manifest)];
      }
    } catch (error) {
      return errorReply(error);
    }
    return [404, { error: 'Not found' }];
  }

  static conversation(body: Json, chat?: (ident: string) => string): string {
    const conversationId = body.conversationId;
    if (typeof conversationId !== 'string' || !conversationId || pyLen(conversationId) > 600) throw new ArtifactError('Choose a chat');
    return chat ? chat(conversationId) : conversationId;
  }

  /** The manifest, unless it is in Recently deleted: every write refuses a deleted artifact with 409 `deleted`. */
  liveOnly(artifactId: unknown): Manifest {
    const manifest = this.store.get(artifactId);
    if (isDeleted(manifest)) throw new ArtifactError('This artifact is in Recently deleted. Restore it first.', 409, 'deleted');
    return manifest;
  }

  /** The owner chat's folder (project or worktree), as prepare() resolved it, or null when unknown. Never manifest.project. */
  ownerFolder(manifest: Manifest): string | null {
    const owner = manifest.conversationId;
    if (typeof owner !== 'string' || !owner) return null;
    const folder = this.cwdFor(this.chat(owner)) ?? null;
    return folder && statOrNull(folder)?.isDirectory ? folder : null;
  }

  /**
   * POST /archive {conversationId, ids, archived}: archive or unarchive. The page may act on any artifact (one opened from another
   * chat's link too); an agent only on its own chat's. Per id: done (in `artifacts`) or refused ({id, code, error}). When nothing was
   * done the reply takes the first refusal's status (403 for another chat's artifact).
   */
  #archive(body: Json, page: boolean): Reply {
    const ids = body.ids;
    if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id)) {
      throw new ArtifactError('ids must be a list of artifact ids');
    }
    if (ids.length > MAX_ARCHIVE_IDS) throw new ArtifactError(`At most ${MAX_ARCHIVE_IDS} ids at a time`);
    const archived = body.archived === undefined ? true : body.archived;
    if (typeof archived !== 'boolean') throw new ArtifactError('archived must be true or false');
    const raw = typeof body.conversationId === 'string' ? body.conversationId : null;
    const chat = raw ? this.chat(raw) : null;
    const done: Json[] = [];
    const unpinned: string[] = [];
    const refused: Json[] = [];
    let firstStatus = 0;
    for (const id of [...new Set(ids as string[])]) {
      try {
        const manifest = this.store.get(id);
        if (isDocHistory(manifest)) throw new ArtifactError('Unknown artifact', 404, 'not_found');
        const owner = manifest.conversationId ?? null;
        if (!page && owner !== chat && owner !== raw) {
          throw new ArtifactError('That artifact belongs to another chat', 403, 'wrong_conversation');
        }
        if (isDeleted(manifest)) throw new ArtifactError('The user deleted this artifact.', 409, 'deleted');
        const [updated, changed, wasPinned] = this.store.setArchived(id, archived);
        if (wasPinned) unpinned.push(id);
        done.push(changed ? this.event(updated) : this.store.summary(updated));
      } catch (error) {
        if (!(error instanceof ArtifactError)) throw error;
        refused.push({ id, code: error.code, error: error.message });
        firstStatus ||= error.status;
      }
    }
    const reply: Json = { artifacts: done, refused, unpinned };
    if (!done.length && refused.length) return [firstStatus, { error: refused[0].error, code: refused[0].code, ...reply }];
    return [200, reply];
  }

  /**
   * Why a deleted artifact's source file stays, or null when it may go. The owner's rule first (sourceFileGoesWithDelete), then the
   * hard limits: the owner chat's real folder only, a regular file reached without links, never aib-docs or .git, never a file another
   * non-deleted artifact shows.
   */
  #keepReason(manifest: Manifest, source: string, folder: string | null): Kept | null {
    const rule = sourceFileGoesWithDelete(artifactOrigin(manifest));
    if (!rule.goes) return { code: rule.code, reason: rule.reason };
    if (!folder) return { code: 'folder_unknown', reason: "AIB can't find this chat's folder" };
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(source);
    } catch {
      return { code: 'gone', reason: 'it was already gone from disk' };
    }
    if (st.isSymlink) return { code: 'link', reason: 'it is a link, not a file' };
    if (!st.isFile) return { code: 'not_file', reason: 'it is not a regular file' };
    if (!inside(source, folder)) return { code: 'outside', reason: "it is outside this chat's folder" };
    if (pathKey(source) !== normcase(abspath(source))) return { code: 'link', reason: 'it is reached through a link' };
    const rel = relativeTo(source, folder) ?? '';
    const parts = rel.split('/').map((part) => (WIN ? part.toLowerCase() : part));
    if (parts.includes('.git')) return { code: 'git', reason: 'it is inside .git' };
    if (parts.includes('aib-docs')) return { code: 'docs', reason: 'it belongs to an AIB doc' };
    if (this.store.sharing(manifest.id, source).length) return { code: 'shared', reason: 'another artifact shows it' };
    return null;
  }

  /**
   * POST /delete {id} (the page only; the gate refuses an agent key): to Recently deleted, and the source file into the artifact's bin
   * (artifacts/<id>/deleted-source/) when #keepReason allows. A file changed since the latest version is saved as a version first
   * ("File at delete time"). A locked file refuses the whole Delete with nothing changed. One synchronous run: no watcher tick between.
   * -> {artifact, file: null | {path, action: 'moved' | 'kept', code?, reason?}}
   */
  deleteArtifact(artifactId: unknown): Json {
    let manifest = this.store.get(artifactId);
    if (isDocHistory(manifest)) throw new ArtifactError('Unknown artifact', 404, 'not_found');
    if (isDeleted(manifest)) return { artifact: this.store.summary(manifest), file: this.#fileOf(manifest) };
    const source = pyTruthy(manifest.sourcePath) ? String(manifest.sourcePath) : null;
    if (!source) {
      manifest.deletedAt = this.store.clock();
      this.store.save(manifest);
      return { artifact: this.event(this.store.get(manifest.id)), file: null };
    }
    const folder = this.ownerFolder(manifest);
    const rel = (folder && relativeTo(source, folder)) || source;
    const kept = this.#keepReason(manifest, source, folder);
    if (kept) {
      manifest.deletedAt = this.store.clock();
      manifest.deletedSource = { path: source, rel, kept: kept.reason, code: kept.code };
      this.store.save(manifest);
      return { artifact: this.event(this.store.get(manifest.id)), file: { path: rel, action: 'kept', ...kept } };
    }
    const st = Deno.statSync(source);
    let data: Uint8Array | null = null;
    if (st.size <= MAX_FILE_BYTES) {
      try {
        data = Deno.readFileSync(source);
      } catch (error) {
        if (isLocked(error)) throw lockedError(source);
        throw error;
      }
    }
    const hash = data ? sha256Hex(data) : null;
    const binDir = pathOf(this.store.folder(manifest.id), BIN_FOLDER);
    Deno.mkdirSync(binDir, { recursive: true });
    const base = safeEntryName(pureName(source));
    let name = base;
    for (let k = 2; exists(pathOf(binDir, name)); k++) name = `${k}-${base}`;
    const bin = pathOf(binDir, name);
    try {
      moveFile(this.fileOps, source, bin, hash);
    } catch (error) {
      try {
        Deno.removeSync(binDir); // only when empty
      } catch { /* an older kept copy */ }
      throw error;
    }
    try {
      const latest = manifest.versions[manifest.versions.length - 1];
      if (data && hash !== latest.hash) {
        [manifest] = this.store.addVersion(manifest.id, data, { entry: base, by: 'watch', note: 'File at delete time' });
      }
      manifest.deletedAt = this.store.clock();
      manifest.deletedSource = {
        path: source,
        rel,
        bin: BIN_FOLDER + '/' + name,
        hash: hash ?? sha256Hex(Deno.readFileSync(bin)),
        size: st.size,
        mtime: st.mtime?.getTime() ?? null,
      };
      this.store.save(manifest);
    } catch (error) { // the manifest could not say where the file went: put it back
      try {
        moveFile(this.fileOps, bin, source, null);
      } catch (back) {
        log.exception(back, 'Putting %s back after a failed delete failed; it is in %s', source, bin);
      }
      throw error;
    }
    return { artifact: this.event(this.store.get(manifest.id)), file: { path: rel, action: 'moved' } };
  }

  /** What Delete did with the file, from the manifest (a repeated Delete answers the same). */
  #fileOf(manifest: Manifest): Json | null {
    const ds = manifest.deletedSource;
    if (!isDict(ds)) return null;
    if (isStr(ds.kept)) return { path: ds.rel ?? ds.path, action: 'kept', code: ds.code ?? null, reason: ds.kept };
    return { path: ds.rel ?? ds.path, action: 'moved' };
  }

  /**
   * POST /undelete {id} (the page only): back from Recently deleted, and the file back where it was. A different file at that path
   * now (or another artifact of the chat showing it): it comes back next to it as "<name> (restored).<ext>" and the artifact follows
   * it (owner answer C). The owner's folder gone: the artifact comes back with sourceMissing; its bin copy is dropped when a version
   * has the same bytes, else kept (sourceCopy) so the user can still get at it.
   * -> {artifact, file: null | {path, action: 'restored' | 'restored_as' | 'kept', as?, code?, reason?}}
   */
  undeleteArtifact(artifactId: unknown): Json {
    const manifest = this.store.get(artifactId);
    if (!isDeleted(manifest)) return { artifact: this.store.summary(manifest), file: null };
    const ds = isDict(manifest.deletedSource) ? manifest.deletedSource : null;
    const folder = this.store.folder(manifest.id);
    let file: Json | null = null;
    let dropBin = ''; // a bin copy no longer needed: removed only once the manifest is saved
    if (ds && isStr(ds.bin)) {
      const bin = pathOf(folder, ds.bin);
      const target = String(ds.path);
      const rel = String(ds.rel ?? ds.path);
      const owner = this.ownerFolder(manifest);
      const keepCopy = (code: string, reason: string) => {
        if (manifest.versions.some((v) => v.hash === ds.hash)) dropBin = bin;
        else manifest.sourceCopy = ds.bin;
        manifest.sourceMissing = true;
        file = { path: rel, action: 'kept', code, reason, ...(dropBin ? {} : { as: bin }) };
      };
      if (!isFile(bin)) {
        manifest.sourceMissing = true;
        file = { path: rel, action: 'kept', code: 'copy_gone', reason: 'the saved copy of the file is gone' };
      } else if (!owner) {
        keepCopy('folder_gone', "this chat's folder is gone");
      } else if (!inside(target, owner)) {
        keepCopy('outside', "its old place is outside this chat's folder");
      } else {
        const claimed = this.store.all().some((m) =>
          m.id !== manifest.id && !isDeleted(m) && m.conversationId === manifest.conversationId && pyTruthy(m.sourcePath) &&
          pathKey(m.sourcePath) === pathKey(target)
        );
        const st = statOrNull(target);
        if (st?.isFile && !claimed && st.size === ds.size && sha256Hex(Deno.readFileSync(target)) === ds.hash) {
          dropBin = bin; // the same bytes are back at the path already
          delete manifest.sourceMissing;
          file = { path: rel, action: 'restored' };
        } else if (st || claimed) {
          const as = restoredName(target);
          moveFile(this.fileOps, bin, as, isStr(ds.hash) ? ds.hash : null);
          manifest.sourcePath = as;
          delete manifest.sourceMissing;
          file = { path: rel, action: 'restored_as', as: relativeTo(as, owner) ?? as };
        } else {
          Deno.mkdirSync(parentOf(target), { recursive: true });
          moveFile(this.fileOps, bin, target, isStr(ds.hash) ? ds.hash : null);
          delete manifest.sourceMissing;
          file = { path: rel, action: 'restored' };
        }
      }
    } else if (ds) {
      file = { path: ds.rel ?? ds.path, action: 'kept', code: ds.code ?? null, reason: ds.kept ?? null };
    }
    delete manifest.deletedAt;
    delete manifest.deletedSource;
    this.store.save(manifest);
    if (dropBin) rmtree(dropBin);
    try {
      Deno.removeSync(pathOf(folder, BIN_FOLDER)); // only when empty
    } catch { /* a kept copy is still in it */ }
    return { artifact: this.event(this.store.get(manifest.id)), file };
  }

  /** POST /purge {id} (the page only, "Delete now"): remove a deleted artifact for good, its bin copy too. -> {purged: id} */
  purgeArtifact(artifactId: unknown): Json {
    const manifest = this.store.get(artifactId);
    if (!isDeleted(manifest)) throw new ArtifactError('Only an artifact in Recently deleted can be deleted for good.', 409, 'not_deleted');
    if (!this.store.purge(manifest.id)) throw new ArtifactError('AIB could not remove every file; it tries again later.', 500, 'purge_failed');
    this.purgedEvent(manifest);
    return { purged: manifest.id };
  }

  /** The 30-day sweep (artifact_wiring runs it at start and every 6 h): purge what is due and tell the page. */
  sweep(): string[] {
    const purged = this.store.sweep();
    for (const m of purged) this.purgedEvent(m);
    return purged.map((m) => m.id);
  }

  /** {type: 'artifact', artifact: {id, conversationId, purged: true}}: the page drops it from Recently deleted. */
  purgedEvent(manifest: Manifest): void {
    if (!this.emit || !pyTruthy(manifest.conversationId)) return;
    try {
      const cid = manifest.conversationId as string;
      this.emit(cid, { type: 'artifact', conversationId: cid, artifact: { id: manifest.id, conversationId: cid, purged: true } });
    } catch (error) {
      log.exception(error, 'Emitting the artifact event failed');
    }
  }

  #preview(body: Json): Json {
    const conversationId = Service.conversation(body, (ident) => this.chat(ident));
    const [cwd, real] = this.resolvePath(conversationId, body.path);
    const [manifest, changed] = this.syncFile(conversationId, real, 'preview', { cwd, projectRoot: this.projectRootFor(conversationId) });
    return changed ? this.event(manifest) : this.store.summary(manifest);
  }

  #publish(body: Json): Json {
    const conversationId = Service.conversation(body, (ident) => this.chat(ident));
    // "Built from <doc › page>": resolved by the web route (studio_routes.ts) from the tool's `fromDoc`, never taken from the caller
    const fromDoc = isDict(body[FROM_DOC_RESOLVED]) ? body[FROM_DOC_RESOLVED] as Json : null;
    const hasPath = body.path !== null && body.path !== undefined;
    const hasContent = body.content !== null && body.content !== undefined;
    if (hasPath === hasContent) throw new ArtifactError('Give exactly one of path or content');
    const title = body.title;
    if (title !== null && title !== undefined && !isStr(title)) throw new ArtifactError('title must be text');
    const titleText = (title as string | null | undefined) || null;
    const note = isStr(body.note) ? body.note : '';
    const toolCallId = isStr(body.toolCallId) ? body.toolCallId : null;
    let kind = body.kind as string | null | undefined;
    if (kind !== null && kind !== undefined && !(KINDS as readonly unknown[]).includes(kind)) throw new ArtifactError('Unsupported kind');
    let existing: Manifest | null = null;
    if (body.id !== null && body.id !== undefined) {
      existing = this.store.get(body.id);
      const owner = existing.conversationId ?? null;
      if (owner !== conversationId && owner !== (body.conversationId ?? null)) {
        throw new ArtifactError('That artifact belongs to another chat', 403, 'wrong_conversation');
      }
      if (isDeleted(existing)) {
        throw new ArtifactError('The user deleted this artifact. Publish a new one only if they ask.', 409, 'deleted');
      }
      if (isStr(existing.becameDoc) && existing.becameDoc) {
        throw new ArtifactError(
          `This artifact is now the doc "${existing.becameDoc}": the user edits it there. Read it with doc_read and change it with ` +
            'doc_edit (the never-overwrite guards keep what the user typed); do not publish it again.',
          409,
          'became_doc',
        );
      }
    }
    let manifest: Manifest;
    let changed: boolean;
    if (hasPath) {
      const [cwd, real] = this.resolvePath(conversationId, body.path);
      if (existing) {
        [manifest, changed] = this.store.addVersion(existing.id, readCapped(real), {
          entry: safeEntryName(pureName(real)),
          by: 'tool',
          toolCallId,
          note,
          title: titleText,
          sourcePath: String(real),
        });
      } else { // the same file in the same chat is the same artifact (the watcher may already have made it)
        [manifest, changed] = this.syncFile(conversationId, real, 'tool', {
          cwd,
          projectRoot: this.projectRootFor(conversationId),
          title: titleText,
          toolCallId,
          note,
        });
      }
    } else {
      const content = body.content;
      if (!isStr(content)) throw new ArtifactError('content must be text');
      const data = new TextEncoder().encode(content);
      if (data.length > MAX_FILE_BYTES) throw new ArtifactError('Content too large (limit 25 MB)', 413, 'too_large');
      if (existing) {
        [manifest, changed] = this.store.addVersion(existing.id, data, { by: 'tool', toolCallId, note, title: titleText });
      } else {
        const filename = body.filename;
        let entry: string;
        if (isStr(filename) && pyStrip(filename)) {
          entry = safeEntryName(filename);
          kind = kind || kindFor(entry);
          if (!kind) throw new ArtifactError('That kind of file cannot be previewed.', 400, 'unsupported_kind');
        } else {
          kind = kind || 'html';
          entry = safeEntryName(pyStrip((title as string) || 'artifact').replace(SPACES, '-').toLowerCase(), 'artifact');
        }
        if (!(TEXT_KINDS as readonly string[]).includes(kind)) {
          throw new ArtifactError('Content can only be published as html, svg, md, csv, json or text');
        }
        if (kindFor(entry) !== kind) entry = pureStem(entry) + DEFAULT_EXT[kind];
        manifest = this.store.create(conversationId, titleText || guessTitle(entry, kind, data), kind, entry, data, {
          project: this.projectRootFor(conversationId),
          by: 'tool',
          toolCallId,
          note,
        });
        changed = true;
      }
    }
    if (fromDoc && JSON.stringify(manifest.fromDoc ?? null) !== JSON.stringify(fromDoc)) {
      manifest = this.store.setFromDoc(manifest.id, fromDoc);
      changed = true;
    }
    return changed ? this.event(manifest) : this.store.summary(manifest);
  }
}

/** The body key the web route puts the resolved "built from" doc page under (whatever the caller sent there is dropped first). */
export const FROM_DOC_RESOLVED = '\u0000fromDoc';

function errorReply(error: unknown): Reply {
  if (error instanceof ArtifactError) return [error.status, { error: error.message, code: error.code }];
  if (isOSError(error)) return [400, { error: (error as Error).message }];
  throw error;
}

// ---- write tracking --------------------------------------------------------------------------------

/**
 * The files one conversation's agent has written, learned from its ACP session/update notifications.
 *
 * Only the agent's own write-like tool calls count (kind edit, diff content, or Claude Code's Write / Edit / MultiEdit /
 * NotebookEdit). Reads, searches and shell commands never do. This is the only thing that lets the Watcher attach a file to a chat.
 */
export class WriteTracker {
  readonly cwd: string;
  readonly paths = new Map<string, number>(); // path -> last time it was written (insertion ordered, oldest dropped)
  readonly calls = new Map<string | number, true>(); // toolCallId -> true when that call is a write (later updates may omit the kind)

  constructor(cwd: unknown = '') {
    this.cwd = cwd ? String(cwd) : '';
  }

  static toolName(update: Json): string {
    const meta = update._meta;
    const claude = isDict(meta) ? meta.claudeCode : null;
    const name = pyOr(isDict(claude) ? claude.toolName : null, update.toolName);
    return typeof name === 'string' ? name.slice(name.lastIndexOf('__') < 0 ? 0 : name.lastIndexOf('__') + 2).toLowerCase() : '';
  }

  static isWrite(update: Json): boolean {
    const content = update.content;
    if (Array.isArray(content) && content.some((i) => isDict(i) && i.type === 'diff')) return true;
    return update.kind === 'edit' || WRITE_TOOLS.includes(WriteTracker.toolName(update));
  }

  /** Feed one session/update `params`. Returns the paths it recorded. */
  observe(params: unknown, now: number | null = null): string[] {
    const update = isDict(params) ? params.update : null;
    if (!isDict(update) || (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update')) return [];
    let callId = update.toolCallId as unknown;
    if (typeof callId === 'boolean') callId = callId ? 1 : 0; // Python: True == 1 as a dict key
    let write = WriteTracker.isWrite(update);
    if (typeof callId === 'string' || isInt(callId)) {
      const id = callId as string | number;
      if (write) {
        this.calls.set(id, true);
        while (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value!);
      } else if ((update.kind === null || update.kind === undefined || update.kind === '') && this.calls.has(id)) {
        write = true; // a later update of a call already known to be a write
      }
    }
    if (!write) return [];
    const found: unknown[] = [];
    const content = update.content;
    for (const item of Array.isArray(content) ? content : []) if (isDict(item) && item.type === 'diff') found.push(item.path);
    const locations = update.locations;
    for (const loc of Array.isArray(locations) ? locations : []) found.push(isDict(loc) ? loc.path : null);
    const raw = update.rawInput;
    if (isDict(raw)) { for (const key of PATH_KEYS) found.push(raw[key]); }
    const recorded: string[] = [];
    for (let path of found) {
      if (typeof path !== 'string' || !pyStrip(path) || pyLen(path) > 2000 || path.includes('\0')) continue;
      if (!osIsAbs(path) && this.cwd) path = osJoin(this.cwd, path);
      const normal = osNormpath(path as string);
      this.paths.delete(normal);
      this.paths.set(normal, now === null ? Date.now() / 1000 : now);
      recorded.push(normal);
    }
    while (this.paths.size > MAX_TRACKED_WRITES) this.paths.delete(this.paths.keys().next().value!);
    return recorded;
  }

  written(): string[] {
    return [...this.paths.keys()];
  }
}

// ---- watcher ---------------------------------------------------------------------------------------

export interface WatchedConversation {
  id?: string;
  cwd?: string;
  projectRoot?: string | null;
  writes?: string[];
}

interface Seen {
  stat: string;
  since: number;
  pending: boolean;
}

/**
 * Turns files a chat's own agent wrote into that chat's artifacts, and keeps existing artifacts' versions current.
 *
 * A file becomes an artifact of conversation C only when C's agent wrote it (conversations() gives each open chat as
 * {id, cwd, writes: [paths its agent wrote]}) and it lies in <cwd>/outputs/. Nothing else attaches a file to a chat. Artifacts that
 * already have a sourcePath get a new version when that file changes, about once a second. It polls (Python's watcher thread does
 * the same, every `interval` seconds); a tick is synchronous, so it never interleaves with a route.
 */
export class Watcher {
  readonly seen = new Map<string, Seen>(); // conversation id + path key -> record
  #convs: WatchedConversation[] = [];
  #convsAt = -1e9;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  constructor(
    readonly service: Service,
    readonly conversations: () => WatchedConversation[],
    readonly options: { interval?: number; settle?: number; clock?: () => number; listEvery?: number } = {},
  ) {}

  get interval(): number {
    return this.options.interval ?? 1.0;
  }
  get settle(): number {
    return this.options.settle ?? SETTLE_SECONDS;
  }
  get listEvery(): number {
    return this.options.listEvery ?? 2.0;
  }
  clock(): number {
    return this.options.clock ? this.options.clock() : performance.now() / 1000;
  }

  /** True while the poll loop runs (Python: thread.is_alive()). */
  get alive(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const loop = () => {
      const timer = setTimeout(() => {
        if (!this.#running) return;
        try {
          this.tick();
        } catch (error) {
          log.exception(error, 'Artifact watcher tick failed; will retry');
        }
        if (this.#running) loop();
      }, this.interval * 1000);
      this.#timer = timer;
      Deno.unrefTimer(timer as unknown as number);
    };
    loop();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  static stat(path: string): string | null {
    const st = statOrNull(path);
    return st === null ? null : `${st.mtime?.getTime() ?? 0}:${st.size}`;
  }

  tick(now: number | null = null): void {
    const t = now ?? this.clock();
    if (t - this.#convsAt >= this.listEvery) {
      try {
        this.#convs = this.conversations().filter((c) => pyTruthy(c.id) && pyTruthy(c.cwd));
      } catch (error) {
        log.exception(error, 'Artifact watcher could not list conversations; keeping the previous list');
      }
      this.#convsAt = t;
    }
    const store = this.service.store;
    const candidates = new Map<string, [string, string | null, string | null, string]>(); // key -> (path, cwd, projectRoot, cid)
    for (const conv of this.#convs) {
      const cid = conv.id!, cwd = conv.cwd!;
      const root = conv.projectRoot || cwd;
      const outputs = pathOf(cwd, 'outputs');
      for (const path of conv.writes || []) {
        if (previewable(path) && !osBasename(path).startsWith('.') && inside(path, outputs)) {
          candidates.set(cid + '\0' + pathKey(path), [path, cwd, root, cid]);
        }
      }
    }
    const known = new Map<string, Manifest>();
    for (const manifest of store.all()) { // a deleted artifact is nobody's: no missing-flag event, and a rewrite makes a new one
      if (!isDeleted(manifest) && pyTruthy(manifest.sourcePath) && pyTruthy(manifest.conversationId)) {
        known.set(manifest.conversationId + '\0' + pathKey(manifest.sourcePath), manifest);
      }
    }
    for (const [key, manifest] of known) {
      if (!candidates.has(key)) {
        const project = (manifest.project ?? null) as string | null;
        candidates.set(key, [manifest.sourcePath as string, project, project, manifest.conversationId as string]);
      }
    }
    for (const [key, [path, cwd, root, cid]] of candidates) {
      const manifest = known.get(key);
      const stat = Watcher.stat(path);
      if (stat === null) {
        if (manifest) {
          const [updated, changed] = store.setSourceMissing(manifest.id, true);
          if (changed) this.service.event(updated);
        }
        this.seen.delete(key);
        continue;
      }
      let record = this.seen.get(key);
      if (record === undefined) {
        record = { stat, since: t, pending: true };
        this.seen.set(key, record);
      } else if (record.stat !== stat) {
        Object.assign(record, { stat, since: t, pending: true });
      }
      if (record.pending && t - record.since >= this.settle) {
        record.pending = false;
        try {
          const real = pathOf(realpath(path));
          let updated: Manifest, changed: boolean;
          if (manifest) {
            [updated, changed] = store.addVersion(manifest.id, readCapped(real), {
              entry: safeEntryName(pureName(real)),
              by: 'watch',
              sourcePath: String(real),
            });
          } else {
            [updated, changed] = this.service.syncFile(cid, real, 'watch', { cwd, projectRoot: root });
          }
          if (changed) this.service.event(updated);
        } catch (error) {
          if (!(error instanceof ArtifactError) && !isOSError(error)) throw error;
        }
      }
    }
  }
}
