/**
 * Swarm phase 1 (design: aib-shared/designs/swarm, architect review 2026-11-13): a main chat's agent starts a helper agent of another
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
import { type Helper, helperOf, HOLDING_STATES, type Landing, newHelperId, readHelpers, Registry, RUNNING_STATES } from './registry.ts';
import { lockChats, newLockId } from '../worktrees/landing_lock.ts';
import { CopyMergeQueue } from '../worktrees/merge_queue.ts';
import { BriefError, briefPrompt, overlaps, owned, readBrief, wrapReport } from './brief.ts';
import { DEFAULT_RULES, pickProvider, WORKSPACE_MODE, workspaceModeOf, workspaceModesOf } from './rules.ts';
import { baseAgent, isServerEntry, serverIdOf } from '../agents/claude_family.ts';
import { type ModelServer, modelServerLabel } from '../agents/model_servers.ts';
import { MODEL_SERVER_AGENTS } from '../agents/claude_family.ts';
import { applyChange, changedFiles } from './undo.ts';
import { ignoredFiles, landSubagentWork, protectedPath, SCRATCH_EXT, scratchFiles } from '../worktrees/subagent_land.ts';
export { ignoredFiles, protectedPath, SCRATCH_EXT, scratchFiles };
import { claudeHelpers, swarmEnabled } from './settings.ts';
import { readSubagents, type SubagentRecord } from '../subagents/service.ts';
import { canonicalName } from '../allow/paths.ts';
import { WSL_TOOL_GROUPS } from '../artifacts/mcp.ts';
import { isWslRef } from '../platform/location.ts';
import { pathOf } from '../state/paths.ts';

const log = getLogger('swarm');

type Json = Record<string, unknown>;
export type Reply = [number, unknown];

export const MAX_RUNNING = 3;
export const POLL_MS = 2000;
/** The cleanup of merged helpers' copies is looked at this often (and at the first poll after start). */
export const SWEEP_MS = 30_000;
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
    /** A model-server entry's server health (the kept 30 s answer): '' when it answers, else "strata is not answering at 127.0.0.1:8080". */
    modelServerDown?(provider: string): Promise<string>;
  };
  /**
   * '' when the agent can start now; else the plain reason ("Codex isn't signed in on this PC: sign in from Settings › AIB Linking").
   * Installed and signed in (the sign-in cache, refreshed when older than a minute); a model-server entry needs no sign-in. Without it
   * (tests) nothing is checked up front and a missing sign-in shows while the helper opens, as before.
   */
  agentProblem?(provider: string): Promise<string>;
  /**
   * Helper news that goes where a chat's news goes (desktop notification, phone push; attention/watcher.ts announce): the web server
   * sets it. Never called with a chat's own turn end or request: those are announced by the chat's own watcher look.
   */
  announce?(news: HelperNews): void;
  settings: { builtinEnabled?(id: string): boolean; betaEnabled?(id: string): boolean; modelServer?(id: string): ModelServer | null; modelServers?(): ModelServer[] };
}

const obj = (v: unknown): Json => (isDict(v) ? v : {});
const s = (v: unknown) => (typeof v === 'string' ? v : '');
const lasting = (c: Json) => (s(c.provider) && s(c.sessionId) ? `${s(c.provider)}:${s(c.sessionId)}` : '');
export const providerName = (id: string) =>
  isServerEntry(id)
    ? modelServerLabel(baseAgent(id), serverIdOf(id) ?? '')
    : agentRegistry.BUILTIN_NAMES[id] ?? (agentRegistry.BETA_NAMES as Record<string, string>)[id] ?? id;
/** How a helper's agent reads in every line: the kept label of a model-server entry ("Claude Code · strata"), else its name. */
export const chatName = (h: Helper) => h.chat.label || providerName(h.chat.provider);

/** Build plan 2.2: after this many refusals (busy, locked, moving) the chat gets one line; after this long queued, another. */
export const LANDING_TRIES_NOTE = 3;
export const LANDING_WAIT_NOTE_S = 600;
/** Merge refusals a later try may not meet (git busy, the branch moving, a chat in the folder working). */
const RETRY_CODES = new Set(['busy', 'locked', 'moving', 'ff_failed', 'folder_busy', 'running', 'stash_failed', 'failed']);

/** A finished subagent with no changes whose chat is not open goes this long after its end (#dropEmptyOrphan). */
export const ORPHAN_EMPTY_S = 30 * 60;

/**
 * A subagent's worktree is exactly its snapshot S: HEAD (and its branch) at S, nothing changed, staged or untracked. A worktree that is
 * gone counts when its branch is at S or gone too (nothing of it is anywhere). False whenever git can't say.
 */
export async function subagentUnchanged(rec: { path: string; folder: string; branch: string; snapshot: string }): Promise<boolean> {
  if (!rec.snapshot || !rec.folder || !wt.lexists(rec.folder)) return false;
  const branchAt = await wt.git(['rev-parse', '-q', '--verify', `refs/heads/${rec.branch}`], rec.folder, { check: false });
  const tip = branchAt.returncode === 0 ? pyStr(branchAt.stdout).trim() : '';
  if (tip && tip !== rec.snapshot) return false;
  if (!rec.path || !wt.lexists(rec.path)) return true;
  const head = await wt.git(['rev-parse', 'HEAD'], rec.path, { check: false });
  if (head.returncode !== 0 || pyStr(head.stdout).trim() !== rec.snapshot) return false;
  const status = await wt.git(['status', '--porcelain', '--untracked-files=all', '--ignored=no'], rec.path, { check: false });
  return status.returncode === 0 && pyStr(status.stdout).trim() === '' && !(await ignoredFiles(rec.path)).length;
}

/** How long a subagent worktree that holds files AIB did not land is kept before AIB removes it (the parent is told the date). */
export const KEPT_DAYS = 7;

/** A helper of a chat that works in the project folder: it lands on the folder's branch, queued, with no stash (build plan 2b). */
export const folderParent = (h: Helper) => !!h.worktree?.landOn;

/** The tool's answer when merge_helper queues (build plan 2.2). */
export function queuedLine(h: Helper): string {
  if (h.kind === 'subagent') {
    return `Subagent “${h.title}” lands in the project folder when your turn ends. Finish your turn; the result is in your next message.`;
  }
  return `“${h.title}” (${chatName(h)}) lands in the project folder when your turn ends. Finish your turn; the result is ` +
    'in your next message.';
}

export function newLanding(what: Landing['what'], by: Landing['by'], nowMs: number): Landing {
  return {
    what,
    by,
    queuedAt: nowMs / 1000,
    tries: 0,
    lastRefusal: '',
    waitsFor: '',
    stage: 'queued',
    lockId: '',
    stashSha: '',
    stashName: '',
    stashFolder: '',
    landed: '',
    tipBefore: '',
    toldTries: false,
    toldWait: false,
  };
}

const titleOf = (rec: SubagentRecord) => (rec.description || rec.agentType || 'subagent').replace(/\s+/g, ' ').trim().slice(0, 120);
const shown = (files: string[], limit = 6) => files.slice(0, limit).join(', ') + (files.length > limit ? ' and more' : '');
const baseName = (p: string) => p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1);
const lower = (t: string) => (t ? t[0].toLowerCase() + t.slice(1) : t).replace(/[.\s]+$/, '');

/** How a notification names a helper chat: “Helper “Login bug” (Codex)”, never the brief's first words. */
export const helperTitle = (h: Helper) => `Helper “${h.title}” (${chatName(h)})`;

/** One piece of helper news for the notification paths (SwarmHost.announce). `parent` is the main chat's live id. */
export interface HelperNews {
  fk: string;
  parent: string;
  parentLasting: string;
  title: string;
  kind: 'needs' | 'turn';
  reason: 'failed' | 'finished' | 'approval' | 'question' | 'signin' | 'asks';
  what: string;
}

/** How a line names a helper or a subagent entry. */
export const label = (h: Helper) => (h.kind === 'subagent' ? `subagent “${h.title}”` : `“${h.title}” (${chatName(h)})`);

