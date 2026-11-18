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
 * Phase 1c: the socket registry keyed by device (remote/pc_sockets.ts: Remove closes them within 1 s, each message is checked against
 * the device, a 25 s ping), Files download (GET /api/pc/files/download, a computer-only route: see and download, never a save), and
 * the Device activity lines: terminal opened and closed, file downloaded and file outside the project read (by path, never the
 * content), project added and removed. Message text, terminal input and file contents are never logged.
 *
 * File editing (owner decision 2026-11-16, "1a"): a computer with Files uses the PC's file editor routes and its file socket, with the
 * PC's rules plus the blocked folders and the project-root rule (pc_routes.ts); every save is a Device activity line with the device,
 * the path and the result.
 */
import { Principal, REMOTE_PC } from '../web/security.ts';
import type { WebContext } from '../web/server.ts';
import { artifactPost } from '../web/studio_routes.ts';
import { TERMINAL_SOCKET, terminalSocket } from '../web/terminal_routes.ts';
import type { WsLink } from '../platform/websocket.ts';
import { DOCS_SOCKET, docsSocket } from '../web/docs_routes.ts';
import { MAX_PROMPT_BODY_BYTES } from '../acp/attachments.ts';
import type { Device, DeviceStore } from './devices.ts';
import { chatKeys, decide, entryFor, guardOpenFile, systemTerminalKey } from './pc_routes.ts';
import { BlockedPath, guardPath, insideProjects } from './path_guard.ts';
import { FILES_SOCKET, filesSocket } from '../web/live_files_routes.ts';
import { LOGIN_HEADER } from './gate.ts';
import type { DeviceSockets, SocketKind } from './pc_sockets.ts';
import type { Audit } from './audit.ts';
import { parseQs } from '../artifacts/origin.ts';
import { scopeFor } from '../web/files_routes.ts';
import * as files from '../worktrees/files.ts';
import { hostWhenReady, wslLoc } from '../wsl/access.ts';
import { readWslBytes } from '../wsl/artifact_read.ts';
import { WslHelperError } from '../wsl/contract.ts';
import { isBlocked } from './path_guard.ts';
import { MAX_TOTAL_ATTACHMENT_BYTES } from '../acp/attachments.ts';
import { answeredElsewhere, answerOf, answersOf } from '../attention/answers.ts';

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

/**
 * Rate limit per device (design v2 section 7). Phase 1b tuned it to the computer page: its first load and opening a chat send a
 * burst of page requests at once (13 in the busiest second with one chat and no tabs; several tabs and split panes multiply that),
 * then it polls 2-4 a second. Bursts of 60, 20 per second sustained: a page never waits, a runaway tab still cannot starve AIB.
 */
export const RATE_BURST = 60;
export const RATE_PER_SECOND = 20;
export class RateLimit {
  #buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    readonly burst = RATE_BURST,
    readonly perSecond = RATE_PER_SECOND,
    readonly clock: () => number = () => performance.now(),
  ) {}

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

/** Files download for a computer ("Files: see and download"; Download replaces Open in editor). The attachments' 20 MiB cap. */
export const DOWNLOAD_ROUTE = '/api/pc/files/download';
export const MAX_DOWNLOAD_BYTES = MAX_TOTAL_ATTACHMENT_BYTES;
/** The bridge's own routes (not page routes, so not in ROUTE_LIST): what each needs. */
export const PC_OWN_ROUTES: ReadonlyMap<string, readonly string[]> = new Map([[`GET ${DOWNLOAD_ROUTE}`, ['phone.read', 'pc.files']]]);
/** The routes whose body may carry attachments (the PC composer's limits), read only once Send is checked. */
const PROMPT_ROUTES = new Set(['/api/live/prompt', '/api/live/steer', '/api/live/queue']);
/** The file editor's save: every one from a computer is a Device activity line (device, path, result). */
const SAVE_ROUTE = '/api/live/files/save';
/** Phase 2: the routes that answer a card, for "Allowed once on Laptop (Edge)" (attention/answers.ts). */
const ANSWER_ROUTES = new Map<string, 'permission' | 'elicitation' | 'allow-answer'>([
  ['/api/live/permission', 'permission'],
  ['/api/live/elicitation', 'elicitation'],
  ['/api/live/allow/answer', 'allow-answer'],
]);

