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
import { ClientCaps, type FsMode } from './client_caps.ts';
import {
  applyUpdate,
  augmentInitialize,
  type BreadthState,
  buildConfigRequest,
  checkMode,
  currentValue,
  type McpServer,
  newState,
  publicState,
  selectMcpServers,
  sessionCapabilities,
} from './breadth.ts';
import { validateContent, validateSchema, validateUrlRequest } from './elicitation.ts';
import { MessageQueue, type QueueItem, type SavedItem } from './msgqueue.ts';
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
import { artifactToolCommand } from '../artifacts/mcp.ts';
import { isOwnMcpUrl } from '../artifacts/mcp_http.ts';
import { ProcessTree, treeSpawnOptions } from '../platform/process_tree.ts';
import { projectOfWorktree } from '../worktrees/worktrees.ts';
import { APP_VERSION, TESTS_DIR } from '../core/app.ts';
import { getLogger } from '../core/log.ts';
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

type Hook = (connection: Connection) => unknown;

export interface ConnectionOptions {
  enableTerminal?: boolean;
  enableFs?: FsMode;
  /** Extra variables for an agent the user added in Settings. */
  env?: Record<string, string> | null;
  /** false: the chat's worktree is still being made; startProcess() runs once its folder exists. */
  start?: boolean;
  capsFactory?: CapsFactory;
}

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

// ---- the connection -----------------------------------------------------------------------------------------------------------

export const ARTIFACT_PROMPT =
  'You are running inside Agent Studio, which shows artifacts beside the chat; when the user says "artifact" they ' +
  'mean this viewer and its studio_artifact tool. When you make something the user ' +
  'should look at rather than source code (an HTML page, report, chart, diagram, SVG, Markdown document or image), ' +
  "save its file under the project's outputs/ folder (for example outputs/report.html), never in the project root " +
  'or among source files, then publish it with the studio_artifact publish tool (pass a file path or the content) and mention it in your reply ' +
  'as the Markdown link the tool returns. When you change it, use the studio_artifact update tool so it gets a new ' +
  'version, and do not tell the user to open the file by hand. Only publish to claude.ai (or any other web ' +
  'artifact or sharing service) when the user explicitly asks for a claude.ai page or a shareable link.';

export const WORKTREE_PROMPT =
  'In this chat you work in your own copy of the project, on the git branch {branch} (it started from {base}). ' +
  'When you finish a piece of work, ask the user whether to merge it into the project. Merge only after they say yes, ' +
  'by calling the merge_into_project tool. Never merge on your own.';

/** Python's re.match with `$`: also matches before one trailing newline. */
export const OWN_ARTIFACT_TOOL = /^mcp__studio_artifact__(?:publish|update|list|merge_into_project|resolve_edit_clash)\n?$/;

const PROMPT_UNKNOWN = 'This message was being sent when Studio stopped, so Studio cannot tell whether the agent received it. ' +
  'Check the conversation. If it is missing, press Send again.';

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
  const own = artifactToolCommand();
  return entry.command === own.command && args.length === own.args.length && args.every((a, i) => a === own.args[i]);
}

export class Connection {
  readonly id = crypto.randomUUID().replaceAll('-', '');
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
  closed = false;
  initial: unknown = {};
  imageSupported = false;
  promptCaps: Record<string, boolean> = {
    image: false,
    audio: false,
    embeddedContext: false,
  };
  settings: Json = {};
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
  /** Studio hook: withdraw the owner announcement when the conversation stops. */
  onRelease: Hook | null = null;
  /** The agent's last stderr lines (at most 30, each at most 2000 characters). */
  stderr: string[] = [];
  caps: ClientCapsLike;
  openDone = new ThreadEvent();
  readonly command: string[];
  readonly env: Record<string, string> | null;
  closedAt: number | null = null;
  process: Deno.ChildProcess | null = null;
  tree: ProcessTree | null = null;
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
    // command is always a list (never a shell string).
    this.command = command;
    this.env = options.env ?? null;
    if (options.start ?? true) this.startProcess();
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

  /** Returncode once the agent exited (Popen.poll()). */
  poll(): number | null {
    return this.exitCode;
  }

