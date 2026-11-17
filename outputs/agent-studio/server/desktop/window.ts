/**
 * The desktop app's window, tray and close path (`AIB` with no subcommand in a `deno desktop` build). Everything here talks to the
 * window system through the small Shell interface, so all of the logic is tested with fakes (work/deno/desktop_window_test.ts);
 * the real Shell is native.ts.
 *
 * Facts this relies on (Deno 2.9.8, Windows, spike 2026-11-10):
 *   - A window's `close` event is not cancelable: when the person closes it, the window is destroyed (isClosed() turns true) and
 *     the runtime exits once no window is left. So the Shell keeps one hidden "keeper" window alive, the close question is asked
 *     after the window is gone, and "keep running in the tray" means a new window is made when the person comes back.
 *   - window.open() and target=_blank links open in the system browser (window.open returns null); a plain click on a link to
 *     another origin navigates the app window itself. desktop-bridge.js turns such clicks into window.open; the load check below
 *     is the safety net for anything else (a form, location.assign).
 *   - `bindings.*` exist in every frame of the window, including cross-origin iframes (artifact pages), so the one bound function
 *     (`aibDesktop`) only tells the page it runs in the app. Notifications go through the web server (POST
 *     /api/live/desktop/notify, notify.ts), which needs the page's token.
 */

import { getLogger } from '../core/log.ts';
import { DesktopNotifications, type NotifyTarget, type OsNotify } from './notify.ts';
import {
  type AppWindow,
  AppWindows,
  CASCADE_PX,
  chooseOrder,
  type ChooseTarget,
  cleanSavedGeometry,
  DEFAULT_MAIN_SIZE,
  defaultSize,
  launchKeyOf,
  loadSavedList,
  openAnswer,
  pageWindowId,
  restorePlan,
  type SavedWindow,
  specOf,
  WindowList,
  type WindowsHost,
  windowTitle,
} from './windows.ts';
import { windowUrl } from './windows_contract.ts';

const log = getLogger('desktop');

export const WINDOW_TITLE = 'AIB';
/** How often the watchdog checks that the visible window still shows our page. */
export const WATCHDOG_MS = 10_000;
/** The keeper window's page: nothing at all. */
export const KEEPER_URL = 'about:blank';
export const GEOMETRY_FILE = 'desktop-window.json';
export const DEFAULT_SIZE = { width: 1280, height: 860 };
export const FIRST_PORT = 8777;
/**
 * The app's tray menu, with or without a window: Open AIB, a greyed status line ("2 chats running"), Quit AIB (never stops a chat:
 * with work going on AIB exits and the keeper holds the chats until an AIB is started again) and Stop all chats and quit (the only
 * deliberate stop; a second click confirms it, see stopConfirmLabel).
 */
export const TRAY_ITEMS: TrayItem[] = [
  { id: 'open', label: 'Open AIB' },
  { id: 'status', label: '', disabled: true },
  { id: 'quit', label: 'Quit AIB' },
  { id: 'stop', label: 'Stop all chats and quit' },
];
/**
 * The tray menu's chat slots (architect review break 19: a Windows tray menu is made once, so its chat list is a fixed set of
 * items): up to TRAY_SLOTS chats blocked on the person, under the fixed items, each opening its chat; more than that and the last
 * slot says "+N more" and opens the inbox. A slot with nothing to show is left out of the menu (not a blank line).
 */
export const TRAY_SLOTS = 5;
export const SLOT_ITEMS: TrayItem[] = Array.from({ length: TRAY_SLOTS }, (_, i) => ({ id: `chat-${i}`, label: '', hidden: true }));
/** The reason words of a tray slot (inbox-rules.js reasonWord). */
const SLOT_REASON: Record<string, string> = {
  approval: 'Approval',
  question: 'Question',
  signin: 'Sign-in',
  asks: 'Asks',
  failed: 'Failed',
};
export interface TraySlot {
  label: string;
  target: NotifyTarget;
}
/** The tray's chat slots for these blocked chats (`total`: how many are blocked, at least blocked.length). */
export function trayChatSlots(blocked: { key: string; title: string; reason?: string }[], total = blocked.length): TraySlot[] {
  const all = Math.max(total, blocked.length);
  const room = all > TRAY_SLOTS ? TRAY_SLOTS - 1 : TRAY_SLOTS;
  const cut = (t: string) => (t.length > 60 ? t.slice(0, 59).trimEnd() + '…' : t);
  const slots: TraySlot[] = blocked.slice(0, room).map((b) => ({
    label: `${cut(b.title || 'Conversation')} · ${SLOT_REASON[b.reason ?? ''] ?? 'Needs you'}`,
    target: { type: 'chat', key: b.key },
  }));
  if (all > slots.length) slots.push({ label: `+${all - slots.length} more`, target: { type: 'inbox' } });
  return slots;
}

/** The menu position of Stop all chats and quit (its label turns into the confirm line for STOP_CONFIRM_MS). */
export const STOP_INDEX = 3;
/** How long the confirm line stays armed after the first click on Stop all chats and quit. */
export const STOP_CONFIRM_MS = 10_000;

/** The confirm line that replaces "Stop all chats and quit" after its first click (no native box: the menu item itself asks). */
export function stopConfirmLabel(working: number): string {
  const what = working > 0 ? `${working} chat${working === 1 ? '' : 's'}` : 'everything';
  return `Click again to stop ${what} and quit`;
}

/** What the tray tooltip says while phone access is on (Settings > Remote control "Let paired phones reach AIB"). */
export const PHONE_ON_TOOLTIP = 'Phone access on';

/**
 * The tray-only status line and tooltip for `working` chats, `needsYou` of them waiting for the person. While phone access is on
 * the tooltip says so first ("AIB · Phone access on · 2 chats running"); the status line in the menu stays the counts.
 */
export function trayOnlyView(working: number, needsYou: number, phoneOn = false): { status: string; tooltip: string } {
  const plural = (n: number) => `${n} chat${n === 1 ? '' : 's'}`;
  const status = needsYou
    ? `${plural(needsYou)} need${needsYou === 1 ? 's' : ''} you${working > needsYou ? `, ${working - needsYou} running` : ''}`
    : working
    ? `${plural(working)} running`
    : 'No chat is working';
  return { status, tooltip: phoneOn ? `AIB · ${PHONE_ON_TOOLTIP} · ${status}` : `AIB · ${status}` };
}

// ---------- pure rules ----------

/** The Tauri app's rule: the first port P from `start` where P and P + 1 (the artifact origin) are both free. */
export function choosePortPair(isFree: (port: number) => boolean, start = FIRST_PORT, tries = 200): number {
  for (let port = start; port < start + tries && port + 1 <= 65535; port++) {
    if (isFree(port) && isFree(port + 1)) return port;
  }
  throw new Error(`No two free ports in a row between ${start} and ${start + tries}`);
}

export const LAST_PORT_FILE = 'desktop-port.json';

/** The port pair the app used last time (desktop-port.json), when both ports are free now; else null. */
export function lastPortPair(stateDir: string, isFree: (port: number) => boolean): number | null {
  try {
    const port = JSON.parse(Deno.readTextFileSync(`${stateDir}${SEP}${LAST_PORT_FILE}`)).port;
    if (Number.isInteger(port) && port > 0 && port < 65535 && isFree(port) && isFree(port + 1)) return port;
  } catch { /* none yet */ }
  return null;
}

export function saveLastPort(stateDir: string, port: number): void {
  try {
    Deno.writeTextFileSync(`${stateDir}${SEP}${LAST_PORT_FILE}`, JSON.stringify({ port }));
  } catch { /* not fatal */ }
}

/** True when nothing listens on 127.0.0.1:port right now. */
export function portFree(port: number): boolean {
  try {
    Deno.listen({ hostname: '127.0.0.1', port }).close();
    return true;
  } catch {
    return false;
  }
}

