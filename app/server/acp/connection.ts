/**
 * The ACP side of the agent host: Connection, one agent process spoken to over JSON-RPC on stdio.
 *
 * The reader, the stderr reader and each prompt turn are async tasks on one event loop. Nothing that needs ordering does blocking
 * work, so each such step is a stretch of synchronous code with no `await` inside; the orderings it gives (one prompt at a time, receipts before the turn starts, events in arrival order,
 * queued settings applied before `busy` clears) hold because nothing can run in between.
 *
 * JSON keys, event kinds and error messages are fixed: they reach the page through the host RPC.
 */
import type { AllowGate } from '../allow/gate.ts';
import { promptHash } from '../artifacts/served.ts';
import { houseRules } from '../allow/brief.ts';
import { LinuxFacts } from '../allow/linux.ts';
import { createHash } from 'node:crypto';
import { codexUsable, withCodexMcp } from './codex_mcp.ts';
import { type ClaudePatch, mergeClaudeSettings, withCodexToolServers } from '../toolservers/apply.ts';
import { ClientCaps } from './client_caps.ts';
import { type BreadthState, type McpServer, newState, publicState, sessionCapabilities } from './breadth.ts';
import { arraySource, type Ev, type EventSource } from './event_pages.ts';
import type { HistoryClient } from '../history/client.ts';
import { anchorOf, type ConversationLines, KEPT_KINDS, type KeptLine, LineMerger } from '../history/lines.ts';
import type { Checkpoint, OpenInfo } from '../history/store.ts';
import { MessageQueue, type SteerItem } from './msgqueue.ts';
import { type AuthMethod } from './rpc_errors.ts';
import { eventImageSize, MAX_EVENT_IMAGE_BYTES } from './attachments.ts';
import { WriteTracker } from '../artifacts/artifacts.ts';
import { claudeBase, isCodexFamily } from '../agents/claude_family.ts';
import { ProcessTree, treeSpawnOptions } from '../platform/process_tree.ts';
import { INBOX } from '../attention/inbox_rules.ts';
import type { KeeperRecord } from '../keeper/client.ts';
import { type KeeperChannel, type KeeperLink } from '../keeper/link.ts';
import { projectOfWorktree } from '../worktrees/worktrees.ts';
import { WslClientCaps } from './wsl_caps.ts';
import { distroName, guardRealWslAgent, wslTestHomeEnv } from '../wsl/access.ts';
import { type Holder } from '../ownership/claude_sessions.ts';
import { SUBAGENT_PROMPT, SUBAGENTS_OFF_NO_BASH_PROMPT, SUBAGENTS_OFF_PROMPT } from '../subagents/claude_config.ts';
import { isDict, isStr, pyStr, pyTruthy, ValueError } from '../core/py.ts';
import {
  log,
  MAX_EVENTS,
  type Json,
  RuntimeError,
  errorName,
  errorText,
  isOsOrValueError,
  isOsError,
  get,
  ENCODER,
  now,
  within,
  agentResult,
  changeKey,
} from './conn_util.ts';
import { ThreadEvent, PyTextLines } from './thread_text.ts';
import {
  type ClientCapsLike,
  type Elsewhere,
  defaultCaps,
  type Receipt,
  type ConnectionRecovery,
  type SessionLease,
  type AuthState,
  type Pending,
  type AgentRequest,
  type PendingChange,
  type Hook,
  type ConnectionOptions,
  type WslSpawn,
  NoWrites,
} from './conn_types.ts';
import { type CheckpointStep, SCHEDULE_LATE_MS } from './conn_limits.ts';
import { isFixture, guardRealAgent, testHomeEnv, guardRealAgentAuth, resolveProgram } from './launch_env.ts';
import {
  ARTIFACT_PROMPT,
  WSL_ARTIFACT_PROMPT,
  CODEX_MCP_STARTUP_WAIT_MS,
  WORKTREE_PROMPT,
  SHARED_FOLDER_PROMPT,
  LOCAL_ONLY_WORKTREE_PROMPT,
  IGNORED_SHARED_WORKTREE,
} from './prompts.ts';
import { type ToolSeen, type BackgroundTool, isOwnArtifactEntry, subagentEnd } from './tool_tracking.ts';
import { STEER_AGENTS } from './conn_steer.ts';
import { ReplayWindow, quietSeconds, followUpSeconds } from './replay_window.ts';
import { replayMethods, type ReplayMethods } from './conn_replay.ts';
import { installMethods } from './install_methods.ts';
import { historyMethods, type HistoryMethods } from './conn_history.ts';
import { toolMethods, type ToolMethods } from './conn_tools.ts';
import { ioMethods, type IoMethods } from './conn_io.ts';
import { setupMethods, type SetupMethods } from './conn_setup.ts';
import { handoffMethods, type HandoffMethods } from './conn_handoff.ts';
import { turnMethods, type TurnMethods } from './conn_turn.ts';
import { steerMethods, type SteerMethods } from './conn_steer_methods.ts';
import { queueMethods, type QueueMethods } from './conn_queue.ts';
import { allowMethods, type AllowMethods } from './conn_allow.ts';

// ---- the connection -----------------------------------------------------------------------------------------------------------

export class Connection {
  readonly id: string;
  provider: string;
  /** The chat's folder as AIB keys it: a Windows path, or a WSL project's ref. */
  cwd: string;
  /** The folder the agent itself works in: cwd, or the Linux path of a WSL chat (ACP session/new and session/load get this one). */
  agentCwd: string;
  /** Set for a chat in a WSL project (its distro and Linux folder). */
  /** Set once; only retarget() replaces it (a WSL worktree that could not be made: the project's Linux folder). */
  wsl: WslSpawn | null;
  /** {branch, base} of a chat that runs in its own git worktree. */
  worktree: Record<string, string> | null = null;
  /** The project this chat belongs to; a worktree chat's cwd differs from it. */
  projectRoot: string;
  /**
   * Local-only files this chat is told about (host/aib.ts, before setup): absolute `entries` (the main folder's), the existing
   * folders among them (`dirs`, granted to a worktree chat as extra writable folders) and the main folder's aib-shared/ when git
   * really ignores it (`shared`, '' otherwise). null: nothing to tell (not git, or nothing is local only).
   */
  /** `ignored`: a WSL chat in its own copy also gets the main folder's other ignored folders and files (wsl/local_only.ts). */
  localOnly: { entries: string[]; dirs: string[]; shared: string; ignored?: { dirs: string[]; files: string[] } } | null = null;
  /** Allow rules (server/allow): the host's gate and this chat's scratch folder (outside its worktree). */
  allowGate: AllowGate | null = null;
  scratchDir: string | null = null;
  /**
   * Subagent worktrees (subagents/): the hooks this Claude chat got (settings sent in session/new and load; read-only types and
   * whether the user's own WorktreeCreate hook makes the worktrees), or why it got none (`off`: "hooks are off", "not a git
   * project", "WSL", "Git Bash not found", ...). `settings` without `hooks` (no Git Bash): only the deny rules that turn its
   * subagents off. `off` set while hooks were given: they turned off mid-chat (re-read at each turn start). `configDir`: the Claude
   * config folder its agent reads. Null: not a Claude chat, or not decided (a chat taken over from a keeper note without it).
   */
  subagentHooks: {
    settings: Json | null;
    readOnly: string[];
    userWorktreeHook: string;
    off: string;
    detail?: string;
    adopted?: boolean;
    configDir?: string;
    /** Hooks off (in the user's settings, or no Git Bash): the permission deny rules that turn the chat's editing subagents off (P2). */
    deny?: Json;
    /** Codex (subagents/codex.ts): the system prompt line about its subagents (worktrees, or off). */
    prompt?: string;
    /**
     * Codex with hooks on: this chat's own folder for its subagents' worktrees (<state>/worktrees/<repo hash>/.cx-<chat>), sent as an
     * ACP additionalDirectories entry so its sandbox (Workspace mode) may write there as in the chat's folder, without a prompt.
     */
    subFolder?: string;
    /**
     * Given a forwarder that answers `hook 2` (keeper/hookshell.go): AIB tags the shell calls of this chat's subagents with its cookie prefix
     * (subagents/shell_tag.ts). Absent: an older forwarder, which would refuse the answer, or a chat taken over from an older note: untagged.
     */
    shellTag?: boolean;
    /** Given a forwarder that answers `hook 6`: AIB appends the aib-shared rule to its Agent calls' prompts (claude_config.ts SHARED_RULE_SUFFIX). */
    sharedRule?: boolean;
    /** Antigravity (subagents/antigravity.ts) with hooks on: its --gemini-dir (agy keeps its subagent worktrees under <dir>/antigravity-cli/worktrees). */
    agyDir?: string;
  } | null = null;

  /**
   * The project's tool server list this chat was launched with (toolservers/*, host/aib_toolservers.ts): the part that rides on the
   * session (Claude's settings patch) or on the environment (Codex's partial `mcp_servers` entries). Null: nothing is switched off.
   */
  toolServers: { claude: ClaudePatch | null; codex: Record<string, Record<string, unknown>> | null; copilot: string[] } | null = null;
  /** A tool of an MCP server was called in this chat (the tool list's "seen" names, toolservers/store.ts). */
  onToolSeen: ((server: string, tool: string) => void) | null = null;

  /**
   * Antigravity (subagents/antigravity.ts): the rule its subagents are asked to follow (their own workspace). It can only be asked
   * for, never enforced: it goes in the ACP system prompt when the agent advertises one, else in front of the chat's next prompt
   * (host/aib.ts). '' for every other agent.
   */
  subagentRule = '';