type Json = Record<string, unknown>;

export interface BridgeHost {
  ctx: WebContext;
  devices: DeviceStore;
  /** The open sockets by device (Remove closes them); missing in unit setups without Phone access. */
  sockets?: DeviceSockets;
  /** Device activity (remote/audit.ts). */
  audit?: Audit;
  /** The answer with the phone port's headers. */
  json(status: number, body: unknown, extra?: Record<string, string>): Response;
  /** Phase 1b: an answer's loopback artifact links as this device's links on the phone's artifact port (remote/pc_page.ts). */
  artifactLinks?(text: string, deviceId: string): string;
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
    const own = PC_OWN_ROUTES.get(`${method} ${path}`);
    if (own) {
      await drain(request);
      const missing = this.#missing(device, own);
      if (missing.length) {
        return this.host.json(403, {
          error: 'This computer may not do that. Turn it on for this computer in AIB on the PC: Settings → Remote control.',
          code: 'scope',
          missing,
        }, { 'X-AIB-Refused': 'scope' });
      }
      this.host.devices.touch(device.id);
      return await this.#download(device, url);
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
    const saving = path === SAVE_ROUTE;
    if (saving && 'refuse' in verdict) this.#logSave(device, body, `refused: ${verdict.refuse}`);
    if (saving && 'need' in verdict && this.#missing(device, verdict.need).length) this.#logSave(device, body, 'refused: scope');
    if ('refuse' in verdict) {
      // phase 2: a card another device answered first says who did
      const first = verdict.refuse === 'gone' && ANSWER_ROUTES.has(path) ? answeredElsewhere(ctx, body?.id, body?.key) : null;
      return this.host.json(verdict.status ?? 403, { error: first ?? verdict.message, code: verdict.refuse }, {
        'X-AIB-Refused': verdict.refuse,
      });
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
    if (saving) {
      // every save from a computer: the device, the path and how it went (never the text)
      let code = '';
      if (answer.status !== 200) code = String((await answer.clone().json().catch(() => ({})) as Json).code ?? answer.status);
      this.#logSave(device, body, answer.status === 200 ? 'saved' : `not saved: ${code}`);
    }
    if (answer.status === 200) {
      this.#logDone(device, path, url, body);
      // phase 2: this computer answered the card (the route just wrote the PC's name: attention/answers.ts)
      const op = ANSWER_ROUTES.get(path);
      if (op) answersOf(ctx).note(body?.id, body?.key, { by: device.id, name: device.name, ...answerOf(op, body) });
    }
    return await this.#remoteLinks(answer, device);
  }

  /** Phase 1b: a JSON answer naming the loopback artifact origin gets this device's links on the artifact port instead (the
   * computer cannot reach, and is never told, the PC's loopback addresses). */
  async #remoteLinks(answer: Response, device: Device): Promise<Response> {
    const links = this.host.artifactLinks;
    if (!links || !(answer.headers.get('Content-Type') ?? '').includes('application/json')) return answer;
    const text = await answer.text();
    // the phone port's own headers (its CSP names the artifact port, never the loopback artifact origin)
    const headers = new Headers(this.host.json(answer.status, null).headers);
    headers.set('Content-Type', answer.headers.get('Content-Type')!);
    return new Response(links(text, device.id), { status: answer.status, headers });
  }

  /** A Device activity line (never message text, terminal input or file contents). */
  #log(device: Device, action: string, result: string, more: { chat?: string; path?: string } = {}): void {
    this.host.audit?.write({ device: device.id, name: device.name, action, result, ...more });
  }

