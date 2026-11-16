/**
 * Subagent worktrees, P1 (design v2 2.1-2.3, P0b): AIB's side of a Claude chat's hooks. Every editing subagent works in its own git
 * worktree that AIB builds, like a helper's copy: from a snapshot S of the chat's folder (its uncommitted edits included), on a
 * `studio/sub-<chat>-<n>` branch under AIB's worktrees folder, git-locked while it exists.
 *
 *   pre-tool         Agent/Task of an editing type: record first, then build (or take the spare), then answer
 *                    updatedInput {...input, isolation: "worktree"} (never "allow": the chat's own permission flow still applies).
 *                    Read-only types: unchanged (no isolation value is exempt, "remote" neither: security review P1, MF 2).
 *                    EnterWorktree and Workflow: deny. Over the cap (8 per chat),
 *                    a failed build or a build that would outlast the forwarder's deadline: deny with a plain reason.
 *   worktree-create  name agent-<agentId>: the chat's oldest prepared worktree is bound to that agentId; its bare path is the answer.
 *                    Anything else is refused (409, the reason reaches the parent through the forwarder's stderr).
 *   post-agent       a hint: the tool_use_id <-> agentId pairing; a user-hook worktree's path, adopted only when git says it is a
 *                    worktree of this repo.
 *   subagent-stop    P2: with its agentId (never an internal fork's, agent_type ""), the record is done. It lands only when the
 *                    parent is idle, under the parent's landing lock (swarm/service.ts), so a forged stop lands nothing mid-turn.
 *
 * The routes are harmless when the agent calls them itself (it can read its key): they never answer "allow", never use a path from
 * the body to act on (folders come from AIB's chat record; a body path is only checked against git for adoption), act only on
 * records of that chat, and cap the chat's worktrees.
 *
 * Records: <state>/subagent-worktrees.json, written by the Studio process only (the swarm registry is the web process's), each record
 * written BEFORE its branch or worktree exists, so a crash always leaves an owned, findable item. P2: the web process's swarm reads
 * them (never writes them) and lands each done one through the helper landing (its own registry entry, journal and recovery); the
 * parent's ACP stream continues (SendMessage) or stops (TaskStop, a failed Agent call, a stopped turn) them; once landed, empty or
 * discarded, the web process asks this side to release it (`subagent-release`): worktree, branch and record go, junction-safe.
 */
import { getLogger } from '../core/log.ts';
import { isDict, pyStrip } from '../core/py.ts';
import { readJsonFile, saveJson } from '../state/json.ts';
import { pathOf } from '../state/paths.ts';
import { normcase, realpath, SEP } from '../platform/ospath.ts';
import * as wt from '../worktrees/worktrees.ts';
import { pathFormProblem } from '../allow/paths.ts';
import { readHelpers } from '../swarm/registry.ts';
import { claudeConfigDir, isForkSkill } from './claude_config.ts';

const log = getLogger('subagents');

export const FILE = 'subagent-worktrees.json';
export const MAX_PER_CHAT = 8;
/** pre-tool answers within this, well under the forwarder's 10 s deadline (P0b R2c). */
export const PREPARE_BUDGET_MS = 8000;
/** A spare or unused prepared worktree this old with no open chat is removed at start. */
const STALE_S = 60;

export type SubagentState = 'preparing' | 'spare' | 'prepared' | 'running' | 'done' | 'stopped' | 'user-hook';
/**
 * States that hold one of the chat's slots (the cap): every one with a folder on disk that has not gone yet (security review SF 4),
 * and the user-hook records (MF 4: a forged pre-tool flood hits the cap too).
 */
const SLOT_STATES = new Set<SubagentState>(['preparing', 'prepared', 'running', 'done', 'stopped', 'user-hook']);
/** A path hint from a hook body is stored at most this long (security review MF 4). */
const MAX_HINT = 1024;

export interface SubagentRecord {
  id: string;
  kind: 'subagent';
  /** The parent chat: its live conversation id and lasting name (provider:sessionId, '' until known). */
  chat: string;
  lasting: string;
  /** The project folder (its repo hash names the folder AIB's worktree sits in). */
  project?: string;
  /**
   * P2: the parent's ACP stream showed this record's Agent call (by its tool_use_id), and the agentId it reported, when it did. A
   * user-hook worktree lands only from a call the stream showed, and never when the stream named another agent (security review MF 5).
   */
  acpSeen?: boolean;
  acpAgentId?: string;
  /** The parent's folder (the project folder, or a helper's worktree): what S was taken of, and where the work lands (P2). */
  folder: string;
  slug: string;
  branch: string;
  path: string;
  /** S: the commit the worktree started from (HEAD + the folder's uncommitted edits), and its tree. */
  snapshot: string;
  tree: string;
  state: SubagentState;
  toolUseId: string;
  agentId: string;
  agentType: string;
  description: string;
  createdAt: number;
  boundAt?: number;
  hints?: { postAgent?: { at: number; status: string }; stops?: number; lastStopAt?: number };
  /** A worktree the user's own WorktreeCreate hook made: AIB lands it (P2) and never removes it. */
  adopted?: { path: string; verified: boolean };
  /** The user's own WorktreeCreate hook made its worktree (state 'user-hook' while it runs): never removed by AIB. */
  userHook?: boolean;
  /** P2: when it ended (SubagentStop with its agentId), was continued (SendMessage to it), or was stopped, and why. */
  doneAt?: number;
  continuedAt?: number;
  stoppedAt?: number;
  stoppedWhy?: string;
}

/** What the service needs to know of an open chat. */
export interface SubagentChat {
  id: string;
  provider: string;
  lasting: string;
  /** The chat's folder (repo top: the project folder or a helper's worktree). */
  folder: string;
  /** The project folder (worktrees go under <root>/<its repo hash>/, with the project's other copies). */
  project: string;
  /** Hooks were given to this chat: on, its read-only types, and whether the user's WorktreeCreate hook makes the worktrees. */
  hooks: { readOnly: Set<string>; userWorktreeHook: boolean; configDir?: string } | null;
  /**
   * Where this chat's subagent worktrees go when not <root>/<repo hash>/: a Gemini chat's own <root>/<repo hash>/.gem-<chat> folder,
   * the one folder its agent was given with --include-directories (subagents/gemini.ts); a Codex chat's .cx-<chat>, a writable root
   * of its sandbox (subagents/codex.ts subagentFolder).
   */
  subFolder?: string;
}

