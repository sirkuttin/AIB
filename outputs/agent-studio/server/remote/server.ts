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
 *
 * Part 2 (phone UI v2, prototypes round 4): New chat (remote/newchat.ts; the Start new chats switch, a child of Send), the chat
 * card menu (rename into the PC's shared chat names, mark read / unread in the PC's read state, Mark handled, archive, delete and
 * this phone's Undo; every paired phone, except that ending a session needs Send), a chat's artifacts in phone shape and each
 * artifact's versions, and the PC's theme in bootstrap and home. One activity line per action, never message text or names.
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
import { projectsFor } from './projects.ts';
import { CONTINUE_FIELDS, continueSaved, publicSaved, SAVED_TAIL, type SavedChats, savedHistory } from './saved.ts';
import { type ArtifactTickets, remoteArtifactOrigin } from './artifact_server.ts';
import type { Manifest } from '../artifacts/artifacts.ts';
import { bindWithRetry } from './port.ts';
import { agentsNow, folderOfProject, newChatOptions, NewChats, pickLists } from './newchat.ts';
import { reasonWords } from '../agents/eligibility.ts';
import { conversationAction } from '../web/shared.ts';
import { studioOf } from '../web/studio_routes.ts';
import { bringBack, restoreFolders } from '../web/project_routes.ts';
import { isDeleted, isDocHistory } from '../artifacts/artifacts.ts';
import { SAVED_KEY } from './saved.ts';
import { cleanPushSub } from './devices.ts';
import type { VapidKeys } from './push.ts';

const sep = Deno.build.os === 'windows' ? '\\' : '/';
export const DEVICE_HEADER = 'X-AIB-Device';
export const COOKIE_NAME = '__Host-aib-phone';
const COOKIE_MAX_AGE = 400 * 24 * 3600; // Chrome's cap; renewed whenever the phone page loads
/** The biggest body a phone sends: a message of MAX_TEXT (8000) characters of 4-byte emoji, JSON-escaped, and its fields. */
export const MAX_BODY = 48 * 1024;

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
  // the install icons (tools/make_icons.ts PHONE): Android's 192 px, maskable 192 and 512 (the mark inside the safe zone on the
  // brand teal), the iPhone Home Screen icon (180 px, opaque) and the notification badge (white on see-through)
  '/icons/icon-192.png': `icons${sep}phone-192.png`,
  '/icons/maskable-192.png': `icons${sep}phone-maskable-192.png`,
  '/icons/maskable-512.png': `icons${sep}phone-maskable-512.png`,
  '/icons/apple-touch-180.png': `icons${sep}phone-apple-180.png`,
  '/icons/badge-96.png': `icons${sep}phone-badge-96.png`,
};
export const MANIFEST_PATH = '/manifest.webmanifest';

export type RemoteAuth =
  | 'static'
  | 'bootstrap'
  | 'pair'
  | 'device'
  | 'image'
  | 'action'
  | 'push'
  | 'continue'
  | 'read'
  | 'left'
  | 'phone';
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
  // The phone page was hidden: it no longer shows AIB (attention/presence.ts; its polls say what it shows while visible).
  ['POST', '/api/remote/left', 'left'],
  // Phase B: answer, approve once, send, stop, the chat's own queued messages (remote/actions.ts checks every body).
  ['POST', '/api/remote/elicitation', 'action'],
  ['POST', '/api/remote/permission', 'action'],
  ['POST', '/api/remote/prompt', 'action'],
  ['POST', '/api/remote/steer', 'action'],
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
  // Phone UI v2 part 2 (remote/newchat.ts, phone_ops.ts): New chat (the Start new chats switch), the chat card menu (every paired
  // phone; ending a session needs Send), a chat's artifacts.
  ['GET', '/api/remote/new/options', 'device'],
  ['GET', '/api/remote/new', 'device'],
  ['POST', '/api/remote/new', 'phone'],
  ['POST', '/api/remote/new/first', 'phone'],
  ['POST', '/api/remote/chat-op', 'phone'],
  ['POST', '/api/remote/rename', 'phone'],
  ['POST', '/api/remote/mark', 'phone'],
  ['GET', '/api/remote/artifacts', 'device'],
];
/** The activity log word of each part-2 phone POST. */
const PHONE_AUDIT: Readonly<Record<string, string>> = {
  '/api/remote/new': 'new chat',
  '/api/remote/new/first': 'new chat: first message',
  '/api/remote/chat-op': 'chat menu',
  '/api/remote/rename': 'rename',
  '/api/remote/mark': 'mark',
};
/** How long a phone's Undo can bring back a chat it archived or deleted. */
const UNDO_MS = 10 * 60 * 1000;
/** What a phone archived or deleted lately: the op, when, and the chat's archivedAt|deletedAt right after it (its Undo needs both
 * unchanged: a chat the PC restored, archived or deleted since is the PC's). */