  /** The agent advertised the ACP client system prompt capability (an object, as codex-acp's `{}`): artifactPrompt() can send text. */
  supportsSystemPrompt(): boolean {
    return isDict(this.#sessionCaps()?.systemPrompt);
  }

  /** Isolation is on: AIB's hooks run in this chat (given at the start, or a taken-over chat that had them) and are not off now. */
  subagentIsolationOn(): boolean {
    const h = this.subagentHooks;
    return !!h && !h.off && (isDict(h.settings?.hooks) || h.adopted === true);
  }
  /** The worktree a subagent works in, by its Agent call's tool_use_id (allow-rule parity); set by AIB. */
  subagentWorktree: ((toolUseId: string) => string | null) | null = null;
  /** Subagent worktrees, Gemini (subagents/gemini.ts): the fence and, when on, the redirect this Gemini chat was launched with. */
  geminiSubagents: { policyDir: string; home: string; subFolder: string; off: string; dir: string } | null = null;
  sessionId: string | null = null;
  events: Json[] = [];
  eventImageBytes = 0;
  permissions = new Map<string, AgentRequest>();
  elicitations = new Map<string, AgentRequest>();
  withdrawn = new Map<string, string>();
  auth: AuthState | null = null;
  authMethods: AuthMethod[] = [];
  authResponse: [string, string | null] | null = null;
  authEvent = new ThreadEvent();
  setupAbort = '';
  knownSessions = new Set<string>();
  pending = new Map<unknown, Pending>();
  counter = 0;
  sequence = 0;
  busy = false;
  /** Wall-clock time of the last turn_end event (attention summary). */
  turnEndedAt: number | null = null;
  /** Swarm: this chat's role, set by AIB when it is made (a helper's own record says whose); null outside a worktree. */
  swarm: { role: 'main' | 'helper'; helperId?: string; parent?: string } | null = null;
  /**
   * Set by AIB: told the text of the AIB system prompt each time it is sent to the agent (session/new, session/load), so AIB keeps
   * per chat which prompt it served (artifacts/served.ts). Never called for a keeper replay: nothing is sent then.
   */
  promptServed: ((prompt: string, base: string) => void) | null = null;
  /** True once AIB's tool server has answered this chat's tools/list at or after `since` (ms): set by the host for Codex chats. */
  toolsServed: ((since: number) => boolean) | null = null;
  /** When this agent process started (ms), for toolsServed. */
  processStartedAt = Date.now();
  /**
   * Set by AIB: called right before the queue sends a message to the agent (a queued or a scheduled one). True = AIB replaced this
   * connection (restarted a stale chat); the new connection sends the queue, so this one sends nothing.
   */
  beforeQueuedSend: (() => Promise<boolean>) | null = null;
  /** True while AIB restarts this chat: closing it keeps its recovery entry and its saved queue (the chat goes on, it is not ended). */
  keepRecordOnClose = false;
  /** Set by AIB: this chat was taken over from the keeper (an update or restart of AIB) rather than started by this AIB process. */
  adopted = false;
  /** Swarm: this helper's brief test command (allow rules: the built-in "helper copy" rule answers its runs); set by AIB. */
  helperTestCmd: () => string = () => '';
  /** Wall-clock time the current prompt turn started (attention.busySince, so a reloaded page keeps "Working · 12m"). */
  turnStartedAt: number | null = null;
  /**
   * The last turn ended in an error the agent reported (its session/prompt answered with an error: a usage limit, a prompt too
   * long, a refused connection): when, and the agent's words. Never for a Stop, a closed chat or AIB's own reconnecting. Cleared
   * when the next turn starts. The inbox's Failed (inbox-rules.js).
   */
  turnFailedAt: number | null = null;
  turnError = '';
  /** The last reply asks you something in plain text (inbox-rules.js asksOf, rule R6): when it ended, and the question. */
  $asks: { at: number; question: string } | null = null;
  /**
   * Inbox v3.1 stalled: the agent stopped mid-work without saying it was done. 'died': its output ended (it exited, the pipe broke,
   * the keeper lost it) while a turn ran and nobody pressed Stop or closed the chat (S1). 'silent_end': the turn ended normally but
   * no main-agent text came after its last tool call (S2). When, the kind and the last step (the last main tool call's title).
   * Cleared when the next turn starts. The third signal, gone quiet (S3), is read live in attention() from lastOutputAt.
   */
  $stall: { at: number; kind: string; step: string } | null = null;
  /** When the agent last sent anything on its stream (seconds): S3 "gone quiet". */
  $lastOutputAt: number | null = null;
  /** The title of the main agent's last tool call (the stalled row's "during npm test"). */
  $lastStep = '';
  /** When each live helper was first seen running, and each background shell started (seconds): the inbox's caps. */
  $helperSince = new Map<string, number>();
  $shellSince = new Map<string, number>();
  /** When the chat's last helper or background shell ended (seconds): the agent's own follow-up usually starts within 20 s. */
  $workEndedAt: number | null = null;
  /** Helpers or shells counted as work at the last look (a shell's end is read from the OS, so it is noticed by looking). */
  #hadWork = false;
  /** The background-shell answer of the last look, at most 2 s old (a process listing per call is too slow for every list). */
  $shellsSeen: { at: number; running: boolean } | null = null;
  /**
   * True while `busy` stands for a model cycle Claude Code started on its own (a background helper finished and it answers the
   * task notification), not for a prompt of ours. Ends at that cycle's result (see $watchHeldTurn).
   */
  autonomous = false;
  /** The running prompt's early end: called when its reply ended but Claude Code holds the response for background helpers. */
  $endEarly: { seq: number; fire: () => void } | null = null;
  /** Subagent sessions that started (or resumed) running during the current prompt turn: the helpers Claude Code holds it for. */
  $turnHelpers = new Set<string>();
  /** Claude Code subagent sessions seen running (or waiting for the user) live and not yet ended, whichever turn started them. */
  $liveHelpers = new Set<string>();
  /**
   * Claude Code background shells (Bash or PowerShell with run_in_background) seen started and not seen ended: task id -> the pids of
   * the agent's processes that started with the command (null when they could not be listed: the shell then counts until a
   * task-notification cycle). See backgroundShellsRunning.
   */
  $bgShells = new Map<string, number[] | null>();
  /** Bash/PowerShell tool calls of this chat -> when their tool_call came (seconds): a background shell started after it. */
  $shellCalls = new Map<string, number>();
  /** The agent's processes when the current prompt turn began: none of them is a shell that turn starts. */
  $turnProcesses: Set<number> | null = null;
  /** Tool calls seen (any agent, any session): shell or not, last status, start, turn. At most 300, oldest dropped. */
  $tools = new Map<string, ToolSeen>();
  /** Tool calls that moved to the background, by toolCallId (snapshot `toolBackground`; Stop). */
  $bgTools = new Map<string, BackgroundTool>();
  /** Steers of the current prompt turn: how many went in, whether main-session output came after the last, which may be unread. */
  $steerTurn: { injected: number; outputAfter: boolean; unread: SteerItem[] } = { injected: 0, outputAfter: false, unread: [] };
  /** The pending early end of a held turn after a steer (see steerTiming.settleMs). */
  $settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once the running prompt's session/prompt was written: a steer before it would find no turn (promptRequired). */
  $promptOut = new ThreadEvent();
  /** The steer lane's pump (one at a time) and whether it must look again when it finishes. */
  $steerRun: Promise<void> | null = null;
  $steerAgain = false;
  /** The steer request in flight (cancel() leaves it in the lane; its answer decides). */
  $steerInflight: SteerItem | null = null;
  /** Rebuilt from the keeper: the answer to each steer the old AIB sent, by message id (the lane waits for it instead of resending). */
  $replayedSteers = new Map<string, Promise<string>>();
  /** steer notes by JSON-RPC id of the _session/steering they announce (a rebuild shows the message and applies the answer). */
  $steerNotes = new Map<string, Json>();
  /**
   * Steers whose answer did not come within steerTiming.steerTimeoutSeconds, by message id: the message waits in the after-turn
   * queue, but is not sent from there until the late answer says the agent did not take it (or steerLateSeconds pass), so a steer
   * the agent took late is never sent a second time as a prompt.
   */
  $steerLate = new Set<string>();
  closed = false;
  initial: unknown = {};
  imageSupported = false;
  promptCaps: Record<string, boolean> = {
    image: false,
    audio: false,
    embeddedContext: false,
  };
  settings: Json = {};
  /**
   * The model / mode / effort the person picked on the New chat page: {model?, mode?, effort?} (values, not config ids). Applied by
   * setup() right after session/new and before the connection is ready, so the first prompt already runs with them.
   */
  startPicks: (Partial<Record<'model' | 'mode' | 'effort', string>> & { modeAnyOf?: string[] }) | null = null;
  /**
   * Fork this session (ACP session/fork) instead of starting a new one: the session id of the chat a user forked (Fork this session,
   * swarm/service.ts). `forkHow` is what happened: "copy" (the agent forked its own session), "summary" (the agent does not advertise
   * fork, or refused it: a new session; the caller sends a written summary first), "" (not a fork).
   */
  forkFrom: string | null = null;
  /** The turn running now was started by the user (see turnByUser). */
  userTurn(): boolean {
    return this.busy && !this.autonomous && this.turnByUser;
  }
  forkHow: 'copy' | 'summary' | '' = '';
  /** What happened to each start pick: {kind, value, ok, message?}. Sent to the page in public(). */
  pickResults: Json[] = [];
  /** The session/new reply's settings before any pick was applied (the agent's defaults); null for a reopened chat. */
  startSettings: Json | null = null;
  /** Setting key -> change queued during a turn; the host owns it (survives web-server restarts). */
  pendingChanges = new Map<string, PendingChange>();
  /** The last few queued changes the agent refused: {seq, key, ..., message, time}. */
  changeFailures: Json[] = [];
  changeSeq = 0;
  breadth: BreadthState = newState();
  mcpServers: McpServer[] = [];
  error = '';
  ready = false;
  promptReceipts = new Map<string, Receipt>();
  /** Messages written while the agent works; the host owns it (see msgqueue.ts). */
  queue = new MessageQueue();
  /** Recovery hook installed by AIB; null in standalone use. */
  recovery: ConnectionRecovery | null = null;
  /** True once this connection is in the durable recovery list. */
  persisted = false;
  /** Files this agent wrote: the only way a file becomes this chat's artifact. */
  writes: WriteTracker;
  /** Child sessionId -> latest announcement (title, description, capabilities, state). */
  subagents = new Map<string, Json>();
  sessionLease: SessionLease | null = null;
  /** AIB hook: the agent finished a turn, so it is the user's turn. */
  onTurnEnd: Hook | null = null;
  /** The user stopped a turn (stopReason cancelled; onTurnEnd does not run for it). */
  onTurnCancelled: Hook | null = null;
  /** Claude Code: one of the main agent's Agent / Task / SendMessage / TaskStop calls was seen or updated (subagent worktrees P2). */
  onClaudeTool: ((c: Connection, tool: string, toolUseId: string, input: Json, status: string, agentId: string) => void) | null = null;
  /** Claude Code: the tool call `callId` went on running in the background as `task` (a TaskStop names the task; the cookie names the call). */
  onBackgroundTask: ((c: Connection, task: string, callId: string) => void) | null = null;
  /** How many of this chat's finished subagents still have processes of their own running (subagents/own_work.ts): background work of the chat. */
  ownRuns: ((c: Connection) => number) | null = null;
  /** Gemini: the main session's invoke_agent tool calls (a subagent starts and ends), from the stream the agent can't forge. */
  onGeminiTool: ((c: Connection, toolCallId: string, title: string, status: string) => void) | null = null;
  $geminiCalls = new Set<string>();
  /**
   * Claude Code: the adapter said one of the main agent's subagents ended (subagent_update of child `agentId`, the RFD form: state
   * idle with stopReason end_turn / cancelled / error, none, or unknown). The child's session id IS its agentId (claude-agent-acp
   * native-subagents.js). Subagent worktrees P3: the stream's word, which the agent can't forge, settles records whose SubagentStop
   * hook never reached AIB.
   */
  onSubagentEnded: ((c: Connection, agentId: string, how: string | null) => void) | null = null;

  /** Subagent worktrees P3: Activity's words per subagent by agentId ({where, landing}); set by AIB. */
  subagentActivity: (() => Record<string, unknown>) | null = null;
  /**
   * A WSL chat whose subagent bookkeeping in its distro lags (events waiting, records not readable): Activity still lists the subagents
   * the stream shows, and says "syncing" for their worktree instead of "not isolated". Set by AIB.
   */
  subagentSyncing: (() => boolean) | null = null;
  #subagentActivitySafe(): Record<string, unknown> {
    try {
      return this.subagentActivity!();
    } catch (error) {
      log.exception(error, 'Subagent activity failed');
      return {};
    }
  }

