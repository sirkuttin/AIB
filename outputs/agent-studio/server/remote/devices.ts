/**
 * Paired phones (<state>/devices.json): one record per phone with its name, the SHA-256 of its device token (sent in a header on
 * every API call) and of its image cookie (sent only by the browser on GET images and page files), its scopes, the Tailscale login
 * that paired it, when it was paired and when it was last seen, and its Web Push subscription (the push service's address and the
 * phone's two keys, which encrypt what is sent to it) once the phone turned notifications on. Never the raw token or cookie.
 * Removing a phone removes its subscription with it.
 *
 * Last seen is kept in memory and written at most every 5 minutes (a phone polls every few seconds).
 */
import { inDir, JsonFileStore, VERSION } from '../state/base.ts';
import { now, quarantine, readJsonFile, saveJson } from '../state/json.ts';
import { randomToken, sha256Hex } from './words.ts';

/** What a phone may do: see chats (always), answer questions, send messages and stop turns, start new chats (a child of Send: only
 * with Send on), approve once, get pushes. */
export const PHONE_SCOPES = ['phone.read', 'phone.answer', 'phone.prompt', 'phone.start', 'phone.approve', 'phone.push'] as const;
export type PhoneScope = typeof PHONE_SCOPES[number];
/** Owner decision 2c: a new phone may see chats, answer, send and approve once (no passkey), and get pushes. */
export const DEFAULT_SCOPES: readonly PhoneScope[] = PHONE_SCOPES;

/** Remote control from other PCs (design v2 section 6): a computer's extra switches. A computer has the phone switches too (they
 * cover the shared actions) plus these: Allow always and modes that skip approvals, Files: see, download and edit, Terminal, Add and
 * remove projects. Lead call 2a: a new computer gets all of them (each can be turned off per computer). There is no pc.changes. */
export const PC_SCOPES = ['pc.always', 'pc.files', 'pc.terminal', 'pc.projects'] as const;
export type PcScope = typeof PC_SCOPES[number];
export type DeviceScope = PhoneScope | PcScope;
export const COMPUTER_SCOPES: readonly DeviceScope[] = [...PHONE_SCOPES, ...PC_SCOPES];
/** What the approver on the PC set (MF13): the claimant's screen only proposes it. A record without one is a phone. */
export type DeviceKind = 'phone' | 'computer';
export function cleanKind(value: unknown): DeviceKind {
  return value === 'computer' ? 'computer' : 'phone';
}

/** A phone's Web Push subscription (PushSubscription.toJSON() on the phone). */
export interface PushSub {
  endpoint: string;
  p256dh: string;
  auth: string;
  at: number;
}

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  cookieHash: string;
  scopes: DeviceScope[];
  /** 'computer' when the approver chose Computer; missing means phone (every device paired before computers existed). */
  kind?: 'computer';
  login: string;
  created: number;
  lastSeen: number;
  push?: PushSub;
  /** Silent reminders (owner decision: per phone, on by default; missing = on). The sending lands with the phone presence work. */
  remind?: boolean;
  /** "Start new chats" turned off (owner decision: a child of Send, on by default, also for phones paired before it: missing = on).
   * `scopes` holds phone.start only while Send is on and this is not set. */
  startOff?: boolean;
  /** Saved copies of recent chats on the phone for reading offline (owner decision Q6, 2026-11-16: per phone, on by default;
   * missing = on). The phone learns it from the CACHE_FLAG in the scopes it gets and wipes its copies when it is off. */
  offlineCache?: boolean;
}

/** What Settings > Remote control gets: no hashes and no subscription, only whether the phone has one. */
export type PublicDevice = Omit<Device, 'tokenHash' | 'cookieHash' | 'push' | 'remind' | 'startOff' | 'kind' | 'offlineCache'> & {
  kind: DeviceKind;
  pushOn: boolean;
  remind: boolean;
  /** "Keep saved copies of recent chats" on this phone (Settings > Remote control, the phone's row). */
  offlineCache: boolean;
  /** The "Start new chats" switch itself (it only counts while Send is on: `scopes` has phone.start then). */
  start: boolean;
};

