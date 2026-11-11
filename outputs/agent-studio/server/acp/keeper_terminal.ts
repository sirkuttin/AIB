/**
 * ACP client terminals (`terminal/create` from an agent) in the keeper (keeper phase 3). When the chat's agent runs in the keeper, the
 * commands it asks AIB to run go there too, so they keep running through an AIB restart, crash or update, and the next AIB answers
 * `terminal/output`, `terminal/wait_for_exit`, `terminal/kill` and `terminal/release` from the same process and its recorded output.
 *
 * Note first (keeper design 3.1): before the keeper is asked to start a terminal, the chat's own channel gets a `clientTerminal` note
 * with the agent's request id, the terminal id and the keeper channel id it will have. A takeover reads the notes while replaying the
 * chat: a terminal with a note is re-attached (never started twice: the keeper refuses a second spawn of the same channel id); a
 * request whose note has no channel (an older AIB, or a terminal that ran inside AIB) is answered "lost" as before. A released
 * terminal gets a `clientTerminalReleased` note first, then is killed and its channel removed.
 *
 * Channel ids: `ct-<16 hex>`, from the terminal id `term_<16 hex>`. The keeper label says which chat owns it (Studio removes the
 * terminals of chats that are gone).
 */
import { getLogger } from '../core/log.ts';
import type { ChannelInfo, KeeperRecord } from '../keeper/client.ts';
import { KeeperError } from '../keeper/client.ts';
import type { KeeperChannel, KeeperLink } from '../keeper/link.ts';
import { parseNote } from '../keeper/link.ts';
import { TERMINAL_NEEDS } from '../terminal/keeper_pty.ts';
import { TerminalBase, type TerminalPlan } from './client_caps.ts';

const log = getLogger('client_caps');
const WIN = Deno.build.os === 'windows';

/** A client terminal's keeper channel ids. */
export const CLIENT_TERMINAL_PREFIX = 'ct-';

export function clientTerminalChannel(terminalId: string): string {
  return CLIENT_TERMINAL_PREFIX + terminalId.replace(/^term_/, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 60);
}

/** The bounded record a client terminal keeps in the keeper: enough for its output limit after a takeover. */
export function clientTerminalScrollback(limit: number): number {
  return Math.min(256 * 1024 * 1024, Math.max(64 * 1024, Math.ceil(limit * 1.25) + 64 * 1024));
}

/** The `clientTerminal` note of a terminal/create request (written before the keeper starts it). */
export interface ClientTerminalNote {
  t: 'clientTerminal';
  rpc: unknown;
  terminalId: string;
  /** The keeper channel; null when the terminal ran as a child of AIB (it ended with that AIB). */
  channel: string | null;
  sessionId: string;
  argv: string[];
  cwd: string;
  limit: number;
}

export class KeeperClientTerminal extends TerminalBase {
  channel!: KeeperChannel;
  /** Resolves once the terminal runs (spawned) or is caught up (adopted: its recorded output is in the buffer). Rejects on failure. */
  ready!: Promise<void>;
  #caught: (() => void) | null = null;

  private constructor(id: string, sessionId: string, argv: string[], cwd: string, limit: number) {
    super(id, sessionId, argv, cwd, limit);
  }

  #listener(adopting: boolean, settle: [() => void, (error: Error) => void]) {
    return {
      record: (record: KeeperRecord) => {
        if (record.kind === 'out' || record.kind === 'err') this.append(record.body);
        else if (record.kind === 'exit') this.#exit(record.body);
      },
      gap: () => (this.truncated = true), // the oldest output is no longer kept
      live: () => {
        if (!adopting) return;
        this.channel.claim().then(() => settle[0](), (error) => settle[1](error));
      },
      removed: () => this.finish(null, null),
      lost: () => this.finish(null, null), // the keeper died, and the terminal with it
      spawnFailed: (error: Error) => settle[1](error),
    };
  }

  #exit(body: Uint8Array): void {
    const note = parseNote(body);
    const code = note && typeof note.code === 'number' ? note.code : null;
    // POSIX: the keeper reports a child killed by signal N as 128+N.
    if (!WIN && code !== null && code > 128 && note?.reason === 'killed') this.finish(null, String(code - 128));
    else this.finish(code, null);
  }

  /** Start the plan's command in the keeper (stdin closed at once, as for a child of AIB). */
  static spawn(link: KeeperLink, plan: TerminalPlan, chat: string): KeeperClientTerminal {
    const t = new KeeperClientTerminal(plan.terminalId, plan.sessionId, plan.argv, plan.cwd, plan.limit);
    let settle: [() => void, (error: Error) => void] = [() => {}, () => {}];
    const spawned = new Promise<void>((resolve, reject) => (settle = [resolve, reject]));
    t.channel = link.spawn(
      {
        channel: clientTerminalChannel(plan.terminalId),
        command: plan.program,
        args: plan.args,
        cwd: plan.cwd,
        env: plan.env,
        scrollback: clientTerminalScrollback(plan.limit),
        label: JSON.stringify({ t: 'clientTerminal', v: 1, chat, terminalId: plan.terminalId }),
      },
      t.#listener(false, settle),
      undefined,
      TERMINAL_NEEDS,
    );
    t.channel.ready.then(() => settle[0](), () => {});
    t.ready = spawned.then(() => t.channel.closeStdin());
    t.ready.catch(() => {});
    return t;
  }

  /** Re-attach a terminal an earlier AIB started (its note), rebuild its output from the keeper's record, and own it. */
  static adopt(link: KeeperLink, note: ClientTerminalNote, info: ChannelInfo): KeeperClientTerminal {
    const t = new KeeperClientTerminal(note.terminalId, note.sessionId, note.argv, note.cwd, note.limit);
    t.created = info.created / 1000;
    let settle: [() => void, (error: Error) => void] = [() => {}, () => {}];
    t.ready = new Promise<void>((resolve, reject) => (settle = [resolve, reject]));
    t.ready.catch(() => {});
    t.channel = link.adopt(info, t.#listener(true, settle));
    return t;
  }

  async kill(): Promise<void> {
    if (this.isExited) return;
    this.killed = true;
    await this.channel.kill();
    await Promise.race([this.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  }

  /** Released, or its chat closed: kill it and remove its record from the keeper. */
  override async dispose(): Promise<void> {
    await this.kill();
    await this.channel.remove();
  }
}

/** Parse a `clientTerminal` note; null when it is not one. */
export function clientTerminalNote(note: Record<string, unknown> | null): ClientTerminalNote | null {
  if (!note || note.t !== 'clientTerminal' || typeof note.terminalId !== 'string') return null;
  return {
    t: 'clientTerminal',
    rpc: note.rpc,
    terminalId: note.terminalId,
    channel: typeof note.channel === 'string' ? note.channel : null,
    sessionId: typeof note.sessionId === 'string' ? note.sessionId : '',
    argv: Array.isArray(note.argv) ? note.argv.map(String) : [],
    cwd: typeof note.cwd === 'string' ? note.cwd : '',
    limit: typeof note.limit === 'number' ? note.limit : 1024 * 1024,
  };
}

/** Is this keeper able to run client terminals? ('' = yes, else why not.) */
export function clientTerminalProblem(features: readonly string[], version: string): string {
  const missing = TERMINAL_NEEDS.filter((f) => !features.includes(f));
  return missing.length ? `the running keeper (${version || 'unknown version'}) lacks ${missing.join(', ')}` : '';
}

export function isUnsupported(error: unknown): boolean {
  return error instanceof KeeperError && error.code === 'unsupported';
}

export { log as clientTerminalLog };
