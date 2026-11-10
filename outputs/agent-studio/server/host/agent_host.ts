/**
 * The agent host (agent_host.py): the long-lived process that owns every ACP adapter, so the web server can be restarted.
 *
 * Normally started for you by the web server (detached, `main.ts host ...`); run it by hand only to debug. It listens on a random
 * 127.0.0.1 port and publishes the port and a random token in <state-dir>/agent-host.json (readable by your user only). Stop it
 * with `main.ts --stop-host`. Same RPC, host file, token header, protocol number and reply shapes as the Python host, so a web
 * server of either language can drive it (docs/agent-host.md). The host file also carries `runtime: "deno"`: see host_client.ts
 * findHost for how a web server treats a host of the other language.
 */
import { Studio, type StudioOptions } from './studio.ts';
import { isRequestError, need, pythonErrorType } from './studio.ts';
import {
  APP_ID,
  APP_VERSION,
  CODE_ROOT,
  DENO_SOURCE_HASH,
  HOST_FORMAT,
  LOG_KEEP,
  LOG_MAX_BYTES,
  logPath,
  MAX_RPC_BYTES,
  PROTOCOL_VERSION,
  removeInfo,
  rotateLog,
  RUNTIME,
  TOKEN_HEADER,
  writeInfo,
} from './host_client.ts';
import { ThreadEvent } from '../acp/connection.ts';
import { loadMcpConfig } from '../acp/breadth.ts';
import { OwnershipConflict, SessionLease } from '../ownership/ownership.ts';
import { StateStore } from '../state/recovery.ts';
import { tokenMatches } from '../web/security.ts';
import { APP_ROOT } from '../core/app.ts';
import * as log from '../core/log.ts';
import { HOST_FLAGS, type Options, parseOptions, UsageError } from '../core/options.ts';
import { apply as applyStatePaths } from '../state/paths.ts';
import { ensureHiddenConsole } from '../platform/console.ts';
import { pathStr } from '../platform/pypath.ts';
import { join } from '../platform/ospath.ts';
import { serve, type Server as HttpServer } from '../platform/http_serve.ts';

type Json = Record<string, unknown>;
const logger = log.getLogger('agent_host');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One-time carry-over when switching from the single-process server to the host. The single-process server kept "Was open in
 * Studio before restart" records and prompt receipts in studio-recovery-<port>.json; the host uses studio-recovery-host.json. Each
 * old file is merged once (receipts still marked working load as unknown, as after any restart) and renamed *.migrated.
 */
export function migrateInProcessRecovery(store: StateStore | null): void {
  if (store === null) return;
  const windows = Deno.build.os === 'windows';
  const pattern = windows ? /^studio-recovery-.*\.json$/i : /^studio-recovery-.*\.json$/;
  let names: string[];
  try {
    names = [...Deno.readDirSync(store.directory)].filter((e) => pattern.test(e.name)).map((e) => e.name).sort();
  } catch {
    return;
  }
  for (const fileName of names) {
    const name = fileName.slice('studio-'.length, -'.json'.length);
    if (name.toLowerCase() === 'recovery-host') continue;
    const old = new StateStore(store.directory, name);
    for (const [key, record] of old.conversations) if (!store.conversations.has(key)) store.conversations.set(key, record);
    for (const [key, receipts] of old.receipts) {
      let merged = store.receipts.get(key);
      if (!merged) store.receipts.set(key, merged = new Map());
      for (const [messageId, receipt] of receipts) if (!merged.has(messageId)) merged.set(messageId, receipt);
    }
    store.save();
    if (!store.warning) { // only retire the old file once the merge is safely on disk
      const legacy = join(store.directory, fileName);
      try {
        Deno.renameSync(legacy, legacy + '.migrated');
      } catch { /* left in place */ }
    }
  }
}

interface WebServer {
  pid: unknown;
  port: unknown;
  seen: number;
}

type Op = (args: Json) => unknown;

export class AgentHost {
  static ATTACH_FRESH_SECONDS = 45; // a web server that has not called in this long is not "attached"
  readonly studio: Studio;
  readonly token: string;
  readonly startedAt = Date.now() / 1000;
  readonly idleExitSeconds: number;
  readonly web = new Map<string, WebServer>(); // web server instance id -> {pid, port, seen}
  readonly stopEvent = new ThreadEvent();
  idleSince: number | null = null;
  lease: SessionLease | null = null;
  server: HttpServer | null = null;
  port = 0;
  readonly ops: Record<string, Op>;

