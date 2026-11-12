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
import type { WebContext } from '../web/server.ts';
import type { Audit } from './audit.ts';
import { cleanName, type Device, type DeviceStore, type PhoneScope } from './devices.ts';
import { LOGIN_HEADER, REMOTE_REASONS, RemoteGate } from './gate.ts';
import { type Pairing, PairingError } from './pairing.ts';
import { chatPayload, DEFAULT_TAIL, homePayload, imageOf, type TitleCache } from './payloads.ts';
import { bindWithRetry } from './port.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
export const DEVICE_HEADER = 'X-AIB-Device';
export const COOKIE_NAME = '__Host-aib-phone';
const COOKIE_MAX_AGE = 400 * 24 * 3600; // Chrome's cap; renewed whenever the phone page loads
const MAX_BODY = 16 * 1024;

/** The phone page's files (and only these) are served on the phone port. Never chat.html, '/', or the page bootstrap. */
export const REMOTE_STATIC: Readonly<Record<string, string>> = {
  '/phone.html': 'phone.html',
  '/phone.css': 'phone.css',
  '/phone.js': 'phone.js',
  '/phone-words.js': 'phone-words.js',
  '/markdown.js': 'markdown.js',
};

export type RemoteAuth = 'static' | 'bootstrap' | 'pair' | 'device' | 'image';

/** Every route the phone port answers (method, path, how it is authorised). Default deny: anything else is 404. */
export const REMOTE_ROUTES: readonly [string, string, RemoteAuth][] = [
  ...Object.keys(REMOTE_STATIC).map((p) => ['GET', p, 'static'] as [string, string, RemoteAuth]),
  ['GET', '/api/remote/bootstrap', 'bootstrap'],
  ['POST', '/api/remote/pair/claim', 'pair'],
  ['POST', '/api/remote/pair/status', 'pair'],
  ['GET', '/api/remote/home', 'device'],
  ['GET', '/api/remote/chat', 'device'],
  ['GET', '/api/remote/image', 'image'],
];
const ROUTE_AUTH = new Map(REMOTE_ROUTES.map(([m, p, a]) => [`${m} ${p}`, a]));
/** The scope each device route needs. */
const ROUTE_SCOPE: Record<string, PhoneScope> = {
  'GET /api/remote/home': 'phone.read',
  'GET /api/remote/chat': 'phone.read',
  'GET /api/remote/image': 'phone.read',
};

/** What the phone port needs from Phone access (remote/access.ts). */
export interface RemoteHost {
  ctx: WebContext;
  devices: DeviceStore;
  pairing: Pairing;
  audit: Audit;
  titles: TitleCache;
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
  return (name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css') + '; charset=utf-8';
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
    if (scope && !device.scopes.includes(scope)) return this.json(403, { error: 'This phone may not do that.', code: 'scope' });
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
          return this.#bootstrap(request);
        case 'pair':
          return await this.#pair(request, path);
        case 'device':
          return await this.#deviceRoute(request, url, path);
        case 'image':
          return await this.#image(request, url);
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
    const name = REMOTE_STATIC[path];
    const body = await Deno.readFile(APP_ROOT + sep + name);
    const headers: Record<string, string> = { 'Content-Type': contentType(name), ...securityHeadersRemote() };
    if (path === '/phone.html') {
      // A paired phone's cookie is renewed each time the page loads (rolling expiry; Chrome caps a cookie at 400 days).
      const cookie = cookieOf(request.headers);
      const device = this.host.devices.byCookie(cookie);
      if (device && cookie && device.login === request.headers.get(LOGIN_HEADER)) headers['Set-Cookie'] = setCookie(cookie);
    }
    return new Response(body, { status: 200, headers });
  }

  #bootstrap(request: Request): Response {
    const base = { layout: 'phone', pcName: this.host.pcName(), version: APP_VERSION };
    if (!request.headers.has(DEVICE_HEADER)) return this.json(200, { ...base, paired: false });
    const device = this.#device(request, null);
    if (device instanceof Response) return device;
    return this.json(200, { ...base, paired: true, device: { id: device.id, name: device.name, scopes: [...device.scopes] } });
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
      const known = url.searchParams.get('rev') ?? request.headers.get('If-None-Match')?.replace(/"/g, '');
      if (known && known === home.revision) {
        return new Response(null, { status: 304, headers: { ...securityHeadersRemote(), ETag: `"${home.revision}"` } });
      }
      return this.json(200, home, { ETag: `"${home.revision}"` });
    }
    const id = url.searchParams.get('id') ?? '';
    const tail = Number(url.searchParams.get('tail') ?? DEFAULT_TAIL);
    const after = Math.max(0, Math.trunc(Number(url.searchParams.get('after') ?? 0)) || 0);
    const chat = id ? await chatPayload(this.host.ctx, id, tail, after, this.host.titles) : null;
    if (!chat) return this.json(404, { error: 'This chat is not running on the PC any more.', code: 'connection_not_found' });
    return this.json(200, chat);
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
