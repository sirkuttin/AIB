/**
 * Web Push to the paired phones (owner decision 8a: standard Web Push with VAPID keys made on this PC, no account, no Firebase).
 *
 * Library: jsr:@negrel/webpush 0.5.0 with jsr:@negrel/http-ece 0.7.0, vendored in server/vendor/webpush (MIT). It is written for
 * Deno on WebCrypto and fetch, so it runs the same in a source run and in the built app; npm:web-push needs Node's crypto, https and
 * five npm packages (one of them an HTTP proxy agent) through Deno's Node layer, and an npm download on first run. A new
 * ApplicationServer (a fresh ECDH key) is made for every message, as RFC 8291 asks.
 *
 * The VAPID key pair (push-keys.json in the data folder) is AIB's own, kept apart from the agents' keys (secrets.ts sealAll forgets
 * keys it is not given): on Windows the private key is sealed with DPAPI for this Windows account (never a prompt); on Linux it is
 * in the Secret Service when one answers (secret_service.ts: every call is bounded, so a locked keyring at a restart with nobody at
 * the PC falls back instead of hanging); otherwise, and on macOS, it is in the file, readable by your user only (0600). A key an
 * older AIB left in the file moves into the Secret Service when it is next read. Remove all phones makes a new pair, so any old
 * subscription dies.
 *
 * What a push says: "A chat needs you" / "Chat finished" and the chat's title (notify-rules.js pushText), encrypted to the phone
 * (RFC 8291, aes128gcm). Needs you goes with Urgency high and a short time to live; every push has the same Topic, so the push
 * service keeps only the newest one for a phone that is offline, and the same tag, so the phone shows only the newest one.
 * A subscription the push service calls gone (404 or 410) is deleted.
 *
 * Buttons (0.13, remote/push_acts.ts): a push about one chat also carries that chat's row key, the buttons for its kind (at most
 * two, by this phone's switches) and a one-time code for this phone. Once that request is answered anywhere (its row is gone or
 * about a newer request: seeInbox), the phone that was shown it gets a small "close" push with the key, and its service worker
 * takes the notification away.
 */
import { getLogger } from '../core/log.ts';
import { inDir } from '../state/base.ts';
import { quarantine, readJsonFile, saveJson } from '../state/json.ts';
import { dpapiProtect, dpapiUnprotect } from '../state/secrets.ts';
import { forgetMarked, isMarker, openMarked, storeMarked, useSecretService } from '../state/secret_service.ts';
import { ApplicationServer, PushMessageError, Urgency } from '../vendor/webpush/mod.ts';
import type { DeviceStore, PushSub } from './devices.ts';
import type { InboxRow } from '../attention/inbox_rules.ts';
import type { ToastCodes } from '../desktop/toast.ts';
import { pushButtons, rowSig } from './push_acts.ts';

const log = getLogger('push');

export const PUSH_KEYS_FILE = 'push-keys.json';
/** The VAPID "sub": a contact the push services may use. A placeholder: AIB has no account and sends nobody's address. */
export const CONTACT = 'mailto:phone-push@aib.invalid';
export const TOPIC = 'aib-attention';
/** Time to live at the push service: a question is old news after a few minutes; a finished turn a bit later. */
export const TTL_NEEDS = 300;
export const TTL_FINISHED = 1800;
const SEND_TIMEOUT_MS = 15_000;

const b64url = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const fromB64url = (text: string): Uint8Array<ArrayBuffer> => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

/** How the private key is kept: 'dpapi' (Windows), 'secret-service' (Linux keyring) or 'file' (0600). AIB_PUSH_KEY_STORE=file forces the file (tests of it). */
export function pushKeyStore(): 'dpapi' | 'secret-service' | 'file' {
  const want = (Deno.env.get('AIB_PUSH_KEY_STORE') ?? '').trim().toLowerCase();
  if (want === 'file') return 'file';
  if (Deno.build.os === 'windows') return 'dpapi';
  return useSecretService() ? 'secret-service' : 'file';
}

interface Pair {
  /** The application server key the phone subscribes with: the raw P-256 public key, base64url. */
  publicKey: string;
  keys: CryptoKeyPair;
}

/** The VAPID key pair in <state>/push-keys.json, made on first use. */
export class VapidKeys {
  readonly path: string;
  #pair: Promise<Pair> | null = null;

  constructor(readonly stateDir: string) {
    this.path = inDir(stateDir, PUSH_KEYS_FILE);
  }

