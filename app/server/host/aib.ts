/**
 * The connection manager (studio.py's AIB class): every live agent connection of one process, the ownership check before a
 * chat opens (lease, command-line probe, announcements), owner announcements and their heartbeat, the recovery list and the
 * automatic reconnect after a restart, the install and sign-in jobs, the worktree per chat and live sync, and the artifact tool's
 * environment. The agent host (agent_host.ts) runs one; `--in-process` puts one inside the web server instead.
 *
 * Its live_* methods are the same interface HostProxy offers (LiveBackend), so the web server calls either one without knowing
 * which it has. JSON in, JSON out; status codes, payloads and messages are fixed.
 *
 * Connect's setup, the reconnect workers and the heartbeat are async tasks. Every locked block does no blocking work, so it is a
 * stretch of synchronous code.
 */
import { AddedProjects } from '../desktop/added_projects.ts';
import { Connection, type ConnectionOptions, errorText, SHARED_FOLDER_CONTEXT, sharedFolderNote, ThreadEvent } from '../acp/connection.ts';
import { HistoryClient } from '../history/client.ts';
import { ConversationLines } from '../history/lines.ts';
import { QueueStore } from '../acp/msgqueue.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import { Installer } from '../agents/installer.ts';
import { readCached as readSignIn, Signer } from '../agents/signin.ts';
import {
  claudeBase,
  isClaudeFamily,
  isCodexFamily,
  isModelServerId,
  isQwenFamily,
  sameAgent,
  serverIdOf,
} from '../agents/claude_family.ts';
import { checkModelServer, serverHealth, type ModelServer, type ServerCheck, type ServerInspection } from '../agents/model_servers.ts';
import { withServerModels } from '../acp/breadth.ts';
import { BetaSigner } from '../agents/beta_signin.ts';
import { AgentOptionsCache } from '../state/agent_options.ts';
import { UsageLimitsStore } from '../state/usage_limits.ts';
import { LimitsFeed, REFRESH_SECONDS } from './usage_limits_feed.ts';
import { AgentTitles } from './agent_titles.ts';
import * as artifactKeys from '../artifacts/keys.ts';
import { ArtifactMcpHttp } from '../artifacts/mcp_http.ts';
import { toolSignatures } from '../artifacts/mcp.ts';
import { ServedRecord, staleReasons } from '../artifacts/served.ts';
import { useLandedMemo } from '../worktrees/landed.ts';
import { useLeftCache } from '../worktrees/project_changes.ts';
import { setServedNames } from '../artifacts/tool_ref.ts';
import { mcpTunnelGate } from '../wsl/mcp_tunnel.ts';
import { wslRemote } from '../wsl/subagents.ts';
import { forwarderOf, keeperBinary, programVersion } from '../keeper/client.ts';
import { SubagentWorktrees, type SubagentChat } from '../subagents/service.ts';
import { readClaudeSetup } from '../subagents/claude_config.ts';
import * as codexSub from '../subagents/codex.ts';
import * as gemini from '../subagents/gemini.ts';
import { isAntigravity } from '../subagents/antigravity.ts';
import { ProcessReaper } from '../subagents/reap.ts';
import { APP_VERSION, TESTS_DIR } from '../core/app.ts';
import { type KeeperClient } from '../keeper/client.ts';
import { type KeeperChannel, KeeperLink, keeperSetting, keeperWanted, noteKeeperProblem } from '../keeper/link.ts';
import { announce, registerSecret } from '../core/log.ts';
import { isDict, isStr, pyLen, ValueError } from '../core/py.ts';
import { findExternalOwner, OwnershipConflict, probeExternalOwner } from '../ownership/ownership.ts';
import {
  type Assessment,
  folderOnlyEvidence,
  HEARTBEAT_SECONDS,
  OwnerRegistry,
  OwnershipEvidence,
  OwnershipProbe,
} from '../ownership/probe.ts';
import { Handoff } from '../ownership/handoff.ts';
import type { Holder } from '../ownership/claude_sessions.ts';
import { mergeAssessment, wslCodexScan, wslOwnerCheck, wslOwnerHints, wslOwnPids, wslSessionsHeld } from '../wsl/ownership.ts';
import { expandUser } from '../platform/pypath.ts';
import { home, isdir, join, normcase, realpath } from '../platform/ospath.ts';
import { Recovery, StateStore } from '../state/recovery.ts';
import { ConversationState, ProjectPrefs, ReadState, SettingsStore } from '../state/store.ts';
import { isForeignPath } from '../platform/location.ts';
import * as wt from '../worktrees/worktrees.ts';
import { LiveSync, Mutex } from '../worktrees/sync.ts';
import { chatLocalOnly, defaultsAllowed, ensureDefault, type LocalOnly } from '../worktrees/local_only.ts';
import { wslDefaultsAllowed, wslEnsureLocalOnly } from '../wsl/local_only.ts';
import { helperOf, readHelpers } from '../swarm/registry.ts';
import { isOwnArtifactEntry } from '../acp/connection.ts';
import { normLinuxPath, refOf, type WslLoc, wslLocOf } from '../platform/location.ts';
import { distroName, readyHost, wslLoc } from '../wsl/access.ts';
import { urlGate } from '../wsl/open_urls.ts';
import { wslCreate, wslDiscard, WslPlan } from '../wsl/worktrees.ts';
import { configureWslHosts, wslHostsInUse } from '../wsl/hosts.ts';
import { WslSync, wslSyncChat } from '../wsl/sync.ts';
import { AllowGate } from '../allow/gate.ts';
import { log, type Json, RECONNECT_TRIES, SCAN_RETRY_MS } from './aib_util.ts';
import {
  type AibOptions,
  type ConnectionFactory,
  type OwnerProbe,
  PROBE_COOLDOWN_SECONDS,
  PROBE_TIMEOUT_SECONDS,
  type AibConstruct,
  defaultFactory,
  pairKey,
} from './aib_options.ts';
import { holdKeeper, keeperInstanceId, saveKeeperInstance, orphanCommand, newToken } from './aib_helpers.ts';
import { claudeSetupMethods, type ClaudeSetupMethods } from './aib_setup_claude.ts';
import { installMethods } from '../acp/install_methods.ts';
import { geminiSetupMethods, type GeminiSetupMethods } from './aib_setup_gemini.ts';
import { codexSetupMethods, type CodexSetupMethods } from './aib_setup_codex.ts';
import { qwenSetupMethods, type QwenSetupMethods } from './aib_setup_qwen.ts';
import { agySetupMethods, type AgySetupMethods } from './aib_setup_agy.ts';
import { copilotSetupMethods, type CopilotSetupMethods } from './aib_setup_copilot.ts';
import { keeperMethods, type KeeperMethods } from './aib_keeper.ts';
import { connectMethods, type ConnectMethods } from './aib_connect.ts';
import { wslMethods, type WslMethods } from './aib_wsl.ts';
import { launchMethods, type LaunchMethods } from './aib_launch.ts';
import { callMethods, type CallMethods } from './aib_calls.ts';
import { viewMethods, type ViewMethods } from './aib_views.ts';
import { reconnectMethods, type ReconnectMethods } from './aib_reconnect.ts';
import { worktreeMethods, type WorktreeMethods } from './aib_worktrees.ts';

