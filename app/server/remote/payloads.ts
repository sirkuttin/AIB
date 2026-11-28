/**
 * What the phone reads: small payloads built for a phone on a mobile link (review break 8), not the page's /api/live/* answers.
 *
 *   home   every live chat with its title, project (name and colour, no path), agent, state, whether it waits for you, your
 *          turn, unread, when it last changed state (the list's order: newest change first) and its card's last line. One plain
 *          list: no main chat, no sections (owner, phone prototypes round 2). Under HOME_BUDGET bytes. A revision lets the phone
 *          poll cheaply (304 when nothing changed).
 *   chat   the newest page of one live chat's events (by bytes, never starting inside a message or a run of steps; before=<seq>
 *          pages back), images replaced by URLs (/api/remote/image, cookie only) and other file bytes dropped; no model-in-use lookup, no settings, no permission bodies beyond a title. Artifact links (absolute loopback
 *          URLs of the PC's artifact origin, in live events and in the history a chat replays) point at the phone's artifact
 *          origin https://<name>:8443 instead (Phase D); what is stored is never changed.
 */
import { claudeBase } from '../agents/claude_family.ts';
import { createHash } from 'node:crypto';
import type { WebContext } from '../web/server.ts';
import { ConversationState, type Marks } from '../state/conversations.ts';
import { permissionDetail, type PhoneOption, phoneOptions } from './actions.ts';
import { type PhoneProject, projectsFor } from './projects.ts';
import { INBOX } from '../attention/inbox_rules.ts';
import { hiddenChats, readHelpers } from '../swarm/registry.ts';
import type { Inbox } from '../attention/inbox.ts';
import { clipEvent, type Ev, rowStarts, sessionOf } from '../acp/event_pages.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const DEFAULT_TAIL = 200;
/** The phone's open page budget (history loading: the tail is sized by bytes). */
export const PHONE_PAGE_BYTES = 256 * 1024;
export const MAX_TAIL = 1000;
/** Load earlier (before=<seq>): the most one older page may weigh, and the least. */
export const PHONE_OLDER_MAX = 512 * 1024;
export const PHONE_OLDER_MIN = 16 * 1024;
/** Show output: one event whole, but never more text per string than this (a phone on mobile data). */
export const PHONE_EVENT_CHARS = 1_000_000;
/** Image types the phone may load (never SVG: it can carry script). */
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const AGENT_NAMES: Record<string, string> = { claude: 'Claude Code', omp: 'OMP', codex: 'Codex', gemini: 'Gemini' };

