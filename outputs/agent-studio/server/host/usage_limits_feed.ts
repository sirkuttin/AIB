/**
 * Feeds the per-account usage limits (state/usage_limits.ts) from the Studio's connections, and gives each chat its account's
 * latest snapshot for the composer's Limits chip.
 *
 *   Claude Code  pushed: fromAgent('claude-rate-limit') on each usage_update that carries _claude/rateLimit. Never asked for.
 *   Qwen Code    pushed: fromAgent('qwen-quota') when a prompt fails with data.subscriptionQuota.
 *   Codex        read on chat open and after each turn, at most once a minute per account: the newest session file, else the
 *                app-server (server/agents/codex_limits.ts).
 *   Mistral Vibe the ACP request _account/read on the same cadence (one billing read; never a prompt). An agent that does not
 *                know the request is not asked again in that chat.
 *
 * Every other agent (OMP included) gets null: no chip.
 */
import { getLogger } from '../core/log.ts';
import {
  accountKey,
  type LimitsSnapshot,
  parseClaudeRateLimit,
  parseCodexAppServer,
  parseCodexRollout,
  parseQwenQuota,
  parseVibeAccount,
  type UsageLimitsStore,
} from '../state/usage_limits.ts';
import { TimeoutError } from '../acp/connection.ts';
import { appServerCommand, appServerLimits, codexHome, latestRolloutLimits } from '../agents/codex_limits.ts';

const log = getLogger('usage-limits');

export const REFRESH_SECONDS = 60;

/** What the feed reads from a connection. */
export interface LimitsConnection {
  provider: string;
  command: readonly string[];
  env: Record<string, string> | null;
  sessionId: string | null;
  ready: boolean;
  closed: boolean;
  replaying?: boolean;
  request(method: string, params: Record<string, unknown>, timeout: number): Promise<unknown>;
}

export interface LimitsFeedOptions {
  /** Seconds. */
  now?: () => number;
  /** Codex's home for this connection (tests point it at a fixture). Default: CODEX_HOME or ~/.codex, never under test. */
  codexHome?: (c: LimitsConnection) => string | null;
  /** The app-server command for this connection (tests give a fixture). Default: CODEX_PATH or the bundled @openai/codex. */
  appServer?: (c: LimitsConnection) => string[] | null;
}

const underTest = () => Deno.env.get('AGENT_STUDIO_TEST') === '1';

export class LimitsFeed {
  readonly store: UsageLimitsStore;
  readonly #now: () => number;
  readonly #home: (c: LimitsConnection) => string | null;
  readonly #appServer: (c: LimitsConnection) => string[] | null;
  /** Account key -> when it was last read (seconds), so reads are at most once a minute. */
  readonly #lastRead = new Map<string, number>();
  readonly #running = new Map<string, Promise<void>>();
  /** Vibe chats whose agent does not answer _account/read. */
  readonly #noAccountRead = new WeakSet<LimitsConnection>();

  constructor(store: UsageLimitsStore, options: LimitsFeedOptions = {}) {
    this.store = store;
    this.#now = options.now ?? (() => Date.now() / 1000);
    // The owner's real ~/.codex is never read under test: a test passes its own home.
    this.#home = options.codexHome ?? ((c) => (underTest() ? null : codexHome(c.env)));
    this.#appServer = options.appServer ?? ((c) => appServerCommand(c.command, c.env));
  }

  key(c: LimitsConnection): string {
    return accountKey(c.provider, c.env);
  }

  /** The chat's account's latest snapshot, or null (no chip). */
  view(c: LimitsConnection): LimitsSnapshot | null {
    const key = this.key(c);
    return key ? this.store.get(key) : null;
  }

  /** Something the agent sent on its own. `at` is when (seconds; a replayed record keeps its time, so it never wins over newer). */
  fromAgent(c: LimitsConnection, kind: string, raw: unknown, at: number): void {
    try {
      const key = this.key(c);
      if (!key) return;
      const snapshot = kind === 'claude-rate-limit' && c.provider === 'claude'
        ? parseClaudeRateLimit(raw, at)
        : kind === 'qwen-quota' && c.provider === 'qwen'
        ? parseQwenQuota(raw, at)
        : null;
      this.store.record(key, snapshot);
    } catch (error) {
      log.exception(error, 'Keeping the usage limits failed');
    }
  }

  /** Chat opened or a turn ended: read Codex / Vibe limits when the last read is over a minute old. Never throws. */
  refresh(c: LimitsConnection): Promise<void> {
    if (c.provider !== 'codex' && c.provider !== 'vibe') return Promise.resolve();
    if (c.replaying || c.closed) return Promise.resolve();
    const key = this.key(c);
    if (!key) return Promise.resolve();
    const running = this.#running.get(key);
    if (running) return running;
    const last = this.#lastRead.get(key);
    if (last !== undefined && this.#now() - last < REFRESH_SECONDS) return Promise.resolve();
    this.#lastRead.set(key, this.#now());
    const work = (async () => {
      try {
        const snapshot = c.provider === 'codex' ? await this.#readCodex(c) : await this.#readVibe(c);
        this.store.record(key, snapshot);
      } catch (error) {
        log.exception(error, 'Reading the usage limits failed');
      } finally {
        this.#running.delete(key);
      }
    })();
    this.#running.set(key, work);
    return work;
  }

  async #readCodex(c: LimitsConnection): Promise<LimitsSnapshot | null> {
    const found = latestRolloutLimits(this.#home(c));
    if (found) return parseCodexRollout(found.rateLimits, found.at);
    const command = this.#appServer(c);
    if (!command) return null;
    const result = await appServerLimits(command, c.env ? { ...Deno.env.toObject(), ...c.env } : null);
    return parseCodexAppServer(result, this.#now());
  }

  async #readVibe(c: LimitsConnection): Promise<LimitsSnapshot | null> {
    if (this.#noAccountRead.has(c) || !c.ready || !c.sessionId) return null;
    try {
      const result = await c.request('_account/read', { sessionId: c.sessionId }, 15);
      return parseVibeAccount(result, this.#now());
    } catch (error) {
      // An agent that does not know the request, or never answers it, is not asked again in this chat; a billing hiccup is.
      if ((error as { code?: unknown }).code === -32601 || error instanceof TimeoutError) this.#noAccountRead.add(c);
      log.info(`Mistral Vibe gave no account read: ${(error as Error).message}`);
      return null;
    }
  }
}
