/**
 * Sign-in check and Sign in button of the built-in agents, Claude Code and Codex (agent_signin.py). Studio never reads, copies or
 * stores a credential: the agent's own login runs, and Studio only learns "signed in" / "signed out" from the agent's own status command.
 *
 *   Status   Claude: `node <entry> --cli auth status --json`. Only whether a login exists is read (`kind`, or `loggedIn` / `apiKeySource` /
 *            `apiProvider`); the email, plan and organisation in the output are ignored. Never a throwaway `session/new`.
 *            Codex: `codex login status` when a Codex CLI can be found (the @openai/codex that ships next to the adapter, a global
 *            npm install, or a native codex.exe / codex on PATH), hidden, with a timeout; ONLY its exit code is used (0 = signed in),
 *            its output is never read. Without a CLI (or when it cannot run): whether <CODEX_HOME or ~/.codex>/auth.json exists,
 *            existence only, never opened. "Not checked" only when neither is possible. (Python still leaves Codex unchecked.)
 *   Cache    <state_dir>/agents/<id>/signin.json {state: ready|signin|unknown, checkedAt}. Settings reads it from disk; it is refreshed
 *            when Settings opens (at most once a minute) and by "Check again", never on every settings poll.
 *   Sign in  A one-off `initialize` (no session) reads the methods the agent advertises. A `terminal` method is run by Studio itself:
 *            the adapter with the method's args, in a visible console window on Windows, waiting for exit code 0. ACP `authenticate`
 *            is NEVER sent for a terminal method. An `agent` method (Codex's `chatgpt`) is the one case where `authenticate` is sent,
 *            on that same one-off process. On macOS / Linux the terminal command is shown instead of started.
 *   Job      <state_dir>/agents/<id>/signin-job.json {state: waiting|failed|done|manual, message, command, pid, updatedAt}.
 *
 * Same files and JSON as the Python module, so a Python agent host and a Deno web server read each other's cache and job.
 */
import * as adapters from './adapters.ts';
import { agentDir, Flag, Mutex, readJson, writeJson } from './installer.ts';
import { clip, isDict, pyLen, pyStr, pyTruthy, ValueError } from '../core/py.ts';
import { pidAlive } from '../host/host_client.ts';
import { spawnInNewConsole } from '../platform/console_spawn.ts';
import { ProcessTree, treeSpawnOptions } from '../platform/process_tree.ts';
import { pathOf } from '../state/paths.ts';
import { which } from '../platform/pypath.ts';

export const CACHE_NAME = 'signin.json';
export const JOB_NAME = 'signin-job.json';
export const CACHE_SECONDS = 60; // opening Settings again within a minute does not run the status command again
export const STATUS_TIMEOUT = 20;
export const HANDSHAKE_TIMEOUT = 40;
export const AUTHENTICATE_TIMEOUT = 15 * 60; // an agent method: the user finishes it in the browser
export const CONSOLE_TIMEOUT = 15 * 60;
export const PREFERRED_METHOD: Record<string, string> = { claude: 'claude-ai-login', codex: 'chatgpt' };
/** When the agent advertises nothing usable. */
export const DEFAULT_TERMINAL: Record<string, [string, string[]]> = {
  claude: ['claude-ai-login', ['--cli', 'auth', 'login', '--claudeai']],
};
export const NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
export const CODEX_CLI_PACKAGE: [string, string] = ['@openai/codex', 'bin/codex.js'];

const now = () => Date.now() / 1000;
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);

/** The request cannot be done (unknown agent, not installed, ...). The message is the one plain line the page shows. */
export class SignInRefused extends ValueError {
  override name = 'SignInRefused';
  readonly code = 'signin_refused';
}

export type SignState = 'ready' | 'signin' | 'unknown';

