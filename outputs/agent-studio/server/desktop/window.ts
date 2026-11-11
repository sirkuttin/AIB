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

const log = getLogger('desktop');

export const WINDOW_TITLE = 'AIB';
/** How often the watchdog checks that the visible window still shows our page. */
export const WATCHDOG_MS = 10_000;
/** The keeper window's page: nothing at all. */
export const KEEPER_URL = 'about:blank';
export const GEOMETRY_FILE = 'desktop-window.json';
export const DEFAULT_SIZE = { width: 1280, height: 860 };
export const FIRST_PORT = 8777;
/** The tray menu of a tray-only start (`--start-in-tray`): the same items as the agent host's own icon. */
export const TRAY_ONLY_ITEMS: TrayItem[] = [
  { id: 'open', label: 'Open AIB' },
  { id: 'status', label: '', disabled: true },
  { id: 'stop', label: 'Stop chats and quit' },
];

/** The tray-only status line and tooltip for `working` chats, `needsYou` of them waiting for the person. */
export function trayOnlyView(working: number, needsYou: number): { status: string; tooltip: string } {
  const plural = (n: number) => `${n} chat${n === 1 ? '' : 's'}`;
  const status = needsYou
    ? `${plural(needsYou)} need${needsYou === 1 ? 's' : ''} you${working > needsYou ? `, ${working - needsYou} running` : ''}`
    : working
    ? `${plural(working)} running`
    : 'No chat is working';
  return { status, tooltip: `AIB · ${status}` };
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

export type CloseDecision = 'quit' | 'ask';

/** Closing the window: no chat working quits; chats working, or a count that can't be read (null), asks first. */
export function closeDecision(busy: number | null): CloseDecision {
  return busy === 0 ? 'quit' : 'ask';
}

export function closeQuestion(busy: number | null): string {
  // The native box (MessageBoxW) has fixed OK/Cancel labels, so the lines say what each one does.
  const one = busy === 1;
  const head = busy === null || busy < 1 ? 'Chats may still be working.' : `${busy} chat${one ? ' is' : 's are'} still working.`;
  const it = one ? 'it' : 'them';
  return `${head}\n\nOK: stop ${it} and quit AIB.\nCancel: keep ${it} running; AIB stays in the tray.`;
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
  /** 'close' | 'load' | 'resize' | 'move' | 'focus' */
  on(event: string, fn: () => void): void;
  /** Runs code in the page; resolves with its value (or undefined if it failed). */
  evaluate(code: string): Promise<unknown>;
}

export interface TrayItem {
  id: string;
  label: string;
  /** Shown greyed out and never chosen (a status line). */
  disabled?: boolean;
}

/** The page function a notification click calls (notify-ui.js openFromDesktop): true once the page has opened the target. */
export function openTargetScript(target: NotifyTarget | null): string {
  const t = JSON.stringify(target).replace(/</g, '\\u003c');
  return `(function(){var N=window.AgentNotifyUI;return !!(N&&N.openFromDesktop&&N.openFromDesktop(${t}));})()`;
}

export interface Shell {
  createWindow(options: { title: string; width: number; height: number }): WindowHandle;
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
  /** A native OK/Cancel question; Cancel is the default button. Resolves true for OK. Must not block the event loop. */
  ask(message: string): Promise<boolean>;
  openExternal(url: string): void;
  /** The OS notifications (notify.ts), or null where there are none. */
  notifier: OsNotify | null;
  /** Restores the app window if minimised and makes it the foreground window (Windows: foreground_win.ts). */
  bringToFront?(): { found: boolean; restored: boolean; foreground: boolean };
}

export interface DesktopOptions {
  /** The page, http://127.0.0.1:PORT/ */
  url: string;
  stateDir: string;
  trayIcon: Uint8Array;
  /** How many chats are working (host.busyConnections().length); a throw counts as unknown. */
  busyCount: () => Promise<number>;
  /**
   * Ask the agent host to stop (host_client.stopHost). Quitting always calls it first: forced after OK ("stop them and quit"),
   * unforced otherwise, so an idle host goes at once and a host with chats working refuses and keeps them running (under its own
   * tray icon; it exits by itself a few seconds after the last one finishes). A refusal or failure never holds the quit up.
   */
  stopHost?: (force: boolean) => Promise<unknown>;
  /**
   * True (default, today's behaviour): closing the window or Quit AIB while chats work asks "OK: stop them and quit / Cancel: keep
   * them running in the tray". False: no question; the app quits and the working chats go on in the agent host, under the host's
   * own tray icon (docs/app-lifecycle design 4.4, waiting for the owner's decision). Only with a separate host (stopHost given).
   */
  askOnClose?: boolean;
  /** The window loaded our page (the update helper's health marker is written then). */
  onPageLoaded?: () => void;
  /** The normal close path (the web server). stopAgents: OK was chosen. Never returns in the real app (Deno.exit). */
  quit: (stopAgents: boolean) => Promise<void>;
  saveDelayMs?: number;
  /**
   * Start with no window, only the tray icon (`--start-in-tray`: the keeper restarting AIB after a crash, rule V1, so nothing pops
   * up over the person's work). The menu is then Open AIB, a greyed status line ("2 chats running") and Stop chats and quit (asks
   * first). Open AIB makes the window as usual. While no window was ever opened, AIB quits by itself once nothing has worked for
   * trayIdleQuitMs (the chats that were open come back at the next start, as after an idle agent host).
   */
  startInTray?: boolean;
  /** Terminal shells running a command (a tray-only start does not quit while one does: it would end the shell). */
  terminalsBusy?: () => number;
  /** What works now, for the tray-only status line and its idle quit. Default: busyCount, nobody waiting. */
  trayCounts?: () => Promise<{ working: number; needsYou: number }>;
  /** Tray-only start: how long nothing must work before AIB quits by itself (default 10 s; 0 = never). */
  trayIdleQuitMs?: number;
  /** Tray-only start: how often the status line and the idle rule look (default 2 s; 0 = tests call trayTick()). */
  trayPollMs?: number;
  /** The watchdog period; 0 turns it off (tests drive watchdogTick() themselves). Default WATCHDOG_MS. */
  watchdogMs?: number;
}

const SEP = Deno.build.os === 'windows' ? '\\' : '/';

/** The window, the tray and the close/quit questions. */
export class DesktopApp {
  window: WindowHandle | null = null;
  #quitting = false;
  #asking = false;
  #loadedOnce = false;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  readonly origin: string;
  readonly geometryPath: string;
  /** What POST /api/live/desktop/notify shows through; a click opens the chat (openFromNotification). */
  readonly notifications: DesktopNotifications;
  /** Sending the window back to our page: at most 4 times in 30 s, so a page that fails at once can't make a navigation loop. */
  readonly backAllowed = rateLimiter(4, 30_000);
  keeper: WindowHandle | null = null;
  #watchdog: ReturnType<typeof setInterval> | undefined;
  #trayTimer: ReturnType<typeof setInterval> | undefined;
  #trayView: { status: string; tooltip: string } | null = null;
  #idleSince: number | null = null;
  #windowOpened = false;

  constructor(readonly shell: Shell, readonly options: DesktopOptions) {
    this.origin = new URL(options.url).origin;
    this.geometryPath = `${options.stateDir}${SEP}${GEOMETRY_FILE}`;
    this.notifications = new DesktopNotifications(shell.notifier, (target) => void this.openFromNotification(target));
  }

  /**
   * A notification was clicked: the window comes forward (made again if it was closed) and the page opens the chat or the inbox.
   * A window that is still loading gets a few more tries (every 500 ms, up to `tries`). Resolves true once the page took it.
   */
  async openFromNotification(target: NotifyTarget | null, tries = 20, waitMs = 500): Promise<boolean> {
    if (this.#quitting) return false;
    log.info('notify click → %s', target ? (target.type === 'chat' ? 'open the chat' : 'open the inbox') : 'bring AIB to the front');
    await this.showWindow('notification click');
    if (!target) return true;
    for (let i = 0; i < tries; i++) {
      const win = this.window;
      if (!win || win.isClosed()) return false;
      if ((await win.evaluate(openTargetScript(target))) === true) {
        log.info('notify click → the page opened the %s (try %s)', target.type, i + 1);
        return true;
      }
      if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
    }
    log.info('notification click: the page did not open %s', target.type);
    return false;
  }

  async start(): Promise<void> {
    if (!this.options.startInTray) await this.openWindow();
    else log.info('window: started in the tray (no window until Open AIB)');
    try {
      this.keepKeeperHidden(this.shell.createKeeper());
    } catch (error) {
      log.exception(error, 'keeper window could not be made: closing the window will quit AIB');
    }
    const every = this.options.watchdogMs ?? WATCHDOG_MS;
    if (every > 0) this.#watchdog = setInterval(() => void this.watchdogTick(), every);
    if (this.options.startInTray) {
      this.shell.createTray(
        this.options.trayIcon,
        WINDOW_TITLE,
        TRAY_ONLY_ITEMS,
        () => void this.showWindow(),
        (id) => void (id === 'open' ? this.showWindow() : id === 'stop' ? this.requestStop() : undefined),
      );
      await this.trayTick();
      this.trayState('shown');
      const poll = this.options.trayPollMs ?? 2000;
      if (poll > 0) this.#trayTimer = setInterval(() => void this.trayTick(), poll);
      return;
    }
    this.shell.createTray(
      this.options.trayIcon,
      WINDOW_TITLE,
      [{ id: 'open', label: 'Open AIB' }, { id: 'quit', label: 'Quit AIB' }],
      () => void this.showWindow(),
      (id) => void (id === 'open' ? this.showWindow() : id === 'quit' ? this.requestQuit() : undefined),
    );
    this.trayState('shown');
  }

  /** AIB_TEST_TRAY_STATE (tests on an invisible desktop): the app icon's state, like the host's and the helper's. Never throws. */
  trayState(why: string): void {
    import('./host_tray.ts').then(({ writeTrayState }) =>
      writeTrayState('app', {
        shown: why !== 'removed',
        why,
        trayOnly: !!this.options.startInTray,
        windowOpened: this.#windowOpened,
        tooltip: this.#trayView?.tooltip ?? WINDOW_TITLE,
        status: this.#trayView?.status ?? '',
        items: this.options.startInTray
          ? TRAY_ONLY_ITEMS.map((i) => (i.id === 'status' ? this.#trayView?.status ?? '' : i.label))
          : ['Open AIB', 'Quit AIB'],
      })
    ).catch(() => {});
  }

  async #counts(): Promise<{ working: number; needsYou: number } | null> {
    try {
      if (this.options.trayCounts) return await this.options.trayCounts();
      const n = await this.options.busyCount();
      return Number.isInteger(n) && n >= 0 ? { working: n, needsYou: 0 } : null;
    } catch {
      return null;
    }
  }

  /** Tray-only start: refresh the status line; quit once nothing has worked for trayIdleQuitMs while no window was ever opened. */
  async trayTick(now = Date.now()): Promise<void> {
    if (this.#quitting) return;
    const counts = await this.#counts();
    if (counts) {
      const view = trayOnlyView(counts.working, counts.needsYou);
      if (view.status !== this.#trayView?.status) {
        this.#trayView = view;
        try {
          this.shell.updateTray?.(view.tooltip, 1, view.status);
        } catch { /* not fatal */ }
        this.trayState('status');
      }
    }
    const idleMs = this.options.trayIdleQuitMs ?? 10_000;
    if (this.#windowOpened || idleMs <= 0) return;
    let terminals = 0;
    try {
      terminals = this.options.terminalsBusy?.() ?? 0;
    } catch { /* unknown: not busy */ }
    if (!counts || counts.working > 0 || terminals > 0) {
      this.#idleSince = null;
      return;
    }
    this.#idleSince ??= now;
    if (now - this.#idleSince >= idleMs) {
      log.info('tray: started in the tray and nothing has worked for %s s; quitting', Math.round((now - this.#idleSince) / 1000));
      await this.quit(false);
    }
  }

  /** Tray "Stop chats and quit" (tray-only start): asks first when something works, then stops the chats and quits. */
  async requestStop(): Promise<void> {
    if (this.#quitting || this.#asking) return;
    const counts = await this.#counts();
    if (counts && counts.working === 0) {
      await this.quit(false);
      return;
    }
    this.#asking = true;
    let ok = false;
    try {
      const what = counts ? trayOnlyView(counts.working, counts.needsYou).status : 'Chats may still be working';
      ok = await this.shell.ask(`Stop chats and quit AIB?\n\n${what}. Their current turn is interrupted.`);
    } catch {
      ok = false; // no answer: the safe default
    } finally {
      this.#asking = false;
    }
    if (ok) await this.quit(true);
    else log.info('tray: Stop chats and quit cancelled');
  }

  /** Stops the watchdog and the tray-only timer (tests; the real app ends with Deno.exit). */
  stop(): void {
    clearInterval(this.#watchdog);
    this.#watchdog = undefined;
    clearInterval(this.#trayTimer);
    this.#trayTimer = undefined;
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

  /** Every WATCHDOG_MS: the visible window must show our page; the keeper must stay hidden. */
  async watchdogTick(): Promise<void> {
    const keeper = this.keeper;
    if (keeper && !keeper.isClosed() && keeper.isVisible?.() === true) {
      log.warning('watchdog: the keeper window was visible; hiding it');
      try {
        keeper.hide();
      } catch { /* gone */ }
    }
    const win = this.window;
    if (this.#quitting || !win || win.isClosed()) return;
    if (win.isVisible && !win.isVisible()) return;
    await this.checkPage(win, 'watchdog');
  }

  /** A new window on the page, at the saved size and position. */
  async openWindow(): Promise<WindowHandle> {
    const g = await loadGeometry(this.geometryPath);
    const win = this.shell.createWindow({ title: WINDOW_TITLE, width: g.width, height: g.height });
    this.window = win;
    if (!this.#windowOpened) {
      this.#windowOpened = true;
      if (this.options.startInTray) this.trayState('window opened');
    }
    try {
      win.setSize(g.width, g.height);
      if (g.x !== undefined && g.y !== undefined) win.setPosition(g.x, g.y);
    } catch { /* keep the default */ }
    this.bindAll(win);
    win.on('resize', () => this.scheduleSave(win));
    win.on('move', () => this.scheduleSave(win));
    win.on('load', () => void this.checkPage(win, 'load'));
    win.on('close', () => void this.onWindowClosed(win));
    log.info('window: opening %s (%sx%s)', this.options.url, g.width, g.height);
    win.navigate(this.options.url);
    return win;
  }

  /** Tray click, "Open AIB", or a second launch: show and focus the window, or make a new one if it was closed. */
  async showWindow(why = 'show'): Promise<void> {
    if (this.#quitting) return;
    const win = this.window;
    if (!win || win.isClosed()) {
      await this.openWindow();
      this.toFront(why);
      return;
    }
    try {
      win.show();
      win.focus();
    } catch {
      await this.openWindow();
      return;
    }
    this.toFront(why);
  }

  /**
   * show() and focus() neither restore a minimised window nor make it the foreground window: the Shell does that (Windows:
   * foreground_win.ts), now and once more shortly after (the runtime shows the window on its own UI thread a moment later).
   */
  toFront(why: string): void {
    const front = this.shell.bringToFront;
    if (!front) return;
    const once = (when: string) => {
      try {
        const r = front();
        log.info('window to front (%s, %s): found %s, restored %s, foreground %s', why, when, r.found, r.restored, r.foreground);
      } catch { /* not fatal */ }
    };
    once('now');
    setTimeout(() => once('after 250 ms'), 250);
  }

  /** One binding: the page asks it whether it runs in the app (desktop-bridge.js available()). It does nothing else. */
  bindAll(win: WindowHandle): void {
    win.bind('aibDesktop', () => true);
  }

  scheduleSave(win: WindowHandle): void {
    clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => {
      if (win.isClosed()) return;
      try {
        const [width, height] = win.getSize();
        const [x, y] = win.getPosition();
        void saveGeometry(this.geometryPath, { width, height, x, y });
      } catch { /* window gone */ }
    }, this.options.saveDelayMs ?? 500);
  }

  /**
   * The safety net for the link rule and for the runtime: after every load (and from the watchdog), the window must show our page.
   * A real external site opens in the system browser; anything else that isn't ours (another port on this machine, an error page,
   * about:blank) is never handed outside. Either way the window goes back to our page, rate-limited. Returns the decision.
   */
  async checkPage(win: WindowHandle, why = 'load'): Promise<PageDecision | null> {
    if (why === 'load') {
      try {
        win.setTitle(WINDOW_TITLE);
      } catch { /* not fatal */ }
    }
    const page = parseProbe(await win.evaluate(PAGE_PROBE));
    if (!page) return null; // can't read it now: the next load or watchdog tick looks again
    const decision = pageDecision(page.href, this.origin);
    if (why === 'load') log.info('window: loaded %s (%s)', page.href, decision);
    if (decision === 'ours') {
      if (why === 'load' && !this.#loadedOnce) {
        this.#loadedOnce = true;
        try {
          this.options.onPageLoaded?.();
        } catch { /* not fatal */ }
      }
      return decision;
    }
    if (win !== this.window || win.isClosed() || this.#quitting) return decision;
    if (decision === 'external') {
      log.info('window: %s is an outside site: opening it in the browser', page.href);
      this.shell.openExternal(page.href);
    }
    if (!this.backAllowed()) {
      log.warning('window: on %s (%s, %s); not sent back: too many tries in a row', page.href, decision, why);
      return decision;
    }
    log.warning('window: on %s (%s, %s); sending it back to %s', page.href, decision, why, this.options.url);
    win.navigate(this.options.url);
    return decision;
  }

  async busy(): Promise<number | null> {
    try {
      const n = await this.options.busyCount();
      return Number.isInteger(n) && n >= 0 ? n : null;
    } catch {
      return null;
    }
  }

  /** The window was closed (it is already gone): quit, or ask when chats are working. */
  async onWindowClosed(win: WindowHandle): Promise<void> {
    clearTimeout(this.#saveTimer);
    if (this.#quitting || win !== this.window) return;
    const answer = await this.decide();
    if (answer === 'tray' && !win.isClosed()) {
      try {
        win.hide();
      } catch { /* gone */ }
    }
  }

  /** Tray "Quit AIB": the same question. */
  async requestQuit(): Promise<void> {
    if (this.#quitting) return;
    await this.decide();
  }

  /**
   * 'quit' (nothing working), 'stop' (OK: stop the agents and quit) or 'tray' (Cancel, or a question already open). With
   * askOnClose false and a separate agent host (stopHost given), closing never asks and never stops a chat: the app quits, the host
   * keeps the working chats running and shows its own tray icon until they finish or an app attaches again.
   */
  async decide(): Promise<'quit' | 'stop' | 'tray'> {
    if (this.#asking) return 'tray';
    const busy = await this.busy();
    if (this.options.stopHost && this.options.askOnClose === false) {
      log.info('close: %s chat(s) working; %s', busy ?? 'unknown', busy === 0 ? 'stopping the agent host' : 'they keep running in the agent host');
      await this.quit(false);
      return 'quit';
    }
    log.info('close: %s chat(s) working; %s', busy ?? 'unknown', closeDecision(busy) === 'quit' ? 'quitting' : 'asking');
    if (closeDecision(busy) === 'quit') {
      await this.quit(false);
      return 'quit';
    }
    this.#asking = true;
    let ok = false;
    try {
      ok = await this.shell.ask(closeQuestion(busy));
    } catch {
      ok = false; // no answer: the safe default
    } finally {
      this.#asking = false;
    }
    log.info('close: answered %s', ok ? 'OK (stop the chats and quit)' : 'Cancel (keep the chats running; AIB stays in the tray)');
    if (!ok) return 'tray';
    await this.quit(true);
    return 'stop';
  }

  async quit(stopAgents: boolean): Promise<void> {
    if (this.#quitting) return;
    this.#quitting = true;
    this.stop();
    log.info('quitting: %s', stopAgents ? 'stopping the working chats and the agent host' : 'no chat is stopped (an idle agent host stops, a busy one keeps running)');
    try {
      await this.options.stopHost?.(stopAgents);
    } catch { /* not running, or refused: quit anyway */ }
    try {
      this.shell.removeTray?.();
    } catch { /* quitting anyway */ }
    this.trayState('removed');
    await this.options.quit(stopAgents);
  }
}
