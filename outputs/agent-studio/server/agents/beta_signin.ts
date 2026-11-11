/**
 * Sign-in of the Beta agents (beta_catalog.ts). AIB never reads, copies or stores an agent's credential; the one exception is an API key
 * the person types in Settings, stored with the settings (like an added agent's environment values) and passed to the agent as its
 * environment variable (studio.ts betaEnv), never logged.
 *
 *   Check     The agent itself, hidden, once: `initialize` (clientCapabilities.auth.terminal: true), then `session/new` in an empty folder
 *             of its own (<state>/agents/<id>/probe) with no MCP servers. A session = Ready; ACP auth_required (-32000) = Needs sign-in;
 *             anything else (a timeout, a crash) = Not checked. Cached in <state>/agents/<id>/signin.json like the built-ins, at most once a
 *             minute unless forced (Check again, and after a sign-in).
 *   Sign in   agent-type (catalog signin.kind 'agent'): ACP `authenticate` on a short-lived agent process, in the background (the agent may
 *             open the browser). With a stored API key and an advertised key method, the key goes in `_meta['api-key']` (Gemini's shape).
 *             terminal-type ('terminal'): ACP auth type "terminal". AIB reads the agent's advertised terminal method (its args), writes
 *             them to <state>/agents/<id>/signin-terminal.json, and the page runs the agent with those args in an AIB terminal panel
 *             (web server, server/web/terminal_routes.ts: a ConPTY with no window). When it exits 0 the page asks for a check (re-initialize).
 *             No method advertised: the catalog's login args. Never an external console window.
 *             key-type ('key'): nothing to start; the key field and Check again.
 *   Job       <state>/agents/<id>/signin-job.json, the built-ins' format (signin.ts readJob reads it).
 */
import { type BetaLaunch } from './beta_agents.ts';
import { betaAgent } from './beta_catalog.ts';
import { agentDir, Flag, Mutex, readJson, writeJson } from './installer.ts';
import {
  CACHE_NAME,
  CACHE_SECONDS,
  Handshake,
  HandshakeError,
  JOB_NAME,
  type JobView,
  type Method,
  normalizeMethods,
  readCached,
  readJob,
  SignInRefused,
  type SignState,
} from './signin.ts';
import { isDict, pyLen } from '../core/py.ts';
import { ProcessTree } from '../platform/process_tree.ts';
import { pathOf } from '../state/paths.ts';

export const TERMINAL_NAME = 'signin-terminal.json';
export const TERMINAL_MAX_AGE = 10 * 60; // seconds: the page opens the terminal right after asking
export const CHECK_TIMEOUT = 40;
export const START_TIMEOUT = 25;
export const AUTHENTICATE_TIMEOUT = 15 * 60;
export const PROTOCOL_INIT = {
  protocolVersion: 1,
  clientInfo: { name: 'agent-studio', title: 'AIB', version: '0.1.0' },
  // auth.terminal: AIB runs terminal-type sign-in methods itself (in its own terminal panel), so agents may offer them.
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } },
};

const now = () => Date.now() / 1000;

/** Arguments a terminal sign-in may run with: 1 to 12 plain words, none with a character cmd.exe or a shell would read. */
export function cleanTerminalArgs(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 12) return null;
  const ok = value.every((a) =>
    typeof a === 'string' && pyLen(a) > 0 && pyLen(a) <= 200 && !/[&|<>^%!"`$;\r\n]/.test(a) && !a.includes('\0')
  );
  return ok ? [...value as string[]] : null;
}

/** The terminal sign-in args the agent host saved for the page (fresh and valid), else null: the catalog's args are used then. */
export function readTerminalArgs(stateDir: string, agentId: string, clock: () => number = now): string[] | null {
  const saved = readJson(pathOf(agentDir(stateDir, agentId), TERMINAL_NAME));
  if (!saved || typeof saved.at !== 'number' || clock() - saved.at > TERMINAL_MAX_AGE) return null;
  return cleanTerminalArgs(saved.args);
}

export type BetaLaunchFn = (agentId: string) => Promise<BetaLaunch> | BetaLaunch;
export type EnvFn = (agentId: string) => Record<string, string>;

class Job {
  readonly cancelEvent = new Flag();
  tree: ProcessTree | null = null;
  alive = true;
  done: Promise<void> = Promise.resolve();
  constructor(readonly agentId: string) {}
}

export interface BetaSignerOptions {
  /** Base environment (default: this process's). */
  env?: () => Record<string, string>;
  checkTimeout?: number;
}

export class BetaSigner {
  readonly stateDir: string;
  readonly jobs = new Map<string, Job>();
  readonly #guard = new Mutex();
  readonly #locks = new Map<string, Mutex>();
  readonly #baseEnv: () => Record<string, string>;
  readonly #checkTimeout: number;

