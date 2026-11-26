/**
 * Connection methods: JSON-RPC to and from the agent process (write, request, the stdout and stderr readers, one line handled).
 * Moved out of connection.ts (no change).
 */
import { stripAibMessage } from '../allow/aib_prefix.ts';
import { KILL_BY_NAME_REASON, permissionKillsByName } from '../allow/kill_by_name.ts';
import { screen } from './acp_schema.ts';
import { applyUpdate, augmentInitialize } from './breadth.ts';
import { clip, isDict, isStr, ValueError } from '../core/py.ts';
import {
  log,
  type Json,
  TimeoutError,
  BrokenPipeError,
  errorName,
  errorText,
  isOsOrValueError,
  pget,
  get,
  ENCODER,
  RSTRIP,
  now,
} from './conn_util.ts';
import { ThreadEvent, PyTextLines } from './thread_text.ts';
import { type Pending } from './conn_types.ts';
import { Connection } from './connection.ts';

export const ioMethods = {
  /** One JSON-RPC message to the agent. Writes go out in call order; throws when the agent's stdin is known to be gone. */
  write(this: Connection, message: unknown, once?: string): void {
    if (this.channel) {
      if (this.$stdinClosed) throw new ValueError('I/O operation on closed file.');
      if (this.$stdinBroken) throw new BrokenPipeError('[Errno 32] Broken pipe');
      if (this.rebuildError) return; // read-only: nothing reaches the agent from here
      const key = once ?? this.$onceKey(message as Json);
      if (this.$replaying) {
        this.$held.push({ message: message as Json, once: key });
        return;
      }
      void this.channel.write(ENCODER.encode(JSON.stringify(message) + '\n'), key);
      return;
    }
    const writer = this.$stdin;
    if (writer === null || this.$stdinClosed) {
      throw new ValueError('I/O operation on closed file.');
    }
    if (this.$stdinBroken) throw new BrokenPipeError('[Errno 32] Broken pipe');
    writer.write(ENCODER.encode(JSON.stringify(message) + '\n')).catch(() => {
      this.$stdinBroken = true;
    });
  },

  /**
   * The once-key a keeper write carries, so it can never reach the agent twice (a later AIB that resends it is refused): answers
   * by the agent's request id, requests by our id, a cancel by turn.
   */
  $onceKey(this: Connection, message: Json): string | undefined {
    if (!isDict(message)) return undefined;
    if (!Object.hasOwn(message, 'method')) {
      if (!Object.hasOwn(message, 'id')) return undefined;
      const id = JSON.stringify(message.id); // agents may reuse a request id in a later turn: the key counts its uses
      return `resp:${id}:${this.$requestsSeen.get(id) ?? 0}`;
    }
    if (Object.hasOwn(message, 'id')) return `req:${JSON.stringify(message.id)}`;
    if (message.method === 'session/cancel') {
      return `cancel:${JSON.stringify(get(get(message, 'params', {}) as Json, 'sessionId'))}:${this.promptSeq}`;
    }
    return undefined;
  },

  async request(
    this: Connection,
    method: string,
    params: unknown,
    timeout = 30,
    options: { once?: string; note?: (id: number) => Json | null } = {},
  ): Promise<unknown> {
    if (method === 'initialize') params = augmentInitialize(params as Json);
    this.counter += 1;
    const key = this.counter;
    const entry: Pending = { done: new ThreadEvent(), method, params };
    this.pending.set(key, entry);
    try {
      const note = this.channel && options.note ? options.note(key) : null;
      if (note) void this.channel!.sendNote(note); // goes out before the write: the record says what it is first
      this.write({ jsonrpc: '2.0', id: key, method, params }, options.once);
      if (!(await entry.done.wait(timeout * 1000))) {
        throw new TimeoutError(
          `${method} did not respond within ${timeout} seconds`,
        );
      }
      return Connection.$result(entry.response!);
    } finally {
      this.pending.delete(key);
    }
  },

  /** A request the old AIB sent (rebuilt from the record): wait for its response, which comes from the record or live. */
  async $awaitReplayed(this: Connection, entry: Pending, id: unknown): Promise<unknown> {
    try {
      await entry.done.wait();
      return Connection.$result(entry.response!);
    } finally {
      if (this.pending.get(id) === entry) this.pending.delete(id);
    }
  },

  $pushStderr(this: Connection, line: string): void {
    this.stderr.push(line);
    while (this.stderr.length > 30) this.stderr.shift();
  },

  async $readErrors(this: Connection, stream: ReadableStream<Uint8Array>): Promise<void> {
    const lines = new PyTextLines();
    const reader = this.$stderrReader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of lines.feed(value)) {
          this.$pushStderr(clip(line.replace(RSTRIP, ''), 2000));
        }
      }
      for (const line of lines.feed(null, true)) {
        this.$pushStderr(clip(line.replace(RSTRIP, ''), 2000));
      }
    } catch {
      /* the pipe went away: just stop */
    } finally {
      reader.releaseLock();
    }
  },

  async $read(this: Connection, stream: ReadableStream<Uint8Array>): Promise<void> {
    let failure = '';
    const lines = new PyTextLines();
    const reader = this.$stdoutReader = stream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of lines.feed(value)) {
          const pending = this.$handleLine(line);
          if (pending) await pending;
        }
      }
      for (const line of lines.feed(null, true)) {
        const pending = this.$handleLine(line);
        if (pending) await pending;
      }
    } catch (error) {
      if (isOsOrValueError(error)) this.error = errorText(error);
      else {
        failure = this.$internalFailure(error);
        try {
          await reader.cancel();
        } catch { /* already gone */ }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch { /* a read is still pending (close() cancels it) */ }
      this.$readerEnded(failure);
    }
  },

  /** A bug in one of our handlers must not leave a half-working connection behind: say what happened, then stop the agent. */
  $internalFailure(this: Connection, error: unknown): string {
    log.exception(
      error,
      'Internal error while reading from the agent; closing the connection',
    );
    const name = errorName(error);
    const message = errorText(error);
    const frames = error instanceof Error && error.stack ? error.stack.split(/\r?\n/).slice(1).map((l) => l.trim()).reverse() : [];
    const trace = [
      'Traceback (most recent call last):',
      ...frames,
      `${name}: ${message}`,
    ].join('\n');
    this.traceback = trace;
    for (const line of trace.split('\n').slice(-12)) {
      this.$pushStderr(clip(line, 2000));
    }
    const failure =
      `AIB hit an internal error while reading from the agent (${name}: ${message}). The connection was closed; reconnect to continue.`;
    this.error = failure;
    try {
      this.tree?.kill();
    } catch (killError) {
      log.exception(killError, 'Killing the agent process tree failed');
    }
    return failure;
  },

  /** The agent's output ended (it exited, the pipe broke, or the keeper went away): the connection is closed. Runs once. */
  $readerEnded(this: Connection, failure: string): void {
    if (this.$ended) return;
    this.$ended = true;
    try {
      // S1: the agent's output ended while a turn ran, and nobody pressed Stop or closed the chat (close() sets $closing first)
      const turn = this.autonomous || this.cancelSeq < this.promptSeq;
      if (this.busy && turn && !this.$closing && !this.$replaying) this.$stall = { at: this.$now(), kind: 'died', step: this.$lastStep };
      this.closed = true;
      if (this.closedAt === null) this.closedAt = now();
      this.ready = false;
      this.busy = false;
      this.permissions.clear();
      this.pendingChanges.clear();
      this.$clearElicitations({});
      const message = failure ||
        'ACP connection closed. ' + this.stderr.slice(-3).join('\n');
      for (const entry of this.pending.values()) {
        // An answer that already arrived is kept.
        if (entry.done.isSet()) continue;
        entry.response = { error: { message } };
        entry.done.set();
      }
      this.releaseLease();
      this.$shutdownCaps();
      this.event('disconnected', {
        message: this.error || 'Agent connection closed',
      });
      // the chat ended (its agent exited, the keeper was lost): its store is written to the end and closed, and kept
      if (!this.$replaying) void this.$historyFinish();
    } finally {
      this.$endedResolve?.();
      this.$settleRebuild?.[0](); // ended during the rebuild: the caller sees it closed
      this.$settleRebuild = null;
    }
  },

  /** One stdout line, handled before the next is read. Returns a promise when the next line must wait (a reply, a capability call). */
  $handleLine(this: Connection, line: string): Promise<void> | void {
    const message = screen(this, line) as Json | null;
    if (message === null) return;
    // AIB's cookie prefix on a subagent's shell command is AIB's, not the agent's: everything below (the allow gate, the approval card, Activity,
    // history, notifications) sees the command the agent meant (allow/aib_prefix.ts). The cheap text test keeps every other line untouched.
    if (line.includes('AIB_PROC=')) stripAibMessage(message, this.id);
    if (!Object.hasOwn(message, 'method')) {
      const waiting = this.pending.get(get(message, 'id'));
      if (waiting) {
        waiting.response = message;
        waiting.done.set();
        // Let the caller that waited on this reply run before the next line is read, so the waiter wakes at once:
        // a repeated reply then finds no pending request, and a turn's end is recorded before what the agent sent after it.
        return new Promise((resolve) => setTimeout(resolve, 0));
      }
      return;
    }
    const method = message.method as string;
    const params = get(message, 'params', {}) as Json;
    if (Object.hasOwn(message, 'id')) {
      const seenKey = JSON.stringify(message.id);
      this.$requestsSeen.set(seenKey, (this.$requestsSeen.get(seenKey) ?? 0) + 1);
      if (
        method === 'session/request_permission' && this.ownArtifactTool(params)
      ) {
        // AIB's own artifact tool only publishes into this chat; never make the user approve it.
        const options = get(params, 'options', []);
        const allow = (Array.isArray(options) ? options : []).find((o) => isDict(o) && o.kind === 'allow_once') as Json | undefined;
        if (allow && isStr(allow.optionId)) {
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              outcome: { outcome: 'selected', optionId: allow.optionId },
            },
          });
          return;
        }
      }
      // kill by name is refused for every agent (allow/kill_by_name.ts): the fallback for an agent without a hook, or with hooks off
      if (method === 'session/request_permission' && !this.$replaying && permissionKillsByName(params)) {
        const options = get(params, 'options', []);
        const no = (Array.isArray(options) ? options : []).find((o) => isDict(o) && o.kind === 'reject_once') as Json | undefined;
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          result: { outcome: no && isStr(no.optionId) ? { outcome: 'selected', optionId: no.optionId } : { outcome: 'cancelled' } },
        });
        this.recordedEvent('studio_note', { message: `AIB refused a command that kills processes by name: ${KILL_BY_NAME_REASON}`, sessionId: this.sessionId });
        return;
      }
      // a WSL chat: the distro facts the matcher needs are fetched first (allow/wsl_facts.ts); the next line waits for it
      if (method === 'session/request_permission' && this.allowGate && this.wsl && !this.$replaying) {
        return this.$allowByRuleWsl(message, params, seenKey);
      }
      if (method === 'session/request_permission' && this.allowGate && this.$allowByRule(message, params, seenKey)) return;
      if (method === 'session/request_permission') {
        this.$permissionCard(message, params);
      } else if (this.caps.handles(method)) {
        if (this.$replaying) { // answered once live, unless the record shows the old AIB answered it
          this.$deferred.push(message);
          return;
        }
        const answered = this.$dispatchCaps(message);
        // terminal/wait_for_exit can take as long as the command runs: answered on its own. Everything
        // else is answered before the next line is read.
        if (method !== 'terminal/wait_for_exit') return answered;
        answered?.catch((error) => log.exception(error, 'Client capability request failed'));
      } else if (method === 'elicitation/create') {
        try {
          this.receiveElicitation(message.id, params);
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !['ValueError', 'TypeError', 'KeyError'].includes(error.name)
          ) throw error;
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32602, message: errorText(error) },
          });
        }
      } else {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: {
            code: -32601,
            message: `Client capability not advertised: ${method}`,
          },
        });
      }
    } else if (method === 'session/update') {
      if (this.$reload) { // the history a session/load after a hand-off sends: #reattach shows only the outside turns
        if (!this.$reload.discard) this.$reload.window.push(params); // the newest updates (bounded): the outside turns are at the end
        return;
      }
      this.$noteUserText(params);
      const update = get(params, 'update', {}) as Json;
      const sid = get(params, 'sessionId');
      if (isStr(sid) && sid) this.knownSessions.add(sid);
      // Some agents report subagent session IDs in update payloads.
      for (const name of ['subagentSessionId', 'childSessionId']) {
        const child = pget(update, name);
        if (isStr(child) && child) this.knownSessions.add(child);
      }
      const subagent = get(update, 'subagent');
      if (isDict(subagent) && isStr(subagent.sessionId) && subagent.sessionId) {
        this.knownSessions.add(subagent.sessionId);
      }
      if (this.sessionId === null || sid === null || sid === this.sessionId) {
        applyUpdate(this.breadth, update, this.$now());
        const meta = get(update, 'sessionUpdate') === 'usage_update' ? get(update, '_meta') : null;
        if (isDict(meta) && isDict(meta['_claude/rateLimit'])) {
          this.onLimits?.(this, 'claude-rate-limit', meta['_claude/rateLimit'], this.$now());
        }
      }
      // The chat's own settings only: a subagent's session reports its own config (claude-agent-acp: the helper's model, mode,
      // effort and agent type), which must not replace the chat's.
      const own = this.sessionId === null || sid === null || sid === this.sessionId;
      if (own && get(update, 'sessionUpdate') === 'config_option_update') {
        this.settings.configOptions = get(update, 'configOptions', []);
        this.$withModels(this.settings); // an agent's models list stays offered as the model option
      }
      if (own && get(update, 'sessionUpdate') === 'current_mode_update') {
        this.$modes().currentModeId = get(update, 'currentModeId');
      }
      this.writes.observe(params);
      const done = this.writes.finished(params);
      if (done.length) this.onWritesDone?.(this, done);
      if (this.$merger && !this.ready) this.$mergeReplayed(params);
      this.event('update', params);
      this.$watchTools(params);
      return this.$watchHeldTurn(params);
    } else if (method === 'elicitation/complete') {
      this.completeElicitation(params);
    } else if (method === '$/cancel_request') {
      this.cancelIncomingRequest(
        isDict(params) ? get(params, 'requestId') : null,
      );
    } else {
      this.event('notice', { method, params });
    }
  },
};

export type IoMethods = typeof ioMethods;
