/**
 * New chat from a phone (owner, phone prototypes round 2-4): project -> agent -> model -> mode -> first message -> Start chat.
 *
 *   options  the projects a chat can start in (AIB's added projects whose folder is there; the ones with the newest chats first; no
 *            folder path goes to the phone, only the PC's name, colour and a short id) and every agent with whether it can start a
 *            chat now and why not (agents/eligibility.ts, the PC's own rules), with each project's default agent. Per project and
 *            agent: the model and mode lists the agent last reported (state/agent_options.ts) with the defaults marked; when AIB
 *            has none yet it asks the agent once in the background (a quiet probe, at most every PROBE_GAP_MS) and says "loading".
 *            Every mode the agent offers is listed, with no warning (owner: "trust the users").
 *   start    the PC's own connect with the picks (applied by the agent host before the chat is ready), afterConnect, and the
 *            project's default agent set to the one used (as the PC does after a new chat; which clears the old agent's model and
 *            mode, settings.ts). The picks are for this chat only: no other default changes. Refused before anything starts: an
 *            agent that cannot start a chat, an unknown project, a message a phone may not send (the same checks as a phone
 *            message: no "/" commands, at most MAX_TEXT, pictures and files as bytes within the PC's limits), and a model or mode
 *            that is not on the agent's list. Whether the agent takes pictures or binary files is known once it opens: else the
 *            first message is held with the reason (its text and files stay on the phone). One
 *            start per phone and clientMessageId: the phone keeps the id across retries, and a Start sent again (its answer was
 *            lost) gets the chat the first one started. A list's `default` is a saved default only ('' = none: the phone sends no
 *            pick, and the chat starts with the agent's own setting, `current`). Errors to the phone are fixed words: the agent
 *            host's own (which can name folders) are logged on the PC.
 *   first    a waiter sends the first message once the chat is ready (at most OPEN_MS), with the phone's clientMessageId (the agent
 *            host drops a repeat). If the picked MODE could not be applied the message is held: the phone shows why and keeps the
 *            text (owner decision C); a model that could not be applied is said, and the message goes (as on the PC). A sign-in or a
 *            question while it opens, or the agent closing, holds it too ("Finish on your PC"); so does this phone's Start new
 *            chats switch turned off meanwhile. POST /api/remote/new/first sends a held message again (the phone's Send in that
 *            chat). Jobs live in memory: after AIB restarts the phone looks for its message in the chat by its clientMessageId.
 */
import type { WebContext } from '../web/server.ts';
import { afterConnect } from '../web/project_routes.ts';
import { settingsView } from '../web/shared.ts';
import { studioOf } from '../web/studio_routes.ts';
import { folderKey } from '../state/agent_options.ts';
import { type Eligible, eligibleAgents, reasonWords } from '../agents/eligibility.ts';
import { projectId, projectsFor } from './projects.ts';
import { projectKey } from '../desktop/project_delete.ts';
import { agentLabel, MAX_TEXT, phoneAttachments, Refusal, REFUSALS, takesOf } from './actions.ts';
import { getLogger } from '../core/log.ts';
import { wslLocOf } from '../platform/location.ts';
import { distroName } from '../wsl/access.ts';

/** Phone-side failures go to studio.log (console output only reaches stderr, which the desktop app does not keep). */
const plog = getLogger('phone_newchat');

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 300): string => (typeof v === 'string' ? v.slice(0, max) : '');

/** How long the first message waits for the chat to open. */
export const OPEN_MS = 120_000;
/** A quiet probe for an agent's model lists (it starts the agent for up to ~40 s) at most this often per agent and folder. */
export const PROBE_GAP_MS = 60_000;
/** A phone's new chat is remembered this long (its state for the phone, its first message for a retry). */
export const JOB_MS = 15 * 60_000;
const POLL_MS = 400;

export interface PhoneProjectChoice {
  id: string;
  name: string;
  color: string;
  /** chats of it on this phone's list (running and not running) */
  chats: number;
  /** its default agent for a new chat (the PC's rule) */
  agent: string;
  /**
   * A WSL project only: the agents for a chat there, by that distro's own On/Off switch (Settings > AIB Linking (WSL),
   * agentsByDistro), never the Windows one. The phone offers these instead of the top-level list for this project.
   */
  agents?: (Eligible & { why: string })[];
}

