/**
 * A click on a Windows toast (toast.ts), applied by the AIB server. A button acts only with a good one-time code for a request that
 * is still open (ToastCodes.check) and only when that row would still get that button (a risky command never gets Allow); anything
 * else just opens the chat's row in the inbox, so a crafted activation can never approve anything.
 *
 *   allow / deny  the agent's allow_once / reject_once option, logged as answered on "Windows notification" (answers.ts, by 'pc')
 *   reply         the typed text as a new turn (an empty box opens the chat)
 *   continue      the stalled row's Continue (inbox_act.ts)
 *   retry         the last message again, text only (as the inbox's Retry)
 *   open, a body click, a refused click: the inbox on that chat's row; the grouped toast: the inbox
 * A click made while AIB was fully quit was written by the helper to <data>/toast-inbox.jsonl; takePending applies those after
 * start-up, by the same rules.
 */
import { getLogger } from '../core/log.ts';
import type { InboxRow } from '../attention/inbox_rules.ts';
import { INBOX } from '../attention/inbox_rules.ts';
import { answersOf } from '../attention/answers.ts';
import { inboxAct, lastUserText, sendToChat } from '../attention/inbox_act.ts';
import type { WebContext } from '../web/server.ts';
import type { DesktopNotifications, NotifyTarget } from './notify.ts';
import {
  keeperToastSpawner,
  onceOptions,
  openTarget,
  parseToastArgs,
  type SpawnToastHelper,
  TOAST_APP_ID,
  TOAST_CLSID,
  type ToastAct,
  toastActs,
  type ToastClick,
  ToastCodes,
  WindowsToasts,
} from './toast.ts';

const log = getLogger('desktop');
type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

/** Who answered, as the chat's line names it: "Allowed once on Windows notification". */
export const TOAST_ANSWER_NAME = 'Windows notification';

export interface ToastActDeps {
  look(): Promise<{ rows: InboxRow[] }>;
  liveCall(name: string, body: Json): Promise<[number, unknown]>;
  liveState(id: string, after: number): Promise<unknown>;
  /** The stalled row's Continue (inbox_act.ts inboxAct). */
  continueChat(key: string): Promise<[number, Json]>;
  /** A new turn with this text (inbox_act.ts sendToChat). */
  sendText(key: string, text: string, tag: string): Promise<[number, Json]>;
  note(chatId: string, requestKey: string, answer: { by: string; name: string; option: string }): void;
  codes: ToastCodes;
  /** Brings AIB forward on this (DesktopNotifications.open). */
  open(target: NotifyTarget | null): void;
  /** The chat's toast is done (toast.ts WindowsToasts.remove). */
  removeToast(chat: string): void;
}

/** done: the button did its work; else why not (the chat was opened instead). */
export interface ToastOutcome {
  done: boolean;
  act: string;
  reason?: string;
}

/** The deps from the web context. */
export function toastActDeps(
  ctx: Pick<WebContext, 'inbox' | 'conversations' | 'host'>,
  codes: ToastCodes,
  open: (target: NotifyTarget | null) => void,
  removeToast: (chat: string) => void,
): ToastActDeps {
  return {
    look: () => ctx.inbox.look(),
    liveCall: (name, body) => ctx.host.liveCall(name, body) as Promise<[number, unknown]>,
    liveState: (id, after) => ctx.host.liveState(id, after),
    continueChat: (key) => inboxAct(ctx, { key, action: 'continue' }),
    sendText: (key, text, tag) => sendToChat(ctx, key, text, tag),
    note: (chatId, requestKey, answer) => answersOf(ctx).note(chatId, requestKey, answer),
    codes,
    open,
    removeToast,
  };
}

/** The last message you sent in this chat (the inbox's Retry sends it again), or '' (attention/inbox_act.ts, shared). */
export { lastUserText };

export async function applyToastClick(d: ToastActDeps, click: ToastClick): Promise<ToastOutcome> {
  const { act, chat, code } = parseToastArgs(click.args);
  const opened = (reason: string, target: NotifyTarget | null = openTarget(chat)): ToastOutcome => {
    try {
      d.open(target);
    } catch { /* never fatal */ }
    return { done: false, act, reason };
  };
  if (act === 'inbox') return opened('opened', { type: 'inbox' });
  if (act === 'front') return opened('opened', null);
  if (!chat) return opened('no chat', null);
  if (act === 'open') return opened('opened');
  if (!['allow', 'deny', 'reply', 'continue', 'retry'].includes(act)) return opened('unknown button');
  let row: InboxRow | null = null;
  try {
    row = (await d.look()).rows.find((r) => r.key === chat) ?? null;
  } catch { /* checked as gone */ }
  const sig = row ? (row.sig ?? INBOX.sigOf(row)) : null;
  const verdict = d.codes.check(code, chat, act, sig);
  if (!verdict.ok) {
    log.info('notifications: toast %s refused (%s); opening the chat', act, verdict.reason);
    // still waiting: its row in the inbox (Review for a risky command); answered or gone: the chat itself
    return opened(verdict.reason, row ? openTarget(chat) : { type: 'chat', key: chat });
  }
  // the row as it is now must still get this button (a request that became risky, or a PC-only one, never gets Allow)
  if (!row || !toastActs(row).includes(act as ToastAct)) return opened('not_allowed');
  const ok = (status: number, what: string): ToastOutcome => {
    if (status === 200) {
      d.removeToast(chat);
      log.info('notifications: toast %s applied', act);
      return { done: true, act };
    }
    return opened(what);
  };
  if (act === 'allow' || act === 'deny') {
    const { allow, deny } = onceOptions(row);
    const option = act === 'allow' ? allow : deny;
    if (!option || row.request?.kind !== 'permission') return opened('not_allowed');
    const [status] = await d.liveCall('permission', { id: row.id, key: row.request.key, option: option.optionId });
    if (status === 200) d.note(row.id, row.request.key, { by: 'pc', name: TOAST_ANSWER_NAME, option: option.optionId });
    return ok(status, 'answer failed');
  }
  if (act === 'reply') {
    const text = String(click.inputs.reply ?? '').trim();
    if (!text) return opened('empty reply');
    return ok((await d.sendText(chat, text, 'toast-reply'))[0], 'reply failed');
  }
  if (act === 'continue') return ok((await d.continueChat(chat))[0], 'continue failed');
  // retry: the last message again
  let text = '';
  try {
    text = lastUserText(await d.liveState(row.id, 1));
  } catch { /* none */ }
  if (!text) return opened('nothing to retry');
  return ok((await d.sendText(chat, text, 'toast-retry'))[0], 'retry failed');
}