export class Aib {
  readonly options: AibOptions;
  connectionFactory: ConnectionFactory;
  /** (provider, sessionId) -> folder of a saved transcript; null means chat_folders' own lookup. */
  savedCwd: ((provider: string, sessionId: string) => string) | null = null;
  readonly connections = new Map<string, Connection>();
  /** Tests replace this to age closed connections without sleeping (seconds). */
  clock: () => number = () => Date.now() / 1000;
  readonly token: string;
  /**
   * The id open pages compare to tell "the same AIB" (connection ids still valid) from a restart. With the keeper it survives a
   * restart or update of this process as long as the keeper does (keeperInstanceId): the chats are rebuilt under the same ids.
   */
  readonly instanceId: string;
  readonly stateDir: string;
  /** The projects the user added (desktop/added_projects.ts): a chat opened here adds its folder. */
  readonly addedProjects: AddedProjects | null;
  /** Allow rules (server/allow): one gate for every chat of this host; null without a state folder. */
  readonly allow: AllowGate | null;
  readonly hasStateDir: boolean;
  /** What each chat was served (tool names, AIB prompt), kept in the state folder across take-overs (artifacts/served.ts); null without one. */
  readonly served: ServedRecord | null;
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
  /** The in-process AIB has no separate host: no code warning, nobody to wait for. */
  readonly hostInfo: unknown = undefined;
  readonly waitingChats = 0;
  /** Cleaning up half-made worktrees; connect waits for it. */
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
  $closed = false;
  /** Agents run in the keeper and chats are rebuilt from its record after a restart; null: agents are children. */
  readonly keeper: KeeperLink | null;
  /**
   * New chats start in the keeper: decided when AIB started (on unless the keeper cannot run or AIB_KEEPER=0). False with a keeper
   * link means a keeper still holds chats from before while this AIB runs without it (the fallback, a split agent host): they
   * are taken over and stay there until they end, and new chats run as children.
   */
  readonly keeperForNew: boolean;
  $mcpHttp: ArtifactMcpHttp | null = null;
  /** One-time <studio-context> lines per live chat id (addPromptContext), sent with its next prompt. */
  readonly $ownContext = new Map<string, string[]>();
  /** Stops this AIB answering WSL agents' tool calls (wsl/mcp_tunnel.ts); null when it never did. */
  #untunnel: (() => void) | null = null;

