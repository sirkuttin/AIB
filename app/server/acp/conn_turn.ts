/**
 * Connection methods: discovery calls, preparing and sending a prompt, running a turn, and changing settings.
 * Moved out of connection.ts (no change).
 */
import { createHash } from 'node:crypto';
import {
  buildConfigRequest,
  checkMode,
  currentValue,
  sessionCapabilities,
  isModelsOption,
  withModelsOption,
  withServerModels,
} from './breadth.ts';
import { isAuthRequired, PromptStateUnknown } from './rpc_errors.ts';
import {
  type FileSummary,
  type ImageBlock,
  mapFileAttachments,
  MAX_TOTAL_ATTACHMENT_BYTES,
  splitAttachments,
  validateFileAttachments,
  validateImageAttachments,
} from './attachments.ts';
import { isClaudeFamily } from '../agents/claude_family.ts';
import { APP_VERSION } from '../core/app.ts';
import { HeldElsewhere } from '../ownership/claude_sessions.ts';
import { claudeConfigDir, isForkSkill, typedForkSkillText } from '../subagents/claude_config.ts';
import { clip, isDict, isStr, pyLen, pyStrip, pyTruthy, pyTypeName, ValueError } from '../core/py.ts';
import { log, type Json, errorName, errorText, get, pyEq, sortedCompactJson, now } from './conn_util.ts';
import { type Pending, type PendingChange } from './conn_types.ts';
import { HELD, PROMPT_UNKNOWN, asRpcError, isAgentBusyError, busyRetry } from './conn_steer.ts';
import { Connection } from './connection.ts';

