/**
 * Terminal sessions: one shell per conversation. They outlive the page and the window (closing to the tray keeps them). With the
 * keeper (keeper_pty.ts; keeper 1.2.0 or later) the shell runs in the keeper: it outlives an AIB restart, crash or update, and the
 * next AIB takes it over (adoptKeeper: same process, its recent output replayed, PromptWatch rebuilt from the record); quitting AIB
 * ends it (endAll), an update leaves it running (releaseAll). Without the keeper (off, or one too old) the shell is a child of the web
 * server process and ends with it (on Windows the Job Object also ends it if AIB dies). Nothing typed or printed here goes to an agent.
 *
 * Wire protocol on the socket (GET /api/live/terminal, server/web/server.ts):
 *   server -> page   binary frames: shell output (UTF-8 with VT sequences)
 *                    text frames, JSON:
 *                      {type:'ready', key, id, cwd, shell, shellName, pid, startedAt, lastActivity, resumed}
 *                          attached; `resumed` = an existing shell, its recent output is replayed next
 *                      {type:'exit', code}                     the shell ended (the socket then closes)
 *                      {type:'error', code, message, ...}      not started (the socket then closes). code:
 *                          folder_missing {cwd}                the folder does not exist (never replaced by another one)
 *                          too_many {max, terminals}           the limit; `terminals` says which chats hold one (TerminalInfo)
 *                          spawn_failed {shellName}            the shell did not start; `message` says why
 *                          no_folder, bad_folder, bad_key, closing
 *                      {type:'busy', id, busy}                 answer to {type:'busy?'} (Pty.busy)
 *   page -> server   text frames, JSON:
 *                      {type:'input', data}                    keystrokes, as typed
 *                      {type:'paste', data}                    text to put at the prompt without running it (pasteInput)
 *                      {type:'resize', cols, rows}
 *                      {type:'busy?', id}                      is a command running? (the page asks before a paste)
 *
 * The socket's query: key, cwd, cols, rows, shell=windows-powershell to use Windows PowerShell instead of the default shell, and
 * resume=1 to attach only to a shell that already runs (the page reconnecting after AIB restarted): none gives {type:'error',
 * code:'gone'} and starts nothing.
 */
import { isNetworkPath } from '../web/security.ts';
import { clampSize, defaultShell, type Pty, type PtyOptions, type ShellSpec, spawnPty } from '../platform/pty.ts';
import type { WsLink } from '../platform/websocket.ts';
import { announce, getLogger } from '../core/log.ts';
import type { KeeperLink } from '../keeper/link.ts';
import { inputText, KeeperPty, parseTerminalLabel, TERMINAL_PREFIX, type TerminalLabel, terminalProblem } from './keeper_pty.ts';

const log = getLogger('terminal');

export const MAX_SESSIONS = 8;
/** Recent output kept per session and replayed to a page that attaches later (a reload, a second window). */
export const REPLAY_BYTES = 256 * 1024;

export class TerminalError extends Error {
  constructor(message: string, readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'TerminalError';
  }
}

export interface TerminalInfo {
  key: string;
  id: string;
  cwd: string;
  shell: string;
  shellName: string;
  pid: number;
  startedAt: number;
  /** Last output or input (ms since the epoch): "idle 1h" on the page. */
  lastActivity: number;
  clients: number;
}

/** The shell's name as people know it. */
export function shellName(file: string): string {
  const base = file.split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  if (base === 'pwsh') return 'PowerShell 7';
  if (base === 'powershell') return 'Windows PowerShell';
  if (base === 'cmd') return 'Command Prompt';
  return base;
}

