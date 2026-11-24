/**
 * Who answered a chat's approval or question, and with what (remote control from other PCs, phase 2; design v2 section 8): the line
 * a chat keeps once its card goes reads "Approval · Run npm test · Allowed once on Laptop (Edge)" on every other device. The agent
 * host does not record who answered; the web server does, as each answer goes through it:
 *   - the PC's own page (POST /api/live/permission, /elicitation, /allow/answer): by 'pc', named with the PC's name
 *   - a paired computer (the same routes through remote/pc_bridge.ts): by its device id and name (it overwrites the PC's line the
 *     route itself just wrote)
 *   - a phone (POST /api/remote/permission, /elicitation): by its device id and name
 * GET /api/live/state carries a chat's answers (`answers`: request key -> {by, name, option | action, always}); chat.js names the
 * device only when another device answered. Two devices on one card: the first answer wins (the agent host takes one answer per
 * request); the second is told who was first ("Already answered on DESK.").
 *
 * In memory only, at most MAX_CHATS chats and MAX_KEYS requests each (after an AIB restart a line reads "Answered" again).
 */

export interface Answered {
  /** 'pc' (the PC's own page) or a paired device's id. */
  by: string;
  /** The PC's name or the device's name, as Settings > Remote control shows it. */
  name: string;
  /** An approval: the option id picked (null: the request was cancelled). */
  option?: string | null;
  /** An approval answered with AIB's "Always allow" rule. */
  always?: boolean;
  /** A question: accept, decline or cancel. */
  action?: string;
  at: number;
}

const MAX_CHATS = 200;
const MAX_KEYS = 50;

export class AnswerLog {
  #chats = new Map<string, Map<string, Answered>>();

  /** One answer that went through (the newest write for a request wins: the bridge names the computer after the route named the PC). */
  note(chat: unknown, key: unknown, answer: Omit<Answered, 'at'>): void {
    if (typeof chat !== 'string' || !chat || chat.length > 100 || typeof key !== 'string' || !key || key.length > 300) return;
    let keys = this.#chats.get(chat);
    if (!keys) {
      keys = new Map();
      this.#chats.set(chat, keys);
      while (this.#chats.size > MAX_CHATS) this.#chats.delete(this.#chats.keys().next().value!);
    }
    keys.delete(key);
    keys.set(key, { ...answer, name: String(answer.name).slice(0, 80), at: Date.now() });
    while (keys.size > MAX_KEYS) keys.delete(keys.keys().next().value!);
  }

  /** Who answered this request, or null. */
  who(chat: unknown, key: unknown): Answered | null {
    if (typeof chat !== 'string' || typeof key !== 'string') return null;
    return this.#chats.get(chat)?.get(key) ?? null;
  }

  /** A chat's answers for GET /api/live/state (request key -> answer), or null when it has none. */
  forChat(chat: unknown): Record<string, Answered> | null {
    if (typeof chat !== 'string') return null;
    const keys = this.#chats.get(chat);
    return keys && keys.size ? Object.fromEntries(keys) : null;
  }
}

const logs = new WeakMap<object, AnswerLog>();

/** The answer log of one web server (its WebContext). */
export function answersOf(ctx: object): AnswerLog {
  let log = logs.get(ctx);
  if (!log) logs.set(ctx, log = new AnswerLog());
  return log;
}

/** What a request body answered: an approval's option (and the Always rule), or a question's action. */
export function answerOf(op: 'permission' | 'elicitation' | 'allow-answer', body: Record<string, unknown> | null): Pick<Answered, 'option' | 'always' | 'action'> {
  const b = body ?? {};
  if (op === 'elicitation') return { action: typeof b.action === 'string' ? b.action.slice(0, 20) : '' };
  const option = typeof b.option === 'string' ? b.option.slice(0, 200) : null;
  return op === 'allow-answer' ? { option, always: true } : { option };
}

/** "Already answered on Laptop (Edge)." for the second device on one card, or null when nobody is known to have answered it. */
export function answeredElsewhere(ctx: object, chat: unknown, key: unknown): string | null {
  const a = answersOf(ctx).who(chat, key);
  return a ? `Already answered on ${a.name}.` : null;
}