/** Whether the command line names a port (`--port N` or `--port=N`); the desktop app then uses it instead of choosing a pair. */
export function portGiven(args: string[]): boolean {
  return args.some((a) => a === '--port' || a.startsWith('--port='));
}

export type CloseDecision = 'quit' | 'tray';

/**
 * Closing the window or Quit AIB (the owner's decisions, 2026-11-10 and 2026-11-11: quitting never stops a chat, and AIB exits as
 * Install now does). Nothing working: quit. Something working, or a count that can't be read (null): the chats are left to the
 * keeper and AIB exits (DesktopApp.decide), or, when the keeper cannot hold them, AIB stays in the tray until nothing works.
 * keepInTray: the window was closed while phone access is on (owner's decision 2026-11-12, "Yes, keep in tray"): AIB stays in
 * the tray whatever works, so paired phones, notifications and pushes keep working; only Quit AIB stops it (Quit never passes it).
 */
export function closeDecision(work: number | null, keepInTray = false): CloseDecision {
  if (keepInTray) return 'tray';
  return work === 0 ? 'quit' : 'tray';
}

export interface Geometry {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : undefined;

/** A saved size and position made safe to apply: a bad or minimized (-32000) value falls back to the default size, no position. */
export function cleanGeometry(raw: unknown): Geometry {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const width = int(o.width, 480, 16000), height = int(o.height, 360, 16000);
  if (width === undefined || height === undefined) return { ...DEFAULT_SIZE };
  const x = int(o.x, -16000, 16000), y = int(o.y, -16000, 16000);
  return x === undefined || y === undefined ? { width, height } : { width, height, x, y };
}

export async function loadGeometry(path: string): Promise<Geometry> {
  try {
    return cleanGeometry(JSON.parse(await Deno.readTextFile(path)));
  } catch {
    return { ...DEFAULT_SIZE };
  }
}

export async function saveGeometry(path: string, g: Geometry): Promise<void> {
  const clean = cleanGeometry(g);
  if (clean.x === undefined && (g.x !== undefined || g.y !== undefined)) return; // minimized or off the map: keep the last good one
  try {
    await Deno.writeTextFile(path, JSON.stringify(clean));
  } catch { /* not fatal */ }
}

/** The link rule: an http(s) URL on another origin than the app page goes to the system browser; anything else stays. */
export function isExternal(href: string, appOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(href, appOrigin);
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== new URL(appOrigin).origin;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1', '0.0.0.0']);

/** True for 127.x.x.x, localhost and ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return LOOPBACK_HOSTS.has(h) || /^127\.\d+\.\d+\.\d+$/.test(h) || h.endsWith('.localhost');
}

/**
 * What to do with the page the app window shows:
 *   'ours'     our origin: leave it.
 *   'back'     not a page the person chose: another port on this machine (the desktop runtime's own DENO_SERVE_ADDRESS port, a dead
 *              server), an error page (chrome-error:, edge-error:), about:blank, or anything that isn't http(s). Navigate back to
 *              our page; never hand it to the system browser.
 *   'external' a real http(s) site elsewhere: open it in the system browser and go back.
 */
export type PageDecision = 'ours' | 'back' | 'external';

export function pageDecision(href: string, appOrigin: string): PageDecision {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return 'back';
  }
  if (url.origin === new URL(appOrigin).origin) return 'ours';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'back';
  return isLoopbackHost(url.hostname) ? 'back' : 'external';
}

/** The page-state probe the window runs: where it is (an error page reports chrome-error://chromewebdata/). */
export const PAGE_PROBE = `JSON.stringify({ href: String(location.href), title: String(document.title || '') })`;

/**
 * What the page holds to prove it is the page (page-auth.js): the launch key kept for this tab and the page session this origin
 * keeps. Read through the window's private evaluate channel only, and checked in this process (DesktopOptions.pageConnected).
 */
export const PAGE_AUTH_PROBE = `(() => { const r = (a, n) => { try { return String(window[a].getItem(n) || ''); } catch { return ''; } };
  return JSON.stringify({ key: r('sessionStorage', 'aib-page-key'), session: r('localStorage', 'aib-page-session') }); })()`;

/** The auth probe's answer, or null when it couldn't be read. */
export function parseAuthProbe(value: unknown): { key: string; session: string } | null {
  if (typeof value !== 'string' || !value.startsWith('{')) return null;
  try {
    const o = JSON.parse(value);
    return { key: typeof o?.key === 'string' ? o.key : '', session: typeof o?.session === 'string' ? o.session : '' };
  } catch {
    return null;
  }
}

/** The probe's answer, or null when it couldn't be read (the page is loading, or the call failed). */
export function parseProbe(value: unknown): { href: string; title: string } | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('{')) {
    try {
      const o = JSON.parse(value);
      if (o && typeof o.href === 'string') return { href: o.href, title: typeof o.title === 'string' ? o.title : '' };
    } catch { /* fall through */ }
    return null;
  }
  return { href: value, title: '' }; // a shell that answers with location.href alone
}

/**
 * Keeps a window that must never be seen (the app's keeper; the runtime's startup window in a non-window mode) on about:blank and
 * hidden: now, and again whenever it loads another page or gets focus. Returns the window.
 */
export function keepHidden(win: WindowHandle, label: string, quiet = false): WindowHandle {
  const hide = () => {
    try {
      win.hide();
    } catch { /* gone */ }
  };
  win.on('load', () => {
    hide();
    void win.evaluate('location.href').then((href) => {
      if (typeof href === 'string' && href !== KEEPER_URL) {
        // quiet: the runtime's own startup window in a process with no app window, which the runtime sends to its serve address
        // once by design; that is expected, so it is a plain info line, not a warning.
        if (quiet) log.info('%s: the runtime opened %s in it; hidden and back on %s', label, href, KEEPER_URL);
        else log.warning('%s: loaded %s; hidden and sent back to %s', label, href, KEEPER_URL);
        win.navigate(KEEPER_URL);
      }
    });
  });
  win.on('focus', () => {
    hide();
    log.info('%s: got focus; hidden again', label);
  });
  win.navigate(KEEPER_URL);
  hide();
  log.info('%s: on %s, hidden', label, KEEPER_URL);
  return win;
}

/** At most `max` calls per `windowMs` (the notification bindings are reachable from artifact iframes too). */
export function rateLimiter(max: number, windowMs: number, now: () => number = Date.now): () => boolean {
  const times: number[] = [];
  return () => {
    const t = now();
    while (times.length && times[0] <= t - windowMs) times.shift();
    if (times.length >= max) return false;
    times.push(t);
    return true;
  };
}

// ---------- the window system, behind an interface ----------

export interface WindowHandle {
  navigate(url: string): void;
  show(): void;
  hide(): void;
  focus(): void;
  setTitle(title: string): void;
  isClosed(): boolean;
  getSize(): [number, number];
  getPosition(): [number, number];
  setSize(width: number, height: number): void;
  setPosition(x: number, y: number): void;
  bind(name: string, fn: (...args: unknown[]) => unknown): void;
  /** False when the window is hidden; shells that can't tell leave it out. */
  isVisible?(): boolean;
  /** 'close' | 'load' | 'resize' | 'move' | 'focus' | 'blur' */
  on(event: string, fn: () => void): void;
  /** Runs code in the page; resolves with its value (or undefined if it failed). */
  evaluate(code: string): Promise<unknown>;
  /** Closes it from code (spike S4: no close event fires then). */
  close?(): void;
  /** Windows: its own HWND (B1), null while it can't be found. Other systems leave it out. */
  nativeHandle?(): bigint | null;
  /** Windows: minimised (IsIconic) and maximised (IsZoomed); null/absent where the system can't tell (S5, G3). */
  state?(): { minimized: boolean; maximized: boolean } | null;
  /** Windows: maximise it (G3, ShowWindow SW_MAXIMIZE). */
  maximize?(): void;
}

