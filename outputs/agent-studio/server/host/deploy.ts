/**
 * `aib deploy` (deploy.py): restart a running Agent Studio server (and optionally its agent host) without cutting off a turn.
 * Same flags, plan and messages as deploy.py; it restarts a Deno server (main.ts serve) or a Python one (studio.py) the same way:
 * the new server is started with exactly the command line the old one had.
 */
import { APP_ROOT, selfCommand } from '../core/app.ts';
import { isDict, isInt, pyStr } from '../core/py.ts';
import { PyAttributeError, pyTypeName, truthy } from '../transcripts/pycompat.ts';
import { NetError, rawRequest } from '../artifacts/mcp.ts';
import { isWorktreeCheckout, packageContext } from '../state/paths.ts';
import { processList, processStrings } from '../platform/process_info.ts';
import { type DetachedProcess, spawnDetachedLine } from '../platform/spawn_detached.ts';

type Json = Record<string, unknown>;

const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const parent = (path: string) => path.replace(/[\\/][^\\/]*$/, '');
export const HERE = APP_ROOT;
export const LOGS = parent(parent(APP_ROOT)) + SEP + 'work';

export const DOC = `Restart a running AIB server (and optionally its agent host) without cutting off a turn.

    aib deploy                      # restart only the web server on port 8767 (agents keep working)
    aib deploy --host               # also restart the agent host: wait for idle, stop the host, restart the web server
    aib deploy --wait               # wait for idle before restarting the web server too
    aib deploy --port 8790          # another instance
    aib deploy --dry-run            # report what would happen, change nothing
    aib deploy --timeout 3600       # give up after an hour (default: wait indefinitely)

AIB runs agents in a long-lived agent host process, so restarting only the web server (the default)
never touches a running turn and needs no waiting: the page reconnects to the same conversations. Changes to
the web side of the server and the page files need only that. Changes to the code that talks to agents
(Connection, prompts, permissions, leases; the agent host itself) need --host, which waits until every
AIB-owned conversation is idle or closed, asks the host to stop, and starts a new web server (which starts
a new host). Conversations that were open reconnect automatically (unless the server runs with --no-auto-reconnect).

"Idle" means nothing is working, opening, or waiting for your answer, and it must stay so for --settle
seconds (default 15), so a turn between steps is not mistaken for a finished one. A server running with
--in-process (or an older one without an agent host) owns its agents itself: it always waits, and restarting
it ends them. With the keeper (the default) the server is one process whose agents run in the keeper: it is
restarted at once and the new process continues every chat where it was (--host adds nothing). The new server is started with exactly the command line the old one had. Front-end-only
changes do not need this: refresh the page instead.
`;

/** Python's urllib errors as deploy.py prints them ("<urlopen error ...>", "HTTP Error 500: ..."). */
export class UrlError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(port: number, path: string, headers: Record<string, string>, timeout: number): Promise<unknown> {
  let response;
  try {
    response = await rawRequest(
      `http://127.0.0.1:${port}`,
      'GET',
      path,
      { 'Accept-Encoding': 'identity', ...headers },
      null,
      timeout * 1000,
    );
  } catch (error) {
    if (error instanceof NetError) throw new UrlError(`<urlopen error ${error.message}>`);
    throw error;
  }
  if (response.status < 200 || response.status >= 300) throw new UrlError(`HTTP Error ${response.status}: ${response.reason}`);
  return JSON.parse(new TextDecoder().decode(response.body));
}

/** GET a Studio route as JSON; every route but bootstrap needs the page token, which bootstrap hands out. */
export async function get(port: number, path: string, timeout = 5): Promise<Json> {
  const headers: Record<string, string> = {};
  if (path !== '/api/live/bootstrap') {
    const boot = await fetchJson(port, '/api/live/bootstrap', {}, timeout);
    const token = isDict(boot) && Object.hasOwn(boot, 'token') ? boot.token : '';
    headers['X-Studio-Token'] = pyStr(token);
  }
  const reply = await fetchJson(port, path, headers, timeout);
  return isDict(reply) ? reply : {};
}