  event(kind: string, data: unknown): void {
    this.sequence += 1;
    const item: Json = { seq: this.sequence, kind, data, time: now() };
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

  /** One JSON-RPC message to the agent. Writes go out in call order; throws when the agent's stdin is known to be gone. */
  write(message: unknown): void {
    const writer = this.#stdin;
    if (writer === null || this.#stdinClosed) {
      throw new ValueError('I/O operation on closed file.');
    }
    if (this.#stdinBroken) throw new BrokenPipeError('[Errno 32] Broken pipe');
    writer.write(ENCODER.encode(JSON.stringify(message) + '\n')).catch(() => {
      this.#stdinBroken = true;
    });
  }

  async request(
    method: string,
    params: unknown,
    timeout = 30,
  ): Promise<unknown> {
    if (method === 'initialize') params = augmentInitialize(params as Json);
    this.counter += 1;
    const key = this.counter;
    const entry: Pending = { done: new ThreadEvent(), method, params };
    this.pending.set(key, entry);
    try {
      this.write({ jsonrpc: '2.0', id: key, method, params });
      if (!(await entry.done.wait(timeout * 1000))) {
        throw new TimeoutError(
          `${method} did not respond within ${timeout} seconds`,
        );
      }
      const result = entry.response!;
      if (Object.hasOwn(result, 'error')) {
        const error = result.error;
        throw new RuntimeError(
          pyStr(
            isDict(error) && Object.hasOwn(error, 'message') ? error.message : error,
          ),
        );
      }
      return Object.hasOwn(result, 'result') ? result.result : {};
    } finally {
      this.pending.delete(key);
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
        // A bug in one of our handlers must not leave a half-working connection behind: say what happened, then stop the agent.
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
        failure =
          `Studio hit an internal error while reading from the agent (${name}: ${message}). The connection was closed; reconnect to continue.`;
        this.error = failure;
        try {
          this.tree?.kill();
        } catch (killError) {
          log.exception(killError, 'Killing the agent process tree failed');
        }
        try {
          await reader.cancel();
        } catch { /* already gone */ }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch { /* a read is still pending (close() cancels it) */ }
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
        const answered = this.caps.dispatch(message);
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
        applyUpdate(this.breadth, update, now());
      }
      if (get(update, 'sessionUpdate') === 'config_option_update') {
        this.settings.configOptions = get(update, 'configOptions', []);
      }
      if (get(update, 'sessionUpdate') === 'current_mode_update') {
        this.#modes().currentModeId = get(update, 'currentModeId');
      }
      this.writes.observe(params);
      this.event('update', params);
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
          await this.setupRequest('authenticate', { methodId }, 120);
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
          'This sign-in must be completed outside Studio. Follow the instructions shown, then choose Retry.',
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
    this.ready = false;
    if (resume) this.knownSessions.add(resume);
    this.initial = await this.setupRequest('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'agent-studio',
        title: 'Agent Studio',
        version: APP_VERSION,
      },
      clientCapabilities: {
        ...this.caps.capabilities(),
        subagents: {},
        elicitation: { form: {}, url: {} },
      },
    }, 45);
    this.#checkSetupAbort();
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
      this.sessionId = isDict(result) ? get(result, 'sessionId') as string | null : null;
    }
    if (!isDict(result) || !isStr(this.sessionId) || !this.sessionId) {
      throw new ValueError('The agent returned an invalid session response');
    }
    Object.assign(this.settings, result);
    this.knownSessions.add(this.sessionId);
    this.ready = true;
    this.event('connected', {
      sessionId: this.sessionId,
      provider: this.provider,
    });
  }

  /** Initialize only (no session) so session/list can run in a short-lived process. */
  async initializeForDiscovery(): Promise<void> {
    this.initial = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'agent-studio',
        title: 'Agent Studio',
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
      return {
        accepted: true,
        duplicate: true,
        clientMessageId,
        turnState: receipt.state,
      };
    }
    if (this.closed || !this.ready || !this.sessionId) {
      throw new ValueError('This connection is not ready');
    }
    if (this.busy) {
      throw new ValueError(
        'Wait for the current turn, or interrupt it before sending another prompt',
      );
    }
    this.busy = true;
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
    );
    return {
      accepted: true,
      duplicate: false,
      clientMessageId,
      turnState: 'working',
    };
  }

  async #runTurn(
    seq: number,
    text: string,
    fileBlocks: Json[],
    imageBlocks: ImageBlock[],
    clientMessageId: string | null,
  ): Promise<void> {
    try {
      const context = await this.#studioContext();
      const blocks = [
        ...(context ? [{ type: 'text', text: context[0] }] : []),
        ...(pyStrip(text) ? [{ type: 'text', text }] : []),
        ...fileBlocks,
        ...imageBlocks,
      ];
      let result: unknown;
      if (this.cancelSeq >= seq) { // cancelled while the hook above was still working: the agent never had this turn
        result = { stopReason: 'cancelled' };
      } else {
        const receipt = clientMessageId ? this.promptReceipts.get(clientMessageId) : undefined;
        if (receipt) receipt.sent = true;
        result = await this.request('session/prompt', {
          sessionId: this.sessionId,
          prompt: blocks,
        }, 86400);
        await this.#studioContextSent(context);
      }
      this.turnEndedAt = now();
      this.#queueNoteOutcome(result, false);
      this.event('turn_end', result);
      const hook = this.onTurnEnd;
      if (hook && !(isDict(result) && result.stopReason === 'cancelled')) {
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
      this.error = errorText(error);
      this.#queueNoteOutcome(null, true);
      this.event('error', { message: errorText(error) });
      if (clientMessageId) {
        const receipt = this.promptReceipts.get(clientMessageId);
        if (receipt) receipt.state = 'error';
        this.#receiptChanged(clientMessageId);
      }
    } finally {
      this.withdrawTurnRequests();
      await this.#finishTurn();
      await this.#queueAfterTurn();
    }
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
    const result = await this.request('session/set_config_option', {
      ...params,
      sessionId: this.sessionId,
    });
    if (!isDict(result)) {
      throw new TypeError(`'${pyTypeName(result)}' object is not iterable`);
    }
    Object.assign(this.settings, result);
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
    else if (isDict(result) && result.stopReason === 'cancelled') {
      q.hold = 'interrupted';
    }
  }

  async #queueAfterTurn(): Promise<void> {
    if (this.queue.sendNow) {
      this.queue.sendNow = false;
      this.queue.hold = '';
    }
    this.#queueChanged();
    await this.#queuePump();
  }

  /** Send the first waiting message if nothing stops it: idle, no hold, no edit lease on it, nobody waiting on the user. */
  async #queuePump(): Promise<void> {
    while (true) {
      const q = this.queue;
      if (
        this.closed || !this.ready || this.busy || !this.sessionId ||
        q.inflight || !q.items.length || q.pauseReason()
      ) return;
      if (this.permissions.size || this.elicitations.size || this.auth) return;
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
            'Studio cannot tell whether this one was already sent. Remove it, or press Resume to send it again.',
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
    if (isDict(sessionCaps) && pyTruthy(get(sessionCaps, 'systemPrompt'))) {
      const content: Json[] = [{ type: 'text', text: ARTIFACT_PROMPT }];
      const worktree = this.worktree;
      if (worktree) { // only a chat that works in its own worktree (the merge tool comes with it)
        content.push({
          type: 'text',
          text: WORKTREE_PROMPT.replace('{branch}', worktree.branch ?? '')
            .replace('{base}', worktree.base || 'the project branch'),
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
  }

  /** Withdraw UI for an agent-originated RPC; IDs are direction-specific. */
  cancelIncomingRequest(requestId: unknown): void {
    if (!isStr(requestId) && !isInt(requestId)) return;
    const reason = 'The agent cancelled this request.';
    this.#clearPermissions({ rpcId: requestId, reason });
    this.#clearElicitations({ rpcId: requestId, reason });
  }

  #clearPermissions(
    {
      sessionId = null,
      rpcId = null,
      reason = 'The session ended.',
      scoped = false,
      everything = false,
    }: {
      sessionId?: unknown;
      rpcId?: unknown;
      reason?: string;
      scoped?: boolean;
      everything?: boolean;
    },
  ): void {
    for (const [key, item] of [...this.permissions]) {
      const sid = isDict(item.params) ? get(item.params, 'sessionId') : null;
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
    }: {
      sessionId?: unknown;
      requestId?: unknown;
      rpcId?: unknown;
      reason?: string;
      scoped?: boolean;
    },
  ): void {
    const everything = sessionId === null && requestId === null &&
      rpcId === null && !scoped;
    for (const [key, item] of [...this.elicitations]) {
      const params = item.params;
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
    if (subagent !== null && subagent !== undefined) {
      return this.cancelSubagent(subagent);
    }
    // ACP prompt-turn cancellation: answer every pending permission request with the `cancelled` outcome FIRST (recorded as
    // withdrawn), then notify session/cancel; the agent ends the turn with stopReason `cancelled`.
    this.cancelSeq = this.promptSeq;
    this.#clearPermissions({
      everything: true,
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
      reason: 'The turn was cancelled.',
    });
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
        this.permission(key, null);
      }
      this.#clearElicitations({});
      if (this.busy) this.cancel();
      if (this.process !== null) {
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
    const ended = this.turnEndedAt;
    const stamp = ended ? new Date(Math.floor(ended) * 1000).toISOString().slice(0, 19) + 'Z' : null;
    return { state, needs: state === 'closed' ? 0 : needs, turnEndedAt: stamp };
  }

  /** Wire form of this connection. light=true is the sidebar listing: no events and no permission bodies. */
  public(after = 0, light = false): Json {
    const events = this.events;
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
      events: light ? [] : events.filter((e) => (e.seq as number) > after),
      cursor: this.sequence,
      reset: !!(events.length && after && after < (events[0].seq as number) - 1),
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
    if (this.worktree) data.worktree = { ...this.worktree }; // only a worktree chat has this key; the page does not show it yet
    return data;
  }

  /** Messages that were mid-send when Studio last restarted and are still unresolved (see state_store). */
  unknownReceipts(): unknown[] {
    const store = this.recovery?.store ?? null;
    return store && this.sessionId ? store.unknownReceipts(this.provider, this.sessionId) : [];
  }
}
