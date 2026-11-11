/**
 * Chat terminals in the keeper (keeper phase 3, design "K9"): the shell's pseudo-terminal is held by the keeper, not by AIB, so a
 * shell outlives an AIB restart, crash or update, exactly like a chat's agent. A KeeperPty is the platform Pty (platform/pty.ts) of
 * such a shell, as TerminalSession sees it:
 *
 *   - spawn: the keeper starts the shell on a ConPTY (Windows) or openpty (elsewhere), hidden, in its own Job Object / process group,
 *     with a bounded journal (`scrollback`, TERMINAL_SCROLLBACK) and a `label` that says which chat it belongs to;
 *   - adopt: the next AIB lists the keeper's channels, finds the shells by their label, attaches from the start of what the keeper
 *     still has (the newest TERMINAL_SCROLLBACK bytes), feeds it through the same session code (its replay buffer and PromptWatch see
 *     the output and the typed input again), claims the channel and goes on live with the same shell process;
 *   - the shell ending (an `exit` record) is the only thing that ends it; a fenced channel (a newer AIB took it) just goes quiet.
 *
 * When the keeper cannot hold terminals (it is off, too old: no `scrollback`/`labels`, or it refuses the spawn) the shell starts the
 * old way, as a child of AIB (spawnPty), and the log says why.
 */
import { getLogger } from '../core/log.ts';
import { quoteWindowsArg } from '../platform/spawn_detached.ts';
import type { Pty, PtyOptions, ShellSpec } from '../platform/pty.ts';
import { type ChannelInfo, type KeeperClient, KeeperError, type KeeperRecord, missingFeatures } from '../keeper/client.ts';
import { type KeeperChannel, type KeeperLink, parseNote } from '../keeper/link.ts';

const log = getLogger('terminal');
const DEC = new TextDecoder();

/** What a keeper must offer to hold chat terminals and client terminals (hello's `features`; keeper 1.2.0 and later). */
export const TERMINAL_NEEDS = ['pty', 'scrollback', 'labels'];
/** Terminal output the keeper keeps per shell (its bounded journal): enough for xterm's 5000 lines of scrollback. */
export const TERMINAL_SCROLLBACK = 2 * 1024 * 1024;
/** A chat terminal's channel ids: `pty-<random>`. */
export const TERMINAL_PREFIX = 'pty-';

/** The keeper `label` of a chat terminal: which chat, which shell, since when. Opaque to the keeper. */
export interface TerminalLabel {
  t: 'terminal';
  v: 1;
  key: string;
  id: string;
  cwd: string;
  shell: ShellSpec;
  startedAt: number;
}

export function parseTerminalLabel(label: unknown): TerminalLabel | null {
  if (typeof label !== 'string' || !label) return null;
  const value = parseNote(new TextEncoder().encode(label));
  if (!value || value.t !== 'terminal' || typeof value.key !== 'string' || typeof value.cwd !== 'string') return null;
  const shell = value.shell as ShellSpec | undefined;
  if (!shell || typeof shell.file !== 'string' || !Array.isArray(shell.args)) return null;
  return {
    t: 'terminal',
    v: 1,
    key: value.key,
    id: typeof value.id === 'string' ? value.id : crypto.randomUUID(),
    cwd: value.cwd,
    shell: { file: shell.file, args: shell.args.map(String) },
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : Date.now(),
  };
}

/** Why the keeper cannot hold terminals, from its features ('' = it can). */
export function terminalProblem(client: KeeperClient): string {
  const missing = missingFeatures(client.features, TERMINAL_NEEDS);
  return missing.length ? `the running keeper (${client.keeperVersion || 'unknown version'}) lacks ${missing.join(', ')}` : '';
}

function exitCodeOf(body: Uint8Array): number {
  const note = parseNote(body);
  return note && typeof note.code === 'number' ? note.code : -1;
}

/** The full environment a shell gets: AIB's own plus `extra` (what spawnPty gives a local shell). */
export function shellEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const env = { ...Deno.env.toObject(), ...extra };
  delete env.DENO_SERVE_ADDRESS;
  return env;
}

