/**
 * Connection methods: the message queue, scheduled sends and the landing lock.
 * Moved out of connection.ts (no change).
 */
import { MAX_ITEMS, MAX_SCHEDULED, type QueueItem, type SavedItem } from './msgqueue.ts';
import { PromptStateUnknown } from './rpc_errors.ts';
import { clip, isDict, isStr, pyTruthy, ValueError } from '../core/py.ts';
import { log, scheduleStamp, type Json, errorText } from './conn_util.ts';
import { type Receipt } from './conn_types.ts';
import { PROMPT_UNKNOWN } from './conn_steer.ts';
import type { Connection } from './connection.ts';
import { SCHEDULE_LATE_MS } from './conn_limits.ts';

export const queueMethods = {
  // ---- queued messages: written while the agent works, sent one per turn when it ends ---------------------
  $queueChanged(this: Connection): void {
    if (this.$replaying) return; // the saved queue is the old AIB's; a replay must not overwrite it
    const hook = this.recovery;
    if (hook && this.sessionId) {
      try {
        hook.queueChanged(this);
      } catch (error) {
        log.exception(error, 'Saving the message queue failed');
      }
    }
  },

  $knownReceipt(this: Connection, clientMessageId: string): Receipt | null {
    let receipt = this.promptReceipts.get(clientMessageId) ?? null;
    if (!receipt && this.recovery && this.sessionId) {
      receipt = this.recovery.receipt(this, clientMessageId);
    }
    return receipt;
  },

  queuePublic(this: Connection, light = false): Json {
    return this.queue.public(light);
  },

  /**
   * '' when nothing runs in this chat (no turn, nothing queued or being sent), else why not. Running subagents don't count: a lead that
   * always has one background subagent at work would otherwise never be idle, and the finished ones would never land or go.
   */
  landingIdleReason(this: Connection): string {
    if (this.closed || !this.ready) return 'the chat is not open';
    if (this.busy) return 'a turn is running';
    const q = this.queue;
    if (q.inflight || q.items.length || q.steer.length) return 'messages are queued';
    // Other subagents at work (in their own worktrees or not) never hold a landing back (owner 2026-11-24): a finished builder whose
    // commits apply cleanly lands while the others work. Only this chat's own turn and queue count; conflicts are the landing's own.
    return '';
  },

  /**
   * The gate of a builder's landing (a subagent or a helper that finished): '' when its work may land now, even while this chat's turn
   * runs (owner 2026-11-25: it lands soon after the builder ends, and the agent is told through the steer lane). Only what could
   * clash with the files changing under the agent counts: one of its own edit or shell calls still open (the same for every provider:
   * ACP tool calls), or a background shell of this chat that may be reading the folder (a test run, a build). A turn that merely runs,
   * messages waiting, and other subagents at work never hold it back.
   */
  builderLandingReason(this: Connection): string {
    if (this.closed || !this.ready) return 'the chat is not open';
    if (this.busy) {
      for (const [id, seen] of this.$tools) {
        if (!seen.main || seen.parent || seen.turn !== this.promptSeq || this.$bgTools.has(id)) continue;
        if (seen.status === 'completed' || seen.status === 'failed') continue;
        if (seen.edit) return 'the agent is editing a file';
        if (seen.shell) return 'the agent is running a command';
      }
    }
    if (this.backgroundShellsRunning()) return 'a background process is running';
    for (const [id, background] of this.$bgTools) {
      const seen = this.$tools.get(id);
      if (background.state === 'running' && (!seen || (seen.main && !seen.parent))) return 'a background process is running';
    }
    return '';
  },

  /**
   * One step: if the chat is idle, set the lock and answer ''; else the reason, and nothing changes. The same id may take it again
   * (a renewal). It ends by itself after `ttlMs` without a renewal (the web process died mid-landing; its journal finishes the rest).
   */
  landingLock(this: Connection, id: string, owner: string, title: string, ttlMs: number, builder = false): string {
    if (this.landing && this.landing.id !== id) return `“${this.landing.title}” is landing`;
    if (!this.landing) {
      const why = builder ? this.builderLandingReason() : this.landingIdleReason();
      if (why) return why;
      this.landing = { id, owner, title, at: Date.now() / 1000 };
      this.queue.landing = title || 'a helper';
      this.$queueChanged();
    }
    this.$armLanding(id, ttlMs);
    return '';
  },

  landingRenew(this: Connection, id: string, ttlMs: number): boolean {
    if (!this.landing || this.landing.id !== id) return false;
    this.$armLanding(id, ttlMs);
    return true;
  },

  /** Let go: what queued meanwhile goes out now, in order (the steer lane first). False when this id did not hold it. */
  landingRelease(this: Connection, id: string): boolean {
    if (!this.landing || this.landing.id !== id) return false;
    this.landing = null;
    this.queue.landing = '';
    if (this.$landingTimer !== null) clearTimeout(this.$landingTimer);
    this.$landingTimer = null;
    this.$queueChanged();
    void this.$steerPump().then(() => this.$queuePump()).catch((error) => log.exception(error, 'Sending after a landing failed'));
    return true;
  },

  $armLanding(this: Connection, id: string, ttlMs: number): void {
    if (this.$landingTimer !== null) clearTimeout(this.$landingTimer);
    this.$landingTimer = setTimeout(() => {
      this.$landingTimer = null;
      if (this.landing?.id !== id) return;
      log.warning('chat %s: the landing lock of “%s” was not renewed; letting it go', this.id, this.landing.title);
      this.landingRelease(id);
    }, Math.max(1, ttlMs));
  },

  /** A prompt that arrives while a landing holds the chat: it waits in the queue and goes when the landing ends. */
  async $queueForLanding(this: Connection, text: unknown, clientMessageId: string | null, attachments: unknown): Promise<Json> {
    const answer = await this.queueAdd(text, clientMessageId, attachments);
    return { ...answer, accepted: true, landing: this.landing?.title ?? '' };
  },

  /**
   * A chat rebuilt from the keeper: its saved queue goes on as it was (the turn never stopped), so it is not paused; messages sent
   * while it worked go back into the steer lane (a steer the old AIB sent takes its answer from the record, B4).
   */
  async queueContinue(this: Connection, saved: SavedItem[] | unknown): Promise<void> {
    this.queue.load(saved, '', true);
    void this.$steerPump(); // not awaited: a steer the old AIB sent may still wait for the agent's answer
    this.$scheduleArm();
    await this.scheduleTick(); // messages whose time came while AIB was away go now ("sent late"), through the queue
    await this.$queuePump();
  },

  /** After a host restart: the saved queue comes back PAUSED; nothing is sent until the user resumes. */
  queueRestore(this: Connection, saved: SavedItem[] | unknown): void {
    this.queue.load(saved, 'restart');
    this.$scheduleArm();
    void this.scheduleTick().catch((error) => log.exception(error, 'Sending scheduled messages failed'));
  },

  $scheduleTime(this: Connection, at: unknown): number {
    const when = typeof at === 'number' ? at : isStr(at) && at.trim() ? Number(at) : NaN;
    if (!Number.isFinite(when) || when <= 0) throw new ValueError('Pick a date and time');
    const now = this.scheduleNow();
    if (when < now - 5000) throw new ValueError('That time has already passed');
    if (when > now + 366 * 86_400_000) throw new ValueError('Pick a time within the next year');
    return Math.round(when);
  },

  /** Put the text on the schedule. Same payload as queueAdd, plus `at` (epoch ms). */
  async scheduleAdd(this: Connection, text: unknown, at: unknown, clientMessageId: string | null = null, attachments: unknown = null): Promise<Json> {
    this.$refuseReadOnly();
    const [, , , fingerprint] = this.preparePrompt(text, clientMessageId, attachments);
    if (this.closed || !this.ready || !this.sessionId) throw new ValueError('This connection is not ready');
    const q = this.queue;
    const id = clientMessageId || crypto.randomUUID().replaceAll('-', '');
    const known = q.scheduled.find((item) => item.id === id);
    if (known) {
      if (known.fingerprint !== fingerprint) throw new ValueError('This client message ID was already used for different text');
      return { ok: true, duplicate: true, id, at: known.at, queue: q.public() };
    }
    const when = this.$scheduleTime(at);
    if (q.scheduled.length >= MAX_SCHEDULED) throw new ValueError(`At most ${MAX_SCHEDULED} messages can be scheduled`);
    q.scheduled.push({
      id,
      text: text as string,
      attachments: pyTruthy(attachments) ? attachments as unknown[] : [],
      fingerprint,
      queuedAt: Date.now() / 1000,
      at: when,
    });
    q.scheduled.sort((a, b) => a.at - b.at);
    this.$queueChanged();
    this.$scheduleArm();
    return { ok: true, duplicate: false, id, at: when, queue: q.public() };
  },

  /** Change a scheduled message's text, its time, or both. */
  async scheduleEdit(this: Connection, id: string, text: unknown = null, at: unknown = null): Promise<Json> {
    const q = this.queue;
    const item = q.scheduled.find((i) => i.id === id);
    if (!item) throw new ValueError('That message is no longer scheduled (it may already have been sent)');
    if (text !== null && text !== undefined) {
      if (!isStr(text)) throw new ValueError('Message text is required');
      const [, , , fingerprint] = this.preparePrompt(text, null, item.attachments);
      item.text = text;
      item.fingerprint = fingerprint;
    }
    if (at !== null && at !== undefined) {
      item.at = this.$scheduleTime(at);
      delete item.error;
    }
    q.scheduled.sort((a, b) => a.at - b.at);
    this.$queueChanged();
    this.$scheduleArm();
    return { ok: true, queue: q.public() };
  },

  async scheduleCancel(this: Connection, id: string): Promise<Json> {
    const q = this.queue;
    const at = q.scheduled.findIndex((i) => i.id === id);
    if (at < 0) throw new ValueError('That message is no longer scheduled (it may already have been sent)');
    q.scheduled.splice(at, 1);
    this.$queueChanged();
    this.$scheduleArm();
    return { ok: true, queue: q.public() };
  },

  /** The ↑ on a scheduled card: it goes now, as the queue row's Send now does (nothing running is cancelled). */
  async scheduleSendNow(this: Connection, id: string): Promise<Json> {
    const q = this.queue;
    const item = q.scheduled.find((i) => i.id === id);
    if (!item) throw new ValueError('That message is no longer scheduled (it may already have been sent)');
    q.add(item.id, item.text, item.attachments, item.fingerprint);
    q.scheduled.splice(q.scheduled.indexOf(item), 1);
    this.$scheduleArm();
    return await this.queueSendNow(id);
  },

  /** Move every message whose time has come into the after-turn queue and send as the queue allows. Safe to call at any time. */
  async scheduleTick(this: Connection): Promise<void> {
    const q = this.queue;
    if (this.closed || this.$replaying || !this.ready || !this.sessionId || !q.scheduled.length) return;
    const now = this.scheduleNow();
    const due = q.scheduled.filter((i) => i.at <= now);
    if (!due.length) return;
    for (const item of due) {
      if (q.items.length >= MAX_ITEMS) break; // the queue is full: it stays scheduled and goes when there is room
      const queued = q.add(item.id, item.text, item.attachments, item.fingerprint);
      if (now - item.at > SCHEDULE_LATE_MS) queued.late = item.at;
      q.scheduled.splice(q.scheduled.indexOf(item), 1);
    }
    this.$queueChanged();
    await this.$queuePump();
  },

  $scheduleArm(this: Connection): void {
    if (this.$scheduleTimer !== null) clearTimeout(this.$scheduleTimer);
    this.$scheduleTimer = null;
    const q = this.queue;
    if (this.closed || this.$closing || !q.scheduled.length) return;
    const wait = Math.min(Math.max(q.scheduled[0].at - this.scheduleNow(), 0), 30_000);
    const timer = setTimeout(() => {
      this.$scheduleTimer = null;
      this.scheduleTick().catch((error) => log.exception(error, 'Sending scheduled messages failed')).finally(() => this.$scheduleArm());
    }, wait || 250);
    Deno.unrefTimer(timer as unknown as number);
    this.$scheduleTimer = timer;
  },

  /** Same payload as prompt(). A message that arrives while the agent is idle and nothing waits ahead of it is sent right away. */
  async queueAdd(
    this: Connection,
    text: unknown,
    clientMessageId: string | null = null,
    attachments: unknown = null,
  ): Promise<Json> {
    this.$refuseReadOnly();
    const [, , , fingerprint] = this.preparePrompt(
      text,
      clientMessageId,
      attachments,
    );
    if (this.closed || !this.ready || !this.sessionId) {
      throw new ValueError('This connection is not ready');
    }
    const itemId = clientMessageId || crypto.randomUUID().replaceAll('-', '');
    const receipt = clientMessageId ? this.$knownReceipt(itemId) : null;
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
    this.$queueChanged();
    await this.$queuePump();
    const has = this.queue.has(itemId);
    return {
      accepted: true,
      duplicate: false,
      queued: has,
      clientMessageId: itemId,
      turnState: has ? 'queued' : 'working',
      queue: this.queue.public(),
    };
  },

  /**
   * Edit lease on a queued message: acquire (open the editor), renew (editor still open), save (new text, releases), cancel
   * (releases). While the lease is held the message is never sent; if it is the first one, nothing is sent at all.
   */
  async queueEdit(
    this: Connection,
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
    this.$queueChanged();
    await this.$queuePump();
    return { ok: true, queue: this.queuePublic() };
  },

  async queueRemove(this: Connection, itemId: string): Promise<Json> {
    if (this.queue.inflight && this.queue.inflight.id === itemId) {
      throw new ValueError('That message is already being sent');
    }
    this.queue.remove(itemId);
    this.$queueChanged();
    await this.$queuePump();
    return { ok: true, queue: this.queuePublic() };
  },

  async queueMove(this: Connection, itemId: string, toIndex: unknown): Promise<Json> {
    this.queue.move(itemId, toIndex);
    this.$queueChanged();
    await this.$queuePump();
    return { ok: true, queue: this.queuePublic() };
  },

  async queueResume(this: Connection): Promise<Json> {
    this.queue.resume();
    this.$queueChanged();
    await this.$queuePump();
    return { ok: true, queue: this.queuePublic() };
  },

  /** Interrupt the running turn and send this message first. Refused while its editor is open. */
  /** `interrupt`: the composer's "Interrupt and send", which stops the turn on purpose; the queue row's Send now never does. */
  async queueSendNow(this: Connection, itemId: string, interrupt = false): Promise<Json> {
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
    // Owner, 2026-11-16: Send now never stops what runs. When the agent can read a message mid-turn it goes through the steer lane
    // (`_session/steering`): Claude Code moves a running command or foreground helper to the background ("it was not interrupted") and
    // reads the message now; its background helpers go on. An agent that cannot steer (or a slash command, which never goes
    // mid-turn) waits at the front of the queue (owner, 2026-11-23: never cancels).
    // Claude Code's own cycle (steerable(): it takes a prompt in): any message goes through the lane, which prompts it, commands too.
    const ownCycle = this.busy && this.autonomous;
    if (
      !interrupt && this.steerable() && q.steer.length < 50 &&
      (ownCycle || (!this.$isAgentCommand(item.text) && !this.forkSkillRefusal(item.text)))
    ) {
      q.remove(itemId);
      if (!q.items.length && q.hold === 'interrupted') q.hold = '';
      q.steer.push({
        id: item.id,
        text: item.text,
        attachments: item.attachments,
        fingerprint: item.fingerprint,
        queuedAt: item.queuedAt,
        state: 'sending',
        heldReason: '',
      });
      this.$queueChanged();
      void this.$steerPump(); // the lane shows it as sending; the route never waits for the agent's answer
      return { ok: true, steered: true, queue: this.queuePublic() };
    }
    q.move(itemId, 0);
    item.lease = null;
    q.hold = '';
    // Owner, 2026-11-23: Send now never cancels running work. An agent that cannot steer keeps the message at the front of the
    // queue and gets it the moment this turn ends ($queueAfterTurn pumps). Only the composer's explicit "Interrupt and send" cancels.
    const cancelling = interrupt && this.busy;
    q.sendNow = cancelling;
    this.$queueChanged();
    if (cancelling) {
      this.cancel();
      if (!this.busy) this.queue.sendNow = false; // the turn ended on its own meanwhile
    }
    await this.$queuePump();
    return { ok: true, queue: this.queuePublic() };
  },

  /** A turn just ended: decide whether the queue must wait for the user. Runs before the turn's own requests are withdrawn. */
  $queueNoteOutcome(this: Connection, result: unknown, failed: boolean): void {
    const q = this.queue;
    if (q.sendNow || !q.items.length || q.hold) return;
    const needs = this.permissions.size + this.elicitations.size +
      (this.auth ? 1 : 0);
    if (failed) q.hold = 'error';
    else if (needs) q.hold = 'needs_you';
    else if (isDict(result) && result.stopReason === 'cancelled' && this.cancelSeq >= this.promptSeq) {
      // B14: only the user's own Interrupt pauses the queue; a 'cancelled' the agent reports on its own (after a steer) does not.
      q.hold = 'interrupted';
    }
  },

  async $queueAfterTurn(this: Connection): Promise<void> {
    if (this.queue.sendNow) {
      this.queue.sendNow = false;
      this.queue.hold = '';
    }
    if (this.elsewhere && this.queue.steer.length) {
      // open elsewhere: AIB let go (or is about to): what still waits in the steer lane is kept in the queue, never sent elsewhere's way
      const waiting = this.queue.steer.splice(0);
      this.$steerToQueue(waiting, `Not sent: this chat is open in ${this.elsewhere.app}.`);
    }
    this.$queueChanged();
    await this.$steerPump(); // the steer lane first: a message the agent could not take mid-turn goes now, as a prompt
    await this.$queuePump();
  },

  async $queuePump(this: Connection): Promise<void> {
    let asked = false;
    while (true) {
      if (this.$replaying || this.rebuildError) return;
      const q = this.queue;
      if (
        this.closed || !this.ready || this.busy || !this.sessionId || this.landing || this.elsewhere ||
        q.inflight || !q.items.length || q.pauseReason() || q.steer.length // the steer lane goes first
      ) return;
      if (this.permissions.size || this.elicitations.size || this.auth) return;
      if (this.$steerLate.has(q.items[0].id)) return; // its steer may still land ($steerLateAnswer), which then pumps again
      // the best moment to restart a stale chat: right before a queued or scheduled message goes out (restart first, then send)
      if (this.$restartAsked) return; // another pump pass is asking AIB now
      if (this.beforeQueuedSend && !asked) {
        asked = true;
        this.$restartAsked = true;
        let replaced = false;
        try {
          replaced = await this.beforeQueuedSend();
        } catch (error) {
          log.exception(error, 'Restarting a stale chat before a queued message failed');
        } finally {
          this.$restartAsked = false;
        }
        if (replaced || this.closed) return; // the restarted chat sends the queue it was given
        continue; // re-check every guard: the chat may have changed while it was asked
      }
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
            'AIB cannot tell whether this one was already sent. Remove it, or press Resume to send it again.',
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
      if (!failure && item.late && !(result ?? {}).duplicate) { // a scheduled message that went out after its time
        this.recordedEvent('studio_note', { message: `Sent late (scheduled ${scheduleStamp(item.late)})`, sessionId: this.sessionId });
      }
      if (failure) {
        item.note = failure[0] ? failure[1] : '';
        q.items.unshift(item);
        if (failure[0]) q.hold = failure[0];
      }
      this.$queueChanged();
      if (failure || !(result ?? {}).duplicate || this.busy) return;
    }
  },
};

export type QueueMethods = typeof queueMethods;
