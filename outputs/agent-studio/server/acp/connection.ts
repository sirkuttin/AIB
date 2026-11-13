/**
 * The ACP side of the agent host (acp_connection.py): Connection, one agent process spoken to over JSON-RPC on stdio.
 *
 * Python ran a reader thread, a stderr thread and one thread per prompt turn, guarded by an RLock. Here they are async tasks on one
 * event loop. Every Python `with self.lock:` block does no blocking work, so each becomes a stretch of synchronous code with no
 * `await` inside; the orderings the lock gave (one prompt at a time, receipts before the turn starts, events in arrival order,
 * queued settings applied before `busy` clears) hold because nothing can run in between.
 *
 * JSON keys, event kinds and error messages are Python's word for word: they reach the page through the host RPC.
 */
import { createHash } from 'node:crypto';
import { screen } from './acp_schema.ts';
import { CapError, ClientCaps, type FsMode, type TerminalBackend, type TerminalBase, type TerminalPlan } from './client_caps.ts';
import { clientTerminalChannel, clientTerminalNote, clientTerminalProblem, KeeperClientTerminal } from './keeper_terminal.ts';
import {
  applyUpdate,
  augmentInitialize,
  type BreadthState,
  buildConfigRequest,
  checkMode,
  currentValue,
  type McpServer,
  newState,
  optionValues,
  publicState,
  selectMcpServers,
  sessionCapabilities,
  isModelsOption,
  withModelsOption,
} from './breadth.ts';
import { validateContent, validateSchema, validateUrlRequest } from './elicitation.ts';
import { MessageQueue, type QueueItem, type SavedItem, STEER_RESTART_NOTE, type SteerItem } from './msgqueue.ts';
import { killVerified, type ProcId } from '../platform/kill_verified.ts';
import { type AuthMethod, describeAuthMethods, isAuthRequired, PromptStateUnknown, RpcError } from './rpc_errors.ts';
import {
  eventImageSize,
  type FileSummary,
  type ImageBlock,
  mapFileAttachments,
  MAX_EVENT_IMAGE_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
  splitAttachments,
  validateFileAttachments,
  validateImageAttachments,
} from './attachments.ts';
import { WriteTracker } from '../artifacts/artifacts.ts';
import { findOption as findPickOption } from '../state/agent_options.ts';
import { betaAgent } from '../agents/beta_catalog.ts';
import { artifactToolCommand } from '../artifacts/mcp.ts';
import { isOwnForwardEntry, isOwnMcpUrl } from '../artifacts/mcp_http.ts';
import { type Killable, ProcessTree, treeSpawnOptions } from '../platform/process_tree.ts';
import { descendants, refreshDescendants } from '../platform/descendants.ts';
import type { ChannelInfo, KeeperRecord } from '../keeper/client.ts';
import { type KeeperChannel, type KeeperChannelListener, type KeeperLink, parseNote } from '../keeper/link.ts';
import { projectOfWorktree } from '../worktrees/worktrees.ts';
import { APP_VERSION, TESTS_DIR } from '../core/app.ts';
import { getLogger } from '../core/log.ts';
import { DOCS_RULE } from '../docs/tool_defs.ts';
import {
  clip,
  isDict,
  isInt,
  isStr,
  PY_SPACE,
  pyCompare,
  pyLen,
  pyRepr,
  pyStr,
  pyStrip,
  pyTruthy,
  pyTypeName,
  ValueError,
} from '../core/py.ts';

const log = getLogger('acp_connection');

export const MAX_EVENTS = 6000;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

type Json = Record<string, unknown>;

// ---- Python's exceptions, by name (the host RPC and the tests tell them apart by class name) ----------------------------------

export class RuntimeError extends Error {
  override name = 'RuntimeError';
}
export class TimeoutError extends Error {
  override name = 'TimeoutError';
}
/** Writing to an agent whose stdin is gone (Python: BrokenPipeError / OSError). */
export class BrokenPipeError extends Error {
  override name = 'BrokenPipeError';
}
class AttributeError extends Error {
  override name = 'AttributeError';
}

/** type(error).__name__ */
export function errorName(error: unknown): string {
  if (error instanceof PromptStateUnknown) return 'PromptStateUnknown';
  if (error instanceof RpcError) return 'RpcError';
  return error instanceof Error ? error.name : pyTypeName(error);
}

/** str(error) */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** except (OSError, ValueError): Deno's I/O errors, a broken pipe, or a ValueError of any ported module. */
function isOsOrValueError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (Object.values(Deno.errors).some((type) => error instanceof type)) {
    return true;
  }
  return ['ValueError', 'OSError', 'BrokenPipeError'].includes(error.name) ||
    error instanceof PromptStateUnknown;
}

function isOsError(error: unknown): boolean {
  return error instanceof Error &&
    (Object.values(Deno.errors).some((type) => error instanceof type) ||
      error.name === 'BrokenPipeError');
}

/** dict.get on something Python would call .get on: raises AttributeError when it is not a dict. */
function pget(value: unknown, key: string, fallback: unknown = null): unknown {
  if (!isDict(value)) {
    throw new AttributeError(
      `'${pyTypeName(value)}' object has no attribute 'get'`,
    );
  }
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** dict.get on a dict known to be one. */
function get(value: Json, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(value, key) ? value[key] : fallback;
}

/** Python == between JSON values (1 == 1.0 == True, dicts and lists by content). */
export function pyEq(a: unknown, b: unknown): boolean {
  if (
    (typeof a === 'number' || typeof a === 'boolean') &&
    (typeof b === 'number' || typeof b === 'boolean')
  ) {
    return Number(a) === Number(b);
  }
  if (a === null || a === undefined || b === null || b === undefined) {
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((v, i) => pyEq(v, b[i]));
  }
  if (isDict(a) && isDict(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length &&
      ka.every((k) => Object.hasOwn(b, k) && pyEq(a[k], b[k]));
  }
  return a === b;
}

/** json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')) for the prompt fingerprint. */
export function sortedCompactJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    return '[' + value.map(sortedCompactJson).join(',') + ']';
  }
  if (isDict(value)) {
    return '{' + Object.keys(value).sort(pyCompare).map((k) => JSON.stringify(k) + ':' + sortedCompactJson(value[k])).join(',') +
      '}';
  }
  return JSON.stringify(value);
}

const ENCODER = new TextEncoder();
const RSTRIP = new RegExp(`[${PY_SPACE}]+$`);

function now(): number {
  return Date.now() / 1000;
}

function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** secrets.token_urlsafe(n) */
function tokenUrlsafe(bytes: number): string {
  let text = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) {
    text += String.fromCharCode(b);
  }
  return btoa(text).replaceAll('+', '-').replaceAll('/', '_').replace(
    /=+$/,
    '',
  );
}

function sleep(ms: number): { promise: Promise<void>; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    done = resolve;
    timer = setTimeout(resolve, ms);
  });
  return { promise, cancel: () => (clearTimeout(timer), done()) };
}

/** `task` or false after `ms`; the timer never outlives the call. */
async function within<T>(task: Promise<T>, ms: number): Promise<T | false> {
  const timer = sleep(ms);
  try {
    return await Promise.race([task, timer.promise.then(() => false as const)]);
  } finally {
    timer.cancel();
  }
}

// ---- threading.Event -------------------------------------------------------------------------------------------------------

export class ThreadEvent {
  #set = false;
  #waiters = new Set<() => void>();

  isSet(): boolean {
    return this.#set;
  }

  set(): void {
    if (this.#set) return;
    this.#set = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const wake of waiters) wake();
  }

  clear(): void {
    this.#set = false;
  }

  /** True once set; false when `timeoutMs` passed first (no timeout: waits for ever). */
  wait(timeoutMs?: number): Promise<boolean> {
    if (this.#set) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const wake = () => {
        if (timer !== undefined) clearTimeout(timer);
        resolve(true);
      };
      this.#waiters.add(wake);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          this.#waiters.delete(wake);
          resolve(this.#set);
        }, Math.max(0, timeoutMs));
      }
    });
  }
}

// ---- text lines the way Python's text-mode pipe gives them -------------------------------------------------------------------

/**
 * Bytes in, lines out, as `for line in process.stdout` does with text=True, encoding='utf-8', errors='replace': invalid UTF-8
 * becomes U+FFFD, a BOM is kept, and universal newlines apply (\r\n and a lone \r end a line too). Lines come without their
 * line end (every caller strips it). Long lines are joined once, not grown chunk by chunk.
 */
export class PyTextLines {
  #decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  #parts: string[] = [];
  #pendingCR = false;

  /** No part of a line is waiting for its end (a keeper snapshot is only taken then). */
  get idle(): boolean {
    return !this.#parts.length && !this.#pendingCR;
  }

  /** Lines completed by this chunk. `final` flushes: an incomplete UTF-8 sequence becomes U+FFFD and the last line is returned. */
  feed(chunk: Uint8Array | null, final = false): string[] {
    let text = chunk ? this.#decoder.decode(chunk, { stream: !final }) : this.#decoder.decode();
    if (this.#pendingCR) {
      text = '\r' + text;
      this.#pendingCR = false;
    }
    if (!final && text.endsWith('\r')) {
      text = text.slice(0, -1);
      this.#pendingCR = true;
    }
    if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n');
    const lines: string[] = [];
    let start = 0;
    for (
      let index = text.indexOf('\n');
      index >= 0;
      index = text.indexOf('\n', start)
    ) {
      this.#parts.push(text.slice(start, index));
      lines.push(
        this.#parts.length === 1 ? this.#parts[0] : this.#parts.join(''),
      );
      this.#parts = [];
      start = index + 1;
    }
    if (start < text.length) this.#parts.push(start ? text.slice(start) : text);
    if (final && this.#parts.length) {
      lines.push(this.#parts.join(''));
      this.#parts = [];
    }
    return lines;
  }
}

// ---- what the Connection uses from its neighbours ------------------------------------------------------------------------------

/** What the Connection uses of client_caps.ClientCaps (the fs and terminal capabilities the agent may call back into). */
export interface ClientCapsLike {
  readonly workspace: string;
  capabilities(): Json;
  handles(method: string): boolean;
  /** Answer one agent->client request (through the write function it was given); resolves once answered. */
  dispatch(message: Json): void | Promise<void>;
  shutdown(): void | Promise<void>;
  public(): Json;
}

export type CapsFactory = (
  workspace: string,
  terminal: boolean,
  fs: FsMode,
  knownSession: (sid: string) => boolean,
  record: (kind: string, data: Json) => void,
  writeResponse: (message: Json) => void,
) => ClientCapsLike;

const defaultCaps: CapsFactory = (
  workspace,
  terminal,
  fs,
  knownSession,
  record,
  writeResponse,
) =>
  new ClientCaps(workspace, {
    terminal,
    fs,
    knownSession,
    record,
    writeResponse,
  });

export interface Receipt {
  fingerprint: string;
  state: string;
  /** Set once session/prompt was written to the agent: a deliberate stop then knows the agent had the message. */
  sent?: boolean;
}

/** The Recovery hook Studio installs (state/recovery.ts). Never throws into the caller. */
export interface ConnectionRecovery {
  receipt(connection: Connection, messageId: string): Receipt | null;
  receiptChanged(
    connection: Connection,
    messageId: string,
    receipt: Receipt,
  ): void;
  queueChanged(connection: Connection): void;
  connectionClosed(connection: Connection): void;
  store?:
    | { unknownReceipts(provider: string, sessionId: string): unknown[] }
    | null;
}

export interface SessionLease {
  release(): void;
}

export interface AuthState {
  methods: AuthMethod[];
  message: string;
  error: string;
  working: boolean;
}

interface Pending {
  done: ThreadEvent;
  method: string;
  params: unknown;
  response?: Json;
}

interface AgentRequest {
  rpcId: unknown;
  params: Json;
}

export interface PendingChange {
  key: string;
  kind: string;
  configId: unknown;
  value: unknown;
  queuedAt: number;
}

/** What one snapshot writes: chunk notes of the events since the last one, then the snapshot note (holding the last chunk). */
interface SnapshotPlan {
  chunks: Json[];
  note: Json;
  bytes: number;
  chunkBytes: number;
  last: number;
}

type Hook = (connection: Connection) => unknown;

export interface ConnectionOptions {
  enableTerminal?: boolean;
  enableFs?: FsMode;
  /** Extra variables for an agent the user added in Settings. */
  env?: Record<string, string> | null;
  /** false: the chat's worktree is still being made; startProcess() runs once its folder exists. */
  start?: boolean;
  capsFactory?: CapsFactory;
  /** Run the agent in the keeper instead of as a child of this process. */
  keeper?: KeeperLink | null;
  /** The connection id (a chat rebuilt from the keeper keeps the id it had). */
  id?: string;
  /** Rebuild this chat from a live keeper channel instead of starting an agent (needs `keeper`). */
  rebuild?: ChannelInfo | null;
}

/**
 * The format of a keeper `snapshot` note this code writes (its `sv`). 1: the whole event history inside the note (beta.8 and before;
 * still restored). 2: the note holds the chat's state without its history; each snapshot also stores only the events made since the
 * one before (in the note itself, or in `t: 'event'` chunk notes just before it when they do not fit), so a note stays small however
 * long the chat is, and the journal keeps the chunks the history still needs (truncate stops at the oldest of them).
 */
export const SNAPSHOT_VERSION = 2;
/** A snapshot note larger than this is not written (a note is at most 16 MiB); the replay then starts at the one before, or at 0. */
export const MAX_SNAPSHOT_BYTES = 12 * 1024 * 1024;
/** Events per chunk note, in UTF-8 bytes (several chunks when a snapshot has more new events, e.g. after a session/load). */
export const EVENT_CHUNK_BYTES = 4 * 1024 * 1024;

/** Why a keeper-run agent ended without being asked to: the keeper itself went away. */
export const KEEPER_LOST =
  'Interrupted: the keeper (the AIB process that holds running agents) stopped, so this agent stopped with it. Nothing was sent again.';

// ---- the test guard -----------------------------------------------------------------------------------------------------------

function resolvePath(part: string): string {
  try {
    return Deno.realPathSync(part);
  } catch {
    const absolute = /^([A-Za-z]:[\\/]|[\\/])/.test(part) ? part : Deno.cwd() + SEP + part;
    const out: string[] = [];
    for (const piece of absolute.split(/[\\/]+/)) {
      if (piece === '..') out.length > 1 && out.pop();
      else if (piece !== '.' && piece !== '') out.push(piece);
    }
    return (Deno.build.os === 'windows' ? '' : '/') + out.join(SEP);
  }
}

function normcase(path: string): string {
  return Deno.build.os === 'windows' ? path.replaceAll('/', '\\').toLowerCase() : path;
}

function isFixture(command: unknown): boolean {
  let fixtures: string;
  try {
    fixtures = normcase(resolvePath(TESTS_DIR)).replace(/[\\/]+$/, '');
  } catch {
    return false;
  }
  for (const part of Array.isArray(command) ? command : [command]) {
    const resolved = normcase(resolvePath(String(part)));
    if (
      resolved.startsWith(fixtures + SEP) &&
      resolved.length > fixtures.length + 1
    ) return true;
  }
  return false;
}

/**
 * Under test (AGENT_STUDIO_TEST=1) a Connection may only start a fixture from the repo's work/ folder; anything else would launch
 * a real agent, so it fails loudly. STUDIO_REAL_ADAPTER_TESTS=1 or AGENT_STUDIO_ALLOW_REAL_AGENT=1 lifts it.
 */
export function guardRealAgent(command: string[]): void {
  if (
    Deno.env.get('AGENT_STUDIO_TEST') !== '1' ||
    Deno.env.get('STUDIO_REAL_ADAPTER_TESTS') === '1' ||
    Deno.env.get('AGENT_STUDIO_ALLOW_REAL_AGENT') === '1'
  ) return;
  if (isFixture(command)) return;
  throw new RuntimeError(
    `Test guard: refusing to start a real agent process: ${
      pyRepr(command)
    }. Pass connection_factory= to Studio, or use a fixture under work/.`,
  );
}

let testHome: string | null = null;
export const HOME_VARS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'APPDATA',
  'LOCALAPPDATA',
];

/** Under test, a real (non-fixture) agent gets a throwaway home so it can never write into the owner's ~/.claude. {} otherwise. */
export function testHomeEnv(command: string[]): Record<string, string> {
  if (Deno.env.get('AGENT_STUDIO_TEST') !== '1' || isFixture(command)) {
    return {};
  }
  if (testHome === null) {
    const folder = Deno.makeTempDirSync({ prefix: 'agent-studio-test-home-' });
    testHome = folder;
    globalThis.addEventListener('unload', () => {
      try {
        Deno.removeSync(folder, { recursive: true });
      } catch { /* best effort, as shutil.rmtree(ignore_errors=True) */ }
    });
  }
  return Object.fromEntries(HOME_VARS.map((name) => [name, testHome!]));
}

/**
 * The program a keeper spawn gets: Deno.Command looks a bare name up on PATH itself; the keeper looks in its own PATH, which can
 * be older than ours, so a bare name is resolved here, with the environment the agent gets.
 */
