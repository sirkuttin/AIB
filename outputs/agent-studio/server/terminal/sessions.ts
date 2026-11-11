/**
 * Terminal sessions: one shell per conversation, owned by the web server process. They outlive the page and the window (closing to
 * the tray keeps them), and all end when the web server closes (WebServer.close -> endAll; on Windows the Job Object also ends them
 * if AIB dies). Nothing typed or printed here goes to an agent.
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
 * The socket's query: key, cwd, cols, rows, and shell=windows-powershell to use Windows PowerShell instead of the default shell.
 */
import { isNetworkPath } from '../web/security.ts';
import { clampSize, defaultShell, type Pty, type PtyOptions, type ShellSpec, spawnPty } from '../platform/pty.ts';
import type { WsLink } from '../platform/websocket.ts';

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
  readonly id = crypto.randomUUID();
  readonly startedAt = Date.now();
  lastActivity = Date.now();
  readonly links = new Set<WsLink>();
  readonly prompt: PromptWatch;
  #replay: Uint8Array[] = [];
  #replaySize = 0;
  exitCode: number | null = null;

  constructor(
    readonly key: string,
    readonly cwd: string,
    readonly shell: ShellSpec,
    readonly pty: Pty,
    onExit: (s: TerminalSession) => void,
  ) {
    this.prompt = PromptWatch.forShell(shell.file);
    pty.onData = (bytes) => {
      this.lastActivity = Date.now();
      this.prompt.output(bytes);
      this.#remember(bytes);
      for (const link of this.links) link.send(bytes);
    };
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
}

export class TerminalSessions {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #max: number;
  readonly #spawn: (options: PtyOptions) => Pty;
  readonly #shell: () => ShellSpec;
  #closed = false;

  constructor(options: SessionsOptions = {}) {
    this.#max = options.max ?? MAX_SESSIONS;
    this.#spawn = options.spawn ?? spawnPty;
    this.#shell = options.shell ?? (() => defaultShell());
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
  ): { session: TerminalSession; resumed: boolean } {
    if (this.#closed) throw new TerminalError('AIB is closing.', 'closing');
    const k = checkKey(key);
    const running = this.#sessions.get(k);
    if (running) return { session: running, resumed: true };
    const folder = checkCwd(cwd);
    if (this.#sessions.size >= this.#max) {
      throw new TerminalError(`${this.#max} terminals are already open.`, 'too_many', { max: this.#max, terminals: this.list() });
    }
    const shell = shellChoice === 'windows-powershell' && Deno.build.os === 'windows' ? windowsPowerShell() : this.#shell();
    const size = clampSize(cols, rows);
    let pty: Pty;
    try {
      pty = this.#spawn({ file: shell.file, args: shell.args, cwd: folder, ...size, env: { AIB_TERMINAL: '1' } });
    } catch (error) {
      throw new TerminalError(`${shell.file}: ${(error as Error).message}`, 'spawn_failed', { shellName: shellName(shell.file) });
    }
    const session = new TerminalSession(k, folder, shell, pty, (s) => {
      if (this.#sessions.get(s.key) === s) this.#sessions.delete(s.key);
    });
    this.#sessions.set(k, session);
    return { session, resumed: false };
  }

  /** Attach a socket: open (or reuse) the shell, or tell the page why not and close the socket. */
  attach(link: WsLink, key: unknown, cwd: unknown, cols: unknown, rows: unknown, shell: unknown = ''): TerminalSession | null {
    try {
      const { session, resumed } = this.open(key, cwd, cols, rows, shell);
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
  }

  /** Synchronous last resort while the process exits: signal every shell to end now. */
  terminateAllNow(): void {
    for (const session of this.#sessions.values()) {
      try {
        session.pty.terminate();
      } catch { /* gone */ }
    }
  }
}
