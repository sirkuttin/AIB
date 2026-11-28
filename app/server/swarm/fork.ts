/**
 * Fork this session (owner 2026-11-27): the fork's first line and, when the agent cannot copy its own session, the written summary of
 * the chat that starts it. Pure: events in (a chat's live events: `user` and `update` items), text out.
 *
 * The summary is a digest AIB writes itself (no model call): what the user asked first, every later request in a line, the last few
 * messages of both sides in full (clipped). A fork that is an exact copy (the agent's own session/fork) needs none of it.
 */

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface Turn {
  who: 'user' | 'agent';
  text: string;
}

/** The chat's messages in order: a user message, then the agent's reply chunks joined until the next user message. */
export function turnsOf(events: unknown[]): Turn[] {
  const out: Turn[] = [];
  for (const raw of events) {
    const e = obj(raw);
    if (e.kind === 'user') {
      const text = str(obj(e.data).text).trim();
      if (text) out.push({ who: 'user', text });
    } else if (e.kind === 'update') {
      const update = obj(obj(e.data).update);
      if (update.sessionUpdate !== 'agent_message_chunk') continue;
      const text = str(obj(update.content).text);
      if (!text) continue;
      const last = out[out.length - 1];
      if (last && last.who === 'agent') last.text += text;
      else out.push({ who: 'agent', text });
    }
  }
  return out;
}

const oneLine = (t: string, max: number) => {
  const flat = t.replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
};
const clipEnd = (t: string, max: number) => (t.length > max ? t.slice(0, max - 1) + '…' : t);

/** How many closing messages are given in full. */
export const RECENT_MESSAGES = 6;
export const DIGEST_CLIP = 7000;

/** The summary text of a chat (empty chat: says so). */
export function chatDigest(events: unknown[]): string {
  const turns = turnsOf(events);
  if (!turns.length) return 'The chat had no messages yet.';
  const recent = turns.slice(-RECENT_MESSAGES);
  const earlier = turns.slice(0, turns.length - recent.length);
  const asks = earlier.filter((t) => t.who === 'user');
  const lines: string[] = [];
  const first = turns.find((t) => t.who === 'user');
  if (first) lines.push(`What the user first asked: ${clipEnd(first.text.trim(), 900)}`);
  const later = asks.filter((t) => t !== first);
  if (later.length) {
    lines.push('Their later requests, in order:');
    for (const t of later.slice(-20)) lines.push(`- ${oneLine(t.text, 220)}`);
  }
  lines.push(`The last ${recent.length} message(s), newest last:`);
  for (const t of recent) lines.push(`${t.who === 'user' ? 'User' : 'You'}: ${clipEnd(t.text.trim(), 1200)}`);
  return clipEnd(lines.join('\n'), DIGEST_CLIP);
}

/** The first message of a fork that could not copy the session. It starts "Summary of <chat>". */
export function summaryOpening(chat: string, digest: string): string {
  return [
    `Summary of “${chat}”`,
    '',
    `This chat is a fork of “${chat}”. You did not take part in it; below is what happened there, so you can go on from it.`,
    'The user will write to you next. Reply now with one short line saying you have read it, and wait.',
    '',
    digest,
  ].join('\n');
}

/** The line a fork that copied the session starts with (posted in the fork's chat). */
export const copyLine = (chat: string) => `Copy of “${chat}”: this chat is an exact copy of that session, up to now. It waits for your first message.`;