const NO_BRIEF = { goal: '', owns: [], avoid: [], done_when: '', reply_with: '', test_cmd: '', read_only: false, context_files: [] };

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
  /** When the cleanup sweep last ran (0: not yet, so the first look after start sweeps the leftovers). */
  #sweepAt = 0;
  clock: () => number = Date.now;
  openMs = OPEN_MS;

  /** Own-copy chats' merges that wait for the chats in the project folder (build plan 2.3), run by the same watcher. */
  readonly copyMerges: CopyMergeQueue;

  constructor(readonly ctx: SwarmHost) {
    this.registry = new Registry(ctx.stateDir);
    this.copyMerges = new CopyMergeQueue(ctx.stateDir, ctx.host);
  }

  // ---- who is calling ------------------------------------------------------------------------------------------------------
  /**
   * The caller's live state if it is a main chat; else a Refusal (a helper, a closed chat). A chat in the project folder leads helpers
   * too (build plan 1b, MF 1): its `projectRoot` is set to the folder it works in, which is where its helpers' copies come from.
   */
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
    if (!isDict(state.worktree)) state.projectRoot = s(state.cwd); // a folder chat: its project is the folder it works in
    if (!s(state.projectRoot)) throw new Refusal('not_main', 'This chat has no project folder');
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
      const subagentMerge = action === 'merge_helper' && s(obj(args).helper).startsWith('sa_'); // a subagent's: not a swarm tool
      if (!swarmEnabled(this.ctx.stateDir) && !subagentMerge) {
        return [403, { ok: false, code: 'swarm-off', error: 'Helpers from other agents are turned off. Turn them on in Settings › AIB Linking (Helpers from other agents), then start a new chat.' }];
      }
      const caller = await this.mainChat(conversationId);
      const a = obj(args);
      if (action === 'helper_providers') return [200, await this.providers(caller)];
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
    if (isServerEntry(provider)) { // `claude@strata`: its server's "Use with" switch is on and its base agent is usable
      const base = baseAgent(provider);
      const server = st.modelServer?.(serverIdOf(provider) ?? '') ?? null;
      if (!server) return 'that model server is not in Settings';
      if (!server.useWith.includes(base)) return `${server.name} is not switched on for ${providerName(base)} in Settings`;
      return this.#usable(base);
    }
    if ((agentRegistry.BUILTIN_IDS as readonly string[]).includes(provider)) {
      return st.builtinEnabled && !st.builtinEnabled(provider) ? 'turned off in Settings' : '';
    }
    if ((agentRegistry.BETA_IDS as readonly string[]).includes(provider)) {
      return st.betaEnabled && st.betaEnabled(provider) ? '' : 'not turned on in Settings';
    }
    return 'not an agent AIB knows';
  }

  /** Every model-server entry that is switched on ("Use with") for an agent AIB can run as a helper, as `<agent>@<server id>`. */
  #serverEntries(): { id: string; label: string }[] {
    const out: { id: string; label: string }[] = [];
    for (const server of this.ctx.settings.modelServers?.() ?? []) {
      for (const agent of MODEL_SERVER_AGENTS) {
        if (WORKSPACE_MODE[agent]?.length && server.useWith.includes(agent)) out.push({ id: `${agent}@${server.id}`, label: modelServerLabel(agent, server.name) });
      }
    }
    return out;
  }

  /** The label of an entry from its server's name; the id's own form when the server is gone. */
  #entryLabel(provider: string): string {
    const server = this.ctx.settings.modelServer?.(serverIdOf(provider) ?? '');
    return server ? modelServerLabel(baseAgent(provider), server.name) : providerName(provider);
  }

  /** '' when the agent is installed and signed in (ctx.agentProblem); a check that cannot run says nothing. */
  async #agentProblem(provider: string): Promise<string> {
    if (!this.ctx.agentProblem) return '';
    return await this.ctx.agentProblem(provider).catch(() => '');
  }

  /** '' when the entry's server answers (the kept 30 s health check); else the plain line naming it and its address. */
  async #serverDown(provider: string): Promise<string> {
    if (!isServerEntry(provider) || !this.ctx.host.modelServerDown) return '';
    return await this.ctx.host.modelServerDown(provider).catch(() => '');
  }

  /**
   * The helpers of a project that hold a place in the cap and their files in the owns clash: the ones that work or wait, and the ones
   * that are done but not merged yet (their files stay theirs until the main agent merges or discards them). A read-only helper that
   * is done holds nothing, and a subagent's landing entry is not a helper.
   */
  #runningIn(project: string): Helper[] {
    const key = (p: string) => p.replaceAll('\\', '/').toLowerCase();
    return this.registry.all().filter((h) =>
      h.kind !== 'subagent' && key(h.project) === key(project) && HOLDING_STATES.has(h.state) &&
      (RUNNING_STATES.has(h.state) || !h.brief?.read_only)
    );
  }

  async providers(caller: Json): Promise<Json> {
    const ids = [...agentRegistry.BUILTIN_IDS, ...agentRegistry.BETA_IDS];
    const claude = claudeHelpers(this.ctx.stateDir);
    const builtins = await Promise.all(ids.filter((id) => WORKSPACE_MODE[id]).map(async (id) => {
      const why = (id === 'claude' && !claude ? 'Claude helpers are turned off in Settings' : this.#usable(id)) ||
        await this.#agentProblem(id);
      return { id, name: providerName(id), ok: !why, reason: why, workspaceMode: WORKSPACE_MODE[id][0] };
    }));
    const entries = await Promise.all(this.#serverEntries().map(async (e) => {
      const why = this.#usable(e.id) || await this.#serverDown(e.id) || await this.#agentProblem(e.id);
      return { id: e.id, name: e.label, ok: !why, reason: why, workspaceMode: workspaceModeOf(e.id), modelServer: true };
    }));
    return {
      providers: [...builtins, ...entries],
      ...(entries.length
        ? { note: 'Entries marked modelServer run on a model server the user set up (local or private). Name one in start_helper `provider` (with `why`) for jobs that should stay local, private or cheap.' }
        : {}),
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
      const unmerged = running.filter((h) => h.state === 'done').length;
      throw new Refusal(
        'cap',
        `${running.length} helpers are already running or waiting to be merged in this project (cap ${MAX_RUNNING}). ` +
          (unmerged ? `${unmerged} finished but not merged yet: merge it with merge_helper (or stop it) to free a place. ` : '') +
          'Wait for one to finish.',
      );
    }
    if (!brief.read_only) {
      for (const h of running) { // running, waiting and done-but-unmerged helpers: their files are theirs until merged or discarded
        for (const mine of brief.owns) {
          const clash = h.brief.owns.find((theirs) => overlaps(mine, theirs));
          if (clash !== undefined) {
            throw new Refusal(
              'owns_clash',
              `${mine} overlaps ${clash}, owned by “${h.title}”` + (h.state === 'done' ? ' (finished, not merged yet: merge it first)' : ''),
            );
          }
        }
      }
    }
    // Installed and signed in, asked up front for every provider the pick may take, so a rule skips one that is not ready.
    const rule = DEFAULT_RULES.find((r) => r.job === job) ?? DEFAULT_RULES[DEFAULT_RULES.length - 1];
    const ready = new Map<string, string>();
    for (const p of named ? [named] : [rule.provider, ...rule.fallback]) {
      if (!this.#usable(p) && WORKSPACE_MODE[baseAgent(p)]) ready.set(p, await this.#agentProblem(p));
    }
    const picked = pickProvider(job, (p) => this.#usable(p) || (named ? '' : ready.get(p) ?? ''), claudeHelpers(this.ctx.stateDir), named, model);
    if ('error' in picked) throw new Refusal('provider_unavailable', picked.error);
    const notReady = named ? ready.get(named) ?? '' : '';
    if (notReady) throw new Refusal('provider_unavailable', notReady);
    const down = await this.#serverDown(picked.provider); // never a helper that waits on a server that does not answer
    if (down) throw new Refusal('provider_unavailable', down);
    const mode = workspaceModeOf(picked.provider);
    const entryLabel = isServerEntry(picked.provider) ? this.#entryLabel(picked.provider) : '';
    const id = newHelperId();
    const record: Helper = {
      id,
      title,
      project,
      parent: { live: s(caller.id), lasting: lasting(caller) },
      chat: { live: '', lasting: '', provider: picked.provider, model: picked.model, mode, ...(entryLabel ? { label: entryLabel } : {}) },
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
    // `mode` is the preferred id; `modeAnyOf` is the whole list: the connection takes the first one the agent offers, never a broader one
    const picks: Json = { mode, modeAnyOf: [...workspaceModesOf(picked.provider)], ...(picked.model ? { model: picked.model } : {}) };
    const [code, payload] = await this.ctx.host.liveCall('connect', {
      provider: picked.provider,
      cwd: project,
      background: true,
      picks,
      helperOf: { helperId: id, parent: s(caller.id) },
    });
    if (code !== 200 || !isDict(payload) || !s(payload.id)) {
      const reason = isDict(payload) ? s(payload.error) : 'it did not start';
      await this.#fail(id, `${entryLabel || providerName(picked.provider)} didn't start: ${reason}`);
      throw new Refusal(/worktree/i.test(reason) ? 'no_worktree' : 'provider_unavailable', `Could not start the helper: ${reason}`);
    }
    await this.registry.patch(id, { chat: { ...record.chat, live: s(payload.id) } });
    const pickedText = picked.picked_by === 'rule' ? `rule: ${picked.rule}` : `picked by the main agent: “${why}”`;
    await this.note(
      id,
      'swarm-start',
      `Started helper “${title}” · ${entryLabel || providerName(picked.provider)}${picked.model ? ` · ${picked.model}` : ''} · ${pickedText}`,
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
          return await this.#fail(id, `${chatName(h)} isn't signed in`);
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
        const offered = Array.isArray(modePick?.offered) ? (modePick.offered as unknown[]).map(String) : [];
        const said = offered.length ? `it offers: ${offered.join(', ')}` : s(modePick?.message) || 'it offers no modes';
        return await this.#fail(
          id,
          `Could not set ${chatName(h)}'s edit-in-workspace mode (wanted ${workspaceModesOf(h.chat.provider).join(' or ')}; ${said})`,
        );
      }
      const usedMode = s(modePick.value) || h.chat.mode; // the id the agent actually took (an older adapter names it differently)
      const worktree = {
        path: s(record.path),
        branch: s(record.branch),
        base: s(record.base),
        start: s(record.snapshot),
        ...(s(record.landOn) ? { landOn: s(record.landOn) } : {}), // a folder chat's helper (build plan 2.4)
      };
      await this.registry.patch(id, { chat: { ...h.chat, mode: usedMode, lasting: lasting(state) }, worktree, cursor: Number(state.cursor) || 0 });
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
    const h = await this.registry.patch(id, { state: 'failed', reason, endedAt: Date.now() / 1000 });
    if (!h) return;
    await this.note(id, 'swarm-fail', `Helper “${h.title}” (${chatName(h)}) failed: ${reason}`);
    // The helper never got to run, so its chat says nothing of its own: the failure is announced here, once, as a failed chat is.
    this.#announce({ fk: `helper-failed|${id}`, parent: h.parent.live, parentLasting: h.parent.lasting, title: helperTitle(h), kind: 'needs', reason: 'failed', what: reason });
  }

  #announce(news: HelperNews): void {
    try {
      this.ctx.announce?.(news);
    } catch (error) {
      log.exception(error, 'Announcing helper news failed');
    }
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
      await this.registry.patch(h.id, { state: 'stopped', reason: reason || 'stopped by the main agent', endedAt: Date.now() / 1000 });
      stopped.push(h.id);
      kept.push({ id: h.id, branch: h.worktree.branch, commits });
      await this.note(
        h.id,
        'swarm-stop',
        `Stopped “${h.title}” (${chatName(h)}). Work kept: ${commits} commit(s) on ${h.worktree.branch || 'its branch'}.`,
      );
    }
    return { stopped, kept };
  }

  /** Commit what is uncommitted in the helper's worktree; returns how many commits its branch has over its start. */
  async #keepWork(h: Helper, message: string, settle = true): Promise<number> {
    if (!h.worktree.path) return 0;
    try {
      if (settle) await new Promise((r) => setTimeout(r, 300)); // the cancelled turn's last writes
      if ((await merge.porcelainPaths(h.worktree.path)).size) {
        await wt.git(['add', '-A'], h.worktree.path);
        await wt.unstageLineEndingOnly(h.worktree.path, 'HEAD'); // line-ending churn is not the helper's work
        const staged = await wt.git(['diff', '--cached', '--name-only'], h.worktree.path, { check: false });
        if (staged.stdout.trim()) await merge.gitc(['commit', '-q', '-m', message], h.worktree.path, { check: false });
      }
      const count = await wt.git(['rev-list', '--count', `${h.worktree.start}..HEAD`], h.worktree.path, { check: false });
      return Number(count.stdout.trim()) || 0;
    } catch (error) {
      log.exception(error, 'Keeping the work of helper %s failed', h.id);
      return 0;
    }
  }

  /**
   * merge_helper: the helper's work lands through Merge (busy check, conflicts prompted to the helper), on the parent's behalf. A helper
   * of a chat that works in the project folder (build plan 2b) is queued instead: it lands when the parent's turn has ended and the
   * parent is idle, under the host's landing lock, on the folder's branch, with no stash.
   */
  async mergeHelper(caller: Json, id: string): Promise<Json> {
    const h = this.#mine(caller, id);
    const keptScratch = h.kind === 'subagent' && !!h.sub?.kept?.length; // its scratch files stayed in its worktree: they land now
    if (h.merge && !h.merge.undo && !keptScratch) throw new Refusal('merged', `“${h.title}” is already merged`);
    if (h.kind === 'subagent') { // design 3.5: a retry after a refusal, or a stopped subagent's work the main agent wants landed
      if (h.reason === 'protected') {
        throw new Refusal('protected', `Subagent “${h.title}” changed protected files; only the user can land its work`);
      }
      const rec = readSubagents(this.ctx.stateDir)[h.sub?.record ?? ''];
      if (!rec) throw new Refusal('gone', `Subagent “${h.title}” has no worktree any more; nothing to land`);
      if (rec.state !== 'done' && rec.state !== 'stopped') throw new Refusal('busy', `Subagent “${h.title}” is still running`);
      await this.registry.update(id, (cur) => (cur ? { ...cur, state: 'done', reason: '', sub: { ...cur.sub!, landScratch: true } } : null));
      await this.#queue(this.registry.get(id)!, 'merge', 'tool');
      return { ok: true, state: 'queued', message: queuedLine(this.registry.get(id)!) };
    }
    if (h.state === 'discarded') throw new Refusal('gone', `“${h.title}” was discarded: its worktree and branch are gone; nothing to merge`);
    if (!['done', 'waiting', 'stopped'].includes(h.state)) {
      throw new Refusal('busy', `“${h.title}” is ${h.state}; merge it once its report is in`);
    }
    // A closed helper chat is merged from its recorded worktree and branch (#landByRecord), as a subagent is; only a worktree that is
    // gone leaves nothing to land.
    if (!(await this.#chatOpen(h)) && !(h.worktree.path && wt.lexists(h.worktree.path))) {
      throw new Refusal('gone', `“${h.title}” has no open chat and its worktree is gone; nothing to land`);
    }
    if (folderParent(h)) {
      await this.#queue(h, 'merge', 'tool');
      return { ok: true, state: 'queued', message: queuedLine(h) };
    }
    await this.#patchLanding(id, { ...newLanding('merge', 'tool', this.clock()), stage: 'landing' }); // the journal (SF 3)
    this.#working.add(id);
    try {
      return await this.#landMerge(h, []);
    } finally {
      this.#working.delete(id);
      await this.registry.update(id, (cur) => (cur ? { ...cur, landing: null } : null));
      await this.#cleanup(id); // a closed helper's copy goes at once; an open chat's when it is closed (the sweep)
    }
  }

  /** Where a helper lands: its folder branch (landOn), else the project's main branch (build plan 2.4, MF 7). */
  async #target(h: Helper): Promise<string> {
    if (h.worktree.landOn) return h.worktree.landOn;
    return await merge.targetBranch(h.project, h.worktree.base || 'main', wt.recordForPath(this.ctx.stateDir, h.worktree.path));
  }

  /** True when the helper's chat is open here; a closed one is landed from its recorded worktree (#landByRecord). */
  async #chatOpen(h: Helper): Promise<boolean> {
    if (!h.chat.live) return false;
    const state = obj(await this.ctx.host.liveState(h.chat.live, 0).catch(() => null));
    return !!state.id && !state.closed;
  }

  /**
   * The merge itself: the tool's answer ({state: merged | conflicts | refused, ...}); posts the merge line when it landed.
   * Bug fix (owner 2026-11-23): `tipBefore` is the tip the landing built on, read UNDER the repository lock and told by the journal,
   * never read before Merge takes the lock (another merge landing in between made Undo take that one back too).
   */
  async #landMerge(h: Helper, held: string[]): Promise<Json> {
    if (h.kind === 'subagent') return await this.#landSubagent(h, held);
    const id = h.id;
    const target = await this.#target(h);
    if (!(await this.#chatOpen(h))) return await this.#landByRecord(h, held, target);
    let lockedTip = '';
    let result: Json;
    try {
      result = await merge.merge(this.#mergeStudio(), h.chat.live, h.title, false, { // fromTool=false: the helper must be idle
        held,
        journal: (stage, data) => {
          if (typeof data.tipBefore === 'string' && data.tipBefore) lockedTip = data.tipBefore;
          return this.#patchLanding(id, {
            stage: stage as 'stashed' | 'built' | 'moved',
            ...(typeof data.stashSha === 'string' ? { stashSha: data.stashSha, stashName: s(data.stashName), stashFolder: s(data.folder) } : {}),
            ...(typeof data.landed === 'string' ? { landed: data.landed, tipBefore: s(data.tipBefore) } : {}),
          });
        },
      });
    } catch (error) {
      if (error instanceof merge.Refused) {
        if (error.code === 'empty' && h.brief.read_only) return await this.#readOnlyDone(h, target);
        const files = error instanceof merge.TouchedDirty ? error.files : undefined;
        return { state: 'refused', code: error.code, message: error.message, ...(files ? { files } : {}) };
      }
      throw error;
    }
    if (result.state === 'conflicts') {
      return {
        state: 'conflicts',
        files: result.files,
        target,
        message: 'Nothing landed. The helper was asked to resolve the conflicts in its worktree; merge again when it reports.',
      };
    }
    const landed = s(result.tip);
    const commits = Number(result.commits) || 0;
    return await this.#merged(h, target, lockedTip || (await this.#parentOf(h.project, landed, commits)), landed, commits);
  }

  /** A read-only helper with nothing to land: merged, report only. */
  async #readOnlyDone(h: Helper, target: string): Promise<Json> {
    await this.registry.patch(h.id, { state: 'merged' });
    await this.note(h.id, 'swarm-merge', `Merged “${h.title}” (${chatName(h)}) into ${target} · nothing to land (read-only helper, report only)`);
    return { state: 'merged', commits: 0, files: [], target };
  }

  /** The tip a landing of `commits` commits was built on (the commits are consecutive): only when the journal did not tell it. */
  async #parentOf(project: string, landed: string, commits: number): Promise<string> {
    if (!landed) return '';
    return await merge.rev(project, `${landed}~${Math.max(1, commits)}`);
  }

  /** A landing is done: the record (with the helper's branch tip, for the cleanup), the line with Undo, and the tool's answer. */
  async #merged(h: Helper, target: string, tipBefore: string, landed: string, commits: number): Promise<Json> {
    const branchTip = h.worktree.path && wt.lexists(h.worktree.path) ? await merge.rev(h.worktree.path, 'HEAD').catch(() => '') : '';
    await this.registry.patch(h.id, {
      state: 'merged',
      merge: { tipBefore, landed, commits, at: this.clock() / 1000, ...(branchTip ? { branchTip } : {}), undo: null, again: null },
    });
    await this.note(
      h.id,
      'swarm-merge',
      `Merged “${h.title}” (${chatName(h)}) into ${target} · ${commits} commit${commits === 1 ? '' : 's'}`,
      ['swarm-undo'],
    );
    const files = tipBefore && landed ? await changedFiles(h.project, tipBefore, landed) : [];
    return { state: 'merged', commits, range: [tipBefore, landed], target, files };
  }

  /**
   * "Merge by worktree record" (owner 2026-11-23): the helper's chat is closed, so Merge (which works through the chat) can't run. The
   * helper's work lands from its recorded worktree and branch the way a subagent's does (landSubagentWork: a snapshot of the worktree,
   * its own changes only, the folder's uncommitted-edit check, no stash). Uncommitted work is committed on its branch first; every
   * file lands (scratch and ignored files too: a helper's job is the files it was given). A conflict leaves a clean `-landable`
   * branch of only the helper's changes for the main agent to merge by hand.
   */
  async #landByRecord(h: Helper, held: string[], target: string): Promise<Json> {
    const path = h.worktree.path;
    if (!path || !wt.lexists(path)) return { state: 'refused', code: 'gone', message: 'its worktree is gone' };
    await this.#keepWork(h, 'AIB: helper work kept', false);
    let lockedTip = '';
    const out = await landSubagentWork(this.#mergeStudio(), {
      scratchDir: this.ctx.stateDir,
      path,
      folder: h.project,
      target,
      branch: h.worktree.branch,
      parent: held[0] ?? h.parent.live,
      key: `helper:${h.id}`,
      title: h.title,
      start: h.worktree.start,
      held,
      landKept: null,
      landScratch: true,
    }, async (stage, data) => {
      if (typeof data.tipBefore === 'string' && data.tipBefore) lockedTip = data.tipBefore;
      await this.#patchLanding(h.id, {
        stage: stage as 'built' | 'moved',
        ...(typeof data.landed === 'string' ? { landed: data.landed, tipBefore: s(data.tipBefore) } : {}),
      });
    });
    const state = s(out.state);
    if (state === 'merged') {
      const landed = s(out.landed);
      const counted = Number((await wt.git(['rev-list', '--count', `${h.worktree.start}..HEAD`], path, { check: false })).stdout.trim()) || 0;
      return await this.#merged(h, target, lockedTip || s(out.tipBefore), landed, Math.max(1, counted));
    }
    if (state === 'empty' || state === 'scratch') {
      if (h.brief.read_only) return await this.#readOnlyDone(h, target);
      return { state: 'refused', code: 'empty', message: `Nothing to merge into ${target}: the helper's work is already there or has no changes` };
    }
    if (state === 'conflicts') {
      const landable = s(out.landable);
      return {
        state: 'conflicts',
        files: out.files,
        target,
        ...(landable ? { landable } : {}),
        message: `Nothing landed: the helper's chat is closed and its work conflicts with ${target}. ` +
          (landable
            ? `Merge the branch ${landable} into ${target} by hand and resolve the conflicts; it holds only the helper's own changes.`
            : `Its work is on branch ${h.worktree.branch}; merge it by hand.`),
      };
    }
    return { state: 'refused', code: s(out.code) || 'refused', message: s(out.message), ...(Array.isArray(out.files) ? { files: out.files } : {}) };
  }


  // ---- the landing queue (build plan 2.2) --------------------------------------------------------------------------------------
  async #patchLanding(id: string, fields: Partial<Landing>): Promise<void> {
    await this.registry.update(id, (cur) => (cur ? { ...cur, landing: { ...(cur.landing ?? newLanding('merge', 'tool', this.clock())), ...fields } } : null));
  }

  /** Queue a landing (or wake one that waited for the files to be committed). A landing that runs now is left alone. */
  async #queue(h: Helper, what: Landing['what'], by: Landing['by']): Promise<void> {
    await this.registry.update(h.id, (cur) => {
      if (!cur) return null;
      const now = cur.landing;
      if (now && now.stage !== 'queued') return cur;
      if (now && now.what === what) return { ...cur, landing: { ...now, waitsFor: '', by } };
      return { ...cur, landing: newLanding(what, by, this.clock()) };
    });
  }

  /**
   * One look at a queued landing from the poll: the 10-minute line, then (unless it waits for the user's files) one try to hold the
   * parent's landing lock. A parent that is not idle refuses the lock and nothing happens: it is tried again at the next poll.
   */
  async #landingStep(h: Helper, parentId: string): Promise<void> {
    const L = h.landing;
    if (!L || L.stage !== 'queued') return;
    if (!L.toldWait && this.clock() / 1000 - L.queuedAt > LANDING_WAIT_NOTE_S) {
      await this.#patchLanding(h.id, { toldWait: true });
      await this.note(h.id, 'swarm-merge', `Still waiting for this chat to pause to land “${h.title}”.`);
    }
    if (L.waitsFor) return;
    if (h.kind === 'subagent') { // a subagent continued in a later turn runs again: it lands at its next end
      const rec = readSubagents(this.ctx.stateDir)[h.sub?.record ?? ''];
      if (rec && rec.state !== 'done' && rec.state !== 'stopped') return;
      // P3: queued as done, then the stream said it was killed (TaskStop; its SubagentStop came first): stopped, never landed by
      // itself. A merge_helper after the stop queues it again later than the stop, and lands it.
      if (rec && rec.state === 'stopped' && (rec.stoppedAt ?? 0) >= L.queuedAt) {
        await this.registry.update(h.id, (cur) => (cur ? { ...cur, landing: null, state: 'stopped', reason: rec.stoppedWhy ?? '' } : null));
        await this.#toldStopped(h.id, h.title, rec, parentId);
        return;
      }
    }
    await this.#runLanding(h, parentId);
  }

  /** Hold the parent's lock, land, let go, then tell the parent. null when the parent was not idle (it stays queued). */
  async #runLanding(h: Helper, parentId: string): Promise<Json | null> {
    const L = h.landing!;
    const lockId = newLockId();
    const got = await lockChats(this.#mergeStudio(), [parentId], h.title, `swarm:${h.id}`, lockId);
    if (!got.held) return null;
    this.#working.add(h.id);
    let out: Json;
    try {
      await this.#patchLanding(h.id, { stage: 'landing', lockId });
      try {
        out = L.what === 'merge' ? await this.#landMerge(h, [parentId]) : await this.#applyUndo(h, L.what, [parentId]);
      } catch (error) {
        log.exception(error, 'Landing helper %s failed', h.id);
        out = { state: 'refused', code: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      await got.held.release();
      this.#working.delete(h.id);
    }
    await this.#afterLanding(h.id, L.what, out, parentId);
    await this.#cleanup(h.id);
    return out;
  }

  /** What a landing did, told: the queue entry cleared or kept, the line in the chat, and the parent's next-prompt line (2.5, 2.6). */
  async #afterLanding(id: string, what: Landing['what'], out: Json, parentId: string): Promise<void> {
    const h = this.registry.get(id);
    if (!h) return;
    if (h.kind === 'subagent' && what === 'merge') return await this.#afterSubagent(h, out, parentId);
    const name = label(h);
    const files = Array.isArray(out.files) ? out.files.map(String) : [];
    const state = s(out.state);
    const context = (line: string) => this.ctx.host.liveCall('prompt-context', { id: parentId, line }).catch(() => [500, null]);
    const clear = () => this.registry.update(id, (cur) => (cur ? { ...cur, landing: null } : null));
    if (state === 'merged' || state === 'undone') {
      await clear();
      const did = what === 'undo' ? `the merge of helper ${name} was undone` : what === 'again' ? `helper ${name} was merged again` : '';
      const line = what === 'merge'
        ? `While you were idle, helper ${name} landed ${Number(out.commits) || 0} commit${Number(out.commits) === 1 ? '' : 's'} in this ` +
          `folder (files: ${shown(files) || 'none'}). Re-read those files before editing them.`
        : `While you were idle, ${did} in this folder (files: ${shown(files) || 'none'}). Re-read those files before editing them.`;
      await context(line);
      return;
    }
    if (state === 'dirty' || out.code === 'touched_dirty') {
      await this.#patchLanding(id, { stage: 'queued', lockId: '', waitsFor: 'touched-dirty', lastRefusal: 'touched-dirty' });
      const verb = what === 'merge' ? 'land' : what === 'undo' ? 'undo' : 'merge again';
      await this.note(id, 'swarm-merge', `Didn't ${verb} “${h.title}”: it changes files with uncommitted edits (${shown(files.map(baseName))}).`);
      if (what === 'merge') {
        await context(
          `Helper ${name} changes files you have uncommitted (${shown(files)}). Commit them or set them aside, then call merge_helper again.`,
        );
      }
      return;
    }
    if (state === 'refused' && RETRY_CODES.has(s(out.code))) {
      const tries = (h.landing?.tries ?? 0) + 1;
      const tell = tries >= LANDING_TRIES_NOTE && !h.landing?.toldTries;
      await this.#patchLanding(id, { stage: 'queued', lockId: '', tries, lastRefusal: s(out.message), ...(tell ? { toldTries: true } : {}) });
      if (tell) {
        await this.note(
          id,
          'swarm-merge',
          `Couldn't land “${h.title}” yet: ${lower(s(out.message))}. It will try again when the chat is next idle.`,
        );
      }
      return;
    }
    await clear(); // done for good: conflicts (the helper was asked), can't undo cleanly, or a refusal that a retry won't change
    if (state === 'conflicts') {
      const line = `Helper ${name} didn't land: it conflicts with ${s(out.target) || 'the folder branch'} in ${shown(files)}. ` +
        'The helper was asked to resolve them; call merge_helper again after its next report.';
      await this.note(id, 'swarm-merge', `Didn't land “${h.title}”: it conflicts in ${shown(files.map(baseName))}. The helper was asked to resolve it.`);
      await context(line);
    } else if (state === 'refused') {
      await this.note(id, 'swarm-merge', `Couldn't land “${h.title}”: ${lower(s(out.message))}.`);
      if (what === 'merge') await context(`Helper ${name} did not land: ${lower(s(out.message))}.`);
    }
  }

  /**
   * SF 3: a landing found mid-stage that nothing in this process runs (the web process died during it). The lock is let go; a landing
   * whose branch already moved is finished, any other is rolled back: a folder chat's helper goes back in the queue (nothing was
   * stashed, and the fast-forward is all or nothing), a copy parent's stash is put back (or, if that clashes, named in the chat).
   */
  async #recover(h: Helper, parentLive: string): Promise<void> {
    const L = h.landing!;
    this.#working.add(h.id);
    try {
      if (L.lockId && parentLive) await this.ctx.host.liveCall('landing-release', { id: parentLive, lock: L.lockId }).catch(() => {});
      if (L.stashSha && L.stashFolder) await this.#putBackStash(h, L);
      const target = await this.#target(h).catch(() => '');
      const tip = target ? await merge.rev(h.project, `refs/heads/${target}`) : '';
      const landed = L.what === 'merge' && L.landed && tip && (await merge.isAncestor(h.project, L.landed, tip));
      if (landed) {
        const commits = Number((await wt.git(['rev-list', '--count', `${L.tipBefore}..${L.landed}`], h.project, { check: false })).stdout.trim()) || 1;
        await this.registry.update(h.id, (cur) =>
          cur
            ? { ...cur, state: 'merged', landing: null, merge: { tipBefore: L.tipBefore, landed: L.landed, commits, at: this.clock() / 1000, undo: null, again: null } }
            : null
        );
        const files = await changedFiles(h.project, L.tipBefore, L.landed);
        await this.note(
          h.id,
          'swarm-merge',
          h.kind === 'subagent'
            ? `Merged subagent “${h.title}” into ${target} · ${files.length} file${files.length === 1 ? '' : 's'} · finished after a restart`
            : `Merged “${h.title}” (${chatName(h)}) into ${target} · ${commits} commit${commits === 1 ? '' : 's'} · finished after a restart`,
          ['swarm-undo'],
        );
        if (folderParent(h) && parentLive) {
          await this.ctx.host.liveCall('prompt-context', {
            id: parentLive,
            line: `While you were idle, ${h.kind === 'subagent' ? 'your ' : 'helper '}${label(h)} landed ${commits} commit${commits === 1 ? '' : 's'} ` +
              `in this folder (files: ${shown(files) || 'none'}). Re-read those files before editing them.`,
          }).catch(() => {});
        }
        if (h.kind === 'subagent') await this.#release(h);
        return;
      }
      if (folderParent(h)) {
        await this.#patchLanding(h.id, { stage: 'queued', lockId: '', stashSha: '', landed: '', tipBefore: '' }); // tried again when idle
      } else {
        await this.registry.update(h.id, (cur) => (cur ? { ...cur, landing: null } : null));
        await this.note(h.id, 'swarm-merge', `Merging “${h.title}” was cut off when AIB stopped; nothing landed. Merge it again.`);
      }
    } finally {
      this.#working.delete(h.id);
    }
  }

  async #putBackStash(h: Helper, L: Landing): Promise<void> {
    const listed = (await wt.git(['stash', 'list', '--format=%H %gd'], L.stashFolder, { check: false })).stdout.split(/\r?\n/);
    const entry = listed.map((line) => line.split(' ')).find(([sha]) => sha === L.stashSha);
    if (!entry) return; // put back before the stop
    const back = await wt.git(['stash', 'apply', '--index', L.stashSha], L.stashFolder, { check: false });
    if (back.returncode === 0) {
      await wt.git(['stash', 'drop', entry[1]], L.stashFolder, { check: false });
      await this.note(h.id, 'swarm-merge', `AIB stopped while landing “${h.title}”. Your uncommitted edits were set aside then and are back now.`);
    } else {
      await this.note(
        h.id,
        'swarm-merge',
        `AIB stopped while landing “${h.title}”. Your uncommitted edits are kept in the stash “${L.stashName}” (${L.stashSha.slice(0, 8)}); nothing was lost.`,
      );
    }
    await this.#patchLanding(h.id, { stashSha: '', stashName: '', stashFolder: '' });
  }

  #mergeStudio(): merge.MergeStudio {
    return merge.liveMergeStudio(this.ctx.stateDir, this.ctx.host);
  }

  // ---- the page's Undo and Merge again (page token only; never the agent's key: review break 14) -------------------------------
  async undo(id: unknown): Promise<Reply> {
    const h = typeof id === 'string' ? this.registry.get(id) : null;
    if (!h || !h.merge) return [404, { error: 'That helper has no merge to undo' }];
    if (h.merge.undo && !h.merge.again) return [409, { error: 'Already undone' }];
    return await this.#pageAction(h, 'undo');
  }

  async mergeAgain(id: unknown): Promise<Reply> {
    const h = typeof id === 'string' ? this.registry.get(id) : null;
    if (!h || !h.merge?.undo) return [404, { error: 'That helper has no undone merge' }];
    return await this.#pageAction(h, 'again');
  }

  /**
   * Undo / Merge again from the page. A folder chat's helper (build plan 2.2, MF 8): at once when the parent is idle, else queued
   * until it is (the button says so); never a stash. A copy parent's: at once, as before, but it waits for any chat that works in
   * the project folder (2.3).
   */
  async #pageAction(h: Helper, what: 'undo' | 'again'): Promise<Reply> {
    let out: Json;
    if (folderParent(h)) {
      if (!h.parent.live) return [409, { error: 'Open the main chat first' }];
      await this.#queue(h, what, 'page');
      const fresh = this.registry.get(h.id)!;
      if (fresh.landing?.stage !== 'queued' || fresh.landing.what !== what) return [409, { error: 'Another landing of this helper runs now' }];
      const ran = await this.#runLanding(fresh, h.parent.live);
      if (!ran) return [200, { state: 'queued', message: 'Waits for this chat to pause' }];
      out = ran;
    } else {
      out = await this.#applyUndo(h, what, []);
    }
    const state = s(out.state);
    if (state === 'refused') return [409, { error: s(out.message), code: s(out.code) }];
    return [200, out];
  }

  /** Undo or Merge again itself: {state: undone | merged | cannot_undo | cannot_merge | dirty | refused, ...}; posts its line. */
  async #applyUndo(h: Helper, what: 'undo' | 'again', held: string[]): Promise<Json> {
    if (!h.merge) return { state: 'refused', code: 'gone', message: 'That helper has no merge' };
    const target = await this.#target(h);
    const options = { noStash: folderParent(h), host: this.#mergeStudio(), held, title: h.title };
    if (what === 'undo') {
      if (h.merge.undo && !h.merge.again) return { state: 'refused', code: 'done', message: 'Already undone' };
      const done = await applyChange(
        this.ctx.stateDir,
        h.project,
        target,
        h.merge.again ? h.merge.again.commit : h.merge.landed,
        h.merge.again ? `${h.merge.again.commit}^` : h.merge.tipBefore,
        `AIB: undo the merge of ${h.kind === 'subagent' ? '' : 'helper '}${label(h)}`,
        options,
      );
      if (done.state === 'conflicts') {
        const files = done.files.length ? done.files : await changedFiles(h.project, h.merge.tipBefore, h.merge.landed);
        await this.note(
          h.id,
          'swarm-undo',
          `Can't undo “${h.title}” cleanly: later changes touch the same lines (${files.slice(0, 6).join(', ')}). Nothing changed.`,
        );
        return { state: 'cannot_undo', files };
      }
      if (done.state === 'refused') return { state: 'refused', code: done.code ?? 'refused', message: done.message };
      if (done.state === 'dirty') return { state: 'dirty', files: done.files };
      // a helper whose worktree and branch were cleaned up after the merge has nothing left to merge again by merge_helper: Merge again
      // (the button) still re-applies the commit, so it is not counted as a running or waiting helper
      const cleaned = h.kind !== 'subagent' && !!h.cleanedAt;
      await this.registry.patch(h.id, {
        state: cleaned ? 'discarded' : 'done',
        merge: { ...h.merge, undo: { revert: done.commit, at: this.clock() / 1000 }, again: null },
      });
      await this.note(
        h.id,
        'swarm-undo',
        `Undid the merge of ${label(h)} · ${target} is back to before it` +
          (h.kind === 'subagent' ? '' : cleaned ? ` · the helper's copy was already cleaned up` : ` · the helper's branch is kept`) +
          (done.kept ? ` · your edits clash with it and are kept in a stash` : ''),
        ['swarm-merge-again'],
      );
      return { state: 'undone', commit: done.commit, files: done.files };
    }
    if (!h.merge.undo) return { state: 'refused', code: 'done', message: 'That helper has no undone merge' };
    const revert = h.merge.undo.revert;
    const done = await applyChange(this.ctx.stateDir, h.project, target, revert, `${revert}^`, `AIB: merge ${h.kind === 'subagent' ? label(h) : `helper “${h.title}”`} again`, options);
    if (done.state === 'conflicts') {
      // Bug fix (owner 2026-11-23): this used to say nothing and the button stayed disabled. A line in the chat, the main agent woken the
      // way a failed landing wakes it, and the page (chat.js) re-enables the button.
      const files = done.files;
      const n = files.length;
      await this.note(
        h.id,
        'swarm-merge',
        `Couldn't merge ${label(h)} again: conflict in ${n} file${n === 1 ? '' : 's'} (${shown(files, 3)}). Nothing changed. ` +
          `Later changes to ${target} touch the same lines.`,
      );
      const own = h.worktree.branch ? `its branch ${h.worktree.branch} (${h.merge.landed ? `merged as ${h.merge.landed.slice(0, 8)}` : 'merged earlier'})` : 'its merged commit';
      await this.#wakeParent(
        h,
        held[0] || h.parent.live,
        'again-conflict',
        `The user asked to merge ${label(h)} again after undoing it, but it conflicts with ${target} in ${shown(files)}. Nothing changed ` +
          `and AIB does not retry it. If the user wants that work back, re-apply ${own} onto ${target} by hand, resolving the conflicts ` +
          'so both sides keep what they intended. Tell the user.',
      );
      return { state: 'cannot_merge', files };
    }
    if (done.state === 'refused') return { state: 'refused', code: done.code ?? 'refused', message: done.message };
    if (done.state === 'dirty') return { state: 'dirty', files: done.files };
    await this.registry.patch(h.id, {
      state: 'merged',
      merge: { ...h.merge, undo: null, again: { commit: done.commit, at: this.clock() / 1000 } },
    });
    await this.note(h.id, 'swarm-merge', `Merged ${label(h)} into ${target} again`, ['swarm-undo']);
    return { state: 'merged', commit: done.commit, files: done.files };
  }

  // ---- subagent landings (subagent worktrees P2) -----------------------------------------------------------------------------
  /**
   * The Studio's subagent records (subagent-worktrees.json, its file: this side only reads it) joined to the landing queue. An ended
   * record (done: its SubagentStop came; stopped: the user stopped the turn, the main agent stopped it, its Agent call failed) of an
   * open parent gets one entry here, keyed by the record's id, the first time it is seen: a done one queued to land (it lands when the
   * parent is idle, under its landing lock), a stopped one only told (never landed by itself). Runs at every poll, so at start too,
   * and it is idempotent. A landing refused for touched-dirty files is tried again at the parent's next turn end (design 3.5).
   */
  async #reconcileSubagents(subs: SubagentRecord[], chats: Json[], byLasting: Map<string, Json>): Promise<void> {
    for (const rec of subs) {
      const parent = chats.find((c) => c.id === rec.chat) ?? (rec.lasting ? byLasting.get(rec.lasting) : undefined);
      if (!parent) { // its chat is not open here: it waits (keeper-held chats are listed once taken over); one with no changes goes
        await this.#dropEmptyOrphan(rec).catch((error) => log.exception(error, 'Removing empty subagent %s failed', rec.id));
        continue;
      }
      const ended = s(obj(parent.attention).turnEndedAt);
      const h = this.registry.get(rec.id);
      if (h) {
        if (h.landing?.waitsFor === 'touched-dirty' && h.landing.stage === 'queued' && ended && ended !== h.sub?.turn) {
          await this.registry.update(h.id, (cur) =>
            cur?.landing ? { ...cur, landing: { ...cur.landing, waitsFor: '' }, sub: { ...cur.sub!, turn: ended } } : cur
          );
        }
        // its record's call was fixed after the entry was made (parallel Agent calls: subagents/service.ts swapCalls): its own name
        const title = titleOf(rec);
        if (h.title !== title && h.state !== 'merged' && (!h.landing || h.landing.stage === 'queued')) await this.registry.patch(h.id, { title });
        // landed, but its worktree could not go then (the agent host was busy or restarting): again now. Not while it keeps scratch files.
        if (h.state === 'merged' && !h.landing && (rec.state === 'done' || rec.state === 'stopped') && !h.sub?.kept?.length) await this.#release(h);
        // files it left that AIB did not land: kept KEPT_DAYS (the parent was told the date), then its worktree goes
        if (h.sub?.kept?.length && !h.landing && (this.clock() / 1000 - (h.sub.keptAt ?? h.createdAt)) > KEPT_DAYS * 86400) {
          log.info('swarm: subagent %s kept files for %d days; removing its worktree', h.id, KEPT_DAYS);
          await this.registry.update(h.id, (cur) => (cur ? { ...cur, sub: { ...cur.sub!, kept: [] } } : null));
          await this.#release(h);
        }
        continue;
      }
      if (rec.state !== 'done' && rec.state !== 'stopped') continue;
      // a user-hook worktree is judged once its parent is idle: its PostToolUse hook (which makes it done) runs before the parent's
      // ACP stream reports the Agent call's end (acpSeen), so judging it on first sight refused every one (P3)
      if (rec.userHook && rec.state === 'done' && rec.adopted?.verified && !rec.acpSeen && obj(parent.attention).state !== 'idle') continue;
      try {
        await this.#adoptSubagent(rec, parent, ended);
      } catch (error) {
        log.exception(error, 'Taking up subagent %s for landing failed', rec.id);
      }
    }
  }

  /**
   * A finished subagent whose parent is not open here (closed, or a leftover from before an update) and that changed nothing: nothing
   * would ever land, so its worktree, branch and record go without waiting for the parent (nothing in the parent's folder changes, so
   * no landing lock is needed). Only one that finished ORPHAN_EMPTY_S ago (a keeper-held parent may still continue it while AIB is
   * away), AIB's own worktree (never the user's hook's), and only when git says it is exactly its snapshot S, untracked files included.
   */
  async #dropEmptyOrphan(rec: SubagentRecord): Promise<void> {
    if (rec.state !== 'done' || rec.userHook || !rec.snapshot || !rec.branch) return;
    if (this.clock() / 1000 - (rec.doneAt ?? rec.createdAt) < ORPHAN_EMPTY_S) return;
    const h = this.registry.get(rec.id);
    if (h && (this.#working.has(rec.id) || (h.landing && h.landing.stage !== 'queued'))) return;
    if (!(await subagentUnchanged(rec))) return;
    log.info('swarm: subagent %s (%s) finished with no changes and its chat is not open; removing its worktree', rec.id, rec.branch);
    if (h) {
      await this.registry.update(rec.id, (cur) => (cur ? { ...cur, landing: null, state: 'merged', sub: { ...cur.sub!, empty: true, files: 0 } } : null));
    }
    await this.#release(h ?? ({ id: rec.id, sub: { record: rec.id } } as unknown as Helper));
  }

  async #adoptSubagent(rec: SubagentRecord, parent: Json, ended: string): Promise<void> {
    const title = titleOf(rec);
    const userHook = !!rec.userHook;
    const path = userHook ? rec.adopted?.path ?? '' : rec.path;
    const folder = rec.folder;
    const branch = pyStr((await wt.git(['symbolic-ref', '--short', '-q', 'HEAD'], folder, { check: false })).stdout).trim();
    // a user-hook worktree started at the folder's HEAD (Claude Code's own worktrees have no uncommitted edits: P0): its branch point
    let start = rec.snapshot;
    if (userHook && path && rec.state === 'done') {
      start = pyStr((await wt.git(['merge-base', 'HEAD', pyStr((await wt.git(['rev-parse', 'HEAD'], path, { check: false })).stdout).trim()], folder, {
        check: false,
      })).stdout).trim();
    }
    const fresh: Helper = {
      id: rec.id,
      kind: 'subagent',
      sub: { record: rec.id, agentType: rec.agentType, folder, userHook, turn: ended, ...(rec.agentId ? { agentId: rec.agentId } : {}) },
      title,
      project: folder,
      parent: { live: s(parent.id), lasting: rec.lasting || lasting(parent) },
      chat: { live: '', lasting: '', provider: 'claude', model: '', mode: '' },
      brief: NO_BRIEF,
      picked_by: 'main agent',
      rule: '',
      why: '',
      worktree: { path, branch: rec.branch, base: branch, start, ...(branch ? { landOn: branch } : {}) },
      landing: null,
      state: rec.state === 'done' ? 'done' : 'stopped',
      reason: rec.stoppedWhy ?? '',
      createdAt: rec.createdAt,
      turnEndedAt: '',
      cursor: 0,
      reports: [],
      merge: null,
      notes: [],
    };
    const context = (line: string) => this.ctx.host.liveCall('prompt-context', { id: s(parent.id), line }).catch(() => [500, null]);
    const adoptable = !userHook || (rec.adopted?.verified === true && rec.acpSeen === true && (!rec.acpAgentId || rec.acpAgentId === rec.agentId));
    if (rec.state === 'done' && adoptable && branch && start && path) fresh.landing = newLanding('merge', 'tool', this.clock());
    let made = false;
    await this.registry.update(rec.id, (cur) => {
      if (cur) return cur;
      made = true;
      return fresh;
    });
    if (!made || fresh.landing) return;
    if (userHook && !adoptable) {
      await this.registry.patch(rec.id, { state: 'failed', reason: "your WorktreeCreate hook made its worktree" });
      await this.note(rec.id, 'swarm-fail', `Your WorktreeCreate hook made the worktree of subagent “${title}”; AIB doesn't merge it (${rec.stoppedWhy || 'AIB did not see its Agent call end'}).`);
      await this.#release(fresh);
      return;
    }
    if (rec.state === 'stopped') {
      await this.#toldStopped(rec.id, title, rec, s(parent.id));
      return;
    }
    await this.registry.patch(rec.id, { state: 'failed', reason: 'no branch' });
    await this.note(rec.id, 'swarm-fail', `Couldn't land subagent “${title}”: the folder isn't on a branch.`);
    await context(`Subagent “${title}” did not land: this folder isn't on a branch. Its work is kept in ${path}.`);
  }

  /** A stopped subagent: the chat's line and the main agent's next-prompt line (it lands only when the main agent asks: merge_helper). */
  async #toldStopped(id: string, title: string, rec: SubagentRecord, parentId: string): Promise<void> {
    await this.note(id, 'swarm-stop', `Subagent “${title}” was stopped before it finished (${rec.stoppedWhy || 'stopped'}). AIB didn't land its work.`);
    await this.ctx.host.liveCall('prompt-context', {
      id: parentId,
      line: `Subagent “${title}” was stopped before it finished, so AIB did not merge its work into this folder. If you want what it ` +
        `did, call merge_helper with id ${rec.id}; AIB then lands it when your turn ends.`,
    }).catch(() => [500, null]);
  }

  /**
   * One subagent landing (the parent's landing lock is held: `held`): a snapshot of its worktree (its uncommitted work included; the
   * worktree is not touched), the protected-path check (design 2.4), then merge.ts landWorktree, the folder chats' helper landing.
   */
  async #landSubagent(h: Helper, held: string[]): Promise<Json> {
    const rec = readSubagents(this.ctx.stateDir)[h.sub?.record ?? ''];
    const path = h.worktree.path;
    if (!rec || !path) return { state: 'refused', code: 'gone', message: 'its worktree is gone' };
    const spec = {
      scratchDir: this.ctx.stateDir,
      path,
      folder: h.sub!.folder,
      target: h.worktree.landOn!,
      branch: h.worktree.branch,
      parent: held[0] ?? h.parent.live,
      key: `subagent:${h.id}`,
      title: h.title,
      start: h.worktree.start,
      held,
      // merge_helper asked for the scratch files an earlier landing left behind: only they land now
      landKept: h.sub?.landScratch && h.merge && !h.merge.undo && h.sub.kept?.length ? h.sub.kept : null,
      landScratch: !!h.sub?.landScratch,
    };
    let out: Json;
    try {
      out = await landSubagentWork(
        this.#mergeStudio(),
        spec,
        async (stage, data) => {
          await this.#patchLanding(h.id, {
            stage: stage as 'built' | 'moved',
            ...(typeof data.landed === 'string' ? { landed: data.landed, tipBefore: s(data.tipBefore) } : {}),
          });
        },
      );
    } catch (error) {
      log.exception(error, 'Landing subagent %s failed', h.id);
      throw error;
    }
    if (out.state === 'merged') {
      await this.registry.patch(h.id, {
        state: 'merged',
        merge: { tipBefore: s(out.tipBefore), landed: s(out.landed), commits: 1, at: this.clock() / 1000, undo: null, again: null },
      });
      delete out.tipBefore;
      delete out.landed;
    }
    return out;
  }

  /** A subagent landing's outcome: the line in the parent chat, the parent's next-prompt line, and its worktree removed when done. */
  async #afterSubagent(h: Helper, out: Json, parentId: string): Promise<void> {
    const files = Array.isArray(out.files) ? out.files.map(String) : [];
    const state = s(out.state);
    const context = (line: string) => this.ctx.host.liveCall('prompt-context', { id: parentId, line }).catch(() => [500, null]);
    const clear = () => this.registry.update(h.id, (cur) => (cur ? { ...cur, landing: null } : null));
    const target = h.worktree.landOn || 'the folder branch';
    const retry = swarmEnabled(this.ctx.stateDir)
      ? `then call merge_helper with id ${h.id}; AIB also tries again when your next turn ends.`
      : 'AIB tries again when your next turn ends.';
    const kept = Array.isArray(out.kept) ? out.kept.map(String) : [];
    const until = new Date(this.clock() + KEPT_DAYS * 86400_000).toISOString().slice(0, 10);
    const keptLine = (lead: string, left = kept) =>
      `${lead} left new files in its worktree ${h.worktree.path} that AIB did not merge into this folder (pages or notes it wrote at ` +
      `the top, or files git ignores): ${shown(left, 12)}. Copy them if you want them. Call merge_helper with id ${h.id} when you are ` +
      `done: it lands the ones git can track and removes the worktree. Otherwise AIB removes it on ${until} (in ${KEPT_DAYS} days).`;
    if (state === 'scratch' || (state === 'empty' && kept.length)) {
      // only scratch files (scratchFiles): nothing lands, its worktree stays with them, the main agent is told
      const left = state === 'scratch' ? files : kept;
      await this.registry.update(h.id, (cur) =>
        cur ? { ...cur, landing: null, state: 'failed', reason: 'scratch', sub: { ...cur.sub!, kept: left, keptAt: this.clock() / 1000, landScratch: false } } : null
      );
      await this.note(h.id, 'swarm-merge', `Didn't land subagent “${h.title}”: it only left new files in its worktree (${shown(left)}). They are kept there for ${KEPT_DAYS} days.`);
      await context(keptLine(`Subagent “${h.title}”`, left));
      return;
    }
    if (state === 'merged') {
      await this.registry.update(h.id, (cur) =>
        cur ? { ...cur, landing: null, sub: { ...cur.sub!, files: files.length, kept, ...(kept.length ? { keptAt: this.clock() / 1000 } : {}), landScratch: false } } : null
      );
      await this.note(
        h.id,
        'swarm-merge',
        `Merged subagent “${h.title}” into ${target} · ${files.length} file${files.length === 1 ? '' : 's'}` +
          (kept.length ? ` · ${kept.length} new file${kept.length === 1 ? '' : 's'} kept in its worktree (${shown(kept)})` : ''),
        ['swarm-undo'],
      );
      await context(
        `While you were idle, your subagent “${h.title}” landed in this folder as one commit on ${target} (files: ${shown(files) || 'none'}). ` +
          'Re-read those files before editing them.' + (kept.length ? ' ' + keptLine('It also') : ''),
      );
      if (!kept.length) await this.#release(h);
      return;
    }
    if (state === 'empty') { // no changes (line-ending churn included): its worktree goes, no line (design B4); Activity says "No changes"
      await this.registry.update(h.id, (cur) =>
        cur ? { ...cur, landing: null, state: 'merged', sub: { ...cur.sub!, empty: !cur.merge, files: cur.merge ? cur.sub!.files : 0, kept: [], landScratch: false } } : null
      );
      await this.#release(h);
      return;
    }
    if (out.code === 'touched_dirty') {
      await this.#patchLanding(h.id, { stage: 'queued', lockId: '', waitsFor: 'touched-dirty', lastRefusal: 'touched-dirty' });
      await this.note(h.id, 'swarm-merge', `Didn't land subagent “${h.title}”: it changed files with uncommitted edits (${shown(files.map(baseName))}).`);
      await context(
        `Subagent “${h.title}” changed files with uncommitted edits in this folder (${shown(files)}). Nothing landed and nothing was ` +
          `stashed. Commit those edits or set them aside, ${retry}`,
      );
      return;
    }
    if (out.code === 'protected') {
      await clear();
      await this.registry.patch(h.id, { state: 'failed', reason: 'protected' });
      await this.note(h.id, 'swarm-fail', `Didn't land subagent “${h.title}”: it changed protected files (${shown(files)}). AIB doesn't merge those by itself.`);
      await this.#wakeParent(
        h,
        parentId,
        'protected',
        `Subagent “${h.title}” changed protected files (${shown(files)}). AIB did not merge any of its work into this folder; only the ` +
          'user can land it. Tell the user.',
      );
      return;
    }
    if (state === 'refused' && RETRY_CODES.has(s(out.code))) {
      const tries = (h.landing?.tries ?? 0) + 1;
      const tell = tries >= LANDING_TRIES_NOTE && !h.landing?.toldTries;
      await this.#patchLanding(h.id, { stage: 'queued', lockId: '', tries, lastRefusal: s(out.message), ...(tell ? { toldTries: true } : {}) });
      if (tell) await this.note(h.id, 'swarm-merge', `Couldn't land subagent “${h.title}” yet: ${lower(s(out.message))}. It will try again when the chat is next idle.`);
      return;
    }
    await clear();
    if (state === 'conflicts') {
      await this.registry.patch(h.id, { state: 'failed', reason: 'conflicts' });
      await this.note(
        h.id,
        'swarm-merge',
        `Builder '${h.title}' couldn't land: conflict in ${files.length} file${files.length === 1 ? '' : 's'} (${shown(files, 3)}). The main agent is merging it by hand.`,
      );
      const landable = s(out.landable);
      const own = h.worktree.branch || "(the user hook's branch)";
      await this.#wakeParent(
        h,
        parentId,
        'conflict',
        `Builder “${h.title}” did not land: its changes conflict with ${target} in ${shown(files)}. Merge it into ${target} by hand now ` +
          'and resolve the conflicts, keeping what both sides intended; AIB does not retry it. ' +
          (landable
            ? `Merge the branch ${landable}: it holds only the builder's own changes. Do not merge ${own} (it starts with a snapshot of ` +
              "this folder's uncommitted files, which would be committed). "
            : `Its work is on branch ${own}; check what it contains before merging, because it starts with a snapshot of this folder's uncommitted files. `) +
          `Its worktree is ${h.worktree.path}. When it is merged, tell the user.`,
      );
      return;
    }
    await this.registry.patch(h.id, { state: 'failed', reason: s(out.code) });
    await this.note(h.id, 'swarm-fail', `Couldn't land subagent “${h.title}”: ${lower(s(out.message))}.`);
    await this.#wakeParent(h, parentId, 'failed', `Subagent “${h.title}” did not land: ${lower(s(out.message))}.`);
  }

  /**
   * A landing that failed wakes the chat that started the builder, as a finished builder's report does (#deliverReports): through the
   * steer lane (an idle chat takes it as its next prompt), into its paused queue after the user pressed Stop. When that is refused
   * (the chat is closed) the text is held as a next-prompt line instead, so it is never lost.
   */
  async #wakeParent(h: Helper, parentId: string, kind: string, text: string): Promise<void> {
    const state = obj(await this.ctx.host.liveState(parentId, 0).catch(() => null));
    const how = obj(state.queue).paused ? 'queued' : 'steer';
    const [code] = await this.ctx.host.liveCall(how === 'queued' ? 'queue' : 'steer', {
      id: parentId,
      text,
      clientMessageId: `swarm-landing-${kind}-${h.id}-${Math.floor(this.clock() / 1000)}`,
    }).catch(() => [500] as [number]);
    if (code !== 200) await this.ctx.host.liveCall('prompt-context', { id: parentId, line: text }).catch(() => [500, null]);
  }

  /** Its worktree, branch and record go (the Studio owns subagent-worktrees.json); tried again at the next poll when it can't now. */
  async #release(h: Helper): Promise<void> {
    const [code, payload] = await this.ctx.host.liveCall('subagent-release', { subagent: h.sub?.record ?? h.id }).catch(() => [500, null] as [number, unknown]);
    if (code !== 200) log.info('swarm: the worktree of subagent %s stays for now (%s)', h.id, pyStr(obj(payload).error ?? code));
  }

  // ---- cleanup (owner 2026-11-23: helper worktrees and branches were never removed) -------------------------------------------------
  /**
   * A merged helper's worktree and branch go once its chat is closed, as a subagent's go after landing (Studio's own retire does it the
   * moment a merged copy's chat closes; this covers the rest: a helper merged by record, one merged before this existed, one whose chat
   * closed while AIB was away). Never unmerged work: it needs state merged (not undone), the branch still at the tip the merge left it
   * (or its changes all in the target), and a clean worktree. A `-landable` branch goes only once its commit is in the target (the
   * main agent merged it by hand). A helper whose worktree and branch are both gone without a merge is `discarded`: it stops counting.
   */
  async #cleanup(id: string, chats?: Json[]): Promise<void> {
    try {
      const h = this.registry.get(id);
      if (!h || h.kind === 'subagent' || this.#working.has(id) || h.landing) return;
      const path = h.worktree.path, branch = h.worktree.branch;
      if (!path || !branch.startsWith('studio/helper-') || !h.project) return;
      if (!wt.lexists(h.project)) return; // the project folder is not here: git can't say anything
      await this.#dropLandable(h);
      const tip = await merge.rev(h.project, `refs/heads/${branch}`);
      if (!wt.lexists(path) && !tip && !h.merge && ['done', 'waiting', 'stopped'].includes(h.state)) {
        await this.registry.patch(id, { state: 'discarded', reason: 'its worktree and branch were removed', endedAt: this.clock() / 1000 });
        return;
      }
      if (h.state !== 'merged' || !h.merge || h.merge.undo || h.cleanedAt) return;
      const open = chats
        ? chats.some((c) => (!!h.chat.live && c.id === h.chat.live) || (!!h.chat.lasting && lasting(c) === h.chat.lasting))
        : await this.#chatOpen(h);
      if (open) return;
      const target = await this.#target(h);
      if (tip && !(await this.#nothingUnmerged(h, tip, target))) return; // new work since the merge: kept until merged or discarded
      if (wt.lexists(path) && (await merge.porcelainPaths(path)).size) return; // edits in its worktree: kept
      const [code, payload] = await this.ctx.host.liveCall('helper-release', { path, branch }).catch(() => [500, null] as [number, unknown]);
      const result = s(obj(payload).result);
      if (code === 200 && (result === 'removed' || result === 'gone')) {
        if (result === 'gone' && !wt.lexists(path) && tip) { // no worktree record any more, folder gone: the branch alone is left
          await wt.git(['branch', '-D', branch], h.project, { check: false });
        } else if (result === 'gone' && wt.lexists(path)) return; // a folder AIB has no record of: not removed
        await this.registry.patch(id, { cleanedAt: this.clock() / 1000 });
        log.info('swarm: removed the worktree and branch of merged helper %s (%s)', id, branch);
      } else if (code !== 200 || result !== 'open') {
        log.info('swarm: the copy of helper %s stays for now (%s)', id, result || pyStr(obj(payload).error ?? code));
      }
    } catch (error) {
      log.exception(error, 'Cleaning up helper %s failed', id);
    }
  }

  /** True when nothing of the helper's branch is missing from the target: still where the merge left it, in the target, or the same tree as landed. */
  async #nothingUnmerged(h: Helper, tip: string, target: string): Promise<boolean> {
    if (h.merge?.branchTip && tip === h.merge.branchTip) return true;
    if (await merge.isAncestor(h.project, tip, `refs/heads/${target}`)) return true;
    const landed = h.merge?.landed;
    if (landed) {
      const same = await wt.git(['diff', '--quiet', landed, tip], h.project, { check: false });
      if (same.returncode === 0) return true;
    }
    return false;
  }

  /** The `-landable` branch of a helper (a conflicting landing's clean branch) goes once its commit is in the target. */
  async #dropLandable(h: Helper): Promise<void> {
    const name = `${h.worktree.branch}-landable`;
    const tip = await merge.rev(h.project, `refs/heads/${name}`);
    if (!tip) return;
    const target = await this.#target(h).catch(() => '');
    if (target && (await merge.isAncestor(h.project, tip, `refs/heads/${target}`))) {
      await wt.git(['branch', '-D', name], h.project, { check: false });
    }
  }

  /** At start and every SWEEP_MS: the cleanup for every helper (leftovers of earlier runs go at the first look). */
  async #sweep(chats: Json[]): Promise<void> {
    const now = this.clock();
    if (this.#sweepAt && now - this.#sweepAt < SWEEP_MS) return;
    this.#sweepAt = now;
    for (const h of this.registry.all()) if (h.kind !== 'subagent') await this.#cleanup(h.id, chats);
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
      await this.copyMerges.poll(); // an Own-copy chat's merge that waits for the folder chats (worktrees/merge_queue.ts)
      if (this.#watching) this.#timer = setTimeout(loop, POLL_MS);
    };
    this.#timer = setTimeout(loop, 0);
  }

  async stopWatching(): Promise<void> {
    this.#watching = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    await this.#busy?.catch(() => {});
    await this.copyMerges.poll().catch(() => {});
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
    const pending = (h: Helper) =>
      h.kind === 'subagent'
        ? !!h.landing || h.notes.some((n) => !n.delivered)
        : (h.state !== 'failed' && h.state !== 'discarded') || h.notes.some((n) => !n.delivered) || h.reports.some((r) => !r.delivered) || !!h.landing;
    const subs = Object.values(readSubagents(this.ctx.stateDir));
    if (!subs.length && !this.registry.all().some(pending)) return;
    const listing = obj(await this.ctx.host.liveList());
    if (listing.instanceId === 'host-unavailable') return;
    const chats = (Array.isArray(listing.connections) ? listing.connections : []).map(obj).filter((c) => !c.closed);
    const byLasting = new Map(chats.filter((c) => lasting(c)).map((c) => [lasting(c), c]));
    if (subs.length) await this.#reconcileSubagents(subs, chats, byLasting);
    await this.#sweep(chats);
    const helpers = this.registry.all().filter(pending);
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
      // the landing queue and its journal (build plan 2.2, SF 3): a stage nothing here runs is a landing cut off by a stop
      if (h.landing && h.landing.stage !== 'queued' && !this.#working.has(h.id)) {
        await this.#recover(h, parentLive);
        h = this.registry.get(h.id) ?? h;
      }
      if (parent && h.landing && !this.#working.has(h.id)) {
        await this.#landingStep(h, parentLive);
        h = this.registry.get(h.id) ?? h;
      }
      if (!chat || this.#working.has(h.id) || !['working', 'waiting', 'done'].includes(h.state)) continue;
      const attention = obj(chat.attention);
      h = await this.#followAttention(h, chat, attention);
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

  /**
   * `waiting` (owner 2026-11-23: it was declared but never set): the helper's state while its chat needs the person, an open approval,
   * question or sign-in (attention needs_you; #report sets it too when a turn ends on a question). Activity's "Waiting on you" row and
   * the notification read the same chat attention, so helper_status, the row and the notification agree. It goes back to `working`
   * when the chat works again (the person answered).
   */
  async #followAttention(h: Helper, chat: Json, attention: Json): Promise<Helper> {
    if (attention.state === 'needs_you' && h.state !== 'waiting') {
      const reason = chat.auth
        ? 'needs you to sign in'
        : Array.isArray(chat.elicitations) && chat.elicitations.length
        ? 'asked you a question'
        : 'waiting for your approval';
      return (await this.registry.patch(h.id, { state: 'waiting', reason })) ?? h;
    }
    if (h.state === 'waiting' && attention.state === 'working') return (await this.registry.patch(h.id, { state: 'working', reason: '' })) ?? h;
    return h;
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
    // the turn ended on a question: the helper's reply asks the person something (the chat's own `asks` fact, as the notification reads it)
    const asks = done && !!s(obj(chat.attention).asksAt);
    const text = wrapReport({
      id: h.id,
      title: h.title,
      providerName: chatName(h),
      model: h.chat.model,
      state: asks ? 'waiting' : done ? 'done' : h.state,
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
          state: cur.state === 'merged' ? cur.state : asks ? 'waiting' : 'done',
          reason: cur.state === 'merged' ? cur.reason : asks ? 'ended on a question' : '',
          turnEndedAt: ended,
          cursor: Number(state.cursor) || cur.cursor,
          reports: [...cur.reports, { n: cur.reports.length + 1, at: this.clock() / 1000, text, delivered: false, how: '' }],
        }
        : null);
    await this.note(
      h.id,
      'swarm-report',
      `Report from “${h.title}” (${
        chatName(h)
      }): ${files.length} file(s) changed, +${insertions} −${deletions}, ${commits} commit(s)${asks ? ' · ended on a question, waiting for an answer' : ''}`,
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