/** Why the server is not safe to restart, as human-readable strings (empty list = idle). */
export function busyReasons(listing: Json): string[] {
  const reasons: string[] = [];
  const connections = Array.isArray(listing.connections) ? listing.connections : [];
  for (const c of connections as Json[]) {
    if (truthy(c.closed)) continue;
    const field = (key: string, fallback: unknown) => (Object.hasOwn(c, key) ? c[key] : fallback);
    const name = `${pyStr(field('provider', '?'))} in ${pyStr(field('cwd', '?'))}`;
    const attention = truthy(c.attention) ? c.attention : {};
    if (!isDict(attention)) throw new PyAttributeError(`'${pyTypeName(attention)}' object has no attribute 'get'`);
    let state = attention.state ?? null;
    if (state === null) { // servers older than the attention summary
      state = truthy(c.busy) ? 'working' : (!truthy(field('ready', true)) ? 'opening' : 'idle');
    }
    const labels: Record<string, string> = { working: 'is working', opening: 'is still opening', needs_you: 'is waiting for your answer' };
    if (typeof state === 'string' && Object.hasOwn(labels, state)) reasons.push(`${name} ${labels[state]}`);
  }
  return reasons;
}

/** The exact command line of a running process (Windows), from its PEB (deploy.py asks CIM for the same string). */
export function commandLineOf(pid: number): string {
  const line = (processStrings(pid)?.commandLine ?? '').trim();
  if (!line) throw new Error(`Could not read the command line of process ${pid}`);
  return line;
}

/** PID of the Studio server on this port: from bootstrap when it reports one, else by command line. */
export async function findPid(port: number): Promise<[number, Json]> {
  const boot = await get(port, '/api/live/bootstrap');
  if (isInt(boot.pid)) return [boot.pid, boot];
  const matches: number[] = [];
  for (const entry of processList()) {
    const cmd = processStrings(entry.pid)?.commandLine ?? '';
    if (!/studio\.py|server[\\/]main\.ts/i.test(cmd)) continue;
    const explicit = cmd.includes(`--port ${port}`) || cmd.includes(`--port=${port}`);
    if (explicit || (port === 8767 && !cmd.includes('--port'))) matches.push(entry.pid);
  }
  if (matches.length !== 1) throw new Error(`Found ${matches.length} AIB processes that could be port ${port}; refusing to guess`);
  return [matches[0], boot];
}

export interface Output {
  out: (line: string) => void;
}

export async function waitUntilIdle(
  port: number,
  settle: number,
  timeout: number,
  poll = 5,
  say: Output['out'] = console.log,
): Promise<void> {
  const started = Date.now() / 1000;
  let idleSince: number | null = null;
  let last: string[] | 'idle' | null = null;
  while (true) {
    let reasons: string[];
    try {
      reasons = busyReasons(await get(port, '/api/live/list'));
    } catch (error) {
      if (error instanceof UrlError) throw new Error(`AIB on port ${port} stopped answering: ${error.message}`);
      throw error;
    }
    if (reasons.length) {
      idleSince = null;
      if (!Array.isArray(last) || last.join('\n') !== reasons.join('\n')) {
        say('Waiting: ' + reasons.join('; '));
        last = reasons;
      }
    } else {
      idleSince = idleSince ?? Date.now() / 1000;
      if (last !== 'idle') {
        say(`Idle; restarting if it stays idle for ${settle}s...`);
        last = 'idle';
      }
      if (Date.now() / 1000 - idleSince >= settle) return;
    }
    if (timeout && Date.now() / 1000 - started > timeout) throw new TimeoutError(`Still busy after ${timeout}s; nothing was restarted`);
    await sleep(poll * 1000);
  }
}

export class TimeoutError extends Error {}

export interface Plan {
  wait: boolean;
  stop_host: boolean;
  kill_tree: boolean;
}

/**
 * What a deploy must do for a server in this hostMode ('split', 'in-process', 'keeper', or null for servers that predate the agent
 * host). 'keeper' is one AIB process whose agents run in the keeper (the default): a restart never touches them (the new process
 * rebuilds each chat from the keeper's record), so nothing waits, and the process tree is never killed (the keeper was started by
 * this process and taskkill /T would end it, and every agent with it).
 */
