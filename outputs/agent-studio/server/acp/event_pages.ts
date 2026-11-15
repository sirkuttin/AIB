/**
 * Event pages (history loading, phase 1B): pure functions over one chat's numbered events that answer the page's range reads
 * (the tail, before=, after=, around=, one helper's events) and the boundary state a page needs to build its rows without the
 * events before its first one (design 4.3, architect review H5 / M2 / M7).
 *
 * The events come from an EventSource. Today that is the connection's in-memory array (arraySource); phase 2 plugs in the per-chat
 * store (server/history) behind the same interface. Nothing here imports anything, so node's type stripping can load it as well
 * (work/test_history_pages.js runs it against chat.js's liveRows).
 *
 * Rules:
 * - Pages are sized by bytes (the JSON of the events as sent), not by a count of events.
 * - A page never starts inside a row: rowStart(seq) is view-free. A run is the chat's own events from one row-making event up to
 *   the next one; *_chunk events after a chunk, an identical repeat of your message, and events that make or change no row of
 *   their own (a usage update, an update to an already seen tool call, a withdrawn ask, a sign-in notice) join the run they follow.
 *   So a long streamed reply is one run whatever its length, and message / thought / message stays one run for both thinking modes.
 * - edge carries what crosses the page's first event: the turn index and per-call use counts there, each tool call opened before
 *   it that the events from it on touch (with its merged state at the edge), withdrawn ask keys, and the latest plan event.
 * - Tool events whose JSON passes the page's own limit are clipped on the way out (clipped: true, bytes: the full size); full()
 *   gives the event whole.
 */

export type Ev = { seq: number; kind: string; data?: any; time?: number; replay?: boolean; [k: string]: unknown };

/** One chat's numbered events. The in-memory array today; the history store later. */
export interface EventSource {
  /** The numbering's identity (chat.js compares it; a new one means "start again"). */
  readonly eventsId: string;
  /** The newest seq made (the page's cursor). */
  readonly cursor: number;
  /** Seqs up to here keep their number across a host restart; above it they may be renumbered (review M4). */
  readonly stable: number;
  /** The chat's own session id: events with no sessionId or this one are the chat's; any other is a helper's. */
  readonly mainSession: string;
  /** Every kept event, oldest first (ascending seq). */
  events(): readonly Ev[];
}

export interface SourceInit {
  eventsId?: string;
  cursor?: number;
  stable?: number;
  mainSession?: string | null;
}

export function arraySource(events: readonly Ev[], init: SourceInit = {}): EventSource {
  const last = events.length ? Number(events[events.length - 1].seq) || 0 : 0;
  const cursor = Math.max(last, Number(init.cursor) || 0);
  return {
    eventsId: String(init.eventsId ?? ''),
    cursor,
    stable: Math.min(cursor, init.stable === undefined ? cursor : Math.max(0, Number(init.stable) || 0)),
    mainSession: String(init.mainSession ?? ''),
    events: () => events,
  };
}

// ---- limits ------------------------------------------------------------------------------------------------------------------
export const PAGE_BYTES = 1024 * 1024; // one page's events (design 4.1: bytes=1MB)
export const MAX_PAGE_BYTES = 8 * 1024 * 1024;
export const MIN_PAGE_BYTES = 4 * 1024;
export const CLIP_CHARS = 40000; // the page's own limit on a step's text (chat.js liveRows slices to 40,000)

const CHUNKS = new Set(['agent_message_chunk', 'user_message_chunk', 'agent_thought_chunk']);
const ATTACH_TYPES = new Set(['image', 'resource_link', 'resource', 'audio']);
const ENC = new TextEncoder();

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const upd = (e: Ev): Record<string, any> | null => (e.kind === 'update' && isObj(e.data) && isObj(e.data.update) ? e.data.update : null);

/** The session an event belongs to: its own sessionId, else the chat's (chat.js: event.data?.sessionId || snap?.sessionId). */
export function sessionOf(e: Ev, main: string): string {
  const sid = isObj(e.data) ? e.data.sessionId : undefined;
  return typeof sid === 'string' && sid ? sid : main;
}

export function isChunk(e: Ev): boolean {
  const u = upd(e);
  return !!u && CHUNKS.has(u.sessionUpdate);
}

// ---- row starts ------------------------------------------------------------------------------------------------------------------
type Prev = { chunk: boolean; userText: string | null };

