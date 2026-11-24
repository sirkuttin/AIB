/**
 * Linux notifications with buttons (aib-shared/research/linux-notify-and-update.md, question 1): the same `AIB-keeper toast` helper as
 * on Windows, which on Linux talks to org.freedesktop.Notifications over D-Bus (keeper/toast_fdo.go). Everything else is the Windows
 * route's: the buttons and their one-time codes (toast.ts toastSpec, ToastCodes), the safety rules and the actions (toast_act.ts
 * applyToastClick, unchanged), removing a notification once its request is answered anywhere (CloseNotification), and
 * <data>/toast-inbox.jsonl for a click made while AIB was fully quit (the helper stays for that, at most 12 h, then starts AIB).
 *
 * Differences from Windows:
 *   - a body click is the `default` action; the reply box is KDE's inline reply where the server has `inline-reply`, elsewhere
 *     (GNOME) an Open button that opens the chat itself (act=open&to=chat, applyLinuxClick);
 *   - the chat's line says "Allowed once on desktop notification" (not "Windows notification");
 *   - no quiet-state check (the desktop's Do not disturb holds notifications back by itself);
 *   - the fallback is notify-send (notify.ts posixNotify), used when no notification server with buttons answers.
 * Known issue: on Wayland a click on a running AIB cannot raise its window (the desktop runtime's window has no way to take the
 * click's activation token; it calls only gtk_window_present), so GNOME may show "AIB is ready" instead; the chat still opens. AIB
 * started by a click is handed the token (keeper/toast_linux.go launchAIB; not yet checked on a real Wayland desktop).
 */
import { getLogger } from '../core/log.ts';
import type { WebContext } from '../web/server.ts';
import type { DesktopNotifications, NotifyTarget } from './notify.ts';
import {
  type FdoRegisterInfo,
  keeperToastSpawner,
  type SpawnToastHelper,
  type ToastClick,
  ToastCodes,
  type ToastSpec,
  WindowsToasts,
  type WindowsToastsOptions,
} from './toast.ts';
import { applyToastClick, takePending, type ToastActDeps, toastActDeps, type ToastOutcome } from './toast_act.ts';

const log = getLogger('desktop');
type Json = Record<string, unknown>;

/** Who answered, as the chat's line names it on Linux: "Allowed once on desktop notification". */
export const LINUX_ANSWER_NAME = 'desktop notification';
/** The .desktop file's id (dev.aib.app.desktop in the .deb): GNOME groups AIB's notifications under it. */
export const DESKTOP_ENTRY = 'dev.aib.app';

const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** A show message's fields for the Linux helper (toast_fdo.go): plain text, the body click, the buttons, the reply. */
export function fdoRender(spec: ToastSpec, chat: string): Json {
  const lines = spec.body.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  const reply = spec.buttons.some((b) => b.input);
  return {
    title: spec.title,
    body: lines.join('\n'),
    default: spec.launch,
    buttons: spec.buttons.map((b) => ({ label: b.label, args: b.args, ...(b.input ? { input: b.input } : {}) })),
    ...(spec.input ? { reply: spec.input.placeholder } : {}),
    // GNOME has no inline reply: the reply button becomes Open, which opens the chat to type in
    ...(reply && chat ? { replyOpen: q({ act: 'open', chat, to: 'chat' }) } : {}),
    ...(spec.silent ? { silent: true } : {}),
  };
}

/** A click on a Linux notification: GNOME's Open-for-reply opens the chat itself; everything else is toast_act.ts's. */
export function applyLinuxClick(d: ToastActDeps, click: ToastClick): Promise<ToastOutcome> {
  const p = new URLSearchParams(String(click.args ?? '').slice(0, 2000));
  const chat = p.get('chat') ?? '';
  if (p.get('act') === 'open' && p.get('to') === 'chat' && chat) {
    try {
      d.open({ type: 'chat', key: chat });
    } catch { /* never fatal */ }
    return Promise.resolve({ done: false, act: 'open', reason: 'opened' });
  }
  return applyToastClick(d, click);
}

/** toast_act.ts's deps, with the answer named for Linux. */
export function linuxActDeps(
  ctx: Pick<WebContext, 'inbox' | 'conversations' | 'host'>,
  codes: ToastCodes,
  open: (target: NotifyTarget | null) => void,
  removeToast: (chat: string) => void,
): ToastActDeps {
  const base = toastActDeps(ctx, codes, open, removeToast);
  return { ...base, note: (chatId, requestKey, answer) => base.note(chatId, requestKey, { ...answer, name: LINUX_ANSWER_NAME }) };
}

