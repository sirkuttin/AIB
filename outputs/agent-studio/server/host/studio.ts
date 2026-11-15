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
import { AddedProjects } from '../desktop/added_projects.ts';
import { Connection, type ConnectionOptions, errorText, historyV2, NotStoppable, ThreadEvent } from '../acp/connection.ts';
import { HistoryClient } from '../history/client.ts';
import { sessionOp } from '../acp/breadth.ts';
import type { McpServer } from '../acp/breadth.ts';
import { PromptStateUnknown } from '../acp/rpc_errors.ts';
import { fullEvent, page, type PageQuery, pageQuery } from '../acp/event_pages.ts';
import { QueueStore } from '../acp/msgqueue.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import * as adapters from '../agents/adapters.ts';
import { Installer, InstallRefused } from '../agents/installer.ts';
import { readCached as readSignIn, Signer, SignInRefused } from '../agents/signin.ts';
import { betaAgent, isBeta } from '../agents/beta_catalog.ts';
import { resolveBeta } from '../agents/beta_agents.ts';
import { BetaSigner } from '../agents/beta_signin.ts';
import { AgentOptionsCache } from '../state/agent_options.ts';
import { UsageLimitsStore } from '../state/usage_limits.ts';
import { LimitsFeed, REFRESH_SECONDS } from './usage_limits_feed.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { artifactToolCommand } from '../artifacts/mcp.ts';
import { ArtifactMcpHttp, FORWARD_FILE, forwardEntry, httpEntry, ownForwardFile, ownTunnelEntry, tunnelEntry } from '../artifacts/mcp_http.ts';
import { WSL_TOOL_GROUPS } from '../artifacts/mcp.ts';
import { mcpTunnelGate, type TunnelAnswer } from '../wsl/mcp_tunnel.ts';
import { forwarderOf, keeperBinary, programVersion } from '../keeper/client.ts';
import { isCompiled, isDesktopApp, selfCommand, TESTS_DIR } from '../core/app.ts';
import { type ChannelInfo, type KeeperClient, KeeperError, missingFeatures, type OrphanCommand, readKeeperInfo } from '../keeper/client.ts';
import { pidAlive } from './host_client.ts';
import {
  type KeeperChannel,
  KeeperLink,
  keeperSetting,
  keeperWanted,
  noteKeeperProblem,
  noteKeeperTakeoverProblem,
} from '../keeper/link.ts';
import { CLIENT_TERMINAL_PREFIX } from '../acp/keeper_terminal.ts';
import { announce, getLogger, registerSecret } from '../core/log.ts';
import { PhaseTimer, rebuildPhases } from '../core/timing.ts';
import { isDict, isStr, pyLen, pyRepr, ValueError } from '../core/py.ts';
import { findExternalOwner, OwnershipConflict, probeExternalOwner, SessionLease } from '../ownership/ownership.ts';
import { ACTIVE_WINDOW_SECONDS, type Assessment, HEARTBEAT_SECONDS, OwnerRegistry, OwnershipEvidence, OwnershipProbe } from '../ownership/probe.ts';
import { mergeAssessment, wslOwnerCheck, wslOwnerHints, wslOwnPids } from '../wsl/ownership.ts';
import { expandUser } from '../platform/pypath.ts';
import { home, isdir, join, realpath } from '../platform/ospath.ts';
import { Recovery, StateStore } from '../state/recovery.ts';
import { ConversationState, ProjectPrefs, ReadState, SettingsStore } from '../state/store.ts';
import { builtinLaunch } from '../web/shared.ts';
import { isNetworkPath } from '../web/security.ts';
import { isForeignPath } from '../platform/location.ts';
import * as wt from '../worktrees/worktrees.ts';
import { LiveSync, Mutex } from '../worktrees/sync.ts';
import { DEFAULT_ENTRY, ensureDefault, type LocalOnly } from '../worktrees/local_only.ts';
import { helperOf, readHelpers } from '../swarm/registry.ts';
import { defaultsAllowed } from '../worktrees/local_strays.ts';
import type { WslSpawn } from '../acp/connection.ts';
import { refOf } from '../platform/location.ts';
import { heldDistro, isAibInternalLabel } from '../keeper/link.ts';
import {
  distroName,
  hostWhenReady,
  linkOf,
  readyHost,
  windowsPathInWsl,
  WSL_TOOLS_NOTICE,
  wslHost,
  wslToolsNotice,
  wslLoc,
} from '../wsl/access.ts';
import { urlGate } from '../wsl/open_urls.ts';
import {
  isWslRecord,
  wslCreate,
  wslDiscard,
  wslEnsure,
  wslHasChanges,
  wslIsRemoved,
  WslPlan,
  wslPlanWithReason,
  wslRecord,
  wslRemove,
  wslSetSession,
} from '../wsl/worktrees.ts';
import { configureWslHosts, wslHostsInUse } from '../wsl/hosts.ts';
import { WslSync, wslSyncChat } from '../wsl/sync.ts';
import { blockedCount } from '../attention/inbox_rules.ts';
import { AllowGate } from '../allow/gate.ts';

const log = getLogger('studio');

type Json = Record<string, unknown>;

export const ARTIFACT_URL_FILE = 'artifact-web.json'; // the web server writes its URL here so agents find it after a restart
export const CLOSED_GRACE_SECONDS = 10 * 60; // a closed connection stays listed this long so the page can still show "disconnected"
export const MAX_CLOSED_CONNECTIONS = 20; // ...and never more than this many closed ones are kept (oldest go first)
export const RECONNECT_TRIES = 3;
/** The longest a page's request for a chat waits while chats are taken over from the keeper (chat.js GET_TIMEOUT_MS is longer). */
export const ADOPT_WAIT_MS = 20_000;

/** Swarm lines in a main chat (studio_note kinds) and the buttons they may carry (swarm/service.ts). */
const SWARM_NOTE_KINDS = ['swarm-start', 'swarm-report', 'swarm-merge', 'swarm-undo', 'swarm-stop', 'swarm-fail'];
const SWARM_NOTE_ACTIONS = ['swarm-undo', 'swarm-merge-again', 'swarm-open'];
const SWARM_ACTION_LABELS: Record<string, string> = { 'swarm-undo': 'Undo', 'swarm-merge-again': 'Merge again', 'swarm-open': 'Open chat' };

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
  'steer',
  'tool-stop',
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

/** The line a WSL chat gets when its agent is turned off for its distro in Settings > AIB Linking (WSL). */
export function wslAgentOffLine(provider: string, distroLabel: string, settings: { customAgent(id: string): { name: string } | null }): string {
  const label = agentRegistry.isCustom(provider) ? settings.customAgent(provider)?.name ?? provider : agentRegistry.agentName(provider);
  return `${label} is turned off for ${distroLabel} in Settings > AIB Linking (WSL)`;
}

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
  /** Swarm: this new chat is a helper of that main chat (swarm/service.ts). Its role is decided here, before its tools are (review break 1). */
  helperOf?: { helperId: string; parent: string } | null;
  /** The automatic reconnect at start (reconnectOne), not the person's Continue: a WSL agent turned off for its distro is not refused then. */
  auto?: boolean;
}