export function restartPlan(hostMode: unknown, restartHost = false, wait = false): Plan {
  const split = hostMode === 'split';
  const keeper = hostMode === 'keeper';
  return {
    wait: !!(wait || (restartHost && split) || (!split && !keeper)),
    stop_host: !!(restartHost && split),
    kill_tree: !split && !keeper,
  };
}

/** Ask the agent host to stop through `aib --stop-host` (it refuses while anything is working). */
export async function stopHost(stateDir: unknown): Promise<string> {
  const [command, ...args] = selfCommand();
  const run = new Deno.Command(command, {
    args: [...args, '--stop-host', '--state-dir', pyStr(stateDir)],
    stdin: 'null',
    stdout: 'piped',
    stderr: 'piped',
    signal: AbortSignal.timeout(60_000),
  });
  const out = await run.output();
  const text = new TextDecoder().decode(out.stdout), err = new TextDecoder().decode(out.stderr);
  if (out.code !== 0) throw new Error('The agent host did not stop: ' + (text + err).trim());
  return text.trim();
}

/** Hooks for tests: where the logs go, and whether this runs inside a packaged app. */
export interface Hooks {
  logs?: string;
  packageContext?: () => string | null;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function restart(
  port: number,
  pid: number,
  commandLine: string,
  killTree = true,
  hooks: Hooks = {},
): Promise<[number | null, Json, Json]> {
  const logs = hooks.logs ?? LOGS;
  const say = hooks.out ?? console.log;
  // taskkill /T also ends the process's children. Only an --in-process server owns agents that way; with an agent host the host
  // (started by this server) must survive, so there is no /T.
  await new Deno.Command('taskkill', { args: ['/PID', String(pid), ...(killTree ? ['/T'] : []), '/F'], stdout: 'null', stderr: 'null' })
    .output();
  for (let i = 0; i < 50; i++) {
    try {
      await get(port, '/api/live/bootstrap', 1);
      await sleep(200);
    } catch {
      break;
    }
  }
  await Deno.mkdir(logs, { recursive: true });
  const pkg = (hooks.packageContext ?? (() => packageContext()))();
  let process: DetachedProcess | null;
  if (pkg) { // started from inside a packaged app (the Claude desktop app): Studio must not inherit its sandbox
    say(`This deploy runs inside ${pkg}'s sandbox; starting AIB through Explorer so it runs outside it.`);
    process = await launchOutsidePackage(commandLine, logs);
  } else {
    process = await launchDirect(commandLine, logs);
  }
  const errLog = `${logs}${SEP}agent-studio.stderr.log`;
  try {
    for (let i = 0; i < 60; i++) {
      try {
        const boot = await get(port, '/api/live/bootstrap', 2);
        const listing = await get(port, '/api/live/list', 5);
        return [process ? process.pid : (isInt(boot.pid) ? boot.pid : null), boot, listing];
      } catch (error) {
        if (!(error instanceof UrlError)) throw error;
        const code = process?.exitCode();
        if (process && code !== null && code !== undefined) throw new Error(`The new server exited with code ${code}; see ${errLog}`);
        await sleep(500);
      }
    }
  } finally {
    process?.close();
  }
  throw new Error('The new server did not answer within 30 seconds' + (pkg ? `; see ${errLog}` : ''));
}

export function launchDirect(commandLine: string, logs = LOGS): Promise<DetachedProcess> {
  return spawnDetachedLine(commandLine, `${logs}${SEP}agent-studio.stdout.log`, `${logs}${SEP}agent-studio.stderr.log`, HERE);
}

/**
 * [launcher .cmd, run .cmd]. The launcher is what Explorer opens: it starts the run script hidden, and the run script starts Studio
 * with its output appended to the two logs. Both run from the user's shell, not as children of the packaged app.
 */
export function launcherTexts(
  commandLine: string,
  outLog: string,
  errLog: string,
  runScript: string,
  cwd: string | null = null,
): [string, string] {
  const folder = cwd || HERE;
  const run = `@echo off\r\ncd /d "${folder}"\r\n${commandLine} >>"${outLog}" 2>>"${errLog}" <nul\r\n`;
  const launcher = '@echo off\r\npowershell -NoProfile -NonInteractive -WindowStyle Hidden -Command ' +
    `"Start-Process -FilePath '${runScript.replaceAll("'", "''")}' -WindowStyle Hidden"\r\n`;
  return [launcher, run];
}

/** encoding='ascii', errors='replace': every non-ASCII character becomes '?'. */
function asciiBytes(text: string): Uint8Array {
  return new Uint8Array([...text].map((c) => (c.codePointAt(0)! < 128 ? c.codePointAt(0)! : 63)));
}

/**
 * Start Studio through explorer.exe running a one-shot .cmd. Measured (docs/DESKTOP.md): a process started this way reports no
 * package and writes to the real %LOCALAPPDATA%, while a direct child of the packaged app inherits the redirection. Returns null:
 * Explorer's own process ends at once.
 */
export async function launchOutsidePackage(commandLine: string, logs = LOGS): Promise<null> {
  const outLog = `${logs}${SEP}agent-studio.stdout.log`, errLog = `${logs}${SEP}agent-studio.stderr.log`;
  const launcher = `${logs}${SEP}agent-studio-launch.cmd`, run = `${logs}${SEP}agent-studio-run.cmd`;
  const [launcherText, runText] = launcherTexts(commandLine, outLog, errLog, run);
  await Deno.writeFile(run, asciiBytes(runText));
  await Deno.writeFile(launcher, asciiBytes(launcherText));
  new Deno.Command('explorer.exe', { args: [launcher], stdin: 'null', stdout: 'null', stderr: 'null' }).spawn();
  return null;
}

/** The message to refuse with when `root` (default: this checkout) is a git worktree, else null. */
export function worktreeRefusal(root: string | null = null): string | null {
  if (isWorktreeCheckout(root ?? APP_ROOT)) return 'aib deploy must run from the main checkout, not a worktree';
  return null;
}

// ---- argparse ----------------------------------------------------------------------------------------------------------------

const USAGE = 'usage: aib deploy [-h] [--port PORT] [--settle SETTLE] [--timeout TIMEOUT] [--host] [--wait] [--dry-run]';
const HELP = `${USAGE}

${DOC}
options:
  -h, --help         show this help message and exit
  --port PORT
  --settle SETTLE    seconds it must stay idle before restarting (default 15)
  --timeout TIMEOUT  give up after this many seconds (default: wait indefinitely)
  --host             also restart the agent host (waits until idle, stops the
                     host, then restarts the web server, which starts a new
                     host)
  --wait             wait until idle before restarting the web server even
                     though its agents would not be affected
  --dry-run          report what would happen; change nothing`;

export interface Args {
  port: number;
  settle: number;
  timeout: number;
  host: boolean;
  wait: boolean;
  dry_run: boolean;
}

export class ArgError extends Error {
  constructor(message: string, readonly code = 2) {
    super(message);
  }
}

/** argparse with deploy.py's options: --x=v or --x v, unambiguous prefixes, -h/--help. Throws ArgError (code 0 for --help). */
export function parseArgs(argv: string[]): Args {
  const valued = ['--port', '--settle', '--timeout'];
  const flags = ['--host', '--wait', '--dry-run', '--help'];
  const all = ['--help', ...valued, ...flags.filter((f) => f !== '--help')];
  const args: Args = { port: 8767, settle: 15, timeout: 0, host: false, wait: false, dry_run: false };
  const unknown: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '-h') throw new ArgError(HELP, 0);
    if (!item.startsWith('--') || item === '--') {
      unknown.push(item);
      continue;
    }
    const [flag, inline] = item.includes('=') ? [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)] : [item, null];
    const hits = all.includes(flag) ? [flag] : all.filter((name) => name.startsWith(flag));
    if (hits.length > 1) throw new ArgError(`ambiguous option: ${flag} could match ${hits.join(', ')}`);
    if (!hits.length) {
      unknown.push(item);
      continue;
    }
    const name = hits[0];
    if (name === '--help') throw new ArgError(HELP, 0);
    if (valued.includes(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined || (inline === null && value.startsWith('-') && !/^-\d+$/.test(value))) {
        throw new ArgError(`argument ${name}: expected one argument`);
      }
      if (!/^\s*[-+]?\d+(_\d+)*\s*$/.test(value)) throw new ArgError(`argument ${name}: invalid int value: '${value}'`);
      (args as unknown as Record<string, number>)[name.slice(2)] = parseInt(value.replaceAll('_', ''), 10);
    } else {
      if (inline !== null) throw new ArgError(`argument ${name}: ignored explicit argument '${inline}'`);
      (args as unknown as Record<string, boolean>)[name.slice(2).replace('-', '_')] = true;
    }
  }
  if (unknown.length) throw new ArgError(`unrecognized arguments: ${unknown.join(' ')}`);
  return args;
}

