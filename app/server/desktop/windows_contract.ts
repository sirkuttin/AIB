/**
 * Multi-window contracts K0, K3 and K4 (design: aib-shared/designs/multi-window/aib-multi-window-design.html section 4), frozen before
 * Phase 1. Types, the URL builder and the request validators only: no window is made here.
 *
 *   K0  window ids ('m', 'w2'…'w8') and kinds; the server builds every window URL from fields (windowPath/windowUrl), the page
 *       never sends one.
 *   K3  POST /api/live/desktop/windows bodies (parseWindowsRequest): only the listed shapes, every other field refused.
 *   K4  ctx.desktopWindows: what the server asks of the desktop app (DesktopWindows). null in serve mode. Phase 1 tests use
 *       work/deno/_fake_desktop_windows.ts; Phase 2A provides the real one (server/desktop/windows.ts).
 */
import { ValueError } from '../core/py.ts';

/** At most this many windows in all (the keeper not counted): 'm' plus 'w2'…'w8'. */
export const WINDOW_CAP = 8;
/** K3: the route takes at most this many calls per RATE_MS. */
export const RATE_MAX = 10;
export const RATE_MS = 10_000;
/** K3: a body larger than this is refused (400) before it is parsed. */
export const MAX_WINDOWS_BODY = 2048;
/** Names and titles put into a window title: at most this many characters, control characters stripped. */
export const MAX_TITLE = 80;
const MAX_KEY = 400;
const MAX_DOC_NAME = 200;
const MAX_PATH = 1000;

export type WindowKind = 'main' | 'project' | 'chat' | 'doc';
export const WINDOW_KINDS: readonly WindowKind[] = ['main', 'project', 'chat', 'doc'];
/** K0: an app window's id. */
export const WINDOW_ID = /^(m|w[2-8])$/;

export interface ProjectRef {
  key: string;
  name: string;
  /** Only for the folder-gone check at restore (G4); never used to build a URL. */
  path: string;
}
export interface ChatRef {
  key: string;
  project: string;
  title: string;
}
export interface DocRef {
  project: string;
  name: string;
}
export interface RouteTarget {
  chat?: string;
  project: string;
  doc?: DocRef;
}
export type OpenRequest = { project: ProjectRef } | { chat: ChatRef } | { doc: DocRef };

/** One window as the desktop app knows it (K4 list()). */
export interface WindowInfo {
  w: string;
  kind: WindowKind;
  project: string | null;
  chat: string | null;
  doc: DocRef | null;
  visible: boolean;
  /** A chat or doc pop-out: the window it was moved out of (kept across restarts); null otherwise or unknown. */
  from?: string | null;
}

/** K4: the desktop app's windows, as the server asks for them. null in serve mode (no desktop). */
export interface DesktopWindows {
  /** Make the window, or focus the one that shows it already (existed: true). Throws WindowCapError at WINDOW_CAP. */
  open(req: OpenRequest, from: string): Promise<{ w: string; existed: boolean }>;
  /** The chooser (B6 order): the window that should show the target; it opened it there unless the answer is 'self'. */
  route(target: RouteTarget, from: string): Promise<{ to: 'self' } | { to: string }>;
  focus(w: string): boolean;
  close(w: string): boolean;
  list(): WindowInfo[];
  /** Another app window is open besides w (N1: the page then seeds only missing view-pref values). */
  othersAlive(w: string): boolean;
}

/** K4 open() at the cap: the route answers 409 {cap}. */
export class WindowCapError extends Error {
  override name = 'WindowCapError';
  readonly cap = WINDOW_CAP;
}

// ---- K0: URLs -----------------------------------------------------------------------------------------------------------------

export type WindowSpec =
  | { w: string; kind: 'main' }
  | { w: string; kind: 'project'; project: string }
  | { w: string; kind: 'chat'; chat: string; project: string }
  | { w: string; kind: 'doc'; project: string; name: string };

/** K0: a window's path and query (no key), built with URLSearchParams from validated fields. */
export function windowPath(spec: WindowSpec): string {
  if (!WINDOW_ID.test(spec.w)) throw new ValueError('Invalid window');
  const q = new URLSearchParams({ w: spec.w });
  if (spec.kind === 'main') return '/?' + q;
  q.set('kind', spec.kind);
  if (spec.kind === 'project') {
    q.set('project', key(spec.project));
    return '/?' + q;
  }
  if (spec.kind === 'chat') {
    q.set('mode', 'chat');
    q.set('chat', key(spec.chat));
    q.set('project', key(spec.project));
    return '/?' + q;
  }
  if (spec.kind === 'doc') {
    q.set('project', key(spec.project));
    q.set('name', docName(spec.name));
    return '/doc.html?' + q;
  }
  throw new ValueError('Invalid window');
}

/**
 * K0: the full URL the app process navigates that window to: origin + path. Never a launch key: a URL lands in the browser's history
 * and session-restore files, so the page gets its one-time key through the window's private channel (window.ts pageKeyScript).
 */
export function windowUrl(origin: string, spec: WindowSpec): string {
  return origin.replace(/\/+$/, '') + windowPath(spec);
}