export interface TrayItem {
  id: string;
  label: string;
  /** Shown greyed out and never chosen (a status line). */
  disabled?: boolean;
  /** Not in the menu for now (an empty chat slot); Shell.updateTraySlots shows it. */
  hidden?: boolean;
}

/**
 * What a window is asked to open (notify-ui.js openFromDesktop): a notification's chat or inbox, or a route's target (K3 route:
 * a chat, a project, a doc; a page that doesn't know a type answers 'mine' and just comes forward).
 */
export type OpenTarget = NotifyTarget | { type: 'project'; key: string } | { type: 'doc'; project: string; name: string };

/**
 * The page function a notification click calls (notify-ui.js openFromDesktop). K6: 'mine' once this window opened it (an old page's
 * true counts as 'mine'), 'no' when it is not this window's, false while the page can't answer yet.
 */
export function openTargetScript(target: OpenTarget | null): string {
  const t = JSON.stringify(target).replace(/</g, '\\u003c');
  return `(function(){var N=window.AgentNotifyUI;if(!N||!N.openFromDesktop)return false;var r=N.openFromDesktop(${t});` +
    `return r===true||r==='mine'?'mine':r==='no'?'no':false;})()`;
}

export interface Shell {
  /** A new app window (x/y given: placed there; the runtime applies geometry a moment later, S7). */
  createWindow(options: { title: string; width: number; height: number; x?: number; y?: number }): WindowHandle;
  /**
   * A hidden window that keeps the runtime alive while the main window is closed (the app lives on in the tray): the runtime exits
   * when no window is left, even while servers run. DesktopApp keeps it on about:blank and hidden (keepKeeperHidden).
   */
  createKeeper(): WindowHandle;
  /**
   * The tray icon: a left click calls onClick, its right-click menu (items) calls onMenu with the chosen item's id. The same image
   * on light and dark taskbars (the colour app icon, tray_icon.ts).
   */
  createTray(
    icon: Uint8Array,
    tooltip: string,
    items: TrayItem[],
    onClick: () => void,
    onMenu: (id: string) => void,
  ): void;
  /** Removes the tray icon (quitting), so no dead icon is left behind. Never throws. */
  removeTray?(): void;
  /**
   * Changes the tray's tooltip and the label of the item at `index` (the greyed status line of a tray-only start). Same number of
   * items as createTray got. Never throws.
   */
  updateTray?(tooltip: string, index: number, label: string): void;
  /**
   * The tray's chat slots (SLOT_ITEMS, after the fixed items createTray got): these labels in order, the rest left out of the menu.
   * Never throws.
   */
  updateTraySlots?(labels: string[]): void;
  /** Windows: the attention dot on the app window's icon (title bar, Alt+Tab, taskbar button) on or off. Never throws. */
  setWindowAttention?(on: boolean): void;
  /** A native OK/Cancel question; Cancel is the default button. Resolves true for OK. Must not block the event loop. */
  ask(message: string): Promise<boolean>;
  openExternal(url: string): void;
  /** The OS notifications (notify.ts), or null where there are none. */
  notifier: OsNotify | null;
  /**
   * Restores a window if minimised and makes it the foreground window (Windows: foreground_win.ts): the one with this native handle
   * (B1), or without one the biggest AIB window.
   */
  bringToFront?(hwnd?: bigint | null): { found: boolean; restored: boolean; foreground: boolean };
  /** G1: is this rectangle on a screen now? null/absent: can't tell (the position is kept). */
  onScreen?(rect: { x: number; y: number; width: number; height: number }): boolean | null;
  /** S8: false where the app can't place its windows (Wayland): sizes are restored, positions are left to the window manager. */
  canPosition?: boolean;
}

export interface DesktopOptions {
  /** The page, http://127.0.0.1:PORT/ */
  url: string;
  stateDir: string;
  trayIcon: Uint8Array;
  /** How many chats are working (host.busyConnections().length); a throw counts as unknown. */
  busyCount: () => Promise<number>;
  /**
   * A separate agent host (an older version's, being drained): ask it to stop (host_client.stopHost). Quitting calls it first:
   * forced only for Stop all chats and quit, unforced otherwise, so an idle host goes at once and a host with chats working refuses
   * and keeps them running under its own tray icon (it exits by itself a few seconds after the last one finishes). With a separate
   * host the app itself quits at once: the chats are not in this process. A refusal or failure never holds the quit up.
   */
  stopHost?: (force: boolean) => Promise<unknown>;
  /** The window loaded our page (the update helper's health marker is written then). */
  onPageLoaded?: () => void;
  /**
   * True when what our page holds (PAGE_AUTH_PROBE) gets it the token: the launch key, or a page session the server knows. Our page
   * without either (the runtime's startup navigation to its own serve port lands there through a key-less redirect, which may
   * overwrite the keyed one) is sent to `url` again, which carries the key. Not given: not checked (tests of other things).
   */
  pageConnected?: (held: { key: string; session: string }) => boolean;
  /**
   * The normal close path (the web server). stopAgents: Stop all chats and quit. leave: Quit AIB with work running; the chats stay in
   * the keeper, which holds them until an AIB is started again (no restart in the tray). Never returns in the real app (Deno.exit).
   */
  quit: (stopAgents: boolean, leave?: boolean) => Promise<void>;
  /**
   * Can Quit AIB leave everything that works to the keeper and exit? '' when yes (every working chat and terminal command runs in a
   * keeper that can hold them), else why not; then AIB stays in the tray until nothing works. Not given: never (no keeper).
   */
  canLeave?: () => Promise<string>;
  /** How long Quit AIB waits for a running merge before AIB exits (default 120 s; a cut-off merge would leave a half-done repo). */
  mergeWaitMs?: number;
  saveDelayMs?: number;
  /**
   * Start with no window, only the tray icon (`--start-in-tray`: the keeper restarting AIB after a crash, rule V1, so nothing pops
   * up over the person's work). Open AIB makes the window as usual. Until then AIB is "in the background": it quits by itself once
   * nothing has worked for trayIdleQuitMs (the chats that were open come back at the next start, as after an idle agent host).
   * Quit AIB while something works that the keeper cannot hold (canLeave says why) puts AIB in the background the same way.
   */
  startInTray?: boolean;
  /** Terminal shells running a command (counted as work: Quit AIB leaves them to the keeper, or AIB stays in the tray). */
  terminalsBusy?: () => number;
  /** Merges running in this process (AIB does not exit in the middle of one: it would leave a half-done repo). */
  mergesRunning?: () => number;
  /** What works now, for the status line, the quit decision and the idle quit. Default: busyCount, nobody waiting. */
  trayCounts?: () => Promise<{ working: number; needsYou: number; blocked?: { key: string; title: string; reason?: string }[] }>;
  /** In the background: how long nothing must work before AIB quits by itself (default 10 s; 0 = never). */
  trayIdleQuitMs?: number;
  /**
   * Phone access is on (Settings > Remote control). Then closing the window keeps AIB in the tray (the web server, the phone port, the
   * attention watcher, notifications and pushes go on), the background never quits by itself, and the tooltip says so. Quit AIB
   * is unchanged. Read on every close and tray tick, so turning it off in the tray brings back the idle quit. A throw counts as off.
   */
  phoneOn?: () => boolean;
  /** How often the status line and the idle rule look (default 2 s; 0 = tests call trayTick()). */
  trayPollMs?: number;
  /** The watchdog period; 0 turns it off (tests drive watchdogTick() themselves). Default WATCHDOG_MS. */
  watchdogMs?: number;
  /** G4: a project folder is gone (FolderPresence.isGone); its window is not restored. Not given: never gone. */
  folderGone?: (path: string) => boolean;
  /** A window closed (by the person or from code): its presence slot goes at once (B8). */
  onWindowGone?: (w: string) => void;
}

