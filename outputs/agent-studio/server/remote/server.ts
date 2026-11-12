/**
 * RemoteServer: the phone port (review break 2). A separate loopback listener, bound only while Phone access is on, that Tailscale
 * Serve sends phone traffic to. It is NOT a second WebServer: it never sets ctx.port or ctx.gate, never falls back to
 * WebServer.handle, and answers only the routes in REMOTE_ROUTES, each calling ctx.host / the stores directly. Everything else is
 * 404, every WebSocket is refused, and nothing here ever returns the page token, the agent host or keeper tokens, or an artifact key.
 *
 * Credentials: the device token in the X-AIB-Device header on every API call (the phone keeps it in IndexedDB); an
 * __Host- HttpOnly Secure SameSite=Strict cookie only for GET images (an <img> cannot send a header). Never the reverse.
 */
import { APP_ROOT, APP_VERSION } from '../core/app.ts';
import { HostUnavailable } from '../host/host_client.ts';
import { serve, type Server as HttpServer } from '../platform/http_serve.ts';
import { type WebContext, withThemePref } from '../web/server.ts';
import { ACTION_OPS, checkAction, Refusal } from './actions.ts';
import type { Audit } from './audit.ts';
import { cleanName, type Device, type DeviceStore, type PhoneScope } from './devices.ts';
import { LOGIN_HEADER, REMOTE_REASONS, RemoteGate } from './gate.ts';
import { type Pairing, PairingError } from './pairing.ts';
import { chatPayload, DEFAULT_TAIL, homePayload, imageOf, type TitleCache } from './payloads.ts';
import { bindWithRetry } from './port.ts';
import { cleanPushSub } from './devices.ts';
import type { VapidKeys } from './push.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
export const DEVICE_HEADER = 'X-AIB-Device';
export const COOKIE_NAME = '__Host-aib-phone';
const COOKIE_MAX_AGE = 400 * 24 * 3600; // Chrome's cap; renewed whenever the phone page loads
const MAX_BODY = 16 * 1024;

/** The phone page's files (and only these) are served on the phone port. Never chat.html, '/', or the page bootstrap. The service
 * worker (pwa/sw.js, at the root so its scope is the whole phone origin) and the app icons are served here only: the page port
 * serves top-level page files only, never pwa/ or icons/. */
export const REMOTE_STATIC: Readonly<Record<string, string>> = {
  '/phone.html': 'phone.html',
  '/themes.js': 'themes.js',
  '/theme.css': 'theme.css',
  '/phone.css': 'phone.css',
  '/phone.js': 'phone.js',
  '/phone-words.js': 'phone-words.js',
  '/markdown.js': 'markdown.js',
  '/sw.js': `pwa${sep}sw.js`,
  '/icons/icon-128.png': `icons${sep}128x128.png`,
  '/icons/icon-256.png': `icons${sep}128x128@2x.png`,
  '/icons/icon-512.png': `icons${sep}icon.png`,
};
export const MANIFEST_PATH = '/manifest.webmanifest';

export type RemoteAuth = 'static' | 'bootstrap' | 'pair' | 'device' | 'image' | 'action' | 'push';