export function agentName(provider: unknown): string {
  const p = claudeBase(str(provider, 60));
  return AGENT_NAMES[p] ?? (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Agent');
}

function folderName(cwd: unknown): string {
  const parts = str(cwd, 1000).split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}

/** One subagent as the phone gets it: the facts the PC's Activity names and sorts it by (subagents-ui.js classify / names /
 * worktreeWords run on the phone): its title (often its type, "general-purpose"), the task's description, the agent's state and
 * stop reason, and where it works and how its work lands ({where, landing} from subagent worktrees P3) when AIB knows. */
export interface Helper {
  id: string;
  title: string;
  description?: string;
  state: string;
  stopReason?: string;
  where?: string;
  landing?: string;
  /** The model it runs, as the agent names it ("sonnet", "Opus 5.5"), and when it started and ended (seconds). Row line 2. */
  model?: string;
  startedAt?: number;
  endedAt?: number;
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
  /** The inbox's phase (inbox-rules.js phaseOf): needs_you, failed, asks, working, your_turn, idle, opening. */
  phase: string;
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
  /** What it waits on first (the phone's inbox card answers it from home): an approval or a question, or null. Additive. */
  ask: HomeAsk | null;
  /** A listed helper (left-list helpers, owner 2026-11-27): the key of its main chat, and when it was listed (seconds). Additive. */
  under?: string;
  listedAt?: number;
  /** The PC's manual order of its left list (drag to reorder): 1 = first of its section. Only present once placed by hand. Additive. */
  rank?: number;
}

/** The first request a chat waits on, as the phone's inbox card needs it (only the options a phone may pick: allow/deny once). */
export interface HomeAsk {
  kind: 'permission' | 'question';
  key: string;
  title: string;
  detail: string;
  options: PhoneOption[];
  pcOnly: boolean;
}

export interface Home {
  revision: string;
  pcName: string;
  /** Chats blocked on you (needs you, failed, asks, stalled): the server-built inbox's count, the PC's badge and the trays. */
  waiting: number;
  /** Newest change of state first. */
  chats: HomeChat[];
  /** The server-built inbox (attention/inbox.ts): the same rows the PC's inbox draws. The phone's inbox draws only these. */
  inbox?: Inbox;
}

/** The most a home answer may weigh (the phone polls it every 4 s on a mobile link): longer last lines are cut first. */
export const HOME_BUDGET = 64 * 1024;
export const LINE_MAX = 140;
/** How long a home answer waits for the card lines that changed (a slow agent host never holds the list up longer). */
export const LINE_WAIT_MS = 800;
/** Chats that finished before AIB first ran and were never read count as read: the PC page's own start (studio-sidebar-epoch,
 * kept in the view preferences, sidebar-ui.js), so the phone and the PC show the same unread dots; this process's start only
 * when the PC page never ran. */
const STARTED = Date.now();
export function unreadEpoch(ctx: WebContext): number {
  const pc = Number(ctx.viewPrefs.public().prefs['studio-sidebar-epoch']);
  return Number.isFinite(pc) && pc > 0 ? pc : STARTED;
}

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
export function lineOf(state: Json, after = 0): string {
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
  // the card reads only the newest events: an agent message already going when they start is cut at its front (`partial`)
  let partial = false;
  const running = new Map<string, string>();
  const events = Array.isArray(state.events) ? state.events : [];
  // `after`: the events start after this seq (the card reads the newest ones); 1 counts as the start (seq 1 opens a chat, not a reply)
  const cutFront = after > 1 && (Number(obj(events[0]).seq) || 0) > 1;
  const main = str(state.sessionId, 200);
  for (const raw of events) {
    const e = obj(raw);
    const data = obj(e.data);
    if (main && typeof data.sessionId === 'string' && data.sessionId && data.sessionId !== main) continue; // a subagent's own
    if (e.kind === 'user') {
      partial = false;
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
        partial = who === '' && cutFront;
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
  const line = plainLine(message, who !== 'you' && partial);
  if (!line) return '';
  return cut((who === 'you' ? 'You: ' : '') + line);
}

/** The first request a chat's state waits on (an approval, else a question), or null: the phone inbox card's line 1 and buttons. */
export function askOf(state: Json): HomeAsk | null {
  const perms = Array.isArray(state.permissions) ? state.permissions : [];
  if (perms.length) {
    const params = obj(obj(perms[0]).params);
    const { title, detail } = permissionDetail(params);
    const picked = phoneOptions(params);
    return { kind: 'permission', key: str(obj(perms[0]).key, 100), title, detail: detail.slice(0, 400), options: picked.options, pcOnly: picked.pcOnly };
  }
  const asks = Array.isArray(state.elicitations) ? state.elicitations : [];
  if (asks.length) {
    const params = obj(obj(asks[0]).params);
    const m = typeof params.message === 'string' && params.message.trim() ? params.message.slice(0, 400) : 'An agent has a question';
    return { kind: 'question', key: str(obj(asks[0]).key, 100), title: m, detail: '', options: [], pcOnly: params.mode !== 'form' };
  }
  return null;
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
  /** id -> the first request it waits on (askOf), looked up with its line */
  readonly asks = new Map<string, HomeAsk | null>();
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
          const from = Math.max(1, cursor - 80);
          const state = obj(await ctx.host.liveState(id, from));
          if (state.id || Array.isArray(state.events)) {
            line = lineOf(state, from);
            this.asks.set(id, askOf(state));
          }
        } catch { /* gone */ }
        this.lines.set(id, [sig, line]);
        while (this.lines.size > 500) this.lines.delete(this.lines.keys().next().value!);
        while (this.asks.size > 500) this.asks.delete(this.asks.keys().next().value!);
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
          title = plainTitle(obj(obj(first).data).text);
        } catch { /* gone */ }
        this.titles.set(id, title);
        while (this.titles.size > 500) this.titles.delete(this.titles.keys().next().value!);
      }
    } finally {
      this.#busy = false;
    }
  }
}

/** The most subagents a chat answer lists: every one still running first, then the newest ended ones (`helpersMore` counts the rest). */
export const HELPERS_MAX = 100;
const ENDED = /^(idle|completed?|failed|error|cancell?ed|canceled|stopped|killed|interrupted|unknown)$/i;