export interface HookAnswer {
  status: number;
  body: string;
  type: 'application/json' | 'text/plain';
}

const now = () => Date.now() / 1000;
const json = (payload: unknown, status = 200): HookAnswer => ({ status, body: JSON.stringify(payload), type: 'application/json' });
const text = (body: string, status: number): HookAnswer => ({ status, body, type: 'text/plain' });
const pass = (): HookAnswer => json({});
export const deny = (reason: string): HookAnswer =>
  json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

export const TEXTS = {
  enterWorktree: 'In AIB, chats work in the project folder. Use a subagent instead; AIB gives it its own worktree.',
  workflow: "Workflows aren't available in AIB chats yet, because their agents can't get their own worktree.",
  cap: `This chat already has ${MAX_PER_CHAT} subagents with their own worktree running. Wait for one to finish.`,
  slow: 'AIB is still preparing a worktree for this subagent; try the subagent again in a moment.',
  unexpected: "AIB didn't expect this worktree",
  forkSkill: (name: string) =>
    `In AIB, skills that run as a forked subagent (context: fork) are off, because AIB can't give them their own worktree. ` +
    `Do the steps of "${name}" yourself, or start a subagent (Agent tool) for them; AIB gives that one its own worktree.`,
};

/** Read-only types the chat listed: no worktree (the forwarder decides these too, AIB up or not). No isolation value is exempt. */
function passesUnchanged(input: Record<string, unknown>, readOnly: Set<string>): boolean {
  return typeof input.subagent_type === 'string' && readOnly.has(input.subagent_type);
}

/** The file read fresh. Never throws. */
export function readSubagents(stateDir: string): Record<string, SubagentRecord> {
  try {
    const [status, raw] = readJsonFile(pathOf(stateDir, FILE));
    if (status !== 'ok' || !isDict(raw) || !isDict(raw.subagents)) return {};
    return raw.subagents as Record<string, SubagentRecord>;
  } catch {
    return {};
  }
}

class Mutex {
  #tail: Promise<void> = Promise.resolve();
  async run<T>(work: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => (release = resolve));
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

export class SubagentWorktrees {
  readonly #file = new Mutex();
  readonly #chats = new Map<string, Mutex>();

  constructor(
    readonly stateDir: string,
    /** AIB's worktrees folder (wt.Manager registry root): every subagent worktree goes under <root>/<repo hash>/. */
    readonly root: string,
    readonly chat: (id: string) => SubagentChat | null,
  ) {}

  all(): SubagentRecord[] {
    return Object.values(readSubagents(this.stateDir));
  }

  ofChat(chatId: string): SubagentRecord[] {
    return this.all().filter((r) => r.chat === chatId);
  }

