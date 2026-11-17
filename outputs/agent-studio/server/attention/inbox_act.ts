/**
 * An inbox row's actions that only the server does (Inbox v3.1), for the PC page (POST /api/live/inbox/act) and the phone
 * (POST /api/remote/chat-op): snooze a Needs-you row until a time, wake it, and Continue a stalled chat. Answers, replies, Retry
 * and Mark handled keep their own routes.
 *
 *   snooze   {key, until (s)}: the row leaves the inbox and the count until then, or sooner when it changes (a new request, a new
 *            failure, a new question in a reply, a new stall: inbox-rules.js sigOf / snoozedOf). Saved in the chat's marks
 *            (snoozedUntil, snoozedAt, snoozeSig), never Hold. At most SNOOZE_MAX_SECONDS ahead.
 *   wake     {key}: the snooze is dropped; the row is back at once.
 *   continue {key}: a stalled chat gets "Continue where you left off." A turn gone quiet (S3) is stopped first; a chat whose agent
 *            died (S1) is opened again from its saved session, the same resume path as sending to a closed chat.
 */
import type { WebContext } from '../web/server.ts';
import { INBOX } from './inbox_rules.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});

/** The furthest a snooze may reach (the two choices are 1 hour and tomorrow 9:00). */
export const SNOOZE_MAX_SECONDS = 48 * 3600;
const KEY = /^[a-z0-9][a-z0-9_-]*:[^\s]{1,500}$/;

export type InboxActContext = Pick<WebContext, 'inbox' | 'conversations' | 'host'>;

export async function inboxAct(ctx: InboxActContext, body: unknown): Promise<[number, Json]> {
  const b = obj(body);
  const key = typeof b.key === 'string' ? b.key : '';
  const action = typeof b.action === 'string' ? b.action : '';
  if (!KEY.test(key)) return [400, { error: 'Invalid request' }];
  const at = key.indexOf(':');
  const provider = key.slice(0, at);
  const sessionId = key.slice(at + 1);
  const now = Date.now() / 1000;
  if (action === 'snooze') {
    const until = Math.floor(Number(b.until));
    if (!Number.isFinite(until) || until <= now || until > now + SNOOZE_MAX_SECONDS) return [400, { error: 'Pick a time to snooze until.' }];
    const inbox = await ctx.inbox.look();
    const row = inbox.rows.find((r) => r.key === key && r.section === 'needs');
    const already = inbox.snoozed.find((r) => r.key === key);
    if (!row && !already) return [409, { error: 'This chat no longer needs you.', code: 'gone' }];
    const sig = row ? (row.sig ?? INBOX.sigOf(row)) : String(obj(ctx.conversations.public().entries[key]).snoozeSig ?? '');
    await ctx.conversations.setInbox(provider, sessionId, { snoozedUntil: until, snoozedAt: now, snoozeSig: sig }, {
      title: row?.title ?? already?.title ?? '',
    });
    return [200, { ok: true, until, inbox: await ctx.inbox.look() }];
  }
  if (action === 'wake') {
    await ctx.conversations.setInbox(provider, sessionId, { snoozedUntil: 0, snoozedAt: 0, snoozeSig: '' });
    return [200, { ok: true, inbox: await ctx.inbox.look() }];
  }
  if (action === 'continue') return await sendToChat(ctx, key, INBOX.CONTINUE_TEXT, 'continue');
  return [400, { error: 'Unknown inbox action' }];
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends text to a chat as a new turn (Continue on a stalled row, and a Windows toast's Reply / Retry: desktop/toast_act.ts): stops a
 * quiet turn first, opens a closed chat again from its saved session, then sends the text.
 */
export async function sendToChat(ctx: InboxActContext, key: string, text: string, tag = 'continue'): Promise<[number, Json]> {
  if (!KEY.test(key)) return [400, { error: 'Invalid request' }];
  const at = key.indexOf(':');
  const provider = key.slice(0, at);
  const sessionId = key.slice(at + 1);
  const find = async () => {
    const list = obj(await ctx.host.liveList());
    const all = (Array.isArray(list.connections) ? list.connections : []).map(obj)
      .filter((c) => `${c.provider}:${c.sessionId}` === key);
    return all.find((c) => !c.closed) ?? null;
  };
  let live = await find();
  if (live && live.busy) {
    // gone quiet (S3): the hung turn is stopped first, then Continue goes as a new turn
    await ctx.host.liveCall('cancel', { id: live.id });
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      await wait(150);
      live = await find();
      if (!live || !live.busy) break;
    }
    if (live && live.busy) return [409, { error: 'The turn did not stop. Use Open chat.', code: 'busy' }];
  }
  if (!live) {
    // the agent died (S1): open the chat again from its saved session (the page's resume path: connect with resume)
    const mark = obj(ctx.conversations.public().entries[key]);
    const cwd = typeof mark.cwd === 'string' && mark.cwd ? mark.cwd : typeof mark.projectRoot === 'string' ? mark.projectRoot : '';
    if (!cwd) return [409, { error: 'This chat cannot be opened again from here. Use Open chat.', code: 'no_folder' }];
    const [status, answer] = await ctx.host.liveCall('connect', { provider, cwd, resume: sessionId });
    if (status !== 200) return [status >= 400 && status < 600 ? status : 500, { error: String(obj(answer).error ?? 'The chat could not be opened.') }];
    const id = String(obj(answer).id ?? '');
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      live = await find();
      if (live && live.ready !== false && !live.closed && (!id || live.id === id)) break;
      live = null;
      await wait(200);
    }
    if (!live) return [504, { error: 'The chat is still opening. Try Continue again in a moment.', code: 'opening' }];
  }
  const [status, answer] = await ctx.host.liveCall('prompt', {
    id: live.id,
    text,
    clientMessageId: `${tag}-${key}-${Date.now()}`,
    attachments: [],
  });
  if (status !== 200) return [status >= 400 && status < 600 ? status : 500, { error: String(obj(answer).error ?? (tag === 'continue' ? 'Continue could not be sent.' : 'The message could not be sent.')) }];
  return [200, { ok: true, inbox: await ctx.inbox.look() }];
}
