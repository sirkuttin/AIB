/**
 * What the phone reads: small payloads built for a phone on a mobile link (review break 8), not the page's /api/live/* answers.
 *
 *   home   every live chat with its title, project (name and colour, no path), agent, state, whether it waits for you, your
 *          turn, unread, when it last changed state (the list's order: newest change first) and its card's last line. One plain
 *          list: no main chat, no sections (owner, phone prototypes round 2). Under HOME_BUDGET bytes. A revision lets the phone
 *          poll cheaply (304 when nothing changed).
 *   chat   the last N events of one live chat, images replaced by URLs (/api/remote/image, cookie only) and other file bytes
 *          dropped; no model-in-use lookup, no settings, no permission bodies beyond a title. Artifact links (absolute loopback
 *          URLs of the PC's artifact origin, in live events and in the history a chat replays) point at the phone's artifact
 *          origin https://<name>:8443 instead (Phase D); what is stored is never changed.
 */
import { createHash } from 'node:crypto';
import type { WebContext } from '../web/server.ts';
import { permissionDetail, type PhoneOption, phoneOptions } from './actions.ts';
import { type PhoneProject, projectsFor } from './projects.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const DEFAULT_TAIL = 200;
export const MAX_TAIL = 1000;
/** Image types the phone may load (never SVG: it can carry script). */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', omp: 'OMP', codex: 'Codex', gemini: 'Gemini' };

