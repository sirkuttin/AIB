/**
 * Chats that are not running (owner decision 3b): the phone lists them, shows their saved history read only, and can continue one.
 *
 *   list      the saved chats the PC's own list shows (saved transcripts of added projects, as /api/sessions after filterSessions,
 *             plus chats that were open before a restart and did not come back), minus the ones running now, archived or deleted.
 *             Newest first, at most MAX_SAVED. Kept for LIST_MS (the phone polls home every 4 s; a transcript scan is not free).
 *   history   the last N events of one listed chat's saved transcript (or the N before=<seq>: Load earlier), in the shape of live
 *             events (what phone.js draws), with no picture bytes (saved transcripts only hold their address; the phone says the
 *             picture is on the PC) and under MAX_HISTORY_BYTES. An event's seq is its place in the transcript + 1, so pages join
 *             up. A message longer than MAX_EVENT_TEXT is cut and marked (clipped: true; the phone says the rest is on the PC).
 *   continue  the PC's own reconnect: POST /api/live/connect {provider, cwd, resume} with the chat's saved agent and folder, never
 *             anything the phone sent (no agent, model, mode, folder or config: a body with any other field is refused). The
 *             ownership check runs as on the PC, and without continueAnyway: a chat that is open in another app (or another AIB
 *             copy), or that another app may be using, is refused with the reason; the phone never takes a chat over.
 */
import type { WebContext } from '../web/server.ts';
import { ConversationState, type Marks } from '../state/conversations.ts';
import { afterConnect, filterSessions } from '../web/project_routes.ts';
import { handleGet as monitorGet } from '../transcripts/monitor.ts';
import { CLIP_NOTE } from '../transcripts/pycompat.ts';
import { keptLinesIn } from '../history/lines.ts';
import { pathStr } from '../platform/pypath.ts';
import { agentName, plainTitle, withArtifactOrigin } from './payloads.ts';
import { isRetired, RETIRED_NOTE } from '../agents/agent_registry.ts';
import { hiddenChats, readHelpers } from '../swarm/registry.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const MAX_SAVED = 30;
export const LIST_MS = 10_000;
export const SAVED_TAIL = 200;
export const MAX_HISTORY_BYTES = 512 * 1024;
/** The most text one saved message carries to the phone (longer ones are cut and marked clipped). The transcript reader cuts at
 * 32,000 characters first (pycompat.clipped, with CLIP_NOTE): such a message is marked clipped as well. */
export const MAX_EVENT_TEXT = 100_000;

/** One chat that is not running, as the phone's home lists it. `cwd` and `transcript` stay on the PC. */
export interface SavedChat {
  /** provider:sessionId (the chat's stable key, as the PC's read state and marks use) */
  key: string;
  title: string;
  agent: string;
  folder: string;
  /** when it was last active (ISO), '' when unknown */
  lastActive: string;
  /** an agent AIB no longer runs (OMP): the chat is history only, with a note where Continue was (RETIRED_NOTE) */
  readOnly?: boolean;
  /** the PC's manual order (drag to reorder); only once placed by hand */
  rank?: number;
}

interface SavedEntry extends SavedChat {
  provider: string;
  sessionId: string;
  cwd: string;
  /** the transcript key /api/transcript reads ('' when AIB has no saved transcript of it, e.g. a recovered chat) */
  transcript: string;
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]+/).filter(Boolean).at(-1) ?? '';
}

function isoOf(seconds: unknown): string {
  const n = Number(seconds);
  if (!(n > 0)) return '';
  try {
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  } catch {
    return '';
  }
}

export const SAVED_KEY = /^[a-z0-9][a-z0-9@_-]{0,59}:[^\s:][^\s]{0,299}$/;

/** The phone's list of chats that are not running (cached LIST_MS). */
export class SavedChats {
  #at = 0;
  #list: SavedEntry[] = [];
  #busy: Promise<SavedEntry[]> | null = null;

  constructor(readonly clock: () => number = Date.now) {}

  /** Forget the cached list (after a continue: the chat is running now). */
  invalidate(): void {
    this.#at = 0;
  }