/** Swarm: body.helperOf of a connect request ({helperId, parent}), else null. */
export function readHelperOf(value: unknown): ConnectOptions['helperOf'] {
  if (value === undefined || value === null) return null;
  if (!isDict(value) || !isStr(value.helperId) || !/^h_[0-9a-f]{8}$/.test(value.helperId) || !isStr(value.parent)) {
    throw new ValueError('helperOf must be {helperId, parent}');
  }
  return { helperId: value.helperId, parent: value.parent };
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
  /** How often the usage checker runs on its own for the open chats, in ms (tests pass a short one). Default REFRESH_SECONDS. */
  limitsEveryMs?: number;
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
  /** The projects the user added (desktop/added_projects.ts): a chat opened here adds its folder. */
  readonly addedProjects: AddedProjects | null;
  /** Allow rules (server/allow): one gate for every chat of this host; null without a state folder. */
  readonly allow: AllowGate | null;
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
  /** Live sync of WSL chats' worktrees: the engine runs in each distro's helper (wsl/sync.ts); null without worktrees. */
  readonly wslSync: WslSync | null;
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
  /** Subscription usage limits per agent account, for the Limits chip (host/usage_limits_feed.ts). */
  limits: LimitsFeed;
  /** Running quiet probes by agent|folder, and when each last failed (seconds). */
  readonly #probes = new Map<string, Promise<void>>();
  readonly #probeFailed = new Map<string, number>();
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #limitsTimer: ReturnType<typeof setInterval> | null = null;
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
  /** Stops this Studio answering WSL agents' tool calls (wsl/mcp_tunnel.ts); null when it never did. */
  #untunnel: (() => void) | null = null;

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
    this.addedProjects = this.hasStateDir ? new AddedProjects(this.stateDir) : null;
    this.allow = this.hasStateDir ? new AllowGate(this.stateDir) : null;
    this.recovery = this.store ? new Recovery(this.store) : null;
    if (this.recovery) this.recovery.queues = new QueueStore(this.stateDir, `queues-${name}`); // queued messages survive a host restart (paused)
    const dir = this.hasStateDir ? this.stateDir : null;
    const stores = construct.stores ?? {};
    this.conversations = stores.conversations ?? new ConversationState(dir);
    this.projectPrefs = stores.projectPrefs ?? new ProjectPrefs(dir);
    this.readState = stores.readState ?? new ReadState(dir);
    this.settings = stores.settings ?? new SettingsStore(dir);
    this.agentOptions = new AgentOptionsCache(dir);
    this.limits = new LimitsFeed(new UsageLimitsStore(dir));
    // The usage checker also runs on its own, once a minute for every open chat (not only when a chat opens or a turn ends)
    this.#limitsTimer = setInterval(() => {
      if (this.#closed) return;
      for (const c of this.connections.values()) if (!c.closed) void this.limits.refresh(c);
    }, construct.limitsEveryMs ?? REFRESH_SECONDS * 1000);
    Deno.unrefTimer(this.#limitsTimer);
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
    this.wslSync = this.worktrees ? new WslSync(this) : null;
    if (this.hasStateDir) artifactKeys.configure(this.stateDir);
    if (this.hasStateDir) urlGate.configure(this.stateDir); // "Always allow" of a distro's URLs is kept with AIB's data
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
    // WSL projects (wsl/hosts.ts): one host per distro, made and started only when a WSL project needs it, so a PC without WSL pays
    // nothing. The Windows keeper holds each distro's keep-alive; the Linux keeper is the same program, so it has the same version.
    // The first Studio of the process sets this up (a test that set up its own hosts keeps them).
    if (this.hasStateDir) {
      const keeper = this.keeper;
      let version: Promise<string | null> | null = null;
      configureWslHosts({
        stateDir: this.stateDir,
        windowsLink: () => (this.#closed ? null : keeper),
        keeperVersion: () =>
          version ??= (async () => {
            try {
              return await programVersion(keeper?.options.binary ?? await keeperBinary(this.stateDir));
            } catch {
              return null;
            }
          })(),
      }, false);
      // WSL agents' tool calls through the tunnel (wsl/mcp_tunnel.ts) are answered by this Studio.
      if (!this.options.noArtifactTool) this.#untunnel = mcpTunnelGate.set((request) => this.wslToolCall(request));
    }
    // The chats on the recovery list ran in the previous AIB of this data folder (an app restart, an update, or the split agent
    // host this process took over). Their transcript writes up to now are that AIB's own, not another app's: without this the
    // ownership probe reads a reply written moments before the restart as "another app is writing it", the auto-reconnect is
    // refused as possibly active and the chat shows "Elsewhere · Working" until the write is two minutes old. Writes after this
    // start still count, and the command-line and open-file checks are unchanged.
    for (const item of this.recovered()) this.probe.noteReleased(String(item.provider), String(item.sessionId));
  }

  // ---- hooks on each connection ------------------------------------------------------------------------------------------
  /** The agent finished a turn: mark the conversation "your turn" until the user acts on it. */
  async turnEnded(connection: Connection): Promise<void> {
    if (this.liveSync && connection.worktree) {
      try {
        // the lost-update guard and the merge of files both sides changed (a WSL chat's: in its distro's helper)
        if (this.wslSync && wslSyncChat(connection)) await this.wslSync.turnEnded(connection);
        else await this.liveSync.turnEnded(connection);
      } catch (error) {
        log.exception(error, 'Merging the user edits at the end of the turn failed');
      }
    }
    if (connection.provider && connection.sessionId) await this.#mark('your_turn', connection);
    void this.limits.refresh(connection); // Codex / Vibe: at most once a minute per account
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

  /** Windows pids of this Studio's agents (a WSL chat's pid is the distro's: wslOwnPids). */
  #ownAgentPids(): number[] {
    return [...this.connections.values()].filter((c) => !c.closed && c.process !== null && !c.wsl).map((c) => c.process!.pid);
  }

  /** The Linux pids of this Studio's open chats in a distro (wslOwnPids adds every agent channel its Linux keeper lists). */
  #wslChatPids(distro: string): number[] {
    return [...this.connections.values()]
      .filter((c) => !c.closed && c.wsl?.distro === distro && c.process !== null)
      .map((c) => c.process!.pid);
  }

  /** Owner announcements only (the Windows registry): what a WSL chat's check adds to its distro's answer. */
  readonly #registryProbe = (): OwnershipProbe =>
    new OwnershipProbe({
      registry: this.owners,
      ownedByStudio: (provider, sessionId) => this.#studioOwns(provider, sessionId),
      inspectProcesses: false,
      lockProbe: () => [],
    });

  /**
   * The ownership check of a WSL chat (wsl/ownership.ts): the distro's helper looks for a process holding the session and for the weak
   * signs, AIB adds the Windows owner announcements. `null` assessment from the distro: its helper could not answer.
   */
  async #wslAssess(provider: string, sessionId: string, wsl: { distro: string; linuxPath: string }, projectRoot: string | null) {
    const host = readyHost(wsl.distro);
    const released = this.probe.releasedAt(provider, sessionId);
    const answer = await wslOwnerCheck(host, provider, sessionId, {
      cwd: wsl.linuxPath,
      ...(projectRoot && projectRoot !== wsl.linuxPath ? { projectRoot } : {}),
      exclude: await wslOwnPids(host, this.#wslChatPids(wsl.distro)),
      releasedAgo: released === null ? null : Math.max(0, this.probe.clock() - released),
    });
    if (!answer) log.warning('ownership: %s could not check %s %s in its distro', distroName(wsl.distro), provider, sessionId);
    const registry = this.#registryProbe().assess(provider, sessionId, { deep: false });
    return { owner: answer?.owner ?? null, assessment: mergeAssessment(answer?.assessment ?? null, registry, answer?.owner ?? null, distroName(wsl.distro)) };
  }

  /** Throw OwnershipConflict / OwnershipEvidence unless a WSL chat may be continued: the same rules and words as for a Windows chat. */
  async #wslCheckOwnership(provider: string, sessionId: string, wsl: { distro: string; linuxPath: string }, projectRoot: string | null, continueAnyway: boolean): Promise<void> {
    const { owner, assessment } = await this.#wslAssess(provider, sessionId, wsl, projectRoot);
    if (owner !== null) {
      throw new OwnershipConflict(
        `This ${provider} conversation is already open in another agent process (PID ${owner}). Stop it in its current client before continuing here.`,
      );
    }
    this.#refuseByVerdict(assessment, continueAnyway);
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
    if (this.wslSync) void this.wslSync.refresh(); // a WSL chat's helper stops watching it (no-op without WSL chats)
    if (connection.sessionId) {
      this.probe.noteReleased(connection.provider, connection.sessionId);
      if (this.owners) this.owners.withdraw(connection.provider, connection.sessionId);
    }
  }

  /** Throw OwnershipEvidence unless the conversation may be opened. The command-line probe has run already. */
  checkOwnership(provider: string, sessionId: string, cwd: string, continueAnyway = false, fresh = true): unknown {
    return this.#refuseByVerdict(this.probe.assess(provider, sessionId, { cwd, skipCmdline: true, fresh }), continueAnyway);
  }

  #refuseByVerdict(verdict: Assessment, continueAnyway: boolean): Assessment {
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
   * and stays "Ready". Nothing is ever sent to an agent. At most `concurrency` start at once, `stagger` seconds apart; a
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
    let last = '';
    try {
      for (let attempt = 1; attempt <= tries; attempt++) {
        if (this.reconnectStop.isSet()) return;
        try {
          await this.connect(provider, cwd, sessionId, { background: false, continueAnyway: false, auto: true });
          console.error(`Auto-reconnect: reconnected ${label}`);
          return;
        } catch (error) {
          if (error instanceof OwnershipConflict) {
            console.error(`Auto-reconnect: skipped ${label}: ${error.message}`);
            return;
          }
          last = errorText(error);
          log.warning('Auto-reconnect of %s failed (try %s of %s): %s', label, attempt, tries, last);
          console.error(`Auto-reconnect: ${label} failed (try ${attempt} of ${tries}): ${last}`);
          if (attempt < tries && await this.reconnectStop.wait(retryDelay * 1000)) return;
        }
      }
      // The chat says why it is not running (liveList reconnectFailed), so it never just sits there: Continue tries again.
      this.reconnectFailures.set(pairKey(provider, sessionId), { provider, sessionId, cwd, error: last.slice(0, 500), at: Date.now() / 1000 });
      if (this.store!.forgetConversation(provider, sessionId)) {
        console.error(`Auto-reconnect: gave up on ${label}; it stays Ready (Couldn't reopen)`);
      }
    } finally {
      this.reconnectPending.delete(pairKey(provider, sessionId));
    }
  }

  forgetRecovered(provider: unknown, sessionId: unknown): boolean {
    if (!isStr(provider) || !isStr(sessionId)) throw new ValueError('Invalid conversation');
    const failed = this.reconnectFailures.delete(pairKey(provider, sessionId));
    return !!(this.store && this.store.forgetConversation(provider, sessionId)) || failed;
  }

  /** Chats the automatic reconnect gave up on in this process, with the last reason (until they run again or are forgotten). */
  readonly reconnectFailures = new Map<string, { provider: string; sessionId: string; cwd: string; error: string; at: number }>();

  /** reconnectFailures without the chats that run again (a Continue, a take-over). */
  reconnectFailed(): Json[] {
    const openNow = new Set([...this.connections.values()].filter((c) => !c.closed).map((c) => pairKey(c.provider, c.sessionId)));
    return [...this.reconnectFailures.entries()].filter(([key]) => !openNow.has(key)).map(([, failure]) => ({ ...failure }));
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
      return [row.argv, provider === 'claude' ? adapters.claudeEnv(Deno.env.toObject()) : {}];
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
    const row = await resolveBeta(provider, {
      stateDir: this.hasStateDir ? this.stateDir : null,
      nodeCommand: this.options.nodeCommand || '',
    });
    if (!row.found) throw new ValueError(`${agent.name} is not available: ${row.problem}`);
    return [row.argv, this.betaEnv(provider)];
  }

  /**
   * The environment a Beta agent gets on top of AIB's: its stored API key under the agent's variable (registered as a secret), and
   * its stored API address (Qwen: OPENAI_BASE_URL) when one is set.
   */
  betaEnv(provider: string): Record<string, string> {
    const agent = betaAgent(provider);
    const out: Record<string, string> = {};
    const key = agent?.signin.keyEnv ? this.settings.betaKey(provider) : '';
    if (agent?.signin.keyEnv && key) {
      registerSecret(key); // never in a log line
      out[agent.signin.keyEnv] = key;
    }
    const url = agent?.signin.baseUrlEnv ? this.settings.betaUrl(provider) : '';
    if (agent?.signin.baseUrlEnv && url) out[agent.signin.baseUrlEnv] = url;
    return out;
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
          return c && !c.closed
            ? { cwd: c.cwd, worktree: !!c.worktree && c.swarm?.role !== 'helper', restricted: !!c.wsl, main: this.#isMain(c) }
            : null;
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
  artifactMcpServers(conversationId: string, worktree = false, forwarder: string | null = null, main = false): McpServer[] {
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
    const stdio = this.#artifactStdioEntry(conversationId, key, worktree, main);
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

  /**
   * The `studio_artifact` entry of a WSL chat (design sections 4 and 11). Either way the endpoint gives such a chat the tool groups of
   * mcp.ts WSL_TOOL_GROUPS (artifacts by content, docs, merge in its own worktree; no swarm tools yet).
   *   - The tunnel (phase 2), when the distro's helper has one: the Linux keeper program as forwarder
   *     (`<root>/<ver>/AIB-keeper mcp-forward --helper-socket <data>/helper/mcp.sock`), the key in its environment; each message goes
   *     through the helper channel to this Studio (wslToolCall). Needs no WSL interop and opens no port.
   *   - Else the interop entry (phase 1): the Windows keeper's forwarder as `/mnt/c/.../AIB-keeper.exe mcp-forward <Windows address
   *     file>`, WSLENV handing MCP_FORWARD_HEADERS over to the Windows process.
   *   - Else no entry, and the chat says the tools are missing instead of failing silently.
   * The user's own --mcp-config entries are Windows commands and are not passed.
   */
  async wslMcpServers(conversationId: string, distro = ''): Promise<{ servers: McpServer[]; notice: string }> {
    if (this.options.noArtifactTool || !this.hasStateDir) return { servers: [], notice: '' };
    const key = artifactKeys.issue(conversationId);
    if (!key) return { servers: [], notice: WSL_TOOLS_NOTICE };
    const tunnel = distro ? wslHost(distro)?.mcpTunnel ?? null : null;
    if (tunnel) {
      return { servers: [tunnelEntry(tunnel.forwarder, tunnel.socket, key, conversationId) as unknown as McpServer], notice: wslToolsNotice() };
    }
    let forwarder: string | null = null;
    try {
      forwarder = await forwarderOf(this.keeper?.options.binary ?? null, this.stateDir);
    } catch (error) {
      log.warning('wsl: no MCP forwarder for interop (%s)', errorText(error));
    }
    const program = forwarder ? windowsPathInWsl(forwarder) : null;
    if (!program) return { servers: [], notice: WSL_TOOLS_NOTICE };
    const file = join(this.stateDir, FORWARD_FILE);
    try {
      this.artifactMcpHttp(); // listening, with its address published, before the agent starts the forwarder
      ownForwardFile(file);
    } catch (error) {
      log.exception(error, 'Could not start the HTTP artifact tool for a WSL chat');
      return { servers: [], notice: WSL_TOOLS_NOTICE };
    }
    const entry = forwardEntry(program, file, key, conversationId) as { env: { name: string; value: string }[] };
    entry.env.push({ name: 'WSLENV', value: 'MCP_FORWARD_HEADERS' }); // the agent's variable crosses into the Windows forwarder
    return { servers: [entry as unknown as McpServer], notice: wslToolsNotice() };
  }

  /**
   * One tool call from an agent in a WSL distro, through the tunnel (wsl/mcp_tunnel.ts): only for a live chat of this AIB in that same
   * distro, then the HTTP endpoint's own key check and reply (ArtifactMcpHttp.tunneled).
   */
  async wslToolCall(request: { distro: string; key: string; conversation: string; body: string }): Promise<TunnelAnswer> {
    if (this.#closed) return { status: 503, body: '', error: 'AIB is closed, so this tool cannot answer now. Try again later, once AIB is open again.' };
    const c = this.connections.get(request.conversation);
    if (!c || c.closed || !c.wsl || c.wsl.distro.toLowerCase() !== request.distro.toLowerCase()) {
      const refused = { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'AIB refused the artifact key for this conversation' } };
      return { status: 401, body: JSON.stringify(refused) };
    }
    return await this.artifactMcpHttp().tunneled(request.key, request.conversation, request.body);
  }

  /**
   * What a chat in a WSL project starts (design sections 4 and 5): the agent as the distro has it (the helper's `agents.detect`; a
   * custom agent's command found with `which`), the distro's login environment, and the Linux keeper link it runs in. Throws
   * ValueError with the line the user sees when the distro is not ready or the agent is not installed there.
   * On/Off (docs/wsl/linking-design.md section 12): a WSL chat reads only its distro's own switch (settings.distroAgentEnabled), never
   * the Windows one; an agent turned off for the distro is refused for a new chat (`fresh`) and for the person's Continue
   * (`continued`), never for the automatic reconnect at start.
   */
  async wslLaunch(
    provider: string,
    wsl: { distro: string; linuxPath: string },
    fresh = false,
    continued = false,
  ): Promise<{ command: string[]; extra: Record<string, string>; spawn: WslSpawn; link: KeeperLink }> {
    const name = distroName(wsl.distro);
    if ((fresh || continued) && !this.settings.distroAgentEnabled(wsl.distro, provider)) throw new ValueError(wslAgentOffLine(provider, name, this.settings));
    const host = await hostWhenReady(wsl.distro); // the first chat after a Windows start waits for its distro
    let command: string[];
    let extra: Record<string, string> = {};
    if (agentRegistry.isCustom(provider)) {
      const agent = this.settings.customAgent(provider);
      if (agent === null) throw new ValueError('That agent is not in Settings (it may have been removed)');
      for (const e of agent.env) registerSecret(e.value);
      command = [agent.command, ...agent.args];
      extra = Object.fromEntries(agent.env.map((e) => [e.name, e.value]));
    } else {
      const label = isBeta(provider) ? betaAgent(provider)!.name : agentRegistry.BUILTIN_NAMES[provider] ?? provider;
      const detected = await host.call('agents.detect', { ids: [provider] });
      const row = detected.agents.find((a) => a.id === provider);
      if (!row?.found || !row.command?.length) throw new ValueError(`${label} is not installed in ${name}`);
      command = row.command.map(String);
      if (isBeta(provider)) extra = this.betaEnv(provider);
    }
    const env = await host.env();
    if (provider === 'claude') extra = { ...adapters.claudeEnv(env), ...extra };
    const which = async (program: string) => (await host.call('which', { name: program })).path;
    const program = command[0].includes('/') ? command[0] : await which(command[0]);
    if (!program) throw new ValueError(`${command[0]} was not found in ${name}`);
    const link = linkOf(host);
    this.#followWslLink(link);
    return {
      command,
      extra,
      spawn: { distro: wsl.distro, linuxPath: wsl.linuxPath, env, program, caps: { env: () => host.env(), which } },
      link,
    };
  }

  /** The Linux keepers whose loss this Studio already follows (the same reconnect rule as the Windows keeper's). */
  readonly #wslLinks = new WeakSet<KeeperLink>();

  #followWslLink(link: KeeperLink): void {
    if (this.#wslLinks.has(link)) return;
    this.#wslLinks.add(link);
    const before = link.onLost;
    link.onLost = (channels) => {
      before?.(channels);
      this.#keeperLost(channels);
    };
  }

  #artifactStdioEntry(conversationId: string, key: string, worktree: boolean, main = false): McpServer[] {
    const env: Record<string, string> = {
      STUDIO_ARTIFACT_URL: this.artifactBaseUrl(),
      STUDIO_ARTIFACT_URL_FILE: join(this.stateDir, ARTIFACT_URL_FILE),
      STUDIO_ARTIFACT_KEY: key,
      STUDIO_CONVERSATION_ID: conversationId,
    };
    if (worktree) env.STUDIO_WORKTREE = '1'; // only a worktree chat is offered the merge tools
    if (main) env.STUDIO_MAIN = '1'; // swarm: only a main chat is offered the helper tools (the route checks again)
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
    // The sign-in cache is the Windows agents'; a WSL project's agent signs in inside its distro, so the probe there finds out itself.
    if (this.hasStateDir && !wslLoc(cwd) && readSignIn(this.stateDir, agent).state === 'signin') {
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
    const wsl = wslLoc(cwd);
    let probe: Connection;
    let folder: string | null;
    if (wsl) {
      // A WSL project: the probe runs in its distro, like its chats (never as a Windows child in the Linux folder).
      const launch = await this.wslLaunch(agent, wsl, true);
      folder = refOf({ kind: 'wsl', ...wsl });
      const options: ConnectionOptions = { keeper: launch.link, wsl: launch.spawn };
      if (Object.keys(launch.extra).length) options.env = launch.extra;
      probe = this.connectionFactory(launch.command, folder, agent, options);
    } else {
      const [command, env] = await this.agentLaunch(agent, true);
      folder = cwd && isdir(cwd) ? realpath(expandUser(cwd)) : home();
      probe = Object.keys(env).length
        ? this.connectionFactory(command, folder, agent, { env })
        : this.connectionFactory(command, folder, agent);
      folder = cwd && isdir(cwd) ? cwd : null;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settings = await Promise.race([
        probe.probeSettings(PROBE_TIMEOUT_SECONDS - 5),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new ValueError('The agent did not answer in time')), PROBE_TIMEOUT_SECONDS * 1000);
        }),
      ]);
      this.agentOptions.record(agent, folder, settings, true);
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
    // A WSL project (design section 2): its ref is the chat's folder; nothing about it is looked up on Windows, its worktree (if any)
    // is made and kept by its distro's helper (wsl/worktrees.ts), and its agent starts in the distro's Linux keeper (wslLaunch).
    let wsl = wslLoc(cwd);
    let workspace = wsl ? refOf({ kind: 'wsl', ...wsl }) : realpath(expandUser(cwd));
    if (!wsl && this.worktrees && this.worktrees.isRemoved(workspace, resume ? `${provider}:${resume}` : null)) {
      throw new wt.WorktreeGone(wt.GONE_MESSAGE); // discarded (or being removed): readable, not continuable
    }
    let record: (wt.WorktreeRecord & { key: string }) | null = !wsl && this.worktrees ? this.worktrees.forChat(provider, resume, workspace) : null; // a chat that has a worktree keeps it
    if (record) workspace = realpath(await this.worktrees!.ensure(record)); // made again from its branch if deleted
    if (!wsl && !isdir(workspace)) throw new ValueError('Choose an existing workspace folder');
    if (!agentRegistry.isProvider(provider)) throw new ValueError('Choose an agent');
    const launch = wsl ? await this.wslLaunch(provider, wsl, !resume, !!resume && !options.auto) : null;
    if (launch && this.worktrees) {
      // the same two lookups in the distro: a discarded worktree is not continued; a chat that has one keeps it (made again if deleted)
      const session = resume ? `${provider}:${resume}` : null;
      if (await wslIsRemoved(workspace, session)) throw new wt.WorktreeGone(wt.GONE_MESSAGE);
      const found = await wslRecord(workspace, session);
      if (found) {
        const linuxPath = await wslEnsure(found);
        wsl = { distro: found.distro, linuxPath };
        workspace = refOf({ kind: 'wsl', ...wsl });
        launch.spawn = { ...launch.spawn, linuxPath };
        record = found;
      }
    }
    if (launch) {
      const stat = await readyHost(wsl!.distro).call('fs.stat', { path: wsl!.linuxPath });
      if (!stat.isDir) throw new ValueError('Choose an existing workspace folder');
    }
    const [command, env] = launch ? [launch.command, launch.extra] : await this.agentLaunch(provider, !resume);
    // its agent may still run in the distro's keeper (a take-over at start that failed or never asked): taken over, never a second one
    if (launch && resume) await this.#wslTakeOverFirst(wsl!.distro);
    for (const connection of this.connections.values()) {
      if (resume && connection.provider === provider && connection.sessionId === resume && !connection.closed) {
        if (!connection.ready) throw new OwnershipConflict('This conversation is already opening in AIB. Wait for it to finish.');
        return connection;
      }
    }
    // A saved chat whose agent still runs in the keeper it would start in (a WSL chat: its distro's) is taken over, never started twice
    const keeperOfChat = launch ? launch.link : this.keeper;
    const running = resume && keeperOfChat ? await this.#runningInKeeper(provider, resume, keeperOfChat, launch ? wsl!.distro : null) : null;
    if (running) {
      if (!running.ready) throw new OwnershipConflict('This conversation is already opening in AIB. Wait for it to finish.');
      return running;
    }
    let plan: wt.Plan | null = null;
    let startNote = ''; // a new chat's start note: where it started when that is not the obvious, or why it works in place
    // Swarm: a helper is one from its first moment (helperOf) or because the registry lists it (reopened after a restart, a Continue).
    const asHelper = options.helperOf ?? null;
    const known = !asHelper && this.hasStateDir
      ? helperOf(readHelpers(this.stateDir), { lasting: resume ? `${provider}:${resume}` : null, path: record ? String(record.path) : null })
      : null;
    if (asHelper && resume) throw new ValueError('A helper is a new chat');
    if (asHelper && !this.worktrees) throw new ValueError('Helpers need a worktree: this AIB has no state folder');
    if (resume === null && this.worktrees && (this.settings.worktreePerChat() || asHelper)) {
      const kind = asHelper ? 'helper' : 'chat';
      const planned = wsl ? await wslPlanWithReason(workspace, kind) : await this.worktrees.planWithReason(workspace, null, kind); // no plan: works in place
      plan = planned.plan;
      startNote = wt.inPlaceNote(planned.reason);
      // a helper never works in the project folder (review break 5)
      if (asHelper && !plan) throw new ValueError(`This project cannot make a worktree for a helper: ${planned.reason || 'unknown reason'}`);
    }
    const lease = resume ? await new SessionLease(this.stateDir, provider, resume).acquire() : null;
    let connection: Connection | null = null;
    try {
      // The ownership check reads Windows processes and transcripts; a WSL agent's are inside the distro, so its helper checks there.
      if (resume && wsl) {
        const project = record ? wslLoc(String(record.project ?? ''))?.linuxPath ?? null : null;
        await this.#wslCheckOwnership(provider, resume, wsl, project, continueAnyway);
      } else if (resume) {
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
      if (launch) {
        connectionOptions.keeper = launch.link; // the distro's Linux keeper, whatever the Windows keeper's state
        // a new worktree chat's agent works in the worktree's Linux folder (cwd: its ref)
        connectionOptions.wsl = plan instanceof WslPlan ? { ...launch.spawn, linuxPath: plan.linuxPath } : launch.spawn;
      } else if (this.keeper && this.keeperForNew && await this.#keeperUsable()) connectionOptions.keeper = this.keeper;
      if (connectionOptions.keeper) connectionOptions.history = this.historyClient();
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
      if (asHelper) c.swarm = { role: 'helper', helperId: asHelper.helperId, parent: asHelper.parent };
      else if (known) c.swarm = { role: 'helper', helperId: known.id, parent: known.parent.live };
      else if (c.worktree && (!wsl || WSL_TOOL_GROUPS.swarm)) c.swarm = { role: 'main' }; // WSL: only once its swarm tools are on
      let toolsNotice = '';
      if (launch) {
        const tools = await this.wslMcpServers(c.id, wsl!.distro); // the tunnel, else interop, else a notice (WSL_TOOL_GROUPS)
        c.mcpServers = tools.servers;
        toolsNotice = tools.notice;
      } else {
        const forwarder = c.keeper ? await this.#mcpForwarder() : null;
        const helper = c.swarm?.role === 'helper'; // a helper gets neither the merge tools (review break 3) nor the swarm tools
        c.mcpServers = [...(this.options.mcpServers ?? []), ...this.artifactMcpServers(c.id, !!c.worktree && !helper, forwarder, this.#isMain(c))];
      }
      c.sessionId = resume || null;
      if (!resume && options.picks) c.startPicks = { ...options.picks };
      c.recovery = this.recovery as never;
      this.connections.set(c.id, c);
      // Its folder is a project from now on (the page, auto-reconnect, a keeper take-over and agent-started chats all come here).
      if (this.addedProjects) void this.addedProjects.addOpened(c.projectRoot || workspace);
      if (resume) this.announce(c, 'opening'); // claim before session/load so other clients can see it
      const finishSetup = async () => {
        try {
          // before the snapshot: the default /private exclude is in force, so a new copy never takes the main folder's private/
          const local = wsl ? null : await this.#localOnlyDefault(c.worktree ? c.projectRoot : workspace);
          if (plan) await this.#makeWorktree(c, plan, workspace);
          c.localOnly = this.#localOnlyFor(c, local);
          await c.setup(resume || null);
          if (plan instanceof WslPlan) {
            if (c.worktree) await wslSetSession(plan, provider, c.sessionId!);
          } else if (plan && this.worktrees!.registry.get(plan.key)) await this.worktrees!.setSession(plan.key, provider, c.sessionId!);
          const note = plan && c.worktree ? plan.note : startNote;
          if (note) c.recordedEvent('studio_note', { message: note, sessionId: c.sessionId });
          if (toolsNotice) c.recordedEvent('studio_note', { message: toolsNotice, sessionId: c.sessionId }); // a WSL chat's tools

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
          void this.limits.refresh(c); // chat opened: Codex / Vibe limits (at most once a minute per account)
          if (this.recovery) this.recovery.connectionReady(c);
          this.announce(c, 'ready');
          if (this.liveSync && !wsl) {
            try {
              await this.liveSync.chatOpened(c); // watch its project, catch it up on the user's saved edits
            } catch (error) {
              log.exception(error, 'Starting live sync failed');
            }
          } else if (this.wslSync && wsl) await this.wslSync.chatOpened(c); // the same, in its distro's helper (never throws)
        } catch (error) {
          log.exception(error, 'Opening the conversation failed');
          c.error = errorText(error);
          await c.close();
          if (plan && !c.sessionId) await this.#discardPlan(plan).catch(() => {}); // the chat never began
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
    if (this.allow) {
      c.allowGate = this.allow;
      if (!c.wsl) c.scratchDir = this.allow.scratchFor(c.id); // a Windows scratch folder is no folder for an agent in a distro (its additionalDirectories must be Linux paths)
    }
    c.onRelease = (conn) => {
      this.withdraw(conn);
      if (conn.channel) this.#keeperNoLongerNeeded();
    };
    c.onTurnEnd = (conn) => this.turnEnded(conn);
    c.onLimits = (conn, kind, raw, at) => this.limits.fromAgent(conn, kind, raw, at);
    if (this.liveSync) {
      const sync = this.liveSync;
      const wsl = this.wslSync!; // a WSL chat in its own copy: its distro's helper runs the hooks (wsl/sync.ts)
      c.onTurnStart = (conn) => wslSyncChat(conn) ? wsl.turnStarted(conn) : sync.turnStarted(conn);
      c.contextForPrompt = (conn) => wslSyncChat(conn) ? wsl.contextFor(conn) : sync.contextFor(conn);
      c.contextSent = (conn, token) => wslSyncChat(conn) ? wsl.contextSent(conn, token) : sync.contextSent(conn, token);
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
    let adopted = this.keeper ? await this.#adoptFrom(this.keeper, null) : 0;
    for (const distro of this.#wslDistrosToAdopt()) {
      try {
        adopted += await this.adoptWslKeeper(distro);
      } catch (error) {
        log.warning('keeper: taking WSL chats over from %s failed: %s', distro, errorText(error));
      }
    }
    return adopted;
  }

  /**
   * The distros whose Linux keeper may still hold chats of this data folder: those of the chats on the recovery list (they ran when
   * the previous AIB stopped). Only those are asked, so a start never boots a distro no chat of AIB ran in.
   */
  #wslDistrosToAdopt(): string[] {
    const out = new Set<string>(this.#heldDistros); // a live keep-alive in the Windows keeper: that distro's keeper holds work
    for (const item of this.store ? [...this.store.conversations.values()] : []) {
      const loc = wslLoc(item.cwd);
      if (loc) out.add(loc.distro);
    }
    return [...out];
  }

  /**
   * The distros whose keep-alive (wsl-hold) the Windows keeper still runs (seen during its take-over): their Linux keeper may hold
   * chats even when the recovery list lost them (an AIB without WSL support, or an auto-reconnect that gave up, forgot them).
   */
  #heldDistros = new Set<string>();

  /** The distros whose Linux keeper this process has asked (taken over or found nothing to take over). */
  #wslAsked = new Set<string>();
  #wslAsking = new Map<string, Promise<number>>();

  /**
   * Before a WSL chat is continued: if this process has not yet asked its distro's keeper (the take-over at start failed or never
   * asked), ask now, so an agent still running there is taken over instead of a second one started for the same session.
   */
  async #wslTakeOverFirst(distro: string): Promise<void> {
    if (this.#adopting && !this.#adoptDone) await this.#adopting; // the take-over at start first
    if (this.#wslAsked.has(distro)) return;
    let run = this.#wslAsking.get(distro);
    if (!run) {
      run = this.adoptWslKeeper(distro).catch((error) => {
        log.warning('keeper: taking WSL chats over from %s failed: %s', distro, errorText(error));
        return 0;
      }).finally(() => this.#wslAsking.delete(distro));
      this.#wslAsking.set(distro, run);
    }
    await run;
  }

  /**
   * Rebuild the chats a distro's Linux keeper still runs (an AIB restart or update while WSL agents worked; the hold kept them alive).
   * Same rules as the Windows keeper's take-over. The distro is started for this (only distros a chat on the recovery list ran in are
   * asked: #wslDistrosToAdopt). Returns how many were taken over.
   */
  async adoptWslKeeper(distro: string): Promise<number> {
    let host;
    try {
      host = await hostWhenReady(distro, 120_000);
    } catch (error) {
      log.warning('keeper: %s is not ready, so its chats were not taken over: %s', distro, errorText(error));
      return 0;
    }
    const link = linkOf(host);
    this.#followWslLink(link);
    return await this.#adoptFrom(link, distro);
  }

  /** One take-over at a time (the start's, and the check before a saved chat's agent starts): a channel is never rebuilt twice. */
  readonly #adoptGate = new Mutex();

  /**
   * Take over the chats of one keeper: the Windows keeper (distro null) or a distro's Linux keeper. `check`: the look before a saved
   * chat's agent starts (#runningInKeeper): only live chat channels this AIB holds no chat for are rebuilt; nothing is stopped or
   * removed, and a keeper that cannot be asked throws instead of counting as empty.
   */
  #adoptFrom(keeper: KeeperLink, distro: string | null, check = false): Promise<number> {
    return this.#adoptGate.run(() => this.#adoptFromNow(keeper, distro, check));
  }

  /**
   * Before a saved chat's agent starts: is that session's agent still running in the keeper it would start in? Then that chat is
   * taken over (rebuilt from its channel) and returned instead, so one session never runs as two agents. This covers a take-over
   * at start that failed or timed out (a distro slow to answer), and a keeper link that was given up while its agents kept running.
   * null: no agent of that session runs there. A distro's keeper that cannot be asked is an error (starting blind could make a
   * second agent; the auto-reconnect tries again); the Windows keeper's is logged and the chat starts as before.
   */
  async #runningInKeeper(provider: string, sessionId: string, keeper: KeeperLink, distro: string | null): Promise<Connection | null> {
    try {
      await this.#adoptFrom(keeper, distro, true);
    } catch (error) {
      if (distro) throw new Error(`AIB could not ask ${distroName(distro)} whether this chat still runs there: ${errorText(error)}`);
      log.warning('keeper: could not ask the keeper whether %s %s still runs: %s', provider, sessionId, errorText(error));
    }
    return [...this.connections.values()].find((c) => c.provider === provider && c.sessionId === sessionId && !c.closed) ?? null;
  }

  async #adoptFromNow(keeper: KeeperLink, distro: string | null, check: boolean): Promise<number> {
    let client;
    try {
      client = await keeper.client(false); // only a keeper that already runs: nothing to take over otherwise
    } catch (error) {
      if (check) throw error;
      log.warning('keeper: could not reach the keeper: %s', errorText(error));
      // A keeper that answers but refuses this AIB (another protocol): its chats keep running there; the page says so.
      if (!distro && error instanceof KeeperError && error.code !== 'closed') {
        noteKeeperTakeoverProblem(`the keeper refused this AIB: ${errorText(error)}`);
      }
      return 0;
    }
    if (!client) {
      if (distro) this.#wslAsked.add(distro); // no Linux keeper runs: nothing of it to take over
      return 0;
    }
    const missing = missingFeatures(client.features);
    if (missing.length) {
      // The same rule as Install now's (release.json keeper.needs): a keeper without what this AIB needs is not taken over, and
      // nothing in it is stopped.
      const why = `the running keeper (${client.keeperVersion || 'unknown version'}) lacks ${missing.join(', ')}`;
      announce('studio', 'keeper: not taking chats over: %s', why);
      if (!distro && !check) noteKeeperTakeoverProblem(why); // a distro's keeper version is wsl/hosts.ts's business (it replaces or adopts)
      return 0;
    }
    if (!distro && !check) noteKeeperTakeoverProblem('');
    let adopted = 0;
    const started = performance.now();
    const listed = await client.list();
    if (distro) this.#wslAsked.add(distro);
    for (const info of listed) {
      try {
        if (info.kind !== 'pipe') continue;
        if (info.channel.startsWith(CLIENT_TERMINAL_PREFIX)) continue; // an agent's client terminal: its chat takes it over
        if (isAibInternalLabel(info.label)) { // AIB's own WSL hold or helper: never a chat, never stopped as an orphan
          const held = !distro && info.live ? heldDistro(info.label) : '';
          if (held) this.#heldDistros.add(held);
          continue;
        }
        if (keeper.channels.has(info.channel)) continue; // one of this AIB's own (a chat it runs, or one starting right now)
        if (!info.live) {
          if (!check && info.ended && Date.now() - info.ended > 7 * 86400_000) await keeper.removeEnded(client, info.channel);
          continue;
        }
        const timer = new PhaseTimer();
        const note = await keeper.firstNote(client, info.channel);
        timer.mark('note');
        if (!note || note.t !== 'chat' || !isStr(note.id) || !isStr(note.provider) || !isStr(note.cwd)) {
          if (check) continue; // only the start stops a channel without a chat record
          announce('studio', 'keeper: stopping channel %s: it has no chat record', info.channel);
          await keeper.stopUnknown(client, info.channel);
          continue;
        }
        const known = this.connections.get(note.id);
        // A chat whose link to this channel was given up (the keeper could not be reached for a while) while its agent kept running
        // is rebuilt under its own id; any other chat this AIB has (open, or closed by the user) keeps the channel as it is.
        if (known && !(check && known.closed && known.channel?.lost)) continue;
        const done = await this.#rebuildChat(info, note, keeper, distro, timer);
        if (done) {
          const rebuilt = this.connections.get(note.id);
          if (!rebuilt || !await this.#dropDuplicate(rebuilt)) adopted++;
          timer.mark('duplicate check');
        }
        const session = this.connections.get(note.id)?.sessionId ?? (isStr(note.resume) ? note.resume : '');
        timer.log(`${note.provider} ${session || '-'} ${note.id}${done ? '' : ' (not taken over)'}`);
      } catch (error) {
        log.exception(error, 'keeper: taking over channel failed');
      }
    }
    if (!check) await this.#dropOrphanTerminals(client, listed, keeper);
    if (adopted) {
      announce('studio', 'keeper: %s chat(s) taken over from the keeper in %s ms', adopted, Math.round(performance.now() - started));
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

  /**
   * Client terminals whose chat is gone (it ended while no AIB ran, or could not be taken over): stopped and removed. Those of a chat
   * that was taken over were re-attached by it (Connection, from its clientTerminal notes) and are left alone.
   */
  async #dropOrphanTerminals(client: KeeperClient, listed: ChannelInfo[], keeper: KeeperLink): Promise<void> {
    for (const info of listed) {
      if (!info.channel.startsWith(CLIENT_TERMINAL_PREFIX) || keeper.channels.has(info.channel)) continue;
      if (isAibInternalLabel(info.label)) continue; // AIB's own WSL hold or helper
      let chat = '';
      try {
        chat = String(JSON.parse(info.label ?? '{}').chat ?? '');
      } catch { /* no label */ }
      const owner = chat ? this.connections.get(chat) : undefined;
      if (owner && !owner.closed) continue; // a read-only chat keeps its agent's terminals as they are
      try {
        if (info.live) {
          announce('studio', 'keeper: stopping client terminal %s: its chat is gone', info.channel);
          await keeper.stopUnknown(client, info.channel);
        }
        await keeper.removeEnded(client, info.channel);
      } catch (error) {
        log.warning('keeper: could not remove client terminal %s: %s', info.channel, errorText(error));
      }
    }
  }

  /**
   * A keeper can hold two agents for one session (an earlier AIB that could not take its chat over started another one for it).
   * Both would be listed as the same chat twice. Keep the one that is working, else the first; the other agent is stopped (the
   * session's own transcript is shared, so nothing is lost). True when `c` was the one dropped.
   */
  async #dropDuplicate(c: Connection): Promise<boolean> {
    if (!c.sessionId || c.closed) return false;
    const other = [...this.connections.values()].find((o) =>
      o !== c && !o.closed && o.provider === c.provider && o.sessionId === c.sessionId
    );
    if (!other) return false;
    const loser = c.busy && !other.busy ? other : c;
    announce('studio', 'keeper: %s %s was running twice; stopping the %s one (%s)', c.provider, c.sessionId, loser === c ? 'second' : 'first', loser.id);
    try {
      await loser.close();
    } catch (error) {
      log.warning('keeper: could not stop the duplicate chat %s: %s', loser.id, errorText(error));
    }
    return loser === c;
  }

  async #rebuildChat(
    info: ChannelInfo,
    note: Json,
    keeper: KeeperLink,
    distro: string | null,
    timer = new PhaseTimer(),
  ): Promise<boolean> {
    const command = Array.isArray(note.command) ? note.command.map(String) : [];
    const cwd = String(note.cwd);
    const provider = String(note.provider);
    const options: ConnectionOptions = { keeper, id: String(note.id), rebuild: info, start: false, history: this.historyClient() };
    // A distro's keeper holds only that distro's chats: the note's loc (or its ref) says where the agent works; it starts nothing.
    const loc = isDict(note.loc) && note.loc.kind === 'wsl' && isStr(note.loc.linuxPath) ? note.loc : null;
    const wsl = distro ? (loc ? { distro, linuxPath: String(loc.linuxPath) } : wslLoc(cwd)) : null;
    if (distro && !wsl) {
      announce('studio', 'keeper: %s in %s has no WSL folder; not taken over', note.id, distro);
      return false;
    }
    if (wsl) {
      const host = wslHost(wsl.distro);
      const which = async (name: string) => host ? (await host.call('which', { name })).path : null;
      // the agent's later client terminals still run in the distro, with its environment
      options.wsl = { distro: wsl.distro, linuxPath: wsl.linuxPath, ...(host ? { caps: { env: () => host.env(), which } } : {}) };
    }
    const c = this.connectionFactory(command, cwd, provider, options);
    if (isDict(note.worktree)) c.worktree = { branch: String(note.worktree.branch ?? ''), base: String(note.worktree.base ?? '') };
    c.projectRoot = isStr(note.projectRoot) && note.projectRoot ? note.projectRoot : cwd;
    this.#wire(c);
    const helper = this.hasStateDir
      ? helperOf(readHelpers(this.stateDir), { lasting: isStr(note.resume) && note.resume ? `${provider}:${note.resume}` : null, path: cwd })
      : null;
    c.swarm = helper
      ? { role: 'helper', helperId: helper.id, parent: helper.parent.live }
      : c.worktree && (!wsl || WSL_TOOL_GROUPS.swarm)
      ? { role: 'main' }
      : null;
    c.mcpServers = Array.isArray(note.mcpServers) ? note.mcpServers as McpServer[] : [];
    if (wsl) for (const entry of c.mcpServers) ownTunnelEntry(entry); // its tunnel entry is still AIB's own tool after a restart
    c.sessionId = isStr(note.resume) && note.resume ? note.resume : null;
    c.recovery = this.recovery as never;
    this.connections.set(c.id, c);
    const label = `${provider} ${c.sessionId ?? ''} in ${cwd}`.replace('  ', ' ');
    timer.mark('setup');
    try {
      await c.rebuilt;
    } catch { /* read-only (rebuildError says why) or the keeper went away */ }
    rebuildPhases(timer, c.rebuildTimes);
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
      timer.mark('lease');
      if (this.recovery) {
        this.recovery.connectionReady(c);
        const saved = this.recovery.queues?.get(provider, c.sessionId) ?? [];
        if (saved.length) await c.queueContinue(saved); // the turn never stopped, so neither does its queue
      }
      this.announce(c, 'ready');
      timer.mark('queue and announce');
      if (this.wslSync && wsl) await this.wslSync.chatOpened(c); // its distro's helper watches it (never throws)
      else if (this.liveSync) {
        try {
          await this.liveSync.chatOpened(c);
        } catch (error) {
          log.exception(error, 'Starting live sync failed');
        }
      }
      timer.mark('live sync');
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
    const working = [...this.connections.values()].filter((c) =>
      !c.closed && (c.busy || !c.ready || c.permissions.size || c.helpersRunning?.() || c.backgroundShellsRunning?.())
    );
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
      this.reconnectWorkers.push(
        (async () => {
          for (let waited = 0; !c.closed && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
          await this.reconnectOne(item, RECONNECT_TRIES, 5);
        })().catch((error) => log.exception(error, 'keeper: reconnecting an interrupted chat failed')),
      );
    }
  }

  /**
   * Make the chat's worktree, then start its agent there. If the project cannot have one after all (too much uncommitted work, LFS
   * pointers, ...) the chat works in the project folder: it has not begun, so nothing is filed under another folder.
   */
  /**
   * The project's local-only lookup after setting up the default `/private` exclude (local_only.ensureDefault: idempotent, never
   * throws). null: not git, or a test Studio and a project outside the temp folder (local_strays.defaultsAllowed).
   */
  async #localOnlyDefault(project: string): Promise<LocalOnly | null> {
    if (!project || !defaultsAllowed(this.hasStateDir ? this.stateDir : '', project)) return null;
    try {
      return await ensureDefault(project);
    } catch (error) {
      log.exception(error, 'Setting up the local-only default of %s failed', project);
      return null;
    }
  }

  /**
   * What a chat is told about local-only files (Connection.localOnly). private/ only when git really ignores it (state 'on'); a
   * worktree chat gets the main folder's local-only paths, and the main folder's private/ is made (empty) so it can be granted as an
   * extra writable folder from the first message (owner Q4 a).
   */
  #localOnlyFor(c: Connection, lo: LocalOnly | null): Connection['localOnly'] {
    if (!lo) return null;
    const main = c.worktree ? c.projectRoot : c.cwd;
    if (realpath(main) !== realpath(lo.project)) return null; // the chat fell back to another folder
    const on = lo.defaultState === 'on';
    const told = lo.entries.filter((e) => on || e.toLowerCase() !== DEFAULT_ENTRY);
    const abs = (e: string) => join(lo.project, ...e.split('/'));
    const privateDir = on ? abs(lo.entries.find((e) => e.toLowerCase() === DEFAULT_ENTRY) ?? DEFAULT_ENTRY) : '';
    if (c.worktree && privateDir && !isdir(privateDir)) {
      try {
        Deno.mkdirSync(privateDir, { recursive: true });
      } catch (error) {
        log.warning('Could not make %s: %s', privateDir, errorText(error));
      }
    }
    if (!told.length && !privateDir) return null;
    return { entries: told.map(abs), dirs: told.map(abs).filter((p) => isdir(p)), private: privateDir };
  }

  async #makeWorktree(connection: Connection, plan: wt.Plan, project: string): Promise<void> {
    try {
      if (plan instanceof WslPlan) await wslCreate(plan); // made in the distro by its helper
      else await this.worktrees!.create(plan);
    } catch (error) {
      if (!(error instanceof wt.Fallback)) throw error;
      // a helper never falls back to the project folder (review break 5): the chat closes and the swarm marks it Failed
      if (connection.swarm?.role === 'helper') throw new ValueError(`The helper's worktree could not be made: ${error.message}`);
      if (plan instanceof WslPlan) connection.retarget(project, plan.raw.project);
      else connection.retarget(project);
      connection.projectRoot = project;
      connection.worktree = null;
    }
    if (connection.closed) {
      await this.#discardPlan(plan);
      throw new Error('The chat was closed while it was starting');
    }
    connection.startProcess();
  }

  /** Forget a plan's worktree: the Windows registry's, or (a WSL plan) the distro's. */
  async #discardPlan(plan: wt.Plan): Promise<void> {
    if (plan instanceof WslPlan) await wslDiscard(plan);
    else await this.worktrees!.discard(plan.key);
  }

  /** Swarm: a main chat is any open chat in its own worktree that the helper registry does not list (review option C). */
  #isMain(c: Connection): boolean {
    if (c.swarm?.role !== 'main' || !c.worktree) return false;
    if (!this.hasStateDir) return true;
    return !helperOf(readHelpers(this.stateDir), { live: c.id, lasting: c.sessionId ? `${c.provider}:${c.sessionId}` : null, path: c.cwd });
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
      reconnectFailed: this.reconnectFailed(),
      recoveryWarning: this.store ? this.store.warning : '',
      instanceId: this.instanceId,
      allowRulesTampered: this.allow ? this.allow.tampered() : false, // the page's "Allow rules are off" banner
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
    await Promise.race([adopting.catch(() => 0), new Promise((resolve) => (timer = setTimeout(resolve, ADOPT_WAIT_MS)))]);
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
    if (cursor === 0) void this.limits.refresh(connection); // a page opened this chat (at most once a minute per account)
    return Promise.resolve({ ...connection.public(cursor), limits: this.limits.view(connection) });
  }

  #history: HistoryClient | null | undefined;
  /**
   * The history Worker (history-loading 2A): one SQLite store per keeper chat in <state>/history. null without a state folder or with
   * the aib-history-v2 switch off (AIB_HISTORY_V2=0): snapshots then carry the history in chunk notes, as in beta.10.
   */
  historyClient(): HistoryClient | null {
    if (this.#history === undefined) {
      let dir: string | null = null;
      if (this.hasStateDir && historyV2() && !this.#closed) {
        try {
          dir = `${this.stateDir}/history`;
          Deno.mkdirSync(dir, { recursive: true });
        } catch (error) {
          log.warning('history: no store folder (%s); chats keep their history in the keeper notes', errorText(error));
          dir = null;
        }
      }
      this.#history = dir ? new HistoryClient(dir) : null;
    }
    return this.#history;
  }

  /**
   * One page of a chat's events (history loading, event_pages.ts): the tail by bytes, before= / after= / around= a seq, or one
   * helper's events (session=<its id>), with the page's boundary state. null when the connection is gone. While the chat is being
   * rebuilt from the keeper's record: an empty page with rebuilding: true (the page asks again, as with liveState).
   */
  liveEvents(connectionId: unknown, query: unknown = {}, wait = true): Promise<Json | null> {
    const connection = isStr(connectionId) ? this.connections.get(connectionId) : undefined;
    if (connection === undefined) {
      if (wait && this.#adopting && !this.#adoptDone && isStr(connectionId)) {
        return this.#afterAdopting().then(() => this.liveEvents(connectionId, query, false));
      }
      return Promise.resolve(null);
    }
    const q: PageQuery = pageQuery(isDict(query) ? query : {});
    if (connection.replaying && !connection.rebuildError && !connection.closed) {
      return Promise.resolve({ rebuilding: true, events: [], cursor: connection.sequence, eventsId: connection.eventsId });
    }
    const ram = page(connection.pageSource(), q);
    // Older than RAM keeps, or a helper RAM no longer holds: read from the chat's history store.
    const older = q.before !== undefined || q.around !== undefined || q.after !== undefined;
    const helper = !!q.session && q.session !== 'main' && q.session !== connection.sessionId;
    if (connection.historyState === 'claimed' && ((older && !ram.more && !ram.newer) || (helper && !ram.events.length) || (!older && !ram.more))) {
      return connection.storePage(q).then((stored) => {
        if (!stored) return ram as unknown as Json;
        if (!older && !helper) { // the open page: RAM's, but the history reaches back as far as the store does
          if (stored.first && (!ram.first || stored.first < ram.first)) ram.first = stored.first;
          ram.more = ram.more || (!!ram.from && !!stored.first && stored.first < ram.from);
          return ram as unknown as Json;
        }
        return (stored.events.length || !ram.events.length ? stored : ram) as unknown as Json;
      });
    }
    return Promise.resolve(ram as unknown as Json);
  }

  /** One event whole by seq (a clipped tool output's "Show full output"); null when the connection or the event is gone. */
  liveEvent(connectionId: unknown, seq: unknown): Promise<Json | null> {
    const connection = isStr(connectionId) ? this.connections.get(connectionId) : undefined;
    const n = Math.trunc(Number(seq));
    if (connection === undefined || !Number.isFinite(n)) return Promise.resolve(null);
    const kept = fullEvent(connection.pageSource(), n);
    if (kept || connection.historyState !== 'claimed') return Promise.resolve(kept as Json | null);
    return connection.storeEvent(n) as Promise<Json | null>;
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

  /**
   * Open connections that must not be cut off: working, still opening, waiting for a person, or idle with background helpers still
   * running ('helpers': a Claude Code turn ended while its helpers go on; stopping the agent would kill them), or with a background
   * shell still running ('background': a Bash command Claude Code started with run_in_background, such as a long test run; stopping
   * the agent would kill it). Neither of the last two shows as working in the chat or holds its queue.
   */
  busyList(): Json[] {
    const busy: Json[] = [];
    for (const c of [...this.connections.values()]) {
      const state = c.attention().state;
      if (state === 'working' || state === 'opening' || state === 'needs_you') {
        busy.push({ id: c.id, provider: c.provider, cwd: c.cwd, state });
      } else if (state === 'idle' && c.helpersRunning?.()) {
        busy.push({ id: c.id, provider: c.provider, cwd: c.cwd, state: 'helpers' });
      } else if (state === 'idle' && c.backgroundShellsRunning?.()) {
        busy.push({ id: c.id, provider: c.provider, cwd: c.cwd, state: 'background' });
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
      if (!c.closed && !listed.has(c.id) && c.queue.items.length) {
        working.push({ id: c.id, provider: c.provider, cwd: c.cwd, state: 'queued' });
      }
    }
    for (const [agent, job] of this.installer?.jobs ?? []) {
      if (job.alive) working.push({ id: `install:${agent}`, provider: agent, cwd: '', state: 'installing' });
    }
    for (const [agent, job] of this.signer?.jobs ?? []) {
      if (job.alive) working.push({ id: `signin:${agent}`, provider: agent, cwd: '', state: 'needs_you' });
    }
    return working;
  }

  busyConnections(): Promise<Json[]> {
    return Promise.resolve(this.busyList());
  }

  /**
   * How many chats are blocked on the person (an open request, a failed turn, a question in the last reply): the one number of
   * the inbox (inbox-rules.js), which both tray icons show. A running sign-in job is not a chat and does not count. openOnPc: the
   * chats open in the AIB window (Presence.openOnPc), left out of the desktop's count.
   */
  blockedChats(openOnPc: string[] = []): number {
    const open = [...this.connections.values()].filter((c) => !c.closed);
    const chats = open.map((c) => ({ provider: c.provider, sessionId: c.sessionId, attention: c.attention() }));
    return blockedCount(chats, this.conversations.public().entries as unknown as Record<string, unknown>, Date.now() / 1000, openOnPc);
  }

  studioOwns(provider: unknown, sessionId: unknown): Promise<boolean> {
    return Promise.resolve(this.#studioOwns(provider as string, sessionId as string));
  }

  ownershipQuery(provider = '', sessionId = '', cwd = ''): Promise<unknown> {
    try {
      if (!provider && !sessionId) {
        this.probe.refreshProcessesAsync();
        this.#refreshWslHints();
        // a WSL session's hints come from its distro (session ids never repeat across systems), the Windows ones win a clash. The
        // distro cannot tell AIB's own transcript writes: a chat this AIB runs, or released in the last two minutes, has none.
        const wsl: Record<string, unknown> = {};
        for (const [key, hint] of Object.entries(Object.assign({}, ...[...this.#wslHints.values()].map((h) => h.hints)))) {
          const at = key.indexOf(':');
          const [p, s] = [key.slice(0, at), key.slice(at + 1)];
          const released = this.probe.releasedAt(p, s);
          if (this.#studioOwns(p, s) || (released !== null && this.probe.clock() - released < ACTIVE_WINDOW_SECONDS)) continue;
          wsl[key] = hint;
        }
        return Promise.resolve({ hints: { ...wsl, ...this.probe.hints() }, certainty: this.probe.listCertainty() });
      }
      if (!agentRegistry.isProvider(provider) || !sessionId || pyLen(sessionId) > 512) {
        throw new ValueError('Choose a provider and a saved session ID');
      }
      const wsl = wslLoc(cwd);
      if (wsl) {
        if (this.#studioOwns(provider, sessionId)) return Promise.resolve(this.probe.assess(provider, sessionId)); // owned_by_studio
        return this.#wslAssess(provider, sessionId, wsl, null).then((answer) => answer.assessment);
      }
      if (isNetworkPath(cwd) || isForeignPath(cwd)) throw new ValueError('Network and device paths are not supported');
      return Promise.resolve(this.probe.assess(provider, sessionId, { cwd: cwd || null, fresh: true }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** The conversation list's ownership hints of each ready distro (`ownership.hints`), refreshed in the background every few seconds. */
  readonly #wslHints = new Map<string, { at: number; hints: Record<string, unknown> }>();
  #wslHintsRunning = false;

  #refreshWslHints(): void {
    if (this.#wslHintsRunning || this.#closed) return;
    const hosts = (wslHostsInUse()?.all() ?? []).filter((h) => h.state === 'ready');
    const now = Date.now();
    for (const key of [...this.#wslHints.keys()]) if (!hosts.some((h) => h.distro.toLowerCase() === key)) this.#wslHints.delete(key);
    const due = hosts.filter((h) => now - (this.#wslHints.get(h.distro.toLowerCase())?.at ?? 0) >= 5000);
    if (!due.length) return;
    this.#wslHintsRunning = true;
    void (async () => {
      for (const host of due) {
        const key = host.distro.toLowerCase();
        const hints = await wslOwnerHints(host, await wslOwnPids(host, this.#wslChatPids(key)));
        this.#wslHints.set(key, { at: Date.now(), hints });
      }
    })().finally(() => (this.#wslHintsRunning = false));
  }

  // ---- worktree removal (Discard, archive, delete) ------------------------------------------------------------------------
  /** The worktree record of a chat folder (or saved session): a WSL ref's is asked of its distro's helper (wsl/worktrees.ts). */
  async #worktreeRecord(path: string | null = null, session: string | null = null): Promise<(wt.WorktreeRecord & { key: string }) | null> {
    if (!this.worktrees) return null;
    if (path && wslLoc(path)) return await wslRecord(path, session, true);
    return this.worktrees.registry.find(path, session);
  }

  #connectionsIn(path: string): Connection[] {
    // a WSL ref is compared as the ref it is (never resolved on Windows)
    const here = wslLoc(path) ? (c: Connection) => c.cwd === path : (c: Connection) => wt.same(c.cwd, path);
    return [...this.connections.values()].filter((c) => !c.closed && here(c));
  }

  async #removeWorktree(record: wt.WorktreeRecord & { key: string }, confirmed: boolean): Promise<wt.RemoveOutcome> {
    return isWslRecord(record) ? await wslRemove(record, confirmed) : await this.worktrees!.remove(record.key, confirmed);
  }

  /**
   * Allow rules: the page-session calls (POST /api/live/allow/*; never an MCP tool or a phone route).
   *   allow-answer  {id, key, option, scope, saveOnly?}  answer the card and save its rule, in one call: the rule is saved only when
   *                 the answer went through; answered elsewhere -> 409 answered_elsewhere, and saveOnly then saves it anyway.
   *                 Waiting cards the rule now covers are answered too (sweep).
   *   allow-rules   the list for Settings; allow-remove / allow-restore {ruleId}; allow-review; allow-enable {on};
   *   allow-builtin {name, on}.
   */
  #allowCall(name: string, body: Json): [number, unknown] {
    const gate = this.allow;
    if (!gate) return [404, { error: 'Allow rules need a state folder' }];
    const store = gate.store;
    if (name === 'allow-rules') return [200, store.public()];
    if (name === 'allow-remove') return [200, { ok: store.remove(String(need(body, 'ruleId'))), ...store.public() }];
    if (name === 'allow-restore') return [200, { ok: store.restore(String(need(body, 'ruleId'))), ...store.public() }];
    if (name === 'allow-review') {
      store.review();
      return [200, { ok: true, ...store.public() }];
    }
    if (name === 'allow-enable') {
      store.setEnabled(body.on === true);
      return [200, { ok: true, ...store.public() }];
    }
    if (name === 'allow-builtin') {
      const which = String(need(body, 'name'));
      if (!['safeReads', 'syntax', 'scratch'].includes(which)) throw new ValueError('Unknown built-in rule');
      store.setBuiltin(which as 'safeReads', body.on === true);
      return [200, { ok: true, ...store.public() }];
    }
    if (name !== 'allow-answer') return [404, { error: 'Not found' }];
    const c = this.#connection(body);
    const key = String(need(body, 'key'));
    const scope = body.scope === 'global' ? 'global' : 'project';
    const found = c.allowPending(key);
    if (!found) throw new ValueError('Unknown approval');
    const draft = isDict(found.draft) ? found.draft[scope] : null;
    if (!isDict(draft) || draft.available !== true || !Array.isArray(draft.rules) || !draft.rules.length) {
      return [400, { error: isDict(draft) && isStr(draft.reason) && draft.reason ? draft.reason : 'No rule can be made from this request' }];
    }
    if (!body.saveOnly) {
      if (!found.waiting) return [409, { error: 'This request was already answered elsewhere. Save the rule anyway?', code: 'answered_elsewhere' }];
      const option = body.option;
      const options = Array.isArray(found.params.options) ? found.params.options : [];
      const chosen = options.find((o) => isDict(o) && o.optionId === option);
      if (!isDict(chosen) || chosen.kind !== 'allow_once') throw new ValueError('Always allow goes with an allow-once answer');
      try {
        c.permission(key, option);
      } catch (error) {
        if (error instanceof Error && /stale|no longer|answered/i.test(error.message)) {
          return [409, { error: 'This request was already answered elsewhere. Save the rule anyway?', code: 'answered_elsewhere' }];
        }
        throw error;
      }
    }
    const saved = (draft.rules as Json[]).map((r) => store.add({ ...r, from: 'card' } as never));
    let also = 0;
    const project = c.projectRoot || c.cwd;
    for (const other of this.connections.values()) {
      if (scope === 'project' && (other.projectRoot || other.cwd).toLowerCase() !== project.toLowerCase()) continue;
      try {
        also += other.allowSweep();
      } catch (error) {
        log.exception(error, 'Allow rules: answering waiting cards failed');
      }
    }
    return [200, { ok: true, rules: saved, alsoAllowed: also }];
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
    const record = await this.#worktreeRecord(connection.cwd);
    if (!record) throw new ValueError('This chat has no worktree of its own');
    await connection.close(); // closes the connection, kills the agent's process tree and any client terminals
    connection.tree?.kill();
    const outcome = await this.#removeWorktree(record, true);
    if (connection.scratchDir && this.allow) this.allow.removeScratch(connection.scratchDir); // allow rules: the scratch folder goes with it
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
    const record = await this.#worktreeRecord(path, session);
    if (!record) return { ok: true, worktree: null };
    const branch = record.branch ?? '';
    if (this.#connectionsIn(String(record.path)).length) return { ok: true, worktree: { branch, removed: false, live: true } };
    const changed = isWslRecord(record) ? await wslHasChanges(record) : await this.worktrees!.hasChanges(record);
    if (changed) return { ok: true, worktree: { branch, removed: false, keptChanges: true } };
    const outcome = await this.#removeWorktree(record, false);
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
        // Every agent is asked at once (each check has its own timeout), so the answer takes as long as the slowest one, not the sum
        // (one after another this took ~29 s). Beta agents: only the turned-on ones are asked (a check starts the agent once, hidden).
        const signer = this.signer, beta = this.betaSigner;
        const ids = [
          ...Object.keys(adapters.STUDIO_PACKAGES).map((a) => [a, signer.check(a, !!force)] as const),
          ...agentRegistry.BETA_IDS.filter((a) => this.settings.betaEnabled(a)).map((a) => [a, beta.check(a, !!force)] as const),
        ];
        const answers = await Promise.all(ids.map(([, done]) => done));
        const agents: Json = {};
        ids.forEach(([a], i) => (agents[a] = answers[i]));
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
        helperOf: readHelperOf(body.helperOf),
      });
      return [200, connection.public()];
    }
    if (name.startsWith('allow-')) return this.#allowCall(name, body); // allow rules: page-session routes only (web/live_routes.ts)
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
    if (name === 'swarm-note') { // internal (swarm/service.ts): a swarm line in the main chat; not in LIVE_POST_OPS, so no page route
      const connection = this.#connection(body);
      const kind = String(body.kind ?? '');
      if (!SWARM_NOTE_KINDS.includes(kind)) throw new ValueError('Unknown swarm note');
      const data: Json = {
        message: [...String(need(body, 'message'))].slice(0, 300).join(''),
        sessionId: connection.sessionId,
        kind,
        helper: String(body.helper ?? '').slice(0, 20),
      };
      const actions = (Array.isArray(body.actions) ? body.actions : []).filter((a) => isDict(a) && SWARM_NOTE_ACTIONS.includes(String(a.id)))
        .map((a) => ({ id: (a as Json).id, label: SWARM_ACTION_LABELS[String((a as Json).id)], helper: data.helper }));
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
    if (name === 'steer') { // send now while the agent works (steer-on-send); idle: an ordinary prompt
      const result = await connection.steer(text, messageId, attachments);
      if (connection.provider && connection.sessionId && !result.duplicate) await this.#mark('handled', connection); // replying is acting
      return [200, { ok: true, ...result }];
    }
    if (name === 'tool-stop') { // Stop on a "Still running in the background" row
      try {
        return [200, await connection.stopBackgroundTool(need(body, 'toolCallId'))];
      } catch (error) {
        if (error instanceof NotStoppable) return [409, { error: error.message, code: 'not_stoppable' }];
        throw error;
      }
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
    } else if (name === 'cancel-pending') return [200, { ok: true, pendingChanges: connection.cancelPending(need(body, 'key')) }];
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
   * Can quitting AIB leave every working chat in the keeper, held there until an AIB is started again (keeper 1.3.0 `hold`)? ''
   * when yes; otherwise why not (the keeper is off, a working chat runs outside it, the running keeper is too old to hold).
   */
  async quitHandover(): Promise<string> {
    const why = this.keeperHandover();
    if (why) return why;
    let client: KeeperClient | null = null;
    try {
      client = await this.keeper!.client(false);
    } catch (error) {
      return `the keeper cannot be reached (${errorText(error)})`;
    }
    if (client && !client.has('hold')) return `the running keeper (${client.keeperVersion || 'unknown version'}) cannot hold chats`;
    return '';
  }

  /**
   * Exit for an update (or a restart) without touching the chats that run in the keeper: they keep running and recording, and the
   * next AIB rebuilds them from the keeper's record (adoptKeeper) and claims them. Everything else is stopped as in close(): chats
   * outside the keeper are closed, live sync and timers stop. Their session leases are released, the recovery list keeps them, and
   * no receipt is marked "unknown" (the turns go on). Returns how many chats were left running in the keeper.
   */
  async release(options: { hold?: boolean } = {}): Promise<number> {
    if (this.#closed) return 0;
    this.#closed = true;
    this.#untunnel?.();
    if (this.liveSync) await this.liveSync.stopAll().catch((error) => log.exception(error, 'Stopping live sync failed'));
    this.wslSync?.stopAll(); // the helpers go on syncing the WSL chats that keep running
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#limitsTimer !== null) clearInterval(this.#limitsTimer);
    this.#limitsTimer = null;
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
    if (this.#mcpHttp) await this.#mcpHttp.close(!!options.hold); // hold: the forwarder answers "AIB is closed" at once
    await this.#quitWsl();
    if (options.hold) await holdKeeper(this.keeper); // last thing before leaving (a no-op when main.ts already said it)
    this.keeper?.disconnect(); // the keeper keeps the agents; whoever connects next (the update helper, then the new AIB) is its client
    await this.#stopHistory(); // the next AIB opens the kept chats' stores (Windows cannot delete or reopen a file a live handle holds)
    announce(
      'studio',
      'released %s chat(s) to the keeper; %s closed%s',
      kept.length,
      others.length,
      options.hold ? '; the keeper holds them until AIB is started again' : '',
    );
    return kept.length;
  }

  /** Stop everything this Studio runs. The recovery list is kept (orderly shutdown), so the next start can reconnect. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#untunnel?.();
    if (this.deliberateStop && this.store) {
      for (const c of this.connections.values()) {
        if (!c.sessionId) continue;
        for (const [id, r] of c.promptReceipts) {
          if (r.state === 'working' && r.sent) this.store.setReceipt(c.provider, c.sessionId, id, r.fingerprint, 'finished');
        }
      }
    }
    if (this.liveSync) await this.liveSync.stopAll().catch((error) => log.exception(error, 'Stopping live sync failed'));
    this.wslSync?.stopAll(); // the helpers go on syncing the WSL chats that keep running
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    if (this.#limitsTimer !== null) clearInterval(this.#limitsTimer);
    this.#limitsTimer = null;
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
    if (this.wslSync) await this.wslSync.finish(); // every chat was stopped: the helpers stop watching them
    await this.#quitWsl(3000); // every chat was just stopped: give their channels a moment to end
    this.keeper?.disconnect(); // with no client and no live channel the keeper exits by itself
    await this.#stopHistory();
  }

  /** The history Worker's last writes run, then every store closes and the Worker stops (close and release). */
  async #stopHistory(): Promise<void> {
    const history = this.#history;
    this.#history = null;
    if (history) {
      await Promise.all([...this.connections.values()].map((c) => c.historySettled().catch(() => {})));
      await history.shutdown().catch((error) => log.warning('history: stopping the store worker failed: %s', errorText(error)));
    }
  }

  /**
   * The WSL side of leaving (design section 11 item 1), before the Windows keeper link closes: per distro the keep-alive is stopped
   * unless WSL agents or shells still run there, and the transports end. With some left running the Windows keeper is told `hold`,
   * so it keeps the keep-alive (and with it those agents) until the next AIB takes them over. Never throws.
   */
  async #quitWsl(settleMs = 0): Promise<void> {
    const hosts = wslHostsInUse();
    if (!hosts) return;
    try {
      const { live, held } = await hosts.quit({ settleMs });
      if (live > 0 && held.length) {
        const holding = await holdKeeper(this.keeper);
        announce('studio', 'wsl: %s agent(s) or shell(s) keep running in %s%s', live, held.join(', '), holding ? '; the keeper holds them' : '');
      }
    } catch (error) {
      log.warning('wsl: leaving the distros failed: %s', errorText(error));
    }
  }
}

/**
 * Tell the keeper this AIB leaves on purpose (the person quit with work running): it runs no orphan restart and never stops the
 * channels as orphaned until the next AIB takes them over (keeper 1.3.0 `hold`). Only an already connected keeper; never throws. True when
 * the keeper holds.
 */
export async function holdKeeper(link: KeeperLink | null | undefined): Promise<boolean> {
  if (!link) return false;
  try {
    const client = await link.client(false);
    if (!client?.has('hold')) return false;
    await client.hold();
    return true;
  } catch (error) {
    log.warning('keeper: hold failed: %s', errorText(error));
    return false;
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
