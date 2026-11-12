/**
 * RemoteServer: the phone port (review break 2). A separate loopback listener, bound only while Phone access is on, that Tailscale
 * Serve sends phone traffic to. It is NOT a second WebServer: it never sets ctx.port or ctx.gate, never falls back to
 * WebServer.handle, and answers only the routes in REMOTE_ROUTES, each calling ctx.host / the stores directly. Everything else is
 * 404, every WebSocket is refused, and nothing here ever returns the page token, the agent host or keeper tokens, or an artifact key.
 *
 * Credentials: the device token in the X-AIB-Device header on every API call (the phone keeps it in IndexedDB); an
 * __Host- HttpOnly Secure SameSite=Strict cookie only for GET images (an <img> cannot send a header). Never the reverse.
 *
 * Not running (owner decisions 3b, 4): home lists the chats that are not running; GET /api/remote/saved shows one read only; POST
 * /api/remote/continue starts it again with its saved settings (Send switch); POST /api/remote/read marks a chat read on the PC up
 * to what the phone showed (See chats), at most once per READ_GAP_MS per chat. Paired phones never expire (owner decision 2b).
 *
 * Phase D: GET /api/remote/artifact mints a short-lived signed link for one artifact and this phone, on the phone's artifact port
 * (remote/artifact_server.ts, https://<name>:8443); the page CSP lets the phone page frame that origin and load its images.
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
import { chatPayload, DEFAULT_TAIL, homePayload, imageOf, revisionOf, type TitleCache } from './payloads.ts';
import { CONTINUE_FIELDS, continueSaved, publicSaved, SAVED_TAIL, type SavedChats, savedHistory } from './saved.ts';
import { type ArtifactTickets, remoteArtifactOrigin } from './artifact_server.ts';
import type { Manifest } from '../artifacts/artifacts.ts';
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

export type RemoteAuth = 'static' | 'bootstrap' | 'pair' | 'device' | 'image' | 'action' | 'push' | 'continue' | 'read';
/** A chat's read position is written at most this often for one phone (the phone sends it at most every 5 s anyway). */
export const READ_GAP_MS = 2000;
/** At most one "read" line per phone and chat in the activity log in this time. */
const READ_AUDIT_MS = 10 * 60 * 1000;

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
  // Phase D: a signed link to one artifact on the phone's artifact port.
  ['GET', '/api/remote/artifact', 'device'],
  // Owner decisions 3b and 4: a chat that is not running, read only; Continue this chat; reading marks it read on the PC.
  ['GET', '/api/remote/saved', 'device'],
  ['POST', '/api/remote/continue', 'continue'],
  ['POST', '/api/remote/read', 'read'],
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
  'GET /api/remote/artifact': 'phone.read',
  'GET /api/remote/saved': 'phone.read',
  'POST /api/remote/continue': 'phone.prompt',
  'POST /api/remote/read': 'phone.read',
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
  'phone.read': 'see chats',
  'phone.prompt': 'send messages, stop turns or continue chats',
  'phone.push': 'get notifications',
};

/** What the phone port needs from Phone access (remote/access.ts). */
export interface RemoteHost {
  ctx: WebContext;
  devices: DeviceStore;
  pairing: Pairing;
  audit: Audit;
  titles: TitleCache;
  /** The chats that are not running (remote/saved.ts). */
  saved: SavedChats;
  /** The VAPID keys a phone subscribes with (remote/push.ts). */
  vapid: VapidKeys;
  /** The tailnet name requests must be addressed to ('' = refuse everything). */
  name(): string;
  /** Phase D: https://<name>:8443 while the artifact port listens, else ''. */
  artifactOrigin(): string;
  /** Signs the artifact links the phone opens (checked by the artifact port). */
  tickets: ArtifactTickets;
  /** The Tailscale login of this PC: only phones signed in with it may pair. */
  ownerLogin(): string;
  pcName(): string;
}

/** How the phone shows an artifact kind: a sandboxed page, a picture, text in a sandboxed frame, or "Open on your PC" (a PDF:
 * phone browsers do not show one inside a page). */
export const PHONE_VIEW: Readonly<Record<string, 'page' | 'image' | 'text' | 'pc'>> = {
  html: 'page',
  svg: 'page',
  md: 'page',
  image: 'image',
  csv: 'text',
  json: 'text',
  text: 'text',
  pdf: 'pc',
};

/** The phone port's headers. `artifacts` (https://<name>:8443, or '') is the only other origin the page may frame or load
 * pictures from. */