/** A name or title for a window title: control characters become spaces, whitespace collapsed, at most MAX_TITLE characters. */
export function cleanTitle(value: unknown): string {
  // deno-lint-ignore no-control-regex -- control characters (and DEL, C1) never reach a window title
  return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

// ---- validators ---------------------------------------------------------------------------------------------------------------

// deno-lint-ignore no-control-regex -- refused in keys, doc names and paths
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A project, chat or page key: 1–400 characters, no control characters. */
export function isKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_KEY && !CONTROL.test(value);
}

function key(value: unknown, what = 'key'): string {
  if (!isKey(value)) throw new ValueError(`Invalid ${what}`);
  return value;
}

function docName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_DOC_NAME || CONTROL.test(value)) {
    throw new ValueError('Invalid doc name');
  }
  return value;
}

/** A display name (project name, chat title): a string of at most MAX_KEY characters; cleaned for the title. */
function display(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > MAX_KEY) throw new ValueError(`Invalid ${what}`);
  return cleanTitle(value);
}

function object(value: unknown, what: string, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValueError(`Invalid ${what}`);
  const o = value as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!keys.includes(k) && !optional.includes(k)) throw new ValueError(`Unknown field ${what}.${k.slice(0, 40)}`);
  }
  for (const k of keys) if (!(k in o)) throw new ValueError(`Missing ${what}.${k}`);
  return o;
}

function windowId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !WINDOW_ID.test(value)) throw new ValueError(`Invalid ${what}`);
  return value;
}

export function parseProject(value: unknown): ProjectRef {
  const o = object(value, 'project', ['key', 'name', 'path']);
  if (typeof o.path !== 'string' || !o.path || o.path.length > MAX_PATH || CONTROL.test(o.path)) {
    throw new ValueError('Invalid project.path');
  }
  return { key: key(o.key, 'project.key'), name: display(o.name, 'project.name'), path: o.path };
}

export function parseChat(value: unknown): ChatRef {
  const o = object(value, 'chat', ['key', 'project', 'title']);
  return { key: key(o.key, 'chat.key'), project: key(o.project, 'chat.project'), title: display(o.title, 'chat.title') };
}

export function parseDoc(value: unknown): DocRef {
  const o = object(value, 'doc', ['project', 'name']);
  return { project: key(o.project, 'doc.project'), name: docName(o.name) };
}

export function parseTarget(value: unknown): RouteTarget {
  const o = object(value, 'target', ['project'], ['chat', 'doc']);
  const out: RouteTarget = { project: key(o.project, 'target.project') };
  if (o.chat !== undefined) out.chat = key(o.chat, 'target.chat');
  if (o.doc !== undefined) out.doc = parseDoc(o.doc);
  if (out.chat && out.doc) throw new ValueError('A target is a chat or a doc');
  return out;
}

export type WindowsRequest =
  | { op: 'open'; from: string; req: { project: ProjectRef } }
  | { op: 'popout'; from: string; req: { chat: ChatRef } | { doc: DocRef } }
  | { op: 'route'; from: string; target: RouteTarget }
  | { op: 'focus'; w: string }
  | { op: 'close'; from: string; w: string };

/** K3: the only bodies the route accepts. Anything else (an unknown op, a missing or extra field, a bad value) is a ValueError. */
export function parseWindowsRequest(body: unknown): WindowsRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValueError('Invalid request');
  const op = (body as Record<string, unknown>).op;
  if (op === 'open') {
    const o = object(body, 'request', ['op', 'from', 'project']);
    return { op, from: windowId(o.from, 'from'), req: { project: parseProject(o.project) } };
  }
  if (op === 'popout') {
    const b = body as Record<string, unknown>;
    if ('chat' in b) {
      const o = object(body, 'request', ['op', 'from', 'chat']);
      return { op, from: windowId(o.from, 'from'), req: { chat: parseChat(o.chat) } };
    }
    const o = object(body, 'request', ['op', 'from', 'doc']);
    return { op, from: windowId(o.from, 'from'), req: { doc: parseDoc(o.doc) } };
  }
  if (op === 'route') {
    const o = object(body, 'request', ['op', 'from', 'target']);
    return { op, from: windowId(o.from, 'from'), target: parseTarget(o.target) };
  }
  if (op === 'focus') {
    const o = object(body, 'request', ['op', 'w']);
    return { op, w: windowId(o.w, 'w') };
  }
  if (op === 'close') {
    const o = object(body, 'request', ['op', 'from', 'w']);
    return { op, from: windowId(o.from, 'from'), w: windowId(o.w, 'w') };
  }
  throw new ValueError('Invalid op');
}

/** The window an open/popout request would make or focus: one per project (D1a), one per popped-out chat or doc. */
export function showsAlready(info: WindowInfo, req: OpenRequest): boolean {
  if ('project' in req) return info.kind === 'project' && info.project === req.project.key;
  if ('chat' in req) return info.kind === 'chat' && info.chat === req.chat.key;
  return info.kind === 'doc' && !!info.doc && info.doc.project === req.doc.project && info.doc.name === req.doc.name;
}

/** A sliding-window rate limit: take() is false once max calls were taken in the last ms. */
export class RateLimit {
  #times: number[] = [];
  constructor(readonly max = RATE_MAX, readonly ms = RATE_MS, readonly clock: () => number = Date.now) {}
  take(): boolean {
    const now = this.clock();
    this.#times = this.#times.filter((t) => now - t < this.ms);
    if (this.#times.length >= this.max) return false;
    this.#times.push(now);
    return true;
  }
}
