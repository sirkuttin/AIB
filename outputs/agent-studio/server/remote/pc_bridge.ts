/**
 * PcBridge: a paired COMPUTER's way into AIB's normal routes, on the phone port (design v2 section 11; phase 1a).
 *
 * A deliberate reversal, stated: the phone server never falls back to the page's handlers (remote/server.ts, review break 2). This
 * bridge does call them (WebServer.dispatchAs), but only
 *   - for a device the approver on the PC made a computer (a phone token is refused here: 403 not_computer),
 *   - after RemoteGate (exact Host, Tailscale login, exact Origin, Fetch Metadata) and the device's paired login,
 *   - after refusing every page, agent and host credential header (REFUSED_HEADERS: the bridge never sets or accepts the page token),
 *   - within the device's rate limit,
 *   - after the per-action classification (remote/pc_routes.ts: never, the switches needed, the body or query rules, the blocked
 *     folders and the project-root rule),
 *   - and with an explicit REMOTE_PC principal passed to the handler as an argument (never derived from a header).
 * The own-gate POSTs are never dispatched: agent-key routes are refused by the table, and the page-side artifact actions it allows go
 * to artifactPost with the principal. The sockets come in through pcSocket (the device token as a subprotocol) with their own rules.
 * Nothing here is reachable from, or forwards to, the loopback MCP / hook listener (artifacts/mcp_http.ts) or the agent host.
 *
 * Phase 1c adds the terminal socket registry keyed by device (Remove closes them within 1 s) and the Device activity lines.
 */
import { Principal, REMOTE_PC } from '../web/security.ts';
import type { WebContext } from '../web/server.ts';
import { artifactPost } from '../web/studio_routes.ts';
import { TERMINAL_SOCKET, terminalSocket } from '../web/terminal_routes.ts';
import { DOCS_SOCKET, docsSocket } from '../web/docs_routes.ts';
import { MAX_PROMPT_BODY_BYTES } from '../acp/attachments.ts';
import type { Device, DeviceStore } from './devices.ts';
import { chatKeys, decide, entryFor, systemTerminalKey } from './pc_routes.ts';
import { guardPath, insideProjects } from './path_guard.ts';
import { LOGIN_HEADER } from './gate.ts';

export const DEVICE_HEADER = 'X-AIB-Device';
/** A socket cannot send a header: the device token comes as the subprotocol `aib-device.<token>`. */
export const DEVICE_PROTOCOL_PREFIX = 'aib-device.';

/**
 * Credentials of the page, the agents and the agent host: a request carrying any of them is refused before anything else, so no
 * header can turn a bridged request into the page (review MF2). The subprotocol `aib-token.` (the page token on a socket) too.
 */
export const REFUSED_HEADERS: readonly string[] = [
  'X-Studio-Token', // the page token
  'X-AIB-Page-Key', // the launch key (page_access.ts)
  'X-AIB-Page-Session', // a page session (page_access.ts)
  'X-Studio-Artifact-Key', // an agent's artifact / tool key
  'X-Studio-Hook-Key', // an agent's hook key (artifacts/mcp_http.ts)
  'X-Studio-Hook-Nonce',
  'X-Agent-Host-Token', // the agent host's own token (host/host_client.ts)
];

/** Rate limit per device (design v2 section 7): bursts of 20, 10 per second sustained. */
export class RateLimit {
  #buckets = new Map<string, { tokens: number; at: number }>();
  constructor(readonly burst = 20, readonly perSecond = 10, readonly clock: () => number = () => performance.now()) {}

  take(device: string): boolean {
    const now = this.clock();
    const b = this.#buckets.get(device) ?? { tokens: this.burst, at: now };
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 1000) * this.perSecond);
    b.at = now;
    this.#buckets.set(device, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }

  forget(device: string): void {
    this.#buckets.delete(device);
  }
}

const MAX_BODY = 1_000_000;
/** The routes whose body may carry attachments (the PC composer's limits), read only once Send is checked. */
const PROMPT_ROUTES = new Set(['/api/live/prompt', '/api/live/steer', '/api/live/queue']);

type Json = Record<string, unknown>;

export interface BridgeHost {
  ctx: WebContext;
  devices: DeviceStore;
  /** The answer with the phone port's headers. */
  json(status: number, body: unknown, extra?: Record<string, string>): Response;
}

export class PcBridge {
  readonly limit: RateLimit;

  constructor(readonly host: BridgeHost, limit?: RateLimit) {
    this.limit = limit ?? new RateLimit();
  }