  #update(id: string, change: (r: SubagentRecord | null) => SubagentRecord | null): Promise<SubagentRecord | null> {
    return this.#file.run(() => {
      const all = readSubagents(this.stateDir);
      const next = change(all[id] ? structuredClone(all[id]) : null);
      if (next === null) delete all[id];
      else all[id] = next;
      saveJson(pathOf(this.stateDir, FILE), { version: 1, subagents: all }, '.subagent-worktrees-');
      return next;
    });
  }

  #patch(id: string, fields: Partial<SubagentRecord>): Promise<SubagentRecord | null> {
    return this.#update(id, (r) => (r ? { ...r, ...fields } : null));
  }

  #lockOf(chatId: string): Mutex {
    let m = this.#chats.get(chatId);
    if (!m) this.#chats.set(chatId, m = new Mutex());
    return m;
  }

  // ---- the routes ------------------------------------------------------------------------------------------------------------

  /** One hook call, already key-checked for `chatId`. Never throws. */
  async hook(event: string, chatId: string, body: unknown): Promise<HookAnswer> {
    const chat = this.chat(chatId);
    // not open here (a keeper-held chat before its take-over) or given no hooks: the forwarder fails closed ("AIB is restarting")
    if (!chat || !chat.hooks || !isDict(body)) return text('This chat is not open in AIB', 503);
    try {
      switch (event) {
        case 'pre-tool':
          return await this.#preTool(chat, body as Record<string, unknown>);
        case 'worktree-create':
          return await this.#worktreeCreate(chat, body as Record<string, unknown>);
        case 'post-agent':
          await this.#postAgent(chat, body as Record<string, unknown>);
          return pass();
        case 'subagent-stop':
          await this.#subagentStop(chat, body as Record<string, unknown>);
          return pass();
        default:
          return text('Not found', 404);
      }
    } catch (error) {
      log.exception(error, 'Subagent hook %s failed', event);
      return event === 'pre-tool'
        ? deny(`AIB couldn't make a worktree for this subagent: ${error instanceof Error ? error.message : error}`)
        : text('AIB could not answer this hook', 500);
    }
  }

  async #preTool(chat: SubagentChat, body: Record<string, unknown>): Promise<HookAnswer> {
    const tool = String(body.tool_name ?? '');
    if (tool === 'EnterWorktree') return deny(TEXTS.enterWorktree);
    if (tool === 'Workflow') return deny(TEXTS.workflow);
    const input = isDict(body.tool_input) ? body.tool_input as Record<string, unknown> : {};
    if (tool === 'Skill') { // P3 probe: a fork skill starts a subagent with no Agent call, in the folder: refused
      const name = typeof input.skill === 'string' ? input.skill : '';
      const configDir = chat.hooks!.configDir ?? claudeConfigDir(Deno.env.toObject());
      return isForkSkill(name, chat.folder, configDir) || (chat.project !== chat.folder && isForkSkill(name, chat.project, configDir))
        ? deny(TEXTS.forkSkill(name.slice(0, 120)))
        : pass();
    }
    if (tool !== 'Agent' && tool !== 'Task') return pass();
    if (passesUnchanged(input, chat.hooks!.readOnly)) return pass();
    const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id.slice(0, 200) : '';
    const meta = {
      toolUseId,
      agentType: typeof input.subagent_type === 'string' ? input.subagent_type.slice(0, 200) : 'general-purpose',
      description: typeof input.description === 'string' ? input.description.slice(0, 300) : '',
    };
    const isolated = json({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...input, isolation: 'worktree' } } });
    if (chat.hooks!.userWorktreeHook) {
      // the user's hook makes the worktree (P0 A6): AIB only records the call, to adopt the result (P2); capped like AIB's own
      const id = this.#newId();
      const capped = await this.#lockOf(chat.id).run(async () => {
        if (this.ofChat(chat.id).filter((r) => SLOT_STATES.has(r.state)).length >= MAX_PER_CHAT) return true;
        await this.#update(id, () => this.#record(id, chat, { state: 'user-hook', userHook: true, ...meta }));
        return false;
      });
      return capped ? deny(TEXTS.cap) : isolated;
    }
    const outcome = await this.prepareFor(chat, meta);
    return 'deny' in outcome ? deny(outcome.deny) : isolated;
  }

  /**
   * A worktree for a subagent the chat is about to start (Claude's editing Agent call; Codex's spawn_agent: subagents/codex.ts):
   * capped, answered within PREPARE_BUDGET_MS (a later build becomes the chat's spare). The record (state prepared), or why not.
   */
  async prepareFor(
    chat: SubagentChat,
    meta: { toolUseId: string; agentType: string; description: string },
  ): Promise<SubagentRecord | { deny: string }> {
    let timedOut = false;
    const work = this.#lockOf(chat.id).run(async () => {
      if (this.ofChat(chat.id).filter((r) => SLOT_STATES.has(r.state)).length >= MAX_PER_CHAT) return 'cap';
      return await this.#prepare(chat, meta, () => timedOut);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<'slow'>((resolve) => (timer = setTimeout(() => resolve('slow'), PREPARE_BUDGET_MS)));
    const outcome = await Promise.race([work, budget]).finally(() => clearTimeout(timer));
    if (outcome === 'slow') {
      timedOut = true; // the build goes on and becomes the chat's spare
      return { deny: TEXTS.slow };
    }
    if (outcome === 'cap') return { deny: TEXTS.cap };
    if (typeof outcome === 'string') return { deny: `AIB couldn't make a worktree for this subagent: ${outcome}.` };
    return outcome;
  }

  /**
   * A subagent of the chat started with this agentId (Codex SubagentStart, or its first call): its own record when it has one (a
   * done one runs again: it was continued, and lands at its next end), else the chat's oldest prepared worktree is bound to it.
   * Null: AIB prepared none (its calls are refused).
   */
  async bindAgent(chatId: string, agentId: string, agentType = ''): Promise<SubagentRecord | null> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(agentId)) return null;
    return await this.#lockOf(chatId).run(async () => {
      const mine = this.ofChat(chatId);
      const own = mine.find((r) => r.agentId === agentId && wt.lexists(r.path));
      if (own) {
        if (own.state === 'running') return own;
        if (own.state !== 'done') return null; // stopped (kept for the user), or anything else: no more edits there
        return await this.#patch(own.id, { state: 'running', continuedAt: now() });
      }
      const ready = mine.filter((r) => r.state === 'prepared' && wt.lexists(r.path)).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!ready) return null;
      return await this.#patch(ready.id, {
        agentId,
        state: 'running',
        boundAt: now(),
        ...(agentType && !ready.agentType ? { agentType: agentType.slice(0, 200) } : {}),
      });
    });
  }

  /** The record of the chat's subagent with this agentId while it runs, or null. */
  runningAgent(chatId: string, agentId: string): SubagentRecord | null {
    if (!agentId) return null;
    return this.ofChat(chatId).find((r) => r.agentId === agentId && r.state === 'running' && !!r.path) ?? null;
  }

  /** It ended (Codex SubagentStop): done, so it lands when the parent is idle (P2). */
  async agentEnded(chatId: string, agentId: string): Promise<void> {
    if (!agentId) return;
    await this.#lockOf(chatId).run(async () => {
      const rec = this.ofChat(chatId).find((r) => r.agentId === agentId);
      if (!rec) return;
      const hints = { ...rec.hints, stops: (rec.hints?.stops ?? 0) + 1, lastStopAt: now() };
      await this.#patch(rec.id, { hints, ...(rec.state === 'running' ? { state: 'done' as const, doneAt: now() } : {}) });
    });
  }

  #newId(): string {
    return 'sa_' + crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  }

  #record(id: string, chat: SubagentChat, fields: Partial<SubagentRecord>): SubagentRecord {
    return {
      id,
      kind: 'subagent',
      chat: chat.id,
      lasting: chat.lasting,
      project: chat.project,
      folder: chat.folder,
      slug: '',
      branch: '',
      path: '',
      snapshot: '',
      tree: '',
      state: 'preparing',
      toolUseId: '',
      agentId: '',
      agentType: '',
      description: '',
      createdAt: now(),
      ...fields,
    };
  }

  /** S of the chat's folder: HEAD plus its uncommitted edits (worktrees.ts snapshotCommit); a reason string when it can't be made. */
  async #snapshot(folder: string): Promise<{ commit: string; tree: string } | string> {
    const [untracked, size] = await wt.snapshotSize(folder);
    if (untracked > wt.limits.MAX_UNTRACKED_FILES || size > wt.limits.MAX_SNAPSHOT_BYTES) {
      return `the project has ${Math.round(size / (1024 * 1024))} MB in ${untracked} uncommitted files (limit ` +
        `${Math.round(wt.limits.MAX_SNAPSHOT_BYTES / (1024 * 1024))} MB, ${wt.limits.MAX_UNTRACKED_FILES} files)`;
    }
    Deno.mkdirSync(this.root, { recursive: true });
    const scratch = Deno.makeTempDirSync({ prefix: '.snapshot-', dir: this.root });
    try {
      const commit = await wt.snapshotCommit(folder, scratch);
      const tree = pyStrip((await wt.git(['rev-parse', `${commit}^{tree}`], folder)).stdout);
      return { commit, tree };
    } finally {
      try {
        Deno.removeSync(scratch, { recursive: true });
      } catch { /* gone */ }
    }
  }

  /** A free slug, branch and path for the chat's next subagent worktree. */
  async #place(chat: SubagentChat): Promise<{ slug: string; branch: string; path: string }> {
    const folder = chat.subFolder || pathOf(this.root, wt.repoHash(chat.project));
    const taken = new Set(this.all().map((r) => r.slug));
    for (let n = 1;; n++) {
      const slug = `sub-${chat.id.slice(0, 8)}-${n}`;
      const branch = `studio/${slug}`;
      if (taken.has(slug) || wt.lexists(pathOf(folder, slug))) continue;
      if ((await wt.git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], chat.folder, { check: false })).returncode === 0) continue;
      return { slug, branch, path: pathOf(folder, slug) };
    }
  }

  /**
   * Record first, then S, then the worktree (the chat's spare when it has one: moved to S, which is much faster than a new worktree;
   * P0b R5). Returns the record, or a reason. When `late()` (the route already answered "still preparing"), the result becomes the
   * chat's spare instead of waiting for a WorktreeCreate that will not come.
   */
  async #prepare(
    chat: SubagentChat,
    meta: { toolUseId: string; agentType: string; description: string },
    late: () => boolean,
  ): Promise<SubagentRecord | string> {
    const s = await this.#snapshot(chat.folder);
    if (typeof s === 'string') return s;
    const spare = this.ofChat(chat.id).find((r) => r.state === 'spare' && wt.lexists(r.path));
    if (spare) {
      const moved = await wt.git(['reset', '-q', '--hard', s.commit], spare.path, { check: false });
      if (moved.returncode === 0) {
        const rec = await this.#patch(spare.id, { state: late() ? 'spare' : 'prepared', snapshot: s.commit, tree: s.tree, ...(late() ? {} : meta) });
        this.#spareSoon(chat, s.commit);
        return rec!;
      }
      log.warning('Subagent spare %s could not be moved to S (%s); making a new worktree', spare.path, pyStrip(moved.stderr));
      await this.#remove(spare);
    }
    const rec = await this.#build(chat, s, late() ? null : meta);
    if (typeof rec === 'string') return rec;
    if (late()) await this.#patch(rec.id, { state: 'spare' });
    else this.#spareSoon(chat, s.commit);
    return rec;
  }

  /** Record first (state preparing), then the branch and worktree at S, then the git lock. On failure everything made is removed. */
  async #build(
    chat: SubagentChat,
    s: { commit: string; tree: string },
    meta: { toolUseId: string; agentType: string; description: string } | null,
  ): Promise<SubagentRecord | string> {
    const place = await this.#place(chat);
    const id = this.#newId();
    const rec = this.#record(id, chat, { ...place, snapshot: s.commit, tree: s.tree, ...(meta ?? {}) });
    await this.#update(id, () => rec);
    try {
      Deno.mkdirSync(chat.subFolder || pathOf(this.root, wt.repoHash(chat.project)), { recursive: true });
      await wt.git(['worktree', 'add', '-q', '-b', place.branch, place.path, s.commit], chat.folder);
      // a running subagent's worktree is never removed by `git worktree remove` or prune (as Claude Code does with its own)
      await wt.git(['worktree', 'lock', '--reason', 'AIB subagent', place.path], chat.folder, { check: false });
    } catch (error) {
      await this.#remove(rec);
      return `git could not make it (${error instanceof Error ? error.message.slice(0, 300) : error})`;
    }
    return (await this.#patch(id, { state: meta ? 'prepared' : 'spare' }))!;
  }

  /** The prepared-worktree fast path: one spare per chat, made in the background from the latest S. */
  #spareSoon(chat: SubagentChat, commit: string): void {
    setTimeout(() => {
      void this.#lockOf(chat.id).run(async () => {
        if (!this.chat(chat.id)) return;
        if (this.ofChat(chat.id).some((r) => r.state === 'spare')) return;
        const tree = pyStrip((await wt.git(['rev-parse', `${commit}^{tree}`], chat.folder, { check: false })).stdout);
        const made = await this.#build(chat, { commit, tree }, null);
        if (typeof made === 'string') log.info('No spare subagent worktree for %s: %s', chat.id, made);
      }).catch((error) => log.exception(error, 'Making a spare subagent worktree failed'));
    }, 0);
  }

  async #worktreeCreate(chat: SubagentChat, body: Record<string, unknown>): Promise<HookAnswer> {
    const name = typeof body.name === 'string' ? body.name : '';
    const m = /^agent-([A-Za-z0-9_-]{1,64})$/.exec(name);
    if (!m) return text(TEXTS.unexpected, 409); // EnterWorktree's own names, or anything else
    return await this.#lockOf(chat.id).run(async () => {
      const mine = this.ofChat(chat.id);
      const again = mine.find((r) => r.agentId === m[1] && wt.lexists(r.path));
      if (again) return text(again.path, 200);
      const ready = mine.filter((r) => r.state === 'prepared' && wt.lexists(r.path)).sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!ready) return text(TEXTS.unexpected, 409);
      await this.#patch(ready.id, { agentId: m[1], state: 'running', boundAt: now() });
      return text(ready.path, 200);
    });
  }

  async #postAgent(chat: SubagentChat, body: Record<string, unknown>): Promise<void> {
    const response = isDict(body.tool_response) ? body.tool_response as Record<string, unknown> : {};
    const agentId = typeof response.agentId === 'string' ? response.agentId : '';
    const toolUseId = typeof body.tool_use_id === 'string' ? body.tool_use_id : '';
    const status = typeof response.status === 'string' ? response.status.slice(0, 40) : '';
    await this.#lockOf(chat.id).run(async () => {
      const mine = this.ofChat(chat.id);
      const bound = agentId ? mine.find((r) => r.agentId === agentId) : undefined;
      if (bound) {
        // parallel Agent calls: the prepared worktrees are interchangeable, so the pairing is fixed here (P0 A5: agentId is reliable)
        const other = toolUseId ? mine.find((r) => r.id !== bound.id && r.toolUseId === toolUseId) : undefined;
        if (other) await this.#patch(other.id, { toolUseId: bound.toolUseId });
        await this.#patch(bound.id, { ...(toolUseId ? { toolUseId } : {}), hints: { ...bound.hints, postAgent: { at: now(), status } } });
        return;
      }
      const user = toolUseId ? mine.find((r) => r.state === 'user-hook' && r.toolUseId === toolUseId && !r.adopted) : undefined;
      const raw = typeof response.worktreePath === 'string' ? response.worktreePath : '';
      const hinted = raw.length <= MAX_HINT && !pathFormProblem(raw) ? raw : ''; // security review MF 4: clipped, form-checked
      if (user && raw) {
        // a body path is a hint: adopted only when git says it is a NEW worktree of this very repo that is no one else's: not the
        // chat's or the project's folder, nothing under AIB's worktrees folder, no other chat's, helper's or subagent's (MF 7, MF 5)
        const why = !hinted
          ? 'its path was refused'
          : !(await sameRepository(hinted, chat.folder))
          ? 'it is not a worktree of this repository'
          : await this.#adoptable(hinted, chat, user);
        const verified = !why;
        // P2: a foreground call's PostToolUse comes after its SubagentStop (P0 order), so "completed" is its end; a background one
        // ends at its SubagentStop. One the user's hook made outside this repository is never landed (nor removed): stopped, told.
        const ended = status !== 'async_launched';
        await this.#patch(user.id, {
          agentId,
          adopted: { path: hinted.slice(0, MAX_HINT), verified },
          hints: { postAgent: { at: now(), status } },
          ...(!verified ? { state: 'stopped' as const, stoppedAt: now(), stoppedWhy: why } : ended ? { state: 'done' as const, doneAt: now() } : {}),
        });
      }
    });
  }

  /** Security review MF 5: '' when AIB may land from this user-hook worktree path, else why not (never one that is anything else's). */
  async #adoptable(path: string, chat: SubagentChat, rec: SubagentRecord): Promise<string> {
    const key = (p: string) => normcase(realpath(p)).replace(/[\/]+$/, '');
    const here = key(path);
    const under = (root: string) => here === key(root) || here.startsWith(key(root) + SEP);
    if (here === key(chat.folder) || here === key(chat.project)) return 'it is the project folder';
    if (under(this.root)) return "it is inside AIB's own worktrees folder";
    const taken = [
      ...Object.values(readSubagents(this.stateDir)).flatMap((r) => [r.path, r.folder, r.id !== rec.id ? r.adopted?.path ?? '' : '']),
      ...Object.values(readHelpers(this.stateDir)).map((h) => String(h.worktree?.path ?? '')),
      ...Object.values(new wt.Registry(this.stateDir).all()).map((r) => String(r.path ?? '')),
    ].filter((p) => !!p);
    if (taken.some((p) => key(p) === here)) return 'it belongs to another chat, helper or subagent';
    // new: its git admin folder (.git/worktrees/<name>) was made after the Agent call was recorded
    try {
      const gitdir = pyStrip((await wt.git(['rev-parse', '--path-format=absolute', '--git-dir'], path, { check: false })).stdout);
      if (!gitdir || !/[\/]worktrees[\/]/.test(gitdir)) return 'it is not a linked worktree';
      const st = Deno.statSync(gitdir);
      const made = st.birthtime ?? st.mtime;
      if (!made || made.getTime() / 1000 < rec.createdAt - 2) return 'it existed before the subagent started';
    } catch {
      return 'git could not read it';
    }
    return '';
  }

  async #subagentStop(chat: SubagentChat, body: Record<string, unknown>): Promise<void> {
    const agentId = typeof body.agent_id === 'string' ? body.agent_id : '';
    if (!agentId || !body.agent_type) return; // internal forks (P0 A8b)
    await this.#lockOf(chat.id).run(async () => {
      const rec = this.ofChat(chat.id).find((r) => r.agentId === agentId);
      if (!rec) return;
      const hints = { ...rec.hints, stops: (rec.hints?.stops ?? 0) + 1, lastStopAt: now() };
      // P2: it ended. Done (lands when the parent is idle), unless it was stopped (never lands by itself). A forged stop for a running
      // subagent lands nothing while its parent's turn runs (the landing needs the parent idle, under its landing lock).
      const ends = rec.state === 'running' || (rec.state === 'user-hook' && !!rec.adopted?.verified);
      await this.#patch(rec.id, { hints, ...(ends ? { state: 'done', doneAt: now() } : {}) });
    });
  }

  /**
   * P2: what the parent's ACP stream says (never forged by the agent's own hook calls): `SendMessage` to a finished subagent continues
   * it in the same worktree (P0b R7: no new hooks), so its record runs again until its next SubagentStop; `TaskStop` aimed at it, or
   * its Agent call failing, stops it (never lands by itself).
   */
  async claudeTool(
    chatId: string,
    tool: string,
    toolUseId: string,
    input: Record<string, unknown>,
    status: string,
    agentId = '',
  ): Promise<void> {
    const target = (v: unknown) => (typeof v === 'string' ? v : '');
    await this.#lockOf(chatId).run(async () => {
      const mine = this.ofChat(chatId);
      if ((tool === 'Agent' || tool === 'Task') && toolUseId) { // the parent really made this Agent call (a forged pre-tool has none)
        const rec = mine.find((r) => r.toolUseId === toolUseId && (!r.acpSeen || (agentId && !r.acpAgentId)));
        if (rec) await this.#patch(rec.id, { acpSeen: true, ...(agentId ? { acpAgentId: agentId.slice(0, 64) } : {}) });
      }
      if (tool === 'SendMessage') {
        const to = target(input.to) || target(input.agent_id) || target(input.agentId);
        const rec = to ? mine.find((r) => r.agentId === to && r.state === 'done') : undefined;
        if (rec) await this.#patch(rec.id, { state: rec.userHook ? 'user-hook' : 'running', continuedAt: now() });
      } else if (tool === 'TaskStop' || tool === 'KillShell') {
        const id = target(input.task_id) || target(input.shell_id) || target(input.agent_id);
        const rec = id ? mine.find((r) => r.agentId === id && ['running', 'done', 'user-hook'].includes(r.state)) : undefined;
        if (rec) await this.#stop(rec, 'the main agent stopped it');
      } else if ((tool === 'Agent' || tool === 'Task') && status === 'failed' && toolUseId) {
        const rec = mine.find((r) => r.toolUseId === toolUseId && (r.state === 'running' || r.state === 'user-hook'));
        if (rec) await this.#stop(rec, 'its Agent call failed');
      }
    });
  }

  async #stop(rec: SubagentRecord, why: string): Promise<void> {
    await this.#patch(rec.id, { state: 'stopped', stoppedAt: now(), stoppedWhy: why });
  }

  /**
   * P3: the parent's ACP stream says subagent `agentId` ended (connection.ts onSubagentEnded / endedSubagents: the adapter's
   * subagent_update, whose child session id is the agentId; the agent can't forge it). It settles what the SubagentStop hook would
   * have, and what it can't: a hook that never reached AIB (AIB was down: the take-over replays the stream) and a subagent TaskStop
   * killed. Finished ('end_turn'): done. Anything else (cancelled, error, an unexplained end, lost sight of): stopped, never landed by
   * itself; that also turns a done one stopped (a killed subagent's SubagentStop came first), unless it was continued since.
   */
  async acpEnded(chatId: string, agentId: string, how: string | null): Promise<void> {
    if (!agentId) return;
    await this.#lockOf(chatId).run(async () => {
      const rec = this.ofChat(chatId).find((r) => r.agentId === agentId);
      if (!rec) return;
      // null: it runs again after an end (a SendMessage continued it in its worktree; P0b R7): it lands at its next end
      if (how === null) {
        if (rec.state === 'done') await this.#patch(rec.id, { state: rec.userHook ? 'user-hook' : 'running', continuedAt: now() });
        return;
      }
      await this.#settle(rec, how);
    });
  }

  /** P3: at the parent's turn end and when AIB takes a chat over: every record of the chat the stream shows as ended is settled. */
  async reconcileEnded(chatId: string, ended: Map<string, string>): Promise<void> {
    if (!ended.size) return;
    await this.#lockOf(chatId).run(async () => {
      for (const rec of this.ofChat(chatId)) {
        const how = rec.agentId ? ended.get(rec.agentId) : undefined;
        if (how !== undefined) await this.#settle(rec, how);
      }
    });
  }

  async #settle(rec: SubagentRecord, how: string): Promise<void> {
    const live = rec.state === 'running' || (rec.state === 'user-hook' && !!rec.adopted?.verified);
    if (how === 'end_turn') {
      if (live) await this.#patch(rec.id, { state: 'done', doneAt: now() });
      return;
    }
    if (!live && rec.state !== 'done') return;
    if (rec.state === 'done' && (rec.continuedAt ?? 0) > (rec.doneAt ?? 0)) return;
    const why = how === 'cancelled'
      ? 'it was cancelled'
      : how === 'error'
      ? 'it failed'
      : how === 'unknown'
      ? 'Claude Code lost track of it'
      : 'it ended without saying why';
    await this.#stop(rec, why);
  }

  /** P2: the user stopped the parent's turn: what still runs is stopped (kept, never landed by itself). */
  async turnCancelled(chatId: string): Promise<void> {
    await this.#lockOf(chatId).run(async () => {
      for (const r of this.ofChat(chatId).filter((x) => x.state === 'running' || (x.state === 'user-hook' && x.agentId))) {
        await this.#stop(r, 'the turn was stopped');
      }
    });
  }

  /**
   * P2: the web process landed it (or found nothing to land, or the user discarded it): its worktree, branch and record go. A worktree
   * the user's own hook made is never removed (only AIB's record of it goes). Only an ended record (done or stopped) is released: a
   * running subagent's worktree is never pulled from under it. Returns what happened.
   */
  async release(id: string): Promise<'removed' | 'kept' | 'running' | 'gone'> {
    const rec = readSubagents(this.stateDir)[id];
    if (!rec) return 'gone';
    return await this.#lockOf(rec.chat).run(async () => {
      const cur = readSubagents(this.stateDir)[id];
      if (!cur) return 'gone';
      if (cur.state !== 'done' && cur.state !== 'stopped') return 'running';
      if (cur.userHook) {
        await this.#update(id, () => null);
        return 'kept';
      }
      await this.#remove(cur, true);
      return readSubagents(this.stateDir)[id] ? 'kept' : 'removed';
    });
  }

  // ---- subagents AIB sees start and end in the parent's ACP stream (Gemini: subagents/gemini.ts) ---------------------------------

  /**
   * A worktree for a subagent the parent's ACP stream showed starting (its call id: `callId`), bound to it at once (no WorktreeCreate:
   * the agent never moves; AIB's hook moves its writes). Record first, as for Claude; capped the same. The record, or a reason.
   */
  async startExternal(chatId: string, meta: { callId: string; agentType: string; description: string }): Promise<SubagentRecord | string> {
    const chat = this.chat(chatId);
    if (!chat) return 'this chat is not open in AIB';
    const callId = meta.callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    return await this.#lockOf(chatId).run(async () => {
      const mine = this.ofChat(chatId);
      const again = mine.find((r) => r.toolUseId === callId && r.state === 'running');
      if (again) return again;
      if (mine.filter((r) => SLOT_STATES.has(r.state)).length >= MAX_PER_CHAT) return TEXTS.cap;
      const meta2 = { toolUseId: callId, agentType: meta.agentType.slice(0, 200), description: meta.description.slice(0, 300) };
      const rec = await this.#prepare(chat, meta2, () => false);
      if (typeof rec === 'string') return rec;
      return (await this.#patch(rec.id, { state: 'running', agentId: callId, acpSeen: true, acpAgentId: callId, boundAt: now() }))!;
    });
  }

  /** Its call ended in the parent's ACP stream: done (it lands when the parent is idle) or, when the call failed, stopped. */
  async endExternal(chatId: string, callId: string, ok: boolean): Promise<void> {
    const id = callId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    await this.#lockOf(chatId).run(async () => {
      const rec = this.ofChat(chatId).find((r) => r.toolUseId === id && r.state === 'running');
      if (!rec) return;
      if (ok) await this.#patch(rec.id, { state: 'done', doneAt: now() });
      else await this.#stop(rec, 'its call failed');
    });
  }

  // ---- what the rest of AIB asks ---------------------------------------------------------------------------------------------

  /**
   * P3, Activity: per subagent of the chat (by agentId, the adapter's child session id), where it works and how its work lands, as
   * plain read-only words. From the chat's records (running, done, stopped) and the swarm's landing entries (merged, refused, stopped;
   * the record is gone once landed). Cached a second (the page asks on every state poll).
   */
  activity(chatId: string): Record<string, SubagentActivity> {
    const hit = this.#activity.get(chatId);
    const t = Date.now();
    if (hit && t - hit.at < 1000) return hit.value;
    const out: Record<string, SubagentActivity> = {};
    const entries = Object.values(readHelpers(this.stateDir)).filter((h) => h.kind === 'subagent' && h.parent?.live === chatId);
    for (const h of entries) {
      const id = h.sub?.agentId;
      if (id) out[id] = { where: OWN_WORKTREE, landing: landingWords(h) };
    }
    for (const r of this.ofChat(chatId)) {
      if (!r.agentId || (out[r.agentId] && r.state !== 'running')) continue;
      const where = r.userHook && r.adopted && !r.adopted.verified ? `Not isolated: ${r.stoppedWhy || 'its worktree is not this project\'s'}` : OWN_WORKTREE;
      if (r.state === 'running' || r.state === 'done' || (r.state === 'user-hook' && r.adopted?.verified)) {
        out[r.agentId] = { where, landing: LANDS_AT_TURN_END };
      } else if (r.state === 'stopped') out[r.agentId] = { where, landing: STOPPED_WORDS };
    }
    this.#activity.set(chatId, { at: t, value: out });
    if (this.#activity.size > 100) this.#activity.delete(this.#activity.keys().next().value!);
    return out;
  }
  readonly #activity = new Map<string, { at: number; value: Record<string, SubagentActivity> }>();

  /** The worktree a subagent of this chat works in, by the Agent call's tool_use_id (allow-rule parity, design 2.4). */
  worktreeOf(chatId: string, toolUseId: string): string | null {
    if (!toolUseId) return null;
    const rec = this.ofChat(chatId).find((r) => r.toolUseId === toolUseId && (r.state === 'running' || r.state === 'done'));
    return rec && rec.path ? rec.path : null;
  }

  /**
   * The chat's turn ended: a prepared worktree no Agent call took (the call failed or was refused) becomes the spare, or goes.
   * Bound ones stay for landing (P2).
   */
  async turnEnded(chatId: string): Promise<void> {
    await this.#lockOf(chatId).run(async () => {
      // user-hook records whose Agent call never showed a worktree (refused, failed, forged) go (security review MF 4)
      for (const r of this.ofChat(chatId).filter((x) => x.state === 'user-hook' && !x.adopted)) await this.#update(r.id, () => null);
      let haveSpare = this.ofChat(chatId).some((r) => r.state === 'spare');
      for (const r of this.ofChat(chatId).filter((x) => x.state === 'prepared')) {
        if (!haveSpare && wt.lexists(r.path)) {
          await this.#patch(r.id, { state: 'spare', toolUseId: '', agentType: '', description: '' });
          haveSpare = true;
        } else await this.#remove(r);
      }
    });
  }

  /** The chat closed: its spare and unused prepared worktrees go. Bound ones stay for landing (P2). */
  async chatClosed(chatId: string): Promise<void> {
    await this.#lockOf(chatId).run(async () => {
      for (const r of this.ofChat(chatId).filter((x) => x.state === 'spare' || x.state === 'prepared')) await this.#remove(r);
    });
    this.#chats.delete(chatId);
  }

  /** At start: spares, unused prepared and half-made ('preparing') worktrees of chats not open here, older than a minute, go. */
  async sweep(): Promise<void> {
    for (const r of this.all()) {
      if (!['spare', 'prepared', 'preparing'].includes(r.state) || this.chat(r.chat) || now() - r.createdAt < STALE_S) continue;
      await this.#remove(r).catch((error) => log.exception(error, 'Removing subagent worktree %s failed', r.path));
    }
  }

  /** Remove an unbound worktree AIB made, its branch and its record. Never one outside AIB's worktrees folder. */
  /**
   * Remove a worktree AIB made, its branch and its record (unbound spares and prepared ones; a done or stopped one only when the web
   * process `released` it after landing). Never the user's own, never a running one, and only a path that is exactly AIB's own
   * subagent folder (security review SF 9); through removeSubagentWorktree, which unlinks junctions and links first (MF 6).
   */
  async #remove(rec: SubagentRecord, released = false): Promise<void> {
    if (rec.userHook || rec.state === 'user-hook') return; // the user's own: never AIB's to remove
    if (rec.state === 'running') return; // never from under a running subagent
    if ((rec.state === 'done' || rec.state === 'stopped') && !released) return; // landing's (P2); never lose work
    const own = ownSubagentPath(this.root, rec);
    if (own && rec.folder && wt.lexists(rec.folder)) {
      await removeSubagentWorktree(rec.path, rec.folder);
      if (/^studio\/sub-[\w.-]+$/.test(rec.branch)) await wt.git(['branch', '-D', rec.branch], rec.folder, { check: false });
    }
    if (own && wt.lexists(rec.path)) {
      try {
        unlinkLinks(rec.path);
        wt.rmtree(rec.path);
      } catch { /* in use: the start sweep tries again */ }
    }
    if (!own || !wt.lexists(rec.path)) await this.#update(rec.id, () => null);
  }
}

