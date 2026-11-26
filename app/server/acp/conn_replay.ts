/**
 * Connection methods: the keeper channel (records in, notes out), replaying what an adopted agent said and asked, client terminals,
 * and restoring a snapshot. Moved out of connection.ts (no change).
 */
import { createHash } from 'node:crypto';
import { CapError, ClientCaps, type TerminalBackend, type TerminalBase, type TerminalPlan } from './client_caps.ts';
import { clientTerminalChannel, clientTerminalNote, clientTerminalProblem, KeeperClientTerminal } from './keeper_terminal.ts';
import { type BreadthState, newState } from './breadth.ts';
import { type KeptLine, LineMerger } from '../history/lines.ts';
import { eventImageSize, type FileSummary, type ImageBlock } from './attachments.ts';
import { type Killable } from '../platform/process_tree.ts';
import type { ChannelInfo, KeeperRecord } from '../keeper/client.ts';
import { type KeeperChannel, type KeeperChannelListener, parseNote } from '../keeper/link.ts';
import { APP_VERSION } from '../core/app.ts';
import { clip, isDict, isInt, isStr } from '../core/py.ts';
import { log, type Json, errorName, errorText, isOsOrValueError, get, pyEq, RSTRIP, now } from './conn_util.ts';
import { ThreadEvent } from './thread_text.ts';
import { type Receipt, type Pending } from './conn_types.ts';
import { KEEPER_LOST } from './conn_limits.ts';
import { type BackgroundTool } from './tool_tracking.ts';
import { ReplayWindow } from './replay_window.ts';
import type { Connection } from './connection.ts';