/** Every route the phone port answers (method, path, how it is authorised). Default deny: anything else is 404. */
export const REMOTE_ROUTES: readonly [string, string, RemoteAuth][] = [
  ...Object.keys(REMOTE_STATIC).map((p) => ['GET', p, 'static'] as [string, string, RemoteAuth]),
  ['GET', MANIFEST_PATH, 'static'],
  ['GET', '/api/remote/bootstrap', 'bootstrap'],
  ['POST', '/api/remote/pair/claim', 'pair'],
  ['POST', '/api/remote/pair/status', 'pair'],
  ['GET', '/api/remote/home', 'device'],
  ['GET', '/api/remote/chat', 'device'],
  ['GET', '/api/remote/image', 'image'],
  // Phase B: answer, approve once, send, stop, the chat's own queued messages (remote/actions.ts checks every body).
  ['POST', '/api/remote/elicitation', 'action'],
  ['POST', '/api/remote/permission', 'action'],
  ['POST', '/api/remote/prompt', 'action'],
  ['POST', '/api/remote/queue', 'action'],
  ['POST', '/api/remote/cancel', 'action'],
  ['POST', '/api/remote/queue-send-now', 'action'],
  ['POST', '/api/remote/queue-edit', 'action'],
  ['POST', '/api/remote/queue-remove', 'action'],
  ['POST', '/api/remote/dismiss-unknown', 'action'],
  ['POST', '/api/remote/queue-resume', 'action'], // a queue that Stop paused goes on
  ['POST', '/api/remote/authenticate', 'action'], // always refused: signing an agent in is PC only
  // Phase C: this phone's Web Push subscription (the Push switch on the PC decides whether anything is sent to it).
  ['POST', '/api/remote/push/subscribe', 'push'],
  ['POST', '/api/remote/push/unsubscribe', 'push'],
];
const ROUTE_AUTH = new Map(REMOTE_ROUTES.map(([m, p, a]) => [`${m} ${p}`, a]));
/** The scope each device route needs. */
const ROUTE_SCOPE: Record<string, PhoneScope> = {
  'GET /api/remote/home': 'phone.read',
  'GET /api/remote/chat': 'phone.read',
  'GET /api/remote/image': 'phone.read',
  'POST /api/remote/elicitation': 'phone.answer',
  'POST /api/remote/permission': 'phone.approve',
  'POST /api/remote/prompt': 'phone.prompt',
  'POST /api/remote/queue': 'phone.prompt',
  'POST /api/remote/cancel': 'phone.prompt',
  'POST /api/remote/queue-send-now': 'phone.prompt',
  'POST /api/remote/queue-edit': 'phone.prompt',
  'POST /api/remote/queue-remove': 'phone.prompt',
  'POST /api/remote/dismiss-unknown': 'phone.prompt',
  'POST /api/remote/queue-resume': 'phone.prompt',
  'POST /api/remote/authenticate': 'phone.read',
  'POST /api/remote/push/subscribe': 'phone.push',
  'POST /api/remote/push/unsubscribe': 'phone.read',
};
/** The words a refused scope is reported with (what the phone shows; the switch is in Settings > Devices on the PC). */
const SCOPE_WORDS: Record<string, string> = {
  'phone.answer': 'answer questions',
  'phone.approve': 'approve requests',
  'phone.prompt': 'send messages or stop turns',
  'phone.push': 'get notifications',
};

/** What the phone port needs from Phone access (remote/access.ts). */
export interface RemoteHost {
  ctx: WebContext;
  devices: DeviceStore;
  pairing: Pairing;
  audit: Audit;
  titles: TitleCache;
  /** The VAPID keys a phone subscribes with (remote/push.ts). */
  vapid: VapidKeys;
  /** The tailnet name requests must be addressed to ('' = refuse everything). */
  name(): string;
  /** The Tailscale login of this PC: only phones signed in with it may pair. */
  ownerLogin(): string;
  pcName(): string;
}

export function securityHeadersRemote(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; " +
      "frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
  };
}

