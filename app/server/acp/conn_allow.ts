/**
 * Connection methods: permission requests (allow rules, Linux facts, cards) and elicitations.
 * Moved out of connection.ts (no change).
 */
import type { MatchContext } from '../allow/matcher.ts';
import { isAutoApproved } from '../allow/own_tools.ts';
import { factsNow, type LinuxNeeds, LinuxView } from '../allow/linux.ts';
import { COLLECT_FACTS, prefetch as prefetchWslFacts, warm as warmWslFacts, type WslFactsSource } from '../allow/wsl_facts.ts';
import { validateContent, validateSchema, validateUrlRequest } from './elicitation.ts';
import { isClaudeFamily } from '../agents/claude_family.ts';
import { peekWslHost, wslTestHomeEnv } from '../wsl/access.ts';
import { clip, isDict, isInt, isStr, pyLen, pyStr, ValueError } from '../core/py.ts';
import { log, type Json, pget, get, pyEq, hex, tokenUrlsafe } from './conn_util.ts';
import { type AgentRequest } from './conn_types.ts';
import { ownToolAction, isOwnArtifactEntry } from './tool_tracking.ts';
import type { Connection } from './connection.ts';

export const allowMethods = {
  /**
   * What the allow-rules matcher knows of this chat and request (tool name from the earlier tool_call, the current mode). A WSL chat
   * (allow/linux.ts): its Linux folder as `cwd`, the project's ref as `project`, no scratch folder, and a LinuxView over the distro
   * facts AIB has (`linux.since`: older facts count as unknown; `linux.needs`: a recording view that collects what to ask).
   */
  allowContext(this: Connection, params: unknown, linux: { since?: number; needs?: LinuxNeeds } = {}): MatchContext {
    const call = isDict(params) ? get(params, 'toolCall') : null;
    const id = isDict(call) ? get(call, 'toolCallId') : null;
    const mode = get(this.$modes(), 'currentModeId');
    const seen = isStr(id) ? this.$tools.get(id) : undefined;
    // a WSL chat gets no subagent hooks yet (they'd fail open), so no subagent worktree either
    if (this.wsl) {
      const view = new LinuxView(this.$linuxFacts, { since: linux.since ?? 0, needs: linux.needs ?? null, distro: this.wsl.distro });
      const claude = isClaudeFamily(this.provider) ? view.base()?.claude ?? (view.recording ? COLLECT_FACTS : null) : undefined;
      return {
        provider: this.provider,
        toolName: seen?.toolName ?? null,
        mcp: seen?.mcp ?? null,
        mode: isStr(mode) ? mode : null,
        cwd: this.agentCwd,
        project: this.projectRoot || this.cwd,
        scratch: null,
        stateDir: null,
        ...(claude !== undefined ? { facts: claude } : {}),
        linux: view,
      };
    }
    // Approval parity (subagent worktrees, design 2.4): a subagent's call in the worktree AIB recorded for it is checked against that
    // worktree exactly as the main agent's is against the folder (same rules, same protected names); never its parent folder.
    const worktree = seen?.parent && this.subagentWorktree ? this.subagentWorktree(seen.parent) : null;
    return {
      provider: this.provider,
      toolName: seen?.toolName ?? null,
      mcp: seen?.mcp ?? null,
      mode: isStr(mode) ? mode : null,
      cwd: worktree ?? this.cwd,
      project: this.projectRoot || this.cwd,
      scratch: this.scratchDir,
      stateDir: this.allowGate?.stateDir ?? null,
      ...(this.swarm?.role === 'helper' && this.worktree ? { helper: { testCmd: this.helperTestCmd() } } : {}),
    };
  },

  /**
   * Allow rules: answer a matching request with the agent's allow-once option. Live: match, record the decision (before the
   * answer), record a `permission_auto` event, then answer. Keeper replay: never match again; the decision log says whether the
   * live AIB answered it (its event note and its answer are in the record and replay on their own).
   */
  $allowByRule(this: Connection, message: Json, params: Json, seenKey: string, since?: number): boolean {
    const gate = this.allowGate!;
    const options = get(params, 'options', []);
    const allow = (Array.isArray(options) ? options : []).find((o) => isDict(o) && o.kind === 'allow_once') as Json | undefined;
    if (!allow || !isStr(allow.optionId)) return false; // no allow-once: never auto-answered (fail closed)
    const once = `${seenKey}:${this.$requestsSeen.get(seenKey) ?? 0}`;
    if (this.$replaying) {
      const done = gate.log.find(this.id, once);
      return !!done && !done.swept;
    }
    let result;
    try {
      result = gate.decide(params, since === undefined ? this.allowContext(params) : this.allowContext(params, { since }));
    } catch (error) {
      log.exception(error, 'Allow rules: the matcher failed; the request asks');
      return false;
    }
    if (!result.allow) return false;
    gate.log.record(this.id, {
      key: once,
      optionId: allow.optionId,
      ruleId: result.ruleId,
      label: result.label,
      flagged: result.flagged,
      time: Date.now(),
    });
    this.recordedEvent('permission_auto', {
      sessionId: get(params, 'sessionId'),
      params: { sessionId: get(params, 'sessionId'), toolCall: get(params, 'toolCall') },
      ruleId: result.ruleId,
      label: result.label,
      flagged: result.flagged,
    });
    this.write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: allow.optionId } } });
    return true;
  },

  /** A permission request becomes a card the user answers. */
  $permissionCard(this: Connection, message: Json, params: Json): void {
    const key = hex(12);
    this.permissions.set(key, { rpcId: message.id, params });
    this.event('permission', { key, params });
  },

  $wslFactsSource(this: Connection): WslFactsSource {
    const wsl = this.wsl!;
    const agentEnv = (): Record<string, string> => {
      let test: Record<string, string> = {};
      try {
        test = wslTestHomeEnv();
      } catch { /* no test home: the helper's own */ }
      return { ...(wsl.env ?? {}), ...test, ...(this.env ?? {}) };
    };
    return {
      host: () => {
        const host = peekWslHost(wsl.distro); // never starts the distro
        return host && host.state === 'ready' ? host : null;
      },
      cwd: () => this.agentCwd,
      claude: isClaudeFamily(this.provider),
      claudeDir: () => {
        const env = agentEnv();
        return env.CLAUDE_CONFIG_DIR || (env.HOME?.startsWith('/') ? `${env.HOME.replace(/\/+$/, '')}/.claude` : undefined);
      },
      pathEnv: () => (wsl.env ? agentEnv().PATH : undefined),
    };
  },

  /** Fetch the distro facts deciding `params` needs (facts read before `since`, a factsNow() value, count as unknown). */
  async allowPrefetch(this: Connection, params: Json, since: number): Promise<void> {
    if (!this.allowGate || !this.wsl) return;
    await prefetchWslFacts(
      this.allowGate,
      this.$linuxFacts,
      this.$wslFactsSource(),
      params,
      since,
      (view) => this.allowContext(params, { since, needs: view.opts.needs ?? undefined }),
    );
  },

  /** Once at start: the chat folder and the base facts (PATH folders, AIB's folders, Claude settings). */
  allowWarm(this: Connection): Promise<void> {
    if (!this.allowGate || !this.wsl) return Promise.resolve();
    return this.allowWarming ??= warmWslFacts(this.$linuxFacts, this.$wslFactsSource()).catch((error) => {
      log.exception(error, 'Allow rules: could not read the distro facts');
    });
  },

  /** A WSL chat's live request: the facts first, then the same decision as $allowByRule, else a card. */
  async $allowByRuleWsl(this: Connection, message: Json, params: Json, seenKey: string): Promise<void> {
    const since = factsNow();
    try {
      await this.allowPrefetch(params, since);
    } catch (error) {
      log.exception(error, 'Allow rules: could not read the distro facts; the request asks');
    }
    if (this.closed) return;
    if (this.$allowByRule(message, params, seenKey, since)) return;
    this.$permissionCard(message, params);
  },

  $allowRemember(this: Connection, key: string, v: AgentRequest): Json | null {
    const draft = this.$allowChoice(v);
    if (draft && !this.$allowSeen.has(key)) {
      this.$allowSeen.set(key, { params: v.params, draft });
      while (this.$allowSeen.size > 50) this.$allowSeen.delete(this.$allowSeen.keys().next().value!);
    }
    return draft;
  },

  /** The card's "Always allow" choice for a waiting request (cached on it). */
  $allowChoice(this: Connection, v: AgentRequest): Json | null {
    if (!this.allowGate) return null;
    if (!v.allow) {
      try {
        v.allow = this.allowGate.drafts(v.params, this.allowContext(v.params)) as unknown as Json;
      } catch (error) {
        log.exception(error, 'Allow rules: could not draft a rule');
        v.allow = { project: { offer: true, available: false, reason: "AIB can't read this request.", hideAgentAlways: false }, off: '' };
      }
    }
    return v.allow;
  },

  /** The waiting card's params and draft (allow-answer), or null when it is no longer waiting. */
  allowPending(this: Connection, key: string): { params: Json; draft: Json | null; waiting: boolean } | null {
    const pending = this.permissions.get(key);
    if (pending) {
      const draft = this.$allowChoice(pending);
      this.$allowSeen.set(key, { params: pending.params, draft });
      while (this.$allowSeen.size > 50) this.$allowSeen.delete(this.$allowSeen.keys().next().value!);
      return { params: pending.params, draft, waiting: true };
    }
    const seen = this.$allowSeen.get(key);
    return seen ? { ...seen, waiting: false } : null;
  },

  /**
   * After a rule is saved: answer the waiting cards it now covers, each through permission() (so a phone answering the same card
   * at the same moment gets "stale"). The decision is logged as `swept`: on replay the card still appears, then the answer
   * removes it.
   */
  allowSweep(this: Connection): number {
    if (!this.allowGate || this.$replaying) return 0;
    let n = 0;
    for (const [key, pending] of [...this.permissions]) if (this.$sweepOne(key, pending)) n++;
    return n;
  },

  /** allowSweep for a WSL chat: each waiting card's distro facts are fetched again first. */
  async allowSweepWsl(this: Connection): Promise<number> {
    if (!this.allowGate || this.$replaying || !this.wsl) return 0;
    let n = 0;
    for (const [key, pending] of [...this.permissions]) {
      const since = factsNow();
      try {
        await this.allowPrefetch(pending.params, since);
      } catch { /* unknown facts: it keeps asking */ }
      if (this.closed || this.permissions.get(key) !== pending) continue;
      if (this.$sweepOne(key, pending, since)) n++;
    }
    return n;
  },

  /** One waiting card answered by the rules (logged as swept), or false. */
  $sweepOne(this: Connection, key: string, pending: AgentRequest, since?: number): boolean {
    const gate = this.allowGate!;
    const options = get(pending.params, 'options', []);
    const allow = (Array.isArray(options) ? options : []).find((o) => isDict(o) && o.kind === 'allow_once') as Json | undefined;
    if (!allow || !isStr(allow.optionId)) return false;
    const ctx = since === undefined ? this.allowContext(pending.params) : this.allowContext(pending.params, { since });
    const result = gate.decide(pending.params, ctx);
    if (!result.allow) return false;
    const seenKey = JSON.stringify(pending.rpcId);
    gate.log.record(this.id, {
      key: `${seenKey}:${this.$requestsSeen.get(seenKey) ?? 0}`,
      optionId: allow.optionId,
      ruleId: result.ruleId,
      label: result.label,
      flagged: result.flagged,
      time: Date.now(),
      swept: true,
    });
    this.recordedEvent('permission_auto', {
      sessionId: get(pending.params, 'sessionId'),
      params: { sessionId: get(pending.params, 'sessionId'), toolCall: get(pending.params, 'toolCall') },
      ruleId: result.ruleId,
      label: result.label,
      flagged: result.flagged,
      key,
    });
    this.permission(key, allow.optionId);
    return true;
  },

  /** True when a permission request is for AIB's studio_artifact tool on a chat AIB gave that tool to. */
  ownArtifactTool(this: Connection, params: unknown): boolean {
    if (!(this.mcpServers ?? []).some(isOwnArtifactEntry)) return false;
    const call = isDict(params) ? get(params, 'toolCall') : null;
    if (!isDict(call)) return false;
    const id = get(call, 'toolCallId');
    return isAutoApproved(ownToolAction(call, isStr(id) ? this.$tools.get(id)?.mcp : null));
  },

  permission(this: Connection, key: unknown, option: unknown): void {
    this.$refuseReadOnly();
    const pending = isStr(key) ? this.permissions.get(key) : undefined;
    if (!pending) throw this.$staleError(key, 'approval');
    const options = get(pending.params, 'options', []);
    if (
      option !== null && option !== undefined &&
      !(options as unknown[]).map((o) => pget(o, 'optionId')).some((id) => pyEq(id, option))
    ) {
      throw new ValueError('Unknown approval option');
    }
    const outcome = option === null || option === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: option };
    this.write({ jsonrpc: '2.0', id: pending.rpcId, result: { outcome } });
    this.permissions.delete(key as string);
    this.$cardsChanged();
    // A background helper of Claude Code asks between turns: once answered, a message queued meanwhile can go.
    if (!this.busy && this.$claudeHolds()) void this.$queuePump();
  },

  receiveElicitation(this: Connection, rpcId: unknown, params: unknown): void {
    if (
      !isDict(params) ||
      !['form', 'url'].includes(get(params, 'mode') as string)
    ) {
      throw new ValueError('Only form and url elicitation modes are supported');
    }
    const sid = get(params, 'sessionId');
    const requestId = get(params, 'requestId');
    const idOk = (value: unknown) => isStr(value) || isInt(value);
    if (sid !== null) {
      if (!isStr(sid) || !this.knownSessions.has(sid)) {
        throw new ValueError('Elicitation references an unknown session');
      }
      if (requestId !== null) {
        throw new ValueError(
          'Session-scoped elicitation cannot include requestId',
        );
      }
    } else if (requestId === null || !idOk(requestId)) {
      throw new ValueError(
        'Request-scoped elicitation requires a string or integer requestId',
      );
    }
    if (requestId !== null && !idOk(requestId)) {
      throw new ValueError('Invalid elicitation requestId');
    }
    if (
      get(params, 'toolCallId') !== null &&
      (sid === null || !isStr(params.toolCallId))
    ) {
      throw new ValueError('toolCallId requires a session-scoped request');
    }
    if (
      !isStr(get(params, 'message')) || pyLen(params.message as string) > 10000
    ) {
      throw new ValueError(
        'Elicitation message must be a string of at most 10000 characters',
      );
    }
    if (params.mode === 'url') validateUrlRequest(params);
    else validateSchema(get(params, 'requestedSchema'));
    const key = tokenUrlsafe(18);
    if (this.elicitations.size >= 100) {
      throw new ValueError('Too many pending elicitation requests');
    }
    if (
      params.mode === 'url' &&
      [...this.elicitations.values()].some((p) => pyEq(get(p.params, 'elicitationId'), params.elicitationId))
    ) {
      throw new ValueError(
        'A request with this elicitationId is already pending',
      );
    }
    this.elicitations.set(key, { rpcId, params });
    this.event('elicitation', { key, params });
  },

  answerElicitation(
    this: Connection,
    key: unknown,
    action: unknown,
    content: unknown = null,
  ): void {
    if (!['accept', 'decline', 'cancel'].includes(action as string)) {
      throw new ValueError('Action must be accept, decline, or cancel');
    }
    this.$refuseReadOnly();
    const pending = isStr(key) ? this.elicitations.get(key) : undefined;
    if (!pending) throw this.$staleError(key, 'request');
    const result: Json = { action };
    if (action === 'accept' && get(pending.params, 'mode') === 'url') {
      // the person confirmed they completed the out-of-band interaction
    } else if (action === 'accept') {
      if (!Object.hasOwn(pending.params, 'requestedSchema')) {
        const error = new Error("'requestedSchema'");
        error.name = 'KeyError';
        throw error;
      }
      result.content = validateContent(
        pending.params.requestedSchema,
        content ?? {},
      );
    }
    this.write({ jsonrpc: '2.0', id: pending.rpcId, result });
    this.elicitations.delete(key as string);
    this.$cardsChanged();
    if (this.ready && !this.busy && this.$claudeHolds()) void this.$queuePump(); // as permission() does
    if (action !== 'accept' && !this.ready && !this.closed) {
      const what = get(pending.params, 'mode') === 'form' ? 'a question' : 'a link request';
      const said = clip(pyStr(get(pending.params, 'message', '')), 120);
      this.abortSetup(
        `You ${
          action === 'decline' ? 'declined' : 'cancelled'
        } ${what} while the conversation was opening ("${said}"), so it was not opened.`,
      );
    }
  },

  /** elicitation/complete: the agent says an out-of-band URL interaction finished. */
  completeElicitation(this: Connection, params: unknown): void {
    const eid = isDict(params) ? get(params, 'elicitationId') : null;
    if (!isStr(eid)) return;
    for (const [key, item] of [...this.elicitations]) {
      if (
        get(item.params, 'mode') === 'url' &&
        get(item.params, 'elicitationId') === eid
      ) {
        this.$replyQuietly(item.rpcId, { action: 'accept' });
        this.elicitations.delete(key);
        this.$noteWithdrawn(
          key,
          'elicitation',
          'The agent reported this request complete.',
          get(item.params, 'sessionId'),
        );
      }
    }
    this.$cardsChanged();
  },

  /** Withdraw UI for an agent-originated RPC; IDs are direction-specific. */
  cancelIncomingRequest(this: Connection, requestId: unknown): void {
    if (!isStr(requestId) && !isInt(requestId)) return;
    const reason = 'The agent cancelled this request.';
    this.$clearPermissions({ rpcId: requestId, reason });
    this.$clearElicitations({ rpcId: requestId, reason });
    this.$cardsChanged();
  },

  $clearPermissions(
    this: Connection,
    {
      sessionId = null,
      rpcId = null,
      reason = 'The session ended.',
      scoped = false,
      everything = false,
      except = null,
    }: {
      sessionId?: unknown;
      rpcId?: unknown;
      reason?: string;
      scoped?: boolean;
      everything?: boolean;
      except?: ((sessionId: unknown) => boolean) | null;
    },
  ): void {
    for (const [key, item] of [...this.permissions]) {
      const sid = isDict(item.params) ? get(item.params, 'sessionId') : null;
      if (except?.(sid)) continue;
      const rpcMatch = rpcId !== null && typeof item.rpcId === typeof rpcId &&
        item.rpcId === rpcId;
      if (
        everything || rpcMatch ||
        (sessionId !== null && (sid === sessionId || sid === null)) ||
        (scoped && sid !== null)
      ) {
        this.$replyQuietly(item.rpcId, { outcome: { outcome: 'cancelled' } });
        this.permissions.delete(key);
        this.$noteWithdrawn(key, 'permission', reason, sid);
      }
    }
  },

  $clearElicitations(
    this: Connection,
    {
      sessionId = null,
      requestId = null,
      rpcId = null,
      reason = 'The session ended.',
      scoped = false,
      except = null,
    }: {
      sessionId?: unknown;
      requestId?: unknown;
      rpcId?: unknown;
      reason?: string;
      scoped?: boolean;
      except?: ((sessionId: unknown) => boolean) | null;
    },
  ): void {
    const everything = sessionId === null && requestId === null &&
      rpcId === null && !scoped;
    for (const [key, item] of [...this.elicitations]) {
      const params = item.params;
      if (except?.(get(params, 'sessionId'))) continue;
      const rpcMatch = rpcId !== null && typeof item.rpcId === typeof rpcId &&
        item.rpcId === rpcId;
      const ownRequest = get(params, 'requestId');
      const requestMatch = requestId !== null &&
        typeof ownRequest === typeof requestId && ownRequest === requestId;
      const sid = get(params, 'sessionId');
      if (
        everything || rpcMatch || requestMatch ||
        (sessionId !== null && sid === sessionId) || (scoped && sid !== null)
      ) {
        this.$replyQuietly(item.rpcId, { action: 'cancel' });
        this.elicitations.delete(key);
        this.$noteWithdrawn(key, 'elicitation', reason, sid);
      }
    }
  },

  /** The turn that raised these requests is over; nothing may answer them any more. */
  withdrawTurnRequests(this: Connection): void {
    const reason = 'The turn that asked for this has ended.';
    this.$clearPermissions({ sessionId: this.sessionId, reason });
    this.$clearElicitations({ sessionId: this.sessionId, reason });
  },
};

export type AllowMethods = typeof allowMethods;
