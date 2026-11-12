/**
 * The desktop app's own notifications ("Needs you", "Your turn", the grouped "3 agents are waiting for you", the Settings test).
 * The server decides WHEN to notify (attention/watcher.ts: the AttentionWatcher and its Notifier, with the page's own rules from
 * notify-rules.js: transitions, grouping, never while an AIB window has focus), so they also come with the window closed; the page
 * only sends the Settings test with POST /api/live/desktop/notify. The app process shows them natively, not through the web
 * Notification API (WebView2 has no browser permission prompt and no site settings, so the web API was simply "blocked").
 *
 * Per OS (the OS layer is injected, so all of this is tested with fakes in work/deno/desktop_notify_test.ts):
 *   - Windows: a balloon on AIB's own tray icon (Shell_NotifyIconW NIM_MODIFY + NIF_INFO, tray_win.ts balloonData). Windows 10 and
 *     11 show it as a toast and keep it in the notification centre; a click comes back to the tray thread as NIN_BALLOONUSERCLICK,
 *     which brings the AIB window forward and opens that chat. Nothing is installed, no shortcut AppUserModelID or COM activator is
 *     needed, and no process is started. Before showing, SHQueryUserNotificationState is asked: in presentation mode, quiet time,
 *     or with a full-screen app, nothing is shown; Do not disturb / Focus is applied by Windows itself (it holds the toast back).
 *   - macOS: `osascript` with `display notification` (the text goes in as arguments, never into the script).
 *   - Linux: `notify-send` when it is installed. Either missing: nothing is shown and the reason is reported once in the log.
 *   Both run hidden (stdin/stdout/stderr null) and are killed after 10 s.
 */
import { clip, isDict, isStr, ValueError } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import { rateLimiter } from './window.ts';

const log = getLogger('desktop');

export const MAX_TITLE = 200;
export const MAX_BODY = 500;
export const MAX_KEY = 400;

export type NotifyTarget = { type: 'chat'; key: string } | { type: 'inbox' };

export interface NotifyRequest {
  title: string;
  body: string;
  /** What a click opens; null: just bring AIB forward. */
  target: NotifyTarget | null;
  /** The Settings test button. */
  test: boolean;
}

export interface ShowResult {
  shown: boolean;
  /** Why it was not shown, as the end of a sentence ("Not shown: <reason>."). */
  reason?: string;
  /** The OS call's result (Shell_NotifyIconW's BOOL, a command's exit code), for the log and the tests. */
  code?: number;
}

/** One OS route: shows one notification (a newer one replaces the older where the OS allows it) and reports clicks. */
export interface OsNotify {
  /** 'windows-balloon' | 'osascript' | 'notify-send' */
  mechanism: string;
  show(title: string, body: string): Promise<ShowResult>;
  /** Registers the click handler (Windows only; elsewhere a click is the OS's business). */
  onClick?(fn: () => void): void;
}

/** Drops control characters except tab and new lines (no regex: the linter refuses control characters in one). */
const control = (s: string) =>
  [...s].filter((ch) => {
    const c = ch.charCodeAt(0);
    return c === 9 || c === 10 || c === 13 || (c >= 32 && c !== 127);
  }).join('');

/** The route's body, checked and cut: {title, body, target?: {type: 'chat', key} | {type: 'inbox'}, test?: boolean}. */
export function cleanNotifyRequest(raw: unknown): NotifyRequest {
  if (!isDict(raw)) throw new ValueError('Invalid notification');
  const title = isStr(raw.title) ? clip(control(raw.title).trim(), MAX_TITLE) : '';
  const body = isStr(raw.body) ? clip(control(raw.body).trim(), MAX_BODY) : '';
  if (!title && !body) throw new ValueError('A notification needs a title or a text');
  let target: NotifyTarget | null = null;
  const t = raw.target;
  if (isDict(t)) {
    if (t.type === 'chat' && isStr(t.key) && t.key && t.key.length <= MAX_KEY) target = { type: 'chat', key: t.key };
    else if (t.type === 'inbox') target = { type: 'inbox' };
  }
  return { title: title || 'AIB', body, target, test: raw.test === true };
}

// ---------- Windows ----------

/** SHQueryUserNotificationState's answers (QUERY_USER_NOTIFICATION_STATE). */
export const QUNS = {
  NOT_PRESENT: 1,
  BUSY: 2,
  RUNNING_D3D_FULL_SCREEN: 3,
  PRESENTATION_MODE: 4,
  ACCEPTS_NOTIFICATIONS: 5,
  QUIET_TIME: 6,
  APP: 7,
} as const;

/** Why Windows does not want a notification now, or null to go ahead (also when the state could not be read). */
export function quietReason(state: number | null): string | null {
  switch (state) {
    case QUNS.BUSY:
    case QUNS.RUNNING_D3D_FULL_SCREEN:
    case QUNS.APP:
      return 'an app is running full screen';
    case QUNS.PRESENTATION_MODE:
      return 'Windows is in presentation mode';
    case QUNS.QUIET_TIME:
      return 'Windows is in quiet time';
    default:
      return null; // ACCEPTS_NOTIFICATIONS, NOT_PRESENT (locked: it waits in the notification centre), or unknown
  }
}

