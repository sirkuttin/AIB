/**
 * The sync link's messages (sync between PCs, slice V2). Every frame is one JSON text frame:
 *   { t: 'hello', v: 1, token?, name, host }   the first frame each way (the dialing PC's carries its token, never a URL or header)
 *   { t: 'ping' } / { t: 'pong' }              keep-alive
 *   { t: 'batch', id, project?, items: [...] } a generic envelope later slices fill (project matching, file engine)
 * Paths in a frame are only ever relative to one of a linked project's two folders, `aib-shared/` or `aib-docs/`, named by `area`.
 * A frame never carries a root, an absolute path or a drive: the receiver resolves the root from its own record of the project.
 * Anything that does not validate is refused and the link is closed.
 */

export const PROTOCOL = 1;
/** The first frame comes before the peer is known: it may only be this big. */
export const MAX_HELLO_BYTES = 4096;
/** Every later frame (V2: no file data travels yet; later slices raise this with their own transfer frames). */
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_ITEMS = 5000;
export const MAX_PATH = 400;
export const MAX_SEGMENT = 120;

export type Area = 'shared' | 'docs';
export const AREAS: readonly Area[] = ['shared', 'docs'];

export interface BatchItem {
  op: string;
  /** File items name one of a project's two folders; the project matching items (`project.*`) have none. */
  area?: Area;
  path?: string;
  [key: string]: unknown;
}

export type Frame =
  | { t: 'hello'; v: number; token?: string; name: string; host: string }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'batch'; id: string; project?: string; items: BatchItem[] };

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const DOC_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._()-]{0,79}$/;
const HOST = /^[a-z0-9.-]{1,253}$/;
/** Keys that would name a place on the receiver's disk: never accepted in an item. */
const ROOT_KEYS = new Set(['root', 'abs', 'absolute', 'cwd', 'dir', 'base', 'folder', 'drive']);

/**
 * A path relative to a project's `aib-shared/` or `aib-docs/`. Refused: empty, absolute, a drive letter, backslashes, colons (also
 * NTFS streams), control characters, `.` or `..` segments, empty segments, over-long names, Windows reserved names (with or without an
 * extension), names ending in a dot or a space (Windows drops them, so `a.md.` would be `a.md`) and 8.3 short forms (`ABCDEF~1`).
 * `docs` paths are only `<doc name>/doc.aibdoc` or `<doc name>/assets/<file>`.
 */