export interface OptionChoice {
  value: string;
  name: string;
}
export interface PickList {
  choices: OptionChoice[];
  /** your saved default for this agent in this project ('' = none saved: the chat starts with the agent's own setting and the
   * phone sends no pick) */
  default: string;
  /** what the agent itself uses now (marked "default" when nothing is saved; never sent as a pick) */
  current: string;
}

/** Settings' agent rows (what Settings shows: found, signed in, on). Tests in this process swap it (setAgentRows). */
let agentRows = async (ctx: WebContext): Promise<unknown> => (await settingsView(studioOf(ctx), false, { offThread: true })).agents;
export function setAgentRows(fn: ((ctx: WebContext) => Promise<unknown>) | null): void {
  agentRows = fn ?? (async (ctx: WebContext) => (await settingsView(studioOf(ctx), false, { offThread: true })).agents);
  agentCache = new WeakMap();
}

/**
 * Settings' agent list is slow to build: it looks for every agent's program in every PATH folder (with every PATHEXT) and reads
 * prerequisites' versions, mostly with synchronous file checks (1.5-7 s on a PC with a long PATH, longer while the PC is busy).
 * Built for every New chat options call, it outlasted the phone's request timeout now and then ("loading the projects fails, only
 * sometimes"). So the phone's agent list is kept AGENTS_MS and built once at a time: options calls get the kept list at once (an
 * older one too, while a new one is built behind it); a Start waits for one at most AGENTS_MS old. An agent turned on or off in
 * Settings is never served from the kept list (the agents' settings are part of its key).
 */
export const AGENTS_MS = 15_000;
interface AgentCache {
  key: string;
  at: number;
  agents: Eligible[] | null;
  busy: Promise<Eligible[]> | null;
}
let agentCache = new WeakMap<WebContext, AgentCache>();

function agentSettingsKey(ctx: WebContext): string {
  try {
    return JSON.stringify(ctx.settings.snapshot().agents);
  } catch {
    return '';
  }
}

/** The agents a new chat can start with, from Settings' agent list. `stale`: an older kept list will do (a new one is built
 * behind it); else the list is at most AGENTS_MS old. */
export async function agentsNow(ctx: WebContext, opts: { stale?: boolean; clock?: () => number } = {}): Promise<Eligible[]> {
  const clock = opts.clock ?? Date.now;
  const key = agentSettingsKey(ctx);
  let c = agentCache.get(ctx);
  if (!c || c.key !== key) agentCache.set(ctx, c = { key, at: 0, agents: null, busy: null });
  const cache = c;
  if (cache.agents && clock() - cache.at < AGENTS_MS) return cache.agents;
  cache.busy ??= (async () => {
    let rows: unknown = [];
    try {
      rows = await agentRows(ctx);
    } catch { /* the built-ins, on */ }
    return eligibleAgents(rows);
  })().then((agents) => {
    cache.agents = agents;
    cache.at = clock();
    return agents;
  }).finally(() => (cache.busy = null));
  if (opts.stale && cache.agents) {
    cache.busy.catch(() => {});
    return cache.agents;
  }
  return await cache.busy;
}

/** Added projects whose folder is there: [{path, key (projectKey), id}]. */
function projectFolders(ctx: WebContext): { path: string; id: string }[] {
  let added: Record<string, { path: string }> = {};
  try {
    added = ctx.addedProjects.public().added;
  } catch { /* none */ }
  const out: { path: string; id: string }[] = [];
  for (const item of Object.values(added)) {
    if (!item || typeof item.path !== 'string' || !item.path) continue;
    try {
      if (ctx.folderPresence.isGone(item.path)) continue;
    } catch { /* unknown: listed */ }
    const id = projectId(projectKey(item.path));
    if (!out.some((p) => p.id === id)) out.push({ path: item.path, id });
  }
  return out;
}

/** A phone's project id -> its folder on the PC, or null. */
export function folderOfProject(ctx: WebContext, id: unknown): string | null {
  if (typeof id !== 'string' || !/^[0-9a-f]{12}$/.test(id)) return null;
  return projectFolders(ctx).find((p) => p.id === id)?.path ?? null;
}

/**
 * The agents a new chat in this folder can start with: the PC's list for a Windows folder; for a WSL project the same agents, each
 * on or off by that distro's own switch (docs/wsl/linking-design.md section 12: a WSL chat reads only its distro's switch, as
 * host/studio.ts wslLaunch does; whether the distro has the agent is said when the chat starts). `why` is the phone's words.
 */