/** P3, Activity's words per subagent (fixed text; the owner: "Own worktree", never "Own copy"). */
export interface SubagentActivity {
  /** Where it works: "Own worktree", or "Not isolated: <reason>". Read-only types ("In your folder (read-only)") are the page's. */
  where: string;
  /** How its work lands: "Lands when the turn ends", "Merged · N files", "No changes", "Didn't land: <reason>", "Stopped — ...". */
  landing: string;
}
export const OWN_WORKTREE = 'Own worktree';
export const LANDS_AT_TURN_END = 'Lands when the turn ends';
export const STOPPED_WORDS = 'Stopped — ask the agent to merge it';

/** The landing words of one swarm subagent entry. */
export function landingWords(h: { state: string; reason?: string; merge?: { undo?: unknown } | null; landing?: { waitsFor?: string; lastRefusal?: string } | null; sub?: { files?: number; empty?: boolean } }): string {
  if (h.landing) return h.landing.waitsFor === 'touched-dirty' ? "Didn't land: files it changed have uncommitted edits" : LANDS_AT_TURN_END;
  if (h.state === 'merged') {
    if (h.sub?.empty) return 'No changes';
    if (h.merge?.undo) return 'Merge undone';
    const n = h.sub?.files ?? 0;
    return `Merged · ${n} file${n === 1 ? '' : 's'}`;
  }
  if (h.state === 'stopped') return STOPPED_WORDS;
  if (h.state === 'failed') {
    const why = h.reason === 'protected'
      ? 'it changed protected files'
      : h.reason === 'conflicts'
      ? 'it conflicts with the branch'
      : h.reason === 'no branch'
      ? "the folder isn't on a branch"
      : h.reason || 'see the chat';
    return `Didn't land: ${why}`;
  }
  return LANDS_AT_TURN_END;
}