const SEP = Deno.build.os === 'windows' ? '\\' : '/';

/** A saved window not open (yet): its handle says closed until makeWindow gives it a real one. */
const CLOSED_WINDOW: WindowHandle = {
  navigate() {},
  show() {},
  hide() {},
  focus() {},
  setTitle() {},
  isClosed: () => true,
  isVisible: () => false,
  getSize: () => [0, 0],
  getPosition: () => [0, 0],
  setSize() {},
  setPosition() {},
  bind() {},
  on() {},
  evaluate: () => Promise.resolve(undefined),
};

/**
 * The windows, the tray and the close/quit questions. Several app windows (multi-window Phase 2A): each has its own entry in
 * `windows` (windows.ts) with its own URL, page check, key check, rate limits and save timer; `desktopWindows` is the real K4.
 */
export class DesktopApp implements WindowsHost {
  #quitting = false;
  /** No window and quitting by itself once nothing works (a tray-only start, or a quit the keeper could not take). */
  #background = false;
  /** Stop all chats and quit was clicked once: a second click before this time stops everything. */
  #stopArmedUntil = 0;
  #stopTimer: ReturnType<typeof setTimeout> | undefined;
  #loadedOnce = false;
  readonly origin: string;
  /** The launch key in options.url (each window's K0 URL carries it in its fragment, N4). */
  readonly launchKey: string;
  /** The app windows (K0 ids), and the one writer of desktop-windows.json (K1). */
  readonly windows: WindowList;
  /** K4: ctx.desktopWindows. */
  readonly desktopWindows: AppWindows;
  /** What POST /api/live/desktop/notify shows through; a click opens the chat (openFromNotification). */
  readonly notifications: DesktopNotifications;
  keeper: WindowHandle | null = null;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #trayTimer: ReturnType<typeof setInterval> | undefined;
  #trayView: { status: string; tooltip: string } | null = null;
  /** The tray's chat slots as shown, and the window icon's attention dot (null: not set yet). */
  #slots: TraySlot[] = [];
  #attention: boolean | null = null;
  #idleSince: number | null = null;
  #windowOpened = false;
  /** The saved list as read at the first restore (later restores use the live list). */
  #restored = false;

  constructor(readonly shell: Shell, readonly options: DesktopOptions) {
    this.origin = new URL(options.url).origin;
    this.launchKey = launchKeyOf(options.url);
    this.windows = new WindowList(options.stateDir);
    this.desktopWindows = new AppWindows(this);
    this.notifications = new DesktopNotifications(shell.notifier, (target) => void this.openFromNotification(target));
  }

  /** The window a person sees as "the AIB window": the main one if open, else the one used last (older callers and tests). */
  get window(): WindowHandle | null {
    const main = this.windows.main();
    if (main && !main.handle.isClosed()) return main.handle;
    return this.windows.lastFocused()?.handle ?? main?.handle ?? null;
  }

