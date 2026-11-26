/**
 * Connection methods: opening a chat elsewhere (letting go of a session another app took, reclaiming it).
 * Moved out of connection.ts (no change).
 */
import { sessionCapabilities } from './breadth.ts';
import { type Holder } from '../ownership/claude_sessions.ts';
import { activeWriterError } from '../ownership/codex_threads.ts';
import { isDict, isStr } from '../core/py.ts';
import { log, type Json, errorText, get } from './conn_util.ts';
import { ReplayWindow, outsideTurns } from './replay_window.ts';
import type { Connection } from './connection.ts';
import type { Elsewhere } from './conn_types.ts';

export const handoffMethods = {
  /** The agent can close a session and keep running (claude-agent-acp: sessionCapabilities.close). */
  canCloseSession(this: Connection): boolean {
    return sessionCapabilities(this.initial).ops.includes('close');
  },

  /** Another app holds this chat's session: let go now when quiet, else when the turn (and its helpers) end. Idempotent. */
  handOff(this: Connection, holder: Holder): void {
    if (this.closed || !this.ready || !this.sessionId || this.$replaying || this.elsewhere || this.rebuildError) return;
    if (this.overriddenHolders.has(holder.pid)) return; // the person chose Open here anyway over this one
    if (!this.canCloseSession()) {
      log.info('chat %s: open in %s, but its agent cannot close a session; AIB keeps it', this.id, holder.app);
      return;
    }
    this.elsewhere = { app: holder.app, pid: holder.pid, entrypoint: holder.entrypoint, since: this.$now(), released: false };
    void this.tryRelease();
  },

  /**
   * Let go of this chat now, only when it is idle (Codex: an app-server of VS Code / Codex Desktop started, or the person chose Let go).
   * Never waits for a turn: 'busy' means it is working (a turn, a question, a helper or a shell), 'no' that nothing was done (not
   * ready, already let go, the agent cannot close a session, or closing failed). `line` is the chat line's text.
   */
  async letGoIdle(this: Connection, holder: Holder, line: string): Promise<'released' | 'busy' | 'no'> {
    if (this.closed || !this.ready || !this.sessionId || this.$replaying || this.elsewhere || this.rebuildError) return 'no';
    if (!this.canCloseSession()) return 'no';
    if (!this.$quietForRelease(false)) return 'busy';
    this.elsewhere = { app: holder.app, pid: holder.pid, entrypoint: holder.entrypoint, since: this.$now(), released: false, line };
    const e = this.elsewhere;
    if (await this.tryRelease()) return 'released';
    if (this.elsewhere !== e) return 'no'; // closing failed (tryRelease cleared it)
    this.elsewhere = null; // something started in between: no waiting for the turn to end, as the other hand-offs do
    return 'busy';
  },

  /** Nothing would be lost by closing the session now: no turn, no question open, no background helper or shell, nothing sending. */
  $quietForRelease(this: Connection, turnEnding: boolean): boolean {
    return (turnEnding || !this.busy) && !this.permissions.size && !this.elicitations.size && !this.auth && !this.queue.inflight &&
      !this.helpersRunning() && !this.backgroundShellsRunning() && !this.landing;
  },

  /** Close the session of a chat another app holds, if nothing would be lost now. true when it let go. */
  async tryRelease(this: Connection, turnEnding = false): Promise<boolean> {
    const e = this.elsewhere;
    if (!e || e.released || this.closed || this.$releasing || this.$replaying || !this.sessionId) return false;
    if (!this.$quietForRelease(turnEnding)) return false;
    this.$releasing = true;
    try {
      await this.request('session/close', { sessionId: this.sessionId }, 15);
      e.released = true;
      e.heldNoted = false;
      this.recordedEvent('studio_note', {
        message: e.line ?? `Continued in ${e.app}. AIB let go of this chat. Open it here to take it back.`,
        sessionId: this.sessionId,
        elsewhere: 'released',
        actions: [{ id: 'elsewhere-open', label: 'Open here' }],
      });
      log.info('chat %s: let go of %s (open in %s, pid %s)', this.id, this.sessionId, e.app, e.pid);
      this.onElsewhere?.(this, 'released');
      return true;
    } catch (error) {
      log.warning('chat %s: closing its session for %s failed: %s', this.id, e.app, errorText(error));
      if (this.elsewhere === e) this.elsewhere = null; // the next scan tries again
      return false;
    } finally {
      this.$releasing = false;
    }
  },

  /** The line of a chat AIB let go of that another app still holds (once per hand-off). */
  $noteHeld(this: Connection, e: Elsewhere, app: string): void {
    e.app = app;
    if (e.heldNoted) return;
    e.heldNoted = true;
    this.recordedEvent('studio_note', {
      message: this.singleWriter
        ? `Still open in ${app}. Close it there first, then choose Open here (Codex lets only one app write to a chat at a time).`
        : `Still open in ${app}. Close it there first, or open it here anyway (two apps writing to one chat can mix up its messages).`,
      sessionId: this.sessionId,
      elsewhere: 'held',
      actions: [this.singleWriter ? { id: 'elsewhere-open', label: 'Open here' } : { id: 'elsewhere-force', label: 'Open here anyway' }],
    });
  },

  /**
   * The person came back to a chat AIB let go of (sent a message, or chose Open here): load its session again when nobody else holds
   * it, or `force` (Open here anyway; not for Codex). Still held: one line with Open here anyway (Codex: Open here), and nothing else
   * happens. 'attached': AIB holds it.
   */
  reclaim(this: Connection, force = false): Promise<{ state: 'attached' | 'back' | 'held'; app?: string; picked?: number }> {
    if (!this.elsewhere?.released) return Promise.resolve({ state: 'attached' });
    if (this.$reclaiming) return this.$reclaiming;
    if (this.singleWriter) force = false;
    const run = (async () => {
      const e = this.elsewhere!;
      const holder = this.holderNow ? await this.holderNow().catch(() => null) : null;
      if (holder && !force) {
        this.$noteHeld(e, holder.app);
        return { state: 'held' as const, app: holder.app };
      }
      if (holder) this.overriddenHolders.add(holder.pid); // Open here anyway: that process no longer makes AIB let go
      try {
        const picked = await this.$reattach(e.app);
        return { state: 'back' as const, app: e.app, picked };
      } catch (error) {
        // Codex refused: another app took the thread's writer lock (one AIB could not see, or since the check)
        if (!this.singleWriter || !activeWriterError(error) || this.elsewhere !== e) throw error;
        log.info('chat %s: %s is open in another app (Codex refused the load)', this.id, this.sessionId);
        this.$noteHeld(e, 'another app');
        return { state: 'held' as const, app: e.app };
      }
    })();
    this.$reclaiming = run;
    return run.finally(() => {
      if (this.$reclaiming === run) this.$reclaiming = null;
    });
  },

  /** session/load again after a hand-off: the turns written elsewhere are shown, the rest of the history the agent sends is not. */
  async $reattach(this: Connection, app: string): Promise<number> {
    this.$reload = { window: new ReplayWindow(), discard: false };
    let result: unknown;
    let replay = new ReplayWindow();
    try {
      result = await this.request('session/load', {
        sessionId: this.sessionId,
        cwd: this.agentCwd,
        mcpServers: this.$acpMcp(this.$sessionMcp),
        ...this.artifactPrompt(this.mcpInConfig() ? this.mcpServers : this.$sessionMcp),
        ...this.extraFolders(),
        ...this.claudeMeta(),
        ...this.codexMeta(),
      }, 180);
    } finally {
      replay = this.$reload?.window ?? replay;
      this.$reload = null;
    }
    const updates = replay.updates;
    if (isDict(result)) {
      this.$withModels(result);
      Object.assign(this.settings, result);
      this.$withModels(this.settings);
    }
    const outside = outsideTurns(updates, this.$lastUserText);
    for (const params of outside.updates) {
      this.$noteUserText(params);
      this.recordedEvent('update', params);
    }
    this.elsewhere = null;
    const n = outside.turns;
    this.recordedEvent('studio_note', {
      message: n ? `AIB took this chat back, with ${n} turn${n === 1 ? '' : 's'} from ${app} above.` : 'AIB took this chat back.',
      sessionId: this.sessionId,
      elsewhere: 'back',
    });
    log.info(
      'chat %s: took %s back (%s outside turn(s) of %s replayed updates, the newest %s kept)',
      this.id,
      this.sessionId,
      n,
      replay.received,
      updates.length,
    );
    this.onElsewhere?.(this, 'back');
    void this.$queuePump(); // messages queued while it was away go now, one per turn
    return n;
  },

  /** Remember the newest user message the agent shows (its consecutive user_message_chunk updates). */
  $noteUserText(this: Connection, params: unknown): void {
    const update = isDict(params) ? get(params, 'update', {}) as Json : {};
    const kind = get(update, 'sessionUpdate');
    const own = !this.sessionId || !isDict(params) || get(params, 'sessionId') === this.sessionId;
    if (!own) return;
    if (kind === 'user_message_chunk') {
      const content = get(update, 'content', {}) as Json;
      if (!this.$inUserText) this.$lastUserText = '';
      this.$inUserText = true;
      if (isDict(content) && content.type === 'text' && isStr(content.text)) this.$lastUserText += content.text;
    } else if (kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' || kind === 'tool_call') {
      this.$inUserText = false;
    }
  },
};

export type HandoffMethods = typeof handoffMethods;