interface Undoable {
  op: 'archive' | 'delete';
  at: number;
  stamp: string;
}
const ROUTE_AUTH = new Map(REMOTE_ROUTES.map(([m, p, a]) => [`${m} ${p}`, a]));
/** The scope each device route needs (every REMOTE_ROUTES entry that is not a page file, the bootstrap or pairing has one:
 * remote_server_test sweeps them). */
export const ROUTE_SCOPE: Readonly<Record<string, PhoneScope>> = {
  'GET /api/remote/new/options': 'phone.start',
  'GET /api/remote/new': 'phone.start',
  'POST /api/remote/new': 'phone.start',
  'POST /api/remote/new/first': 'phone.start',
  'POST /api/remote/chat-op': 'phone.read',
  'POST /api/remote/rename': 'phone.read',
  'POST /api/remote/mark': 'phone.read',
  'GET /api/remote/artifacts': 'phone.read',
  'POST /api/remote/left': 'phone.read',
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
  'POST /api/remote/steer': 'phone.prompt',
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
/** The words a refused scope is reported with (what the phone shows; the switch is in Settings > Remote control on the PC). */
const SCOPE_WORDS: Record<string, string> = {
  'phone.answer': 'answer questions',
  'phone.approve': 'approve requests',
  'phone.read': 'see chats',
  'phone.prompt': 'send messages, stop turns or continue chats',
  'phone.start': 'start new chats',
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
  csv: 'page', // a table (the artifact origin draws it with ?view=1)
  json: 'text',
  text: 'text',
  pdf: 'pc',
};

/** What made an artifact version, in the phone's words (artifacts.ts Version.by). */
export const VERSION_BY: Readonly<Record<string, string>> = {
  tool: 'Made by the agent',
  publish: 'Made by the agent',
  watch: 'File changed',
  preview: 'Opened from Files',
  user: 'Edited by you',
  edit: 'Edited by you',
  restore: 'Restored',
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
    // Chrome installs a page with a 192 and a 512 icon; maskable ones fill Android's circle or squircle instead of sitting small
    // in a white one
    icons: [
      { src: '/icons/icon-128.png', sizes: '128x128', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-256.png', sizes: '256x256', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
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
  /** Chats started from a phone (remote/newchat.ts). Kept in memory only: after AIB restarts the phone finds its first message in
   * the chat's own events by its clientMessageId, or puts it back in its box (phone.js checkNewJob). */
  newChats = new NewChats();
  /** device id -> chat key -> what this phone archived or deleted lately, when, and the mark it left (archivedAt / deletedAt):
   * its Undo is only the exact inverse, and only while that mark is still the one it left */
  #undoable = new Map<string, Map<string, Undoable>>();
  /** How long a delete of a running chat waits for its session to end on the agent host. */
  static END_WAIT_MS = 10_000;
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
          ? `This phone may not ${what}. Turn it on for this phone in AIB on your PC: Settings → Remote control.`
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
      // What the phone sent, so a refusal can be diagnosed from the phone's screen (never a token, login or cookie value).
      const h = request.headers;
      const seen = (v: string | null) => (v === null ? '(none)' : v.slice(0, 40));
      const origin = h.get('Origin');
      const detail = `${method} ${path} · Host ${seen(h.get('Host'))} · Site ${seen(h.get('Sec-Fetch-Site'))} · Mode ${
        seen(h.get('Sec-Fetch-Mode'))
      } · Dest ${seen(h.get('Sec-Fetch-Dest'))} · Origin ${origin === null ? '(none)' : seen(origin)}`;
      console.warn(`phone request refused (${refused}): ${detail}`);
      return this.json(status, { error: `${message} (${detail})`, code: refused, detail });
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
        case 'left':
          return await this.#left(request);
        case 'phone':
          return await this.#phone(request, path);
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

  /** The PC's colour theme and status symbols switch (the phone follows them unless its own Theme pick says otherwise). */
  #pcTheme(): { pcTheme: string; pcSymbols: boolean } {
    const prefs = this.host.ctx.viewPrefs.public().prefs;
    const theme = prefs['aib-theme'];
    return {
      pcTheme: typeof theme === 'string' && /^[a-z0-9-]{1,40}$/.test(theme) ? theme : 'teal-dark',
      pcSymbols: prefs['aib-status-glyphs'] === 'on',
    };
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
      ...this.#pcTheme(),
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
    if (path === '/api/remote/artifact') return this.#artifact(url, device);
    if (path === '/api/remote/artifacts') return await this.#artifacts(url, device);
    if (path === '/api/remote/new/options') return await this.#newOptions(url);
    if (path === '/api/remote/new') {
      const status = this.newChats.status(device.id, url.searchParams.get('id') ?? '');
      return status ? this.json(200, status) : this.json(404, { error: 'This new chat is not known here any more.', code: 'not_found' });
    }
    // The page polls only while it is visible: it shows this chat (or no live chat). News held back because this phone is in hand
    // goes with the answer (attention/presence.ts); the page shows it as a banner.
    const presence = this.host.ctx.presence;
    const seen = (chat: string | null) => {
      presence.seePhone(device.id, chat);
      return presence.takeNotices(device.id).map(({ chat, kind, title }) => ({ chat, kind, title }));
    };
    if (path === '/api/remote/home') {
      const notices = seen(null);
      const home = await homePayload(this.host.ctx, this.host.pcName(), this.host.titles);
      const savedList = await this.host.saved.list(this.host.ctx);
      const project = projectsFor(this.host.ctx, savedList.map((c) => c.cwd));
      const saved = savedList.map((c) => ({ ...publicSaved(c), project: project(c.cwd) }));
      // The phone's switches go with every answer (turned off on the PC: its buttons go away on the next poll).
      const scopes = [...device.scopes];
      const theme = this.#pcTheme();
      const revision = home.revision + '.' + revisionOf(saved).slice(0, 8) + '.' + scopes.map((x) => x.slice(6, 8)).join('') + '.' +
        revisionOf(theme).slice(0, 6);
      const known = url.searchParams.get('rev') ?? request.headers.get('If-None-Match')?.replace(/"/g, '');
      if (known && known === revision && !notices.length) {
        return new Response(null, { status: 304, headers: { ...securityHeadersRemote(), ETag: `"${revision}"` } });
      }
      return this.json(200, { ...home, saved, revision, scopes, notices, ...theme }, { ETag: `"${revision}"` });
    }
    if (path === '/api/remote/saved') {
      const notices = seen(null);
      const key = url.searchParams.get('key') ?? '';
      const chat = await this.host.saved.find(this.host.ctx, key);
      if (!chat) {
        // running again (here or on the PC): the phone opens the live chat instead
        const live = await this.#liveByKey(key);
        if (live) return this.json(200, { key, live, scopes: [...device.scopes], notices });
        return this.json(404, { error: 'This chat is no longer in the list on your PC.', code: 'not_found' });
      }
      const tail = Number(url.searchParams.get('tail') ?? SAVED_TAIL);
      const history = await savedHistory(this.host.ctx, chat, tail, remoteArtifactOrigin(this.host.name()));
      return this.json(200, { ...history, live: null, scopes: [...device.scopes], notices });
    }
    const id = url.searchParams.get('id') ?? '';
    const tail = Number(url.searchParams.get('tail') ?? DEFAULT_TAIL);
    const after = Math.max(0, Math.trunc(Number(url.searchParams.get('after') ?? 0)) || 0);
    const links = remoteArtifactOrigin(this.host.name());
    const chat = id ? await chatPayload(this.host.ctx, id, tail, after, this.host.titles, links) : null;
    const notices = seen(chat ? id : null);
    if (!chat) {
      return this.json(404, { error: 'This chat is not running on the PC any more.', code: 'connection_not_found', notices });
    }
    return this.json(200, { ...chat, scopes: [...device.scopes], notices });
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
    if (isDeleted(manifest) || isDocHistory(manifest) || !manifest.versions?.length) {
      return this.json(404, { error: 'This artifact is no longer on the PC.', code: 'not_found' });
    }
    const asked = url.searchParams.get('v');
    const want = Math.trunc(Number(asked ?? 0));
    const latest = manifest.versions[manifest.versions.length - 1];
    const version = asked && want ? manifest.versions.find((v) => v.n === want) : latest;
    if (!version) return this.json(404, { error: 'That version of this artifact is no longer kept on the PC.', code: 'not_found' });
    const view = PHONE_VIEW[manifest.kind] ?? 'pc';
    const base = {
      id,
      title: manifest.title,
      kind: manifest.kind,
      version: version.n,
      latest: latest.n,
      // the viewer's version menu: newest first, each with its time, what made it and its note (no paths, no links)
      versions: [...manifest.versions].reverse().map((v) => ({
        n: v.n,
        at: Number(v.at) || 0,
        by: VERSION_BY[String(v.by)] ?? 'Saved',
        note: typeof v.note === 'string' && !/^rev \d+/.test(v.note) ? v.note.slice(0, 200) : '',
        latest: v.n === latest.n,
      })),
    };
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
    return this.json(200, {
      ...base,
      view,
      url: `${origin}/r/${ticket}${path}${manifest.kind === 'md' || manifest.kind === 'csv' ? '?view=1' : ''}`,
    });
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
    for (const k of ['accepted', 'duplicate', 'turnState', 'state', 'leaseId', 'text', 'queued', 'clientMessageId']) {
      if (k in answer) out[k] = answer[k];
    }
    return this.json(200, out);
  }

  /** A chat's artifacts for its Artifacts page (phone shape: no links, no paths). `key` provider:sessionId; `id` its live id (only
   * that: an artifact filed under another chat's live id is never listed here). */
  async #artifacts(url: URL, device: Device): Promise<Response> {
    const key = url.searchParams.get('key') ?? '';
    const id = url.searchParams.get('id') ?? '';
    if (!SAVED_KEY.test(key) || id.length > 100) return this.json(400, { error: 'Invalid request', code: 'invalid' });
    const found = await this.#listed(key);
    if (!found) return this.json(404, { error: 'This chat is no longer in the list on your PC.', code: 'not_found' });
    if (id && id !== String(found.live?.id ?? '')) {
      this.host.audit.write({ device: device.id, name: device.name, action: 'artifacts', chat: key, result: 'refused: not this chat' });
      return this.json(400, { error: 'Invalid request', code: 'invalid' });
    }
    const store = this.host.ctx.artifacts?.store;
    const items = store ? store.list(key, id ? [id] : []) : [];
    const artifacts = items.map((a) => ({
      id: String(a.id),
      title: String(a.title ?? ''),
      kind: String(a.kind ?? ''),
      version: Number(a.version) || 1,
      versions: Number(a.versions) || 1,
      updatedAt: Number(a.updatedAt) || 0,
      pinned: !!a.pinned,
      archived: typeof a.archivedAt === 'number',
    }));
    artifacts.sort((a, b) => b.updatedAt - a.updatedAt);
    return this.json(200, { key, artifacts });
  }

  /** New chat: the projects and agents (no `project`), or one agent's model and mode lists for one project. */
  async #newOptions(url: URL): Promise<Response> {
    const projectId = url.searchParams.get('project');
    if (projectId !== null) {
      const folder = folderOfProject(this.host.ctx, projectId);
      const agent = url.searchParams.get('agent') ?? '';
      if (!folder) return this.json(404, { error: 'This project is no longer in AIB on your PC.', code: 'not_found' });
      if (!/^[a-z0-9][a-z0-9_-]{0,47}$/.test(agent)) return this.json(400, { error: 'Invalid request', code: 'invalid' });
      // only an agent that can start a chat now: asking a turned-off or missing agent for its lists could start it (a probe)
      const can = (await agentsNow(this.host.ctx)).find((a) => a.id === agent);
      if (!can) return this.json(400, { error: 'Invalid request', code: 'invalid' });
      if (!can.ok) {
        return this.json(403, {
          error: `${can.name} cannot start a chat now: ${reasonWords(can.reason) || can.reason}`,
          code: 'agent_unavailable',
        });
      }
      return this.json(200, { project: projectId, agent, ...(await pickLists(this.host.ctx, folder, agent)) });
    }
    const listing = await this.host.ctx.host.liveList() as Record<string, unknown>;
    const lists: { folder: string; at: number }[] = [];
    for (const raw of Array.isArray(listing?.connections) ? listing.connections : []) {
      const c = raw as Record<string, unknown>;
      if (!c || c.closed) continue;
      lists.push({ folder: String(c.projectRoot || c.cwd || ''), at: Date.now() });
    }
    for (const c of await this.host.saved.list(this.host.ctx)) lists.push({ folder: c.cwd, at: Date.parse(c.lastActive) || 0 });
    return this.json(200, await newChatOptions(this.host.ctx, lists));
  }

  /** Is this chat on a phone's lists (running and not archived or deleted, or listed as not running)? */
  async #listed(
    key: string,
  ): Promise<{ live: Record<string, unknown> | null; cwd: string; title: string; projectRoot: string } | null> {
    const ctx = this.host.ctx;
    const mark = (ctx.conversations.public().entries as unknown as Record<string, Record<string, unknown>>)[key] ?? {};
    const listing = await ctx.host.liveList() as Record<string, unknown>;
    for (const raw of Array.isArray(listing?.connections) ? listing.connections : []) {
      const c = raw as Record<string, unknown>;
      if (!c || c.closed || `${c.provider}:${c.sessionId}` !== key) continue;
      if (mark.archivedAt || mark.deletedAt) return null;
      const info = ((c.breadth as Record<string, unknown> | undefined)?.sessionInfo ?? {}) as Record<string, unknown>;
      const title = ctx.viewPrefs.chatNames()[key] || String(mark.title || '') || String(info.title || '');
      return { live: c, cwd: String(c.cwd || ''), title, projectRoot: String(c.projectRoot || '') };
    }
    const saved = await this.host.saved.find(ctx, key);
    return saved ? { live: null, cwd: saved.cwd, title: saved.title, projectRoot: '' } : null;
  }

  /** The phone's own POST routes of part 2: new chat, the card menu. One activity line each (never message text or names). */
  async #phone(request: Request, path: string): Promise<Response> {
    const body = await this.#body(request);
    const audit = PHONE_AUDIT[path];
    const chatOf = (v: unknown) => (typeof v === 'string' ? v.slice(0, 100) : '');
    const device = this.#device(request, ROUTE_SCOPE[`POST ${path}`]);
    if (device instanceof Response) {
      const known = device.status === 403 && this.host.devices.byToken(request.headers.get(DEVICE_HEADER));
      if (known && device.headers.get('X-AIB-Refused') === 'scope') {
        this.host.audit.write({
          device: known.id,
          name: known.name,
          action: audit,
          chat: chatOf(body?.key ?? body?.id),
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
    try {
      if (path === '/api/remote/new') {
        // the first message goes only while this phone still has Start new chats (and so Send) when the chat is ready
        const allowed = () => !!this.host.devices.byId(device.id)?.scopes.includes('phone.start');
        const started = await this.newChats.start(this.host.ctx, device.id, body, allowed);
        this.host.saved.invalidate();
        log(started.id, started.existing ? 'sent again: the chat it already started' : `started on the PC with ${started.agent}`);
        return this.json(200, { ok: true, id: started.id, ...(started.existing ? { existing: true } : {}) });
      }
      if (path === '/api/remote/new/first') {
        const job = this.newChats.job(device.id, typeof body.id === 'string' ? body.id : '');
        if (!job) throw new Refusal(404, 'not_found', 'This new chat is not known here any more. Send your message in the chat.');
        const checked = await checkAction(this.host.ctx, 'prompt', { id: job.id, text: body.text, clientMessageId: body.clientMessageId });
        const [status, answer] = await this.newChats.send(this.host.ctx, job, checked.text as string, checked.clientMessageId as string);
        log(job.id, status === 200 ? 'first message sent' : `failed (${status})`);
        if (status !== 200) return this.json(status, { error: job.error, code: answer.code ?? 'failed' });
        return this.json(200, { ok: true, state: job.state });
      }
      return await this.#chatOp(path, body, device, log);
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      log(body.key ?? body.id, `refused: ${error.code}`);
      return this.json(error.status, { error: error.message, code: error.code });
    }
  }

  /** Rename, mark read / unread, archive, delete, their Undo, and Mark handled, from the card menu. */
  async #chatOp(
    path: string,
    body: Record<string, unknown>,
    device: Device,
    log: (chat: unknown, result: string) => void,
  ): Promise<Response> {
    const ctx = this.host.ctx;
    const key = typeof body.key === 'string' ? body.key : '';
    if (!SAVED_KEY.test(key)) throw new Refusal(400, 'invalid', 'Invalid request');
    const undo = this.#undoable.get(device.id) ?? new Map<string, Undoable>();
    const op = path === '/api/remote/chat-op' ? String(body.op ?? '') : path === '/api/remote/rename' ? 'rename' : 'mark';
    if (!['rename', 'mark', 'handled', 'archive', 'delete', 'unarchive', 'restore'].includes(op)) {
      throw new Refusal(400, 'invalid', 'Invalid request');
    }
    const isUndo = op === 'unarchive' || op === 'restore';
    const found = isUndo ? null : await this.#listed(key);
    const markOf = () => (ctx.conversations.public().entries as unknown as Record<string, Record<string, unknown>>)[key] ?? {};
    const stampOf = () => `${Number(markOf().archivedAt) || 0}|${Number(markOf().deletedAt) || 0}`;
    if (isUndo) {
      // only the exact inverse of what this phone did lately, and only while the chat is still as this phone left it (archived or
      // deleted then, by this phone): a chat the PC changed since (restored, archived or deleted again) is the PC's now
      const did = undo.get(key);
      if (!did || Date.now() - did.at > UNDO_MS) throw new Refusal(404, 'not_found', 'This can only be undone on your PC now.');
      if ((did.op === 'archive' ? 'unarchive' : 'restore') !== op) {
        throw new Refusal(
          409,
          'not_undo',
          `This phone ${did.op === 'archive' ? 'archived' : 'deleted'} that chat; Undo can only bring it back from that.`,
        );
      }
      if (stampOf() !== did.stamp) {
        undo.delete(key);
        throw new Refusal(409, 'changed', 'This chat was changed on your PC since. Undo it there if you still want to.');
      }
    } else if (!found) throw new Refusal(404, 'not_found', 'This chat is no longer in the list on your PC.');
    const sendOn = device.scopes.includes('phone.prompt');
    const [provider, ...rest] = key.split(':');
    const sessionId = rest.join(':');
    const mark = (action: string) =>
      conversationAction(studioOf(ctx), {
        action,
        provider,
        sessionId,
        title: found?.title ?? '',
        cwd: found?.cwd ?? '',
        projectRoot: found?.projectRoot ?? '',
      });
    const liveId = String(found?.live?.id ?? '');
    switch (op) {
      case 'rename': {
        const name = typeof body.name === 'string' ? body.name : '';
        if (name.length > 200) throw new Refusal(400, 'too_long', 'A chat name can be at most 200 characters.');
        await ctx.viewPrefs.setChatName(key, name);
        this.host.saved.invalidate();
        log(liveId || key, name.trim() ? 'renamed' : 'name cleared');
        return this.json(200, { ok: true });
      }
      case 'mark': {
        if (!found?.live) throw new Refusal(409, 'not_live', 'Only a running chat can be marked read or unread.');
        if (body.read !== true && body.read !== false) throw new Refusal(400, 'invalid', 'Invalid request');
        await ctx.readState.markUnread(key, !body.read);
        log(liveId, body.read ? 'marked read' : 'marked unread');
        return this.json(200, { ok: true });
      }
      case 'handled': {
        if (!found?.live) throw new Refusal(409, 'not_live', 'Only a running chat can be marked handled.');
        const [status, answer] = await mark('handled');
        log(liveId, status === 200 ? 'marked handled' : `failed (${status})`);
        if (status !== 200) {
          console.error(
            `Mark handled from a phone was refused (${status}): ${String((answer as Record<string, unknown>).error ?? '').slice(0, 400)}`,
          );
        }
        return status === 200
          ? this.json(200, { ok: true })
          : this.json(status, { error: 'It could not be marked handled. Try again, or do it on your PC.', code: 'failed' });
      }
      case 'archive':
      case 'delete': {
        const live = !!found?.live;
        const end = op === 'delete' ? live : body.end === true;
        if (live && end && !sendOn) {
          throw new Refusal(
            403,
            'scope',
            op === 'delete'
              ? 'This chat is running. Deleting it from this phone ends its session first, which needs "Send messages, stop turns and ' +
                'continue chats" on for this phone (Settings → Remote control on your PC). You can archive it and keep it running.'
              : 'Ending a chat\'s session from this phone needs "Send messages, stop turns and continue chats" on for this phone ' +
                '(Settings → Remote control on your PC). You can keep it running and archive it.',
          );
        }
        if (live && end) {
          const [status, answer] = await ctx.host.liveCall('disconnect', { id: liveId });
          if (status !== 200) {
            const a = answer && typeof answer === 'object' ? answer as Record<string, unknown> : {};
            console.error(`A phone could not end a chat's session (${status}): ${String(a.error ?? '').slice(0, 400)}`);
            log(liveId, `failed to end the session (${status})`);
            return this.json(status >= 400 && status < 600 ? status : 500, {
              error: 'The session could not be ended. Look at AIB on your PC.',
              code: 'failed',
            });
          }
          // wait until the agent host no longer has it (a delete of a chat that is still live is refused); a session slower to end
          // than that is said: it has ended or is ending, and Delete again goes through
          const until = Date.now() + RemoteServer.END_WAIT_MS;
          const stillLive = async () =>
            !!(await this.#liveByKey(key)) || (op === 'delete' && await ctx.host.studioOwns(provider, sessionId).catch(() => false));
          while ((await stillLive()) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
          if (op === 'delete' && (await stillLive())) {
            this.host.saved.invalidate();
            log(liveId, 'session ending, not deleted yet');
            return this.json(409, {
              error: 'Its session is ending on your PC. It was not deleted yet: delete it again in a moment.',
              code: 'ending',
            });
          }
        }
        const [status, answer] = await mark(op);
        if (status !== 200) {
          const a = answer as Record<string, unknown>;
          console.error(`A phone's ${op} was refused (${status}): ${String(a.error ?? '').slice(0, 400)}`);
          log(liveId || key, `refused: ${String(a.code ?? status)}`);
          return this.json(status, {
            error: live && end
              ? `Its session has ended, but the chat could not be ${
                op === 'delete' ? 'deleted' : 'archived'
              }. Try again, or do it on your PC.`
              : `The chat could not be ${op === 'delete' ? 'deleted' : 'archived'}. Try again, or do it on your PC.`,
            code: String(a.code ?? 'failed'),
          });
        }
        undo.set(key, { op: op as 'archive' | 'delete', at: Date.now(), stamp: stampOf() });
        this.#undoable.set(device.id, undo);
        this.host.saved.invalidate();
        const result = op === 'delete'
          ? (live ? 'session ended, deleted' : 'deleted')
          : !live
          ? 'archived'
          : end
          ? 'session ended, archived'
          : 'archived, kept running';
        log(liveId || key, result);
        return this.json(200, { ok: true });
      }
      default: {
        // unarchive / restore: the Undo of this phone's own archive or delete
        const folders = op === 'restore' ? restoreFolders(ctx.conversations, { action: 'restore', provider, sessionId }) : [];
        const [status, answer] = await conversationAction(studioOf(ctx), { action: op, provider, sessionId });
        if (status !== 200) {
          console.error(`A phone's Undo was refused (${status}): ${String((answer as Record<string, unknown>).error ?? '').slice(0, 400)}`);
          return this.json(status, { error: 'It could not be undone from here. Do it on your PC.', code: 'failed' });
        }
        if (folders.length) await bringBack(ctx.removedProjects, folders, ctx.addedProjects);
        undo.delete(key);
        this.host.saved.invalidate();
        log(key, op === 'restore' ? 'restored (undo)' : 'unarchived (undo)');
        return this.json(200, { ok: true });
      }
    }
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

  /** The phone page was hidden (best effort; a phone that stops polling counts as gone after PHONE_TTL_MS anyway). */
  async #left(request: Request): Promise<Response> {
    await drain(request);
    const device = this.#device(request, null);
    if (device instanceof Response) return device;
    this.host.ctx.presence.leavePhone(device.id);
    return this.json(200, { ok: true });
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
