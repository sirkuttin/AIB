/**
 * Chat names follow AIB into the agents' own lists. A name the user gives a Claude Code or Codex chat in AIB (Rename, on the PC or a
 * phone) is also given to the agent's own session, so `claude --resume`, the VS Code extension and Codex's thread list show the same
 * name AIB shows.
 *
 * The agent names it itself: a short-lived adapter process (Connection.renameSessionTitle) asks for its `_session/rename`, which
 * loads no session and starts no model turn. Claude Code's adapter writes what the CLI's own `/rename` writes (a `custom-title`
 * record in the transcript and its `custom-title.json`); a running chat's CLI reads that record back before it re-stamps its
 * metadata, so it never writes an old name over it. codex-acp sets the thread name through its app-server. AIB never edits a
 * transcript or Codex's files itself.
 *
 * Never while the chat's turn runs: the name waits for the turn to end (the turn-end hook, and a slow check while one waits, so a
 * stopped turn is not missed). A chat that has no transcript yet (a new chat before its first reply) is named at its first turn end.
 * A cleared name (Rename to nothing) changes nothing in the agent. The newest name wins; an older one still waiting is dropped.
 */
import { getLogger } from '../core/log.ts';
import { claudeBase } from '../agents/claude_family.ts';

const log = getLogger('agent-titles');

/** The agents whose adapters AIB pins and that offer `_session/rename` (Claude Code, Codex). */
export const TITLED_PROVIDERS: ReadonlySet<string> = new Set(['claude', 'codex']);
/** While a name waits for a running turn: how often to look again (the turn-end hook is the fast path). */
const IDLE_CHECK_MS = 5000;
/** A name for a chat whose transcript is not there yet waits for at most this many turn ends. */
const MAX_NOT_FOUND = 3;

/** What AgentTitles needs to know of a running chat. */
export interface TitleChat {
  readonly busy: boolean;
  readonly autonomous: boolean;
  readonly closed: boolean;
  readonly cwd: string;
}

export interface TitleDeps {
  /** The chat AIB runs for this session, if any. */
  live(provider: string, sessionId: string): TitleChat | null;
  /** Name the session through the agent (a short-lived process); false when the agent does not offer it. */
  rename(provider: string, sessionId: string, title: string, cwd: string): Promise<boolean>;
}

interface Wanted {
  provider: string;
  sessionId: string;
  title: string;
  cwd: string;
  notFound: number;
}

/** The newest wanted name per chat, and the runs in flight. */
export class AgentTitles {
  readonly #wanted = new Map<string, Wanted>();
  readonly #running = new Set<string>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Done renames, newest last (tests read them through the host's debug answer). */
  readonly done: { key: string; title: string; ok: boolean; reason: string }[] = [];

  constructor(readonly deps: TitleDeps) {}

  /** The user named this chat in AIB: give the agent's own session the same name (now, or when its turn ends). */
  request(provider: string, sessionId: string, title: string, cwd = ''): boolean {
    const name = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!TITLED_PROVIDERS.has(claudeBase(provider)) || !sessionId || !name) return false;
    const key = `${provider}:${sessionId}`;
    this.#wanted.set(key, { provider, sessionId, title: name, cwd: cwd || '', notFound: 0 });
    void this.#try(key);
    return true;
  }

  /** A chat's turn ended: a name waiting for it goes now. */
  turnEnded(provider: string, sessionId: string): void {
    const key = `${provider}:${sessionId}`;
    if (this.#wanted.has(key)) void this.#try(key);
  }

  /** Names still waiting (for tests and the log). */
  waiting(): string[] {
    return [...this.#wanted.keys()];
  }

  stop(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
  }

  async #try(key: string): Promise<void> {
    const want = this.#wanted.get(key);
    if (!want || this.#running.has(key)) return;
    const chat = this.deps.live(want.provider, want.sessionId);
    if (chat && !chat.closed && (chat.busy || chat.autonomous)) {
      this.#checkLater();
      return;
    }
    this.#running.add(key);
    let reason = '';
    let ok = false;
    try {
      ok = await this.deps.rename(want.provider, want.sessionId, want.title, (chat && !chat.closed ? chat.cwd : '') || want.cwd);
      if (!ok) reason = 'the agent does not offer renaming';
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      // -32002: the agent knows no such session yet (no transcript before the first reply): named at a later turn end
      const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
      if (code === -32002 && this.#wanted.get(key) === want && ++want.notFound < MAX_NOT_FOUND) {
        this.#running.delete(key);
        log.info('Naming %s in the agent waits for its first reply: %s', key, reason);
        return;
      }
    } finally {
      this.#running.delete(key);
    }
    this.done.push({ key, title: want.title, ok, reason });
    if (this.done.length > 50) this.done.shift();
    if (ok) log.info('Named %s in the agent', key);
    else log.warning('Naming %s in the agent failed: %s', key, reason);
    // a newer name came while this one ran: it goes next; else this one is done
    if (this.#wanted.get(key) === want) this.#wanted.delete(key);
    else void this.#try(key);
  }

  #checkLater(): void {
    if (this.#timer !== null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      for (const key of [...this.#wanted.keys()]) void this.#try(key);
    }, IDLE_CHECK_MS);
    try {
      Deno.unrefTimer(this.#timer as unknown as number);
    } catch { /* not Deno */ }
  }
}