export function agentsFor(ctx: WebContext, folder: string, agents: Eligible[]): (Eligible & { why: string })[] {
  const wsl = wslLocOf(folder);
  if (!wsl) return agents.map((a) => ({ ...a, why: reasonWords(a.reason) }));
  const on = (id: string) => {
    try {
      return ctx.settings.distroAgentEnabled(wsl.distro, id);
    } catch {
      return true; // unknown: on, as an unset switch is
    }
  };
  const off = `Turned off for ${distroName(wsl.distro)} in Settings on your PC (AIB Linking (WSL)).`;
  return agents.map((a) => on(a.id) ? { ...a, ok: true, reason: '' as const, why: '' } : { ...a, ok: false, reason: 'Turned off in Settings' as const, why: off });
}

/** The default agent for a new chat in this folder (agent-choice.js loadChoice, without the PC browser's own memory). */
export function defaultAgent(ctx: WebContext, folder: string, agents: Eligible[]): string {
  const ok = (id: unknown) => typeof id === 'string' && agents.some((a) => a.id === id && a.ok);
  const defaults = obj(obj(ctx.settings.public().settings).defaults);
  const mine = obj(obj(defaults.projects)[folderKey(folder)]);
  if (ok(mine.agent)) return mine.agent as string;
  if (ok(defaults.agent)) return defaults.agent as string;
  const last = ctx.viewPrefs.public().prefs['studio-new-chat-agent'];
  if (ok(last)) return last as string;
  return agents.find((a) => a.ok)?.id ?? 'omp';
}

/** The model and mode a new chat starts with for this agent in this folder (agent-choice.js defaultPicks). */
export function defaultPicks(ctx: WebContext, folder: string, agent: string): { model: string; mode: string } {
  const defaults = obj(obj(ctx.settings.public().settings).defaults);
  const mine = obj(obj(defaults.projects)[folderKey(folder)]);
  const pick = !mine.agent || mine.agent === agent ? mine : {};
  const glob = obj(obj(defaults.byAgent)[agent]);
  return { model: str(pick.model) || str(glob.model), mode: str(pick.mode) || str(glob.mode) };
}

/** The projects and agents for the phone's New chat. `lists`: the chats on the phone's list ({folder, at}) for order and counts. */
export async function newChatOptions(
  ctx: WebContext,
  lists: { folder: string; at: number }[],
): Promise<{ projects: PhoneProjectChoice[]; agents: (Eligible & { why: string })[] }> {
  const agents = await agentsNow(ctx, { stale: true });
  const folders = projectFolders(ctx);
  const project = projectsFor(ctx, [...folders.map((f) => f.path), ...lists.map((l) => l.folder)]);
  const stats = new Map<string, { chats: number; at: number }>();
  for (const l of lists) {
    const id = project(l.folder).id;
    const s = stats.get(id) ?? { chats: 0, at: 0 };
    s.chats++;
    s.at = Math.max(s.at, l.at);
    stats.set(id, s);
  }
  const projects = folders.map((f) => {
    const p = project(f.path);
    const own = wslLocOf(f.path) ? agentsFor(ctx, f.path, agents) : null; // a WSL project: its distro's switches
    return {
      id: f.id,
      name: p.name,
      color: p.color,
      chats: stats.get(f.id)?.chats ?? 0,
      agent: defaultAgent(ctx, f.path, own ?? agents),
      ...(own ? { agents: own } : {}),
    };
  });
  projects.sort((a, b) => (stats.get(b.id)?.at ?? 0) - (stats.get(a.id)?.at ?? 0) || a.name.localeCompare(b.name));
  return { projects, agents: agents.map((a) => ({ ...a, why: reasonWords(a.reason) })) };
}

const probedAt = new Map<string, number>();

/** One option list as the phone shows it. */
function listOf(option: unknown, fallbackDefault: string): PickList | null {
  const o = obj(option);
  const choices = (Array.isArray(o.choices) ? o.choices : []).map(obj)
    .filter((c) => typeof c.value === 'string' && c.value)
    .map((c) => ({ value: str(c.value), name: str(c.name, 80) || str(c.value) }))
    .slice(0, 200);
  if (!choices.length) return null;
  const saved = fallbackDefault && choices.some((c) => c.value === fallbackDefault) ? fallbackDefault : '';
  const current = choices.some((c) => c.value === str(o.current)) ? str(o.current) : '';
  return { choices, default: saved, current };
}