/**
 * Security review SF 9: `rec.path` is exactly <root>\<repo hash>\sub-<...> (its project's hash when the record names it), with no
 * link or junction anywhere on the way (its real path is its own path). Anything else is never removed by AIB.
 */
export function ownSubagentPath(root: string, rec: { path: string; project?: string }): boolean {
  const path = rec.path;
  if (!path || pathFormProblem(path)) return false;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  // a Gemini or Codex chat's: <root>\<repo hash>\.gem-<chat>\sub-<...> (subagents/gemini.ts), .cx-<chat> (subagents/codex.ts)
  const chatFolder = /^\.(gem|cx)-[A-Za-z0-9_-]{1,64}$/.test(parts[parts.length - 2] ?? '') ? parts.splice(parts.length - 2, 1)[0] : '';
  const name = parts[parts.length - 1], hash = parts[parts.length - 2];
  if (!/^sub-[\w.-]+$/.test(name) || !hash) return false;
  if (rec.project && hash !== wt.repoHash(rec.project)) return false;
  const top = normcase(root).replace(/[\\/]+$/, '');
  if (normcase(parts.slice(0, -2).join(SEP)) !== top) return false;
  if (!wt.lexists(path)) return true; // gone already: only its record and branch are left
  try {
    const own = chatFolder ? pathOf(realpath(root), hash, chatFolder, name) : pathOf(realpath(root), hash, name);
    return normcase(realpath(path)) === normcase(own);
  } catch {
    return false;
  }
}

