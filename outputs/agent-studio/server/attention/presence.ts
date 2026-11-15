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
 * Several windows (multi-window design K2): each page reports with its window id `w` ('m', 'w2'…'w8'; 't-…' for a browser tab in
 * serve mode) and gets one slot; a report without `w` (old pages, tests) goes into slot "_". focused() is any fresh slot that is
 * focused, openOnPc() the union of the fresh, visible slots' open chats, and the answer (answer()) names the sound owner: the
 * focused window, else the one focused last (D1), so only one window chimes. `left: true` (pagehide) or the desktop app closing a
 * window (leave) drops its slot at once. At most MAX_SLOTS slots.
 *
 * The PC page also says which chats it shows (`open`: the active tab's chat and any split pane's, while the window is visible:
 * inbox-rules.js openKeys). openOnPc() is the union of those lists while the reports are fresh. Those chats are left out of the DESKTOP only (no
 * desktop notification, not in the tray count, the tray's chat slots or the taskbar dot): they are already in front of the
 * owner. Pushes ignore it on purpose: holding back pushes for a chat on a focused but idle PC would swallow the push the owner
 * walked away from the PC to get, so pushes still go by active() alone.
 */
import { ValueError } from '../core/py.ts';

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

/** K2: a presence slot id. 'm' and 'w2'…'w8' are app windows, 't-…' a browser tab in serve mode, '_' a call without an id. */
export const PRESENCE_ID = /^(m|w[2-8]|t-[a-z0-9]{4,12}|_)$/;
/** At most this many slots; the one reported longest ago goes first. */
export const MAX_SLOTS = 16;
const MAX_OPEN = 20;
const PRESENCE_KINDS = ['main', 'project', 'chat', 'doc'] as const;
export type PresenceKind = typeof PRESENCE_KINDS[number];

/** One window (or browser tab) as its last fresh report says (K2 answer `windows`). */
export interface WindowView {
  w: string;
  kind: PresenceKind;
  project: string | null;
  chat: string | null;
  doc: { project: string; name: string } | null;
  focused: boolean;
  visible: boolean;
}

/** K2: the answer to POST /api/live/presence. */
export interface PresenceAnswer {
  ok: true;
  /** The window that may chime, toast and ask for desktop notifications: the focused one, else the one focused last. */
  soundOwner: string | null;
  /** The chats on screen in any fresh, visible window. */
  openAll: string[];
  windows: WindowView[];
}

interface Slot {
  kind: PresenceKind;
  project: { key: string; name: string } | null;
  chat: string | null;
  doc: { project: string; name: string } | null;
  focused: boolean;
  visible: boolean;
  open: string[];
  /** The last report (ms). */
  at: number;
  /** The last report that said focused (ms); 0: never. */
  focusedAt: number;
}

// deno-lint-ignore no-control-regex -- refused in keys
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const isKey = (v: unknown): v is string => typeof v === 'string' && v.length >= 1 && v.length <= 400 && !CONTROL.test(v);
function key(v: unknown, what: string): string {
  if (!isKey(v)) throw new ValueError(`Invalid ${what}`);
  return v;
}
// deno-lint-ignore no-control-regex -- control characters in a name become spaces
const cleanName = (v: unknown) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
const openList = (open: unknown) => (Array.isArray(open) ? open : []).filter((k): k is string => isKey(k)).slice(0, MAX_OPEN);

export class Presence {
  /** One slot per window id (K2, B7): a report from one window never overwrites another's. */
  #slots = new Map<string, Slot>();
  #inputAt = 0;
  #phones = new Map<string, { chat: string | null; since: number; at: number; held: HeldAlert[] }>();
  /** alert id -> the phones whose page has not got it yet */
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #ended = new Set<(e: PhoneEnded) => void>();

  constructor(readonly clock: () => number = Date.now) {}

  /** A report without a window id (old pages, tests): slot "_". Its window has focus or not, the time since its last input (ms),
   * the chats it shows (page keys). */
  report(focused: unknown, idleMs: unknown, open?: unknown): void {
    this.#put('_', { kind: 'main', project: null, chat: null, doc: null, focused: focused === true, visible: true, open: openList(open) }, idleMs);
  }

  /**
   * K2: one window's report (POST /api/live/presence). A body without `w` goes into slot "_"; `left: true` drops that slot at once
   * (pagehide). A bad id, kind or key is a ValueError (400); a long name is cut to 80 characters. Returns the answer.
   */
  reportWindow(body: unknown): PresenceAnswer {
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    if (b.w === undefined && b.left !== true) {
      this.report(b.focused, b.idleMs, b.open); // an old page's body: today's call, slot "_"
      return this.answer();
    }
    const w = b.w === undefined ? '_' : b.w;
    if (typeof w !== 'string' || !PRESENCE_ID.test(w)) throw new ValueError('Invalid window');
    if (b.left === true) {
      this.leave(w);
      return this.answer();
    }
    const kind = b.kind === undefined ? 'main' : b.kind;
    if (!PRESENCE_KINDS.includes(kind as PresenceKind)) throw new ValueError('Invalid kind');
    let project: Slot['project'] = null;
    if (b.project !== undefined && b.project !== null) {
      if (typeof b.project !== 'object' || Array.isArray(b.project)) throw new ValueError('Invalid project');
      const p = b.project as Record<string, unknown>;
      project = { key: key(p.key, 'project.key'), name: cleanName(p.name) };
    }
    const chat = b.chat === undefined || b.chat === null ? null : key(b.chat, 'chat');
    let doc: Slot['doc'] = null;
    if (b.doc !== undefined && b.doc !== null) {
      if (typeof b.doc !== 'object' || Array.isArray(b.doc)) throw new ValueError('Invalid doc');
      const d = b.doc as Record<string, unknown>;
      doc = { project: key(d.project, 'doc.project'), name: key(d.name, 'doc.name') };
    }
    const slot = { kind: kind as PresenceKind, project, chat, doc, focused: b.focused === true, visible: b.visible !== false, open: openList(b.open) };
    this.#put(w, slot, b.idleMs);
    return this.answer();
  }

  #put(w: string, slot: Omit<Slot, 'at' | 'focusedAt'>, idleMs: unknown): void {
    const now = this.clock();
    const idle = Number(idleMs);
    const old = this.#slots.get(w);
    this.#slots.delete(w); // re-inserted last: the map's order is the report order (the cap drops the first)
    this.#slots.set(w, { ...slot, at: now, focusedAt: slot.focused ? now : old?.focusedAt ?? 0 });
    while (this.#slots.size > MAX_SLOTS) this.#slots.delete(this.#slots.keys().next().value!);
    if (Number.isFinite(idle) && idle >= 0) this.#inputAt = Math.max(this.#inputAt, now - Math.min(idle, 7 * 86400_000));
  }

  /** A window closed or its page went away (left: true, or the desktop app closed it): its slot goes at once (B8). */
  leave(w: string): void {
    this.#slots.delete(w);
  }

  /** The fresh slots (reported in the last STALE_MS), in report order; stale ones are dropped. */
  #fresh(): [string, Slot][] {
    const now = this.clock();
    for (const [w, s] of [...this.#slots]) if (now - s.at >= STALE_MS) this.#slots.delete(w);
    return [...this.#slots];
  }

  /** An AIB window has focus now: any fresh report says so. */
  focused(): boolean {
    return this.#fresh().some(([, s]) => s.focused);
  }

  active(): boolean {
    return this.focused() && this.clock() - this.#inputAt < ACTIVE_MS;
  }

  /** The chats on screen in AIB now (page keys): the union of every fresh, visible window's open chats; none once all stopped. */
  openOnPc(): string[] {
    const out = new Set<string>();
    for (const [, s] of this.#fresh()) if (s.visible) for (const k of s.open) out.add(k);
    return [...out];
  }

  /** D1: the focused window (the latest to say so when several do), else the one focused last; null when none is known. */
  soundOwner(): string | null {
    const fresh = this.#fresh();
    const pool = fresh.some(([, s]) => s.focused) ? fresh.filter(([, s]) => s.focused) : fresh.filter(([, s]) => s.focusedAt > 0);
    let best: [string, number] | null = null;
    for (const [w, s] of pool) if (!best || s.focusedAt >= best[1]) best = [w, s.focusedAt];
    return best ? best[0] : null;
  }

  /** The fresh windows (K2 answer `windows`), in report order. */
  windows(): WindowView[] {
    return this.#fresh().map(([w, s]) => ({
      w,
      kind: s.kind,
      project: s.project?.key ?? null,
      chat: s.chat,
      doc: s.doc ? { ...s.doc } : null,
      focused: s.focused,
      visible: s.visible,
    }));
  }

  /** K2: the presence answer. */
  answer(): PresenceAnswer {
    return { ok: true, soundOwner: this.soundOwner(), openAll: this.openOnPc(), windows: this.windows() };
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
