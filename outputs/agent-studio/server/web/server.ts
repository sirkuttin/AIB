/**
 * The Deno web server (studio.py's web side, web_handler.py's dispatch). One gate for every request (security.ts), then the route:
 * the live routes answered by the agent host (live_routes.ts), the Studio routes (studio_routes.ts), the transcript viewer
 * (transcripts/monitor.ts), the page files and bootstrap below. Every route is served here; stage B's private Python web server is gone.
 * The HTTP API is identical to the Python server's; work/contract/ checks it against both servers.
 */
import { type Backend, KeepAwake, realBackend } from '../platform/keep_awake.ts';
import { ABOUT_LINE, APP_ROOT, APP_VERSION, VERSION_LABEL } from '../core/app.ts';
import type { LiveBackend } from '../host/backend.ts';
import { HostUnavailable } from '../host/host_client.ts';
import { keeperProblem } from '../keeper/link.ts';
import { ConversationState, ProjectPrefs, ReadState, SettingsStore } from '../state/store.ts';
import { ViewPrefs, ViewPrefsBusy } from '../state/view_prefs.ts';
import { authorize, drawingHeaders, Gate, newToken, Principal, Refusal, securityHeaders, TOKEN_HEADER } from './security.ts';
import { routeKind, ROUTES } from './routes.ts';
import { handleGet as monitorGet, type Source } from '../transcripts/monitor.ts';
import { liveRoutes } from './live_routes.ts';
import { chatStudioOf, makeLauncher, ownGatePost, savedFolders, type StudioHandler, studioOf, studioRoutes } from './studio_routes.ts';
import { type AgentOptions, notices } from './shared.ts';
import { check as checkArtifactKey } from '../artifacts/keys.ts';
import { Artifacts } from './artifact_wiring.ts';
import type { Launcher } from '../desktop/editors.ts';
import { FolderMemory } from '../desktop/folders.ts';
import { Refused } from '../worktrees/merge.ts';
import { EditorError } from '../desktop/editors.ts';
import type { UpdateService } from '../desktop/updater.ts';
import { cleanNotifyRequest, type DesktopNotifications } from '../desktop/notify.ts';
import { MAX_PROMPT_BODY_BYTES } from '../acp/attachments.ts';
import { pathStr } from '../platform/pypath.ts';
import { serve, type Server as HttpServer } from '../platform/http_serve.ts';
import { TerminalSessions } from '../terminal/sessions.ts';
import type { KeeperLink } from '../keeper/link.ts';
import { TERMINAL_SOCKET, terminalRoutes, terminalSocket } from './terminal_routes.ts';
import { RemovedProjects } from '../desktop/project_delete.ts';
import { filterSessions, folderOfSession, projectAdd, projectRemove } from './project_routes.ts';
import { FolderPresence, presence } from '../desktop/folder_presence.ts';
import { AddedProjects } from '../desktop/added_projects.ts';
import { filesRoutes } from './files_routes.ts';
import { DOCS_SOCKET, docsRoutes, docsSocket } from './docs_routes.ts';
import { DocStore } from '../docs/store.ts';
import { ArtifactHistory } from '../docs/history.ts';
import { type AccessOptions, PhoneAccess } from '../remote/access.ts';
import { Presence } from '../attention/presence.ts';
import type { DeviceStore } from '../remote/devices.ts';
import { devicesRoutes } from './devices_routes.ts';

/** web_handler.WEB_STARTED: when this web server started (seconds since the epoch). */
const WEB_STARTED = Date.now() / 1000;
const sep = Deno.build.os === 'windows' ? '\\' : '/';
const ASSET_NAME = /^\/([a-z0-9][a-z0-9-]*\.(?:js|css))$/;
const MAX_BODY = 1_000_000;

/** Vendored libraries (Deno only; the Python reference server has none): vendor/xterm/<name>.js|css. */
const VENDOR_ASSET = /^\/vendor\/(xterm|docs)\/([a-z0-9][a-z0-9-]*\.(?:js|css))$/;
/** The drawing page's Excalidraw bundle (tools/drawing/build.mjs): its code-split chunks, its CSS and its fonts. The server-only
 * Mermaid converter is not served. */
const EXCALIDRAW_ASSET = /^\/vendor\/excalidraw\/((?:chunks\/|assets\/|fonts\/[A-Za-z]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:js|css|woff2))$/;