export function agentName(provider: unknown): string {
  const p = str(provider, 60);
  return AGENT_NAMES[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Agent');
}

function folderName(cwd: unknown): string {
  const parts = str(cwd, 1000).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}

export interface Helper {
  id: string;
  title: string;
  state: string;
}

export interface HomeChat {
  id: string;
  /** provider:sessionId: the chat's stable key (its card menu acts on it; its artifacts are filed under it). */
  key: string;
  title: string;
  agent: string;
  folder: string;
  /** The project the chat belongs to (remote/projects.ts): a short id, the PC's name for it and its colour. */
  project: PhoneProject;
  state: string;
  needs: number;
  busySince: string | null;
  turnEndedAt: string | null;
  yourTurn: boolean;
  /** Finished and not read yet on the PC, or marked unread (the PC's unread dot). */
  unread: boolean;
  /** When the chat last changed state (started working, asked, finished; a message you send starts it working). The list's order. */
  changedAt: string;
  /** The card's last line: what it asks, the step it works on, or the last message ('' until the PC has read it once). */
  line: string;
}

export interface Home {
  revision: string;
  pcName: string;
  /** Newest change of state first. */
  chats: HomeChat[];
}

/** The most a home answer may weigh (the phone polls it every 4 s on a mobile link): longer last lines are cut first. */
export const HOME_BUDGET = 64 * 1024;
export const LINE_MAX = 140;
/** How long a home answer waits for the card lines that changed (a slow agent host never holds the list up longer). */
export const LINE_WAIT_MS = 800;
/** Chats that finished before this AIB started and were never read count as read (the PC page does the same from its start). */
const STARTED = Date.now();

type Phase = 'needs_you' | 'working' | 'opening' | 'idle';
const phaseOf = (attention: Json): Phase => {
  const s = str(attention.state, 20);
  return s === 'needs_you' || s === 'working' || s === 'opening' ? s : 'idle';
};
const ms = (iso: unknown): number => (typeof iso === 'string' ? Date.parse(iso) || 0 : 0);

/**
 * When each live chat last changed state, kept while AIB runs: fed by the AttentionWatcher's look at the chat list every 2 s
 * (watcher.ts onList) and by every home answer. Working takes the turn's start, idle the turn's end; asking (and opening) the
 * time it was first seen. A chat seen for the first time takes the best time its list entry has.
 */
export class StateTimes {
  readonly #at = new Map<string, { phase: Phase; at: number }>();
  constructor(readonly clock: () => number = Date.now) {}

  #first(phase: Phase, attention: Json, now: number): number {
    if (phase === 'working') return ms(attention.busySince) || now;
    if (phase === 'idle') return ms(attention.turnEndedAt) || ms(attention.busySince);
    return now;
  }

  /** One look at the agent host's chat list. */
  see(listing: unknown): void {
    const now = this.clock();
    const seen = new Set<string>();
    for (const raw of Array.isArray(obj(listing).connections) ? obj(listing).connections as unknown[] : []) {
      const c = obj(raw);
      const id = str(c.id, 100);
      if (!id || c.closed) continue;
      seen.add(id);
      this.#see(id, obj(c.attention), now);
    }
    for (const id of [...this.#at.keys()]) if (!seen.has(id)) this.#at.delete(id);
  }

  #see(id: string, attention: Json, now: number): number {
    const phase = phaseOf(attention);
    const old = this.#at.get(id);
    if (old && old.phase === phase) return old.at;
    let at: number;
    if (!old) at = this.#first(phase, attention, now);
    else if (phase === 'working') at = ms(attention.busySince) || now;
    else if (phase === 'idle') at = ms(attention.turnEndedAt) || now;
    else at = now;
    this.#at.set(id, { phase, at });
    while (this.#at.size > 2000) this.#at.delete(this.#at.keys().next().value!);
    return at;
  }

  /** When this chat last changed state (ms; 0 when unknown). */
  changedAt(id: string, attention: Json): number {
    return this.#see(id, attention, this.clock());
  }
}

/** The card line of a chat from its newest events and what waits: what it asks, the step it works on, the last message. */
export function lineOf(state: Json): string {
  const cut = (t: string) => {
    const s = t.replace(/\s+/g, ' ').trim();
    return s.length > LINE_MAX ? s.slice(0, LINE_MAX - 1) + '…' : s;
  };
  const perms = Array.isArray(state.permissions) ? state.permissions : [];
  if (perms.length) {
    const { title, detail } = permissionDetail(obj(obj(perms[0]).params));
    return cut('Wants to run: ' + (detail || title));
  }
  const asks = Array.isArray(state.elicitations) ? state.elicitations : [];
  if (asks.length) {
    const m = obj(obj(asks[0]).params).message;
    return cut('Asks: ' + (typeof m === 'string' && m.trim() ? m : 'a question'));
  }
  let message = '';
  let who = '';
  let step = '';
  const running = new Map<string, string>();
  for (const raw of Array.isArray(state.events) ? state.events : []) {
    const e = obj(raw);
    const data = obj(e.data);
    if (e.kind === 'user') {
      who = 'you';
      message = typeof data.text === 'string' ? data.text : '';
      continue;
    }
    if (e.kind !== 'update') continue;
    const u = obj(data.update);
    if (u.sessionUpdate === 'agent_message_chunk') {
      const t = typeof obj(u.content).text === 'string' ? obj(u.content).text as string : '';
      if (who === 'agent') message += t;
      else {
        who = 'agent';
        message = t;
      }
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const id = str(u.toolCallId, 200);
      if (u.sessionUpdate === 'tool_call' && who === 'agent') who = 'steps'; // a new agent message after steps starts over
      if (!id) continue;
      const done = u.status === 'completed' || u.status === 'failed';
      if (done) running.delete(id);
      else running.set(id, str(u.title, 200) || running.get(id) || 'Step');
    }
  }
  if (state.busy && running.size) step = [...running.values()].at(-1)!;
  if (step) return cut('Working on: ' + step);
  if (!message.trim()) return '';
  return cut((who === 'you' ? 'You: ' : '') + message);
}

/**
 * What the phone's home knows of live chats beyond the list: remembered first prompts (for chats with no other title), each chat's
 * card line (looked up again in the background when the chat moved on), and when each changed state (StateTimes).
 */
export class TitleCache {
  readonly titles = new Map<string, string>();
  readonly times = new StateTimes();
  /** id -> [signature (cursor and what waits), line] */
  readonly lines = new Map<string, [string, string]>();
  #busy = false;
  #queue: string[] = [];
  #lineQueue = new Map<string, string>();
  #lineBusy = false;

  want(ctx: WebContext, id: string): void {
    if (this.titles.has(id) || this.#queue.includes(id)) return;
    this.#queue.push(id);
    void this.#run(ctx);
  }

  /** The AttentionWatcher's look at the chat list (state-change times stay right while no phone looks). */
  seeList(listing: unknown): void {
    this.times.see(listing);
  }

  /** The card line known for this chat now; looked up again in the background when `sig` changed. */
  line(ctx: WebContext, id: string, sig: string, cursor: number): string {
    const known = this.lines.get(id);
    if (!known || known[0] !== sig) {
      this.#lineQueue.set(id, sig + '\n' + cursor);
      void this.#runLines(ctx);
    }
    return known ? known[1] : '';
  }

  #lineWaiters: (() => void)[] = [];

  /** Wait (at most `ms`) for the lines asked for to be looked up, so an answer carries them and its revision holds still. */
  settleLines(ms: number): Promise<void> {
    if (!this.#lineBusy && !this.#lineQueue.size) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.#lineWaiters.push(done);
    });
  }

  async #runLines(ctx: WebContext): Promise<void> {
    if (this.#lineBusy) return;
    this.#lineBusy = true;
    try {
      while (this.#lineQueue.size) {
        const [id, job] = this.#lineQueue.entries().next().value!;
        this.#lineQueue.delete(id);
        const [sig, cursorText] = job.split('\n');
        const cursor = Number(cursorText) || 0;
        let line = this.lines.get(id)?.[1] ?? '';
        try {
          // the newest events only; never cursor 0 (that read also refreshes the account's usage limits)
          const state = obj(await ctx.host.liveState(id, Math.max(1, cursor - 80)));
          if (state.id || Array.isArray(state.events)) line = lineOf(state);
        } catch { /* gone */ }
        this.lines.set(id, [sig, line]);
        while (this.lines.size > 500) this.lines.delete(this.lines.keys().next().value!);
      }
    } finally {
      this.#lineBusy = false;
      for (const w of this.#lineWaiters.splice(0)) w();
    }
  }

  async #run(ctx: WebContext): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#queue.length) {
        const id = this.#queue.shift()!;
        let title = '';
        try {
          const state = obj(await ctx.host.liveState(id, 0));
          const events = Array.isArray(state.events) ? state.events : [];
          const first = events.find((e) => obj(e).kind === 'user');
          title = str(obj(obj(first).data).text, 170);
        } catch { /* gone */ }
        this.titles.set(id, title);
        while (this.titles.size > 500) this.titles.delete(this.titles.keys().next().value!);
      }
    } finally {
      this.#busy = false;
    }
  }
}