  constructor(options: AibOptions, construct: AibConstruct = {}) {
    this.options = options;
    this.connectionFactory = construct.connectionFactory ?? defaultFactory;
    this.token = newToken();
    registerSecret(this.token);
    this.hasStateDir = options.stateDir !== undefined && options.stateDir !== null;
    this.stateDir = this.hasStateDir ? String(options.stateDir) : join(TESTS_DIR, 'agent-studio-state');
    this.served = this.hasStateDir ? new ServedRecord(this.stateDir, APP_VERSION) : null;
    if (this.hasStateDir) { // verdicts of builder branches are kept across restarts: a start does not decide ~90 of them again
      useLandedMemo(join(this.stateDir, 'landed-memo.json'));
      useLeftCache(join(this.stateDir, 'left-cache.json'));
    }
    const served = this.served;
    if (served) setServedNames((id) => served.get(id)?.tools?.names); // toolRef: name AIB tools the way each chat knows them
    const withKeeper = construct.keeper !== undefined ? !!construct.keeper : this.hasStateDir && keeperWanted(this.stateDir);
    this.instanceId = withKeeper && this.hasStateDir ? keeperInstanceId(this.stateDir) : crypto.randomUUID().replaceAll('-', '');
    this.ownerProbe = (provider, sessionId, excluded) => this.#cmdlineOwner(provider, sessionId, excluded);
    this.owners = options.ownersDir ? new OwnerRegistry(options.ownersDir, { instanceId: this.instanceId }) : null;
    this.probe = new OwnershipProbe({
      ompRoot: options.ompSessions ?? null,
      claudeRoot: options.claudeProjects ?? null,
      registry: this.owners,
      ownedByAib: (provider, sessionId) => this.$aibOwns(provider, sessionId),
      ownPids: () => this.#ownAgentPids(),
      liveHolder: (provider, sessionId) => this.handoff.savedHolder(provider, sessionId),
    });
    this.handoff = new Handoff({
      connections: () => this.connections.values(),
      wslHeld: (distro, sessionIds, chatPids) => this.#wslHeld(distro, sessionIds, chatPids),
      codexHomeOf: (provider) => isModelServerId(provider) && isCodexFamily(provider) && this.hasStateDir
        ? join(this.stateDir, 'codex-home', serverIdOf(provider)!)
        : null,
      wslCodex: async (distro, sessionIds, chatPids, codexHome) => {
        try {
          const host = readyHost(distro);
          return await wslCodexScan(host, sessionIds, await wslOwnPids(host, chatPids), codexHome);
        } catch {
          return null;
        }
      },
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
      if (this.$closed) return;
      for (const c of this.connections.values()) if (!c.closed) void this.limits.refresh(c);
    }, construct.limitsEveryMs ?? REFRESH_SECONDS * 1000);
    Deno.unrefTimer(this.#limitsTimer);
    const manager = this.hasStateDir ? new wt.Manager(this.stateDir) : null; // worktree per chat (hidden flag)
    this.worktrees = manager;
    const subagents = manager ? new SubagentWorktrees(this.stateDir, manager.registry.root, (id) => this.$subagentChat(id)) : null;
    this.subagents = subagents;
    if (subagents) subagents.remote = wslRemote; // a WSL chat's subagents are made, kept and landed by its distro's helper
    if (subagents) { // a finished subagent's processes are shut down by their shell cookie (subagents/reap.ts); the parent gets one line
      subagents.reaper = new ProcessReaper();
      subagents.onReaped = (chatId, rec, killed) => {
        const connection = this.connections.get(chatId);
        if (!connection) return;
        const name = rec ? (rec.description || rec.agentType || 'subagent').slice(0, 80) : '';
        connection.recordedEvent('studio_note', {
          message: rec
            ? `Subagent “${name}” finished; its processes were shut down (${killed}).`
            : `A stopped background command left processes running; they were shut down (${killed}).`,
          sessionId: connection.sessionId,
          kind: 'swarm-ended',
          helper: '',
        });
      };
    }
    this.geminiSubagents = subagents ? new gemini.GeminiSubagents(subagents, (id) => this.$geminiChat(id)) : null;
    this.ready = (async () => {
      if (!manager) return;
      try {
        await manager.cleanupIncomplete(); // a half-made worktree of a process that died
        await manager.retryPending(); // removals that were pending (a file in use) + git worktree prune
        await subagents?.sweep(); // spare / unused subagent worktrees of chats that are gone
        // no keeper: no Gemini chat can still be running, so their folders go (with a keeper: after its take-over, #takeOver...)
        this.$sweepGeminiWithoutKeeper(manager.registry.root);
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
      this.keeper.onLost = (channels) => this.$keeperLost(channels);
      this.keeper.onClient = () => saveKeeperInstance(this.stateDir, this.instanceId); // the ids now live as long as this keeper
    }
    // WSL projects (wsl/hosts.ts): one host per distro, made and started only when a WSL project needs it, so a PC without WSL pays
    // nothing. The Windows keeper holds each distro's keep-alive; the Linux keeper is the same program, so it has the same version.
    // The first AIB of the process sets this up (a test that set up its own hosts keeps them).
    if (this.hasStateDir) {
      const keeper = this.keeper;
      let version: Promise<string | null> | null = null;
      configureWslHosts({
        stateDir: this.stateDir,
        windowsLink: () => (this.$closed ? null : keeper),
        keeperVersion: () =>
          version ??= (async () => {
            try {
              return await programVersion(keeper?.options.binary ?? await keeperBinary(this.stateDir));
            } catch {
              return null;
            }
          })(),
      }, false);
      // WSL agents' tool calls through the tunnel (wsl/mcp_tunnel.ts) are answered by this AIB.
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
      if (isClaudeFamily(connection.provider)) {
        await this.subagents.reconcileEnded(connection.id, connection.endedSubagents()).catch((error) => log.exception(error, 'Subagent turn end check failed'));
      }
      await this.subagents.turnEnded(connection.id).catch((error) => log.exception(error, 'Subagent turn end failed'));
    }
    if (connection.provider && connection.sessionId) await this.$mark('your_turn', connection);
    if (connection.sessionId) this.agentTitles.turnEnded(connection.provider, connection.sessionId); // a name that waited for the turn
    void this.limits.refresh(connection); // Codex / Vibe: at most once a minute per account
  }

  async $mark(action: string, connection: Connection): Promise<void> {
    try {
      await this.conversations.apply(action, connection.provider, connection.sessionId);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'ValueError')) throw error;
    }
  }

  $aibOwns(provider: string, sessionId: string): boolean {
    return [...this.connections.values()].some((c) => claudeBase(c.provider) === claudeBase(provider) && c.sessionId === sessionId && !c.closed);
  }

  /** Windows pids of this AIB's agents (a WSL chat's pid is the distro's: wslOwnPids). */
  #ownAgentPids(): number[] {
    return [...this.connections.values()].filter((c) => !c.closed && c.process !== null && !c.wsl).map((c) => c.process!.pid);
  }