  /** A file save from this computer (owner decision 2026-11-16, 1a): the file's path, never its text. */
  #logSave(device: Device, body: Json | null, result: string): void {
    const id = typeof body?.file === 'string' ? body.file : '';
    const lf = id ? this.host.ctx.liveFiles?.get(id) : null;
    this.#log(device, 'file saved', result, { path: lf ? lf.place.abs : id ? `(file ${id.slice(0, 40)} not open)` : '' });
  }

  /** The Device activity lines of a bridged request that went through: an outside file read, a project added or removed. */
  #logDone(device: Device, path: string, url: URL, body: Json | null): void {
    const text = (v: unknown) => (typeof v === 'string' ? v : '');
    if (path === '/api/live/files/outside') {
      const q = url.searchParams;
      const peek = q.get('peek') === '1';
      this.#log(device, 'file outside the project', peek ? 'looked up' : 'read', { chat: q.get('id') ?? '', path: q.get('path') ?? '' });
    } else if (path === '/api/live/project-add') {
      const paths = [text(body?.path), ...(Array.isArray(body?.paths) ? (body!.paths as unknown[]).map(text) : [])].filter(Boolean);
      for (const p of paths) this.#log(device, 'project added', 'done', { path: p });
    } else if (path === '/api/live/project-remove' && body?.check !== true) {
      this.#log(device, 'project removed', 'done (the folder stays on disk)', { path: text(body?.path) });
    }
  }

  /**
   * GET /api/pc/files/download?id|project&root&path: one file of a chat's folder or an added project, as a download (at most 20 MiB).
   * The same folder rules as the Files view (files_routes.ts scopeFor: never a folder from the request), the blocked folders after
   * links are resolved, and a Device activity line with the path (never the content).
   */
  async #download(device: Device, url: URL): Promise<Response> {
    const { ctx } = this.host;
    const args = parseQs(url.search.slice(1));
    const scope = await scopeFor(ctx, args);
    if (Array.isArray(scope)) return this.host.json(scope[0] as number, scope[1]);
    const stateDir = ctx.stateDir ?? null;
    const blocked = () =>
      this.host.json(403, { error: 'This folder holds sign-ins or AIB data. Open it on the PC itself.', code: 'blocked_folder' });
    const rel = args.path?.[0] ?? '';
    let abs: string, name: string;
    const wsl = wslLoc(scope.root);
    if (wsl) {
      // a WSL project (0.13.0): the bytes through the distro's helper (files.readBytes: the realpath check in the distro, no .git),
      // the blocked names by Linux rules on the folder and on the file's real path
      if (isBlocked(scope.root, stateDir)) return blocked();
      let got: { data: Uint8Array; linuxPath: string; name: string };
      try {
        const host = await hostWhenReady(wsl.distro, 20_000);
        got = await readWslBytes(host, wsl.linuxPath, rel, MAX_DOWNLOAD_BYTES, () => {});
      } catch (error) {
        const code = error instanceof WslHelperError || error instanceof files.FilesError ? error.code : '';
        if (code === 'too_large') {
          return this.host.json(413, { error: `This file is larger than ${MAX_DOWNLOAD_BYTES / 1048576} MiB. Download it on the PC itself.`, code: 'too_big' });
        }
        if (code === 'not_found' || code === 'outside') return this.host.json(404, { error: 'Not found', code: 'not_found' });
        if (code === 'hidden' || code === 'not_file') return this.host.json(400, { error: 'Not a file', code });
        if (error instanceof Error && (error.name === 'ValueError' || error instanceof WslHelperError)) {
          return this.host.json(409, { error: error.message, code: 'wsl_away' });
        }
        if (error instanceof Error && error.name === 'WslReadError') return this.host.json(409, { error: error.message, code: 'changed' });
        throw error;
      }
      const ref = `wsl://${wsl.distro}${got.linuxPath}`;
      if (isBlocked(ref, stateDir)) return blocked();
      return this.#sendDownload(device, args, ref, got.name, got.data);
    }
    try {
      if (isBlocked(scope.root, stateDir)) return blocked();
      let found: [string, string];
      try {
        found = files.resolveInside(scope.root, rel);
      } catch (error) {
        // a local-only file lives in the main folder (files/read lays it over a chat's copy the same way)
        if (!(error instanceof files.FilesError) || error.status !== 404 || scope.main === scope.root) throw error;
        found = files.resolveInside(scope.main, rel);
      }
      abs = found[0];
      if (!found[1]) throw new files.FilesError('Choose a file', 'not_file');
      if (isBlocked(abs, stateDir)) return blocked();
      name = found[1].slice(found[1].lastIndexOf('/') + 1);
      const st = await Deno.stat(abs);
      if (!st.isFile) throw new files.FilesError('Not a file', 'not_file');
      if (st.size > MAX_DOWNLOAD_BYTES) {
        return this.host.json(413, {
          error: `This file is larger than ${MAX_DOWNLOAD_BYTES / 1048576} MiB. Download it on the PC itself.`,
          code: 'too_big',
        });
      }
    } catch (error) {
      if (error instanceof files.FilesError) return this.host.json(error.status, { error: error.message, code: error.code });
      if (error instanceof Deno.errors.NotFound) return this.host.json(404, { error: 'Not found', code: 'not_found' });
      throw error;
    }
    const bytes = await Deno.readFile(abs);
    return this.#sendDownload(device, args, abs, name, bytes);
  }

  #sendDownload(device: Device, args: Record<string, string[]>, abs: string, name: string, bytes: Uint8Array): Response {
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) return this.host.json(413, { error: 'This file is too large.', code: 'too_big' });
    this.#log(device, 'file downloaded', 'done', { chat: args.id?.[0] ?? '', path: abs });
    const headers = new Headers(this.host.json(200, null).headers);
    headers.set('Content-Type', 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${asciiName(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    headers.set('Content-Length', String(bytes.byteLength));
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(bytes as Uint8Array<ArrayBuffer>, { status: 200, headers });
  }

  /** The link a socket's session gets: in the device's registry (Remove closes it; checked per message), with its log lines. */
  #registered(device: Device, kind: SocketKind, chat: string): ((link: WsLink) => WsLink) | null {
    const sockets = this.host.sockets;
    if (!sockets) return null;
    return (link) => {
      if (kind === 'terminal') this.#log(device, 'terminal', 'opened', { chat });
      return sockets.wrap(device.id, kind, link, kind === 'terminal' ? () => this.#log(device, 'terminal', 'closed', { chat }) : null);
    };
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
   * A WebSocket (terminal, docs or the file editor's) from a computer. The device token is the `aib-device.<token>` subprotocol; the exact Origin is
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
      // the shell starts where it was checked: with no cwd given, the chat's folder (never the session's own default)
      const started = new URL(url);
      started.searchParams.set('cwd', cwd);
      const answer = terminalSocket(ctx, request, started, principal, this.#registered(device, 'terminal', key!));
      return 'response' in answer ? answer.response : this.host.json(answer.refused[0], answer.refused[1]);
    }
    if (url.pathname === FILES_SOCKET) {
      // the file editor (owner decision 2026-11-16, 1a): Files; the open file in an added project, never a blocked folder
      if (!device.scopes.includes('pc.files')) {
        return this.host.json(403, { error: 'This computer may not edit files.', code: 'scope', missing: ['pc.files'] });
      }
      const extra = [...new Set(q.keys())].filter((k) => k !== 'file' && k !== 'view');
      if (extra.length) return this.host.json(403, { error: `Not accepted from another computer: ${extra.join(', ')}.`, code: 'pc_only' });
      try {
        guardOpenFile(ctx, q.get('file'));
      } catch (error) {
        if (error instanceof BlockedPath) return this.host.json(error.status, { error: error.message, code: error.code });
        throw error;
      }
      this.host.devices.touch(device.id);
      const answer = filesSocket(ctx, request, url, principal, this.#registered(device, 'files', ''));
      return 'response' in answer ? answer.response : this.host.json(answer.refused[0], answer.refused[1]);
    }
    if (url.pathname === DOCS_SOCKET) {
      // the live doc editor writes through its socket: doc editing is under Send (v2 fix 5)
      const need = ['phone.read', 'phone.prompt'].filter((s) => !(device.scopes as string[]).includes(s));
      if (need.length) return this.host.json(403, { error: 'This computer may not edit docs.', code: 'scope', missing: need });
      this.host.devices.touch(device.id);
      const answer = docsSocket(ctx, request, url, principal, this.#registered(device, 'docs', ''));
      return 'response' in answer ? answer.response : this.host.json(answer.refused[0], answer.refused[1]);
    }
    return this.host.json(404, { error: 'Not found' });
  }
}

/** A file name for the plain filename= part of Content-Disposition: printable ASCII, no quotes or backslashes. */
function asciiName(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'download';
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