/** 'ready' | 'signin' | 'unknown' from the output of `auth status --json`. Reads only whether a login exists, never who it is. */
export function parseStatus(text: string | null | undefined): SignState {
  let data: unknown;
  try {
    data = JSON.parse(text || '');
  } catch {
    return 'unknown';
  }
  if (!isDict(data)) return 'unknown';
  const kind = data.kind;
  if (typeof kind === 'string' && kind) return kind === 'none' ? 'signin' : 'ready';
  if (typeof data.loggedIn !== 'boolean') return 'unknown';
  const external = pyTruthy(data.apiProvider) && data.apiProvider !== 'firstParty'; // Bedrock, Vertex...: the login lives outside the agent
  return data.loggedIn || pyTruthy(data.apiKeySource) || external ? 'ready' : 'signin';
}

export function readCached(stateDir: string, agentId: string): { state: SignState; checkedAt: number } {
  const saved = readJson(pathOf(agentDir(stateDir, agentId), CACHE_NAME)) ?? {};
  const state = saved.state === 'ready' || saved.state === 'signin' ? saved.state : 'unknown';
  const at = Number(saved.checkedAt || 0);
  return { state, checkedAt: Number.isFinite(at) ? at : 0 };
}

export interface JobView {
  agent: string;
  state: 'idle' | 'waiting' | 'failed' | 'done' | 'manual' | string;
  message: string;
  command: string;
  attached?: boolean;
}

/** The sign-in job as the page sees it, from disk only. A waiting job whose process has died is reported as failed. */
export function readJob(stateDir: string, agentId: string): JobView {
  const saved = readJson(pathOf(agentDir(stateDir, agentId), JOB_NAME));
  if (!saved || !['waiting', 'failed', 'done', 'manual'].includes(saved.state as string)) {
    return { agent: agentId, state: 'idle', message: '', command: '' };
  }
  const out: JobView = {
    agent: agentId,
    state: saved.state as string,
    message: saved.message ? pyStr(saved.message) : '',
    command: saved.command ? pyStr(saved.command) : '',
  };
  if (out.state === 'waiting' && !pidAlive(saved.pid)) {
    Object.assign(out, { state: 'failed', message: 'The sign-in was interrupted before it finished. Try again.' });
  }
  return out;
}

/** What the Status column shows: a chat that is open now knows best ('signin' = waiting for sign-in, 'running' = it works). */
export function effectiveState(cachedState: string, liveStatus = ''): SignState {
  if (liveStatus === 'signin') return 'signin';
  if (liveStatus === 'running') return 'ready';
  return cachedState === 'ready' || cachedState === 'signin' ? cachedState : 'unknown';
}

export interface Method {
  id: string;
  name?: string;
  kind: 'terminal' | 'agent';
  args: string[];
}

/** [{id, name, kind, args}] from initialize.authMethods; methods Studio cannot start (env vars, unknown types) are dropped. */
export function normalizeMethods(raw: unknown): Method[] {
  const out: Method[] = [];
  for (const item of Array.isArray(raw) ? raw.slice(0, 20) : []) {
    if (!isDict(item) || typeof item.id !== 'string' || !item.id || pyLen(item.id) > 256) continue;
    const type = item.type ?? null;
    const kind = type === null || type === 'agent' ? 'agent' : type === 'terminal' ? 'terminal' : null;
    if (!kind) continue;
    const args = item.args;
    const ok = Array.isArray(args) && args.length > 0 && args.length <= 12 &&
      args.every((a) => typeof a === 'string' && pyLen(a) > 0 && pyLen(a) <= 200 && !a.includes('\n') && !a.includes('\r'));
    out.push({
      id: item.id,
      name: clip(pyStr(pyTruthy(item.name) ? item.name : item.id), 80),
      kind,
      args: ok && kind === 'terminal' ? [...args as string[]] : [],
    });
  }
  return out;
}

/** The method the Sign in button runs: the agent's usual one when advertised, else the first one Studio can start. */
export function chooseMethod(agentId: string, methods: Method[]): Method | null {
  for (const method of methods) if (method.id === PREFERRED_METHOD[agentId]) return method;
  return methods[0] ?? null;
}

const WIN = Deno.build.os === 'windows';

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index <= 0 ? path : path.slice(0, index);
}