  /**
   * A notification (or a tray chat slot) was clicked: the right window comes forward and opens the chat or the inbox (B6, E4): the
   * pop-out showing that chat, then the window pinned to its project, then the main window (made if needed), then the one used
   * last. Each page answers K6 'mine' or 'no' (the next window is asked); a page still loading gets a few more tries (every 500 ms,
   * up to `tries`). With no window open every saved window comes back first. Resolves true once a page took it.
   */
  async openFromNotification(target: NotifyTarget | null, tries = 20, waitMs = 500): Promise<boolean> {
    if (this.#quitting) return false;
    log.info('notify click → %s', target ? (target.type === 'chat' ? 'open the chat' : 'open the inbox') : 'bring AIB to the front');
    if (!target) {
      await this.showWindow('notification click');
      return true;
    }
    if (!this.windows.visible().length) await this.showWindow('notification click');
    const choose: ChooseTarget = target.type === 'chat' ? { chat: target.key } : {};
    const won = await this.#deliver(() => chooseOrder(choose, this.windows.chooser()), target, tries, waitMs);
    if (won) {
      log.info('notify click → window %s opened the %s', won, target.type);
      return true;
    }
    log.info('notification click: no window opened %s', target.type);
    return false;
  }

  /**
   * Asks the windows in order to open `target` (K6): 'mine' → that window comes forward, done; 'no' → the next one; no answer yet
   * (loading) → asked again on the next round. All said 'no' and there is no main window: one is made (B6 "made if needed").
   */
  async #deliver(
    order: () => { order: string[]; needsMain: boolean },
    target: OpenTarget,
    tries: number,
    waitMs: number,
    front = true,
  ): Promise<string | null> {
    const said = new Map<string, 'no'>();
    for (let i = 0; i < tries; i++) {
      if (this.#quitting) return null;
      const { order: ids, needsMain } = order();
      let waiting = false;
      for (const id of ids) {
        if (said.has(id)) continue;
        const e = this.windows.get(id);
        if (!e || e.handle.isClosed()) continue;
        const answer = openAnswer(await e.handle.evaluate(openTargetScript(target)));
        if (answer === 'mine') {
          if (front) this.focusWindow(e, 'opened ' + target.type);
          return id;
        }
        if (answer === 'no') said.set(id, 'no');
        else waiting = true;
      }
      if (!waiting && needsMain) {
        log.info('open %s: no window took it; opening the main window', target.type);
        this.makeWindow({ id: 'm', kind: 'main', ...DEFAULT_MAIN_SIZE });
        continue;
      }
      if (!waiting && !ids.some((id) => !said.has(id))) return null;
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }
    return null;
  }

  /** K4 route's delivery (WindowsHost): the window it chose opens it (K6; tries again while that page loads). */
  deliver(order: string[], target: ChooseTarget): Promise<string | null> {
    const t: OpenTarget = target.chat
      ? { type: 'chat', key: target.chat }
      : target.doc
      ? { type: 'doc', project: target.doc.project, name: target.doc.name }
      : { type: 'project', key: target.project ?? '' };
    return this.#deliver(() => ({ order, needsMain: false }), t, 20, 500, false);
  }

  async start(): Promise<void> {
    if (!this.options.startInTray) await this.restoreAll('start');
    else {
      this.#background = true;
      log.info('window: started in the tray (no window until Open AIB)');
    }
    try {
      this.keepKeeperHidden(this.shell.createKeeper());
    } catch (error) {
      log.exception(error, 'keeper window could not be made: closing the window will quit AIB');
    }
    const every = this.options.watchdogMs ?? WATCHDOG_MS;
    if (every > 0) this.#watchdog = setInterval(() => void this.watchdogTick(), every);
    this.shell.createTray(
      this.options.trayIcon,
      WINDOW_TITLE,
      [...TRAY_ITEMS, ...SLOT_ITEMS],
      () => void this.showWindow(),
      (id) => void this.onTrayMenu(id),
    );
    await this.trayTick();
    this.trayState('shown');
    const poll = this.options.trayPollMs ?? 2000;
    if (poll > 0) this.#trayTimer = setInterval(() => void this.trayTick(), poll);
  }

  onTrayMenu(id: string): Promise<void> {
    if (id === 'open') return this.showWindow();
    if (id === 'quit') return this.requestQuit();
    if (id === 'stop') return this.requestStop();
    const slot = /^chat-(\d+)$/.exec(id);
    const target = slot ? this.#slots[Number(slot[1])]?.target : undefined;
    if (target) return this.openFromNotification(target).then(() => {});
    return Promise.resolve();
  }

  /** True while AIB has no window (it quits by itself once nothing works, unless phone access is on). */
  get background(): boolean {
    return this.#background;
  }

  /** Phone access is on (options.phoneOn); false when not given or it throws. */
  phoneOn(): boolean {
    try {
      return this.options.phoneOn?.() === true;
    } catch {
      return false;
    }
  }

  /** AIB_TEST_TRAY_STATE (tests on an invisible desktop): the app icon's state, like the host's and the helper's. Never throws. */
  trayState(why: string): void {
    const stopLabel = this.#stopLabel;
    import('./host_tray.ts').then(({ writeTrayState }) =>
      writeTrayState('app', {
        shown: why !== 'removed',
        why,
        trayOnly: !!this.options.startInTray,
        background: this.#background,
        windowOpened: this.#windowOpened,
        tooltip: this.#trayView?.tooltip ?? WINDOW_TITLE,
        phoneOn: this.phoneOn(),
        status: this.#trayView?.status ?? '',
        items: TRAY_ITEMS.map((i) => (i.id === 'status' ? this.#trayView?.status ?? '' : i.id === 'stop' ? stopLabel : i.label)),
        chats: this.#slots.map((s) => s.label),
        attention: !!this.#attention,
      })
    ).catch(() => {});
  }

  async #counts(): Promise<{ working: number; needsYou: number; blocked?: { key: string; title: string; reason?: string }[] } | null> {
    try {
      if (this.options.trayCounts) return await this.options.trayCounts();
      const n = await this.options.busyCount();
      return Number.isInteger(n) && n >= 0 ? { working: n, needsYou: 0 } : null;
    } catch {
      return null;
    }
  }

  /** Everything quitting must not cut off: chats working (queued, helpers, waiting for the person), terminal commands, merges. */
  async work(): Promise<
    {
      working: number;
      needsYou: number;
      blocked?: { key: string; title: string; reason?: string }[];
      terminals: number;
      merges: number;
      total: number;
    } | null
  > {
    const counts = await this.#counts();
    if (!counts) return null;
    const safe = (f?: () => number) => {
      try {
        const n = f?.() ?? 0;
        return Number.isInteger(n) && n > 0 ? n : 0;
      } catch {
        return 0; // unknown: not busy
      }
    };
    const terminals = safe(this.options.terminalsBusy);
    const merges = safe(this.options.mergesRunning);
    return { ...counts, terminals, merges, total: counts.working + terminals + merges };
  }

  /** Every trayPollMs: refresh the status line; in the background, quit once nothing has worked for trayIdleQuitMs. */
  async trayTick(now = Date.now()): Promise<void> {
    if (this.#quitting) return;
    const work = await this.work();
    const phoneOn = this.phoneOn();
    if (work) {
      const view = trayOnlyView(work.working, work.needsYou, phoneOn);
      if (view.status !== this.#trayView?.status || view.tooltip !== this.#trayView?.tooltip) {
        this.#trayView = view;
        try {
          this.shell.updateTray?.(view.tooltip, 1, view.status);
        } catch { /* not fatal */ }
        this.trayState('status');
      }
      const slots = trayChatSlots(work.blocked ?? [], work.blocked ? work.needsYou : 0);
      if (slots.map((x) => x.label).join('\n') !== this.#slots.map((x) => x.label).join('\n')) {
        this.#slots = slots;
        try {
          this.shell.updateTraySlots?.(slots.map((x) => x.label));
        } catch { /* not fatal */ }
        this.trayState('chats');
      }
      const attention = work.needsYou > 0;
      if (attention !== this.#attention) {
        this.#attention = attention;
        try {
          this.shell.setWindowAttention?.(attention);
        } catch { /* not fatal */ }
        this.trayState('attention');
      }
    }
    const idleMs = this.options.trayIdleQuitMs ?? 10_000;
    // Phone access on: AIB stays in the tray for the phones however long nothing works. Turned off while AIB has no window: the
    // usual idle rule again (it quits once nothing has worked for idleMs; work running keeps it until that finishes).
    if (!this.#background || idleMs <= 0 || phoneOn) {
      this.#idleSince = null;
      return;
    }
    if (!work || work.total > 0) {
      this.#idleSince = null;
      return;
    }
    this.#idleSince ??= now;
    if (now - this.#idleSince >= idleMs) {
      log.info('tray: in the background and nothing has worked for %s s; quitting', Math.round((now - this.#idleSince) / 1000));
      await this.quit(false);
    }
  }

  get #stopLabel(): string {
    return Date.now() < this.#stopArmedUntil ? this.#armedLabel : TRAY_ITEMS[STOP_INDEX].label;
  }

  #armedLabel = '';

  #setStopLabel(label: string): void {
    try {
      this.shell.updateTray?.(this.#trayView?.tooltip ?? WINDOW_TITLE, STOP_INDEX, label);
    } catch { /* not fatal */ }
  }

  /**
   * Tray "Stop all chats and quit", the only deliberate way to stop everything. With nothing working it just quits. Otherwise the
   * first click turns the item into "Click again to stop 2 chats and quit" for STOP_CONFIRM_MS (no native box); a second click in
   * that time stops the chats, their helpers and terminals, and quits.
   */
  async requestStop(now = Date.now()): Promise<void> {
    if (this.#quitting) return;
    if (now < this.#stopArmedUntil) {
      clearTimeout(this.#stopTimer);
      log.info('tray: Stop all chats and quit confirmed; stopping everything');
      await this.quit(true);
      return;
    }
    const work = await this.work();
    if (work && work.total === 0) {
      log.info('tray: Stop all chats and quit with nothing working; quitting');
      await this.quit(false);
      return;
    }
    this.#armedLabel = stopConfirmLabel(work?.working ?? 0);
    this.#stopArmedUntil = now + STOP_CONFIRM_MS;
    this.#setStopLabel(this.#armedLabel);
    this.trayState('stop armed');
    log.info(
      'tray: Stop all chats and quit clicked once (%s); a second click within %s s stops everything',
      this.#armedLabel,
      STOP_CONFIRM_MS / 1000,
    );
    clearTimeout(this.#stopTimer);
    this.#stopTimer = setTimeout(() => {
      this.#stopArmedUntil = 0;
      if (this.#quitting) return;
      this.#setStopLabel(TRAY_ITEMS[STOP_INDEX].label);
      this.trayState('stop disarmed');
    }, STOP_CONFIRM_MS);
  }

  /** Stops the watchdog and the tray timers (tests; the real app ends with Deno.exit). */
  stop(): void {
    clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    clearInterval(this.#trayTimer);
    this.#trayTimer = undefined;
    clearTimeout(this.#stopTimer);
    this.#stopTimer = undefined;
    for (const t of this.#frontTimers) clearTimeout(t);
    this.#frontTimers.clear();
    for (const e of this.windows.entries) {
      clearTimeout(e.saveTimer);
      e.saveTimer = undefined;
    }
  }

  /**
   * The keeper only keeps the runtime alive: it must never show or load anything. It is put on about:blank and hidden now, and
   * again whenever it loads a page or gets focus (the runtime may navigate or show windows on its own, e.g. after a renderer
   * restart). The watchdog re-hides it too when the shell can tell it is visible.
   */
  keepKeeperHidden(keeper: WindowHandle): void {
    this.keeper = keeper;
    keepHidden(keeper, 'keeper window');
  }

  /** Every WATCHDOG_MS: every visible window must show its own page (B2); the keeper must stay hidden. */
  async watchdogTick(): Promise<void> {
    const keeper = this.keeper;
    if (keeper && !keeper.isClosed() && keeper.isVisible?.() === true) {
      log.warning('watchdog: the keeper window was visible; hiding it');
      try {
        keeper.hide();
      } catch { /* gone */ }
    }
    if (this.#quitting) return;
    for (const e of this.windows.visible()) await this.checkPage(e, 'watchdog');
  }

  /** The main window at its saved size and position (made again if it was closed); older callers. */
  async openWindow(): Promise<WindowHandle> {
    await this.#firstRestore();
    const main = this.windows.main();
    if (main && !main.handle.isClosed()) return main.handle;
    const g = main ? { ...main.geometry, maximized: main.maximized } : { ...DEFAULT_MAIN_SIZE };
    return this.makeWindow({ id: 'm', kind: 'main', ...g }).handle;
  }

  /** The saved list, read once (the first start, or Open AIB after a tray-only start), into the list as not-yet-open entries. */
  async #firstRestore(): Promise<void> {
    if (this.#restored) return;
    this.#restored = true;
    const saved = await loadSavedList(this.options.stateDir);
    const plan = restorePlan(saved, {
      folderGone: this.options.folderGone,
      onScreen: this.shell.onScreen ? (r) => this.shell.onScreen!(r) : undefined,
      positions: this.shell.canPosition !== false,
    });
    const gone = (saved?.windows ?? []).filter((w) => !plan.some((p) => p.id === w.id)).length;
    if (gone > 0) log.info('windows: %s saved window(s) not restored (project folder gone)', gone);
    for (const item of plan) this.windows.add(this.#entry(item, CLOSED_WINDOW));
    if (saved?.lastFocused) this.windows.focused(saved.lastFocused); // B12: the window used last before the restart
    this.#pendingDropSave = gone > 0;
  }

  /** A folder-gone window was left out at restore: the next save drops it from the file (G4). */
  #pendingDropSave = false;

  /**
   * Makes every saved window that is not open (D3a): at start, at Open AIB with none open (B12, G7), or after the last one closed
   * (G9). The main window first (B4), then the others in their saved order (section 7).
   */
  async restoreAll(why: string): Promise<void> {
    await this.#firstRestore();
    if (this.#quitting) return;
    const todo = this.windows.entries.filter((e) => e.handle.isClosed());
    log.info('windows: restoring %s window(s) (%s)', todo.length, why);
    for (const e of todo) {
      if (this.#quitting) return;
      this.makeWindow({
        id: e.id,
        kind: e.kind,
        ...(e.project ? { project: e.project } : {}),
        ...(e.chat ? { chat: e.chat } : {}),
        ...(e.doc ? { doc: e.doc } : {}),
        ...(e.from ? { from: e.from } : {}),
        ...e.geometry,
        maximized: e.maximized,
        cascade: e.cascade,
      });
    }
    if (!this.windows.open().length) this.makeWindow({ id: 'm', kind: 'main', ...DEFAULT_MAIN_SIZE });
    if (this.#pendingDropSave) {
      this.#pendingDropSave = false;
      void this.windows.save('a window was not restored');
    }
  }

  #entry(w: SavedWindow & { cascade?: number }, handle: WindowHandle): AppWindow {
    const g = cleanSavedGeometry(w, defaultSize(w.kind));
    return {
      id: w.id,
      kind: w.kind,
      ...(w.project ? { project: w.project } : {}),
      ...(w.chat ? { chat: w.chat } : {}),
      ...(w.doc ? { doc: w.doc } : {}),
      ...(w.from && (w.kind === 'chat' || w.kind === 'doc') ? { from: w.from } : {}),
      handle,
      url: windowUrl(this.origin, specOf(w), this.launchKey),
      title: windowTitle(w),
      geometry: { width: g.width, height: g.height, ...(g.x !== undefined && g.y !== undefined ? { x: g.x, y: g.y } : {}) },
      maximized: !!w.maximized,
      loaded: false,
      cascade: w.cascade ?? 0,
      focusedAt: this.windows.get(w.id)?.focusedAt ?? 0,
      backAllowed: rateLimiter(4, 30_000),
      keyAllowed: rateLimiter(3, 60_000),
    };
  }

  /**
   * WindowsHost: a new window (its id chosen by the caller: 'm' or the free one), recorded in the list before it is made (F3), at
   * its size and position, on its own K0 URL. `from`: the window it was opened from (the new one opens next to it).
   */
  makeWindow(w: SavedWindow & { cascade?: number }, from?: string): AppWindow {
    const placed = { ...w };
    if (placed.x === undefined && from) Object.assign(placed, this.#nextTo(from, placed) ?? {});
    const e = this.#entry(placed, CLOSED_WINDOW);
    this.windows.add(e); // recorded before the window exists: a second open sees it (F3)
    const opts: { title: string; width: number; height: number; x?: number; y?: number } = {
      title: e.title,
      width: e.geometry.width,
      height: e.geometry.height,
    };
    if (e.geometry.x !== undefined && e.geometry.y !== undefined) {
      opts.x = e.geometry.x;
      opts.y = e.geometry.y;
    }
    const win = this.shell.createWindow(opts);
    e.handle = win;
    this.#opens++;
    const wasBackground = this.#background;
    this.#background = false; // the person is back: no quitting by itself while a window is there
    if (!this.#windowOpened || wasBackground) {
      this.#windowOpened = true;
      this.trayState('window opened');
    }
    try {
      win.setSize(e.geometry.width, e.geometry.height);
      if (e.geometry.x !== undefined && e.geometry.y !== undefined) win.setPosition(e.geometry.x, e.geometry.y);
    } catch { /* keep the default */ }
    this.bindAll(win);
    win.on('resize', () => this.scheduleSave(e));
    win.on('move', () => this.scheduleSave(e));
    win.on('load', () => void this.#loaded(e));
    win.on('focus', () => this.windows.focused(e.id));
    win.on('close', () => void this.onWindowClosed(e));
    log.info('window %s (%s): opening %s (%sx%s)', e.id, e.kind, e.url, e.geometry.width, e.geometry.height);
    win.navigate(e.url);
    void this.windows.save(`window ${e.id} opened`);
    return e;
  }

  /** A new window next to the one it came from: a pop-out at its right edge when that is on a screen, else 30 px down and right. */
  #nextTo(from: string, w: SavedWindow): { x: number; y: number } | null {
    if (this.shell.canPosition === false) return null;
    const src = this.windows.get(from);
    if (!src || src.handle.isClosed()) return null;
    let pos: [number, number], size: [number, number];
    try {
      pos = src.handle.getPosition();
      size = src.handle.getSize();
    } catch {
      return null;
    }
    if (w.kind === 'chat' || w.kind === 'doc') {
      const right = { x: pos[0] + size[0], y: pos[1], width: w.width, height: w.height };
      let on: boolean | null = null;
      try {
        on = this.shell.onScreen?.(right) ?? null;
      } catch { /* can't tell */ }
      if (on === true) return { x: right.x, y: right.y };
    }
    return { x: pos[0] + CASCADE_PX, y: pos[1] + CASCADE_PX };
  }

  /** A window's load: its title (B13), the first-load geometry jobs (S7: cascade G2, maximise G3), then the page check. */
  async #loaded(e: AppWindow): Promise<void> {
    if (e.handle.isClosed()) return;
    try {
      e.handle.setTitle(e.title); // the native title does not follow document.title (Phase 2A probe): the app owns it
    } catch { /* not fatal */ }
    if (!e.loaded) {
      e.loaded = true;
      try {
        e.handle.nativeHandle?.(); // B1: find and keep its own handle while it is the newest window
      } catch { /* not fatal */ }
      if (e.cascade > 0) {
        const first = this.windows.open().find((x) => x !== e && x.loaded);
        try {
          if (first) {
            const [x, y] = first.handle.getPosition();
            e.handle.setPosition(x + CASCADE_PX * e.cascade, y + CASCADE_PX * e.cascade);
          }
        } catch { /* not fatal */ }
      }
      if (e.maximized) {
        try {
          e.handle.maximize?.();
        } catch { /* not fatal */ }
      }
    }
    await this.checkPage(e, 'load');
  }

  /**
   * Tray click, "Open AIB", or a second launch (B12): the window used last comes forward. Windows hidden by Quit AIB or the tray
   * rule are shown again. With no window open every saved window comes back (G7, G9); with only pop-outs open, a main window is
   * made (E7).
   */
  async showWindow(why = 'show'): Promise<void> {
    if (this.#quitting) return;
    this.#leaving = false; // Quit AIB waiting for a merge: the person is back, AIB stays
    if (!this.windows.open().length) {
      await this.restoreAll(why);
      const front = this.windows.lastFocused();
      if (front) this.focusWindow(front, why);
      return;
    }
    for (const e of this.windows.open()) {
      if (e.handle.isVisible?.() !== false) continue;
      try {
        e.handle.show();
      } catch { /* gone */ }
    }
    this.#opens++;
    if (this.#background) {
      this.#background = false; // a window hidden by Quit AIB is shown again: the person is back
      this.trayState('window shown');
    }
    if (!this.windows.open().some((e) => e.kind === 'main' || e.kind === 'project')) {
      const g = this.windows.main()?.geometry ?? DEFAULT_MAIN_SIZE;
      this.focusWindow(this.makeWindow({ id: 'm', kind: 'main', ...g }), why);
      return;
    }
    const front = this.windows.lastFocused();
    if (front) this.focusWindow(front, why);
  }

  /** WindowsHost: show, focus and bring to the front with the window's own handle (B1). */
  focusWindow(e: AppWindow, why: string): void {
    try {
      e.handle.show();
      e.handle.focus();
    } catch { /* gone */ }
    this.windows.focused(e.id);
    this.toFront(why, e);
  }

  /** WindowsHost / K4 close (S4): out of the list first (no close event comes), then closed; its presence slot goes (B8). */
  closeWindow(e: AppWindow): void {
    const lastVisible = this.windows.visible().every((x) => x === e);
    if (lastVisible && e.kind !== 'main') {
      // A pinned window or pop-out closing itself (its project or chat is gone, G4) never leaves AIB without a window.
      const main = this.windows.main();
      if (!main || main.handle.isClosed()) this.makeWindow({ id: 'm', kind: 'main', ...(main?.geometry ?? DEFAULT_MAIN_SIZE) });
    }
    this.windows.remove(e.id);
    try {
      e.handle.close?.();
    } catch { /* gone */ }
    this.#gone(e.id);
    log.info('window %s (%s): closed from its page', e.id, e.kind);
    void this.windows.save(`window ${e.id} closed`);
  }

  #gone(id: string): void {
    try {
      this.options.onWindowGone?.(id);
    } catch { /* not fatal */ }
  }

  /**
   * show() and focus() neither restore a minimised window nor make it the foreground window: the Shell does that (Windows:
   * foreground_win.ts), with the window's own handle (B1; the biggest AIB window without one), now and once more shortly after
   * (the runtime shows the window on its own UI thread a moment later).
   */
  toFront(why: string, e: AppWindow | undefined = this.windows.lastFocused()): void {
    const front = this.shell.bringToFront;
    if (!front) return;
    const once = (when: string) => {
      let hwnd: bigint | null = null;
      try {
        hwnd = e && !e.handle.isClosed() ? e.handle.nativeHandle?.() ?? null : null;
      } catch { /* none */ }
      try {
        const r = front(hwnd);
        log.info(
          'window to front (%s, %s, %s): found %s, restored %s, foreground %s',
          why,
          when,
          e?.id ?? '?',
          r.found,
          r.restored,
          r.foreground,
        );
      } catch { /* not fatal */ }
    };
    once('now');
    const t = setTimeout(() => {
      this.#frontTimers.delete(t);
      once('after 250 ms');
    }, 250);
    this.#frontTimers.add(t);
  }

  #frontTimers = new Set<ReturnType<typeof setTimeout>>();

  /** One binding: the page asks it whether it runs in the app (desktop-bridge.js available()). It does nothing else. */
  bindAll(win: WindowHandle): void {
    win.bind('aibDesktop', () => true);
  }

  /**
   * B10: one save timer per window. Geometry from getSize/getPosition only, after the first load (S7), never at 0x0 or minimised
   * (S5). A maximised window keeps its normal size and position and only sets the flag (G3). The list has one writer (windows.ts).
   */
  scheduleSave(e: AppWindow): void {
    clearTimeout(e.saveTimer);
    e.saveTimer = setTimeout(() => {
      e.saveTimer = undefined;
      if (e.handle.isClosed() || !e.loaded || this.#quitting) return;
      try {
        const st = e.handle.state?.() ?? null;
        if (st?.minimized) return;
        const [width, height] = e.handle.getSize();
        const [x, y] = e.handle.getPosition();
        if (!(width > 0 && height > 0)) return; // minimised (S5)
        e.maximized = !!st?.maximized;
        if (!e.maximized) {
          const g = cleanSavedGeometry({ width, height, x, y }, e.geometry);
          if (g.x === undefined && e.geometry.x !== undefined) return; // off the map (-32000): keep the last good one
          const place = g.x !== undefined && g.y !== undefined && this.shell.canPosition !== false;
          e.geometry = { width: g.width, height: g.height, ...(place ? { x: g.x, y: g.y } : {}) };
        }
        void this.windows.save(`window ${e.id} moved`);
      } catch { /* window gone */ }
    }, this.options.saveDelayMs ?? 500);
  }

  #entryOf(win: WindowHandle | AppWindow): AppWindow | null {
    const asEntry = win as AppWindow;
    if (asEntry.handle && typeof asEntry.url === 'string') return asEntry;
    return this.windows.entries.find((e) => e.handle === win) ?? null;
  }

  /**
   * The safety net for the link rule and for the runtime: after every load (and from the watchdog), each window must show its own
   * page (B2, B3). A real external site opens in the system browser; anything else that isn't ours (another port on this machine,
   * an error page, about:blank) is never handed outside. Either way the window goes back to its own K0 URL, rate-limited per window.
   * Our page without this window's own id (S6: the first window loses its query; B4: the runtime's startup redirect) is sent its
   * own URL again, with the key check's rate limit. Returns the decision.
   */
  async checkPage(target: WindowHandle | AppWindow, why = 'load'): Promise<PageDecision | null> {
    const e = this.#entryOf(target);
    if (!e) return null;
    const win = e.handle;
    const page = parseProbe(await win.evaluate(PAGE_PROBE));
    if (!page) return null; // can't read it now: the next load or watchdog tick looks again
    const decision = pageDecision(page.href, this.origin);
    if (why === 'load') log.info('window %s: loaded %s (%s)', e.id, page.href, decision);
    if (decision === 'ours') {
      if (why === 'load' && !this.#loadedOnce) {
        this.#loadedOnce = true;
        try {
          this.options.onPageLoaded?.();
        } catch { /* not fatal */ }
      }
      if (win.isClosed() || this.#quitting || this.windows.get(e.id) !== e) return decision;
      if (pageWindowId(page.href) !== e.id) {
        if (!e.keyAllowed()) {
          log.warning('window %s: on %s without its own id; not sent again: too many tries in a row', e.id, page.href);
          return decision;
        }
        log.info('window %s: on %s without its own id (%s); sending its own URL again', e.id, page.href, why);
        win.navigate(e.url);
        return decision;
      }
      await this.#ensureConnected(e, page.href, why);
      return decision;
    }
    if (win.isClosed() || this.#quitting || this.windows.get(e.id) !== e) return decision;
    if (decision === 'external') {
      log.info('window %s: %s is an outside site: opening it in the browser', e.id, page.href);
      this.shell.openExternal(page.href);
    }
    if (!e.backAllowed()) {
      log.warning('window %s: on %s (%s, %s); not sent back: too many tries in a row', e.id, page.href, decision, why);
      return decision;
    }
    log.warning('window %s: on %s (%s, %s); sending it back to %s', e.id, page.href, decision, why, e.url);
    win.navigate(e.url);
    return decision;
  }

  /**
   * Our page, but holding neither the launch key nor a known page session ("This browser is not connected to AIB yet"): the
   * runtime sent the window to its serve port after our keyed navigation, and that redirect carries no key (it is open to every
   * local process, so it never may). The key reaches the page only here, through this window's own navigate (N4). Rate-limited
   * per window.
   */
  async #ensureConnected(e: AppWindow, href: string, why: string): Promise<void> {
    const check = this.options.pageConnected;
    const win = e.handle;
    if (!check || win.isClosed() || this.#quitting) return;
    const held = parseAuthProbe(await win.evaluate(PAGE_AUTH_PROBE));
    if (!held) return; // can't read it now: the next load or watchdog tick looks again
    let connected = true;
    try {
      connected = check(held);
    } catch { /* unknown: leave the page alone */ }
    if (connected) return;
    if (!e.keyAllowed()) {
      log.warning('window %s: our page (%s) is not connected; not opened again: too many tries in a row', e.id, why);
      return;
    }
    log.warning('window %s: our page %s holds no launch key or known page session (%s); opening it again with the key', e.id, href, why);
    win.navigate(e.url);
  }

  async busy(): Promise<number | null> {
    try {
      const n = await this.options.busyCount();
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /**
   * A window was closed by the person (it is already gone; the close can't be cancelled, S3). Not the last visible window: it just
   * closes and leaves the saved list (B5), nothing is asked or stopped. The last visible one stays in the saved list (G8, G9) and
   * runs the same rule as Quit AIB, except while phone access is on: then AIB stays in the tray (owner's decision 2026-11-12), so
   * the phones, notifications and pushes keep working; Open AIB brings the windows back.
   */
  async onWindowClosed(target: WindowHandle | AppWindow): Promise<void> {
    const e = this.#entryOf(target);
    if (!e) return;
    clearTimeout(e.saveTimer);
    if (this.windows.get(e.id) !== e) return; // closed from code: already out of the list (S4)
    this.#gone(e.id);
    if (this.#quitting) return;
    if (this.windows.visible().some((x) => x !== e)) {
      this.windows.remove(e.id);
      log.info('close: window %s (%s) closed; %s other window(s) stay open', e.id, e.kind, this.windows.open().length);
      void this.windows.save(`window ${e.id} closed`);
      return;
    }
    if (this.phoneOn()) { // closeDecision(work, true): 'tray' whatever works
      log.info('close (the last window was closed): phone access is on; AIB stays in the tray for the phones (Quit AIB stops it)');
      this.#hideAll();
      this.#background = true;
      this.#idleSince = null;
      this.trayState('background: phone access');
      return;
    }
    await this.decide('the window was closed');
  }

  /** Tray "Quit AIB": the same rule as closing the last window (every window is hidden when AIB stays or leaves, B5). */
  async requestQuit(): Promise<void> {
    if (this.#quitting) return;
    await this.decide('Quit AIB');
  }

  /** Counts every window made or shown again (decide: "a window was opened meanwhile" means this changed). */
  #opens = 0;

  /**
   * Closing the last window or Quit AIB never stops a chat (owner's decisions 2026-11-10 and 2026-11-11). 'quit': nothing works,
   * AIB quits. 'leave': something works and the keeper can hold all of it (canLeave): the windows go, a running merge is let
   * finish, then AIB exits the way Install now does, minus starting a new version: the chats stay in the keeper, which holds them
   * (no restart in the tray) until an AIB is started again; that one takes them over. 'tray': the keeper cannot hold it (off, too
   * old, a chat or terminal command outside it): the windows go, AIB stays in the tray with the status line and quits by itself
   * once nothing has worked for trayIdleQuitMs. With a separate agent host (an older version's, being drained) the app quits at
   * once: the host keeps its chats under its own icon. A window opened meanwhile (Open AIB, a notification) keeps AIB as it is.
   */
  async decide(why = 'quit', _win?: WindowHandle | null): Promise<'quit' | 'leave' | 'tray'> {
    if (this.#leaving) return 'leave';
    if (this.options.stopHost) {
      const busy = await this.busy();
      log.info(
        'close (%s): %s chat(s) working; %s',
        why,
        busy ?? 'unknown',
        busy === 0 ? 'stopping the agent host' : 'they keep running in the agent host',
      );
      await this.quit(false);
      return 'quit';
    }
    const opens = this.#opens;
    const work = await this.work();
    if (this.#quitting) return 'quit';
    if (this.#opens !== opens) {
      log.info('close (%s): a window was opened meanwhile; AIB stays', why);
      return 'tray';
    }
    const total = work ? work.total : null;
    if (closeDecision(total) === 'quit') {
      log.info('close (%s): nothing is working; quitting', why);
      await this.quit(false);
      return 'quit';
    }
    const what = work
      ? `${work.working} chat(s), ${work.terminals} terminal command(s), ${work.merges} merge(s) working`
      : 'what works is unknown';
    let cannot = 'there is no keeper';
    try {
      if (this.options.canLeave) cannot = await this.options.canLeave();
    } catch (error) {
      cannot = error instanceof Error ? error.message : String(error);
    }
    if (this.#quitting) return 'quit';
    if (this.#opens !== opens) {
      log.info('close (%s): a window was opened meanwhile; AIB stays', why);
      return 'tray';
    }
    if (!cannot) {
      log.info('close (%s): %s; nothing is stopped: the keeper holds the chats and AIB exits', why, what);
      this.#hideAll();
      this.#leaving = true;
      if (!await this.#mergesDone()) {
        log.info('close (%s): the window was opened again while a merge finished; AIB stays', why);
        return 'tray';
      }
      await this.quit(false, true);
      return 'leave';
    }
    log.info(
      'close (%s): %s; the keeper cannot hold it (%s): AIB stays in the tray and quits by itself once nothing works',
      why,
      what,
      cannot,
    );
    this.#hideAll();
    this.#background = true;
    this.#idleSince = null;
    this.trayState('background');
    return 'tray';
  }

  /** Quit AIB is leaving the chats to the keeper (waiting for a merge to finish first). Opening the window again calls it off. */
  #leaving = false;

  /** B5: Quit AIB and the tray rule hide every window (they stay open and in the saved list; Open AIB shows them again). */
  #hideAll(): void {
    for (const e of this.windows.open()) {
      try {
        e.handle.hide();
      } catch { /* gone */ }
    }
  }

  /** Wait (up to mergeWaitMs) until no merge runs in this process. False when the window was opened again meanwhile. */
  async #mergesDone(): Promise<boolean> {
    const until = Date.now() + (this.options.mergeWaitMs ?? 120_000);
    const running = () => {
      try {
        return this.options.mergesRunning?.() ?? 0;
      } catch {
        return 0;
      }
    };
    if (running() > 0) log.info('quit: waiting for %s merge(s) to finish before AIB exits', running());
    while (running() > 0 && this.#leaving && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
    return this.#leaving;
  }

  async quit(stopAgents: boolean, leave = false): Promise<void> {
    if (this.#quitting) return;
    this.#quitting = true;
    this.windows.frozen = true; // G8: the list on disk is the one to restore; nothing is written while quitting
    this.stop();
    log.info(
      'quitting: %s',
      stopAgents
        ? 'Stop all chats and quit: stopping every chat'
        : leave
        ? 'the chats stay in the keeper until AIB is started again'
        : 'nothing is working: the idle chats close and keep their history (the next start reopens each as the same chat)',
    );
    try {
      await this.options.stopHost?.(stopAgents);
    } catch { /* not running, or refused: quit anyway */ }
    try {
      this.shell.removeTray?.();
    } catch { /* quitting anyway */ }
    this.trayState('removed');
    // G8: a write asked for before the quit (the list as it was then) lands before AIB exits; frozen, no new one starts.
    await this.windows.writing;
    await this.options.quit(stopAgents, leave);
  }
}
