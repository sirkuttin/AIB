/**
 * The desktop app's window list (multi-window Phase 2A; design private/designs/multi-window/aib-multi-window-design.html sections
 * 4, 5 and 7). The runtime gives no getAllWindows/fromId/isFocused (spike S1), so AIB keeps its own list: one entry per app window,
 * with its K0 id ('m', 'w2'…'w8'), kind, what it shows, its own keyed URL, its own rate limits, save timer and last good geometry.
 *
 *   - Pure rules, tested with fakes (work/deno/desktop_window_test.ts): K1 saved list (cleanSavedList, load with the one-time
 *     migration from desktop-window.json, atomic write), restorePlan (G1 monitor gone, G2 cascade, G4 folder gone, S8 Wayland),
 *     the chooser order (B6), K6 answers, titles (B13: the native title does not follow document.title, so the app sets it).
 *   - WindowList: the entries, the free-id rule, last focused (from focus events, S1), and the one writer of desktop-windows.json
 *     (B10/B11: per-window debounce in DesktopApp, one serialized atomic write here; nothing is written once frozen, G8).
 *   - AppWindows: the real K4 (ctx.desktopWindows) over DesktopApp (window.ts), which owns the Shell side.
 */
import { getLogger } from '../core/log.ts';
import {
  type ChatRef,
  cleanTitle,
  type DesktopWindows,
  type DocRef,
  type OpenRequest,
  parseChat,
  parseDoc,
  parseProject,
  type ProjectRef,
  type RouteTarget,
  showsAlready,
  WINDOW_CAP,
  WINDOW_ID,
  WindowCapError,
  type WindowInfo,
  type WindowKind,
  type WindowSpec,
} from './windows_contract.ts';
import type { WindowHandle } from './window.ts';

const log = getLogger('desktop');
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

export const WINDOWS_FILE = 'desktop-windows.json';
/** The single-window file before Phase 2A, read once as window 'm' when WINDOWS_FILE is missing. */
export const OLD_GEOMETRY_FILE = 'desktop-window.json';
export const DEFAULT_MAIN_SIZE = { width: 1280, height: 860 };
export const DEFAULT_PROJECT_SIZE = { width: 1280, height: 860 };
export const DEFAULT_CHAT_SIZE = { width: 480, height: 720 };
export const DEFAULT_DOC_SIZE = { width: 720, height: 900 };
/** G2: each later window without a position is placed this far down and right of the one before. */
export const CASCADE_PX = 30;

// ---- K1: the saved list ----------------------------------------------------------------------------------------------------

export interface SavedGeometry {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

export interface SavedWindow extends SavedGeometry {
  id: string;
  kind: WindowKind;
  project?: ProjectRef;
  chat?: ChatRef;
  doc?: DocRef;
  /** A chat or doc pop-out: the window it was moved out of (Phase 3). Saved so that, after a restart, that window still knows the
   * pop-out is its own and takes the tab back when the pop-out closes (its own record of the move is per-window memory). */
  from?: string;
}

export interface SavedList {
  v: 1;
  lastFocused: string | null;
  windows: SavedWindow[];
}

const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined;

const MIN_W = 320, MIN_H = 240;

/** A saved size and position made safe: a bad size falls back to `fallback`, a bad or minimised (-32000) position is dropped. */
export function cleanSavedGeometry(raw: unknown, fallback: { width: number; height: number }): SavedGeometry {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const width = int(o.width, MIN_W, 16000), height = int(o.height, MIN_H, 16000);
  const g: SavedGeometry = width === undefined || height === undefined ? { ...fallback } : { width, height };
  const x = int(o.x, -16000, 16000), y = int(o.y, -16000, 16000);
  if (x !== undefined && y !== undefined) {
    g.x = x;
    g.y = y;
  }
  if (o.maximized === true) g.maximized = true;
  return g;
}

export function defaultSize(kind: WindowKind): { width: number; height: number } {
  return kind === 'chat'
    ? DEFAULT_CHAT_SIZE
    : kind === 'doc'
    ? DEFAULT_DOC_SIZE
    : kind === 'project'
    ? DEFAULT_PROJECT_SIZE
    : DEFAULT_MAIN_SIZE;
}

/** One saved entry, or null when it is not a valid window (bad id or kind, a missing or bad project/chat/doc). */
export function cleanSavedWindow(raw: unknown): SavedWindow | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !WINDOW_ID.test(o.id)) return null;
  const kind = o.kind;
  if (kind !== 'main' && kind !== 'project' && kind !== 'chat' && kind !== 'doc') return null;
  if ((kind === 'main') !== (o.id === 'm')) return null; // only the main window has the id 'm' (K0)
  const g = cleanSavedGeometry(o, defaultSize(kind));
  const out: SavedWindow = { id: o.id, kind, ...g };
  try {
    if (kind === 'project') out.project = parseProject(o.project);
    if (kind === 'chat') out.chat = parseChat(o.chat);
    if (kind === 'doc') out.doc = parseDoc(o.doc);
  } catch {
    return null;
  }
  if ((kind === 'chat' || kind === 'doc') && typeof o.from === 'string' && WINDOW_ID.test(o.from) && o.from !== o.id) out.from = o.from;
  return out;
}