/** What one of the session's events does to the rows: 'join' (no row of its own, or continues the run) or 'start'. */
function step(e: Ev, prev: Prev | null, seen: Map<string, number>, turn: number): { start: boolean; next: Prev | null } {
  const u = upd(e);
  const keep = { start: false, next: prev };
  if (e.kind === 'update') {
    if (!u) return keep;
    const kind = u.sessionUpdate;
    if (CHUNKS.has(kind)) {
      const text = typeof u.content?.text === 'string' ? u.content.text : '';
      const attached = isObj(u.content) && ATTACH_TYPES.has(u.content.type);
      if (!text && !attached) return keep;
      const userText = kind === 'user_message_chunk' && !attached ? text : null;
      const joins = !!prev && (prev.chunk || (userText !== null && prev.userText === userText));
      return { start: !joins, next: { chunk: true, userText } };
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const key = String(u.toolCallId);
      const was = seen.get(key);
      // an update to a call already seen, or the same call again in its turn, edits that row: the last row stays what it was (a
      // reply around it stays one row); a call that reuses an id from an earlier turn is a row of its own (chat.js liveRows)
      if (was !== undefined && (kind === 'tool_call_update' || was === turn)) return keep;
      seen.set(key, turn);
      return { start: true, next: { chunk: false, userText: null } };
    }
    if (kind === 'plan') return { start: true, next: { chunk: false, userText: null } };
    return keep; // session_message, usage_update, available_commands_update, ...: no row
  }
  if (e.kind === 'user') {
    const text = typeof e.data?.text === 'string' ? e.data.text : '';
    const files = (Array.isArray(e.data?.attachments) && e.data.attachments.length) || (Array.isArray(e.data?.files) && e.data.files.length);
    if (!text && !files) return keep;
    const userText = files ? null : text;
    if (prev && userText !== null && prev.userText === userText) return keep; // chat.js drops the identical repeat
    return { start: true, next: { chunk: false, userText } };
  }
  if (e.kind === 'permission' || e.kind === 'elicitation') {
    return typeof e.data?.key === 'string' && e.data.key ? { start: true, next: { chunk: false, userText: null } } : keep;
  }
  if (e.kind === 'permission_auto' || e.kind === 'turn_end') return { start: true, next: { chunk: false, userText: null } };
  if (e.kind === 'error' || e.kind === 'disconnected' || e.kind === 'studio_note') {
    return e.data?.message ? { start: true, next: { chunk: false, userText: null } } : keep;
  }
  return keep; // request_withdrawn, auth_required (it may take back the reply before it), and every other kind
}

/** seq -> the seq its page may start at (the first event of its run), for one session's events. */
export function rowStarts(events: readonly Ev[], session: string, main: string): Map<number, number> {
  const out = new Map<number, number>();
  const seen = new Map<string, number>(); // tool call id -> the turn its row was made in
  let prev: Prev | null = null;
  let start = 0, turn = 0;
  for (const e of events) {
    if (sessionOf(e, main) !== session) continue;
    if (e.kind === 'user' || e.kind === 'turn_end') turn++;
    const r = step(e, prev, seen, turn);
    prev = r.next;
    if (r.start || !start) start = e.seq;
    out.set(e.seq, start);
  }
  return out;
}

// ---- boundary state ----------------------------------------------------------------------------------------------------------------
export interface EdgeTool {
  key: string;
  /** The row's id seq (the event that made the row). */
  seq: number;
  /** The turn index the row was made in (a new tool_call with the same id in another turn is its own row). */
  turn: number;
  /** How many rows this id has made so far (uid = key#n when n > 1). */
  uses: number;
  /** Updates merged into the row so far (chat.js row.rev). */
  rev: number;
  /** The call's merged state at the edge. */
  raw: Record<string, any>;
  time: number;
}

export interface Edge {
  /** The page's first seq: everything below is outside it. */
  seq: number;
  /** User messages plus turn ends before the edge (chat.js liveRows' turn counter). */
  turn: number;
  /** Per tool call id: rows made before the edge, for ids the events from the edge on use. */
  uses: Record<string, number>;
  /** Calls opened before the edge that events from the edge on update (toolFinal: their state at the edge). */
  tools: EdgeTool[];
  /** Ask keys withdrawn from the edge on. */
  withdrawn: string[];
  /** The latest plan event of the chat (docked plan), wherever it is. */
  plan: Ev | null;
}

