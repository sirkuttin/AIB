/**
 * The server-built inbox (Inbox v3.1 phase 1): ONE place builds the inbox's rows, its count and every chat's phase, for the PC page
 * (GET /api/live/inbox), the phone (home.inbox in its home payload), the notifications (the AttentionWatcher) and both trays. The
 * rules themselves are inbox-rules.js rowsOf (pure, shared with the page); this file gathers each chat's facts for it:
 *
 *   the agent host's chat list (attention facts, what waits), the marks file (handled, hold, archive, snooze, a saved stall), the
 *   chat names (Rename), the project names, and ONE state read per chat when what it shows changed (the first open request with
 *   its body capped, the agent's last words, its last step). A chat the agent host no longer lists but whose mark says it stalled
 *   is still a row (its agent died mid-turn: only the marks know it).
 *
 * No data migration: rows are computed; the marks only gained fields (snoozedUntil, snoozedAt, snoozeSig, stalledAt, stallKind,
 * stallStep). The answer carries a version (a hash of what it shows) so a poller gets 204 when nothing changed.
 */
import { createHash } from 'node:crypto';
import type { LiveBackend } from '../host/backend.ts';
import type { ConversationState } from '../state/conversations.ts';
import type { ProjectPrefs } from '../state/projects.ts';
import { chatNamesOf, type ViewPrefs } from '../state/view_prefs.ts';
import { folderKinds } from '../desktop/folders.ts';
import { RULES } from './rules.ts';
import { phoneOptions } from '../remote/actions.ts';
import { type ChatFacts, INBOX, type InboxRows } from './inbox_rules.ts';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A string in a request body: at most this long (architect break 13). */
export const STRING_CAP = 2048;
/** A diff in a request body: its first lines only. */
export const DIFF_LINES = 40;
/** How long one answer waits for the state reads it needs (a slow agent host never holds the inbox up longer). */
export const DETAIL_WAIT_MS = 800;
const KIND_CACHE_MS = 60_000;

/** The inbox as every surface gets it. */
export interface Inbox extends InboxRows {
  version: string;
  /** Epoch seconds the rows were built at. */
  at: number;
}

const capString = (v: string, n = STRING_CAP) => (v.length > n ? v.slice(0, n - 1) + '…' : v);
const capLines = (v: unknown) => {
  if (typeof v !== 'string') return v;
  const lines = v.split(/\r?\n/);
  return capString(lines.length > DIFF_LINES ? lines.slice(0, DIFF_LINES).join('\n') + '\n…' : v, STRING_CAP * 4);
};

/** A copy of a value with every string capped (STRING_CAP) and at most 50 keys / items per level, 4 levels deep. */
function capValue(v: unknown, depth = 0): unknown {
  if (typeof v === 'string') return capString(v);
  if (Array.isArray(v)) return depth > 4 ? [] : v.slice(0, 50).map((x) => capValue(x, depth + 1));
  if (!v || typeof v !== 'object') return v;
  if (depth > 4) return {};
  const out: Json = {};
  for (const [k, x] of Object.entries(v as Json).slice(0, 50)) out[k] = capValue(x, depth + 1);
  return out;
}

/** An approval's body as a row carries it: the tool call (its input capped, a diff's first DIFF_LINES lines) and the options. */
export function capPermission(params: unknown): Json {
  const p = obj(params);
  const tc = obj(p.toolCall);
  const content = (Array.isArray(tc.content) ? tc.content : []).slice(0, 4).map((raw) => {
    const c = obj(raw);
    if (c.type === 'diff') return { type: 'diff', path: str(c.path, 1000), oldText: capLines(c.oldText), newText: capLines(c.newText) };
    return capValue(c, 2);
  });
  const toolCall: Json = {
    ...(tc.toolCallId !== undefined ? { toolCallId: str(tc.toolCallId, 200) } : {}),
    ...(tc.title !== undefined ? { title: capString(String(tc.title ?? '')) } : {}),
    ...(tc.kind !== undefined ? { kind: str(tc.kind, 40) } : {}),
    ...(tc.rawInput !== undefined ? { rawInput: capValue(tc.rawInput, 1) } : {}),
    ...(content.length ? { content } : {}),
    ...(Array.isArray(tc.locations) ? { locations: capValue(tc.locations.slice(0, 4), 1) } : {}),
  };
  const options = (Array.isArray(p.options) ? p.options : []).slice(0, 8).map((o) => {
    const x = obj(o);
    return { optionId: str(x.optionId, 200), name: str(x.name, 200), kind: str(x.kind, 40) };
  });
  return { toolCall, options, ...(p.title !== undefined ? { title: str(p.title, 400) } : {}) };
}

