/**
 * The connection manager (studio.py's Studio class): every live agent connection of one process, the ownership check before a
 * chat opens (lease, command-line probe, announcements), owner announcements and their heartbeat, the recovery list and the
 * automatic reconnect after a restart, the install and sign-in jobs, the worktree per chat and live sync, and the artifact tool's
 * environment. The agent host (agent_host.ts) runs one; `--in-process` puts one inside the web server instead.
 *
 * Its live_* methods are the same interface HostProxy offers (LiveBackend), so the web server calls either one without knowing
 * which it has. JSON in, JSON out; status codes, payloads and messages are Python's.
 *
 * Python ran connect's setup, the reconnect workers and the heartbeat on threads under an RLock; here they are async tasks. Every
 * Python `with self.lock:` block does no blocking work, so it is a stretch of synchronous code here.
 */
import { Connection, type ConnectionOptions, errorText, ThreadEvent } from '../acp/connection.ts';
import { sessionOp } from '../acp/breadth.ts';
import type { McpServer } from '../acp/breadth.ts';
import { PromptStateUnknown } from '../acp/rpc_errors.ts';
import { QueueStore } from '../acp/msgqueue.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import * as adapters from '../agents/adapters.ts';
import { Installer, InstallRefused } from '../agents/installer.ts';
import { readCached as readSignIn, Signer, SignInRefused } from '../agents/signin.ts';
import { betaAgent, isBeta } from '../agents/beta_catalog.ts';
import { resolveBeta } from '../agents/beta_agents.ts';
import { BetaSigner } from '../agents/beta_signin.ts';
import { AgentOptionsCache } from '../state/agent_options.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { artifactToolCommand } from '../artifacts/mcp.ts';
import { ArtifactMcpHttp, FORWARD_FILE, forwardEntry, httpEntry, ownForwardFile } from '../artifacts/mcp_http.ts';
import { forwarderOf } from '../keeper/client.ts';
import { isCompiled, isDesktopApp, selfCommand, TESTS_DIR } from '../core/app.ts';
import { type ChannelInfo, type OrphanCommand, readKeeperInfo } from '../keeper/client.ts';
import { pidAlive } from './host_client.ts';
import { type KeeperChannel, KeeperLink, keeperSetting, keeperWanted, noteKeeperProblem } from '../keeper/link.ts';
import { announce, getLogger, registerSecret } from '../core/log.ts';
import { isDict, isStr, pyLen, pyRepr, ValueError } from '../core/py.ts';
import { findExternalOwner, OwnershipConflict, probeExternalOwner, SessionLease } from '../ownership/ownership.ts';
import { HEARTBEAT_SECONDS, OwnerRegistry, OwnershipEvidence, OwnershipProbe } from '../ownership/probe.ts';
import { expandUser } from '../platform/pypath.ts';
import { home, isdir, join, realpath } from '../platform/ospath.ts';
import { Recovery, StateStore } from '../state/recovery.ts';
import { ConversationState, ProjectPrefs, ReadState, SettingsStore } from '../state/store.ts';
import { builtinLaunch } from '../web/shared.ts';
import { isNetworkPath } from '../web/security.ts';
import * as wt from '../worktrees/worktrees.ts';
import { LiveSync, Mutex } from '../worktrees/sync.ts';

const log = getLogger('studio');

type Json = Record<string, unknown>;

export const ARTIFACT_URL_FILE = 'artifact-web.json'; // the web server writes its URL here so agents find it after a restart
export const CLOSED_GRACE_SECONDS = 10 * 60; // a closed connection stays listed this long so the page can still show "disconnected"
export const MAX_CLOSED_CONNECTIONS = 20; // ...and never more than this many closed ones are kept (oldest go first)
export const RECONNECT_TRIES = 3;

/** Studio.LIVE_POST_OPS: the generic POST /api/live/<name> calls (web/live_routes.ts keeps the same list). */
export const LIVE_POST_OPS: ReadonlySet<string> = new Set([
  'connect',
  'discover',
  'forget',
  'prompt',
  'cancel',
  'permission',
  'authenticate',
  'elicitation',
  'config',
  'mode',
  'cancel-pending',
  'session-op',
  'disconnect',
  'queue',
  'queue-edit',
  'queue-remove',
  'queue-move',
  'queue-resume',
  'queue-send-now',
  'dismiss-unknown',
  'worktree-discard',
  'worktree-archive',
]);

/** Python's KeyError: str() of it is the repr of the key, which is what the page sees as the error text. */
export class KeyError extends Error {
  override name = 'KeyError';
  constructor(key: unknown) {
    super(pyRepr(key));
  }
}

/** body[key], or KeyError like a Python dict lookup. */
export function need(body: Json, key: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(body, key)) throw new KeyError(key);
  return body[key];
}

/**
 * The errors Python's `except (KeyError, ValueError, TypeError, OSError, RuntimeError, TimeoutError)` catches, by the name the
 * ported modules give their Python exception classes. JavaScript's own engine errors (a ReferenceError, a RangeError from a bug)
 * are not request errors, except the RangeError security.refuseNetworkPath throws for a refused path.
 */
const REQUEST_ERROR_NAMES = new Set([
  'KeyError',
  'ValueError',
  'TypeError',
  'OSError',
  'RuntimeError',
  'TimeoutError',
  'BrokenPipeError',
  'FileNotFoundError',
  'PermissionError',
  'OwnershipConflict',
  'OwnershipEvidence',
  'PromptStateUnknown',
  'RpcError',
  'WorktreeGone',
  'InstallRefused',
  'SignInRefused',
  'GitError',
  'LockTimeout',
  'JSONDecodeError',
  'FolderError',
  'Fallback',
  'HandshakeError',
  'AnnouncementError',
  'Refused',
  'Error',
]);

export function isRequestError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  if (error instanceof Deno.errors.NotFound || error instanceof Deno.errors.PermissionDenied) return true;
  if (Object.values(Deno.errors).some((kind) => error instanceof kind)) return true; // OSError family
  return REQUEST_ERROR_NAMES.has(error.name) || error.constructor.name.endsWith('ValueError');
}

/** The Python class name a request error reports as errorType on the host RPC. */
export function pythonErrorType(error: Error): string {
  if (error instanceof Deno.errors.NotFound) return 'FileNotFoundError';
  if (error instanceof Deno.errors.PermissionDenied) return 'PermissionError';
  if (Object.values(Deno.errors).some((kind) => error instanceof kind)) return 'OSError';
  if (error.constructor.name.endsWith('ValueError') && error.name === 'Error') return 'ValueError';
  return error.name === 'Error' ? 'RuntimeError' : error.name;
}

/** The agent options a Studio reads (the command-line flags of studio.py / agent_host.py; server/core/options.ts has them all). */
export interface StudioOptions {
  /** undefined/null: no state folder was configured (Python: the namespace has no state_dir), so nothing durable is kept. */
  stateDir?: string | null;
  port?: number | null;
  ompSessions?: string | null;
  claudeProjects?: string | null;
  ompCommand?: string;
  nodeCommand?: string;
  claudeLauncher?: string;
  codexLauncher?: string;
  ownersDir?: string | null;
  autoReconnect?: boolean;
  enableClientTerminal?: boolean;
  enableClientFs?: 'read' | 'readwrite' | null;
  noArtifactTool?: boolean;
  /** How agents get the artifact tool; default 'http' from a built binary, else 'stdio' (see artifactMcpServers). */
  artifactTransport?: 'stdio' | 'http';
  mcpServers?: McpServer[];
  migration?: Record<string, unknown> | null;
}

export type ConnectionFactory = (command: string[], cwd: string, provider: string, options?: ConnectionOptions) => Connection;
export type OwnerProbe = (provider: string, sessionId: string, excludedPids?: Iterable<number>) => number | null | Promise<number | null>;

export interface ConnectOptions {
  background?: boolean;
  continueAnyway?: boolean;
  /** The New chat page's picks, applied before the first prompt (Connection.startPicks). New chats only. */
  picks?: Partial<Record<'model' | 'mode' | 'effort', string>> | null;
}

/** A failed or empty probe is not tried again for this long (seconds) for the same agent and folder. */
export const PROBE_COOLDOWN_SECONDS = 10 * 60;
/** The whole quiet probe (start, initialize, session/new, close) may take at most this long (seconds). */
export const PROBE_TIMEOUT_SECONDS = 40;

/** body.picks of a connect request: {model?, mode?, effort?} with short string values, else null. */
export function readPicks(value: unknown): ConnectOptions['picks'] {
  if (value === undefined || value === null) return null;
  if (!isDict(value)) throw new ValueError('picks must be an object');
  const out: Partial<Record<'model' | 'mode' | 'effort', string>> = {};
  for (const kind of ['model', 'mode', 'effort'] as const) {
    const v = value[kind];
    if (v === undefined || v === null || v === '') continue;
    if (!isStr(v) || pyLen(v) > 300) throw new ValueError(`picks.${kind} must be a short string`);
    out[kind] = v;
  }
  return Object.keys(out).length ? out : null;
}

export interface StudioConstruct {
  /** The recovery file's name part (studio-recovery-<port>.json): the agent host passes 'host'. Default: options.port, else 0. */
  port?: number | string | null;
  connectionFactory?: ConnectionFactory | null;
  /**
   * The keeper link (tests pass their own). undefined: one when this process decided to use the keeper (decideKeeper) or a keeper
   * already runs for the state folder; null: none.
   */
  keeper?: KeeperLink | null;
  /** New chats start in the keeper (default: the start decision, keeperSetting(); true when a test passes its own link). */
  keeperForNew?: boolean;
  /** Shared stores (an --in-process web server passes its own, so both read and write one instance). */
  stores?: { conversations?: ConversationState; projectPrefs?: ProjectPrefs; readState?: ReadState; settings?: SettingsStore };
}