function isFileSync(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

export interface CodexCliOptions {
  which?: (name: string) => string | null | undefined;
}

/**
 * The Codex CLI as an argv, or null. First the `@openai/codex` package the adapter itself depends on, run with the adapter's node:
 * found by walking up from the adapter's entry file as Node resolves it (nested, then hoisted), but only inside the adapter's own
 * node_modules tree, so AIB's install and a global `npm i -g` of the adapter are found and nothing outside them is. Then a native
 * `codex.exe` (Windows) / `codex` on PATH. Windows .cmd/.bat shims are skipped: they cannot be started directly.
 */
export function findCodexCli(adapterArgv: string[] | null, options: CodexCliOptions = {}): Promise<string[] | null> {
  const [name, entry] = CODEX_CLI_PACKAGE;
  if (adapterArgv && adapterArgv.length >= 2) {
    const script = adapterArgv[1];
    const parts = script.split(/[\\/]/);
    const top = parts.findIndex((part) => part.toLowerCase() === 'node_modules'); // the outermost node_modules of the adapter
    if (top > 0) {
      const stop = parts.slice(0, top).join(WIN ? '\\' : '/') || '/';
      let folder = parentDir(script);
      for (let i = 0; i < 40; i++) {
        const base = folder.slice(Math.max(folder.lastIndexOf('/'), folder.lastIndexOf('\\')) + 1).toLowerCase();
        if (base !== 'node_modules') {
          const candidate = pathOf(folder, 'node_modules', ...name.split('/'), ...entry.split('/'));
          if (isFileSync(candidate)) return Promise.resolve([adapterArgv[0], candidate]);
        }
        if (folder.length <= stop.length) break;
        const up = parentDir(folder);
        if (up === folder) break;
        folder = up;
      }
    }
  }
  const look = options.which ?? which;
  for (const program of WIN ? ['codex.exe'] : ['codex']) {
    const found = look(program);
    if (found && !/\.(cmd|bat)$/i.test(found)) return Promise.resolve([found]);
  }
  return Promise.resolve(null);
}

/** <CODEX_HOME>/auth.json (Codex honours CODEX_HOME), else ~/.codex/auth.json; null when there is no home folder. */
export function codexAuthFile(env: Record<string, string>): string | null {
  const home = env.CODEX_HOME || '';
  if (home) return pathOf(home, 'auth.json');
  const user = (WIN ? env.USERPROFILE : env.HOME) || env.HOME || '';
  return user ? pathOf(user, '.codex', 'auth.json') : null;
}

/** 'ready' when the Codex credentials file exists, 'signin' when it does not: existence only (stat), the file is never opened. */
export function codexAuthState(env: Record<string, string>): SignState {
  const file = codexAuthFile(env);
  if (!file) return 'unknown';
  try {
    Deno.statSync(file);
    return 'ready';
  } catch (error) {
    return error instanceof Deno.errors.NotFound ? 'signin' : 'unknown';
  }
}

export class HandshakeError extends Error {
  override name = 'HandshakeError';
}

/** Lines of a stream, read with a timeout: a string, null at the end, undefined when nothing came in time. */
class LineQueue {
  #items: (string | null)[] = [];
  #waiters: (() => void)[] = [];
  constructor(stream: ReadableStream<Uint8Array>) {
    this.#pump(stream);
  }
  async #pump(stream: ReadableStream<Uint8Array>) {
    let buffer = '';
    try {
      for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          this.#push(buffer.slice(0, index + 1));
          buffer = buffer.slice(index + 1);
        }
      }
    } catch { /* closed */ }
    if (buffer) this.#push(buffer);
    this.#push(null);
  }
  #push(item: string | null) {
    this.#items.push(item);
    for (const wake of this.#waiters.splice(0)) wake();
  }
  async get(ms: number): Promise<string | null | undefined> {
    if (!this.#items.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await new Promise<void>((resolve) => {
        const wake = () => resolve();
        this.#waiters.push(wake);
        timer = setTimeout(() => {
          this.#waiters = this.#waiters.filter((w) => w !== wake);
          resolve();
        }, ms);
      });
      clearTimeout(timer);
    }
    if (!this.#items.length) return undefined;
    const item = this.#items[0];
    if (item !== null) this.#items.shift(); // the end stays at the head
    return item;
  }
}