  async list(ctx: WebContext, fresh = false): Promise<SavedEntry[]> {
    if (!fresh && this.#at && this.clock() - this.#at < LIST_MS) return this.#list;
    if (this.#busy) return await this.#busy;
    this.#busy = this.#build(ctx);
    try {
      this.#list = await this.#busy;
      this.#at = this.clock();
      return this.#list;
    } finally {
      this.#busy = null;
    }
  }

  /** One listed chat by its key (looked up again when the cached list does not have it). */
  async find(ctx: WebContext, key: string): Promise<SavedEntry | null> {
    if (!SAVED_KEY.test(key)) return null;
    return (await this.list(ctx)).find((c) => c.key === key) ?? (await this.list(ctx, true)).find((c) => c.key === key) ?? null;
  }

  async #build(ctx: WebContext): Promise<SavedEntry[]> {
    const listing = obj(await ctx.host.liveList());
    const running = new Set<string>();
    for (const raw of Array.isArray(listing.connections) ? listing.connections : []) {
      const c = obj(raw);
      if (!c.closed && typeof c.provider === 'string' && typeof c.sessionId === 'string') running.add(`${c.provider}:${c.sessionId}`);
    }
    const marks = ctx.conversations.public().entries;
    const names = ctx.viewPrefs.chatNames(); // Rename, on the PC or a phone
    const helperChats = hiddenChats(ctx.stateDir ? readHelpers(ctx.stateDir) : {}); // a helper's chat is not in the phone's list
    const out = new Map<string, SavedEntry>();
    const add = (provider: string, sessionId: string, cwd: string, title: string, when: unknown, transcript: string) => {
      const key = `${provider}:${sessionId}`;
      if (!provider || !sessionId || !cwd || out.has(key) || running.has(key) || helperChats.lasting.has(key) || !SAVED_KEY.test(key)) return;
      const mark = obj(marks[key]);
      if (mark.archivedAt || mark.deletedAt) return;
      const agent = agentName(provider);
      const folder = folderName(cwd);
      out.set(key, {
        key,
        provider,
        sessionId,
        cwd,
        transcript,
        title: str(names[key], 170) || plainTitle(mark.title) || plainTitle(title) || `${agent}${folder ? ' in ' + folder : ''}`,
        agent,
        folder,
        lastActive: isoOf(when),
        ...(ConversationState.listRank(mark as Partial<Marks>) ? { rank: ConversationState.listRank(mark as Partial<Marks>) } : {}),
        ...(isRetired(provider) ? { readOnly: true } : {}),
      });
    };
    let sessions: unknown[] = [];
    try {
      const reply = await monitorGet(ctx.transcripts, '/api/sessions', '');
      const body = obj(reply.body);
      if (reply.status === 200 && Array.isArray(body.sessions)) {
        sessions = filterSessions(ctx.addedProjects, body.sessions, ctx.conversations);
      }
    } catch { /* no saved transcripts readable: only recovered chats */ }
    for (const raw of sessions) {
      const s = obj(raw);
      if (!s.hasMessages || s.agentId) continue;
      add(str(s.provider, 60), str(s.id, 300), str(s.cwd, 2000), str(s.title) || str(s.prompt) || '', s.modified, str(s.key, 1000));
    }
    for (const raw of Array.isArray(listing.recovered) ? listing.recovered : []) {
      const r = obj(raw);
      const cwd = str(r.cwd, 2000);
      if (!ctx.addedProjects.shows(str(r.projectRoot, 2000) || cwd)) continue;
      add(str(r.provider, 60), str(r.sessionId, 300), cwd, str(r.title), r.lastSeen || r.openedAt, '');
    }
    const time = (c: SavedEntry) => Date.parse(c.lastActive) || 0;
    return [...out.values()].sort((a, b) => time(b) - time(a)).slice(0, MAX_SAVED);
  }
}

/** What the phone gets for its home list (never the folder path or the transcript key). */
export function publicSaved(c: SavedEntry): SavedChat {
  return {
    key: c.key,
    title: c.title,
    agent: c.agent,
    folder: c.folder,
    lastActive: c.lastActive,
    ...(c.rank ? { rank: c.rank } : {}),
    ...(c.readOnly ? { readOnly: true, note: RETIRED_NOTE } : {}),
  };
}

// ---- the saved history, as live events ---------------------------------------------------------------------------------------

/** Saved transcript events (transcripts/normalize.ts) -> the live events phone.js draws. Thinking is left out; pictures are a note.
 * events[i] gets seq first + i (its place in the transcript + 1). `afterAgent`: the event before events[0] was a reply of the agent
 * (a reply that follows another one starts with a blank line, as when both are on one page). */
export function liveShaped(events: unknown[], first = 1, afterAgent = false): Json[] {
  const out: Json[] = [];
  let seq = first - 1;
  let lastAgent = afterAgent;
  let cut = false;
  const push = (kind: string, data: Json, time: unknown) => {
    const t = Date.parse(typeof time === 'string' ? time : '');
    out.push({ seq, kind, ...(t ? { time: t / 1000 } : {}), data, ...(cut ? { clipped: true } : {}) });
  };
  for (const raw of events) {
    seq++;
    const e = obj(raw);
    const pictures = Array.isArray(e.images) && e.images.length;
    const note = pictures ? (pictures === 1 ? '[A picture: it is on your PC.]' : `[${pictures} pictures: they are on your PC.]`) : '';
    let full = typeof e.text === 'string' ? e.text : '';
    const kind = e.kind;
    // the transcript reader already cut a very long text (its own limit, with a note at the end): the phone says so in its own words
    const shortened = full.endsWith(CLIP_NOTE);
    if (shortened) full = full.slice(0, -CLIP_NOTE.length);
    cut = (shortened || full.length > MAX_EVENT_TEXT) && kind !== 'tool' && kind !== 'result' && kind !== 'error'; // no step output shown
    const text = full.slice(0, MAX_EVENT_TEXT);
    if (kind === 'user') {
      push('user', { text: [text, note].filter(Boolean).join('\n') }, e.time);
      lastAgent = false;
    } else if (kind === 'assistant') {
      const shown = [text, note].filter(Boolean).join('\n');
      if (!shown) continue;
      push('update', {
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: (lastAgent ? '\n\n' : '') + shown } },
      }, e.time);
      lastAgent = true;
    } else if (kind === 'tool') {
      const intent = str(e.intent, 200);
      push('update', {
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: str(e.callId, 200) || `saved-${seq + 1}`,
          title: intent || str(e.label, 200) || 'Step',
          status: 'completed',
        },
      }, e.time);
      lastAgent = false;
    } else if (kind === 'result' || kind === 'error') {
      if (typeof e.callId === 'string' && e.callId) {
        push('update', {
          update: { sessionUpdate: 'tool_call_update', toolCallId: str(e.callId, 200), status: kind === 'error' ? 'failed' : 'completed' },
        }, e.time);
      }
      lastAgent = false;
    } else if (kind === 'assignment' || kind === 'task-done' || kind === 'notice') {
      const label = str(e.label, 80);
      if (text) push('studio_note', { message: (label ? label + ': ' : '') + text }, e.time);
      lastAgent = false;
    }
  }
  return out;
}