  constructor(readonly options: StudioOptions, idleExitMinutes = 30, readonly hostPort = 0) {
    this.studio = new Studio(options, { port: 'host' });
    migrateInProcessRecovery(this.studio.store);
    this.token = newToken();
    this.idleExitSeconds = Math.max(0, Number(idleExitMinutes)) * 60;
    this.studio.artifactUrlProvider = () => this.webUrl();
    const studio = this.studio;
    this.ops = {
      info: () => this.opInfo(),
      attach: (a) => this.opAttach(a),
      detach: (a) => this.opDetach(a),
      list: () => studio.liveListSync(),
      state: (a) => studio.liveState(need(a, 'id'), a.after ?? 0),
      live: async (a) => [...await studio.liveCall(need(a, 'name') as string, a.body ?? null)],
      ownership: (a) => studio.ownershipQuery(str(a.provider), str(a.id), str(a.cwd)),
      artifact: (a) => studio.emitArtifact(need(a, 'conversationId'), need(a, 'data')),
      writes: () => studio.liveWrites(),
      install: async (a) => [...await studio.installCall(need(a, 'action') as string, a.agent ?? null)], // protocol 3: the install job
      signin: async (a) => [...await studio.signinCall(need(a, 'action') as string, str(a.agent), a.force ?? null)], // protocol 4: sign-in
      busy: () => ({ busy: studio.busyList() }),
      stop: (a) => this.opStop(a),
    };
  }

  // ---- operations --------------------------------------------------------------------------------------------------------
  webAttached(): number {
    const now = Date.now() / 1000;
    for (const [key, value] of [...this.web]) if (now - value.seen > AgentHost.ATTACH_FRESH_SECONDS) this.web.delete(key);
    return this.web.size;
  }

  /** Artifact tool: base URL of the most recently attached web server, or '' (the tool then reads artifact-web.json). */
  webUrl(): string {
    const now = Date.now() / 1000;
    const fresh = [...this.web.values()].filter((v) =>
      Number.isInteger(v.port) && v.port && now - v.seen <= AgentHost.ATTACH_FRESH_SECONDS
    );
    fresh.sort((a, b) => b.seen - a.seen);
    return fresh.length ? `http://127.0.0.1:${fresh[0].port}` : '';
  }

  async opInfo(): Promise<Json> {
    const info = await this.studio.liveInfo();
    const busy = this.studio.busyList();
    return {
      ...info,
      format: HOST_FORMAT,
      protocol: PROTOCOL_VERSION,
      hostId: info.instanceId,
      startedAt: this.startedAt,
      stateDir: pathStr(this.studio.stateDir),
      codeRoot: CODE_ROOT,
      sourceHash: await DENO_SOURCE_HASH(),
      appId: APP_ID,
      version: APP_VERSION,
      open: (info.connections as unknown[]).length,
      active: busy,
      webAttached: this.webAttached(),
      idleExitMinutes: this.idleExitSeconds / 60,
      startedWith: this.startedWith(),
      runtime: RUNTIME,
    };
  }

  startedWith(): Json {
    const o = this.options;
    return {
      ompCommand: o.ompCommand ?? null,
      nodeCommand: o.nodeCommand ?? null,
      claudeLauncher: o.claudeLauncher ?? null,
      ownersDir: o.ownersDir ? String(o.ownersDir) : null,
      autoReconnect: !!this.studio.autoReconnect,
      enableClientTerminal: !!o.enableClientTerminal,
      enableClientFs: o.enableClientFs ?? null,
      mcpServers: (o.mcpServers ?? []).length,
    };
  }

  opAttach(args: Json): Json {
    this.web.set(webKey(args), { pid: args.pid ?? null, port: args.port ?? null, seen: Date.now() / 1000 });
    return { attached: true, webServers: this.webAttached() };
  }

  opDetach(args: Json): Json {
    this.web.delete(webKey(args));
    return { detached: true };
  }

  opStop(args: Json): Json {
    const busy = this.studio.busyList();
    if (busy.length && !args.force) {
      const names = busy.map((b) => `${b.provider} in ${b.cwd} (${b.state})`).join('; ');
      return {
        stopping: false,
        active: busy,
        message:
          `Refusing to stop the agent host: ${busy.length} conversation(s) are working, opening or waiting for you: ${names}. Use --force to stop anyway.`,
      };
    }
    this.stopEvent.set();
    return { stopping: true, forced: busy.length > 0, active: busy };
  }