/** The Windows route class with the Linux settings: plain fields for the helper, notify-send as the fallback, no quiet check. */
export function linuxRoute(
  o: Omit<WindowsToastsOptions, 'mechanism' | 'render' | 'routeName' | 'fallbackName' | 'quietState' | 'register'> & {
    register: FdoRegisterInfo;
  },
): WindowsToasts {
  return new WindowsToasts({
    ...o,
    mechanism: 'linux-notify',
    render: fdoRender,
    routeName: 'Linux notification route',
    fallbackName: 'notify-send',
    quietState: () => null,
  });
}

export interface StartLinuxToastsOptions {
  stateDir: string;
  /** The keeper program (keeper/client.ts keeperBinary). */
  program: string;
  /** AIB's program for a click while AIB is quit ($APPIMAGE, or the installed program; '' in a source run). */
  launch: string;
  /** The app icon PNG on each notification (written to <data>/toast-icon.png). */
  icon: Uint8Array;
  /** Tests: a fake helper (or the real one through wsl.exe) instead of `AIB-keeper toast`. */
  spawn?: SpawnToastHelper;
  pendingEveryMs?: number;
  firstWaitMs?: number;
  settleMs?: number;
}

/**
 * The desktop app on Linux: notifications get buttons through the helper; notify-send stays the fallback. Off with AIB_TOASTS=0.
 * Returns the route, a stop, and the clicks applied from while AIB was quit; null when off.
 */
export function startLinuxToasts(
  ctx: Pick<WebContext, 'inbox' | 'conversations' | 'host'>,
  notifications: DesktopNotifications,
  o: StartLinuxToastsOptions,
): { toasts: WindowsToasts; stop(): void; applied: Promise<ToastOutcome[]> } | null {
  if (Deno.env.get('AIB_TOASTS') === '0' || !notifications.os) return null;
  const fallback = notifications.os;
  const icon = `${o.stateDir}/toast-icon.png`;
  try {
    Deno.writeFileSync(icon, o.icon);
  } catch { /* the server's default icon */ }
  const codes = new ToastCodes({ file: `${o.stateDir}/toast-codes.json` });
  const open = (target: NotifyTarget | null) => notifications.open(target);
  let deps: ToastActDeps | null = null;
  const toasts = linuxRoute({
    spawn: o.spawn ?? keeperToastSpawner(o.program, ['toast'], false),
    register: { name: 'AIB', icon, data: o.stateDir, launch: o.launch, desktop: DESKTOP_ENTRY },
    balloon: fallback,
    codes,
    rowOf: (key) => ctx.inbox.latest()?.rows.find((r) => r.key === key) ?? null,
    onActivated: (click) => {
      if (deps) void applyLinuxClick(deps, click).catch(() => {});
    },
  });
  deps = linuxActDeps(ctx, codes, open, (chat) => toasts.remove(chat));
  const d = deps;
  notifications.use(toasts);
  let firstInbox = () => {};
  const built = new Promise<void>((resolve) => firstInbox = resolve);
  const unwatch = ctx.inbox.watch((inbox) => {
    firstInbox();
    toasts.seeInbox(inbox);
  });
  void toasts.start(); // also stops a helper that still waits from before AIB quit (toast-helper.pid)
  let running: Promise<ToastOutcome[]> = Promise.resolve([]);
  const runPending = () =>
    running = running.then(async () => {
      const out: ToastOutcome[] = [];
      for (const click of takePending(o.stateDir)) {
        out.push(await applyLinuxClick(d, click).catch(() => ({ done: false as const, act: '', reason: 'error' })));
      }
      return out;
    });
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let wait: ReturnType<typeof setTimeout> | undefined;
  const applied = new Promise<void>((resolve) => {
    wait = setTimeout(resolve, o.firstWaitMs ?? 20_000);
    built.then(() => setTimeout(resolve, o.settleMs ?? 3000));
  }).then(() => {
    clearTimeout(wait);
    if (stopped) return [];
    timer = setInterval(() => void runPending(), o.pendingEveryMs ?? 5000);
    return runPending();
  });
  log.info('notifications: Linux notification route on');
  return {
    toasts,
    applied,
    stop() {
      stopped = true;
      clearTimeout(wait);
      clearInterval(timer);
      unwatch();
      toasts.close();
    },
  };
}