const defaultFactory: ConnectionFactory = (command, cwd, provider, options) => new Connection(command, cwd, provider, options ?? {});
const pairKey = (provider: unknown, sessionId: unknown) => JSON.stringify([provider, sessionId]);

export class Studio {
  readonly options: StudioOptions;
  connectionFactory: ConnectionFactory;
  /** (provider, sessionId) -> folder of a saved transcript; null means chat_folders' own lookup. */
  savedCwd: ((provider: string, sessionId: string) => string) | null = null;
  readonly connections = new Map<string, Connection>();
  /** Tests replace this to age closed connections without sleeping (seconds). */
  clock: () => number = () => Date.now() / 1000;
  readonly token: string;
  /**
   * The id open pages compare to tell "the same Studio" (connection ids still valid) from a restart. With the keeper it survives a
   * restart or update of this process as long as the keeper does (keeperInstanceId): the chats are rebuilt under the same ids.
   */
  readonly instanceId: string;
  readonly stateDir: string;
  readonly hasStateDir: boolean;
  ownerProbe: OwnerProbe;
  readonly owners: OwnerRegistry | null;
  readonly probe: OwnershipProbe;
  heartbeatSeconds = HEARTBEAT_SECONDS;
  readonly store: StateStore | null;
  readonly recovery: Recovery | null;
  readonly conversations: ConversationState;
  readonly projectPrefs: ProjectPrefs;
  readonly readState: ReadState;
  readonly settings: SettingsStore;
  readonly worktrees: wt.Manager | null;
  readonly liveSync: LiveSync | null;
  /** Callable returning the web server's base URL for the artifact tool; set by the agent host. */
  artifactUrlProvider: (() => string) | null = null;
  autoReconnect: boolean;
  /** pairKey(provider, sessionId) of chats queued or being reconnected right now. */
  readonly reconnectPending = new Set<string>();
  reconnectStarted = false;
  readonly reconnectStop = new ThreadEvent();
  reconnectWorkers: Promise<void>[] = [];
  installer: Installer | null = null;
  signer: Signer | null = null;
  betaSigner: BetaSigner | null = null;
  /** Bootstrap's hostMode: 'keeper' when agents run in the keeper (they outlive this process), else 'in-process'. */
  get hostMode(): string {
    return this.keeper && this.keeperForNew ? 'keeper' : 'in-process';
  }
  /** The in-process Studio has no separate host: no code warning, nobody to wait for. */
  readonly hostInfo: unknown = undefined;
  readonly waitingChats = 0;
  /** Cleaning up half-made worktrees (Python does it in __init__); connect waits for it. */
  readonly ready: Promise<void>;
  /** The model / mode / effort lists each agent reported (state/agent_options.ts). */
  readonly agentOptions: AgentOptionsCache;
  /** Running quiet probes by agent|folder, and when each last failed (seconds). */
  readonly #probes = new Map<string, Promise<void>>();
  readonly #probeFailed = new Map<string, number>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #closed = false;
  /** Agents run in the keeper and chats are rebuilt from its record after a restart; null: agents are children. */
  readonly keeper: KeeperLink | null;
  /**
   * New chats start in the keeper: decided when AIB started (on unless the keeper cannot run or AIB_KEEPER=0). False with a keeper
   * link means a keeper still holds chats from before while this Studio runs without it (the fallback, a split agent host): they
   * are taken over and stay there until they end, and new chats run as children.
   */
  readonly keeperForNew: boolean;
  #mcpHttp: ArtifactMcpHttp | null = null;

  constructor(options: StudioOptions, construct: StudioConstruct = {}) {
    this.options = options;
    this.connectionFactory = construct.connectionFactory ?? defaultFactory;
    this.token = newToken();
    registerSecret(this.token);
    this.hasStateDir = options.stateDir !== undefined && options.stateDir !== null;
    this.stateDir = this.hasStateDir ? String(options.stateDir) : join(TESTS_DIR, 'agent-studio-state');
    const withKeeper = construct.keeper !== undefined ? !!construct.keeper : this.hasStateDir && keeperWanted(this.stateDir);
    this.instanceId = withKeeper && this.hasStateDir ? keeperInstanceId(this.stateDir) : crypto.randomUUID().replaceAll('-', '');
    this.ownerProbe = (provider, sessionId, excluded) => this.#cmdlineOwner(provider, sessionId, excluded);
    this.owners = options.ownersDir ? new OwnerRegistry(options.ownersDir, { instanceId: this.instanceId }) : null;
    this.probe = new OwnershipProbe({
      ompRoot: options.ompSessions ?? null,
      claudeRoot: options.claudeProjects ?? null,
      registry: this.owners,
      ownedByStudio: (provider, sessionId) => this.#studioOwns(provider, sessionId),
      ownPids: () => this.#ownAgentPids(),
    });
    const name = construct.port !== undefined && construct.port !== null ? construct.port : options.port ?? 0;
    // Recovery state is kept only when a state directory was configured explicitly.
    this.store = this.hasStateDir ? new StateStore(this.stateDir, `recovery-${name}`) : null;
    this.recovery = this.store ? new Recovery(this.store) : null;
    if (this.recovery) this.recovery.queues = new QueueStore(this.stateDir, `queues-${name}`); // queued messages survive a host restart (paused)
    const dir = this.hasStateDir ? this.stateDir : null;
    const stores = construct.stores ?? {};
    this.conversations = stores.conversations ?? new ConversationState(dir);
    this.projectPrefs = stores.projectPrefs ?? new ProjectPrefs(dir);
    this.readState = stores.readState ?? new ReadState(dir);
    this.settings = stores.settings ?? new SettingsStore(dir);
    this.agentOptions = new AgentOptionsCache(dir);
    const manager = this.hasStateDir ? new wt.Manager(this.stateDir) : null; // worktree per chat (hidden flag)
    this.worktrees = manager;
    this.ready = (async () => {
      if (!manager) return;
      try {
        await manager.cleanupIncomplete(); // a half-made worktree of a process that died
        await manager.retryPending(); // removals that were pending (a file in use) + git worktree prune
      } catch (error) {
        log.exception(error, 'Cleaning up half-made worktrees failed');
      }
    })();
    // live sync of the user's saved edits into chat worktrees; watchers start only for open worktree chats
    this.liveSync = this.worktrees ? new LiveSync(this) : null;
    if (this.hasStateDir) artifactKeys.configure(this.stateDir);
    // The command-line flag can only turn it off; the Settings page can too, read here, so a change applies at the next start.
    this.autoReconnect = (options.autoReconnect ?? true) && this.settings.autoReconnect();
    this.keeper = construct.keeper !== undefined
      ? construct.keeper
      : withKeeper
      ? new KeeperLink({ dataDir: this.stateDir, orphan: orphanCommand() })
      : null;
    this.keeperForNew = !!this.keeper &&
      (construct.keeperForNew ?? (construct.keeper !== undefined ? true : keeperSetting()));
    if (this.keeper) {
      this.keeper.onLost = (channels) => this.#keeperLost(channels);
      this.keeper.onClient = () => saveKeeperInstance(this.stateDir, this.instanceId); // the ids now live as long as this keeper
    }
  }

  // ---- hooks on each connection ------------------------------------------------------------------------------------------
  /** The agent finished a turn: mark the conversation "your turn" until the user acts on it. */
  async turnEnded(connection: Connection): Promise<void> {
    if (this.liveSync && connection.worktree) {
      try {
        await this.liveSync.turnEnded(connection); // the lost-update guard and the merge of files both sides changed
      } catch (error) {
        log.exception(error, 'Merging the user edits at the end of the turn failed');
      }
    }
    if (connection.provider && connection.sessionId) await this.#mark('your_turn', connection);
  }

