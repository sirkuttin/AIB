/**
 * Buttons on phone notifications (0.13: the Windows toasts' buttons, desktop/toast.ts, on the phone). The service worker shows them
 * with the Notifications API's `actions` (pwa/sw.js); a tap comes back here as POST /api/remote/notify-act (remote/server.ts).
 *
 * Android Chrome shows at most two buttons, so each kind gets its two most useful (the toast's buttons, in toastActs, cut to two):
 *   approval   Allow · Deny (the agent's once-options); Allow · Open when there is no Deny; a risky command (push, force push,
 *              delete), AIB's merge request, an option a phone may not pick, or a phone without Approve: Open
 *   asks, finished  Reply · Open. Chrome has no text box on a web notification: Reply opens the phone page on that chat's composer
 *              with the keyboard up (pwa/sw.js, phone.js #chat=<id>&reply=1). Without Send: Open
 *   stalled    Continue · Open (Send)       failed  Retry · Open (Send)       a question form, a sign-in: Open
 *   grouped    ("3 chats need you") no buttons; a tap opens the phone page
 * Each answering button (Allow, Deny, Continue, Retry) carries a one-time code (ToastCodes, own file push-codes.json) issued for that
 * phone, that chat and that request, refused when it is expired, used, for another phone or the request was answered anywhere.
 * The tap is checked again as the row is now (a request that became risky never gets Allow) and against the phone's switches now.
 */
import { INBOX, type InboxRow } from '../attention/inbox_rules.ts';
import { onceOptions, type ToastAct, toastActs } from '../desktop/toast.ts';
import { phoneOptions } from './actions.ts';

export type PushAct = ToastAct;

/** What Android Chrome shows at most (Notification.maxActions there). */
export const MAX_PUSH_ACTIONS = 2;

/** The button words on the phone. */
export const PUSH_ACT_TITLES: Readonly<Record<PushAct, string>> = {
  allow: 'Allow',
  deny: 'Deny',
  reply: 'Reply',
  continue: 'Continue',
  retry: 'Retry',
  open: 'Open',
};

/** The buttons that act on AIB (a code is issued for them); Reply and Open only open the phone page. */
export const CODED_ACTS: readonly PushAct[] = ['allow', 'deny', 'continue', 'retry'];

/** The switch a button needs (Settings > Remote control): Approve once for Allow / Deny, Send for the rest. */
export function scopeOfAct(act: string): string {
  return act === 'allow' || act === 'deny' ? 'phone.approve' : 'phone.prompt';
}

/** May a phone pick this once-option (remote/actions.ts phoneOptions: not a mode switch, not "always", not a merge)? */
function phonePicks(row: InboxRow, optionId: string | undefined): boolean {
  if (!optionId || row.request?.kind !== 'permission') return false;
  return phoneOptions(row.request.params).options.some((o) => o.optionId === optionId);
}

/** The (at most two) buttons a row's phone notification gets, for a phone with these switches, in order. */
export function pushActs(row: InboxRow | null, scopes: readonly string[]): PushAct[] {
  if (!row) return [];
  const can = (act: PushAct) => act === 'open' || scopes.includes(scopeOfAct(act));
  let acts = toastActs(row);
  if (row.kind === 'approval' && acts.includes('allow')) {
    const { allow, deny } = onceOptions(row);
    if (!phonePicks(row, allow?.optionId) || !can('allow')) acts = ['open'];
    else acts = deny && phonePicks(row, deny.optionId) ? ['allow', 'deny'] : ['allow', 'open'];
  }
  if (acts.includes('reply')) acts = ['reply', 'open'];
  acts = acts.filter(can);
  if (!acts.length) acts = ['open'];
  return acts.slice(0, MAX_PUSH_ACTIONS);
}

/** The row's signature (the request it is about): a code is good only while it is the same. */
export const rowSig = (row: InboxRow): string => row.sig ?? INBOX.sigOf(row);

export interface PushButtons {
  /** The row key (provider:sessionId) the buttons act on. */
  key: string;
  actions: { action: PushAct; title: string }[];
  /** The one-time code for the answering buttons, '' when there are none. */
  code: string;
}

/**
 * The buttons for one phone's notification about one chat, with a fresh code when any of them answers (issue: ToastCodes.issue for
 * this phone). null: no buttons (no row, or nothing but a grouped notification).
 */
export function pushButtons(
  row: InboxRow | null,
  scopes: readonly string[],
  issue: (chat: string, sig: string, acts: PushAct[]) => string,
): PushButtons | null {
  if (!row) return null;
  const acts = pushActs(row, scopes);
  if (!acts.length) return null;
  const coded = acts.filter((a) => CODED_ACTS.includes(a));
  const code = coded.length ? issue(row.key, rowSig(row), coded) : '';
  return { key: row.key, actions: acts.map((action) => ({ action, title: PUSH_ACT_TITLES[action] })), code };
}

/** Words for a tap that did not work, as the phone page shows them (phone.js NOTIFY_NOTES has the same keys). */
export const NOTIFY_NOTES: Readonly<Record<string, string>> = {
  expired: 'That notification is too old. Answer it here.',
  used: 'That button was already used.',
  answered: 'This was already answered.',
  unknown: 'That notification is no longer valid. Answer it here.',
  wrong_device: 'That notification was for another device.',
  wrong_chat: 'That notification is no longer valid. Answer it here.',
  not_allowed: 'Check this one here first.',
  scope: 'This phone may not do that. Turn it on in AIB on your PC: Settings → Remote control.',
  offline: 'AIB could not be reached. Try again here.',
  failed: 'That did not work. Try again here.',
};