/**
 * P0b R11 / security review MF 6: every junction and symbolic link inside `dir` is removed (the link only, never what it points at)
 * before anything deletes the tree: `git worktree remove` and a recursive delete both follow junctions on Windows and would empty
 * the target (the project's node_modules, a linked package). The .git file of a worktree is a plain file, so it is left alone.
 */
export function unlinkLinks(dir: string): void {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = pathOf(dir, entry.name);
    let st: Deno.FileInfo;
    try {
      st = Deno.lstatSync(full);
    } catch {
      continue;
    }
    if (st.isSymlink) {
      try {
        Deno.removeSync(full); // non-recursive: the link or junction itself
      } catch (error) {
        log.warning('Could not unlink %s before removing a subagent worktree: %s', full, error instanceof Error ? error.message : error);
        throw error; // never go on to a delete that would follow it
      }
    } else if (st.isDirectory) unlinkLinks(full);
  }
}

/** The one way a subagent worktree folder is removed: links first (unlinkLinks), then unlock and `git worktree remove --force`. */
export async function removeSubagentWorktree(path: string, gitCwd: string): Promise<void> {
  unlinkLinks(path);
  await wt.git(['worktree', 'unlock', path], gitCwd, { check: false });
  await wt.git(['worktree', 'remove', '--force', path], gitCwd, { check: false });
}

/** `path` is a worktree of the same repository as `folder` (git common dirs equal). */
export async function sameRepository(path: string, folder: string): Promise<boolean> {
  // a body path: its form is checked before anything touches it (no \\host\share: resolving it would connect out)
  if (pathFormProblem(path) || !/^([A-Za-z]:[\\/]|\/)/.test(path) || !wt.lexists(path)) return false;
  try {
    const a = await wt.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path, { check: false });
    const b = await wt.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], folder, { check: false });
    return a.returncode === 0 && b.returncode === 0 && normcase(realpath(pyStrip(a.stdout))) === normcase(realpath(pyStrip(b.stdout)));
  } catch {
    return false;
  }
}