export function helpersOf(subagents: unknown, worktrees?: unknown): { helpers: Helper[]; more: number } {
  const wt = obj(worktrees);
  const all: Helper[] = [];
  for (const [id, raw] of Object.entries(obj(subagents))) {
    const a = obj(raw);
    const h: Helper = { id, title: str(a.title, 120), state: str(a.state, 40) || 'unknown' };
    const d = str(a.description, 200);
    if (d) h.description = d;
    const why = str(a.stopReason, 40);
    if (why) h.stopReason = why;
    const model = str(a.model, 80);
    if (model) h.model = model;
    const t0 = Number(a.startedAt);
    if (t0 > 0) h.startedAt = t0;
    const t1 = Number(a.endedAt);
    if (t1 > 0) h.endedAt = t1;
    const w = obj(wt[id]);
    if (str(w.where, 200)) {
      h.where = str(w.where, 200);
      const landing = str(w.landing, 200);
      if (landing) h.landing = landing;
    }
    all.push(h);
  }
  if (all.length <= HELPERS_MAX) return { helpers: all, more: 0 };
  const running = all.filter((h) => !ENDED.test(h.state)).slice(-HELPERS_MAX);
  const room = HELPERS_MAX - running.length;
  const ended = room > 0 ? all.filter((h) => ENDED.test(h.state)).slice(-room) : [];
  const keep = new Set([...running, ...ended]);
  return { helpers: all.filter((h) => keep.has(h)), more: all.length - keep.size };
}

/** A card's last line in plain words: the first line of a message as the PC's sidebar shows it (headings, quotes, list markers,
 * emphasis and code marks gone; a link as its text, never its URL), spaces collapsed. `partial`: the text starts somewhere inside
 * the message (the card reads only the newest events), so it starts at the next whole paragraph or sentence, never mid-word. */
export function plainLine(text: string, partial = false): string {
  let t = String(text || '').replace(/\r\n?/g, '\n');
  if (partial) {
    // the next sentence in the cut paragraph, else the next paragraph, else the next word (after "…")
    const para = t.search(/\n\s*\S/);
    const end = /[.!?]["')\]]?[ \t]+(?=\S)/.exec(t);
    if (end && (para < 0 || end.index < para)) t = t.slice(end.index + end[0].length);
    else if (para >= 0) t = t.slice(para + 1);
    else {
      const space = t.search(/\s\S/);
      t = space >= 0 ? '…' + t.slice(space + 1) : t;
    }
  }
  let fence = false;
  for (const line of t.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (/^\s*\|?[\s:|-]*-{3,}[\s:|-]*$/.test(line) || /^\s*([-*_]\s*){3,}$/.test(line)) continue; // table rule, horizontal rule
    const s = plainInline(line.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)?/, ''));
    if (s) return s;
  }
  return '';
}

/** A chat title in plain words. Titles that come from the first prompt carry its markdown ("Run the **review** ..."), and a long one is
 * cut mid-mark ("Run the **revi…"): the same plain text as a card's line, plus the marks of a pair the cut left open. A name the
 * owner typed is never passed through here. */
