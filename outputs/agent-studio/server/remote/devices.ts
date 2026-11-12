/**
 * Paired phones (<state>/devices.json): one record per phone with its name, the SHA-256 of its device token (sent in a header on
 * every API call) and of its image cookie (sent only by the browser on GET images and page files), its scopes, the Tailscale login
 * that paired it, when it was paired and when it was last seen. Never the raw token or cookie.
 *
 * Last seen is kept in memory and written at most every 5 minutes (a phone polls every few seconds).
 */
import { inDir, JsonFileStore, VERSION } from '../state/base.ts';
import { now, quarantine, readJsonFile, saveJson } from '../state/json.ts';
import { randomToken, sha256Hex } from './words.ts';

/** What a phone may do: see chats (always), answer questions, send messages and stop turns, approve once, get pushes. */
export const PHONE_SCOPES = ['phone.read', 'phone.answer', 'phone.prompt', 'phone.approve', 'phone.push'] as const;
export type PhoneScope = typeof PHONE_SCOPES[number];
/** Owner decision 2c: a new phone may see chats, answer, send and approve once (no passkey), and get pushes. */
export const DEFAULT_SCOPES: readonly PhoneScope[] = PHONE_SCOPES;

export interface Device {
  id: string;
  name: string;
  tokenHash: string;
  cookieHash: string;
  scopes: PhoneScope[];
  login: string;
  created: number;
  lastSeen: number;
}

export type PublicDevice = Omit<Device, 'tokenHash' | 'cookieHash'>;

const SEEN_WRITE_SECONDS = 300;
const MAX_DEVICES = 50;

export function cleanScopes(value: unknown): PhoneScope[] {
  const list = Array.isArray(value) ? value : [];
  const out = PHONE_SCOPES.filter((s) => list.includes(s));
  return out.includes('phone.read') ? out : ['phone.read', ...out]; // a paired phone can always see chats
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
      this.devices.set(d.id, {
        id: d.id,
        name: cleanName(d.name),
        tokenHash: d.tokenHash,
        cookieHash: d.cookieHash,
        scopes: cleanScopes(d.scopes),
        login: typeof d.login === 'string' ? d.login : '',
        created: Number(d.created) || 0,
        lastSeen,
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
    return [...this.devices.values()].map(({ tokenHash: _t, cookieHash: _c, ...rest }) => ({ ...rest, scopes: [...rest.scopes] }));
  }

  /** Add a phone; returns its record and the raw token and cookie (shown to the phone once, never stored). */
  add(options: { name: string; login: string; scopes: PhoneScope[] }): Promise<{ device: PublicDevice; token: string; cookie: string }> {
    return this.locked(() => {
      this.sync();
      this.requireReadable();
      if (this.devices.size >= MAX_DEVICES) throw new RangeError(`At most ${MAX_DEVICES} phones can be paired`);
      const token = randomToken();
      const cookie = randomToken();
      const id = randomToken(9);
      const at = this.clock();
      const device: Device = {
        id,
        name: cleanName(options.name),
        tokenHash: sha256Hex(token),
        cookieHash: sha256Hex(cookie),
        scopes: cleanScopes(options.scopes),
        login: options.login,
        created: at,
        lastSeen: at,
      };
      this.devices.set(id, device);
      this.counter++;
      this.#save();
      const { tokenHash: _t, cookieHash: _c, ...rest } = device;
      return { device: rest, token, cookie };
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
      d.scopes = cleanScopes(scopes);
      this.counter++;
      this.#save();
      const { tokenHash: _t, cookieHash: _c, ...rest } = d;
      return { ...rest, scopes: [...rest.scopes] };
    });
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
