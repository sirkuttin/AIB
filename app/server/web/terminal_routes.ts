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
 *   GET  /api/live/terminal?signin=claude&arg=..&arg=..  a built-in agent's terminal sign-in (a chat's "Sign in" card): the agent's own
 *                                                   launcher (Settings / Studio install / global, as a chat starts it) with the args
 *                                                   of the terminal method the agent advertised (ACP terminal auth). Plain words only.
 *   GET  /api/live/terminal?signin=<agent>&distro=<distro>[&arg=..][&start=1]&cols=&rows=  an agent's own login inside a WSL distro (design section 8 item 4):
 *                                                   a distro terminal in the Linux home running the agent's login command (the
 *                                                   sign-in card's advertised args when given). A distro AIB is not using is
 *                                                   refused, never started, unless start=1 (the user's click starts it and waits); for the next
 *                                                   5 minutes the login page it asks for opens on Windows without asking (wsl/open_urls.ts)
 *   GET  /api/live/terminal?setup=wsl-node&distro=<distro>[&start=1]&cols=&rows=  "Install Node.js in Ubuntu" (Settings > AIB Linking (WSL)):
 *                                                   a distro terminal in the Linux home running nvm's installer, pinned by its
 *                                                   SHA-256, then `nvm install --lts` (wsl/node_setup.ts). Asks the helper's
 *                                                   env.prereqs first (force) and is refused unless canInstallNode (the line is its
 *                                                   nodeInstallBlocked). A distro AIB is not using is refused, never started, unless
 *                                                   start=1. Key setup:wsl-node@<distro>. The page reads prereqs?force=1 after exit 0
 *   GET  /api/live/terminal/list                    {terminals: [TerminalInfo], max} (sessions.ts)
 *   POST /api/live/terminal/end {key}               ends that conversation's shell: {ok, ended}
 */
import { ValueError } from '../core/py.ts';
import { authorize, type Principal, Refusal, REMOTE_PC, TOKEN_HEADER } from './security.ts';
import { ROUTES } from './routes.ts';
import { upgradeWebSocket, wantsWebSocket } from '../platform/websocket.ts';
import type { WebContext } from './server.ts';
import { betaAgent } from '../agents/beta_catalog.ts';
import { resolveBeta, signinArgv } from '../agents/beta_agents.ts';
import { cleanTerminalArgs, readTerminalMethod } from '../agents/beta_signin.ts';
import { builtinLaunch } from './shared.ts';
import { defaultProbe, refreshWindowsPath, setupCommand } from '../agents/beta_setup.ts';
import type { ShellSpec } from '../platform/pty.ts';
import { remoteSetupCommand } from '../remote/install.ts';
import type { WsLink } from '../platform/websocket.ts';
import { refOf } from '../platform/location.ts';
import { distroName, hostWhenReady, notReady, peekState, peekWslHost } from '../wsl/access.ts';
import { urlGate } from '../wsl/open_urls.ts';
import { BUILTIN_NAMES } from '../agents/agent_registry.ts';
import { type EnvPrereqs, WslHelperError, type WslHost } from '../wsl/contract.ts';
import { wslNodeCommand } from '../wsl/node_setup.ts';

/** A distro name as the routes take it (wsl_routes.ts DISTRO). */
const WSL_DISTRO = /^[A-Za-z0-9._-]{1,64}$/;

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
export function terminalSocket(
  ctx: WebContext,
  request: Request,
  url: URL,
  principal: Principal | null = null,
  /** A remote computer's socket registry (remote/pc_sockets.ts): the link the shell gets, checked per message and closed on Remove. */
  wrap: ((link: WsLink) => WsLink) | null = null,
): { refused: Reply } | { response: Response } {
  const protocols = offered(request);
  // A remote computer: the bridge (remote/pc_bridge.ts pcSocket) checked the device and the terminal rules and passes its principal
  // in; it never offers the page token. Anyone else goes through the page gate with the token in the subprotocol.
  if (principal?.kind !== REMOTE_PC) {
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
  }
  if (request.headers.get('Origin') === null) return { refused: [403, { error: 'Request must come from the AIB page' }] };
  if (!wantsWebSocket(request) || !protocols.includes(TERMINAL_PROTOCOL)) {
    return { refused: [400, { error: 'This address only takes a terminal WebSocket.' }] };
  }
  const upgraded = upgradeWebSocket(request, TERMINAL_PROTOCOL);
  const { response } = upgraded;
  const link = wrap ? wrap(upgraded.link) : upgraded.link;
  const q = url.searchParams;
  const signin = q.get('signin');
  const setup = q.get('setup');
  const distro = q.get('distro');
  if (setup === 'wsl-node') void attachWslNode(ctx, link, distro ?? '', q.get('cols'), q.get('rows'), q.get('start') === '1');
  else if (signin !== null && distro) {
    void attachWslSignin(ctx, link, signin, distro, q.get('cols'), q.get('rows'), q.getAll('arg'), q.get('start') === '1');
  } else if (signin !== null) void attachSignin(ctx, link, signin, q.get('cols'), q.get('rows'), q.getAll('arg'));
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

export const BUILTIN_SIGNIN_AGENTS = new Set(['claude', 'codex']);

/**
 * The program a built-in agent's terminal sign-in runs: its own launcher (as a chat starts it) plus the advertised method's args.
 * The page only names the args, never the program; they must be 1 to 12 plain words (cleanTerminalArgs).
 */
export async function builtinSigninCommand(
  ctx: Pick<WebContext, 'agentOptions' | 'settings'>,
  agentId: string,
  args: unknown,
): Promise<ShellSpec | string> {
  const words = cleanTerminalArgs(args);
  if (!words) return 'This sign-in has no command AIB can run. Sign in with the agent itself, then choose Try again.';
  const launch = await builtinLaunch(ctx.agentOptions, ctx.settings, agentId);
  if (!launch.found || !launch.argv.length) return `${BUILTIN_NAMES[agentId]} is not installed. ${launch.problem}`.trim();
  const argv = [...launch.argv, ...words];
  return { file: argv[0], args: argv.slice(1) };
}

/** The program a Beta agent's terminal sign-in runs: [file, args], or a one-line reason it cannot run. */
export async function signinCommand(
  ctx: Pick<WebContext, 'agentOptions'> & Partial<Pick<WebContext, 'settings'>>,
  agentId: string,
  args: unknown = [],
): Promise<ShellSpec | string> {
  if (BUILTIN_SIGNIN_AGENTS.has(agentId) && ctx.settings) {
    return await builtinSigninCommand(ctx as Pick<WebContext, 'agentOptions' | 'settings'>, agentId, args);
  }
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
async function attachSignin(
  ctx: WebContext,
  link: WsLink,
  agentId: string,
  cols: unknown,
  rows: unknown,
  args: string[] = [],
): Promise<void> {
  const command = await signinCommand(ctx, agentId, args);
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

/**
 * The login an agent installed in a WSL distro runs, as [file, args] in that distro, or a one-line reason. Claude: its adapter's own
 * `--cli auth login --claudeai` (as on Windows, agents/signin.ts); Codex: `codex login` with the CLI the adapter ships (agents.detect
 * `signin`: also through an asdf / mise shim), else `codex` found with the helper's `which`. `start`: the user clicked, so a distro AIB
 * is not using yet is started and waited for; without it such a distro is refused and left alone.
 */
export async function wslSigninCommand(agentId: string, distro: string, args: unknown = [], start = false): Promise<ShellSpec | string> {
  const name = distroName(distro);
  const host = await clickedHost(distro, start, 'sign in');
  if (typeof host === 'string') return host;
  const label = BUILTIN_NAMES[agentId] ?? agentId;
  if (agentId !== 'claude' && agentId !== 'codex') return `Signing in to ${label} inside ${name} is not available yet.`;
  if (agentId === 'codex') {
    // the Codex CLI next to the adapter (AIB's own install in the distro has one), else `codex` on the distro's PATH
    const row = (await host.call('agents.detect', { ids: ['codex'] })).agents.find((a) => a.id === 'codex');
    if (row?.signin?.length && row.signin[0].startsWith('/')) {
      const [file, ...rest] = row.signin.map(String);
      return { file, args: [...rest, 'login'] };
    }
    const codex = (await host.call('which', { name: 'codex' })).path;
    return codex ? { file: codex, args: ['login'] } : `The Codex CLI is not installed in ${name}.`;
  }
  const row = (await host.call('agents.detect', { ids: ['claude'] })).agents.find((a) => a.id === 'claude');
  if (!row?.found || !row.command?.length) return `${label} is not installed in ${name}.`;
  const [file, ...rest] = row.command.map(String);
  const program = file.includes('/') ? file : (await host.call('which', { name: file })).path;
  if (!program) return `${file} was not found in ${name}.`;
  // A chat's sign-in card names the method Claude advertised (--cli auth login --claudeai / --console); else the Claude.ai login.
  return { file: program, args: [...rest, ...(cleanTerminalArgs(args) ?? ['--cli', 'auth', 'login', '--claudeai'])] };
}

/**
 * The host of a distro for a terminal the user clicked, or the line it shows instead. Only the click's `start` may start the distro;
 * otherwise a distro AIB is not using is answered ("<distro> is not running. Start it in Settings > AIB Linking (WSL), then <then>."),
 * never started.
 */
async function clickedHost(distro: string, start: boolean, then: string): Promise<WslHost | string> {
  let host = peekWslHost(distro);
  if (start && (!host || host.state !== 'ready')) {
    try {
      host = await hostWhenReady(distro);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (peekState(host) === 'off') return `${distroName(distro)} is not running. Start it in Settings > AIB Linking (WSL), then ${then}.`;
  return notReady(host, distro) || host!;
}

/**
 * The Node.js button's terminal in a distro (wsl/node_setup.ts): the command and the Linux home it starts in, or the one line it shows
 * instead. The helper's env.prereqs is asked first, reading the login PATH again (force): refused unless canInstallNode.
 */
export async function wslNodeSetupCommand(distro: string, start = false): Promise<{ command: ShellSpec; home: string } | string> {
  if (!WSL_DISTRO.test(distro)) return 'Choose a distro.';
  const name = distroName(distro);
  const host = await clickedHost(distro, start, 'install Node.js');
  if (typeof host === 'string') return host;
  let prereqs: EnvPrereqs;
  try {
    prereqs = await host.call('env.prereqs', { force: true }, { timeoutMs: 30_000 });
  } catch (error) {
    if (error instanceof WslHelperError && error.code === 'unknown_method') return `The AIB helper in ${name} is too old to install Node.js. Restart AIB.`;
    return `AIB could not check what ${name} has: ${error instanceof Error ? error.message : String(error)}`;
  }
  const command = wslNodeCommand(prereqs, name);
  if (typeof command === 'string') return command;
  const home = (await host.env()).HOME || '';
  if (!home.startsWith('/')) return 'The Linux home folder is unknown.';
  return { command, home };
}

/** The Node.js button's terminal: key setup:wsl-node@<distro>, in the Linux home; it ends when the steps end. */
async function attachWslNode(ctx: WebContext, link: WsLink, distro: string, cols: unknown, rows: unknown, start: boolean): Promise<void> {
  let ready: { command: ShellSpec; home: string } | string;
  try {
    ready = await wslNodeSetupCommand(distro, start);
  } catch (error) {
    ready = `The Node.js install could not start: ${(error as Error).message}`;
  }
  if (typeof ready === 'string') {
    link.send(JSON.stringify({ type: 'error', message: ready, code: 'setup_unavailable' }));
    link.close(1000, 'refused');
    return;
  }
  const key = distro.toLowerCase();
  void ctx.terminals.attachWsl(link, `setup:wsl-node@${key}`, refOf({ kind: 'wsl', distro: key, linuxPath: ready.home }), cols, rows, ready.command);
}

/** A sign-in terminal in a distro: key signin:<agent>@<distro>, in the Linux home; it ends when the login ends. */
async function attachWslSignin(
  ctx: WebContext,
  link: WsLink,
  agentId: string,
  distro: string,
  cols: unknown,
  rows: unknown,
  args: string[] = [],
  start = false,
): Promise<void> {
  let command: ShellSpec | string;
  let home = '';
  try {
    command = await wslSigninCommand(agentId, distro, args, start);
    if (typeof command !== 'string') home = (await peekWslHost(distro)!.env()).HOME || '';
  } catch (error) {
    command = `The sign-in could not start: ${(error as Error).message}`;
  }
  if (typeof command === 'string' || !home.startsWith('/')) {
    link.send(JSON.stringify({ type: 'error', message: typeof command === 'string' ? command : 'The Linux home folder is unknown.', code: 'signin_unavailable' }));
    link.close(1000, 'refused');
    return;
  }
  urlGate.signInStarted(distro); // the user started it: the agent's login page may open directly for 5 minutes
  const key = distro.toLowerCase();
  void ctx.terminals.attachWsl(link, `signin:${agentId}@${key}`, refOf({ kind: 'wsl', distro: key, linuxPath: home }), cols, rows, command);
}
