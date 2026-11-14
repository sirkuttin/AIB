/**
 * The phone's artifact port (Phase D, review break 9): a separate loopback listener that Tailscale Serve sends https://<name>:8443
 * to, so the phone page (https://<name>) can show artifacts in a sandboxed frame. It is not the PC's artifact origin (that one stays
 * loopback only and unchanged) and shares only the code that turns a path into a file (artifacts/origin.ts artifactAnswer).
 *
 * Every request must:
 *   - be a GET with Host exactly <name>:8443 (a loopback Host means something on this PC called the port directly);
 *   - carry Serve's Tailscale-User-Login header (Funnel and tagged devices send none);
 *   - not come from another site (Sec-Fetch-Site cross-site, an Origin that is not the phone page, this origin or a sandboxed
 *     frame's "null"; the PC page is http://127.0.0.1, another site), carry no page or agent credential, and not be a WebSocket.
 * An artifact itself is only at /r/<ticket>/a/<id>/v<n>/<entry>: the ticket is a short-lived signed URL token the phone port mints
 * for one paired phone and one artifact (GET /api/remote/artifact). It is checked on every request: signature, expiry, the artifact
 * id in the path, that the phone is still paired (removed phone: its links stop working), that it may see chats, and that the login
 * header is the one it was paired with. A cookie never authorises anything here (cookies are not port-isolated, review break 4).
 * /_lib/ (the vendored chart and diagram libraries, public files) needs the Host and the login of a paired phone, no ticket.
 *
 * Answers carry a CSP built from the request Host: frame-ancestors https://<name> (only the phone page may frame it), script-src
 * this origin's /_lib/ only, and the same sandbox flags as on the PC (never allow-same-origin). Project-file tickets of the PC's
 * Files view are not served here.
 */
import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { artifactAnswer, CSP_TEMPLATE, type Send } from '../artifacts/origin.ts';
import { LIB_PREFIX } from '../artifacts/libs.ts';
import { pathOf } from '../state/paths.ts';
import { serve, type Server as HttpServer } from '../platform/http_serve.ts';
import type { Device, DeviceStore } from './devices.ts';
import { LOGIN_HEADER } from './gate.ts';
import { bindWithRetry } from './port.ts';
import { randomToken } from './words.ts';