export interface WindowsLayer {
  /** Shell_NotifyIconW(NIM_MODIFY, NIF_INFO ...) on AIB's tray icon: its BOOL result, or null when the tray icon isn't running. */
  balloon(title: string, body: string): number | null;
  /** SHQueryUserNotificationState's state, or null when it failed. */
  quietState(): number | null;
}

export function windowsNotify(layer: WindowsLayer): OsNotify & { clicked(): void } {
  let click: (() => void) | null = null;
  return {
    mechanism: 'windows-balloon',
    show(title, body) {
      const quiet = quietReason(layer.quietState());
      if (quiet) return Promise.resolve({ shown: false, reason: quiet });
      const code = layer.balloon(title, body);
      if (code === null) return Promise.resolve({ shown: false, reason: "AIB's tray icon isn't running" });
      return Promise.resolve(code !== 0 ? { shown: true, code } : { shown: false, reason: 'Windows refused it', code });
    },
    onClick(fn) {
      click = fn;
    },
    clicked() {
      click?.();
    },
  };
}

// ---------- macOS and Linux ----------

/** A leading '-' would be read as an option by osascript: an en dash looks the same. */
const noOption = (s: string) => s.replace(/^-/, '\u2013');

/** The command that shows one notification, or null on an OS without one. Text only ever goes in as separate arguments. */
export function posixCommand(os: string, title: string, body: string): { cmd: string; args: string[] } | null {
  if (os === 'darwin') {
    return {
      cmd: 'osascript',
      args: [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv)',
        '-e',
        'end run',
        noOption(title),
        noOption(body),
      ],
    };
  }
  if (os === 'linux' || os === 'freebsd' || os === 'netbsd' || os === 'openbsd') {
    return { cmd: 'notify-send', args: ['--app-name=AIB', '--', title, body] };
  }
  return null;
}

/** Runs a command hidden; resolves with its exit code, or 'missing' when the program isn't installed. */
export type Runner = (cmd: string, args: string[]) => Promise<number | 'missing'>;

export const runHidden: Runner = async (cmd, args) => {
  let child: Deno.ChildProcess;
  try {
    child = new Deno.Command(cmd, { args, stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 'missing';
    throw error;
  }
  const timer = setTimeout(() => {
    try {
      child.kill();
    } catch { /* already gone */ }
  }, 10_000);
  try {
    return (await child.status).code;
  } finally {
    clearTimeout(timer);
  }
};

export function posixNotify(os: string, run: Runner = runHidden): OsNotify | null {
  const probe = posixCommand(os, '', '');
  if (!probe) return null;
  let missing = false;
  return {
    mechanism: probe.cmd,
    async show(title, body) {
      const why = probe.cmd === 'osascript' ? "osascript isn't available" : "notify-send isn't installed";
      if (missing) return { shown: false, reason: why };
      const c = posixCommand(os, title, body)!;
      let code: number | 'missing';
      try {
        code = await run(c.cmd, c.args);
      } catch {
        return { shown: false, reason: `${c.cmd} could not start` };
      }
      if (code === 'missing') {
        missing = true;
        log.info('notifications: %s is not installed; desktop notifications are off', c.cmd);
        return { shown: false, reason: why };
      }
      return code === 0 ? { shown: true, code } : { shown: false, reason: `${c.cmd} failed`, code };
    },
  };
}

// ---------- what the route talks to ----------

/** The route's side: rate limit, remember what a click opens, show. Clicks call `open` with the last notification's target. */
export class DesktopNotifications {
  #last: NotifyTarget | null = null;

  constructor(
    readonly os: OsNotify | null,
    readonly open: (target: NotifyTarget | null) => void,
    readonly allowed: () => boolean = rateLimiter(6, 30_000),
  ) {
    os?.onClick?.(() => this.clicked());
  }

  get mechanism(): string {
    return this.os?.mechanism ?? 'none';
  }

  async show(req: NotifyRequest): Promise<ShowResult> {
    if (!this.os) return { shown: false, reason: 'this system has no notifications AIB can use' };
    if (!this.allowed()) return { shown: false, reason: 'too many notifications in a row; try again in a moment' };
    let result: ShowResult;
    try {
      result = await this.os.show(req.title, req.body);
    } catch (error) {
      result = { shown: false, reason: 'the system refused it' };
      log.info('notifications: %s failed: %s', this.os.mechanism, error);
    }
    if (result.shown) this.#last = req.target;
    else if (req.test) log.info('notifications: test not shown (%s)', result.reason);
    return result;
  }

  /** The notification was clicked: bring AIB forward and open what it was about. */
  clicked(): void {
    const target = this.#last;
    log.info('notify click → %s', target ? `${target.type}` : 'no chat (a test, or before any notification)');
    try {
      this.open(target);
    } catch { /* never fatal */ }
  }
}
