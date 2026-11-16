/**
 * Swarm phase 1 (design: private/designs/swarm, architect review 2026-11-13): a main chat's agent starts a helper agent of another
 * provider, in its own worktree branched from main; the helper's turn end comes back to the main chat as a report, and the main agent
 * merges it into main through the existing merge pipeline, with one "Merged “X” (Codex) into main · Undo" line in the main chat.
 *
 * Runs in the web process, beside Merge (worktrees/merge.ts): the agent's tool calls come in on POST /api/live/swarm/tool with its
 * per-chat key, the page's Undo / Merge again on page-token routes. Helpers are opened through the live backend's connect (in-process,
 * keeper or split host alike) with `helperOf`, so the Studio gives them their role at creation (review break 1). A loop reads the chat
 * list every 2 s, as the attention watcher does, to see helper turn ends (break 17), keep live ids current after a restart and deliver
 * what waits for a closed main chat (breaks 16b, 20).
 *
 * Enforced here, never taken from the agent's word: only a main chat (a live chat in its own worktree that the registry does not list
 * as a helper) may call the tools, checked on every call; at most MAX_RUNNING helpers per project; no nesting; the brief contract; the
 * owns clash; a helper is merged only by its parent; AIB never runs the brief's test command (break 9).
 */
import { isDict, pyStr } from '../core/py.ts';
import { getLogger } from '../core/log.ts';
import * as merge from '../worktrees/merge.ts';
import * as wt from '../worktrees/worktrees.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import { type Helper, helperOf, newHelperId, readHelpers, Registry, RUNNING_STATES } from './registry.ts';
import { BriefError, briefPrompt, overlaps, owned, readBrief, wrapReport } from './brief.ts';
import { DEFAULT_RULES, pickProvider, WORKSPACE_MODE } from './rules.ts';
import { applyChange, changedFiles } from './undo.ts';
import { claudeHelpers, swarmEnabled } from './settings.ts';
import { WSL_TOOL_GROUPS } from '../artifacts/mcp.ts';
import { isWslRef } from '../platform/location.ts';

const log = getLogger('swarm');

type Json = Record<string, unknown>;
export type Reply = [number, unknown];

export const MAX_RUNNING = 3;
export const POLL_MS = 2000;
/** How long a helper may take to open (the phone's new-chat wait, remote/newchat.ts). */
export const OPEN_MS = 120_000;
/** helper_status calls within this time get the same answer plus a reminder that reports come on their own (review 28). */
export const STATUS_THROTTLE_MS = 60_000;
export const TOOL_NAMES = ['helper_providers', 'start_helper', 'helper_status', 'stop_helper', 'merge_helper'] as const;
export const NOTE_KINDS = ['swarm-start', 'swarm-report', 'swarm-merge', 'swarm-undo', 'swarm-stop', 'swarm-fail'];
export const NOTE_ACTIONS = ['swarm-undo', 'swarm-merge-again', 'swarm-open'];

export interface SwarmHost {
  stateDir: string;
  host: {
    liveList(): Promise<unknown>;
    liveState(id: unknown, after?: unknown): Promise<unknown>;
    liveCall(name: string, body: unknown): Promise<[number, unknown]>;
  };
  settings: { builtinEnabled?(id: string): boolean; betaEnabled?(id: string): boolean };
}

const obj = (v: unknown): Json => (isDict(v) ? v : {});
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const lasting = (c: Json) => (s(c.provider) && s(c.sessionId) ? `${s(c.provider)}:${s(c.sessionId)}` : '');
export const providerName = (id: string) =>
  agentRegistry.BUILTIN_NAMES[id] ?? (agentRegistry.BETA_NAMES as Record<string, string>)[id] ?? id;

export class Refusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
  }
}

export class Swarm {
  readonly registry: Registry;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #watching = false;
  #busy: Promise<void> | null = null;
  #statusAt = new Map<string, [number, Json]>();
  /** Helper ids whose report or open step runs now (a poll never starts a second one). */
  #working = new Set<string>();
  clock: () => number = Date.now;
  openMs = OPEN_MS;

