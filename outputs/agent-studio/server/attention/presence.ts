/**
 * Where the owner is looking: one model of every screen that shows AIB, read by the AttentionWatcher's Notifier (watcher.ts).
 *
 * The PC page tells the server (POST /api/live/presence) whether its window has focus and how long ago the person last typed,
 * clicked or scrolled in it; it does so when that changes and every 20 s while it has focus. A report older than 45 s counts as
 * "not focused": the window was closed, AIB was quit, or the page stopped.
 *
 *   focused()   an AIB window has focus now: no desktop notification (the page's own badge, list and toasts show it).
 *   active()    focused, and input in the last 2 minutes: no phone push either (the owner is working at the PC right now).
 *
 * Each paired phone tells it by polling: phone.html polls /api/remote/chat (a chat on screen) or /api/remote/home and
 * /api/remote/saved (no live chat on screen) every 3-4 s, only while the page is visible (remote/server.ts calls seePhone). A phone
 * that stops polling counts as gone after PHONE_TTL_MS; phone.html also sends POST /api/remote/left when the page is hidden.
 *
 *   phones()          the phones on screen now: {device, chat (the live chat it shows, or null), since, at}.
 *   onPhoneEnded(fn)  a phone stopped showing AIB (the left beacon, or no poll for PHONE_TTL_MS): fn gets the alerts that were held
 *                     back because that phone was in hand (record below) and the ones no phone's page got (undelivered).
 *
 * Alerts held back because a phone is in hand go to that phone's page as a banner (hold / takeNotices: the next poll's answer
 * carries them). Every one is also kept in the phone's record for this time on screen (suppressed(), and `held` in the ended
 * event), so a later rule (for example one summary when the phone is put away while chats still need you) can be added on the
 * "ended" event without rework.
 *
 * The PC page does not say which chat it shows: a focused window already stops every desktop notification and an active one every
 * push, and holding back pushes for a chat on a focused but idle PC would swallow the push the owner walked away from the PC to get.
 */
export const STALE_MS = 45_000;
export const ACTIVE_MS = 120_000;
/** A phone that has not polled for this long is not looking (it polls every 3-4 s while visible). */
export const PHONE_TTL_MS = 15_000;
/** At most this many held-back alerts kept per phone (the oldest go). */
const MAX_RECORD = 200;
const MAX_PHONES = 50;

/** One alert as the watcher announces it (watcher.ts Fire). */
export interface Alert {
  key: string;
  chat: string;
  kind: 'needs' | 'turn';
  title: string;
}

/** An alert held back because a phone was in hand. onScreen: that phone showed this very chat. */
export interface HeldAlert extends Alert {
  at: number;
  onScreen: boolean;
  /** The phone's page got it (a banner, or the chat it already showed). */
  delivered: boolean;
}

export interface PhoneView {
  device: string;
  chat: string | null;
  /** When this time on screen started (ms). */
  since: number;
  /** The last poll (ms). */
  at: number;
}

export interface PhoneEnded {
  device: string;
  why: 'left' | 'expired' | 'removed';
  since: number;
  /** Every alert held back while this phone was in hand, oldest first. */
  held: HeldAlert[];
  /** Held-back alerts no phone's page got: the Notifier sends them the usual way now. */
  undelivered: (Alert & { desktopSkipped: boolean })[];
}

interface Pending {
  alert: Alert;
  devices: Set<string>;
  delivered: boolean;
  /** Not shown on the PC because a phone showed this chat (the PC had no focus). */
  desktopSkipped: boolean;
}

export class Presence {
  #focused = false;
  #at = 0;
  #inputAt = 0;
  #phones = new Map<string, { chat: string | null; since: number; at: number; held: HeldAlert[] }>();
  /** alert id -> the phones whose page has not got it yet */
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #ended = new Set<(e: PhoneEnded) => void>();

  constructor(readonly clock: () => number = Date.now) {}

  /** A page's report: its window has focus or not, and the time since its last input (ms). */
  report(focused: unknown, idleMs: unknown): void {
    const now = this.clock();
    const idle = Number(idleMs);
    this.#focused = focused === true;
    this.#at = now;
    if (Number.isFinite(idle) && idle >= 0) this.#inputAt = Math.max(this.#inputAt, now - Math.min(idle, 7 * 86400_000));
  }

