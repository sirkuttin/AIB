/**
 * ReplayWindow (a session/load replay held while it arrives), outsideTurns, and the quiet / follow-up timing helpers.
 * Moved out of connection.ts (no change).
 */
import { INBOX } from '../attention/inbox_rules.ts';
import { isDict, isStr, pyStrip } from '../core/py.ts';
import { MAX_EVENTS, type Json, get } from './conn_util.ts';

/** The most of a session/load replay a ReplayWindow holds, in JSON bytes (besides MAX_EVENTS updates). */
export const REPLAY_WINDOW_BYTES = 32 * 1024 * 1024;

/**
 * A session/load replay held while it arrives (a reopened chat, or one taken back after a hand-off: only the outside turns at its
 * END are shown, outsideTurns): its NEWEST updates, at most `max` of them and `maxBytes` of JSON, the oldest dropped first, so
 * memory stays bounded whatever the transcript's length. Until 0.12.1 the OLDEST MAX_EVENTS were kept: the end of a long transcript
 * was lost, a generic last message ("[Request interrupted by user]") matched an old turn, and every later turn of the first 6000
 * updates came back as "from outside AIB" (24 old turns in the owner's WSL chat, 2026-11-17).
 */
export class ReplayWindow {
  #items: (Json | null)[] = [];
  #sizes: number[] = [];
  #head = 0;
  #bytes = 0;
  /** Updates received, and dropped (the oldest, over the bounds). */
  received = 0;
  dropped = 0;
  constructor(readonly max = MAX_EVENTS, readonly maxBytes = REPLAY_WINDOW_BYTES) {}

  push(params: Json): void {
    let size = 0;
    try {
      size = JSON.stringify(params)?.length ?? 0;
    } catch { /* not JSON: counted as nothing */ }
    this.#items.push(params);
    this.#sizes.push(size);
    this.#bytes += size;
    this.received += 1;
    while (this.length > 1 && (this.length > this.max || this.#bytes > this.maxBytes)) {
      this.#bytes -= this.#sizes[this.#head];
      this.#items[this.#head] = null;
      this.#head += 1;
      this.dropped += 1;
    }
    if (this.#head > 4096 && this.#head * 2 > this.#items.length) { // drop the dead front now and then (no O(n) shift per update)
      this.#items = this.#items.slice(this.#head);
      this.#sizes = this.#sizes.slice(this.#head);
      this.#head = 0;
    }
  }

  get length(): number {
    return this.#items.length - this.#head;
  }

  /** The updates held, oldest first. */
  get updates(): Json[] {
    return this.#items.slice(this.#head) as Json[];
  }
}

/**
 * Open elsewhere: of the history a session/load sends back (session/update params, oldest first), the turns that came after the
 * last user message this chat already showed (`lastUserText`), so only what was written in another app is shown again. A turn
 * starts at a user message (consecutive user_message_chunk updates). The last turn whose user text contains `lastUserText` is
 * this chat's own; everything after it is outside. `lastUserText` empty (the chat never showed a user message): every turn is
 * outside. Not found: nothing (AIB shows no history twice; the agent still has it all).
 */
export function outsideTurns(updates: Json[], lastUserText: string): { updates: Json[]; turns: number } {
  const turns: { text: string; updates: Json[] }[] = [];
  let inUser = false;
  for (const params of updates) {
    const update = isDict(params) ? get(params, 'update', {}) as Json : {};
    const kind = isDict(update) ? get(update, 'sessionUpdate') : null;
    if (kind === 'user_message_chunk') {
      if (!inUser || !turns.length) turns.push({ text: '', updates: [] });
      inUser = true;
      const content = get(update, 'content', {}) as Json;
      if (isDict(content) && content.type === 'text' && isStr(content.text)) turns.at(-1)!.text += content.text;
    } else {
      inUser = false;
      if (!turns.length) turns.push({ text: '', updates: [] }); // something before the first user message: part of what AIB had
    }
    turns.at(-1)!.updates.push(params);
  }
  const want = pyStrip(lastUserText);
  let from = 0;
  if (want) {
    let mine = -1;
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].text.includes(want)) {
        mine = i;
        break;
      }
    }
    if (mine < 0) return { updates: [], turns: 0 };
    from = mine + 1;
  } else if (turns.length && !turns[0].text) from = 1;
  const outside = turns.slice(from).filter((t) => t.text);
  return { updates: outside.flatMap((t) => t.updates), turns: outside.length };
}

/** S3's quiet time (inbox-rules.js QUIET_SECONDS); test runs (AGENT_STUDIO_TEST=1) may shorten it with AIB_TEST_QUIET_SECONDS. */
export let quietCache: number | null = null;
export function quietSeconds(): number {
  if (quietCache !== null) return quietCache;
  let v = INBOX.QUIET_SECONDS;
  try {
    const test = Deno.env.get('AGENT_STUDIO_TEST') === '1' ? Number(Deno.env.get('AIB_TEST_QUIET_SECONDS')) : NaN;
    if (Number.isFinite(test) && test > 0) v = test;
  } catch { /* no env access */ }
  return (quietCache = v);
}

/** The follow-up window after a helper or shell ends (inbox-rules.js FOLLOW_UP_SECONDS, 20 s); test runs (AGENT_STUDIO_TEST=1) may shorten it with AIB_TEST_FOLLOW_UP_SECONDS. */
export let followCache: number | null = null;
export function followUpSeconds(): number {
  if (followCache !== null) return followCache;
  let v = INBOX.FOLLOW_UP_SECONDS;
  try {
    const test = Deno.env.get('AGENT_STUDIO_TEST') === '1' ? Number(Deno.env.get('AIB_TEST_FOLLOW_UP_SECONDS')) : NaN;
    if (Number.isFinite(test) && test > 0) v = test;
  } catch { /* no env access */ }
  return (followCache = v);
}
