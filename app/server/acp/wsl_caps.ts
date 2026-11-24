/**
 * The client capabilities of a chat in a WSL project (docs/wsl/design.md sections 4 and 5): the agent runs in the distro, so nothing
 * it asks for may touch Windows files.
 *   - fs/read_text_file and fs/write_text_file are never offered (phase 1: AIB has no file layer inside the distro for them);
 *   - terminal/create (when client terminals are on) runs the command as a Linux-keeper channel in the distro, never as a child of AIB:
 *     the cwd is checked against the chat's Linux folder with POSIX rules, a bare program name is found with the helper's `which`, and
 *     the environment is the distro's login environment, not AIB's.
 * Everything else (output, wait, kill, release, the note-first takeover) is ClientCaps' own, through Connection's keeper backend.
 */
import { BASE_ENV_NAMES, CapError, ClientCaps, type ClientCapsOptions, ENV_NAME, type FsMode, MAX_ARG_CHARS, MAX_ARGS, MAX_ENV, MAX_OUTPUT_LIMIT, MAX_TERMINALS, DEFAULT_OUTPUT_LIMIT, type TerminalPlan } from './client_caps.ts';
import { clip, isDict, pyLen, pyRepr, pyStrip } from '../core/py.ts';
import { purePath } from '../transcripts/purepath.ts';

type Params = Record<string, unknown>;

export interface WslCapsHooks {
  /** The distro's login environment (PATH without /mnt). */
  env(): Promise<Record<string, string>>;
  /** The helper's `which`: a bare program name to its Linux path, or null. */
  which(name: string): Promise<string | null>;
}

/** `path` (absolute, or relative to root) normalised with POSIX rules when it stays inside root; else null. */
export function insideLinux(path: string, root: string): string | null {
  const base = purePath(root, false);
  const target = purePath(path.startsWith('/') ? path : `${root.replace(/\/+$/, '')}/${path}`, false);
  const parts: string[] = [];
  for (const part of target.parts) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  if (parts.length < base.parts.length || base.parts.some((p, i) => parts[i] !== p)) return null;
  return '/' + parts.join('/');
}

export class WslClientCaps extends ClientCaps {
  constructor(linuxPath: string, options: ClientCapsOptions, readonly hooks: WslCapsHooks) {
    super(linuxPath, { ...options, fs: null });
  }

  /** Client terminals as Studio says; fs is always off for a WSL chat. */
  override configure(terminal = false, _fs: FsMode = null): void {
    super.configure(terminal, null);
  }

  override terminalCreate(params: Params, rpc?: unknown, pinned?: string): Promise<{ terminalId: string }> {
    return this.#create(params, rpc, pinned);
  }

  async #create(params: Params, rpc?: unknown, pinned?: string): Promise<{ terminalId: string }> {
    const command = params.command;
    let args = Object.hasOwn(params, 'args') ? params.args : [];
    if (typeof command !== 'string' || !pyStrip(command) || command.includes('\0') || pyLen(command) > 4096) {
      throw new CapError('command must be a non-empty string');
    }
    if (args === null || args === undefined) args = [];
    if (
      !Array.isArray(args) || args.length > MAX_ARGS ||
      args.some((a) => typeof a !== 'string' || a.includes('\0') || pyLen(a) > MAX_ARG_CHARS)
    ) throw new CapError(`args must be a list of at most ${MAX_ARGS} strings`);
    const argList = args as string[];
    let cwd = this.workspace;
    if (params.cwd !== null && params.cwd !== undefined) {
      if (typeof params.cwd !== 'string' || params.cwd.includes('\0')) throw new CapError('cwd must be a string');
      const resolved = insideLinux(params.cwd, this.workspace);
      if (!resolved) throw new CapError('cwd must stay inside the workspace');
      cwd = resolved;
    }
    let limit = params.outputByteLimit;
    if (limit === null || limit === undefined) limit = DEFAULT_OUTPUT_LIMIT;
    else if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0) {
      throw new CapError('outputByteLimit must be a non-negative integer');
    }
    const byteLimit = Math.min(limit as number, MAX_OUTPUT_LIMIT);
    const env = await this.#environment(params.env);
    const program = command.includes('/') ? command : await this.hooks.which(command);
    if (!program) throw new CapError(`Command not found: ${clip(command, 80)}`);
    if (this.shut) throw new CapError('Connection is closing', -32603);
    if ([...this.terminals.values()].filter((t) => !t.released).length >= MAX_TERMINALS) {
      throw new CapError(`At most ${MAX_TERMINALS} terminals may be open at once; release one first`);
    }
    if (!this.terminalBackend) throw new CapError('Terminals of a WSL chat run in the distro, and it is not connected', -32603);
    const id = pinned ?? 'term_' + [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const plan: TerminalPlan = {
      rpc,
      terminalId: id,
      sessionId: params.sessionId as string,
      program,
      args: argList,
      argv: [command, ...argList],
      cwd,
      env,
      limit: byteLimit,
      pinned: !!pinned,
    };
    const terminal = await this.terminalBackend.create(plan);
    // Never a child of AIB: that would run a Linux command on Windows.
    if (!terminal) throw new CapError('The distro cannot run terminals for this chat right now', -32603);
    if (this.shut) {
      void terminal.dispose();
      throw new CapError('Connection is closing', -32603);
    }
    this.terminals.set(id, terminal);
    this.record('client_terminal', { op: 'create', terminalId: id, command, args: argList.slice(0, 20), cwd });
    return { terminalId: id };
  }

  /** The distro's environment, reduced to the names a Windows client terminal gets (POSIX case), plus what the agent asked for. */
  async #environment(requested: unknown): Promise<Record<string, string>> {
    const base = await this.hooks.env();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) if (BASE_ENV_NAMES.includes(key.toUpperCase())) env[key] = value;
    if (requested === null || requested === undefined) return env;
    if (!Array.isArray(requested) || requested.length > MAX_ENV) {
      throw new CapError(`env must be a list of at most ${MAX_ENV} name/value objects`);
    }
    for (const item of requested) {
      if (!isDict(item) || typeof item.name !== 'string' || typeof item.value !== 'string') {
        throw new CapError('Each env entry needs string name and value');
      }
      if (!ENV_NAME.test(item.name) || item.value.includes('\0') || pyLen(item.value) > MAX_ARG_CHARS) {
        throw new CapError(`Invalid environment variable: ${pyRepr(clip(item.name, 40))}`);
      }
      env[item.name] = item.value;
    }
    return env;
  }
}