/** The https port Tailscale Serve listens on for artifacts (the owner's second `tailscale serve` command). */
export const ARTIFACT_SERVE_PORT = 8443;
/** How long a minted artifact link works. The phone mints a new one each time an artifact is opened. */
export const TICKET_SECONDS = 15 * 60;
const TICKET_PATH =
  /^\/r\/([A-Za-z0-9_-]{1,40})\.([0-9a-f]{16})\.([0-9]{1,12})\.([A-Za-z0-9_-]{43})(\/a\/([0-9a-f]{16})\/v[0-9]{1,6}\/[^?#]+)$/;

/** Signed artifact links for paired phones: <device id>.<artifact id>.<expiry>.<HMAC>. The key lives in memory only (a restart of
 * AIB ends every link; the phone mints another when it opens an artifact). */
export class ArtifactTickets {
  readonly #key = randomToken(32);

  constructor(readonly clock: () => number = () => Date.now() / 1000) {}

  #mac(body: string): string {
    return createHmac('sha256', this.#key).update(body).digest('base64url');
  }

  mint(deviceId: string, artifactId: string, seconds = TICKET_SECONDS): string {
    const body = `${deviceId}.${artifactId}.${Math.floor(this.clock() + seconds)}`;
    return `${body}.${this.#mac(body)}`;
  }

  /** The device id a ticket was minted for, when its signature is right, it has not expired and it names this artifact. */
  check(device: string, artifactId: string, expires: string, mac: string, pathArtifact: string): string | null {
    const want = Buffer.from(this.#mac(`${device}.${artifactId}.${expires}`));
    const got = Buffer.from(mac);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (!(Number(expires) > this.clock())) return null;
    if (artifactId !== pathArtifact) return null;
    return device;
  }
}

/** The artifact origin the phone sees for a tailnet name. */
export function remoteArtifactOrigin(name: string): string {
  return name ? `https://${name}:${ARTIFACT_SERVE_PORT}` : '';
}

/** The page CSP for an artifact on the phone: the PC's policy with the phone page as the only frame ancestor and this origin's
 * /_lib/ as the only script source of its own. */
export function remoteCsp(name: string): string {
  const own = remoteArtifactOrigin(name);
  return CSP_TEMPLATE.replace('frame-ancestors http://127.0.0.1:{port} http://localhost:{port}', `frame-ancestors https://${name}`)
    .replace('https://unpkg.com;', `https://unpkg.com ${own}${LIB_PREFIX};`);
}

/** What the artifact port needs from Phone access. */
export interface ArtifactHost {
  /** The tailnet name ('' = refuse everything). */
  name(): string;
  devices: DeviceStore;
  tickets: ArtifactTickets;
  /** The artifact store folder ('' = none yet). */
  root(): string;
}

export type ArtifactRefusal = 'method' | 'bad_host' | 'no_login' | 'cross_site' | 'credential' | 'websocket' | 'ticket' | 'not_found';

const REFUSALS: Record<ArtifactRefusal, [number, string]> = {
  method: [405, 'Method not allowed'],
  bad_host: [403, "Not this PC's phone address"],
  no_login: [403, 'Phone access works through Tailscale only'],
  cross_site: [403, 'Only the AIB phone page may open this'],
  credential: [403, 'Page credentials are not accepted here'],
  websocket: [403, 'Not available from a phone'],
  ticket: [403, 'This link has expired or is not for this phone. Open the artifact again from the AIB phone page.'],
  not_found: [404, 'Not found'],
};

export class RemoteArtifactServer {
  #server: HttpServer | null = null;
  port = 0;

  constructor(readonly host: ArtifactHost) {}

  async listen(port: number, retryMs?: number): Promise<number> {
    this.#server = await bindWithRetry(
      port,
      (p) =>
        serve({ hostname: '127.0.0.1', port: p, onListen() {}, onError: () => new Response('', { status: 500 }) }, (r) => this.handle(r)),
      retryMs,
    );
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

  #headers(name: string, mime: string, extra: Record<string, string>, page: boolean): Headers {
    const headers = new Headers();
    headers.set('Content-Type', mime);
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Cache-Control', 'no-store');
    headers.set('Cross-Origin-Resource-Policy', 'same-site');
    // Pages get the full artifact policy; anything else (text, images, refusals) may still only be framed by the phone page.
    headers.set(
      'Content-Security-Policy',
      page && name ? remoteCsp(name) : `default-src 'none'; frame-ancestors ${name ? `https://${name}` : "'none'"}; sandbox`,
    );
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return headers;
  }

  #refuse(why: ArtifactRefusal, name: string): Response {
    const [status, text] = REFUSALS[why];
    return new Response(text, { status, headers: this.#headers(name, 'text/plain; charset=utf-8', {}, false) });
  }

  /** Why a request is refused before its path is looked at, or null. */
  check(request: Request): ArtifactRefusal | null {
    const h = request.headers;
    const name = this.host.name();
    if (h.get('Upgrade') !== null || h.has('Sec-WebSocket-Key')) return 'websocket';
    if (request.method !== 'GET') return 'method';
    if (!name || (h.get('Host') ?? '').toLowerCase() !== `${name}:${ARTIFACT_SERVE_PORT}`) return 'bad_host';
    if (h.has('X-Studio-Token') || h.has('X-Studio-Artifact-Key') || h.has('X-AIB-Device')) return 'credential';
    const login = h.get(LOGIN_HEADER);
    if (!login || !login.trim()) return 'no_login';
    if (h.get('Sec-Fetch-Site') === 'cross-site') return 'cross_site';
    const origin = h.get('Origin');
    if (origin !== null && origin !== 'null' && origin !== `https://${name}` && origin !== remoteArtifactOrigin(name)) return 'cross_site';
    return null;
  }

  handle(request: Request): Response {
    const name = this.host.name();
    const refused = this.check(request);
    if (refused) return this.#refuse(refused, name);
    const url = new URL(request.url);
    const target = url.pathname + url.search;
    const login = request.headers.get(LOGIN_HEADER) ?? '';
    const root = this.host.root();
    if (!root) return this.#refuse('not_found', name);
    const send: Send = (status, body, mime = 'text/plain; charset=utf-8', extra = {}, withCsp = false) => {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      return new Response(bytes as Uint8Array<ArrayBuffer>, { status, headers: this.#headers(name, mime, extra, withCsp) });
    };
    if (url.pathname.startsWith(LIB_PREFIX)) {
      // public library files: any phone paired with this login
      if (!this.host.devices.list().some((d) => d.login === login && d.scopes.includes('phone.read'))) return this.#refuse('ticket', name);
      return artifactAnswer(pathOf(root), target, send, false);
    }
    const m = TICKET_PATH.exec(url.pathname);
    if (!m) return this.#refuse(url.pathname.startsWith('/r/') ? 'ticket' : 'not_found', name);
    const [, deviceId, artifactId, expires, mac, rest, pathArtifact] = m;
    const id = this.host.tickets.check(deviceId, artifactId, expires, mac, pathArtifact);
    const device: Device | null = id ? this.host.devices.byId(id) : null;
    if (!device || device.login !== login || !device.scopes.includes('phone.read')) return this.#refuse('ticket', name);
    return artifactAnswer(pathOf(root), rest + url.search, send, false);
  }
}