export function resolveProgram(program: string, env: Record<string, string>): string {
  if (/[\\/]/.test(program)) return resolvePath(program);
  const win = Deno.build.os === 'windows';
  const path = env.PATH ?? env.Path ?? Deno.env.get('PATH') ?? '';
  const exts = win ? ['.exe', '.com', ...(env.PATHEXT ?? '.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const hasExt = win && /\.[^\\/.]+$/.test(program);
  for (const dir of path.split(win ? ';' : ':').filter(Boolean)) {
    for (const ext of hasExt ? [''] : exts) {
      const candidate = dir.replace(/[\\/]+$/, '') + SEP + program + ext;
      try {
        const info = Deno.statSync(candidate);
        if (info.isFile && (win || ((info.mode ?? 0) & 0o111))) return candidate;
      } catch { /* not here */ }
    }
  }
  return program;
}

// ---- the connection -----------------------------------------------------------------------------------------------------------

/**
 * Codex connects to MCP servers in the background: a first prompt sent as the chat opens can find no studio_artifact tools yet
 * (seen in real runs: an ALL_TOOLS search 1 s into the turn came back empty, the same search a second later listed them).
 */
export const TOOLS_LOADING = 'The studio_artifact tools (full names like mcp__studio_artifact__doc_create) can take a few seconds to ' +
  'appear at the start of a chat: if you do not see them yet, wait a few seconds and look again (more than once) before telling ' +
  'the user they are missing.';

export const ARTIFACT_PROMPT =
  'You are running inside AIB, which shows artifacts beside the chat; when the user says "artifact" they ' +
  'mean this viewer and its studio_artifact tool. ' + DOCS_RULE + ' When you make something else the user ' +
  'should look at rather than source code (an HTML page, one-off report, chart, diagram, SVG or image), ' +
  "save its file under the project's outputs/ folder (for example outputs/report.html), never in the project root " +
  'or among source files, then publish it with the studio_artifact publish tool (pass a file path or the content) and mention it in your reply ' +
  'as the Markdown link the tool returns. When you change it, use the studio_artifact update tool so it gets a new ' +
  'version, and do not tell the user to open the file by hand. Only publish to claude.ai (or any other web ' +
  'artifact or sharing service) when the user explicitly asks for a claude.ai page or a shareable link. ' + TOOLS_LOADING;

export const WORKTREE_PROMPT =
  'In this chat you work in your own copy of the project, on the git branch {branch} (it started from {base}). ' +
  'Helpers you start work in their own copies: when one finishes, merge its branch into yours with `git merge <branch>`. ' +
  "When your work is done and tested (for example before a release), merge it into the project's main branch yourself with the " +
  "merge_into_project tool; you don't need to ask first. If main has moved, the tool brings main into your copy: resolve any " +
  'conflicts there, commit, and call it again.';

/** Python's re.match with `$`: also matches before one trailing newline. */
export const OWN_ARTIFACT_TOOL = /^mcp__studio_artifact__(?:publish|update|list|merge_into_project|resolve_edit_clash)\n?$/;

/** The `_claude/origin` kinds of a cycle Claude Code started on its own (claude-agent-acp's AUTONOMOUS_RESULT_ORIGINS). */
const AUTONOMOUS_ORIGINS = new Set(['task-notification', 'peer', 'coordinator', 'observer', 'observer-activity']);

/** What #untilReplyEnds races the response against. */
const HELD = Symbol('held');

const PROMPT_UNKNOWN = 'This message was being sent when AIB stopped, so AIB cannot tell whether the agent received it. ' +
  'Check the conversation. If it is missing, press Send again.';

// ---- steer-on-send (messages sent while the agent works) -------------------------------------------------------------------------

/** The agents whose steering behaviour AIB knows (the page picks its hint copy by this); any other agent that steers gets the fallback. */
export const STEER_AGENTS: ReadonlySet<string> = new Set(['claude', 'codex', 'omp']);

/**
 * How long a Claude Code turn whose reply ended while its helpers run waits before it is ended early, when a steered message went in
 * during the turn: the steer may get its own model cycle, whose output comes a moment after the first cycle's result (recording C4).
 * Any main-session output in that time cancels the early end. Tests lower it.
 */
export const steerTiming = { settleMs: 3000, steerTimeoutSeconds: 30, steerLateSeconds: 300 };

/** The note on a queued message a steer could not deliver (the agent refused it or did not answer). */
export const STEER_FAILED_NOTE = "Couldn't send now: sends when this turn ends.";
/** Codex may drop a steer that lands as its turn ends (codex-acp v1 turn/completed): no reply after it means it was probably lost. */
export const CODEX_UNREAD_NOTE = "Codex may not have read this: it ended its turn without answering it. Press Resume to send it again, or remove it.";

/**
 * Background-command phrases in a tool result (B6). Claude Code: its run_in_background, and the moves of a running command (a steer,
 * its timeout, Ctrl+B). OMP: its job. The id is the task (or job) id. Claude Code's are read from the result's start only (a command
 * that printed this would have to print it first).
 */
const CLAUDE_BACKGROUND_TEXT = [
  /^Command running in background with ID: (\S+?)\.(?:\s|$)/,
  /^Command was moved to the background \(ID: ([^)\s]+)\)/,
  /^[^\n]*?timeout and was moved to the background \(ID: ([^)\s]+)\)/,
  /^[^\n]*?manually backgrounded by user with ID: ([^\s.]+)/,
];
const OMP_BACKGROUND_TEXT = [/(?:^|\n)Backgrounded as job (\S+?)[\s(.]/];

/** The text of a tool result: Claude Code's string rawOutput, or the text blocks of OMP's {content: [...]}. */
function rawOutputText(raw: unknown): string {
  if (isStr(raw)) return raw;
  if (isDict(raw) && Array.isArray(raw.content)) {
    return raw.content.map((b) => (isDict(b) && isStr(b.text) ? b.text : '')).join('');
  }
  return '';
}

/**
 * A tool result's background task id, from the agent's own signal: Claude Code's meta (toolResponse.backgroundTaskId, with
 * backgroundedToDeliverMessage for a steer) or its result text; any other agent: OMP's details.async {state: running, jobId} or its
 * "Backgrounded as job" text. (A Codex command that outlives its turn is found at the turn's end instead.)
 */
export function backgroundTask(update: Json, claude: boolean): string | null {
  const raw = get(update, 'rawOutput');
  if (claude) {
    const meta = get(update, '_meta');
    const code = isDict(meta) ? get(meta, 'claudeCode') : null;
    const response = isDict(code) ? get(code, 'toolResponse') : null;
    const task = isDict(response) ? get(response, 'backgroundTaskId') : null;
    if (isStr(task) && task) return task;
  } else {
    const details = isDict(raw) ? get(raw, 'details') : null;
    const job = isDict(details) && isDict(details.async) ? details.async : null;
    if (job && job.state === 'running' && isStr(job.jobId) && job.jobId) return job.jobId;
  }
  const text = rawOutputText(raw).replace(/^\s+/, '');
  for (const pattern of claude ? CLAUDE_BACKGROUND_TEXT : OMP_BACKGROUND_TEXT) {
    const m = pattern.exec(text);
    if (m) return m[1];
  }
  return null;
}

/** A tool update that says the tool is over (completed / failed) and does not say it keeps running in the background. */
function toolEnded(update: Json, claude: boolean): boolean {
  const status = get(update, 'status');
  if (status !== 'completed' && status !== 'failed') {
    const raw = get(update, 'rawOutput');
    const details = isDict(raw) ? get(raw, 'details') : null;
    const job = isDict(details) && isDict(details.async) ? details.async : null;
    return !!job && isStr(job.state) && ['completed', 'failed', 'killed', 'cancelled', 'stopped'].includes(job.state);
  }
  return backgroundTask(update, claude) === null;
}

/** A tool AIB has seen in this chat: whether it is a shell command, its last status, when it began, which prompt turn it was in. */
interface ToolSeen {
  shell: boolean;
  status: string;
  since: number;
  main: boolean;
  turn: number;
}

/** A tool call that moved to the background (any of the three signals): what the page shows and what Stop may kill. */
interface BackgroundTool {
  /** The #bgShells key (Claude's task id, OMP's job id, or `open:<toolCallId>` for a Codex command that outlived its turn). */
  task: string;
  state: 'running' | 'done' | 'stopped';
  /** The processes that started with the command, by (pid, start time); null when they cannot be told apart from others. */
  procs: ProcId[] | null;
  stoppable: boolean;
  since: number;
  at: number;
  endedAt: number | null;
  /**
   * A Claude Code helper (its child session id) rather than a command: marked from the adapter's own "Async agent launched" reply,
   * done when its subagent_update leaves running. Never stoppable: it runs inside the agent's own process, so there is no process
   * of its own (pid and start time) AIB could verify and kill.
   */
  helper?: string;
}

/** The adapter's reply when a helper went on in the background (claude-agent-acp 0.97, recording C2: `<toolUseId>:reply`). */
const HELPER_BACKGROUND_TEXT = /^\s*Async agent launched successfully/;

/** Stop on a background row was refused (HTTP 409): not stoppable, not running, or the processes cannot be verified. */
export class NotStoppable extends Error {
  override name = 'NotStoppable';
}

/** str(a) for each item of `e.get('args') or []` (a string iterates its characters, as in Python). */
function argStrings(args: unknown): string[] {
  if (!pyTruthy(args)) return [];
  if (Array.isArray(args)) return args.map((a) => pyStr(a));
  if (isStr(args)) return [...args];
  if (isDict(args)) return Object.keys(args);
  throw new TypeError(`'${pyTypeName(args)}' object is not iterable`);
}

/**
 * True for the `studio_artifact` entry Studio itself gave the chat: the Deno tool (artifacts/mcp.ts: this program with the
 * mcp-artifact subcommand) or the HTTP one this process serves (artifacts/mcp_http.ts). The Deno host builds every chat's entries
 * itself, so the Python tool (artifact_mcp.py) never needs recognising.
 */
function isOwnArtifactEntry(entry: unknown): boolean {
  if (!isDict(entry) || entry.name !== 'studio_artifact') return false;
  if (entry.type === 'http') return isOwnMcpUrl(entry.url);
  const args = argStrings(get(entry, 'args'));
  if (isOwnForwardEntry(entry.command, args)) return true; // the keeper's forwarder to this Studio's HTTP tool
  const own = artifactToolCommand();
  return entry.command === own.command && args.length === own.args.length && args.every((a, i) => a === own.args[i]);
}

export class Connection {
  readonly id: string;
  provider: string;
  cwd: string;
  /** {branch, base} of a chat that runs in its own git worktree. */
  worktree: Record<string, string> | null = null;
  /** The project this chat belongs to; a worktree chat's cwd differs from it. */
  projectRoot: string;
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
  /** Wall-clock time the current prompt turn started (attention.busySince, so a reloaded page keeps "Working · 12m"). */
  turnStartedAt: number | null = null;
  /**
   * True while `busy` stands for a model cycle Claude Code started on its own (a background helper finished and it answers the
   * task notification), not for a prompt of ours. Ends at that cycle's result (see #watchHeldTurn).
   */
  autonomous = false;
  /** The running prompt's early end: called when its reply ended but Claude Code holds the response for background helpers. */
  #endEarly: { seq: number; fire: () => void } | null = null;
  /** Subagent sessions that started (or resumed) running during the current prompt turn: the helpers Claude Code holds it for. */
  #turnHelpers = new Set<string>();
  /** Claude Code subagent sessions seen running (or waiting for the user) live and not yet ended, whichever turn started them. */
  #liveHelpers = new Set<string>();
  /**
   * Claude Code background shells (Bash or PowerShell with run_in_background) seen started and not seen ended: task id -> the pids of
   * the agent's processes that started with the command (null when they could not be listed: the shell then counts until a
   * task-notification cycle). See backgroundShellsRunning.
   */
  #bgShells = new Map<string, number[] | null>();
  /** Bash/PowerShell tool calls of this chat -> when their tool_call came (seconds): a background shell started after it. */
  #shellCalls = new Map<string, number>();
  /** The agent's processes when the current prompt turn began: none of them is a shell that turn starts. */
  #turnProcesses: Set<number> | null = null;
  /** Tool calls seen (any agent, any session): shell or not, last status, start, turn. At most 300, oldest dropped. */
  #tools = new Map<string, ToolSeen>();
  /** Tool calls that moved to the background, by toolCallId (snapshot `toolBackground`; Stop). */
  #bgTools = new Map<string, BackgroundTool>();
  /** Steers of the current prompt turn: how many went in, whether main-session output came after the last, which may be unread. */
  #steerTurn: { injected: number; outputAfter: boolean; unread: SteerItem[] } = { injected: 0, outputAfter: false, unread: [] };
  /** The pending early end of a held turn after a steer (see steerTiming.settleMs). */
  #settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set once the running prompt's session/prompt was written: a steer before it would find no turn (promptRequired). */
  #promptOut = new ThreadEvent();
  /** The steer lane's pump (one at a time) and whether it must look again when it finishes. */
  #steerRun: Promise<void> | null = null;
  #steerAgain = false;
  /** The steer request in flight (cancel() leaves it in the lane; its answer decides). */
  #steerInflight: SteerItem | null = null;
  /** Rebuilt from the keeper: the answer to each steer the old AIB sent, by message id (the lane waits for it instead of resending). */
  #replayedSteers = new Map<string, Promise<string>>();
  /** steer notes by JSON-RPC id of the _session/steering they announce (a rebuild shows the message and applies the answer). */
  #steerNotes = new Map<string, Json>();
  /**
   * Steers whose answer did not come within steerTiming.steerTimeoutSeconds, by message id: the message waits in the after-turn
   * queue, but is not sent from there until the late answer says the agent did not take it (or steerLateSeconds pass), so a steer
   * the agent took late is never sent a second time as a prompt.
   */
  #steerLate = new Set<string>();
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
  startPicks: Partial<Record<'model' | 'mode' | 'effort', string>> | null = null;
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
  /** Recovery hook installed by Studio; null in standalone use. */
  recovery: ConnectionRecovery | null = null;
  /** True once this connection is in the durable recovery list. */
  persisted = false;
  /** Files this agent wrote: the only way a file becomes this chat's artifact. */
  writes: WriteTracker;
  /** Child sessionId -> latest announcement (title, description, capabilities, state). */
  subagents = new Map<string, Json>();
  sessionLease: SessionLease | null = null;
  /** Studio hook: the agent finished a turn, so it is the user's turn. */
  onTurnEnd: Hook | null = null;
  /**
   * Studio hook: the agent sent subscription limit data on its own (server/host/usage_limits_feed.ts). kind 'claude-rate-limit'
   * (usage_update._meta._claude/rateLimit) or 'qwen-quota' (a prompt error's data.subscriptionQuota); at = when, in seconds.
   */
  onLimits: ((connection: Connection, kind: string, raw: unknown, at: number) => void) | null = null;
  /** Number of the latest prompt() accepted. */
  promptSeq = 0;
  /** cancel() cancels every prompt up to this number (one still before its send is dropped; later ones go through). */
  cancelSeq = 0;
  /** Studio hook (worktree live sync): called before the prompt is sent. */
  onTurnStart: Hook | null = null;
  /** Studio hook: connection -> [text, token] or null, a note sent as an extra text block in front of the prompt. */
  contextForPrompt: ((connection: Connection) => unknown) | null = null;
  /** Studio hook: (connection, token) once the prompt went through; the note is not sent again. */
  contextSent: ((connection: Connection, token: unknown) => unknown) | null = null;
  /** Studio hook: a prompt is about to reach the agent (text and clientMessageId as given); the merge permission ends on the user's own. */
  onUserPrompt: ((connection: Connection, text: unknown, clientMessageId: string | null) => unknown) | null = null;
  /** Studio hook: withdraw the owner announcement when the conversation stops. */
  onRelease: Hook | null = null;
  /** The agent's last stderr lines (at most 30, each at most 2000 characters). */
  stderr: string[] = [];
  caps: ClientCapsLike;
  openDone = new ThreadEvent();
  readonly command: string[];
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
  #replaying = false;
  /** Record time (seconds) while replaying, so rebuilt events keep their original times. */
  #clock: number | null = null;
  #outLines = new PyTextLines();
  #errLines = new PyTextLines();
  #records: Promise<void> = Promise.resolve();
  /** Writes held back while replaying: those the record shows were made are dropped, the rest go out once live. */
  #held: { message: Json; once?: string }[] = [];
  /** receipt notes by JSON-RPC id of the prompt they announce. */
  #receiptNotes = new Map<string, Json>();
  /** fsWrite / clientTerminal notes by the agent request id they are about. */
  #sideNotes = new Map<string, Json>();
  /** Client terminals the record says were released (their `clientTerminalReleased` notes). */
  #releasedTerminals = new Set<string>();
  #terminalProblemLogged = false;
  /** Agent -> client capability requests met while replaying (answered once live, unless the record shows the answer). */
  #deferred: Json[] = [];
  #exitResolve: (() => void) | null = null;
  /** How often each agent request id was seen (rebuilt identically by a replay): part of an answer's once-key. */
  #requestsSeen = new Map<string, number>();
  /**
   * The id of this chat's event numbering, sent with every state (eventsId): a page whose events came from another numbering starts
   * its list again. A chat rebuilt from the keeper keeps the id when its record gives the same numbering (a snapshot, or a record
   * whose events are all in it: `ev` in the chat note), so an open page simply goes on from its cursor.
   */
  eventsId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  /** The last keeper record handled (a snapshot says how far it reaches). */
  #lastSeq = 0;
  /** While replaying: records since the newest snapshot (or the start), handled once the replay has caught up. */
  #replayBuffer: KeeperRecord[] = [];
  /** While replaying: the newest snapshot note met and its seq. */
  #replaySnapshot: { note: Json; seq: number } | null = null;
  /** While replaying: records before this seq were truncated away (0: none). */
  #replayGapNext = 0;
  /** The keeper sent `live`: records from here on are handled as they come. */
  #replayLive = false;
  #snapshotQueued = false;
  /** The newest event seq already stored in the journal by a snapshot (in its note or a chunk note before it). */
  #eventsSaved = 0;
  /** The journal notes that hold stored events: [record seq, last event seq], oldest first (truncate keeps what the history needs). */
  #eventChunks: [number, number][] = [];
  /** While replaying: the stored event chunks met, by record seq. */
  #replayChunks = new Map<number, Json[]>();
  /** Snapshots written and journal truncations asked for (tests). */
  snapshots = 0;
  /** The size in bytes of the last snapshot note written, and of the chunk notes written with it (tests, logs). */
  snapshotBytes = 0;
  snapshotChunkBytes = 0;
  /** A rebuild: the seq of the snapshot it started from (0: the start of the record) and how many records it replayed after it. */
  replayedFrom = 0;
  replayedRecords = 0;
  traceback = '';
  exitCode: number | null = null;
  #stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  #stdinBroken = false;
  #stdinClosed = false;
  #readTask: Promise<void> | null = null;
  #stdoutReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #stderrReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  #errorTask: Promise<void> | null = null;
  #exited: Promise<void> | null = null;
  #closing = false;
  /** The running turn's task (tests and close() can await it). */
  turn: Promise<void> | null = null;

  constructor(
    command: string[],
    cwd: string,
    provider: string,
    options: ConnectionOptions = {},
  ) {
    guardRealAgent(command);
    this.id = options.id ?? crypto.randomUUID().replaceAll('-', '');
    this.keeper = options.keeper ?? null;
    this.provider = provider;
    this.cwd = String(cwd);
    const found = projectOfWorktree(this.cwd); // a chat in any app's git worktree belongs to the main checkout
    this.projectRoot = found ? found.project : this.cwd;
    this.writes = new WriteTracker(cwd);
    // opt-in, off by default
    this.caps = (options.capsFactory ?? defaultCaps)(
      this.cwd,
      !!options.enableTerminal,
      options.enableFs ?? null,
      (sid) => this.knownSessions.has(sid),
      (kind, data) => this.event(kind, data),
      (message) => this.write(message),
    );
    // In the keeper, the agent's client terminals run there too (note first), so they outlive an AIB restart with the chat.
    if (this.keeper && this.caps instanceof ClientCaps) this.caps.terminalBackend = this.#terminalBackend();
    // command is always a list (never a shell string).
    this.command = command;
    this.env = options.env ?? null;
    if (options.rebuild && this.keeper) this.#adoptChannel(options.rebuild);
    else if (options.start ?? true) this.startProcess();
  }

  /** Change the folder of an agent that has not started yet (a worktree that could not be made: the chat works in place). */
  retarget(cwd: string): void {
    if (this.process !== null) {
      throw new RuntimeError('The agent already started');
    }
    this.cwd = String(cwd);
    (this.caps as { workspace: string }).workspace = this.cwd;
    this.writes = new WriteTracker(this.cwd); // nothing was observed yet: the same as changing its folder
  }

  startProcess(): void {
    if (this.keeper) return this.#startInKeeper();
    const [program, ...args] = this.command;
    const extra = { ...testHomeEnv(this.command), ...(this.env ?? {}) };
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
    this.#stdin = child.stdin.getWriter();
    this.#exited = child.status.then((status) => {
      this.exitCode = status.code;
    }, () => {});
    this.#readTask = this.#read(child.stdout);
    this.#errorTask = this.#readErrors(child.stderr);
  }

  // ---- the agent in the keeper ----------------------------------------------------------------------------------------------
  /** Start the agent as a keeper channel. Writes made before the keeper answers wait for it, in order. */
  #startInKeeper(): void {
    const [program, ...args] = this.command;
    const env: Record<string, string> = { ...Deno.env.toObject(), ...testHomeEnv(this.command), ...(this.env ?? {}) };
    delete env.DENO_SERVE_ADDRESS;
    const channel = this.keeper!.spawn(
      { channel: `chat-${this.id}`, command: resolveProgram(program, env), args, cwd: this.cwd, env },
      this.#keeperListener(),
      () => this.#chatNote(),
    );
    this.#useChannel(channel);
  }

  /** Rebuild from a live keeper channel an earlier AIB started: replay its record, then claim it and go on live. */
  #adoptChannel(info: ChannelInfo): void {
    this.#replaying = true;
    let settle: [() => void, (error: Error) => void] = [() => {}, () => {}];
    this.rebuilt = new Promise<void>((resolve, reject) => (settle = [resolve, reject]));
    this.rebuilt.catch(() => {});
    this.#settleRebuild = settle;
    this.#useChannel(this.keeper!.adopt(info, this.#keeperListener()));
  }

  #settleRebuild: [() => void, (error: Error) => void] | null = null;
  #endedResolve: (() => void) | null = null;
  #ended = false;
  /** True when the keeper itself went away under this chat (the agent ended with it). */
  interrupted = false;

  #useChannel(channel: KeeperChannel): void {
    this.channel = channel;
    const kill = () => void channel.kill();
    const standIn: Killable = {
      get pid() {
        return channel.pid;
      },
      kill,
    };
    this.process = standIn as Deno.ChildProcess;
    this.tree = { kill };
    this.#exited = new Promise<void>((resolve) => (this.#exitResolve = resolve));
    this.#readTask = new Promise<void>((resolve) => (this.#endedResolve = resolve));
    this.#errorTask = Promise.resolve();
  }

  /** The `chat` note: written right after the spawn, so a later AIB knows what this channel is. */
  #chatNote(): Json {
    return {
      t: 'chat',
      id: this.id,
      provider: this.provider,
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      worktree: this.worktree,
      resume: this.sessionId,
      command: this.command,
      mcpServers: this.mcpServers,
      app: APP_VERSION,
      // Every event of this chat is rebuilt from this record (Studio's own events go in as `event` notes), so a rebuild numbers
      // them exactly as now and an open page keeps its cursor.
      ev: 1,
      eventsId: this.eventsId,
    };
  }

  #keeperListener(): KeeperChannelListener {
    return {
      record: (record: KeeperRecord) => {
        if (this.#replaying && !this.#replayLive) return this.#bufferReplay(record);
        this.#enqueue(() => this.#onRecord(record));
      },
      live: () => {
        this.#replayLive = true;
        this.#enqueue(() => this.#caughtUp());
      },
      gap: (from: number, next: number) => {
        if (this.#replaying && !this.#replayLive) { // truncated after a snapshot: fine when a snapshot covers it (checked at live)
          this.#replayGapNext = next;
          this.#replayBuffer = [];
          this.#replaySnapshot = null;
          this.#replayChunks.clear();
          return;
        }
        this.#enqueue(() => {
          if (this.#replaying) this.#rebuildFailed(new Error(`the record from ${from} to ${next - 1} is no longer kept`));
          else log.warning('keeper: %s lost records %s..%s', this.id, from, next - 1);
        });
      },
      fenced: () =>
        this.#enqueue(() => {
          this.#stdinBroken = true;
          this.error = 'Another AIB took over this chat; this window no longer sends anything to it.';
        }),
      lost: (error: Error | null) => this.#enqueue(() => this.#onLost(error)),
      spawnFailed: (error: Error) =>
        this.#enqueue(() => {
          if (this.#replaying) return this.#rebuildFailed(error);
          this.#pushStderr(clip(`Could not start the agent in the keeper: ${errorText(error)}`, 2000));
          this.#exitResolve?.();
          this.#readerEnded('');
        }),
      writeFailed: (error: Error) => {
        this.#stdinBroken = true;
        log.warning('keeper: a write to %s failed: %s', this.id, errorText(error));
      },
    };
  }

  /** Records are handled one at a time, in journal order, exactly like lines read from a pipe. */
  #enqueue(work: () => unknown): void {
    this.#records = this.#records.then(async () => {
      await work();
    }).catch((error) => this.#recordFailed(error));
  }

  #recordFailed(error: unknown): void {
    if (this.#ended) return;
    if (this.#replaying) return this.#rebuildFailed(error);
    if (isOsOrValueError(error)) {
      this.error = errorText(error);
      this.#readerEnded('');
      return;
    }
    const failure = this.#internalFailure(error);
    this.#readerEnded(failure);
  }

  #now(): number {
    return this.#clock ?? now();
  }

  async #onRecord(record: KeeperRecord): Promise<void> {
    if (this.#ended) return;
    try {
      await this.#handleRecord(record);
    } finally {
      if (record.seq > this.#lastSeq) this.#lastSeq = record.seq;
    }
  }

  async #handleRecord(record: KeeperRecord): Promise<void> {
    this.#clock = this.#replaying ? record.time / 1000 : null;
    if (record.kind === 'out') {
      for (const line of this.#outLines.feed(record.body)) {
        const pending = this.#handleLine(line);
        if (pending) await pending;
      }
    } else if (record.kind === 'err') {
      for (const line of this.#errLines.feed(record.body)) this.#pushStderr(clip(line.replace(RSTRIP, ''), 2000));
    } else if (record.kind === 'in') {
      if (!this.#replaying) return; // our own writes coming back
      for (const line of new TextDecoder().decode(record.body).split('\n')) {
        if (line.trim()) this.#replayIn(line);
      }
      await new Promise((resolve) => setTimeout(resolve, 0)); // let a turn that just began reach its wait, as live code would
    } else if (record.kind === 'note') {
      if (this.#replaying) this.#replayNote(parseNote(record.body));
    } else if (record.kind === 'exit') {
      let code: number | null = null;
      try {
        const body = JSON.parse(new TextDecoder().decode(record.body));
        code = typeof body.code === 'number' ? body.code : null;
      } catch { /* no code */ }
      await this.#flushLines();
      this.exitCode = code;
      this.#exitResolve?.();
      if (!this.#replaying) void this.channel?.remove(); // the agent is gone: its record is no longer needed
      this.#readerEnded('');
    }
  }

  async #flushLines(): Promise<void> {
    for (const line of this.#outLines.feed(null, true)) {
      const pending = this.#handleLine(line);
      if (pending) await pending;
    }
    for (const line of this.#errLines.feed(null, true)) this.#pushStderr(clip(line.replace(RSTRIP, ''), 2000));
  }

  async #onLost(_error: Error | null): Promise<void> {
    if (this.#ended) return;
    this.interrupted = true;
    try {
      await this.#flushLines();
    } catch { /* what was cut off stays cut off */ }
    this.error = KEEPER_LOST;
    this.#exitResolve?.();
    this.#settleRebuild?.[1](new Error(KEEPER_LOST));
    this.#settleRebuild = null;
    this.#readerEnded(KEEPER_LOST);
  }

  // ---- rebuilding from the keeper's record ------------------------------------------------------------------------------------
  /** True while this chat is being rebuilt from the record: nothing is written, spawned or answered. */
  get replaying(): boolean {
    return this.#replaying;
  }

  /** A line AIB wrote to the agent, read back from the record. */
  #replayIn(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isDict(message)) return;
    const method = message.method;
    if (isStr(method) && Object.hasOwn(message, 'id')) return this.#replayRequest(message);
    if (isStr(method)) {
      if (method === 'session/cancel') {
        const sid = get(get(message, 'params', {}) as Json, 'sessionId');
        if (!this.sessionId || sid === this.sessionId) {
          this.cancelSeq = this.promptSeq;
          if (this.autonomous) void this.#endAutonomous('cancelled'); // as cancel() did live
        }
      }
      return;
    }
    if (Object.hasOwn(message, 'id')) this.#replayAnswered(message.id);
  }

  /** A request AIB sent: it is pending until its response shows up in the record (or arrives live). */
  #replayRequest(message: Json): void {
    const id = message.id;
    const method = message.method as string;
    const params = get(message, 'params', {}) as Json;
    if (isInt(id) && id > this.counter) this.counter = id; // ids never collide with the old AIB's
    const entry: Pending = { done: new ThreadEvent(), method, params };
    this.pending.set(id, entry);
    if (method === 'session/prompt') return this.#replayTurn(id, entry, params);
    if (method === '_session/steering') return this.#replaySteer(id, entry, params);
    void entry.done.wait().then(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
      this.#applyAnswered(method, params, entry.response ?? {});
    });
  }

  /** What a response to a replayed request changes: the same state the live code sets after it awaited the request. */
  #applyAnswered(method: string, params: Json, response: Json): void {
    if (Object.hasOwn(response, 'error')) return;
    const result = Object.hasOwn(response, 'result') ? response.result : {};
    try {
      if (method === 'initialize') {
        this.initial = result;
        this.#applyInitialize();
      } else if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
        this.#applySession(result, method === 'session/new' ? null : get(params, 'sessionId') as string | null);
      } else if (method === 'session/set_mode') {
        this.#modes().currentModeId = get(params, 'modeId');
      } else if (method === 'session/set_config_option' && isDict(result)) {
        Object.assign(this.settings, result);
        withModelsOption(this.settings);
      } else if (method === 'session/set_model') {
        this.#modelSet(get(params, 'modelId'));
      }
    } catch (error) {
      if (this.#replaying) this.#rebuildFailed(error);
      else log.exception(error, 'Applying a response to a request from before the restart failed');
    }
  }

  /**
   * A steer the old AIB sent (B4): once its answer is known (from the record, or live) the same happens as live: injected shows the
   * user's message (at the same place, so events number the same); the lane, restored later from the queue store, takes the answer
   * from #replayedSteers instead of sending the message again.
   */
  #replaySteer(id: unknown, entry: Pending, params: Json): void {
    const key = JSON.stringify(id);
    const note = this.#steerNotes.get(key) ?? null;
    this.#steerNotes.delete(key);
    const itemId = note && isStr(note.receipt) ? note.receipt : null;
    const outcome = entry.done.wait().then(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
      const response = entry.response ?? {};
      const result = Object.hasOwn(response, 'error') ? null : response.result;
      const said = isDict(result) ? result.outcome : null;
      if (said === 'injected' || said === 'startedNewTurn') {
        const blocks = get(params, 'prompt', []);
        const images = (Array.isArray(blocks) ? blocks : []).filter((b) => isDict(b) && b.type === 'image') as unknown as ImageBlock[];
        if (itemId && note) {
          this.#steerLanded(itemId, isStr(note.text) ? note.text : '', images, Array.isArray(note.files) ? note.files as FileSummary[] : [],
            isStr(note.fingerprint) ? note.fingerprint : '');
        }
        return 'injected';
      }
      return said === 'promptRequired' ? 'promptRequired' : 'failed';
    });
    if (itemId) {
      this.#replayedSteers.set(itemId, outcome);
      while (this.#replayedSteers.size > 100) this.#replayedSteers.delete(this.#replayedSteers.keys().next().value!);
    }
  }

  /** A prompt from the record: the turn starts again here, through the same code, waiting for the same response. */
  #replayTurn(id: unknown, entry: Pending, params: Json): void {
    const note = this.#receiptNotes.get(JSON.stringify(id)) ?? null;
    this.#receiptNotes.delete(JSON.stringify(id));
    const blocks = get(params, 'prompt', []);
    const prompt = (Array.isArray(blocks) ? blocks : []).filter(isDict) as Json[];
    const images = prompt.filter((b) => b.type === 'image') as unknown as ImageBlock[];
    const said = prompt.find((b) => b.type === 'text' && isStr(b.text) && !b.text.startsWith('<studio-context>'));
    const text = note && isStr(note.text) ? note.text : said ? String(said.text) : '';
    const clientMessageId = note && isStr(note.receipt) ? note.receipt : null;
    const seq = this.#startTurn(clientMessageId, note && isStr(note.fingerprint) ? note.fingerprint : '');
    const userEvent: Json = { text, attachments: images, sessionId: this.sessionId, clientMessageId };
    if (note && Array.isArray(note.files) && note.files.length) userEvent.files = note.files;
    this.event('user', userEvent);
    this.turn = this.#runTurn(seq, text, [], images, clientMessageId, null, { entry, id });
  }

  /** AIB answered an agent request: whatever this replay was about to answer for it was answered already. */
  #replayAnswered(id: unknown): void {
    const same = (other: unknown) => typeof other === typeof id && pyEq(other, id);
    this.#held = this.#held.filter((h) => Object.hasOwn(h.message, 'method') || !same(h.message.id));
    for (const [key, item] of [...this.permissions]) if (same(item.rpcId)) this.permissions.delete(key);
    for (const [key, item] of [...this.elicitations]) if (same(item.rpcId)) this.elicitations.delete(key);
    this.#deferred = this.#deferred.filter((m) => !same(m.id));
  }

  #replayNote(note: Json | null): void {
    if (note && note.t === 'event' && isStr(note.kind)) return this.event(note.kind, note.data ?? null); // Studio's own event
    if (note && note.t === 'chat') { // a record that has every event: the rebuild numbers them as before
      if (note.ev === 1 && isStr(note.eventsId) && note.eventsId) this.eventsId = note.eventsId;
      return;
    }
    if (note?.t === 'clientTerminalReleased' && isStr(note.terminalId)) {
      this.#releasedTerminals.add(note.terminalId);
      return;
    }
    if (!note || note.rpc === undefined) return;
    if (note.t === 'receipt') this.#receiptNotes.set(JSON.stringify(note.rpc), note);
    else if (note.t === 'steer') this.#steerNotes.set(JSON.stringify(note.rpc), note);
    else if (note.t === 'fsWrite' || note.t === 'clientTerminal') this.#sideNotes.set(`${note.t}:${JSON.stringify(note.rpc)}`, note);
  }

  /**
   * Client terminals in the keeper (note first): start one for terminal/create after writing its `clientTerminal` note in this chat's
   * record; null lets it run as a child of AIB (the agent is not in the keeper, or the keeper is too old: the note then says so).
   */
  #terminalBackend(): TerminalBackend {
    return {
      create: async (plan: TerminalPlan) => {
        const chat = this.channel;
        if (!chat || chat.lost || this.rebuildError || !this.keeper) return null;
        try {
          await chat.ready;
        } catch {
          return null;
        }
        const client = chat.client;
        const problem = !client || client.closed ? 'no keeper connection' : clientTerminalProblem(client.features, client.keeperVersion);
        if (!plan.pinned) {
          const note: Json = {
            t: 'clientTerminal',
            rpc: plan.rpc,
            terminalId: plan.terminalId,
            channel: problem ? null : clientTerminalChannel(plan.terminalId),
            sessionId: plan.sessionId,
            argv: plan.argv.slice(0, 50),
            cwd: plan.cwd,
            limit: plan.limit,
          };
          if (!await chat.sendNote(note)) throw new CapError('AIB could not record the terminal, so it was not started', -32603);
        }
        if (problem) {
          if (!this.#terminalProblemLogged) log.info('keeper: client terminals of %s run inside AIB: %s', this.id, problem);
          this.#terminalProblemLogged = true;
          return null;
        }
        const terminal = KeeperClientTerminal.spawn(this.keeper, plan, this.id);
        try {
          await terminal.ready;
        } catch (error) {
          throw new CapError(`Could not start command: ${errorText(error) || errorName(error)}`, -32603);
        }
        return terminal;
      },
      release: async (terminal: TerminalBase) => {
        if (terminal instanceof KeeperClientTerminal && this.channel) {
          await this.channel.sendNote({ t: 'clientTerminalReleased', terminalId: terminal.id });
        }
      },
    };
  }

  /** After a takeover: re-attach the client terminals the record shows still running in the keeper, before answering anything. */
  async #adoptClientTerminals(): Promise<void> {
    const caps = this.caps;
    if (!(caps instanceof ClientCaps) || !this.keeper || !this.channel?.client) return;
    const notes = [...this.#sideNotes.values()].map((n) => clientTerminalNote(n)).filter((n) => n && n.channel);
    if (!notes.length) return;
    const client = this.channel.client;
    const channels = new Map((await client.list()).map((info) => [info.channel, info]));
    for (const note of notes) {
      const info = channels.get(note!.channel!);
      if (!info || caps.terminals.has(note!.terminalId)) continue;
      if (this.#releasedTerminals.has(note!.terminalId)) { // released, but not yet removed when the old AIB stopped
        try {
          if (info.live) await this.keeper.stopUnknown(client, info.channel);
          await this.keeper.removeEnded(client, info.channel);
        } catch { /* next time */ }
        continue;
      }
      const terminal = KeeperClientTerminal.adopt(this.keeper, note!, info);
      try {
        await Promise.race([
          terminal.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000)),
        ]);
        caps.adoptTerminal(terminal);
      } catch (error) {
        log.warning('keeper: could not take over client terminal %s: %s', note!.terminalId, errorText(error));
      }
    }
  }

  /** The replay reached the live end: claim the channel (the old AIB can no longer write), send what it never sent, go live. */
  async #caughtUp(): Promise<void> {
    if (!this.#replaying || this.rebuildError || this.#ended) return;
    try {
      await this.#replayFromSnapshot();
    } catch (error) {
      return this.#rebuildFailed(error);
    }
    if (this.rebuildError || this.#ended) return;
    try {
      await this.channel!.claim();
    } catch (error) {
      return this.#rebuildFailed(error);
    }
    this.#replaying = false;
    this.#clock = null;
    try {
      await this.#adoptClientTerminals(); // terminal/output, wait_for_exit, kill and release are answered from these
    } catch (error) {
      log.warning('keeper: taking over client terminals failed: %s', errorText(error));
    }
    const held = this.#held;
    this.#held = [];
    for (const { message, once } of held) {
      try {
        this.write(message, once); // never resends: each carries its once-key, and the record showed it was not written
      } catch (error) {
        log.warning('keeper: could not send a held answer: %s', errorText(error));
      }
    }
    const deferred = this.#deferred;
    this.#deferred = [];
    for (const message of deferred) {
      const answered = this.#answerDeferred(message);
      if (answered instanceof Promise) answered.catch((error) => log.exception(error, 'Client capability request failed'));
    }
    this.#settleRebuild?.[0]();
    this.#settleRebuild = null;
  }

  /** A client capability request the old AIB had not answered: answer it now, unless its note says it was already acted on. */
  #answerDeferred(message: Json): void | Promise<void> {
    const key = JSON.stringify(message.id);
    const method = message.method;
    const terminalNote = method === 'terminal/create' ? clientTerminalNote(this.#sideNotes.get(`clientTerminal:${key}`) ?? null) : null;
    if (terminalNote) {
      const caps = this.caps instanceof ClientCaps ? this.caps : null;
      if (terminalNote.channel && caps?.terminals.has(terminalNote.terminalId)) {
        // Started before the restart and still there in the keeper: this is its answer.
        this.write({ jsonrpc: '2.0', id: message.id, result: { terminalId: terminalNote.terminalId } });
        return;
      }
      if (terminalNote.channel && caps?.terminalBackend) {
        // Noted but never started (the old AIB stopped in between): start it now under the noted id; the keeper refuses a second one.
        caps.pinTerminal(message.id, terminalNote.terminalId);
        return this.#dispatchCaps(message);
      }
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'The terminal was lost when AIB restarted. It was not started again.' },
      });
      return;
    }
    const written = this.#sideNotes.get(`fsWrite:${key}`);
    if (method === 'fs/write_text_file' && written) {
      const params = get(message, 'params', {}) as Json;
      try {
        const hash = createHash('sha256').update(Deno.readFileSync(String(params.path))).digest('hex');
        if (hash === written.sha256) {
          this.write({ jsonrpc: '2.0', id: message.id, result: null }); // the write happened before the restart
          return;
        }
      } catch { /* not there: write it */ }
    }
    return this.#dispatchCaps(message);
  }

  // ---- snapshots: a rebuild starts at the newest one instead of the start of the record -----------------------------------------
  /** A record met while replaying: kept until the replay has caught up; a snapshot note drops what it already covers. */
  #bufferReplay(record: KeeperRecord): void {
    if (record.kind === 'note') {
      const note = parseNote(record.body);
      if (note?.t === 'event' && note.chunk === 1 && Array.isArray(note.events)) { // stored history (written before a snapshot)
        this.#replayChunks.set(record.seq, note.events.filter(isDict) as Json[]);
        return;
      }
      if (note?.t === 'snapshot' && (note.sv === 1 || note.sv === 2) && isDict(note.state) && isInt(note.upTo)) {
        if (note.sv === 2 && Array.isArray(note.events) && note.events.length) {
          this.#replayChunks.set(record.seq, note.events.filter(isDict) as Json[]);
        }
        delete note.events; // kept once, in the chunks
        this.#replaySnapshot = { note, seq: record.seq };
        const upTo = note.upTo;
        this.#replayBuffer = this.#replayBuffer.filter((r) => r.seq > upTo);
        // Chunks wholly before the history this snapshot keeps are no longer needed.
        const from = note.sv === 2 && isInt(note.state.eventsFrom) ? note.state.eventsFrom : Infinity;
        for (const [seq, events] of this.#replayChunks) {
          if (!events.length || (events.at(-1)!.seq as number) < from) this.#replayChunks.delete(seq);
        }
        return;
      }
    }
    this.#replayBuffer.push(record);
  }

  /** At the live end: restore the newest snapshot (if any), then handle the records after it, all with side effects off. */
  async #replayFromSnapshot(): Promise<void> {
    const snapshot = this.#replaySnapshot;
    const records = this.#replayBuffer;
    const chunks = this.#replayChunks;
    this.#replayBuffer = [];
    this.#replaySnapshot = null;
    this.#replayChunks = new Map();
    if (this.#replayGapNext && (!snapshot || (snapshot.note.upTo as number) < this.#replayGapNext - 1)) {
      throw new Error(`the record before ${this.#replayGapNext} is no longer kept and no snapshot covers it`);
    }
    if (snapshot) this.#restoreSnapshot(snapshot.note, chunks);
    this.replayedFrom = snapshot ? snapshot.seq : 0;
    for (const record of records) {
      if (this.rebuildError || this.#ended) return;
      // AIB's own writes and notes before the snapshot note were made before it was taken: the snapshot has them already.
      if (snapshot && record.seq < snapshot.seq && (record.kind === 'in' || record.kind === 'note')) continue;
      this.replayedRecords += 1;
      await this.#onRecord(record);
    }
  }

  /** The state a snapshot note carries, put back exactly (what the replay of everything before `upTo` would have rebuilt). */
  #restoreSnapshot(note: Json, chunks: Map<number, Json[]>): void {
    const s = note.state as Json;
    const entries = (value: unknown) => (Array.isArray(value) ? value.filter((e) => Array.isArray(e) && e.length === 2) : []);
    this.initial = s.initial ?? {};
    if (isDict(this.initial) && Object.keys(this.initial).length) this.#applyInitialize();
    this.sessionId = isStr(s.sessionId) ? s.sessionId : null;
    this.ready = s.ready === true;
    this.settings = isDict(s.settings) ? s.settings : {};
    this.knownSessions = new Set(Array.isArray(s.knownSessions) ? s.knownSessions.filter(isStr) : []);
    this.counter = isInt(s.counter) ? s.counter : 0;
    this.promptSeq = isInt(s.promptSeq) ? s.promptSeq : 0;
    this.cancelSeq = isInt(s.cancelSeq) ? s.cancelSeq : 0;
    this.changeSeq = isInt(s.changeSeq) ? s.changeSeq : 0;
    this.changeFailures = Array.isArray(s.changeFailures) ? s.changeFailures.filter(isDict) as Json[] : [];
    this.turnEndedAt = typeof s.turnEndedAt === 'number' ? s.turnEndedAt : null;
    this.sequence = isInt(s.sequence) ? s.sequence : 0;
    if (note.sv === 1) { // beta.8 and before: the whole history inside the note; the next snapshot stores it in chunks
      this.events = Array.isArray(s.events) ? s.events.filter(isDict) as Json[] : [];
      this.#eventsSaved = 0;
      this.#eventChunks = [];
    } else {
      this.events = this.#chunkEvents(chunks, isInt(s.eventsFrom) ? s.eventsFrom : this.sequence + 1);
      this.#eventsSaved = this.sequence;
      this.#eventChunks = [...chunks].filter(([, e]) => e.length).map(([seq, e]) => [seq, e.at(-1)!.seq as number] as [number, number])
        .sort((a, b) => a[0] - b[0]);
    }
    this.eventImageBytes = this.events.reduce((sum, e) => sum + eventImageSize(e), 0);
    this.subagents = new Map(entries(s.subagents) as [string, Json][]);
    this.#liveHelpers = new Set(Array.isArray(s.liveHelpers) ? s.liveHelpers.filter(isStr) : []);
    this.#bgShells = new Map(
      (Array.isArray(s.bgShells) ? s.bgShells : []).filter((e): e is [string, number[] | null] =>
        Array.isArray(e) && isStr(e[0]) && (e[1] === null || (Array.isArray(e[1]) && e[1].every(isInt)))
      ),
    );
    this.#bgTools = new Map(
      entries(s.bgTools).filter((e) => isStr(e[0]) && isDict(e[1]) && isStr((e[1] as Json).task)) as [string, BackgroundTool][],
    );
    const b = isDict(s.breadth) ? s.breadth : {};
    this.breadth = {
      ...newState(),
      ...b,
      compaction: new Map(entries(b.compaction) as [string, never][]),
    } as BreadthState;
    this.writes.paths.clear();
    for (const [k, v] of entries(isDict(s.writes) ? s.writes.paths : null)) this.writes.paths.set(k as string, v as number);
    this.writes.calls.clear();
    for (const [k] of entries(isDict(s.writes) ? s.writes.calls : null)) this.writes.calls.set(k as string, true);
    this.promptReceipts = new Map(entries(s.promptReceipts) as [string, Receipt][]);
    this.#requestsSeen = new Map(entries(s.requestsSeen) as [string, number][]);
    this.withdrawn = new Map(entries(s.withdrawn) as [string, string][]);
    this.stderr = Array.isArray(s.stderr) ? s.stderr.filter(isStr) : [];
    if (isStr(s.eventsId) && s.eventsId) this.eventsId = s.eventsId;
    this.#lastSeq = note.upTo as number;
  }

  /**
   * The history a version-2 snapshot keeps: the stored events from `from` to `sequence`, each once, in order. A chunk that is gone
   * (the keeper's size cap dropped an old segment) leaves the history starting after the hole, never with one in it.
   */
  #chunkEvents(chunks: Map<number, Json[]>, from: number): Json[] {
    const bySeq = new Map<number, Json>();
    for (const events of chunks.values()) {
      for (const e of events) {
        const seq = e.seq;
        if (isInt(seq) && seq >= from && seq <= this.sequence) bySeq.set(seq, e);
      }
    }
    const out: Json[] = [];
    for (let seq = this.sequence; seq >= from; seq--) {
      const e = bySeq.get(seq);
      if (!e) {
        log.warning('keeper: %s: events %s..%s are no longer stored; the history starts after them', this.id, from, seq);
        break;
      }
      out.push(e);
    }
    return out.reverse();
  }

  /** Take a snapshot once the record queue has handled what it holds now (so `upTo` is exact). */
  #scheduleSnapshot(): void {
    if (!this.channel || this.#replaying || this.#snapshotQueued) return;
    this.#snapshotQueued = true;
    this.#enqueue(() => {
      this.#snapshotQueued = false;
      return this.#writeSnapshot();
    });
  }

  /** Nothing is in flight: no turn, request, question, sign-in or held answer, and no line half read. */
  #quiet(): boolean {
    return this.ready && !this.busy && !this.closed && !this.#replaying && !this.rebuildError && !this.auth &&
      this.pending.size === 0 && this.permissions.size === 0 && this.elicitations.size === 0 && !this.#deferred.length &&
      !this.#held.length && this.#outLines.idle && this.#errLines.idle;
  }

  /** The chat's state for a snapshot note, without its event history (that goes in chunks: see #snapshotPlan). */
  #snapshotState(): Json {
    return {
      initial: this.initial,
      sessionId: this.sessionId,
      ready: this.ready,
      settings: this.settings,
      knownSessions: [...this.knownSessions],
      counter: this.counter,
      promptSeq: this.promptSeq,
      cancelSeq: this.cancelSeq,
      changeSeq: this.changeSeq,
      changeFailures: this.changeFailures,
      turnEndedAt: this.turnEndedAt,
      // The history kept: events from eventsFrom to sequence, stored in this note and the chunk notes before it (and earlier ones).
      eventsFrom: this.events.length ? this.events[0].seq : this.sequence + 1,
      sequence: this.sequence,
      subagents: [...this.subagents],
      liveHelpers: [...this.#liveHelpers],
      bgShells: [...this.#bgShells],
      bgTools: [...this.#bgTools],
      breadth: { ...this.breadth, compaction: [...this.breadth.compaction] },
      writes: { paths: [...this.writes.paths], calls: [...this.writes.calls] },
      promptReceipts: [...this.promptReceipts],
      requestsSeen: [...this.#requestsSeen],
      withdrawn: [...this.withdrawn],
      stderr: this.stderr,
      eventsId: this.eventsId,
    };
  }

  /**
   * What a snapshot writes now: the events made since the last one, cut into chunks of at most EVENT_CHUNK_BYTES (the last one goes
   * inside the snapshot note when it fits), and the snapshot note. null when the state alone is too large to store.
   */
  #snapshotPlan(): SnapshotPlan | null {
    const note: Json = { t: 'snapshot', sv: SNAPSHOT_VERSION, upTo: this.#lastSeq, chat: this.#chatNote(), state: this.#snapshotState() };
    const stateBytes = ENCODER.encode(JSON.stringify(note)).length;
    if (stateBytes > MAX_SNAPSHOT_BYTES - 1024) return null;
    const groups: { events: Json[]; bytes: number }[] = [];
    let group: { events: Json[]; bytes: number } = { events: [], bytes: 0 };
    for (const event of this.events) {
      if ((event.seq as number) <= this.#eventsSaved) continue;
      let stored = event;
      let bytes = ENCODER.encode(JSON.stringify(event)).length + 1;
      if (bytes > MAX_SNAPSHOT_BYTES - 1024) { // one agent message larger than a note: its place in the history says so after a restart
        stored = {
          seq: event.seq,
          kind: 'studio_note',
          time: event.time,
          data: { message: 'An agent message too large to keep across a restart was left out here.' },
        };
        bytes = ENCODER.encode(JSON.stringify(stored)).length + 1;
      }
      if (group.events.length && group.bytes + bytes > EVENT_CHUNK_BYTES) {
        groups.push(group);
        group = { events: [], bytes: 0 };
      }
      group.events.push(stored);
      group.bytes += bytes;
    }
    if (group.events.length) groups.push(group);
    const inline = groups.length && stateBytes + groups.at(-1)!.bytes <= MAX_SNAPSHOT_BYTES - 1024 ? groups.pop()! : null;
    note.events = inline ? inline.events : [];
    return {
      chunks: groups.map((g) => ({ t: 'event', chunk: 1, events: g.events })),
      note,
      bytes: stateBytes + (inline ? inline.bytes : 0),
      chunkBytes: groups.reduce((sum, g) => sum + g.bytes, 0),
      last: this.sequence,
    };
  }

  /** The snapshot note a snapshot now would write (with the events since the last one), or null when it is too large to store. */
  snapshotNote(): Json | null {
    return this.#snapshotPlan()?.note ?? null;
  }

  /**
   * Write a snapshot note when the chat is quiet (a turn just ended), then let the keeper drop the journal segments before it
   * (truncate), so a rebuild reads and replays only what came after, plus the chunks the kept history is in. Never throws.
   */
  async #writeSnapshot(): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.lost || !this.#quiet() || !this.#lastSeq) return;
    let plan: SnapshotPlan | null;
    try {
      plan = this.#snapshotPlan();
    } catch (error) {
      log.exception(error, 'keeper: making a snapshot failed');
      return;
    }
    if (!plan) {
      log.warning('keeper: %s: the snapshot would be larger than %s bytes; not written', this.id, MAX_SNAPSHOT_BYTES);
      return;
    }
    // All sent at once, in order, before anything AIB writes after this moment (a write after the note is replayed; one before is not).
    const stored = await Promise.all([...plan.chunks, plan.note].map((n) => channel.snapshot(n)));
    const seq = stored.at(-1);
    if (!seq || stored.some((s) => s === null)) return; // tried again at the next quiet moment (a stored chunk is then just repeated)
    const lastOf = (events: unknown) => (events as Json[]).at(-1)!.seq as number;
    plan.chunks.forEach((chunk, i) => this.#eventChunks.push([stored[i]!, lastOf(chunk.events)]));
    if ((plan.note.events as Json[]).length) this.#eventChunks.push([seq, lastOf(plan.note.events)]);
    this.#eventsSaved = plan.last;
    const first = this.events.length ? this.events[0].seq as number : Infinity;
    this.#eventChunks = this.#eventChunks.filter(([, last]) => last >= first);
    this.snapshots += 1;
    this.snapshotBytes = plan.bytes;
    this.snapshotChunkBytes = plan.chunkBytes;
    // Records after upTo are still needed (they may come before the note), and so are the chunks the kept history is in.
    const after = (plan.note.upTo as number) + 1;
    await channel.truncate(this.#eventChunks.length ? Math.min(this.#eventChunks[0][0], after) : after);
  }

  /** The record cannot be rebuilt by this code: keep showing the chat, never write to it. */
  #rebuildFailed(error: unknown): void {
    if (this.rebuildError) return;
    log.exception(error, 'Rebuilding a chat from the keeper record failed');
    this.rebuildError = `AIB could not continue this chat after the restart (${
      errorText(error) || errorName(error)
    }). The agent goes on in the background; nothing is sent to it from here. Close the chat to stop it.`;
    this.error = this.rebuildError;
    this.#held = [];
    this.#deferred = [];
    this.#settleRebuild?.[1](error instanceof Error ? error : new Error(String(error)));
    this.#settleRebuild = null;
  }

  #refuseReadOnly(): void {
    if (this.rebuildError) throw new ValueError(this.rebuildError);
  }

  /** Answer a client capability request; in the keeper the side effects that cannot be undone get their note first. */
  #dispatchCaps(message: Json): void | Promise<void> {
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

  /** Returncode once the agent exited (Popen.poll()). */
  poll(): number | null {
    return this.exitCode;
  }

  /**
   * An event Studio makes itself (not from the agent: an artifact, a Studio note, a session op). In the keeper it also goes into the
   * record as an `event` note, so a rebuild has it in the same place and numbers every later event the same.
   */
  recordedEvent(kind: string, data: unknown): void {
    if (this.channel && !this.#replaying && !this.rebuildError) void this.channel.sendNote({ t: 'event', kind, data });
    this.event(kind, data);
  }

  event(kind: string, data: unknown): void {
    this.sequence += 1;
    const item: Json = { seq: this.sequence, kind, data, time: this.#now() };
    // History the agent re-sends on session/load: 'time' is the reconnect, not when it was said.
    if (kind === 'update' && !this.ready && this.sessionId) item.replay = true;
    if (this.events.length >= MAX_EVENTS) {
      this.eventImageBytes -= eventImageSize(this.events.shift()!);
    }
    this.events.push(item);
    this.eventImageBytes += eventImageSize(item);
    if (kind === 'update') this.#trackSubagent(data);
    while (
      this.eventImageBytes > MAX_EVENT_IMAGE_BYTES && this.events.length > 1
    ) {
      this.eventImageBytes -= eventImageSize(this.events.shift()!);
    }
  }

  /** Remember what the agent says each child can do (RFD form: capabilities.cancel). */
  #trackSubagent(params: unknown): void {
    const update = isDict(params) ? get(params, 'update') : null;
    if (!isDict(update) || get(update, 'sessionUpdate') !== 'subagent_update') {
      return;
    }
    const child = get(update, 'sessionId');
    if (!isStr(child) || !child || child === this.sessionId) return;
    let entry = this.subagents.get(child);
    if (!entry) this.subagents.set(child, entry = { capabilities: {} });
    for (const name of ['title', 'description']) {
      const value = get(update, name);
      if (isStr(value) && pyStrip(value)) entry[name] = clip(value, 500);
    }
    // Where the child works, when the agent says (worktrees/merge.ts: only a helper inside the chat's own worktree holds a merge).
    for (const name of ['cwd', 'worktree', 'worktreePath', 'workingDirectory']) {
      const value = get(update, name);
      if (isStr(value) && pyStrip(value)) entry.cwd = clip(value, 1000);
    }
    if (isDict(get(update, 'capabilities'))) {
      entry.capabilities = update.capabilities;
    }
    let state = get(update, 'state');
    state = isDict(state) ? get(state, 'state') : state;
    if (isStr(state)) entry.state = state;
    while (this.subagents.size > 200) {
      this.subagents.delete(this.subagents.keys().next().value!);
    }
  }

  // ---- Claude Code's held turns and the cycles it starts on its own ------------------------------------------------------------
  /**
   * The Claude Code adapter (claude-agent-acp) holds a prompt's response open while background helpers (Agent with
   * run_in_background) that the turn started still run: the reply has ended, but the response comes only once they finish, or when
   * the next prompt arrives (the adapter then settles the held turn at once). It also starts model cycles on its own when a
   * background task finishes, with no prompt at all. Its updates say both: the usage_update of a result carries
   * `_meta['_claude/origin']` (no other update does), `human` for a prompt's result, `task-notification` (and the other kinds in
   * AUTONOMOUS_ORIGINS) for a cycle it started. Only this adapter announces `agentCapabilities._meta.claudeCode`.
   */
  #claudeHolds(): boolean {
    const caps = isDict(this.initial) ? get(this.initial, 'agentCapabilities') : null;
    const meta = isDict(caps) ? get(caps, '_meta') : null;
    return isDict(meta) && isDict(get(meta, 'claudeCode'));
  }

  /**
   * Background helpers of this chat still run although no turn may be working (Claude Code's held turns): the chat must not be cut
   * off (Studio.busyList), but it is not busy for the page or the queue.
   */
  helpersRunning(): boolean {
    return !this.closed && this.#liveHelpers.size > 0;
  }

  /**
   * A Claude Code background shell of this chat still runs (a long test run started with Bash run_in_background, its reply long
   * ended): like helpersRunning, the chat must not be cut off on quit, update or idle exit (Studio.busyList 'background'), but it is
   * not busy for the page or the queue. Claude Code tells a client like AIB only that the command went to the background (the Bash
   * result's `_meta.claudeCode.toolResponse.backgroundTaskId`), never that it ended, so the end is read from the OS: the agent's
   * processes that started with the command are gone (platform/descendants.ts). A shell whose processes could not be listed counts
   * until a task-notification cycle of Claude Code (it starts one when a background task ends).
   */
  backgroundShellsRunning(): boolean {
    if (this.closed || !this.#bgShells.size) return false;
    const pid = this.process?.pid;
    const now = pid ? descendants(pid) : null;
    if (now) {
      const live = new Set(now.map((d) => d.pid));
      for (const [task, pids] of [...this.#bgShells]) {
        if (pids !== null && !pids.some((p) => live.has(p))) {
          this.#bgShells.delete(task);
          log.info('chat %s: background shell %s ended', this.id, task);
        }
      }
    }
    return this.#bgShells.size > 0;
  }

  /** The background shells this chat counts as running now (task ids), for tests and the log. */
  backgroundShells(): string[] {
    return this.backgroundShellsRunning() ? [...this.#bgShells.keys()] : [];
  }

  /** The agent's processes now, as the turn begins (an MCP server, the PowerShell tool's own shell): see #markBackground. */
  #noteTurnProcesses(): void {
    this.#turnProcesses = null;
    const pid = this.process?.pid;
    if (this.#replaying || !pid) return;
    refreshDescendants();
    const now = descendants(pid);
    if (now) this.#turnProcesses = new Set(now.map((d) => d.pid));
  }

  /**
   * Every agent's tool calls (any session: a helper's shells run in the same agent): which are shell commands, their status, and
   * which moved to the background (Claude Code's backgroundTaskId, OMP's details.async, the result text; see backgroundTask), so the
   * page can mark the row and Stop can end it. Also notes main-session output for the steer rules (B1, B13).
   */
  #watchTools(params: Json): void {
    if (!this.ready || this.closed) return;
    const update = get(params, 'update');
    if (!isDict(update)) return;
    const kind = get(update, 'sessionUpdate');
    const main = get(params, 'sessionId') === this.sessionId;
    const meta = get(update, '_meta');
    const claude = isDict(meta) ? get(meta, 'claudeCode') : null;
    if (
      main && this.busy && !this.autonomous &&
      (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') &&
      !(isDict(claude) && get(claude, 'parentToolUseId'))
    ) this.#mainOutput();
    if (kind === 'session_message' || kind === 'subagent_update') return this.#watchHelper(update, kind, main);
    if (kind !== 'tool_call' && kind !== 'tool_call_update') return;
    const id = get(update, 'toolCallId');
    if (!isStr(id) || !id) return;
    const toolName = isDict(claude) ? get(claude, 'toolName') : null;
    let seen = this.#tools.get(id);
    if (kind === 'tool_call' && !seen) {
      // A shell command: Claude Code's Bash or PowerShell; for the other agents an `execute` tool (Codex exec_command, OMP bash).
      // Never an MCP tool or WebFetch, whatever kind it reports.
      const shell = isStr(toolName) ? toolName === 'Bash' || toolName === 'PowerShell' : get(update, 'kind') === 'execute';
      seen = { shell, status: '', since: this.#now(), main, turn: this.promptSeq };
      this.#tools.set(id, seen);
      while (this.#tools.size > 300) this.#tools.delete(this.#tools.keys().next().value!);
      if (shell) {
        if (!this.#shellCalls.has(id)) this.#shellCalls.set(id, seen.since);
        while (this.#shellCalls.size > 200) this.#shellCalls.delete(this.#shellCalls.keys().next().value!);
      }
    }
    const status = get(update, 'status');
    if (seen && isStr(status)) seen.status = status;
    if (kind !== 'tool_call_update') return;
    const background = this.#bgTools.get(id);
    if (background) {
      // Codex: the command's completed update comes after the turn; OMP: a second completed on the old card, or the job's end.
      if (background.state === 'running' && toolEnded(update, this.#claudeHolds())) this.#backgroundEnded(id, background, 'done');
      return;
    }
    const task = backgroundTask(update, this.#claudeHolds());
    if (task) this.#markBackground(id, task);
  }

  /**
   * The tool `id` went on running in the background as `task`. Notes the agent's processes that started with the command: not there
   * when the turn began, and not older than its tool call (two seconds of slack for ps's whole-second start times). An older one (an
   * MCP server, the PowerShell tool's own shell) is not it. None: the command already ended. A process of unknown age counts as
   * running (never cut one off) but makes Stop unavailable. Stop is offered only for a shell command whose processes cannot belong
   * to another command (no other shell command running, none started since this one) and whose start times are known.
   */
  #markBackground(id: string, task: string, onlyIfRunning = false): void {
    if (this.#bgShells.has(task) || this.#bgTools.has(id)) return;
    const since = this.#shellCalls.get(id) ?? this.#tools.get(id)?.since ?? this.#now() - 10;
    const pid = this.process?.pid;
    refreshDescendants(); // the command started a moment ago: a snapshot from before it would not have it
    const now = pid ? descendants(pid) : null;
    const before = this.#turnProcesses;
    const mine = now ? now.filter((d) => !before?.has(d.pid) && (d.started === null || d.started >= since - 2)) : null;
    const taken = new Set([...this.#bgTools.values()].filter((t) => t.state === 'running').flatMap((t) => t.procs ?? []).map((p) => p.pid));
    const pids = mine ? mine.filter((d) => !taken.has(d.pid)) : null;
    const at = this.#now();
    if (pids && !pids.length) {
      if (onlyIfRunning) return;
      this.#bgTools.set(id, { task, state: 'done', procs: null, stoppable: false, since, at, endedAt: at });
      this.#trimBackground();
      this.#announceBackground(id);
      return;
    }
    this.#bgShells.set(task, pids ? pids.map((d) => d.pid) : null);
    while (this.#bgShells.size > 100) this.#bgShells.delete(this.#bgShells.keys().next().value!);
    const shell = this.#tools.get(id)?.shell ?? this.#shellCalls.has(id);
    const others = [...this.#tools].some(([other, t]) =>
      other !== id && t.shell &&
      (t.since >= since - 2 || !['completed', 'failed'].includes(t.status) || this.#bgTools.get(other)?.state === 'running')
    );
    const known = pids !== null && before !== null && pids.every((d) => d.started !== null);
    const stoppable = shell && known && !others;
    const procs = stoppable ? pids!.map((d) => ({ pid: d.pid, started: d.started as number })) : null;
    this.#bgTools.set(id, { task, state: 'running', procs, stoppable, since, at, endedAt: null });
    this.#trimBackground();
    this.#announceBackground(id);
    log.info(
      'chat %s: tool %s went to the background as %s (%s%s)',
      this.id,
      id,
      task,
      pids ? `processes ${pids.map((d) => d.pid).join(', ')}` : 'processes unknown',
      stoppable ? '' : ', no Stop',
    );
  }

  /**
   * Claude Code helpers (recording C2): a steer moves a foreground helper to the background, and the adapter says so in the main
   * session with a session_message `<toolUseId>:reply` from the helper's session, "Async agent launched successfully". Its row (the
   * Agent tool call, and the helper's card in the Activity pane) is marked running in the background, without Stop; it is done once
   * the helper's subagent_update leaves running.
   */
  #watchHelper(update: Json, kind: unknown, main: boolean): void {
    if (kind === 'subagent_update') {
      const child = get(update, 'sessionId');
      let state = get(update, 'state');
      state = isDict(state) ? get(state, 'state') : state;
      if (!isStr(child) || !isStr(state) || state === 'running' || state === 'requires_action') return;
      for (const [id, t] of this.#bgTools) {
        if (t.helper === child && t.state === 'running') this.#backgroundEnded(id, t, 'done');
      }
      return;
    }
    if (!main) return;
    const messageId = get(update, 'messageId');
    const sender = get(update, 'senderSessionId');
    if (!isStr(messageId) || !messageId.endsWith(':reply') || !isStr(sender) || sender === this.sessionId) return;
    const content = get(update, 'content');
    const text = rawOutputText({ content: Array.isArray(content) ? content : [] });
    if (!HELPER_BACKGROUND_TEXT.test(text)) return;
    const id = messageId.slice(0, -':reply'.length);
    if (!id || this.#bgTools.has(id) || !this.#liveHelpers.has(sender)) return;
    const at = this.#now();
    this.#bgTools.set(id, {
      task: `helper:${sender}`,
      state: 'running',
      procs: null,
      stoppable: false,
      since: this.#tools.get(id)?.since ?? at,
      at,
      endedAt: null,
      helper: sender,
    });
    this.#trimBackground();
    this.#announceBackground(id);
    log.info('chat %s: helper %s (%s) went on in the background', this.id, sender, id);
  }

  /**
   * The page reads a tool row's background state from the row's updates (`update.background = {state, stoppable}`): each change is
   * a tool_call_update of AIB's own for that row. A recorded event (keeper note), so a rebuild has it in the same place; never made
   * while replaying (the note brings it back).
   */
  #announceBackground(id: string): void {
    const t = this.#bgTools.get(id);
    if (!t || this.#replaying) return;
    this.recordedEvent('update', {
      sessionId: this.sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        background: {
          state: t.state,
          stoppable: t.state === 'running' && t.stoppable && !this.closed,
          ...(t.helper ? { helper: t.helper } : {}),
        },
      },
    });
  }

  #trimBackground(): void {
    while (this.#bgTools.size > 100) this.#bgTools.delete(this.#bgTools.keys().next().value!);
  }

  #backgroundEnded(id: string, background: BackgroundTool, state: 'done' | 'stopped'): void {
    background.state = state;
    background.endedAt = this.#now();
    this.#bgShells.delete(background.task);
    log.info('chat %s: background tool %s %s', this.id, id, state === 'done' ? 'ended' : 'was stopped');
    this.#announceBackground(id);
  }

  /**
   * Codex keeps running a command past its turn's end (recording X1): an execute tool of the main session still open when the turn
   * ends, whose processes still run, is a background command from then on (its completed update comes later, with no new turn).
   */
  #backgroundOpenTools(seq: number): void {
    if (this.#claudeHolds()) return; // Claude Code says so itself (backgroundTaskId); its turn never ends with a tool open
    for (const [id, seen] of [...this.#tools]) {
      if (seen.turn !== seq || !seen.main || !seen.shell || this.#bgTools.has(id)) continue;
      if (seen.status === 'completed' || seen.status === 'failed') continue;
      this.#markBackground(id, `open:${id}`, true);
    }
  }

  /** The background tools as the page sees them (snapshot `toolBackground`): {toolCallId: {state, stoppable}}. */
  toolBackground(): Record<string, { state: string; stoppable: boolean; helper?: string }> {
    if (!this.#bgTools.size) return {};
    this.backgroundShellsRunning(); // drops shells whose processes ended
    const out: Record<string, { state: string; stoppable: boolean; helper?: string }> = {};
    for (const [id, t] of this.#bgTools) {
      if (t.helper) {
        // a helper ends with its subagent_update; one AIB no longer counts as live (an agent restart) is over too
        if (t.state === 'running' && (this.closed || !this.#liveHelpers.has(t.helper))) this.#backgroundEnded(id, t, 'done');
      } else if (t.state === 'running' && !this.#bgShells.has(t.task)) this.#backgroundEnded(id, t, 'done');
      out[id] = { state: t.state, stoppable: t.state === 'running' && t.stoppable && !this.closed, ...(t.helper ? { helper: t.helper } : {}) };
    }
    return out;
  }

  /**
   * Stop a command running in the background (POST /api/live/tool-stop): AIB kills the processes it noted when the command moved
   * there, re-verified now (still the agent's, same start time) together with what they started since, leaf first
   * (platform/kill_verified.ts). Refused (NotStoppable, HTTP 409) for anything else: an MCP tool, a command whose processes could
   * not be told apart, one that already ended. The agent learns of it on its own (Claude Code's task notification).
   */
  async stopBackgroundTool(toolCallId: unknown): Promise<Json> {
    this.#refuseReadOnly();
    const background = isStr(toolCallId) ? this.#bgTools.get(toolCallId) : undefined;
    if (!background) throw new NotStoppable('That tool is not running in the background.');
    this.toolBackground();
    if (background.helper) {
      throw new NotStoppable("AIB can't stop a helper by itself: it runs inside the agent's own process. Ask the agent to stop it.");
    }
    if (background.state !== 'running') throw new NotStoppable('That command is no longer running.');
    if (!background.stoppable || !background.procs?.length) {
      throw new NotStoppable('AIB cannot tell which processes belong to this command, so it cannot stop it.');
    }
    const pid = this.process?.pid;
    if (this.closed || !pid) throw new NotStoppable('The agent is not running.');
    const result = await killVerified(pid, background.procs);
    if (!result) throw new NotStoppable('AIB cannot list the processes right now. Try again.');
    if (!result.killed.length) {
      this.#backgroundEnded(toolCallId as string, background, 'done');
      return { ok: true, toolCallId, state: 'done', killed: 0 };
    }
    this.#backgroundEnded(toolCallId as string, background, 'stopped');
    log.info('chat %s: stopped background tool %s (processes %s)', this.id, toolCallId, result.killed.map((k) => k.pid).join(', '));
    return { ok: true, toolCallId, state: 'stopped', killed: result.killed.length };
  }

  /** A helper started during the current prompt turn is still running (or waits for the user). */
  #helpersRunning(): boolean {
    for (const child of this.#turnHelpers) {
      const state = this.subagents.get(child)?.state;
      if (state === 'running' || state === 'requires_action') return true;
    }
    return false;
  }

  /** Main-session output of the running prompt turn: a steer before it was read (B13), and a pending early end is off (B1). */
  #mainOutput(): void {
    this.#steerTurn.outputAfter = true;
    this.#steerTurn.unread = [];
    this.#clearSettle();
  }

  #clearSettle(): void {
    if (this.#settleTimer !== null) clearTimeout(this.#settleTimer);
    this.#settleTimer = null;
  }

  /** End the held turn early once steerTiming.settleMs pass with no main-session output (which clears the timer). */
  #armSettle(early: { seq: number; fire: () => void }): void {
    this.#clearSettle();
    this.#settleTimer = setTimeout(() => {
      this.#settleTimer = null;
      if (this.#endEarly !== early || !this.busy || this.autonomous || this.cancelSeq >= early.seq || !this.#helpersRunning()) return;
      this.#endEarly = null;
      early.fire();
    }, steerTiming.settleMs);
  }

  /**
   * One session/update seen (after it is recorded): ends a prompt turn whose reply ended while its helpers still run, and shows a
   * cycle Claude Code started on its own as working until its result. Same on a rebuild from the keeper's record, which replays the
   * same lines. Returns a promise when the turn's end must be handled before the next line is read.
   */
  #watchHeldTurn(params: Json): Promise<void> | void {
    if (!this.ready || this.closed || !this.#claudeHolds()) return;
    const update = get(params, 'update');
    if (!isDict(update)) return;
    const kind = get(update, 'sessionUpdate');
    if (kind === 'subagent_update') {
      const child = get(update, 'sessionId');
      let state = get(update, 'state');
      state = isDict(state) ? get(state, 'state') : state;
      const live = state === 'running' || state === 'requires_action';
      if (isStr(child) && live && this.busy && !this.autonomous) {
        this.#turnHelpers.add(child);
      }
      if (isStr(child) && live) this.#liveHelpers.add(child);
      else if (isStr(child) && isStr(state)) this.#liveHelpers.delete(child);
      return;
    }
    if (get(params, 'sessionId') !== this.sessionId) return; // a subagent's own updates
    const meta = get(update, '_meta');
    if (kind === 'usage_update') {
      const origin = isDict(meta) ? get(meta, '_claude/origin') : null;
      if (!isDict(origin)) return; // usage during the turn, not a result
      if (get(origin, 'kind') === 'task-notification') {
        // A background task ended: one shell whose processes could not be listed stops counting (the others are read from the OS).
        const unknown = [...this.#bgShells].find(([, pids]) => pids === null);
        if (unknown) this.#bgShells.delete(unknown[0]);
        // ...and a row marked running in the background whose processes are gone is done now, not at the next snapshot (the process
        // list is cached for a second): Claude Code sends nothing else for the command (recording C1)
        refreshDescendants();
        this.toolBackground();
      }
      if (this.autonomous) return this.#endAutonomous('end_turn');
      const early = this.#endEarly;
      if (
        early && this.busy && !AUTONOMOUS_ORIGINS.has(get(origin, 'kind') as string) && this.cancelSeq < early.seq &&
        this.#helpersRunning()
      ) {
        // B1: a steer interrupts the running cycle, which then ends with a result of its own; the steered message's reply comes
        // after it (in the same cycle, or a cycle of its own, recording C4). So with a steer in this turn, only a result after
        // main-session output that came after the last steer can end the turn early, and only once no more output follows for a
        // moment. A human result is never a turn end by itself.
        if (this.#steerTurn.injected) {
          if (this.#steerTurn.outputAfter) this.#armSettle(early);
          return;
        }
        this.#endEarly = null;
        early.fire();
        return new Promise((resolve) => setTimeout(resolve, 0)); // the turn's end is recorded before what comes after it
      }
      return;
    }
    // Claude Code's own cycle: model output of the main conversation while no prompt runs.
    if (
      !this.busy && (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') &&
      !(isDict(meta) && isDict(get(meta, 'claudeCode')) && get(get(meta, 'claudeCode') as Json, 'parentToolUseId'))
    ) {
      this.autonomous = true;
      this.busy = true;
      this.turnStartedAt = now();
      this.error = '';
    }
  }

  /** Claude Code's own cycle ended (its result came, or it was stopped): the chat is idle again and the queue goes on. */
  #endAutonomous(stopReason: string): Promise<void> {
    this.autonomous = false;
    this.turnEndedAt = this.#now();
    const result = { stopReason };
    this.#queueNoteOutcome(result, false);
    this.event('turn_end', result);
    const done = (async () => {
      const hook = this.onTurnEnd;
      if (hook && !this.#replaying && stopReason !== 'cancelled') {
        try {
          await hook(this);
        } catch (error) {
          log.exception(error, 'on_turn_end hook failed');
        }
      }
      await this.#finishTurn();
      await this.#queueAfterTurn();
      if (!this.#replaying) this.#scheduleSnapshot();
    })().catch((error) => log.exception(error, 'Ending a cycle the agent started on its own failed'));
    this.turn = done;
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** One JSON-RPC message to the agent. Writes go out in call order; throws when the agent's stdin is known to be gone. */
  write(message: unknown, once?: string): void {
    if (this.channel) {
      if (this.#stdinClosed) throw new ValueError('I/O operation on closed file.');
      if (this.#stdinBroken) throw new BrokenPipeError('[Errno 32] Broken pipe');
      if (this.rebuildError) return; // read-only: nothing reaches the agent from here
      const key = once ?? this.#onceKey(message as Json);
      if (this.#replaying) {
        this.#held.push({ message: message as Json, once: key });
        return;
      }
      void this.channel.write(ENCODER.encode(JSON.stringify(message) + '\n'), key);
      return;
    }
    const writer = this.#stdin;
    if (writer === null || this.#stdinClosed) {
      throw new ValueError('I/O operation on closed file.');
    }
    if (this.#stdinBroken) throw new BrokenPipeError('[Errno 32] Broken pipe');
    writer.write(ENCODER.encode(JSON.stringify(message) + '\n')).catch(() => {
      this.#stdinBroken = true;
    });
  }

  /**
   * The once-key a keeper write carries, so it can never reach the agent twice (a later AIB that resends it is refused): answers
   * by the agent's request id, requests by our id, a cancel by turn.
   */
  #onceKey(message: Json): string | undefined {
    if (!isDict(message)) return undefined;
    if (!Object.hasOwn(message, 'method')) {
      if (!Object.hasOwn(message, 'id')) return undefined;
      const id = JSON.stringify(message.id); // agents may reuse a request id in a later turn: the key counts its uses
      return `resp:${id}:${this.#requestsSeen.get(id) ?? 0}`;
    }
    if (Object.hasOwn(message, 'id')) return `req:${JSON.stringify(message.id)}`;
    if (message.method === 'session/cancel') {
      return `cancel:${JSON.stringify(get(get(message, 'params', {}) as Json, 'sessionId'))}:${this.promptSeq}`;
    }
    return undefined;
  }

  async request(
    method: string,
    params: unknown,
    timeout = 30,
    options: { once?: string; note?: (id: number) => Json | null } = {},
  ): Promise<unknown> {
    if (method === 'initialize') params = augmentInitialize(params as Json);
    this.counter += 1;
    const key = this.counter;
    const entry: Pending = { done: new ThreadEvent(), method, params };
    this.pending.set(key, entry);
    try {
      const note = this.channel && options.note ? options.note(key) : null;
      if (note) void this.channel!.sendNote(note); // goes out before the write: the record says what it is first
      this.write({ jsonrpc: '2.0', id: key, method, params }, options.once);
      if (!(await entry.done.wait(timeout * 1000))) {
        throw new TimeoutError(
          `${method} did not respond within ${timeout} seconds`,
        );
      }
      return Connection.#result(entry.response!);
    } finally {
      this.pending.delete(key);
    }
  }

  static #result(result: Json): unknown {
    if (Object.hasOwn(result, 'error')) {
      const error = result.error;
      const failure = new RuntimeError(
        pyStr(
          isDict(error) && Object.hasOwn(error, 'message') ? error.message : error,
        ),
      );
      // The agent's code and data ride along (Qwen's subscriptionQuota, a -32601 for an unknown request); the message is unchanged.
      if (isDict(error)) Object.assign(failure, { code: error.code ?? null, data: error.data ?? null });
      throw failure;
    }
    return Object.hasOwn(result, 'result') ? result.result : {};
  }

  /** A request the old AIB sent (rebuilt from the record): wait for its response, which comes from the record or live. */
  async #awaitReplayed(entry: Pending, id: unknown): Promise<unknown> {
    try {
      await entry.done.wait();
      return Connection.#result(entry.response!);
    } finally {
      if (this.pending.get(id) === entry) this.pending.delete(id);
    }
  }

  #pushStderr(line: string): void {
    this.stderr.push(line);
    while (this.stderr.length > 30) this.stderr.shift();
  }

  async #readErrors(stream: ReadableStream<Uint8Array>): Promise<void> {
    const lines = new PyTextLines();
    const reader = this.#stderrReader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of lines.feed(value)) {
          this.#pushStderr(clip(line.replace(RSTRIP, ''), 2000));
        }
      }
      for (const line of lines.feed(null, true)) {
        this.#pushStderr(clip(line.replace(RSTRIP, ''), 2000));
      }
    } catch {
      /* the pipe went away: as Python's thread, just stop */
    } finally {
      reader.releaseLock();
    }
  }

  async #read(stream: ReadableStream<Uint8Array>): Promise<void> {
    let failure = '';
    const lines = new PyTextLines();
    const reader = this.#stdoutReader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of lines.feed(value)) {
          const pending = this.#handleLine(line);
          if (pending) await pending;
        }
      }
      for (const line of lines.feed(null, true)) {
        const pending = this.#handleLine(line);
        if (pending) await pending;
      }
    } catch (error) {
      if (isOsOrValueError(error)) this.error = errorText(error);
      else {
        failure = this.#internalFailure(error);
        try {
          await reader.cancel();
        } catch { /* already gone */ }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch { /* a read is still pending (close() cancels it) */ }
      this.#readerEnded(failure);
    }
  }

  /** A bug in one of our handlers must not leave a half-working connection behind: say what happened, then stop the agent. */
  #internalFailure(error: unknown): string {
    log.exception(
      error,
      'Internal error while reading from the agent; closing the connection',
    );
    const name = errorName(error);
    const message = errorText(error);
    const frames = error instanceof Error && error.stack ? error.stack.split(/\r?\n/).slice(1).map((l) => l.trim()).reverse() : [];
    const trace = [
      'Traceback (most recent call last):',
      ...frames,
      `${name}: ${message}`,
    ].join('\n');
    this.traceback = trace;
    for (const line of trace.split('\n').slice(-12)) {
      this.#pushStderr(clip(line, 2000));
    }
    const failure =
      `AIB hit an internal error while reading from the agent (${name}: ${message}). The connection was closed; reconnect to continue.`;
    this.error = failure;
    try {
      this.tree?.kill();
    } catch (killError) {
      log.exception(killError, 'Killing the agent process tree failed');
    }
    return failure;
  }

  /** The agent's output ended (it exited, the pipe broke, or the keeper went away): the connection is closed. Runs once. */
  #readerEnded(failure: string): void {
    if (this.#ended) return;
    this.#ended = true;
    try {
      this.closed = true;
      if (this.closedAt === null) this.closedAt = now();
      this.ready = false;
      this.busy = false;
      this.permissions.clear();
      this.pendingChanges.clear();
      this.#clearElicitations({});
      const message = failure ||
        'ACP connection closed. ' + this.stderr.slice(-3).join('\n');
      for (const entry of this.pending.values()) {
        // An answer that already arrived is kept (Python could overwrite it here when the agent exited right after replying).
        if (entry.done.isSet()) continue;
        entry.response = { error: { message } };
        entry.done.set();
      }
      this.releaseLease();
      this.#shutdownCaps();
      this.event('disconnected', {
        message: this.error || 'Agent connection closed',
      });
    } finally {
      this.#endedResolve?.();
      this.#settleRebuild?.[0](); // ended during the rebuild: the caller sees it closed
      this.#settleRebuild = null;
    }
  }

  /** One stdout line, handled before the next is read. Returns a promise when the next line must wait (a reply, a capability call). */
  #handleLine(line: string): Promise<void> | void {
    const message = screen(this, line) as Json | null;
    if (message === null) return;
    if (!Object.hasOwn(message, 'method')) {
      const waiting = this.pending.get(get(message, 'id'));
      if (waiting) {
        waiting.response = message;
        waiting.done.set();
        // Let the caller that waited on this reply run before the next line is read, as Python's waiting thread wakes at once:
        // a repeated reply then finds no pending request, and a turn's end is recorded before what the agent sent after it.
        return new Promise((resolve) => setTimeout(resolve, 0));
      }
      return;
    }
    const method = message.method as string;
    const params = get(message, 'params', {}) as Json;
    if (Object.hasOwn(message, 'id')) {
      const seenKey = JSON.stringify(message.id);
      this.#requestsSeen.set(seenKey, (this.#requestsSeen.get(seenKey) ?? 0) + 1);
      if (
        method === 'session/request_permission' && this.ownArtifactTool(params)
      ) {
        // Studio's own artifact tool only publishes into this chat; never make the user approve it.
        const options = get(params, 'options', []);
        const allow = (Array.isArray(options) ? options : []).find((o) => isDict(o) && o.kind === 'allow_once') as Json | undefined;
        if (allow && isStr(allow.optionId)) {
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              outcome: { outcome: 'selected', optionId: allow.optionId },
            },
          });
          return;
        }
      }
      if (method === 'session/request_permission') {
        const key = hex(12);
        this.permissions.set(key, { rpcId: message.id, params });
        this.event('permission', { key, params });
      } else if (this.caps.handles(method)) {
        if (this.#replaying) { // answered once live, unless the record shows the old AIB answered it
          this.#deferred.push(message);
          return;
        }
        const answered = this.#dispatchCaps(message);
        // terminal/wait_for_exit can take as long as the command runs: answered on its own (Python: a worker thread). Everything
        // else is answered before the next line is read, as Python's reader thread does.
        if (method !== 'terminal/wait_for_exit') return answered;
        answered?.catch((error) => log.exception(error, 'Client capability request failed'));
      } else if (method === 'elicitation/create') {
        try {
          this.receiveElicitation(message.id, params);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !['ValueError', 'TypeError', 'KeyError'].includes(error.name)
          ) throw error;
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: errorText(error) },
          });
        }
      } else {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Client capability not advertised: ${method}`,
          },
        });
      }
    } else if (method === 'session/update') {
      const update = get(params, 'update', {}) as Json;
      const sid = get(params, 'sessionId');
      if (isStr(sid) && sid) this.knownSessions.add(sid);
      // Some agents report subagent session IDs in update payloads.
      for (const name of ['subagentSessionId', 'childSessionId']) {
        const child = pget(update, name);
        if (isStr(child) && child) this.knownSessions.add(child);
      }
      const subagent = get(update, 'subagent');
      if (isDict(subagent) && isStr(subagent.sessionId) && subagent.sessionId) {
        this.knownSessions.add(subagent.sessionId);
      }
      if (this.sessionId === null || sid === null || sid === this.sessionId) {
        applyUpdate(this.breadth, update, this.#now());
        const meta = get(update, 'sessionUpdate') === 'usage_update' ? get(update, '_meta') : null;
        if (isDict(meta) && isDict(meta['_claude/rateLimit'])) {
          this.onLimits?.(this, 'claude-rate-limit', meta['_claude/rateLimit'], this.#now());
        }
      }
      // The chat's own settings only: a subagent's session reports its own config (claude-agent-acp: the helper's model, mode,
      // effort and agent type), which must not replace the chat's.
      const own = this.sessionId === null || sid === null || sid === this.sessionId;
      if (own && get(update, 'sessionUpdate') === 'config_option_update') {
        this.settings.configOptions = get(update, 'configOptions', []);
        withModelsOption(this.settings); // an agent's models list stays offered as the model option
      }
      if (own && get(update, 'sessionUpdate') === 'current_mode_update') {
        this.#modes().currentModeId = get(update, 'currentModeId');
      }
      this.writes.observe(params);
      this.event('update', params);
      this.#watchTools(params);
      return this.#watchHeldTurn(params);
    } else if (method === 'elicitation/complete') {
      this.completeElicitation(params);
    } else if (method === '$/cancel_request') {
      this.cancelIncomingRequest(
        isDict(params) ? get(params, 'requestId') : null,
      );
    } else {
      this.event('notice', { method, params });
    }
  }

  /** self.settings.setdefault('modes', {}): a non-dict value fails as item assignment does in Python. */
  #modes(): Json {
    if (!Object.hasOwn(this.settings, 'modes')) this.settings.modes = {};
    const modes = this.settings.modes;
    if (!isDict(modes)) {
      throw new TypeError(
        `'${pyTypeName(modes)}' object does not support item assignment`,
      );
    }
    return modes;
  }

  /** Kill the agent's client terminals; never throws. */
  #shutdownCaps(): Promise<void> {
    try {
      return Promise.resolve(this.caps.shutdown()).catch((error) => log.exception(error, 'Stopping client terminals failed'));
    } catch (error) {
      log.exception(error, 'Stopping client terminals failed');
      return Promise.resolve();
    }
  }

  releaseLease(): void {
    const lease = this.sessionLease;
    this.sessionLease = null;
    if (lease) lease.release();
    const hook = this.onRelease;
    if (hook) {
      try {
        const result = hook(this);
        if (result instanceof Promise) {
          result.catch((error) => log.exception(error, 'on_release hook failed'));
        }
      } catch (error) {
        log.exception(error, 'on_release hook failed');
      }
    }
  }

  #pausedForUser(): boolean {
    return !!(this.elicitations.size || this.permissions.size ||
      (this.auth && !this.auth.working));
  }

  /** Like request(), but the timeout clock stops while a person is being asked something. */
  async setupRequest(
    method: string,
    params: unknown,
    timeout: number,
  ): Promise<unknown> {
    if (method === 'initialize') params = augmentInitialize(params as Json);
    this.counter += 1;
    const key = this.counter;
    const entry: Pending = { done: new ThreadEvent(), method, params };
    this.pending.set(key, entry);
    try {
      this.write({ jsonrpc: '2.0', id: key, method, params });
      let waited = 0;
      while (!(await entry.done.wait(250))) {
        if (!this.#pausedForUser()) waited += 0.25;
        if (waited >= timeout) {
          throw new TimeoutError(
            `${method} did not respond within ${timeout} seconds`,
          );
        }
      }
      const response = entry.response!;
      if (Object.hasOwn(response, 'error')) throw new RpcError(response.error);
      return Object.hasOwn(response, 'result') ? response.result : {};
    } finally {
      this.pending.delete(key);
    }
  }

  #checkSetupAbort(): void {
    if (this.setupAbort) throw new ValueError(this.setupAbort);
  }

  /** Fail connection setup now (e.g. the person declined a setup question). */
  abortSetup(message: string): void {
    this.setupAbort = this.setupAbort || message;
    for (const entry of [...this.pending.values()]) {
      if (!entry.done.isSet()) {
        entry.response = { error: { message, code: null } };
        entry.done.set();
      }
    }
    this.authResponse = ['cancel', null];
    this.authEvent.set();
  }

  async #setupSessionCall(method: string, params: Json): Promise<unknown> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await this.setupRequest(method, params, 90);
        this.#checkSetupAbort();
        return result;
      } catch (error) {
        if (!(error instanceof RpcError)) throw error;
        this.#checkSetupAbort();
        if (!isAuthRequired(error)) throw error;
        if (attempt === 3) {
          throw new ValueError(
            'The agent still reports that sign-in is required. ' +
              error.message,
          );
        }
        await this.#awaitAuth(error);
      }
    }
    throw new ValueError('Sign-in did not complete');
  }

  /** Hold connection setup until the person signs in, retries, or cancels. */
  async #awaitAuth(error: RpcError): Promise<void> {
    const auth: AuthState = {
      methods: [...this.authMethods],
      message: clip(error.message, 500),
      error: '',
      working: false,
    };
    this.auth = auth;
    this.authResponse = null;
    this.authEvent.clear();
    this.event('auth_required', {
      methods: auth.methods,
      message: auth.message,
    });
    const deadline = now() + 1800;
    try {
      while (true) {
        if (!(await this.authEvent.wait(250))) {
          if (this.closed) {
            throw new RuntimeError(
              'The agent disconnected while waiting for sign-in',
            );
          }
          if (now() > deadline) {
            throw new ValueError(
              'Sign-in timed out. The conversation was not opened.',
            );
          }
          continue;
        }
        this.authEvent.clear();
        this.#checkSetupAbort();
        const [action, methodId] = this.authResponse ?? ['cancel', null];
        if (action === 'cancel') {
          throw new ValueError(
            'Sign-in was cancelled, so the conversation was not opened.',
          );
        }
        if (action === 'retry') return;
        auth.working = true;
        auth.error = '';
        try {
          await this.setupRequest('authenticate', this.authenticateParams(methodId), 120);
          this.#checkSetupAbort();
          return;
        } catch (failure) {
          if (
            !(failure instanceof RpcError) && !(failure instanceof TimeoutError)
          ) throw failure;
          this.#checkSetupAbort();
          if (this.closed) throw failure;
          auth.working = false;
          auth.error = 'Sign-in failed: ' + clip(failure.message, 300);
        }
      }
    } finally {
      this.auth = null;
    }
  }

  /**
   * The params of ACP uthenticate. A Beta agent whose API key method takes the key in _meta['api-key'] (Gemini) gets the key AIB
   * passes in its environment (Settings > AIB Linking > Beta agents); every other method is just {methodId}.
   */
  authenticateParams(methodId: unknown): Json {
    const params: Json = { methodId };
    const agent = betaAgent(this.provider);
    const keyEnv = agent?.signin.keyEnv;
    const key = keyEnv && this.env ? this.env[keyEnv] : '';
    if (agent && key && agent.signin.keyMethod && agent.signin.keyMethod === methodId) params._meta = { 'api-key': key };
    return params;
  }

  /**
   * Beta agents whose session/new reports a model they do not use until the client sets one (GitHub Copilot CLI, github/copilot-cli#5363):
   * right after session/new (and the New chat picks), set the model explicitly to the one the agent reports, through its model config
   * option, else through session/set_model (the models shape). A refusal is logged, never thrown: the chat still opens. True = sent.
   */
  async applyModelQuirk(): Promise<boolean> {
    if (!betaAgent(this.provider)?.setModelAfterNew || !this.sessionId) return false;
    try {
      const option = findPickOption(this.settings, 'model');
      if (option && isStr(option.currentValue) && option.currentValue) {
        await this.setConfig(option.id, option.currentValue);
        return true;
      }
      const models = isDict(this.settings.models) ? this.settings.models as Json : null;
      const current = models && isStr(models.currentModelId) ? models.currentModelId : '';
      if (current) {
        await this.request('session/set_model', { sessionId: this.sessionId, modelId: current });
        return true;
      }
    } catch (error) {
      log.warning('Setting the model of %s after session/new failed: %s', this.provider, errorText(error));
    }
    return false;
  }

  /** Called from the HTTP layer: choose an in-app method, retry after an external sign-in, or cancel. */
  answerAuth(action: unknown, methodId: unknown = null): void {
    const auth = this.auth;
    if (!auth) {
      throw new ValueError('No sign-in is pending for this connection');
    }
    if (auth.working) throw new ValueError('Sign-in is already in progress');
    if (action === 'authenticate') {
      const method = isStr(methodId) ? auth.methods.find((m) => m.id === methodId) ?? null : null;
      if (method === null) throw new ValueError('Unknown sign-in method');
      if (method.kind !== 'agent') {
        throw new ValueError(
          'This sign-in must be completed outside AIB. Follow the instructions shown, then choose Retry.',
        );
      }
    } else if (action !== 'retry' && action !== 'cancel') {
      throw new ValueError('Action must be authenticate, retry, or cancel');
    } else {
      methodId = null;
    }
    this.authResponse = [action as string, methodId as string | null];
    this.authEvent.set();
  }

  async setup(resume: string | null = null): Promise<void> {
    this.#refuseReadOnly();
    this.ready = false;
    if (resume) this.knownSessions.add(resume);
    this.initial = await this.setupRequest('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'agent-studio',
        title: 'AIB',
        version: APP_VERSION,
      },
      clientCapabilities: {
        ...this.caps.capabilities(),
        subagents: {},
        elicitation: { form: {}, url: {} },
        // A Beta agent that signs in through a terminal: AIB runs that sign-in itself (its own terminal, Settings > AIB Linking), so the
        // agent may offer its terminal-type methods (ACP auth.terminal); the chat's sign-in card then has a Sign in button.
        ...(betaAgent(this.provider)?.signin.kind === 'terminal' ? { auth: { terminal: true } } : {}),
      },
    }, 45);
    this.#checkSetupAbort();
    const mcpServers = this.#applyInitialize();
    let result: unknown;
    if (resume) {
      const resumeCaps = sessionCapabilities(this.initial);
      if (!resumeCaps.loadSession && !resumeCaps.resume) {
        throw new ValueError(
          'This agent does not advertise session loading. Start a new conversation instead.',
        );
      }
      this.sessionId = resume;
      result = await this.#setupSessionCall(
        resumeCaps.loadSession ? 'session/load' : 'session/resume',
        {
          sessionId: resume,
          cwd: this.cwd,
          mcpServers,
          ...this.artifactPrompt(mcpServers),
        },
      );
    } else {
      result = await this.#setupSessionCall('session/new', {
        cwd: this.cwd,
        mcpServers,
        ...this.artifactPrompt(mcpServers),
      });
    }
    this.#takeSession(result, resume);
    if (!resume) {
      // Live setup only (a keeper replay never comes here): the New chat page's picks go in before the chat is ready, so the
      // first prompt runs with them. Their set_config_option / set_mode calls are in the keeper's record like any other, so a
      // rebuild replays their answers and never sends them again.
      this.startSettings = structuredClone(result) as Json;
      await this.applyStartPicks();
      await this.applyModelQuirk();
      this.#checkSetupAbort();
    }
    this.#markReady();
  }

  /** What the `initialize` result (this.initial) sets; returns the MCP servers this agent gets. Live setup and replay share it. */
  #applyInitialize(): McpServer[] {
    if (
      !isDict(this.initial) || !pyEq(get(this.initial, 'protocolVersion'), 1)
    ) {
      throw new ValueError(
        'The agent did not negotiate supported ACP protocol version 1',
      );
    }
    let advertised = pget(
      get(this.initial, 'agentCapabilities', {}),
      'promptCapabilities',
      {},
    );
    advertised = isDict(advertised) ? advertised : {};
    this.promptCaps = Object.fromEntries(
      ['image', 'audio', 'embeddedContext'].map((
        key,
      ) => [key, get(advertised as Json, key) === true]),
    );
    this.imageSupported = this.promptCaps.image;
    this.authMethods = describeAuthMethods(
      get(this.initial, 'authMethods'),
      this.provider,
    );
    const [mcpServers, skipped] = selectMcpServers(
      this.mcpServers,
      this.initial,
    );
    this.breadth.skippedMcp = skipped;
    return mcpServers;
  }

  /** What a session/new, session/load or session/resume result sets: the chat is ready. Replay uses it as is. */
  #applySession(result: unknown, resume: string | null): void {
    this.#takeSession(result, resume);
    this.#markReady();
  }

  /** The session id and settings of a session/new, session/load or session/resume result. Live setup and replay share it. */
  #takeSession(result: unknown, resume: string | null): void {
    if (resume) this.sessionId = resume;
    else this.sessionId = isDict(result) ? get(result, 'sessionId') as string | null : null;
    if (!isDict(result) || !isStr(this.sessionId) || !this.sessionId) {
      throw new ValueError('The agent returned an invalid session response');
    }
    withModelsOption(result); // ACP `models` (Gemini): shown, and remembered through startSettings, as the model option
    Object.assign(this.settings, result);
    withModelsOption(this.settings);
    this.knownSessions.add(this.sessionId);
  }

  /** The chat is ready: prompts are accepted from now on. */
  #markReady(): void {
    this.ready = true;
    this.event('connected', {
      sessionId: this.sessionId,
      provider: this.provider,
    });
  }

  /**
   * Apply the New chat page's picks to the session that was just made, each validated against what the agent reports NOW (a remembered
   * model may be gone). A pick equal to the current value is skipped. A refusal is recorded, never thrown: the chat still opens, with
   * the agent's own setting, and the page says which pick did not apply.
   */
  async applyStartPicks(): Promise<Json[]> {
    const picks = this.startPicks;
    this.pickResults = [];
    if (!picks) return this.pickResults;
    for (const kind of ['model', 'mode', 'effort'] as const) {
      const value = picks[kind];
      if (!isStr(value) || !value) continue;
      const entry: Json = { kind, value, ok: false };
      try {
        const modes = isDict(this.settings.modes) ? this.settings.modes : null;
        if (kind === 'mode' && modes && Array.isArray(modes.availableModes) && modes.availableModes.length) {
          checkMode(this.settings, value);
          if (modes.currentModeId !== value) await this.setMode(value);
        } else {
          const option = findPickOption(this.settings, kind);
          if (!option) throw new ValueError(`This agent does not offer a ${kind} setting in this chat`);
          entry.configId = option.id;
          if (!optionValues(option).includes(value)) throw new ValueError('No longer offered by the agent');
          if (option.currentValue !== value) await this.setConfig(option.id, value);
        }
        entry.ok = true;
      } catch (error) {
        entry.message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof RpcError) && !(error instanceof ValueError) && !(error instanceof TypeError)) {
          log.exception(error, 'Applying a start pick failed');
        }
      }
      this.pickResults.push(entry);
    }
    return this.pickResults;
  }

  /**
   * A quiet look at what a new session of this agent offers: initialize, session/new in this folder with no MCP servers, read the
   * reply, close the session when the agent can. Never signs in: an agent that needs sign-in simply has no list. The caller closes
   * the process. Returns the session/new reply (sessionId, modes, configOptions, ...).
   */
  async probeSettings(timeoutSeconds = 30): Promise<Json> {
    await this.initializeForDiscovery();
    const result = await this.request('session/new', { cwd: this.cwd, mcpServers: [] }, timeoutSeconds);
    if (!isDict(result)) throw new ValueError('The agent returned an invalid session response');
    withModelsOption(result); // the remembered lists (agent-options.json) keep an agent's models list as its model option
    const sid = get(result, 'sessionId');
    const caps = sessionCapabilities(this.initial);
    if (isStr(sid) && sid && caps.ops.includes('close')) {
      try {
        await this.request('session/close', { sessionId: sid }, 5);
      } catch { /* the process is ended next anyway */ }
    }
    return result;
  }

  /** Initialize only (no session) so session/list can run in a short-lived process. */
  async initializeForDiscovery(): Promise<void> {
    this.initial = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'agent-studio',
        title: 'AIB',
        version: APP_VERSION,
      },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 45);
    if (
      !isDict(this.initial) || !pyEq(get(this.initial, 'protocolVersion'), 1)
    ) {
      throw new ValueError(
        'The agent did not negotiate supported ACP protocol version 1',
      );
    }
  }

  async listSessions(
    cwd: string | null = null,
    cursor: string | null = null,
  ): Promise<Json> {
    const capabilities = isDict(this.initial) ? get(this.initial, 'agentCapabilities', {}) : {};
    const sessionCaps = isDict(capabilities) ? get(capabilities, 'sessionCapabilities') : null;
    if (!isDict(sessionCaps) || get(sessionCaps, 'list') === null) {
      return { supported: false, sessions: [], nextCursor: null };
    }
    const params: Json = {};
    if (cwd) params.cwd = cwd;
    if (cursor) params.cursor = cursor;
    const result = await this.request('session/list', params, 60);
    const raw = isDict(result) ? get(result, 'sessions') : null;
    if (!Array.isArray(raw)) {
      throw new ValueError('The agent returned an invalid session list');
    }
    const sessions: Json[] = [];
    for (const item of raw.slice(0, 500)) {
      if (
        isDict(item) && isStr(item.sessionId) && item.sessionId &&
        pyLen(item.sessionId) <= 512 && isStr(item.cwd)
      ) {
        sessions.push({
          sessionId: item.sessionId,
          cwd: clip(item.cwd, 1024),
          title: isStr(item.title) ? clip(item.title, 300) : '',
          updatedAt: isStr(item.updatedAt) ? item.updatedAt : '',
        });
      }
    }
    const nextCursor = get(result as Json, 'nextCursor');
    return {
      supported: true,
      sessions,
      nextCursor: isStr(nextCursor) && nextCursor ? nextCursor : null,
    };
  }

  preparePrompt(
    text: unknown,
    clientMessageId: unknown,
    attachments: unknown,
  ): [ImageBlock[], Json[], FileSummary[], string] {
    if (!isStr(text) || pyLen(text) > 200000) {
      throw new ValueError('Prompt text must be at most 200,000 characters');
    }
    let imageBlocks: ImageBlock[] = [];
    let fileBlocks: Json[] = [];
    let fileSummaries: FileSummary[] = [];
    let fileFingerprints: Json[] = [];
    if (
      attachments !== null && attachments !== undefined &&
      !(Array.isArray(attachments) && attachments.length === 0)
    ) {
      const [imageItems, fileItems] = splitAttachments(attachments);
      let imageTotal = 0;
      if (imageItems.length) {
        if (!this.imageSupported) {
          throw new ValueError(
            'This agent does not advertise image prompt support',
          );
        }
        [imageBlocks, imageTotal] = validateImageAttachments(imageItems);
      }
      if (fileItems.length) {
        const [records, fileTotal] = validateFileAttachments(fileItems);
        if (imageTotal + fileTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new ValueError(
            `Attachments exceed the ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1048576)} MiB total limit`,
          );
        }
        [fileBlocks, fileSummaries] = mapFileAttachments(
          records,
          this.promptCaps,
        );
        fileFingerprints = records.map((r) => ({
          name: r.name,
          mimeType: r.mimeType,
          size: r.size,
          sha256: r.sha256,
        }));
      }
    }
    if (!pyStrip(text) && !imageBlocks.length && !fileBlocks.length) {
      throw new ValueError(
        'Enter a prompt or attach at least one image or file',
      );
    }
    if (
      clientMessageId !== null && clientMessageId !== undefined &&
      (!isStr(clientMessageId) || pyLen(clientMessageId) < 1 ||
        pyLen(clientMessageId) > 128)
    ) throw new ValueError('Invalid client message ID');
    let data: string;
    if (fileFingerprints.length) {
      data = sortedCompactJson([text, imageBlocks, fileFingerprints]);
    } else if (imageBlocks.length) {
      data = sortedCompactJson([text, imageBlocks]);
    } else data = text;
    const fingerprint = createHash('sha256').update(
      new TextEncoder().encode(data),
    ).digest('hex');
    return [imageBlocks, fileBlocks, fileSummaries, fingerprint];
  }

  async prompt(
    text: unknown,
    clientMessageId: string | null = null,
    attachments: unknown = null,
  ): Promise<Json> {
    const [imageBlocks, fileBlocks, fileSummaries, fingerprint] = this
      .preparePrompt(text, clientMessageId, attachments);
    let receipt = clientMessageId ? this.promptReceipts.get(clientMessageId) ?? null : null;
    if (!receipt && clientMessageId && this.recovery && this.sessionId) {
      receipt = this.recovery.receipt(this, clientMessageId);
    }
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new ValueError(
          'This client message ID was already used for different text',
        );
      }
      if (receipt.state === 'unknown') {
        throw new PromptStateUnknown(PROMPT_UNKNOWN);
      }
      // B3: a steer the agent did not take (promptRequired, or it failed) goes again as this prompt, with the same id.
      if (receipt.state !== 'steering') {
        return {
          accepted: true,
          duplicate: true,
          clientMessageId,
          turnState: receipt.state,
        };
      }
    }
    this.#refuseReadOnly();
    if (this.closed || !this.ready || !this.sessionId) {
      throw new ValueError('This connection is not ready');
    }
    // A cycle Claude Code started on its own does not refuse a prompt: the prompt's turn takes the cycle over, as the adapter does.
    if (this.busy && !this.autonomous) {
      throw new ValueError(
        'Wait for the current turn, or interrupt it before sending another prompt',
      );
    }
    const seq = this.#startTurn(clientMessageId, fingerprint);
    if (this.onUserPrompt) {
      try {
        this.onUserPrompt(this, text, clientMessageId);
      } catch (error) {
        log.exception(error, 'on_user_prompt hook failed');
      }
    }
    await this.#drainPending(); // changes still queued from a finished turn go first; a failure is reported but never drops this prompt
    const userEvent: Json = {
      text,
      attachments: imageBlocks,
      sessionId: this.sessionId,
      clientMessageId,
    };
    if (fileSummaries.length) userEvent.files = fileSummaries; // names, types, sizes and a bounded text preview; never the full content
    this.event('user', userEvent);
    this.turn = this.#runTurn(
      seq,
      text as string,
      fileBlocks,
      imageBlocks,
      clientMessageId,
      { receipt: clientMessageId, fingerprint, text, files: fileSummaries },
    );
    return {
      accepted: true,
      duplicate: false,
      clientMessageId,
      turnState: 'working',
    };
  }

  /** The turn begins: busy, and the receipt is "working". Shared by prompt() and a turn rebuilt from the keeper's record. */
  #startTurn(clientMessageId: string | null, fingerprint: string): number {
    this.busy = true;
    this.autonomous = false; // a prompt sent while Claude Code ran a cycle of its own takes that cycle over
    this.#turnHelpers.clear();
    this.#steerTurn = { injected: 0, outputAfter: false, unread: [] };
    this.#clearSettle();
    this.#promptOut.clear();
    this.#noteTurnProcesses();
    this.turnStartedAt = now();
    this.error = '';
    this.promptSeq += 1;
    const seq = this.promptSeq;
    if (clientMessageId) {
      this.promptReceipts.set(clientMessageId, {
        fingerprint,
        state: 'working',
      });
      while (this.promptReceipts.size > 1000) {
        this.promptReceipts.delete(this.promptReceipts.keys().next().value!);
      }
      this.#receiptChanged(clientMessageId);
    }
    return seq;
  }

  async #runTurn(
    seq: number,
    text: string,
    fileBlocks: Json[],
    imageBlocks: ImageBlock[],
    clientMessageId: string | null,
    receipt: Json | null,
    replayed: { entry: Pending; id: unknown } | null = null,
  ): Promise<void> {
    try {
      const context = replayed ? null : await this.#studioContext();
      const blocks = [
        ...(context ? [{ type: 'text', text: context[0] }] : []),
        ...(pyStrip(text) ? [{ type: 'text', text }] : []),
        ...fileBlocks,
        ...imageBlocks,
      ];
      let result: unknown;
      if (replayed) { // the old AIB sent it: wait for its response, from the record or live
        const promptReceipt = clientMessageId ? this.promptReceipts.get(clientMessageId) : undefined;
        if (promptReceipt) promptReceipt.sent = true; // the agent has it already (a deliberate stop records it as delivered)
        this.#promptOut.set();
        result = await this.#untilReplyEnds(seq, this.#awaitReplayed(replayed.entry, replayed.id));
      } else if (this.cancelSeq >= seq) { // cancelled while the hook above was still working: the agent never had this turn
        this.#promptOut.set();
        result = { stopReason: 'cancelled' };
      } else {
        // (not `receipt`: that is the keeper's receipt note for this turn, below)
        const promptReceipt = clientMessageId ? this.promptReceipts.get(clientMessageId) : undefined;
        if (promptReceipt) promptReceipt.sent = true;
        const response = this.request('session/prompt', {
          sessionId: this.sessionId,
          prompt: blocks,
        }, 86400, {
          // keeper: the receipt note goes first, so a later AIB rebuilds the page's message and receipt; the key stops a resend
          note: (id) => receipt ? { t: 'receipt', rpc: id, ...receipt } : null,
          once: clientMessageId ? `prompt:${clientMessageId}` : undefined,
        });
        this.#promptOut.set(); // written: a steer from now on reaches this turn
        result = await this.#untilReplyEnds(seq, response);
        await this.#studioContextSent(context);
      }
      this.#clearSettle();
      this.turnEndedAt = this.#now();
      this.#backgroundOpenTools(seq);
      if (!(isDict(result) && result.stopReason === 'cancelled')) this.#steerUnread();
      this.#queueNoteOutcome(result, false);
      this.event('turn_end', result);
      const hook = this.onTurnEnd;
      // A turn that ended before a rebuild had its hooks run by the AIB that saw it end.
      if (hook && !this.#replaying && !(isDict(result) && result.stopReason === 'cancelled')) {
        try {
          await hook(this);
        } catch (error) {
          log.exception(error, 'on_turn_end hook failed');
        }
      }
      if (clientMessageId) {
        const receipt = this.promptReceipts.get(clientMessageId);
        if (receipt) receipt.state = 'finished';
        this.#receiptChanged(clientMessageId);
      }
    } catch (error) {
      log.exception(error, 'Prompt turn failed');
      const data = isDict(error) || error instanceof Error ? (error as { data?: unknown }).data : null;
      if (isDict(data) && isDict(data.subscriptionQuota)) {
        this.onLimits?.(this, 'qwen-quota', data.subscriptionQuota, this.#now()); // Qwen: the cap is reached
      }
      this.error = errorText(error);
      this.#queueNoteOutcome(null, true);
      this.event('error', { message: errorText(error) });
      if (clientMessageId) {
        const receipt = this.promptReceipts.get(clientMessageId);
        if (receipt) receipt.state = 'error';
        this.#receiptChanged(clientMessageId);
      }
    } finally {
      this.#promptOut.set();
      this.#clearSettle();
      this.withdrawTurnRequests();
      await this.#finishTurn();
      await this.#queueAfterTurn();
      if (!this.#replaying) this.#scheduleSnapshot(); // quiet now (or skipped when the queue started the next turn)
    }
  }

  /**
   * The prompt's response, or `{stopReason: 'end_turn'}` as soon as its reply ended while Claude Code holds the response for
   * background helpers the turn started (see #watchHeldTurn). The held response still comes later, when the helpers finish or the
   * next prompt arrives; by then this turn is over, so it changes nothing (a cycle Claude Code ran inside the held turn ends with it).
   */
  async #untilReplyEnds(seq: number, response: Promise<unknown>): Promise<unknown> {
    let fire: () => void = () => {};
    const ended = new Promise<typeof HELD>((resolve) => (fire = () => resolve(HELD)));
    const early = { seq, fire };
    this.#endEarly = early;
    try {
      const first = await Promise.race([response, ended]);
      if (first !== HELD) return first;
    } finally {
      if (this.#endEarly === early) this.#endEarly = null;
    }
    response.then(
      () => {
        if (this.autonomous) void this.#endAutonomous('end_turn');
        else if (!this.busy && !this.#replaying) this.#scheduleSnapshot(); // the last request in flight is answered now
      },
      (error) => log.warning('The held response of an ended turn failed: %s', errorText(error)),
    );
    return { stopReason: 'end_turn' };
  }

  /** [text, token] of the note to put in front of this prompt (kept out of the user event and the fingerprint), or null. */
  async #studioContext(): Promise<[string, unknown] | null> {
    const start = this.onTurnStart;
    const provider = this.contextForPrompt;
    if (start) {
      try {
        await start(this);
      } catch (error) {
        log.exception(error, 'on_turn_start hook failed');
      }
    }
    if (!provider) return null;
    try {
      const context = await provider(this);
      return pyTruthy(context) ? context as [string, unknown] : null;
    } catch (error) {
      log.exception(error, 'The note for the prompt could not be made');
      return null;
    }
  }

  async #studioContextSent(context: [string, unknown] | null): Promise<void> {
    const done = this.contextSent;
    if (context && done) {
      try {
        await done(this, context[1]);
      } catch (error) {
        log.exception(error, 'Clearing the sent note failed');
      }
    }
  }

  // ---- settings changes: applied now between turns, queued during a turn -----------------------
  static changeKey(kind: string, configId: unknown = null): string {
    return kind === 'mode' ? 'mode' : `config:${pyStr(configId)}`;
  }

  /** Validated session/set_config_option, applied now. */
  async setConfig(configId: unknown, value: unknown): Promise<void> {
    const params = buildConfigRequest(this.settings, configId, value);
    if (isModelsOption(this.settings, configId)) { // an agent's models list: session/set_model (unstable_setSessionModel)
      await this.request('session/set_model', { sessionId: this.sessionId, modelId: value });
      this.#modelSet(value);
      return;
    }
    const result = await this.request('session/set_config_option', {
      ...params,
      sessionId: this.sessionId,
    });
    if (!isDict(result)) {
      throw new TypeError(`'${pyTypeName(result)}' object is not iterable`);
    }
    Object.assign(this.settings, result);
  }

  /** The model the agent took through session/set_model: its models reply and the model option AIB made from it. */
  #modelSet(modelId: unknown): void {
    if (!isStr(modelId)) return;
    if (isDict(this.settings.models)) (this.settings.models as Json).currentModelId = modelId;
    withModelsOption(this.settings);
  }

  /** Validated session/set_mode, applied now. */
  async setMode(modeId: unknown): Promise<void> {
    checkMode(this.settings, modeId);
    await this.request('session/set_mode', {
      sessionId: this.sessionId,
      modeId,
    });
    this.#modes().currentModeId = modeId;
  }

  /**
   * A mode/config change from the UI. Idle: applied now (errors raise). Mid-turn: validated, then queued as the one pending value
   * for that setting (last choice wins; picking the current value withdraws it) and applied in order when the turn ends, before
   * the next prompt is accepted.
   */
  async changeSetting(
    kind: unknown,
    configId: unknown,
    value: unknown,
  ): Promise<Json> {
    if (kind !== 'mode' && kind !== 'config') {
      throw new ValueError('Unknown setting kind');
    }
    this.#refuseReadOnly();
    if (this.closed || !this.ready || !this.sessionId) {
      throw new ValueError('This connection is not ready');
    }
    if (kind === 'mode') checkMode(this.settings, value);
    else buildConfigRequest(this.settings, configId, value);
    const key = Connection.changeKey(kind, configId);
    if (this.busy) {
      this.pendingChanges.delete(key);
      if (!pyEq(currentValue(this.settings, kind, configId), value)) {
        this.pendingChanges.set(key, {
          key,
          kind,
          configId: kind === 'config' ? configId : null,
          value,
          queuedAt: now(),
        });
      }
      return {
        queued: this.pendingChanges.has(key),
        pendingChanges: this.pendingList(),
      };
    }
    await this.#drainPending(); // leftovers from an earlier turn keep their order ahead of this change
    if (kind === 'mode') await this.setMode(value);
    else await this.setConfig(configId, value);
    return { queued: false, pendingChanges: this.pendingList() };
  }

  cancelPending(key: unknown): Json[] {
    if (!isStr(key) || !this.pendingChanges.delete(key)) {
      throw new ValueError('That change is no longer queued');
    }
    return this.pendingList();
  }

  pendingList(): Json[] {
    return [...this.pendingChanges.values()].map((v) => ({ ...v }));
  }

  async #applyPendingEntry(entry: PendingChange): Promise<void> {
    let error: string | null = null;
    try {
      if (
        !pyEq(
          currentValue(this.settings, entry.kind, entry.configId),
          entry.value,
        )
      ) {
        if (entry.kind === 'mode') await this.setMode(entry.value);
        else await this.setConfig(entry.configId, entry.value);
      }
    } catch (caught) {
      log.warning(
        'Applying a queued setting change failed: %s',
        errorText(caught),
      );
      error = errorText(caught) || errorName(caught);
    }
    if (this.pendingChanges.get(entry.key) === entry) {
      this.pendingChanges.delete(entry.key); // a newer choice made meanwhile stays queued
    }
    if (error) {
      this.changeSeq += 1;
      this.changeFailures.push({
        seq: this.changeSeq,
        key: entry.key,
        kind: entry.kind,
        configId: entry.configId,
        value: entry.value,
        message: clip(error, 500),
        time: now(),
      });
      this.changeFailures.splice(
        0,
        Math.max(0, this.changeFailures.length - 5),
      );
    }
  }

  /** Apply queued changes one by one, in the order chosen. A refused change is recorded in changeFailures and dropped. */
  async #drainPending(): Promise<void> {
    while (true) {
      if (this.closed || !this.ready) {
        this.pendingChanges.clear();
        return;
      }
      const entry = this.pendingChanges.values().next().value;
      if (entry === undefined) return;
      await this.#applyPendingEntry(entry);
    }
  }

  /** The turn is over: apply what was queued, then (and only when nothing new was queued meanwhile) accept prompts again. */
  async #finishTurn(): Promise<void> {
    try {
      await this.#drainPending();
    } catch (error) {
      log.exception(
        error,
        'Applying queued setting changes failed; dropping them',
      );
      this.pendingChanges.clear();
    } finally {
      while (true) {
        if (!this.pendingChanges.size) {
          this.busy = false;
          break;
        }
        try {
          await this.#drainPending();
        } catch (error) {
          log.exception(
            error,
            'Applying queued setting changes failed; dropping them',
          );
          this.pendingChanges.clear();
        }
      }
    }
  }

  // ---- queued messages: written while the agent works, sent one per turn when it ends ---------------------
  #queueChanged(): void {
    if (this.#replaying) return; // the saved queue is the old AIB's; a replay must not overwrite it
    const hook = this.recovery;
    if (hook && this.sessionId) {
      try {
        hook.queueChanged(this);
      } catch (error) {
        log.exception(error, 'Saving the message queue failed');
      }
    }
  }

  #knownReceipt(clientMessageId: string): Receipt | null {
    let receipt = this.promptReceipts.get(clientMessageId) ?? null;
    if (!receipt && this.recovery && this.sessionId) {
      receipt = this.recovery.receipt(this, clientMessageId);
    }
    return receipt;
  }

  queuePublic(light = false): Json {
    return this.queue.public(light);
  }

  /**
   * A chat rebuilt from the keeper: its saved queue goes on as it was (the turn never stopped), so it is not paused; messages sent
   * while it worked go back into the steer lane (a steer the old AIB sent takes its answer from the record, B4).
   */
  async queueContinue(saved: SavedItem[] | unknown): Promise<void> {
    this.queue.load(saved, '', true);
    void this.#steerPump(); // not awaited: a steer the old AIB sent may still wait for the agent's answer
    await this.#queuePump();
  }

  /** After a host restart: the saved queue comes back PAUSED; nothing is sent until the user resumes. */
  queueRestore(saved: SavedItem[] | unknown): void {
    this.queue.load(saved, 'restart');
  }

  /** Same payload as prompt(). A message that arrives while the agent is idle and nothing waits ahead of it is sent right away. */
  async queueAdd(
    text: unknown,
    clientMessageId: string | null = null,
    attachments: unknown = null,
  ): Promise<Json> {
    this.#refuseReadOnly();
    const [, , , fingerprint] = this.preparePrompt(
      text,
      clientMessageId,
      attachments,
    );
    if (this.closed || !this.ready || !this.sessionId) {
      throw new ValueError('This connection is not ready');
    }
    const itemId = clientMessageId || crypto.randomUUID().replaceAll('-', '');
    const receipt = clientMessageId ? this.#knownReceipt(itemId) : null;
    const queued = this.queue.find(itemId) ??
      (this.queue.inflight && this.queue.inflight.id === itemId ? this.queue.inflight : null);
    const known = receipt ?? queued;
    if (known) {
      if (
        (receipt ? receipt.fingerprint : (known as QueueItem).fingerprint) !==
          fingerprint
      ) {
        throw new ValueError(
          'This client message ID was already used for different text',
        );
      }
      if (receipt && receipt.state === 'unknown') {
        throw new PromptStateUnknown(PROMPT_UNKNOWN);
      }
      return {
        accepted: true,
        duplicate: true,
        queued: queued !== null,
        clientMessageId: itemId,
        turnState: receipt ? receipt.state : 'queued',
        queue: this.queue.public(),
      };
    }
    this.queue.add(
      itemId,
      text as string,
      pyTruthy(attachments) ? attachments as unknown[] : [],
      fingerprint,
    );
    this.#queueChanged();
    await this.#queuePump();
    const has = this.queue.has(itemId);
    return {
      accepted: true,
      duplicate: false,
      queued: has,
      clientMessageId: itemId,
      turnState: has ? 'queued' : 'working',
      queue: this.queue.public(),
    };
  }

  // ---- messages sent while the agent works: the steer lane (steer-on-send) ----------------------------------------------------
  /** `_meta.steering.supported` of the initialize result (top level, where the three adapters put it, or under agentCapabilities). */
  steeringSupported(): boolean {
    const initial = isDict(this.initial) ? this.initial : {};
    const caps = get(initial, 'agentCapabilities');
    for (const holder of [get(initial, '_meta'), isDict(caps) ? get(caps, '_meta') : null]) {
      const steering = isDict(holder) ? get(holder, 'steering') : null;
      if (isDict(steering) && steering.supported === true) return true;
    }
    return false;
  }

  /** What the composer keys on (snapshot `steerable`): a prompt turn of ours runs and the agent can read a message during it. */
  steerable(): boolean {
    return this.busy && !this.autonomous && this.ready && !this.closed && !this.rebuildError && this.steeringSupported();
  }

  /** A slash command the agent offers (or /doc): never sent into a running turn, it waits for the turn to end (B17). */
  #isAgentCommand(text: unknown): boolean {
    if (!isStr(text)) return false;
    const m = /^\/(\S+)/.exec(pyStrip(text));
    if (!m) return false;
    return m[1] === 'doc' || this.breadth.commands.some((c) => c.name === m[1]);
  }

  /**
   * Send now (POST /api/live/steer; Enter in the composer, a typed inbox or phone reply). Same payload as prompt(). AIB decides:
   *   idle (or Claude Code's own cycle)        an ordinary prompt                                   state 'prompted'
   *   working, the agent can steer             `_session/steering` now, through the steer lane      'injected' / 'sending' / 'fallback'
   *   working, an approval or question open    held until it is answered (owner decision 5)        'held'
   *   working, no steering, or a slash command  the after-turn queue, as today                       'queued'
   * Retrying the same clientMessageId never sends twice.
   */
  async steer(text: unknown, clientMessageId: string | null = null, attachments: unknown = null): Promise<Json> {
    this.#refuseReadOnly();
    const [, , , fingerprint] = this.preparePrompt(text, clientMessageId, attachments);
    if (this.closed || !this.ready || !this.sessionId) throw new ValueError('This connection is not ready');
    const id = clientMessageId || crypto.randomUUID().replaceAll('-', '');
    const q = this.queue;
    const inLane = q.findSteer(id);
    const queued = q.find(id) ?? (q.inflight && q.inflight.id === id ? q.inflight : null);
    const receipt = clientMessageId ? this.#knownReceipt(id) : null;
    if (inLane || queued || receipt) {
      const known = inLane ? inLane.fingerprint : queued ? queued.fingerprint : receipt!.fingerprint;
      if (known !== fingerprint) throw new ValueError('This client message ID was already used for different text');
      if (!inLane && !queued && receipt!.state === 'unknown') throw new PromptStateUnknown(PROMPT_UNKNOWN);
      return this.#steerAnswer(id, true);
    }
    const working = this.busy && !this.autonomous;
    if (working && (this.#isAgentCommand(text) || !this.steeringSupported())) {
      await this.queueAdd(text, id, attachments);
      return this.#steerAnswer(id, false);
    }
    if (!working && !q.steer.length) {
      await this.prompt(text, id, attachments);
      return this.#steerAnswer(id, false);
    }
    if (q.steer.length >= 50) throw new ValueError('At most 50 messages can wait to be sent');
    q.steer.push({
      id,
      text: text as string,
      attachments: pyTruthy(attachments) ? attachments as unknown[] : [],
      fingerprint,
      queuedAt: Date.now() / 1000,
      state: 'sending',
      heldReason: '',
    });
    this.#queueChanged();
    await this.#steerPump();
    return this.#steerAnswer(id, false);
  }

  /** The steer route's answer: where message `id` is now (state, see steer()), with the lanes. */
  #steerAnswer(id: string, duplicate: boolean): Json {
    const q = this.queue;
    const inLane = q.findSteer(id);
    const receipt = this.#knownReceipt(id);
    let state: string;
    if (inLane) state = inLane.state;
    else if (q.find(id) || (q.inflight && q.inflight.id === id)) state = 'queued';
    else if (receipt?.state === 'injected') state = 'injected';
    else state = 'prompted';
    return {
      accepted: true,
      duplicate,
      clientMessageId: id,
      id,
      state,
      turnState: receipt ? receipt.state : state === 'queued' ? 'queued' : 'working',
      steerLane: q.steerPublic(),
      queue: q.public(),
    };
  }

  /** Run the steer lane: one item at a time, in order. Concurrent calls join the running pass (which then looks once more). */
  #steerPump(): Promise<void> {
    if (this.#steerRun) {
      this.#steerAgain = true;
      return this.#steerRun;
    }
    const run = (async () => {
      try {
        do {
          this.#steerAgain = false;
          await this.#steerLane();
        } while (this.#steerAgain);
      } catch (error) {
        log.exception(error, 'Sending a message to the running turn failed');
      } finally {
        this.#steerRun = null;
      }
    })();
    this.#steerRun = run;
    return run;
  }

  async #steerLane(): Promise<void> {
    const q = this.queue;
    while (true) {
      if (this.#replaying || this.rebuildError || this.closed || !this.ready || !this.sessionId) return;
      const head = q.steer[0];
      if (!head) return;
      if (!this.busy || this.autonomous) {
        // Idle (or Claude Code's own cycle, which a prompt takes over): the first goes as an ordinary prompt and the rest are steered
        // into its turn (B9). A helper's open card does not hold it: the main agent is idle (owner, 2026-11-12).
        q.steer.shift();
        if (head.state === 'fallback') {
          // The agent said it did not take it (promptRequired): safe to send, even when a restart left its receipt "unknown".
          this.promptReceipts.set(head.id, { fingerprint: String(head.fingerprint), state: 'steering' });
        }
        try {
          await this.prompt(head.text, head.id, head.attachments.length ? head.attachments : null);
        } catch (error) {
          const unknown = error instanceof PromptStateUnknown;
          if (!unknown) log.warning('Sending a held message failed: %s', errorText(error));
          this.#steerToQueue([head], unknown ? STEER_RESTART_NOTE : clip(errorText(error), 300), unknown ? 'unknown' : 'error');
        }
        this.#queueChanged();
        continue;
      }
      if (head.state === 'fallback') return; // B2: the agent's turn is over; it goes as a prompt once AIB has finished that turn
      if (this.permissions.size || this.elicitations.size) {
        // Owner decision 5 (B8): never steered while an approval or question is open (OMP would cancel the card). Released by any
        // close of the last card (#cardsChanged), and by the turn's end (#queueAfterTurn).
        let changed = false;
        for (const item of q.steer) {
          if (item.state === 'sending') {
            item.state = 'held';
            item.heldReason = 'approval';
            changed = true;
          }
        }
        if (changed) this.#queueChanged();
        return;
      }
      if (!this.steeringSupported()) { // cannot happen for a chat that took a steer; kept safe: they wait for the turn to end
        const all = q.steer;
        q.steer = [];
        this.#steerToQueue(all, '');
        this.#queueChanged();
        return;
      }
      if (!this.#promptOut.isSet()) { // the prompt that started this turn is not written yet: a steer now would find no turn
        await this.#promptOut.wait(30000);
        continue;
      }
      let changed = false;
      for (const item of q.steer) {
        if (item.state === 'held') {
          item.state = 'sending';
          item.heldReason = '';
          changed = true;
        }
      }
      if (changed) this.#queueChanged();
      const seq = this.promptSeq;
      this.#steerInflight = head;
      let outcome: string;
      try {
        const replayed = this.#replayedSteers.get(head.id);
        this.#replayedSteers.delete(head.id);
        outcome = replayed
          ? ((await within(replayed, steerTiming.steerTimeoutSeconds * 1000)) || 'failed')
          : await this.#sendSteer(head);
      } finally {
        this.#steerInflight = null;
      }
      const index = q.steer.indexOf(head);
      if (index >= 0) {
        if (outcome === 'injected') q.steer.splice(index, 1);
        else if (outcome === 'promptRequired' && this.cancelSeq < seq) head.state = 'fallback';
        else if (outcome === 'promptRequired') { // the user interrupted meanwhile: it waits with the others, paused
          q.steer.splice(index, 1);
          this.#steerToQueue([head], '', 'interrupted');
        } else {
          q.steer.splice(index, 1);
          this.#steerToQueue([head], STEER_FAILED_NOTE);
        }
      }
      this.#queueChanged();
    }
  }

  /**
   * One `_session/steering` (always with idleBehavior promptRequired: without it Claude Code starts a turn AIB never asked for,
   * recording C3). Carries the <studio-context> note like a prompt (B12; no turn-start hook: no turn starts). Returns 'injected',
   * 'promptRequired' or 'failed'. In the keeper the steer note goes first and the once-key stops a resend (B4).
   */
  async #sendSteer(item: SteerItem): Promise<string> {
    let images: ImageBlock[];
    let fileBlocks: Json[];
    let files: FileSummary[];
    try {
      [images, fileBlocks, files] = this.preparePrompt(item.text, null, item.attachments.length ? item.attachments : null);
    } catch (error) {
      log.warning('A held message can no longer be sent: %s', errorText(error));
      return 'failed';
    }
    let context: [string, unknown] | null = null;
    const provider = this.contextForPrompt;
    if (provider) {
      try {
        const made = await provider(this);
        context = pyTruthy(made) ? made as [string, unknown] : null;
      } catch (error) {
        log.exception(error, 'The note for the prompt could not be made');
      }
    }
    if (this.onUserPrompt) {
      try {
        this.onUserPrompt(this, item.text, item.id);
      } catch (error) {
        log.exception(error, 'on_user_prompt hook failed');
      }
    }
    const blocks = [
      ...(context ? [{ type: 'text', text: context[0] }] : []),
      ...(pyStrip(item.text) ? [{ type: 'text', text: item.text }] : []),
      ...fileBlocks,
      ...images,
    ];
    this.promptReceipts.set(item.id, { fingerprint: String(item.fingerprint), state: 'steering' });
    while (this.promptReceipts.size > 1000) this.promptReceipts.delete(this.promptReceipts.keys().next().value!);
    this.#receiptChanged(item.id);
    // The request may answer after the lane gave up on it (steerTimeoutSeconds): the late answer is still read (#steerLateAnswer).
    const answer: Promise<{ result?: unknown; error?: unknown }> = this.request('_session/steering', {
      sessionId: this.sessionId,
      prompt: blocks,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    }, steerTiming.steerLateSeconds, {
      note: (rpc) => ({ t: 'steer', rpc, receipt: item.id, text: item.text, files, fingerprint: item.fingerprint }),
      once: `steer:${item.id}`,
    }).then((result) => ({ result }), (error) => ({ error }));
    const first = await within(answer, steerTiming.steerTimeoutSeconds * 1000);
    if (first === false) {
      log.warning('chat %s: the agent did not answer a message sent while it works within %s s', this.id, steerTiming.steerTimeoutSeconds);
      this.#steerLateAnswer(item, answer, images, files, context);
      return 'failed';
    }
    if (Object.hasOwn(first, 'error')) {
      log.warning('The agent did not take a message sent while it works: %s', errorText(first.error));
      return 'failed';
    }
    const outcome = isDict(first.result) ? first.result.outcome : null;
    if (outcome === 'injected' || outcome === 'startedNewTurn') {
      if (outcome === 'startedNewTurn') log.warning('chat %s: the agent started a turn of its own for a steer', this.id);
      this.#steerLanded(item.id, item.text, images, files, String(item.fingerprint), item);
      void this.#studioContextSent(context);
      return 'injected';
    }
    if (outcome === 'promptRequired') return 'promptRequired';
    log.warning('chat %s: a steer came back %s', this.id, pyRepr(outcome));
    return 'failed';
  }

  /**
   * A steer that timed out goes to the after-turn queue with its id (#steerLane), but stays unsent there (#queuePump) until its answer
   * comes: taken (injected) → it leaves the queue and shows as sent while working, as if it had answered in time; anything else (not
   * taken, an error, steerLateSeconds with no answer) → it is free to go after the turn, with the same id.
   */
  #steerLateAnswer(
    item: SteerItem,
    answer: Promise<{ result?: unknown; error?: unknown }>,
    images: ImageBlock[],
    files: FileSummary[],
    context: [string, unknown] | null,
  ): void {
    this.#steerLate.add(item.id);
    void answer.then((late) => {
      this.#steerLate.delete(item.id);
      const outcome = !Object.hasOwn(late, 'error') && isDict(late.result) ? late.result.outcome : null;
      if ((outcome === 'injected' || outcome === 'startedNewTurn') && !this.closed) {
        const q = this.queue;
        const at = q.items.findIndex((i) => i.id === item.id);
        if (at >= 0) q.items.splice(at, 1);
        log.info('chat %s: the agent took message %s late; it is not sent again', this.id, item.id);
        this.#steerLanded(item.id, item.text, images, files, String(item.fingerprint), item);
        void this.#studioContextSent(context);
      } else {
        log.info('chat %s: the late answer to message %s: not taken (%s)', this.id, item.id, pyRepr(outcome));
      }
      this.#queueChanged();
      void this.#queuePump();
    });
  }

  /**
   * The agent took a steered message: it shows as the user's bubble (no adapter echoes it), tagged `steered` ("Sent while working"),
   * and its receipt is final. Live and on a keeper rebuild alike, right where the answer is in the record.
   */
  #steerLanded(id: string, text: string, images: ImageBlock[], files: FileSummary[], fingerprint: string, item?: SteerItem): void {
    const receipt = this.promptReceipts.get(id);
    if (receipt) receipt.state = 'injected';
    else this.promptReceipts.set(id, { fingerprint, state: 'injected' });
    this.promptReceipts.get(id)!.sent = true;
    this.#receiptChanged(id);
    const userEvent: Json = { text, attachments: images, sessionId: this.sessionId, clientMessageId: id, steered: true };
    if (files.length) userEvent.files = files;
    this.event('user', userEvent);
    if (!this.busy || this.autonomous) return;
    this.#steerTurn.injected += 1;
    this.#steerTurn.outputAfter = false;
    this.#clearSettle();
    if (item && this.provider === 'codex') this.#steerTurn.unread.push(item);
  }

  /**
   * B13: codex-acp v1 can drop a steer that lands as its turn completes. A steer with no main-session output after it by the turn's
   * end goes back in the queue, paused, with a note (a new id, so Resume really sends it again).
   */
  #steerUnread(): void {
    const unread = this.#steerTurn.unread;
    this.#steerTurn.unread = [];
    if (!unread.length) return;
    const q = this.queue;
    q.items.unshift(...unread.map((i) => ({
      id: crypto.randomUUID().replaceAll('-', ''),
      text: i.text,
      attachments: i.attachments,
      fingerprint: i.fingerprint,
      queuedAt: Date.now() / 1000,
      lease: null,
      note: CODEX_UNREAD_NOTE,
    })));
    q.hold = 'unknown';
    this.#queueChanged();
  }

  /** Steer-lane items into the after-turn queue, at its front (after an item being sent now), in order. */
  #steerToQueue(items: SteerItem[], note: string, hold = ''): void {
    if (!items.length) return;
    const q = this.queue;
    const at = q.sendNow ? Math.min(1, q.items.length) : 0;
    q.items.splice(at, 0, ...items.map((i) => ({
      id: i.id,
      text: i.text,
      attachments: i.attachments,
      fingerprint: i.fingerprint,
      queuedAt: i.queuedAt,
      lease: null,
      note,
    })));
    if (hold && !q.sendNow && !q.hold) q.hold = hold;
  }

  /** Interrupt (B8): what waits in the steer lane moves to the after-turn queue, paused; a steer in flight is decided by its answer. */
  #laneInterrupted(): void {
    const q = this.queue;
    const inflight = this.#steerInflight && q.steer.includes(this.#steerInflight) ? this.#steerInflight : null;
    const moved = q.steer.filter((i) => i !== inflight);
    if (!moved.length) return;
    q.steer = inflight ? [inflight] : [];
    this.#steerToQueue(moved, '', 'interrupted');
    this.#queueChanged();
  }

  /** An approval or question was answered or withdrawn: with none open, messages held for it go now (B8). */
  #cardsChanged(): void {
    if (!this.queue.steer.length || this.permissions.size || this.elicitations.size) return;
    void this.#steerPump();
  }

  /**
   * Edit lease on a queued message: acquire (open the editor), renew (editor still open), save (new text, releases), cancel
   * (releases). While the lease is held the message is never sent; if it is the first one, nothing is sent at all.
   */
  async queueEdit(
    itemId: string,
    action: unknown,
    leaseId: string | null = null,
    text: unknown = null,
  ): Promise<Json> {
    if (!['acquire', 'renew', 'save', 'cancel'].includes(action as string)) {
      throw new ValueError('Unknown edit action');
    }
    const q = this.queue;
    if (action === 'acquire') {
      const item = q.acquire(itemId, leaseId);
      return {
        ok: true,
        leaseId: item.lease!.id,
        text: item.text,
        queue: q.public(),
      };
    }
    if (action === 'renew') {
      q.renew(itemId, leaseId);
      return { ok: true, queue: q.public() };
    }
    if (action === 'cancel') {
      q.release(itemId, leaseId);
    } else {
      const item = q.find(itemId); // MessageQueue._leased
      if (item === null) {
        throw new ValueError(
          'That message is no longer queued (it may already have been sent)',
        );
      }
      if (!item.lease || item.lease.id !== leaseId) {
        throw new ValueError('This edit is no longer open');
      }
      if (!isStr(text)) throw new ValueError('Message text is required');
      const [, , , fingerprint] = this.preparePrompt(
        text,
        null,
        item.attachments,
      );
      item.text = text;
      item.fingerprint = fingerprint;
      item.note = '';
      q.release(itemId, leaseId);
    }
    this.#queueChanged();
    await this.#queuePump();
    return { ok: true, queue: this.queuePublic() };
  }

  async queueRemove(itemId: string): Promise<Json> {
    if (this.queue.inflight && this.queue.inflight.id === itemId) {
      throw new ValueError('That message is already being sent');
    }
    this.queue.remove(itemId);
    this.#queueChanged();
    await this.#queuePump();
    return { ok: true, queue: this.queuePublic() };
  }

  async queueMove(itemId: string, toIndex: unknown): Promise<Json> {
    this.queue.move(itemId, toIndex);
    this.#queueChanged();
    await this.#queuePump();
    return { ok: true, queue: this.queuePublic() };
  }

  async queueResume(): Promise<Json> {
    this.queue.resume();
    this.#queueChanged();
    await this.#queuePump();
    return { ok: true, queue: this.queuePublic() };
  }

  /** Interrupt the running turn and send this message first. Refused while its editor is open. */
  async queueSendNow(itemId: string): Promise<Json> {
    const q = this.queue;
    const item = q.find(itemId);
    if (item === null) {
      throw new ValueError(
        'That message is no longer queued (it may already have been sent)',
      );
    }
    if (q.leaseActive(item)) {
      throw new ValueError('Save or cancel the edit first');
    }
    q.move(itemId, 0);
    item.lease = null;
    q.hold = '';
    const interrupt = this.busy;
    q.sendNow = interrupt;
    this.#queueChanged();
    if (interrupt) {
      this.cancel();
      if (!this.busy) this.queue.sendNow = false; // the turn ended on its own meanwhile
    }
    await this.#queuePump();
    return { ok: true, queue: this.queuePublic() };
  }

  /** A turn just ended: decide whether the queue must wait for the user. Runs before the turn's own requests are withdrawn. */
  #queueNoteOutcome(result: unknown, failed: boolean): void {
    const q = this.queue;
    if (q.sendNow || !q.items.length || q.hold) return;
    const needs = this.permissions.size + this.elicitations.size +
      (this.auth ? 1 : 0);
    if (failed) q.hold = 'error';
    else if (needs) q.hold = 'needs_you';
    else if (isDict(result) && result.stopReason === 'cancelled' && this.cancelSeq >= this.promptSeq) {
      // B14: only the user's own Interrupt pauses the queue; a 'cancelled' the agent reports on its own (after a steer) does not.
      q.hold = 'interrupted';
    }
  }

  async #queueAfterTurn(): Promise<void> {
    if (this.queue.sendNow) {
      this.queue.sendNow = false;
      this.queue.hold = '';
    }
    this.#queueChanged();
    await this.#steerPump(); // the steer lane first: a message the agent could not take mid-turn goes now, as a prompt
    await this.#queuePump();
  }

  /** Send the first waiting message if nothing stops it: idle, no hold, no edit lease on it, nobody waiting on the user. */
  async #queuePump(): Promise<void> {
    while (true) {
      if (this.#replaying || this.rebuildError) return;
      const q = this.queue;
      if (
        this.closed || !this.ready || this.busy || !this.sessionId ||
        q.inflight || !q.items.length || q.pauseReason() || q.steer.length // the steer lane goes first
      ) return;
      if (this.permissions.size || this.elicitations.size || this.auth) return;
      if (this.#steerLate.has(q.items[0].id)) return; // its steer may still land (#steerLateAnswer), which then pumps again
      const item = q.items.shift()!;
      q.inflight = item;
      let failure: [string, string] | null = null;
      let result: Json | null = null;
      try {
        // receipts make a retry of the same id harmless
        result = await this.prompt(
          item.text,
          item.id,
          pyTruthy(item.attachments) ? item.attachments : null,
        );
      } catch (error) {
        if (error instanceof PromptStateUnknown) {
          failure = [
            'unknown',
            'AIB cannot tell whether this one was already sent. Remove it, or press Resume to send it again.',
          ];
        } else {
          log.warning('Sending a queued message failed: %s', errorText(error));
          failure = [
            errorText(error).includes('Wait for the current turn') ? '' : 'error',
            clip(errorText(error), 300),
          ];
        }
      }
      q.inflight = null;
      if (failure) {
        item.note = failure[0] ? failure[1] : '';
        q.items.unshift(item);
        if (failure[0]) q.hold = failure[0];
      }
      this.#queueChanged();
      if (failure || !(result ?? {}).duplicate || this.busy) return;
    }
  }

  #staleError(key: unknown, what: string): ValueError {
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

  #noteWithdrawn(
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

  #replyQuietly(rpcId: unknown, result: Json): void {
    try {
      this.write({ jsonrpc: '2.0', id: rpcId, result });
    } catch (error) {
      if (!isOsOrValueError(error)) throw error;
    }
  }

  #receiptChanged(clientMessageId: string): void {
    const hook = this.recovery;
    const found = this.promptReceipts.get(clientMessageId);
    if (hook && found) hook.receiptChanged(this, clientMessageId, { ...found });
  }

  /**
   * {systemPrompt: ...} that tells the agent about Studio's artifact tool, or {} when this chat has no such tool or the agent does
   * not advertise client system prompts (ACP unstable `systemPrompt`; appended after the agent's own).
   */
  artifactPrompt(servers: unknown[] | null): Json {
    if (!(servers ?? []).some(isOwnArtifactEntry)) return {};
    const out: Json = {};
    const caps = isDict(this.initial) ? get(pyTruthy(this.initial) ? this.initial : {}, 'agentCapabilities') : null;
    const sessionCaps = isDict(caps) ? get(caps, 'sessionCapabilities') : null;
    // Presence is support (ACP capability objects): codex-acp advertises `systemPrompt: {}`, which a truthiness test missed.
    if (isDict(sessionCaps) && isDict(get(sessionCaps, 'systemPrompt'))) {
      const content: Json[] = [{ type: 'text', text: ARTIFACT_PROMPT }];
      const worktree = this.worktree;
      if (worktree) { // only a chat that works in its own worktree (the merge tool comes with it)
        content.push({
          type: 'text',
          text: WORKTREE_PROMPT.replace('{branch}', worktree.branch ?? '')
            .replaceAll('{base}', worktree.base || 'the project branch'),
        });
      }
      out.systemPrompt = { mode: 'append', content };
    }
    return out;
  }

  /** True when a permission request is for Studio's studio_artifact tool on a chat Studio gave that tool to. */
  ownArtifactTool(params: unknown): boolean {
    if (!(this.mcpServers ?? []).some(isOwnArtifactEntry)) return false;
    const call = isDict(params) ? get(params, 'toolCall') : null;
    if (!isDict(call)) return false;
    const meta = isDict(call._meta) ? call._meta : {};
    const claude = isDict(meta.claudeCode) ? meta.claudeCode : {};
    let name: unknown = get(claude, 'toolName');
    if (!pyTruthy(name)) name = get(call, 'name');
    if (!pyTruthy(name)) name = get(call, 'title');
    if (!pyTruthy(name)) name = '';
    return isStr(name) && OWN_ARTIFACT_TOOL.test(name);
  }

  permission(key: unknown, option: unknown): void {
    this.#refuseReadOnly();
    const pending = isStr(key) ? this.permissions.get(key) : undefined;
    if (!pending) throw this.#staleError(key, 'approval');
    const options = get(pending.params, 'options', []);
    if (
      option !== null && option !== undefined &&
      !(options as unknown[]).map((o) => pget(o, 'optionId')).some((id) => pyEq(id, option))
    ) {
      throw new ValueError('Unknown approval option');
    }
    const outcome = option === null || option === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option };
    this.write({ jsonrpc: '2.0', id: pending.rpcId, result: { outcome } });
    this.permissions.delete(key as string);
    this.#cardsChanged();
    // A background helper of Claude Code asks between turns: once answered, a message queued meanwhile can go.
    if (!this.busy && this.#claudeHolds()) void this.#queuePump();
  }

  receiveElicitation(rpcId: unknown, params: unknown): void {
    if (
      !isDict(params) ||
      !['form', 'url'].includes(get(params, 'mode') as string)
    ) {
      throw new ValueError('Only form and url elicitation modes are supported');
    }
    const sid = get(params, 'sessionId');
    const requestId = get(params, 'requestId');
    const idOk = (value: unknown) => isStr(value) || isInt(value);
    if (sid !== null) {
      if (!isStr(sid) || !this.knownSessions.has(sid)) {
        throw new ValueError('Elicitation references an unknown session');
      }
      if (requestId !== null) {
        throw new ValueError(
          'Session-scoped elicitation cannot include requestId',
        );
      }
    } else if (requestId === null || !idOk(requestId)) {
      throw new ValueError(
        'Request-scoped elicitation requires a string or integer requestId',
      );
    }
    if (requestId !== null && !idOk(requestId)) {
      throw new ValueError('Invalid elicitation requestId');
    }
    if (
      get(params, 'toolCallId') !== null &&
      (sid === null || !isStr(params.toolCallId))
    ) {
      throw new ValueError('toolCallId requires a session-scoped request');
    }
    if (
      !isStr(get(params, 'message')) || pyLen(params.message as string) > 10000
    ) {
      throw new ValueError(
        'Elicitation message must be a string of at most 10000 characters',
      );
    }
    if (params.mode === 'url') validateUrlRequest(params);
    else validateSchema(get(params, 'requestedSchema'));
    const key = tokenUrlsafe(18);
    if (this.elicitations.size >= 100) {
      throw new ValueError('Too many pending elicitation requests');
    }
    if (
      params.mode === 'url' &&
      [...this.elicitations.values()].some((p) => pyEq(get(p.params, 'elicitationId'), params.elicitationId))
    ) {
      throw new ValueError(
        'A request with this elicitationId is already pending',
      );
    }
    this.elicitations.set(key, { rpcId, params });
    this.event('elicitation', { key, params });
  }

  answerElicitation(
    key: unknown,
    action: unknown,
    content: unknown = null,
  ): void {
    if (!['accept', 'decline', 'cancel'].includes(action as string)) {
      throw new ValueError('Action must be accept, decline, or cancel');
    }
    this.#refuseReadOnly();
    const pending = isStr(key) ? this.elicitations.get(key) : undefined;
    if (!pending) throw this.#staleError(key, 'request');
    const result: Json = { action };
    if (action === 'accept' && get(pending.params, 'mode') === 'url') {
      // the person confirmed they completed the out-of-band interaction
    } else if (action === 'accept') {
      if (!Object.hasOwn(pending.params, 'requestedSchema')) {
        const error = new Error("'requestedSchema'");
        error.name = 'KeyError';
        throw error;
      }
      result.content = validateContent(
        pending.params.requestedSchema,
        content ?? {},
      );
    }
    this.write({ jsonrpc: '2.0', id: pending.rpcId, result });
    this.elicitations.delete(key as string);
    this.#cardsChanged();
    if (this.ready && !this.busy && this.#claudeHolds()) void this.#queuePump(); // as permission() does
    if (action !== 'accept' && !this.ready && !this.closed) {
      const what = get(pending.params, 'mode') === 'form' ? 'a question' : 'a link request';
      const said = clip(pyStr(get(pending.params, 'message', '')), 120);
      this.abortSetup(
        `You ${
          action === 'decline' ? 'declined' : 'cancelled'
        } ${what} while the conversation was opening ("${said}"), so it was not opened.`,
      );
    }
  }

  /** elicitation/complete: the agent says an out-of-band URL interaction finished. */
  completeElicitation(params: unknown): void {
    const eid = isDict(params) ? get(params, 'elicitationId') : null;
    if (!isStr(eid)) return;
    for (const [key, item] of [...this.elicitations]) {
      if (
        get(item.params, 'mode') === 'url' &&
        get(item.params, 'elicitationId') === eid
      ) {
        this.#replyQuietly(item.rpcId, { action: 'accept' });
        this.elicitations.delete(key);
        this.#noteWithdrawn(
          key,
          'elicitation',
          'The agent reported this request complete.',
          get(item.params, 'sessionId'),
        );
      }
    }
    this.#cardsChanged();
  }

  /** Withdraw UI for an agent-originated RPC; IDs are direction-specific. */
  cancelIncomingRequest(requestId: unknown): void {
    if (!isStr(requestId) && !isInt(requestId)) return;
    const reason = 'The agent cancelled this request.';
    this.#clearPermissions({ rpcId: requestId, reason });
    this.#clearElicitations({ rpcId: requestId, reason });
    this.#cardsChanged();
  }

  #clearPermissions(
    {
      sessionId = null,
      rpcId = null,
      reason = 'The session ended.',
      scoped = false,
      everything = false,
      except = null,
    }: {
      sessionId?: unknown;
      rpcId?: unknown;
      reason?: string;
      scoped?: boolean;
      everything?: boolean;
      except?: ((sessionId: unknown) => boolean) | null;
    },
  ): void {
    for (const [key, item] of [...this.permissions]) {
      const sid = isDict(item.params) ? get(item.params, 'sessionId') : null;
      if (except?.(sid)) continue;
      const rpcMatch = rpcId !== null && typeof item.rpcId === typeof rpcId &&
        item.rpcId === rpcId;
      if (
        everything || rpcMatch ||
        (sessionId !== null && (sid === sessionId || sid === null)) ||
        (scoped && sid !== null)
      ) {
        this.#replyQuietly(item.rpcId, { outcome: { outcome: 'cancelled' } });
        this.permissions.delete(key);
        this.#noteWithdrawn(key, 'permission', reason, sid);
      }
    }
  }

  #clearElicitations(
    {
      sessionId = null,
      requestId = null,
      rpcId = null,
      reason = 'The session ended.',
      scoped = false,
      except = null,
    }: {
      sessionId?: unknown;
      requestId?: unknown;
      rpcId?: unknown;
      reason?: string;
      scoped?: boolean;
      except?: ((sessionId: unknown) => boolean) | null;
    },
  ): void {
    const everything = sessionId === null && requestId === null &&
      rpcId === null && !scoped;
    for (const [key, item] of [...this.elicitations]) {
      const params = item.params;
      if (except?.(get(params, 'sessionId'))) continue;
      const rpcMatch = rpcId !== null && typeof item.rpcId === typeof rpcId &&
        item.rpcId === rpcId;
      const ownRequest = get(params, 'requestId');
      const requestMatch = requestId !== null &&
        typeof ownRequest === typeof requestId && ownRequest === requestId;
      const sid = get(params, 'sessionId');
      if (
        everything || rpcMatch || requestMatch ||
        (sessionId !== null && sid === sessionId) || (scoped && sid !== null)
      ) {
        this.#replyQuietly(item.rpcId, { action: 'cancel' });
        this.elicitations.delete(key);
        this.#noteWithdrawn(key, 'elicitation', reason, sid);
      }
    }
  }

  /** The turn that raised these requests is over; nothing may answer them any more. */
  withdrawTurnRequests(): void {
    const reason = 'The turn that asked for this has ended.';
    this.#clearPermissions({ sessionId: this.sessionId, reason });
    this.#clearElicitations({ sessionId: this.sessionId, reason });
  }

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

  cancel(subagent: unknown = null): void {
    this.#refuseReadOnly();
    if (subagent !== null && subagent !== undefined) {
      return this.cancelSubagent(subagent);
    }
    // ACP prompt-turn cancellation: answer every pending permission request with the `cancelled` outcome FIRST (recorded as
    // withdrawn), then notify session/cancel; the agent ends the turn with stopReason `cancelled`.
    this.cancelSeq = this.promptSeq;
    if (this.busy && !this.autonomous) this.#laneInterrupted();
    // B7: a helper still running in the background from an earlier turn goes on, so its approval stays open; everything else this
    // turn asked (the main session's, a helper the turn waits for) is answered cancelled, as before.
    const background = (sid: unknown) => isStr(sid) && sid !== this.sessionId && this.#liveHelpers.has(sid) && !this.#turnHelpers.has(sid);
    this.#clearPermissions({
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
    this.#clearElicitations({
      scoped: true,
      except: background,
      reason: 'The turn was cancelled.',
    });
    if (this.autonomous) void this.#endAutonomous('cancelled'); // stopped: its result may never come
  }

  async #waitExit(ms: number): Promise<boolean> {
    if (!this.#exited) return true;
    return (await within(this.#exited.then(() => true), ms)) === true;
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    let stop = false;
    try {
      for (const key of [...this.permissions.keys()]) {
        if (!this.rebuildError) this.permission(key, null);
      }
      this.#clearElicitations({});
      if (this.busy && !this.rebuildError) this.cancel();
      if (this.channel !== null) {
        if (this.rebuildError) await this.channel.claim().catch(() => 0); // read-only until now: take it over to stop it
        this.#stdinClosed = true;
        void this.channel.closeStdin(); // ACP adapters exit on it, as on a closed pipe
        if (!(await this.#waitExit(5000))) stop = true;
      } else if (this.process !== null) {
        this.#stdinClosed = true;
        this.#stdin?.close().catch(() => {});
        if (!(await this.#waitExit(5000))) stop = true;
      }
    } catch (error) {
      if (!isOsError(error) && !(error instanceof ValueError)) throw error;
      stop = true;
    }
    if (stop && this.process !== null) {
      try {
        this.process.kill('SIGTERM');
      } catch { /* already gone */ }
      await this.#waitExit(3000);
    }
    // The adapter had its chance to exit cleanly; now take down whatever it left running (claude CLI, MCP servers, ...).
    if (this.process !== null) {
      this.tree!.kill();
      await this.#waitExit(3000);
    }
    if (this.channel) void this.channel.remove(); // closed by the person: its record is not needed any more
    this.closed = true;
    if (this.closedAt === null) this.closedAt = now();
    this.ready = false;
    await this.#shutdownCaps();
    this.releaseLease();
    if (this.recovery) this.recovery.connectionClosed(this);
    if (this.process !== null) {
      await within(this.#readTask!, 2000);
      await within(this.#errorTask!, 2000);
      // A pipe still open after all that (a grandchild outside the job kept it): stop reading it so nothing leaks.
      for (const reader of [this.#stdoutReader, this.#stderrReader]) {
        try {
          await reader?.cancel();
        } catch { /* released: read to the end */ }
      }
    }
  }

  /** Cheap summary for the sidebar, status line and notifications. needs_you wins over working. */
  attention(): Json {
    const needs = this.permissions.size + this.elicitations.size +
      (this.auth ? 1 : 0); // includes subagent requests
    const state = this.closed ? 'closed' : needs ? 'needs_you' : !this.ready ? 'opening' : this.busy ? 'working' : 'idle';
    const iso = (t: number | null) => t ? new Date(Math.floor(t) * 1000).toISOString().slice(0, 19) + 'Z' : null;
    const started = this.busy && !this.closed ? this.turnStartedAt : null;
    return {
      state,
      needs: state === 'closed' ? 0 : needs,
      turnEndedAt: iso(this.turnEndedAt),
      busySince: iso(started),
    };
  }

  /** Wire form of this connection. light=true is the sidebar listing: no events and no permission bodies. */
  public(after = 0, light = false): Json {
    const events = this.events;
    // Being rebuilt from the keeper's record: no events yet, and the page keeps its cursor (the rebuilt chat numbers them the same).
    const rebuilding = this.#replaying && !this.rebuildError && !this.closed;
    // A cursor past the end belongs to another numbering (an older record without its Studio events): send everything again.
    const stale = !rebuilding && after > this.sequence;
    const data: Json = {
      attention: this.attention(),
      id: this.id,
      provider: this.provider,
      cwd: this.cwd,
      projectRoot: this.projectRoot,
      sessionId: this.sessionId,
      busy: this.busy,
      closed: this.closed,
      error: this.error,
      settings: this.settings,
      queue: this.queue.public(light),
      // Steer-on-send: the composer keys on `steerable` alone; steerAgent picks the page's hint copy; the lane of messages sent
      // while the agent works; background tool rows ({toolCallId: {state, stoppable}}).
      steerable: this.steerable(),
      // Claude Code's own follow-up cycle (busy, but no turn of ours): the composer stays the plain Send, as before steer-on-send (T27)
      autonomous: this.busy && this.autonomous,
      steerAgent: STEER_AGENTS.has(this.provider) ? this.provider : null,
      steerLane: this.queue.steerPublic(light),
      toolBackground: this.toolBackground(),
      pendingChanges: [...this.pendingChanges.values()].map((v) => ({ ...v })),
      changeFailures: this.changeFailures.map((v) => ({ ...v })),
      state: this.closed
        ? 'closed'
        : this.elicitations.size || this.permissions.size || this.auth
        ? 'input_needed'
        : !this.ready
        ? 'opening'
        : this.busy
        ? 'working'
        : 'ready',
      ready: !!(this.ready && !this.closed),
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
    return data;
  }

  /** Messages that were mid-send when Studio last restarted and are still unresolved (see state_store). */
  unknownReceipts(): unknown[] {
    const store = this.recovery?.store ?? null;
    return store && this.sessionId ? store.unknownReceipts(this.provider, this.sessionId) : [];
  }
}
