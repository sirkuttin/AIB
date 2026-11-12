/**
 * Chats that are not running (owner decision 3b): the phone lists them, shows their saved history read only, and can continue one.
 *
 *   list      the saved chats the PC's own list shows (saved transcripts of added projects, as /api/sessions after filterSessions,
 *             plus chats that were open before a restart and did not come back), minus the ones running now, archived or deleted.
 *             Newest first, at most MAX_SAVED. Kept for LIST_MS (the phone polls home every 4 s; a transcript scan is not free).
 *   history   the last N events of one listed chat's saved transcript, in the shape of live events (what phone.js draws), with no
 *             picture bytes (saved transcripts only hold their address; the phone says the picture is on the PC) and under
 *             MAX_HISTORY_BYTES.
 *   continue  the PC's own reconnect: POST /api/live/connect {provider, cwd, resume} with the chat's saved agent and folder, never
 *             anything the phone sent (no agent, model, mode, folder or config: a body with any other field is refused). The
 *             ownership check runs as on the PC, and without continueAnyway: a chat that is open in another app (or another AIB
 *             copy), or that another app may be using, is refused with the reason; the phone never takes a chat over.
 */
import type { WebContext } from '../web/server.ts';
import { afterConnect, filterSessions } from '../web/project_routes.ts';
import { handleGet as monitorGet } from '../transcripts/monitor.ts';
import { agentName, withArtifactOrigin } from './payloads.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const MAX_SAVED = 30;
export const LIST_MS = 10_000;
export const SAVED_TAIL = 200;
export const MAX_HISTORY_BYTES = 512 * 1024;
const MAX_EVENT_TEXT = 8000;

/** One chat that is not running, as the phone's home lists it. `cwd` and `transcript` stay on the PC. */
export interface SavedChat {
  /** provider:sessionId (the chat's stable key, as the PC's read state and marks use) */
  key: string;
  title: string;
  agent: string;
  folder: string;
  /** when it was last active (ISO), '' when unknown */
  lastActive: string;
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

export const SAVED_KEY = /^[a-z0-9][a-z0-9_-]{0,59}:[^\s:][^\s]{0,299}$/;

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
    const out = new Map<string, SavedEntry>();
    const add = (provider: string, sessionId: string, cwd: string, title: string, when: unknown, transcript: string) => {
      const key = `${provider}:${sessionId}`;
      if (!provider || !sessionId || !cwd || out.has(key) || running.has(key) || !SAVED_KEY.test(key)) return;
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
        title: str(mark.title, 170) || str(title, 170) || `${agent}${folder ? ' in ' + folder : ''}`,
        agent,
        folder,
        lastActive: isoOf(when),
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
  return { key: c.key, title: c.title, agent: c.agent, folder: c.folder, lastActive: c.lastActive };
}

// ---- the saved history, as live events ---------------------------------------------------------------------------------------

const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_EVENT_TEXT) : '');

/** Saved transcript events (transcripts/normalize.ts) -> the live events phone.js draws. Thinking is left out; pictures are a note. */
export function liveShaped(events: unknown[], first = 1): Json[] {
  const out: Json[] = [];
  let seq = first - 1;
  let lastAgent = false;
  const push = (kind: string, data: Json, time: unknown) => {
    const t = Date.parse(typeof time === 'string' ? time : '');
    out.push({ seq: ++seq, kind, ...(t ? { time: t / 1000 } : {}), data });
  };
  for (const raw of events) {
    const e = obj(raw);
    const pictures = Array.isArray(e.images) && e.images.length;
    const note = pictures ? (pictures === 1 ? '[A picture: it is on your PC.]' : `[${pictures} pictures: they are on your PC.]`) : '';
    const text = clip(e.text);
    const kind = e.kind;
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

export interface SavedHistory {
  key: string;
  title: string;
  agent: string;
  folder: string;
  lastActive: string;
  /** false: AIB keeps no saved transcript of this chat here (it can still be continued) */
  history: boolean;
  truncated: boolean;
  events: Json[];
}

/** The last `tail` events of a saved chat, under MAX_HISTORY_BYTES (the oldest are dropped first). */
export async function savedHistory(ctx: WebContext, chat: SavedEntry, tail: number, artifactOrigin = ''): Promise<SavedHistory> {
  const base = { ...publicSaved(chat), history: !!chat.transcript, truncated: false, events: [] as Json[] };
  if (!chat.transcript) return base;
  const n = Math.max(1, Math.min(500, Math.trunc(tail) || SAVED_TAIL));
  const reply = await monitorGet(ctx.transcripts, '/api/transcript', `key=${encodeURIComponent(chat.transcript)}&limit=${n}`);
  const page = obj(reply.body);
  if (reply.status !== 200 || !Array.isArray(page.events)) return { ...base, history: false };
  let events = liveShaped(page.events, (Number(page.before) || 0) + 1).map((e) => withArtifactOrigin(e, artifactOrigin) as Json);
  let truncated = Number(page.before) > 0;
  let size = new TextEncoder().encode(JSON.stringify(events)).byteLength;
  while (events.length > 1 && size > MAX_HISTORY_BYTES) {
    const drop = Math.max(1, Math.ceil(events.length / 10));
    size -= new TextEncoder().encode(JSON.stringify(events.slice(0, drop))).byteLength;
    events = events.slice(drop);
    truncated = true;
  }
  return { ...base, truncated, events };
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