function helpersOf(subagents: unknown): Helper[] {
  const out: Helper[] = [];
  for (const [id, raw] of Object.entries(obj(subagents))) {
    const a = obj(raw);
    out.push({ id, title: str(a.title, 120) || str(a.description, 120) || 'Subagent', state: str(a.state, 40) || 'unknown' });
  }
  return out.slice(-30);
}

export function revisionOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

/** Cut the cards' last lines (longest first) until the answer fits `budget` bytes. */
export function fitBudget<T extends { line: string }>(cards: T[], size: () => number, budget = HOME_BUDGET): void {
  let over = size() - budget;
  if (over <= 0) return;
  for (const c of [...cards].sort((a, b) => b.line.length - a.line.length)) {
    if (over <= 0) break;
    const cut = Math.min(c.line.length, over + 1);
    c.line = c.line.length - cut > 20 ? c.line.slice(0, c.line.length - cut - 1) + '…' : '';
    over = size() - budget;
  }
}

export async function homePayload(ctx: WebContext, pcName: string, titles: TitleCache): Promise<Home> {
  const listing = obj(await ctx.host.liveList());
  const marks = ctx.conversations.public().entries;
  const read = ctx.readState.public().chats;
  const names = ctx.viewPrefs.chatNames(); // Rename, on the PC or a phone
  const raws = (Array.isArray(listing.connections) ? listing.connections : []).map(obj).filter((c) => !c.closed && str(c.id, 100));
  const project = projectsFor(ctx, raws.map((c) => str(c.projectRoot, 2000) || str(c.cwd, 2000)));
  const chats: (HomeChat & { at: number })[] = [];
  for (const c of raws) {
    const id = str(c.id, 100);
    const key = `${str(c.provider, 60)}:${str(c.sessionId, 200)}`;
    const mark = obj(marks[key]);
    if (mark.archivedAt || mark.deletedAt) continue;
    const attention = obj(c.attention);
    const sessionTitle = str(obj(obj(c.breadth).sessionInfo).title, 170);
    let title = str(names[key], 170) || str(mark.title, 170) || sessionTitle;
    if (!title) {
      title = titles.titles.get(id) ?? '';
      if (!titles.titles.has(id)) titles.want(ctx, id);
    }
    const agent = agentName(c.provider);
    const folder = folderName(c.projectRoot || c.cwd);
    const at = titles.times.changedAt(id, attention);
    const ended = ms(attention.turnEndedAt);
    const seen = Number(obj(read[key]).seenAt) || 0;
    const needs = Number(attention.needs) || 0;
    const asks = (Array.isArray(c.elicitations) ? c.elicitations : []).map((e) => str(obj(e).key, 100)).join(',');
    const marked = Number(obj(read[key]).markedUnreadAt) || 0;
    chats.push({
      id,
      key,
      title: title || `${agent}${folder ? ' in ' + folder : ''}`,
      agent,
      folder,
      project: project(str(c.projectRoot, 2000) || str(c.cwd, 2000)),
      state: str(attention.state, 20) || 'idle',
      needs,
      busySince: (attention.busySince as string | null) ?? null,
      turnEndedAt: (attention.turnEndedAt as string | null) ?? null,
      yourTurn: Number(mark.yourTurnAt) > 0 && !mark.holdAt,
      unread: (phaseOf(attention) === 'idle' && ended > (seen || STARTED)) || marked > seen,
      changedAt: at ? new Date(at).toISOString() : '',
      line: titles.line(ctx, id, `${Number(c.cursor) || 0}|${needs}|${asks}|${c.busy ? 1 : 0}`, Number(c.cursor) || 0),
      at,
    });
  }
  // the lines that changed are looked up now (the newest events of those chats), within LINE_WAIT_MS
  await titles.settleLines(LINE_WAIT_MS);
  for (const c of chats) c.line = titles.lines.get(c.id)?.[1] ?? c.line;
  chats.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title));
  const list: HomeChat[] = chats.map(({ at: _at, ...c }) => c);
  const body = { pcName, chats: list };
  fitBudget(list, () => new TextEncoder().encode(JSON.stringify(body)).byteLength);
  return { revision: revisionOf(body), ...body };
}