export class KeeperPty implements Pty {
  pid = 0;
  onData: ((bytes: Uint8Array) => void) | null = null;
  /** Typed input found in the keeper's record while replaying (PromptWatch needs it to be in the same state as before). */
  onInput: ((bytes: Uint8Array) => void) | null = null;
  /** Called (once) when the shell runs as a child of AIB after all (the keeper could not take it); says why. */
  onFallback: ((why: string) => void) | null = null;
  readonly exited: Promise<number>;
  /** Resolves once the shell runs (spawned, or replayed and claimed): `pid` is known then. Never rejects: see startError. */
  readonly ready: Promise<void>;
  /** Why the shell could not start at all ('' = it runs). */
  startError = '';
  /** The time of the newest record seen (ms): the session's "last activity" after a restart. */
  lastRecord = 0;
  #exit!: (code: number) => void;
  #ready!: () => void;
  #ended = false;
  #fenced = false;
  #local: Pty | null = null;
  #channel: KeeperChannel | null = null;
  #replaying = false;

  private constructor(
    readonly link: KeeperLink,
    readonly mode: 'spawn' | 'adopt',
    readonly options: PtyOptions | null,
    readonly label: TerminalLabel,
    readonly info: ChannelInfo | null,
    readonly fallback: ((options: PtyOptions) => Pty) | null,
  ) {
    this.exited = new Promise((resolve) => (this.#exit = resolve));
    this.ready = new Promise((resolve) => (this.#ready = resolve));
  }

  /** A new shell in the keeper; `fallback` starts it as a child of AIB when the keeper cannot. Call start() once the session is wired. */
  static spawn(link: KeeperLink, options: PtyOptions, label: TerminalLabel, fallback: (options: PtyOptions) => Pty): KeeperPty {
    return new KeeperPty(link, 'spawn', options, label, null, fallback);
  }

  /** A shell an earlier AIB started in the keeper (from `list`). Call start() once the session is wired. */
  static adopt(link: KeeperLink, info: ChannelInfo, label: TerminalLabel): KeeperPty {
    const pty = new KeeperPty(link, 'adopt', null, label, info, null);
    pty.pid = info.pid;
    return pty;
  }

  get channelId(): string | null {
    return this.#channel?.id ?? null;
  }

  /** True when this shell runs in the keeper (false: a child of AIB after a fallback, or not started). */
  get inKeeper(): boolean {
    return !!this.#channel && !this.#local;
  }

  start(): void {
    if (this.mode === 'spawn') this.#spawn();
    else this.#adopt();
  }

  #listener() {
    return {
      record: (record: KeeperRecord) => this.#record(record),
      live: () => {
        if (this.mode === 'adopt' && this.#replaying && !this.#ended) void this.#claim();
      },
      fenced: () => {
        this.#fenced = true; // a newer AIB took this shell: it goes on there; this one stays quiet
      },
      removed: () => this.#ended || this.#end(-1),
      lost: () => this.#end(-1), // the keeper died: its Job Objects took the shell with them
      spawnFailed: (error: Error) => this.#spawnFailed(error),
      writeFailed: (error: Error) => {
        if (!this.#fenced && !this.#ended) log.warning('terminal %s: keeper write failed: %s', this.#channel?.id, error.message);
      },
    };
  }

  #spawn(): void {
    const options = this.options!;
    const id = `${TERMINAL_PREFIX}${crypto.randomUUID().replaceAll('-', '')}`;
    const env = shellEnvironment(options.env ?? {});
    const windows = Deno.build.os === 'windows';
    this.#channel = this.link.spawn(
      {
        channel: id,
        command: options.file,
        args: options.args,
        ...(windows ? { windowsCommandLine: [options.file, ...options.args].map(quoteWindowsArg).join(' ') } : {}),
        cwd: options.cwd,
        env,
        pty: { cols: options.cols, rows: options.rows },
        scrollback: TERMINAL_SCROLLBACK,
        label: JSON.stringify(this.label),
      },
      this.#listener(),
      undefined,
      TERMINAL_NEEDS,
    );
    this.#channel.ready.then(() => {
      if (this.#local) return;
      this.pid = this.#channel!.pid;
      this.#ready();
    }, () => {/* spawnFailed handles it */});
  }

  #spawnFailed(error: Error): void {
    if (this.#ended || this.#local) return;
    if (this.mode === 'adopt' || (this.#channel && this.#channel.pid)) {
      log.warning('terminal %s: the keeper channel failed: %s', this.#channel?.id, error.message);
      this.#end(-1);
      return;
    }
    const why = error instanceof KeeperError && error.code === 'unsupported' ? error.message.replace(/^unsupported: /, '') : error.message;
    if (this.#channel) this.link.channels.delete(this.#channel.id);
    this.#channel = null;
    try {
      const local = this.fallback!(this.options!);
      this.#local = local;
      this.pid = local.pid;
      local.onData = (bytes) => this.onData?.(bytes);
      void local.exited.then((code) => this.#end(code));
      this.onFallback?.(why);
    } catch (caught) {
      this.startError = caught instanceof Error ? caught.message : String(caught);
      this.#end(-1);
    }
    this.#ready();
  }

  #adopt(): void {
    this.#replaying = true;
    this.#channel = this.link.adopt(this.info!, this.#listener());
    this.#channel.ready.catch(() => {/* spawnFailed handles it */});
  }

  async #claim(): Promise<void> {
    try {
      await this.#channel!.claim();
      this.#replaying = false;
      this.#ready();
    } catch (error) {
      log.warning('terminal %s: could not take the shell over: %s', this.#channel?.id, error instanceof Error ? error.message : error);
      this.startError = 'The terminal could not be taken over after AIB restarted.';
      this.#end(-1);
    }
  }

  #record(record: KeeperRecord): void {
    this.lastRecord = record.time || this.lastRecord;
    if (record.kind === 'out') this.onData?.(record.body);
    else if (record.kind === 'in' && this.#replaying) this.onInput?.(record.body);
    else if (record.kind === 'exit') this.#end(exitCodeOf(record.body));
  }

  #end(code: number): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#exit(code);
    this.#ready(); // a shell that ended while starting: the session reports that, not a hang
  }

  write(data: string | Uint8Array): void {
    if (this.#local) return this.#local.write(data);
    if (this.#ended || this.#fenced || !this.#channel) return;
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (bytes.length) void this.#channel.write(bytes);
  }

  resize(cols: number, rows: number): void {
    if (this.#local) return this.#local.resize(cols, rows);
    if (this.#ended || this.#fenced || !this.#channel) return;
    void this.#channel.resize(cols, rows);
  }

  /** End the shell and what it started, and drop its record from the keeper. */
  async kill(): Promise<void> {
    if (this.#local) return await this.#local.kill();
    const channel = this.#channel;
    if (!channel || this.#fenced) return;
    if (!this.#ended) {
      await channel.kill();
      await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
    }
    await channel.remove();
  }

  /** Leave the shell running in the keeper (AIB exits for an update): stop following it. */
  async release(): Promise<void> {
    if (this.#local) return await this.#local.kill();
    this.#fenced = true;
    await this.#channel?.detach();
  }

  /** The process is exiting without close(): a shell in the keeper stays there (the next AIB takes it over). */
  terminate(): void {
    this.#local?.terminate();
  }

  /** The keeper cannot see into a shell's process tree; PromptWatch (sessions.ts) tells whether a command runs. */
  busy(): boolean {
    return this.#local ? this.#local.busy() : false;
  }

  /** For logs. */
  describe(): string {
    return this.#local ? `pid ${this.pid} (inside AIB)` : `pid ${this.pid} in keeper channel ${this.#channel?.id}`;
  }
}

/** The typed input of a replayed `in` record, as text (PromptWatch.input). */
export function inputText(bytes: Uint8Array): string {
  return DEC.decode(bytes);
}