/** K1 read: unknown fields and bad entries dropped, ids unique, at most WINDOW_CAP windows, in the saved (restore) order. */
export function cleanSavedList(raw: unknown): SavedList {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const seen = new Set<string>();
  const windows: SavedWindow[] = [];
  for (const item of Array.isArray(o.windows) ? o.windows : []) {
    const w = cleanSavedWindow(item);
    if (!w || seen.has(w.id) || windows.length >= WINDOW_CAP) continue;
    seen.add(w.id);
    windows.push(w);
  }
  const lastFocused = typeof o.lastFocused === 'string' && seen.has(o.lastFocused) ? o.lastFocused : null;
  return { v: 1, lastFocused, windows };
}

/**
 * The saved list (K1), or null when there is none yet. The old single-window desktop-window.json is read once as window 'm' when
 * the new file is missing (it is left where it is: an older version started again still finds its own file).
 */
export async function loadSavedList(stateDir: string): Promise<SavedList | null> {
  try {
    return cleanSavedList(JSON.parse(await Deno.readTextFile(`${stateDir}${SEP}${WINDOWS_FILE}`)));
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) log.info('windows: %s unreadable (%s); starting from the old file', WINDOWS_FILE, error);
  }
  try {
    const old = JSON.parse(await Deno.readTextFile(`${stateDir}${SEP}${OLD_GEOMETRY_FILE}`));
    const g = cleanSavedGeometry(old, DEFAULT_MAIN_SIZE);
    return { v: 1, lastFocused: 'm', windows: [{ id: 'm', kind: 'main', ...g }] };
  } catch {
    return null;
  }
}

