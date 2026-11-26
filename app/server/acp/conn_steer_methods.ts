/**
 * Connection methods: steering (sending while the agent works): lanes, steer sends, late answers, unread steers.
 * Moved out of connection.ts (no change).
 */
import { type HeldCard, STEER_RESTART_NOTE, type SteerItem } from './msgqueue.ts';
import { PromptStateUnknown } from './rpc_errors.ts';
import { type FileSummary, type ImageBlock } from './attachments.ts';
import { isCodexFamily } from '../agents/claude_family.ts';
import { clip, isDict, isStr, pyRepr, pyStrip, pyTruthy, ValueError } from '../core/py.ts';
import { log, type Json, errorText, get, within } from './conn_util.ts';
import { PROMPT_UNKNOWN, steerTiming, STEER_FAILED_NOTE, CODEX_UNREAD_NOTE } from './conn_steer.ts';
import type { Connection } from './connection.ts';

export const steerMethods = {
  // ---- messages sent while the agent works: the steer lane (steer-on-send) ----------------------------------------------------
  /** `_meta.steering.supported` of the initialize result (top level, where the three adapters put it, or under agentCapabilities). */
  steeringSupported(this: Connection): boolean {
    const initial = isDict(this.initial) ? this.initial : {};
    const caps = get(initial, 'agentCapabilities');
    for (const holder of [get(initial, '_meta'), isDict(caps) ? get(caps, '_meta') : null]) {
      const steering = isDict(holder) ? get(holder, 'steering') : null;
      if (isDict(steering) && steering.supported === true) return true;
    }
    return false;
  },

  /**
   * What the composer keys on (snapshot `steerable`): the agent works and can read a message now. A prompt turn of ours, with an
   * agent that can steer; or a cycle Claude Code started on its own (a background task ended): `_session/steering` would answer
   * promptRequired there (claude-agent-acp steers only a prompt's turn, and the cycle is none), but a session/prompt is folded into
   * the cycle, which it takes over ("A prompt folded into an autonomous turn owns that turn now"), and nothing running stops. So
   * Send now prompts it (steer(), $steerLane). Codex starts no cycles of its own; one seen anyway is not steered.
   */
  steerable(this: Connection): boolean {
    if (!this.busy || !this.ready || this.closed || this.rebuildError) return false;
    return this.autonomous ? this.$autonomousTakesPrompt() : this.steeringSupported();
  },

  /** Claude Code's own cycle takes a prompt in (see steerable()). */
  $autonomousTakesPrompt(this: Connection): boolean {
    return this.$claudeHolds();
  },

  /** Is this open card a subagent's (a helper inside this chat), not the main agent's own? */
  $cardIsHelpers(this: Connection, params: unknown): boolean {
    if (!isDict(params)) return false;
    const session = get(params, 'sessionId');
    if (isStr(session) && session && this.sessionId && session !== this.sessionId) return true;
    const call = get(params, 'toolCall');
    if (!isDict(call)) return false;
    const meta = get(call, '_meta');
    const claude = isDict(meta) ? get(meta, 'claudeCode') : null;
    const parent = isDict(claude) ? get(claude, 'parentToolUseId') : null;
    if (isStr(parent) && parent) return true;
    const id = get(call, 'toolCallId');
    const seen = isStr(id) ? this.$tools.get(id) : undefined;
    return !!(seen && (seen.parent || !seen.main));
  },

  /**
   * The open cards a message sent now waits for (owner decision 5), oldest first; none: it may go in. Codex is not recorded with a card open: every card holds. Claude Code
   * (claude-agent-acp) delivers a steer at priority `later` while the SDK awaits an answer, which leaves the card open (recording
   * C4, IJAI-1191): a subagent's card does not hold it (owner, 2026-11-17), the main agent's own still does (decision 5).
   */
  $steerHolds(this: Connection): HeldCard[] {
    const past = this.$claudeHolds();
    const out: HeldCard[] = [];
    const clean = (t: unknown): string => isStr(t) ? t.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    const title = (params: unknown, card: 'approval' | 'question'): string => {
      if (!isDict(params)) return '';
      if (card === 'question') return clean(get(params, 'message'));
      const call = get(params, 'toolCall');
      return isDict(call) ? clean(get(call, 'title')) : '';
    };
    for (const [card, map] of [['approval', this.permissions], ['question', this.elicitations]] as const) {
      for (const v of map.values()) {
        if (past && this.$cardIsHelpers(v.params)) continue;
        const session = isDict(v.params) ? get(v.params, 'sessionId') : null;
        out.push({ card, title: title(v.params, card), sessionId: isStr(session) ? session : null, route: this.route(session) });
      }
    }
    return out;
  },

  /**
   * Claude Code aborts the foreground shell command a steer meets instead of moving it to the background (recordings with
   * claude-agent-acp 0.97 and 0.102; the adapter always steers at priority `now`). Owner rule: Send now never cancels running work.
   * So while the main agent's own foreground command runs, a message waits (held, "Sends when the running command finishes") and goes
   * in at the command's end (tool update completed/failed or moved to the background). Codex's steer queues input without touching
   * a running command, so it is not held.
   */
  $runningCommand(this: Connection): HeldCard | null {
    if (!this.$claudeHolds()) return null;
    for (const [id, seen] of this.$tools) {
      if (!seen.shell || !seen.main || seen.parent || seen.turn !== this.promptSeq || this.$bgTools.has(id)) continue;
      if (seen.status === 'completed' || seen.status === 'failed') continue;
      return { card: 'command', title: (seen.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120), sessionId: null, route: 'main' };
    }
    return null;
  },

  /** A slash command the agent offers (or /doc): never sent into a running turn, it waits for the turn to end (B17). */
  $isAgentCommand(this: Connection, text: unknown): boolean {
    if (!isStr(text)) return false;
    const m = /^\/(\S+)/.exec(pyStrip(text));
    if (!m) return false;
    return m[1] === 'doc' || this.breadth.commands.some((c) => c.name === m[1]);
  },

  /**
   * Send now (POST /api/live/steer; Enter in the composer, a typed inbox or phone reply). Same payload as prompt(). AIB decides:
   *   idle (or Claude Code's own cycle)        an ordinary prompt                                   state 'prompted'
   *   working, the agent can steer             `_session/steering` now, through the steer lane      'injected' / 'sending' / 'fallback'
   *   working, an approval or question open    held until it is answered (owner decision 5)        'held'
   *   working, no steering, or a slash command  the after-turn queue, as today                       'queued'
   * Retrying the same clientMessageId never sends twice.
   */
  async steer(this: Connection, text: unknown, clientMessageId: string | null = null, attachments: unknown = null): Promise<Json> {
    this.$refuseReadOnly();
    const [, , , fingerprint] = this.preparePrompt(text, clientMessageId, attachments);
    if (this.closed || !this.ready || !this.sessionId) throw new ValueError('This connection is not ready');
    const id = clientMessageId || crypto.randomUUID().replaceAll('-', '');
    const q = this.queue;
    const inLane = q.findSteer(id);
    const queued = q.find(id) ?? (q.inflight && q.inflight.id === id ? q.inflight : null);
    const receipt = clientMessageId ? this.$knownReceipt(id) : null;
    if (inLane || queued || receipt) {
      const known = inLane ? inLane.fingerprint : queued ? queued.fingerprint : receipt!.fingerprint;
      if (known !== fingerprint) throw new ValueError('This client message ID was already used for different text');
      if (!inLane && !queued && receipt!.state === 'unknown') throw new PromptStateUnknown(PROMPT_UNKNOWN);
      return this.$steerAnswer(id, true);
    }
    const working = this.busy && !this.autonomous;
    if (working && (this.$isAgentCommand(text) || this.forkSkillRefusal(text) || !this.steeringSupported())) {
      await this.queueAdd(text, id, attachments);
      return this.$steerAnswer(id, false);
    }
    if (!working && !q.steer.length) {
      await this.prompt(text, id, attachments);
      return this.$steerAnswer(id, false);
    }
    if (q.steer.length >= 50) throw new ValueError('At most 50 messages can wait to be sent');
    q.steer.push({
      id,
      text: text as string,
      attachments: pyTruthy(attachments) ? attachments as unknown[] : [],
      fingerprint,
      queuedAt: Date.now() / 1000,
      state: 'sending',
      heldReason: '',
    });
    this.$queueChanged();
    await this.$steerPump();
    return this.$steerAnswer(id, false);
  },

  /** The steer route's answer: where message `id` is now (state, see steer()), with the lanes. */
  $steerAnswer(this: Connection, id: string, duplicate: boolean): Json {
    const q = this.queue;
    const inLane = q.findSteer(id);
    const receipt = this.$knownReceipt(id);
    let state: string;
    if (inLane) state = inLane.state;
    else if (q.find(id) || (q.inflight && q.inflight.id === id)) state = 'queued';
    else if (receipt?.state === 'injected') state = 'injected';
    else state = 'prompted';
    return {
      accepted: true,
      duplicate,
      clientMessageId: id,
      id,
      state,
      turnState: receipt ? receipt.state : state === 'queued' ? 'queued' : 'working',
      steerLane: q.steerPublic(),
      queue: q.public(),
    };
  },

  /** Run the steer lane: one item at a time, in order. Concurrent calls join the running pass (which then looks once more). */
  $steerPump(this: Connection): Promise<void> {
    if (this.$steerRun) {
      this.$steerAgain = true;
      return this.$steerRun;
    }
    const run = (async () => {
      try {
        do {
          this.$steerAgain = false;
          await this.$steerLane();
        } while (this.$steerAgain);
      } catch (error) {
        log.exception(error, 'Sending a message to the running turn failed');
      } finally {
        this.$steerRun = null;
      }
    })();
    this.$steerRun = run;
    return run;
  },

  async $steerLane(this: Connection): Promise<void> {
    const q = this.queue;
    while (true) {
      if (this.$replaying || this.rebuildError || this.closed || !this.ready || !this.sessionId) return;
      const head = q.steer[0];
      if (!head) return;
      if ((!this.busy || this.autonomous) && this.landing) return; // a landing holds the folder: it goes when that lets go
      if (!this.busy || this.autonomous) {
        // Idle (or Claude Code's own cycle, which a prompt takes over): the first goes as an ordinary prompt and the rest are steered
        // into its turn (B9). A helper's open card does not hold it: the main agent is idle (owner, 2026-11-12).
        q.steer.shift();
        if (head.state === 'fallback') {
          // The agent said it did not take it (promptRequired): safe to send, even when a restart left its receipt "unknown".
          this.promptReceipts.set(head.id, { fingerprint: String(head.fingerprint), state: 'steering' });
        }
        try {
          await this.prompt(head.text, head.id, head.attachments.length ? head.attachments : null);
        } catch (error) {
          const unknown = error instanceof PromptStateUnknown;
          if (!unknown) log.warning('Sending a held message failed: %s', errorText(error));
          this.$steerToQueue([head], unknown ? STEER_RESTART_NOTE : clip(errorText(error), 300), unknown ? 'unknown' : 'error');
        }
        this.$queueChanged();
        continue;
      }
      if (head.state === 'fallback') return; // B2: the agent's turn is over; it goes as a prompt once AIB has finished that turn
      const holds = this.$steerHolds();
      const running = holds.length ? null : this.$runningCommand();
      if (running) holds.push(running);
      if (holds.length) {
        // Owner decision 5 (B8): never steered while an approval or question is open except a Claude
        // Code subagent's ($steerHolds). The row names the card it waits for. Released by any close of the last card that holds it
        // ($cardsChanged), and by the turn's end ($queueAfterTurn).
        const first = holds[0];
        let changed = false;
        for (const item of q.steer) {
          if (item.state !== 'sending' && item.state !== 'held') continue;
          const was = JSON.stringify([item.state, item.heldReason, item.heldFor]);
          item.state = 'held';
          item.heldReason = first.card;
          item.heldFor = { ...first };
          if (JSON.stringify([item.state, item.heldReason, item.heldFor]) !== was) changed = true;
        }
        if (changed) this.$queueChanged();
        return;
      }
      if (!this.steeringSupported()) { // cannot happen for a chat that took a steer; kept safe: they wait for the turn to end
        const all = q.steer;
        q.steer = [];
        this.$steerToQueue(all, '');
        this.$queueChanged();
        return;
      }
      if (!this.$promptOut.isSet()) { // the prompt that started this turn is not written yet: a steer now would find no turn
        await this.$promptOut.wait(30000);
        continue;
      }
      let changed = false;
      for (const item of q.steer) {
        if (item.state === 'held') {
          item.state = 'sending';
          item.heldReason = '';
          item.heldFor = null;
          changed = true;
        }
      }
      if (changed) this.$queueChanged();
      const seq = this.promptSeq;
      this.$steerInflight = head;
      let outcome: string;
      try {
        const replayed = this.$replayedSteers.get(head.id);
        this.$replayedSteers.delete(head.id);
        outcome = replayed
          ? ((await within(replayed, steerTiming.steerTimeoutSeconds * 1000)) || 'failed')
          : await this.$sendSteer(head);
      } finally {
        this.$steerInflight = null;
      }
      const index = q.steer.indexOf(head);
      if (index >= 0) {
        if (outcome === 'injected') q.steer.splice(index, 1);
        else if (outcome === 'promptRequired' && this.cancelSeq < seq) head.state = 'fallback';
        else if (outcome === 'promptRequired') { // the user interrupted meanwhile: it waits with the others, paused
          q.steer.splice(index, 1);
          this.$steerToQueue([head], '', 'interrupted');
        } else {
          q.steer.splice(index, 1);
          this.$steerToQueue([head], STEER_FAILED_NOTE);
        }
      }
      this.$queueChanged();
    }
  },

  /**
   * One `_session/steering` (always with idleBehavior promptRequired: without it Claude Code starts a turn AIB never asked for,
   * recording C3). Carries the <studio-context> note like a prompt (B12; no turn-start hook: no turn starts). Returns 'injected',
   * 'promptRequired' or 'failed'. In the keeper the steer note goes first and the once-key stops a resend (B4).
   */
  async $sendSteer(this: Connection, item: SteerItem): Promise<string> {
    let images: ImageBlock[];
    let fileBlocks: Json[];
    let files: FileSummary[];
    try {
      [images, fileBlocks, files] = this.preparePrompt(item.text, null, item.attachments.length ? item.attachments : null);
    } catch (error) {
      log.warning('A held message can no longer be sent: %s', errorText(error));
      return 'failed';
    }
    let context: [string, unknown] | null = null;
    const provider = this.contextForPrompt;
    if (provider) {
      try {
        const made = await provider(this);
        context = pyTruthy(made) ? made as [string, unknown] : null;
      } catch (error) {
        log.exception(error, 'The note for the prompt could not be made');
      }
    }
    if (this.onUserPrompt) {
      try {
        this.onUserPrompt(this, item.text, item.id);
      } catch (error) {
        log.exception(error, 'on_user_prompt hook failed');
      }
    }
    const blocks = [
      ...(context ? [{ type: 'text', text: context[0] }] : []),
      ...(pyStrip(item.text) ? [{ type: 'text', text: item.text }] : []),
      ...fileBlocks,
      ...images,
    ];
    this.promptReceipts.set(item.id, { fingerprint: String(item.fingerprint), state: 'steering' });
    while (this.promptReceipts.size > 1000) this.promptReceipts.delete(this.promptReceipts.keys().next().value!);
    this.$receiptChanged(item.id);
    // The request may answer after the lane gave up on it (steerTimeoutSeconds): the late answer is still read ($steerLateAnswer).
    const answer: Promise<{ result?: unknown; error?: unknown }> = this.request('_session/steering', {
      sessionId: this.sessionId,
      prompt: blocks,
      _meta: { steering: { idleBehavior: 'promptRequired' } },
    }, steerTiming.steerLateSeconds, {
      note: (rpc) => ({ t: 'steer', rpc, receipt: item.id, text: item.text, files, fingerprint: item.fingerprint }),
      once: `steer:${item.id}`,
    }).then((result) => ({ result }), (error) => ({ error }));
    const first = await within(answer, steerTiming.steerTimeoutSeconds * 1000);
    if (first === false) {
      log.warning('chat %s: the agent did not answer a message sent while it works within %s s', this.id, steerTiming.steerTimeoutSeconds);
      this.$steerLateAnswer(item, answer, images, files, context);
      return 'failed';
    }
    if (Object.hasOwn(first, 'error')) {
      log.warning('The agent did not take a message sent while it works: %s', errorText(first.error));
      return 'failed';
    }
    const outcome = isDict(first.result) ? first.result.outcome : null;
    if (outcome === 'injected' || outcome === 'startedNewTurn') {
      if (outcome === 'startedNewTurn') log.warning('chat %s: the agent started a turn of its own for a steer', this.id);
      this.$steerLanded(item.id, item.text, images, files, String(item.fingerprint), item);
      void this.$aibContextSent(context);
      return 'injected';
    }
    if (outcome === 'promptRequired') return 'promptRequired';
    log.warning('chat %s: a steer came back %s', this.id, pyRepr(outcome));
    return 'failed';
  },

  /**
   * A steer that timed out goes to the after-turn queue with its id ($steerLane), but stays unsent there ($queuePump) until its answer
   * comes: taken (injected) → it leaves the queue and shows as sent while working, as if it had answered in time; anything else (not
   * taken, an error, steerLateSeconds with no answer) → it is free to go after the turn, with the same id.
   */
  $steerLateAnswer(
    this: Connection,
    item: SteerItem,
    answer: Promise<{ result?: unknown; error?: unknown }>,
    images: ImageBlock[],
    files: FileSummary[],
    context: [string, unknown] | null,
  ): void {
    this.$steerLate.add(item.id);
    void answer.then((late) => {
      this.$steerLate.delete(item.id);
      const outcome = !Object.hasOwn(late, 'error') && isDict(late.result) ? late.result.outcome : null;
      if ((outcome === 'injected' || outcome === 'startedNewTurn') && !this.closed) {
        const q = this.queue;
        const at = q.items.findIndex((i) => i.id === item.id);
        if (at >= 0) q.items.splice(at, 1);
        log.info('chat %s: the agent took message %s late; it is not sent again', this.id, item.id);
        this.$steerLanded(item.id, item.text, images, files, String(item.fingerprint), item);
        void this.$aibContextSent(context);
      } else {
        log.info('chat %s: the late answer to message %s: not taken (%s)', this.id, item.id, pyRepr(outcome));
      }
      this.$queueChanged();
      void this.$queuePump();
    });
  },

  /**
   * The agent took a steered message: it shows as the user's bubble (no adapter echoes it), tagged `steered` ("Sent while working"),
   * and its receipt is final. Live and on a keeper rebuild alike, right where the answer is in the record.
   */
  $steerLanded(this: Connection, id: string, text: string, images: ImageBlock[], files: FileSummary[], fingerprint: string, item?: SteerItem): void {
    const receipt = this.promptReceipts.get(id);
    if (receipt) receipt.state = 'injected';
    else this.promptReceipts.set(id, { fingerprint, state: 'injected' });
    this.promptReceipts.get(id)!.sent = true;
    this.$receiptChanged(id);
    const userEvent: Json = { text, attachments: images, sessionId: this.sessionId, clientMessageId: id, steered: true };
    if (files.length) userEvent.files = files;
    this.event('user', userEvent);
    if (!this.busy || this.autonomous) return;
    this.$steerTurn.injected += 1;
    this.$steerTurn.outputAfter = false;
    this.$clearSettle();
    if (item && isCodexFamily(this.provider)) this.$steerTurn.unread.push(item);
  },

  /**
   * B13: codex-acp v1 can drop a steer that lands as its turn completes. A steer with no main-session output after it by the turn's
   * end goes back in the queue, paused, with a note (a new id, so Resume really sends it again).
   */
  $steerUnread(this: Connection): void {
    const unread = this.$steerTurn.unread;
    this.$steerTurn.unread = [];
    if (!unread.length) return;
    const q = this.queue;
    q.items.unshift(...unread.map((i) => ({
      id: crypto.randomUUID().replaceAll('-', ''),
      text: i.text,
      attachments: i.attachments,
      fingerprint: i.fingerprint,
      queuedAt: Date.now() / 1000,
      lease: null,
      note: CODEX_UNREAD_NOTE,
    })));
    q.hold = 'unknown';
    this.$queueChanged();
  },

  /** Steer-lane items into the after-turn queue, at its front (after an item being sent now), in order. */
  $steerToQueue(this: Connection, items: SteerItem[], note: string, hold = ''): void {
    if (!items.length) return;
    const q = this.queue;
    const at = q.sendNow ? Math.min(1, q.items.length) : 0;
    q.items.splice(at, 0, ...items.map((i) => ({
      id: i.id,
      text: i.text,
      attachments: i.attachments,
      fingerprint: i.fingerprint,
      queuedAt: i.queuedAt,
      lease: null,
      note,
    })));
    if (hold && !q.sendNow && !q.hold) q.hold = hold;
  },

  /** Interrupt (B8): what waits in the steer lane moves to the after-turn queue, paused; a steer in flight is decided by its answer. */
  $laneInterrupted(this: Connection): void {
    const q = this.queue;
    const inflight = this.$steerInflight && q.steer.includes(this.$steerInflight) ? this.$steerInflight : null;
    const moved = q.steer.filter((i) => i !== inflight);
    if (!moved.length) return;
    q.steer = inflight ? [inflight] : [];
    this.$steerToQueue(moved, '', 'interrupted');
    this.$queueChanged();
  },

  /** An approval or question was answered or withdrawn: with none left that holds them, held messages go now (B8); else their
   *  rows name the card they wait for now ($steerLane). */
  $cardsChanged(this: Connection): void {
    if (!this.queue.steer.length) return;
    void this.$steerPump();
  },
};

export type SteerMethods = typeof steerMethods;