  focused(): boolean {
    return this.#focused && this.clock() - this.#at < STALE_MS;
  }

  active(): boolean {
    return this.focused() && this.clock() - this.#inputAt < ACTIVE_MS;
  }

  // ---- phones -------------------------------------------------------------------------------------------------------------------

  /** A visible phone page polled: it shows this live chat, or none (home, a chat that is not running). */
  seePhone(device: string, chat: string | null): void {
    if (!device) return;
    this.sweep();
    const now = this.clock();
    const old = this.#phones.get(device);
    if (old) {
      old.chat = chat || null;
      old.at = now;
      return;
    }
    this.#phones.set(device, { chat: chat || null, since: now, at: now, held: [] });
    while (this.#phones.size > MAX_PHONES) this.#end(this.#phones.keys().next().value!, 'expired');
  }

  /** The phone's page was hidden (POST /api/remote/left), or the phone was removed. */
  leavePhone(device: string, why: 'left' | 'removed' = 'left'): void {
    if (this.#phones.has(device)) this.#end(device, why);
  }

  /** The phones on screen now. */
  phones(): PhoneView[] {
    this.sweep();
    return [...this.#phones].map(([device, p]) => ({ device, chat: p.chat, since: p.since, at: p.at }));
  }

  /** Is this live chat on a phone's screen now? */
  phoneShows(chat: string): boolean {
    return this.phones().some((p) => p.chat === chat);
  }

  /** Phones that stopped polling end ("expired"). The watcher calls this on every look; the reads above call it too. */
  sweep(): void {
    const now = this.clock();
    for (const [device, p] of [...this.#phones]) if (now - p.at >= PHONE_TTL_MS) this.#end(device, 'expired');
  }

  /** fn is called for every phone that stops showing AIB. Returns the unsubscribe. */
  onPhoneEnded(fn: (e: PhoneEnded) => void): () => void {
    this.#ended.add(fn);
    return () => this.#ended.delete(fn);
  }

  /**
   * An alert held back because phones are in hand: each of them gets it in its next poll's answer, and it goes into each one's
   * record. desktopSkipped: no desktop notification was shown for it because a phone showed the chat.
   */
  hold(alert: Alert, desktopSkipped: boolean): void {
    const phones = this.phones();
    if (!phones.length) return;
    const now = this.clock();
    for (const p of phones) {
      const held = this.#phones.get(p.device)!.held;
      held.push({ ...alert, at: now, onScreen: p.chat === alert.chat, delivered: false });
      if (held.length > MAX_RECORD) held.splice(0, held.length - MAX_RECORD);
    }
    this.#pending.set(this.#nextId++, { alert, devices: new Set(phones.map((p) => p.device)), delivered: false, desktopSkipped });
  }

  /** The alerts this phone's page has not got yet (they go with this answer: delivered). */
  takeNotices(device: string): Alert[] {
    const out: Alert[] = [];
    for (const [id, p] of [...this.#pending]) {
      if (!p.devices.delete(device)) continue;
      p.delivered = true;
      out.push(p.alert);
      if (!p.devices.size) this.#pending.delete(id);
    }
    for (const h of this.#phones.get(device)?.held ?? []) {
      if (out.some((a) => a.key === h.key && a.kind === h.kind && a.chat === h.chat)) h.delivered = true;
    }
    return out;
  }

  /** What was held back while this phone (on screen now) was in hand. */
  suppressed(device: string): HeldAlert[] {
    return [...(this.#phones.get(device)?.held ?? [])];
  }

  #end(device: string, why: PhoneEnded['why']): void {
    const p = this.#phones.get(device);
    if (!p) return;
    this.#phones.delete(device);
    const undelivered: PhoneEnded['undelivered'] = [];
    for (const [id, pending] of [...this.#pending]) {
      if (!pending.devices.delete(device) || pending.devices.size) continue;
      this.#pending.delete(id);
      if (!pending.delivered) undelivered.push({ ...pending.alert, desktopSkipped: pending.desktopSkipped });
    }
    const event: PhoneEnded = { device, why, since: p.since, held: p.held, undelivered };
    for (const fn of [...this.#ended]) {
      try {
        fn(event);
      } catch { /* one listener never stops the others */ }
    }
  }
}