/**
 * The model and mode lists of one agent for one project, with the defaults marked: what AIB remembers first; with nothing
 * remembered, a quiet probe in the background (at most every PROBE_GAP_MS) and `loading` (the phone asks again).
 */
export async function pickLists(
  ctx: WebContext,
  folder: string,
  agent: string,
  clock: () => number = Date.now,
): Promise<{ model: PickList | null; mode: PickList | null; loading: boolean; problem: string }> {
  const [status, payload] = await ctx.host.liveCall('agent-options', { agent, cwd: folder, probe: false });
  const options = status === 200 ? obj(obj(payload).options) : {};
  const defaults = defaultPicks(ctx, folder, agent);
  const model = listOf(options.model, defaults.model);
  const mode = listOf(options.mode, defaults.mode);
  if (model || mode) return { model, mode, loading: false, problem: '' };
  const key = `${agent}|${folderKey(folder)}`;
  const last = probedAt.get(key) ?? 0;
  if (clock() - last < PROBE_GAP_MS) return { model, mode, loading: last + 45_000 > clock(), problem: '' };
  probedAt.set(key, clock());
  while (probedAt.size > 200) probedAt.delete(probedAt.keys().next().value!);
  void ctx.host.liveCall('agent-options', { agent, cwd: folder, probe: true }).catch(() => {});
  return { model, mode, loading: true, problem: '' };
}

export type JobState = 'opening' | 'sent' | 'held' | 'failed' | 'pc';

interface Job {
  id: string;
  device: string;
  /** this phone may still send the first message (Start new chats and Send; read again right before it goes) */
  allowed: () => boolean;
  text: string;
  clientMessageId: string;
  /** the first message's pictures and files (checked bytes; dropped once it is sent) */
  attachments: Json[];
  state: JobState;
  error: string;
  warning: string;
  at: number;
  /** value -> name of the picked model and mode, for the words */
  names: Record<string, string>;
}

/** What the phone sends to start a chat; anything else is refused. */
export const NEW_FIELDS = new Set(['project', 'agent', 'model', 'mode', 'text', 'clientMessageId', 'attachments']);

/** The first message's checks (the same as a phone message, remote/actions.ts; what the agent can take is checked once it opens). */
export function firstText(body: Json): { text: string; clientMessageId: string; attachments: Json[] } {
  const attachments = phoneAttachments(body, null);
  const value = body.text ?? (attachments.length ? '' : undefined);
  if (typeof value !== 'string' || (!value.trim() && !attachments.length)) throw REFUSALS.empty();
  if (value.length > MAX_TEXT) throw REFUSALS.tooLong();
  if (value.trimStart().startsWith('/')) throw REFUSALS.command();
  const mid = body.clientMessageId;
  if (typeof mid !== 'string' || !mid || mid.length > 128) throw REFUSALS.bad();
  return { text: value, clientMessageId: mid, attachments };
}

/** What a phone sees when a chat could not be started (the agent host's own words, which can name folders on the PC, are logged
 * on the PC instead). */
export const START_FAILED = 'The chat could not be started on your PC. Look at AIB on your PC for why, then try again.';

export class NewChats {
  readonly #jobs = new Map<string, Job>();
  /** device + clientMessageId -> a Start still on its way (the same Start sent again waits for it instead of starting another) */
  readonly #starting = new Map<string, Promise<{ id: string; agent: string; existing: boolean }>>();

  constructor(readonly clock: () => number = Date.now, readonly openMs = OPEN_MS) {}

  #prune(): void {
    const now = this.clock();
    for (const [id, j] of this.#jobs) if (now - j.at > JOB_MS) this.#jobs.delete(id);
  }

  /** This phone's new chat: its state for the phone (never another phone's, never the text). */
  status(device: string, id: string): Json | null {
    this.#prune();
    const j = this.#jobs.get(id);
    if (!j || j.device !== device) return null;
    return { id: j.id, state: j.state, error: j.error, warning: j.warning };
  }

  job(device: string, id: string): Job | null {
    const j = this.#jobs.get(id);
    return j && j.device === device ? j : null;
  }

