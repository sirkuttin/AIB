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
 *
 * Paired computers (remote control from other PCs, phase 2; design v2 section 8, review MF12): a computer's page reports through
 * POST /api/remote/pc/presence (reportDevice). The SERVER builds the slot id from the device, `r-<device>-<n>` with n 1..DEVICE_SLOTS;
 * the page's own tab id is only a lookup key for its n, never part of the id, so a page can never name or overwrite another slot.
 * Each device holds at most DEVICE_SLOTS of the MAX_SLOTS (its oldest tab gives its slot up), and when the slots are full a
 * computer's slot goes before any of the PC's own, so a laptop with many tabs never pushes the PC's windows out. A computer's slots
 * never count for the PC's own focused() / active() / openOnPc() / soundOwner(): those stay about the PC's screen.
 *
 *   where()   "where you are" (a new rule, review WC9): the device with the latest input in the last 2 minutes. The PC counts while
 *             active() (focus and input); a computer while its last input in AIB is under ACTIVE_MS old (its tab may have lost focus
 *             since: you are still at that computer); a phone while it is on screen, from when it came on screen or last acted
 *             (phoneInput). Null: nobody is anywhere. The Notifier (watcher.ts) sends the news there.
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
  /** Phase 2: you are at another device now (where()): this one's pages do not chime or show notifications of their own. */
  quiet: boolean;
}

/** Phase 2: at most this many of the MAX_SLOTS per paired computer. */
export const DEVICE_SLOTS = 4;
/** "Where you are" (where()). */
export type Where = { who: 'pc' } | { who: 'computer'; device: string } | { who: 'phone'; device: string } | null;
const REMOTE_SLOT = 'r-';

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

/** One window's report body as a slot (a bad kind or key is a ValueError: 400; a long name is cut to 80 characters). */
function slotOf(b: Record<string, unknown>): Omit<Slot, 'at' | 'focusedAt'> {
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
  return { kind: kind as PresenceKind, project, chat, doc, focused: b.focused === true, visible: b.visible !== false, open: openList(b.open) };
}

/** The open chats of these slots' visible windows. */
function openOf(slots: [string, Slot][]): string[] {
  const out = new Set<string>();
  for (const [, s] of slots) if (s.visible) for (const k of s.open) out.add(k);
  return [...out];
}

/** D1 over these slots: the focused one (the latest to say so), else the one focused last; null when none. */
function ownerOf(slots: [string, Slot][]): string | null {
  const pool = slots.some(([, s]) => s.focused) ? slots.filter(([, s]) => s.focused) : slots.filter(([, s]) => s.focusedAt > 0);
  let best: [string, number] | null = null;
  for (const [w, s] of pool) if (!best || s.focusedAt >= best[1]) best = [w, s.focusedAt];
  return best ? best[0] : null;
}

const viewOf = (w: string, s: Slot): WindowView => ({
  w,
  kind: s.kind,
  project: s.project?.key ?? null,
  chat: s.chat,
  doc: s.doc ? { ...s.doc } : null,
  focused: s.focused,
  visible: s.visible,
});