const publicOf = (d: Device): PublicDevice => {
  const { tokenHash: _t, cookieHash: _c, push, remind, startOff, kind, offlineCache, ...rest } = d;
  return {
    ...rest,
    kind: cleanKind(kind),
    scopes: [...rest.scopes],
    pushOn: !!push,
    remind: remind !== false,
    start: startOff !== true,
    // Saved copies of chats are phone-only: a computer keeps chats in memory only (security review SF6)
    offlineCache: kind !== 'computer' && offlineCache !== false,
  };
};

/** The flag the phone finds in its scopes while it may keep saved copies of chats (not a switch the server checks a route by). */
export const CACHE_FLAG = 'phone.cache';

/** The scopes a phone is told (bootstrap and every home / chat / saved answer): its switches, plus CACHE_FLAG while it may keep saved
 * copies of chats. Without the flag the phone wipes its copies. Never for a computer: it keeps chats in memory only (SF6). */
export function scopesForPhone(d: Device): string[] {
  return d.offlineCache === false || d.kind === 'computer' ? [...d.scopes] : [...d.scopes, CACHE_FLAG];
}

/**
 * The push services a subscription may point at (review should-fix, design v2 section 7): Chrome / Edge on Android and Chrome on
 * desktop (FCM), Firefox (Mozilla autopush), Edge on Windows (WNS) and Safari (Apple). Any other address is refused, so a paired
 * device cannot make the PC send requests to a LAN or tailnet address.
 */
export const PUSH_HOSTS: readonly string[] = ['fcm.googleapis.com', 'web.push.apple.com'];
export const PUSH_HOST_SUFFIXES: readonly string[] = ['.push.services.mozilla.com', '.notify.windows.com'];

/** May a subscription's endpoint be sent to? https on the default port, at a known push service. Tests only: with AGENT_STUDIO_TEST=1
 * and AIB_TEST_PUSH_LOOPBACK=1, a fake push service on 127.0.0.1 (remote_push_test.ts). */
export function pushEndpointAllowed(url: URL): boolean {
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  const host = url.hostname.toLowerCase();
  if (host === '127.0.0.1' && Deno.env.get('AGENT_STUDIO_TEST') === '1' && Deno.env.get('AIB_TEST_PUSH_LOOPBACK') === '1') return true;
  if (url.port !== '') return false;
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s) && host.length > s.length);
}

/** Why a subscription from a browser cannot be kept (null when it can): the endpoint is not an https address, is at a push service
 * AIB does not send to (host says which), or the keys are not the two base64url values. */
export function pushSubProblem(value: unknown): { code: 'bad_endpoint' | 'push_service' | 'bad_keys'; host: string; reason: string } | null {
  const v = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const keys = v.keys && typeof v.keys === 'object' ? v.keys as Record<string, unknown> : {};
  const endpoint = typeof v.endpoint === 'string' ? v.endpoint : '';
  const b64 = (x: unknown, min: number, max: number) =>
    typeof x === 'string' && x.length >= min && x.length <= max && /^[A-Za-z0-9_-]+=*$/.test(x);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { code: 'bad_endpoint', host: '', reason: 'the notification address is missing or not a web address' };
  }
  if (endpoint.length > 1000) return { code: 'bad_endpoint', host: url.hostname, reason: 'the notification address is too long' };
  if (!pushEndpointAllowed(url)) {
    const host = url.hostname;
    const reason = url.protocol !== 'https:' ? 'it is not an https address' : 'that is not a push service AIB sends to';
    return { code: 'push_service', host, reason };
  }
  if (!b64(keys.p256dh, 80, 100) || !b64(keys.auth, 16, 30)) {
    return { code: 'bad_keys', host: url.hostname, reason: 'the notification keys are missing or malformed' };
  }
  return null;
}

