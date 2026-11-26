/**
 * Aib methods: reconnecting recovered chats after a restart and the schedule scan.
 * Moved out of aib.ts (no change).
 */
import { errorText } from '../acp/connection.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import { isStr, ValueError } from '../core/py.ts';
import { OwnershipConflict } from '../ownership/ownership.ts';
import { Mutex } from '../worktrees/sync.ts';
import { log, type Json, RECONNECT_TRIES } from './aib_util.ts';
import { pairKey } from './aib_options.ts';
import { Aib } from './aib.ts';

export const reconnectMethods = {
  // ---- automatic reconnect after a restart -------------------------------------------------------------------------------
  /**
   * Reload, in the background, every conversation that was live in AIB before the restart. Uses the ordinary resume path of
   * connect() with continueAnyway=false, so the ownership check runs: a conversation another app owns or may be using is skipped
   * and stays "Ready". Nothing is ever sent to an agent. At most `concurrency` start at once, `stagger` seconds apart; a
   * failure is retried up to `tries` times and then dropped from the recovery list. Returns how many were queued.
   */
  startAutoReconnect(this: Aib, concurrency = 2, stagger = 1.0, tries: number | null = null, retryDelay = 5.0): number {
    if (!this.store || !this.autoReconnect || this.reconnectStarted) return 0;
    this.reconnectStarted = true;
    const items = this.recovered().filter((r) => !agentRegistry.isRetired(r.provider)).map((r) => [r.provider, r.sessionId, r.cwd] as [string, string, string]); // a retired agent's chat is never started
    const attempts = tries || RECONNECT_TRIES;
    if (!items.length) return 0;
    for (const [p, i] of items) this.reconnectPending.add(pairKey(p, i));
    const work = [...items];
    const gate = new Mutex();
    let started = false;
    const worker = async () => {
      while (!this.reconnectStop.isSet()) {
        let item: [string, string, string] | undefined;
        const proceed = await gate.run(async () => { // one start at a time, spaced out
          if (!work.length) return false;
          item = work.shift()!;
          if (started && await this.reconnectStop.wait(stagger * 1000)) return false;
          started = true;
          return true;
        });
        if (!proceed) return;
        await this.reconnectOne(item!, attempts, retryDelay);
      }
    };
    for (let n = 0; n < Math.max(1, Math.trunc(concurrency)); n++) this.reconnectWorkers.push(worker());
    return items.length;
  },

  /**
   * Owner, 2026-11-23: a scheduled message goes out at its time even if nobody opens the chat. Looks at the saved schedules of every
   * chat (the queue file keeps where each runs). A chat whose time has come is reopened in the background, like the automatic
   * reconnect does, and its own timer sends the message ("Sent late (scheduled ...)" when AIB was away). Later times wait on one
   * timer. A chat that cannot be reopened keeps its message as a scheduled card with the reason on it.
   */
  startScheduleScan(this: Aib): void {
    if (!this.recovery?.queues || this.$closed) return;
    void this.scheduleScan();
  },

  async scheduleScan(this: Aib): Promise<void> {
    const queues = this.recovery?.queues;
    if (!queues || this.$closed || this.$scanning) return;
    this.$scanning = true;
    try {
      const open = new Set([...this.connections.values()].filter((c) => !c.closed).map((c) => pairKey(c.provider, c.sessionId)));
      const now = this.scheduleClock();
      for (const chat of queues.scheduledChats()) {
        if (this.$closed || this.reconnectStop.isSet()) return;
        const key = pairKey(chat.provider, chat.sessionId);
        if (open.has(key) || this.reconnectPending.has(key) || chat.at > now) continue; // an open chat sends its own
        const failedAt = this.$scanFailed.get(key);
        if (failedAt !== undefined && now - failedAt < Aib.SCAN_RETRY_MS) continue;
        try {
          await this.connect(chat.provider, chat.cwd, chat.sessionId, { background: false, continueAnyway: false, auto: true });
          this.$scanFailed.delete(key);
          console.error(`Send later: reopened ${chat.provider} ${chat.sessionId} to send its scheduled message`);
        } catch (error) {
          const why = error instanceof OwnershipConflict
            ? 'Another app is using this chat, so AIB could not send this at its time. Open the chat to send it.'
            : `AIB could not reopen this chat to send this at its time (${errorText(error).slice(0, 160)}). It is kept here.`;
          this.$scanFailed.set(key, now);
          queues.markScheduleError(chat.provider, chat.sessionId, why, now);
          log.warning('Send later: could not reopen %s %s: %s', chat.provider, chat.sessionId, errorText(error));
        }
      }
    } finally {
      this.$scanning = false;
      this.$scanArm();
    }
  },

  $scanArm(this: Aib): void {
    if (this.$scanTimer !== null) clearTimeout(this.$scanTimer);
    this.$scanTimer = null;
    const queues = this.recovery?.queues;
    if (!queues || this.$closed || this.reconnectStop.isSet()) return;
    const open = new Set([...this.connections.values()].filter((c) => !c.closed).map((c) => pairKey(c.provider, c.sessionId)));
    const now = this.scheduleClock();
    let next = Infinity;
    for (const chat of queues.scheduledChats()) {
      if (open.has(pairKey(chat.provider, chat.sessionId))) continue;
      next = Math.min(next, Math.max(chat.at, now));
    }
    if (next === Infinity) return;
    const timer = setTimeout(() => {
      this.$scanTimer = null;
      void this.scheduleScan();
    }, Math.min(Math.max(next - now, 0) + 50, 30_000));
    Deno.unrefTimer(timer as unknown as number);
    this.$scanTimer = timer;
  },

  async reconnectOne(this: Aib, item: [string, string, string], tries: number, retryDelay: number): Promise<void> {
    const [provider, sessionId, cwd] = item;
    const label = `${provider} ${sessionId} in ${cwd}`;
    let last = '';
    try {
      for (let attempt = 1; attempt <= tries; attempt++) {
        if (this.reconnectStop.isSet()) return;
        try {
          await this.connect(provider, cwd, sessionId, { background: false, continueAnyway: false, auto: true });
          console.error(`Auto-reconnect: reconnected ${label}`);
          return;
        } catch (error) {
          if (error instanceof OwnershipConflict) {
            console.error(`Auto-reconnect: skipped ${label}: ${error.message}`);
            return;
          }
          last = errorText(error);
          log.warning('Auto-reconnect of %s failed (try %s of %s): %s', label, attempt, tries, last);
          console.error(`Auto-reconnect: ${label} failed (try ${attempt} of ${tries}): ${last}`);
          if (attempt < tries && await this.reconnectStop.wait(retryDelay * 1000)) return;
        }
      }
      // The chat says why it is not running (liveList reconnectFailed), so it never just sits there: Continue tries again.
      this.reconnectFailures.set(pairKey(provider, sessionId), { provider, sessionId, cwd, error: last.slice(0, 500), at: Date.now() / 1000 });
      if (this.store!.forgetConversation(provider, sessionId)) {
        console.error(`Auto-reconnect: gave up on ${label}; it stays Ready (Couldn't reopen)`);
      }
    } finally {
      this.reconnectPending.delete(pairKey(provider, sessionId));
    }
  },

  forgetRecovered(this: Aib, provider: unknown, sessionId: unknown): boolean {
    if (!isStr(provider) || !isStr(sessionId)) throw new ValueError('Invalid conversation');
    const failed = this.reconnectFailures.delete(pairKey(provider, sessionId));
    return !!(this.store && this.store.forgetConversation(provider, sessionId)) || failed;
  },

  /** reconnectFailures without the chats that run again (a Continue, a take-over). */
  reconnectFailed(this: Aib): Json[] {
    const openNow = new Set([...this.connections.values()].filter((c) => !c.closed).map((c) => pairKey(c.provider, c.sessionId)));
    return [...this.reconnectFailures.entries()].filter(([key]) => !openNow.has(key)).map(([, failure]) => ({ ...failure }));
  },
};

export type ReconnectMethods = typeof reconnectMethods;