  async #mark(action: string, connection: Connection): Promise<void> {
    try {
      await this.conversations.apply(action, connection.provider, connection.sessionId);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ValueError')) throw error;
    }
  }

  #studioOwns(provider: string, sessionId: string): boolean {
    return [...this.connections.values()].some((c) => c.provider === provider && c.sessionId === sessionId && !c.closed);
  }

  #ownAgentPids(): number[] {
    return [...this.connections.values()].filter((c) => !c.closed && c.process !== null).map((c) => c.process!.pid);
  }

  /** Strong, read-only check: a native agent process whose command line names this session. */
  async #cmdlineOwner(provider: string, sessionId: string, excludedPids: Iterable<number> = []): Promise<number | null> {
    const [snapshot] = this.probe.processes.get(0);
    if (snapshot === null) return await probeExternalOwner(provider, sessionId, excludedPids);
    const own = this.probe.ownProcessIds(snapshot);
    for (const pid of excludedPids) own.add(Number(pid));
    const rows = snapshot.filter((p) => p.cmdline).map((p) => ({ pid: p.pid, name: p.name, commandline: p.cmdline }));
    return findExternalOwner(rows, provider, sessionId, own);
  }

  announce(connection: Connection, state: string | null = null): void {
    if (!this.owners || !connection.sessionId || connection.closed) return;
    this.owners.announce(connection.provider, connection.sessionId, connection.cwd, state || (connection.busy ? 'working' : 'ready'));
    if (this.#heartbeat === null && !this.#closed) {
      this.#heartbeat = setInterval(() => this.heartbeatTick(), this.heartbeatSeconds * 1000);
      Deno.unrefTimer(this.#heartbeat);
    }
  }

  /** One owner heartbeat: refresh the announcement of every open chat, withdraw the ones no longer open. */
  heartbeatTick(): void {
    try {
      const live = [...this.connections.values()].filter((c) => c.sessionId && !c.closed);
      const keys = new Set<string>();
      for (const connection of live) {
        keys.add(pairKey(connection.provider, connection.sessionId));
        this.announce(connection);
      }
      for (const [[provider, sessionId]] of this.owners ? this.owners.claimed() : []) {
        if (!keys.has(pairKey(provider, sessionId))) this.owners!.withdraw(provider, sessionId);
      }
    } catch (error) {
      log.exception(error, 'Owner heartbeat failed');
    }
  }

  withdraw(connection: Connection): void {
    if (this.liveSync) {
      this.liveSync.refresh().catch((error) => log.exception(error, 'Stopping live sync failed')); // the last chat of a project closed
    }
    if (connection.sessionId) {
      this.probe.noteReleased(connection.provider, connection.sessionId);
      if (this.owners) this.owners.withdraw(connection.provider, connection.sessionId);
    }
  }

  /** Throw OwnershipEvidence unless the conversation may be opened. The command-line probe has run already. */
  checkOwnership(provider: string, sessionId: string, cwd: string, continueAnyway = false, fresh = true): unknown {
    const verdict = this.probe.assess(provider, sessionId, { cwd, skipCmdline: true, fresh });
    if (verdict.verdict === 'owned_elsewhere') {
      const strong = verdict.reasons.find((r) => r.strength === 'strong')!.text;
      throw new OwnershipEvidence(`${strong} Stop it in its current client before continuing here.`, 'session_in_use', verdict);
    }
    if (verdict.verdict === 'possibly_active' && !continueAnyway) {
      throw new OwnershipEvidence(
        'Another app may be using this conversation: ' + verdict.reasons.slice(0, 2).map((r) => r.text).join(' '),
        'possibly_active',
        verdict,
      );
    }
    return verdict;
  }

  /** Conversations the previous Studio process owned and this one does not (yet). */
  recovered(): Json[] {
    if (!this.store) return [];
    const openNow = new Set([...this.connections.values()].filter((c) => !c.closed).map((c) => pairKey(c.provider, c.sessionId)));
    const result: Json[] = [];
    for (const item of [...this.store.conversations.values()]) {
      const key = pairKey(item.provider, item.sessionId);
      if (openNow.has(key)) continue;
      result.push({
        ...item,
        unknownMessages: this.store.unknownCount(item.provider, item.sessionId),
        unknownReceipts: this.store.unknownReceipts(item.provider, item.sessionId),
        reconnecting: this.reconnectPending.has(key),
      });
    }
    return result;
  }

  // ---- automatic reconnect after a restart -------------------------------------------------------------------------------
  /**
   * Reload, in the background, every conversation that was live in Studio before the restart. Uses the ordinary resume path of
   * connect() with continueAnyway=false, so the ownership check runs: a conversation another app owns or may be using is skipped
   * and stays "Not running". Nothing is ever sent to an agent. At most `concurrency` start at once, `stagger` seconds apart; a
   * failure is retried up to `tries` times and then dropped from the recovery list. Returns how many were queued.
   */
  startAutoReconnect(concurrency = 2, stagger = 1.0, tries: number | null = null, retryDelay = 5.0): number {
    if (!this.store || !this.autoReconnect || this.reconnectStarted) return 0;
    this.reconnectStarted = true;
    const attempts = tries || RECONNECT_TRIES;
    const items = this.recovered().map((r) => [r.provider, r.sessionId, r.cwd] as [string, string, string]);
    if (!items.length) return 0;
    for (const [p, i] of items) this.reconnectPending.add(pairKey(p, i));
    const work = [...items];
    const gate = new Mutex();
    let started = false;
    const worker = async () => {
      while (!this.reconnectStop.isSet()) {
        let item: [string, string, string] | undefined;
        const proceed = await gate.run(async () => { // one start at a time, spaced out
          if (!work.length) return false;
          item = work.shift()!;
          if (started && await this.reconnectStop.wait(stagger * 1000)) return false;
          started = true;
          return true;
        });
        if (!proceed) return;
        await this.reconnectOne(item!, attempts, retryDelay);
      }
    };
    for (let n = 0; n < Math.max(1, Math.trunc(concurrency)); n++) this.reconnectWorkers.push(worker());
    return items.length;
  }

  async reconnectOne(item: [string, string, string], tries: number, retryDelay: number): Promise<void> {
    const [provider, sessionId, cwd] = item;
    const label = `${provider} ${sessionId} in ${cwd}`;
    try {
      for (let attempt = 1; attempt <= tries; attempt++) {
        if (this.reconnectStop.isSet()) return;
        try {
          await this.connect(provider, cwd, sessionId, { background: false, continueAnyway: false });
          console.error(`Auto-reconnect: reconnected ${label}`);
          return;
        } catch (error) {
          if (error instanceof OwnershipConflict) {
            console.error(`Auto-reconnect: skipped ${label}: ${error.message}`);
            return;
          }
          log.warning('Auto-reconnect of %s failed (try %s of %s): %s', label, attempt, tries, errorText(error));
          console.error(`Auto-reconnect: ${label} failed (try ${attempt} of ${tries}): ${errorText(error)}`);
          if (attempt < tries && await this.reconnectStop.wait(retryDelay * 1000)) return;
        }
      }
      if (this.store!.forgetConversation(provider, sessionId)) {
        console.error(`Auto-reconnect: gave up on ${label}; it stays Not running`);
      }
    } finally {
      this.reconnectPending.delete(pairKey(provider, sessionId));
    }
  }

  forgetRecovered(provider: unknown, sessionId: unknown): boolean {
    if (!isStr(provider) || !isStr(sessionId)) throw new ValueError('Invalid conversation');
    return !!(this.store && this.store.forgetConversation(provider, sessionId));
  }

  /**
   * [argv, extra environment] that starts this agent. Never a shell string. fresh=true is a brand-new chat: an agent turned off in
   * Settings is refused there, but its saved chats can still be reopened.
   */
  async agentLaunch(provider: string, fresh = false): Promise<[string[], Record<string, string>]> {
    if ((agentRegistry.BUILTIN_IDS as readonly string[]).includes(provider)) {
      if (fresh && !this.settings.builtinEnabled(provider)) {
        throw new ValueError(`${agentRegistry.BUILTIN_NAMES[provider]} is turned off in Settings`);
      }
      if (provider === 'omp') {
        if (!this.options.ompCommand) throw new ValueError('OMP is not installed: it was not found on PATH');
        return [[this.options.ompCommand, 'acp'], {}];
      }
      const row = await builtinLaunch(this.#agentOptions(), this.settings, provider);
      if (!row.found) throw new ValueError(`${agentRegistry.BUILTIN_NAMES[provider]} is not available: ${row.problem}`);
      return [row.argv, {}];
    }
    if (isBeta(provider)) return await this.#betaLaunch(provider, fresh);
    const agent = agentRegistry.isCustom(provider) ? this.settings.customAgent(provider) : null;
    if (agent === null) throw new ValueError('That agent is not in Settings (it may have been removed)');
    if (fresh && !agent.enabled) throw new ValueError(`${agent.name} is turned off in Settings`);
    for (const e of agent.env) registerSecret(e.value); // custom agent env values (often API keys) never reach a log line
    return [[agentRegistry.checkCommand(agent.command), ...agent.args], Object.fromEntries(agent.env.map((e) => [e.name, e.value]))];
  }

  /** A Beta agent (beta_catalog.ts): refused for a new chat while it is off; its API key, when one is stored, goes in its environment. */
  async #betaLaunch(provider: string, fresh: boolean): Promise<[string[], Record<string, string>]> {
    const agent = betaAgent(provider)!;
    if (fresh && !this.settings.betaEnabled(provider)) throw new ValueError(`${agent.name} is turned off in Settings`);
    const row = await resolveBeta(provider, { stateDir: this.hasStateDir ? this.stateDir : null, nodeCommand: this.options.nodeCommand || '' });
    if (!row.found) throw new ValueError(`${agent.name} is not available: ${row.problem}`);
    return [row.argv, this.betaEnv(provider)];
  }

  /** The environment a Beta agent gets on top of AIB's: its stored API key under the agent's variable (registered as a secret). */
  betaEnv(provider: string): Record<string, string> {
    const agent = betaAgent(provider);
    const key = agent?.signin.keyEnv ? this.settings.betaKey(provider) : '';
    if (!agent?.signin.keyEnv || !key) return {};
    registerSecret(key); // never in a log line
    return { [agent.signin.keyEnv]: key };
  }

  #agentOptions() {
    return { ...this.options, stateDir: this.hasStateDir ? this.stateDir : null };
  }

  async agentCommand(provider: string): Promise<string[]> {
    return (await this.agentLaunch(provider))[0];
  }

  // ---- artifact tool -----------------------------------------------------------------------------------------------------
  /** Base URL of the web server the artifact tool should call ('' when unknown; the tool then reads the URL file). */
  artifactBaseUrl(): string {
    let url = '';
    try {
      url = this.artifactUrlProvider ? this.artifactUrlProvider() : '';
    } catch (error) {
      log.exception(error, 'The artifact URL provider failed');
      url = '';
    }
    const port = this.options.port;
    if (!url && Number.isInteger(port) && port) url = `http://127.0.0.1:${port}`;
    return url || '';
  }

  /** How agents get the artifact tool: 'http' from a built binary (see artifacts/mcp_http.ts), 'stdio' under `deno run`. */
  artifactTransport(): 'stdio' | 'http' {
    return this.options.artifactTransport ?? (isCompiled() ? 'http' : 'stdio');
  }

  /** The HTTP artifact server of this Studio, started on first use. */
  artifactMcpHttp(): ArtifactMcpHttp {
    if (this.#closed) throw new Error('This AIB is closed');
    if (!this.#mcpHttp) {
      this.#mcpHttp = new ArtifactMcpHttp({
        conversation: (id) => {
          const c = this.connections.get(id);
          return c && !c.closed ? { cwd: c.cwd, worktree: !!c.worktree } : null;
        },
        baseUrl: () => this.artifactBaseUrl(),
        urlFile: join(this.stateDir, ARTIFACT_URL_FILE),
        addressFile: this.keeper ? join(this.stateDir, FORWARD_FILE) : undefined, // the keeper's MCP forwarder reads it
      });
    }
    this.#mcpHttp.start();
    return this.#mcpHttp;
  }

  /**
   * The `studio_artifact` MCP entries for one conversation (appended to the user's --mcp-config entries), or []. stdio: the
   * stdio entry. http: the HTTP entry first and the stdio entry as the fallback, under the same name; the connection gives the
   * agent the first one it supports (selectMcpServers), so agents that advertise mcpCapabilities.http get the HTTP one.
   */
  artifactMcpServers(conversationId: string, worktree = false, forwarder: string | null = null): McpServer[] {
    if (this.options.noArtifactTool || !this.hasStateDir) return [];
    const key = artifactKeys.issue(conversationId);
    if (!key) return [];
    if (forwarder) {
      // An agent in the keeper (design 3.7): the keeper's forwarder, whose program is never in an AIB version folder (an update can
      // remove the old version's files while the chat runs), posting to whichever AIB serves the tool now. stdio only: every ACP
      // agent supports it, and an HTTP entry's port would be dead after the next restart.
      const file = join(this.stateDir, FORWARD_FILE);
      try {
        this.artifactMcpHttp(); // listening, with its address published, before the agent starts the forwarder
        ownForwardFile(file);
        return [forwardEntry(forwarder, file, key, conversationId) as unknown as McpServer];
      } catch (error) {
        log.exception(error, 'Could not start the HTTP artifact tool for the keeper forwarder; the agent gets the usual entries');
      }
    }
    const stdio = this.#artifactStdioEntry(conversationId, key, worktree);
    if (this.artifactTransport() !== 'http') return stdio;
    let url: string;
    try {
      url = this.artifactMcpHttp().url;
    } catch (error) {
      log.exception(error, 'Could not start the HTTP artifact tool; agents get the stdio one');
      return stdio;
    }
    return [httpEntry(url, key, conversationId) as unknown as McpServer, ...stdio];
  }

  #artifactStdioEntry(conversationId: string, key: string, worktree: boolean): McpServer[] {
    const env: Record<string, string> = {
      STUDIO_ARTIFACT_URL: this.artifactBaseUrl(),
      STUDIO_ARTIFACT_URL_FILE: join(this.stateDir, ARTIFACT_URL_FILE),
      STUDIO_ARTIFACT_KEY: key,
      STUDIO_CONVERSATION_ID: conversationId,
    };
    if (worktree) env.STUDIO_WORKTREE = '1'; // only a worktree chat is offered the merge tools
    return [{
      name: 'studio_artifact',
      ...artifactToolCommand(), // `<deno> run -A --quiet main.ts mcp-artifact` (or `<binary> mcp-artifact`): artifacts/mcp.ts
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    } as McpServer];
  }

  /** Protocol-native session discovery (session/list). Never loads or prompts a session. */
  async listAgentSessions(provider: unknown, cwd: unknown = null, cursor: unknown = null): Promise<Json> {
    if (provider !== 'omp' && provider !== 'claude') {
      throw new ValueError('Finding saved chats through the agent works for Claude Code and OMP only');
    }
    const command = await this.agentCommand(provider);
    if (cursor !== null && cursor !== undefined && (!isStr(cursor) || !(pyLen(cursor) > 0 && pyLen(cursor) <= 1024))) {
      throw new ValueError('Invalid session list cursor');
    }
    if (cwd !== null && cwd !== undefined && (!isStr(cwd) || pyLen(cwd) > 1024)) throw new ValueError('Invalid workspace filter');
    const live = [...this.connections.values()].find((c) => c.provider === provider && c.ready && !c.closed);
    if (live) return { ...(await live.listSessions((cwd as string) || null, (cursor as string) || null)), via: 'studio-connection' };
    const probe = this.connectionFactory(command, home(), provider);
    try {
      await probe.initializeForDiscovery();
      return { ...(await probe.listSessions((cwd as string) || null, (cursor as string) || null)), via: 'temporary-process' };
    } finally {
      await probe.close();
    }
  }

  // ---- model / mode / effort lists for new chats ---------------------------------------------------------------------------
  /** Remember the lists this connection's agent reports (a new chat's defaults come from its session/new reply). Never throws. */
  rememberOptions(c: Connection): void {
    if (c.replaying) return; // a keeper rebuild replays an old record: nothing new to remember
    try {
      const folder = c.projectRoot || c.cwd;
      if (c.startSettings) this.agentOptions.record(c.provider, folder, c.startSettings, true);
      this.agentOptions.record(c.provider, folder, c.settings, false);
    } catch (error) {
      log.exception(error, 'Remembering the model lists failed');
    }
  }

  /**
   * POST /api/live/agent-options {agent, cwd?, probe?}: the model / mode / effort lists a new chat of this agent can offer, from
   * memory. An open chat of the agent refreshes the memory first. With probe=true and nothing remembered, a quiet probe runs once
   * (hidden process, initialize + session/new with no MCP servers, closed again; never a sign-in, never a prompt), at most one at a
   * time per agent and folder, and not again for PROBE_COOLDOWN_SECONDS after it failed or found nothing.
   */
  async agentOptionsFor(body: Json): Promise<Json> {
    const agent = body.agent;
    if (!isStr(agent) || !agentRegistry.isProvider(agent)) throw new ValueError('Choose an agent');
    const cwd = isStr(body.cwd) && pyLen(body.cwd) <= 1024 ? body.cwd : '';
    for (const c of this.connections.values()) {
      if (c.provider === agent && c.ready && !c.closed) this.rememberOptions(c);
    }
    let hit = this.agentOptions.lookup(agent, cwd);
    if (hit || body.probe !== true) return { agent, options: hit, probed: false };
    const key = `${agent}|${cwd}`;
    const failedAt = this.#probeFailed.get(key);
    if (failedAt !== undefined && this.clock() - failedAt < PROBE_COOLDOWN_SECONDS) {
      return { agent, options: null, probed: false, probeError: 'tried recently' };
    }
    if (this.hasStateDir && readSignIn(this.stateDir, agent).state === 'signin') {
      return { agent, options: null, probed: false, probeError: 'needs sign-in' };
    }
    let problem = '';
    let running = this.#probes.get(key);
    if (!running) {
      running = this.#probe(agent, cwd)
        .catch((error) => {
          problem = errorText(error);
          this.#probeFailed.set(key, this.clock());
        })
        .finally(() => this.#probes.delete(key));
      this.#probes.set(key, running);
    }
    await running;
    hit = this.agentOptions.lookup(agent, cwd);
    if (!hit && !this.#probeFailed.has(key)) this.#probeFailed.set(key, this.clock());
    return { agent, options: hit, probed: true, ...(problem ? { probeError: problem } : {}) };
  }

  async #probe(agent: string, cwd: string): Promise<void> {
    const [command, env] = await this.agentLaunch(agent, true);
    const folder = cwd && isdir(cwd) ? realpath(expandUser(cwd)) : home();
    const probe = Object.keys(env).length
      ? this.connectionFactory(command, folder, agent, { env })
      : this.connectionFactory(command, folder, agent);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settings = await Promise.race([
        probe.probeSettings(PROBE_TIMEOUT_SECONDS - 5),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ValueError('The agent did not answer in time')), PROBE_TIMEOUT_SECONDS * 1000);
        }),
      ]);
      this.agentOptions.record(agent, cwd && isdir(cwd) ? cwd : null, settings, true);
      log.info('Read the model lists of %s with a quiet probe', agent);
    } finally {
      clearTimeout(timer);
      await probe.close();
    }
  }

  // ---- connect ------------------------------------------------------------------------------------------------------------
  async connect(provider: string, cwd: string, resume: string | null = null, options: ConnectOptions = {}): Promise<Connection> {
    const background = options.background ?? false;
    const continueAnyway = options.continueAnyway ?? false;
    if (resume !== null && resume !== undefined && (!isStr(resume) || pyLen(resume) > 512)) {
      throw new ValueError('Invalid saved session ID');
    }
    resume = resume || null;
    await this.ready;
    this.evictClosed();
    if (!isStr(cwd)) throw new TypeError(`expected str, bytes or os.PathLike object, not ${cwd === null ? 'NoneType' : typeof cwd}`);
    let workspace = realpath(expandUser(cwd));
    if (this.worktrees && this.worktrees.isRemoved(workspace, resume ? `${provider}:${resume}` : null)) {
      throw new wt.WorktreeGone(wt.GONE_MESSAGE); // discarded (or being removed): readable, not continuable
    }
    const record = this.worktrees ? this.worktrees.forChat(provider, resume, workspace) : null; // a chat that has a worktree keeps it
    if (record) workspace = realpath(await this.worktrees!.ensure(record)); // made again from its branch if deleted
    if (!isdir(workspace)) throw new ValueError('Choose an existing workspace folder');
    if (!agentRegistry.isProvider(provider)) throw new ValueError('Choose an agent');
    const [command, env] = await this.agentLaunch(provider, !resume);
    for (const connection of this.connections.values()) {
      if (resume && connection.provider === provider && connection.sessionId === resume && !connection.closed) {
        if (!connection.ready) throw new OwnershipConflict('This conversation is already opening in AIB. Wait for it to finish.');
        return connection;
      }
    }
    let plan: wt.Plan | null = null;
    if (resume === null && this.worktrees && this.settings.worktreePerChat()) {
      plan = await this.worktrees.plan(workspace); // null: this project works in place (the reason is logged)
    }
    const lease = resume ? await new SessionLease(this.stateDir, provider, resume).acquire() : null;
    let connection: Connection | null = null;
    try {
      if (resume) {
        const owner = await this.ownerProbe(provider, resume, [Deno.pid]);
        if (owner !== null && owner !== undefined) {
          throw new OwnershipConflict(
            `This ${provider} conversation is already open in another agent process (PID ${owner}). Stop it in its current client before continuing here.`,
          );
        }
        this.checkOwnership(provider, resume, workspace, continueAnyway);
      }
      const connectionOptions: ConnectionOptions = {};
      if (Object.keys(env).length) connectionOptions.env = env;
      if (this.keeper && this.keeperForNew && await this.#keeperUsable()) connectionOptions.keeper = this.keeper;
      if (plan) connectionOptions.start = false; // the agent starts in finishSetup, once its worktree exists
      connection = Object.keys(connectionOptions).length
        ? this.connectionFactory(command, plan ? plan.path : workspace, provider, connectionOptions)
        : this.connectionFactory(command, plan ? plan.path : workspace, provider);
      const c = connection;
      if (plan || record) {
        c.worktree = plan ? { branch: plan.branch, base: plan.base } : { branch: String(record!.branch), base: String(record!.base ?? '') };
        c.projectRoot = plan ? workspace : String(record!.project); // cwd is the worktree, projectRoot the project
      }
      this.#wire(c);
      c.sessionLease = lease;
      const forwarder = c.keeper ? await this.#mcpForwarder() : null;
      c.mcpServers = [...(this.options.mcpServers ?? []), ...this.artifactMcpServers(c.id, !!c.worktree, forwarder)];
      c.sessionId = resume || null;
      if (!resume && options.picks) c.startPicks = { ...options.picks };
      c.recovery = this.recovery as never;
      this.connections.set(c.id, c);
      if (resume) this.announce(c, 'opening'); // claim before session/load so other clients can see it
      const finishSetup = async () => {
        try {
          if (plan) await this.#makeWorktree(c, plan, workspace);
          await c.setup(resume || null);
          if (plan && this.worktrees!.registry.get(plan.key)) await this.worktrees!.setSession(plan.key, provider, c.sessionId!);
          if (!lease) {
            const newLease = await new SessionLease(this.stateDir, provider, c.sessionId!).acquire();
            if (c.closed) {
              newLease.release();
              throw new Error('The agent disconnected while opening the conversation');
            }
            c.sessionLease = newLease;
          }
          if (c.closed) throw new Error('The agent disconnected while opening the conversation');
          this.rememberOptions(c);
          if (this.recovery) this.recovery.connectionReady(c);
          this.announce(c, 'ready');
          if (this.liveSync) {
            try {
              await this.liveSync.chatOpened(c); // watch its project, catch it up on the user's saved edits
            } catch (error) {
              log.exception(error, 'Starting live sync failed');
            }
          }
        } catch (error) {
          log.exception(error, 'Opening the conversation failed');
          c.error = errorText(error);
          await c.close();
          if (plan && !c.sessionId) await this.worktrees!.discard(plan.key).catch(() => {}); // the chat never began
          if (c.sessionLease === null && lease) lease.release();
          if (!background) throw error;
        } finally {
          c.openDone.set();
        }
      };
      if (background) {
        void finishSetup().catch(() => {});
        return c;
      }
      await finishSetup();
    } catch (error) {
      log.exception(error, 'Connecting to the agent failed');
      if (connection) {
        connection.error = errorText(error);
        await connection.close();
      } else if (lease) {
        lease.release();
      }
      throw error;
    }
    return connection!;
  }

  /** The Studio's hooks on one connection (turn start and end, live sync, release) and its client capabilities. */
  #wire(c: Connection): void {
    c.onRelease = (conn) => {
      this.withdraw(conn);
      if (conn.channel) this.#keeperNoLongerNeeded();
    };
    c.onTurnEnd = (conn) => this.turnEnded(conn);
    if (this.liveSync) {
      const sync = this.liveSync;
      c.onTurnStart = (conn) => sync.turnStarted(conn);
      c.contextForPrompt = (conn) => sync.contextFor(conn);
      c.contextSent = (conn, token) => sync.contextSent(conn, token);
    }
    const caps = c.caps as { configure?: (terminal: boolean, fs: 'read' | 'readwrite' | null) => void };
    caps.configure?.(!!this.options.enableClientTerminal, this.options.enableClientFs ?? null);
  }

  // ---- the keeper: chats that outlive this process -------------------------------------------------------------------------
  /**
   * Without the keeper for new chats (a fallback), the keeper only holds chats from before (keeperForNew false): once the last of them has ended, let go of the
   * keeper connection, so the keeper exits by itself (no live channel, no client) instead of staying for as long as AIB runs.
   */
  #keeperNoLongerNeeded(): void {
    if (!this.keeper || this.keeperForNew || this.#closed) return;
    if ([...this.connections.values()].some((c) => !c.closed && c.channel && !c.channel.lost)) return;
    announce('studio', 'keeper: the last chat the keeper held from before has ended; letting the keeper go');
    this.keeper.disconnect();
  }

  /**
   * At start (before the automatic reconnect): every chat whose agent still runs in the keeper is rebuilt from the keeper's record
   * and goes on live, its turn, question and queue included. Nothing is sent again. Returns how many chats were taken over.
   * Ended channels older than a week are removed; a live channel without a chat note (an AIB that crashed while starting it)
   * is stopped.
   */
  adoptKeeper(): Promise<number> {
    this.#adopting ??= this.#adoptKeeper().catch((error) => {
      log.exception(error, 'keeper: taking chats over failed');
      return 0;
    }).finally(() => (this.#adoptDone = true));
    return this.#adopting;
  }

  #adoptDone = false;

  /** The take-over from the keeper while it runs (liveState waits for it: an open page keeps its chat meanwhile). */
  #adopting: Promise<number> | null = null;

  async #adoptKeeper(): Promise<number> {
    const keeper = this.keeper;
    if (!keeper) return 0;
    let client;
    try {
      client = await keeper.client(false); // only a keeper that already runs: nothing to take over otherwise
    } catch (error) {
      log.warning('keeper: could not reach the keeper: %s', errorText(error));
      return 0;
    }
    if (!client) return 0;
    let adopted = 0;
    for (const info of await client.list()) {
      try {
        if (info.kind !== 'pipe') continue;
        if (!info.live) {
          if (info.ended && Date.now() - info.ended > 7 * 86400_000) await keeper.removeEnded(client, info.channel);
          continue;
        }
        const note = await keeper.firstNote(client, info.channel);
        if (!note || note.t !== 'chat' || !isStr(note.id) || !isStr(note.provider) || !isStr(note.cwd)) {
          announce('studio', 'keeper: stopping channel %s: it has no chat record', info.channel);
          await keeper.stopUnknown(client, info.channel);
          continue;
        }
        if (this.connections.has(note.id)) continue;
        if (await this.#rebuildChat(info, note)) adopted++;
      } catch (error) {
        log.exception(error, 'keeper: taking over channel failed');
      }
    }
    if (adopted) {
      announce('studio', 'keeper: %s chat(s) taken over from the keeper', adopted);
      // Their artifact tool is the keeper's forwarder: it needs this Studio's HTTP endpoint and its published address.
      const forwarded = [...this.connections.values()].some((c) => c.channel && !c.closed && c.mcpServers.some(isForwardEntry));
      if (forwarded && !this.options.noArtifactTool) {
        try {
          this.artifactMcpHttp();
          ownForwardFile(join(this.stateDir, FORWARD_FILE));
        } catch (error) {
          log.exception(error, 'Could not start the HTTP artifact tool for the chats taken over from the keeper');
        }
      }
    }
    return adopted;
  }

  async #rebuildChat(info: ChannelInfo, note: Json): Promise<boolean> {
    const command = Array.isArray(note.command) ? note.command.map(String) : [];
    const cwd = String(note.cwd);
    const provider = String(note.provider);
    const c = this.connectionFactory(command, cwd, provider, { keeper: this.keeper, id: String(note.id), rebuild: info, start: false });
    if (isDict(note.worktree)) c.worktree = { branch: String(note.worktree.branch ?? ''), base: String(note.worktree.base ?? '') };
    c.projectRoot = isStr(note.projectRoot) && note.projectRoot ? note.projectRoot : cwd;
    this.#wire(c);
    c.mcpServers = Array.isArray(note.mcpServers) ? note.mcpServers as McpServer[] : [];
    c.sessionId = isStr(note.resume) && note.resume ? note.resume : null;
    c.recovery = this.recovery as never;
    this.connections.set(c.id, c);
    const label = `${provider} ${c.sessionId ?? ''} in ${cwd}`.replace('  ', ' ');
    try {
      await c.rebuilt;
    } catch { /* read-only (rebuildError says why) or the keeper went away */ }
    try {
      if (c.closed) return false;
      if (c.rebuildError) {
        announce('studio', 'keeper: %s stays read-only: %s', label, c.rebuildError);
        return false;
      }
      if (!c.ready || !c.sessionId) {
        c.error = 'AIB restarted while this chat was opening, so it was stopped. Open it again.';
        await c.close();
        return false;
      }
      try {
        c.sessionLease = await new SessionLease(this.stateDir, provider, c.sessionId).acquire();
      } catch (error) {
        log.warning('keeper: no session lease for %s: %s', label, errorText(error));
      }
      if (this.recovery) {
        this.recovery.connectionReady(c);
        const saved = this.recovery.queues?.get(provider, c.sessionId) ?? [];
        if (saved.length) await c.queueContinue(saved); // the turn never stopped, so neither does its queue
      }
      this.announce(c, 'ready');
      if (this.liveSync) {
        try {
          await this.liveSync.chatOpened(c);
        } catch (error) {
          log.exception(error, 'Starting live sync failed');
        }
      }
      announce('studio', 'keeper: rebuilt %s (%s)', label, c.busy ? 'turn running' : 'idle');
      console.error(`Keeper: continued ${label}`);
      return true;
    } finally {
      c.openDone.set();
    }
  }

  /** The keeper program as the MCP forwarder for a new chat in the keeper (null: not available, the usual entries are used). */
  async #mcpForwarder(): Promise<string | null> {
    if (this.options.noArtifactTool || !this.hasStateDir || !this.keeper) return null;
    try {
      return await forwarderOf(this.keeper.options.binary ?? null, this.stateDir);
    } catch (error) {
      log.warning('keeper: no MCP forwarder (%s); the artifact tool runs as before', errorText(error));
      return null;
    }
  }

  /**
   * Can a new chat run in the keeper? Starts the keeper when none runs and applies its version rules (KeeperLink.check). False when
   * the running keeper is too old for this AIB while it holds other chats, or the keeper cannot be started: the chat then runs as a
   * child of this process, the reason is logged and shown in Settings > About (it is not carried through an update).
   */
  async #keeperUsable(): Promise<boolean> {
    try {
      await this.keeper!.check();
      noteKeeperProblem('');
      return true;
    } catch (error) {
      const why = this.keeper!.problem || errorText(error);
      announce('studio', 'keeper: this chat runs without the keeper: %s', why);
      noteKeeperProblem(why); // Settings > About shows it
      return false;
    }
  }

  /**
   * Can every working chat survive this process exiting for an update (Install now)? Yes when each one runs in a keeper this AIB is
   * connected to: release() then leaves them there and the next version takes them over. Otherwise the reason ('' when yes).
   */
  keeperHandover(): string {
    if (!this.keeper) return 'the keeper is off';
    const working = [...this.connections.values()].filter((c) => !c.closed && (c.busy || !c.ready || c.permissions.size));
    const outside = working.filter((c) => !c.channel || c.channel.lost || !c.channel.client || c.channel.client.closed);
    if (outside.length) return `${outside.length} working chat(s) run outside the keeper`;
    return '';
  }

  /** The keeper went away (its agents ended with it): the chats say "Interrupted" and reconnect with session/load, never resent. */
  #keeperLost(channels: KeeperChannel[]): void {
    const ids = new Set(channels.map((ch) => ch.id));
    const chats = [...this.connections.values()].filter((c) => c.channel && ids.has(c.channel.id) && c.sessionId);
    announce('studio', 'keeper: the keeper stopped; %s chat(s) were interrupted', chats.length);
    if (!this.store || !this.autoReconnect || this.#closed) return;
    for (const c of chats) {
      const item: [string, string, string] = [c.provider, c.sessionId!, c.cwd];
      const key = pairKey(c.provider, c.sessionId);
      if (this.reconnectPending.has(key)) continue;
      this.reconnectPending.add(key);
      this.reconnectWorkers.push((async () => {
        for (let waited = 0; !c.closed && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
        await this.reconnectOne(item, RECONNECT_TRIES, 5);
      })().catch((error) => log.exception(error, 'keeper: reconnecting an interrupted chat failed')));
    }
  }

  /**
   * Make the chat's worktree, then start its agent there. If the project cannot have one after all (too much uncommitted work, LFS
   * pointers, ...) the chat works in the project folder: it has not begun, so nothing is filed under another folder.
   */
  async #makeWorktree(connection: Connection, plan: wt.Plan, project: string): Promise<void> {
    try {
      await this.worktrees!.create(plan);
    } catch (error) {
      if (!(error instanceof wt.Fallback)) throw error;
      connection.retarget(project);
      connection.projectRoot = project;
      connection.worktree = null;
    }
    if (connection.closed) {
      await this.worktrees!.discard(plan.key);
      throw new Error('The chat was closed while it was starting');
    }
    connection.startProcess();
  }

  // ---- live-connection operations (the LiveBackend interface) -------------------------------------------------------------
  get webInstanceId(): string {
    return this.instanceId;
  }

  liveInfo(): Promise<Json> {
    const openIds = [...this.connections.values()].filter((c) => !c.closed).map((c) => c.id);
    return Promise.resolve({
      instanceId: this.instanceId,
      pid: Deno.pid,
      durableRecovery: !!this.store,
      ownerAnnouncements: !!this.owners,
      connections: openIds,
    });
  }

  /**
   * Forget closed connections: any closed longer than CLOSED_GRACE_SECONDS, then the oldest beyond MAX_CLOSED_CONNECTIONS. Until then
   * a closed connection stays so the page can read its `disconnected` state. Dropping it frees its events and images.
   */
  evictClosed(nowSeconds: number | null = null): string[] {
    const now = nowSeconds ?? this.clock();
    const closed = [...this.connections.values()].filter((c) => c.closed && c.closedAt !== null).sort((a, b) => a.closedAt! - b.closedAt!);
    const drop = closed.filter((c) => now - c.closedAt! > CLOSED_GRACE_SECONDS);
    const keep = closed.filter((c) => !drop.includes(c));
    drop.push(...keep.slice(0, Math.max(0, keep.length - MAX_CLOSED_CONNECTIONS)));
    for (const c of drop) this.connections.delete(c.id);
    for (const c of drop) {
      try {
        c.tree?.kill();
      } catch (error) {
        log.exception(error, 'Closing a dropped connection failed');
      }
      c.events.length = 0;
      c.eventImageBytes = 0;
    }
    return drop.map((c) => c.id);
  }

  liveListSync(): Json {
    this.evictClosed();
    const listed: Json[] = [];
    for (const c of [...this.connections.values()]) {
      const item = c.public(0, true);
      delete item.events;
      delete item.permissions;
      item.reconnecting = this.reconnectPending.has(pairKey(c.provider, c.sessionId)) && !c.closed;
      listed.push(item);
    }
    return {
      connections: listed,
      autoReconnect: !!(this.store && this.autoReconnect),
      recovered: this.recovered(),
      recoveryWarning: this.store ? this.store.warning : '',
      instanceId: this.instanceId,
    };
  }

  liveList(): Promise<Json> {
    return Promise.resolve(this.liveListSync());
  }

  /** Resolves when the take-over from the keeper has finished (at most 20 s); later calls resolve at once. */
  async #afterAdopting(): Promise<void> {
    const adopting = this.#adopting;
    if (!adopting) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([adopting.catch(() => 0), new Promise((resolve) => (timer = setTimeout(resolve, 20_000)))]);
    clearTimeout(timer);
  }

  liveState(connectionId: unknown, after: unknown = 0, wait = true): Promise<Json | null> {
    const connection = isStr(connectionId) ? this.connections.get(connectionId) : undefined;
    if (connection === undefined) {
      // Taking chats over from the keeper right now: the page's chat may be one of them. Wait for it (bounded) instead of telling
      // the page the connection is gone, so it keeps the chat without reloading its list.
      if (wait && this.#adopting && !this.#adoptDone && isStr(connectionId)) {
        return this.#afterAdopting().then(() => this.liveState(connectionId, after, false));
      }
      return Promise.resolve(null);
    }
    const cursor = Math.trunc(Number(after));
    if (Number.isNaN(cursor)) return Promise.reject(new ValueError(`invalid literal for int() with base 10: ${pyRepr(after)}`));
    return Promise.resolve(connection.public(cursor));
  }

  /** Artifact created / new version: push {"type":"artifact",...} to the page as a normal conversation event (kind 'artifact'). */
  emitArtifact(conversationId: unknown, data: unknown): Promise<boolean> {
    const connection = isStr(conversationId) ? this.connections.get(conversationId) : undefined;
    if (connection === undefined) return Promise.resolve(false);
    connection.recordedEvent('artifact', data); // in the keeper's record too: a rebuild shows it and numbers events the same
    return Promise.resolve(true);
  }

  /** {connection id: [file paths that connection's agent wrote]} for open connections (the artifact watcher's only source). */
  liveWrites(): Promise<Record<string, string[]>> {
    const open = [...this.connections.values()].filter((c) => !c.closed);
    return Promise.resolve(Object.fromEntries(open.map((c) => [c.id, c.writes.written()])));
  }

  /** Open connections that must not be cut off: working, still opening, or waiting for a person. */
  busyList(): Json[] {
    const busy: Json[] = [];
    for (const c of [...this.connections.values()]) {
      const state = c.attention().state;
      if (state === 'working' || state === 'opening' || state === 'needs_you') {
        busy.push({ id: c.id, provider: c.provider, cwd: c.cwd, state });
      }
    }
    return busy;
  }

  /**
   * Everything that keeps an app's agent host alive with no app attached (docs/agent-host.md "Lifecycle"): busyList (a turn running,
   * an agent opening, a chat waiting for the person) plus chats with queued prompts and running agent install or sign-in jobs. A chat
   * that is open but idle is not in it.
   */
  workingList(): Json[] {
    const working = this.busyList();
    const listed = new Set(working.map((w) => w.id));
    for (const c of [...this.connections.values()]) {
      if (!c.closed && !listed.has(c.id) && c.queue.items.length) working.push({ id: c.id, provider: c.provider, cwd: c.cwd, state: 'queued' });
    }
    for (const [agent, job] of this.installer?.jobs ?? []) if (job.alive) working.push({ id: `install:${agent}`, provider: agent, cwd: '', state: 'installing' });
    for (const [agent, job] of this.signer?.jobs ?? []) if (job.alive) working.push({ id: `signin:${agent}`, provider: agent, cwd: '', state: 'needs_you' });
    return working;
  }

  busyConnections(): Promise<Json[]> {
    return Promise.resolve(this.busyList());
  }

  studioOwns(provider: unknown, sessionId: unknown): Promise<boolean> {
    return Promise.resolve(this.#studioOwns(provider as string, sessionId as string));
  }

  ownershipQuery(provider = '', sessionId = '', cwd = ''): Promise<unknown> {
    try {
      if (!provider && !sessionId) {
        this.probe.refreshProcessesAsync();
        return Promise.resolve({ hints: this.probe.hints(), certainty: this.probe.listCertainty() });
      }
      if (!agentRegistry.isProvider(provider) || !sessionId || pyLen(sessionId) > 512) {
        throw new ValueError('Choose a provider and a saved session ID');
      }
      if (isNetworkPath(cwd)) throw new ValueError('Network and device paths are not supported');
      return Promise.resolve(this.probe.assess(provider, sessionId, { cwd: cwd || null, fresh: true }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  // ---- worktree removal (Discard, archive, delete) ------------------------------------------------------------------------
  #worktreeRecord(path: string | null = null, session: string | null = null) {
    return this.worktrees ? this.worktrees.registry.find(path, session) : null;
  }

  #connectionsIn(path: string): Connection[] {
    return [...this.connections.values()].filter((c) => !c.closed && wt.same(c.cwd, path));
  }

  #connection(body: Json): Connection {
    const id = need(body, 'id');
    if (id !== null && typeof id === 'object') throw new TypeError(`unhashable type: '${Array.isArray(id) ? 'list' : 'dict'}'`);
    const connection = isStr(id) ? this.connections.get(id) : undefined;
    if (connection === undefined) throw new KeyError(id);
    return connection;
  }

  /**
   * Discard: stop the chat's agent (its process tree and client terminals), then remove its worktree and branch. Needs
   * body.confirm === true, the page's one confirmation; without it nothing happens. The only place --force is used.
   */
  async worktreeDiscard(body: Json): Promise<Json> {
    if (body.confirm !== true) throw new ValueError('Discarding needs the confirmation first; nothing was removed');
    const connection = this.#connection(body);
    const record = this.#worktreeRecord(connection.cwd);
    if (!record) throw new ValueError('This chat has no worktree of its own');
    await connection.close(); // closes the connection, kills the agent's process tree and any client terminals
    connection.tree?.kill();
    const outcome = await this.worktrees!.remove(record.key, true);
    return { ok: true, result: outcome, branch: record.branch ?? '', removed: outcome === 'removed', pending: outcome === 'pending' };
  }

  /**
   * Archive or delete of a chat that may have a worktree. Without changes against its diff base (and no live agent in it) the
   * worktree and branch are removed silently, without --force. With changes it is kept and the page says so.
   */
  async worktreeArchive(body: Json): Promise<Json> {
    const { provider, sessionId } = body;
    const session = isStr(provider) && isStr(sessionId) && sessionId ? `${provider}:${sessionId}` : null;
    const path = isStr(body.cwd) && body.cwd ? body.cwd : null;
    const record = this.#worktreeRecord(path, session);
    if (!record) return { ok: true, worktree: null };
    const branch = record.branch ?? '';
    if (this.#connectionsIn(String(record.path)).length) return { ok: true, worktree: { branch, removed: false, live: true } };
    if (await this.worktrees!.hasChanges(record)) return { ok: true, worktree: { branch, removed: false, keptChanges: true } };
    const outcome = await this.worktrees!.remove(record.key, false);
    return { ok: true, worktree: { branch, removed: outcome === 'removed', pending: outcome === 'pending' } };
  }

  // ---- install and sign-in jobs -------------------------------------------------------------------------------------------
  /**
   * The agent install job: action 'status', 'start' or 'cancel' for one built-in agent. Returns [HTTP status, payload]; never throws
   * for request errors. The job lives in this process, which is the agent host when there is one (it outlives the web server).
   */
  async installCall(action: string, agentId: unknown): Promise<[number, unknown]> {
    this.installer ??= new Installer(this.stateDir, { nodeCommand: this.options.nodeCommand || '' });
    try {
      if (action === 'start') return [200, { ...(await this.installer.start(agentId)), ok: true }];
      if (action === 'cancel') return [200, { ...(await this.installer.cancel(agentId)), ok: true }];
      if (action === 'status') return [200, { ...(await this.installer.status(agentId)), ok: true }];
      if (action === 'uninstall' || action === 'uninstall-check') { // Deno only: refused while a chat with the agent is open here or its sign-in runs
        const open = [...this.connections.values()].filter((c) => c.provider === agentId && !c.closed).length;
        const signing = typeof agentId === 'string' && !!this.signer?.jobs.get(agentId)?.alive;
        return [200, { ...(await this.installer.uninstall(agentId, open, signing, action === 'uninstall-check')), ok: true }];
      }
      return [404, { error: 'Not found' }];
    } catch (error) {
      if (error instanceof InstallRefused) return [409, { error: error.message, code: error.code }];
      if (isRequestError(error)) return [400, { error: error.message }];
      throw error;
    }
  }

  /**
   * The sign-in check and Sign in job: action 'status', 'check', 'start' or 'cancel' for one built-in agent; 'check' with an empty
   * agent id checks every built-in agent Studio can ask. Returns [HTTP status, payload]; never throws for request errors.
   */
  async signinCall(action: string, agentId: unknown, force: unknown = false): Promise<[number, unknown]> {
    this.signer ??= new Signer(this.stateDir, (agent) => builtinLaunch(this.#agentOptions(), this.settings, agent));
    this.betaSigner ??= new BetaSigner(
      this.stateDir,
      (agent) => resolveBeta(agent, { stateDir: this.hasStateDir ? this.stateDir : null, nodeCommand: this.options.nodeCommand || '' }),
      (agent) => this.betaEnv(agent),
    );
    try {
      if (action === 'check' && !agentId) {
        const agents: Json = {};
        for (const a of Object.keys(adapters.STUDIO_PACKAGES)) agents[a] = await this.signer.check(a, !!force);
        // Beta agents: only the turned-on ones are asked (a check starts the agent once, hidden)
        for (const a of agentRegistry.BETA_IDS) if (this.settings.betaEnabled(a)) agents[a] = await this.betaSigner.check(a, !!force);
        return [200, { ok: true, agents }];
      }
      if (isBeta(agentId)) return await this.#betaSigninCall(action, agentId as string, force);
      if (action === 'check') return [200, { ...(await this.signer.check(agentId, !!force)), ok: true }];
      if (action === 'start') return [200, { ...(await this.signer.start(agentId)), ok: true }];
      if (action === 'cancel') return [200, { ...(await this.signer.cancel(agentId)), ok: true }];
      if (action === 'status') return [200, { ...this.signer.status(agentId), ok: true }];
      return [404, { error: 'Not found' }];
    } catch (error) {
      if (error instanceof SignInRefused) return [409, { error: error.message, code: error.code }];
      if (isRequestError(error)) return [400, { error: error.message }];
      throw error;
    }
  }

  /** A Beta agent's sign-in calls (beta_signin.ts): 'check', 'start', 'cancel', 'status'. */
  async #betaSigninCall(action: string, agentId: string, force: unknown): Promise<[number, unknown]> {
    const signer = this.betaSigner!;
    if (action === 'check') return [200, { ...(await signer.check(agentId, !!force)), ok: true }];
    if (action === 'start') return [200, { ...(await signer.start(agentId)), ok: true }];
    if (action === 'cancel') return [200, { ...(await signer.cancel(agentId)), ok: true }];
    if (action === 'status') return [200, { ...signer.status(agentId), ok: true }];
    return [404, { error: 'Not found' }];
  }

  // ---- POST /api/live/<name> ----------------------------------------------------------------------------------------------
  /** One POST /api/live/<name> request. Returns [HTTP status, JSON payload]; never throws for request errors. */
  async liveCall(name: string, body: unknown): Promise<[number, unknown]> {
    try {
      return await this.#liveCall(name, body);
    } catch (error) {
      if (error instanceof OwnershipConflict) {
        const verdict = (error as { verdict?: unknown }).verdict;
        return [409, {
          error: error.message,
          code: (error as { code?: string }).code ?? 'session_in_use',
          ...(verdict ? { ownership: verdict } : {}),
        }];
      }
      if (error instanceof PromptStateUnknown) return [409, { error: error.message, code: 'prompt_state_unknown' }];
      if (isRequestError(error)) return [400, { error: error.message }];
      throw error;
    }
  }

  async #liveCall(name: string, body: unknown): Promise<[number, unknown]> {
    if (!isDict(body)) throw new ValueError('Invalid request');
    if (name === 'connect') {
      const background = body.background ?? false;
      if (typeof background !== 'boolean') throw new ValueError('background must be a boolean');
      const continueAnyway = body.continueAnyway ?? false;
      if (typeof continueAnyway !== 'boolean') throw new ValueError('continueAnyway must be a boolean');
      const provider = need(body, 'provider');
      const cwd = need(body, 'cwd');
      const connection = await this.connect(provider as string, cwd as string, (body.resume ?? null) as string | null, {
        background,
        continueAnyway,
        picks: readPicks(body.picks),
      });
      return [200, connection.public()];
    }
    if (name === 'agent-options') return [200, await this.agentOptionsFor(body)]; // POST /api/live/agent-options (web/live_routes.ts)
    if (name === 'discover') return [200, await this.listAgentSessions(need(body, 'provider'), body.cwd ?? null, body.cursor ?? null)];
    if (name === 'forget') return [200, { ok: true, forgotten: this.forgetRecovered(body.provider, body.sessionId) }];
    if (name === 'worktree-note') { // internal (worktrees/merge.ts): not in LIVE_POST_OPS, so no page route reaches it
      const connection = this.#connection(body);
      const data: Json = { message: [...String(need(body, 'message'))].slice(0, 300).join(''), sessionId: connection.sessionId };
      const actions = (Array.isArray(body.actions) ? body.actions : [])
        .filter((a) => isDict(a) && (a.id === 'keep-mine' || a.id === 'leave')) // buttons in the note: only Studio's own two
        .map((a) => ({ id: (a as Json).id, label: [...String((a as Json).label || (a as Json).id)].slice(0, 40).join('') }));
      if (actions.length) data.actions = actions;
      connection.recordedEvent('studio_note', data);
      return [200, { ok: true }];
    }
    if (!LIVE_POST_OPS.has(name)) return [404, { error: 'Not found' }];
    if (name === 'worktree-discard') return [200, await this.worktreeDiscard(body)];
    if (name === 'worktree-archive') return [200, await this.worktreeArchive(body)];
    if (name === 'dismiss-unknown') {
      let { provider, sessionId } = body;
      const messageId = body.clientMessageId;
      if (isStr(body.id) && this.connections.has(body.id)) {
        const connection = this.connections.get(body.id)!;
        provider = connection.provider;
        sessionId = connection.sessionId;
      }
      if (!(this.store && isStr(provider) && isStr(sessionId) && isStr(messageId))) {
        throw new ValueError('provider, sessionId and clientMessageId are required');
      }
      return [200, { ok: true, dismissed: this.store.dismissReceipt(provider, sessionId, messageId) }];
    }
    const connection = this.#connection(body);
    const text = body.text ?? '';
    const messageId = (body.clientMessageId ?? null) as string | null;
    const attachments = body.attachments ?? null;
    if (name === 'prompt') {
      const result = await connection.prompt(text, messageId, attachments);
      if (connection.provider && connection.sessionId && !result.duplicate) await this.#mark('handled', connection); // replying is acting
      return [200, { ok: true, ...result }];
    }
    if (name === 'queue') {
      const result = await connection.queueAdd(text, messageId, attachments);
      if (connection.provider && connection.sessionId && !result.duplicate) await this.#mark('handled', connection); // queueing is acting
      return [200, { ok: true, ...result }];
    }
    if (name === 'queue-edit') {
      return [
        200,
        await connection.queueEdit(
          need(body, 'messageId') as string,
          need(body, 'action'),
          (body.leaseId ?? null) as string | null,
          body.text ?? null,
        ),
      ];
    }
    if (name === 'queue-remove') return [200, await connection.queueRemove(need(body, 'messageId') as string)];
    if (name === 'queue-move') return [200, await connection.queueMove(need(body, 'messageId') as string, need(body, 'to'))];
    if (name === 'queue-resume') return [200, await connection.queueResume()];
    if (name === 'queue-send-now') return [200, await connection.queueSendNow(need(body, 'messageId') as string)];
    if (name === 'cancel') connection.cancel(body.subagentSessionId ?? null);
    else if (name === 'permission') connection.permission(need(body, 'key'), body.option ?? null);
    else if (name === 'authenticate') connection.answerAuth(need(body, 'action'), body.methodId ?? null);
    else if (name === 'elicitation') connection.answerElicitation(need(body, 'key'), need(body, 'action'), body.content ?? null);
    else if (name === 'config') {
      const result = await connection.changeSetting('config', need(body, 'configId'), need(body, 'value')); // queued during a turn
      this.rememberOptions(connection);
      return [200, { ok: true, ...result }];
    } else if (name === 'mode') {
      const result = await connection.changeSetting('mode', null, need(body, 'modeId'));
      this.rememberOptions(connection);
      return [200, { ok: true, ...result }];
    }
    else if (name === 'cancel-pending') return [200, { ok: true, pendingChanges: connection.cancelPending(need(body, 'key')) }];
    else if (name === 'session-op') {
      const deletedRef = body.op === 'delete' ? [connection.provider, connection.sessionId] : null;
      const result = await sessionOp(connection as never, body);
      const payload: Json = { ok: true, ...result };
      if (deletedRef && result.done === 'delete') payload._deleted = deletedRef; // the web layer owns conversation marks and removes this key
      return [200, payload];
    } else if (name === 'disconnect') await connection.close();
    return [200, { ok: true }];
  }

  /**
   * Set when the person chose to stop the working chats (the app's "stop them and quit", the tray's Stop chats and quit, a forced
   * stop). close() then records a message the agent already had as delivered, so the next start shows no "restarted while this was
   * being sent" warning for a turn that was stopped on purpose.
   */
  deliberateStop = false;

  /**
   * Exit for an update (or a restart) without touching the chats that run in the keeper: they keep running and recording, and the
   * next AIB rebuilds them from the keeper's record (adoptKeeper) and claims them. Everything else is stopped as in close(): chats
   * outside the keeper are closed, live sync and timers stop. Their session leases are released, the recovery list keeps them, and
   * no receipt is marked "unknown" (the turns go on). Returns how many chats were left running in the keeper.
   */
  async release(): Promise<number> {
    if (this.#closed) return 0;
    this.#closed = true;
    if (this.liveSync) await this.liveSync.stopAll().catch((error) => log.exception(error, 'Stopping live sync failed'));
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.reconnectStop.set();
    if (this.recovery) this.recovery.shuttingDown = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(this.reconnectWorkers.map((w) => w.catch(() => {}))),
      new Promise((resolve) => (timer = setTimeout(resolve, 10_000))),
    ]);
    clearTimeout(timer);
    const kept: Connection[] = [];
    const others: Connection[] = [];
    for (const c of this.connections.values()) {
      if (c.closed) continue;
      (c.channel && !c.channel.lost && c.channel.client && !c.channel.client.closed ? kept : others).push(c);
    }
    await Promise.all(others.map((c) => c.close().catch((error) => log.exception(error, 'Closing a connection failed'))));
    for (const c of kept) c.releaseLease(); // the next AIB takes the lease when it takes the chat
    if (this.owners) this.owners.withdrawAll();
    if (this.#mcpHttp) await this.#mcpHttp.close();
    this.keeper?.disconnect(); // the keeper keeps the agents; whoever connects next (the update helper, then the new AIB) is its client
    announce('studio', 'released %s chat(s) to the keeper; %s closed', kept.length, others.length);
    return kept.length;
  }

  /** Stop everything this Studio runs. The recovery list is kept (orderly shutdown), so the next start can reconnect. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.deliberateStop && this.store) {
      for (const c of this.connections.values()) {
        if (!c.sessionId) continue;
        for (const [id, r] of c.promptReceipts) {
          if (r.state === 'working' && r.sent) this.store.setReceipt(c.provider, c.sessionId, id, r.fingerprint, 'finished');
        }
      }
    }
    if (this.liveSync) await this.liveSync.stopAll().catch((error) => log.exception(error, 'Stopping live sync failed'));
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    this.reconnectStop.set();
    if (this.recovery) this.recovery.shuttingDown = true;
    // A reconnect that is opening right now finishes (or fails) first, so its connection is closed below too. Bounded: an agent
    // that hangs in setup must not keep the host from stopping.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(this.reconnectWorkers.map((w) => w.catch(() => {}))),
      new Promise((resolve) => (timer = setTimeout(resolve, 10_000))),
    ]);
    clearTimeout(timer);
    await Promise.all(
      [...this.connections.values()].map((c) => c.close().catch((error) => log.exception(error, 'Closing a connection failed'))),
    );
    if (this.owners) this.owners.withdrawAll();
    if (this.store) this.store.markWorkingUnknown();
    if (this.#mcpHttp) await this.#mcpHttp.close();
    this.keeper?.disconnect(); // with no client and no live channel the keeper exits by itself
  }
}

/** A `<keeper program> mcp-forward <file>` entry (design 3.7). */
function isForwardEntry(entry: unknown): boolean {
  const args = isDict(entry) && Array.isArray(entry.args) ? entry.args : [];
  return args[0] === 'mcp-forward';
}

const INSTANCE_FILE = 'studio-instance-keeper.json';

/**
 * The instance id of a Studio whose chats run in the keeper: the id the previous Studio of this data folder used, when the keeper it
 * was connected to still runs (same pid and start time), since every chat it had is rebuilt under the same connection id; a new id
 * otherwise (no keeper, or another one: no old connection id can be valid). Never throws.
 */
export function keeperInstanceId(stateDir: string): string {
  try {
    const saved = JSON.parse(Deno.readTextFileSync(join(stateDir, INSTANCE_FILE)));
    const info = readKeeperInfo(stateDir);
    if (info && pidAlive(info.pid) && isStr(saved.id) && saved.keeperPid === info.pid && saved.keeperStarted === info.started) {
      return saved.id;
    }
  } catch { /* none yet */ }
  return crypto.randomUUID().replaceAll('-', '');
}

/** Remember which keeper this instance id belongs to (on every connection to a keeper). Never throws. */
export function saveKeeperInstance(stateDir: string, id: string): void {
  try {
    const info = readKeeperInfo(stateDir);
    if (!info) return;
    Deno.writeTextFileSync(join(stateDir, INSTANCE_FILE), JSON.stringify({ id, keeperPid: info.pid, keeperStarted: info.started }));
  } catch { /* not fatal: the next start shows "restarted" once */ }
}

/**
 * How the keeper starts AIB again when no AIB is attached (keeper rule V1): this very process's command line. The desktop app adds
 * --start-in-tray, so AIB coming back after a crash shows only its tray icon, never a window over the person's work.
 */
export function orphanCommand(args: string[] = Deno.args, desktop = isDesktopApp()): OrphanCommand {
  const self = selfCommand();
  const windowed = desktop && !['serve', 'host', 'deploy', 'mcp-artifact', 'update-helper'].includes(args[0]);
  const extra = windowed && !args.includes('--start-in-tray') ? ['--start-in-tray'] : [];
  return { command: self[0], args: [...self.slice(1), ...args, ...extra], cwd: Deno.cwd() };
}

/** secrets.token_urlsafe(32). */
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** True for a pair key's provider/session (exported for tests that look at reconnectPending). */
export function reconnectKey(provider: string, sessionId: string): string {
  return pairKey(provider, sessionId);
}
