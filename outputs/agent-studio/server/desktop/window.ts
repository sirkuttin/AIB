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
 *   - `bindings.*` exist in every frame of the window, including cross-origin iframes (artifact pages), so the bound functions
 *     only show notifications, rate-limited.
 */

import { getLogger } from '../core/log.ts';

const log = getLogger('desktop');

export const WINDOW_TITLE = 'AIB';
/** How often the watchdog checks that the visible window still shows our page. */
export const WATCHDOG_MS = 10_000;
/** The keeper window's page: nothing at all. */
export const KEEPER_URL = 'about:blank';
export const GEOMETRY_FILE = 'desktop-window.json';
export const DEFAULT_SIZE = { width: 1280, height: 860 };
export const FIRST_PORT = 8777;

// ---------- pure rules ----------

/** The Tauri app's rule: the first port P from `start` where P and P + 1 (the artifact origin) are both free. */
export function choosePortPair(isFree: (port: number) => boolean, start = FIRST_PORT, tries = 200): number {
  for (let port = start; port < start + tries && port + 1 <= 65535; port++) {
    if (isFree(port) && isFree(port + 1)) return port;
  }
  throw new Error(`No two free ports in a row between ${start} and ${start + tries}`);
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
  const head = busy === null || busy < 1 ? 'Chats may still be working.' : `${busy} chat${busy === 1 ? ' is' : 's are'} still working.`;
  return `${head}\n\nOK: stop them and quit AIB.\nCancel: keep them running; AIB stays in the tray.`;
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
export function keepHidden(win: WindowHandle, label: string): WindowHandle {
  const hide = () => {
    try {
      win.hide();
    } catch { /* gone */ }
  };
  win.on('load', () => {
    hide();
    void win.evaluate('location.href').then((href) => {
      if (typeof href === 'string' && href !== KEEPER_URL) {
        log.warning('%s: loaded %s; hidden and sent back to %s', label, href, KEEPER_URL);
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
}

export interface Notifier {
  /** True when a notification would show now. */
  ready(): Promise<boolean>;
  /** Asks the OS once; 'granted' or 'denied'. */
  request(): Promise<'granted' | 'denied'>;
  show(title: string, body: string): void;
}

export interface Shell {
  createWindow(options: { title: string; width: number; height: number }): WindowHandle;
  /**
   * A hidden window that keeps the runtime alive while the main window is closed (the app lives on in the tray): the runtime exits
   * when no window is left, even while servers run. DesktopApp keeps it on about:blank and hidden (keepKeeperHidden).
   */
  createKeeper(): WindowHandle;
  /**
   * The tray icon: a left click calls onClick, its right-click menu (items) calls onMenu with the chosen item's id. iconDark: the
   * image while the system is in dark mode (Deno.Tray.setIconDark, macOS and Linux), null/absent for none.
   */
  createTray(
    icon: Uint8Array,
    tooltip: string,
    items: TrayItem[],
    onClick: () => void,
    onMenu: (id: string) => void,
    iconDark?: Uint8Array | null,
  ): void;
  /** Removes the tray icon (quitting), so no dead icon is left behind. Never throws. */
  removeTray?(): void;
  /** A native OK/Cancel question; Cancel is the default button. Resolves true for OK. Must not block the event loop. */
  ask(message: string): Promise<boolean>;
  openExternal(url: string): void;
  notifier: Notifier;
}

export interface DesktopOptions {
  /** The page, http://127.0.0.1:PORT/ */
  url: string;
  stateDir: string;
  trayIcon: Uint8Array;
  /** The tray image for dark mode (tray_icon.ts trayIconDarkPng: macOS and Linux), or null. */
  trayIconDark?: Uint8Array | null;
  /** How many chats are working (host.busyConnections().length); a throw counts as unknown. */
  busyCount: () => Promise<number>;
  /**
   * Ask the agent host to stop (host_client.stopHost). Quitting always calls it first, so nothing is left running invisibly once the
   * window and tray are gone: forced after OK ("stop them and quit"), unforced when no chat was working, so a chat that started in
   * the meantime makes the host refuse and keep running. A refusal or failure never holds the quit up.
   */
  stopHost?: (force: boolean) => Promise<unknown>;
  /** The normal close path (the web server). stopAgents: OK was chosen. Never returns in the real app (Deno.exit). */
  quit: (stopAgents: boolean) => Promise<void>;
  saveDelayMs?: number;
  /** The watchdog period; 0 turns it off (tests drive watchdogTick() themselves). Default WATCHDOG_MS. */
  watchdogMs?: number;
}

const SEP = Deno.build.os === 'windows' ? '\\' : '/';

/** The window, the tray and the close/quit questions. */
export class DesktopApp {
  window: WindowHandle | null = null;
  #quitting = false;
  #asking = false;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  readonly origin: string;
  readonly geometryPath: string;
  readonly notifyAllowed = rateLimiter(6, 30_000);
  /** Sending the window back to our page: at most 4 times in 30 s, so a page that fails at once can't make a navigation loop. */
  readonly backAllowed = rateLimiter(4, 30_000);
  keeper: WindowHandle | null = null;
  #watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(readonly shell: Shell, readonly options: DesktopOptions) {
    this.origin = new URL(options.url).origin;
    this.geometryPath = `${options.stateDir}${SEP}${GEOMETRY_FILE}`;
  }

  async start(): Promise<void> {
    await this.openWindow();
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
      [{ id: 'open', label: 'Open AIB' }, { id: 'quit', label: 'Quit AIB' }],
      () => void this.showWindow(),
      (id) => void (id === 'open' ? this.showWindow() : id === 'quit' ? this.requestQuit() : undefined),
      this.options.trayIconDark ?? null,
    );
  }

  /** Stops the watchdog (tests; the real app ends with Deno.exit). */
  stop(): void {
    clearInterval(this.#watchdog);
    this.#watchdog = undefined;
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
  async showWindow(): Promise<void> {
    if (this.#quitting) return;
    const win = this.window;
    if (!win || win.isClosed()) {
      await this.openWindow();
      return;
    }
    try {
      win.show();
      win.focus();
    } catch {
      await this.openWindow();
    }
  }

  bindAll(win: WindowHandle): void {
    const n = this.shell.notifier;
    const text = (v: unknown, max: number) => String(v ?? '').slice(0, max);
    win.bind('aibNotify', (title, body) => {
      if (!this.notifyAllowed()) return false;
      n.show(text(title, 200), text(body, 500));
      return true;
    });
    win.bind('aibNotifyReady', () => n.ready());
    win.bind('aibRequestNotifications', () => n.request());
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
    if (decision === 'ours') return decision;
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

  /** 'quit' (nothing working), 'stop' (OK: stop the agents and quit) or 'tray' (Cancel, or a question already open). */
  async decide(): Promise<'quit' | 'stop' | 'tray'> {
    if (this.#asking) return 'tray';
    const busy = await this.busy();
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
    if (!ok) return 'tray';
    await this.quit(true);
    return 'stop';
  }

  async quit(stopAgents: boolean): Promise<void> {
    if (this.#quitting) return;
    this.#quitting = true;
    this.stop();
    log.info('quitting (stop agents: %s)', stopAgents);
    try {
      await this.options.stopHost?.(stopAgents);
    } catch { /* not running, or refused: quit anyway */ }
    try {
      this.shell.removeTray?.();
    } catch { /* quitting anyway */ }
    await this.options.quit(stopAgents);
  }
}