  // ---- serving -----------------------------------------------------------------------------------------------------------
  #allowed(request: Request, info: { remoteAddr: { hostname: string } }): boolean {
    const port = this.port;
    const peer = info.remoteAddr.hostname;
    const headers = request.headers;
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer) &&
      [`127.0.0.1:${port}`, `localhost:${port}`].includes(headers.get('host') ?? '') &&
      headers.get('origin') === null && headers.get('sec-fetch-site') === null &&
      tokenMatches(headers.get(TOKEN_HEADER) ?? '', this.token);
  }

  async handle(request: Request, info: { remoteAddr: { hostname: string } }): Promise<Response> {
    if (request.method === 'GET' || request.method === 'HEAD') {
      await drain(request);
      return reply(405, { error: 'POST /rpc only' });
    }
    if (request.method !== 'POST') {
      await drain(request);
      return reply(501, { error: `Unsupported method (${request.method})` });
    }
    if (!this.#allowed(request, info)) {
      await drain(request);
      return reply(403, { error: 'Forbidden' });
    }
    try {
      const declared = request.headers.get('content-length');
      const length = declared !== null && /^\s*\d+\s*$/.test(declared) ? parseInt(declared, 10) : declared === null ? 0 : NaN;
      if (Number.isNaN(length)) {
        throw Object.assign(new Error(`invalid literal for int() with base 10: '${declared}'`), { name: 'ValueError' });
      }
      if (!(length > 0 && length <= MAX_RPC_BYTES) || new URL(request.url).pathname !== '/rpc') {
        await drain(request);
        return reply(400, { error: 'Invalid request', errorType: 'ValueError' });
      }
      const raw = new Uint8Array(await request.arrayBuffer());
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { name: 'JSONDecodeError' });
      }
      const operation = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? Object.prototype.hasOwnProperty.call(this.ops, String((parsed as Json).op)) ? this.ops[String((parsed as Json).op)] : undefined
        : undefined;
      if (operation === undefined) return reply(404, { error: 'Unknown operation' });
      const args = (parsed as Json).args;
      const result = await operation(args && typeof args === 'object' && !Array.isArray(args) ? args as Json : {});
      return reply(200, { result: result === undefined ? null : result });
    } catch (error) {
      if (isRequestError(error)) return reply(400, { error: error.message, errorType: pythonErrorType(error) });
      logger.exception(error, 'Host RPC failed'); // a bug here must not kill the host
      const name = error instanceof Error ? error.name : 'Error';
      return reply(500, { error: `${name}: ${error instanceof Error ? error.message : error}`, errorType: 'RuntimeError' });
    }
  }

  /** Take the one-host lock, listen, publish the host file, start reconnecting. Returns the port. Throws OwnershipConflict. */
  async start(): Promise<number> {
    const stateDir = this.studio.stateDir;
    await Deno.mkdir(stateDir, { recursive: true });
    this.lease = await new SessionLease(stateDir, 'agent-host', 'singleton').acquire(); // one host per state dir; released if we die
    try {
      this.server = serve(
        { hostname: '127.0.0.1', port: this.hostPort, onListen: () => {} },
        (request, info) => this.handle(request, info),
      );
    } catch (error) {
      this.lease.release();
      throw error;
    }
    this.port = this.server.addr.port;
    await writeInfo(stateDir, {
      format: HOST_FORMAT,
      protocol: PROTOCOL_VERSION,
      pid: Deno.pid,
      port: this.port,
      token: this.token,
      hostId: this.studio.instanceId,
      startedAt: this.startedAt,
      codeRoot: CODE_ROOT,
      sourceHash: await DENO_SOURCE_HASH(),
      appId: APP_ID,
      version: APP_VERSION,
      runtime: RUNTIME,
      startedWith: this.startedWith(),
    });
    this.studio.startAutoReconnect(); // chats that were open before the restart; nothing is sent
    return this.port;
  }

  /** True when the host should exit: no open conversations and no web server for the whole idle period. */
  idleCheck(): boolean {
    if (!this.idleExitSeconds) return false;
    const open = [...this.studio.connections.values()].some((c) => !c.closed);
    if (open || this.webAttached()) {
      this.idleSince = null;
      return false;
    }
    this.idleSince ??= Date.now() / 1000;
    return Date.now() / 1000 - this.idleSince >= this.idleExitSeconds;
  }

  async run(): Promise<void> {
    const path = logPath(this.studio.stateDir);
    let checked = 0;
    while (!(await this.stopEvent.wait(2000))) {
      if (Date.now() / 1000 - checked > 60) { // the log is held open by this process, so rotate it by copy-and-truncate
        checked = Date.now() / 1000;
        await rotateLog(path, LOG_MAX_BYTES, LOG_KEEP, true);
      }
      if (this.idleCheck()) {
        console.log('Agent host: idle with no conversations and no web server; exiting.');
        break;
      }
    }
    await this.shutdown();
  }

  async shutdown(): Promise<void> {
    await removeInfo(this.studio.stateDir, Deno.pid); // first, so web servers see a stop and not a crash
    await sleep(200); // let the reply to a stop request leave
    if (this.server) {
      // An RPC still running (a connect waiting on its agent) must not hold the stop up: give replies a moment, then go on.
      await Promise.race([this.server.shutdown().catch(() => {}), sleep(1000)]);
    }
    await this.studio.close();
    this.lease?.release();
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function webKey(args: Json): string {
  const id = args.webInstanceId || args.pid;
  return id === null || id === undefined ? 'None' : String(id);
}

function reply(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

async function drain(request: Request): Promise<void> {
  try {
    await request.body?.cancel();
  } catch { /* nothing to read */ }
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** The agent options of a parsed command line, as the Studio reads them (the --mcp-config file loaded). */
export function studioOptions(o: Options, mcpServers: StudioOptions['mcpServers'] = []): StudioOptions {
  return {
    stateDir: o.stateDir,
    port: o.port,
    ompSessions: o.ompSessions,
    claudeProjects: o.claudeProjects,
    ompCommand: o.ompCommand,
    nodeCommand: o.nodeCommand,
    claudeLauncher: o.claudeLauncher,
    codexLauncher: o.codexLauncher,
    ownersDir: o.ownersDir,
    autoReconnect: o.autoReconnect,
    enableClientTerminal: o.enableClientTerminal,
    enableClientFs: o.enableClientFs,
    noArtifactTool: o.noArtifactTool,
    mcpServers,
    migration: (o as unknown as { migration?: Record<string, unknown> | null }).migration ?? null,
  };
}

/** studio.finish_agent_options: load --mcp-config (a usage error when it is invalid). */
export function loadMcp(o: Options, usage: (message: string) => never): StudioOptions['mcpServers'] {
  if (!o.mcpConfig) return [];
  try {
    return loadMcpConfig(o.mcpConfig);
  } catch (error) {
    if (error instanceof Error && (error.name === 'ValueError' || error.constructor.name.endsWith('ValueError'))) {
      usage(`--mcp-config: ${error.message}`);
    }
    throw error;
  }
}

/** `main.ts host [flags]`: agent_host.py's main. Resolves with the exit code. */
export async function hostMain(argv: string[]): Promise<number> {
  ensureHiddenConsole(); // agents and their tools get no console windows
  const usage = (message: string): never => {
    console.error(`usage: aib host [options]\naib host: error: ${message}`);
    Deno.exit(2);
  };
  let options: Options;
  try {
    options = parseOptions(argv, HOST_FLAGS);
  } catch (error) {
    if (error instanceof UsageError) usage(error.message);
    throw error;
  }
  const mcpServers = loadMcp(options, usage);
  await applyStatePaths(options as never, usage, APP_ROOT, false); // normally --state-dir is given by the web server
  // stderr only: the web server starts the host with stdout and stderr going to <state>/agent-host.log, which is rotated by
  // copy-and-truncate, so a second handle on that file would fight the rotation.
  log.setup('agent-host', { level: options.logLevel });
  const host = new AgentHost(studioOptions(options, mcpServers), options.idleExitMinutes, options.hostPort);
  log.registerSecret(host.token);
  let port: number;
  try {
    port = await host.start();
  } catch (error) {
    if (error instanceof OwnershipConflict) {
      console.log('Agent host: another host already runs for this state dir; exiting.');
      await host.studio.close();
      return 0;
    }
    console.error(`Agent host: could not start: ${error instanceof Error ? error.message : error}`);
    await host.studio.close();
    return 1;
  }
  const signals = (Deno.build.os === 'windows' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT', 'SIGTERM']) as Deno.Signal[];
  for (const signal of signals) {
    try {
      Deno.addSignalListener(signal, () => host.stopEvent.set());
    } catch { /* not supported here */ }
  }
  console.log(`Agent host ${Deno.pid} protocol ${PROTOCOL_VERSION} on 127.0.0.1:${port}, state ${host.studio.stateDir}`);
  await host.run();
  console.log('Agent host stopped.');
  return 0;
}