/** The state from before `seq` that the session's rows from `seq` on need. */
export function edgeAt(source: EventSource, seq: number, session = source.mainSession): Edge {
  const main = source.mainSession;
  const all = source.events();
  let turn = 0;
  const tools = new Map<string, EdgeTool>();
  const uses = new Map<string, number>();
  let plan: Ev | null = null;
  const after = new Set<string>(); // tool ids the events from the edge on use
  const withdrawn: string[] = [];
  for (const e of all) {
    if (sessionOf(e, main) !== session) continue;
    const u = upd(e);
    if (u?.sessionUpdate === 'plan') plan = e;
    if (e.seq >= seq) {
      if (u && (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update')) after.add(String(u.toolCallId));
      if (e.kind === 'request_withdrawn' && typeof e.data?.key === 'string') withdrawn.push(e.data.key);
      continue;
    }
    if (e.kind === 'user' || e.kind === 'turn_end') {
      turn++;
      continue;
    }
    if (!u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) continue;
    const key = String(u.toolCallId);
    let old = tools.get(key);
    if (old && u.sessionUpdate === 'tool_call' && old.turn !== turn) old = undefined;
    if (old) {
      old.raw = { ...old.raw, ...u };
      old.rev += 1;
      continue;
    }
    const n = (uses.get(key) || 0) + 1;
    uses.set(key, n);
    tools.set(key, { key, seq: e.seq, turn, uses: n, rev: 0, raw: { ...u }, time: e.replay ? 0 : Number(e.time) || 0 });
  }
  return {
    seq,
    turn,
    uses: Object.fromEntries([...uses].filter(([k]) => after.has(k))),
    tools: [...tools.values()].filter((t) => after.has(t.key)).sort((a, b) => a.seq - b.seq),
    withdrawn,
    plan,
  };
}

// ---- turn and helper facts (state the page's readers need without the whole array, review M2) -----------------------------
export interface TurnFacts {
  /** Your newest message (0: none kept). */
  promptSeq: number;
  /** Its time in ms. */
  since: number;
  /** The newest step after it: a tool call or thinking. */
  step: { kind: 'tool'; title: string; status: string; toolKind: string } | { kind: 'thinking' } | null;
  /** Tool calls after it. */
  steps: number;
  /** The seq of a turn_end after it (0: the turn is still going or no turn end came). */
  endSeq: number;
  /** The agent's own text came after the newest step (chat.js liveStatus "talking"). */
  talking: boolean;
}

export function turnFacts(source: EventSource): TurnFacts {
  const main = source.mainSession;
  const all = source.events();
  let at = -1;
  for (let i = all.length - 1; i >= 0; i--) {
    const e = all[i];
    if (e.kind !== 'user' || sessionOf(e, main) !== main) continue;
    const text = typeof e.data?.text === 'string' ? e.data.text.trim() : '';
    if (text || (Array.isArray(e.data?.attachments) && e.data.attachments.length)) {
      at = i;
      break;
    }
  }
  if (at < 0) return { promptSeq: 0, since: 0, step: null, steps: 0, endSeq: 0, talking: false };
  const prompt = all[at];
  const raws = new Map<string, Record<string, any>>();
  let step: TurnFacts['step'] = null, steps = 0, endSeq = 0, talking = false, lastTool = '';
  for (let i = at + 1; i < all.length; i++) {
    const e = all[i];
    if (sessionOf(e, main) !== main) continue;
    if (e.kind === 'turn_end') endSeq = e.seq;
    const u = upd(e);
    if (!u) continue;
    if (u.sessionUpdate === 'agent_message_chunk') talking = true;
    else if (u.sessionUpdate === 'agent_thought_chunk') {
      step = { kind: 'thinking' };
      talking = false;
    } else if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const id = String(u.toolCallId ?? 'call-' + i);
      if (!raws.has(id)) steps++;
      raws.set(id, { ...raws.get(id), ...u });
      if (u.sessionUpdate === 'tool_call') lastTool = id;
      const r = raws.get(lastTool || id)!;
      step = { kind: 'tool', title: String(r.title ?? ''), status: String(r.status ?? ''), toolKind: String(r.kind ?? '') };
      talking = false;
    }
  }
  return { promptSeq: prompt.seq, since: (Number(prompt.time) || 0) * 1000, step, steps, endSeq, talking };
}

export interface HelperFacts {
  id: string;
  title: string;
  description: string;
  state: string;
  created: number;
  firstSeq: number;
  lastSeq: number;
  lastTime: number;
  events: number;
  background: boolean;
  model: string;
  used: number;
  activity: string;
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Per helper session: what the helpers list, Activity strip and cards show, from its events (no helper events on the wire). */
export function helperFacts(source: EventSource): Record<string, HelperFacts> {
  const main = source.mainSession;
  const out = new Map<string, HelperFacts & { msg: string }>();
  const background = new Map<string, boolean>();
  const facts = (id: string, e: Ev) => {
    let f = out.get(id);
    if (!f) {
      f = {
        id, title: '', description: '', state: 'Live stream', created: Number(e.time) || 0, firstSeq: e.seq, lastSeq: e.seq,
        lastTime: Number(e.time) || 0, events: 0, background: false, model: '', used: 0, activity: '', msg: '',
      };
      out.set(id, f);
    }
    return f;
  };
  for (const e of source.events()) {
    const u = upd(e);
    if (u?.sessionUpdate === 'tool_call_update' && isObj(u.background) && typeof u.background.helper === 'string') {
      background.set(u.background.helper, u.background.state === 'running');
    }
    if (u?.sessionUpdate === 'subagent_update') {
      const child = isObj(u.subagent) ? u.subagent : u;
      const id = String(child.sessionId || child.subagentSessionId || '');
      if (id && id !== main) {
        const f = facts(id, e);
        if (typeof child.title === 'string' && child.title.trim()) f.title = child.title.slice(0, 500);
        if (typeof child.description === 'string' && child.description.trim()) f.description = child.description.slice(0, 500);
        const st = isObj(child.state) ? child.state.state : child.state ?? child.status;
        if (typeof st === 'string' && st) f.state = st;
        else if (f.state === 'Live stream') f.state = 'Available';
        if (typeof child.model === 'string' && child.model) f.model = child.model;
      }
    }
    const sid = sessionOf(e, main);
    if (sid === main) continue;
    const f = facts(sid, e);
    f.events++;
    f.lastSeq = e.seq;
    f.lastTime = Number(e.time) || f.lastTime;
    if (!u) continue;
    if (u.sessionUpdate === 'agent_message_chunk') {
      f.msg = (f.msg + (typeof u.content?.text === 'string' ? u.content.text : '')).slice(-2000);
      const line = oneLine(f.msg);
      if (line) f.activity = line.slice(-200);
    } else if (u.sessionUpdate === 'agent_thought_chunk') {
      f.activity = 'Thinking';
      f.msg = '';
    } else if (u.sessionUpdate === 'tool_call') {
      f.activity = oneLine(String(u.title ?? u.kind ?? '')).slice(0, 200);
      f.msg = '';
    } else if (u.sessionUpdate === 'usage_update' && Number(u.used) > 0) f.used = Number(u.used);
  }
  const result: Record<string, HelperFacts> = {};
  for (const [id, { msg: _msg, ...f }] of out) result[id] = { ...f, background: background.get(id) === true };
  return result;
}

// ---- clipping -------------------------------------------------------------------------------------------------------------------
function clipValue(v: unknown, limit: number, state: { cut: boolean }, key = '', parent: Record<string, any> | null = null): unknown {
  if (typeof v === 'string') {
    if (v.length <= limit) return v;
    if (key === 'data' && parent && ATTACH_TYPES.has(parent.type)) return v; // a picture's bytes: never cut
    state.cut = true;
    return v.slice(0, limit) + `\n\n[Clipped: ${v.length} characters; open the full output to see all]`;
  }
  if (Array.isArray(v)) return v.map((x) => clipValue(x, limit, state));
  if (isObj(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = clipValue(x, limit, state, k, v);
    return out;
  }
  return v;
}

export function byteSize(e: unknown): number {
  return ENC.encode(JSON.stringify(e)).length;
}

/** A tool event cut to the page's own limit: {..., clipped: true, bytes: full size}. Other events are returned as they are. */
export function clipEvent(e: Ev, limit = CLIP_CHARS): Ev {
  const u = upd(e);
  if (!limit || !u || (u.sessionUpdate !== 'tool_call' && u.sessionUpdate !== 'tool_call_update')) return e;
  const full = byteSize(e);
  if (full <= limit) return e;
  const state = { cut: false };
  const data = clipValue(e.data, limit, state) as Record<string, any>;
  return state.cut ? { ...e, data, clipped: true, bytes: full } : e;
}

// ---- pages ------------------------------------------------------------------------------------------------------------------
export interface PageQuery {
  /** 'main' (the chat's own events; default) or a helper's session id. */
  session?: string;
  before?: number;
  after?: number;
  around?: number;
  /** The byte budget of the page's events. */
  bytes?: number;
  /** Clip tool events to this many characters per string (0: none). */
  clip?: number;
}

export interface Page {
  session: string;
  events: Ev[];
  /** The page's first and last seq (0, 0 when it is empty). */
  from: number;
  to: number;
  /** Older events of this session exist before `from`. */
  more: boolean;
  /** Newer events of this session exist after `to`. */
  newer: boolean;
  /** The oldest kept seq of this session (the history notice reads it). */
  first: number;
  cursor: number;
  stable: number;
  eventsId: string;
  bytes: number;
  edge: Edge;
  /** The main session's open page (no before/after/around) also carries what the page's readers need. */
  turn?: TurnFacts;
  helpers?: Record<string, HelperFacts>;
}

const budget = (q: PageQuery) => Math.max(MIN_PAGE_BYTES, Math.min(MAX_PAGE_BYTES, Math.trunc(Number(q.bytes) || PAGE_BYTES)));

/** One page of a session's events: the tail, before=, after= or around= (see PageQuery). */
export function page(source: EventSource, query: PageQuery = {}): Page {
  const main = source.mainSession;
  const session = !query.session || query.session === 'main' ? main : String(query.session);
  const clip = query.clip === undefined ? CLIP_CHARS : Math.max(0, Math.trunc(Number(query.clip)) || 0);
  const all = source.events().filter((e) => sessionOf(e, main) === session);
  const starts = rowStarts(all, session, main);
  const cap = budget(query);
  const out = all.map((e) => clipEvent(e, clip));
  const size = (i: number) => byteSize(out[i]);
  // the index of the first event with seq >= s
  const at = (s: number) => {
    let lo = 0, hi = all.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (all[mid].seq < s) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  // back from `end` (exclusive) while the budget lasts, then down to the start of the run there (a page never starts in a row)
  const back = (end: number, room: number) => {
    let i = end, used = 0;
    while (i > 0 && (i === end || used + size(i - 1) <= room)) used += size(--i);
    if (i < all.length && i < end) {
      const start = starts.get(all[i].seq)!;
      while (i > 0 && all[i].seq > start) i--;
    }
    return i;
  };
  const forward = (from: number, room: number) => {
    let i = from, used = 0;
    while (i < all.length && (i === from || used + size(i) <= room)) used += size(i++);
    return i;
  };
  let lo: number, hi: number;
  if (query.around !== undefined && query.around !== null && !Number.isNaN(Number(query.around))) {
    const mid = Math.min(at(Number(query.around)), Math.max(0, all.length - 1));
    lo = back(mid + 1, cap / 2);
    hi = forward(mid + 1, cap / 2);
    if (hi === mid + 1 && mid + 1 < all.length && size(mid + 1) > cap / 2) hi = mid + 1; // keep the first after only within budget
  } else if (query.before !== undefined && query.before !== null && !Number.isNaN(Number(query.before))) {
    hi = at(Number(query.before));
    lo = hi > 0 ? back(hi, cap) : 0;
  } else if (query.after !== undefined && query.after !== null && !Number.isNaN(Number(query.after))) {
    lo = at(Number(query.after) + 1);
    hi = forward(lo, cap);
  } else {
    hi = all.length;
    lo = back(hi, cap);
  }
  const events = out.slice(lo, hi);
  const from = events.length ? events[0].seq : 0;
  const to = events.length ? events[events.length - 1].seq : 0;
  const open = query.around === undefined && query.before === undefined && query.after === undefined;
  const result: Page = {
    session: session === main ? 'main' : session,
    events,
    from,
    to,
    more: lo > 0,
    newer: hi < all.length,
    first: all.length ? all[0].seq : 0,
    cursor: source.cursor,
    stable: source.stable,
    eventsId: source.eventsId,
    bytes: events.reduce((n, e) => n + byteSize(e), 0),
    edge: edgeAt(source, from || source.cursor + 1, session),
  };
  if (open && session === main) {
    result.turn = turnFacts(source);
    result.helpers = helperFacts(source);
  }
  return result;
}

/** One event whole (a clipped tool output's "Show full output"), or null when it is not kept. */
export function fullEvent(source: EventSource, seq: number): Ev | null {
  const all = source.events();
  let lo = 0, hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid].seq < seq) lo = mid + 1;
    else hi = mid;
  }
  return lo < all.length && all[lo].seq === seq ? all[lo] : null;
}

/** The query from URL / RPC arguments (numbers as text are fine; anything else is left out). */
export function pageQuery(a: Record<string, unknown>): PageQuery {
  const num = (v: unknown) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? undefined : Math.trunc(Number(v)));
  const q: PageQuery = {};
  if (typeof a.session === 'string' && a.session) q.session = a.session.slice(0, 300);
  for (const k of ['before', 'after', 'around', 'bytes', 'clip'] as const) {
    const n = num(a[k]);
    if (n !== undefined) q[k] = n;
  }
  return q;
}
