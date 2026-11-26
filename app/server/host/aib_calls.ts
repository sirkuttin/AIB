/**
 * Aib methods: the host RPC calls (allow, install, sign-in, live calls).
 * Moved out of aib.ts (no change).
 */
import { Connection, NotStoppable } from '../acp/connection.ts';
import { sessionOp } from '../acp/breadth.ts';
import { PromptStateUnknown } from '../acp/rpc_errors.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import * as adapters from '../agents/adapters.ts';
import { Installer, InstallRefused } from '../agents/installer.ts';
import { Signer, SignInRefused } from '../agents/signin.ts';
import { isBeta } from '../agents/beta_catalog.ts';
import { isCodexFamily } from '../agents/claude_family.ts';
import { BetaSigner } from '../agents/beta_signin.ts';
import { isDict, isStr, ValueError } from '../core/py.ts';
import { OwnershipConflict } from '../ownership/ownership.ts';
import { builtinLaunch } from '../web/shared.ts';
import { wslLoc } from '../wsl/access.ts';
import { isWslRecord, wslHasChanges } from '../wsl/worktrees.ts';
import { sameProject } from '../allow/matcher.ts';
import {
  log,
  type Json,
  SWARM_NOTE_KINDS,
  SWARM_NOTE_ACTIONS,
  SWARM_ACTION_LABELS,
  LIVE_POST_OPS,
  KeyError,
  need,
  isRequestError,
} from './aib_util.ts';
import { LANDING_TTL_MS, readOwnCopy, readHelperOf, readPicks } from './aib_options.ts';
import type { Aib } from './aib.ts';