/**
 * One short-lived adapter process spoken to over ACP stdio. It only reads `initialize.authMethods` (and, for an `agent` method, sends
 * `authenticate`); it never creates a session, so no transcript is written.
 */
export class Handshake {
  readonly process: Deno.ChildProcess;
  readonly tree: ProcessTree;
  readonly #lines: LineQueue;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  #nextId = 0;

  constructor(argv: string[], env: Record<string, string>) {
    this.process = new Deno.Command(argv[0], {
      args: argv.slice(1),
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'null',
      env,
      clearEnv: true,
      ...treeSpawnOptions(),
    }).spawn();
    this.tree = new ProcessTree(this.process);
    this.#writer = this.process.stdin.getWriter();
    this.#lines = new LineQueue(this.process.stdout);
    this.process.status.catch(() => {});
  }

  async #send(message: Record<string, unknown>): Promise<void> {
    try {
      await this.#writer.write(new TextEncoder().encode(JSON.stringify({ ...message, jsonrpc: '2.0' }) + '\n'));
    } catch {
      throw new HandshakeError('The agent stopped before it answered.');
    }
  }

  async request(method: string, params: unknown, timeout: number, cancel?: Flag): Promise<unknown> {
    const mine = ++this.#nextId;
    await this.#send({ id: mine, method, params });
    const deadline = now() + timeout;
    for (;;) {
      if (cancel?.isSet()) throw new HandshakeError('cancelled');
      if (now() > deadline) throw new HandshakeError('The agent did not answer in time.');
      const raw = await this.#lines.get(250);
      if (raw === undefined) continue;
      if (raw === null) throw new HandshakeError('The agent stopped before it answered.');
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isDict(message)) continue;
      if ('method' in message && 'id' in message) { // the agent asks the client for something: this client offers nothing
        await this.#send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
      } else if (message.id === mine && !('method' in message)) {
        if (isDict(message.error)) throw new HandshakeError(clip(pyStr(message.error.message || 'The agent refused.'), 200));
        return message.result ?? null;
      }
    }
  }

  async close(): Promise<void> {
    this.tree.kill();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.process.status.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, 10_000)))]);
    clearTimeout(timer);
    try {
      await this.#writer.close();
    } catch { /* already closed */ }
    try {
      await this.process.stdout.cancel();
    } catch { /* already closed */ }
  }
}

/** A started process the sign-in waits for (Deno.ChildProcess fits). */
export interface Spawned {
  readonly pid: number;
  readonly status: Promise<{ code: number }>;
  kill(signal?: Deno.Signal): void;
}

export type SpawnConsole = (argv: string[], env: Record<string, string>) => Spawned;
export type LaunchFn = (
  agentId: string,
) => { argv?: string[]; found?: boolean; problem?: string } | null | Promise<{ argv?: string[]; found?: boolean; problem?: string } | null>;

class Job {
  readonly cancelEvent = new Flag();
  tree: ProcessTree | null = null;
  alive = true;
  done: Promise<void> = Promise.resolve();
  constructor(readonly agentId: string) {}
}

type Outcome = 'done' | 'failed' | 'cancelled' | 'manual';

export interface SignerOptions {
  /** The login in its own visible console window (Windows). Injectable so tests never open a window. */
  spawnConsole?: SpawnConsole;
  systemIsWindows?: boolean;
  /** How the Codex CLI is found from the adapter's argv (findCodexCli). Injectable so tests use a fake codex. */
  codexCli?: (adapterArgv: string[]) => Promise<string[] | null>;
}

/**
 * One per process that runs sign-ins (the agent host; the in-process Studio of tests and demos).
 * `launch(agentId)` returns {argv, found, problem} like shared.builtinLaunch.
 */