  /** The current pair (read or made once per process). */
  pair(): Promise<Pair> {
    this.#pair ??= this.#load().catch((error) => {
      this.#pair = null;
      throw error;
    });
    return this.#pair;
  }

  async publicKey(): Promise<string> {
    return (await this.pair()).publicKey;
  }

  /** A new pair (Remove all phones): every subscription made with the old public key stops working. */
  async rotate(): Promise<string> {
    this.#pair = this.#make();
    return (await this.#pair).publicKey;
  }

  async #load(): Promise<Pair> {
    const [status, data] = readJsonFile(this.path);
    if (status === 'ok' && data && typeof data === 'object') {
      const d = data as Record<string, unknown>;
      const opened = await this.#open(d);
      if (opened) return opened;
      log.info('push: the saved push keys could not be opened; making new ones (phones turn notifications on again)');
      quarantine(this.path);
    } else if (status === 'corrupt') quarantine(this.path);
    return this.#make();
  }

  async #open(d: Record<string, unknown>): Promise<Pair | null> {
    const pub = typeof d.publicKey === 'string' ? d.publicKey : '';
    const priv = typeof d.privateKey === 'string' ? d.privateKey : '';
    let dKey = '';
    if (priv.startsWith('dpapi:v1:')) {
      if (Deno.build.os !== 'windows') return null;
      const plain = dpapiUnprotect(fromB64url(priv.slice(9)));
      if (!plain) return null;
      dKey = new TextDecoder().decode(plain);
    } else if (isMarker(priv)) {
      const plain = openMarked(priv);
      if (plain === null) return null;
      dKey = plain;
    } else if (priv.startsWith('file:v1:')) dKey = priv.slice(8);
    else return null;
    try {
      const raw = fromB64url(pub);
      if (raw.length !== 65 || raw[0] !== 4) return null;
      const jwk = { kty: 'EC', crv: 'P-256', x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33)), d: dKey, ext: true };
      const privateKey = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      const { d: _d, ...pubJwk } = jwk;
      const publicKey = await crypto.subtle.importKey('jwk', pubJwk, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']);
      // A key an older AIB left in the file moves into the Secret Service (the file keeps only the marker; a refusing store
      // leaves the file as it was).
      if (priv.startsWith('file:v1:') && pushKeyStore() === 'secret-service') {
        const marker = storeMarked('push-vapid-private-key', dKey);
        if (marker) saveJson(this.path, { version: 1, store: 'secret-service', publicKey: pub, privateKey: marker }, 'push-keys-');
      }
      return { publicKey: pub, keys: { privateKey, publicKey } };
    } catch {
      return null;
    }
  }

  #previousMarker(): string | null {
    const [status, data] = readJsonFile(this.path);
    const priv = status === 'ok' && data && typeof data === 'object' ? (data as Record<string, unknown>).privateKey : null;
    return typeof priv === 'string' && isMarker(priv) ? priv : null;
  }

  async #make(): Promise<Pair> {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey));
    const jwk = await crypto.subtle.exportKey('jwk', keys.privateKey);
    const publicKey = b64url(raw);
    const store = pushKeyStore();
    let privateKey = store === 'dpapi' ? 'dpapi:v1:' + b64url(dpapiProtect(new TextEncoder().encode(jwk.d!))) : 'file:v1:' + jwk.d;
    let kept = store;
    if (store === 'secret-service') {
      const marker = storeMarked('push-vapid-private-key', jwk.d!);
      if (marker) privateKey = marker;
      else kept = 'file'; // the keyring refused: the 0600 file, not a lost key
    }
    const old = this.#previousMarker();
    saveJson(this.path, { version: 1, store: kept, publicKey, privateKey }, 'push-keys-'); // written 0600 (core/fs.ts writeJsonAtomic)
    forgetMarked(old); // a rotated pair: the old private key leaves the keyring
    // The pair in use keeps an unextractable private key.
    const sign = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
    return { publicKey, keys: { privateKey: sign, publicKey: keys.publicKey } };
  }
}

export interface PushMessage {
  title: string;
  body: string;
  tag: string;
  chat: string;
  sheet: boolean;
  /** Finished only: the phone shows it without a sound or vibration (pwa/sw.js). */
  silent?: boolean;
  /** One chat's push: its row key (provider:sessionId), for the buttons (remote/push_acts.ts). */
  key?: string;
}

/** What the buttons need: the inbox row of a chat now, and the one-time codes (push-codes.json). */
export interface PushButtonDeps {
  rowOf(key: string): InboxRow | null;
  codes: ToastCodes;
}

export interface SendResult {
  device: string;
  status: number;
  dropped: boolean;
}

/** The page a notification click opens: the computer page or the phone page, on the chat (a phone's sheet up for Needs you). */
export function openTarget(kind: 'phone' | 'computer', chat: unknown, sheet: unknown): string {
  const id = typeof chat === 'string' ? chat.slice(0, 100) : '';
  if (kind === 'computer') return id ? '/pc.html#chat=' + encodeURIComponent(id) : '/pc.html';
  return id ? '/phone.html#chat=' + encodeURIComponent(id) + (sheet ? '&sheet=1' : '') : '/phone.html';
}