export const replayMethods = {
  /** Rebuild from a live keeper channel an earlier AIB started: replay its record, then claim it and go on live. */
  $adoptChannel(this: Connection, info: ChannelInfo): void {
    this.$replaying = true;
    let settle: [() => void, (error: Error) => void] = [() => {}, () => {}];
    this.rebuilt = new Promise<void>((resolve, reject) => (settle = [resolve, reject]));
    this.rebuilt.catch(() => {});
    this.$settleRebuild = settle;
    this.rebuildTimes.adopt = performance.now();
    const from = this.$history ? () => this.$historyAdoptFrom(info) : 0;
    this.$useChannel(this.keeper!.adopt(info, this.$keeperListener(), from));
  },

  $useChannel(this: Connection, channel: KeeperChannel): void {
    this.channel = channel;
    const kill = () => void channel.kill();
    const standIn: Killable = {
      get pid() {
        return channel.pid;
      },
      kill,
    };
    this.process = standIn as Deno.ChildProcess;
    this.tree = { kill };
    this.$exited = new Promise<void>((resolve) => (this.$exitResolve = resolve));
    this.$readTask = new Promise<void>((resolve) => (this.$endedResolve = resolve));
    this.$errorTask = Promise.resolve();
  },

  $hooksNote(this: Connection): Json {
    const h = this.subagentHooks!;
    return {
      given: isDict(h.settings?.hooks) || h.adopted === true,
      off: h.off,
      ...(h.detail ? { detail: h.detail } : {}),
      readOnly: h.readOnly,
      userWorktreeHook: h.userWorktreeHook,
      ...(h.configDir ? { configDir: h.configDir } : {}),
      ...(h.deny ? { deny: h.deny } : {}), // the editing-subagent deny rules a reopen must send again
      ...(h.prompt ? { prompt: h.prompt } : {}),
      ...(h.shellTag ? { shellTag: true } : {}),
      ...(h.agyDir ? { agyDir: h.agyDir } : {}),
    };
  },

  /** The `chat` note: written right after the spawn, so a later AIB knows what this channel is. */
  $chatNote(this: Connection): Json {
    return {
      t: 'chat',
      id: this.id,
      provider: this.provider,
      cwd: this.cwd,
      // which keeper holds it: a WSL chat's note says its distro, so a rebuild looks for it in that distro's keeper
      loc: this.wsl ? { kind: 'wsl', distro: this.wsl.distro, linuxPath: this.wsl.linuxPath } : { kind: 'win' },
      projectRoot: this.projectRoot,
      worktree: this.worktree,
      resume: this.sessionId,
      command: this.command,
      mcpServers: this.mcpServers,
      app: APP_VERSION,
      // subagent worktrees: whether its agent runs AIB's hooks, or why not, so a take-over shows the same (should-fix 6). No key.
      ...(this.subagentHooks ? { subagentHooks: this.$hooksNote() } : {}),
      // Every event of this chat is rebuilt from this record (AIB's own events go in as `event` notes), so a rebuild numbers
      // them exactly as now and an open page keeps its cursor.
      ev: 1,
      // a reopened chat that goes on in its store from this seq: a rebuild drops its setup session/load's replay, as live did
      ...(this.continuedFrom ? { continued: this.continuedFrom } : {}),
      eventsId: this.eventsId,
    };
  },

  $keeperListener(this: Connection): KeeperChannelListener {
    return {
      record: (record: KeeperRecord) => {
        if (this.$replaying && !this.$replayLive) return this.$bufferReplay(record);
        this.$enqueue(() => this.$onRecord(record));
      },
      live: () => {
        if (this.$replaying && !this.rebuildTimes.live) this.rebuildTimes.live = performance.now();
        this.$replayLive = true;
        this.$enqueue(() => this.$caughtUp());
      },
      gap: (from: number, next: number) => {
        if (this.$replaying && !this.$replayLive) { // truncated after a snapshot: fine when a snapshot covers it (checked at live)
          this.$replayGapNext = next;
          this.$replayBuffer = [];
          this.$replaySnapshot = this.$storeSnapshot; // the store's checkpoint still covers what came before (or nothing does)
          this.$replayChunks.clear();
          return;
        }
        this.$enqueue(() => {
          if (this.$replaying) this.$rebuildFailed(new Error(`the record from ${from} to ${next - 1} is no longer kept`));
          else log.warning('keeper: %s lost records %s..%s', this.id, from, next - 1);
        });
      },
      fenced: () =>
        this.$enqueue(() => {
          this.$stdinBroken = true;
          this.error = 'Another AIB took over this chat; this window no longer sends anything to it.';
          this.$historyEnd('close'); // the new owner writes the store now
        }),
      lost: (error: Error | null) => this.$enqueue(() => this.$onLost(error)),
      spawnFailed: (error: Error) =>
        this.$enqueue(() => {
          if (this.$replaying) return this.$rebuildFailed(error);
          this.$pushStderr(clip(`Could not start the agent in the keeper: ${errorText(error)}`, 2000));
          this.$exitResolve?.();
          this.$readerEnded('');
        }),
      writeFailed: (error: Error) => {
        this.$stdinBroken = true;
        log.warning('keeper: a write to %s failed: %s', this.id, errorText(error));
      },
    };
  },

  /** Records are handled one at a time, in journal order, exactly like lines read from a pipe. */
  $enqueue(this: Connection, work: () => unknown): void {
    this.$records = this.$records.then(async () => {
      await work();
    }).catch((error) => this.$recordFailed(error));
  },

  $recordFailed(this: Connection, error: unknown): void {
    if (this.$ended) return;
    if (this.$replaying) return this.$rebuildFailed(error);
    if (isOsOrValueError(error)) {
      this.error = errorText(error);
      this.$readerEnded('');
      return;
    }
    const failure = this.$internalFailure(error);
    this.$readerEnded(failure);
  },

  $now(this: Connection): number {
    return this.$clock ?? now();
  },

  async $onRecord(this: Connection, record: KeeperRecord): Promise<void> {
    if (this.$ended) return;
    try {
      await this.$handleRecord(record);
    } finally {
      if (record.seq > this.$lastSeq) this.$lastSeq = record.seq;
    }
  },

  async $handleRecord(this: Connection, record: KeeperRecord): Promise<void> {
    // What the agent wrote is stamped with the keeper's time for it, live as in a replay: a take-over rebuilds every event with the
    // same time it had (live, now() lags the keeper by the hop to AIB, a few ms, more under load). Live, only while this record is
    // handled (with the reply's wait for its caller: the `connected` a session result makes).
    const live = !this.$replaying;
    this.$clock = live && record.kind !== 'out' && record.kind !== 'err' ? null : record.time / 1000;
    try {
      await this.$handleRecordAt(record);
    } finally {
      if (live && !this.$replaying) this.$clock = null;
    }
  },

  async $handleRecordAt(this: Connection, record: KeeperRecord): Promise<void> {
    if (record.kind === 'out') {
      for (const line of this.$outLines.feed(record.body)) {
        const pending = this.$handleLine(line);
        if (pending) await pending;
      }
    } else if (record.kind === 'err') {
      for (const line of this.$errLines.feed(record.body)) this.$pushStderr(clip(line.replace(RSTRIP, ''), 2000));
    } else if (record.kind === 'in') {
      if (!this.$replaying) return; // our own writes coming back
      for (const line of new TextDecoder().decode(record.body).split('\n')) {
        if (line.trim()) this.$replayIn(line);
      }
      await new Promise((resolve) => setTimeout(resolve, 0)); // let a turn that just began reach its wait, as live code would
    } else if (record.kind === 'note') {
      if (this.$replaying) this.$replayNote(parseNote(record.body));
    } else if (record.kind === 'exit') {
      let code: number | null = null;
      try {
        const body = JSON.parse(new TextDecoder().decode(record.body));
        code = typeof body.code === 'number' ? body.code : null;
      } catch { /* no code */ }
      await this.$flushLines();
      this.exitCode = code;
      this.$exitResolve?.();
      if (!this.$replaying) {
        if (this.channel) this.channelRemoved = this.channel.remove(); // the agent is gone: its record is no longer needed
        // its store is kept (owner rule 2026-11-17): reopening the conversation goes on in it under this chat id
        void this.$historyFinish();
      }
      this.$readerEnded('');
    }
  },

  async $flushLines(this: Connection): Promise<void> {
    for (const line of this.$outLines.feed(null, true)) {
      const pending = this.$handleLine(line);
      if (pending) await pending;
    }
    for (const line of this.$errLines.feed(null, true)) this.$pushStderr(clip(line.replace(RSTRIP, ''), 2000));
  },

  async $onLost(this: Connection, _error: Error | null): Promise<void> {
    if (this.$ended) return;
    this.interrupted = true;
    try {
      await this.$flushLines();
    } catch { /* what was cut off stays cut off */ }
    this.error = KEEPER_LOST;
    this.$exitResolve?.();
    this.$settleRebuild?.[1](new Error(KEEPER_LOST));
    this.$settleRebuild = null;
    this.$readerEnded(KEEPER_LOST);
  },

  /** A line AIB wrote to the agent, read back from the record. */
  $replayIn(this: Connection, line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isDict(message)) return;
    const method = message.method;
    if (isStr(method) && Object.hasOwn(message, 'id')) return this.$replayRequest(message);
    if (isStr(method)) {
      if (method === 'session/cancel') {
        const sid = get(get(message, 'params', {}) as Json, 'sessionId');
        if (!this.sessionId || sid === this.sessionId) {
          this.cancelSeq = this.promptSeq;
          if (this.autonomous) void this.$endAutonomous('cancelled'); // as cancel() did live
        }
      }
      return;
    }
    if (Object.hasOwn(message, 'id')) this.$replayAnswered(message.id);
  },

  /** A request AIB sent: it is pending until its response shows up in the record (or arrives live). */
  $replayRequest(this: Connection, message: Json): void {
    const id = message.id;
    const method = message.method as string;
    const params = get(message, 'params', {}) as Json;
    if (isInt(id) && id > this.counter) this.counter = id; // ids never collide with the old AIB's
    const entry: Pending = { done: new ThreadEvent(), method, params };
    this.pending.set(id, entry);
    if (method === 'session/prompt') return this.$replayTurn(id, entry, params);
    if (method === '_session/steering') return this.$replaySteer(id, entry, params);
    // open elsewhere: a session/load after a hand-off (the chat was ready): the outside turns it showed are AIB events in the
    // record already, so the history it brought back is dropped again
    // A reopened chat's setup session/load: the transcript it replays is in the store; the outside turns live showed are `event`
    // notes in the record (#showOutsideTurns).
    const setupOfContinued = method === 'session/load' && this.$continued && !this.ready;
    const reload = (method === 'session/load' && this.ready && !!this.sessionId) || setupOfContinued;
    if (reload) this.$reload = { window: new ReplayWindow(), discard: true };
    void entry.done.wait().then(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
      if (reload) {
        this.$reload = null;
        if (setupOfContinued) this.$continued = false;
        else if (!Object.hasOwn(entry.response ?? {}, 'error')) this.elsewhere = null;
      }
      if (method === 'session/close' && !Object.hasOwn(entry.response ?? {}, 'error') && get(params, 'sessionId') === this.sessionId) {
        // the old AIB let go of this chat (another app opened it); the line saying so is in the record as its own event
        this.elsewhere = { app: 'another app', pid: 0, entrypoint: '', since: this.$now(), released: true };
        return;
      }
      this.$applyAnswered(method, params, entry.response ?? {});
    });
  },

  /** What a response to a replayed request changes: the same state the live code sets after it awaited the request. */
  $applyAnswered(this: Connection, method: string, params: Json, response: Json): void {
    if (Object.hasOwn(response, 'error')) return;
    const result = Object.hasOwn(response, 'result') ? response.result : {};
    try {
      if (method === 'initialize') {
        this.initial = result;
        this.$applyInitialize();
      } else if (method === 'session/new' || method === 'session/load' || method === 'session/resume') {
        this.$applySession(result, method === 'session/new' ? null : get(params, 'sessionId') as string | null);
      } else if (method === 'session/set_mode') {
        this.$modes().currentModeId = get(params, 'modeId');
      } else if (method === 'session/set_config_option' && isDict(result)) {
        Object.assign(this.settings, result);
        this.$withModels(this.settings);
      } else if (method === 'session/set_model') {
        this.$modelSet(get(params, 'modelId'));
      }
    } catch (error) {
      if (this.$replaying) this.$rebuildFailed(error);
      else log.exception(error, 'Applying a response to a request from before the restart failed');
    }
  },

  /**
   * A steer the old AIB sent (B4): once its answer is known (from the record, or live) the same happens as live: injected shows the
   * user's message (at the same place, so events number the same); the lane, restored later from the queue store, takes the answer
   * from $replayedSteers instead of sending the message again.
   */
  $replaySteer(this: Connection, id: unknown, entry: Pending, params: Json): void {
    const key = JSON.stringify(id);
    const note = this.$steerNotes.get(key) ?? null;
    this.$steerNotes.delete(key);
    const itemId = note && isStr(note.receipt) ? note.receipt : null;
    const outcome = entry.done.wait().then(() => {
      if (this.pending.get(id) === entry) this.pending.delete(id);
      const response = entry.response ?? {};
      const result = Object.hasOwn(response, 'error') ? null : response.result;
      const said = isDict(result) ? result.outcome : null;
      if (said === 'injected' || said === 'startedNewTurn') {
        const blocks = get(params, 'prompt', []);
        const images = (Array.isArray(blocks) ? blocks : []).filter((b) => isDict(b) && b.type === 'image') as unknown as ImageBlock[];
        if (itemId && note) {
          this.$steerLanded(itemId, isStr(note.text) ? note.text : '', images, Array.isArray(note.files) ? note.files as FileSummary[] : [],
            isStr(note.fingerprint) ? note.fingerprint : '');
        }
        return 'injected';
      }
      return said === 'promptRequired' ? 'promptRequired' : 'failed';
    });
    if (itemId) {
      this.$replayedSteers.set(itemId, outcome);
      while (this.$replayedSteers.size > 100) this.$replayedSteers.delete(this.$replayedSteers.keys().next().value!);
    }
  },

  /** A prompt from the record: the turn starts again here, through the same code, waiting for the same response. */
  $replayTurn(this: Connection, id: unknown, entry: Pending, params: Json): void {
    const note = this.$receiptNotes.get(JSON.stringify(id)) ?? null;
    this.$receiptNotes.delete(JSON.stringify(id));
    const blocks = get(params, 'prompt', []);
    const prompt = (Array.isArray(blocks) ? blocks : []).filter(isDict) as Json[];
    const images = prompt.filter((b) => b.type === 'image') as unknown as ImageBlock[];
    const said = prompt.find((b) => b.type === 'text' && isStr(b.text) && !b.text.startsWith('<studio-context>'));
    const text = note && isStr(note.text) ? note.text : said ? String(said.text) : '';
    const clientMessageId = note && isStr(note.receipt) ? note.receipt : null;
    const seq = this.$startTurn(clientMessageId, note && isStr(note.fingerprint) ? note.fingerprint : '');
    const userEvent: Json = { text, attachments: images, sessionId: this.sessionId, clientMessageId };
    if (note && Array.isArray(note.files) && note.files.length) userEvent.files = note.files;
    this.event('user', userEvent);
    this.turn = this.$runTurn(seq, text, [], images, clientMessageId, null, { entry, id });
  },

  /** AIB answered an agent request: whatever this replay was about to answer for it was answered already. */
  $replayAnswered(this: Connection, id: unknown): void {
    const same = (other: unknown) => typeof other === typeof id && pyEq(other, id);
    this.$held = this.$held.filter((h) => Object.hasOwn(h.message, 'method') || !same(h.message.id));
    for (const [key, item] of [...this.permissions]) if (same(item.rpcId)) this.permissions.delete(key);
    for (const [key, item] of [...this.elicitations]) if (same(item.rpcId)) this.elicitations.delete(key);
    this.$deferred = this.$deferred.filter((m) => !same(m.id));
  },

  $replayNote(this: Connection, note: Json | null): void {
    if (note && note.t === 'event' && isStr(note.kind)) { // AIB's own event (a line put back from the conversation keeps its time)
      return this.event(note.kind, note.data ?? null, typeof note.time === 'number' ? note.time : undefined);
    }
    if (note && note.t === 'chat') { // a record that has every event: the rebuild numbers them as before
      if (note.ev === 1 && isStr(note.eventsId) && note.eventsId) this.eventsId = note.eventsId;
      // a reopened chat (its store's checkpoint is the state before this record): its setup session/load is dropped, as live
      if (isInt(note.continued) && note.continued > 0 && !this.ready) {
        this.continuedFrom = note.continued;
        this.$continued = true;
      }
      return;
    }
    if (note?.t === 'lines' && Array.isArray(note.lines)) { // the conversation's kept lines a session/load merged (live: the same)
      this.$merger = new LineMerger(note.lines.filter((l) => isDict(l) && isStr(l.kind) && isStr(l.after)) as KeptLine[]);
      return;
    }
    if (note?.t === 'clientTerminalReleased' && isStr(note.terminalId)) {
      this.$releasedTerminals.add(note.terminalId);
      return;
    }
    if (!note || note.rpc === undefined) return;
    if (note.t === 'receipt') this.$receiptNotes.set(JSON.stringify(note.rpc), note);
    else if (note.t === 'steer') this.$steerNotes.set(JSON.stringify(note.rpc), note);
    else if (note.t === 'fsWrite' || note.t === 'clientTerminal') this.$sideNotes.set(`${note.t}:${JSON.stringify(note.rpc)}`, note);
  },

  /**
   * Client terminals in the keeper (note first): start one for terminal/create after writing its `clientTerminal` note in this chat's
   * record; null lets it run as a child of AIB (the agent is not in the keeper, or the keeper is too old: the note then says so).
   */
  $terminalBackend(this: Connection): TerminalBackend {
    return {
      create: async (plan: TerminalPlan) => {
        const chat = this.channel;
        if (!chat || chat.lost || this.rebuildError || !this.keeper) return null;
        try {
          await chat.ready;
        } catch {
          return null;
        }
        const client = chat.client;
        const problem = !client || client.closed ? 'no keeper connection' : clientTerminalProblem(client.features, client.keeperVersion);
        if (!plan.pinned) {
          const note: Json = {
            t: 'clientTerminal',
            rpc: plan.rpc,
            terminalId: plan.terminalId,
            channel: problem ? null : clientTerminalChannel(plan.terminalId),
            sessionId: plan.sessionId,
            argv: plan.argv.slice(0, 50),
            cwd: plan.cwd,
            limit: plan.limit,
          };
          if (!await chat.sendNote(note)) throw new CapError('AIB could not record the terminal, so it was not started', -32603);
        }
        if (problem) {
          if (!this.$terminalProblemLogged) log.info('keeper: client terminals of %s run inside AIB: %s', this.id, problem);
          this.$terminalProblemLogged = true;
          return null;
        }
        const terminal = KeeperClientTerminal.spawn(this.keeper, plan, this.id);
        try {
          await terminal.ready;
        } catch (error) {
          throw new CapError(`Could not start command: ${errorText(error) || errorName(error)}`, -32603);
        }
        return terminal;
      },
      release: async (terminal: TerminalBase) => {
        if (terminal instanceof KeeperClientTerminal && this.channel) {
          await this.channel.sendNote({ t: 'clientTerminalReleased', terminalId: terminal.id });
        }
      },
    };
  },

  /** After a takeover: re-attach the client terminals the record shows still running in the keeper, before answering anything. */
  async $adoptClientTerminals(this: Connection): Promise<void> {
    const caps = this.caps;
    if (!(caps instanceof ClientCaps) || !this.keeper || !this.channel?.client) return;
    const notes = [...this.$sideNotes.values()].map((n) => clientTerminalNote(n)).filter((n) => n && n.channel);
    if (!notes.length) return;
    const client = this.channel.client;
    const channels = new Map((await client.list()).map((info) => [info.channel, info]));
    for (const note of notes) {
      const info = channels.get(note!.channel!);
      if (!info || caps.terminals.has(note!.terminalId)) continue;
      if (this.$releasedTerminals.has(note!.terminalId)) { // released, but not yet removed when the old AIB stopped
        try {
          if (info.live) await this.keeper.stopUnknown(client, info.channel);
          await this.keeper.removeEnded(client, info.channel);
        } catch { /* next time */ }
        continue;
      }
      const terminal = KeeperClientTerminal.adopt(this.keeper, note!, info);
      try {
        await Promise.race([
          terminal.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 15000)),
        ]);
        caps.adoptTerminal(terminal);
      } catch (error) {
        log.warning('keeper: could not take over client terminal %s: %s', note!.terminalId, errorText(error));
      }
    }
  },

  /** The replay reached the live end: claim the channel (the old AIB can no longer write), send what it never sent, go live. */
  async $caughtUp(this: Connection): Promise<void> {
    if (!this.$replaying || this.rebuildError || this.$ended) return;
    try {
      await this.$replayFromSnapshot();
    } catch (error) {
      return this.$rebuildFailed(error);
    }
    this.rebuildTimes.replayed = performance.now();
    if (this.rebuildError || this.$ended) return;
    try {
      await this.channel!.claim();
    } catch (error) {
      return this.$rebuildFailed(error);
    }
    // The store catches up in the background: the chat is live at once (a slow or stuck store never holds the rebuild back).
    // Events made meanwhile are queued; nothing is written before the take-over has claimed the store and dropped what it replaces.
    if (this.historyState === 'open') {
      this.$historyAdopting = true;
      this.$historyAdopt = this.$historyTakeOver().finally(() => {
        this.$historyAdopting = false;
        if (this.$historyQueue.length && this.historyState === 'claimed') this.$historySchedule();
      });
    }
    this.$replaying = false;
    this.$clock = null;
    try {
      await this.$adoptClientTerminals(); // terminal/output, wait_for_exit, kill and release are answered from these
    } catch (error) {
      log.warning('keeper: taking over client terminals failed: %s', errorText(error));
    }
    const held = this.$held;
    this.$held = [];
    for (const { message, once } of held) {
      try {
        this.write(message, once); // never resends: each carries its once-key, and the record showed it was not written
      } catch (error) {
        log.warning('keeper: could not send a held answer: %s', errorText(error));
      }
    }
    const deferred = this.$deferred;
    this.$deferred = [];
    for (const message of deferred) {
      const answered = this.$answerDeferred(message);
      if (answered instanceof Promise) answered.catch((error) => log.exception(error, 'Client capability request failed'));
    }
    this.rebuildTimes.settled = performance.now();
    this.$settleRebuild?.[0]();
    this.$settleRebuild = null;
  },

  /** A client capability request the old AIB had not answered: answer it now, unless its note says it was already acted on. */
  $answerDeferred(this: Connection, message: Json): void | Promise<void> {
    const key = JSON.stringify(message.id);
    const method = message.method;
    const terminalNote = method === 'terminal/create' ? clientTerminalNote(this.$sideNotes.get(`clientTerminal:${key}`) ?? null) : null;
    if (terminalNote) {
      const caps = this.caps instanceof ClientCaps ? this.caps : null;
      if (terminalNote.channel && caps?.terminals.has(terminalNote.terminalId)) {
        // Started before the restart and still there in the keeper: this is its answer.
        this.write({ jsonrpc: '2.0', id: message.id, result: { terminalId: terminalNote.terminalId } });
        return;
      }
      if (terminalNote.channel && caps?.terminalBackend) {
        // Noted but never started (the old AIB stopped in between): start it now under the noted id; the keeper refuses a second one.
        caps.pinTerminal(message.id, terminalNote.terminalId);
        return this.$dispatchCaps(message);
      }
      this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'The terminal was lost when AIB restarted. It was not started again.' },
      });
      return;
    }
    const written = this.$sideNotes.get(`fsWrite:${key}`);
    if (method === 'fs/write_text_file' && written) {
      const params = get(message, 'params', {}) as Json;
      try {
        const hash = createHash('sha256').update(Deno.readFileSync(String(params.path))).digest('hex');
        if (hash === written.sha256) {
          this.write({ jsonrpc: '2.0', id: message.id, result: null }); // the write happened before the restart
          return;
        }
      } catch { /* not there: write it */ }
    }
    return this.$dispatchCaps(message);
  },

  // ---- snapshots: a rebuild starts at the newest one instead of the start of the record -----------------------------------------
  /** A record met while replaying: kept until the replay has caught up; a snapshot note drops what it already covers. */
  $bufferReplay(this: Connection, record: KeeperRecord): void {
    if (record.kind === 'note') {
      const note = parseNote(record.body);
      if (note?.t === 'event' && note.chunk === 1 && Array.isArray(note.events)) { // stored history (written before a snapshot)
        this.$replayChunks.set(record.seq, note.events.filter(isDict) as Json[]);
        return;
      }
      if (note?.t === 'snapshot' && (note.sv === 1 || note.sv === 2) && isDict(note.state) && isInt(note.upTo)) {
        // The store's checkpoint covers this note (the note written for it, or an older one): used only for the skip rule.
        const ours = this.$storeSnapshot;
        if (ours && (note.upTo as number) <= (ours.note.upTo as number)) {
          if (this.$replaySnapshot === ours && record.seq > ours.seq) ours.seq = record.seq;
          return;
        }
        // This build's note whose events never reached the store (a crash between the note and the flush): not a state to restore.
        // The journal still holds every record after the store's checkpoint (truncate waits for the commit), so the replay rebuilds
        // them; only when nothing else covers the record (no checkpoint and the journal was truncated) is it used, without history.
        const st = note.state as Json;
        const storeNote = note.sv === 2 && isInt(st.sequence) && st.eventsFrom === st.sequence + 1 && !(Array.isArray(note.events) && note.events.length);
        const opened = this.$historyOpened;
        if (storeNote && opened && this.historyState === 'open' && (st.sequence as number) > opened.writtenSeq && (ours || !this.$replayGapNext)) {
          return;
        }
        if (note.sv === 2 && Array.isArray(note.events) && note.events.length) {
          this.$replayChunks.set(record.seq, note.events.filter(isDict) as Json[]);
        }
        delete note.events; // kept once, in the chunks
        this.$replaySnapshot = { note, seq: record.seq };
        const upTo = note.upTo;
        this.$replayBuffer = this.$replayBuffer.filter((r) => r.seq > upTo);
        // Chunks wholly before the history this snapshot keeps are no longer needed.
        const from = note.sv === 2 && isInt(note.state.eventsFrom) ? note.state.eventsFrom : Infinity;
        for (const [seq, events] of this.$replayChunks) {
          if (!events.length || (events.at(-1)!.seq as number) < from) this.$replayChunks.delete(seq);
        }
        return;
      }
    }
    this.$replayBuffer.push(record);
  },

  /** At the live end: restore the newest snapshot (if any), then handle the records after it, all with side effects off. */
  async $replayFromSnapshot(this: Connection): Promise<void> {
    const snapshot = this.$replaySnapshot;
    const records = this.$replayBuffer;
    const chunks = this.$replayChunks;
    this.$replayBuffer = [];
    this.$replaySnapshot = null;
    this.$replayChunks = new Map();
    if (this.$replayGapNext && (!snapshot || (snapshot.note.upTo as number) < this.$replayGapNext - 1)) {
      throw new Error(`the record before ${this.$replayGapNext} is no longer kept and no snapshot covers it`);
    }
    this.$restoredSnapshot = snapshot;
    const stored = snapshot ? await this.$historyRestoreEvents(snapshot.note) : null;
    if (snapshot) this.$restoreSnapshot(snapshot.note, chunks, stored);
    this.replayedFrom = snapshot ? snapshot.seq : 0;
    for (const record of records) {
      if (this.rebuildError || this.$ended) return;
      // AIB's own writes and notes before the snapshot note were made before it was taken: the snapshot has them already.
      if (snapshot && record.seq < snapshot.seq && (record.kind === 'in' || record.kind === 'note')) continue;
      this.replayedRecords += 1;
      await this.$onRecord(record);
    }
  },

  /** The state a snapshot note carries, put back exactly (what the replay of everything before `upTo` would have rebuilt). */
  $restoreSnapshot(this: Connection, note: Json, chunks: Map<number, Json[]>, stored: Json[] | null = null): void {
    const s = note.state as Json;
    const entries = (value: unknown) => (Array.isArray(value) ? value.filter((e) => Array.isArray(e) && e.length === 2) : []);
    this.initial = s.initial ?? {};
    if (isDict(this.initial) && Object.keys(this.initial).length) this.$applyInitialize();
    this.sessionId = isStr(s.sessionId) ? s.sessionId : null;
    this.ready = s.ready === true;
    this.settings = isDict(s.settings) ? s.settings : {};
    this.knownSessions = new Set(Array.isArray(s.knownSessions) ? s.knownSessions.filter(isStr) : []);
    this.counter = isInt(s.counter) ? s.counter : 0;
    this.promptSeq = isInt(s.promptSeq) ? s.promptSeq : 0;
    this.ownerTouched = s.ownerTouched === true;
    this.cancelSeq = isInt(s.cancelSeq) ? s.cancelSeq : 0;
    this.changeSeq = isInt(s.changeSeq) ? s.changeSeq : 0;
    this.changeFailures = Array.isArray(s.changeFailures) ? s.changeFailures.filter(isDict) as Json[] : [];
    this.turnEndedAt = typeof s.turnEndedAt === 'number' ? s.turnEndedAt : null;
    this.sequence = isInt(s.sequence) ? s.sequence : 0;
    if (note.sv === 1) { // beta.8 and before: the whole history inside the note; the next snapshot stores it in chunks
      this.events = Array.isArray(s.events) ? s.events.filter(isDict) as Json[] : [];
      this.$eventsSaved = 0;
      this.$eventChunks = [];
    } else if (stored) { // the history store: its events up to the note's history start, then the chunks' (an older build's note)
      const from = isInt(s.eventsFrom) ? s.eventsFrom : this.sequence + 1;
      const last = stored.length ? stored.at(-1)!.seq as number : 0;
      this.events = [...stored, ...this.$chunkEvents(chunks, Math.max(from, last + 1))];
      this.$eventsSaved = this.sequence;
      this.$eventChunks = [];
    } else {
      this.events = this.$chunkEvents(chunks, isInt(s.eventsFrom) ? s.eventsFrom : this.sequence + 1);
      this.$eventsSaved = this.sequence;
      this.$eventChunks = [...chunks].filter(([, e]) => e.length).map(([seq, e]) => [seq, e.at(-1)!.seq as number] as [number, number])
        .sort((a, b) => a[0] - b[0]);
    }
    this.eventImageBytes = this.events.reduce((sum, e) => sum + eventImageSize(e), 0);
    this.subagents = new Map(entries(s.subagents) as [string, Json][]);
    this.$liveHelpers = new Set(Array.isArray(s.liveHelpers) ? s.liveHelpers.filter(isStr) : []);
    const times = (value: unknown) => new Map(entries(value).filter((e) => isStr(e[0]) && typeof e[1] === 'number') as [string, number][]);
    this.$helperSince = times(s.helperSince);
    for (const child of this.$liveHelpers) if (!this.$helperSince.has(child)) this.$helperSince.set(child, this.$now()); // an older note
    this.$shellSince = times(s.shellSince);
    this.turnFailedAt = typeof s.turnFailedAt === 'number' ? s.turnFailedAt : null;
    this.turnError = isStr(s.turnError) ? s.turnError : '';
    const asks = isDict(s.asks) ? s.asks : null;
    this.$asks = asks && typeof asks.at === 'number' && isStr(asks.question) ? { at: asks.at, question: asks.question } : null;
    const stall = isDict(s.stall) ? s.stall : null;
    this.$stall = stall && typeof stall.at === 'number' && isStr(stall.kind)
      ? { at: stall.at, kind: stall.kind, step: isStr(stall.step) ? stall.step : '' }
      : null;
    this.$lastStep = isStr(s.lastStep) ? s.lastStep : '';
    this.$workEndedAt = typeof s.workEndedAt === 'number' ? s.workEndedAt : null;
    this.$bgShells = new Map(
      (Array.isArray(s.bgShells) ? s.bgShells : []).filter((e): e is [string, number[] | null] =>
        Array.isArray(e) && isStr(e[0]) && (e[1] === null || (Array.isArray(e[1]) && e[1].every(isInt)))
      ),
    );
    this.$bgTools = new Map(
      entries(s.bgTools).filter((e) => isStr(e[0]) && isDict(e[1]) && isStr((e[1] as Json).task)) as [string, BackgroundTool][],
    );
    const b = isDict(s.breadth) ? s.breadth : {};
    this.breadth = {
      ...newState(),
      ...b,
      compaction: new Map(entries(b.compaction) as [string, never][]),
    } as BreadthState;
    this.writes.paths.clear();
    for (const [k, v] of entries(isDict(s.writes) ? s.writes.paths : null)) this.writes.paths.set(k as string, v as number);
    this.writes.calls.clear();
    for (const [k] of entries(isDict(s.writes) ? s.writes.calls : null)) this.writes.calls.set(k as string, true);
    this.promptReceipts = new Map(entries(s.promptReceipts) as [string, Receipt][]);
    this.$requestsSeen = new Map(entries(s.requestsSeen) as [string, number][]);
    this.withdrawn = new Map(entries(s.withdrawn) as [string, string][]);
    this.stderr = Array.isArray(s.stderr) ? s.stderr.filter(isStr) : [];
    if (isStr(s.eventsId) && s.eventsId) this.eventsId = s.eventsId;
    this.$lastSeq = note.upTo as number;
  },

  /**
   * The history a version-2 snapshot keeps: the stored events from `from` to `sequence`, each once, in order. A chunk that is gone
   * (the keeper's size cap dropped an old segment) leaves the history starting after the hole, never with one in it.
   */
  $chunkEvents(this: Connection, chunks: Map<number, Json[]>, from: number): Json[] {
    const bySeq = new Map<number, Json>();
    for (const events of chunks.values()) {
      for (const e of events) {
        const seq = e.seq;
        if (isInt(seq) && seq >= from && seq <= this.sequence) bySeq.set(seq, e);
      }
    }
    const out: Json[] = [];
    for (let seq = this.sequence; seq >= from; seq--) {
      const e = bySeq.get(seq);
      if (!e) {
        log.warning('keeper: %s: events %s..%s are no longer stored; the history starts after them', this.id, from, seq);
        break;
      }
      out.push(e);
    }
    return out.reverse();
  },
};

export type ReplayMethods = typeof replayMethods;