export class Signer {
  readonly stateDir: string;
  readonly spawnConsole: SpawnConsole;
  readonly windows: boolean;
  readonly codexCli: (adapterArgv: string[]) => Promise<string[] | null>;
  readonly jobs = new Map<string, Job>();
  readonly #guard = new Mutex();
  readonly #checkLocks = new Map<string, Mutex>();

  constructor(stateDir: string, readonly launch: LaunchFn, options: SignerOptions = {}) {
    this.stateDir = pathOf(stateDir);
    this.spawnConsole = options.spawnConsole ?? spawnInNewConsole;
    this.windows = options.systemIsWindows ?? Deno.build.os === 'windows';
    this.codexCli = options.codexCli ?? ((argv) => findCodexCli(argv));
  }

  // ---- helpers ------------------------------------------------------------------------------------------------------
  #agent(agentId: unknown): string {
    if (typeof agentId !== 'string' || !hasOwn(adapters.STUDIO_PACKAGES, agentId)) {
      throw new SignInRefused('AIB cannot check or start a sign-in for that agent.');
    }
    return agentId;
  }

  async #argv(agentId: string): Promise<string[] | null> {
    const row = await this.launch(agentId);
    return row && row.found && row.argv && row.argv.length ? [...row.argv] : null;
  }

  #env(): Record<string, string> {
    return Deno.env.toObject();
  }

  #writeCache(agentId: string, state: SignState): number {
    const at = now();
    writeJson(pathOf(agentDir(this.stateDir, agentId), CACHE_NAME), { state, checkedAt: at });
    return at;
  }

  #writeJob(agentId: string, state: string, message = '', command = '', pid?: number): void {
    writeJson(pathOf(agentDir(this.stateDir, agentId), JOB_NAME), { state, message, command, pid: pid ?? Deno.pid, updatedAt: now() });
  }

  #clearJob(agentId: string): void {
    try {
      Deno.removeSync(pathOf(agentDir(this.stateDir, agentId), JOB_NAME));
    } catch { /* already gone */ }
  }

  #clearCache(agentId: string): void {
    try {
      Deno.removeSync(pathOf(agentDir(this.stateDir, agentId), CACHE_NAME));
    } catch { /* already gone */ }
  }

  // ---- status -------------------------------------------------------------------------------------------------------
  /**
   * Codex: `codex login status`, exit code only (0 = ready, anything else = signin); its output goes to NUL and is never read.
   * Hidden like every child (the process's hidden console on Windows). No CLI, or it could not run or timed out: auth.json exists.
   */
  async probeCodex(argv: string[]): Promise<SignState> {
    const env = this.#env();
    let cli: string[] | null = null;
    try {
      cli = await this.codexCli(argv);
    } catch { /* no CLI */ }
    if (cli && cli.length) {
      let child: Deno.ChildProcess | null = null;
      try {
        child = new Deno.Command(cli[0], {
          args: [...cli.slice(1), 'login', 'status'],
          stdin: 'null',
          stdout: 'null',
          stderr: 'null',
          env,
          clearEnv: true,
          ...treeSpawnOptions(),
        }).spawn();
      } catch { /* cannot start: fall back */ }
      if (child) {
        const tree = new ProcessTree(child);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
          child.status.catch(() => null),
          new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), STATUS_TIMEOUT * 1000))),
        ]);
        clearTimeout(timer);
        if (result === 'timeout') {
          tree.kill();
          await child.status.catch(() => {});
        } else if (result) return result.code === 0 ? 'ready' : 'signin';
      }
    }
    return codexAuthState(env);
  }

  /** Run the agent's own status command. 'ready' | 'signin' | 'unknown' (a timeout or unreadable output is unknown). */
  async probe(agentId: string, argv: string[]): Promise<SignState> {
    if (agentId === 'codex') return await this.probeCodex(argv);
    if (agentId !== 'claude') return 'unknown';
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(argv[0], {
        args: [...argv.slice(1), '--cli', 'auth', 'status', '--json'],
        stdin: 'null',
        stdout: 'piped',
        stderr: 'null',
        env: this.#env(),
        clearEnv: true,
        ...treeSpawnOptions(),
      }).spawn();
    } catch {
      return 'unknown';
    }
    const tree = new ProcessTree(child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      child.output(), // logged out exits 1 and still prints the JSON
      new Promise<'timeout'>((resolve) => (timer = setTimeout(() => resolve('timeout'), STATUS_TIMEOUT * 1000))),
    ]);
    clearTimeout(timer);
    if (result === 'timeout') {
      tree.kill();
      await child.status.catch(() => {});
      return 'unknown';
    }
    return parseStatus(new TextDecoder().decode(result.stdout));
  }

  /** Refresh the cached state unless it is younger than CACHE_SECONDS (force ignores that). {agent, state, checkedAt, checked}. */
  check(agentId: unknown, force = false): Promise<{ agent: string; state: SignState; checkedAt: number; checked: boolean }> {
    let id: string;
    try {
      id = this.#agent(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
    let lock = this.#checkLocks.get(id);
    if (!lock) this.#checkLocks.set(id, lock = new Mutex());
    return lock.run(async () => {
      const cached = readCached(this.stateDir, id);
      const argv = await this.#argv(id);
      if (argv === null) { // not installed: nothing to check, and an old answer would be stale
        this.#clearCache(id);
        return { agent: id, state: 'unknown' as SignState, checkedAt: 0.0, checked: false };
      }
      if (force && ['manual', 'done', 'failed'].includes(readJob(this.stateDir, id).state)) this.#clearJob(id);
      if (!force && cached.checkedAt && now() - cached.checkedAt < CACHE_SECONDS) {
        return { ...cached, agent: id, checked: false };
      }
      const state = await this.probe(id, argv);
      const checkedAt = this.#writeCache(id, state);
      return { agent: id, state, checkedAt, checked: true };
    });
  }

  status(agentId: unknown): { state: SignState; checkedAt: number; agent: string; job: JobView } {
    const id = this.#agent(agentId);
    return { ...readCached(this.stateDir, id), agent: id, job: readJob(this.stateDir, id) };
  }

  // ---- the sign-in job ----------------------------------------------------------------------------------------------
  /** Start the agent's own login, or join the one already running. Returns the job view; throws SignInRefused when it cannot start. */
  start(agentId: unknown): Promise<JobView> {
    let id: string;
    try {
      id = this.#agent(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#guard.run(async () => {
      const running = this.jobs.get(id);
      if (running && running.alive) return { ...readJob(this.stateDir, id), attached: true };
      const argv = await this.#argv(id);
      if (argv === null) {
        const row = (await this.launch(id)) ?? {};
        throw new SignInRefused(`${NAMES[id]} is not installed yet, so there is nothing to sign in to. ${row.problem || ''}`.trim());
      }
      const job = new Job(id);
      this.jobs.set(id, job);
      this.#writeJob(id, 'waiting');
      job.done = this.#run(job, argv);
      return { ...readJob(this.stateDir, id), attached: false };
    });
  }

  /** Kill the login's whole process tree (the console window closes with it). Returns the job view (idle after a cancel). */
  async cancel(agentId: unknown): Promise<JobView> {
    const id = this.#agent(agentId);
    const job = this.jobs.get(id);
    if (job && job.alive) {
      job.cancelEvent.set();
      job.tree?.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, 30_000)))]);
      clearTimeout(timer);
    } else if (['manual', 'failed', 'done'].includes(readJob(this.stateDir, id).state)) this.#clearJob(id);
    return readJob(this.stateDir, id);
  }

  async #run(job: Job, argv: string[]): Promise<void> {
    const agentId = job.agentId;
    let outcome: Outcome = 'failed';
    let message = 'The sign-in stopped unexpectedly.';
    let command = '';
    try {
      [outcome, message, command] = await this.#signIn(job, argv);
    } catch (error) { // a job never takes the host down
      console.error(`Signing in to ${agentId} failed`, error);
      outcome = 'failed';
      message = `The sign-in stopped unexpectedly: ${error instanceof Error ? error.message : error}`;
    } finally {
      try {
        if (outcome === 'cancelled') this.#clearJob(agentId);
        else this.#writeJob(agentId, outcome, message, command);
      } finally {
        job.alive = false;
      }
    }
  }

  #track(job: Job, tree: ProcessTree): void {
    job.tree = tree;
    if (job.cancelEvent.isSet()) tree.kill();
  }

  async #signIn(job: Job, argv: string[]): Promise<[Outcome, string, string]> {
    const agentId = job.agentId;
    const name = NAMES[agentId];
    const env = this.#env();
    let methods: Method[] = [];
    let handshake: Handshake | null = null;
    try {
      handshake = new Handshake(argv, env);
      this.#track(job, handshake.tree);
      const init = await handshake.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: { name: 'agent-studio', title: 'AIB', version: '0.1.0' },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
        },
        HANDSHAKE_TIMEOUT,
        job.cancelEvent,
      );
      methods = normalizeMethods(isDict(init) ? init.authMethods : null);
    } catch (error) {
      if (!(error instanceof HandshakeError)) {
        await handshake?.close();
        throw error;
      }
      if (job.cancelEvent.isSet()) {
        await handshake?.close();
        return ['cancelled', '', ''];
      }
      console.info(`Reading the sign-in methods of ${agentId} failed: ${error.message}`);
    }
    let method = chooseMethod(agentId, methods);
    if (method === null && hasOwn(DEFAULT_TERMINAL, agentId)) { // nothing usable advertised: the documented login of this adapter
      method = { id: DEFAULT_TERMINAL[agentId][0], kind: 'terminal', args: [...DEFAULT_TERMINAL[agentId][1]] };
    }
    if (method !== null && method.kind === 'terminal' && !method.args.length && hasOwn(DEFAULT_TERMINAL, agentId)) {
      method = { ...method, args: [...DEFAULT_TERMINAL[agentId][1]] };
    }
    if (method === null || (method.kind === 'terminal' && !method.args.length)) {
      await handshake?.close();
      return [
        'failed',
        `${name} did not offer a sign-in that AIB can start. Sign in with the ${name} program itself, then choose Check again.`,
        '',
      ];
    }
    if (method.kind === 'agent') { // the only case where ACP `authenticate` is sent: the agent opens the browser itself
      try {
        await handshake!.request('authenticate', { methodId: method.id }, AUTHENTICATE_TIMEOUT, job.cancelEvent);
      } catch (error) {
        if (!(error instanceof HandshakeError)) throw error;
        if (job.cancelEvent.isSet()) return ['cancelled', '', ''];
        return ['failed', `${name} did not sign in: ${error.message}`, ''];
      } finally {
        await handshake!.close();
      }
      this.#writeCache(agentId, 'ready');
      return ['done', '', ''];
    }
    await handshake?.close(); // a terminal method: never `authenticate`; run the adapter with the method's own args instead
    const command = [...argv, ...method.args];
    const shown = command.map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ');
    if (!this.windows) return ['manual', 'Run this in a terminal, finish the sign-in there, then choose Check again.', shown];
    const process = this.spawnConsole(command, env);
    let code: number | null = null;
    const exited = process.status.then((s) => (code = s.code), () => (code = -1));
    this.#track(job, new ProcessTree(process));
    const deadline = now() + CONSOLE_TIMEOUT;
    while (code === null) {
      await job.cancelEvent.wait(400, exited);
      if (job.cancelEvent.isSet()) return ['cancelled', '', ''];
      if (code !== null) break;
      if (now() > deadline) {
        job.tree?.kill();
        return ['failed', 'The sign-in window was open for too long and was closed. Try again.', ''];
      }
    }
    const exitCode = code as number;
    const state = await this.probe(agentId, argv); // re-check when the process exits
    this.#writeCache(agentId, state);
    if (exitCode !== 0) return ['failed', `The sign-in did not finish (it ended with code ${exitCode}). Try again.`, ''];
    if (state === 'signin') return ['failed', `The sign-in window closed, but ${name} still shows as signed out. Try again.`, ''];
    return ['done', '', ''];
  }
}