  /** The Linux pids of this AIB's open chats in a distro (wslOwnPids adds every agent channel its Linux keeper lists). */
  #wslChatPids(distro: string): number[] {
    return [...this.connections.values()]
      .filter((c) => !c.closed && c.wsl?.distro === distro && c.process !== null)
      .map((c) => c.process!.pid);
  }

  /** Owner announcements only (the Windows registry): what a WSL chat's check adds to its distro's answer. */
  readonly #registryProbe = (): OwnershipProbe =>
    new OwnershipProbe({
      registry: this.owners,
      ownedByAib: (provider, sessionId) => this.$aibOwns(provider, sessionId),
      inspectProcesses: false,
      lockProbe: () => [],
    });

  /**
   * The ownership check of a WSL chat (wsl/ownership.ts): the distro's helper looks for a process holding the session and for the weak
   * signs, AIB adds the Windows owner announcements. `null` assessment from the distro: its helper could not answer.
   */
  async $wslAssess(provider: string, sessionId: string, wsl: { distro: string; linuxPath: string }, projectRoot: string | null) {
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
  async $wslCheckOwnership(provider: string, sessionId: string, wsl: { distro: string; linuxPath: string }, projectRoot: string | null, continueAnyway: boolean): Promise<Assessment> {
    const { owner, assessment } = await this.$wslAssess(provider, sessionId, wsl, projectRoot);
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
    if (this.#heartbeat === null && !this.$closed) {
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

  /** Conversations the previous AIB process owned and this one does not (yet). */
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
        reconnecting: this.reconnectPending.has(key) || this.$takeOverPending(item.cwd),
      });
    }
    return result;
  }

  // ---- Send later for chats nobody opened -------------------------------------------------------------------------------------
  /** The time source of the schedule scan (a test moves it). */
  scheduleClock: () => number = () => Date.now();
  $scanTimer: ReturnType<typeof setTimeout> | null = null;
  $scanning = false;
  /** Chats the scan could not reopen: not tried again for a while (their cards stay, with a plain error line). */
  readonly $scanFailed = new Map<string, number>();
  static readonly SCAN_RETRY_MS = SCAN_RETRY_MS;

  /** Chats the automatic reconnect gave up on in this process, with the last reason (until they run again or are forgotten). */
  readonly reconnectFailures = new Map<string, { provider: string; sessionId: string; cwd: string; error: string; at: number }>();

  /** Test seam: how a model server is inspected for its API kinds (default: the kept health answer, 30 s). */
  modelServerInspect: (server: ModelServer, key: string) => Promise<ServerInspection> = (server, key) => serverHealth.check(server, key);

  /** The models each model server (by its own id) listed the last time a chat of it started. */
  readonly $serverModels = new Map<string, string[]>();

  /** Test seam: how a model server is asked (default GET <address>/v1/models). */
  modelServerCheck: (url: string, key: string) => Promise<ServerCheck> = (url, key) => checkModelServer(url, key);

  /** The Linux keepers whose loss this AIB already follows (the same reconnect rule as the Windows keeper's). */
  readonly $wslLinks = new WeakSet<KeeperLink>();

  /** Protocol-native session discovery (session/list). Never loads or prompts a session. */
  async listAgentSessions(provider: unknown, cwd: unknown = null, cursor: unknown = null): Promise<Json> {
    if (!isStr(provider) || !isClaudeFamily(provider)) {
      throw new ValueError('Finding saved chats through the agent works for Claude Code only');
    }
    const [command, launchEnv] = await this.agentLaunch(provider); // a model-server chat is asked with its own address, key and model
    if (cursor !== null && cursor !== undefined && (!isStr(cursor) || !(pyLen(cursor) > 0 && pyLen(cursor) <= 1024))) {
      throw new ValueError('Invalid session list cursor');
    }
    if (cwd !== null && cwd !== undefined && (!isStr(cwd) || pyLen(cwd) > 1024)) throw new ValueError('Invalid workspace filter');
    // A WSL chat's agent lives in its distro and knows only that distro's sessions (Linux cwds): it never answers for Windows
    // projects, and a WSL project is asked only of a running agent in its own distro (its sessions' cwds become refs again).
    const wslLoc = wslLocOf(cwd);
    if (wslLoc) return await this.#listWslSessions(provider, wslLoc, (cursor as string) || null);
    const live = [...this.connections.values()].find((c) => sameAgent(c.provider, provider) && c.ready && !c.closed && !c.wsl);
    if (live) return { ...(await live.listSessions((cwd as string) || null, (cursor as string) || null)), via: 'studio-connection' };
    const probe = isModelServerId(provider) && Object.keys(launchEnv).length ? this.connectionFactory(command, home(), provider, { env: launchEnv }) : this.connectionFactory(command, home(), provider);
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
      sameAgent(c.provider, provider) && c.ready && !c.closed && c.wsl?.distro.toLowerCase() === loc.distro
    );
    if (!live) {
      const note = `Open a Claude Code chat in ${distroName(loc.distro)} first: ` +
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
    if (!isStr(agent) || !agentRegistry.isChoosable(agent)) throw new ValueError('Choose an agent');
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
      const server = this.settings.modelServer(serverIdOf(agent) ?? '');
      if (server) {
        const own = this.$serverModelsFor(server);
        if (own.models.length) withServerModels(settings as Json, own.models, own.model);
      }
      this.agentOptions.record(agent, folder, settings, true);
      log.info('Read the model lists of %s with a quiet probe', agent);
    } finally {
      clearTimeout(timer);
      await probe.close();
    }
  }

  $adoptDone = false;
  $windowsAdoptDone = false;

  /** The take-over from the keeper while it runs (liveState waits for it: an open page keeps its chat meanwhile). */
  $adopting: Promise<number> | null = null;
  $adoptingWindows: Promise<number> | null = null;

  /**
   * The distros whose keep-alive (wsl-hold) the Windows keeper still runs (seen during its take-over): their Linux keeper may hold
   * chats even when the recovery list lost them (an AIB without WSL support, or an auto-reconnect that gave up, forgot them).
   */
  $heldDistros = new Set<string>();

  /** The distros whose Linux keeper this process has asked (taken over or found nothing to take over). */
  $wslAsked = new Set<string>();
  $wslAsking = new Map<string, Promise<number>>();

  /** One take-over at a time (the start's, and the check before a saved chat's agent starts): a channel is never rebuilt twice. */
  readonly $adoptGate = new Mutex();

  /** pre-tool calls of each chat waiting for an answer (security review P1, should-fix 3: a forged flood is refused at once). */
  readonly $preToolWaiting = new Map<string, number>();

  /**
   * What subagents/service.ts may know of an open chat (by its live id). A chat taken over from the keeper after a restart has no
   * hooks record in this process: its hooks still run with its key (only AIB set AIB_HOOK_KEY), so its setup is read again here.
   */
  $subagentChat(id: string): SubagentChat | null {
    const c = this.connections.get(id);
    if (c && !c.closed && c.provider === 'gemini' && c.geminiSubagents?.subFolder) { // its subagents' worktrees: in its own folder
      const lasting = c.sessionId ? `${c.provider}:${c.sessionId}` : '';
      return { id: c.id, provider: c.provider, lasting, folder: c.cwd, project: c.projectRoot || c.cwd, hooks: null, subFolder: c.geminiSubagents.subFolder };
    }
    if (!c || c.closed || (!isClaudeFamily(c.provider) && !isCodexFamily(c.provider) && !isQwenFamily(c.provider) && !isAntigravity(c.provider))) return null;
    if (c.wsl) { // its distro's helper holds its subagents (SubagentWorktrees.remote); only the facts it needs are named here
      const h = c.subagentHooks;
      if (!h) return null; // a WSL chat without a hooks record was given none (the forwarder fails closed)
      const on = !!h.settings?.hooks || h.adopted === true;
      return {
        id: c.id,
        provider: c.provider,
        lasting: c.sessionId ? `${c.provider}:${c.sessionId}` : '',
        folder: c.cwd,
        project: c.projectRoot || c.cwd,
        hooks: on ? { readOnly: new Set(h.readOnly), userWorktreeHook: !!h.userWorktreeHook, ...(h.configDir ? { configDir: h.configDir } : {}), ...(h.shellTag ? { shellTag: true } : {}), ...(h.sharedRule ? { sharedRule: true } : {}) } : null,
        wsl: { distro: c.wsl.distro },
        ...(isCodexFamily(c.provider) && on && h.subFolder ? { subFolder: h.subFolder } : {}),
        ...(isAntigravity(c.provider) && on && h.agyDir ? { agyDir: h.agyDir } : {}),
      };
    }
    if (!c.subagentHooks && (isCodexFamily(c.provider) || isQwenFamily(c.provider) || isAntigravity(c.provider))) return null; // a Codex, Qwen or Antigravity chat without a hooks record was given none
    if (!c.subagentHooks) {
      // a chat taken over from a keeper note older than the hooks record (newer notes carry it: hooksFromNote)
      const setup = readClaudeSetup(c.projectRoot || c.cwd, Deno.env.toObject());
      c.subagentHooks = { settings: null, readOnly: setup.readOnly, userWorktreeHook: setup.userWorktreeHook, off: '', adopted: true };
    }
    const h = c.subagentHooks!;
    const on = !!h.settings?.hooks || h.adopted === true; // hooks were given (a later "hooks are off" still lets them answer)
    const project = c.projectRoot || c.cwd;
    // a Codex chat's own subagent folder: given at the start, or (taken over from the keeper) the one made for its id, if it exists
    const own = isCodexFamily(c.provider) && on ? h.subFolder ?? codexSub.subagentFolder(this.subagents!.root, project, c.id) : '';
    const subFolder = own && wt.lexists(own) ? own : '';
    return {
      id: c.id,
      provider: c.provider,
      lasting: c.sessionId ? `${c.provider}:${c.sessionId}` : '',
      folder: c.cwd,
      project,
      hooks: on ? { readOnly: new Set(h.readOnly), userWorktreeHook: !!h.userWorktreeHook, ...(h.configDir ? { configDir: h.configDir } : {}), ...(h.shellTag ? { shellTag: true } : {}), ...(h.sharedRule ? { sharedRule: true } : {}) } : null,
      ...(subFolder ? { subFolder } : {}),
      ...(isAntigravity(c.provider) && on && h.agyDir ? { agyDir: h.agyDir } : {}),
    };
  }

  /** The keeper program as the MCP forwarder for a new chat in the keeper (null: not available, the usual entries are used). */
  async $mcpForwarder(): Promise<string | null> {
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
  async $keeperUsable(): Promise<boolean> {
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
  $keeperLost(channels: KeeperChannel[]): void {
    const ids = new Set(channels.map((ch) => ch.id));
    const chats = [...this.connections.values()].filter((c) => c.channel && ids.has(c.channel.id) && c.sessionId);
    announce('studio', 'keeper: the keeper stopped; %s chat(s) were interrupted', chats.length);
    if (!this.store || !this.autoReconnect || this.$closed) return;
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
   * The project's local-only lookup after setting up the default `/aib-shared` exclude (local_only.ensureDefault: idempotent, never
   * throws). null: not git, or a test AIB and a project outside the temp folder (local_only.defaultsAllowed).
   */
  async $localOnlyDefault(project: string): Promise<LocalOnly | null> {
    if (!project || !defaultsAllowed(this.hasStateDir ? this.stateDir : '', project)) return null;
    try {
      return await ensureDefault(project);
    } catch (error) {
      log.exception(error, 'Setting up the local-only default of %s failed', project);
      return null;
    }
  }

  /**
   * What a chat is told about local-only files (Connection.localOnly). aib-shared/ only when git really ignores it (state 'on'); a
   * worktree chat gets the main folder's local-only paths, and the main folder's aib-shared/ is made (empty) so it can be granted as an
   * extra writable folder from the first message (owner Q4 a).
   */
  $localOnlyFor(c: Connection, lo: LocalOnly | null): Connection['localOnly'] {
    if (!lo) return null;
    const main = c.worktree ? c.projectRoot : c.cwd;
    if (realpath(main) !== realpath(lo.project)) return null; // the chat fell back to another folder
    return chatLocalOnly(lo, !!c.worktree, (dir, error) => log.warning('Could not make %s: %s', dir, errorText(error)));
  }

  /**
   * $localOnlyDefault for a WSL project (its ref): the distro's helper sets the default `/aib-shared` up, before the snapshot as above,
   * and only where a Windows project would get it (wsl/local_only.ts wslDefaultsAllowed). Never throws.
   */
  async $wslLocalOnlyDefault(projectRef: string): Promise<void> {
    if (!projectRef || !wslDefaultsAllowed(this.hasStateDir ? this.stateDir : '', projectRef)) return;
    await wslEnsureLocalOnly(projectRef);
  }

  /** Make the plan's worktree and start the agent; '' when made, else why the chat works in the project folder instead (wt.Fallback). */
  async $makeWorktree(connection: Connection, plan: wt.Plan, project: string): Promise<string> {
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
      await this.$discardPlan(plan);
      throw new Error('The chat was closed while it was starting');
    }
    connection.startProcess();
    return fellBack;
  }

  /** Forget a plan's worktree: the Windows registry's, or (a WSL plan) the distro's. */
  async $discardPlan(plan: wt.Plan): Promise<void> {
    if (plan instanceof WslPlan) await wslDiscard(plan);
    else await this.worktrees!.discard(plan.key);
  }

  /**
   * The file editor's "files changed" feed (architect review 2026-11-16, must-fix 7): a chat's write tool call finished, so its files
   * are on disk. The web server holds the open files' live text (files/live_files.ts) and asks for what is new with
   * liveCall('files-changed', {after}) while a file is open; landings and Undo run in the web server and tell it directly
   * (files/files_changed.ts). Kept in memory, the last 200.
   */
  readonly $filesChanged: { seq: number; paths: string[]; who: string; chat: string; at: number }[] = [];
  $filesSeq = 0;
  $writesDone(c: Connection, paths: string[]): void {
    this.$filesChanged.push({ seq: ++this.$filesSeq, paths: paths.slice(0, 50), who: this.chatTitle(c), chat: c.id, at: Date.now() });
    if (this.$filesChanged.length > 200) this.$filesChanged.splice(0, this.$filesChanged.length - 200);
  }

  /** Put a one-time line in front of this chat's next prompt (in a <studio-context> block); said once, then dropped. */
  addPromptContext(c: Connection, line: string, replace = ''): void {
    let lines = this.$ownContext.get(c.id) ?? [];
    if (replace) lines = lines.filter((l) => !l.startsWith(replace)); // one line per subject, the newest (the file editor's notes)
    if (!lines.includes(line)) lines.push(line);
    this.$ownContext.set(c.id, lines);
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
  $sharedFolderStart(c: Connection, working: Connection): void {
    c.recordedEvent('studio_note', { message: sharedFolderNote(this.chatTitle(working)), sessionId: c.sessionId });
    this.addPromptContext(c, SHARED_FOLDER_CONTEXT);
    this.addPromptContext(working, SHARED_FOLDER_CONTEXT);
  }

  // ---- stale chats restart themselves (0.15 slice 3; owner 2026-11-23/24) --------------------------------------------------
  /** What the restart line says in the chat afterwards. */
  static readonly RESTARTED_NOTE = 'Restarted to pick up new AIB tools';
  readonly #restarting = new Set<string>();
  /** When AIB's tool server last answered each chat's tools/list (ms; this process only). */
  readonly $toolsAnsweredAt = new Map<string, number>();
  #staleTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Why a chat is stale: the AIB tools or prompt it was served differ from what this AIB would serve it now (artifacts/served.ts).
   * Empty: fresh, or not known (a helper, a chat without a keeper, a chat that has not asked for its tools yet).
   */
  staleWhy(c: Connection): string[] {
    if (!this.served || c.closed || c.swarm?.role === 'helper' || !c.keeper) return [];
    if (!this.options.noArtifactTool && !this.$closed) this.artifactMcpHttp(); // its entries count as AIB's own only once this AIB serves them
    const own = (c.mcpServers ?? []).some(isOwnArtifactEntry);
    const tools = own ? toolSignatures({ restricted: !!c.wsl, worktree: !!c.worktree, main: this.$isMain(c) }) : null;
    return staleReasons(this.served.get(c.id), { tools, promptBase: own ? c.promptBase() || null : null }, c.adopted);
  }

  /**
   * Restart the chat if it is stale, may be restarted now (not mid-turn, no background process; a waiting question, a queued or a
   * scheduled message do not block), and this app version has not tried it yet. True: the chat was replaced by its restarted self.
   */
  async restartIfStale(c: Connection, moment: 'scan' | 'before-send' = 'scan'): Promise<boolean> {
    if (!this.served || this.$closed || this.#restarting.has(c.id)) return false;
    const why = this.staleWhy(c);
    if (!why.length || this.served.restartTried(c.id) || c.restartBlocker()) return false;
    if (!c.canReloadSession()) {
      log.info('stale chat %s (%s) cannot be restarted: its agent does not advertise session load or resume', c.id, why.join(', '));
      return false;
    }
    this.#restarting.add(c.id);
    try {
      return await this.#restartChat(c, why, moment);
    } finally {
      this.#restarting.delete(c.id);
    }
  }

  /** The existing Continue path: end the agent, then reopen the same conversation as the same chat (id, keys, helper links, history). */
  async #restartChat(c: Connection, why: string[], moment: string): Promise<boolean> {
    const { provider, sessionId, cwd } = c;
    if (!sessionId) return false;
    const saved = c.queue.toSaved();
    log.info('chat %s is stale (%s): restarting it (%s)', c.id, why.join(', '), moment);
    this.served!.restartNoted(c.id, false); // the one try of this app version, written first
    c.keepRecordOnClose = true; // an ended agent, not an ended chat: its recovery entry and queue stay
    try {
      await c.close();
      const next = await this.connect(provider, cwd, sessionId, { continueAnyway: true, auto: true });
      if (saved.length) await next.queueContinue(saved); // goes on as it was: not paused
      next.recordedEvent('studio_note', { message: Aib.RESTARTED_NOTE, sessionId: next.sessionId });
      this.served!.restartNoted(next.id, true);
      return true;
    } catch (error) {
      const message = errorText(error);
      log.warning('restarting stale chat %s failed: %s', c.id, message);
      this.served!.restartNoted(c.id, false, message);
      c.error = `Couldn't restart to pick up new AIB tools: ${message}`;
      this.reconnectFailures.set(pairKey(provider, sessionId), { provider, sessionId, cwd, error: c.error.slice(0, 500), at: Date.now() / 1000 });
      return false;
    }
  }

  /** One look at every open chat; stale idle ones restart, one after the other. Returns the chat ids that restarted. */
  async staleScan(): Promise<string[]> {
    const done: string[] = [];
    for (const c of [...this.connections.values()]) {
      if (c.closed) continue;
      try {
        if (await this.restartIfStale(c, 'scan')) done.push(c.id);
      } catch (error) {
        log.exception(error, 'Checking whether a chat is stale failed');
      }
    }
    return done;
  }

  /** The look repeats (a turn or a background process may have ended meanwhile); the first one is after the take-over at start. */
  startStaleScan(everyMs = 30_000): void {
    if (!this.served || this.#staleTimer || this.$closed) return;
    const run = () => void this.staleScan().catch((error) => log.exception(error, 'Stale chat scan failed'));
    void this.$afterAdopting().then(run, run);
    this.#staleTimer = setInterval(run, everyMs);
    Deno.unrefTimer(this.#staleTimer as unknown as number);
  }

  /**
   * Swarm: a main chat is any open chat, in its own worktree or in the project folder (build plan 1b, MF 1), that the helper registry
   * does not list (review option C).
   */
  $isMain(c: Connection): boolean {
    if (c.swarm?.role !== 'main') return false;
    if (!this.hasStateDir) return true;
    // A main chat ALWAYS lists the helper tools (owner rule: helpers are never turned off). With the setting off, the swarm route
    // refuses each call and says where the switch is (swarm/service.ts 'swarm-off'), so the list never changes under a chat.
    return !helperOf(readHelpers(this.stateDir), { live: c.id, lasting: c.sessionId ? `${c.provider}:${c.sessionId}` : null, path: c.cwd });
  }

  // ---- live-connection operations (the LiveBackend interface) -------------------------------------------------------------
  get webInstanceId(): string {
    return this.instanceId;
  }

  $history: HistoryClient | null | undefined;

  /** The conversation list's ownership hints of each ready distro (`ownership.hints`), refreshed in the background every few seconds. */
  readonly $wslHints = new Map<string, { at: number; hints: Record<string, unknown> }>();
  #wslHintsRunning = false;

  $refreshWslHints(): void {
    if (this.#wslHintsRunning || this.$closed) return;
    const hosts = (wslHostsInUse()?.all() ?? []).filter((h) => h.state === 'ready');
    const now = Date.now();
    for (const key of [...this.$wslHints.keys()]) if (!hosts.some((h) => h.distro.toLowerCase() === key)) this.$wslHints.delete(key);
    const due = hosts.filter((h) => now - (this.$wslHints.get(h.distro.toLowerCase())?.at ?? 0) >= 5000);
    if (!due.length) return;
    this.#wslHintsRunning = true;
    void (async () => {
      for (const host of due) {
        const key = host.distro.toLowerCase();
        const hints = await wslOwnerHints(host, await wslOwnPids(host, this.#wslChatPids(key)));
        this.$wslHints.set(key, { at: Date.now(), hints });
      }
    })().finally(() => (this.#wslHintsRunning = false));
  }

  $retiring: Promise<string[]> | null = null;


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
    if (this.$closed) return 0;
    this.$closed = true;
    this.#untunnel?.();
    if (this.liveSync) await this.liveSync.stopAll().catch((error) => log.exception(error, 'Stopping live sync failed'));
    this.wslSync?.stopAll(); // the helpers go on syncing the WSL chats that keep running
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    this.agentTitles.stop();
    this.#heartbeat = null;
    if (this.#limitsTimer !== null) clearInterval(this.#limitsTimer);
    this.#limitsTimer = null;
    this.reconnectStop.set();
    if (this.$scanTimer !== null) clearTimeout(this.$scanTimer);
    this.$scanTimer = null;
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
    if (this.$mcpHttp) await this.$mcpHttp.close(!!options.hold); // hold: the forwarder answers "AIB is closed" at once
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

  /** Stop everything this AIB runs. The recovery list is kept (orderly shutdown), so the next start can reconnect. */
  async close(): Promise<void> {
    if (this.$closed) return;
    this.$closed = true;
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
    if (this.$scanTimer !== null) clearTimeout(this.$scanTimer);
    this.$scanTimer = null;
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
    if (this.$mcpHttp) await this.$mcpHttp.close();
    if (this.wslSync) await this.wslSync.finish(); // every chat was stopped: the helpers stop watching them
    await this.#quitWsl(3000); // every chat was just stopped: give their channels a moment to end
    this.keeper?.disconnect(); // with no client and no live channel the keeper exits by itself
    await this.#stopHistory();
  }

  /** The history Worker's last writes run, then every store closes and the Worker stops (close and release). */
  async #stopHistory(): Promise<void> {
    const history = this.$history;
    this.$history = null;
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

// Methods moved to their own modules (no change): the interface gives Aib their types, installMethods their code.
export interface Aib extends ClaudeSetupMethods, GeminiSetupMethods, CodexSetupMethods, QwenSetupMethods, AgySetupMethods, CopilotSetupMethods, KeeperMethods, ConnectMethods, WslMethods, LaunchMethods, CallMethods, ViewMethods, ReconnectMethods, WorktreeMethods {}
installMethods(Aib, claudeSetupMethods, geminiSetupMethods, codexSetupMethods, qwenSetupMethods, agySetupMethods, copilotSetupMethods, keeperMethods, connectMethods, wslMethods, launchMethods, callMethods, viewMethods, reconnectMethods, worktreeMethods);

// Moved out (no change); re-exported so every importer of this file keeps working.
export { ARTIFACT_URL_FILE, CLOSED_GRACE_SECONDS, MAX_CLOSED_CONNECTIONS, STOPPED_HELPER_DAYS, RECONNECT_TRIES, ADOPT_WAIT_MS, KeyError, need, wslAgentOffLine, isRequestError, pythonErrorType } from './aib_util.ts';
export { LIVE_POST_OPS } from './aib_live_ops.ts';
export { LANDING_TTL_MS, readOwnCopy, readHelperOf, PROBE_COOLDOWN_SECONDS, PROBE_TIMEOUT_SECONDS, readPicks } from './aib_options.ts';
export type { AibOptions, ConnectionFactory, OwnerProbe, ConnectOptions, AibConstruct } from './aib_options.ts';
export { holdKeeper, chatIdOfChannel, providerOfCommand, keeperInstanceId, saveKeeperInstance, orphanCommand, reconnectKey } from './aib_helpers.ts';