/** A loopback artifact URL's origin (any port: history may come from an AIB that ran on another one), when an artifact path or
 * the libraries follow. Other loopback URLs (an agent's dev server) are left alone. */
const LOOPBACK_ARTIFACT = /\bhttps?:\/\/(?:127\.0\.0\.1|localhost):[0-9]{1,5}(?=\/(?:a\/[0-9a-f]{16}\/v[0-9]{1,6}\/|_lib\/))/g;

/** A copy of `value` with every loopback artifact URL in its strings moved to `origin` (the phone's artifact origin). */
export function withArtifactOrigin(value: unknown, origin: string): unknown {
  if (!origin) return value;
  if (typeof value === 'string') return value.includes('://') ? value.replace(LOOPBACK_ARTIFACT, origin) : value;
  if (Array.isArray(value)) return value.map((v) => withArtifactOrigin(v, origin));
  if (!value || typeof value !== 'object') return value;
  const out: Json = {};
  for (const [k, v] of Object.entries(value as Json)) out[k] = withArtifactOrigin(v, origin);
  return out;
}

/** A copy of `value` with image bytes replaced by URLs and other embedded file bytes dropped. */
export function withoutBytes(value: unknown, image: (n: number, mime: string) => string, counter = { n: 0 }): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutBytes(v, image, counter));
  if (!value || typeof value !== 'object') return value;
  const out: Json = {};
  const src = value as Json;
  const mime = typeof src.mimeType === 'string' ? src.mimeType.toLowerCase() : '';
  const isImage = typeof src.data === 'string' && (src.type === 'image' || mime.startsWith('image/'));
  for (const [k, v] of Object.entries(src)) {
    if (k === 'data' && typeof v === 'string' && (isImage || mime || src.type === 'audio')) continue; // file bytes (base64)
    if (k === 'blob' && typeof v === 'string') continue; // embedded resource bytes
    out[k] = withoutBytes(v, image, counter);
  }
  if (isImage) {
    const n = counter.n++;
    if (IMAGE_TYPES.has(mime)) out.url = image(n, mime);
    out.bytesLeftOnPc = true;
  }
  return out;
}