  /** The chat this phone started with this clientMessageId, if it is still remembered. */
  #byMessage(device: string, clientMessageId: string): Job | null {
    for (const j of this.#jobs.values()) if (j.device === device && j.clientMessageId === clientMessageId) return j;
    return null;
  }

  /**
   * Start a chat from a phone. Idempotent per phone and clientMessageId (the phone keeps the id across its retries): a Start sent
   * again after the network dropped answers with the chat the first one started (`existing`), never a second chat. Refusals are
   * thrown (Refusal). `allowed`: whether this phone may still send the first message (read again right before it goes).
   */
  async start(
    ctx: WebContext,
    device: string,
    body: Json,
    allowed: () => boolean = () => true,
  ): Promise<{ id: string; agent: string; existing: boolean }> {
    if (Object.keys(body).some((k) => !NEW_FIELDS.has(k))) throw REFUSALS.bad();
    const first = firstText(body);
    this.#prune();
    const known = this.#byMessage(device, first.clientMessageId);
    if (known) return { id: known.id, agent: '', existing: true };
    const key = `${device}|${first.clientMessageId}`;
    const running = this.#starting.get(key);
    if (running) return { ...(await running), existing: true };
    const started = this.#start(ctx, device, body, first, allowed);
    this.#starting.set(key, started);
    try {
      return await started;
    } finally {
      this.#starting.delete(key);
    }
  }

