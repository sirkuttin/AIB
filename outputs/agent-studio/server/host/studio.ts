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
import {
  Connection,
  type ConnectionOptions,
  type ContinueStore,
  errorText,
  historyV2,
  MAX_EVENTS,
  NotStoppable,
  SHARED_FOLDER_CONTEXT,
  sharedFolderNote,
  ThreadEvent,
} from '../acp/connection.ts';
import { HistoryClient } from '../history/client.ts';
import { ConversationLines } from '../history/lines.ts';
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
import { AgentTitles } from './agent_titles.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { artifactToolCommand } from '../artifacts/mcp.ts';
import { ArtifactMcpHttp, FORWARD_FILE, forwardEntry, httpEntry, ownForwardFile, ownTunnelEntry, tunnelEntry } from '../artifacts/mcp_http.ts';
import { WSL_TOOL_GROUPS } from '../artifacts/mcp.ts';
import { mcpTunnelGate, type TunnelAnswer } from '../wsl/mcp_tunnel.ts';
import { forwarderOf, hookForwarderOf, keeperBinary, programVersion } from '../keeper/client.ts';
import { deny as denyHook, type HookAnswer, SubagentWorktrees, type SubagentChat } from '../subagents/service.ts';
import { claudeConfigDir, gitBashPath, hookSettings, readClaudeSetup, subagentsOffSettings } from '../subagents/claude_config.ts';
import * as codexSub from '../subagents/codex.ts';
import * as gemini from '../subagents/gemini.ts';
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
import { isDict, isStr, pyLen, pyRepr, pyStrip, ValueError } from '../core/py.ts';
import { findExternalOwner, OwnershipConflict, probeExternalOwner, SessionLease } from '../ownership/ownership.ts';
import {
  ACTIVE_WINDOW_SECONDS,
  type Assessment,
  folderOnlyEvidence,
  folderOnlyNote,
  HEARTBEAT_SECONDS,
  OwnerRegistry,
  OwnershipEvidence,
  OwnershipProbe,
} from '../ownership/probe.ts';
import { Handoff } from '../ownership/handoff.ts';
import type { Holder } from '../ownership/claude_sessions.ts';
import { mergeAssessment, wslOwnerCheck, wslOwnerHints, wslOwnPids, wslSessionsHeld } from '../wsl/ownership.ts';
import { expandUser } from '../platform/pypath.ts';
import { home, isdir, join, normcase, realpath } from '../platform/ospath.ts';
import { Recovery, StateStore } from '../state/recovery.ts';
import { ConversationState, ProjectPrefs, ReadState, SettingsStore } from '../state/store.ts';
import { builtinLaunch } from '../web/shared.ts';
import { isNetworkPath } from '../web/security.ts';
import { isForeignPath } from '../platform/location.ts';
import * as wt from '../worktrees/worktrees.ts';
import { movedTo as movedChatTo } from '../state/moved_chats.ts';
import { applyProject as cleanupApply, dropChatRefs, logLine as cleanupLog } from '../worktrees/cleanup.ts';
import { LiveSync, Mutex } from '../worktrees/sync.ts';
import { chatLocalOnly, ensureDefault, type LocalOnly } from '../worktrees/local_only.ts';
import { wslChatLocalOnly, wslDefaultsAllowed, wslEnsureLocalOnly } from '../wsl/local_only.ts';
import { helperOf, readHelpers, Registry as HelperRegistry } from '../swarm/registry.ts';
import { swarmEnabled } from '../swarm/settings.ts';
import { defaultsAllowed } from '../worktrees/local_strays.ts';
import { isFixture, testHomeEnv, type WslSpawn } from '../acp/connection.ts';
import { normLinuxPath, refOf, type WslLoc, wslLocOf } from '../platform/location.ts';
import { heldDistro, isAibInternalLabel } from '../keeper/link.ts';
import {
  distroName,
  hostWhenReady,
  linkOf,
  readyHost,
  windowsPathInWsl,
  WSL_TOOLS_NOTICE,
  wslHost,
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
import { sameProject } from '../allow/matcher.ts';

const log = getLogger('studio');

type Json = Record<string, unknown>;

export const ARTIFACT_URL_FILE = 'artifact-web.json'; // the web server writes its URL here so agents find it after a restart
export const CLOSED_GRACE_SECONDS = 10 * 60; // a closed connection stays listed this long so the page can still show "disconnected"
export const MAX_CLOSED_CONNECTIONS = 20; // ...and never more than this many closed ones are kept (oldest go first)
export const STOPPED_HELPER_DAYS = 7; // a stopped or failed helper's copy goes this long after it stopped (nothing unmerged; build plan 1b 5.3)
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
  /**
   * Owner decision 2026-11-16: there is no per-chat Own copy. Every new chat works in the project folder; only helpers get a copy.
   * Tests only: true makes a new chat in its own copy, as AIB did before, so they can stand in for a chat made then (those keep
   * their copy, Merge and Discard). The web connect route never passes it (it ignores body.ownCopy, see readOwnCopy) unless the
   * server runs with AIB_TEST_COPY_CHATS=1. A saved chat (resume) and a helper ignore it.
   */
  ownCopy?: boolean | null;
}

/** Marks the token of the combined prompt note (Studio #wire), so a token from elsewhere is never taken for one. */
const OWN_CONTEXT = '__aibOwnContext';
/** How long a landing lock lasts without a renewal (build plan 2.3: the web process renews it every 10 s while the merge runs). */
export const LANDING_TTL_MS = 60_000;

/**
 * body.ownCopy of a connect request. Owner decision 2026-11-16: no per-chat Own copy, so it is ignored (null) with a log line, and
 * a page from before the change that still sends it is not refused. Only a test server (AIB_TEST_COPY_CHATS=1) takes true, to
 * make a copy chat like the ones made before the change.
 */