// ---- main ----------------------------------------------------------------------------------------------------------------------

/** `aib deploy [options]`. Returns the exit code (deploy.py's sys.exit(message) prints the message to stderr and exits 1). */
export async function main(argv: string[], hooks: Hooks & { root?: string } = {}): Promise<number> {
  const out = hooks.out ?? console.log;
  const err = hooks.err ?? console.error;
  const refusal = worktreeRefusal(hooks.root ?? null);
  if (refusal) {
    err(refusal);
    return 1;
  }
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    if (error.code === 0) out(error.message);
    else err(`${USAGE}\naib deploy: error: ${error.message}`);
    return error.code;
  }
  if (Deno.build.os !== 'windows') {
    err('aib deploy currently supports Windows only');
    return 1;
  }
  try {
    const [pid, boot] = await findPid(args.port);
    const commandLine = commandLineOf(pid);
    const plan = restartPlan(boot.hostMode ?? null, args.host, args.wait);
    if (args.host && boot.hostMode !== 'split') {
      out(
        boot.hostMode === 'keeper'
          ? 'This server has no agent host (its agents run in the keeper), so restarting it is the restart; --host adds nothing.'
          : 'This server runs its agents itself (no agent host), so restarting it is the restart; --host adds nothing.',
      );
    }
    out(
      `AIB on port ${args.port}: process ${pid} (${truthy(boot.hostMode) ? pyStr(boot.hostMode) : 'no agent host'})\n  ${commandLine}`,
    );
    if (args.dry_run) {
      const reasons = busyReasons(await get(args.port, '/api/live/list'));
      const steps = [
        ...(plan.wait ? ['wait until idle'] : []),
        ...(plan.stop_host ? ['stop the agent host'] : []),
        'restart the web server',
      ];
      out('Would: ' + steps.join(', then ') + '.');
      if (plan.wait) out(reasons.length ? 'Waiting for: ' + reasons.join('; ') : 'Idle now.');
      return 0;
    }
    if (plan.wait) await waitUntilIdle(args.port, args.settle, args.timeout, 5, out);
    if (plan.stop_host) out(await stopHost(boot.stateDir ?? null));
    const [newPid, newBoot, listing] = await restart(args.port, pid, commandLine, plan.kill_tree, hooks);
    const describe = (r: Json) => `${pyStr(r.provider ?? null)} in ${pyStr(r.cwd ?? null)}`;
    const recovered = (Array.isArray(listing.recovered) ? listing.recovered : []).map((r) => describe(r as Json));
    const live = (Array.isArray(listing.connections) ? listing.connections : []).filter((c) => !(c as Json).closed).map((c) =>
      describe(c as Json)
    );
    out(`Restarted: process ${pyStr(newPid)}, instance ${pyStr(newBoot.instanceId ?? null)}`);
    let inside: unknown = null;
    try {
      inside = (await get(args.port, '/api/live/settings')).packageContext ?? null;
    } catch {
      inside = null;
    }
    if (truthy(inside)) {
      out(`WARNING: the new AIB still runs inside ${pyStr(inside)}'s sandbox, so its data is in that app's private folder.`);
    }
    out('Still running: ' + (live.length ? live.join('; ') : 'none'));
    out(
      (truthy(listing.autoReconnect) ? 'Reconnecting automatically: ' : 'Ready to reconnect: ') +
        (recovered.length ? recovered.join('; ') : 'none'),
    );
    return 0;
  } catch (error) {
    if (error instanceof Error && !(error instanceof SyntaxError)) {
      err(`Not restarted: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