/** The nth image (in withoutBytes' order) of one event: its base64 bytes and type, or null. */
export function imageOf(event: unknown, n: number): { data: string; mime: string } | null {
  let count = 0;
  let found: { data: string; mime: string } | null = null;
  const walk = (value: unknown) => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) return value.forEach(walk);
    const src = value as Json;
    const mime = typeof src.mimeType === 'string' ? src.mimeType.toLowerCase() : '';
    if (typeof src.data === 'string' && (src.type === 'image' || mime.startsWith('image/'))) {
      if (count++ === n) found = IMAGE_TYPES.has(mime) ? { data: src.data, mime } : null;
      // its own fields hold no further images
      for (const [k, v] of Object.entries(src)) if (k !== 'data') walk(v);
      return;
    }
    for (const v of Object.values(src)) walk(v);
  };
  walk(event);
  return found;
}

export interface ChatPayload {
  id: string;
  title: string;
  agent: string;
  folder: string;
  /** The project the chat belongs to (name and colour, as on its card). */
  project: PhoneProject;
  state: string;
  needs: number;
  busy: boolean;
  /** Working and the agent can read a message during the turn (the phone's Send then goes in at once). */
  steerable: boolean;
  busySince: string | null;
  cursor: number;
  reset: boolean;
  /** The first event sent (the phone shows "earlier messages are on your PC" when it is not the chat's first). */
  firstSeq: number;
  truncated: boolean;
  helpers: Helper[];
  /** What waits for you: what the sheets need (permission: only the options a phone may pick; question: the form). */
  waiting: Waiting[];
  /** Can take a message now (ready, not read only). */
  ready: boolean;
  /** The connection has ended (the phone offers Continue this chat, by savedKey). */
  closed: boolean;
  /** provider:sessionId, the chat's stable key ('' before the agent gave it a session). */
  savedKey: string;
  /** Why it ended or could not open ('' when it did not). */
  error: string;
  /** Messages waiting to be sent in this chat (text, whether one is being sent or edited). */
  queue: { items: QueuedItem[]; paused: boolean; message: string };
  /** Messages that may or may not have reached the agent before AIB restarted. */
  unknown: { clientMessageId: string; at: number }[];
  events: unknown[];
}

export interface QueuedItem {
  id: string;
  text: string;
  files: number;
  sending: boolean;
  editing: boolean;
}

export interface Waiting {
  kind: 'permission' | 'question' | 'sign-in';
  title: string;
  key?: string;
  /** permission: the command or file it is about. */
  detail?: string;
  /** permission: the options a phone may pick (allow / deny once). */
  options?: PhoneOption[];
  /** permission: options left on the PC (Allow always and the like). */
  hidden?: number;
  /** Must be answered on the PC (a link question, AIB's merge request, sign-in, or no once-only option). */
  pcOnly?: boolean;
  /** question: the form's fields (the agent's requestedSchema). */
  schema?: unknown;
}