export function checkPath(value: unknown, area: Area): Checked<string> {
  if (typeof value !== 'string' || !value) return bad('path must be text');
  if (value.length > MAX_PATH) return bad('path too long');
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 32 || code === 127) return bad('control character in path');
  }
  if (value.includes('\\')) return bad('backslash in path');
  if (value.includes(':')) return bad('colon in path');
  if (value.startsWith('/')) return bad('absolute path');
  const segments = value.split('/');
  for (const segment of segments) {
    if (!segment) return bad('empty segment in path');
    if (segment === '.' || segment === '..') return bad('dot segment in path');
    if (segment.length > MAX_SEGMENT) return bad('path segment too long');
    if (/[. ]$/.test(segment)) return bad('path segment ends in a dot or a space');
    if (WINDOWS_RESERVED.test(segment)) return bad('reserved name in path');
    if (/~\d/.test(segment)) return bad('short-name form in path');
    if (/[<>"|?*]/.test(segment)) return bad('character not allowed in path');
  }
  if (area === 'docs') {
    if (!DOC_NAME.test(segments[0])) return bad('not a doc folder name');
    const ok = (segments.length === 2 && segments[1] === 'doc.aibdoc') || (segments.length >= 3 && segments[1] === 'assets');
    if (!ok) return bad('only doc.aibdoc and assets/ are synced in a doc folder');
  }
  return { ok: true, value };
}

const hasControl = (v: string) => [...v].some((c) => c < ' ' || c === '\u007f');
export const OID = /^[A-Za-z0-9_-]{8,64}$/;
export const REMOTE = /^[a-z0-9.-]{1,253}\/[^\s\\:]{1,300}$/;
/** A project's place in its repo, as an offer carries it: relative, forward slashes, no dot segments (never a folder path). */
export const placeOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 300 && !/[\\:]/.test(v) && !hasControl(v) && !v.startsWith('/') &&
  (v === '' || v.split('/').every((s) => s !== '' && s !== '.' && s !== '..'));
export const nameOk = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= 80 && !/[\\/]/.test(v) && !hasControl(v);

/**
 * Project matching items (slice V3). Only the listed keys survive; a project is named by an opaque offer id, never a folder.
 *   project.begin / project.end   the start and the end of one PC's list of offers
 *   project.offer                 {id, name, remote (normalized git remote or null), prefix (place in the repo), wsl}
 *   project.link                  {mine, theirs, how}: batch.project is the new project sync id; mine = the sender's offer id
 *   project.unlink                batch.project is the project sync id
 *   project.switch                {shared, docs}: the sender's two switches for batch.project (V4: files move only when both PCs have it on)
 */
function checkProjectItem(item: Record<string, unknown>): Checked<BatchItem> {
  const op = item.op as string;
  switch (op) {
    case 'project.begin':
    case 'project.end':
    case 'project.unlink':
      return { ok: true, value: { op } };
    case 'project.switch':
      if (typeof item.shared !== 'boolean' || typeof item.docs !== 'boolean') return bad('bad switch');
      return { ok: true, value: { op, shared: item.shared, docs: item.docs } };
    case 'project.offer': {
      if (typeof item.id !== 'string' || !OID.test(item.id)) return bad('bad offer id');
      if (!nameOk(item.name)) return bad('bad project name');
      if (item.remote !== null && (typeof item.remote !== 'string' || !REMOTE.test(item.remote))) return bad('bad remote');
      if (!placeOk(item.prefix)) return bad('bad place in repo');
      if (typeof item.wsl !== 'boolean') return bad('bad wsl flag');
      return { ok: true, value: { op, id: item.id, name: item.name, remote: item.remote, prefix: item.prefix, wsl: item.wsl } };
    }
    case 'project.link':
      if (typeof item.mine !== 'string' || !OID.test(item.mine) || typeof item.theirs !== 'string' || !OID.test(item.theirs)) {
        return bad('bad offer id');
      }
      if (item.how !== 'remote' && item.how !== 'manual') return bad('bad link kind');
      return { ok: true, value: { op, mine: item.mine, theirs: item.theirs, how: item.how } };
    default:
      return bad('bad op');
  }
}

const HASH = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** A chunk's base64 text must fit a frame with room to spare (512 KB of bytes is 699,052 characters). */
export const MAX_CHUNK_TEXT = 760_000;
const whole = (v: unknown, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max;

/**
 * File items (slice V4, aib-shared), all under batch.project; `area` is 'shared' (docs come with V5). Only the listed keys survive.
 *   file.begin / file.end   the start and end of one PC's full list of its files (what is absent from a complete list is deleted)
 *   file.state              {path, hash (sha256 hex, null = deleted), size, mtime (ms), sup?}: one file as the sender has it now;
 *                           sup lists the hashes this version replaces (a merge) or 'del' (kept against a delete)
 *   file.get                {path, hash, offset}: asks for the next chunk of the version with that hash
 *   file.data               {path, hash, offset, size, last, data (base64)}: one chunk (at most 512 KB of bytes)
 *   file.gone               {path, hash}: that version is no longer here
 */
function checkFileItem(item: Record<string, unknown>): Checked<BatchItem> {
  const op = item.op as string;
  if (item.area !== 'shared') return bad('bad area');
  const area: Area = 'shared';
  if (op === 'file.begin' || op === 'file.end') return { ok: true, value: { op, area } };
  const path = checkPath(item.path, area);
  if (!path.ok) return path;
  const base = { op, area, path: path.value };
  switch (op) {
    case 'file.state': {
      if (item.hash !== null && (typeof item.hash !== 'string' || !HASH.test(item.hash))) return bad('bad hash');
      if (!whole(item.size, 2 ** 40) || !whole(item.mtime, 2 ** 53)) return bad('bad size or time');
      let sup: string[] = [];
      if (item.sup !== undefined) {
        if (!Array.isArray(item.sup) || item.sup.length > 4) return bad('bad sup');
        for (const h of item.sup) if (typeof h !== 'string' || !(HASH.test(h) || h === 'del')) return bad('bad sup');
        sup = item.sup as string[];
      }
      return { ok: true, value: { ...base, hash: item.hash, size: item.size, mtime: item.mtime, sup } };
    }
    case 'file.get':
      if (typeof item.hash !== 'string' || !HASH.test(item.hash) || !whole(item.offset, 2 ** 40)) return bad('bad request');
      return { ok: true, value: { ...base, hash: item.hash, offset: item.offset } };
    case 'file.data':
      if (typeof item.hash !== 'string' || !HASH.test(item.hash) || !whole(item.offset, 2 ** 40) || !whole(item.size, 2 ** 40)) {
        return bad('bad chunk');
      }
      if (typeof item.last !== 'boolean') return bad('bad chunk');
      if (typeof item.data !== 'string' || item.data.length > MAX_CHUNK_TEXT || !B64.test(item.data)) return bad('bad chunk data');
      return { ok: true, value: { ...base, hash: item.hash, offset: item.offset, size: item.size, last: item.last, data: item.data } };
    case 'file.gone':
      if (typeof item.hash !== 'string' || !HASH.test(item.hash)) return bad('bad hash');
      return { ok: true, value: { ...base, hash: item.hash } };
    default:
      return bad('bad op');
  }
}

function checkItem(raw: unknown): Checked<BatchItem> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('item must be an object');
  const item = raw as Record<string, unknown>;
  for (const key of Object.keys(item)) if (ROOT_KEYS.has(key.toLowerCase())) return bad(`item may not carry "${key}"`);
  if (typeof item.op !== 'string' || !/^[a-z][a-z0-9._-]{0,31}$/.test(item.op)) return bad('bad op');
  if (item.op.startsWith('project.')) return checkProjectItem(item);
  if (item.op.startsWith('file.')) return checkFileItem(item);
  if (!AREAS.includes(item.area as Area)) return bad('bad area');
  if (item.path !== undefined) {
    const path = checkPath(item.path, item.area as Area);
    if (!path.ok) return path;
  }
  return { ok: true, value: item as BatchItem };
}

/** Parse and validate one frame's text. `first`: this is the first frame of a link (it must be a hello, and a small one). */
export function parseFrame(text: unknown, first = false): Checked<Frame> {
  if (typeof text !== 'string') return bad('frames are text');
  const limit = first ? MAX_HELLO_BYTES : MAX_FRAME_BYTES;
  if (text.length > limit || new TextEncoder().encode(text).byteLength > limit) return bad('frame too big');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad('not JSON');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('frame must be an object');
  const f = raw as Record<string, unknown>;
  if (first && f.t !== 'hello') return bad('the first frame must be hello');
  switch (f.t) {
    case 'hello': {
      if (f.v !== PROTOCOL) return bad('unsupported protocol version');
      if (f.token !== undefined && (typeof f.token !== 'string' || !/^[A-Za-z0-9_-]{20,200}$/.test(f.token))) return bad('bad token');
      const host = typeof f.host === 'string' ? f.host.toLowerCase() : '';
      if (!HOST.test(host)) return bad('bad host');
      const name = typeof f.name === 'string' ? f.name.slice(0, 80) : '';
      return { ok: true, value: { t: 'hello', v: PROTOCOL, token: f.token as string | undefined, name, host } };
    }
    case 'ping':
    case 'pong':
      return { ok: true, value: { t: f.t } };
    case 'batch': {
      if (typeof f.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(f.id)) return bad('bad batch id');
      if (f.project !== undefined && (typeof f.project !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(f.project))) {
        return bad('bad project id');
      }
      if (!Array.isArray(f.items) || f.items.length > MAX_ITEMS) return bad('bad items');
      const items: BatchItem[] = [];
      for (const raw of f.items) {
        const item = checkItem(raw);
        if (!item.ok) return item;
        items.push(item.value);
      }
      return { ok: true, value: { t: 'batch', id: f.id, project: f.project as string | undefined, items } };
    }
    default:
      return bad('unknown frame');
  }
}