/** The helper's file of clicks made while AIB was fully quit. */
export const pendingFile = (dataDir: string) => `${dataDir}/toast-inbox.jsonl`;

/** Reads and empties <data>/toast-inbox.jsonl; returns its clicks (at most 20, the newest last). */
export function takePending(dataDir: string): ToastClick[] {
  const file = pendingFile(dataDir);
  const taking = `${file}.taking`;
  try {
    Deno.renameSync(file, taking);
  } catch {
    return [];
  }
  let text = '';
  try {
    text = Deno.readTextFileSync(taking);
  } catch { /* gone */ }
  try {
    Deno.removeSync(taking);
  } catch { /* gone */ }
  const out: ToastClick[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = obj(JSON.parse(line));
      const inputs: Record<string, string> = {};
      for (const [k, x] of Object.entries(obj(v.inputs))) if (typeof x === 'string') inputs[k] = x;
      if (typeof v.args === 'string') out.push({ args: v.args, inputs });
    } catch { /* a torn line */ }
  }
  return out.slice(-20);
}

export interface StartToastsOptions {
  stateDir: string;
  /** The keeper program (keeper/client.ts keeperBinary). */
  program: string;
  /** AIB's program for a click while AIB is closed ('' in a source run). */
  launch: string;
  /** The app icon PNG Windows shows on each toast (written to <data>/toast-icon.png). */
  icon: Uint8Array;
  /** SHQueryUserNotificationState (tray_win.ts userNotificationState). */
  quietState: () => number | null;
  /** Tests: a fake helper instead of `AIB-keeper toast`. */
  spawn?: SpawnToastHelper;
  /** How often the clicks made while AIB was closed are looked for (ms). */
  pendingEveryMs?: number;
  /** The longest wait for the first inbox before those clicks are applied anyway, and the pause after it (ms). */
  firstWaitMs?: number;
  settleMs?: number;
}

const winPath = (p: string) => p.replace(/\//g, '\\');

/**
 * The desktop app on Windows: notifications become toasts with buttons (the balloon stays as the fallback). Off with AIB_TOASTS=0.
 * Returns the route, a stop, and the clicks applied from while AIB was closed; null when off.
 */
export function startWindowsToasts(
  ctx: Pick<WebContext, 'inbox' | 'conversations' | 'host'>,
  notifications: DesktopNotifications,
  o: StartToastsOptions,
): { toasts: WindowsToasts; stop(): void; applied: Promise<ToastOutcome[]> } | null {
  if (Deno.env.get('AIB_TOASTS') === '0' || !notifications.os) return null;
  const balloon = notifications.os;
  const icon = `${o.stateDir}/toast-icon.png`;
  try {
    Deno.writeFileSync(icon, o.icon);
  } catch { /* Windows shows its default icon */ }
  const codes = new ToastCodes({ file: `${o.stateDir}/toast-codes.json` });
  const open = (target: NotifyTarget | null) => notifications.open(target);
  let deps: ToastActDeps | null = null;
  const toasts = new WindowsToasts({
    spawn: o.spawn ?? keeperToastSpawner(o.program),
    register: { appId: TOAST_APP_ID, name: 'AIB', icon: winPath(icon), clsid: TOAST_CLSID, data: winPath(o.stateDir), launch: o.launch },
    balloon,
    quietState: o.quietState,
    codes,
    rowOf: (key) => ctx.inbox.latest()?.rows.find((r) => r.key === key) ?? null,
    onActivated: (click) => {
      if (deps) void applyToastClick(deps, click).catch(() => {});
    },
  });
  deps = toastActDeps(ctx, codes, open, (chat) => toasts.remove(chat));
  const d = deps;
  notifications.use(toasts);
  let firstInbox = () => {};
  const built = new Promise<void>((resolve) => firstInbox = resolve);
  const unwatch = ctx.inbox.watch((inbox) => {
    firstInbox();
    toasts.seeInbox(inbox);
  });
  void toasts.start(); // registers AIB's app id and click handler now (HKCU), so a click works even after AIB quits
  let running: Promise<ToastOutcome[]> = Promise.resolve([]);
  const runPending = () =>
    running = running.then(async () => {
      const out: ToastOutcome[] = [];
      for (const click of takePending(o.stateDir)) {
        out.push(await applyToastClick(d, click).catch(() => ({ done: false as const, act: '', reason: 'error' })));
      }
      return out;
    });
  // a click made while AIB was closed: applied once the first inbox is built and the chats had a moment to come back
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