  constructor(readonly ctx: SwarmHost) {
    this.registry = new Registry(ctx.stateDir);
  }

  // ---- who is calling ------------------------------------------------------------------------------------------------------
  /** The caller's live state if it is a main chat; else a Refusal (a helper, a closed chat, a chat with no worktree of its own). */
  async mainChat(conversationId: unknown): Promise<Json> {
    if (typeof conversationId !== 'string' || !conversationId) throw new Refusal('bad_request', 'No conversation', 400);
    const state = obj(await this.ctx.host.liveState(conversationId, 0).catch(() => null));
    if (!state.id || state.closed) throw new Refusal('not_main', 'This chat is not open in AIB');
    const helpers = readHelpers(this.ctx.stateDir);
    if (helperOf(helpers, { live: conversationId, lasting: lasting(state), path: s(state.cwd) })) {
      throw new Refusal('nested', 'Helpers cannot start or manage helpers: only the main chat can');
    }
    // A WSL chat gets no helper tools (mcp.ts WSL_TOOL_GROUPS.swarm off); its own key must not start one either (helpers are
    // Windows worktrees: a helper in the distro would start and then fail at the worktree registry).
    if (!WSL_TOOL_GROUPS.swarm && (isDict(state.wsl) || isWslRef(state.cwd) || isWslRef(state.projectRoot))) {
      throw new Refusal('wsl', 'Helpers are not available in WSL projects yet');
    }
    if (!isDict(state.worktree) || !s(state.projectRoot)) {
      throw new Refusal('no_worktree', 'Helpers need a project that can make worktrees, and this chat works in the project folder itself');
    }
    return state;
  }

  /** True when this chat is a helper (the worktree/tool route refuses its merge: review break 3). */
  isHelper(conversationId: unknown, cwd = ''): boolean {
    if (typeof conversationId !== 'string') return false;
    return !!helperOf(readHelpers(this.ctx.stateDir), { live: conversationId, path: cwd || null });
  }