/** K1 write (B11): to a temp file next to it, then renamed over it, so a crash mid-write never leaves half a list. */
export async function writeSavedList(stateDir: string, list: SavedList): Promise<void> {
  const path = `${stateDir}${SEP}${WINDOWS_FILE}`;
  const tmp = `${path}.${Deno.pid}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(list, null, 1));
  try {
    await Deno.rename(tmp, path);
  } catch (error) {
    await Deno.remove(tmp).catch(() => {});
    throw error;
  }
}

// ---- restore (section 7) ---------------------------------------------------------------------------------------------------

export interface RestoreEnv {
  /** G4: the project folder is gone (FolderPresence.isGone: network and WSL paths count as present, and nothing is waited for). */
  folderGone?: (path: string) => boolean;
  /** G1: is the rectangle on a screen now? null/undefined: can't tell (other systems: the position is kept). */
  onScreen?: (rect: { x: number; y: number; width: number; height: number }) => boolean | null;
  /** S8: false where the app can't place its windows (Wayland): sizes only. */
  positions?: boolean;
}

export interface RestoreItem extends SavedWindow {
  /** G2: no position; placed CASCADE_PX × cascade down and right of the first window once that one has loaded. 0: left alone. */
  cascade: number;
}

/**
 * The windows to make at start or at "Open AIB" with none open (D3a), in order: the main window first (B4), then the others in
 * their saved order. Project windows whose folder is gone are left out (G4, and dropped at the next save). A position off every
 * screen is dropped (G1); on Wayland every position is (S8). Windows still without a position after the first are cascaded (G2).
 * An empty or missing list gives one main window.
 */
export function restorePlan(saved: SavedList | null, env: RestoreEnv = {}): RestoreItem[] {
  const kept = (saved?.windows ?? []).filter((w) => {
    if (w.kind !== 'project' || !w.project) return true;
    try {
      return !env.folderGone?.(w.project.path);
    } catch {
      return true; // can't tell: keep it
    }
  });
  const main = kept.filter((w) => w.kind === 'main');
  const ordered = [...main, ...kept.filter((w) => w.kind !== 'main')];
  if (!ordered.length) ordered.push({ id: 'm', kind: 'main', ...DEFAULT_MAIN_SIZE });
  let unplaced = 0;
  return ordered.map((w, i) => {
    const item: RestoreItem = { ...w, cascade: 0 };
    if (env.positions === false) {
      delete item.x;
      delete item.y;
    } else if (item.x !== undefined && item.y !== undefined) {
      let on: boolean | null | undefined = null;
      try {
        on = env.onScreen?.({ x: item.x, y: item.y, width: item.width, height: item.height });
      } catch { /* can't tell */ }
      if (on === false) {
        delete item.x;
        delete item.y;
      }
    }
    if (item.x === undefined && i > 0 && env.positions !== false) item.cascade = ++unplaced;
    return item;
  });
}

/**
 * S8: Wayland lets no app place its windows (setPosition is ignored), so there only sizes are restored. X11 (GDK_BACKEND=x11, or
 * no Wayland socket), Windows and macOS place them.
 */
export function canPlaceWindows(os: string = Deno.build.os, env: (k: string) => string | undefined = (k) => Deno.env.get(k)): boolean {
  if (os !== 'linux') return true;
  const backend = (env('GDK_BACKEND') ?? '').split(',')[0].trim();
  if (backend === 'x11') return true;
  if (backend === 'wayland') return false;
  return !env('WAYLAND_DISPLAY') && env('XDG_SESSION_TYPE') !== 'wayland';
}

// ---- titles (B13) ----------------------------------------------------------------------------------------------------------

/** The native title of a window: the runtime's title does not follow document.title (Phase 2A probe), so the app sets one. */
export function windowTitle(w: { kind: WindowKind; project?: { name: string }; chat?: { title: string }; doc?: { name: string } }): string {
  if (w.kind === 'project') return w.project?.name ? `AIB · ${cleanTitle(w.project.name)}` : 'AIB';
  if (w.kind === 'chat') return `${cleanTitle(w.chat?.title) || 'Chat'} · AIB`;
  if (w.kind === 'doc') return `${cleanTitle(w.doc?.name) || 'Doc'} · AIB`;
  return 'AIB';
}

export function specOf(w: { id: string; kind: WindowKind; project?: ProjectRef; chat?: ChatRef; doc?: DocRef }): WindowSpec {
  if (w.kind === 'project' && w.project) return { w: w.id, kind: 'project', project: w.project.key };
  if (w.kind === 'chat' && w.chat) return { w: w.id, kind: 'chat', chat: w.chat.key, project: w.chat.project };
  if (w.kind === 'doc' && w.doc) return { w: w.id, kind: 'doc', project: w.doc.project, name: w.doc.name };
  return { w: w.id, kind: 'main' };
}

/** The launch key in the app's page URL (`…/#aib-key=K`), '' when it has none. */
export function launchKeyOf(url: string): string {
  try {
    const m = /(?:^|&)aib-key=([^&]*)/.exec(new URL(url).hash.replace(/^#/, ''));
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

/** S6: the `w` the page's own URL carries ('' when none). */
export function pageWindowId(href: string): string {
  try {
    return new URL(href).searchParams.get('w') ?? '';
  } catch {
    return '';
  }
}

// ---- the chooser (B6) and K6 -----------------------------------------------------------------------------------------------

export interface ChooserWindow {
  w: string;
  kind: WindowKind;
  project: string | null;
  chat: string | null;
  doc: DocRef | null;
  focusedAt: number;
}

export interface ChooseTarget {
  chat?: string;
  project?: string;
  doc?: DocRef;
}

/**
 * The windows to try for a target, best first (B6, E4): the pop-out showing that chat (or doc), then the window pinned to its
 * project, then (the project unknown: a notification carries only the chat key) every project window, which answer 'no' (K6)
 * when it isn't theirs, then the main window, then the rest by last focus. `needsMain`: there is no main window to end on.
 */
export function chooseOrder(target: ChooseTarget, wins: ChooserWindow[]): { order: string[]; needsMain: boolean } {
  const out: string[] = [];
  const add = (w: ChooserWindow | undefined) => void (w && !out.includes(w.w) && out.push(w.w));
  const byFocus = [...wins].sort((a, b) => b.focusedAt - a.focusedAt);
  if (target.chat) add(wins.find((w) => w.kind === 'chat' && w.chat === target.chat));
  if (target.doc) add(wins.find((w) => w.kind === 'doc' && w.doc?.project === target.doc!.project && w.doc?.name === target.doc!.name));
  if (target.project) add(wins.find((w) => w.kind === 'project' && w.project === target.project));
  else if (target.chat) { for (const w of byFocus) if (w.kind === 'project') add(w); }
  const main = wins.find((w) => w.kind === 'main');
  add(main);
  if (!target.project && !target.chat && !target.doc) { for (const w of byFocus) add(w); // the inbox: any window, last used first
   } else for (const w of byFocus) if (w.kind !== 'chat' && w.kind !== 'doc') add(w); // never a pop-out showing something else
  return { order: out, needsMain: !main };
}

/** K6: a page's answer to openFromDesktop. 'mine' (true from an old page too), 'no', or null while it can't answer yet. */
export function openAnswer(value: unknown): 'mine' | 'no' | null {
  if (value === 'mine' || value === true) return 'mine';
  if (value === 'no') return 'no';
  return null;
}

// ---- the list ----------------------------------------------------------------------------------------------------------------

export interface AppWindow {
  id: string;
  kind: WindowKind;
  project?: ProjectRef;
  chat?: ChatRef;
  doc?: DocRef;
  /** A pop-out: the window it was moved out of (SavedWindow.from). */
  from?: string;
  handle: WindowHandle;
  /** K0: its own keyed URL (the key only in the fragment). */
  url: string;
  title: string;
  /** The last good normal geometry (read with getSize/getPosition after the first load, S7). */
  geometry: SavedGeometry;
  maximized: boolean;
  /** The first load was seen: geometry may be read from now on (S7). */
  loaded: boolean;
  /** G2: placed this many CASCADE_PX down and right of the first window after its first load (0: no). */
  cascade: number;
  focusedAt: number;
  /** Sending it back to its page: at most 4 times in 30 s; its key/URL re-send: at most 3 times in 60 s (per window, B2). */
  backAllowed: () => boolean;
  keyAllowed: () => boolean;
  saveTimer?: ReturnType<typeof setTimeout>;
}

export class WindowList {
  /** In creation order (the saved order). */
  readonly entries: AppWindow[] = [];
  /** G8: set while quitting; nothing is written from then on. */
  frozen = false;
  /** The last write (tests wait for it). */
  writing: Promise<void> = Promise.resolve();
  #clock: () => number;
  #focusSeq = 0;
  #lastFocused: string | null = null;

  constructor(readonly stateDir: string, clock: () => number = Date.now) {
    this.#clock = clock;
  }

  /** The windows open now (not closed). */
  open(): AppWindow[] {
    return this.entries.filter((e) => !e.handle.isClosed());
  }

  /** The open windows a person can see (not hidden by Quit AIB / the tray rule). */
  visible(): AppWindow[] {
    return this.open().filter((e) => e.handle.isVisible?.() !== false);
  }

  get(id: string): AppWindow | undefined {
    return this.entries.find((e) => e.id === id);
  }

  main(): AppWindow | undefined {
    return this.entries.find((e) => e.kind === 'main');
  }

  /** The lowest free id for a new non-main window (K0), or null at the cap. */
  freeId(): string | null {
    for (let n = 2; n <= WINDOW_CAP; n++) if (!this.entries.some((e) => e.id === `w${n}`)) return `w${n}`;
    return null;
  }

  add(e: AppWindow): void {
    const at = this.entries.findIndex((x) => x.id === e.id);
    if (at >= 0) this.entries.splice(at, 1, e);
    else if (e.kind === 'main') this.entries.unshift(e); // the main window restores first (B4)
    else this.entries.push(e);
  }

  /** Drops a window from the list (S4: called by close(w) itself; no close event fires for a programmatic close). */
  remove(id: string): AppWindow | undefined {
    const at = this.entries.findIndex((e) => e.id === id);
    if (at < 0) return undefined;
    const [e] = this.entries.splice(at, 1);
    clearTimeout(e.saveTimer);
    if (this.#lastFocused === id) this.#lastFocused = null;
    return e;
  }

  focused(id: string): void {
    const e = this.get(id);
    if (!e) return;
    e.focusedAt = this.#clock() * 1000 + (++this.#focusSeq % 1000); // strictly increasing within one ms
    this.#lastFocused = id;
  }

  /** The window used last that is still open (B12), else the first open one. */
  lastFocused(): AppWindow | undefined {
    const open = this.open();
    return open.slice().sort((a, b) => b.focusedAt - a.focusedAt).find((e) => e.focusedAt > 0) ?? open[0];
  }

  set lastFocusedId(id: string | null) {
    this.#lastFocused = id;
  }

  /** K4 list(): the open windows. */
  info(): WindowInfo[] {
    return this.open().map((e) => ({
      w: e.id,
      kind: e.kind,
      project: e.kind === 'project'
        ? e.project?.key ?? null
        : e.kind === 'chat'
        ? e.chat?.project ?? null
        : e.kind === 'doc'
        ? e.doc?.project ?? null
        : null,
      chat: e.kind === 'chat' ? e.chat?.key ?? null : null,
      doc: e.kind === 'doc' && e.doc ? { ...e.doc } : null,
      visible: e.handle.isVisible?.() !== false,
      from: (e.kind === 'chat' || e.kind === 'doc') && e.from ? e.from : null,
    }));
  }

  chooser(): ChooserWindow[] {
    return this.open().map((e) => ({
      w: e.id,
      kind: e.kind,
      project: e.kind === 'project' ? e.project?.key ?? null : null,
      chat: e.kind === 'chat' ? e.chat?.key ?? null : null,
      doc: e.kind === 'doc' ? e.doc ?? null : null,
      focusedAt: e.focusedAt,
    }));
  }

  /** K1: what is saved now (every entry, open or kept after the last window closed, G9). */
  snapshot(): SavedList {
    const lf = this.#lastFocused && this.get(this.#lastFocused) ? this.#lastFocused : null;
    return {
      v: 1,
      lastFocused: lf,
      windows: this.entries.map((e) => {
        const w: SavedWindow = { id: e.id, kind: e.kind, width: e.geometry.width, height: e.geometry.height };
        if (e.project) w.project = { ...e.project };
        if (e.chat) w.chat = { ...e.chat };
        if (e.doc) w.doc = { ...e.doc };
        if (e.from && (e.kind === 'chat' || e.kind === 'doc')) w.from = e.from;
        if (e.geometry.x !== undefined && e.geometry.y !== undefined) {
          w.x = e.geometry.x;
          w.y = e.geometry.y;
        }
        w.maximized = e.maximized;
        return w;
      }),
    };
  }

  /** The one writer (B10/B11): writes the whole list now, one write at a time. Never while frozen (G8). */
  save(why: string): Promise<void> {
    if (this.frozen) return this.writing;
    const list = this.snapshot();
    this.writing = this.writing.then(() => writeSavedList(this.stateDir, list)).then(
      () => log.debug('windows: saved %s window(s) (%s)', list.windows.length, why),
      (error) => log.info('windows: could not save the window list (%s): %s', why, error),
    );
    return this.writing;
  }
}

// ---- K4 ------------------------------------------------------------------------------------------------------------------------

/** What AppWindows needs from DesktopApp (window.ts). */
export interface WindowsHost {
  readonly windows: WindowList;
  /** Makes a window (id reserved by the caller), navigates it to its URL. */
  makeWindow(w: SavedWindow & { cascade?: number }, from?: string): AppWindow;
  /** Shows it, focuses it and brings it to the front with its own handle (B1). */
  focusWindow(e: AppWindow, why: string): void;
  /** S4: drops it from the list, then closes it (no close event comes). */
  closeWindow(e: AppWindow): void;
  /** Delivers an open to the windows in order (K6: the next on 'no'); resolves the window that took it, or null. */
  deliver(order: string[], target: ChooseTarget): Promise<string | null>;
}

/** The real K4 (ctx.desktopWindows). */
export class AppWindows implements DesktopWindows {
  constructor(readonly host: WindowsHost) {}

  open(req: OpenRequest, from: string): Promise<{ w: string; existed: boolean }> {
    const list = this.host.windows;
    const there = list.open().find((e) => showsAlready(list.info().find((i) => i.w === e.id)!, req));
    if (there) {
      this.host.focusWindow(there, 'open: already open');
      return Promise.resolve({ w: there.id, existed: true });
    }
    if (list.open().length >= WINDOW_CAP) throw new WindowCapError('At most 8 AIB windows');
    const id = list.freeId();
    if (!id) throw new WindowCapError('At most 8 AIB windows');
    const saved: SavedWindow = 'project' in req
      ? { id, kind: 'project', project: req.project, ...DEFAULT_PROJECT_SIZE }
      : 'chat' in req
      ? { id, kind: 'chat', chat: req.chat, ...DEFAULT_CHAT_SIZE }
      : { id, kind: 'doc', doc: req.doc, ...DEFAULT_DOC_SIZE };
    if (saved.kind !== 'project' && WINDOW_ID.test(from) && from !== id) saved.from = from; // the window it moved out of
    const e = this.host.makeWindow(saved, from);
    this.host.focusWindow(e, 'opened');
    return Promise.resolve({ w: e.id, existed: false });
  }

  route(target: RouteTarget, from: string): Promise<{ to: 'self' } | { to: string }> {
    const list = this.host.windows;
    const { order } = chooseOrder(target, list.chooser());
    // The best window that may show it: the pop-out with it, the project's window, else the main window (made if needed).
    const firstPick = order.find((w) => {
      const e = list.get(w);
      return e && (e.kind === 'main' || (target.chat && e.kind === 'chat') || (target.doc && e.kind === 'doc') ||
        (e.kind === 'project' && e.project?.key === target.project));
    });
    let pick = firstPick;
    if (!pick) {
      const made = this.host.makeWindow({ id: 'm', kind: 'main', ...DEFAULT_MAIN_SIZE }, from);
      pick = made.id;
    }
    if (pick === from) return Promise.resolve({ to: 'self' });
    const e = list.get(pick)!;
    this.host.focusWindow(e, 'route');
    void this.host.deliver([pick], target);
    return Promise.resolve({ to: pick });
  }

  focus(w: string): boolean {
    const e = this.host.windows.open().find((x) => x.id === w);
    if (!e) return false;
    this.host.focusWindow(e, 'focus');
    return true;
  }

  close(w: string): boolean {
    const e = this.host.windows.open().find((x) => x.id === w);
    if (!e) return false;
    this.host.closeWindow(e);
    return true;
  }

  list(): WindowInfo[] {
    return this.host.windows.info();
  }

  othersAlive(w: string): boolean {
    return this.host.windows.open().some((e) => e.id !== w);
  }
}