/**
 * AIB's own lines of the chat (history/lines.ts: turn ends, AIB notes; the transcript page's `lines`) put into the live-shaped
 * events after their turns, with their own time. A line before transcript event `at` gets seq at + 0.5 (+ 0.001 for each line
 * before it there): between the seqs of the events around it, never a whole number, so pages and Load earlier still count
 * transcript events. Lines at or before `start` (the page's first event) belong to the older page. A note's buttons (Undo,
 * Merge again) are left out: the chat is not running.
 */
export function withKeptLines(events: Json[], lines: unknown[], start: number): Json[] {
  const extra: Json[] = [];
  const perAt = new Map<number, number>();
  for (const raw of lines) {
    const l = obj(raw);
    const at = Number(l.at);
    if (!Number.isInteger(at) || at <= start || (l.kind !== 'turn_end' && l.kind !== 'studio_note')) continue;
    const j = perAt.get(at) ?? 0;
    perAt.set(at, j + 1);
    const { actions: _actions, ...data } = obj(l.data);
    const time = Number(l.time);
    extra.push({
      seq: at + 0.5 + Math.min(j, 499) / 1000,
      kind: l.kind,
      ...(time > 0 ? { time } : {}),
      data: { ...data, restored: true },
    });
  }
  if (!extra.length) return events;
  return [...events, ...extra].sort((a, b) => Number(a.seq) - Number(b.seq));
}

export interface SavedHistory {
  key: string;
  title: string;
  agent: string;
  folder: string;
  lastActive: string;
  /** false: AIB keeps no saved transcript of this chat here (it can still be continued) */
  history: boolean;
  /** Older messages exist before firstSeq (Load earlier asks before=firstSeq). */
  truncated: boolean;
  /** The first event's seq (its place in the transcript + 1); `before` when a Load earlier page is empty. */
  firstSeq: number;
  events: Json[];
}

/** The last `tail` events of a saved chat (or the `tail` before seq `before`: Load earlier), under MAX_HISTORY_BYTES (the oldest
 * are dropped first). */
