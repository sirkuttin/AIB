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
  area: Area;
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

function checkItem(raw: unknown): Checked<BatchItem> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('item must be an object');
  const item = raw as Record<string, unknown>;
  for (const key of Object.keys(item)) if (ROOT_KEYS.has(key.toLowerCase())) return bad(`item may not carry "${key}"`);
  if (typeof item.op !== 'string' || !/^[a-z][a-z0-9._-]{0,31}$/.test(item.op)) return bad('bad op');
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