export class Presence {
  /** One slot per window id (K2, B7): a report from one window never overwrites another's. */
  #slots = new Map<string, Slot>();
  #inputAt = 0;
  #phones = new Map<string, { chat: string | null; since: number; at: number; held: HeldAlert[] }>();
  /** alert id -> the phones whose page has not got it yet */
  #pending = new Map<number, Pending>();
  #nextId = 1;
  #ended = new Set<(e: PhoneEnded) => void>();
  /** Phase 2: a computer's slot id -> its device and the page's tab id (the lookup key only). */
  #remote = new Map<string, { device: string; tab: string }>();
  /** Phase 2: a computer's last input in AIB (ms), kept when its slots go stale (a tab in the background stops focusing). */
  #deviceInput = new Map<string, number>();
  /** Phase 2: a phone's last action (a send, an answer): it is in hand and used now. */
  #phoneInput = new Map<string, number>();

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
    this.#put(w, slotOf(b), b.idleMs);
    return this.answer();
  }

  /**
   * Phase 2: a paired computer's report (POST /api/remote/pc/presence). `w` is the page's own tab id (window-context.js), used only
   * to find this tab's slot; the slot id is r-<device>-<n>. A fifth tab of one device takes the slot of its tab reported longest
   * ago. `left: true` drops the tab's slot. Returns the answer in the page's own terms (its tabs' ids, only its own windows).
   */
  reportDevice(device: string, body: unknown): PresenceAnswer {
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(device)) throw new ValueError('Invalid device');
    const b = (body && typeof body === 'object' && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
    const tab = b.w;
    if (typeof tab !== 'string' || !PRESENCE_ID.test(tab) || tab === '_') throw new ValueError('Invalid window');
    const have = this.#slotOfTab(device, tab);
    if (b.left === true) {
      if (have) this.#drop(have);
      return this.deviceAnswer(device);
    }
    const slot = slotOf(b); // a bad body is refused before a slot is taken
    let id = have;
    if (!id) {
      const mine = [...this.#slots.keys()].filter((k) => this.#remote.get(k)?.device === device);
      const used = new Set(mine.map((k) => k.slice(k.lastIndexOf('-') + 1)));
      let n = 0;
      for (let i = 1; i <= DEVICE_SLOTS && !n; i++) if (!used.has(String(i))) n = i;
      if (!n) {
        const oldest = mine[0]; // the map's order is the report order
        n = Number(oldest.slice(oldest.lastIndexOf('-') + 1));
        this.#drop(oldest);
      }
      id = `${REMOTE_SLOT}${device}-${n}`;
      this.#remote.set(id, { device, tab });
    }
    this.#put(id, slot, b.idleMs, device);
    return this.deviceAnswer(device);
  }

  #slotOfTab(device: string, tab: string): string | null {
    for (const [id, r] of this.#remote) if (r.device === device && r.tab === tab && this.#slots.has(id)) return id;
    return null;
  }

  /** A slot goes (and a computer's tab mapping with it). */
  #drop(id: string): void {
    this.#slots.delete(id);
    this.#remote.delete(id);
  }

  #put(w: string, slot: Omit<Slot, 'at' | 'focusedAt'>, idleMs: unknown, device?: string): void {
    const now = this.clock();
    const idle = Number(idleMs);
    const old = this.#slots.get(w);
    this.#slots.delete(w); // re-inserted last: the map's order is the report order (the cap drops the first)
    this.#slots.set(w, { ...slot, at: now, focusedAt: slot.focused ? now : old?.focusedAt ?? 0 });
    while (this.#slots.size > MAX_SLOTS) {
      // a computer's slot (the one reported longest ago) goes before any of the PC's own windows
      const ids = [...this.#slots.keys()];
      this.#drop(ids.find((k) => k !== w && k.startsWith(REMOTE_SLOT)) ?? ids.find((k) => k !== w) ?? ids[0]);
    }
    if (!(Number.isFinite(idle) && idle >= 0)) return;
    const input = now - Math.min(idle, 7 * 86400_000);
    if (device) this.#deviceInput.set(device, Math.max(this.#deviceInput.get(device) ?? 0, input));
    else this.#inputAt = Math.max(this.#inputAt, input);
  }

  /** A window closed or its page went away (left: true, or the desktop app closed it): its slot goes at once (B8). */
  leave(w: string): void {
    if (!w.startsWith(REMOTE_SLOT)) this.#drop(w);
  }

  /** Phase 2: a computer was removed: its slots and its "where you are" go at once. */
  leaveDevice(device: string): void {
    for (const [id, r] of [...this.#remote]) if (r.device === device) this.#drop(id);
    this.#deviceInput.delete(device);
  }

  /** The fresh slots (reported in the last STALE_MS), in report order; stale ones are dropped. */
  #fresh(): [string, Slot][] {
    const now = this.clock();
    for (const [w, s] of [...this.#slots]) if (now - s.at >= STALE_MS) this.#drop(w);
    return [...this.#slots];
  }

  /** The PC's own fresh slots (never a computer's). */
  #local(): [string, Slot][] {
    return this.#fresh().filter(([w]) => !w.startsWith(REMOTE_SLOT));
  }

  /** One computer's fresh slots. */
  #ofDevice(device: string): [string, Slot][] {
    return this.#fresh().filter(([w]) => this.#remote.get(w)?.device === device);
  }

  /** An AIB window on the PC has focus now: any fresh report of the PC's own says so. */
  focused(): boolean {
    return this.#local().some(([, s]) => s.focused);
  }

  active(): boolean {
    return this.focused() && this.clock() - this.#inputAt < ACTIVE_MS;
  }

  /** Phase 2: a computer's AIB page has focus now (it shows news itself: no push to it). */
  deviceFocused(device: string): boolean {
    return this.#ofDevice(device).some(([, s]) => s.focused);
  }

  /** Phase 2: a phone acted (sent, answered, stopped): it is in hand and used now (where()). */
  phoneInput(device: string): void {
    if (!device) return;
    this.#phoneInput.set(device, this.clock());
    while (this.#phoneInput.size > MAX_PHONES) this.#phoneInput.delete(this.#phoneInput.keys().next().value!);
  }

  /**
   * Phase 2, "where you are": the device with the latest input in the last ACTIVE_MS (the PC while active(); a computer by its last
   * input in AIB; a phone on screen by when it came on screen or last acted). The PC wins a tie. Null: nobody is anywhere.
   */
  where(): Where {
    const now = this.clock();
    let best: Where = null;
    let at = -Infinity;
    if (this.active()) {
      best = { who: 'pc' };
      at = this.#inputAt;
    }
    for (const [device, t] of [...this.#deviceInput]) {
      if (now - t >= ACTIVE_MS) {
        this.#deviceInput.delete(device);
        continue;
      }
      if (t > at) {
        best = { who: 'computer', device };
        at = t;
      }
    }
    for (const p of this.phones()) {
      const t = Math.max(p.since, this.#phoneInput.get(p.device) ?? 0);
      if (t > at) {
        best = { who: 'phone', device: p.device };
        at = t;
      }
    }
    return best;
  }

  /** The chats on screen in AIB now (page keys): the union of every fresh, visible window's open chats; none once all stopped. */
  openOnPc(): string[] {
    return openOf(this.#local());
  }

  /** D1: the focused window (the latest to say so when several do), else the one focused last; null when none is known. */
  soundOwner(): string | null {
    return ownerOf(this.#local());
  }

  /** The fresh windows (K2 answer `windows`), in report order. */
  windows(): WindowView[] {
    return this.#local().map(([w, s]) => viewOf(w, s));
  }

  /** K2: the presence answer. quiet: you are at a computer now (the PC's pages do not chime). */
  answer(): PresenceAnswer {
    return {
      ok: true,
      soundOwner: this.soundOwner(),
      openAll: this.openOnPc(),
      windows: this.windows(),
      quiet: this.where()?.who === 'computer',
    };
  }

  /** Phase 2: a computer's answer, in its page's terms: its own windows by its tabs' ids, its sound owner, its open chats; quiet
   * while you are at another device (the PC, another computer or a phone). */
  deviceAnswer(device: string): PresenceAnswer {
    const mine = this.#ofDevice(device);
    const tabOf = (id: string | null) => (id ? this.#remote.get(id)?.tab ?? null : null);
    const where = this.where();
    return {
      ok: true,
      soundOwner: tabOf(ownerOf(mine)),
      openAll: openOf(mine),
      windows: mine.map(([w, s]) => viewOf(tabOf(w)!, s)),
      quiet: where !== null && !(where.who === 'computer' && where.device === device),
    };
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
    if (why === 'removed') {
      this.#phoneInput.delete(device);
      this.leaveDevice(device); // a removed computer's slots go too (remote/access.ts calls this for every device)
    }
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
