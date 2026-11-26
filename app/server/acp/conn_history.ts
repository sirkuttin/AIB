/**
 * Connection methods: snapshots, the history store (queue, flush, finish, adopt, take over) and its checkpoints.
 * Moved out of connection.ts (no change).
 */
import { arraySource, type Ev, page, type Page, type PageQuery } from './event_pages.ts';
import type { Checkpoint, StoredEvent, StoreEvent } from '../history/store.ts';
import { eventImageSize, MAX_EVENT_IMAGE_BYTES } from './attachments.ts';
import type { ChannelInfo } from '../keeper/client.ts';
import { type KeeperChannel } from '../keeper/link.ts';
import { isDict, isInt, isStr, pyStrip } from '../core/py.ts';
import { log, MAX_EVENTS, type Json, errorText, ENCODER } from './conn_util.ts';
import { type SnapshotPlan, type ContinueStore } from './conn_types.ts';
import { SNAPSHOT_VERSION, MAX_SNAPSHOT_BYTES, HISTORY_FLUSH_MS, HISTORY_HELPER_TAIL, EVENT_CHUNK_BYTES } from './conn_limits.ts';
import { ReplayWindow, outsideTurns } from './replay_window.ts';
import type { Connection } from './connection.ts';

export const historyMethods = {
  /** Take a snapshot once the record queue has handled what it holds now (so `upTo` is exact). */
  $scheduleSnapshot(this: Connection): void {
    if (!this.channel || this.$replaying || this.$snapshotQueued) return;
    this.$snapshotQueued = true;
    this.$enqueue(() => {
      this.$snapshotQueued = false;
      return this.$writeSnapshot();
    });
  },

  /** Nothing is in flight: no turn, request, question, sign-in or held answer, and no line half read. */
  $quiet(this: Connection): boolean {
    return this.ready && !this.busy && !this.closed && !this.$replaying && !this.rebuildError && !this.auth &&
      this.pending.size === 0 && this.permissions.size === 0 && this.elicitations.size === 0 && !this.$deferred.length &&
      !this.$held.length && this.$outLines.idle && this.$errLines.idle;
  },

  /** The chat's state for a snapshot note, without its event history (that goes in chunks: see $snapshotPlan). */
  $snapshotState(this: Connection): Json {
    return {
      initial: this.initial,
      sessionId: this.sessionId,
      ready: this.ready,
      settings: this.settings,
      knownSessions: [...this.knownSessions],
      counter: this.counter,
      promptSeq: this.promptSeq,
      ownerTouched: this.ownerTouched,
      cancelSeq: this.cancelSeq,
      changeSeq: this.changeSeq,
      changeFailures: this.changeFailures,
      turnEndedAt: this.turnEndedAt,
      // The history kept: events from eventsFrom to sequence, stored in this note and the chunk notes before it (and earlier ones).
      eventsFrom: this.events.length ? this.events[0].seq : this.sequence + 1,
      sequence: this.sequence,
      subagents: [...this.subagents],
      liveHelpers: [...this.$liveHelpers],
      helperSince: [...this.$helperSince],
      bgShells: [...this.$bgShells],
      shellSince: [...this.$shellSince],
      turnFailedAt: this.turnFailedAt,
      turnError: this.turnError,
      asks: this.$asks,
      stall: this.$stall,
      lastStep: this.$lastStep,
      workEndedAt: this.$workEndedAt,
      bgTools: [...this.$bgTools],
      breadth: { ...this.breadth, compaction: [...this.breadth.compaction] },
      writes: { paths: [...this.writes.paths], calls: [...this.writes.calls] },
      promptReceipts: [...this.promptReceipts],
      requestsSeen: [...this.$requestsSeen],
      withdrawn: [...this.withdrawn],
      stderr: this.stderr,
      eventsId: this.eventsId,
    };
  },

  /**
   * What a snapshot writes now: the events made since the last one, cut into chunks of at most EVENT_CHUNK_BYTES (the last one goes
   * inside the snapshot note when it fits), and the snapshot note. null when the state alone is too large to store.
   */
  $snapshotPlan(this: Connection): SnapshotPlan | null {
    const note: Json = { t: 'snapshot', sv: SNAPSHOT_VERSION, upTo: this.$lastSeq, chat: this.$chatNote(), state: this.$snapshotState() };
    const stateBytes = ENCODER.encode(JSON.stringify(note)).length;
    if (stateBytes > MAX_SNAPSHOT_BYTES - 1024) return null;
    const groups: { events: Json[]; bytes: number }[] = [];
    let group: { events: Json[]; bytes: number } = { events: [], bytes: 0 };
    for (const event of this.events) {
      if ((event.seq as number) <= this.$eventsSaved) continue;
      let stored = event;
      let bytes = ENCODER.encode(JSON.stringify(event)).length + 1;
      if (bytes > MAX_SNAPSHOT_BYTES - 1024) { // one agent message larger than a note: its place in the history says so after a restart
        stored = {
          seq: event.seq,
          kind: 'studio_note',
          time: event.time,
          data: { message: 'An agent message too large to keep across a restart was left out here.' },
        };
        bytes = ENCODER.encode(JSON.stringify(stored)).length + 1;
      }
      if (group.events.length && group.bytes + bytes > EVENT_CHUNK_BYTES) {
        groups.push(group);
        group = { events: [], bytes: 0 };
      }
      group.events.push(stored);
      group.bytes += bytes;
    }
    if (group.events.length) groups.push(group);
    const inline = groups.length && stateBytes + groups.at(-1)!.bytes <= MAX_SNAPSHOT_BYTES - 1024 ? groups.pop()! : null;
    note.events = inline ? inline.events : [];
    return {
      chunks: groups.map((g) => ({ t: 'event', chunk: 1, events: g.events })),
      note,
      bytes: stateBytes + (inline ? inline.bytes : 0),
      chunkBytes: groups.reduce((sum, g) => sum + g.bytes, 0),
      last: this.sequence,
    };
  },

  /** The snapshot note a snapshot now would write (with the events since the last one), or null when it is too large to store. */
  snapshotNote(this: Connection): Json | null {
    return this.$snapshotPlan()?.note ?? null;
  },

  /**
   * Write a snapshot note when the chat is quiet (a turn just ended), then let the keeper drop the journal segments before it
   * (truncate), so a rebuild reads and replays only what came after, plus the chunks the kept history is in. Never throws.
   */
  async $writeSnapshot(this: Connection): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.lost || !this.$quiet() || !this.$lastSeq) return;
    // A new chat's store may still be opening (the Worker starts with the first chat): its first flush claims it.
    if (this.historyState === 'open' && channel.epoch > 0) await this.$historyFlush();
    if (this.historyState === 'claimed') return this.$writeCheckpoint(channel);
    if (this.historyState === 'open') return; // not ours yet: the next quiet point checkpoints (no chunk notes meanwhile)
    let plan: SnapshotPlan | null;
    try {
      plan = this.$snapshotPlan();
    } catch (error) {
      log.exception(error, 'keeper: making a snapshot failed');
      return;
    }
    if (!plan) {
      log.warning('keeper: %s: the snapshot would be larger than %s bytes; not written', this.id, MAX_SNAPSHOT_BYTES);
      return;
    }
    // All sent at once, in order, before anything AIB writes after this moment (a write after the note is replayed; one before is not).
    const stored = await Promise.all([...plan.chunks, plan.note].map((n) => channel.snapshot(n)));
    const seq = stored.at(-1);
    if (!seq || stored.some((s) => s === null)) return; // tried again at the next quiet moment (a stored chunk is then just repeated)
    const lastOf = (events: unknown) => (events as Json[]).at(-1)!.seq as number;
    plan.chunks.forEach((chunk, i) => this.$eventChunks.push([stored[i]!, lastOf(chunk.events)]));
    if ((plan.note.events as Json[]).length) this.$eventChunks.push([seq, lastOf(plan.note.events)]);
    this.$eventsSaved = plan.last;
    const first = this.events.length ? this.events[0].seq as number : Infinity;
    this.$eventChunks = this.$eventChunks.filter(([, last]) => last >= first);
    this.snapshots += 1;
    this.snapshotBytes = plan.bytes;
    this.snapshotChunkBytes = plan.chunkBytes;
    // Records after upTo are still needed (they may come before the note), and so are the chunks the kept history is in.
    const after = (plan.note.upTo as number) + 1;
    await channel.truncate(this.$eventChunks.length ? Math.min(this.$eventChunks[0][0], after) : after);
  },

  // ---- the history store (history-loading design 3.1-3.5) -------------------------------------------------------------------
  /** The event as the store keeps it: whose it is (null: the chat's own; a helper's session id). */
  $historyItem(this: Connection, item: Json): Json {
    const data = item.data;
    const sid = isDict(data) && isStr(data.sessionId) && data.sessionId ? data.sessionId : null;
    return { ...item, session: sid && this.sessionId && sid !== this.sessionId ? sid : null };
  },

  $historyQueueEvent(this: Connection, item: Json): void {
    this.$historyQueue.push(this.$historyItem(item));
    this.$historySchedule();
  },

  $historySchedule(this: Connection): void {
    if (this.$historyTimer !== null) return;
    const timer = setTimeout(() => {
      this.$historyTimer = null;
      void this.$historyFlush();
    }, HISTORY_FLUSH_MS);
    Deno.unrefTimer(timer as unknown as number);
    this.$historyTimer = timer;
  },

  /**
   * A new chat: a store of its own, claimed once the spawn has an epoch. A reopened chat opens the store it goes on in. A leftover
   * file under a new chat's id (ids are random: in practice never) is not this chat's history: it is archived, never just deleted.
   */
  async $historyOpenNew(this: Connection): Promise<void> {
    const h = this.$history!;
    try {
      if (!this.$continueCkpt) {
        const copy = await h.archive(this.id, 'leftover');
        if (copy) log.warning('history: %s: a leftover store under this new chat id was kept as %s', this.id, copy);
      }
      this.$historyOpened = await h.open(this.id, { eventsId: this.eventsId, mainSession: this.sessionId });
    } catch (error) {
      this.$historyFailed(error);
    }
  },

  /** Commit the queued events (moves written_seq only). True when everything queued is in the store. Writes run one at a time. */
  $historyFlush(this: Connection): Promise<boolean> {
    const run = this.$historyChain.then(() => this.$historyFlushNow());
    this.$historyChain = run.catch(() => {});
    return run;
  },

  async $historyFlushNow(this: Connection): Promise<boolean> {
    if (this.$historyTimer !== null) {
      clearTimeout(this.$historyTimer);
      this.$historyTimer = null;
    }
    const h = this.$history;
    if (!h) return false;
    await this.$historyOpening;
    const channel = this.channel;
    if (this.historyState === 'open' && !this.$replaying && !this.$historyAdopting && channel && channel.epoch > 0) { // a new chat
      try {
        const ckpt = this.$continueCkpt;
        if (ckpt) { // a reopened chat: its store goes on under the new channel
          await h.continueAt(this.id, channel.epoch, ckpt);
          this.historyCkpt = ckpt;
          this.historyWrittenSeq = ckpt.sequence;
          this.$continueCkpt = null;
        } else await h.claim(this.id, channel.epoch);
        this.historyState = 'claimed';
      } catch (error) {
        this.$historyFailed(error);
        return false;
      }
    }
    if (this.historyState !== 'claimed') {
      if (this.historyState === 'open' && this.$historyQueue.length && !this.$replaying && !this.$historyAdopting) this.$historySchedule();
      return false;
    }
    const batch = this.$historyQueue;
    this.$historyQueue = [];
    if (!batch.length) return true;
    try {
      const result = await h.append(this.id, batch as unknown as StoreEvent[]);
      this.historyWrittenSeq = result.writtenSeq;
      if (result.stopped) {
        log.warning('history: %s: the disk is full; the store stopped writing (the chat goes on)', this.id);
        this.$historyEnd('close');
        return false;
      }
      return true;
    } catch (error) {
      this.$historyFailed(error);
      return false;
    }
  },

  $historyFailed(this: Connection, error: unknown): void {
    if ((error as { code?: unknown })?.code === 'fenced') {
      this.$historyFenced = true;
      log.warning('history: %s: another owner took the store; this one stops writing', this.id);
    } else log.warning('history: %s: the store stopped: %s', this.id, errorText(error));
    this.$historyEnd('close');
  },

  /**
   * Stop writing and close the store. Never deletes it (owner rule 2026-11-17: the chat history is permanent; only deleting the
   * chat removes it: Aib.forgetHistory). A fenced writer leaves the new owner's store alone.
   */
  $historyEnd(this: Connection, _how: 'close' = 'close'): void {
    const h = this.$history;
    if (!h || this.historyState === 'off') return;
    if (this.$historyTimer !== null) {
      clearTimeout(this.$historyTimer);
      this.$historyTimer = null;
    }
    this.$historyQueue = [];
    const was = this.historyState;
    this.historyState = 'dead';
    if (was !== 'dead') this.$historyChain = this.$historyChain.then(() => h.close(this.id)).catch(() => {});
  },

  /**
   * The chat stopped (its agent exited, the chat was closed, AIB quit with it idle): what is queued is written, then the store is
   * closed and KEPT, so reopening the conversation goes on in it under the same chat id (Aib.connect). A store with no event at
   * all (a chat that never began) is removed: it holds no history.
   */
  $historyFinish(this: Connection): Promise<void> {
    if (!this.$historyFinishing) this.$historyFinishing = this.$historyFinishNow();
    return this.$historyFinishing;
  },

  /**
   * This chat's store is no longer this connection's: written to the end, closed, kept (AIB, before a reopened chat with the same
   * id opens it: one store is never written by two connections). Never throws.
   */
  async historyDetach(this: Connection): Promise<void> {
    await this.$historyFinish().catch(() => {});
    await this.historySettled();
  },

  async $historyFinishNow(this: Connection): Promise<void> {
    const h = this.$history;
    if (!h || this.historyState === 'off' || this.historyState === 'dead') return;
    await this.$historyAdopt.catch(() => {});
    await this.$historyOpening.catch(() => {});
    if (this.historyState === 'open' || this.historyState === 'claimed') await this.$historyFlush().catch(() => false);
    if (this.historyState !== 'open' && this.historyState !== 'claimed') return; // the flush failed: the store was closed (kept)
    if (this.$historyTimer !== null) {
      clearTimeout(this.$historyTimer);
      this.$historyTimer = null;
    }
    this.$historyQueue = [];
    this.historyState = 'dead';
    const fenced = this.$historyFenced;
    this.$historyChain = this.$historyChain.then(async () => {
      if (fenced) await h.close(this.id);
      else await h.release(this.id);
    }).catch((error) =>
      log.warning('history: %s: closing the store failed: %s', this.id, errorText(error))
    );
    await this.$historyChain;
  },

  /**
   * A reopened conversation goes on in its chat's store (AIB found it): the same numbering, the next seq after the newest stored
   * one, the stored tail in RAM, and the checkpoint a later take-over of the new channel starts from (record 0: this state, before
   * the channel's first record). The setup session/load's replay is dropped (it is in the store); turns made outside AIB meanwhile
   * are shown ($showOutsideTurns).
   */
  $continueFrom(this: Connection, c: ContinueStore): void {
    if (!isStr(c.eventsId) || !c.eventsId || !isInt(c.sequence) || c.sequence < 1) return;
    this.eventsId = c.eventsId;
    this.sequence = c.sequence;
    this.events = (Array.isArray(c.events) ? c.events : []).filter((e) => isDict(e) && isInt(e.seq) && (e.seq as number) <= c.sequence)
      .slice(-MAX_EVENTS) as Json[];
    this.eventImageBytes = this.events.reduce((sum, e) => sum + eventImageSize(e), 0);
    while (this.eventImageBytes > MAX_EVENT_IMAGE_BYTES && this.events.length > 1) this.eventImageBytes -= eventImageSize(this.events.shift()!);
    this.$eventsSaved = c.sequence; // every seq up to here is in the store: it keeps its number
    for (const e of this.events) { // where the outside turns begin: the last user message the chat showed
      if (e.kind === 'user' && isDict(e.data) && isStr(e.data.text) && pyStrip(e.data.text)) {
        this.$lastUserText = e.data.text;
        this.$inUserText = false;
      } else if (e.kind === 'update') this.$noteUserText(e.data);
    }
    this.continuedFrom = c.sequence;
    this.$continued = true;
    const state = this.$snapshotState();
    state.eventsFrom = c.sequence + 1; // the history up to here is in the store
    this.$continueCkpt = { state, sequence: c.sequence, record: 0, noteSeq: 0 };
  },

  /**
   * After a reopened chat's setup session/load: of what the agent replayed, only the turns after the last one the store has (written
   * in another app meanwhile) are shown, as `event` notes in the record (a rebuild drops the replay and shows these the same way).
   */
  $showOutsideTurns(this: Connection, replay: ReplayWindow): void {
    const updates = replay.updates;
    const outside = this.$lastUserText ? outsideTurns(updates, this.$lastUserText) : { updates: [], turns: 0 };
    for (const params of outside.updates) {
      this.$noteUserText(params);
      this.recordedEvent('update', params);
    }
    if (outside.turns) {
      const n = outside.turns;
      this.recordedEvent('studio_note', { message: `${n} turn${n === 1 ? '' : 's'} from outside AIB above.`, sessionId: this.sessionId });
    }
    log.info(
      'chat %s: went on in its history store from seq %s (%s outside turn(s) of %s replayed updates, the newest %s kept)',
      this.id,
      this.continuedFrom,
      outside.turns,
      replay.received,
      updates.length,
    );
  },

  /** The store's write chain has run (tests). */
  async historySettled(this: Connection): Promise<void> {
    await this.$historyAdopt.catch(() => {});
    await this.$historyFinishing?.catch(() => {});
    await this.$historyChain;
  },

  /**
   * A take-over: open the store and attach the keeper from its checkpoint (ckpt.record + 1), with the checkpoint's state as the
   * snapshot the replay starts from. A checkpoint past the end of the journal (a reset WSL distro, another keeper) is not this
   * record's: that store is deleted and the chat is rebuilt from its journal. 0: from the start.
   */
  async $historyAdoptFrom(this: Connection, info: ChannelInfo): Promise<number> {
    const h = this.$history!;
    try {
      let opened = await h.open(this.id, {});
      if (opened.ckpt && isInt(info.last) && opened.ckpt.record > info.last) {
        log.warning(
          'history: %s: the store checkpoint (record %s) is past the end of the journal (%s); it is not this record\'s and is dropped',
          this.id,
          opened.ckpt.record,
          info.last,
        );
        const copy = await h.archive(this.id, 'stale-checkpoint'); // kept (owner rule: the history is permanent); a new store starts
        if (copy) log.warning('history: %s: the old store was kept as %s', this.id, copy);
        opened = await h.open(this.id, {});
      }
      this.$historyOpened = opened;
      const ckpt = opened.ckpt;
      if (!ckpt || !isDict(ckpt.state)) return this.attachedFrom = 0;
      this.historyCkpt = ckpt;
      this.$storeSnapshot = { note: { t: 'snapshot', sv: SNAPSHOT_VERSION, upTo: ckpt.record, state: ckpt.state }, seq: ckpt.noteSeq };
      this.$replaySnapshot = this.$storeSnapshot;
      return this.attachedFrom = ckpt.record + 1;
    } catch (error) {
      log.warning('history: %s: the store could not be read; rebuilding from the journal: %s', this.id, errorText(error));
      this.historyState = 'dead';
      return this.attachedFrom = 0;
    }
  },

  /**
   * A take-over: the events a restored state's history has in the store: the chat's own newest (MAX_EVENTS) and each live helper's
   * tail, up to min(state.sequence, eventsFrom - 1) (an older build's note keeps the rest in its chunks). null: the store has none
   * (or another numbering): the chunks alone, as before.
   */
  async $historyRestoreEvents(this: Connection, note: Json): Promise<Json[] | null> {
    const h = this.$history;
    const opened = this.$historyOpened;
    if (!h || this.historyState !== 'open' || !opened) return null;
    const s = note.state as Json;
    const sequence = isInt(s.sequence) ? s.sequence : 0;
    const from = isInt(s.eventsFrom) ? s.eventsFrom : sequence + 1;
    if (opened.eventsId && isStr(s.eventsId) && s.eventsId && opened.eventsId !== s.eventsId && opened.last) {
      this.$storeReset = true; // another numbering: the store starts again from what this rebuild makes
      return null;
    }
    const limit = Math.max(0, Math.min(sequence, from - 1));
    this.$storeTrusted = limit;
    if (!opened.last || limit < 1) return null;
    try {
      const rows: StoredEvent[] = [];
      rows.push(...(await h.before(this.id, limit + 1, { session: null, limit: MAX_EVENTS, bytes: MAX_EVENT_IMAGE_BYTES })).events);
      const live = Array.isArray(s.liveHelpers) ? s.liveHelpers.filter(isStr) : [];
      for (const sid of live) {
        rows.push(...(await h.helper(this.id, sid, { before: limit + 1, limit: HISTORY_HELPER_TAIL, bytes: MAX_EVENT_IMAGE_BYTES })).events);
      }
      rows.sort((a, b) => a.seq - b.seq);
      return rows.map((r) => JSON.parse(r.data) as Json);
    } catch (error) {
      log.warning('history: %s: reading the store failed; the history starts after the restart: %s', this.id, errorText(error));
      this.$storeTrusted = 0;
      return null;
    }
  },

  /**
   * A take-over has caught up and claimed the channel: claim the store with the same epoch, delete its provisional events (above
   * what the restore took from it), append what the replay rebuilt, and commit a newer keeper note's checkpoint (a crash between
   * note and commit, or an older build's note: its history is in the store from now on).
   */
  async $historyTakeOver(this: Connection): Promise<void> {
    const h = this.$history;
    const channel = this.channel;
    if (!h || this.historyState !== 'open' || !channel) return;
    try {
      const opened = await h.open(this.id, { eventsId: this.eventsId, mainSession: this.sessionId });
      this.$historyOpened = opened;
      await h.claim(this.id, channel.epoch);
      if (opened.eventsIdChanged || this.$storeReset) {
        await h.reset(this.id, this.eventsId);
        this.$storeTrusted = 0;
      } else await h.dropProvisional(this.id, this.$storeTrusted);
      const bySeq = new Map<number, Json>();
      for (const e of this.events) if ((e.seq as number) > this.$storeTrusted) bySeq.set(e.seq as number, this.$historyItem(e));
      for (const e of this.$historyQueue) if ((e.seq as number) > this.$storeTrusted) bySeq.set(e.seq as number, e);
      this.$historyQueue = [...bySeq.values()].sort((a, b) => (a.seq as number) - (b.seq as number));
      if (this.historyState !== 'open') return; // closed or deleted meanwhile
      this.historyState = 'claimed'; // only now: nothing is appended before the provisional events are gone
    } catch (error) {
      this.$historyFailed(error);
      return;
    }
    if (!(await this.$historyFlush())) return;
    try {
      const { writtenSeq, ckpt } = await h.getCheckpoint(this.id);
      this.historyWrittenSeq = writtenSeq;
      this.historyCkpt = ckpt;
      const restored = this.$restoredSnapshot;
      const s = restored && isDict(restored.note.state) ? restored.note.state as Json : null;
      if (restored && s && restored !== this.$storeSnapshot && isInt(s.sequence) && s.sequence <= writtenSeq) {
        const record = restored.note.upTo as number;
        if (!ckpt || record > ckpt.record) {
          const state = { ...s, eventsFrom: s.sequence + 1 }; // its history is in the store now
          const next: Checkpoint = { state, sequence: s.sequence, record, noteSeq: restored.seq };
          if (await h.setCheckpoint(this.id, next)) this.historyCkpt = next;
        }
      }
    } catch (error) {
      log.warning('history: %s: committing the take-over checkpoint failed: %s', this.id, errorText(error));
    }
  },

  /**
   * The quiet-point checkpoint (design 3.2): the keeper's sv:2 note (no chunks: eventsFrom = sequence + 1) is sent at the quiet
   * moment itself, before anything AIB writes after it (as the old snapshot was: a prompt sent right after a turn end never makes
   * the checkpoint wait for the next quiet point); then the queued events are flushed, ckpt = {state, sequence, record, noteSeq}
   * is committed once both are done, and the journal is truncated before ckpt.record + 1 (never awaited: a reconnecting WSL bridge
   * holds operations back, and the store writer never waits on it).
   *
   * Crash safety: until the commit, the old ckpt stands and the journal still holds every record after it. A take-over uses a
   * newer note only when the store has its events (written_seq >= note.state.sequence, see $bufferReplay); otherwise it replays
   * from the old ckpt as if the note were not there.
   */
  async $writeCheckpoint(this: Connection, channel: KeeperChannel): Promise<void> {
    const h = this.$history!;
    if (channel.lost || !this.$quiet() || this.historyState !== 'claimed') return;
    const upTo = this.$lastSeq;
    const sequence = this.sequence;
    const state = this.$snapshotState();
    state.eventsFrom = sequence + 1; // the history is in the store (an older build opens the chat without it, and works)
    const note: Json = { t: 'snapshot', sv: SNAPSHOT_VERSION, upTo, chat: this.$chatNote(), state, events: [] };
    const bytes = ENCODER.encode(JSON.stringify(note)).length;
    if (bytes > MAX_SNAPSHOT_BYTES - 1024) {
      log.warning('keeper: %s: the snapshot would be larger than %s bytes; not written', this.id, MAX_SNAPSHOT_BYTES);
      return;
    }
    const noted = channel.snapshot(note); // sent now, in order with everything AIB writes
    if (this.historyStopAfter === 'note') {
      await noted;
      return this.$historyStop();
    }
    const [flushed, noteSeq] = await Promise.all([this.$historyFlush(), noted]);
    if (!noteSeq) return;
    this.snapshots += 1;
    this.snapshotBytes = bytes;
    this.snapshotChunkBytes = 0;
    this.$eventsSaved = sequence;
    this.$eventChunks = [];
    if (!flushed || this.historyWrittenSeq < sequence) return; // committed at the next quiet point
    if (this.historyStopAfter === 'flush') return this.$historyStop();
    const ckpt: Checkpoint = { state, sequence, record: upTo, noteSeq };
    try {
      if (!(await h.setCheckpoint(this.id, ckpt))) return;
    } catch (error) {
      this.$historyFailed(error);
      return;
    }
    this.historyCkpt = ckpt;
    if (this.historyStopAfter === 'commit') return this.$historyStop();
    void channel.truncate(upTo + 1);
  },

  /** Tests: the checkpoint stopped at historyStopAfter (a crash right there): nothing more reaches the store from this host. */
  $historyStop(this: Connection): void {
    this.historyStopAfter = null;
    this.$historyFenced = true; // and it never deletes it either
    this.$historyEnd('close');
  },

  /**
   * One page of events from the store (history pages older than RAM, a finished helper's events): the same Page as event_pages.ts
   * page(), with `more` and `first` from the store. null: no store.
   */
  async storePage(this: Connection, query: PageQuery): Promise<Page | null> {
    const h = this.$history;
    if (!h || (this.historyState !== 'claimed' && this.historyState !== 'open')) return null;
    const main = this.sessionId ?? '';
    const session = !query.session || query.session === 'main' || query.session === main ? null : String(query.session);
    const bytes = Math.max(4096, Math.min(8 * 1024 * 1024, Math.trunc(Number(query.bytes) || 1024 * 1024)));
    const options = { session, bytes, limit: 100_000 };
    try {
      let rows: StoredEvent[];
      let more: boolean;
      let newer = false;
      if (query.around !== undefined) {
        const older = await h.before(this.id, query.around + 1, { ...options, bytes: bytes / 2 });
        const later = await h.after(this.id, query.around, { ...options, bytes: bytes / 2 });
        rows = [...older.events, ...later.events];
        more = older.more;
        newer = later.more;
      } else if (query.after !== undefined) {
        const p = await h.after(this.id, query.after, options);
        rows = p.events;
        more = (await h.before(this.id, (p.from ?? query.after + 1), { ...options, limit: 1, bytes: 1 })).events.length > 0;
        newer = p.more;
      } else {
        const p = query.before !== undefined ? await h.before(this.id, query.before, options) : await h.tail(this.id, options);
        rows = p.events;
        more = p.more;
        if (query.before !== undefined && p.to !== null) newer = true;
      }
      const events = rows.map((r) => JSON.parse(r.data) as Ev);
      const result = page(arraySource(events, { eventsId: this.eventsId, cursor: this.sequence, stable: this.stableSeq, mainSession: main }), {
        ...query,
        bytes: Number.MAX_SAFE_INTEGER,
        before: undefined,
        after: undefined,
        around: undefined,
      });
      const info = await h.info(this.id) as { first?: number | null };
      result.more = more;
      result.newer = newer;
      if (session === null && typeof info?.first === 'number') result.first = info.first;
      if (query.before !== undefined || query.after !== undefined || query.around !== undefined) {
        delete result.turn;
        delete result.helpers;
      }
      return result;
    } catch (error) {
      log.warning('history: %s: reading a page from the store failed: %s', this.id, errorText(error));
      return null;
    }
  },

  /** One event whole from the store (one RAM no longer keeps), or null. */
  async storeEvent(this: Connection, seq: number): Promise<Ev | null> {
    const h = this.$history;
    if (!h || (this.historyState !== 'claimed' && this.historyState !== 'open')) return null;
    try {
      const row = await h.event(this.id, seq);
      return row ? JSON.parse(row.data) as Ev : null;
    } catch {
      return null;
    }
  },
};

export type HistoryMethods = typeof historyMethods;