/** A question's body: its message, mode and (form) schema, capped. */
export function capQuestion(params: unknown): Json {
  const p = obj(params);
  return {
    message: capString(typeof p.message === 'string' ? p.message : ''),
    ...(p.mode !== undefined ? { mode: str(p.mode, 40) } : {}),
    ...(p.requestedSchema !== undefined ? { requestedSchema: capValue(p.requestedSchema, 1) } : {}),
  };
}

/** What one state read tells the inbox: the first open request, how many more wait, the agent's last words and its last step. */
export interface Details {
  request: ChatFacts['request'];
  more: number;
  lastText: string;
  lastStep: string;
}

/** The details of a chat from its state (newest events): main session only (a helper's own words and steps are not the chat's). */
export function detailsOf(state: Json): Details {
  const perms = Array.isArray(state.permissions) ? state.permissions.map(obj) : [];
  const asks = Array.isArray(state.elicitations) ? state.elicitations.map(obj) : [];
  let request: Details['request'] = null;
  if (perms.length) {
    // pcOnly: a phone may not answer it (a merge request, options it cannot tell apart: remote/actions.ts phoneOptions)
    const pcOnly = phoneOptions(perms[0].params).pcOnly;
    request = { kind: 'permission', key: str(perms[0].key, 300), params: capPermission(perms[0].params), ...(pcOnly ? { pcOnly } : {}) };
  }
  else if (asks.length) request = { kind: 'question', key: str(asks[0].key, 300), params: capQuestion(asks[0].params) };
  const main = typeof state.sessionId === 'string' ? state.sessionId : '';
  let text = '';
  let step = '';
  for (const raw of Array.isArray(state.events) ? state.events : []) {
    const e = obj(raw);
    const data = obj(e.data);
    if (e.kind === 'user') {
      text = '';
      continue;
    }
    if (e.kind !== 'update') continue;
    if (main && typeof data.sessionId === 'string' && data.sessionId && data.sessionId !== main) continue;
    const u = obj(data.update);
    const meta = obj(obj(u._meta).claudeCode);
    if (meta.parentToolUseId) continue; // a helper's
    if (u.sessionUpdate === 'agent_message_chunk') {
      const t = obj(u.content).text;
      if (typeof t === 'string') text = (text + t).slice(-16384);
    } else if (u.sessionUpdate === 'tool_call') {
      text = ''; // the agent's words after its last step
      const title = str(u.title, 200);
      if (title) step = title;
    }
  }
  return { request, more: Math.max(0, perms.length + asks.length - 1), lastText: text.trim(), lastStep: step };
}

/** What the inbox reads (the web context's stores). */
export interface InboxSources {
  host: Pick<LiveBackend, 'liveList' | 'liveState'>;
  conversations: Pick<ConversationState, 'public'>;
  projectPrefs: Pick<ProjectPrefs, 'public'>;
  viewPrefs: Pick<ViewPrefs, 'public'>;
  /** First prompts of chats with no other title (remote/payloads.ts TitleCache), when there is one. */
  firstPrompt?: (id: string) => string;
  /** The chats open in a visible AIB window (Presence.openOnPc): left out of the desktop's count (the trays). */
  openOnPc?: () => string[];
  /** The folder kinds (worktree / scratch, a worktree's main checkout); tests pass their own. */
  kinds?: (path: string) => { worktree: boolean; scratch: boolean; worktreeOf?: string };
  clock?: () => number;
}

/** The page's chat key: provider:sessionId (chat.js aliasKey), the connection id until the chat has a session. */
export function chatKeyOf(c: Json): string {
  return `${str(c.provider, 60)}:${str(c.sessionId, 300) || str(c.id, 100)}`;
}

export class InboxService {
  readonly clock: () => number;
  #kinds = new Map<string, [number, { worktree: boolean; scratch: boolean; worktreeOf?: string }]>();
  /** live id -> [signature of what it shows, details] */
  #details = new Map<string, [string, Details]>();
  #detailQueue = new Map<string, [string, number]>();
  #detailBusy = false;
  #detailWaiters: (() => void)[] = [];
  /** chat key -> [signature of its open requests, when the server first saw them (s)] */
  #requestAt = new Map<string, [string, number]>();
  #last: Inbox | null = null;
  #lastAt = 0;
  #building: Promise<Inbox> | null = null;

  constructor(readonly sources: InboxSources) {
    this.clock = sources.clock ?? Date.now;
  }