  /** Subagent worktrees P3: the main agent's subagents the stream shows as ended, by agentId -> how (see onSubagentEnded). */
  endedSubagents(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, entry] of this.subagents) {
      const how = subagentEnd(entry);
      if (how !== null) out.set(id, how);
    }
    return out;
  }
  /**
   * AIB hook: the agent sent subscription limit data on its own (server/host/usage_limits_feed.ts). kind 'claude-rate-limit'
   * (usage_update._meta._claude/rateLimit) or 'qwen-quota' (a prompt error's data.subscriptionQuota); at = when, in seconds.
   */
  onLimits: ((connection: Connection, kind: string, raw: unknown, at: number) => void) | null = null;
  /** A write tool call of this chat finished (its files are on disk): the absolute paths it named (host/aib.ts filesChanged). */
  onWritesDone: ((connection: Connection, paths: string[]) => void) | null = null;
  /** Number of the latest prompt() accepted. */
  promptSeq = 0;
  /**
   * The owner (or anything but AIB's own swarm and merge messages) sent this chat a message: a helper the owner typed into is left
   * alone by the end-of-helper sweep (swarm/service.ts #endable). Kept in the snapshot, so it survives a rebuild.
   */
  ownerTouched = false;
  /** The turn running now was started by a message from the user, not by AIB's own swarm/merge lines: helper `chat: true` is only allowed then. */
  turnByUser = false;
  /** cancel() cancels every prompt up to this number (one still before its send is dropped; later ones go through). */
  cancelSeq = 0;
  /** AIB hook (worktree live sync): called before the prompt is sent. */
  onTurnStart: Hook | null = null;
  /** AIB hook: connection -> [text, token] or null, a note sent as an extra text block in front of the prompt. */
  contextForPrompt: ((connection: Connection) => unknown) | null = null;
  /** AIB hook: (connection, token) once the prompt went through; the note is not sent again. */
  contextSent: ((connection: Connection, token: unknown) => unknown) | null = null;
  /** AIB hook: a prompt is about to reach the agent (text and clientMessageId as given); the merge permission ends on the user's own. */
  onUserPrompt: ((connection: Connection, text: unknown, clientMessageId: string | null) => unknown) | null = null;
  /** AIB hook: withdraw the owner announcement when the conversation stops. */
  onRelease: Hook | null = null;
  /** The agent's last stderr lines (at most 30, each at most 2000 characters). */
  stderr: string[] = [];
  caps: ClientCapsLike;
  openDone = new ThreadEvent();
  command: string[];
  readonly env: Record<string, string> | null;
  closedAt: number | null = null;
  /** The agent process; for a keeper-run agent a stand-in with only pid and kill (it is not our child). */
  process: Deno.ChildProcess | null = null;
  tree: { kill(): void } | null = null;
  /** Set when this chat's agent runs in the keeper. */
  readonly keeper: KeeperLink | null;
  /** The keeper channel of this chat's agent, or null for a child process. */
  channel: KeeperChannel | null = null;
  /** Resolves once a chat rebuilt from the keeper is live again (rejects when it could not be rebuilt). */
  rebuilt: Promise<void> | null = null;
  /** Why this chat could not be rebuilt from the keeper's record ('' when it was, or was never rebuilt). It is then read-only. */
  rebuildError = '';
  $replaying = false;
  /** AIB's own lines of this conversation, kept by provider + session (history/lines.ts); set by AIB. */
  lines: ConversationLines | null = null;
  /** While a session/load replays the transcript (live only): puts the kept lines back after their turns. */
  $merger: LineMerger | null = null;
  /** The replayed user message being read (its text so far), or null between messages. */
  #mergeUserText: string | null = null;
  /** The anchor of the last replayed user message that ended (its turn's lines come before the next one). */
  #mergeAnchor = '';
  /** The raw text and attachments of the latest prompt, so a turn that failed for sign-in can be sent again once (Deno only). */
  $lastPrompt: { seq: number; text: unknown; attachments: unknown } | null = null;
  /** The message to send again after a mid-session sign-in, or null. */
  $authRetry: { text: unknown; attachments: unknown } | null = null;
  /** True while the automatic resend after a sign-in is running: another auth failure then says the sign-in did not take. */
  $authResent = false;
  /** Record time (seconds) while replaying, so rebuilt events keep their original times. */
  $clock: number | null = null;
  $outLines = new PyTextLines();
  $errLines = new PyTextLines();
  $records: Promise<void> = Promise.resolve();
  /** Writes held back while replaying: those the record shows were made are dropped, the rest go out once live. */
  $held: { message: Json; once?: string }[] = [];
  /** receipt notes by JSON-RPC id of the prompt they announce. */
  $receiptNotes = new Map<string, Json>();
  /** fsWrite / clientTerminal notes by the agent request id they are about. */
  $sideNotes = new Map<string, Json>();
  /** Client terminals the record says were released (their `clientTerminalReleased` notes). */
  $releasedTerminals = new Set<string>();
  $terminalProblemLogged = false;
  /** Agent -> client capability requests met while replaying (answered once live, unless the record shows the answer). */
  $deferred: Json[] = [];
  $exitResolve: (() => void) | null = null;
  /** How often each agent request id was seen (rebuilt identically by a replay): part of an answer's once-key. */
  $requestsSeen = new Map<string, number>();
  /**
   * The id of this chat's event numbering, sent with every state (eventsId): a page whose events came from another numbering starts
   * its list again. A chat rebuilt from the keeper keeps the id when its record gives the same numbering (a snapshot, or a record
   * whose events are all in it: `ev` in the chat note), so an open page simply goes on from its cursor.
   */
  eventsId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  /** The last keeper record handled (a snapshot says how far it reaches). */
  $lastSeq = 0;
  /** While replaying: records since the newest snapshot (or the start), handled once the replay has caught up. */
  $replayBuffer: KeeperRecord[] = [];
  /** While replaying: the newest snapshot note met and its seq. */
  $replaySnapshot: { note: Json; seq: number } | null = null;
  /** While replaying: records before this seq were truncated away (0: none). */
  $replayGapNext = 0;
  /** The keeper sent `live`: records from here on are handled as they come. */
  $replayLive = false;
  $snapshotQueued = false;
  /** The newest event seq already stored in the journal by a snapshot (in its note or a chunk note before it). */
  $eventsSaved = 0;
  /** The journal notes that hold stored events: [record seq, last event seq], oldest first (truncate keeps what the history needs). */
  $eventChunks: [number, number][] = [];
  /** While replaying: the stored event chunks met, by record seq. */
  $replayChunks = new Map<number, Json[]>();
  /** Snapshots written and journal truncations asked for (tests). */
  snapshots = 0;
  /** The size in bytes of the last snapshot note written, and of the chunk notes written with it (tests, logs). */
  snapshotBytes = 0;
  snapshotChunkBytes = 0;
  /** A rebuild: the seq of the snapshot it started from (0: the start of the record) and how many records it replayed after it. */
  replayedFrom = 0;
  replayedRecords = 0;
  /** performance.now() at the take-over's steps (aib.ts logs each chat's take-over timing from them); 0: not reached. */
  rebuildTimes = { adopt: 0, live: 0, replayed: 0, settled: 0 };
  // ---- the history store (design 3.1-3.5) ----
  $history: HistoryClient | null = null;
  /** off: no store; open: opened, not yet ours (a take-over before claim); claimed: written; dead: fenced, full or failed. */
  historyState: 'off' | 'open' | 'claimed' | 'dead' = 'off';
  $historyQueue: Json[] = [];
  $historyTimer: ReturnType<typeof setTimeout> | null = null;
  $historyChain: Promise<unknown> = Promise.resolve();
  $historyOpening: Promise<unknown> = Promise.resolve();
  $historyOpened: OpenInfo | null = null;
  /** The store's checkpoint this chat last committed or started from. */
  historyCkpt: Checkpoint | null = null;
  /** The newest seq committed to the store (written_seq). */
  historyWrittenSeq = 0;
  /** A take-over: the store's checkpoint as the snapshot the replay starts from (kept across a gap; newer keeper notes win). */
  $storeSnapshot: { note: Json; seq: number } | null = null;
  /** A take-over: events up to here came from the store (the rest were rebuilt and are appended). */
  $storeTrusted = 0;
  /** A take-over: the store is not this numbering's (another eventsId): it is started again from the rebuilt events. */
  $storeReset = false;
  /** A take-over: the record the keeper was attached from (ckpt.record + 1, or 0). */
  attachedFrom = 0;
  /** Tests: stop the next checkpoint right after this step (a crash there). */
  historyStopAfter: CheckpointStep | null = null;
  /** A reopened chat that goes on in its store: the newest stored seq it continued from (0: a new store, or a take-over). */
  continuedFrom = 0;
  /** The removal of this chat's ended keeper channel (a reopen under the same id waits for it before it spawns `chat-<id>` again). */
  channelRemoved: Promise<void> = Promise.resolve();
  /** A reopened chat: the store's checkpoint for the new channel (its state before the channel's first record), claimed with it. */
  $continueCkpt: Checkpoint | null = null;
  /** A reopened chat until its setup session/load ends: what the agent replays is in the store already (only outside turns are new). */
  $continued = false;
  traceback = '';
  exitCode: number | null = null;
  $stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  $stdinBroken = false;
  $stdinClosed = false;
  $readTask: Promise<void> | null = null;
  $stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  $stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  $errorTask: Promise<void> | null = null;
  $exited: Promise<void> | null = null;
  $closing = false;
  /** The running turn's task (tests and close() can await it). */
  turn: Promise<void> | null = null;

  constructor(
    command: string[],
    cwd: string,
    provider: string,
    options: ConnectionOptions = {},
  ) {
    this.wsl = options.wsl ?? null;
    if (this.wsl) guardRealWslAgent(command, isFixture(command));
    else guardRealAgent(command);
    this.id = options.id ?? crypto.randomUUID().replaceAll('-', '');
    this.keeper = options.keeper ?? null;
    this.provider = provider;
    this.cwd = String(cwd);
    this.agentCwd = this.wsl ? this.wsl.linuxPath : this.cwd;
    if (this.wsl && !this.keeper) throw new ValueError('A WSL chat runs in its distro, and AIB has no connection to it');
    // a chat in any app's git worktree belongs to the main checkout (a WSL chat: no Windows lookup for its ref; AIB sets
    // projectRoot to the project's ref when the chat has a worktree in the distro)
    const found = this.wsl ? null : projectOfWorktree(this.cwd);
    this.projectRoot = found ? found.project : this.cwd;
    this.writes = this.wsl ? new NoWrites(cwd) : new WriteTracker(cwd);
    // opt-in, off by default; a WSL chat never gets the fs capabilities, and its terminals run in the distro
    const wslCaps = this.wsl?.caps;
    this.caps = this.wsl && !options.capsFactory
      ? new WslClientCaps(this.agentCwd, {
        terminal: !!options.enableTerminal && !!wslCaps,
        knownSession: (sid) => this.knownSessions.has(sid),
        record: (kind, data) => this.event(kind, data),
        writeResponse: (message) => this.write(message),
      }, wslCaps ?? { env: () => Promise.resolve({}), which: () => Promise.resolve(null) })
      : (options.capsFactory ?? defaultCaps)(
        this.agentCwd,
        !!options.enableTerminal,
        this.wsl ? null : options.enableFs ?? null,
        (sid) => this.knownSessions.has(sid),
        (kind, data) => this.event(kind, data),
        (message) => this.write(message),
      );
    // In the keeper, the agent's client terminals run there too (note first), so they outlive an AIB restart with the chat.
    if (this.keeper && this.caps instanceof ClientCaps) this.caps.terminalBackend = this.$terminalBackend();
    // command is always a list (never a shell string).
    this.command = command;
    this.env = options.env ?? null;
    if (this.keeper && options.history) {
      this.$history = options.history;
      this.historyState = 'open';
      if (options.continueStore && !options.rebuild) this.$continueFrom(options.continueStore);
    }
    if (options.rebuild && this.keeper) this.$adoptChannel(options.rebuild);
    else {
      if (this.$history) this.$historyOpening = this.$historyOpenNew();
      if (options.start ?? true) this.startProcess();
    }
  }

  /**
   * Change the folder of an agent that has not started yet (a worktree that could not be made: the chat works in place). A WSL chat
   * gets the project's ref as `cwd` and its Linux folder as `linuxPath` (the agent's cwd).
   */
  retarget(cwd: string, linuxPath?: string): void {
    if (this.process !== null) {
      throw new RuntimeError('The agent already started');
    }
    if (this.wsl) {
      if (!linuxPath || !linuxPath.startsWith('/')) throw new RuntimeError('A WSL chat moves to a Linux folder');
      this.wsl = { ...this.wsl, linuxPath };
      this.cwd = String(cwd);
      this.agentCwd = linuxPath;
      (this.caps as { workspace: string }).workspace = linuxPath;
      this.writes = new NoWrites(this.cwd);
      return;
    }
    this.cwd = String(cwd);
    this.agentCwd = this.cwd;
    (this.caps as { workspace: string }).workspace = this.cwd;
    this.writes = new WriteTracker(this.cwd); // nothing was observed yet: the same as changing its folder
  }

  /** CODEX_CONFIG could not take the MCP servers (not a JSON object): the chat keeps the ACP route. */
  #codexConfigRefused = false;

  /**
   * Does this chat's agent get its MCP servers in CODEX_CONFIG instead of session/new (codex-acp 2.6)? Codex family with a server it
   * can run. See acp/codex_mcp.ts: this is what puts AIB's tools straight into the model request, and it never replaces the user's
   * own servers. `mcpServers` stays the record (prompt, approvals, take-over).
   */
  mcpInConfig(): boolean {
    return isCodexFamily(this.provider) && !this.#codexConfigRefused && codexUsable(this.mcpServers).length > 0;
  }

  /** What session/new, session/load and session/resume list as `mcpServers`: nothing when the servers are in CODEX_CONFIG. */
  $acpMcp(servers: McpServer[]): McpServer[] {
    return this.mcpInConfig() ? [] : servers;
  }

  /** The agent's environment with the chat's MCP servers merged into its CODEX_CONFIG (Codex family; `inherited`: the server's own). */
  #withMcpConfig(env: Record<string, string>, inherited: string | undefined): Record<string, string> {
    if (!this.mcpInConfig()) return env;
    const merged = withCodexMcp(env.CODEX_CONFIG ?? inherited, this.mcpServers, (server) => isOwnArtifactEntry(server));
    if (merged === null) {
      this.#codexConfigRefused = true;
      return env;
    }
    return { ...env, CODEX_CONFIG: withCodexToolServers(merged, this.toolServers?.codex) };
  }

  /**
   * Change the launch command of an agent that has not started yet (Copilot: `--additional-mcp-config @<file>` names the MCP servers,
   * which are known only after the connection exists: agents/copilot_mcp.ts).
   */
  useCommand(command: string[]): void {
    if (this.process !== null) throw new RuntimeError('The agent already started');
    this.command = command;
  }

  startProcess(): void {
    this.processStartedAt = Date.now();
    if (this.wsl) return this.#startInWsl();
    if (this.keeper) return this.#startInKeeper();
    const [program, ...args] = this.command;
    const extra = this.#withMcpConfig({ ...testHomeEnv(this.command), ...(this.env ?? {}) }, Deno.env.get('CODEX_CONFIG'));
    guardRealAgentAuth(this.provider, this.command, extra);
    const child = new Deno.Command(program, {
      args,
      cwd: this.cwd,
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
      ...(Object.keys(extra).length ? { env: extra } : {}),
      // Own process group on POSIX so close() reaches the agent's children; on Windows NOT detached: the agent inherits the
      // server's hidden console (platform/console.ts) so the console programs it starts open no window.
      ...treeSpawnOptions(),
    }).spawn();
    this.process = child;
    this.tree = new ProcessTree(child);
    this.$stdin = child.stdin.getWriter();
    this.$exited = child.status.then((status) => {
      this.exitCode = status.code;
    }, () => {});
    this.$readTask = this.$read(child.stdout);
    this.$errorTask = this.$readErrors(child.stderr);
  }

  // ---- the agent in the keeper ----------------------------------------------------------------------------------------------
  /** Start the agent as a keeper channel. Writes made before the keeper answers wait for it, in order. */
  #startInKeeper(): void {
    const [program, ...args] = this.command;
    const env: Record<string, string> = this.#withMcpConfig({ ...Deno.env.toObject(), ...testHomeEnv(this.command), ...(this.env ?? {}) }, undefined);
    delete env.DENO_SERVE_ADDRESS;
    guardRealAgentAuth(this.provider, this.command, env, {});
    const channel = this.keeper!.spawn(
      { channel: `chat-${this.id}`, command: resolveProgram(program, env), args, cwd: this.cwd, env },
      this.$keeperListener(),
      () => this.$chatNote(),
    );
    this.$useChannel(channel);
  }

  /**
   * Start the agent of a WSL chat as a channel of its distro's Linux keeper: the distro's login environment (AIB read it from the WSL
   * host; never Deno.env), the program the helper's `which` found, the Linux folder as cwd. Nothing of Windows is resolved here.
   */
  #startInWsl(): void {
    const wsl = this.wsl!;
    const [program, ...args] = this.command;
    const env: Record<string, string> = this.#withMcpConfig({ ...(wsl.env ?? {}), ...wslTestHomeEnv(), ...(this.env ?? {}) }, undefined);
    // a fixture copied into the test's AIB_WSL_ROOT is not a real agent; the distro's keyring and ~/.config are no test auth either
    const root = (Deno.env.get('AIB_WSL_ROOT') ?? '').replace(/\/+$/, '');
    const wslFixture = isFixture(this.command) || (root.startsWith('/') && this.command.some((part) => String(part).startsWith(root + '/')));
    if (!wslFixture) guardRealAgentAuth(this.provider, this.command, env, {});
    const channel = this.keeper!.spawn(
      { channel: `chat-${this.id}`, command: wsl.program || program, args, cwd: this.agentCwd, env },
      this.$keeperListener(),
      () => this.$chatNote(),
    );
    this.$useChannel(channel);
  }

  $settleRebuild: [() => void, (error: Error) => void] | null = null;
  $endedResolve: (() => void) | null = null;
  $ended = false;
  /** True when the keeper itself went away under this chat (the agent ended with it). */
  interrupted = false;

  // ---- rebuilding from the keeper's record ------------------------------------------------------------------------------------
  /** True while this chat is being rebuilt from the record: nothing is written, spawned or answered. */
  get replaying(): boolean {
    return this.$replaying;
  }

  $historyFenced = false;
  /** A take-over is claiming the store (no write and no claim by the 200 ms writer until it is done). */
  $historyAdopting = false;
  $historyAdopt: Promise<void> = Promise.resolve();

  $historyFinishing: Promise<void> | null = null;

  /** The snapshot the take-over restored (the store's checkpoint, or a newer keeper note). */
  $restoredSnapshot: { note: Json; seq: number } | null = null;

  /** The record cannot be rebuilt by this code: keep showing the chat, never write to it. */
  $rebuildFailed(error: unknown): void {
    if (this.rebuildError) return;
    log.exception(error, 'Rebuilding a chat from the keeper record failed');
    this.rebuildError = `AIB could not continue this chat after the restart (${
      errorText(error) || errorName(error)
    }). The agent goes on in the background; nothing is sent to it from here. Close the chat to stop it.`;
    this.error = this.rebuildError;
    this.$held = [];
    this.$deferred = [];
    this.$settleRebuild?.[1](error instanceof Error ? error : new Error(String(error)));
    this.$settleRebuild = null;
  }

  $refuseReadOnly(): void {
    if (this.rebuildError) throw new ValueError(this.rebuildError);
  }

  /** Answer a client capability request; in the keeper the side effects that cannot be undone get their note first. */
  $dispatchCaps(message: Json): void | Promise<void> {
    const method = message.method;
    // terminal/create: with a terminal backend (this chat is in the keeper) the backend writes the note itself, with the channel id.
    const terminalNoted = method === 'terminal/create' && this.caps instanceof ClientCaps && this.caps.terminalBackend !== null;
    if (this.channel && !terminalNoted && (method === 'fs/write_text_file' || method === 'terminal/create')) {
      const params = get(message, 'params', {});
      const note: Json = { t: method === 'terminal/create' ? 'clientTerminal' : 'fsWrite', rpc: message.id };
      if (method === 'fs/write_text_file' && isDict(params)) {
        note.path = params.path;
        note.sha256 = createHash('sha256').update(ENCODER.encode(isStr(params.content) ? params.content : '')).digest('hex');
      }
      return this.channel.sendNote(note).then(() => this.caps.dispatch(message));
    }
    return this.caps.dispatch(message);
  }

  /**
   * History pages (event_pages.ts): seqs up to here keep their number across a host restart (saved with the last snapshot); above
   * it a rebuild may number AIB's own events differently. A chat outside the keeper is not rebuilt: every seq is stable.
   */
  get stableSeq(): number {
    return this.channel ? Math.min(this.$eventsSaved, this.sequence) : this.sequence;
  }

  /** This chat's events as an event_pages.ts source (the in-memory array today; the history store in phase 2). */
  pageSource(): EventSource {
    return arraySource(this.events as Ev[], {
      eventsId: this.eventsId,
      cursor: this.sequence,
      stable: this.stableSeq,
      mainSession: this.sessionId ?? '',
    });
  }

  /** Returncode once the agent exited (Popen.poll()). */
  poll(): number | null {
    return this.exitCode;
  }

  /**
   * An event AIB makes itself (not from the agent: an artifact, an AIB note, a session op). In the keeper it also goes into the
   * record as an `event` note, so a rebuild has it in the same place and numbers every later event the same.
   */
  recordedEvent(kind: string, data: unknown, time?: number): void {
    if (this.channel && !this.$replaying && !this.rebuildError) {
      void this.channel.sendNote({ t: 'event', kind, data, ...(time === undefined ? {} : { time }) });
    }
    this.event(kind, data, time);
  }

  event(kind: string, data: unknown, time?: number): void {
    this.sequence += 1;
    const item: Json = { seq: this.sequence, kind, data, time: time ?? this.$now() };
    // History the agent re-sends on session/load: 'time' is the reconnect, not when it was said.
    if (kind === 'update' && !this.ready && this.sessionId) item.replay = true;
    if (this.events.length >= MAX_EVENTS) {
      this.eventImageBytes -= eventImageSize(this.events.shift()!);
    }
    this.events.push(item);
    this.eventImageBytes += eventImageSize(item);
    if (this.historyState === 'open' || this.historyState === 'claimed') this.$historyQueueEvent(item);
    if (kind === 'update') this.$trackSubagent(data, item.time as number);
    if (KEPT_KINDS.has(kind) && this.lines && !this.$replaying) this.#keepLine(kind, data, item.time as number);
    while (
      this.eventImageBytes > MAX_EVENT_IMAGE_BYTES && this.events.length > 1
    ) {
      this.eventImageBytes -= eventImageSize(this.events.shift()!);
    }
  }

  /**
   * One of AIB's own lines (a turn end, an AIB note) as it happens: kept by conversation as well (history/lines.ts), after the
   * user message whose turn it belongs to, so a rebuild under another chat id shows it again. Lines put back from there are not
   * kept twice.
   */
  #keepLine(kind: string, data: unknown, time: number): void {
    if (!this.sessionId || (isDict(data) && data.restored === true)) return;
    let after = '';
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.kind !== 'user') continue;
      const d = e.data;
      if (isDict(d) && isStr(d.sessionId) && d.sessionId && d.sessionId !== this.sessionId) continue;
      after = anchorOf(isDict(d) && isStr(d.text) ? d.text : '');
      break;
    }
    this.lines!.append(this.provider, this.sessionId, { kind, data, time, after });
  }

  /** A session/load replay (live): a user message starts or the agent answers; the kept lines of the turn before go in first. */
  $mergeReplayed(params: Json): void {
    const update = get(params, 'update', {}) as Json;
    const sid = get(params, 'sessionId');
    if (isStr(sid) && sid && sid !== this.sessionId) return; // a helper's
    if (get(update, 'sessionUpdate') === 'user_message_chunk') {
      const content = get(update, 'content');
      const text = isDict(content) && isStr(content.text) ? content.text : '';
      if (this.#mergeUserText === null) {
        this.#restoreLines(this.#mergeAnchor); // the turn before this message ended here
        this.#mergeAnchor = '';
        this.#mergeUserText = text;
      } else this.#mergeUserText += text;
      return;
    }
    if (this.#mergeUserText !== null) {
      this.#mergeAnchor = anchorOf(this.#mergeUserText);
      this.#mergeUserText = null;
    }
  }

  /** The end of a session/load replay: the last replayed turn's lines, then no more merging. */
  $mergeDone(): void {
    if (!this.$merger) return;
    if (this.#mergeUserText !== null) this.#mergeAnchor = anchorOf(this.#mergeUserText);
    this.#restoreLines(this.#mergeAnchor);
    this.$merger = null;
    this.#mergeUserText = null;
    this.#mergeAnchor = '';
  }

  #restoreLines(anchor: string): void {
    for (const line of this.$merger?.take(anchor) ?? []) this.#restoreLine(line);
  }

  #restoreLine(line: KeptLine): void {
    const data = isDict(line.data) ? { ...line.data, restored: true } : { value: line.data, restored: true };
    this.event(line.kind, data, line.time); // no note of its own: a rebuild merges them again from the `lines` note
  }

  static $result(result: Json): unknown {
    return agentResult(result);
  }

  // ---- open elsewhere (ownership/handoff.ts) ---------------------------------------------------------------------------------
  /**
   * Another app's Claude Code process holds this chat's session (Claude Code's session registry names it). `released`: AIB closed
   * its session (session/close: the Claude process ended, the adapter and its keeper channel stay) and loads it again when the
   * person comes back. null: AIB holds the session.
   */
  elsewhere: Elsewhere | null = null;
  /** AIB hook (handoff.ts): who else holds this chat's session now; null when nobody does (or AIB cannot tell). */
  holderNow: (() => Promise<Holder | null>) | null = null;
  /** AIB hook: this chat let go of its session ('released') or took it back ('back'). */
  onElsewhere: ((connection: Connection, what: 'released' | 'back') => void) | null = null;
  /** Processes the person chose Open here anyway over: their holding no longer makes this chat let go. */
  readonly overriddenHolders = new Set<number>();
  $sessionMcp: McpServer[] = [];
  /** Set while a session/load after a hand-off runs: the history the agent sends back is held here, not shown again. */
  $reload: { window: ReplayWindow; discard: boolean } | null = null;
  $releasing = false;
  $reclaiming: Promise<{ state: 'attached' | 'back' | 'held'; app?: string; picked?: number }> | null = null;
  /** The text of the last user message this chat showed (sent here, or replayed by the agent): where the outside turns begin. */
  $lastUserText = '';
  $inUserText = false;

  /**
   * One writer at a time: Codex refuses a second app on a thread (codex_threads.ts), so a Codex chat another app holds cannot be
   * opened here anyway; it waits until it is closed there.
   */
  get singleWriter(): boolean {
    return isCodexFamily(this.provider);
  }

  // ---- settings changes: applied now between turns, queued during a turn -----------------------
  static changeKey(kind: string, configId: unknown = null): string {
    return changeKey(kind, configId);
  }

  /** A model-server chat (set by AIB): the server's models, and the model a new chat starts with. null for every other chat. */
  serverModels: { models: string[]; model: string } | null = null;
  $serverCurrent = '';

  // ---- the landing lock (build plan 1b, 2.3, MF 2) ---------------------------------------------------------------------------
  /** The lock a landing in this chat's folder holds: while set, every prompt source queues instead of starting a turn. */
  landing: { id: string; owner: string; title: string; at: number } | null = null;
  $landingTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * AIB hook (subagent worktrees): this child (its agentId) works in its own worktree AIB made, so a landing in this chat's folder
   * can't change anything under it. Null: none is.
   */
  subagentIsolated: ((child: string) => boolean) | null = null;
  /**
   * Claude Code: child session `child` (its agentId) is a background subagent of this chat (subagents/service.ts inBackground): a
   * stopped turn leaves its open approvals and questions alone, as for a helper from an earlier turn. Set by AIB.
   */
  subagentInBackground: ((child: string) => boolean) | null = null;

  // ---- send later: messages that wait for a time, then join the after-turn queue ------------------------------------------------
  /** Tests inject a fake clock (epoch ms) to move time without waiting. */
  scheduleNow: () => number = () => Date.now();
  $scheduleTimer: ReturnType<typeof setTimeout> | null = null;

  /** A time this late or later (ms after the scheduled time) counts as "sent late": AIB was not running at the time. */
  static readonly SCHEDULE_LATE_MS = SCHEDULE_LATE_MS;

  /** Send the first waiting message if nothing stops it: idle, no hold, no edit lease on it, nobody waiting on the user. */
  $restartAsked = false;

  $staleError(key: unknown, what: string): ValueError {
    const reason = isStr(key) ? this.withdrawn.get(key) : undefined;
    return new ValueError(
      reason ? `This ${what} was withdrawn: ${reason}` : `This ${what} is no longer pending`,
    );
  }

  route(sessionId: unknown): string {
    if (sessionId === null || sessionId === undefined) return 'setup';
    if (sessionId === this.sessionId) return 'main';
    return isStr(sessionId) && this.knownSessions.has(sessionId) ? 'subagent' : 'unknown';
  }

  $noteWithdrawn(
    key: string,
    kind: string,
    reason: string,
    sessionId: unknown = null,
  ): void {
    this.withdrawn.delete(key);
    this.withdrawn.set(key, reason);
    while (this.withdrawn.size > 200) {
      this.withdrawn.delete(this.withdrawn.keys().next().value!);
    }
    this.event('request_withdrawn', {
      key,
      kind,
      reason,
      sessionId: sessionId ?? null,
    });
  }

  $replyQuietly(rpcId: unknown, result: Json): void {
    try {
      this.write({ jsonrpc: '2.0', id: rpcId, result });
    } catch (error) {
      if (!isOsOrValueError(error)) throw error;
    }
  }

  $receiptChanged(clientMessageId: string): void {
    const hook = this.recovery;
    const found = this.promptReceipts.get(clientMessageId);
    if (hook && found) hook.receiptChanged(this, clientMessageId, { ...found });
  }

  /**
   * {systemPrompt: ...} that tells the agent about AIB's artifact tool, or {} when this chat has no such tool or the agent does
   * not advertise client system prompts (ACP unstable `systemPrompt`; appended after the agent's own).
   */
  /**
   * {_meta: {claudeCode: {options: {settings}}}} for a Claude chat whose subagents get their own worktree (subagents/claude_config.ts
   * hookSettings: the command hooks; never written to ~/.claude), or {}. The same object on every session/new and session/load.
   */
  claudeMeta(): Json {
    const settings = mergeClaudeSettings(this.subagentHooks?.settings ?? this.subagentHooks?.deny ?? null, this.toolServers?.claude ?? null);
    return settings ? { _meta: { claudeCode: { options: { settings: structuredClone(settings) } } } } : {};
  }

  /**
   * Codex (codex-acp 2.6, docs/mcp-startup-await-timeout.md): session/new, session/load and session/resume carry
   * `_meta.mcpStartupAwaitTimeoutMs`; without it codex-acp does not wait for the MCP servers, and Codex builds the first turn's tool
   * catalog after 1 s, which AIB's forwarder can miss. Not `required`: with AIB closed a required server would fail the chat
   * (architect review, must-fix 5). A server that does not come up in time ends the wait; its startup-failed card shows as before.
   */
  codexMeta(): Json {
    return isCodexFamily(this.provider) ? { _meta: { mcpStartupAwaitTimeoutMs: CODEX_MCP_STARTUP_WAIT_MS } } : {};
  }

  artifactPrompt(servers: unknown[] | null): Json {
    const own = (servers ?? []).some(isOwnArtifactEntry);
    const local = this.localOnlyText();
    const brief = this.scratchDir ? houseRules(this.scratchDir) : ''; // allow rules: the house rules with the literal scratch path
    // hooks given: subagents that edit get their own worktree (the same text on every reopen, whatever a later re-read says);
    // hooks off at the start (settings, or no Git Bash): they are turned off (P2)
    const subagents = this.subagentHooks?.prompt ? this.subagentHooks.prompt : isDict(this.subagentHooks?.settings?.hooks) ? SUBAGENT_PROMPT : this.subagentHooks?.deny
      ? (this.subagentHooks.off === 'Git Bash not found' ? SUBAGENTS_OFF_NO_BASH_PROMPT : SUBAGENTS_OFF_PROMPT)
      : this.subagentRule; // Antigravity: asked for, not enforced
    const base = this.promptBase(servers);
    if (!own && !local && !brief && !subagents) {
      this.promptServed?.('', base);
      return {};
    }
    const out: Json = {};
    // Presence is support (ACP capability objects): codex-acp advertises `systemPrompt: {}`, which a truthiness test missed.
    if (isDict(this.#sessionCaps()?.systemPrompt)) {
      const content: Json[] = own ? [{ type: 'text', text: this.wsl ? WSL_ARTIFACT_PROMPT : ARTIFACT_PROMPT }] : [];
      const worktree = this.worktree;
      if (own && worktree) { // only a chat that works in its own worktree (the merge tool comes with it)
        content.push({
          type: 'text',
          text: WORKTREE_PROMPT.replace('{branch}', worktree.branch ?? '')
            .replaceAll('{base}', worktree.base || 'the project branch'),
        });
      }
      if (brief) content.push({ type: 'text', text: brief });
      if (local) content.push({ type: 'text', text: local });
      if (subagents) content.push({ type: 'text', text: subagents });
      out.systemPrompt = { mode: 'append', content };
    }
    this.promptServed?.(JSON.stringify(out.systemPrompt ?? null), base);
    return out;
  }

  /**
   * The hash of AIB's own fixed prompt texts for this chat (the artifact prompt, the worktree prompt): what a new AIB version can
   * change. The per-chat facts in the prompt (folders, house rules) are left out: a restart sends them again as they are.
   */
  promptBase(servers: unknown[] | null = null): string {
    const own = (servers ?? (this.$sessionMcp.length ? this.$sessionMcp : this.mcpServers) ?? []).some(isOwnArtifactEntry);
    if (!own) return '';
    const parts = [this.wsl ? WSL_ARTIFACT_PROMPT : ARTIFACT_PROMPT];
    if (this.worktree) parts.push(WORKTREE_PROMPT.replace('{branch}', this.worktree.branch ?? '').replaceAll('{base}', this.worktree.base || 'the project branch'));
    return promptHash(parts.join(' | '));
  }

  /** Can the agent reload its session (session/load or session/resume)? Read from its own initialize answer. */
  canReloadSession(): boolean {
    const caps = sessionCapabilities(this.initial);
    return caps.loadSession || caps.resume;
  }

  /**
   * Why AIB may not restart this chat right now, or '' when it may. Restarting stops the agent process, so: never mid-turn (a pending
   * approval is mid-turn too), never while the chat opens or replays, and never while a background process or helper of the chat runs.
   * Not a blocker: a waiting question, a queued message, a scheduled message.
   */
  restartBlocker(): string {
    if (this.closed || this.$closing) return 'closed';
    if (this.rebuildError) return 'read-only';
    if (!this.ready || !this.sessionId || this.$replaying) return 'opening';
    if (this.busy) return 'mid-turn';
    if (this.permissions.size || this.elicitations.size) return 'mid-turn';
    if (this.auth) return 'signing in';
    if (this.landing) return 'landing';
    if (this.elsewhere) return 'open elsewhere';
    if (this.queue.inflight) return 'sending';
    if (this.helpersRunning()) return 'helpers running';
    if (this.backgroundShellsRunning()) return 'background process';
    return '';
  }

  /** The agent's `sessionCapabilities` from initialize, or null. */
  #sessionCaps(): Json | null {
    const caps = isDict(this.initial) ? get(pyTruthy(this.initial) ? this.initial : {}, 'agentCapabilities') : null;
    const sessionCaps = isDict(caps) ? get(caps, 'sessionCapabilities') : null;
    return isDict(sessionCaps) ? sessionCaps as Json : null;
  }

  /** What this chat is told about local-only files ('' when nothing). */
  localOnlyText(): string {
    const lo = this.localOnly;
    if (!lo) return '';
    const folder = lo.shared ? SHARED_FOLDER_PROMPT : '';
    if (!this.worktree) return folder;
    const ignored = lo.ignored ? [...lo.ignored.dirs, ...lo.ignored.files] : [];
    const ignoredText = ignored.length ? IGNORED_SHARED_WORKTREE.replace('{paths}', ignored.join(', ')) : '';
    // aib-shared/ itself is in the copy too (its link): only the other local-only paths are named by their main-folder path
    const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
    const others = lo.entries.filter((e) => !(lo.shared && same(e, lo.shared)));
    const othersText = others.length ? LOCAL_ONLY_WORKTREE_PROMPT.replace('{paths}', others.join(', ')) : '';
    return [folder, othersText, ignoredText].filter(Boolean).join(' ');
  }

  /**
   * {additionalDirectories: [...]} for a worktree chat whose project has local-only folders, when the agent advertises the ACP
   * session capability (Claude Code's and Codex's adapters do): those folders of the main folder become writable for it. Never the
   * main folder itself. Also the chat's scratch folder, and a Codex chat's own subagent-worktree folder (codex-acp adds each to the
   * sandbox's writable roots: Workspace mode then lets its subagents write in their worktrees as the chat writes in its folder).
   * {} otherwise.
   */
  extraFolders(): Json {
    const own = this.worktree ? [...(this.localOnly?.dirs ?? []), ...(this.localOnly?.ignored?.dirs ?? [])] : [];
    // a Codex chat's subagent folder: only its own subagents' worktrees go there (never the folder's parent or other chats' copies)
    const sub = isCodexFamily(this.provider) && this.subagentHooks?.subFolder ? [this.subagentHooks.subFolder] : [];
    // Antigravity with subagent isolation: the project is its only workspace (the scratch folder is left out). With more, agy makes a
    // folder per workspace for each subagent and starts the subagent in the copy of the FIRST one (the scratch folder), not in its git
    // worktree (subagents/antigravity.ts). Its writes to the scratch folder still go through AIB's allow rules as permission requests.
    const onlyProject = this.provider === 'antigravity' && !!this.subagentHooks?.agyDir;
    const dirs = [...own, ...(this.scratchDir && !onlyProject ? [this.scratchDir] : []), ...sub];
    if (!dirs.length || !isDict(this.#sessionCaps()?.additionalDirectories)) return {};
    return { additionalDirectories: [...dirs] };
  }

  // ---- allow rules in a WSL chat (allow/linux.ts, allow/wsl_facts.ts) ---------------------------------------------------------
  /** What AIB has learnt of this WSL chat's distro for the matcher. */
  $linuxFacts = new LinuxFacts();
  /** The start's fetch of the chat folder and the base facts (AIB waits for it briefly). */
  allowWarming: Promise<void> | null = null;

  /** Drafts of cards shown lately, by key: "Save the rule anyway?" after another device answered first. */
  $allowSeen = new Map<string, { params: Json; draft: Json | null }>();

  /** Stop one child only when the agent announced a cancel capability for it. */
  cancelSubagent(childSessionId: unknown): void {
    const entry = isStr(childSessionId) ? this.subagents.get(childSessionId) : undefined;
    if (this.closed || !this.ready) {
      throw new ValueError('This connection is not ready');
    }
    if (
      !entry || !isDict(entry.capabilities) ||
      !Object.hasOwn(entry.capabilities, 'cancel')
    ) {
      throw new ValueError(
        'This agent did not advertise cancellation for that subagent',
      );
    }
    if (
      [
        'idle',
        'completed',
        'complete',
        'failed',
        'cancelled',
        'canceled',
        'stopped',
      ].includes(entry.state as string)
    ) {
      throw new ValueError('That subagent is not running');
    }
    this.write({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: childSessionId },
    });
  }

  #inBackground(child: string): boolean {
    try {
      return !!this.subagentInBackground?.(child);
    } catch (error) {
      log.exception(error, 'subagentInBackground failed');
      return false;
    }
  }

  cancel(subagent: unknown = null): void {
    this.$refuseReadOnly();
    if (subagent !== null && subagent !== undefined) {
      return this.cancelSubagent(subagent);
    }
    // ACP prompt-turn cancellation: answer every pending permission request with the `cancelled` outcome FIRST (recorded as
    // withdrawn), then notify session/cancel; the agent ends the turn with stopReason `cancelled`.
    this.cancelSeq = this.promptSeq;
    if (this.busy && !this.autonomous) this.$laneInterrupted();
    // B7: a helper still running in the background from an earlier turn goes on, so its approval stays open; everything else this
    // turn asked (the main session's, a helper the turn waits for) is answered cancelled, as before.
    // A helper this turn started with run_in_background (or moved to the background) is one too (owner, 2026-11-16).
    const background = (sid: unknown) =>
      isStr(sid) && sid !== this.sessionId && this.$liveHelpers.has(sid) && (!this.$turnHelpers.has(sid) || this.#inBackground(sid));
    this.$clearPermissions({
      everything: true,
      except: background,
      reason: 'The turn was cancelled.',
    });
    if (this.sessionId && !this.closed) {
      try {
        this.write({
          jsonrpc: '2.0',
          method: 'session/cancel',
          params: { sessionId: this.sessionId },
        });
      } catch (error) {
        if (!isOsOrValueError(error)) throw error;
      }
    }
    this.$clearElicitations({
      scoped: true,
      except: background,
      reason: 'The turn was cancelled.',
    });
    if (this.autonomous) void this.$endAutonomous('cancelled'); // stopped: its result may never come
  }

  async #waitExit(ms: number): Promise<boolean> {
    if (!this.$exited) return true;
    return (await within(this.$exited.then(() => true), ms)) === true;
  }

  async close(): Promise<void> {
    if (this.$closing) return;
    this.$closing = true;
    if (this.$scheduleTimer !== null) clearTimeout(this.$scheduleTimer);
    this.$scheduleTimer = null;
    let stop = false;
    let deadChannel = false;
    try {
      for (const key of [...this.permissions.keys()]) {
        if (!this.rebuildError) this.permission(key, null);
      }
      this.$clearElicitations({});
      if (this.busy && !this.rebuildError) this.cancel();
      if (this.channel !== null && this.channel.unreachable) {
        // The keeper connection is already gone: nothing can answer a stdin close, so waiting for the exit would only run out the
        // clock. Go straight to the kill step below (one short wait).
        this.$stdinClosed = true;
        stop = true;
        deadChannel = true;
      } else if (this.channel !== null) {
        if (this.rebuildError) await this.channel.claim().catch(() => 0); // read-only until now: take it over to stop it
        this.$stdinClosed = true;
        void this.channel.closeStdin(); // ACP adapters exit on it, as on a closed pipe
        if (!(await this.#waitExit(5000))) stop = true;
      } else if (this.process !== null) {
        this.$stdinClosed = true;
        this.$stdin?.close().catch(() => {});
        if (!(await this.#waitExit(5000))) stop = true;
      }
    } catch (error) {
      if (!isOsError(error) && !(error instanceof ValueError)) throw error;
      stop = true;
    }
    if (stop && !deadChannel && this.process !== null) {
      try {
        this.process.kill('SIGTERM');
      } catch { /* already gone */ }
      await this.#waitExit(3000);
    }
    // The adapter had its chance to exit cleanly; now take down whatever it left running (claude CLI, MCP servers, ...).
    if (this.process !== null) {
      this.tree!.kill();
      await this.#waitExit(deadChannel ? 300 : 3000);
    }
    if (this.channel) this.channelRemoved = this.channel.remove(); // closed: its keeper record is not needed any more
    // its history store is kept (owner rule 2026-11-17): reopening the conversation goes on in it under this chat id
    await this.$historyFinish();
    this.closed = true;
    if (this.closedAt === null) this.closedAt = now();
    this.ready = false;
    await this.$shutdownCaps();
    this.releaseLease();
    if (this.recovery) this.recovery.connectionClosed(this);
    if (this.process !== null) {
      await within(this.$readTask!, 2000);
      await within(this.$errorTask!, 2000);
      // A pipe still open after all that (a grandchild outside the job kept it): stop reading it so nothing leaks.
      for (const reader of [this.$stdoutReader, this.$stderrReader]) {
        try {
          await reader?.cancel();
        } catch { /* released: read to the end */ }
      }
    }
  }

  /**
   * Cheap summary for the sidebar, status line, notifications and the inbox. needs_you wins over working. `state` keeps its old
   * meaning (quit, idle exit and the keeper's lifecycle read it); `phase` and the facts after it are the inbox's (inbox-rules.js):
   * helpers (Claude Code's helpers still running, each for at most an hour), shells (a background shell started in the last 30
   * minutes still runs), followUntil (the follow-up window after the last of them ended), failedAt / error / failKind (the agent
   * reported an error for the last turn), asksAt / question (the last reply asks you something in plain text).
   */
  attention(): Json {
    const needs = this.permissions.size + this.elicitations.size +
      (this.auth ? 1 : 0); // includes subagent requests
    const state = this.closed ? 'closed' : needs ? 'needs_you' : !this.ready ? 'opening' : this.busy ? 'working' : 'idle';
    const iso = (t: number | null) => t ? new Date(Math.floor(t) * 1000).toISOString().slice(0, 19) + 'Z' : null;
    const exact = (t: number | null) => t ? new Date(Math.round(t * 1000)).toISOString() : null; // compared with mark times
    const started = this.busy && !this.closed ? this.turnStartedAt : null;
    const at = this.$now();
    const helpers = this.closed
      ? 0
      : [...this.$liveHelpers].filter((h) => at - (this.$helperSince.get(h) ?? at) < INBOX.HELPER_CAP_SECONDS).length;
    // a finished subagent's own runs count as the chat's background processes: the chat is working while they go on
    const shells = !this.closed && (this.#shellsRunning(at) || this.#ownRuns() > 0);
    const work = helpers > 0 || shells;
    if (this.#hadWork && !work && !this.$workEndedAt) this.$workEndedAt = at; // a shell's end is seen by looking
    if (work) this.$workEndedAt = null;
    this.#hadWork = work;
    const ended = this.$workEndedAt;
    const followUntil = ended && ended >= (this.turnEndedAt ?? 0) ? ended + followUpSeconds() : null;
    const facts = {
      helpers,
      shells,
      followUntil: exact(followUntil),
      failedAt: exact(this.turnFailedAt),
      error: this.turnFailedAt ? this.turnError : '',
      failKind: this.turnFailedAt ? INBOX.classifyError(this.turnError) : '',
      asksAt: exact(this.$asks?.at ?? null),
      question: this.$asks?.question ?? '',
      ...this.#stallFacts(at, needs, helpers, shells, exact),
    };
    return {
      state,
      needs: state === 'closed' ? 0 : needs,
      turnEndedAt: iso(this.turnEndedAt),
      busySince: iso(started),
      phase: INBOX.basePhase({ closed: this.closed, ready: this.ready, busy: this.busy, needs, ...facts }, at),
      ...facts,
    };
  }

  /**
   * The stall facts (Inbox v3.1): a saved S1 / S2 stall, or S3 read now: a turn that runs with no stream event for QUIET_SECONDS,
   * nothing open, no helper or background shell, and no tool call of this turn still in progress that started within
   * TOOL_CAP_SECONDS (a long npm test is work). lastOutputAt always (seconds, exact ISO).
   */
  #stallFacts(at: number, needs: number, helpers: number, shells: boolean, exact: (t: number | null) => string | null): Json {
    const out: Json = { lastOutputAt: exact(this.$lastOutputAt) };
    if (this.$stall) return { ...out, stalledAt: exact(this.$stall.at), stallKind: this.$stall.kind, stallStep: this.$stall.step };
    const quietSince = this.$lastOutputAt ?? this.turnStartedAt;
    if (!this.busy || this.closed || needs || helpers || shells || !quietSince || at - quietSince < quietSeconds()) return out;
    const toolRuns = [...this.$tools.values()].some((t) =>
      t.turn === this.promptSeq && t.status !== 'completed' && t.status !== 'failed' && at - t.since < INBOX.TOOL_CAP_SECONDS
    );
    if (toolRuns) return out;
    return { ...out, stalledAt: exact(quietSince), stallKind: 'quiet', stallStep: this.$lastStep };
  }

  /** A background shell started within the inbox's cap still runs (the OS is asked at most every 2 s). */
  #ownRuns(): number {
    try {
      return this.ownRuns?.(this) ?? 0;
    } catch (error) {
      log.exception(error, 'ownRuns failed');
      return 0;
    }
  }

  #shellsRunning(at: number): boolean {
    if (!this.$bgShells.size) return false;
    const seen = this.$shellsSeen;
    if (!seen || at - seen.at >= 2 || at < seen.at) {
      const running = this.backgroundShellsRunning();
      for (const task of [...this.$shellSince.keys()]) if (!this.$bgShells.has(task)) this.$shellSince.delete(task);
      const capped = running && [...this.$bgShells.keys()].some((t) => at - (this.$shellSince.get(t) ?? at) < INBOX.SHELL_CAP_SECONDS);
      this.$shellsSeen = { at, running: capped };
    }
    return this.$shellsSeen!.running;
  }

  /**
   * The turn just ended: does its last reply ask you something (inbox-rules.js asksOf)? The reply is the main session's message
   * after its last tool call. The same on a rebuild from the keeper's record, which replays the same events.
   */
  $noteAsks(): void {
    const parts: string[] = [];
    let size = 0;
    let step: string | null = null; // the main tool call the walk stopped at (the turn's last step)
    for (let i = this.events.length - 1; i >= 0 && size < 16384; i--) {
      const e = this.events[i];
      if (e.kind === 'user' || e.kind === 'turn_end') break;
      if (e.kind !== 'update' || !isDict(e.data) || get(e.data, 'sessionId') !== this.sessionId) continue;
      const update = get(e.data, 'update');
      if (!isDict(update)) continue;
      const kind = get(update, 'sessionUpdate');
      if (kind === 'tool_call') {
        const meta = get(update, '_meta');
        const claude = isDict(meta) ? get(meta, 'claudeCode') : null;
        if (!(isDict(claude) && get(claude as Json, 'parentToolUseId'))) {
          const title = get(update, 'title');
          step = isStr(title) ? title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
          break;
        }
      }
      if (kind !== 'agent_message_chunk') continue;
      const content = get(update, 'content');
      const text = isDict(content) ? get(content, 'text') : null;
      if (isStr(text)) {
        parts.push(text);
        size += text.length;
      }
    }
    const words = parts.reverse().join('');
    const found = INBOX.asksOf(words.slice(-16384)); // the reply's end: one chunk may be megabytes
    this.$asks = found.asks ? { at: this.$now(), question: found.question } : null;
    // S2: the turn ended after a tool call with no word from the agent after it ("no final message")
    this.$stall = step !== null && !words.trim() ? { at: this.$now(), kind: 'silent_end', step: step || this.$lastStep } : null;
  }

  /** Wire form of this connection. light=true is the sidebar listing: no events and no permission bodies. */
  public(after = 0, light = false): Json {
    const events = this.events;
    // Being rebuilt from the keeper's record: no events yet, and the page keeps its cursor (the rebuilt chat numbers them the same).
    const rebuilding = this.$replaying && !this.rebuildError && !this.closed;
    // A cursor past the end belongs to another numbering (an older record without its AIB events): send everything again.
    const stale = !rebuilding && after > this.sequence;
    const data: Json = {
      attention: this.attention(),
      id: this.id,
      provider: this.provider,
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      ...(this.wsl ? { wsl: { distro: this.wsl.distro, name: distroName(this.wsl.distro), linuxPath: this.wsl.linuxPath } } : {}),
      sessionId: this.sessionId,
      busy: this.busy,
      closed: this.closed,
      ownerTouched: this.ownerTouched,
      error: this.error,
      // open elsewhere: another app holds this chat; `released` once AIB let go of it (ownership/handoff.ts)
      ...(this.elsewhere ? { elsewhere: { app: this.elsewhere.app, released: this.elsewhere.released } } : {}),
      settings: this.settings,
      queue: this.queue.public(light),
      // Steer-on-send: the composer keys on `steerable` alone; steerAgent picks the page's hint copy; the lane of messages sent
      // while the agent works; background tool rows ({toolCallId: {state, stoppable}}).
      steerable: this.steerable(),
      // Claude Code's own follow-up cycle (busy, but no turn of ours). It takes a message in (steerable, owner 2026-11-17): Send now
      // prompts it into the cycle; another agent's (not expected) is not steerable and the queue box says why.
      autonomous: this.busy && this.autonomous,
      steerAgent: STEER_AGENTS.has(claudeBase(this.provider)) ? claudeBase(this.provider) : null,
      steerLane: this.queue.steerPublic(light),
      toolBackground: this.toolBackground(),
      // Subagent worktrees (P1; Activity's chips are P3): on, or why not ("hooks are off", "not a git project", "WSL, coming", ...)
      // P3: plus the read-only types (they work in the folder) and, per subagent by agentId, where it works and how its work lands
      ...(this.subagentHooks
        ? {
          subagentIsolation: { on: this.subagentIsolationOn(), reason: this.subagentHooks.off, readOnly: this.subagentHooks.readOnly },
          ...(this.subagentSyncing?.() ? { subagentSync: true } : {}),
          ...(this.subagents.size && this.subagentActivity ? { subagentWorktrees: this.#subagentActivitySafe() } : {}),
        }
        : this.geminiSubagents
        ? { // Gemini (subagents/gemini.ts): on when its edits are moved into a worktree; else why the fence alone runs
          subagentIsolation: { on: !!this.geminiSubagents.subFolder, reason: this.geminiSubagents.off, readOnly: ['codebase_investigator', 'cli_help'] },
          ...(this.subagentActivity ? { subagentWorktrees: this.#subagentActivitySafe() } : {}),
        }
        : {}),
      pendingChanges: [...this.pendingChanges.values()].map((v) => ({ ...v })),
      changeFailures: this.changeFailures.map((v) => ({ ...v })),
      state: this.closed
        ? 'closed'
        : this.elicitations.size || this.permissions.size || this.auth
        ? 'input_needed'
        : !this.ready || rebuilding
        ? 'opening'
        : this.busy
        ? 'working'
        : 'ready',
      // Not ready until the rebuild has replayed the whole record: a restored snapshot sets `ready` before the records after it
      // (a running turn's prompt among them) are replayed, so a page (or test) asking in between would see an idle chat mid-turn.
      ready: !!(this.ready && !this.closed && !rebuilding),
      subagents: Object.fromEntries(
        [...this.subagents].map(([k, v]) => [k, { ...v }]),
      ),
      imageSupported: this.imageSupported,
      promptCapabilities: { ...this.promptCaps },
      breadth: publicState(this),
      events: light || rebuilding ? [] : stale ? [...events] : events.filter((e) => (e.seq as number) > after),
      cursor: rebuilding ? after : this.sequence,
      reset: stale || !!(!rebuilding && events.length && after && after < (events[0].seq as number) - 1),
      setupDone: this.openDone.isSet(),
      auth: this.auth ? { ...this.auth } : null,
      permissions: light ? [] : [...this.permissions].map(([k, v]) => ({
        key: k,
        params: v.params,
        ...(this.allowGate ? { allow: this.$allowRemember(k, v) } : {}),
        route: this.route(isDict(v.params) ? get(v.params, 'sessionId') : null),
      })),
      elicitations: [...this.elicitations].map(([k, v]) => ({
        key: k,
        params: v.params,
        route: this.route(get(v.params, 'sessionId')),
      })),
      clientCaps: this.caps.public(),
      unknownReceipts: this.unknownReceipts(),
    };
    if (this.pickResults.length) data.pickResults = this.pickResults.map((v) => ({ ...v })); // a new chat's start picks (Deno only)
    if (this.rebuildError) data.readOnly = true; // rebuilt from the keeper's record but not continuable (error says why)
    if (rebuilding) data.rebuilding = true;
    if (this.channel) data.eventsId = this.eventsId; // a chat in the keeper: its numbering survives a rebuild (chat.js compares it)
    if (this.worktree) data.worktree = { ...this.worktree }; // only a worktree chat has this key; the page does not show it yet
    if (this.swarm) data.swarm = { ...this.swarm };
    return data;
  }

  /** Messages that were mid-send when AIB last restarted and are still unresolved (see state_store). */
  unknownReceipts(): unknown[] {
    const store = this.recovery?.store ?? null;
    return store && this.sessionId ? store.unknownReceipts(this.provider, this.sessionId) : [];
  }
}

// Methods moved to their own modules (no change): the interface gives Connection their types, installMethods their code.
export interface Connection extends ReplayMethods, HistoryMethods, ToolMethods, IoMethods, SetupMethods, HandoffMethods, TurnMethods, SteerMethods, QueueMethods, AllowMethods {}
installMethods(Connection, replayMethods, historyMethods, toolMethods, ioMethods, setupMethods, handoffMethods, turnMethods, steerMethods, queueMethods, allowMethods);

// Moved out (no change); re-exported so every importer of this file keeps working.
export { MAX_EVENTS, RuntimeError, TimeoutError, BrokenPipeError, errorName, errorText, pyEq, sortedCompactJson } from './conn_util.ts';
export { ThreadEvent, PyTextLines } from './thread_text.ts';
export type { ClientCapsLike, CapsFactory, Receipt, ConnectionRecovery, SessionLease, AuthState, PendingChange, ConnectionOptions, ContinueStore, WslSpawn } from './conn_types.ts';
export { SNAPSHOT_VERSION, MAX_SNAPSHOT_BYTES, HISTORY_FLUSH_MS, HISTORY_HELPER_TAIL, historyV2, EVENT_CHUNK_BYTES, KEEPER_LOST } from './conn_limits.ts';
export type { CheckpointStep } from './conn_limits.ts';
export { isFixture, guardRealAgent, HOME_VARS, TEMP_VARS, testHomeEnv, guardRealAgentAuth, resolveProgram } from './launch_env.ts';
export { TOOLS_LOADING, COMMANDS_RULE, ARTIFACT_PROMPT, WSL_ARTIFACT_PROMPT, CODEX_MCP_STARTUP_WAIT_MS, WORKTREE_PROMPT, SHARED_FOLDER_PROMPT, LOCAL_ONLY_WORKTREE_PROMPT, IGNORED_SHARED_WORKTREE, SHARED_FOLDER_CONTEXT, sharedFolderNote } from './prompts.ts';
export { OWN_ARTIFACT_TOOL, SWARM_TOOL_NAMES, ownToolName, ownToolAction, backgroundTask, NotStoppable, isOwnArtifactEntry, subagentEnd } from './tool_tracking.ts';
export { STEER_AGENTS, TERMINAL_SIGNIN_PROVIDERS, steerTiming, isAgentBusyError, busyRetry, STEER_FAILED_NOTE, CODEX_UNREAD_NOTE } from './conn_steer.ts';
export { REPLAY_WINDOW_BYTES, ReplayWindow, outsideTurns } from './replay_window.ts';