/** Windows PowerShell (always present on Windows): the fallback the page offers when the default shell does not start. */
export function windowsPowerShell(env: { get(name: string): string | undefined } = Deno.env): ShellSpec {
  const root = env.get('SystemRoot') || env.get('windir') || 'C:\\Windows';
  return { file: `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ['-NoLogo'] };
}

/** A folder the page may start a shell in: absolute, local (no UNC or device path), an existing directory. */
export function checkCwd(cwd: unknown): string {
  const text = typeof cwd === 'string' ? cwd.trim() : '';
  if (!text) throw new TerminalError('This chat has no folder to open a terminal in.', 'no_folder');
  if (isNetworkPath(text)) throw new TerminalError('Network and device folders are not supported.', 'bad_folder');
  const absolute = Deno.build.os === 'windows' ? /^[A-Za-z]:[\\/]/.test(text) : text.startsWith('/');
  if (!absolute) throw new TerminalError('The chat folder is not an absolute path.', 'bad_folder');
  let dir = false;
  try {
    dir = Deno.statSync(text).isDirectory;
  } catch { /* missing */ }
  if (!dir) throw new TerminalError(`This chat's folder no longer exists: ${text}`, 'folder_missing', { cwd: text });
  return text;
}

const ESC = String.fromCharCode(27);
/** Shift+Enter as a win32-input-mode key press and release (ConPTY turns on that mode; PSReadLine reads it as AddLine). */
const SHIFT_ENTER = `${ESC}[13;28;13;1;16;1_${ESC}[13;28;13;0;16;1_`;

/**
 * What to write to the shell so `text` lands at its prompt and nothing runs: no trailing Enter, control characters removed (a pasted
 * escape sequence could end a bracketed paste early), tabs as spaces (a tab would complete). Several lines: on Windows each line break
 * is Shift+Enter (PowerShell adds a line without running; ConPTY drops bracketed-paste markers and would run each line); elsewhere a
 * bracketed paste (bash 5.1+, zsh: line breaks are inserted, not run).
 */
export function pasteInput(text: string, os: string = Deno.build.os): string {
  const lines = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '    ')
    // deno-lint-ignore no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\n+$/, '')
    .split('\n');
  if (lines.length === 1) return lines[0];
  if (os === 'windows') return lines.join(SHIFT_ENTER);
  return `${ESC}[200~${lines.join('\r')}${ESC}[201~`;
}

/**
 * Is a command running in a Windows shell? Pty.busy() sees the programs a command starts, but not a PowerShell cmdlet that runs inside
 * the shell itself (Start-Sleep, a long Get-ChildItem). So: once the shell has printed a prompt we recognise (`PS C:\x> ` for PowerShell,
 * `C:\x>` for cmd), Enter makes it busy until a prompt is again the last thing it printed. Conservative: a shell whose prompt was never
 * recognised (a custom prompt) is never called busy by this, only by Pty.busy().
 */
export class PromptWatch {
  #tail = '';
  #seen = false;
  #pending = false;
  #decoder = new TextDecoder();
  constructor(readonly enabled: boolean) {}

  static forShell(file: string): PromptWatch {
    return new PromptWatch(['PowerShell 7', 'Windows PowerShell', 'Command Prompt'].includes(shellName(file)));
  }