export async function chatPayload(
  ctx: WebContext,
  id: string,
  tail: number,
  after: number,
  titles: TitleCache,
  artifactOrigin = '',
): Promise<ChatPayload | null> {
  const state = await ctx.host.liveState(id, after) as Json | null;
  if (!state) return null;
  const all = Array.isArray(state.events) ? state.events : [];
  const n = Math.max(1, Math.min(MAX_TAIL, Math.trunc(tail) || DEFAULT_TAIL));
  const events = all.slice(-n);
  const attention = obj(state.attention);
  const waiting: Waiting[] = [];
  for (const p of Array.isArray(state.permissions) ? state.permissions : []) {
    const params = obj(obj(p).params);
    const { title, detail } = permissionDetail(params);
    const picked = phoneOptions(params);
    waiting.push({
      kind: 'permission',
      key: str(obj(p).key, 100),
      title,
      detail,
      options: picked.options,
      hidden: picked.hidden,
      pcOnly: picked.pcOnly,
    });
  }
  for (const e of Array.isArray(state.elicitations) ? state.elicitations : []) {
    const params = obj(obj(e).params);
    const form = params.mode === 'form';
    waiting.push({
      kind: 'question',
      key: str(obj(e).key, 100),
      title: typeof params.message === 'string' && params.message.trim() ? params.message.slice(0, 2000) : 'An agent has a question',
      pcOnly: !form,
      ...(form ? { schema: params.requestedSchema ?? {} } : {}),
    });
  }
  if (state.auth) waiting.push({ kind: 'sign-in', title: 'An agent needs you to sign in', pcOnly: true });
  const queue = obj(state.queue);
  const queued: QueuedItem[] = (Array.isArray(queue.items) ? queue.items : []).map(obj).map((i) => ({
    id: str(i.id, 128),
    text: typeof i.text === 'string' ? i.text.slice(0, 8000) : '',
    files: Array.isArray(i.attachments) ? i.attachments.length : 0,
    sending: !!i.sending,
    editing: !!i.editing,
  }));
  const unknown = (Array.isArray(state.unknownReceipts) ? state.unknownReceipts : []).map(obj)
    .filter((r) => typeof r.clientMessageId === 'string')
    .map((r) => ({ clientMessageId: r.clientMessageId as string, at: Number(r.at) || 0 }));
  const marks = ctx.conversations.public().entries;
  const mark = obj(marks[`${str(state.provider, 60)}:${str(state.sessionId, 200)}`]);
  const agent = agentName(state.provider);
  const folder = folderName(state.projectRoot || state.cwd);
  const name = ctx.viewPrefs.chatNames()[`${str(state.provider, 60)}:${str(state.sessionId, 200)}`];
  const title = str(name, 170) || str(mark.title, 170) || str(obj(obj(state.breadth).sessionInfo).title, 170) || titles.titles.get(id) ||
    `${agent}${folder ? ' in ' + folder : ''}`;
  const root = str(state.projectRoot, 2000) || str(state.cwd, 2000);
  return {
    id,
    title,
    agent,
    folder,
    project: projectsFor(ctx, [root])(root),
    state: str(attention.state, 20) || 'idle',
    needs: Number(attention.needs) || 0,
    busy: !!state.busy,
    steerable: !!state.busy && state.steerable === true,
    busySince: (attention.busySince as string | null) ?? null,
    cursor: Number(state.cursor) || 0,
    reset: !!state.reset,
    firstSeq: Number(obj(events[0]).seq) || 0,
    truncated: all.length > events.length,
    helpers: helpersOf(state.subagents),
    waiting,
    ready: !!state.ready && !state.readOnly && !state.rebuilding && !state.closed,
    closed: !!state.closed,
    savedKey: str(state.provider, 60) && str(state.sessionId, 300) ? `${str(state.provider, 60)}:${str(state.sessionId, 300)}` : '',
    error: state.closed ? str(state.error, 400) : '',
    queue: { items: queued, paused: !!queue.paused, message: str(queue.message, 120) },
    unknown,
    events: events.map((e) => {
      const seq = Number(obj(e).seq) || 0;
      const light = withoutBytes(e, (k) => `/api/remote/image?id=${encodeURIComponent(id)}&seq=${seq}&n=${k}`);
      return withArtifactOrigin(light, artifactOrigin);
    }),
  };
}