  #kindOf(path: string) {
    const given = this.sources.kinds;
    if (given) return given(path);
    const now = this.clock();
    const hit = this.#kinds.get(path);
    if (hit && now - hit[0] < KIND_CACHE_MS) return hit[1];
    const kind = folderKinds([path], true)[path] ?? { worktree: false, scratch: false };
    this.#kinds.set(path, [now, kind]);
    while (this.#kinds.size > 500) this.#kinds.delete(this.#kinds.keys().next().value!);
    return kind;
  }

  /** A chat's project as the page files and names it: a worktree under its repository; its saved display name, else the folder. */
  project(c: Json, prefs: unknown): { key: string; name: string; worktree: boolean; scratch: boolean } {
    const base = str(c.projectRoot, 2000) || str(c.cwd, 2000);
    if (!base) return { key: 'none', name: '', worktree: false, scratch: false };
    const kind = this.#kindOf(base);
    const root = (kind.worktreeOf && str(kind.worktreeOf, 2000)) || base;
    const rootKind = root === base ? kind : this.#kindOf(root);
    const key = RULES.pathKey(root) || 'none';
    const named = obj(obj(obj(prefs).projects)[key]).name;
    const parts = RULES.splitPath(root).segments;
    const name = typeof named === 'string' && named.trim() ? named.trim().slice(0, 120) : (parts[parts.length - 1] || '').slice(0, 120);
    return {
      key,
      name,
      worktree: !!rootKind.worktree || RULES.isWorktreePath(root),
      scratch: !!rootKind.scratch || RULES.isScratchPath(root),
    };
  }

  /** A chat's title as the page shows it: your name for it, the agent's session title, the saved title, its first prompt. */
  title(c: Json, names: Record<string, unknown>, marks: Record<string, unknown>): string {
    const key = chatKeyOf(c);
    const mark = obj(marks[`${str(c.provider, 60)}:${str(c.sessionId, 300)}`]);
    return str(names[key], 170) || str(obj(obj(c.breadth).sessionInfo).title, 170) || str(mark.title, 170) ||
      str(this.sources.firstPrompt?.(str(c.id, 100)), 170) || 'Conversation';
  }