  output(bytes: Uint8Array): void {
    if (!this.enabled) return;
    this.#tail = (this.#tail + plainText(this.#decoder.decode(bytes, { stream: true }))).slice(-600);
    if (endsWithPrompt(this.#tail)) {
      this.#seen = true;
      this.#pending = false;
    }
  }

  input(text: string): void {
    if (!this.enabled || !text.includes('\r')) return;
    this.#pending = true;
    this.#tail = '';
  }

  get busy(): boolean {
    return this.enabled && this.#seen && this.#pending;
  }
}

/** Shell output as plain lines: a cursor move to a row starts a new line; other escape sequences and carriage returns go. */
function plainText(text: string): string {
  return text
    .replace(new RegExp(`${ESC}\\[[0-9;]*[Hf]`, 'g'), '\n')
    .replace(new RegExp(`${ESC}\\][^\\x07${ESC}]*(?:\\x07|${ESC}\\\\)`, 'g'), '')
    .replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${ESC}[@-_]`, 'g'), '')
    .replace(/\r/g, '');
}

/** The last line is a PowerShell (`PS C:\x> `) or cmd (`C:\x>`) prompt with nothing typed after it. */
export function endsWithPrompt(text: string): boolean {
  const line = text.replace(/\s+$/, '').split('\n').pop() ?? '';
  return /^PS .*>$/.test(line) || /^[A-Za-z]:\\[^<>|]*>$/.test(line);
}

export function checkKey(key: unknown): string {
  if (typeof key !== 'string' || !key.trim() || key.length > 300) throw new TerminalError('Unknown conversation.', 'bad_key');
  return key;
}

export class TerminalSession {
  readonly id: string;
  readonly startedAt: number;
  lastActivity = Date.now();
  readonly links = new Set<WsLink>();
  readonly prompt: PromptWatch;
  #replay: Uint8Array[] = [];
  #replaySize = 0;
  exitCode: number | null = null;
  #started = false;

  constructor(
    readonly key: string,
    readonly cwd: string,
    readonly shell: ShellSpec,
    readonly pty: Pty,
    onExit: (s: TerminalSession) => void,
    restored: { id: string; startedAt: number } | null = null,
  ) {
    this.id = restored?.id ?? crypto.randomUUID();
    this.startedAt = restored?.startedAt ?? Date.now();
    this.prompt = PromptWatch.forShell(shell.file);
    const keeper = pty instanceof KeeperPty ? pty : null;
    pty.onData = (bytes) => {
      this.lastActivity = keeper && !this.#started ? keeper.lastRecord || Date.now() : Date.now();
      this.prompt.output(bytes);
      this.#remember(bytes);
      for (const link of this.links) link.send(bytes);
    };
    if (keeper) {
      keeper.onInput = (bytes) => this.prompt.input(inputText(bytes)); // replayed typing: PromptWatch as it was before the restart
      void keeper.ready.then(() => (this.#started = true));
    } else this.#started = true;
    void pty.exited.then((code) => {
      this.exitCode = code;
      onExit(this);
      const message = JSON.stringify({ type: 'exit', code });
      for (const link of [...this.links]) {
        link.send(message);
        link.close(1000, 'shell ended');
      }
      this.links.clear();
    });
  }

  #remember(bytes: Uint8Array): void {
    this.#replay.push(bytes);
    this.#replaySize += bytes.length;
    while (this.#replaySize > REPLAY_BYTES && this.#replay.length > 1) this.#replaySize -= this.#replay.shift()!.length;
  }

  get info(): TerminalInfo {
    return {
      key: this.key,
      id: this.id,
      cwd: this.cwd,
      shell: this.shell.file,
      shellName: shellName(this.shell.file),
      pid: this.pty.pid,
      startedAt: this.startedAt,
      lastActivity: this.lastActivity,
      clients: this.links.size,
    };
  }

  /** Attach a page. `resumed` says whether the shell was already running (its recent output is sent first). */
  attach(link: WsLink, resumed: boolean): void {
    const keeper = this.pty instanceof KeeperPty ? this.pty : null;
    if (keeper && !this.#started) { // the keeper is still starting it, or replaying it after a restart: ready once it runs
      let gone = false;
      link.onclose = () => (gone = true);
      void keeper.ready.then(() => {
        this.#started = true;
        if (!gone) this.attach(link, resumed);
      });
      return;
    }
    if (keeper?.startError || this.exitCode !== null) {
      link.send(JSON.stringify({
        type: 'error',
        code: 'spawn_failed',
        shellName: shellName(this.shell.file),
        message: keeper?.startError || 'The shell ended.',
      }));
      link.close(1000, 'refused');
      return;
    }
    this.links.add(link);
    link.send(JSON.stringify({ type: 'ready', ...this.info, resumed }));
    for (const chunk of this.#replay) link.send(chunk);
    link.onmessage = (data) => this.#message(data);
    link.onclose = () => this.links.delete(link);
  }

  #message(data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      this.prompt.input(new TextDecoder().decode(data));
      this.pty.write(data);
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message?.type === 'input' && typeof message.data === 'string') {
      this.lastActivity = Date.now();
      this.prompt.input(message.data);
      this.pty.write(message.data);
    } else if (message?.type === 'paste' && typeof message.data === 'string') {
      this.lastActivity = Date.now();
      this.pty.write(pasteInput(message.data));
    } else if (message?.type === 'busy?') {
      let busy = false;
      try {
        busy = this.pty.busy();
      } catch { /* unknown: not busy */ }
      busy ||= this.prompt.busy;
      for (const link of this.links) link.send(JSON.stringify({ type: 'busy', id: message.id ?? null, busy }));
    } else if (message?.type === 'resize') {
      const { cols, rows } = clampSize(message.cols, message.rows);
      this.pty.resize(cols, rows);
    }
  }
}

export interface SessionsOptions {
  max?: number;
  spawn?: (options: PtyOptions) => Pty;
  shell?: () => ShellSpec;
  /** Run the shells in the keeper (main.ts, when the keeper is on): they outlive AIB. null: children of this process. */
  keeper?: KeeperLink | null;
}

export class TerminalSessions {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #max: number;
  readonly #spawn: (options: PtyOptions) => Pty;
  readonly #shell: () => ShellSpec;
  readonly keeper: KeeperLink | null;
  /** Why new shells run inside AIB although the keeper is on ('' = they go to the keeper, or it is off). */
  keeperProblem = '';
  #closed = false;

  constructor(options: SessionsOptions = {}) {
    this.#max = options.max ?? MAX_SESSIONS;
    this.#spawn = options.spawn ?? spawnPty;
    this.#shell = options.shell ?? (() => defaultShell());
    this.keeper = options.keeper ?? null;
  }

  get(key: string): TerminalSession | undefined {
    return this.#sessions.get(key);
  }

  list(): TerminalInfo[] {
    return [...this.#sessions.values()].map((s) => s.info);
  }

  get max(): number {
    return this.#max;
  }

  /**
   * The conversation's running shell, or a new one in `cwd`. Returns it and whether it was already running. `shell` is '' for the
   * default shell or 'windows-powershell'.
   */
  open(
    key: unknown,
    cwd: unknown,
    cols: unknown,
    rows: unknown,
    shellChoice: unknown = '',
    command: ShellSpec | null = null,
  ): { session: TerminalSession; resumed: boolean } {
    if (this.#closed) throw new TerminalError('AIB is closing.', 'closing');
    const k = checkKey(key);
    const running = this.#sessions.get(k);
    if (running) return { session: running, resumed: true };
    const folder = checkCwd(cwd);
    if (this.#sessions.size >= this.#max) {
      throw new TerminalError(`${this.#max} terminals are already open.`, 'too_many', { max: this.#max, terminals: this.list() });
    }
    // command: a program to run instead of a shell (a Beta agent's sign-in, server/web/terminal_routes.ts); it ends with that program.
    const shell = command ?? (shellChoice === 'windows-powershell' && Deno.build.os === 'windows' ? windowsPowerShell() : this.#shell());
    const size = clampSize(cols, rows);
    const options: PtyOptions = { file: shell.file, args: shell.args, cwd: folder, ...size, env: { AIB_TERMINAL: '1' } };
    let pty: Pty;
    let label: TerminalLabel | null = null;
    // A sign-in command stays inside AIB: it is short-lived and ends with the sign-in, so there is nothing to keep through a restart.
    if (this.keeper && !this.keeperProblem && !command) {
      label = { t: 'terminal', v: 1, key: k, id: crypto.randomUUID(), cwd: folder, shell, startedAt: Date.now() };
      const keeperPty = KeeperPty.spawn(this.keeper, options, label, (o) => this.#spawn(o));
      keeperPty.onFallback = (why) => this.#fellBack(why);
      pty = keeperPty;
    } else {
      try {
        pty = this.#spawn(options);
      } catch (error) {
        throw new TerminalError(`${shell.file}: ${(error as Error).message}`, 'spawn_failed', { shellName: shellName(shell.file) });
      }
    }
    const session = this.#add(k, folder, shell, pty, label);
    return { session, resumed: false };
  }

  #add(key: string, cwd: string, shell: ShellSpec, pty: Pty, label: TerminalLabel | null): TerminalSession {
    const session = new TerminalSession(key, cwd, shell, pty, (s) => {
      if (this.#sessions.get(s.key) === s) this.#sessions.delete(s.key);
    }, label ? { id: label.id, startedAt: label.startedAt } : null);
    this.#sessions.set(key, session);
    if (pty instanceof KeeperPty) pty.start();
    return session;
  }

  /** The keeper could not take a shell (too old, refused): this and later shells run inside AIB; logged once. */
  #fellBack(why: string): void {
    if (this.keeperProblem) return;
    this.keeperProblem = why || 'the keeper could not start it';
    announce('terminal', 'keeper: terminals run inside AIB (%s); they end when AIB restarts', this.keeperProblem);
  }

  /**
   * At start: take over the shells an earlier AIB left running in the keeper (a restart, a crash, an update). Each is found by its
   * label, replayed (its recent output and PromptWatch state come back) and claimed; the page attaches to it like to any running
   * shell. An ended terminal channel (its shell ended while no AIB was there) is removed. Returns how many were taken over.
   */
  async adoptKeeper(): Promise<number> {
    const link = this.keeper;
    if (!link || this.#closed) return 0;
    let client;
    try {
      client = await link.client(false);
    } catch (error) {
      log.warning('terminal: could not reach the keeper: %s', error instanceof Error ? error.message : error);
      return 0;
    }
    if (!client) return 0; // no keeper runs: nothing to take over; the first shell starts one
    const problem = terminalProblem(client);
    if (problem) {
      // Not final: a keeper with no live channel is replaced by the bundled one at the first spawn (KeeperLink.check).
      announce('terminal', 'keeper: %s; terminals may run inside AIB', problem);
      return 0;
    }
    let adopted = 0;
    for (const info of await client.list()) {
      if (info.kind !== 'pty' || !info.channel.startsWith(TERMINAL_PREFIX)) continue;
      const label = parseTerminalLabel(info.label);
      if (!label) continue;
      try {
        if (!info.live) {
          await link.removeEnded(client, info.channel);
          continue;
        }
        if (this.#sessions.has(label.key) || this.#sessions.size >= this.#max) {
          announce(
            'terminal',
            'keeper: stopping terminal %s (%s)',
            info.channel,
            this.#sessions.has(label.key) ? 'its chat has another one' : 'too many',
          );
          await link.stopUnknown(client, info.channel);
          continue;
        }
        const pty = KeeperPty.adopt(link, info, label);
        this.#add(label.key, label.cwd, label.shell, pty, label);
        adopted++;
      } catch (error) {
        log.exception(error, 'keeper: taking over a terminal failed');
      }
    }
    if (adopted) announce('terminal', 'keeper: %s terminal(s) taken over from the keeper', adopted);
    return adopted;
  }

  /** How many shells are running a command right now (Pty.busy, PromptWatch). The tray-only AIB does not quit while one does. */
  busyCount(): number {
    let n = 0;
    for (const s of this.#sessions.values()) {
      let busy = false;
      try {
        busy = s.pty.busy();
      } catch { /* unknown */ }
      if (busy || s.prompt.busy) n++;
    }
    return n;
  }

  /**
   * Attach a socket: open (or reuse) the shell, or tell the page why not and close the socket. `command`: a program instead of a shell
   * (a Beta agent's sign-in). `resume`: only a shell that already runs (the page reconnecting after a restart); none is refused with
   * code `gone`.
   */
  attach(
    link: WsLink,
    key: unknown,
    cwd: unknown,
    cols: unknown,
    rows: unknown,
    shell: unknown = '',
    command: ShellSpec | null = null,
    resume = false,
  ): TerminalSession | null {
    try {
      if (resume && !this.#sessions.has(checkKey(key))) throw new TerminalError('This terminal is no longer running.', 'gone');
      const { session, resumed } = this.open(key, cwd, cols, rows, shell, command);
      session.attach(link, resumed);
      if (resumed) {
        const size = clampSize(cols, rows);
        session.pty.resize(size.cols, size.rows);
      }
      return session;
    } catch (error) {
      const known = error instanceof TerminalError;
      link.send(JSON.stringify({
        type: 'error',
        ...(known ? error.details : {}),
        message: known ? error.message : 'Could not open the terminal.',
        code: known ? error.code : 'failed',
      }));
      link.close(1000, 'refused');
      return null;
    }
  }

  /** End the conversation's shell (and what it started). False when it had none. */
  async end(key: string): Promise<boolean> {
    const session = this.#sessions.get(key);
    if (!session) return false;
    this.#sessions.delete(key);
    await session.pty.kill();
    return true;
  }

  /** End every shell and refuse new ones (the web server is closing). */
  async endAll(): Promise<void> {
    this.#closed = true;
    const all = [...this.#sessions.keys()];
    await Promise.all(all.map((key) => this.end(key)));
    this.keeper?.disconnect();
  }

  /**
   * AIB exits for an update: shells in the keeper keep running (the next AIB takes them over), shells inside AIB end. Refuses new
   * ones. Returns how many were left in the keeper.
   */
  async releaseAll(): Promise<number> {
    this.#closed = true;
    let kept = 0;
    const all = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(all.map(async (s) => {
      if (s.pty instanceof KeeperPty && s.pty.inKeeper) {
        kept++;
        for (const link of [...s.links]) link.close(1012, 'AIB is restarting'); // the page reconnects to the next AIB
        await s.pty.release();
      } else await s.pty.kill();
    }));
    this.keeper?.disconnect();
    if (kept) announce('terminal', 'keeper: %s terminal(s) left running in the keeper', kept);
    return kept;
  }

  /** Synchronous last resort while the process exits: signal every shell to end now (shells in the keeper stay: see KeeperPty). */
  terminateAllNow(): void {
    for (const session of this.#sessions.values()) {
      try {
        session.pty.terminate();
      } catch { /* gone */ }
    }
  }
}
