/**
 * Aib methods: the host RPC calls (allow, install, sign-in, live calls).
 * Moved out of aib.ts (no change).
 */
import type { Connection } from '../acp/connection.ts';
import { PromptStateUnknown } from '../acp/rpc_errors.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import * as adapters from '../agents/adapters.ts';
import { Installer, InstallRefused } from '../agents/installer.ts';
import { Signer, SignInRefused } from '../agents/signin.ts';
import { isBeta } from '../agents/beta_catalog.ts';
import { BetaSigner } from '../agents/beta_signin.ts';
import { isDict, isStr, ValueError } from '../core/py.ts';
import { OwnershipConflict } from '../ownership/ownership.ts';
import { builtinLaunch } from '../web/shared.ts';
import { isWslRecord, wslHasChanges } from '../wsl/worktrees.ts';
import { sameProject } from '../allow/matcher.ts';
import {
  log,
  type Json,
  KeyError,
  need,
  isRequestError,
} from './aib_util.ts';
import { liveOp } from './aib_live_ops.ts';
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

  /** One live call (POST /api/live/<name> and the internal calls): the table in aib_live_ops.ts is the one list of ops. */
  async $liveCall(this: Aib, name: string, body: unknown): Promise<[number, unknown]> {
    if (!isDict(body)) throw new ValueError('Invalid request');
    if (name.startsWith('allow-')) return this.$allowCall(name, body); // allow rules: page-session routes only (web/live_routes.ts)
    const entry = liveOp(name);
    if (!entry) return [404, { error: 'Not found' }];
    return await entry.run.call(this, body);
  },
};

export type CallMethods = typeof callMethods;