  constructor(stateDir: string, readonly launch: BetaLaunchFn, readonly envFor: EnvFn = () => ({}), options: BetaSignerOptions = {}) {
    this.stateDir = pathOf(stateDir);
    this.#baseEnv = options.env ?? (() => Deno.env.toObject());
    this.#checkTimeout = options.checkTimeout ?? CHECK_TIMEOUT;
  }

  #agent(agentId: unknown): string {
    if (!betaAgent(agentId)) throw new SignInRefused('AIB cannot check or start a sign-in for that agent.');
    return agentId as string;
  }

  #env(agentId: string): Record<string, string> {
    return { ...this.#baseEnv(), ...this.envFor(agentId) };
  }

  #dir(agentId: string): string {
    return agentDir(this.stateDir, agentId);
  }

  #writeCache(agentId: string, state: SignState): number {
    const at = now();
    writeJson(pathOf(this.#dir(agentId), CACHE_NAME), { state, checkedAt: at });
    return at;
  }

  #writeJob(agentId: string, state: string, message = '', command = ''): void {
    writeJson(pathOf(this.#dir(agentId), JOB_NAME), { state, message, command, pid: Deno.pid, updatedAt: now() });
  }

  #clear(agentId: string, name: string): void {
    try {
      Deno.removeSync(pathOf(this.#dir(agentId), name));
    } catch { /* already gone */ }
  }

  // ---- the check ----------------------------------------------------------------------------------------------------
  /** initialize + session/new in the agent's own empty probe folder. 'ready' | 'signin' | 'unknown'. Never throws. */
  async probe(agentId: string, argv: string[]): Promise<SignState> {
    const folder = pathOf(this.#dir(agentId), 'probe');
    try {
      Deno.mkdirSync(folder, { recursive: true });
    } catch { /* the agent reports the folder problem */ }
    let shake: Handshake | null = null;
    try {
      shake = new Handshake(argv, this.#env(agentId));
      await shake.request('initialize', PROTOCOL_INIT, this.#checkTimeout);
      const result = await shake.request('session/new', { cwd: folder, mcpServers: [] }, this.#checkTimeout);
      if (isDict(result) && typeof result.sessionId === 'string' && result.sessionId) {
        try {
          await shake.request('session/close', { sessionId: result.sessionId }, 3);
        } catch { /* the process is ended next anyway */ }
        return 'ready';
      }
      return 'unknown';
    } catch (error) {
      if (error instanceof HandshakeError && (error.code === -32000 || /auth/i.test(error.message))) return 'signin';
      return 'unknown';
    } finally {
      await shake?.close();
    }
  }

  check(agentId: unknown, force = false): Promise<{ agent: string; state: SignState; checkedAt: number; checked: boolean }> {
    let id: string;
    try {
      id = this.#agent(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
    let lock = this.#locks.get(id);
    if (!lock) this.#locks.set(id, lock = new Mutex());
    return lock.run(async () => {
      const cached = readCached(this.stateDir, id);
      const row = await this.launch(id);
      if (!row.found) {
        this.#clear(id, CACHE_NAME);
        return { agent: id, state: 'unknown' as SignState, checkedAt: 0, checked: false };
      }
      if (force && ['manual', 'done', 'failed'].includes(readJob(this.stateDir, id).state)) this.#clear(id, JOB_NAME);
      if (!force && cached.checkedAt && now() - cached.checkedAt < CACHE_SECONDS) return { ...cached, agent: id, checked: false };
      const state = await this.probe(id, row.argv);
      return { agent: id, state, checkedAt: this.#writeCache(id, state), checked: true };
    });
  }

  status(agentId: unknown): { state: SignState; checkedAt: number; agent: string; job: JobView } {
    const id = this.#agent(agentId);
    return { ...readCached(this.stateDir, id), agent: id, job: readJob(this.stateDir, id) };
  }

  // ---- Sign in ------------------------------------------------------------------------------------------------------
  /** The methods the agent advertises to a client that runs terminal sign-ins (a short handshake), or [] when it cannot be asked. */
  async methods(argv: string[], agentId: string, timeout = START_TIMEOUT, cancel?: Flag): Promise<[Method[], Handshake | null]> {
    let shake: Handshake | null = null;
    try {
      shake = new Handshake(argv, this.#env(agentId));
      const init = await shake.request('initialize', PROTOCOL_INIT, timeout, cancel);
      return [normalizeMethods(isDict(init) ? init.authMethods : null), shake];
    } catch (error) {
      await shake?.close();
      if (!(error instanceof HandshakeError)) throw error;
      return [[], null];
    }
  }

  /**
   * Sign in. terminal: {state: 'terminal', command, args}: the page runs it in an AIB terminal panel (the args are saved for the web
   * server). agent: the background job ({state: 'waiting'}; poll status). key: refused with what to do instead.
   */
  start(agentId: unknown): Promise<JobView & { args?: string[] }> {
    let id: string;
    try {
      id = this.#agent(agentId);
    } catch (error) {
      return Promise.reject(error);
    }
    const agent = betaAgent(id)!;
    return this.#guard.run(async () => {
      const running = this.jobs.get(id);
      if (running && running.alive) return { ...readJob(this.stateDir, id), attached: true };
      const row = await this.launch(id);
      if (!row.found) {
        throw new SignInRefused(`${agent.name} is not installed yet, so there is nothing to sign in to. ${row.problem}`.trim());
      }
      if (agent.signin.kind === 'key') {
        throw new SignInRefused(`${agent.name} signs in with an API key: type it in the API key box, then choose Check again.`);
      }
      if (agent.signin.kind === 'terminal') {
        const [methods, shake] = await this.methods(row.argv, id);
        await shake?.close();
        const advertised = methods.find((m) => m.kind === 'terminal' && cleanTerminalArgs(m.args));
        const args = advertised ? advertised.args : [...(agent.signin.terminalArgs ?? [])];
        writeJson(pathOf(this.#dir(id), TERMINAL_NAME), { args, method: advertised?.id ?? '', at: now() });
        this.#clear(id, JOB_NAME);
        const shown = [...row.base, ...args].map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
        return { agent: id, state: 'terminal', message: '', command: shown, args };
      }
      const job = new Job(id);
      this.jobs.set(id, job);
      this.#writeJob(id, 'waiting');
      job.done = this.#run(job, row);
      return { ...readJob(this.stateDir, id), attached: false };
    });
  }

  async cancel(agentId: unknown): Promise<JobView> {
    const id = this.#agent(agentId);
    const job = this.jobs.get(id);
    if (job && job.alive) {
      job.cancelEvent.set();
      job.tree?.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([job.done, new Promise<void>((r) => (timer = setTimeout(r, 30_000)))]);
      clearTimeout(timer);
    } else if (['manual', 'failed', 'done'].includes(readJob(this.stateDir, id).state)) this.#clear(id, JOB_NAME);
    return readJob(this.stateDir, id);
  }

  async #run(job: Job, row: BetaLaunch): Promise<void> {
    const id = job.agentId;
    let outcome: 'done' | 'failed' | 'cancelled' = 'failed';
    let message = 'The sign-in stopped unexpectedly.';
    try {
      [outcome, message] = await this.#authenticate(job, row);
    } catch (error) {
      console.error(`Signing in to ${id} failed`, error);
      message = `The sign-in stopped unexpectedly: ${error instanceof Error ? error.message : error}`;
    } finally {
      try {
        if (outcome === 'cancelled') this.#clear(id, JOB_NAME);
        else this.#writeJob(id, outcome, outcome === 'done' ? '' : message);
      } finally {
        job.alive = false;
      }
    }
  }

  async #authenticate(job: Job, row: BetaLaunch): Promise<['done' | 'failed' | 'cancelled', string]> {
    const id = job.agentId;
    const agent = betaAgent(id)!;
    const [methods, shake] = await this.methods(row.argv, id, START_TIMEOUT, job.cancelEvent);
    if (job.cancelEvent.isSet()) {
      await shake?.close();
      return ['cancelled', ''];
    }
    if (!shake) return ['failed', `${agent.name} did not answer, so AIB could not start its sign-in. Try again.`];
    job.tree = shake.tree;
    const usable = methods.filter((m) => m.kind === 'agent');
    const key = agent.signin.keyEnv ? this.envFor(id)[agent.signin.keyEnv] ?? '' : '';
    const byKey = key && agent.signin.keyMethod ? usable.find((m) => m.id === agent.signin.keyMethod) : undefined;
    const method = byKey ?? usable.find((m) => m.id === agent.signin.method) ?? usable[0];
    if (!method) {
      await shake.close();
      return [
        'failed',
        `${agent.name} did not offer a sign-in that AIB can start. Sign in with ${agent.name} itself, then choose Check again.`,
      ];
    }
    const params: Record<string, unknown> = { methodId: method.id };
    if (byKey) params._meta = { 'api-key': key };
    try {
      await shake.request('authenticate', params, AUTHENTICATE_TIMEOUT, job.cancelEvent);
    } catch (error) {
      if (!(error instanceof HandshakeError)) throw error;
      if (job.cancelEvent.isSet()) return ['cancelled', ''];
      return ['failed', `${agent.name} did not sign in: ${error.message}`];
    } finally {
      await shake.close();
    }
    const state = await this.probe(id, row.argv); // the sign-in is done in that process: ask a fresh one, as a new chat would
    this.#writeCache(id, state === 'unknown' ? 'ready' : state);
    if (state === 'signin') return ['failed', `The sign-in finished, but ${agent.name} still shows as signed out. Try again.`];
    return ['done', ''];
  }
}