export const turnMethods = {
  async $probeSettings(this: Connection, timeoutSeconds: number): Promise<Json> {
    await this.initializeForDiscovery();
    const result = await this.request('session/new', { cwd: this.agentCwd, mcpServers: [] }, timeoutSeconds);
    if (!isDict(result)) throw new ValueError('The agent returned an invalid session response');
    this.$withModels(result); // the remembered lists (agent-options.json) keep an agent's models list as its model option
    const sid = get(result, 'sessionId');
    const caps = sessionCapabilities(this.initial);
    if (isStr(sid) && sid && caps.ops.includes('close')) {
      try {
        await this.request('session/close', { sessionId: sid }, 5);
      } catch { /* the process is ended next anyway */ }
    }
    return result;
  },

  /**
   * Name a saved session the agent's own way, in this short-lived process (no session loaded, no prompt, no model call): Claude
   * Code's and Codex's adapters offer `_session/rename` to a client that declares their session index extension
   * (`_meta.jetbrains.air.capabilities: ["sessionIndex"]`, which only this probe process declares: a chat's own process stays a
   * plain ACP client). Claude Code's adapter appends the same `custom-title` / `agent-name` records and `custom-title.json` the
   * CLI's `/rename` writes; codex-acp sets the thread name through its app-server (`thread/name/set`). Returns false when the agent
   * does not offer it (an older adapter, another agent); throws on a refusal.
   */
  async renameSessionTitle(this: Connection, sessionId: string, title: string, timeoutSeconds = 45): Promise<boolean> {
    this.initial = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'agent-studio', title: 'AIB', version: APP_VERSION },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { jetbrains: { air: { version: 1, capabilities: ['sessionIndex'] } } },
      },
    }, timeoutSeconds);
    if (!isDict(this.initial) || !pyEq(get(this.initial, 'protocolVersion'), 1)) {
      throw new ValueError('The agent did not negotiate supported ACP protocol version 1');
    }
    const meta = get(this.initial, '_meta');
    const jetbrains = isDict(meta) ? get(meta, 'jetbrains') : null;
    const air = isDict(jetbrains) ? get(jetbrains, 'air') : null;
    const offered = isDict(air) ? get(air, 'capabilities') : null;
    if (!Array.isArray(offered) || !offered.includes('sessionRename')) return false;
    await this.request('_session/rename', { sessionId, title }, timeoutSeconds);
    return true;
  },

  /** Initialize only (no session) so session/list can run in a short-lived process. */
  async initializeForDiscovery(this: Connection): Promise<void> {
    this.initial = await this.request('initialize', {
      protocolVersion: 1,
      clientInfo: {
        name: 'agent-studio',
        title: 'AIB',
        version: APP_VERSION,
      },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    }, 45);
    if (
      !isDict(this.initial) || !pyEq(get(this.initial, 'protocolVersion'), 1)
    ) {
      throw new ValueError(
        'The agent did not negotiate supported ACP protocol version 1',
      );
    }
  },

  async listSessions(
    this: Connection,
    cwd: string | null = null,
    cursor: string | null = null,
  ): Promise<Json> {
    const capabilities = isDict(this.initial) ? get(this.initial, 'agentCapabilities', {}) : {};
    const sessionCaps = isDict(capabilities) ? get(capabilities, 'sessionCapabilities') : null;
    if (!isDict(sessionCaps) || get(sessionCaps, 'list') === null) {
      return { supported: false, sessions: [], nextCursor: null };
    }
    const params: Json = {};
    if (cwd) params.cwd = cwd;
    if (cursor) params.cursor = cursor;
    const result = await this.request('session/list', params, 60);
    const raw = isDict(result) ? get(result, 'sessions') : null;
    if (!Array.isArray(raw)) {
      throw new ValueError('The agent returned an invalid session list');
    }
    const sessions: Json[] = [];
    for (const item of raw.slice(0, 500)) {
      if (
        isDict(item) && isStr(item.sessionId) && item.sessionId &&
        pyLen(item.sessionId) <= 512 && isStr(item.cwd)
      ) {
        sessions.push({
          sessionId: item.sessionId,
          cwd: clip(item.cwd, 1024),
          title: isStr(item.title) ? clip(item.title, 300) : '',
          updatedAt: isStr(item.updatedAt) ? item.updatedAt : '',
        });
      }
    }
    const nextCursor = get(result as Json, 'nextCursor');
    return {
      supported: true,
      sessions,
      nextCursor: isStr(nextCursor) && nextCursor ? nextCursor : null,
    };
  },

  preparePrompt(
    this: Connection,
    text: unknown,
    clientMessageId: unknown,
    attachments: unknown,
  ): [ImageBlock[], Json[], FileSummary[], string] {
    if (!isStr(text) || pyLen(text) > 200000) {
      throw new ValueError('Prompt text must be at most 200,000 characters');
    }
    if (!(isStr(clientMessageId) && /^(swarm|merge)-/.test(clientMessageId))) this.ownerTouched = true;
    let imageBlocks: ImageBlock[] = [];
    let fileBlocks: Json[] = [];
    let fileSummaries: FileSummary[] = [];
    let fileFingerprints: Json[] = [];
    if (
      attachments !== null && attachments !== undefined &&
      !(Array.isArray(attachments) && attachments.length === 0)
    ) {
      const [imageItems, fileItems] = splitAttachments(attachments);
      let imageTotal = 0;
      if (imageItems.length) {
        if (!this.imageSupported) {
          throw new ValueError(
            'This agent does not advertise image prompt support',
          );
        }
        [imageBlocks, imageTotal] = validateImageAttachments(imageItems);
      }
      if (fileItems.length) {
        const [records, fileTotal] = validateFileAttachments(fileItems);
        if (imageTotal + fileTotal > MAX_TOTAL_ATTACHMENT_BYTES) {
          throw new ValueError(
            `Attachments exceed the ${Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / 1048576)} MiB total limit`,
          );
        }
        [fileBlocks, fileSummaries] = mapFileAttachments(
          records,
          this.promptCaps,
        );
        fileFingerprints = records.map((r) => ({
          name: r.name,
          mimeType: r.mimeType,
          size: r.size,
          sha256: r.sha256,
        }));
      }
    }
    if (!pyStrip(text) && !imageBlocks.length && !fileBlocks.length) {
      throw new ValueError(
        'Enter a prompt or attach at least one image or file',
      );
    }
    if (
      clientMessageId !== null && clientMessageId !== undefined &&
      (!isStr(clientMessageId) || pyLen(clientMessageId) < 1 ||
        pyLen(clientMessageId) > 128)
    ) throw new ValueError('Invalid client message ID');
    let data: string;
    if (fileFingerprints.length) {
      data = sortedCompactJson([text, imageBlocks, fileFingerprints]);
    } else if (imageBlocks.length) {
      data = sortedCompactJson([text, imageBlocks]);
    } else data = text;
    const fingerprint = createHash('sha256').update(
      new TextEncoder().encode(data),
    ).digest('hex');
    return [imageBlocks, fileBlocks, fileSummaries, fingerprint];
  },

  async prompt(
    this: Connection,
    text: unknown,
    clientMessageId: string | null = null,
    attachments: unknown = null,
  ): Promise<Json> {
    const [imageBlocks, fileBlocks, fileSummaries, fingerprint] = this
      .preparePrompt(text, clientMessageId, attachments);
    let receipt = clientMessageId ? this.promptReceipts.get(clientMessageId) ?? null : null;
    if (!receipt && clientMessageId && this.recovery && this.sessionId) {
      receipt = this.recovery.receipt(this, clientMessageId);
    }
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new ValueError(
          'This client message ID was already used for different text',
        );
      }
      if (receipt.state === 'unknown') {
        throw new PromptStateUnknown(PROMPT_UNKNOWN);
      }
      // B3: a steer the agent did not take (promptRequired, or it failed) goes again as this prompt, with the same id.
      if (receipt.state !== 'steering') {
        return {
          accepted: true,
          duplicate: true,
          clientMessageId,
          turnState: receipt.state,
        };
      }
    }
    this.$refuseReadOnly();
    // Open elsewhere: AIB let go of this chat. Sending takes it back when nobody else holds it; still held: nothing is sent.
    if (this.elsewhere?.released && !this.closed) {
      const back = await this.reclaim(false);
      if (back.state === 'held') throw new HeldElsewhere(back.app || 'another app', this.singleWriter);
    }
    if (this.closed || !this.ready || !this.sessionId) {
      throw new ValueError('This connection is not ready');
    }
    // Build plan 1b, 2.3: a landing holds this chat's folder. Every route that starts a turn comes through here (the page, a steer while
    // idle, the phone, a helper's report, a merge prompt): it waits in the queue instead, and goes when the landing lets go.
    if (this.landing) {
      if (clientMessageId && receipt?.state === 'steering') this.promptReceipts.delete(clientMessageId); // a steer the agent did not take
      return await this.$queueForLanding(text, clientMessageId, attachments);
    }
    // A cycle Claude Code started on its own does not refuse a prompt: the prompt's turn takes the cycle over, as the adapter does.
    if (this.busy && !this.autonomous) {
      throw new ValueError(
        'Wait for the current turn, or interrupt it before sending another prompt',
      );
    }
    const forkRefusal = this.forkSkillRefusal(text);
    if (forkRefusal) return this.$refuseTyped(text, clientMessageId, fingerprint, imageBlocks, fileSummaries, forkRefusal);
    const seq = this.$startTurn(clientMessageId, fingerprint);
    if (this.onUserPrompt) {
      try {
        this.onUserPrompt(this, text, clientMessageId);
      } catch (error) {
        log.exception(error, 'on_user_prompt hook failed');
      }
    }
    await this.$drainPending(); // changes still queued from a finished turn go first; a failure is reported but never drops this prompt
    const userEvent: Json = {
      text,
      attachments: imageBlocks,
      sessionId: this.sessionId,
      clientMessageId,
    };
    if (fileSummaries.length) userEvent.files = fileSummaries; // names, types, sizes and a bounded text preview; never the full content
    this.event('user', userEvent);
    if (isStr(text) && pyStrip(text)) {
      this.$lastUserText = text;
      this.$inUserText = false;
    }
    this.$lastPrompt = { seq, text, attachments };
    this.turn = this.$runTurn(
      seq,
      text as string,
      fileBlocks,
      imageBlocks,
      clientMessageId,
      { receipt: clientMessageId, fingerprint, text, files: fileSummaries },
    );
    return {
      accepted: true,
      duplicate: false,
      clientMessageId,
      turnState: 'working',
    };
  },

  /**
   * Subagent worktrees (work/p3_skill_fork_probe.py typed-*, Claude Code 2.1.310): a skill or command with `context: fork` that the
   * user starts by typing `/name` runs as a forked subagent with no Skill or Agent tool call, so none of AIB's hooks sees it, and it
   * edits this folder (verified in acceptEdits and bypass mode). In a Claude chat under the subagent rule (hooks on, or editing
   * subagents off), AIB doesn't send it: the chat line saying why, else null. Reads the skill files only; never throws.
   */
  forkSkillRefusal(this: Connection, text: unknown): string | null {
    if (!isClaudeFamily(this.provider) || !isStr(text)) return null;
    const h = this.subagentHooks;
    if (!h || !(isDict(h.settings?.hooks) || isDict(h.deny) || h.adopted === true)) return null;
    const m = /^\/(\S+)/.exec(pyStrip(text));
    if (!m) return null;
    try {
      const configDir = h.configDir ?? claudeConfigDir(Deno.env.toObject());
      const project = this.projectRoot || this.cwd;
      const fork = isForkSkill(m[1], this.cwd, configDir) || (project !== this.cwd && isForkSkill(m[1], project, configDir));
      return fork ? typedForkSkillText(m[1].slice(0, 120)) : null;
    } catch (error) {
      log.warning('Could not check /%s for a fork skill: %s', m[1].slice(0, 120), errorText(error));
      return null;
    }
  },

  /** A typed prompt AIB doesn't send (forkSkillRefusal): it shows as sent, then AIB's line says why; no turn starts. */
  $refuseTyped(this: Connection, text: unknown, clientMessageId: string | null, fingerprint: string, attachments: ImageBlock[], files: unknown[], message: string): Json {
    if (clientMessageId) {
      this.promptReceipts.set(clientMessageId, { fingerprint, state: 'finished' });
      this.$receiptChanged(clientMessageId);
    }
    const userEvent: Json = { text, attachments, sessionId: this.sessionId, clientMessageId };
    if (files.length) userEvent.files = files;
    this.event('user', userEvent);
    this.recordedEvent('studio_note', { message, sessionId: this.sessionId });
    setTimeout(() => void this.$queuePump(), 0); // a queued message behind it goes now (the pump stops after a non-duplicate send)
    return { accepted: true, duplicate: false, clientMessageId, turnState: 'finished', refused: message };
  },

  /** The turn begins: busy, and the receipt is "working". Shared by prompt() and a turn rebuilt from the keeper's record. */
  $startTurn(this: Connection, clientMessageId: string | null, fingerprint: string): number {
    this.busy = true;
    this.autonomous = false; // a prompt sent while Claude Code ran a cycle of its own takes that cycle over
    this.$turnHelpers.clear();
    this.$steerTurn = { injected: 0, outputAfter: false, unread: [] };
    this.$clearSettle();
    this.$promptOut.clear();
    this.$noteTurnProcesses();
    this.turnStartedAt = now();
    this.error = '';
    this.turnFailedAt = null; // sending is acting on a failure or a question
    this.turnError = '';
    this.$asks = null;
    this.$stall = null; // and on a stall
    this.$lastOutputAt = this.$now();
    this.promptSeq += 1;
    const seq = this.promptSeq;
    if (clientMessageId) {
      this.promptReceipts.set(clientMessageId, {
        fingerprint,
        state: 'working',
      });
      while (this.promptReceipts.size > 1000) {
        this.promptReceipts.delete(this.promptReceipts.keys().next().value!);
      }
      this.$receiptChanged(clientMessageId);
    }
    return seq;
  },

  async $runTurn(
    this: Connection,
    seq: number,
    text: string,
    fileBlocks: Json[],
    imageBlocks: ImageBlock[],
    clientMessageId: string | null,
    receipt: Json | null,
    replayed: { entry: Pending; id: unknown } | null = null,
  ): Promise<void> {
    try {
      const context = replayed ? null : await this.$aibContext();
      const blocks = [
        ...(context ? [{ type: 'text', text: context[0] }] : []),
        ...(pyStrip(text) ? [{ type: 'text', text }] : []),
        ...fileBlocks,
        ...imageBlocks,
      ];
      let result: unknown;
      if (replayed) { // the old AIB sent it: wait for its response, from the record or live
        const promptReceipt = clientMessageId ? this.promptReceipts.get(clientMessageId) : undefined;
        if (promptReceipt) promptReceipt.sent = true; // the agent has it already (a deliberate stop records it as delivered)
        this.$promptOut.set();
        result = await this.$untilReplyEnds(seq, this.$awaitReplayed(replayed.entry, replayed.id));
      } else if (this.cancelSeq >= seq) { // cancelled while the hook above was still working: the agent never had this turn
        this.$promptOut.set();
        result = { stopReason: 'cancelled' };
      } else {
        // (not `receipt`: that is the keeper's receipt note for this turn, below)
        const promptReceipt = clientMessageId ? this.promptReceipts.get(clientMessageId) : undefined;
        if (promptReceipt) promptReceipt.sent = true;
        const send = (attempt: number): Promise<unknown> =>
          this.request('session/prompt', {
            sessionId: this.sessionId,
            prompt: blocks,
          }, 86400, {
            // keeper: the receipt note goes first, so a later AIB rebuilds the page's message and receipt; the key stops a resend
            note: (id) => receipt ? { t: 'receipt', rpc: id, ...receipt } : null,
            once: clientMessageId ? `prompt:${clientMessageId}${attempt ? ':' + attempt : ''}` : undefined,
          });
        // An agent still works on something AIB thinks is over (a steer it answered promptRequired, the end of a cancelled turn) and refuses
        // the prompt with "Agent is already processing...". That is no failure: the message waits and goes the moment the agent is free.
        const sendWhenFree = async (): Promise<unknown> => {
          const until = Date.now() + busyRetry.maxSeconds * 1000;
          for (let attempt = 0;; attempt++) {
            try {
              return await send(attempt);
            } catch (error) {
              if (!isAgentBusyError(error) || this.closed || this.cancelSeq >= seq || Date.now() >= until) throw error;
              log.info('chat %s: the agent is still processing; the message goes when it is free', this.id);
              await new Promise((resolve) => setTimeout(resolve, busyRetry.delayMs));
              if (this.closed || this.cancelSeq >= seq) throw error;
            }
          }
        };
        const response = sendWhenFree();
        this.$promptOut.set(); // written: a steer from now on reaches this turn
        result = await this.$untilReplyEnds(seq, response);
        await this.$aibContextSent(context);
      }
      this.$clearSettle();
      this.turnEndedAt = this.$now();
      if (!(isDict(result) && result.stopReason === 'cancelled')) this.$noteAsks();
      this.$backgroundOpenTools(seq);
      if (!(isDict(result) && result.stopReason === 'cancelled')) this.$steerUnread();
      this.$queueNoteOutcome(result, false);
      this.$authResent = false;
      this.event('turn_end', result);
      const hook = this.onTurnEnd;
      // A turn that ended before a rebuild had its hooks run by the AIB that saw it end.
      if (hook && !this.$replaying && !(isDict(result) && result.stopReason === 'cancelled')) {
        try {
          await hook(this);
        } catch (error) {
          log.exception(error, 'on_turn_end hook failed');
        }
      }
      if (this.onTurnCancelled && !this.$replaying && isDict(result) && result.stopReason === 'cancelled') {
        await Promise.resolve(this.onTurnCancelled(this)).catch((error) => log.exception(error, 'on_turn_cancelled hook failed'));
      }
      if (clientMessageId) {
        const receipt = this.promptReceipts.get(clientMessageId);
        if (receipt) receipt.state = 'finished';
        this.$receiptChanged(clientMessageId);
      }
    } catch (error) {
      const authError = asRpcError(error);
      if (authError && isAuthRequired(authError) && !this.closed && this.cancelSeq < seq && !this.auth && !this.$replaying) {
        // The agent's login expired mid-session ("Failed to authenticate…" then ACP auth_required): one sign-in card, not two raw
        // errors; once signed in, the message goes again once (Deno only).
        this.$holdForSignIn(authError, seq);
        if (clientMessageId) {
          const receipt = this.promptReceipts.get(clientMessageId);
          if (receipt) receipt.state = 'error';
          this.$receiptChanged(clientMessageId);
        }
        return; // finally still runs
      }
      log.exception(error, 'Prompt turn failed');
      const data = isDict(error) || error instanceof Error ? (error as { data?: unknown }).data : null;
      if (isDict(data) && isDict(data.subscriptionQuota)) {
        this.onLimits?.(this, 'qwen-quota', data.subscriptionQuota, this.$now()); // Qwen: the cap is reached
      }
      this.error = errorText(error);
      // Failed (the inbox): only the agent's own answer to this prompt, never a Stop or a chat that closed under it.
      if (errorName(error) === 'RuntimeError' && !this.closed && this.cancelSeq < seq) {
        this.turnFailedAt = this.$now();
        this.turnError = errorText(error).replace(/\s+/g, ' ').trim().slice(0, 300);
      }
      this.$queueNoteOutcome(null, true);
      this.event('error', { message: errorText(error) });
      if (clientMessageId) {
        const receipt = this.promptReceipts.get(clientMessageId);
        if (receipt) receipt.state = 'error';
        this.$receiptChanged(clientMessageId);
      }
    } finally {
      this.$promptOut.set();
      this.$clearSettle();
      this.withdrawTurnRequests();
      // open elsewhere: another app opened this chat during the turn; let go now, before the chat counts as idle (no prompt slips in)
      if (this.elsewhere && !this.elsewhere.released && !this.$replaying) await this.tryRelease(true);
      await this.$finishTurn();
      await this.$queueAfterTurn();
      if (!this.$replaying) this.$scheduleSnapshot(); // quiet now (or skipped when the queue started the next turn)
    }
  },

  /**
   * The prompt's response, or `{stopReason: 'end_turn'}` as soon as its reply ended while Claude Code holds the response for
   * background helpers the turn started (see $watchHeldTurn). The held response still comes later, when the helpers finish or the
   * next prompt arrives; by then this turn is over, so it changes nothing (a cycle Claude Code ran inside the held turn ends with it).
   */
  async $untilReplyEnds(this: Connection, seq: number, response: Promise<unknown>): Promise<unknown> {
    let fire: () => void = () => {};
    const ended = new Promise<typeof HELD>((resolve) => (fire = () => resolve(HELD)));
    const early = { seq, fire };
    this.$endEarly = early;
    try {
      const first = await Promise.race([response, ended]);
      if (first !== HELD) return first;
    } finally {
      if (this.$endEarly === early) this.$endEarly = null;
    }
    response.then(
      () => {
        if (this.autonomous) void this.$endAutonomous('end_turn');
        else if (!this.busy && !this.$replaying) this.$scheduleSnapshot(); // the last request in flight is answered now
      },
      (error) => log.warning('The held response of an ended turn failed: %s', errorText(error)),
    );
    return { stopReason: 'end_turn' };
  },

  /** [text, token] of the note to put in front of this prompt (kept out of the user event and the fingerprint), or null. */
  async $aibContext(this: Connection): Promise<[string, unknown] | null> {
    const start = this.onTurnStart;
    const provider = this.contextForPrompt;
    if (start) {
      try {
        await start(this);
      } catch (error) {
        log.exception(error, 'on_turn_start hook failed');
      }
    }
    if (!provider) return null;
    try {
      const context = await provider(this);
      return pyTruthy(context) ? context as [string, unknown] : null;
    } catch (error) {
      log.exception(error, 'The note for the prompt could not be made');
      return null;
    }
  },

  async $aibContextSent(this: Connection, context: [string, unknown] | null): Promise<void> {
    const done = this.contextSent;
    if (context && done) {
      try {
        await done(this, context[1]);
      } catch (error) {
        log.exception(error, 'Clearing the sent note failed');
      }
    }
  },

  /** Validated session/set_config_option, applied now. */
  async setConfig(this: Connection, configId: unknown, value: unknown): Promise<void> {
    const params = buildConfigRequest(this.settings, configId, value);
    if (isModelsOption(this.settings, configId)) { // an agent's models list: session/set_model (unstable_setSessionModel)
      await this.request('session/set_model', { sessionId: this.sessionId, modelId: value });
      this.$modelSet(value);
      return;
    }
    const result = await this.request('session/set_config_option', {
      ...params,
      sessionId: this.sessionId,
    });
    if (!isDict(result)) {
      throw new TypeError(`'${pyTypeName(result)}' object is not iterable`);
    }
    Object.assign(this.settings, result);
    if (this.serverModels) {
      const all = Array.isArray(this.settings.configOptions) ? this.settings.configOptions : [];
      const option = all.find((o) => isDict(o) && o.id === configId) as Json | undefined;
      if (option && (option.category === 'model' || option.id === 'model') && isStr(value)) this.$serverCurrent = value;
      this.$withModels(this.settings);
    }
  },

  /** withModelsOption, then (model-server chat) the server's models in place of the adapter's. */
  $withModels(this: Connection, settings: unknown): void {
    withModelsOption(settings);
    if (this.serverModels) withServerModels(settings, this.serverModels.models, this.$serverCurrent || this.serverModels.model);
  },

  /** The model the agent took through session/set_model: its models reply and the model option AIB made from it. */
  $modelSet(this: Connection, modelId: unknown): void {
    if (!isStr(modelId)) return;
    this.$serverCurrent = modelId;
    if (isDict(this.settings.models)) (this.settings.models as Json).currentModelId = modelId;
    this.$withModels(this.settings);
  },

  /** Validated session/set_mode, applied now. */
  async setMode(this: Connection, modeId: unknown): Promise<void> {
    checkMode(this.settings, modeId);
    await this.request('session/set_mode', {
      sessionId: this.sessionId,
      modeId,
    });
    this.$modes().currentModeId = modeId;
  },

  /**
   * A mode/config change from the UI. Idle: applied now (errors raise). Mid-turn: validated, then queued as the one pending value
   * for that setting (last choice wins; picking the current value withdraws it) and applied in order when the turn ends, before
   * the next prompt is accepted.
   */
  async changeSetting(
    this: Connection,
    kind: unknown,
    configId: unknown,
    value: unknown,
  ): Promise<Json> {
    if (kind !== 'mode' && kind !== 'config') {
      throw new ValueError('Unknown setting kind');
    }
    this.$refuseReadOnly();
    if (this.closed || !this.ready || !this.sessionId) {
      throw new ValueError('This connection is not ready');
    }
    if (kind === 'mode') checkMode(this.settings, value);
    else buildConfigRequest(this.settings, configId, value);
    const key = Connection.changeKey(kind, configId);
    if (this.busy) {
      this.pendingChanges.delete(key);
      if (!pyEq(currentValue(this.settings, kind, configId), value)) {
        this.pendingChanges.set(key, {
          key,
          kind,
          configId: kind === 'config' ? configId : null,
          value,
          queuedAt: now(),
        });
      }
      return {
        queued: this.pendingChanges.has(key),
        pendingChanges: this.pendingList(),
      };
    }
    await this.$drainPending(); // leftovers from an earlier turn keep their order ahead of this change
    if (kind === 'mode') await this.setMode(value);
    else await this.setConfig(configId, value);
    return { queued: false, pendingChanges: this.pendingList() };
  },

  cancelPending(this: Connection, key: unknown): Json[] {
    if (!isStr(key) || !this.pendingChanges.delete(key)) {
      throw new ValueError('That change is no longer queued');
    }
    return this.pendingList();
  },

  pendingList(this: Connection): Json[] {
    return [...this.pendingChanges.values()].map((v) => ({ ...v }));
  },

  async $applyPendingEntry(this: Connection, entry: PendingChange): Promise<void> {
    let error: string | null = null;
    try {
      if (
        !pyEq(
          currentValue(this.settings, entry.kind, entry.configId),
          entry.value,
        )
      ) {
        if (entry.kind === 'mode') await this.setMode(entry.value);
        else await this.setConfig(entry.configId, entry.value);
      }
    } catch (caught) {
      log.warning(
        'Applying a queued setting change failed: %s',
        errorText(caught),
      );
      error = errorText(caught) || errorName(caught);
    }
    if (this.pendingChanges.get(entry.key) === entry) {
      this.pendingChanges.delete(entry.key); // a newer choice made meanwhile stays queued
    }
    if (error) {
      this.changeSeq += 1;
      this.changeFailures.push({
        seq: this.changeSeq,
        key: entry.key,
        kind: entry.kind,
        configId: entry.configId,
        value: entry.value,
        message: clip(error, 500),
        time: now(),
      });
      this.changeFailures.splice(
        0,
        Math.max(0, this.changeFailures.length - 5),
      );
    }
  },

  /** Apply queued changes one by one, in the order chosen. A refused change is recorded in changeFailures and dropped. */
  async $drainPending(this: Connection): Promise<void> {
    while (true) {
      if (this.closed || !this.ready) {
        this.pendingChanges.clear();
        return;
      }
      const entry = this.pendingChanges.values().next().value;
      if (entry === undefined) return;
      await this.$applyPendingEntry(entry);
    }
  },

  /** The turn is over: apply what was queued, then (and only when nothing new was queued meanwhile) accept prompts again. */
  async $finishTurn(this: Connection): Promise<void> {
    try {
      await this.$drainPending();
    } catch (error) {
      log.exception(
        error,
        'Applying queued setting changes failed; dropping them',
      );
      this.pendingChanges.clear();
    } finally {
      while (true) {
        if (!this.pendingChanges.size) {
          this.busy = false;
          break;
        }
        try {
          await this.$drainPending();
        } catch (error) {
          log.exception(
            error,
            'Applying queued setting changes failed; dropping them',
          );
          this.pendingChanges.clear();
        }
      }
    }
  },
};

export type TurnMethods = typeof turnMethods;
