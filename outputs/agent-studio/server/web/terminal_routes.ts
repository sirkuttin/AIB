/**
 * The per-chat terminal's routes (Deno only: routes.ts DENO_ONLY). Same gate as every route (security.ts authorize: loopback Host,
 * this server's Origin, Sec-Fetch-Site same-origin or absent, the page token), so the artifact origin can never reach them.
 *
 *   GET  /api/live/terminal?key=&cwd=&cols=&rows=[&shell=][&resume=1]  WebSocket (scope write). A browser cannot set headers on a WebSocket, so the page
 *                                                   offers two subprotocols: `aib-terminal` and `aib-token.<page token>`; the token is
 *                                                   checked as X-Studio-Token. An Origin header is required (browsers always send one).
 *   GET  /api/live/terminal?signin=<agent>&cols=&rows=  the same socket, running a Beta agent's own sign-in command instead of a shell
 *                                                   (ACP terminal auth: beta_signin.ts). The page never names the program: it is the
 *                                                   agent's own launcher with the sign-in args the agent host saved, else the catalog's.
 *   GET  /api/live/terminal/list                    {terminals: [TerminalInfo], max} (sessions.ts)
 *   POST /api/live/terminal/end {key}               ends that conversation's shell: {ok, ended}
 */
import { ValueError } from '../core/py.ts';
import { authorize, Refusal, TOKEN_HEADER } from './security.ts';
import { ROUTES } from './routes.ts';
import { upgradeWebSocket, wantsWebSocket } from '../platform/websocket.ts';
import type { WebContext } from './server.ts';
import { betaAgent } from '../agents/beta_catalog.ts';
import { resolveBeta, signinArgv } from '../agents/beta_agents.ts';
import { readTerminalMethod } from '../agents/beta_signin.ts';
import { defaultProbe, refreshWindowsPath, setupCommand } from '../agents/beta_setup.ts';
import type { ShellSpec } from '../platform/pty.ts';
import { remoteSetupCommand } from '../remote/install.ts';
import type { WsLink } from '../platform/websocket.ts';

export const TERMINAL_SOCKET = '/api/live/terminal';
export const TERMINAL_PROTOCOL = 'aib-terminal';
export const TOKEN_PROTOCOL_PREFIX = 'aib-token.';

type Json = Record<string, unknown>;
type Reply = [number, unknown];