  async #start(
    ctx: WebContext,
    device: string,
    body: Json,
    first: { text: string; clientMessageId: string; attachments: Json[] },
    allowed: () => boolean,
  ): Promise<{ id: string; agent: string; existing: boolean }> {
    const folder = folderOfProject(ctx, body.project);
    if (!folder) throw new Refusal(404, 'not_found', 'This project is no longer in AIB on your PC. Pick another one.');
    const agents = agentsFor(ctx, folder, await agentsNow(ctx)); // a WSL project: its distro's switches
    const agent = agents.find((a) => a.id === body.agent);
    if (!agent) throw new Refusal(400, 'invalid', 'Pick an agent.');
    if (!agent.ok) {
      throw new Refusal(403, 'agent_unavailable', `${agent.name} cannot start a chat now: ${agent.why || agent.reason}`);
    }
    const picks: Record<string, string> = {};
    for (const kind of ['model', 'mode'] as const) {
      const v = body[kind];
      if (v === undefined || v === null || v === '') continue;
      if (typeof v !== 'string' || v.length > 300) throw REFUSALS.bad();
      picks[kind] = v;
    }
    // a pick must be on the agent's list (what the phone was shown); the names, for the words if one cannot be applied
    const names: Record<string, string> = {};
    let lists: { model: PickList | null; mode: PickList | null } = { model: null, mode: null };
    try {
      lists = await pickLists(ctx, folder, agent.id, this.clock);
      for (const l of [lists.model, lists.mode]) for (const c of l?.choices ?? []) names[c.value] = c.name;
    } catch { /* no lists: a pick is refused below */ }
    for (const kind of ['model', 'mode'] as const) {
      if (kind in picks && !(lists[kind]?.choices ?? []).some((c) => c.value === picks[kind])) {
        throw new Refusal(400, 'invalid', `${agent.name} does not offer that ${kind} now. Go back and pick the ${kind} again.`);
      }
    }
    const connect: Json = {
      provider: agent.id,
      cwd: folder,
      resume: '',
      background: true,
      ...(Object.keys(picks).length ? { picks } : {}),
    };
    const [status, payload] = await ctx.host.liveCall('connect', connect);
    const answer = obj(payload);
    if (status !== 200 || typeof answer.id !== 'string') {
      plog.error('%s', `A phone's new chat could not be started (${status}): ${str(answer.error, 600)}`);
      throw new Refusal(status >= 400 && status < 600 ? status : 500, 'failed', START_FAILED);
    }
    await afterConnect(ctx.removedProjects, connect, status, ctx.addedProjects, payload).catch(() => {});
    // the project's default agent becomes the one used (as on the PC); its model and mode stay for this chat only
    try {
      const key = folderKey(folder);
      const defaults = obj(obj(ctx.settings.public().settings).defaults);
      if (key && obj(obj(defaults.projects)[key]).agent !== agent.id) {
        await ctx.settings.update({ defaults: { projects: { [key]: { agent: agent.id } } } });
      }
    } catch (error) {
      plog.exception(error, "The project's default agent could not be saved");
    }
    this.#prune();
    const job: Job = {
      id: answer.id,
      device,
      allowed,
      text: first.text,
      clientMessageId: first.clientMessageId,
      attachments: first.attachments,
      state: 'opening',
      error: '',
      warning: '',
      at: this.clock(),
      names,
    };
    this.#jobs.set(job.id, job);
    void this.#wait(ctx, job).catch((error) => {
      job.state = 'failed';
      job.error = 'The first message could not be sent. It is in the box below: try again.';
      plog.exception(error, 'A phone new chat failed');
    });
    return { id: job.id, agent: agent.name, existing: false };
  }

  /** Wait for the chat to open, then send the first message (or hold it, saying why). */
  async #wait(ctx: WebContext, job: Job): Promise<void> {
    const until = this.clock() + this.openMs;
    while (this.clock() < until) {
      const list = obj(await ctx.host.liveList());
      const entry = (Array.isArray(list.connections) ? list.connections : []).map(obj).find((c) => c.id === job.id);
      const state = entry && !entry.closed
        ? obj(await ctx.host.liveState(job.id, Math.max(1, Math.trunc(Number(entry.cursor) || 0))))
        : null;
      if (!state || state.closed) {
        if (str(state?.error, 400)) plog.error('%s', `A phone's new chat closed while it was opening: ${str(state?.error, 400)}`);
        job.state = 'failed';
        job.error = 'The chat closed while it was opening. Your message was not sent. Look at AIB on your PC for why.';
        return;
      }
      if ((Array.isArray(state.elicitations) && state.elicitations.length) || state.auth) {
        job.state = 'pc';
        job.error = 'This chat needs a sign-in or an answer before it can start. Finish on your PC, then send your message here.';
        return;
      }
      if (state.ready) {
        const results = (Array.isArray(state.pickResults) ? state.pickResults : []).map(obj).filter((r) => r.ok === false);
        const said = (r: Json) => `${job.names[str(r.value)] || str(r.value)}: ${str(r.message, 300) || 'refused'}`;
        const mode = results.find((r) => r.kind === 'mode');
        if (mode) {
          job.state = 'held';
          job.error = `The mode could not be set (${said(mode)}). The chat is open with the agent's own mode; ` +
            'your message was not sent. Send it from here, or change the mode on your PC first.';
          return;
        }
        const others = results.filter((r) => r.kind !== 'mode');
        if (others.length) {
          job.warning = `Could not apply ${others.map((r) => `${r.kind === 'model' ? 'the model' : r.kind} ${said(r)}`).join(' · ')}. ` +
            'The chat started with the agent default.';
        }
        if (job.attachments.length) {
          try {
            phoneAttachments({ attachments: job.attachments }, takesOf(state), agentLabel(state.provider));
          } catch (error) {
            if (!(error instanceof Refusal)) throw error;
            job.state = 'held';
            job.error = `${error.message} Your message was not sent: it is in the box below.`;
            return;
          }
        }
        if (!job.allowed()) {
          job.state = 'failed';
          job.error = 'Starting chats from this phone was turned off on your PC while this one opened. Your message was not sent; ' +
            'the chat is open on your PC.';
          return;
        }
        await this.send(ctx, job);
        return;
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    job.state = 'failed';
    job.error = 'The chat did not open in time. Your message was not sent: it is in the box below.';
  }

  /** Send the job's first message (again). */
  async send(
    ctx: WebContext,
    job: Job,
    text = job.text,
    clientMessageId = job.clientMessageId,
    attachments = job.attachments,
  ): Promise<[number, Json]> {
    const [status, payload] = await ctx.host.liveCall('prompt', {
      id: job.id,
      text,
      clientMessageId,
      ...(attachments.length ? { attachments } : {}),
    });
    const answer = obj(payload);
    if (status === 200) {
      job.state = 'sent';
      job.error = '';
      job.text = '';
      job.attachments = [];
    } else {
      job.state = 'failed';
      job.text = text;
      job.attachments = attachments;
      job.clientMessageId = clientMessageId;
      if (str(answer.error, 400)) plog.error('%s', `A phone's first message was not sent (${status}): ${str(answer.error, 400)}`);
      job.error = 'Your first message was not sent. It is in the box below: send it again.';
    }
    return [status, answer];
  }
}