/** The drawing editor page and its boot script: served with their own CSP (security.ts drawingHeaders). */
const DRAWING_PAGE: Record<string, string> = { '/doc-drawing.html': 'drawing.html', '/doc-drawing-boot.js': 'drawing-boot.js' };

/** web_handler.studio_asset: map a request path to a Studio page file name, or null if Studio does not serve it. */
export function studioAsset(path: string): string | null {
  if (path === '/' || path === '/chat.html') return 'chat.html';
  if (path === '/doc.html') return 'doc.html'; // the local docs' editor page (a test page until the UI lands)
  const excalidraw = path.match(EXCALIDRAW_ASSET);
  if (excalidraw && !excalidraw[1].includes('..') && excalidraw[1] !== 'mermaid_headless.js') {
    try {
      return Deno.statSync(`${APP_ROOT}${sep}vendor${sep}excalidraw${sep}${excalidraw[1].replace(/\//g, sep)}`).isFile
        ? `vendor/excalidraw/${excalidraw[1]}`
        : null;
    } catch {
      return null;
    }
  }
  const vendored = path.match(VENDOR_ASSET);
  if (vendored) {
    try {
      return Deno.statSync(`${APP_ROOT}${sep}vendor${sep}${vendored[1]}${sep}${vendored[2]}`).isFile
        ? `vendor/${vendored[1]}/${vendored[2]}`
        : null;
    } catch {
      return null;
    }
  }
  const match = path.match(ASSET_NAME);
  if (!match) return null;
  try {
    return Deno.statSync(APP_ROOT + sep + match[1]).isFile ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * chat.html with the saved view preferences in a JSON data block (`<script type="application/json" id="aibViewPrefs">`) before
 * </head>, for view-prefs.js to put into localStorage before any other page script reads it. A data block is not run, so the
 * page's CSP (script-src 'self') is unchanged; '<' is escaped so no value can close the block.
 */
export function withViewPrefs(html: string, prefs: Record<string, string>): string {
  const at = html.indexOf('</head>');
  if (at < 0) return html;
  const data = JSON.stringify({ prefs }).replace(/</g, '\\u003c');
  return withThemePref(
    html.slice(0, at) + '<script type="application/json" id="aibViewPrefs">' + data + '</script>' + html.slice(at),
    prefs['aib-theme'],
    prefs['aib-status-glyphs'],
  );
}

/**
 * The saved colour theme on <html data-theme-pref="..."> (and the status-symbols switch on data-status-glyphs-pref), so themes.js (the first, blocking script) paints it before anything
 * shows. Only a plain theme id is written; anything else leaves the page as it is (themes.js then uses its default).
 */
export function withThemePref(html: string, pref: string | undefined, symbols?: string): string {
  let attrs = '';
  if (typeof pref === 'string' && /^[a-z0-9-]{1,40}$/.test(pref)) attrs += ` data-theme-pref="${pref}"`;
  if (symbols === 'on' || symbols === 'off') attrs += ` data-status-glyphs-pref="${symbols}"`;
  if (!attrs) return html;
  return html.replace(/^(<!doctype html>)?<html\b/i, (m) => m + attrs);
}

/** Added projects whose folder is gone from the disk (folder_presence.ts, cached): the page leaves them out until it is back. */
function goneAdded(c: WebContext): string[] {
  const out: string[] = [];
  for (const [key, item] of Object.entries(c.addedProjects.public().added)) if (c.folderPresence.isGone(item.path)) out.push(key);
  return out.sort();
}
/** A short stable signature of a list of keys (FNV-1a), so the revision changes when an added folder goes or comes back. */
function signatureOf(keys: string[]): string {
  let h = 2166136261;
  for (const ch of keys.join(String.fromCharCode(10))) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `${keys.length}.${h.toString(36)}`;
}

/** The project preferences plus the removed and the added projects, under one revision (the list route reports the same one). */
function projectsRevision(c: WebContext): string {
  const parts = [c.projectPrefs.revision(), c.removedProjects.revision(), c.addedProjects.revision(), signatureOf(goneAdded(c))];
  return parts.join('+');
}
function projectsView(c: WebContext): Record<string, unknown> {
  const gone = new Set(goneAdded(c));
  const added: Record<string, { path: string; at: number; gone?: true }> = {};
  for (const [key, item] of Object.entries(c.addedProjects.public().added)) added[key] = gone.has(key) ? { ...item, gone: true } : item;
  return { ...c.projectPrefs.public(), removed: c.removedProjects.public().removed, added, revision: projectsRevision(c) };
}

function contentType(name: string): string {
  if (name.endsWith('.woff2')) return 'font/woff2';
  return (name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css') + '; charset=utf-8';
}

export interface WebContext {
  token: string;
  webInstanceId: string;
  port: number;
  /** The --port flag as given (bootstrap reports it as webPort, like Python: 0 when any free port was asked for). */
  cliPort: number;
  host: LiveBackend;
  /** The update checker and installer (updater.ts), started by main.ts. */
  updates: UpdateService;
  conversations: ConversationState;
  projectPrefs: ProjectPrefs;
  /** Projects removed from AIB ("Delete project…"): served with the project preferences. */
  removedProjects: RemovedProjects;
  /** The projects the user added (desktop/added_projects.ts): served with the project preferences; saved chats of other folders
   * are not listed. */
  addedProjects: AddedProjects;
  /** Which folders are gone from the disk (cached); added projects whose folder is gone are left out of the page's list. */
  folderPresence: FolderPresence;
  readState: ReadState;
  settings: SettingsStore;
  /** The transcript viewer's data (monitor.py): OMP sessions and Claude Code projects. */
  transcripts: Source;
  /** The transcript folders (for the model-in-use lookup of /api/live/state). */
  options: { claudeProjects: string; ompSessions: string };
  /** Called after POST /api/live/shutdown has been answered: the normal close path (the agent host keeps running). */
  shutdown: () => void;
  /** The state folder (worktree registry, clash and sync files, folder memory, artifacts). */
  stateDir: string;
  /** The agent options the Settings agent list reads (launchers, node, state folder, migration). */
  agentOptions: AgentOptions;
  launcher: Launcher;
  folderMemory: FolderMemory;
  /** The page's view and appearance preferences (state/view_prefs.ts): served inside chat.html, saved by POST /api/live/view-prefs. */
  viewPrefs: ViewPrefs;
  artifacts: Artifacts;
  /** This server's gate (set once it listens): the own-gate routes call it after reading the body. */
  gate: Gate | null;
  /** The live list the editor roots read (refreshed before each editor request). */
  editorList: Record<string, unknown>;
  /** The open local docs (docs/store.ts). */
  docs: DocStore;
  /** The chats' terminal shells (terminal/sessions.ts); ended when this server closes. */
  terminals: TerminalSessions;
  /** The desktop app's own notifications (desktop/notify.ts), set by main.ts in the app; null in a server run (a browser uses the
   * web Notification API instead). */
  desktopNotify: DesktopNotifications | null;
  /** Phone access (remote/access.ts): the switch, Tailscale checks, the phone port, pairing. Settings > Devices. */
  phone: PhoneAccess;
  /** The paired phones (<state>/devices.json; remote/devices.ts), the same store phone.devices holds. */
  devices: DeviceStore;
  /** Whether the owner is at the PC (the page reports it: POST /api/live/presence): no desktop notification while an AIB window
   * has focus, no phone push while the owner is working in it (attention/presence.ts). */
  presence: Presence;
  /** "Keep this PC awake while AIB runs" (platform/keep_awake.ts): applied from Settings and at start, released on close. */
  keepAwake: KeepAwake;
}

type Handler = (ctx: WebContext, url: URL, body: Record<string, unknown> | null, request: Request) => Promise<Response> | Response;

export class WebServer {
  gate!: Gate;
  #server: HttpServer | null = null;
  readonly native = new Map<string, Handler>();

  constructor(readonly ctx: WebContext) {
    this.native.set('GET /api/live/list', async (c) => {
      const listing = await c.host.liveList();
      // Recovered chats (open before a restart) of folders that are not added projects are not listed either.
      const recovered = Array.isArray(listing.recovered)
        ? (listing.recovered as unknown[]).filter((r) =>
          !r || typeof r !== 'object' || c.addedProjects.shows(folderOfSession(r))
        )
        : listing.recovered;
      return this.json(200, {
        ...listing,
        ...(recovered === undefined ? {} : { recovered }),
        conversationRevision: c.conversations.revision(),
        projectsRevision: projectsRevision(c),
        readStateRevision: c.readState.revision(),
        settingsRevision: c.settings.revision(),
        webInstanceId: c.webInstanceId,
      });
    });
    this.native.set('GET /api/live/conversation-state', (c) => this.json(200, c.conversations.public()));
    this.native.set('GET /api/live/read-state', (c) => this.json(200, c.readState.public()));
    this.native.set('POST /api/live/read-state', async (c, _url, body) => {
      await c.readState.update(body);
      return this.json(200, { ...c.readState.public(), ok: true });
    });
    this.native.set('POST /api/live/view-prefs', async (c, _url, body) => {
      let result;
      c.viewPrefs.begin(); // quitting waits for it (main.ts close, ViewPrefs.settle)
      try {
        const slow = Number(Deno.env.get('AIB_TEST_SLOW_VIEW_PREFS_MS') ?? 0); // tests: a save that takes long (a busy machine)
        if (slow > 0) await new Promise((r) => setTimeout(r, Math.min(slow, 5000)));
        result = await c.viewPrefs.update(body);
      } catch (error) {
        if (error instanceof ViewPrefsBusy) return this.json(503, { error: error.message, code: 'busy' });
        throw error;
      } finally {
        c.viewPrefs.end();
      }
      const view = c.viewPrefs.public();
      return this.json(200, { revision: view.revision, warning: view.warning, refused: result.refused, ok: true });
    });
    // The desktop app shows a notification itself: the Settings test (the AttentionWatcher shows the others from the server, never
    // the page). {title, body, target?, test?} -> {ok, shown, reason?, mechanism}.
    this.native.set('POST /api/live/desktop/notify', async (c, _url, body) => {
      const n = c.desktopNotify;
      if (!n) return this.json(409, { error: 'Only the AIB desktop app shows notifications itself' });
      const result = await n.show(cleanNotifyRequest(body));
      return this.json(200, { ok: true, shown: result.shown, reason: result.reason ?? '', mechanism: n.mechanism });
    });
    // The page: its window has focus or not, and how long since the last input in it (attention/presence.ts).
    this.native.set('POST /api/live/presence', (c, _url, body) => {
      c.presence.report(body?.focused, body?.idleMs);
      return this.json(200, { ok: true });
    });
    this.native.set('GET /api/live/project-prefs', (c) => this.json(200, projectsView(c)));
    this.native.set('POST /api/live/project-prefs', async (c, _url, body) => {
      await c.projectPrefs.update(body);
      return this.json(200, { ...projectsView(c), ok: true });
    });
    this.native.set('POST /api/live/project-add', async (c, _url, body) => {
      await projectAdd(c.addedProjects, body, c.removedProjects);
      return this.json(200, { ...projectsView(c), ok: true });
    });
    this.native.set('POST /api/live/project-remove', async (c, _url, body) => {
      const [status, payload] = await projectRemove(c, body);
      return this.json(status, payload);
    });
    for (const [key, handler] of liveRoutes()) {
      this.native.set(key, async (c, url, body) => {
        const [status, payload] = await handler(c, url, body);
        return this.json(status, payload);
      });
    }
    for (const [key, handler] of studioRoutes()) {
      this.native.set(key, async (c, url, body, request) => {
        const [status, payload] = await (handler as StudioHandler)(c, url, body, request);
        return this.json(status, payload);
      });
    }
    for (const [key, handler] of filesRoutes()) {
      this.native.set(key, async (c, url, body, request) => {
        const [status, payload] = await handler(c, url, body, request);
        return this.json(status, payload);
      });
    }
    for (const [key, handler] of docsRoutes()) {
      this.native.set(key, async (c, url, body) => {
        const [status, payload] = await handler(c, url, body);
        return this.json(status, payload);
      });
    }
    for (const [key, handler] of devicesRoutes()) {
      this.native.set(key, async (c, url, body) => {
        const [status, payload] = await handler(c, url, body);
        return this.json(status, payload);
      });
    }
    for (const [key, handler] of terminalRoutes()) {
      this.native.set(key, async (c, url, body) => {
        const [status, payload] = await handler(c, url, body);
        return this.json(status, payload);
      });
    }
    this.native.set('GET /api/live/bootstrap', async (c) => this.json(200, await this.bootstrap(c)));
  }

  /**
   * web_handler.get_bootstrap, key for key. server.python (sys.version in Python) is kept as '' so the keys match; this server runs
   * no Python of its own.
   */
  async bootstrap(c: WebContext): Promise<Record<string, unknown>> {
    const info = await c.host.liveInfo();
    const startedWith = (info.startedWith && typeof info.startedWith === 'object' ? info.startedWith : {}) as Record<string, unknown>;
    if (!('connections' in info)) throw Object.assign(new Error("'connections'"), { name: 'KeyError' });
    return {
      token: c.token,
      instanceId: info.instanceId,
      webInstanceId: c.webInstanceId,
      pid: Deno.pid,
      launchNonce: Deno.env.get('AGENT_STUDIO_LAUNCH_NONCE') ?? '',
      hostMode: c.host.hostMode,
      hostPid: info.pid ?? null,
      stateDir: pathStr(c.stateDir),
      artifactOrigin: this.artifactOrigin,
      server: {
        version: APP_VERSION,
        versionLabel: VERSION_LABEL,
        aboutLine: ABOUT_LINE,
        protocol: info.protocol ?? null,
        hostFormat: info.format ?? null,
        hostStartedAt: info.startedAt ?? null,
        webStartedAt: WEB_STARTED,
        hostAutoReconnect: startedWith.autoReconnect ?? null,
        // Settings > About: why the keeper is not used although it should be (it could not run; AIB fell back). Only present then:
        // the Python reference has no keeper and no such key.
        ...(keeperProblem() ? { keeperProblem: keeperProblem() } : {}),
        python: '',
        webPort: c.cliPort,
      },
      features: {
        promptReceipts: true,
        sessionLeases: true,
        formElicitation: true,
        asyncConnect: true,
        imageAttachments: true,
        fileAttachments: true,
        urlElicitation: true,
        authentication: true,
        setupRequests: true,
        requestWithdrawal: true,
        acpBreadth: true,
        durableRecovery: info.durableRecovery ?? false,
        sessionDiscovery: true,
        subagentCancel: 'when_advertised',
        externalOwnership: 'best_effort',
        ownershipEvidence: true,
        ownerAnnouncements: info.ownerAnnouncements ?? false,
        conversationOrganize: true,
      },
      connections: info.connections,
      ...(await notices(studioOf(c))),
      ...(info.unavailable ? { hostProblem: info.unavailable } : {}),
    };
  }

  get artifactOrigin(): string {
    return this.ctx.artifacts?.store.origin ?? '';
  }

  json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...securityHeaders(this.artifactOrigin) },
    });
  }

  bytes(status: number, body: Uint8Array<ArrayBuffer>, type: string): Response {
    return new Response(body, { status, headers: { 'Content-Type': type, ...securityHeaders(this.artifactOrigin) } });
  }

  /** Listen on 127.0.0.1:port (0 = any free port). Resolves with the port. */
  listen(port: number): Promise<number> {
    return new Promise((resolve) => {
      this.#server = serve({
        hostname: '127.0.0.1',
        port,
        onListen: ({ port }) => {
          this.ctx.port = port;
          this.gate = new Gate(port, () => this.ctx.token);
          this.ctx.gate = this.gate;
          this.ctx.docs.start();
          globalThis.addEventListener('unload', this.#onUnload);
          resolve(port);
        },
      }, (request) => this.handle(request));
    });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase() === 'HEAD' ? 'GET' : request.method.toUpperCase();
    try {
      if (method === 'GET' && path === DOCS_SOCKET) {
        const answer = docsSocket(this.ctx, request, url);
        return 'response' in answer ? answer.response : this.json(answer.refused[0], answer.refused[1]);
      }
      if (method === 'GET' && path === TERMINAL_SOCKET) {
        const answer = terminalSocket(this.ctx, request, url);
        return 'response' in answer ? answer.response : this.json(answer.refused[0], answer.refused[1]);
      }
      if (method === 'POST' && (routeKind('POST', path) === 'own-gate' || path.startsWith('/api/live/artifacts/'))) {
        // These check the agent tool key after reading the body (web_handler.post_artifacts / post_worktree_tool).
        const [status, payload] = await ownGatePost(this.ctx, request, url);
        return this.json(status, payload);
      }
      const scope = ROUTES.scopeFor(method, path);
      const conversationId = url.searchParams.get('conversationId');
      const allowed = authorize({ method, path, headers: request.headers }, this.gate, scope, conversationId, checkArtifactKey);
      if (allowed instanceof Refusal) {
        await drain(request);
        return this.json(allowed.status, { error: allowed.message(path) });
      }
      void (allowed as Principal);
      if (method === 'GET') {
        const handler = this.native.get(`GET ${path}`);
        if (handler) return await handler(this.ctx, url, null, request);
        const drawing = DRAWING_PAGE[path];
        if (drawing) {
          const body = await Deno.readFile(`${APP_ROOT}${sep}server${sep}docs${sep}drawing${sep}page${sep}${drawing}`);
          return new Response(body, {
            status: 200,
            headers: { 'Content-Type': contentType(drawing), ...drawingHeaders(this.artifactOrigin) },
          });
        }
        const asset = studioAsset(path);
        if (asset === 'chat.html') {
          const page = withViewPrefs(await Deno.readTextFile(APP_ROOT + sep + asset), this.ctx.viewPrefs.public().prefs);
          return this.bytes(200, new TextEncoder().encode(page), contentType(asset));
        }
        if (asset) return this.bytes(200, await Deno.readFile(APP_ROOT + sep + asset), contentType(asset));
        if (routeKind('GET', path) === 'monitor') {
          const reply = await monitorGet(this.ctx.transcripts, path, url.search.slice(1));
          // Saved chats of folders that are not added projects are not shown anywhere in AIB (nothing on disk changes).
          if (path === '/api/sessions' && reply.status === 200 && reply.body && typeof reply.body === 'object') {
            const listed = reply.body as { sessions?: unknown };
            if (Array.isArray(listed.sessions)) listed.sessions = filterSessions(this.ctx.addedProjects, listed.sessions, this.ctx.conversations);
          }
          if (reply.body instanceof Uint8Array) return this.bytes(reply.status, reply.body as Uint8Array<ArrayBuffer>, reply.contentType);
          return new Response(JSON.stringify(reply.body), {
            status: reply.status,
            headers: { 'Content-Type': reply.contentType, ...securityHeaders(this.artifactOrigin) },
          });
        }
        return this.json(404, { error: 'Not found' });
      }
      if (method === 'POST' && path === '/api/live/shutdown') {
        await drain(request);
        setTimeout(() => this.ctx.shutdown(), 50); // answer first; serve() then runs the normal close path
        return this.json(200, { ok: true });
      }
      if (method === 'POST') {
        const handler = this.native.get(`POST ${path}`);
        const raw = await readBody(request, path === '/api/live/prompt' ? MAX_PROMPT_BODY_BYTES : MAX_BODY);
        if (raw === null || raw.byteLength === 0) return this.json(400, { error: 'Invalid request size' });
        let body: unknown;
        try {
          body = JSON.parse(new TextDecoder().decode(raw));
        } catch (error) {
          return this.json(400, { error: pythonJsonError(error) });
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) return this.json(400, { error: 'Invalid request' });
        if (!handler) return this.json(404, { error: 'Not found' });
        return await handler(this.ctx, url, body as Record<string, unknown>, request);
      }
      await drain(request); // the gate refuses every other method (no route has one)
      return this.json(404, { error: 'Not found' });
    } catch (error) {
      if (error instanceof HostUnavailable) return this.json(503, { error: error.message, code: error.code });
      if (error instanceof Refused || error instanceof EditorError) {
        return this.json(error.status, { error: error.message, code: error.code });
      }
      if (error instanceof Error && ['FolderError', 'EditorError', 'RuntimeError', 'TimeoutError'].includes(error.name)) {
        return this.json(400, { error: error.message });
      }
      if (error instanceof Error && ['ValueError', 'TypeError', 'KeyError', 'OSError', 'RangeError'].includes(error.name)) {
        return this.json(400, { error: error.message });
      }
      if (error instanceof Error && error.constructor.name.endsWith('ValueError')) return this.json(400, { error: error.message });
      console.error('Request failed', path, error);
      return this.json(500, { error: 'Internal error' });
    }
  }

  /** Stop serving. Terminal shells end, except with `release` (an update): shells in the keeper keep running for the next AIB. */
  async close(release = false): Promise<void> {
    globalThis.removeEventListener('unload', this.#onUnload);
    if (release) await this.ctx.terminals.releaseAll();
    else await this.ctx.terminals.endAll();
    await this.ctx.docs.close();
    await this.#server?.shutdown();
  }

  /** The process is exiting without close() (Deno.exit): stop every terminal shell now, so none is left behind. */
  readonly #onUnload = () => this.ctx.terminals.terminateAllNow();
}