/** A subscription from a phone or computer, checked (pushSubProblem): an https address at a known push service and the two keys
 * (base64url). Null when it is not one. */
export function cleanPushSub(value: unknown, at: number): PushSub | null {
  if (pushSubProblem(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = v.keys as Record<string, unknown>;
  return { endpoint: v.endpoint as string, p256dh: keys.p256dh as string, auth: keys.auth as string, at };
}

const SEEN_WRITE_SECONDS = 300;
const MAX_DEVICES = 50;

/** A device's switches, cleaned: only the names its kind has (a phone never holds a pc.* scope, whatever was sent or saved). */
export function cleanScopes(value: unknown, kind: DeviceKind = 'phone'): DeviceScope[] {
  const list = Array.isArray(value) ? value : [];
  const known: readonly DeviceScope[] = kind === 'computer' ? COMPUTER_SCOPES : PHONE_SCOPES;
  // Start new chats only counts while Send is on (owner decision E: a child of Send)
  const out = known.filter((s) => list.includes(s) && (s !== 'phone.start' || list.includes('phone.prompt')));
  return out.includes('phone.read') ? out : ['phone.read', ...out]; // a paired phone can always see chats
}

/** A phone's scopes from its saved switches: Start new chats is on while Send is on, unless it was turned off (missing = on). */
export function effectiveScopes(value: unknown, startOff: boolean, kind: DeviceKind = 'phone'): DeviceScope[] {
  const list = (Array.isArray(value) ? value : []).filter((s) => s !== 'phone.start');
  if (!startOff && list.includes('phone.prompt')) list.push('phone.start');
  return cleanScopes(list, kind);
}

/** The Start new chats switch after the PC sent a whole list of switches: the list says it only while Send is in it (Start is
 * greyed out and keeps its own setting while Send is off). */
export function startOffAfter(scopes: unknown, before: boolean): boolean {
  const list = Array.isArray(scopes) ? scopes : [];
  return list.includes('phone.prompt') ? !list.includes('phone.start') : before;
}

export function cleanName(value: unknown): string {
  // deno-lint-ignore no-control-regex -- control characters in a phone's name become spaces
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, 40) || 'Phone';
}

export class DeviceStore extends JsonFileStore {
  static FILE = 'devices.json';
  devices = new Map<string, Device>();
  /** When last-seen times were last written. */
  #seenWritten = 0;
  #seenDirty = false;

  constructor(stateDir: string | null = null, readonly clock: () => number = now) {
    super();
    this.path = stateDir ? inDir(stateDir, DeviceStore.FILE) : null;
    this.reload();
  }

  protected reload(): void {
    if (this.path === null) return;
    const [status, data] = readJsonFile(this.path);
    this.seen = this.stamp();
    if (status === 'missing') {
      this.devices = new Map();
      this.unreadable = false;
      return;
    }
    if (status === 'busy') {
      this.unreadableNow('devices.json could not be read just now');
      return;
    }
    if (status === 'corrupt' || !data || typeof data !== 'object' || !Array.isArray((data as { devices?: unknown }).devices)) {
      quarantine(this.path);
      this.devices = new Map();
      this.unreadable = false;
      this.warning = 'The paired phones list was damaged and has been reset. Pair your phones again.';
      return;
    }
    const memorySeen = new Map([...this.devices].map(([id, d]) => [id, d.lastSeen]));
    this.devices = new Map();
    for (const raw of (data as { devices: unknown[] }).devices) {
      if (!raw || typeof raw !== 'object') continue;
      const d = raw as Record<string, unknown>;
      if (typeof d.id !== 'string' || typeof d.tokenHash !== 'string' || typeof d.cookieHash !== 'string') continue;
      const lastSeen = Math.max(Number(d.lastSeen) || 0, memorySeen.get(d.id) ?? 0);
      const p = d.push && typeof d.push === 'object' ? d.push as Record<string, unknown> : null;
      const push = p ? cleanPushSub({ endpoint: p.endpoint, keys: { p256dh: p.p256dh, auth: p.auth } }, Number(p.at) || 0) : null;
      const startOff = d.startOff === true;
      const kind = cleanKind(d.kind);
      this.devices.set(d.id, {
        id: d.id,
        name: cleanName(d.name),
        tokenHash: d.tokenHash,
        cookieHash: d.cookieHash,
        scopes: effectiveScopes(d.scopes, startOff, kind),
        ...(kind === 'computer' ? { kind } : {}),
        login: typeof d.login === 'string' ? d.login : '',
        created: Number(d.created) || 0,
        lastSeen,
        ...(push ? { push } : {}),
        ...(d.remind === false ? { remind: false } : {}),
        ...(startOff ? { startOff: true } : {}),
        ...(d.offlineCache === false ? { offlineCache: false } : {}),
      });
    }
    this.unreadable = false;
    this.counter++;
  }

  #save(): void {
    if (this.path === null) return;
    saveJson(this.path, { version: VERSION, savedAt: this.clock(), devices: [...this.devices.values()] }, 'devices-');
    this.seen = this.stamp();
    this.#seenWritten = this.clock();
    this.#seenDirty = false;
  }

  list(): PublicDevice[] {
    this.sync();
    return [...this.devices.values()].map(publicOf);
  }

  /** Add a phone; returns its record and the raw token and cookie (shown to the phone once, never stored). */
  add(
    options: { name: string; login: string; scopes: DeviceScope[]; kind?: DeviceKind },
  ): Promise<{ device: PublicDevice; token: string; cookie: string }> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      if (this.devices.size >= MAX_DEVICES) throw new RangeError(`At most ${MAX_DEVICES} phones can be paired`);
      const token = randomToken();
      const cookie = randomToken();
      const id = randomToken(9);
      const at = this.clock();
      const startOff = startOffAfter(options.scopes, false);
      const kind = cleanKind(options.kind);
      const device: Device = {
        id,
        name: cleanName(options.name),
        tokenHash: sha256Hex(token),
        cookieHash: sha256Hex(cookie),
        scopes: effectiveScopes(options.scopes, startOff, kind),
        ...(kind === 'computer' ? { kind } : {}),
        login: options.login,
        created: at,
        lastSeen: at,
        ...(startOff ? { startOff: true } : {}),
      };
      this.devices.set(id, device);
      this.counter++;
      this.#save();
      return { device: publicOf(device), token, cookie };
    });
  }

  remove(id: string): Promise<boolean> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      const had = this.devices.delete(id);
      if (had) {
        this.counter++;
        this.#save();
      }
      return had;
    });
  }

  /** The owner changed a phone's switches on the PC; the phone's next request is checked against them. */
  setScopes(id: string, scopes: unknown): Promise<PublicDevice | null> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      const d = this.devices.get(id);
      if (!d) return null;
      const startOff = startOffAfter(scopes, d.startOff === true);
      if (startOff) d.startOff = true;
      else delete d.startOff;
      d.scopes = effectiveScopes(scopes, startOff, cleanKind(d.kind));
      this.counter++;
      this.#save();
      return publicOf(d);
    });
  }

  /** The owner changed a device's kind on the PC (Settings > Devices, the row's Phone / Computer control). A computer gets every
   * switch on (lead call: computers default to full work); a phone loses every pc.* switch. */
  setKind(id: string, kindValue: unknown): Promise<PublicDevice | null> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      const d = this.devices.get(id);
      if (!d) return null;
      const kind = cleanKind(kindValue);
      if (kind === 'computer') {
        d.kind = 'computer';
        delete d.startOff;
        d.scopes = cleanScopes(COMPUTER_SCOPES, 'computer');
      } else {
        delete d.kind;
        d.scopes = cleanScopes(d.scopes, 'phone');
      }
      this.counter++;
      this.#save();
      return publicOf(d);
    });
  }

  /** Silent reminders on or off for one phone (Settings > Remote control, the phone's row). */
  setRemind(id: string, remind: boolean): Promise<PublicDevice | null> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      const d = this.devices.get(id);
      if (!d) return null;
      if (remind) delete d.remind;
      else d.remind = false;
      this.counter++;
      this.#save();
      return publicOf(d);
    });
  }

  /** Saved copies of recent chats on the phone on or off (Settings > Remote control, the phone's row). Off: the phone wipes them
   * when it next reaches the PC. */
  setOfflineCache(id: string, on: boolean): Promise<PublicDevice | null> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      const d = this.devices.get(id);
      if (!d) return null;
      if (on) delete d.offlineCache;
      else d.offlineCache = false;
      this.counter++;
      this.#save();
      return publicOf(d);
    });
  }

  /** The phone's push subscription (null: drop it). Another phone with the same subscription loses it (one browser, re-paired). */
  setPush(id: string, push: PushSub | null): Promise<boolean> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      const d = this.devices.get(id);
      if (!d) return false;
      if (push) {
        for (const other of this.devices.values()) if (other !== d && other.push?.endpoint === push.endpoint) delete other.push;
        d.push = push;
      } else delete d.push;
      this.counter++;
      this.#save();
      return true;
    });
  }

  /** The push service said this subscription is gone (404 / 410): drop it wherever it is. */
  dropPush(endpoint: string): Promise<number> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      let n = 0;
      for (const d of this.devices.values()) {
        if (d.push?.endpoint === endpoint) {
          delete d.push;
          n++;
        }
      }
      if (n) {
        this.counter++;
        this.#save();
      }
      return n;
    });
  }

  /** The phones a push goes to now: a subscription and the Push switch on. */
  pushTargets(): { id: string; name: string; push: PushSub; kind: DeviceKind }[] {
    this.sync();
    return [...this.devices.values()]
      .filter((d) => d.push && d.scopes.includes('phone.push'))
      .map((d) => ({ id: d.id, name: d.name, push: { ...d.push! }, kind: cleanKind(d.kind) }));
  }

  removeAll(): Promise<number> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      const count = this.devices.size;
      this.devices.clear();
      this.counter++;
      this.#save();
      return count;
    });
  }

  /** The phone with this device token (header), or null. Every record is compared, so the time does not say which one matched. */
  byToken(token: string | null): Device | null {
    return this.#find('tokenHash', token);
  }

  /** The phone with this id (a signed artifact link names it; remote/artifact_server.ts), or null: a removed phone is gone. */
  byId(id: string): Device | null {
    this.sync();
    return this.devices.get(id) ?? null;
  }

  /** The phone with this image cookie, or null. */
  byCookie(cookie: string | null): Device | null {
    return this.#find('cookieHash', cookie);
  }

  #find(field: 'tokenHash' | 'cookieHash', secret: string | null): Device | null {
    if (!secret || secret.length > 200) return null;
    this.sync();
    const hash = sha256Hex(secret);
    let found: Device | null = null;
    for (const d of this.devices.values()) if (sameText(d[field], hash)) found = d;
    return found;
  }

  /** The phone made a request now: last seen in memory, written to the file at most every 5 minutes. */
  touch(id: string): void {
    const d = this.devices.get(id);
    if (!d) return;
    d.lastSeen = this.clock();
    this.#seenDirty = true;
    if (this.clock() - this.#seenWritten >= SEEN_WRITE_SECONDS) {
      void this.locked(() => {
        if (!this.#seenDirty) return;
        const memory = new Map([...this.devices].map(([k, v]) => [k, v.lastSeen]));
        this.sync();
        for (const [k, v] of memory) {
          const x = this.devices.get(k);
          if (x) x.lastSeen = Math.max(x.lastSeen, v);
        }
        this.#save();
      }).catch(() => {});
    }
  }

  /** Write a pending last-seen time now (AIB is closing). */
  flush(): Promise<void> {
    if (!this.#seenDirty) return Promise.resolve();
    return this.locked(() => this.#save()).catch(() => {});
  }
}

function sameText(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