export const callMethods = {
  /**
   * Allow rules: the page-session calls (POST /api/live/allow/*; never an MCP tool or a phone route).
   *   allow-answer  {id, key, option, scope, saveOnly?}  answer the card and save its rule, in one call: the rule is saved only when
   *                 the answer went through; answered elsewhere -> 409 answered_elsewhere, and saveOnly then saves it anyway.
   *                 Waiting cards the rule now covers are answered too (sweep).
   *   allow-rules   the list for Settings; allow-remove / allow-restore {ruleId}; allow-review; allow-enable {on};
   *   allow-builtin {name, on}.
   */
  async $allowCall(this: Aib, name: string, body: Json): Promise<[number, unknown]> {
    const gate = this.allow;
    if (!gate) return [404, { error: 'Allow rules need a state folder' }];
    const store = gate.store;
    if (name === 'allow-rules') return [200, store.public()];
    if (name === 'allow-remove') return [200, { ok: store.remove(String(need(body, 'ruleId'))), ...store.public() }];
    if (name === 'allow-restore') return [200, { ok: store.restore(String(need(body, 'ruleId'))), ...store.public() }];
    if (name === 'allow-review') {
      store.review();
      return [200, { ok: true, ...store.public() }];
    }
    if (name === 'allow-enable') {
      store.setEnabled(body.on === true);
      return [200, { ok: true, ...store.public() }];
    }
    if (name === 'allow-builtin') {
      const which = String(need(body, 'name'));
      if (!['safeReads', 'syntax', 'scratch'].includes(which)) throw new ValueError('Unknown built-in rule');
      store.setBuiltin(which as 'safeReads', body.on === true);
      return [200, { ok: true, ...store.public() }];
    }
    if (name !== 'allow-answer') return [404, { error: 'Not found' }];
    const c = this.$connection(body);
    const key = String(need(body, 'key'));
    const scope = body.scope === 'global' ? 'global' : 'project';
    const found = c.allowPending(key);
    if (!found) throw new ValueError('Unknown approval');
    const draft = isDict(found.draft) ? found.draft[scope] : null;
    if (!isDict(draft) || draft.available !== true || !Array.isArray(draft.rules) || !draft.rules.length) {
      return [400, { error: isDict(draft) && isStr(draft.reason) && draft.reason ? draft.reason : 'No rule can be made from this request' }];
    }
    if (!body.saveOnly) {
      if (!found.waiting) return [409, { error: 'This request was already answered elsewhere. Save the rule anyway?', code: 'answered_elsewhere' }];
      const option = body.option;
      const options = Array.isArray(found.params.options) ? found.params.options : [];
      const chosen = options.find((o) => isDict(o) && o.optionId === option);
      if (!isDict(chosen) || chosen.kind !== 'allow_once') throw new ValueError('Always allow goes with an allow-once answer');
      try {
        c.permission(key, option);
      } catch (error) {
        if (error instanceof Error && /stale|no longer|answered/i.test(error.message)) {
          return [409, { error: 'This request was already answered elsewhere. Save the rule anyway?', code: 'answered_elsewhere' }];
        }
        throw error;
      }
    }
    const saved = (draft.rules as Json[]).map((r) => store.add({ ...r, from: 'card' } as never));
    let also = 0;
    const project = c.projectRoot || c.cwd;
    for (const other of [...this.connections.values()]) {
      // a WSL project's ref compares exactly: Linux paths are case-sensitive (audit F6)
      if (scope === 'project' && !sameProject(other.projectRoot || other.cwd, project)) continue;
      try {
        also += other.wsl ? await other.allowSweepWsl() : other.allowSweep(); // a WSL chat reads its distro facts again first
      } catch (error) {
        log.exception(error, 'Allow rules: answering waiting cards failed');
      }
    }
    return [200, { ok: true, rules: saved, alsoAllowed: also }];
  },

  $connection(this: Aib, body: Json): Connection {
    const id = need(body, 'id');
    if (id !== null && typeof id === 'object') throw new TypeError(`unhashable type: '${Array.isArray(id) ? 'list' : 'dict'}'`);
    const connection = isStr(id) ? this.connections.get(id) : undefined;
    if (connection === undefined) throw new KeyError(id);
    return connection;
  },

  /**
   * Archive or delete of a chat that may have a worktree. Without changes against its diff base (and no live agent in it) the
   * worktree and branch are removed silently, without --force. With changes it is kept and the page says so.
   */
  async worktreeArchive(this: Aib, body: Json): Promise<Json> {
    const { provider, sessionId } = body;
    const session = isStr(provider) && isStr(sessionId) && sessionId ? `${provider}:${sessionId}` : null;
    const path = isStr(body.cwd) && body.cwd ? body.cwd : null;
    const record = await this.$worktreeRecord(path, session);
    if (!record) return { ok: true, worktree: null };
    const branch = record.branch ?? '';
    if (this.$connectionsIn(String(record.path)).length) return { ok: true, worktree: { branch, removed: false, live: true } };
    const changed = isWslRecord(record) ? await wslHasChanges(record) : await this.worktrees!.hasChanges(record);
    if (changed) return { ok: true, worktree: { branch, removed: false, keptChanges: true } };
    const outcome = await this.$removeWorktree(record, false);
    return { ok: true, worktree: { branch, removed: outcome === 'removed', pending: outcome === 'pending' } };
  },

  // ---- install and sign-in jobs -------------------------------------------------------------------------------------------
  /**
   * The agent install job: action 'status', 'start' or 'cancel' for one built-in agent. Returns [HTTP status, payload]; never throws
   * for request errors. The job lives in this process, which is the agent host when there is one (it outlives the web server).
   */
  async installCall(this: Aib, action: string, agentId: unknown): Promise<[number, unknown]> {
    this.installer ??= new Installer(this.stateDir, { nodeCommand: this.options.nodeCommand || '' });
    try {
      if (action === 'start') return [200, { ...(await this.installer.start(agentId)), ok: true }];
      if (action === 'cancel') return [200, { ...(await this.installer.cancel(agentId)), ok: true }];
      if (action === 'status') return [200, { ...(await this.installer.status(agentId)), ok: true }];
      if (action === 'uninstall' || action === 'uninstall-check') { // Deno only: refused while a chat with the agent is open here or its sign-in runs
        const open = [...this.connections.values()].filter((c) => c.provider === agentId && !c.closed).length;
        const signing = typeof agentId === 'string' && !!this.signer?.jobs.get(agentId)?.alive;
        return [200, { ...(await this.installer.uninstall(agentId, open, signing, action === 'uninstall-check')), ok: true }];
      }
      return [404, { error: 'Not found' }];
    } catch (error) {
      if (error instanceof InstallRefused) return [409, { error: error.message, code: error.code }];
      if (isRequestError(error)) return [400, { error: error.message }];
      throw error;
    }
  },

  /**
   * The sign-in check and Sign in job: action 'status', 'check', 'start' or 'cancel' for one built-in agent; 'check' with an empty
   * agent id checks every built-in agent AIB can ask. Returns [HTTP status, payload]; never throws for request errors.
   */
  async signinCall(this: Aib, action: string, agentId: unknown, force: unknown = false): Promise<[number, unknown]> {
    this.signer ??= new Signer(this.stateDir, (agent) => builtinLaunch(this.$agentOptions(), this.settings, agent));
    this.betaSigner ??= new BetaSigner(
      this.stateDir,
      (agent) => this.$betaRow(agent),
      (agent) => this.betaEnv(agent),
    );
    try {
      if (action === 'check' && !agentId) {
        // Every agent is asked at once (each check has its own timeout), so the answer takes as long as the slowest one, not the sum
        // (one after another this took ~29 s). Beta agents: only the turned-on ones are asked (a check starts the agent once, hidden).
        const signer = this.signer, beta = this.betaSigner;
        const ids = [
          ...Object.keys(adapters.STUDIO_PACKAGES).map((a) => [a, signer.check(a, !!force)] as const),
          ...agentRegistry.BETA_IDS.filter((a) => this.settings.betaEnabled(a)).map((a) => [a, beta.check(a, !!force)] as const),
        ];
        const answers = await Promise.all(ids.map(([, done]) => done));
        const agents: Json = {};
        ids.forEach(([a], i) => (agents[a] = answers[i]));
        return [200, { ok: true, agents }];
      }
      if (isBeta(agentId)) return await this.$betaSigninCall(action, agentId as string, force);
      if (action === 'check') return [200, { ...(await this.signer.check(agentId, !!force)), ok: true }];
      if (action === 'start') return [200, { ...(await this.signer.start(agentId)), ok: true }];
      if (action === 'cancel') return [200, { ...(await this.signer.cancel(agentId)), ok: true }];
      if (action === 'status') return [200, { ...this.signer.status(agentId), ok: true }];
      return [404, { error: 'Not found' }];
    } catch (error) {
      if (error instanceof SignInRefused) return [409, { error: error.message, code: error.code }];
      if (isRequestError(error)) return [400, { error: error.message }];
      throw error;
    }
  },

  /** A Beta agent's sign-in calls (beta_signin.ts): 'check', 'start', 'cancel', 'status'. */
  async $betaSigninCall(this: Aib, action: string, agentId: string, force: unknown): Promise<[number, unknown]> {
    const signer = this.betaSigner!;
    if (action === 'check') return [200, { ...(await signer.check(agentId, !!force)), ok: true }];
    if (action === 'start') return [200, { ...(await signer.start(agentId)), ok: true }];
    if (action === 'cancel') return [200, { ...(await signer.cancel(agentId)), ok: true }];
    if (action === 'status') return [200, { ...signer.status(agentId), ok: true }];
    return [404, { error: 'Not found' }];
  },

  // ---- POST /api/live/<name> ----------------------------------------------------------------------------------------------
  /** One POST /api/live/<name> request. Returns [HTTP status, JSON payload]; never throws for request errors. */
  async liveCall(this: Aib, name: string, body: unknown): Promise<[number, unknown]> {
    try {
      return await this.$liveCall(name, body);
    } catch (error) {
      if (error instanceof OwnershipConflict) {
        const verdict = (error as { verdict?: unknown }).verdict;
        return [409, {
          error: error.message,
          code: (error as { code?: string }).code ?? 'session_in_use',
          ...(verdict ? { ownership: verdict } : {}),
        }];
      }
      if (error instanceof PromptStateUnknown) return [409, { error: error.message, code: 'prompt_state_unknown' }];
      if (isRequestError(error)) return [400, { error: error.message }];
      throw error;
    }
  },

  /**
   * Activity's "Processes" list (transcripts/gone.ts): which of the background commands the saved transcript calls running have no
   * process any more. `calls`: [{call, main}], call the tool_use_id, main true for the chat's own agent. The main agent's are read from
   * the same pid-and-start-time check the chat's "still running" row uses (Connection.toolBackground; a WSL chat's through its helper);
   * a subagent's by its cookie scan (subagents/service.ts callsGone, a WSL chat's in its distro). A call AIB cannot tell about is never
   * listed. Read-only and cheap: the caller asks at most every ten seconds.
   */
  async backgroundGone(this: Aib, sessionId: string, raw: unknown): Promise<string[]> {
    return (await this.backgroundStatus(sessionId, raw)).gone;
  },

  /**
   * backgroundGone, and the calls of subagents that still have a process (`alive`): a subagent whose turn ended with background work of
   * its own is waiting on it, and Activity says so instead of "ended with the agent" (transcripts/monitor.ts withGone).
   */
  async backgroundStatus(this: Aib, sessionId: string, raw: unknown): Promise<{ gone: string[]; alive: string[] }> {
    const connection = [...this.connections.values()].find((c) => !c.closed && c.sessionId === sessionId);
    if (!connection || !Array.isArray(raw)) return { gone: [], alive: [] };
    const calls = raw.filter((c): c is { call: string; main: boolean } => isDict(c) && isStr(c.call) && c.call.length <= 200).slice(0, 200);
    const gone = new Set<string>();
    const state = calls.some((c) => c.main) ? connection.toolBackground() : {};
    for (const c of calls) if (c.main === true && state[c.call]?.state === 'done') gone.add(c.call);
    const subs = calls.filter((c) => c.main !== true).map((c) => c.call);
    const alive = new Set<string>();
    if (this.subagents && subs.length) {
      const status = await this.subagents.callsStatus(connection.id, subs);
      for (const call of status.gone) gone.add(call);
      for (const call of status.alive) alive.add(call);
    }
    return { gone: [...gone], alive: [...alive] };
  },

  async $liveCall(this: Aib, name: string, body: unknown): Promise<[number, unknown]> {
    if (!isDict(body)) throw new ValueError('Invalid request');
    if (name === 'connect') {
      const background = body.background ?? false;
      if (typeof background !== 'boolean') throw new ValueError('background must be a boolean');
      const continueAnyway = body.continueAnyway ?? false;
      if (typeof continueAnyway !== 'boolean') throw new ValueError('continueAnyway must be a boolean');
      const provider = need(body, 'provider');
      const cwd = need(body, 'cwd');
      const connection = await this.connect(provider as string, cwd as string, (body.resume ?? null) as string | null, {
        background,
        continueAnyway,
        picks: readPicks(body.picks),
        helperOf: readHelperOf(body.helperOf),
        ownCopy: readOwnCopy(body.ownCopy),
      });
      return [200, connection.public()];
    }
    if (name.startsWith('allow-')) return this.$allowCall(name, body); // allow rules: page-session routes only (web/live_routes.ts)
    if (name === 'agent-options') return [200, await this.agentOptionsFor(body)]; // POST /api/live/agent-options (web/live_routes.ts)
    if (name === 'discover') return [200, await this.listAgentSessions(need(body, 'provider'), body.cwd ?? null, body.cursor ?? null)];
    if (name === 'agent-title') { // internal (web/server.ts chat-name, remote rename): not in LIVE_POST_OPS
      const queued = this.agentTitles.request(String(need(body, 'provider')), String(need(body, 'sessionId')), String(body.title ?? ''), isStr(body.cwd) ? body.cwd : '');
      return [200, { ok: true, queued }];
    }
    if (name === 'agent-title-state') return [200, { waiting: this.agentTitles.waiting(), done: this.agentTitles.done }]; // internal: tests
    if (name === 'bg-gone') return [200, await this.backgroundStatus(String(need(body, 'sessionId')), body.calls)]; // internal: web/server.ts
    if (name === 'forget') return [200, { ok: true, forgotten: this.forgetRecovered(body.provider, body.sessionId) }];
    if (name === 'worktree-note') { // internal (worktrees/merge.ts): not in LIVE_POST_OPS, so no page route reaches it
      const connection = this.$connection(body);
      const data: Json = { message: [...String(need(body, 'message'))].slice(0, 300).join(''), sessionId: connection.sessionId };
      const actions = (Array.isArray(body.actions) ? body.actions : [])
        .filter((a) => isDict(a) && (a.id === 'keep-mine' || a.id === 'leave')) // buttons in the note: only AIB's own two
        .map((a) => ({ id: (a as Json).id, label: [...String((a as Json).label || (a as Json).id)].slice(0, 40).join('') }));
      if (actions.length) data.actions = actions;
      connection.recordedEvent('studio_note', data);
      return [200, { ok: true }];
    }
    if (name === 'swarm-note') { // internal (swarm/service.ts): a swarm line in the main chat; not in LIVE_POST_OPS, so no page route
      const connection = this.$connection(body);
      const kind = String(body.kind ?? '');
      if (!SWARM_NOTE_KINDS.includes(kind)) throw new ValueError('Unknown swarm note');
      const data: Json = {
        message: [...String(need(body, 'message'))].slice(0, 300).join(''),
        sessionId: connection.sessionId,
        kind,
        helper: String(body.helper ?? '').slice(0, 20),
      };
      const actions = (Array.isArray(body.actions) ? body.actions : []).filter((a) => isDict(a) && SWARM_NOTE_ACTIONS.includes(String(a.id)))
        .map((a) => ({ id: (a as Json).id, label: SWARM_ACTION_LABELS[String((a as Json).id)], helper: data.helper }));
      if (actions.length) data.actions = actions;
      connection.recordedEvent('studio_note', data);
      return [200, { ok: true }];
    }
    // Build plan 1b, 2.3 (MF 2): the landing lock and its friends. Internal (swarm/service.ts, worktrees/merge.ts): not in LIVE_POST_OPS,
    // so no page route reaches them.
    if (name === 'landing-lock' || name === 'landing-renew' || name === 'landing-release') {
      const connection = this.$connection(body);
      const lock = String(need(body, 'lock'));
      const ttl = Math.min(Math.max(Number(body.ttlMs) || LANDING_TTL_MS, 50), 10 * 60_000);
      if (name === 'landing-lock') {
        const why = connection.landingLock(lock, String(body.owner ?? ''), String(body.title ?? '').slice(0, 120), ttl, body.builder === true);
        return [200, { ok: !why, reason: why }];
      }
      if (name === 'landing-renew') return [200, { ok: connection.landingRenew(lock, ttl) }];
      return [200, { ok: connection.landingRelease(lock) }];
    }
    if (name === 'worktree-retire') { // P4b: merged helpers' copies, stopped helpers' copies after 7 days (web: after the take-over)
      const removed = await this.retireMerged();
      const stopped = await this.retireStoppedHelpers().catch((error) => (log.exception(error, 'Stopped helpers failed'), [] as string[]));
      return [200, { ok: true, removed, stopped }];
    }
    if (name === 'subagent-release') { // internal (swarm/service.ts): a landed / empty / discarded subagent's worktree goes (P2)
      if (!this.subagents) return [404, { error: 'No subagent worktrees here' }];
      return [200, { ok: true, result: await this.subagents.release(String(need(body, 'subagent'))) }];
    }
    if (name === 'helper-end') { // internal (swarm/service.ts #endHelper): a finished helper's chat ends, so its agent and everything under it stop
      const connection = this.$connection(body);
      const processes = connection.processCount();
      await connection.close(); // the keeper channel's job (Windows) or process group is killed: exact for every provider
      if (connection.worktree) void this.retireMerged().catch((error) => log.exception(error, 'Removing merged copies failed'));
      return [200, { ok: true, processes }];
    }
    if (name === 'helper-release') { // internal (swarm/service.ts #cleanup): a merged helper's worktree and branch go (the swarm checked it is merged and clean)
      const path = String(body.path ?? '');
      const record = path && this.worktrees ? await this.$worktreeRecord(path, null) : null;
      if (!record) return [200, { ok: true, result: 'gone' }];
      const branch = String(record.branch ?? '');
      if (!branch.startsWith('studio/helper-') || branch !== String(body.branch ?? '') || wslLoc(path)) {
        return [409, { error: 'Not a helper copy of this host' }]; // never any other chat's worktree
      }
      const session = String(record.session ?? '');
      const at = session.indexOf(':');
      if (this.$connectionsIn(path).length || (at > 0 && (await this.$openAnywhere(session.slice(0, at), session.slice(at + 1), path)))) {
        return [200, { ok: true, result: 'open' }];
      }
      return [200, { ok: true, result: await this.$removeWorktree({ ...record }, false) }]; // never confirmed: git refuses a worktree with edits
    }
    if (name === 'history-forget') { // internal (web/shared.ts conversationAction): the person deleted the chat; not in LIVE_POST_OPS
      return [200, { ok: true, removed: await this.forgetHistory(String(body.provider ?? ''), String(body.sessionId ?? '')) }];
    }
    if (name === 'files-changed') { // internal (files/live_files.ts): write calls that finished since `after`; not in LIVE_POST_OPS
      const after = Number(body.after) || 0;
      return [200, { instance: this.instanceId, seq: this.$filesSeq, events: this.$filesChanged.filter((e) => e.seq > after) }];
    }
    if (name === 'prompt-context') { // a one-time line in front of this chat's next prompt (a landing told it what changed)
      const connection = this.$connection(body);
      const replace = typeof body.replace === 'string' ? body.replace.slice(0, 600) : '';
      this.addPromptContext(connection, [...String(need(body, 'line'))].slice(0, 2000).join(''), replace);
      return [200, { ok: true }];
    }
    if (name === 'folder-chats') { // the open chats that work in this folder itself (not copies, not helpers)
      const chats = this.folderChats(String(need(body, 'folder'))).map((c) => ({
        id: c.id,
        title: this.chatTitle(c),
        idle: c.landingIdleReason(),
        landing: c.landing ? c.landing.title : '',
      }));
      return [200, { chats }];
    }
    if (!LIVE_POST_OPS.has(name)) return [404, { error: 'Not found' }];
    if (name === 'worktree-archive') return [200, await this.worktreeArchive(body)];
    if (name === 'dismiss-unknown') {
      let { provider, sessionId } = body;
      const messageId = body.clientMessageId;
      if (isStr(body.id) && this.connections.has(body.id)) {
        const connection = this.connections.get(body.id)!;
        provider = connection.provider;
        sessionId = connection.sessionId;
      }
      if (!(this.store && isStr(provider) && isStr(sessionId) && isStr(messageId))) {
        throw new ValueError('provider, sessionId and clientMessageId are required');
      }
      return [200, { ok: true, dismissed: this.store.dismissReceipt(provider, sessionId, messageId) }];
    }
    const connection = this.$connection(body);
    const text = body.text ?? '';
    const messageId = (body.clientMessageId ?? null) as string | null;
    const attachments = body.attachments ?? null;
    if (name === 'prompt') {
      const result = await connection.prompt(text, messageId, attachments);
      if (connection.provider && connection.sessionId && !result.duplicate) await this.$mark('handled', connection); // replying is acting
      return [200, { ok: true, ...result }];
    }
    if (name === 'steer') { // send now while the agent works (steer-on-send); idle: an ordinary prompt
      const result = await connection.steer(text, messageId, attachments);
      if (connection.provider && connection.sessionId && !result.duplicate) await this.$mark('handled', connection); // replying is acting
      return [200, { ok: true, ...result }];
    }
    if (name === 'tool-stop') { // Stop on a "Still running in the background" row
      try {
        return [200, await connection.stopBackgroundTool(need(body, 'toolCallId'))];
      } catch (error) {
        if (error instanceof NotStoppable) return [409, { error: error.message, code: 'not_stoppable' }];
        throw error;
      }
    }
    if (name === 'queue') {
      const result = await connection.queueAdd(text, messageId, attachments);
      if (connection.provider && connection.sessionId && !result.duplicate) await this.$mark('handled', connection); // queueing is acting
      return [200, { ok: true, ...result }];
    }
    if (name === 'queue-edit') {
      return [
        200,
        await connection.queueEdit(
          need(body, 'messageId') as string,
          need(body, 'action'),
          (body.leaseId ?? null) as string | null,
          body.text ?? null,
        ),
      ];
    }
    if (name === 'queue-remove') return [200, await connection.queueRemove(need(body, 'messageId') as string)];
    if (name === 'queue-move') return [200, await connection.queueMove(need(body, 'messageId') as string, need(body, 'to'))];
    if (name === 'queue-resume') return [200, await connection.queueResume()];
    if (name === 'queue-send-now') return [200, await connection.queueSendNow(need(body, 'messageId') as string, body.interrupt === true)];
    if (name === 'schedule') { // Send later: the message waits for `at` (epoch ms), then joins the queue like any Send
      const result = await connection.scheduleAdd(text, need(body, 'at'), messageId, attachments);
      if (connection.provider && connection.sessionId && !result.duplicate) await this.$mark('handled', connection); // scheduling is acting
      return [200, result];
    }
    if (name === 'schedule-edit') {
      return [200, await connection.scheduleEdit(need(body, 'messageId') as string, body.text ?? null, body.at ?? null)];
    }
    if (name === 'schedule-cancel') return [200, await connection.scheduleCancel(need(body, 'messageId') as string)];
    if (name === 'schedule-send-now') return [200, await connection.scheduleSendNow(need(body, 'messageId') as string)];
    if (name === 'cancel') connection.cancel(body.subagentSessionId ?? null);
    else if (name === 'permission') connection.permission(need(body, 'key'), body.option ?? null);
    else if (name === 'authenticate') connection.answerAuth(need(body, 'action'), body.methodId ?? null);
    else if (name === 'elicitation') connection.answerElicitation(need(body, 'key'), need(body, 'action'), body.content ?? null);
    else if (name === 'config') {
      const result = await connection.changeSetting('config', need(body, 'configId'), need(body, 'value')); // queued during a turn
      this.rememberOptions(connection);
      return [200, { ok: true, ...result }];
    } else if (name === 'mode') {
      const result = await connection.changeSetting('mode', null, need(body, 'modeId'));
      this.rememberOptions(connection);
      return [200, { ok: true, ...result }];
    } else if (name === 'cancel-pending') return [200, { ok: true, pendingChanges: connection.cancelPending(need(body, 'key')) }];
    else if (name === 'session-op' && body.op === 'open-here') {
      // open elsewhere: Open here / Open here anyway on the chat's line (ownership/handoff.ts); nothing is sent to the agent but session/load
      return [200, { ok: true, ...(await connection.reclaim(body.force === true)) }];
    } else if (name === 'session-op' && body.op === 'let-go') {
      // the Let go icon on a Codex chat: let another app open it now (idle only; ownership/handoff.ts)
      if (!isCodexFamily(connection.provider)) throw new ValueError('Let go is for Codex chats.');
      if (connection.elsewhere?.released) return [200, { ok: true, state: 'already' }];
      const state = await connection.letGoIdle(
        { pid: 0, entrypoint: 'let-go', status: '', app: 'another app' },
        'AIB let go of this chat so another app can open it. Open it here to take it back.',
      );
      return [200, {
        ok: true,
        state,
        ...(state === 'busy' ? { message: 'This chat is working, so AIB did not let go. Try again when it is idle.' } : {}),
        ...(state === 'no' ? { message: 'AIB could not let go of this chat right now.' } : {}),
      }];
    } else if (name === 'session-op') {
      const deletedRef = body.op === 'delete' ? [connection.provider, connection.sessionId] : null;
      const result = await sessionOp(connection as never, body);
      const payload: Json = { ok: true, ...result };
      if (deletedRef && result.done === 'delete') payload._deleted = deletedRef; // the web layer owns conversation marks and removes this key
      return [200, payload];
    } else if (name === 'disconnect') {
      await connection.close();
      if (connection.worktree) {
        void this.retireMerged().then(() => this.retireStoppedHelpers()).catch((error) => log.exception(error, 'Removing merged copies failed'));
      }
    }
    return [200, { ok: true }];
  },
};

export type CallMethods = typeof callMethods;