/** The body up to `limit` bytes, or null when it is larger (the connection is then answered without reading the rest). */
async function readBody(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > limit) return null;
  return new Uint8Array(await request.arrayBuffer());
}

async function drain(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch { /* nothing to read */ }
}

/** Python's json.loads error text is shown for a broken body; close enough for a person, and only `error` is a contract. */
function pythonJsonError(error: unknown): string {
  return `Expecting value: ${error instanceof Error ? error.message : String(error)}`;
}

export function makeContext(
  options: {
    stateDir: string;
    host: LiveBackend;
    updates: UpdateService;
    webInstanceId: string;
    cliPort: number;
    transcripts: Source;
    claudeProjects: string;
    ompSessions: string;
    shutdown: () => void;
    agentOptions?: AgentOptions;
    /** Run the chats' terminal shells in the keeper (null or absent: as children of this process). */
    terminalKeeper?: KeeperLink | null;
    /** Stores to share (an --in-process Studio passes its own, so one instance of each file is read and written). */
    stores?: { conversations?: ConversationState; projectPrefs?: ProjectPrefs; readState?: ReadState; settings?: SettingsStore };
    /** Phone access options (tests: a fake Tailscale CLI, a short bind retry). */
    phone?: AccessOptions;
    /** The OS backend for keep-awake (tests: a recording one, or null); default: the real one for this OS (none in a test run). */
    keepAwakeBackend?: Backend | null;
  },
): WebContext {
  const ctx: WebContext = {
    token: newToken(),
    webInstanceId: options.webInstanceId,
    port: 0,
    cliPort: options.cliPort,
    host: options.host,
    updates: options.updates,
    conversations: options.stores?.conversations ?? new ConversationState(options.stateDir),
    projectPrefs: options.stores?.projectPrefs ?? new ProjectPrefs(options.stateDir),
    removedProjects: new RemovedProjects(options.stateDir),
    addedProjects: new AddedProjects(options.stateDir),
    folderPresence: presence,
    readState: options.stores?.readState ?? new ReadState(options.stateDir),
    settings: options.stores?.settings ?? new SettingsStore(options.stateDir),
    transcripts: options.transcripts,
    options: { claudeProjects: options.claudeProjects, ompSessions: options.ompSessions },
    shutdown: options.shutdown,
    stateDir: options.stateDir,
    agentOptions: options.agentOptions ?? { stateDir: options.stateDir },
    launcher: null as unknown as Launcher,
    folderMemory: new FolderMemory(options.stateDir),
    viewPrefs: new ViewPrefs(options.stateDir),
    artifacts: null as unknown as Artifacts,
    gate: null,
    editorList: {},
    terminals: new TerminalSessions({ keeper: options.terminalKeeper ?? null }),
    docs: new DocStore(options.stateDir, { history: new ArtifactHistory(() => ctx.artifacts?.store ?? null) }),
    desktopNotify: null,
    phone: null as unknown as PhoneAccess,
    devices: null as unknown as DeviceStore,
    presence: new Presence(),
    keepAwake: new KeepAwake(options.keepAwakeBackend === undefined ? realBackend() : options.keepAwakeBackend),
  };
  ctx.phone = new PhoneAccess(ctx, options.stateDir, {
    avoid: () => (ctx.port ? [ctx.port, ctx.port + 1] : []),
    ...options.phone,
  });
  ctx.devices = ctx.phone.devices;
  ctx.launcher = makeLauncher(() => ctx, () => ctx.editorList);
  ctx.artifacts = new Artifacts(
    options.stateDir,
    options.host,
    () => ctx.token,
    async (chat) => chatStudioOf(ctx, await savedFolders(ctx, chat)),
  );
  // a chat's turn ended (its turnEndedAt moved, or its connection went): the docs drop its presence and claims, show its refused notes
  ctx.artifacts.onTurnEnd = (chat) => ctx.docs.turnEnded(chat);
  return ctx;
}

export { TOKEN_HEADER };