export function plainTitle(text: unknown, max = 170): string {
  const t = plainLine(String(text ?? '')).replace(/(^|\s)(\*\*|__|~~|`)(?=\S)/g, '$1').replace(/(?<=\S)(\*\*|__|~~)(?=\s|$)/g, '');
  return t.length > max ? t.slice(0, max) : t;
}

/** Markdown marks out of one line: images and links as their text, emphasis, strike and code marks gone, spaces collapsed. */
export function plainInline(line: string): string {
  return String(line || '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?![\w])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
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
  const epoch = unreadEpoch(ctx);
  const raws = (Array.isArray(listing.connections) ? listing.connections : []).map(obj).filter((c) => !c.closed && str(c.id, 100));
  const project = projectsFor(ctx, raws.map((c) => str(c.projectRoot, 2000) || str(c.cwd, 2000)));
  const chats: (HomeChat & { at: number })[] = [];
  // a helper's chat is not in the phone's list (it is in the inbox when it needs you, and opens by its link): registry.ts hiddenFromLists
  const helpers = ctx.stateDir ? readHelpers(ctx.stateDir) : {};
  const helperChats = hiddenChats(helpers);
  // ...unless the user listed it: then it is a card under its main chat (registry.ts hiddenFromLists)
  const listed = new Map<string, { under: string; listedAt: number }>();
  for (const h of Object.values(helpers)) {
    if (h.listed && h.kind !== 'subagent' && h.chat?.lasting && h.parent?.lasting) listed.set(h.chat.lasting, { under: h.parent.lasting, listedAt: Number(h.listedAt) || 0 });
  }
  for (const c of raws) {
    const id = str(c.id, 100);
    const key = `${str(c.provider, 60)}:${str(c.sessionId, 200)}`;
    const sub = listed.get(key);
    if (helperChats.live.has(id) || helperChats.lasting.has(key) || (obj(c.swarm).role === 'helper' && !sub)) continue;
    const mark = obj(marks[key]);
    if (mark.archivedAt || mark.deletedAt) continue;
    const attention = obj(c.attention);
    const sessionTitle = plainTitle(obj(obj(c.breadth).sessionInfo).title);
    let title = str(names[key], 170) || plainTitle(mark.title) || sessionTitle;
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
      phase: INBOX.phaseOf(attention, mark, Date.now() / 1000),
      needs,
      busySince: (attention.busySince as string | null) ?? null,
      turnEndedAt: (attention.turnEndedAt as string | null) ?? null,
      yourTurn: Number(mark.yourTurnAt) > 0 && !mark.holdAt,
      unread: (phaseOf(attention) === 'idle' && ended > (seen || epoch)) || marked > seen,
      changedAt: at ? new Date(at).toISOString() : '',
      line: titles.line(ctx, id, `${Number(c.cursor) || 0}|${needs}|${asks}|${c.busy ? 1 : 0}`, Number(c.cursor) || 0),
      ask: null,
      ...(sub ? { under: sub.under, listedAt: sub.listedAt } : {}),
      ...(ConversationState.listRank(mark as Partial<Marks>) ? { rank: ConversationState.listRank(mark as Partial<Marks>) } : {}),
      at,
    });
  }
  // the lines that changed are looked up now (the newest events of those chats), within LINE_WAIT_MS
  await titles.settleLines(LINE_WAIT_MS);
  for (const c of chats) {
    c.line = titles.lines.get(c.id)?.[1] ?? c.line;
    // only while it still waits (a request answered since the last look is not offered again)
    c.ask = c.needs > 0 || c.state === 'needs_you' || c.phase === 'needs_you' || c.phase === 'asks' ? titles.asks.get(c.id) ?? null : null;
  }
  chats.sort((a, b) => b.at - a.at || a.title.localeCompare(b.title));
  const list: HomeChat[] = chats.map(({ at: _at, ...c }) => c);
  // the inbox's rows and count come from the one server builder (attention/inbox.ts), never from the cards here
  const inbox = await ctx.inbox?.current(500).catch(() => null);
  const body = {
    pcName,
    waiting: inbox ? inbox.count : list.filter((c) => INBOX.blocked(c.phase)).length,
    chats: list,
    ...(inbox ? { inbox: { ...inbox, at: 0 } } : {}),
  };
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
  /** What this chat's agent can take with a message (its promptCapabilities): pictures (image input), binary files such as PDFs
   * (embedded context); text files always go. The phone's attach button follows it; the server checks it again. */
  takes: { pictures: boolean; binary: boolean };
  busySince: string | null;
  cursor: number;
  reset: boolean;
  /** The first event sent: Load earlier asks for the page before it (before=firstSeq) while `truncated`. */
  firstSeq: number;
  /** Older events of this chat exist before firstSeq. */
  truncated: boolean;
  /** A delta (after=) that had more new events than the phone asked for: `events` is the newest whole runs only, the phone starts
   * again from them (its older events no longer join up). */
  gap?: boolean;
  helpers: Helper[];
  /** Ended subagents left out of `helpers` (HELPERS_MAX); the phone says they are on the PC. */
  helpersMore?: number;
  /** The inbox's phase (inbox-rules.js phaseOf), as on a home card: the header's status follows it. */
  phase: string;
  /** The reply ended but this many of its subagents still run (attention.helpers): the header says Working · N subagents. */
  helpersRunning: number;
  /** The reply ended but a command it started still runs (attention.shells). */
  background: boolean;
  /** Subagent worktrees: on, or why not, and the read-only types (the phone's subagent lines use it as the PC's Activity does). */
  subagentIsolation?: unknown;
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
  queue: { items: QueuedItem[]; paused: boolean; message: string; scheduled?: ScheduledView[] };
  /** Messages that may or may not have reached the agent before AIB restarted. */
  unknown: { clientMessageId: string; at: number }[];
  events: unknown[];
}

/** A message set to go out later (Send later): its time is epoch ms. A phone sees it and can cancel it. */
export interface ScheduledView {
  id: string;
  text: string;
  at: number;
  /** Why AIB could not send it at its time (its chat could not be reopened); the card stays. */
  error?: string;
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
  // History loading: opening (after 0) reads one tail page by bytes (the chat's own events, huge tool output clipped) and then the
  // state from that page's cursor, instead of all 6,000 events; deltas read the state after the phone's cursor as before. Either
  // way helper events stay off the phone (its helpers list reads the facts) and tool output is clipped to the page's limit.
  const pages = after <= 0 && typeof ctx.host.liveEvents === 'function'; // a test's stand-in host may not have it
  const opened = pages ? await ctx.host.liveEvents(id, { bytes: PHONE_PAGE_BYTES }) as Json | null : null;
  if (pages && !opened) return null;
  const paged = !!opened && !opened.rebuilding && Array.isArray(opened.events);
  const state = await ctx.host.liveState(id, paged ? Number(opened!.cursor) || 0 : after) as Json | null;
  if (!state) return null;
  const main = typeof state.sessionId === 'string' ? state.sessionId : '';
  const own = (e: unknown) => sessionOf(e as Ev, main) === main;
  const fresh = (Array.isArray(state.events) ? state.events : []).filter(own).map((e) => clipEvent(e as Ev));
  const all = paged && !state.reset ? [...(opened!.events as unknown[]), ...fresh] : fresh; // reset: another numbering, all again
  const n = Math.max(1, Math.min(MAX_TAIL, Math.trunc(tail) || DEFAULT_TAIL));
  // The open page is sized by bytes and starts at a run (event_pages.page): no count cuts it. Otherwise (a delta, or a host with no
  // pages) at most n events, and never from inside a run: a long streamed reply is many chunk events, and the phone glues them.
  const events = paged && !state.reset ? all : wholeRuns(all as Ev[], n, main);
  const gap = after > 0 && events.length < all.length;
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
  if (state.auth) {
    // The chat's sign-in card (the same one the PC shows); the sign-in itself runs on the PC (a terminal or the agent's browser page).
    const auth = obj(state.auth);
    const name = AGENT_NAMES[claudeBase(str(state.provider, 40))] ?? 'An agent';
    waiting.push({
      kind: 'sign-in',
      title: `${name} needs you to sign in${auth.during === 'prompt' ? ' again' : ''}`,
      detail: 'Sign in on the PC.',
      pcOnly: true,
    });
  }
  const queue = obj(state.queue);
  const queued: QueuedItem[] = (Array.isArray(queue.items) ? queue.items : []).map(obj).map((i) => ({
    id: str(i.id, 128),
    text: typeof i.text === 'string' ? i.text.slice(0, 8000) : '',
    files: Array.isArray(i.attachments) ? i.attachments.length : 0,
    sending: !!i.sending,
    editing: !!i.editing,
  }));
  const scheduled: ScheduledView[] = (Array.isArray(queue.scheduled) ? queue.scheduled : []).map(obj).map((i) => ({
    id: str(i.id, 128),
    text: typeof i.text === 'string' ? i.text.slice(0, 8000) : '',
    at: Number(i.at) || 0,
    ...(typeof i.error === 'string' && i.error ? { error: i.error.slice(0, 300) } : {}),
  }));
  const unknown = (Array.isArray(state.unknownReceipts) ? state.unknownReceipts : []).map(obj)
    .filter((r) => typeof r.clientMessageId === 'string')
    .map((r) => ({ clientMessageId: r.clientMessageId as string, at: Number(r.at) || 0 }));
  const marks = ctx.conversations.public().entries;
  const mark = obj(marks[`${str(state.provider, 60)}:${str(state.sessionId, 200)}`]);
  const agent = agentName(state.provider);
  const folder = folderName(state.projectRoot || state.cwd);
  const name = ctx.viewPrefs.chatNames()[`${str(state.provider, 60)}:${str(state.sessionId, 200)}`];
  const title = str(name, 170) || plainTitle(mark.title) || plainTitle(obj(obj(state.breadth).sessionInfo).title) || titles.titles.get(id) ||
    `${agent}${folder ? ' in ' + folder : ''}`;
  const root = str(state.projectRoot, 2000) || str(state.cwd, 2000);
  const helpersMade = helpersOf(state.subagents, state.subagentWorktrees);
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
    takes: { pictures: obj(state.promptCapabilities).image === true, binary: obj(state.promptCapabilities).embeddedContext === true },
    busySince: (attention.busySince as string | null) ?? null,
    cursor: Number(state.cursor) || 0,
    reset: !!state.reset,
    firstSeq: Number(obj(events[0]).seq) || 0,
    truncated: all.length > events.length || (paged && !!opened!.more),
    ...(gap ? { gap: true } : {}),
    helpers: helpersMade.helpers,
    ...(helpersMade.more ? { helpersMore: helpersMade.more } : {}),
    phase: INBOX.phaseOf(attention, mark, Date.now() / 1000),
    helpersRunning: Number(attention.helpers) || 0,
    background: !!attention.shells,
    ...(state.subagentIsolation ? { subagentIsolation: state.subagentIsolation } : {}),
    waiting,
    ready: !!state.ready && !state.readOnly && !state.rebuilding && !state.closed,
    closed: !!state.closed,
    savedKey: str(state.provider, 60) && str(state.sessionId, 300) ? `${str(state.provider, 60)}:${str(state.sessionId, 300)}` : '',
    error: state.closed ? str(state.error, 400) : '',
    queue: { items: queued, paused: !!queue.paused, message: str(queue.message, 120), ...(scheduled.length ? { scheduled } : {}) },
    unknown,
    events: events.map((e) => phoneEvent(id, e, artifactOrigin)),
  };
}

/** One event as the phone gets it: picture bytes replaced by URLs (other file bytes dropped), artifact links on its origin. This is
 * also the shape a later offline cache on the phone keeps, keyed by seq: {seq, kind, time?, data, clipped?, bytes?}. */
function phoneEvent(id: string, e: unknown, artifactOrigin: string): unknown {
  const seq = Number(obj(e).seq) || 0;
  const light = withoutBytes(e, (k) => `/api/remote/image?id=${encodeURIComponent(id)}&seq=${seq}&n=${k}`);
  return withArtifactOrigin(light, artifactOrigin);
}

/** The newest events of `all` (the chat's own, oldest first), at most `n`, except that the first one kept is the start of its run
 * (event_pages.rowStarts): a run longer than n is kept whole. */
export function wholeRuns(all: Ev[], n: number, main: string): Ev[] {
  if (all.length <= n) return all;
  const starts = rowStarts(all, main, main);
  let i = all.length - n;
  const start = starts.get(all[i].seq) ?? all[i].seq;
  while (i > 0 && all[i].seq > start) i--;
  return all.slice(i);
}

/** Load earlier: the page of a live chat's own events before `before` (by bytes, starting at a run, tool output clipped). */
export interface OlderPage {
  id: string;
  events: unknown[];
  /** The page's first seq (the next Load earlier asks before it); `before` when the page is empty. */
  firstSeq: number;
  /** Still older events exist. */
  more: boolean;
}

export async function olderPage(
  ctx: WebContext,
  id: string,
  before: number,
  bytes: number,
  artifactOrigin = '',
): Promise<OlderPage | null> {
  if (typeof ctx.host.liveEvents !== 'function') return null;
  const budget = Math.max(PHONE_OLDER_MIN, Math.min(PHONE_OLDER_MAX, Math.trunc(bytes) || PHONE_PAGE_BYTES));
  const found = await ctx.host.liveEvents(id, { before: Math.max(0, Math.trunc(before)), bytes: budget }) as Json | null;
  if (!found) return null;
  if (found.rebuilding || !Array.isArray(found.events)) return { id, events: [], firstSeq: before, more: true };
  // the page holds the chat's own events only (session main); its tool events are clipped already (clipping twice adds a 2nd note)
  const events = found.events as Ev[];
  return {
    id,
    events: events.map((e) => phoneEvent(id, e, artifactOrigin)),
    firstSeq: events.length ? Number(events[0].seq) || before : before,
    more: !!found.more,
  };
}

/** Show output: one event of a live chat whole (strings over PHONE_EVENT_CHARS still clipped), or null when it is not kept. */
export async function wholeEvent(ctx: WebContext, id: string, seq: number, artifactOrigin = ''): Promise<unknown | null> {
  if (typeof ctx.host.liveEvent !== 'function') return null;
  const found = await ctx.host.liveEvent(id, Math.trunc(seq)) as Ev | null;
  if (!found || typeof found !== 'object') return null;
  return phoneEvent(id, clipEvent(found, PHONE_EVENT_CHARS), artifactOrigin);
}