/** Sends one message to every phone that may get pushes; drops subscriptions the push service calls gone. */
export class PushSender {
  /** device -> the chat (row key) and request its newest notification is about ('' key: a grouped one, nothing to close). */
  #shown = new Map<string, { key: string; sig: string }>();

  constructor(
    readonly devices: DeviceStore,
    readonly keys: VapidKeys,
    readonly fetcher: typeof fetch = fetch,
    readonly buttons: PushButtonDeps | null = null,
  ) {}

  /** The notification each phone was shown last (tests). */
  shown(): { device: string; key: string; sig: string }[] {
    return [...this.#shown].map(([device, v]) => ({ device, ...v }));
  }

  /** This phone's notification about this chat is gone already (its own button answered it): no close push for it. */
  forget(device: string, key: string): void {
    if (this.#shown.get(device)?.key === key) this.#shown.delete(device);
  }

  /** Every inbox built: a phone shown a request that was answered anywhere since gets a close push; its codes stop working. */
  async seeInbox(inbox: { rows: InboxRow[] }): Promise<void> {
    for (const [device, v] of [...this.#shown]) {
      if (!v.key) continue;
      const row = inbox.rows.find((r) => r.key === v.key);
      if (row && rowSig(row) === v.sig) continue;
      this.#shown.delete(device);
      this.buttons?.codes.revokeChat(v.key, true, device);
      const target = this.devices.pushTargets().find((t) => t.id === device);
      if (!target) continue;
      const pair = await this.keys.pair();
      await this.#one(device, target.push, JSON.stringify({ type: 'close', key: v.key, tag: TOPIC }), false, pair, TTL_NEEDS);
    }
  }

  /** Anyone to send to? (a subscription and the Push switch on) */
  any(): boolean {
    return this.devices.pushTargets().length > 0;
  }

  /** `to` (phase 2, attention/watcher.ts pushPick): only the targets it picks ("where you are"); every target without it. */
  async send(message: PushMessage, to?: (target: { id: string; kind: 'phone' | 'computer' }) => boolean): Promise<SendResult[]> {
    const targets = this.devices.pushTargets().filter((t) => !to || to({ id: t.id, kind: t.kind }));
    if (!targets.length) return [];
    const pair = await this.keys.pair();
    const urgent = message.sheet || /need/i.test(message.title);
    const out: SendResult[] = [];
    for (const t of targets) {
      // the buttons: a phone's push about one chat (a computer's page has its own; a grouped push has none)
      const row = message.key && t.kind === 'phone' && this.buttons ? this.buttons.rowOf(message.key) : null;
      const codes = this.buttons?.codes;
      const buttons = row && codes ? pushButtons(row, t.scopes, (chat, sig, acts) => codes.issue(chat, sig, acts, t.id)) : null;
      this.#shown.set(t.id, buttons && row ? { key: row.key, sig: rowSig(row) } : { key: '', sig: '' });
      // where a click opens it (phase 1b, v2 fix 7): the service worker cannot ask a page for the device kind, the server knows it
      const payload = JSON.stringify({
        title: message.title,
        body: message.body,
        tag: message.tag,
        chat: message.chat,
        sheet: message.sheet,
        open: openTarget(t.kind, message.chat, message.sheet),
        ...(message.silent ? { silent: true } : {}),
        ...(buttons ? { key: buttons.key, actions: buttons.actions, ...(buttons.code ? { code: buttons.code } : {}) } : {}),
      });
      out.push(await this.#one(t.id, t.push, payload, urgent, pair));
    }
    return out;
  }

  async #one(device: string, sub: PushSub, payload: string, urgent: boolean, pair: Pair, ttl?: number): Promise<SendResult> {
    // A fresh application server (ECDH key) per message (RFC 8291 3.1); the VAPID pair signs the request.
    const server = await ApplicationServer.new({ contactInformation: CONTACT, vapidKeys: pair.keys });
    const subscriber = server.subscribe({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } });
    const signal = AbortSignal.timeout(SEND_TIMEOUT_MS);
    try {
      await subscriber.pushTextMessage(payload, {
        urgency: urgent ? Urgency.High : Urgency.Normal,
        ttl: ttl ?? (urgent ? TTL_NEEDS : TTL_FINISHED),
        topic: TOPIC,
        signal,
        fetcher: this.fetcher,
      });
      return { device, status: 201, dropped: false };
    } catch (error) {
      if (error instanceof PushMessageError) {
        const status = error.response.status;
        await error.response.body?.cancel().catch(() => {});
        if (status === 404 || status === 410) {
          await this.devices.dropPush(sub.endpoint);
          log.info('push: a phone subscription is gone (%s); deleted', status);
          return { device, status, dropped: true };
        }
        log.info('push: the push service answered %s', status);
        return { device, status, dropped: false };
      }
      log.info('push: could not reach the push service (%s)', error instanceof Error ? error.message : error);
      return { device, status: 0, dropped: false };
    }
  }
}