export async function savedHistory(
  ctx: WebContext,
  chat: SavedEntry,
  tail: number,
  artifactOrigin = '',
  before: number | null = null,
): Promise<SavedHistory> {
  const base = { ...publicSaved(chat), history: !!chat.transcript, truncated: false, firstSeq: before ?? 0, events: [] as Json[] };
  if (!chat.transcript) return base;
  const n = Math.max(1, Math.min(500, Math.trunc(tail) || SAVED_TAIL));
  // one event more than asked: the one before the page says whether its first reply follows another (it is not sent)
  const end = before === null ? '' : `&before=${Math.max(0, Math.trunc(before) - 1)}`;
  const reply = await monitorGet(ctx.transcripts, '/api/transcript', `key=${encodeURIComponent(chat.transcript)}&limit=${n + 1}${end}`, {
    keptLines: keptLinesIn(pathStr(ctx.stateDir)),
  });
  const page = obj(reply.body);
  if (reply.status !== 200 || !Array.isArray(page.events)) return { ...base, history: false };
  let raw = page.events as unknown[];
  let start = Number(page.before) || 0;
  let afterAgent = false;
  if (raw.length > n) {
    const lead = obj(raw[0]);
    afterAgent = lead.kind === 'assistant' && (!!String(lead.text ?? '').trim() || (Array.isArray(lead.images) && lead.images.length > 0));
    raw = raw.slice(1);
    start += 1;
  }
  let events = withKeptLines(liveShaped(raw, start + 1, afterAgent), Array.isArray(page.lines) ? page.lines : [], start)
    .map((e) => withArtifactOrigin(e, artifactOrigin) as Json);
  let truncated = start > 0;
  let size = new TextEncoder().encode(JSON.stringify(events)).byteLength;
  while (events.length > 1 && size > MAX_HISTORY_BYTES) {
    const drop = Math.max(1, Math.ceil(events.length / 10));
    size -= new TextEncoder().encode(JSON.stringify(events.slice(0, drop))).byteLength;
    events = events.slice(drop);
    truncated = true;
    // a page starts at a transcript event (Load earlier asks before its seq); AIB's lines cut off here come with that older page
    while (events.length > 1 && !Number.isInteger(Number(events[0].seq))) events = events.slice(1);
  }
  const firstSeq = events.length ? Number(events[0].seq) || 0 : before ?? start + 1;
  return { ...base, truncated, firstSeq, events };
}

// ---- continue ------------------------------------------------------------------------------------------------------------------

export interface ContinueResult {
  status: number;
  code: string;
  error?: string;
  id?: string;
}

/** The only field a phone sends to continue a chat. */
export const CONTINUE_FIELDS = new Set(['key']);

/**
 * Continue a listed chat with its saved agent and folder (the PC's connect, in the background: the phone polls the chat while it
 * opens). The ownership check refuses a chat another app has or may have open.
 */
export async function continueSaved(ctx: WebContext, chat: SavedEntry): Promise<ContinueResult> {
  if (isRetired(chat.provider)) return { status: 409, code: 'read_only', error: RETIRED_NOTE };
  const body = { provider: chat.provider, cwd: chat.cwd, resume: chat.sessionId, background: true };
  const [status, payload] = await ctx.host.liveCall('connect', body);
  const answer = obj(payload);
  if (status === 200 && typeof answer.id === 'string') {
    await afterConnect(ctx.removedProjects, body, status, ctx.addedProjects, payload).catch(() => {});
    return { status: 200, code: 'ok', id: answer.id };
  }
  const why = str(answer.error, 600);
  const code = typeof answer.code === 'string' ? answer.code : status === 409 ? 'session_in_use' : 'failed';
  if (code === 'possibly_active') {
    return {
      status: 409,
      code,
      error:
        `Not continued: another app may be using this chat right now. ${
          why.replace(/^Another app may be using this conversation:\s*/, '')
        } ` +
        'Nothing was opened or sent. To check and decide, continue it in AIB on your PC.',
    };
  }
  if (status === 409) {
    return {
      status: 409,
      code: 'session_in_use',
      error: `Not continued: this chat is open somewhere else. ${why} Nothing was opened or sent.`.replace(/\s+/g, ' '),
    };
  }
  return {
    status: status >= 400 && status < 600 ? status : 500,
    code: 'failed',
    error: `This chat could not be started on your PC${why ? ': ' + why : '.'}`,
  };
}