function contentType(name: string): string {
  if (name.endsWith('.png')) return 'image/png';
  return (name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css') + '; charset=utf-8';
}

/** The web app manifest (Add to Home Screen, Android's install): the phone page, standalone, AIB's icons. */
export function manifestOf(pcName: string): Record<string, unknown> {
  return {
    id: '/phone.html',
    name: `AIB on ${pcName}`,
    short_name: 'AIB',
    description: 'Your AIB chats on your phone.',
    start_url: '/phone.html',
    scope: '/',
    display: 'standalone',
    background_color: '#16151b',
    theme_color: '#16151b',
    icons: [
      { src: '/icons/icon-128.png', sizes: '128x128', type: 'image/png' },
      { src: '/icons/icon-256.png', sizes: '256x256', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

function cookieOf(headers: Headers): string | null {
  for (const part of (headers.get('Cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === COOKIE_NAME) return part.slice(at + 1).trim();
  }
  return null;
}

function setCookie(value: string): string {
  return `${COOKIE_NAME}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`;
}

async function drain(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch { /* nothing to read */ }
}

export class RemoteServer {
  readonly gate: RemoteGate;
  #server: HttpServer | null = null;
  port = 0;

  constructor(readonly host: RemoteHost) {
    this.gate = new RemoteGate(() => host.name());
  }

  json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...securityHeadersRemote(), ...extra },
    });
  }

  /** Bind 127.0.0.1:port, retrying while it is busy (port.ts bindWithRetry); throws PortBusy instead of taking another port. */
  async listen(port: number, retryMs?: number): Promise<number> {
    this.#server = await bindWithRetry(port, (p) => serve({ hostname: '127.0.0.1', port: p }, (request) => this.handle(request)), retryMs);
    this.port = this.#server.addr.port;
    return this.port;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    await server?.shutdown().catch(() => {});
  }

  get listening(): boolean {
    return this.#server !== null;
  }

  /** The device of an API request: its header token, the login it was paired with, and the scope this route needs. */
  #device(request: Request, scope: PhoneScope | null, viaCookie = false): Device | Response {
    const headers = request.headers;
    const device = viaCookie ? this.host.devices.byCookie(cookieOf(headers)) : this.host.devices.byToken(headers.get(DEVICE_HEADER));
    if (!device) {
      return this.json(401, { error: 'This phone is not paired with this PC.', code: 'not_paired' });
    }
    if (device.login !== (headers.get(LOGIN_HEADER) ?? '')) {
      this.host.audit.write({ device: device.id, name: device.name, action: 'request', result: 'refused: other Tailscale login' });
      return this.json(403, {
        error: 'This phone is signed in to Tailscale with another login than when it was paired.',
        code: 'wrong_login',
      });
    }
    if (scope && !device.scopes.includes(scope)) {
      const what = SCOPE_WORDS[scope];
      return this.json(403, {
        error: what
          ? `This phone may not ${what}. Turn it on for this phone in AIB on your PC: Settings → Devices.`
          : 'This phone may not do that.',
        code: 'scope',
      }, { 'X-AIB-Refused': 'scope' });
    }
    this.host.devices.touch(device.id);
    return device;
  }

  async #body(request: Request): Promise<Record<string, unknown> | null> {
    const declared = Number(request.headers.get('Content-Length') ?? '0');
    if (declared > MAX_BODY) return null;
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!raw.byteLength || raw.byteLength > MAX_BODY) return null;
    try {
      const body = JSON.parse(new TextDecoder().decode(raw));
      return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
    } catch {
      return null;
    }
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
    const auth = ROUTE_AUTH.get(`${method} ${path}`);
    if (request.headers.get('Upgrade') !== null) {
      await drain(request);
      return this.json(403, { error: REMOTE_REASONS.websocket[1] });
    }
    if (!auth) {
      await drain(request);
      return this.json(404, { error: 'Not found' });
    }
    const refused = this.gate.check({ method, path, headers: request.headers }, auth === 'static' || auth === 'image' ? 'static' : 'api');
    if (refused) {
      await drain(request);
      const [status, message] = REMOTE_REASONS[refused];
      return this.json(status, { error: message, code: refused });
    }
    try {
      switch (auth) {
        case 'static':
          return await this.#static(request, path);
        case 'bootstrap':
          return await this.#bootstrap(request);
        case 'pair':
          return await this.#pair(request, path);
        case 'device':
          return await this.#deviceRoute(request, url, path);
        case 'image':
          return await this.#image(request, url);
        case 'action':
          return await this.#action(request, path);
        case 'push':
          return await this.#push(request, path);
      }
    } catch (error) {
      if (error instanceof HostUnavailable) {
        return this.json(503, { error: 'AIB is starting its agents. Try again in a moment.', code: 'busy' });
      }
      console.error('Phone request failed', path, error);
      return this.json(500, { error: 'Internal error' });
    }
    return this.json(404, { error: 'Not found' });
  }

  async #static(request: Request, path: string): Promise<Response> {
    if (path === MANIFEST_PATH) {
      return new Response(JSON.stringify(manifestOf(this.host.pcName())), {
        status: 200,
        headers: { ...securityHeadersRemote(), 'Content-Type': 'application/manifest+json; charset=utf-8' },
      });
    }
    const name = REMOTE_STATIC[path];
    let body: Uint8Array<ArrayBuffer> = await Deno.readFile(APP_ROOT + sep + name);
    const headers: Record<string, string> = { 'Content-Type': contentType(name), ...securityHeadersRemote() };
    if (path === '/sw.js') {
      headers['Cache-Control'] = 'no-cache'; // the browser looks for a newer service worker on every page load
      headers['Service-Worker-Allowed'] = '/';
    }
    if (path === '/phone.html') {
      // The phone shows the PC's colour theme (only the theme id goes on <html>; no other view preference).
      const theme = this.host.ctx.viewPrefs.public().prefs['aib-theme'];
      body = new TextEncoder().encode(withThemePref(new TextDecoder().decode(body), theme));
      // A paired phone's cookie is renewed each time the page loads (rolling expiry; Chrome caps a cookie at 400 days).
      const cookie = cookieOf(request.headers);
      const device = this.host.devices.byCookie(cookie);
      if (device && cookie && device.login === request.headers.get(LOGIN_HEADER)) headers['Set-Cookie'] = setCookie(cookie);
    }
    return new Response(body, { status: 200, headers });
  }

  async #bootstrap(request: Request): Promise<Response> {
    const base = { layout: 'phone', pcName: this.host.pcName(), version: APP_VERSION };
    if (!request.headers.has(DEVICE_HEADER)) return this.json(200, { ...base, paired: false });
    const device = this.#device(request, null);
    if (device instanceof Response) return device;
    // The public VAPID key the phone subscribes with, and whether this PC has its subscription (the phone resubscribes anyway).
    let pushKey = '';
    try {
      pushKey = await this.host.vapid.publicKey();
    } catch (error) {
      console.error('Phone push keys could not be read', error);
    }
    return this.json(200, {
      ...base,
      paired: true,
      device: { id: device.id, name: device.name, scopes: [...device.scopes] },
      push: { key: pushKey, on: !!device.push },
    });
  }

  /** This phone turns notifications on (its subscription) or off. */
  async #push(request: Request, path: string): Promise<Response> {
    const body = await this.#body(request);
    const device = this.#device(request, ROUTE_SCOPE[`POST ${path}`]);
    if (device instanceof Response) return device;
    if (path === '/api/remote/push/unsubscribe') {
      await this.host.devices.setPush(device.id, null);
      this.host.audit.write({ device: device.id, name: device.name, action: 'notifications', result: 'turned off on the phone' });
      return this.json(200, { ok: true, on: false });
    }
    const sub = cleanPushSub(body?.subscription, Date.now() / 1000);
    if (!sub) return this.json(400, { error: 'This phone sent no usable notification address. Try again.', code: 'invalid' });
    const had = device.push?.endpoint === sub.endpoint;
    await this.host.devices.setPush(device.id, sub);
    if (!had) this.host.audit.write({ device: device.id, name: device.name, action: 'notifications', result: 'turned on on the phone' });
    return this.json(200, { ok: true, on: true });
  }

  async #pair(request: Request, path: string): Promise<Response> {
    const body = await this.#body(request);
    if (!body) return this.json(400, { error: 'Invalid request' });
    const login = request.headers.get(LOGIN_HEADER) ?? '';
    const owner = this.host.ownerLogin();
    if (!owner || login !== owner) {
      this.host.audit.write({ action: 'pair', result: 'refused: other Tailscale login' });
      return this.json(403, {
        error: 'Sign in to Tailscale on this phone with the same login you use on your PC, then try again.',
        code: 'other_login',
      });
    }
    const pairing = this.host.pairing;
    if (path === '/api/remote/pair/claim') {
      const name = cleanName(body.name);
      try {
        const { claim, claimSecret } = pairing.claim({ code: body.code, name, login, phoneNonce: body.nonce });
        this.host.audit.write({ name, action: 'pair', result: 'waiting for approval on the PC' });
        return this.json(200, {
          claim: claim.id,
          claimSecret,
          pcNonce: claim.pcNonce,
          checkWords: claim.checkWords,
          pcName: this.host.pcName(),
        });
      } catch (error) {
        if (!(error instanceof PairingError)) throw error;
        this.host.audit.write({ name, action: 'pair', result: `refused: ${error.code}` });
        return this.json(error.status, { error: error.message, code: error.code });
      }
    }
    const claim = pairing.status(body.claim, body.claimSecret);
    if (!claim || claim.login !== login) {
      return this.json(404, { error: 'This pairing is no longer open. Start again on your PC.', code: 'no_claim' });
    }
    if (claim.state === 'pending') return this.json(200, { state: 'pending' });
    if (claim.state === 'rejected') return this.json(200, { state: 'rejected' });
    const handover = claim.handover!;
    return this.json(200, { state: 'approved', token: handover.token, device: handover.device }, {
      'Set-Cookie': setCookie(handover.cookie),
    });
  }

  async #deviceRoute(request: Request, url: URL, path: string): Promise<Response> {
    const device = this.#device(request, ROUTE_SCOPE[`GET ${path}`]);
    if (device instanceof Response) return device;
    if (path === '/api/remote/home') {
      const home = await homePayload(this.host.ctx, this.host.pcName(), this.host.titles);
      // The phone's switches go with every answer (turned off on the PC: its buttons go away on the next poll).
      const scopes = [...device.scopes];
      const revision = home.revision + '.' + scopes.map((x) => x.slice(6, 8)).join('');
      const known = url.searchParams.get('rev') ?? request.headers.get('If-None-Match')?.replace(/"/g, '');
      if (known && known === revision) {
        return new Response(null, { status: 304, headers: { ...securityHeadersRemote(), ETag: `"${revision}"` } });
      }
      return this.json(200, { ...home, revision, scopes }, { ETag: `"${revision}"` });
    }
    const id = url.searchParams.get('id') ?? '';
    const tail = Number(url.searchParams.get('tail') ?? DEFAULT_TAIL);
    const after = Math.max(0, Math.trunc(Number(url.searchParams.get('after') ?? 0)) || 0);
    const chat = id ? await chatPayload(this.host.ctx, id, tail, after, this.host.titles) : null;
    if (!chat) return this.json(404, { error: 'This chat is not running on the PC any more.', code: 'connection_not_found' });
    return this.json(200, { ...chat, scopes: [...device.scopes] });
  }

  /** A phone action (remote/actions.ts): device and switch, the body checked against the chat now, then the live op; one log line. */
  async #action(request: Request, path: string): Promise<Response> {
    const { op, audit } = ACTION_OPS[path];
    const body = await this.#body(request);
    const chatOf = (value: unknown) => (typeof value === 'string' ? value.slice(0, 100) : '');
    const device = this.#device(request, ROUTE_SCOPE[`POST ${path}`]);
    if (device instanceof Response) {
      const known = device.status === 403 && this.host.devices.byToken(request.headers.get(DEVICE_HEADER));
      if (known && device.headers.get('X-AIB-Refused') === 'scope') {
        this.host.audit.write({
          device: known.id,
          name: known.name,
          action: audit,
          chat: chatOf(body?.id),
          result: 'refused: switched off',
        });
      }
      return device;
    }
    const log = (chat: unknown, result: string) =>
      this.host.audit.write({ device: device.id, name: device.name, action: audit, chat: chatOf(chat), result });
    if (!body) {
      log('', 'refused: invalid request');
      return this.json(400, { error: 'Invalid request', code: 'invalid' });
    }
    let checked: Record<string, unknown>;
    try {
      checked = await checkAction(this.host.ctx, op, body);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      log(body.id, `refused: ${error.code}`);
      return this.json(error.status, { error: error.message, code: error.code });
    }
    const [status, payload] = await this.host.ctx.host.liveCall(op, checked);
    log(checked.id, status === 200 ? 'done' : `failed (${status})`);
    const answer = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    if (status !== 200) {
      return this.json(status, {
        error: typeof answer.error === 'string' ? answer.error : 'That did not work.',
        code: answer.code ?? 'failed',
      });
    }
    // Only what the phone needs back (never a full queue or state of another chat).
    const out: Record<string, unknown> = { ok: true };
    for (const k of ['accepted', 'duplicate', 'turnState', 'leaseId', 'text', 'queued', 'clientMessageId']) {
      if (k in answer) out[k] = answer[k];
    }
    return this.json(200, out);
  }

  async #image(request: Request, url: URL): Promise<Response> {
    const device = this.#device(request, 'phone.read', true);
    if (device instanceof Response) return device;
    const id = url.searchParams.get('id') ?? '';
    const seq = Math.trunc(Number(url.searchParams.get('seq')));
    const n = Math.trunc(Number(url.searchParams.get('n') ?? 0));
    if (!id || !(seq > 0) || !(n >= 0)) return this.json(400, { error: 'Invalid request' });
    const state = await this.host.ctx.host.liveState(id, seq - 1) as Record<string, unknown> | null;
    const events = Array.isArray(state?.events) ? state!.events as Record<string, unknown>[] : [];
    const event = events.find((e) => e && e.seq === seq);
    const image = event ? imageOf(event, n) : null;
    if (!image) return this.json(404, { error: 'This picture is no longer kept on the PC.' });
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    } catch {
      return this.json(404, { error: 'This picture could not be read.' });
    }
    return new Response(bytes, {
      status: 200,
      headers: { ...securityHeadersRemote(), 'Content-Type': image.mime, 'Content-Security-Policy': "default-src 'none'; sandbox" },
    });
  }
}