  #isParent(h: Helper, caller: string, callerLasting: string): boolean {
    return h.parent.live === caller || (!!callerLasting && h.parent.lasting === callerLasting);
  }

  // ---- the agent's tools -----------------------------------------------------------------------------------------------------
  /** POST /api/live/swarm/tool {conversationId, action, args}: [status, payload]. The key was checked by the route. */
  async tool(conversationId: unknown, action: unknown, args: unknown): Promise<Reply> {
    try {
      if (!swarmEnabled(this.ctx.stateDir)) {
        return [403, { ok: false, code: 'swarm-off', error: 'Helpers from other agents are turned off. Turn them on in Settings (Helpers from other agents, experimental), then start a new chat.' }];
      }
      const caller = await this.mainChat(conversationId);
      const a = obj(args);
      if (action === 'helper_providers') return [200, this.providers(caller)];
      if (action === 'start_helper') return [200, await this.startHelper(caller, a)];
      if (action === 'helper_status') return [200, this.status(caller, s(a.helper))];
      if (action === 'stop_helper') return [200, await this.stop(caller, s(a.helper), s(a.reason))];
      if (action === 'merge_helper') return [200, await this.mergeHelper(caller, s(a.helper))];
      return [404, { error: 'Unknown swarm action' }];
    } catch (error) {
      if (error instanceof Refusal) return [error.status, { ok: false, code: error.code, error: error.message }];
      if (error instanceof BriefError) return [409, { ok: false, code: error.code, error: error.message }];
      throw error;
    }
  }

  #usable(provider: string): string {
    const st = this.ctx.settings;
    if ((agentRegistry.BUILTIN_IDS as readonly string[]).includes(provider)) {
      return st.builtinEnabled && !st.builtinEnabled(provider) ? 'turned off in Settings' : '';
    }
    if ((agentRegistry.BETA_IDS as readonly string[]).includes(provider)) {
      return st.betaEnabled && st.betaEnabled(provider) ? '' : 'not turned on in Settings';
    }
    return 'not an agent AIB knows';
  }

  #runningIn(project: string): Helper[] {
    const key = (p: string) => p.replaceAll('\\', '/').toLowerCase();
    return this.registry.all().filter((h) => key(h.project) === key(project) && RUNNING_STATES.has(h.state));
  }

  providers(caller: Json): Json {
    const ids = [...agentRegistry.BUILTIN_IDS, ...agentRegistry.BETA_IDS];
    const claude = claudeHelpers(this.ctx.stateDir);
    return {
      providers: ids.filter((id) => WORKSPACE_MODE[id]).map((id) => {
        const why = id === 'claude' && !claude ? 'Claude helpers are turned off in Settings' : this.#usable(id);
        return { id, name: providerName(id), ok: !why, reason: why, workspaceMode: WORKSPACE_MODE[id] };
      }),
      rules: DEFAULT_RULES.map((r) => ({ job: r.job, label: r.label, provider: r.provider, model: r.model, fallback: r.fallback })),
      caps: { running: this.#runningIn(s(caller.projectRoot)).length, max: MAX_RUNNING, project: s(caller.projectRoot) },
      claudeHelpers: claude,
    };
  }

  async startHelper(caller: Json, args: Json): Promise<Json> {
    const { title, job, brief, provider: named, model, why } = readBrief(args);
    const project = s(caller.projectRoot);
    const running = this.#runningIn(project);
    if (running.length >= MAX_RUNNING) {
      throw new Refusal(
        'cap',
        `${running.length} helpers are already running in this project (cap ${MAX_RUNNING}). Wait for one to finish.`,
      );
    }
    if (!brief.read_only) {
      for (const h of running) {
        for (const mine of brief.owns) {
          const clash = h.brief.owns.find((theirs) => overlaps(mine, theirs));
          if (clash !== undefined) throw new Refusal('owns_clash', `${mine} overlaps ${clash}, owned by “${h.title}”`);
        }
      }
    }
    const picked = pickProvider(job, (p) => this.#usable(p), claudeHelpers(this.ctx.stateDir), named, model);
    if ('error' in picked) throw new Refusal('provider_unavailable', picked.error);
    const mode = WORKSPACE_MODE[picked.provider];
    const id = newHelperId();
    const record: Helper = {
      id,
      title,
      project,
      parent: { live: s(caller.id), lasting: lasting(caller) },
      chat: { live: '', lasting: '', provider: picked.provider, model: picked.model, mode },
      brief,
      picked_by: picked.picked_by,
      rule: picked.rule,
      why,
      worktree: { path: '', branch: '', base: '', start: '' },
      state: 'starting',
      reason: '',
      createdAt: this.clock() / 1000,
      turnEndedAt: '',
      cursor: 0,
      reports: [],
      merge: null,
      notes: [],
    };
    await this.registry.update(id, () => record);
    const picks: Json = { mode, ...(picked.model ? { model: picked.model } : {}) };
    const [code, payload] = await this.ctx.host.liveCall('connect', {
      provider: picked.provider,
      cwd: project,
      background: true,
      picks,
      helperOf: { helperId: id, parent: s(caller.id) },
    });
    if (code !== 200 || !isDict(payload) || !s(payload.id)) {
      const reason = isDict(payload) ? s(payload.error) : 'it did not start';
      await this.#fail(id, `${providerName(picked.provider)} didn't start: ${reason}`);
      throw new Refusal(/worktree/i.test(reason) ? 'no_worktree' : 'provider_unavailable', `Could not start the helper: ${reason}`);
    }
    await this.registry.patch(id, { chat: { ...record.chat, live: s(payload.id) } });
    const pickedText = picked.picked_by === 'rule' ? `rule: ${picked.rule}` : `picked by the main agent: “${why}”`;
    await this.note(
      id,
      'swarm-start',
      `Started helper “${title}” · ${providerName(picked.provider)}${picked.model ? ` · ${picked.model}` : ''} · ${pickedText}`,
      [
        'swarm-open',
      ],
    );
    void this.#open(id).catch((error) => log.exception(error, 'Opening helper %s failed', id));
    return {
      ok: true,
      helper: id,
      chat: s(payload.id),
      provider: picked.provider,
      model: picked.model,
      picked_by: picked.picked_by,
      rule: picked.rule,
      skipped: picked.skipped,
      state: 'starting',
      caps: { running: running.length + 1, max: MAX_RUNNING },
      note: 'Its report comes to this chat on its own when it finishes: do not poll helper_status.',
    };
  }

  /** Wait for the helper to open; then check its worktree and mode (fail closed) and send the brief as its first prompt. */
  async #open(id: string): Promise<void> {
    this.#working.add(id);
    try {
      const deadline = this.clock() + this.openMs;
      let state: Json = {};
      while (this.clock() < deadline) {
        const h = this.registry.get(id);
        if (!h || h.state !== 'starting') return; // stopped meanwhile
        state = obj(await this.ctx.host.liveState(h.chat.live, 0).catch(() => null));
        if (!state.id || state.closed) return await this.#fail(id, `The helper could not open: ${s(state.error) || 'it closed'}`);
        if (state.auth) {
          await this.ctx.host.liveCall('disconnect', { id: h.chat.live });
          return await this.#fail(id, `${providerName(h.chat.provider)} isn't signed in`);
        }
        if (state.setupDone && state.ready) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      const h = this.registry.get(id)!;
      if (!(state.setupDone && state.ready)) {
        await this.ctx.host.liveCall('disconnect', { id: h.chat.live });
        return await this.#fail(id, 'The helper did not open in time');
      }
      const record = wt.recordForPath(this.ctx.stateDir, state.cwd);
      if (!isDict(state.worktree) || !record) { // never in the project folder (review break 5)
        await this.ctx.host.liveCall('disconnect', { id: h.chat.live });
        return await this.#fail(id, 'The helper could not get its own worktree');
      }
      const picks = Array.isArray(state.pickResults) ? state.pickResults.map(obj) : [];
      const modePick = picks.find((p) => p.kind === 'mode');
      if (!modePick || modePick.ok !== true) { // review break 7: never fall back to the agent's or the user's default mode
        await this.ctx.host.liveCall('disconnect', { id: h.chat.live });
        return await this.#fail(id, `Could not set ${providerName(h.chat.provider)}'s edit-in-workspace mode (${h.chat.mode})`);
      }
      const worktree = { path: s(record.path), branch: s(record.branch), base: s(record.base), start: s(record.snapshot) };
      await this.registry.patch(id, { chat: { ...h.chat, lasting: lasting(state) }, worktree, cursor: Number(state.cursor) || 0 });
      const [code, payload] = await this.ctx.host.liveCall('prompt', {
        id: h.chat.live,
        text: briefPrompt(h.title, h.brief, worktree.branch),
        clientMessageId: `swarm-brief-${id}`,
      });
      if (code !== 200) return await this.#fail(id, `The brief could not be sent: ${s(obj(payload).error)}`);
      await this.registry.patch(id, { state: 'working' });
    } finally {
      this.#working.delete(id);
    }
  }

  async #fail(id: string, reason: string): Promise<void> {
    const h = await this.registry.patch(id, { state: 'failed', reason });
    if (h) await this.note(id, 'swarm-fail', `Helper “${h.title}” (${providerName(h.chat.provider)}) failed: ${reason}`);
  }

  status(caller: Json, helper: string): Json {
    const key = `${s(caller.id)}|${helper}`;
    const now = this.clock();
    const hit = this.#statusAt.get(key);
    if (hit && now - hit[0] < STATUS_THROTTLE_MS) {
      return { ...hit[1], throttled: true, note: 'Same as a moment ago. Reports arrive in this chat on their own; no need to poll.' };
    }
    const mine = this.registry.all().filter((h) => this.#isParent(h, s(caller.id), lasting(caller)) && (!helper || h.id === helper));
    const out = {
      helpers: mine.map((h) => ({
        id: h.id,
        title: h.title,
        provider: h.chat.provider,
        model: h.chat.model,
        state: h.state,
        reason: h.reason,
        minutes: Math.round((now / 1000 - h.createdAt) / 60),
        branch: h.worktree.branch,
        merged: h.merge && !h.merge.undo ? { commits: h.merge.commits, range: [h.merge.tipBefore, h.merge.landed] } : null,
      })),
    };
    this.#statusAt.set(key, [now, out]);
    return out;
  }

  #mine(caller: Json, id: string): Helper {
    const h = this.registry.get(id);
    if (!h) throw new Refusal('unknown_helper', `No helper ${id}`, 404);
    if (!this.#isParent(h, s(caller.id), lasting(caller))) {
      throw new Refusal('not_parent', 'Only the chat that started this helper can do that', 403);
    }
    return h;
  }

  /** Stop: the helper's turn is cancelled and its work committed on its branch; its chat stays open, so it can still be merged. */
  async stop(caller: Json, which: string, reason: string): Promise<Json> {
    const targets = which === 'all'
      ? this.registry.all().filter((h) => this.#isParent(h, s(caller.id), lasting(caller)) && RUNNING_STATES.has(h.state))
      : [this.#mine(caller, which)];
    const stopped: string[] = [];
    const kept: Json[] = [];
    for (const h of targets) {
      if (h.chat.live) await this.ctx.host.liveCall('cancel', { id: h.chat.live }).catch(() => {});
      const commits = await this.#keepWork(h, 'AIB: helper stopped, work kept');
      await this.registry.patch(h.id, { state: 'stopped', reason: reason || 'stopped by the main agent' });
      stopped.push(h.id);
      kept.push({ id: h.id, branch: h.worktree.branch, commits });
      await this.note(
        h.id,
        'swarm-stop',
        `Stopped “${h.title}” (${providerName(h.chat.provider)}). Work kept: ${commits} commit(s) on ${h.worktree.branch || 'its branch'}.`,
      );
    }
    return { stopped, kept };
  }

  /** Commit what is uncommitted in the helper's worktree; returns how many commits its branch has over its start. */
  async #keepWork(h: Helper, message: string): Promise<number> {
    if (!h.worktree.path) return 0;
    try {
      await new Promise((r) => setTimeout(r, 300)); // the cancelled turn's last writes
      if ((await merge.porcelainPaths(h.worktree.path)).size) {
        await wt.git(['add', '-A'], h.worktree.path);
        await merge.gitc(['commit', '-q', '-m', message], h.worktree.path, { check: false });
      }
      const count = await wt.git(['rev-list', '--count', `${h.worktree.start}..HEAD`], h.worktree.path, { check: false });
      return Number(count.stdout.trim()) || 0;
    } catch (error) {
      log.exception(error, 'Keeping the work of helper %s failed', h.id);
      return 0;
    }
  }

  /** merge_helper: the helper's work lands on main through Merge (busy check, conflicts prompted to the helper), on the parent's behalf. */
  async mergeHelper(caller: Json, id: string): Promise<Json> {
    const h = this.#mine(caller, id);
    if (h.merge && !h.merge.undo) throw new Refusal('merged', `“${h.title}” is already merged`);
    if (!['done', 'waiting', 'stopped'].includes(h.state)) {
      throw new Refusal('busy', `“${h.title}” is ${h.state}; merge it once its report is in`);
    }
    if (!h.chat.live) throw new Refusal('closed', 'The helper chat is not open');
    const base = h.worktree.base || 'main';
    const target = await merge.targetBranch(h.project, base);
    const tipBefore = await merge.rev(h.project, `refs/heads/${target}`);
    let result: Json;
    try {
      result = await merge.merge(this.#mergeStudio(), h.chat.live, h.title, false); // fromTool=false: the helper must be idle
    } catch (error) {
      if (error instanceof merge.Refused) {
        if (error.code === 'empty' && h.brief.read_only) {
          await this.registry.patch(id, { state: 'merged' });
          await this.note(
            id,
            'swarm-merge',
            `Merged “${h.title}” (${providerName(h.chat.provider)}) into ${target} · nothing to land (read-only helper, report only)`,
          );
          return { state: 'merged', commits: 0 };
        }
        return { state: 'refused', code: error.code, message: error.message };
      }
      throw error;
    }
    if (result.state === 'conflicts') {
      return {
        state: 'conflicts',
        files: result.files,
        message: 'Nothing landed. The helper was asked to resolve the conflicts in its worktree; merge again when it reports.',
      };
    }
    const landed = s(result.tip);
    const commits = Number(result.commits) || 0;
    await this.registry.patch(id, {
      state: 'merged',
      merge: { tipBefore, landed, commits, at: this.clock() / 1000, undo: null, again: null },
    });
    await this.note(
      id,
      'swarm-merge',
      `Merged “${h.title}” (${providerName(h.chat.provider)}) into ${target} · ${commits} commit${commits === 1 ? '' : 's'}`,
      ['swarm-undo'],
    );
    return { state: 'merged', commits, range: [tipBefore, landed], target };
  }

  #mergeStudio(): merge.MergeStudio {
    return {
      stateDir: this.ctx.stateDir,
      liveState: (chatId) => this.ctx.host.liveState(chatId, 0),
      liveCall: (op, payload) => this.ctx.host.liveCall(op, payload),
    };
  }

  // ---- the page's Undo and Merge again (page token only; never the agent's key: review break 14) -------------------------------
  async undo(id: unknown): Promise<Reply> {
    const h = typeof id === 'string' ? this.registry.get(id) : null;
    if (!h || !h.merge) return [404, { error: 'That helper has no merge to undo' }];
    if (h.merge.undo && !h.merge.again) return [409, { error: 'Already undone' }];
    const target = await merge.targetBranch(h.project, h.worktree.base || 'main');
    const done = await applyChange(
      this.ctx.stateDir,
      h.project,
      target,
      h.merge.again ? h.merge.again.commit : h.merge.landed,
      h.merge.again ? `${h.merge.again.commit}^` : h.merge.tipBefore,
      `AIB: undo the merge of helper “${h.title}” (${providerName(h.chat.provider)})`,
    );
    if (done.state === 'conflicts') {
      const files = done.files.length ? done.files : await changedFiles(h.project, h.merge.tipBefore, h.merge.landed);
      await this.note(
        h.id,
        'swarm-undo',
        `Can't undo “${h.title}” cleanly: later changes touch the same lines (${files.slice(0, 6).join(', ')}). Nothing changed.`,
      );
      return [200, { state: 'cannot_undo', files }];
    }
    if (done.state === 'refused') return [409, { error: done.message }];
    await this.registry.patch(h.id, {
      state: 'done',
      merge: { ...h.merge, undo: { revert: done.commit, at: this.clock() / 1000 }, again: null },
    });
    await this.note(
      h.id,
      'swarm-undo',
      `Undid the merge of “${h.title}” (${providerName(h.chat.provider)}) · ${target} is back to before it · the helper's branch is kept` +
        (done.kept ? ` · your edits clash with it and are kept in a stash` : ''),
      ['swarm-merge-again'],
    );
    return [200, { state: 'undone', commit: done.commit }];
  }

  async mergeAgain(id: unknown): Promise<Reply> {
    const h = typeof id === 'string' ? this.registry.get(id) : null;
    if (!h || !h.merge?.undo) return [404, { error: 'That helper has no undone merge' }];
    const target = await merge.targetBranch(h.project, h.worktree.base || 'main');
    const revert = h.merge.undo.revert;
    const done = await applyChange(this.ctx.stateDir, h.project, target, revert, `${revert}^`, `AIB: merge helper “${h.title}” again`);
    if (done.state === 'conflicts') return [200, { state: 'cannot_merge', files: done.files }];
    if (done.state === 'refused') return [409, { error: done.message }];
    await this.registry.patch(h.id, {
      state: 'merged',
      merge: { ...h.merge, undo: null, again: { commit: done.commit, at: this.clock() / 1000 } },
    });
    await this.note(h.id, 'swarm-merge', `Merged “${h.title}” (${providerName(h.chat.provider)}) into ${target} again`, ['swarm-undo']);
    return [200, { state: 'merged', commit: done.commit }];
  }

  // ---- lines in the main chat ------------------------------------------------------------------------------------------------
  /** A line in the parent chat; kept in the record and posted when the parent is open (now or later). */
  async note(id: string, kind: string, text: string, actions: string[] = []): Promise<void> {
    const h = await this.registry.update(
      id,
      (h) => h ? { ...h, notes: [...h.notes, { at: this.clock() / 1000, kind, text, actions, delivered: false }] } : null,
    );
    if (h) await this.#flushNotes(h);
  }

  async #flushNotes(h: Helper): Promise<void> {
    const waiting = h.notes.map((n, i) => [n, i] as const).filter(([n]) => !n.delivered);
    if (!waiting.length || !h.parent.live) return;
    for (const [n, i] of waiting) {
      const [code] = await this.ctx.host.liveCall('swarm-note', {
        id: h.parent.live,
        kind: n.kind,
        helper: h.id,
        message: n.text,
        actions: (n.actions ?? []).map((a) => ({ id: a })),
      }).catch(() => [500] as [number]);
      if (code !== 200) return; // the parent is closed: posted when it opens again
      await this.registry.update(h.id, (cur) => {
        if (!cur) return null;
        const notes = [...cur.notes];
        if (notes[i]) notes[i] = { ...notes[i], delivered: true };
        return { ...cur, notes };
      });
    }
  }

  // ---- watching the helpers (every POLL_MS) ----------------------------------------------------------------------------------
  startWatching(): void {
    if (this.#watching) return;
    this.#watching = true;
    const loop = async () => {
      if (!this.#watching) return;
      await this.poll();
      if (this.#watching) this.#timer = setTimeout(loop, POLL_MS);
    };
    this.#timer = setTimeout(loop, 0);
  }

  async stopWatching(): Promise<void> {
    this.#watching = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    await this.#busy?.catch(() => {});
  }

  poll(): Promise<void> {
    if (this.#busy) return this.#busy;
    const run = this.#poll().catch((error) =>
      log.info('swarm: could not look at the helpers (%s)', error instanceof Error ? error.message : error)
    )
      .finally(() => (this.#busy = null));
    this.#busy = run;
    return run;
  }

  async #poll(): Promise<void> {
    const helpers = this.registry.all().filter((h) =>
      h.state !== 'failed' || h.notes.some((n) => !n.delivered) || h.reports.some((r) => !r.delivered)
    );
    if (!helpers.length) return;
    const listing = obj(await this.ctx.host.liveList());
    if (listing.instanceId === 'host-unavailable') return;
    const chats = (Array.isArray(listing.connections) ? listing.connections : []).map(obj).filter((c) => !c.closed);
    const byLasting = new Map(chats.filter((c) => lasting(c)).map((c) => [lasting(c), c]));
    for (const h0 of helpers) {
      let h = h0;
      // live ids change across restarts: find both chats again by their lasting names
      const parent = byLasting.get(h.parent.lasting) ?? chats.find((c) => c.id === h.parent.live);
      const chat = (h.chat.lasting ? byLasting.get(h.chat.lasting) : undefined) ?? chats.find((c) => c.id === h.chat.live);
      const parentLive = parent ? s(parent.id) : '';
      const chatLive = chat ? s(chat.id) : h.chat.live;
      if (parentLive !== h.parent.live || chatLive !== h.chat.live) {
        h = (await this.registry.patch(h.id, { parent: { ...h.parent, live: parentLive }, chat: { ...h.chat, live: chatLive } })) ?? h;
      }
      if (parent) {
        await this.#flushNotes(h);
        await this.#deliverReports(h, parent);
      }
      if (!chat || this.#working.has(h.id) || !['working', 'waiting', 'done'].includes(h.state)) continue;
      const attention = obj(chat.attention);
      const ended = s(attention.turnEndedAt);
      const queue = obj(chat.queue);
      const idle = attention.state === 'idle' && !(Array.isArray(queue.items) && queue.items.length);
      if (!idle || !ended || ended === h.turnEndedAt) continue;
      this.#working.add(h.id);
      try {
        await this.#report(h, chat, ended);
      } finally {
        this.#working.delete(h.id);
      }
      const fresh = this.registry.get(h.id);
      if (fresh && parent) await this.#deliverReports(fresh, parent);
    }
  }

  /** The helper's turn ended: build the report from AIB's own facts and the helper's reply text. */
  async #report(h: Helper, chat: Json, ended: string): Promise<void> {
    const state = obj(await this.ctx.host.liveState(s(chat.id), h.cursor || 1).catch(() => null));
    const events = Array.isArray(state.events) ? state.events.map(obj) : [];
    const reply = events.map((e) => obj(obj(e.data).update)).filter((u) => u.sessionUpdate === 'agent_message_chunk')
      .map((u) => s(obj(u.content).text)).join('');
    let files: string[] = [], insertions = 0, deletions = 0, commits = 0;
    if (h.worktree.path && h.worktree.start) {
      try {
        files = await wt.touchedPaths(h.worktree.path, h.worktree.start);
        for (
          const line of (await wt.git(['diff', '--numstat', h.worktree.start], h.worktree.path, { check: false })).stdout.split(/\r?\n/)
        ) {
          const [a, d] = line.split('\t');
          insertions += Number(a) || 0;
          deletions += Number(d) || 0;
        }
        commits =
          Number((await wt.git(['rev-list', '--count', `${h.worktree.start}..HEAD`], h.worktree.path, { check: false })).stdout.trim()) ||
          0;
      } catch (error) {
        log.exception(error, 'Reading the changes of helper %s failed', h.id);
      }
    }
    const done = !h.reports.length || h.state !== 'merged';
    const text = wrapReport({
      id: h.id,
      title: h.title,
      providerName: providerName(h.chat.provider),
      model: h.chat.model,
      state: done ? 'done' : h.state,
      minutes: Math.max(0, Math.round((this.clock() / 1000 - h.createdAt) / 60)),
      branch: h.worktree.branch,
      commits,
      files: files.length,
      insertions,
      deletions,
      outside: files.filter((f) => !owned(f, h.brief.owns)),
      doneWhen: h.brief.done_when,
      reply,
    });
    await this.registry.update(h.id, (cur) =>
      cur
        ? {
          ...cur,
          state: cur.state === 'merged' ? cur.state : 'done',
          turnEndedAt: ended,
          cursor: Number(state.cursor) || cur.cursor,
          reports: [...cur.reports, { n: cur.reports.length + 1, at: this.clock() / 1000, text, delivered: false, how: '' }],
        }
        : null);
    await this.note(
      h.id,
      'swarm-report',
      `Report from “${h.title}” (${
        providerName(h.chat.provider)
      }): ${files.length} file(s) changed, +${insertions} −${deletions}, ${commits} commit(s)`,
      ['swarm-open'],
    );
  }

  /**
   * Reports go to the parent: through the steer lane while it works, as its next prompt while it is idle, and into its queue (paused)
   * after the user pressed Stop, so a report never restarts work the user just stopped (review break 16a). A closed parent gets them
   * when it opens again.
   */
  async #deliverReports(h: Helper, parent: Json): Promise<void> {
    for (const r of h.reports.filter((r) => !r.delivered)) {
      const queue = obj(parent.queue);
      const how = queue.paused ? 'queued' : 'steer';
      const [code, payload] = await this.ctx.host.liveCall(how === 'queued' ? 'queue' : 'steer', {
        id: s(parent.id),
        text: r.text,
        clientMessageId: `swarm-report-${h.id}-${r.n}`,
      }).catch((error) => [500, { error: String(error) }] as [number, unknown]);
      if (code !== 200) {
        log.info('swarm: report %s of %s waits: %s', r.n, h.id, pyStr(obj(payload).error ?? ''));
        return;
      }
      const sent = how === 'queued' ? 'queued' : obj(payload).steered ? 'steer' : 'prompt';
      await this.registry.update(
        h.id,
        (cur) =>
          cur ? { ...cur, reports: cur.reports.map((x) => (x.n === r.n ? { ...x, delivered: true, how: sent as 'steer' } : x)) } : null,
      );
    }
  }
}