export function terminalRoutes(): Map<string, (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply> | Reply> {
  const routes = new Map<string, (ctx: WebContext, url: URL, body: Json | null) => Promise<Reply> | Reply>();
  routes.set('GET /api/live/terminal/list', (ctx) => [200, { terminals: ctx.terminals.list(), max: ctx.terminals.max }]);
  routes.set('POST /api/live/terminal/end', async (ctx, _url, body) => {
    const key = body?.key;
    if (typeof key !== 'string' || !key) throw new ValueError('key must be text');
    return [200, { ok: true, ended: await ctx.terminals.end(key) }];
  });
  return routes;
}

/** The subprotocols a client offered. */
function offered(request: Request): string[] {
  return (request.headers.get('sec-websocket-protocol') ?? '').split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * GET /api/live/terminal. Returns the refusal (as [status, body]) or the 101 response. Refusals happen before the upgrade, so a page
 * that is not ours never gets a socket.
 */
export function terminalSocket(ctx: WebContext, request: Request, url: URL): { refused: Reply } | { response: Response } {
  const protocols = offered(request);
  const token = protocols.find((p) => p.startsWith(TOKEN_PROTOCOL_PREFIX))?.slice(TOKEN_PROTOCOL_PREFIX.length) ?? '';
  const headers = new Headers(request.headers);
  headers.delete(TOKEN_HEADER);
  if (token) headers.set(TOKEN_HEADER, token);
  const allowed = authorize(
    { method: 'GET', path: TERMINAL_SOCKET, headers },
    ctx.gate,
    ROUTES.scopeFor('GET', TERMINAL_SOCKET),
  );
  if (allowed instanceof Refusal) return { refused: [allowed.status, { error: allowed.message(TERMINAL_SOCKET) }] };
  if (request.headers.get('Origin') === null) return { refused: [403, { error: 'Request must come from the AIB page' }] };
  if (!wantsWebSocket(request) || !protocols.includes(TERMINAL_PROTOCOL)) {
    return { refused: [400, { error: 'This address only takes a terminal WebSocket.' }] };
  }
  const { link, response } = upgradeWebSocket(request, TERMINAL_PROTOCOL);
  const q = url.searchParams;
  const signin = q.get('signin');
  const setup = q.get('setup');
  if (signin !== null) void attachSignin(ctx, link, signin, q.get('cols'), q.get('rows'));
  else if (setup !== null) void attachSetup(ctx, link, setup, q.get('step') ?? '', q.get('cols'), q.get('rows'));
  else {ctx.terminals.attach(
      link,
      q.get('key'),
      q.get('cwd'),
      q.get('cols'),
      q.get('rows'),
      q.get('shell') ?? '',
      null,
      q.get('resume') === '1',
    );}
  return { response };
}

/** The program a Beta agent's terminal sign-in runs: [file, args], or a one-line reason it cannot run. */
export async function signinCommand(ctx: Pick<WebContext, 'agentOptions'>, agentId: string): Promise<ShellSpec | string> {
  const agent = betaAgent(agentId);
  if (!agent || agent.signin.kind !== 'terminal') return 'That agent does not sign in through a terminal.';
  const options = ctx.agentOptions;
  const launch = await resolveBeta(agentId, { stateDir: options.stateDir ?? null, nodeCommand: options.nodeCommand || '' });
  if (!launch.found) return `${agent.name} is not installed. ${launch.problem}`;
  const saved = options.stateDir ? readTerminalMethod(options.stateDir, agentId) : null;
  let argv: string[] | null;
  try {
    argv = signinArgv(launch, agentId, saved);
  } catch (error) {
    return (error as Error).message;
  }
  if (!argv || !argv.length) return `${agent.name} has no sign-in command AIB can run.`;
  const env = saved?.advertised ? { ...(saved.env ?? {}) } : {};
  return Object.keys(env).length ? { file: argv[0], args: argv.slice(1), env } : { file: argv[0], args: argv.slice(1) };
}

/** A sign-in terminal: key signin:<agent>, started in the home folder; it ends when the sign-in command ends. */
async function attachSignin(ctx: WebContext, link: WsLink, agentId: string, cols: unknown, rows: unknown): Promise<void> {
  const command = await signinCommand(ctx, agentId);
  if (typeof command === 'string') {
    link.send(JSON.stringify({ type: 'error', message: command, code: 'signin_unavailable' }));
    link.close(1000, 'refused');
    return;
  }
  const home = Deno.env.get(Deno.build.os === 'windows' ? 'USERPROFILE' : 'HOME') || Deno.cwd();
  ctx.terminals.attach(link, `signin:${agentId}`, home, cols, rows, '', command);
}

/**
 * A setup terminal on a Beta card: key setup:<agent>, step `install` (the vendor's installer) or `prereq:<id>` (a prerequisite's
 * installer). The command comes from the catalog (beta_setup.ts setupCommand), never from the page. PATH is refreshed first (Windows),
 * so a prerequisite installed a moment ago is found.
 */
async function attachSetup(ctx: WebContext, link: WsLink, agentId: string, step: string, cols: unknown, rows: unknown): Promise<void> {
  await refreshWindowsPath().catch(() => false);
  // setup=remote: Settings > Remote control on Linux (install Tailscale, the operator line, start tailscaled); remote/install.ts
  const command = agentId === 'remote'
    ? remoteSetupCommand(step)
    : await setupCommand(agentId, step, defaultProbe(ctx.agentOptions.nodeCommand || '', true));
  if (typeof command === 'string') {
    link.send(JSON.stringify({ type: 'error', message: command, code: 'setup_unavailable' }));
    link.close(1000, 'refused');
    return;
  }
  const home = Deno.env.get(Deno.build.os === 'windows' ? 'USERPROFILE' : 'HOME') || Deno.cwd();
  ctx.terminals.attach(link, `setup:${agentId}`, home, cols, rows, '', command);
}