  /** The credential header a request carries that the bridge refuses, or null. */
  static refusedHeader(headers: Headers): string | null {
    for (const name of REFUSED_HEADERS) if (headers.has(name)) return name;
    const offered = (headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
    if (offered.some((p) => p.startsWith('aib-token.'))) return 'Sec-WebSocket-Protocol';
    return null;
  }

  /** The computer behind a device token, or the refusal. Also used by the socket entry. */
  #computer(token: string | null, headers: Headers): Device | Response {
    const { devices } = this.host;
    const device = devices.byToken(token);
    if (!device) return this.host.json(401, { error: 'This device is not paired with this PC.', code: 'not_paired' });
    if (device.login !== (headers.get(LOGIN_HEADER) ?? '')) {
      return this.host.json(403, {
        error: 'This device is signed in to Tailscale with another login than when it was paired.',
        code: 'wrong_login',
      });
    }
    if (device.kind !== 'computer') {
      return this.host.json(403, { error: 'A phone uses the phone page. This needs a device paired as a computer.', code: 'not_computer' });
    }
    if (!this.limit.take(device.id)) {
      return this.host.json(429, { error: 'Too many requests from this computer. Try again in a moment.', code: 'rate_limited' }, {
        'Retry-After': '1',
      });
    }
    return device;
  }