  /** The inbox at most `maxAgeMs` old (the watcher refreshes it every 2 s; a page or phone poll in between reuses it). */
  current(maxAgeMs = 1000): Promise<Inbox> {
    if (this.#last && this.clock() - this.#lastAt <= maxAgeMs) return Promise.resolve(this.#last);
    return this.look();
  }

  #watchers = new Set<(inbox: Inbox) => void>();

  /** Calls fn with every inbox built from now on (Windows toasts drop the ones whose request was answered); returns the unwatch. */
  watch(fn: (inbox: Inbox) => void): () => void {
    this.#watchers.add(fn);
    return () => this.#watchers.delete(fn);
  }

  /** The last inbox built, or null before the first look. */
  latest(): Inbox | null {
    return this.#last;
  }

  /** Builds the inbox now, from this listing (the watcher's look) or a fresh one. One build at a time. */
  look(listing?: unknown): Promise<Inbox> {
    if (this.#building && listing === undefined) return this.#building;
    const run = (async () => {
      try {
        return await this.#build(listing === undefined ? await this.sources.host.liveList() : listing);
      } finally {
        this.#building = null;
      }
    })();
    this.#building = run;
    return run;
  }

  async #build(listingRaw: unknown): Promise<Inbox> {
    const listing = obj(listingRaw);
    const marks = this.sources.conversations.public().entries as unknown as Record<string, unknown>;
    const prefs = this.sources.projectPrefs.public();
    const names: Record<string, unknown> = chatNamesOf(this.sources.viewPrefs.public().prefs);
    const nowMs = this.clock();
    const now = nowMs / 1000;
    const facts: ChatFacts[] = [];
    const listed = new Set<string>();
    const want: [string, string, number][] = [];
    const connections = (Array.isArray(listing.connections) ? listing.connections : []).map(obj);
    // A chat listed twice (closed, then reopened): the open connection wins.
    connections.sort((a, b) => Number(!!b.closed) - Number(!!a.closed));
    for (const c of connections) {
      const id = str(c.id, 100);
      if (!id) continue;
      const key = chatKeyOf(c);
      const markKey = `${str(c.provider, 60)}:${str(c.sessionId, 300)}`;
      if (listed.has(key)) {
        const at = facts.findIndex((f) => f.key === key);
        if (at >= 0 && !c.closed && !facts[at].live) facts.splice(at, 1);
        else continue;
      }
      listed.add(key);
      const attention = obj(c.attention);
      const mark = marks[markKey];
      const live = !c.closed;
      const phase = INBOX.phaseOf(live ? attention : { ...attention, state: 'closed' }, mark, now);
      const p = this.project(c, prefs);
      const elicitations = Array.isArray(c.elicitations) ? c.elicitations.length : 0;
      const f: ChatFacts = {
        key,
        id,
        title: this.title(c, names, marks),
        project: { key: p.key, name: p.name },
        provider: str(c.provider, 60),
        agent: str(c.provider, 60),
        attention,
        mark,
        live,
        elicitations,
        auth: !!c.auth,
      };
      // when the server first saw this chat's open requests: the wait of a needs-you row
      if (phase === 'needs_you') {
        const sig = `${Number(attention.needs) || 0}|${(Array.isArray(c.elicitations) ? c.elicitations : []).map((e) => str(obj(e).key, 100)).join(',')}`;
        const known = this.#requestAt.get(key);
        if (!known) this.#requestAt.set(key, [sig, now]);
        f.requestAt = (known ?? [sig, now])[1];
      } else this.#requestAt.delete(key);
      // the details (request body, last words, last step) of a chat that has a row, read again when what it shows changed
      if (INBOX.blocked(phase) || phase === 'your_turn') {
        const sig = `${phase}|${Number(c.cursor) || 0}|${Number(attention.needs) || 0}|${elicitations}`;
        want.push([id, sig, Number(c.cursor) || 0]);
      }
      facts.push(f);
    }
    // stalled chats the agent host no longer lists: their mark is all there is
    for (const [key, raw] of Object.entries(marks)) {
      if (listed.has(key)) continue;
      const m = obj(raw);
      if (!m.stalledAt || m.archivedAt || m.deletedAt) continue;
      if (!INBOX.stallOf({}, m)) continue;
      const c = { provider: key.slice(0, key.indexOf(':')), sessionId: key.slice(key.indexOf(':') + 1), cwd: m.cwd, projectRoot: m.projectRoot };
      const p = this.project(c, prefs);
      facts.push({
        key,
        id: '',
        title: str(names[key], 170) || str(m.title, 170) || 'Conversation',
        project: { key: p.key, name: p.name },
        provider: c.provider,
        agent: c.provider,
        attention: { state: 'closed' },
        mark: m,
        live: false,
      });
    }
    for (const id of [...this.#details.keys()]) if (!connections.some((c) => str(c.id, 100) === id)) this.#details.delete(id);
    for (const [id, sig, cursor] of want) {
      const known = this.#details.get(id);
      if (!known || known[0] !== sig) this.#detailQueue.set(id, [sig, cursor]);
    }
    if (this.#detailQueue.size) {
      void this.#runDetails();
      await this.#settle(DETAIL_WAIT_MS);
    }
    for (const f of facts) {
      const d = f.id ? this.#details.get(f.id)?.[1] : undefined;
      if (!d) continue;
      f.request = d.request;
      f.more = d.more;
      f.lastText = d.lastText;
      f.lastStep = d.lastStep;
    }
    const rows = INBOX.rowsOf(facts, now, {});
    const body = { rows: rows.rows, count: rows.count, working: rows.working, snoozed: rows.snoozed };
    const version = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);
    const inbox: Inbox = { version, at: Math.floor(now), ...body };
    this.#last = inbox;
    this.#lastAt = nowMs;
    for (const fn of this.#watchers) {
      try {
        fn(inbox);
      } catch { /* a watcher never breaks a build */ }
    }
    return inbox;
  }

  #settle(ms: number): Promise<void> {
    if (!this.#detailBusy && !this.#detailQueue.size) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.#detailWaiters.push(done);
    });
  }

  async #runDetails(): Promise<void> {
    if (this.#detailBusy) return;
    this.#detailBusy = true;
    try {
      while (this.#detailQueue.size) {
        const [id, [sig, cursor]] = this.#detailQueue.entries().next().value!;
        this.#detailQueue.delete(id);
        try {
          // the newest events only; never cursor 0 (that read also refreshes the account's usage limits)
          const state = obj(await this.sources.host.liveState(id, Math.max(1, cursor - 120)));
          if (state.id || Array.isArray(state.events)) this.#details.set(id, [sig, detailsOf(state)]);
        } catch { /* gone */ }
        while (this.#details.size > 500) this.#details.delete(this.#details.keys().next().value!);
      }
    } finally {
      this.#detailBusy = false;
      for (const w of this.#detailWaiters.splice(0)) w();
    }
  }

  /** The count the desktop shows (trays, taskbar): Needs-you rows minus the chats open in a visible AIB window. */
  desktopCount(inbox: Inbox | null = this.#last): number {
    if (!inbox) return 0;
    const open = this.sources.openOnPc?.() ?? [];
    return inbox.rows.filter((r) => r.section === 'needs' && !INBOX.isOpen(r.key, open)).length;
  }
}