export function securityHeadersRemote(artifacts = ''): Record<string, string> {
  const other = artifacts ? ' ' + artifacts : '';
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:" + other +
      "; connect-src 'self'; " +
      "font-src 'self'; frame-src " + (artifacts || "'none'") + "; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; " +
      "object-src 'none'",
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
  /** device id + chat key -> when its read position was last written / last logged */
  #readAt = new Map<string, number>();
  #readLogged = new Map<string, number>();
  port = 0;

  constructor(readonly host: RemoteHost) {
    this.gate = new RemoteGate(() => host.name());
  }

  json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...securityHeadersRemote(this.host.artifactOrigin()), ...extra },
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
        case 'continue':
          return await this.#continue(request);
        case 'read':
          return await this.#read(request);
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
    const headers: Record<string, string> = { 'Content-Type': contentType(name), ...securityHeadersRemote(this.host.artifactOrigin()) };
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
      // where this PC's artifacts open on the phone ('' while the artifact port is not up: "Open on your PC")
      artifacts: this.host.artifactOrigin(),
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
      const saved = (await this.host.saved.list(this.host.ctx)).map(publicSaved);
      // The phone's switches go with every answer (turned off on the PC: its buttons go away on the next poll).
      const scopes = [...device.scopes];
      const revision = home.revision + '.' + revisionOf(saved).slice(0, 8) + '.' + scopes.map((x) => x.slice(6, 8)).join('');
      const known = url.searchParams.get('rev') ?? request.headers.get('If-None-Match')?.replace(/"/g, '');
      if (known && known === revision) {
        return new Response(null, { status: 304, headers: { ...securityHeadersRemote(), ETag: `"${revision}"` } });
      }
      return this.json(200, { ...home, saved, revision, scopes }, { ETag: `"${revision}"` });
    }
    if (path === '/api/remote/artifact') return this.#artifact(url, device);
    if (path === '/api/remote/saved') {
      const key = url.searchParams.get('key') ?? '';
      const chat = await this.host.saved.find(this.host.ctx, key);
      if (!chat) {
        // running again (here or on the PC): the phone opens the live chat instead
        const live = await this.#liveByKey(key);
        if (live) return this.json(200, { key, live, scopes: [...device.scopes] });
        return this.json(404, { error: 'This chat is no longer in the list on your PC.', code: 'not_found' });
      }
      const tail = Number(url.searchParams.get('tail') ?? SAVED_TAIL);
      const history = await savedHistory(this.host.ctx, chat, tail, remoteArtifactOrigin(this.host.name()));
      return this.json(200, { ...history, live: null, scopes: [...device.scopes] });
    }
    const id = url.searchParams.get('id') ?? '';
    const tail = Number(url.searchParams.get('tail') ?? DEFAULT_TAIL);
    const after = Math.max(0, Math.trunc(Number(url.searchParams.get('after') ?? 0)) || 0);
    const links = remoteArtifactOrigin(this.host.name());
    const chat = id ? await chatPayload(this.host.ctx, id, tail, after, this.host.titles, links) : null;
    if (!chat) return this.json(404, { error: 'This chat is not running on the PC any more.', code: 'connection_not_found' });
    return this.json(200, { ...chat, scopes: [...device.scopes] });
  }

  /**
   * One artifact for the phone's viewer: its title, kind and version, how the phone shows it, and a signed link on the artifact
   * port for this phone and this artifact (TICKET_SECONDS). `v` picks a version (the one a chat message named); else the latest.
   * Any artifact on this PC can be opened by id: a phone that may see chats already sees every chat these come from.
   */
  #artifact(url: URL, device: Device): Response {
    const id = url.searchParams.get('id') ?? '';
    if (!/^[0-9a-f]{16}$/.test(id)) return this.json(400, { error: 'Invalid request', code: 'invalid' });
    const store = this.host.ctx.artifacts?.store;
    let manifest: Manifest;
    try {
      if (!store) throw new Error('no store');
      manifest = store.get(id);
    } catch {
      return this.json(404, { error: 'This artifact is no longer on the PC.', code: 'not_found' });
    }
    const want = Math.trunc(Number(url.searchParams.get('v') ?? 0));
    const latest = manifest.versions[manifest.versions.length - 1];
    const version = manifest.versions.find((v) => v.n === want) ?? latest;
    const view = PHONE_VIEW[manifest.kind] ?? 'pc';
    const base = { id, title: manifest.title, kind: manifest.kind, version: version.n, latest: latest.n };
    const origin = this.host.artifactOrigin();
    if (view === 'pc' || !origin) {
      return this.json(200, {
        ...base,
        view: 'pc',
        why: view === 'pc' ? 'PDFs open on your PC.' : 'Artifacts open on this phone once phone access on your PC is fully set up.',
      });
    }
    // the store's own link without its loopback origin: /a/<id>/v<n>/<entry>
    const own = store!.versionUrl(manifest, version);
    const path = own.slice(own.indexOf('/a/'));
    const ticket = this.host.tickets.mint(device.id, id);
    return this.json(200, { ...base, view, url: `${origin}/r/${ticket}${path}${manifest.kind === 'md' ? '?view=1' : ''}` });
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

  /** The live connection id of a chat by its key (provider:sessionId), when it is running. */
  async #liveByKey(key: string): Promise<string | null> {
    if (!key) return null;
    const listing = await this.host.ctx.host.liveList() as Record<string, unknown>;
    for (const raw of Array.isArray(listing?.connections) ? listing.connections : []) {
      const c = raw as Record<string, unknown>;
      if (c && !c.closed && typeof c.id === 'string' && `${c.provider}:${c.sessionId}` === key) return c.id;
    }
    return null;
  }

  /** Continue this chat: a listed chat that is not running starts again on the PC with its saved agent and settings. */
  async #continue(request: Request): Promise<Response> {
    const body = await this.#body(request);
    const key = typeof body?.key === 'string' ? body.key.slice(0, 400) : '';
    const device = this.#device(request, 'phone.prompt');
    if (device instanceof Response) {
      const known = device.status === 403 && this.host.devices.byToken(request.headers.get(DEVICE_HEADER));
      if (known && device.headers.get('X-AIB-Refused') === 'scope') {
        this.host.audit.write({ device: known.id, name: known.name, action: 'continue', chat: key, result: 'refused: switched off' });
      }
      return device;
    }
    const log = (result: string, chat = key) =>
      this.host.audit.write({ device: device.id, name: device.name, action: 'continue', chat, result });
    if (!body || !key) {
      log('refused: invalid request');
      return this.json(400, { error: 'Invalid request', code: 'invalid' });
    }
    // Only the chat's key: the agent, model, mode, folder and settings are the chat's saved ones, never the phone's.
    if (Object.keys(body).some((k) => !CONTINUE_FIELDS.has(k))) {
      log('refused: settings');
      return this.json(403, {
        error: 'From a phone a chat continues with its saved agent and settings. To change them, continue it in AIB on your PC.',
        code: 'pc_only',
      });
    }
    const running = await this.#liveByKey(key);
    if (running) return this.json(200, { ok: true, id: running, already: true });
    const chat = await this.host.saved.find(this.host.ctx, key);
    if (!chat) {
      log('refused: not_found');
      return this.json(404, { error: 'This chat is no longer in the list on your PC.', code: 'not_found' });
    }
    const result = await continueSaved(this.host.ctx, chat);
    this.host.saved.invalidate();
    if (result.status !== 200) {
      log(`refused: ${result.code}`);
      return this.json(result.status, { error: result.error, code: result.code });
    }
    log('started on the PC', result.id);
    return this.json(200, { ok: true, id: result.id });
  }

  /**
   * The phone showed a live chat's newest events up to `seq`: mark it read on the PC (the same read-state store the PC page writes).
   * Up to the newest event: read now (as the PC does when you look at a chat); an older one: read up to that event's time. Positions
   * only move forward.
   */
  async #read(request: Request): Promise<Response> {
    const body = await this.#body(request);
    const device = this.#device(request, 'phone.read');
    if (device instanceof Response) return device;
    const id = body?.id;
    const seq = Math.trunc(Number(body?.seq));
    if (typeof id !== 'string' || !id || id.length > 100 || !(seq >= 0)) {
      return this.json(400, { error: 'Invalid request', code: 'invalid' });
    }
    const ctx = this.host.ctx;
    const listing = await ctx.host.liveList() as Record<string, unknown>;
    const entry = (Array.isArray(listing?.connections) ? listing.connections as Record<string, unknown>[] : [])
      .find((c) => c && c.id === id && !c.closed);
    if (!entry) return this.json(409, { error: 'This chat is not running on your PC.', code: 'not_live' });
    const provider = typeof entry.provider === 'string' ? entry.provider : '';
    const sessionId = typeof entry.sessionId === 'string' ? entry.sessionId : '';
    if (!provider || !sessionId) return this.json(200, { ok: true, marked: false });
    const key = `${provider}:${sessionId}`;
    const slot = `${device.id} ${key}`;
    const now = Date.now();
    if (now - (this.#readAt.get(slot) ?? 0) < READ_GAP_MS) return this.json(200, { ok: true, marked: false, throttled: true });
    const cursor = Number(entry.cursor) || 0;
    let seenAt = 0;
    if (seq >= cursor) seenAt = now;
    else if (seq > 0) {
      const state = await ctx.host.liveState(id, seq - 1) as Record<string, unknown> | null;
      const event = (Array.isArray(state?.events) ? state!.events as Record<string, unknown>[] : []).find((e) => e && e.seq === seq);
      const time = Number(event?.time);
      if (time > 0) seenAt = Math.min(now, Math.round(time * 1000));
    }
    if (!seenAt) return this.json(200, { ok: true, marked: false });
    this.#readAt.set(slot, now);
    while (this.#readAt.size > 1000) this.#readAt.delete(this.#readAt.keys().next().value!);
    const before = ctx.readState.public().chats[key]?.seenAt ?? 0;
    await ctx.readState.update({ set: { [key]: { seenAt } } });
    const marked = seenAt > before;
    if (marked && now - (this.#readLogged.get(slot) ?? 0) >= READ_AUDIT_MS) {
      this.#readLogged.set(slot, now);
      while (this.#readLogged.size > 1000) this.#readLogged.delete(this.#readLogged.keys().next().value!);
      this.host.audit.write({ device: device.id, name: device.name, action: 'read', chat: id, result: 'marked read on the PC' });
    }
    return this.json(200, { ok: true, marked });
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