  #principal(device: Device): Principal {
    return new Principal(REMOTE_PC, new Set<string>(device.scopes), null, device.id);
  }

  #missing(device: Device, need: readonly string[]): string[] {
    return need.filter((s) => !(device.scopes as string[]).includes(s));
  }

  /** One bridged API request (GET or POST). The phone port's RemoteGate has already passed it. */
  async handle(request: Request, url: URL): Promise<Response> {
    const { ctx } = this.host;
    const path = url.pathname;
    const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
    const bad = PcBridge.refusedHeader(request.headers);
    if (bad) {
      await drain(request);
      return this.host.json(403, { error: 'Page credentials are not accepted here', code: 'page_credential' });
    }
    const device = this.#computer(request.headers.get(DEVICE_HEADER), request.headers);
    if (device instanceof Response) {
      await drain(request);
      return device;
    }
    const entry = entryFor(method, path);
    if (!entry || (method !== 'GET' && method !== 'POST')) {
      await drain(request);
      return this.host.json(404, { error: 'Not found' });
    }
    if (entry.kind === 'socket') {
      await drain(request);
      return this.host.json(400, { error: 'This address only takes a WebSocket.' });
    }
    if (entry.kind === 'never') {
      await drain(request);
      return this.host.json(403, { error: `This is done on the PC only (${entry.why}).`, code: 'pc_only' }, { 'X-AIB-Refused': 'pc_only' });
    }
    let body: Json | null = null;
    if (method === 'POST') {
      // the big attachment bodies only for a computer with Send (the phone port's rule: nothing more than MAX_BODY read otherwise)
      const max = PROMPT_ROUTES.has(path) && device.scopes.includes('phone.prompt') ? MAX_PROMPT_BODY_BYTES : MAX_BODY;
      const read = await readJson(request, max);
      if (read === 'too_big') return this.host.json(413, { error: 'Invalid request size' });
      if (read === null) return this.host.json(400, { error: 'Invalid request' });
      body = read;
    }
    const verdict = await decide(entry, { method, path, query: url.searchParams, body, ctx });
    if ('refuse' in verdict) {
      return this.host.json(verdict.status ?? 403, { error: verdict.message, code: verdict.refuse }, { 'X-AIB-Refused': verdict.refuse });
    }
    const missing = this.#missing(device, verdict.need);
    if (missing.length) {
      return this.host.json(403, {
        error: 'This computer may not do that. Turn it on for this computer in AIB on the PC: Settings → Remote control.',
        code: 'scope',
        missing,
      }, { 'X-AIB-Refused': 'scope' });
    }
    this.host.devices.touch(device.id);
    const principal = this.#principal(device);
    if (method === 'POST' && path.startsWith('/api/live/artifacts/')) {
      // the page-side artifact actions (the table never lets an agent-key one through): with the principal, no gate of their own
      const [status, payload] = await artifactPost(ctx, { headers: request.headers, principal }, path, body!);
      return this.host.json(status, payload);
    }
    if (!ctx.dispatchAs) return this.host.json(503, { error: 'AIB is starting. Try again in a moment.', code: 'busy' });
    const answer = await ctx.dispatchAs(principal, method as 'GET' | 'POST', url, request, body);
    if (path === '/api/live/terminal/list' && answer.status === 200) return await this.#terminalList(answer);
    return answer;
  }

  /** GET /api/live/terminal/list for a computer: only the chat terminals of added projects (never a sign-in or setup one). */
  async #terminalList(answer: Response): Promise<Response> {
    const data = await answer.json() as Json;
    const keys = await chatKeys(this.host.ctx);
    const list = Array.isArray(data.terminals) ? data.terminals as Json[] : [];
    const terminals = list.filter((t) => t && typeof t.key === 'string' && !systemTerminalKey(t.key) && keys.has(t.key));
    return this.host.json(200, { ...data, terminals });
  }

  /**
   * A WebSocket (terminal or docs) from a computer. The device token is the `aib-device.<token>` subprotocol; the exact Origin is
   * required (RemoteGate checks it is this PC's address; here it must be present). The terminal: Terminal switch, a plain shell for a
   * chat key of an added project, cwd inside that chat's folder; no signin, setup, distro, shell, arg, step or start (v2 fix 4, 6).
   * The cwd rule is where the shell starts, not containment: a shell can cd anywhere, accepted under the Terminal switch.
   */
  async socket(request: Request, url: URL): Promise<Response> {
    const { ctx } = this.host;
    if (PcBridge.refusedHeader(request.headers)) {
      return this.host.json(403, { error: 'Page credentials are not accepted here', code: 'page_credential' });
    }
    if (request.headers.get('Origin') === null) {
      return this.host.json(403, { error: 'Request must come from the AIB page', code: 'bad_origin' });
    }
    const offered = (request.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((p) => p.trim());
    const token = offered.find((p) => p.startsWith(DEVICE_PROTOCOL_PREFIX))?.slice(DEVICE_PROTOCOL_PREFIX.length) ?? null;
    const device = this.#computer(token, request.headers);
    if (device instanceof Response) return device;
    const principal = this.#principal(device);
    const q = url.searchParams;
    if (url.pathname === TERMINAL_SOCKET) {
      if (!device.scopes.includes('pc.terminal')) {
        return this.host.json(403, { error: 'This computer may not open a terminal.', code: 'scope', missing: ['pc.terminal'] });
      }
      const allowed = new Set(['key', 'cwd', 'cols', 'rows', 'resume']);
      const extra = [...new Set(q.keys())].filter((k) => !allowed.has(k));
      if (extra.length) {
        return this.host.json(403, {
          error: `Only a chat's own shell opens from another computer (${extra.join(', ')}).`,
          code: 'pc_only',
        });
      }
      const key = q.get('key');
      if (systemTerminalKey(key)) return this.host.json(403, { error: "AIB's sign-in and setup terminals are the PC's.", code: 'pc_only' });
      const folder = key ? (await chatKeys(ctx)).get(key) : undefined;
      if (!folder) {
        return this.host.json(403, { error: 'Only a chat terminal of a project added to AIB opens from here.', code: 'pc_only' });
      }
      const cwd = q.get('cwd') || folder;
      try {
        guardPath(cwd, ctx.stateDir);
      } catch {
        return this.host.json(403, { error: 'This folder holds sign-ins or AIB data. Open it on the PC itself.', code: 'blocked_folder' });
      }
      if (!insideProjects(cwd, [folder])) {
        return this.host.json(403, { error: "A chat's terminal starts in the chat's folder.", code: 'pc_only' });
      }
      this.host.devices.touch(device.id);
      const answer = terminalSocket(ctx, request, url, principal);
      return 'response' in answer ? answer.response : this.host.json(answer.refused[0], answer.refused[1]);
    }
    if (url.pathname === DOCS_SOCKET) {
      // the live doc editor writes through its socket: doc editing is under Send (v2 fix 5)
      const need = ['phone.read', 'phone.prompt'].filter((s) => !(device.scopes as string[]).includes(s));
      if (need.length) return this.host.json(403, { error: 'This computer may not edit docs.', code: 'scope', missing: need });
      this.host.devices.touch(device.id);
      const answer = docsSocket(ctx, request, url, principal);
      return 'response' in answer ? answer.response : this.host.json(answer.refused[0], answer.refused[1]);
    }
    return this.host.json(404, { error: 'Not found' });
  }
}

async function drain(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch { /* nothing to read */ }
}

/** The JSON object of a POST, at most `max` bytes ('too_big' past that), or null when it is not one. */
async function readJson(request: Request, max: number): Promise<Json | null | 'too_big'> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > max) {
    await drain(request);
    return 'too_big';
  }
  const reader = request.body?.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return 'too_big';
    }
    parts.push(value);
  }
  if (!size) return null;
  const raw = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    raw.set(part, at);
    at += part.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(raw));
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}