export function readOwnCopy(value: unknown, testCopies = Deno.env.get('AIB_TEST_COPY_CHATS') === '1'): boolean | null {
  if (value === undefined || value === null) return null;
  if (testCopies && typeof value === 'boolean') return value;
  console.error(`Connect: ownCopy ${JSON.stringify(value)} ignored (every new chat works in the project folder)`);
  return null;
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
  /** Open elsewhere (ownership/handoff.ts): lets go of a Claude chat another app opened, takes it back when the person returns. */
  readonly handoff: Handoff;
  heartbeatSeconds = HEARTBEAT_SECONDS;
  readonly store: StateStore | null;
  readonly recovery: Recovery | null;
  readonly conversationLines: ConversationLines | null;
  readonly conversations: ConversationState;
  readonly projectPrefs: ProjectPrefs;
  readonly readState: ReadState;
  readonly settings: SettingsStore;
  readonly worktrees: wt.Manager | null;
  /** Subagent worktrees (subagents/service.ts): AIB's side of Claude chats' hooks; null without a state folder. */
  readonly subagents: SubagentWorktrees | null;
  /** Subagent worktrees, Gemini (subagents/gemini.ts): who is calling (from the ACP stream) and the BeforeTool hook route. */
  readonly geminiSubagents: gemini.GeminiSubagents | null;
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
  /** Chat names given in AIB, given to the agent's own session too (host/agent_titles.ts). */
  readonly agentTitles: AgentTitles;
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
  /** One-time <studio-context> lines per live chat id (addPromptContext), sent with its next prompt. */
  readonly #ownContext = new Map<string, string[]>();
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
      liveHolder: (provider, sessionId) => this.handoff.savedHolder(provider, sessionId),
    });
    this.handoff = new Handoff({
      connections: () => this.connections.values(),
      wslHeld: (distro, sessionIds, chatPids) => this.#wslHeld(distro, sessionIds, chatPids),
    });
    const name = construct.port !== undefined && construct.port !== null ? construct.port : options.port ?? 0;
    // Recovery state is kept only when a state directory was configured explicitly.
    this.store = this.hasStateDir ? new StateStore(this.stateDir, `recovery-${name}`) : null;
    this.addedProjects = this.hasStateDir ? new AddedProjects(this.stateDir) : null;
    this.allow = this.hasStateDir ? new AllowGate(this.stateDir) : null;
    // AIB's own lines (turn ends, notes) kept by conversation, so a chat rebuilt under another id shows them (history/lines.ts)
    this.conversationLines = this.hasStateDir ? new ConversationLines(join(this.stateDir, 'conversation-lines')) : null;
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
    this.agentTitles = new AgentTitles({
      live: (provider, sessionId) =>
        [...this.connections.values()].find((c) => c.provider === provider && c.sessionId === sessionId && !c.closed) ?? null,
      rename: (provider, sessionId, title, cwd) => this.#renameInAgent(provider, sessionId, title, cwd),
    });
    // The usage checker also runs on its own, once a minute for every open chat (not only when a chat opens or a turn ends)
    this.#limitsTimer = setInterval(() => {
      if (this.#closed) return;
      for (const c of this.connections.values()) if (!c.closed) void this.limits.refresh(c);
    }, construct.limitsEveryMs ?? REFRESH_SECONDS * 1000);
    Deno.unrefTimer(this.#limitsTimer);
    const manager = this.hasStateDir ? new wt.Manager(this.stateDir) : null; // worktree per chat (hidden flag)
    this.worktrees = manager;
    const subagents = manager ? new SubagentWorktrees(this.stateDir, manager.registry.root, (id) => this.#subagentChat(id)) : null;
    this.subagents = subagents;
    this.geminiSubagents = subagents ? new gemini.GeminiSubagents(subagents, (id) => this.#geminiChat(id)) : null;
    this.ready = (async () => {
      if (!manager) return;
      try {
        await manager.cleanupIncomplete(); // a half-made worktree of a process that died
        await manager.retryPending(); // removals that were pending (a file in use) + git worktree prune
        await subagents?.sweep(); // spare / unused subagent worktrees of chats that are gone
        // no keeper: no Gemini chat can still be running, so their folders go (with a keeper: after its take-over, #takeOver...)
        this.#sweepGeminiWithoutKeeper(manager.registry.root);
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
    // a prepared subagent worktree no Agent call took becomes the spare, or goes (bound ones stay for landing: P2); P3: what the
    // stream shows as ended is settled (a killed one, or one whose SubagentStop never reached AIB)
    this.geminiSubagents?.turnOver(connection.id); // a Gemini subagent call whose end never came is stopped
    if (this.subagents) {
      if (connection.provider === 'claude') {
        await this.subagents.reconcileEnded(connection.id, connection.endedSubagents()).catch((error) => log.exception(error, 'Subagent turn end check failed'));
      }
      await this.subagents.turnEnded(connection.id).catch((error) => log.exception(error, 'Subagent turn end failed'));
    }
    if (connection.provider && connection.sessionId) await this.#mark('your_turn', connection);
    if (connection.sessionId) this.agentTitles.turnEnded(connection.provider, connection.sessionId); // a name that waited for the turn
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
  async #wslCheckOwnership(provider: string, sessionId: string, wsl: { distro: string; linuxPath: string }, projectRoot: string | null, continueAnyway: boolean): Promise<Assessment> {
    const { owner, assessment } = await this.#wslAssess(provider, sessionId, wsl, projectRoot);
    if (owner !== null) {
      throw new OwnershipConflict(
        `This ${provider} conversation is already open in another agent process (PID ${owner}). Stop it in its current client before continuing here.`,
      );
    }
    return this.#refuseByVerdict(assessment, continueAnyway);
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

  /** A WSL chat's open-elsewhere check: its distro's helper reads Claude Code's session registry there ({} when it cannot). */
  async #wslHeld(distro: string, sessionIds: string[], chatPids: number[]): Promise<Record<string, Holder>> {
    try {
      const host = readyHost(distro);
      return await wslSessionsHeld(host, sessionIds, await wslOwnPids(host, chatPids));
    } catch {
      return {};
    }
  }

  announce(connection: Connection, state: string | null = null): void {
    if (!this.owners || !connection.sessionId || connection.closed || connection.elsewhere?.released) return;
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

  /**
   * Throw OwnershipEvidence unless the conversation may be opened; the assessment otherwise. The command-line probe has run already.
   * Folder-only evidence (probe.ts folderOnlyEvidence) does not ask: connect() continues and notes it in the chat.
   */
  checkOwnership(provider: string, sessionId: string, cwd: string, continueAnyway = false, fresh = true): unknown {
    return this.#refuseByVerdict(this.probe.assess(provider, sessionId, { cwd, skipCmdline: true, fresh }), continueAnyway);
  }

  #refuseByVerdict(verdict: Assessment, continueAnyway: boolean): Assessment {
    // Open elsewhere: when the only strong sign is Claude Code's session registry (another app has it open), the person may open it
    // here anyway, as VS Code offers; any other strong sign still refuses
    const strongs = verdict.reasons.filter((r) => r.strength === 'strong');
    if (verdict.verdict === 'owned_elsewhere' && strongs.every((r) => r.signal === 'session-registry')) {
      if (continueAnyway) return verdict;
      throw new OwnershipEvidence(
        `${strongs[0].text} Close it there first, or open it here anyway (two apps writing to one chat can mix up its messages).`,
        'possibly_active',
        verdict,
      );
    }
    if (verdict.verdict === 'owned_elsewhere') {
      const strong = verdict.reasons.find((r) => r.strength === 'strong')!.text;
      throw new OwnershipEvidence(`${strong} Stop it in its current client before continuing here.`, 'session_in_use', verdict);
    }
    if (verdict.verdict === 'possibly_active' && !continueAnyway && !folderOnlyEvidence(verdict)) {
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
        reconnecting: this.reconnectPending.has(key) || this.#takeOverPending(item.cwd),
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
        // the keeper's MCP forwarder reads it, and every Claude chat's hook forwarder (subagent worktrees), in the keeper or not
        addressFile: join(this.stateDir, FORWARD_FILE),
        hook: (event, conversation, body) => this.#hookCall(event, conversation, body),
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
   * mcp.ts WSL_TOOL_GROUPS (artifacts by content or Linux path, docs, merge in its own worktree; no swarm tools yet).
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
      return { servers: [tunnelEntry(tunnel.forwarder, tunnel.socket, key, conversationId) as unknown as McpServer], notice: '' };
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
    return { servers: [entry as unknown as McpServer], notice: '' };
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
    // A WSL chat's agent lives in its distro and knows only that distro's sessions (Linux cwds): it never answers for Windows
    // projects, and a WSL project is asked only of a running agent in its own distro (its sessions' cwds become refs again).
    const wslLoc = wslLocOf(cwd);
    if (wslLoc) return await this.#listWslSessions(provider, wslLoc, (cursor as string) || null);
    const live = [...this.connections.values()].find((c) => c.provider === provider && c.ready && !c.closed && !c.wsl);
    if (live) return { ...(await live.listSessions((cwd as string) || null, (cursor as string) || null)), via: 'studio-connection' };
    const probe = this.connectionFactory(command, home(), provider);
    try {
      await probe.initializeForDiscovery();
      return { ...(await probe.listSessions((cwd as string) || null, (cursor as string) || null)), via: 'temporary-process' };
    } finally {
      await probe.close();
    }
  }

  /**
   * Name a saved session in the agent's own list (host/agent_titles.ts): a short-lived adapter process of the chat's agent, in its
   * distro for a WSL chat, asks for `_session/rename`. Never loads the session or prompts it. False when the agent does not offer it.
   */
  async #renameInAgent(provider: string, sessionId: string, title: string, cwd: string): Promise<boolean> {
    const loc = cwd ? wslLocOf(cwd) : null;
    let probe: Connection;
    if (loc) {
      const launch = await this.wslLaunch(provider, loc);
      const options: ConnectionOptions = { keeper: launch.link, wsl: launch.spawn };
      if (Object.keys(launch.extra).length) options.env = launch.extra;
      probe = this.connectionFactory(launch.command, refOf(loc), provider, options);
    } else {
      const [command, env] = await this.agentLaunch(provider);
      const folder = cwd && !isForeignPath(cwd) && isdir(cwd) ? realpath(expandUser(cwd)) : home();
      probe = Object.keys(env).length
        ? this.connectionFactory(command, folder, provider, { env })
        : this.connectionFactory(command, folder, provider);
    }
    try {
      return await probe.renameSessionTitle(sessionId, title);
    } finally {
      await probe.close();
    }
  }

  /** "Find more chats via agent" for a WSL project: a running chat of the agent in that distro, else a clean empty answer. */
  async #listWslSessions(provider: string, loc: WslLoc, cursor: string | null): Promise<Json> {
    const live = [...this.connections.values()].find((c) =>
      c.provider === provider && c.ready && !c.closed && c.wsl?.distro.toLowerCase() === loc.distro
    );
    if (!live) {
      const note = `Open a ${provider === 'claude' ? 'Claude Code' : 'OMP'} chat in ${distroName(loc.distro)} first: ` +
        'AIB asks a running agent there and never starts one to list chats.';
      return { supported: true, sessions: [], nextCursor: null, via: 'none', note };
    }
    const answer = await live.listSessions(loc.linuxPath, cursor);
    const sessions = Array.isArray(answer.sessions) ? answer.sessions : [];
    for (const s of sessions as Json[]) {
      const path = normLinuxPath(s.cwd);
      s.cwd = path ? refOf({ kind: 'wsl', distro: loc.distro, linuxPath: path }) : '';
    }
    answer.sessions = (sessions as Json[]).filter((s) => s.cwd);
    return { ...answer, via: 'studio-connection' };
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
    // Build plan 1b, 4.4 (MF 4): an old copy chat that the owner's migration script moved to its project folder carries on there
    // (state/moved_chats.ts, read only). Read first, so a page that still sends the copy path lands there too. A WSL chat's mapping
    // is a ref of its distro's project folder.
    const movedTo = resume && this.hasStateDir ? movedChatTo(this.stateDir, provider, resume) : null;
    const movedWsl = movedTo ? wslLoc(movedTo) : null;
    if (movedWsl) {
      wsl = movedWsl;
      workspace = refOf({ kind: 'wsl', ...movedWsl });
    } else if (movedTo && !wsl && isdir(movedTo)) workspace = realpath(movedTo);
    else if (!wsl && this.worktrees && this.worktrees.isRemoved(workspace, resume ? `${provider}:${resume}` : null)) {
      throw new wt.WorktreeGone(wt.GONE_MESSAGE); // discarded (or being removed): readable, not continuable
    }
    let record: (wt.WorktreeRecord & { key: string }) | null = !wsl && this.worktrees && !movedTo ? this.worktrees.forChat(provider, resume, workspace) : null; // a chat that has a worktree keeps it
    if (record) workspace = realpath(await this.worktrees!.ensure(record)); // made again from its branch if deleted
    if (!wsl && !isdir(workspace)) throw new ValueError('Choose an existing workspace folder');
    if (!agentRegistry.isProvider(provider)) throw new ValueError('Choose an agent');
    const launch = wsl ? await this.wslLaunch(provider, wsl, !resume, !!resume && !options.auto) : null;
    if (launch && this.worktrees && !movedWsl) {
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
    // Owner decision 2026-11-16: every new chat works in the project folder (no per-chat Own copy, no pre-set; the hidden
    // worktreePerChat setting no longer decides either); a helper always gets its own copy. ownCopy: tests only (ConnectOptions).
    // `working`: another folder chat working here now, for the shared-folder start note and context line (#sharedFolderStart).
    const working = resume === null && !asHelper ? this.folderChatWorking(workspace) : null;
    const wantsCopy = resume === null && !!this.worktrees && (!!asHelper || options.ownCopy === true);
    if (wantsCopy) {
      const kind = asHelper ? 'helper' : 'chat';
      // Build plan 2.4 (MF 7): a helper of a chat that works in the project folder starts from the folder's branch, with the folder's
      // uncommitted edits (the main agent's too), and lands there (landOn in its worktree record). No WSL part: WSL has no swarm.
      const parentChat = asHelper ? this.connections.get(asHelper.parent) : undefined;
      const folderParent = !!parentChat && !parentChat.closed && !parentChat.worktree && parentChat.swarm?.role !== 'helper';
      const planned = wsl
        ? await wslPlanWithReason(workspace, kind)
        : await this.worktrees!.planWithReason(workspace, null, kind, folderParent ? { onFolderBranch: true } : {}); // no plan: works in place
      plan = planned.plan;
      startNote = wt.inPlaceNote(planned.reason);
      // a helper never works in the project folder (review break 5)
      if (asHelper && !plan) throw new ValueError(`This project cannot make a worktree for a helper: ${planned.reason || 'unknown reason'}`);
    }
    const lease = resume ? await new SessionLease(this.stateDir, provider, resume).acquire() : null;
    let connection: Connection | null = null;
    let ownerNote: string | null = null; // folder-only evidence: continued without asking, said in the chat
    try {
      // The ownership check reads Windows processes and transcripts; a WSL agent's are inside the distro, so its helper checks there.
      if (resume && wsl) {
        const project = record ? wslLoc(String(record.project ?? ''))?.linuxPath ?? null : null;
        ownerNote = folderOnlyNote(await this.#wslCheckOwnership(provider, resume, wsl, project, continueAnyway));
      } else if (resume) {
        const owner = await this.ownerProbe(provider, resume, [Deno.pid]);
        if (owner !== null && owner !== undefined) {
          throw new OwnershipConflict(
            `This ${provider} conversation is already open in another agent process (PID ${owner}). Stop it in its current client before continuing here.`,
          );
        }
        ownerNote = folderOnlyNote(this.checkOwnership(provider, resume, workspace, continueAnyway));
      }
      if (ownerNote) log.info('ownership: %s %s continued with folder-only evidence: %s', provider, resume, ownerNote);
      // the keeper this chat's agent runs in (a WSL chat: its distro's Linux keeper, whatever the Windows keeper's state)
      const chatKeeper = launch ? launch.link : this.keeper && this.keeperForNew && await this.#keeperUsable() ? this.keeper : null;
      // Owner rule 2026-11-17 (a conversation is one chat; its history is permanent): a conversation whose chat has a history store
      // reopens as that chat, same id, going on in its store (after an idle quit, a crash, a lost keeper, an update, Continue).
      const reopen = resume && chatKeeper && !asHelper ? await this.#storeToContinue(provider, resume, chatKeeper) : null;
      const chatId = reopen?.id ?? null;
      // Subagent worktrees (subagents/): a Claude chat in a git project gets command hooks through the keeper's forwarder; its key and
      // id go in the agent's environment (never in settings, a command line or a URL). A WSL chat gets none yet (they'd fail open).
      // Codex (subagents/codex.ts): its hooks go in CODEX_CONFIG; hooks off or unavailable turn its subagents off instead.
      const subagent = provider === 'claude'
        ? await this.#subagentHooks(command, plan ? plan.path : workspace, workspace, !!plan, env, !!wsl, chatId)
        : provider === 'codex'
        ? await this.#codexSubagentHooks(
          command,
          plan ? plan.path : workspace,
          workspace,
          !!plan,
          env,
          launch ? launch.spawn.env ?? {} : null,
          chatId,
        )
        : null;
      // Gemini (subagents/gemini.ts): every chat gets the fence (an admin policy); an API-key chat in a git project also the redirect
      const gem = provider === 'gemini'
        ? await this.#geminiSubagents(plan ? plan.path : workspace, workspace, !!plan, env, !!wsl, chatId)
        : null;
      const connectionOptions: ConnectionOptions = {};
      const agentEnv = { ...env, ...subagent?.env, ...gem?.env };
      if (Object.keys(agentEnv).length) connectionOptions.env = agentEnv;
      if (subagent?.id) connectionOptions.id = subagent.id;
      if (gem?.id) connectionOptions.id = gem.id;
      if (chatId) connectionOptions.id = chatId;
      const launchCommand = gem ? [...command, ...gem.args] : command;
      if (launch) {
        connectionOptions.keeper = launch.link; // the distro's Linux keeper, whatever the Windows keeper's state
        // a new worktree chat's agent works in the worktree's Linux folder (cwd: its ref)
        connectionOptions.wsl = plan instanceof WslPlan ? { ...launch.spawn, linuxPath: plan.linuxPath } : launch.spawn;
      } else if (chatKeeper) connectionOptions.keeper = chatKeeper;
      if (connectionOptions.keeper) connectionOptions.history = this.historyClient();
      if (reopen && connectionOptions.history) connectionOptions.continueStore = reopen.store;
      if (plan) connectionOptions.start = false; // the agent starts in finishSetup, once its worktree exists
      connection = Object.keys(connectionOptions).length
        ? this.connectionFactory(launchCommand, plan ? plan.path : workspace, provider, connectionOptions)
        : this.connectionFactory(launchCommand, plan ? plan.path : workspace, provider);
      const c = connection;
      if (gem) {
        if (gem.id && c.id !== gem.id) { // another id: its hook key would not check; the fence alone holds
          c.geminiSubagents = { ...gem.setup, home: '', subFolder: '', off: 'it was not set up' };
        } else c.geminiSubagents = gem.setup;
      }
      // a factory that gave the chat another id: its hooks' key would not check, so it gets none (it would fail closed otherwise)
      if (subagent) c.subagentHooks = !subagent.id || c.id === subagent.id ? subagent.hooks : offHooks('not set up');
      if (plan || record) {
        c.worktree = plan ? { branch: plan.branch, base: plan.base } : { branch: String(record!.branch), base: String(record!.base ?? '') };
        c.projectRoot = plan ? workspace : String(record!.project); // cwd is the worktree, projectRoot the project
      }
      this.#wire(c);
      c.sessionLease = lease;
      if (asHelper) c.swarm = { role: 'helper', helperId: asHelper.helperId, parent: asHelper.parent };
      else if (known) c.swarm = { role: 'helper', helperId: known.id, parent: known.parent.live };
      // every other chat can lead helpers, in its own copy or in the project folder (MF 1); WSL: only once its swarm tools are on
      else if (!wsl || WSL_TOOL_GROUPS.swarm) c.swarm = { role: 'main' };
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
          const mainFolder = c.worktree ? c.projectRoot : workspace;
          if (wsl) await this.#wslLocalOnlyDefault(mainFolder); // the same in the distro (its helper; never throws)
          const local = wsl ? null : await this.#localOnlyDefault(mainFolder);
          if (plan) {
            const fellBack = await this.#makeWorktree(c, plan, workspace);
            if (fellBack) startNote = wt.inPlaceNote(fellBack);
          }
          // a WSL chat: the main folder's local-only paths as Linux paths, from its distro's helper
          c.localOnly = wsl ? await wslChatLocalOnly(c.worktree ? c.projectRoot : c.cwd, !!c.worktree) : this.#localOnlyFor(c, local);
          // allow rules of a WSL chat: its folder and the distro's base facts, read while the agent starts (allow/wsl_facts.ts)
          const warming = wsl && this.allow ? c.allowWarm() : null;
          await c.setup(resume || null);
          if (warming) await warming; // bounded by the helper call's own time limit; never throws
          if (c.provider === 'claude' && c.subagentHooks?.off === HOOKS_OFF) { // design 2.6: said up front, before a subagent edits the folder (P0 A7)
            c.recordedEvent('studio_note', {
              message: `Subagents that edit files are off in this chat: hooks are off in your Claude Code settings ` +
                `(${c.subagentHooks.detail}), so AIB can't give them their own worktree. Read-only subagents (Explore, Plan) still work.`,
              sessionId: c.sessionId,
            });
          } else if (c.subagentHooks?.off === NO_GIT_BASH) {
            c.recordedEvent('studio_note', { message: SUBAGENTS_OFF_NO_BASH, sessionId: c.sessionId });
          } else if (subagent && 'note' in subagent && subagent.note) { // Codex: its subagents are off (hooks off or unavailable)
            c.recordedEvent('studio_note', { message: subagent.note, sessionId: c.sessionId });
          }
          if (c.geminiSubagents?.off) { // the fence only: said up front (owner rule: refused, never in the folder)
            c.recordedEvent('studio_note', { message: gemini.GEMINI_TEXTS.off(c.geminiSubagents.off), sessionId: c.sessionId });
          }
          if (plan instanceof WslPlan) {
            if (c.worktree) await wslSetSession(plan, provider, c.sessionId!);
          } else if (plan && this.worktrees!.registry.get(plan.key)) await this.worktrees!.setSession(plan.key, provider, c.sessionId!);
          const note = plan && c.worktree ? plan.note : startNote;
          if (note) c.recordedEvent('studio_note', { message: note, sessionId: c.sessionId });
          if (!c.worktree && c.swarm?.role !== 'helper' && working && !working.closed && working !== c) this.#sharedFolderStart(c, working);
          if (toolsNotice) c.recordedEvent('studio_note', { message: toolsNotice, sessionId: c.sessionId }); // a WSL chat's tools
          if (ownerNote) c.recordedEvent('studio_note', { message: ownerNote, sessionId: c.sessionId }); // another agent in its folder

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
          this.handoff.refresh(); // its Claude config folder is watched from now on (open elsewhere)
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
    c.lines = this.conversationLines;
    if (this.allow) {
      c.allowGate = this.allow;
      if (!c.wsl) c.scratchDir = this.allow.scratchFor(c.id); // a Windows scratch folder is no folder for an agent in a distro (its additionalDirectories must be Linux paths)
    }
    c.onRelease = (conn) => {
      this.withdraw(conn);
      void this.subagents?.chatClosed(conn.id).catch((error) => log.exception(error, 'Removing spare subagent worktrees failed'))
        .then(() => { // after its spare went: the Gemini chat's home (junctions unlinked first), policy and empty subagent folder
          this.geminiSubagents?.chatClosed(conn.id);
          if (conn.geminiSubagents) gemini.tearDown(conn.geminiSubagents);
          if (conn.provider === 'codex' && conn.subagentHooks?.subFolder) codexSub.removeSubagentFolder(conn.subagentHooks.subFolder);
        });
      if (conn.channel) this.#keeperNoLongerNeeded();
      this.handoff.refresh();
    };
    // open elsewhere (ownership/handoff.ts): who else holds its session; letting go withdraws AIB's owner announcement
    c.holderNow = () => this.handoff.holderNow(c);
    queueMicrotask(() => this.handoff.refresh()); // a chat rebuilt from the keeper comes only through here (connect() refreshes again once ready)
    c.onElsewhere = (conn, what) => {
      if (!conn.sessionId) return;
      if (what === 'released') {
        this.probe.noteReleased(conn.provider, conn.sessionId);
        this.owners?.withdraw(conn.provider, conn.sessionId);
      } else this.announce(conn);
    };
    c.onTurnEnd = (conn) => this.turnEnded(conn);
    if (c.provider === 'codex' && this.subagents) { // a stopped turn stops its subagents (kept, never landed by themselves)
      const subagents = this.subagents;
      c.onTurnCancelled = (conn) => subagents.turnCancelled(conn.id);
      c.subagentActivity = () => subagents.activity(c.id); // P3's Activity line (codex-acp's child session id is the agent_id)
    }
    if (c.provider === 'claude' && this.subagents) { // subagent worktrees P2: what the parent's stream says of its subagents
      const subagents = this.subagents;
      // a stopped turn stops only the subagents it was waiting on: background ones run on and land (owner, 2026-11-16)
      c.onTurnCancelled = (conn) => subagents.turnCancelled(conn.id, 'claude');
      c.subagentInBackground = (child) => subagents.inBackground(c.id, child);
      c.onClaudeTool = (conn, tool, toolUseId, input, status, agentId) => {
        void subagents.claudeTool(conn.id, tool, toolUseId, input, status, agentId).catch((error) => log.exception(error, 'Subagent tool update failed'));
      };
      c.subagentActivity = () => subagents.activity(c.id);
      c.onSubagentEnded = (conn, agentId, how) => {
        void subagents.acpEnded(conn.id, agentId, how).catch((error) => log.exception(error, 'Subagent end failed'));
      };
    }
    c.subagentWorktree = (toolUseId) => this.subagents?.worktreeOf(c.id, toolUseId) ?? null; // allow-rule parity (design 2.4)
    // a subagent in its own worktree never keeps the chat from being idle for a landing (finished ones land beside a running one)
    c.subagentIsolated = (child) => this.subagents?.isolated(c.id, child) ?? false;
    if (c.provider === 'gemini' && this.subagents && this.geminiSubagents) { // Gemini subagents start and end in the parent's stream
      const subagents = this.subagents, gem = this.geminiSubagents;
      c.onTurnCancelled = async (conn) => {
        gem.turnOver(conn.id);
        await subagents.turnCancelled(conn.id);
      };
      const told = new Map<string, { state: string; agent: string }>();
      c.onGeminiTool = (conn, callId, title, status) => {
        gem.toolUpdate(conn.id, callId, title, status);
        // its Activity card (with P3's worktree line), from the call: Gemini's stream has no child session for it
        const update = gemini.cardUpdate(callId, title, status, told);
        if (update) conn.recordedEvent('update', { sessionId: conn.sessionId, update });
      };
      c.subagentActivity = () => subagents.activity(c.id); // P3's {where, landing} per subagent (keyed by its call id)
    }
    c.onLimits = (conn, kind, raw, at) => this.limits.fromAgent(conn, kind, raw, at);
    c.onWritesDone = (conn, paths) => this.#writesDone(conn, paths); // the file editor reads those files (files/live_files.ts)
    const sync = this.liveSync;
    const wsl = this.wslSync; // a WSL chat in its own copy: its distro's helper runs the hooks (wsl/sync.ts)
    c.onTurnStart = (conn) => {
      recheckSubagentHooks(conn); // hooks turned off mid-chat (should-fix 7)
      if (sync) return wslSyncChat(conn) && wsl ? wsl.turnStarted(conn) : sync.turnStarted(conn);
    };
    // Every chat (build plan SF 11): live sync's note for a copy, then AIB's own one-time lines (#ownContext), in one prompt.
    c.contextForPrompt = async (conn) => {
      const synced = sync ? await (wslSyncChat(conn) && wsl ? wsl.contextFor(conn) : sync.contextFor(conn)) as [string, unknown] | null : null;
      const own = this.#ownContext.get(conn.id) ?? [];
      if (!synced && !own.length) return null;
      const ownText = own.length ? `<studio-context>${own.join('\n')}</studio-context>` : '';
      const text = [synced ? synced[0] : '', ownText].filter(Boolean).join('\n');
      return [text, { [OWN_CONTEXT]: true, sync: synced ? synced[1] : null, synced: !!synced, own: own.length }];
    };
    c.contextSent = async (conn, token) => {
      const t = isDict(token) && token[OWN_CONTEXT] ? token : null;
      if (!t) return;
      if (t.synced && sync) await (wslSyncChat(conn) && wsl ? wsl.contextSent(conn, t.sync) : sync.contextSent(conn, t.sync));
      const own = this.#ownContext.get(conn.id);
      if (own && Number(t.own) > 0) {
        own.splice(0, Number(t.own));
        if (!own.length) this.#ownContext.delete(conn.id);
      }
    };
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
    if (!this.#adopting) {
      // The Windows keeper first (its keep-alives name the distros to ask), then each distro's Linux keeper. The WSL part (it may
      // have to boot the distro and install the Linux programs) never holds up the Windows chats: adoptKeeperWindows() resolves
      // as soon as they are taken over, and the app's window never waits for either (main.ts).
      const windows = (this.keeper ? this.#adoptFrom(this.keeper, null) : Promise.resolve(0)).catch((error) => {
        log.exception(error, 'keeper: taking chats over failed');
        return 0;
      }).finally(() => (this.#windowsAdoptDone = true));
      this.#adoptingWindows = windows;
      this.#adopting = windows.then(async (n) => n + await this.#adoptWsl()).catch((error) => {
        log.exception(error, 'keeper: taking chats over failed');
        return 0;
      }).finally(() => (this.#adoptDone = true));
    }
    return this.#adopting;
  }

  /** True while the take-over at start (the Windows keeper's or a distro's) still runs. */
  takingOver(): boolean {
    return !!this.#adopting && !this.#adoptDone;
  }

  /** The take-over from the Windows keeper only (started by adoptKeeper()): the WSL distros' may still be on their way. */
  adoptKeeperWindows(): Promise<number> {
    void this.adoptKeeper();
    return this.#adoptingWindows!;
  }

  /**
   * True while the take-over at start may still rebuild the chat of this folder (the page shows it as Reconnecting…, never as
   * Not running, until its keeper has been asked).
   */
  #takeOverPending(cwd: string): boolean {
    if (!this.#adopting || this.#adoptDone) return false;
    const loc = wslLoc(cwd);
    return loc ? !this.#wslAsked.has(loc.distro) : !this.#windowsAdoptDone;
  }

  #adoptDone = false;
  #windowsAdoptDone = false;

  /** The take-over from the keeper while it runs (liveState waits for it: an open page keeps its chat meanwhile). */
  #adopting: Promise<number> | null = null;
  #adoptingWindows: Promise<number> | null = null;

  async #adoptWsl(): Promise<number> {
    let adopted = 0;
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

  /**
   * Owner rule 2026-11-17 (a conversation is one chat; the owner's chat history, AIB's own lines too, is permanent): reopening a
   * conversation whose chat has a history store goes on in that store under the same chat id, whatever ended the agent (an idle
   * quit, a crash, a lost keeper, an update, a closed chat). Where one conversation has several stores (it came back under new ids
   * before this rule), the newest one (by its last event) is continued. null: no store, or none can go on now (a new id and store).
   */
  async #storeToContinue(provider: string, sessionId: string, keeper: KeeperLink): Promise<{ id: string; store: ContinueStore } | null> {
    const h = this.historyClient();
    if (!h) return null;
    let found: { chat: string }[] = [];
    try {
      found = await h.find(provider, sessionId);
    } catch (error) {
      log.warning('history: could not look for the stores of %s %s: %s', provider, sessionId, errorText(error));
      return null;
    }
    for (const { chat } of found) {
      const old = this.connections.get(chat);
      if (old && !old.closed) continue; // its chat is open (a live one was returned before this); never two chats on one store
      if (old) { // ended in this AIB: its keeper channel's removal and its store's close are done first (one writer per store)
        await old.channelRemoved.catch(() => {});
        await old.historyDetach();
      }
      if (!(await this.#freeChannel(keeper, chat))) continue;
      try {
        const info = await h.open(chat, {});
        if (!info.last || !info.eventsId) {
          await h.close(chat).catch(() => {});
          continue;
        }
        const tail = await h.before(chat, info.last + 1, { session: null, limit: MAX_EVENTS, bytes: 32 * 1024 * 1024 });
        await h.close(chat);
        log.info('history: %s %s reopens as chat %s, going on in its store from seq %s', provider, sessionId, chat, info.last);
        return {
          id: chat,
          store: { eventsId: info.eventsId, sequence: info.last, events: tail.events.map((r) => JSON.parse(r.data) as Json) },
        };
      } catch (error) {
        log.warning('history: the store of %s could not be read to reopen it: %s', chat, errorText(error));
        await h.close(chat).catch(() => {});
      }
    }
    return null;
  }

  /**
   * The keeper channel name `chat-<id>` free for a reopened chat: an ended channel of it (its agent exited, or the keeper came back
   * after a crash with it on disk) is removed. False when it is live (its agent still runs there) or the keeper cannot say.
   */
  async #freeChannel(keeper: KeeperLink, chat: string): Promise<boolean> {
    const name = `chat-${chat}`;
    try {
      // the keeper the agent will start in (started now if it is not running, as the spawn would): one that starts again keeps the
      // ended channels of its journal folder, so "not running" does not mean "no channel"
      const client = await keeper.check();
      const info = (await client.list()).find((i) => i.channel === name);
      if (!info) return true;
      if (info.live) return false;
      await keeper.removeEnded(client, name);
      return true;
    } catch (error) {
      log.warning('keeper: could not free the channel of chat %s to reopen it: %s', chat, errorText(error));
      return false;
    }
  }

  /** The person deleted the conversation: its chat's history stores go too (every one of them). Returns the chat ids removed. */
  async forgetHistory(provider: string, sessionId: string): Promise<string[]> {
    const h = this.historyClient();
    if (!h || !provider || !sessionId) return [];
    const live = [...this.connections.values()].some((c) => !c.closed && c.provider === provider && c.sessionId === sessionId);
    if (live) return []; // a delete of a live chat is refused before this (conversationAction)
    for (const c of this.connections.values()) {
      if (c.provider === provider && c.sessionId === sessionId) await c.historySettled().catch(() => {});
    }
    const removed = await h.forget(provider, sessionId);
    if (removed.length) log.info('history: %s %s was deleted: removed its store(s) %s', provider, sessionId, removed.join(', '));
    return removed;
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
    if (!distro && !check && this.hasStateDir && this.worktrees) { // Gemini chat folders no running or open chat uses any more
      const keep = new Set([...this.connections.keys()]);
      for (const info of listed) if (info.live) for (const id of gemini.idsInArgs([info.command, ...(info.args ?? [])])) keep.add(id);
      try {
        gemini.sweep(this.stateDir, this.worktrees.registry.root, keep);
      } catch (error) {
        log.exception(error, 'Sweeping Gemini chat folders failed');
      }
    }
    let rebuilt = 0;
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
        const facts = await keeper.channelFacts(client, info.channel);
        let note = facts.note;
        timer.mark('note');
        if (!note || note.t !== 'chat' || !isStr(note.id) || !isStr(note.provider) || !isStr(note.cwd)) {
          if (check) continue; // only the start acts on a channel without a chat record
          const chatId = chatIdOfChannel(info.channel);
          if (!chatId) { // not a chat's channel at all (another program's, or an old build's): stopped as before
            announce('studio', 'keeper: stopping channel %s: it has no chat record', info.channel);
            await keeper.stopUnknown(client, info.channel);
            continue;
          }
          // A chat's channel is never stopped for a missing record (owner rule: quitting or updating AIB never kills a working chat):
          // its record is made again from what the keeper and AIB still know, and the chat is taken over with it.
          note = this.#recordFromKeeper(info, chatId, facts.sessionId, distro);
          if (!note) {
            announce(
              'studio',
              'keeper: channel %s has no chat record and names no session; it keeps running in the keeper (not taken over)',
              info.channel,
            );
            continue;
          }
          announce(
            'studio',
            'keeper: channel %s had no chat record%s; rebuilt it from the keeper: %s %s in %s',
            info.channel,
            facts.timedOut ? ' (reading it timed out)' : '',
            note.provider,
            note.resume,
            note.cwd,
          );
        }
        if (!isStr(note.id)) continue;
        const known = this.connections.get(note.id);
        // A chat whose link to this channel was given up (the keeper could not be reached for a while) while its agent kept running
        // is rebuilt under its own id; any other chat this AIB has (open, or closed by the user) keeps the channel as it is.
        if (known && !(check && known.closed && known.channel?.lost)) continue;
        // Between chats, the page's requests get their turn: a big chat's note parse and replay are synchronous work, and the
        // window is open while this runs (main.ts).
        if (rebuilt++) await new Promise((resolve) => setTimeout(resolve, 0));
        if (!check) await testTakeOverDelay();
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

  /**
   * A chat note made again for a chat channel whose own is gone (a journal truncated past it, or one that never had it): the chat id
   * from the channel name, the session from the agent's lines, the provider, folder and project from AIB's recovery list (else
   * from the agent's command and the keeper's folder). null: no session is known, so nothing can continue it.
   */
  #recordFromKeeper(info: ChannelInfo, chatId: string, sessionId: string | null, distro: string | null): Json | null {
    if (!sessionId) return null;
    const saved = this.store
      ? [...this.store.conversations.values()].find((c) => c.sessionId === sessionId) ?? null
      : null;
    const command = [info.command, ...(info.args ?? [])].map(String);
    const provider = saved?.provider || providerOfCommand(command);
    // a distro's keeper knows the Linux folder; AIB's list has the wsl:// one the rebuild needs
    const cwd = (distro ? saved?.cwd : info.cwd || saved?.cwd) || '';
    if (!provider || !cwd) return null;
    return {
      t: 'chat',
      id: chatId,
      provider,
      cwd,
      loc: { kind: 'win' },
      projectRoot: saved?.projectRoot || cwd,
      worktree: null,
      resume: sessionId,
      command,
      mcpServers: [],
      rebuiltRecord: true,
    };
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
    const options: ConnectionOptions = { keeper, id: String(note.id), rebuild: info, start: false, history: this.historyClient(String(note.id)) };
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
    if (provider === 'claude' || provider === 'codex') c.subagentHooks = hooksFromNote(note.subagentHooks); // as the chat started (should-fix 6)
    if (provider === 'gemini' && this.hasStateDir && this.worktrees) { // its fence and redirect as launched (subagents/gemini.ts)
      c.geminiSubagents = gemini.restore(this.stateDir, this.worktrees.registry.root, c.id, c.projectRoot || cwd);
    }
    this.#wire(c);
    if (wsl && this.allow) void c.allowWarm(); // allow rules: the rebuilt WSL chat's distro facts (allow/wsl_facts.ts; never throws)
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
    // subagent worktrees P3: a subagent that ended while AIB was down (its SubagentStop hook failed open) is settled from the replayed
    // stream, so it never stays "running"
    if (provider === 'claude' && this.subagents) {
      await this.subagents.reconcileEnded(c.id, c.endedSubagents()).catch((error) => log.exception(error, 'Subagent take-over check failed'));
    }
    rebuildPhases(timer, c.rebuildTimes);
    try {
      if (c.closed) return false;
      if (c.rebuildError) {
        announce('studio', 'keeper: %s stays read-only: %s', label, c.rebuildError);
        return false;
      }
      if ((!c.ready || !c.sessionId) && note.rebuiltRecord === true) {
        // A record made again from the keeper that did not bring the chat back: its agent keeps running (never stopped for a lost
        // record); the chat stays read-only here.
        announce('studio', 'keeper: %s (record rebuilt from the keeper) did not come back ready; its agent keeps running', label);
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

  /**
   * The hooks a new Claude chat gets (subagent worktrees, design v2 2.1): command hooks running the keeper's forwarder, which reads
   * AIB's address file and sends the chat's hook key. `folder`: where the agent works (a helper's worktree is made later, so it
   * counts as a git project); `project`: whose .claude settings and agents apply. Off, with the reason, when it can't hold.
   */
  async #subagentHooks(
    command: string[],
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wsl = false,
    chatId: string | null = null, // a reopened chat keeps its id (its hook key is bound to it)
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']> } | null> {
    if (!this.subagents || !this.hasStateDir) return { hooks: offHooks('AIB has no state folder') };
    // under test only a real agent the run allowed gets hooks (a fixture or a test's own factory runs none, and must not pay for them)
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && (isFixture(command) || !realAllowed)) return null;
    if (wsl) return { hooks: offHooks('WSL, coming') }; // through an unreachable host they would fail open (design 2.8)
    try {
      if (!aibWorktree) {
        const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
        if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) return { hooks: offHooks('not a git project') };
        if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
          return { hooks: offHooks('the repository has no commits yet') };
        }
      }
      const agentEnv = { ...Deno.env.toObject(), ...testHomeEnv(command), ...env };
      // Claude Code runs command hooks with Git Bash; under another shell AIB's hook command fails open (security review P1, MF 7).
      // Without it: no hooks, and the chat's editing subagents are turned off by the same per-session deny rules as hooks off (P2).
      if (!gitBashPath(agentEnv)) {
        const readOnly = readClaudeSetup(project, agentEnv).readOnly;
        const configDir = claudeConfigDir(agentEnv);
        return { hooks: { ...offHooks(NO_GIT_BASH), readOnly, configDir, deny: subagentsOffSettings(project, agentEnv, readOnly) } };
      }
      const forwarder = await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
      if (!forwarder) return { hooks: offHooks("AIB's keeper program can't run hooks") };
      const configDir = claudeConfigDir(agentEnv);
      const setup = readClaudeSetup(project, agentEnv);
      if (setup.hooksOff) { // owner rule: its editing subagents are turned off instead (per-session permission deny, not hooks)
        return { hooks: { ...offHooks(HOOKS_OFF, setup.hooksOff), configDir, deny: subagentsOffSettings(project, agentEnv, setup.readOnly) } };
      }
      const settings = hookSettings(forwarder, join(this.stateDir, FORWARD_FILE), { worktreeCreate: !setup.userWorktreeHook });
      if (!settings) return { hooks: offHooks("AIB's folder can't be named in a hook command") };
      this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
      const key = artifactKeys.issueHookKey(id);
      if (!key) return { hooks: offHooks('AIB has no key secret') };
      return {
        id,
        env: { AIB_HOOK_KEY: key, AIB_HOOK_CHAT: id, AIB_HOOK_READONLY: setup.readOnly.join(',') },
        hooks: { settings, readOnly: setup.readOnly, userWorktreeHook: setup.userWorktreeHook, off: '', configDir },
      };
    } catch (error) {
      log.exception(error, 'Could not set up subagent hooks; the chat runs without them');
      return { hooks: offHooks(`AIB could not set up its hooks (${errorText(error)})`) };
    }
  }

  #sweepGeminiWithoutKeeper(root: string): void {
    if (!this.keeper && this.hasStateDir) gemini.sweep(this.stateDir, root, new Set(this.connections.keys()));
  }

  /** The open Gemini chat with the redirect on (its folder and subagent folder), or null. */
  #geminiChat(id: string): { folder: string; subFolder: string } | null {
    const c = this.connections.get(id);
    return c && !c.closed && c.provider === 'gemini' && c.geminiSubagents?.subFolder ? { folder: c.cwd, subFolder: c.geminiSubagents.subFolder } : null;
  }

  /**
   * A new Gemini chat's subagent rule (subagents/gemini.ts): always the fence (`--admin-policy`); with an API-key sign-in in a git
   * project, also the redirect (its own GEMINI_CLI_HOME with AIB's BeforeTool hook, the subagent folder in --include-directories),
   * with a fixed chat id (its hook key is bound to it). Null under test unless a real agent was allowed, or with no state folder.
   */
  async #geminiSubagents(
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wsl: boolean,
    chatId: string | null = null, // a reopened chat keeps its id
  ): Promise<{ id: string; args: string[]; env: Record<string, string>; setup: gemini.GeminiSetup } | null> {
    if (!this.subagents || !this.hasStateDir || !this.worktrees) return null;
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && !realAllowed) return null;
    const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
    let gitProject: '' | 'not a git project' | 'the repository has no commits yet' = '';
    if (!aibWorktree && !wsl) {
      const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
      if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) gitProject = 'not a git project';
      else if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
        gitProject = 'the repository has no commits yet';
      }
    }
    const agentEnv = { ...Deno.env.toObject(), ...testHomeEnv(['gemini']), ...env };
    const forwarder = wsl || gitProject ? null : await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
    const dir = join(this.stateDir, 'gemini', id);
    try {
      if (forwarder) this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const made = gemini.setUp({
        stateDir: this.stateDir,
        root: this.worktrees.registry.root,
        chatId: id,
        project,
        folder,
        env: agentEnv,
        gitProject,
        forwarder,
        addressFile: join(this.stateDir, FORWARD_FILE),
        hookKey: forwarder ? artifactKeys.issueHookKey(id) : null,
        wsl,
      });
      return { id, ...made };
    } catch (error) {
      log.exception(error, 'Could not set up the Gemini subagent rule; the chat runs with the fence only');
      const policyDir = join(dir, 'policy');
      try { // the fence alone: every subagent edit denied
        Deno.mkdirSync(policyDir, { recursive: true });
        Deno.writeTextFileSync(join(policyDir, 'aib-subagents.toml'), gemini.policyToml(gemini.BUILTIN_AGENTS, null));
      } catch { /* the chat still opens; logged above */ }
      const setup = { policyDir, home: '', subFolder: '', off: `AIB could not set it up (${errorText(error)})`, dir };
      return { id, args: ['--admin-policy', policyDir], env: {}, setup };
    }
  }

  /** pre-tool calls of each chat waiting for an answer (security review P1, should-fix 3: a forged flood is refused at once). */
  readonly #preToolWaiting = new Map<string, number>();

  /** One key-checked hook call. More than MAX_PRE_TOOL_WAITING pre-tool calls of one chat at once: the next is denied at once. */
  async #hookCall(event: string, conversation: string, body: unknown): Promise<HookAnswer> {
    if (!this.subagents) return { status: 503, body: 'No state folder', type: 'text/plain' };
    if (event.startsWith('codex-')) return await this.#codexHookCall(event, conversation, body);
    if (event === 'gemini-before-tool') { // a Gemini chat's only (GeminiSubagents answers 503 for any other chat)
      if (this.connections.get(conversation)?.provider !== 'gemini' || !this.geminiSubagents) {
        return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
      }
      return await this.geminiSubagents.beforeTool(conversation, body);
    }
    // each route answers its own agent's chats only (a Codex chat's key can't drive the Claude routes)
    if (this.connections.get(conversation)?.provider !== 'claude') return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
    if (event !== 'pre-tool') return await this.subagents.hook(event, conversation, body);
    const waiting = this.#preToolWaiting.get(conversation) ?? 0;
    if (waiting >= MAX_PRE_TOOL_WAITING) return denyHook(SUBAGENT_BUSY);
    this.#preToolWaiting.set(conversation, waiting + 1);
    try {
      return await this.subagents.hook(event, conversation, body);
    } finally {
      const left = (this.#preToolWaiting.get(conversation) ?? 1) - 1;
      if (left > 0) this.#preToolWaiting.set(conversation, left);
      else this.#preToolWaiting.delete(conversation);
    }
  }

  /**
   * A Codex chat's hook call (subagents/codex.ts), key already checked. Only a Codex chat that was given hooks answers; its
   * spawn_agent calls are limited like Claude's Agent calls (MAX_PRE_TOOL_WAITING at once). Never throws.
   */
  async #codexHookCall(event: string, conversation: string, body: unknown): Promise<HookAnswer> {
    const chat = this.#subagentChat(conversation);
    if (!chat || chat.provider !== 'codex' || !chat.hooks || !isDict(body)) {
      return { status: 503, body: 'This chat is not open in AIB', type: 'text/plain' };
    }
    const spawn = event === 'codex-pre-tool' && !body.agent_id;
    const waiting = this.#preToolWaiting.get(conversation) ?? 0;
    if (spawn && waiting >= MAX_PRE_TOOL_WAITING) return denyHook(SUBAGENT_BUSY);
    if (spawn) this.#preToolWaiting.set(conversation, waiting + 1);
    try {
      return await codexSub.codexHook(this.subagents!, event, chat, body as Record<string, unknown>);
    } catch (error) {
      log.exception(error, 'Codex subagent hook %s failed', event);
      return event === 'codex-pre-tool'
        ? denyHook(`AIB couldn't check this call against the subagent's worktree: ${errorText(error)}`)
        : { status: 500, body: 'AIB could not answer this hook', type: 'text/plain' };
    } finally {
      if (spawn) {
        const left = (this.#preToolWaiting.get(conversation) ?? 1) - 1;
        if (left > 0) this.#preToolWaiting.set(conversation, left);
        else this.#preToolWaiting.delete(conversation);
      }
    }
  }

  /**
   * The hooks a new Codex chat gets (subagents/codex.ts): CODEX_CONFIG with AIB's hooks (the user's own CODEX_CONFIG merged in) and
   * the chat's hook key in the agent's environment; or, when hooks are off or AIB can't give them (owner rule 2026-11-16), the same
   * CODEX_CONFIG with features.multi_agent = false, and a chat line. `wslEnv`: the distro's environment of a WSL chat (its hooks
   * would run in the distro: not yet, so off). Null: under test, a fixture or a run that allows no real agent (left as it is).
   */
  async #codexSubagentHooks(
    command: string[],
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wslEnv: Record<string, string> | null,
    chatId: string | null = null, // a reopened chat keeps its id (its hook key and subagent folder are bound to it)
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; note?: string } | null> {
    const result = await this.#codexHooksFor(command, folder, project, aibWorktree, env, wslEnv, chatId);
    if (!result) return null;
    // open elsewhere (ownership/handoff.ts): its threads unload as soon as AIB lets go of them, so another app can open them at once
    const agentEnv = wslEnv ? { ...wslEnv, ...env } : { ...Deno.env.toObject(), ...env };
    const config = codexSub.withUnloadNow(result.env?.CODEX_CONFIG ?? agentEnv.CODEX_CONFIG);
    return config === null ? result : { ...result, env: { ...result.env, CODEX_CONFIG: config } };
  }

  async #codexHooksFor(
    command: string[],
    folder: string,
    project: string,
    aibWorktree: boolean,
    env: Record<string, string>,
    wslEnv: Record<string, string> | null,
    chatId: string | null,
  ): Promise<{ id?: string; env?: Record<string, string>; hooks: NonNullable<Connection['subagentHooks']>; note?: string } | null> {
    const realAllowed = Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' || Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1';
    if (Deno.env.get('AGENT_STUDIO_TEST') === '1' && (isFixture(command) || !realAllowed)) return null;
    const agentEnv = wslEnv ? { ...wslEnv, ...env } : { ...Deno.env.toObject(), ...testHomeEnv(command), ...env };
    // a WSL chat's config files are the distro's: only its CODEX_CONFIG is read
    const setup = wslEnv
      ? codexSub.readCodexSetup('', agentEnv.CODEX_CONFIG ? { CODEX_CONFIG: agentEnv.CODEX_CONFIG } : {})
      : codexSub.readCodexSetup(project, agentEnv);
    if (setup.configError) return { hooks: offHooks(setup.configError) }; // codex-acp refuses it as well: nothing to merge into
    const off = (why: string, detail: string) => ({
      env: { CODEX_CONFIG: JSON.stringify(codexSub.withSubagentsOff(setup.config)) },
      hooks: { ...offHooks(why, detail), prompt: codexSub.CODEX_SUBAGENTS_OFF_PROMPT },
      note: `Subagents are off in this chat: ${detail}, so AIB can't give them their own worktree.`,
    });
    if (wslEnv) return off('WSL, coming', "AIB's subagent rule doesn't reach Codex in WSL yet");
    if (!this.subagents || !this.hasStateDir) return off('AIB has no state folder', 'AIB has no state folder');
    try {
      if (!aibWorktree) { // as Claude's: no worktree can be made outside git (nothing changes for its subagents)
        const top = await wt.git(['rev-parse', '--show-toplevel'], folder, { check: false });
        if (top.returncode !== 0 || !wt.same(pyStrip(top.stdout), folder)) return { hooks: offHooks('not a git project') };
        if ((await wt.git(['rev-parse', '--verify', '-q', 'HEAD'], folder, { check: false })).returncode !== 0) {
          return { hooks: offHooks('the repository has no commits yet') };
        }
      }
      if (setup.hooksOff) return off(HOOKS_OFF, setup.hooksOff);
      const forwarder = await hookForwarderOf(this.keeper?.options.binary ?? null, this.stateDir).catch(() => null);
      if (!forwarder) return off("AIB's keeper program can't run hooks", "AIB's keeper program can't run hooks");
      const hooks = codexSub.codexHooks(forwarder, join(this.stateDir, FORWARD_FILE), folder, setup.config?.hooks);
      if (!hooks) return off("AIB's folder can't be named in a hook command", "AIB's folder has a space or a sign Codex hooks can't run from");
      this.artifactMcpHttp(); // listening, with its address published, before the agent's first hook
      const id = chatId ?? crypto.randomUUID().replaceAll('-', '');
      const key = artifactKeys.issueHookKey(id);
      if (!key) return off('AIB has no key secret', 'AIB has no key secret');
      // its subagents' worktrees go in a folder of this chat's own, a writable root of its sandbox (Connection.extraFolders)
      const subFolder = codexSub.subagentFolder(this.subagents.root, project, id);
      Deno.mkdirSync(subFolder, { recursive: true });
      return {
        id,
        env: { AIB_HOOK_KEY: key, AIB_HOOK_CHAT: id, CODEX_CONFIG: JSON.stringify(codexSub.withCodexHooks(setup.config, hooks)) },
        hooks: { ...offHooks(''), adopted: true, prompt: codexSub.CODEX_SUBAGENT_PROMPT, subFolder },
      };
    } catch (error) {
      log.exception(error, 'Could not set up Codex subagent hooks; its subagents are off');
      return off('AIB could not set up its hooks', `AIB could not set up its hooks (${errorText(error)})`);
    }
  }

  /**
   * What subagents/service.ts may know of an open chat (by its live id). A chat taken over from the keeper after a restart has no
   * hooks record in this process: its hooks still run with its key (only AIB set AIB_HOOK_KEY), so its setup is read again here.
   */
  #subagentChat(id: string): SubagentChat | null {
    const c = this.connections.get(id);
    if (c && !c.closed && c.provider === 'gemini' && c.geminiSubagents?.subFolder) { // its subagents' worktrees: in its own folder
      const lasting = c.sessionId ? `${c.provider}:${c.sessionId}` : '';
      return { id: c.id, provider: c.provider, lasting, folder: c.cwd, project: c.projectRoot || c.cwd, hooks: null, subFolder: c.geminiSubagents.subFolder };
    }
    if (!c || c.closed || (c.provider !== 'claude' && c.provider !== 'codex') || c.wsl) return null;
    if (!c.subagentHooks && c.provider === 'codex') return null; // a Codex chat without a hooks record was given none
    if (!c.subagentHooks) {
      // a chat taken over from a keeper note older than the hooks record (newer notes carry it: hooksFromNote)
      const setup = readClaudeSetup(c.projectRoot || c.cwd, Deno.env.toObject());
      c.subagentHooks = { settings: null, readOnly: setup.readOnly, userWorktreeHook: setup.userWorktreeHook, off: '', adopted: true };
    }
    const h = c.subagentHooks!;
    const on = !!h.settings?.hooks || h.adopted === true; // hooks were given (a later "hooks are off" still lets them answer)
    const project = c.projectRoot || c.cwd;
    // a Codex chat's own subagent folder: given at the start, or (taken over from the keeper) the one made for its id, if it exists
    const own = c.provider === 'codex' && on ? h.subFolder ?? codexSub.subagentFolder(this.subagents!.root, project, c.id) : '';
    const subFolder = own && wt.lexists(own) ? own : '';
    return {
      id: c.id,
      provider: c.provider,
      lasting: c.sessionId ? `${c.provider}:${c.sessionId}` : '',
      folder: c.cwd,
      project,
      hooks: on ? { readOnly: new Set(h.readOnly), userWorktreeHook: !!h.userWorktreeHook, ...(h.configDir ? { configDir: h.configDir } : {}) } : null,
      ...(subFolder ? { subFolder } : {}),
    };
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
    return chatLocalOnly(lo, !!c.worktree, (dir, error) => log.warning('Could not make %s: %s', dir, errorText(error)));
  }

  /**
   * #localOnlyDefault for a WSL project (its ref): the distro's helper sets the default `/private` up, before the snapshot as above,
   * and only where a Windows project would get it (wsl/local_only.ts wslDefaultsAllowed). Never throws.
   */
  async #wslLocalOnlyDefault(projectRef: string): Promise<void> {
    if (!projectRef || !wslDefaultsAllowed(this.hasStateDir ? this.stateDir : '', projectRef)) return;
    await wslEnsureLocalOnly(projectRef);
  }

  /** Make the plan's worktree and start the agent; '' when made, else why the chat works in the project folder instead (wt.Fallback). */
  async #makeWorktree(connection: Connection, plan: wt.Plan, project: string): Promise<string> {
    let fellBack = '';
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
      fellBack = error.message || 'the copy could not be made';
    }
    if (connection.closed) {
      await this.#discardPlan(plan);
      throw new Error('The chat was closed while it was starting');
    }
    connection.startProcess();
    return fellBack;
  }

  /** Forget a plan's worktree: the Windows registry's, or (a WSL plan) the distro's. */
  async #discardPlan(plan: wt.Plan): Promise<void> {
    if (plan instanceof WslPlan) await wslDiscard(plan);
    else await this.worktrees!.discard(plan.key);
  }

  /**
   * The file editor's "files changed" feed (architect review 2026-11-16, must-fix 7): a chat's write tool call finished, so its files
   * are on disk. The web server holds the open files' live text (files/live_files.ts) and asks for what is new with
   * liveCall('files-changed', {after}) while a file is open; landings and Undo run in the web server and tell it directly
   * (files/files_changed.ts). Kept in memory, the last 200.
   */
  readonly #filesChanged: { seq: number; paths: string[]; who: string; chat: string; at: number }[] = [];
  #filesSeq = 0;
  #writesDone(c: Connection, paths: string[]): void {
    this.#filesChanged.push({ seq: ++this.#filesSeq, paths: paths.slice(0, 50), who: this.chatTitle(c), chat: c.id, at: Date.now() });
    if (this.#filesChanged.length > 200) this.#filesChanged.splice(0, this.#filesChanged.length - 200);
  }

  /** Put a one-time line in front of this chat's next prompt (in a <studio-context> block); said once, then dropped. */
  addPromptContext(c: Connection, line: string, replace = ''): void {
    let lines = this.#ownContext.get(c.id) ?? [];
    if (replace) lines = lines.filter((l) => !l.startsWith(replace)); // one line per subject, the newest (the file editor's notes)
    if (!lines.includes(line)) lines.push(line);
    this.#ownContext.set(c.id, lines);
  }

  /** The open chats that work in `folder` itself: not a chat in its own copy, not a helper (build plan 2.3). */
  folderChats(folder: string): Connection[] {
    const key = (p: string) => (wslLoc(p) ? p : normcase(realpath(p)));
    let want: string;
    try {
      want = key(folder);
    } catch {
      return [];
    }
    return [...this.connections.values()].filter((c) => {
      if (c.closed || c.worktree || c.swarm?.role === 'helper') return false;
      try {
        return key(c.cwd) === want;
      } catch {
        return false;
      }
    });
  }

  /**
   * The open folder chat of this project that is working (a turn running, or messages queued), else null. A chat in its own copy
   * and a helper do not count: they don't write the project folder. Read when a new chat is made (the shared-folder start note).
   */
  folderChatWorking(project: string): Connection | null {
    const key = (p: string) => (wslLoc(p) ? p : normcase(realpath(p)));
    let want: string;
    try {
      want = key(project);
    } catch {
      return null;
    }
    for (const c of this.connections.values()) {
      if (c.closed || c.worktree || c.swarm?.role === 'helper') continue;
      const queued = c.queue.items.length > 0 || c.queue.steer.length > 0;
      if (!c.busy && !queued) continue;
      try {
        if (key(c.cwd) === want) return c;
      } catch { /* its folder is gone */ }
    }
    return null;
  }

  /** A chat's name for a note: the agent's title for it, else AIB's saved one, else its first message, else "another chat". */
  chatTitle(c: Connection): string {
    const clip = (t: string) => {
      const one = t.replace(/\s+/g, ' ').trim();
      return one.length > 60 ? `${one.slice(0, 59)}…` : one;
    };
    const info = c.breadth?.sessionInfo?.title;
    if (isStr(info) && info.trim()) return clip(info);
    const mark = c.sessionId ? this.conversations.entries.get(ConversationState.sessionKey(c.provider, c.sessionId)) : null;
    if (mark && isStr(mark.title) && mark.title.trim()) return clip(mark.title);
    const first = c.events.find((e) => e.kind === 'user' && isDict(e.data) && isStr(e.data.text) && e.data.text.trim());
    if (first) return clip(String((first.data as Record<string, unknown>).text));
    return 'another chat';
  }

  /** Build plan 1.1 (4): a new folder chat starts while another folder chat works there: one grey line, and both agents are told. */
  #sharedFolderStart(c: Connection, working: Connection): void {
    c.recordedEvent('studio_note', { message: sharedFolderNote(this.chatTitle(working)), sessionId: c.sessionId });
    this.addPromptContext(c, SHARED_FOLDER_CONTEXT);
    this.addPromptContext(working, SHARED_FOLDER_CONTEXT);
  }

  /**
   * Swarm: a main chat is any open chat, in its own worktree or in the project folder (build plan 1b, MF 1), that the helper registry
   * does not list (review option C).
   */
  #isMain(c: Connection): boolean {
    if (c.swarm?.role !== 'main') return false;
    if (!this.hasStateDir) return true;
    if (!swarmEnabled(this.stateDir)) return false; // swarm phase 1 is opt-in (swarm/settings.ts): no helper tools while it is off
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
   * The history Worker (history-loading 2A): one SQLite store per keeper chat in <state>/history. With the aib-history-v2 switch
   * off (AIB_HISTORY_V2=0) new chats get no store (snapshots carry the history in chunk notes, as in beta.10), but a chat taken over
   * from the keeper whose store an earlier store-on build wrote (`chatId` given, `<state>/history/<id>.sqlite` there) keeps using
   * it: that build's snapshot notes carry no chunks and its journal was truncated after them, so the store is the only copy of the
   * history AIB has (without it the rebuilt chat would show no history at all).
   */
  historyClient(chatId?: string): HistoryClient | null {
    if (!this.hasStateDir || this.#closed) return null;
    const dir = `${this.stateDir}/history`;
    if (!historyV2()) {
      if (!chatId) return null;
      try {
        // store.ts storePath() (not imported: it loads node:sqlite, which stays in the Worker)
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(chatId) || chatId.startsWith('.')) return null;
        if (!Deno.statSync(`${dir}/${chatId}.sqlite`).isFile) return null;
      } catch {
        return null; // no store for this chat (or not a chat id)
      }
      log.info('history: %s has a store from a store-on build; it keeps using it (the switch is off)', chatId);
    }
    if (this.#history === undefined) {
      try {
        Deno.mkdirSync(dir, { recursive: true });
        this.#history = new HistoryClient(dir);
      } catch (error) {
        log.warning('history: no store folder (%s); chats keep their history in the keeper notes', errorText(error));
        this.#history = null;
      }
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
    if (isWslRecord(record)) return await wslRemove(record, confirmed);
    const outcome = await this.worktrees!.remove(record.key, confirmed);
    // decision 6 (5.3): every refs/studio/<slug>/* of the chat's branch goes with it (the U pin and anything later added there)
    if (outcome === 'removed' && record.project && isdir(String(record.project))) {
      await dropChatRefs(String(record.project), String(record.branch ?? '')).catch((error) => log.exception(error, 'Dropping refs failed'));
    }
    return outcome;
  }

  // ---- after a copy is gone: the chat carries on in the project folder (build plan 1b 4.3-4.5; owner 2026-11-16) ------------
  /** True when the saved chat (or a copy folder) is a helper's: helper transcripts are never moved, helpers never move to the folder. */
  #isHelperCopy(record: wt.WorktreeRecord): boolean {
    if (String(record.branch ?? '').startsWith('studio/helper-')) return true;
    if (!this.hasStateDir) return false;
    return !!helperOf(readHelpers(this.stateDir), { lasting: String(record.session ?? '') || null, path: String(record.path ?? '') || null });
  }

  /** True while the saved chat runs anywhere: a chat of this host, a keeper channel or another agent process (VS Code, a terminal). */
  async #openAnywhere(provider: string, sessionId: string, path: string): Promise<boolean> {
    for (const c of this.connections.values()) {
      if (c.closed) continue;
      if (c.provider === provider && c.sessionId === sessionId) return true;
      if (path && wt.same(c.cwd, path)) return true;
    }
    if (this.takingOver()) return true; // its agent may still be in the keeper, about to be taken over
    try {
      const owner = await this.ownerProbe(provider, sessionId, [Deno.pid]);
      if (owner !== null && owner !== undefined) return true;
    } catch {
      return true; // cannot tell: not now
    }
    return false;
  }

  #retiring: Promise<string[]> | null = null;

  /**
   * Build plan 1b 5.3 (MF 5): the copies of helpers that stopped or failed go 7 days after they stopped, when their chat is closed (not
   * open anywhere), their main chat is not open here and nothing in the copy is unmerged. The removal is cleanup.ts applyProject for
   * that one copy: this install's records only (per-install scope), a fresh scan under the repo lock, silent only without unmerged
   * work (5.2: files against the user base, commits on the branch count), never a running chat's copy. A helper that stopped before
   * this build has no stop time: its 7 days count from the first time this runs. WSL has no helpers. Returns the helper ids done.
   */
  async retireStoppedHelpers(now = Date.now() / 1000): Promise<string[]> {
    const done: string[] = [];
    if (!this.worktrees || !this.hasStateDir || this.takingOver()) return done;
    const helpers = new HelperRegistry(this.stateDir);
    for (const h of Object.values(readHelpers(this.stateDir))) {
      if (h.state !== 'stopped' && h.state !== 'failed') continue;
      const path = String(h.worktree?.path ?? '');
      if (!path || wslLoc(path)) continue;
      if (!(Number(h.endedAt) > 0)) {
        await helpers.patch(h.id, { endedAt: now });
        continue;
      }
      if (now - Number(h.endedAt) < STOPPED_HELPER_DAYS * 86_400) continue;
      const record = this.worktrees.registry.find(path, null);
      if (!record || record.status !== 'ready' || !record.project) continue;
      if (this.#connectionsIn(path).length) continue;
      const lasting = String(h.chat?.lasting ?? '');
      const at = lasting.indexOf(':');
      if (at > 0 && (await this.#openAnywhere(lasting.slice(0, at), lasting.slice(at + 1), path))) continue;
      const open = [...this.connections.values()].filter((c) => !c.closed);
      if (open.some((c) => c.id === h.parent?.live || (!!c.sessionId && `${c.provider}:${c.sessionId}` === h.parent?.lasting))) continue;
      const live = open.flatMap((c) => [c.cwd, ...(c.sessionId ? [`${c.provider}:${c.sessionId}`] : [])]);
      const id = `copy:${record.key}`;
      try {
        const result = await cleanupApply(this.stateDir, String(record.project), [], { live, only: [id] });
        if (result.removed.includes(id)) {
          done.push(h.id);
          cleanupLog(this.stateDir, `stopped helper ${h.id} (${h.state} ${Math.floor((now - Number(h.endedAt)) / 86_400)} days ago): removed its copy ${path}`);
        } else {
          const item = result.scan.items.find((i) => i.id === id);
          const why = result.left[id] || result.scan.skipped || (item?.unmerged ? 'unmerged work' : item?.live ? 'in use' : 'not found');
          log.info('Kept the copy of stopped helper %s: %s', h.id, why);
        }
      } catch (error) {
        log.exception(error, 'Removing the copy of stopped helper %s failed', h.id);
      }
    }
    return done;
  }

  /**
   * P4b (decision 6, 5.3; MF 5): the copies of merged helpers whose chat is closed (not open anywhere) and that hold nothing new
   * since the merge are removed (worktree, branch, refs, git's record). A copy with work after its merge is kept: unmerged work is
   * never removed silently. An old main chat's copy (from before every chat worked in the project folder) is left alone: the owner's
   * one-off migration script (work/migrate/folder_chats_migrate.ts) moves those chats to their project folder. Runs when a chat is
   * closed, after a merge, and once the take-over at start is done. Returns the keys removed.
   */
  retireMerged(): Promise<string[]> {
    if (this.#retiring) return this.#retiring.then(() => this.retireMerged());
    const run = this.#retireMerged().finally(() => (this.#retiring = null));
    this.#retiring = run;
    return run;
  }

  async #retireMerged(): Promise<string[]> {
    const done: string[] = [];
    if (!this.worktrees) return done;
    for (const [key, record] of Object.entries(this.worktrees.registry.all())) {
      if (record.status !== 'ready' || !record.mergedAt || !this.#isHelperCopy(record)) continue;
      const path = String(record.path ?? '');
      const session = String(record.session ?? '');
      const at = session.indexOf(':');
      if (this.#connectionsIn(path).length) continue; // its chat is open here
      if (at > 0 && (await this.#openAnywhere(session.slice(0, at), session.slice(at + 1), path))) continue;
      if (at < 0 && this.takingOver()) continue;
      try {
        if (await this.worktrees.hasChanges(record)) continue; // work since the merge: kept until merged or discarded
        const outcome = await this.#removeWorktree({ ...record, key }, false);
        if (outcome !== 'removed') continue;
        done.push(key);
      } catch (error) {
        log.exception(error, 'Removing the merged copy %s failed', path);
      }
    }
    return done;
  }

  /**
   * Allow rules: the page-session calls (POST /api/live/allow/*; never an MCP tool or a phone route).
   *   allow-answer  {id, key, option, scope, saveOnly?}  answer the card and save its rule, in one call: the rule is saved only when
   *                 the answer went through; answered elsewhere -> 409 answered_elsewhere, and saveOnly then saves it anyway.
   *                 Waiting cards the rule now covers are answered too (sweep).
   *   allow-rules   the list for Settings; allow-remove / allow-restore {ruleId}; allow-review; allow-enable {on};
   *   allow-builtin {name, on}.
   */
  async #allowCall(name: string, body: Json): Promise<[number, unknown]> {
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
    for (const other of [...this.connections.values()]) {
      // a WSL project's ref compares exactly: Linux paths are case-sensitive (audit F6)
      if (scope === 'project' && !sameProject(other.projectRoot || other.cwd, project)) continue;
      try {
        also += other.wsl ? await other.allowSweepWsl() : other.allowSweep(); // a WSL chat reads its distro facts again first
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
        ownCopy: readOwnCopy(body.ownCopy),
      });
      return [200, connection.public()];
    }
    if (name.startsWith('allow-')) return this.#allowCall(name, body); // allow rules: page-session routes only (web/live_routes.ts)
    if (name === 'agent-options') return [200, await this.agentOptionsFor(body)]; // POST /api/live/agent-options (web/live_routes.ts)
    if (name === 'discover') return [200, await this.listAgentSessions(need(body, 'provider'), body.cwd ?? null, body.cursor ?? null)];
    if (name === 'agent-title') { // internal (web/server.ts chat-name, remote rename): not in LIVE_POST_OPS
      const queued = this.agentTitles.request(String(need(body, 'provider')), String(need(body, 'sessionId')), String(body.title ?? ''), isStr(body.cwd) ? body.cwd : '');
      return [200, { ok: true, queued }];
    }
    if (name === 'agent-title-state') return [200, { waiting: this.agentTitles.waiting(), done: this.agentTitles.done }]; // internal: tests
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
    // Build plan 1b, 2.3 (MF 2): the landing lock and its friends. Internal (swarm/service.ts, worktrees/merge.ts): not in LIVE_POST_OPS,
    // so no page route reaches them.
    if (name === 'landing-lock' || name === 'landing-renew' || name === 'landing-release') {
      const connection = this.#connection(body);
      const lock = String(need(body, 'lock'));
      const ttl = Math.min(Math.max(Number(body.ttlMs) || LANDING_TTL_MS, 50), 10 * 60_000);
      if (name === 'landing-lock') {
        const why = connection.landingLock(lock, String(body.owner ?? ''), String(body.title ?? '').slice(0, 120), ttl);
        return [200, { ok: !why, reason: why }];
      }
      if (name === 'landing-renew') return [200, { ok: connection.landingRenew(lock, ttl) }];
      return [200, { ok: connection.landingRelease(lock) }];
    }
    if (name === 'worktree-retire') { // P4b: merged helpers' copies, stopped helpers' copies after 7 days (web: after the take-over)
      const removed = await this.retireMerged();
      const stopped = await this.retireStoppedHelpers().catch((error) => (log.exception(error, 'Stopped helpers failed'), [] as string[]));
      return [200, { ok: true, removed, stopped }];
    }
    if (name === 'subagent-release') { // internal (swarm/service.ts): a landed / empty / discarded subagent's worktree goes (P2)
      if (!this.subagents) return [404, { error: 'No subagent worktrees here' }];
      return [200, { ok: true, result: await this.subagents.release(String(need(body, 'subagent'))) }];
    }
    if (name === 'history-forget') { // internal (web/shared.ts conversationAction): the person deleted the chat; not in LIVE_POST_OPS
      return [200, { ok: true, removed: await this.forgetHistory(String(body.provider ?? ''), String(body.sessionId ?? '')) }];
    }
    if (name === 'files-changed') { // internal (files/live_files.ts): write calls that finished since `after`; not in LIVE_POST_OPS
      const after = Number(body.after) || 0;
      return [200, { instance: this.instanceId, seq: this.#filesSeq, events: this.#filesChanged.filter((e) => e.seq > after) }];
    }
    if (name === 'prompt-context') { // a one-time line in front of this chat's next prompt (a landing told it what changed)
      const connection = this.#connection(body);
      const replace = typeof body.replace === 'string' ? body.replace.slice(0, 600) : '';
      this.addPromptContext(connection, [...String(need(body, 'line'))].slice(0, 2000).join(''), replace);
      return [200, { ok: true }];
    }
    if (name === 'folder-chats') { // the open chats that work in this folder itself (not copies, not helpers)
      const chats = this.folderChats(String(need(body, 'folder'))).map((c) => ({
        id: c.id,
        title: this.chatTitle(c),
        idle: c.landingIdleReason(),
        landing: c.landing ? c.landing.title : '',
      }));
      return [200, { chats }];
    }
    if (!LIVE_POST_OPS.has(name)) return [404, { error: 'Not found' }];
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
    if (name === 'queue-send-now') return [200, await connection.queueSendNow(need(body, 'messageId') as string, body.interrupt === true)];
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
    else if (name === 'session-op' && body.op === 'open-here') {
      // open elsewhere: Open here / Open here anyway on the chat's line (ownership/handoff.ts); nothing is sent to the agent but session/load
      return [200, { ok: true, ...(await connection.reclaim(body.force === true)) }];
    } else if (name === 'session-op') {
      const deletedRef = body.op === 'delete' ? [connection.provider, connection.sessionId] : null;
      const result = await sessionOp(connection as never, body);
      const payload: Json = { ok: true, ...result };
      if (deletedRef && result.done === 'delete') payload._deleted = deletedRef; // the web layer owns conversation marks and removes this key
      return [200, payload];
    } else if (name === 'disconnect') {
      await connection.close();
      if (connection.worktree) {
        void this.retireMerged().then(() => this.retireStoppedHelpers()).catch((error) => log.exception(error, 'Removing merged copies failed'));
      }
    }
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
    this.agentTitles.stop();
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
    this.handoff.close();
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
    this.agentTitles.stop();
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

/** Subagent worktrees: the reason a chat whose Claude settings turn hooks off gets none (its chat line and Activity say so). */
const HOOKS_OFF = 'hooks are off';

/** Subagent worktrees: the reason a Windows chat without Git Bash gets no hooks; its subagents are denied instead (MF 7). */
const NO_GIT_BASH = 'Git Bash not found';
const SUBAGENTS_OFF_NO_BASH = "Subagents that edit files are off: Git Bash is needed for AIB's subagent rule. Read-only subagents (Explore, Plan) still work.";
/**
 * Subagent calls of one chat AIB prepares at once; more are denied at once (should-fix 3). Above the parallel subagents a turn
 * usually starts, well under the cap of worktrees per chat.
 */
const MAX_PRE_TOOL_WAITING = 4;
const SUBAGENT_BUSY = 'AIB is still preparing worktrees for other subagents of this chat; try this subagent again in a moment.';

/**
 * At each turn start (security review P1, should-fix 7): a chat that was given hooks reads its Claude settings again. When they now
 * turn hooks off (disableAllHooks or allowManagedHooksOnly written mid-chat), Claude Code stops running AIB's hooks: the chat says so
 * and Activity shows "Not isolated"; when they are back on, it says that too. Never throws.
 */
function recheckSubagentHooks(c: Connection): void {
  const h = c.subagentHooks;
  if (!h || c.provider !== 'claude' || !(h.settings?.hooks || h.adopted)) return;
  if (h.off && h.off !== HOOKS_OFF) return;
  try {
    const now = readClaudeSetup(c.projectRoot || c.cwd, h.configDir ? { CLAUDE_CONFIG_DIR: h.configDir } : Deno.env.toObject()).hooksOff;
    if (now && h.off !== HOOKS_OFF) {
      h.off = HOOKS_OFF;
      h.detail = now;
      c.recordedEvent('studio_note', {
        message: `Subagents aren't isolated any more: hooks are off in your Claude Code settings (${now}).`,
        sessionId: c.sessionId,
      });
    } else if (!now && h.off === HOOKS_OFF) {
      h.off = '';
      delete h.detail;
      c.recordedEvent('studio_note', { message: 'Hooks are back on: subagents that edit get their own worktree again.', sessionId: c.sessionId });
    }
  } catch (error) {
    log.warning('Could not re-read the Claude settings of %s: %s', c.id, errorText(error));
  }
}

/** A chat's subagent hooks record when it gets none, and why. */
function offHooks(why: string, detail = ''): NonNullable<Connection['subagentHooks']> {
  return { settings: null, readOnly: [], userWorktreeHook: '', off: why, ...(detail ? { detail } : {}) };
}

/**
 * The hooks record of a chat taken over from the keeper, from its chat note (Connection.hooksNote): hooks on (answered as before,
 * with the read-only list the agent was given) or off with the reason. Null for a note older than the record (#subagentChat).
 */
function hooksFromNote(raw: unknown): Connection['subagentHooks'] {
  if (!isDict(raw)) return null;
  const text = (v: unknown, n = 300) => (typeof v === 'string' ? v.slice(0, n) : '');
  const readOnly = Array.isArray(raw.readOnly) ? raw.readOnly.filter((n): n is string => typeof n === 'string' && /^[\w.:-]{1,200}$/.test(n)) : [];
  return {
    settings: null,
    readOnly,
    userWorktreeHook: text(raw.userWorktreeHook),
    off: text(raw.off),
    ...(text(raw.detail) ? { detail: text(raw.detail) } : {}),
    ...(text(raw.configDir, 1024) ? { configDir: text(raw.configDir, 1024) } : {}),
    adopted: raw.given === true, // its agent runs AIB's hooks
    ...(text(raw.prompt, 2000) ? { prompt: text(raw.prompt, 2000) } : {}), // Codex: the system prompt line a reopen sends again
    ...(isDict(raw.deny) ? { deny: raw.deny as Json } : {}),
  };
}

/** A `<keeper program> mcp-forward <file>` entry (design 3.7). */
function isForwardEntry(entry: unknown): boolean {
  const args = isDict(entry) && Array.isArray(entry.args) ? entry.args : [];
  return args[0] === 'mcp-forward';
}

/** The chat id of a chat's keeper channel (`chat-<id>`, connection.ts), or '' for any other channel. */
export function chatIdOfChannel(channel: string): string {
  const m = /^chat-([0-9a-f]{32})$/.exec(channel);
  return m ? m[1] : '';
}

/** The provider an agent command runs, by its program and arguments ('' when it is not one AIB knows). */
export function providerOfCommand(command: string[]): string {
  const text = command.join(' ').toLowerCase().replaceAll('\\', '/');
  if (/claude-agent-acp|claude-code-acp|\/claude(\.exe)?\b/.test(text)) return 'claude';
  if (/codex/.test(text)) return 'codex';
  if (/gemini/.test(text)) return 'gemini';
  return '';
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

/**
 * Tests of whole AIBs (AGENT_STUDIO_TEST=1) may slow the take-over at start down: AIB_TEST_TAKEOVER_DELAY_MS before each chat is
 * rebuilt (a big chat's note and replay), to prove the server and the window do not wait for it. Nothing outside a test.
 */
function testTakeOverDelay(): Promise<void> {
  const ms = Deno.env.get('AGENT_STUDIO_TEST') === '1' ? Number(Deno.env.get('AIB_TEST_TAKEOVER_DELAY_MS')) : NaN;
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, Math.min(ms, 60_000))) : Promise.resolve();
}

/** True for a pair key's provider/session (exported for tests that look at reconnectPending). */
export function reconnectKey(provider: string, sessionId: string): string {
  return pairKey(provider, sessionId);
}
