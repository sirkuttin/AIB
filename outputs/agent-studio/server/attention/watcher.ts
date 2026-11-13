/**
 * AttentionWatcher: "a chat needs you" and "a chat finished", decided by the server, so desktop notifications and phone pushes come
 * with the AIB window closed (review break 10; design section 8).
 *
 * The same way in every mode: it reads the agent host's chat list (liveList: in-process, the keeper, or the split agent host) every
 * 2 s and compares what it sees with what it already announced (fired.ts, kept in the state folder):
 *
 *   needs you  once per question, approval or sign-in of a chat (the chat + the request's key). A request that came while AIB was
 *              down is announced once when AIB is back; one announced before a restart or a keeper take-over is not announced again.
 *   finished   once per finished turn (the chat + its turnEndedAt), only when the chat is really done: not while the queue is about
 *              to send its next message (that turn is not the end), and not while the chat's helpers or background shells still
 *              run. A turn that ended before this AIB first watched (older than the fired file, or more than 6 hours ago) is not news.
 *
 * Which chats may notify, the desktop app's choices and the 60 s grouping are the page's own rules (notify-rules.js, through
 * rules.ts). News about a chat that may not notify (muted, hidden, archived...) is still remembered, so unmuting it later does not
 * replay it. Where the news goes (desktop notification, phone pushes) is the Notifier's business (below).
 */
import { getLogger } from '../core/log.ts';
import type { LiveBackend } from '../host/backend.ts';
import { folderKinds } from '../desktop/folders.ts';
import type { ConversationState } from '../state/conversations.ts';
import type { ProjectPrefs } from '../state/projects.ts';
import type { ViewPrefs } from '../state/view_prefs.ts';
import type { ReadState } from '../state/read_state.ts';
import { FiredStore } from './fired.ts';
import { type ChatFacts, type Flags, type Group, type GroupEntry, type Kind, RULES } from './rules.ts';
import type { Presence } from './presence.ts';

const log = getLogger('attention');

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

export const POLL_MS = 2000;
/**
 * A finished turn is announced once the chat has stayed done this long: when a helper ends, Claude Code runs a short follow-up of
 * its own (idle for a moment between the two), and the queue picks its next message up a moment after a turn ends.
 */
export const SETTLE_MS = 3000;
/** A finished turn older than this when first seen is not announced (a chat AIB brought back after a long time away). */
export const TURN_FRESH_SECONDS = 6 * 3600;
const KIND_CACHE_MS = 60_000;

/** One piece of news: the page's chat key, the live chat's id, the kind and the chat's title. */
export interface Fire {
  key: string;
  chat: string;
  kind: Kind;
  title: string;
}

/** What the watcher reads besides the agent host (the web context's stores). */
export interface WatchSources {
  host: Pick<LiveBackend, 'liveList' | 'liveState' | 'busyConnections'>;
  conversations: Pick<ConversationState, 'public'>;
  projectPrefs: Pick<ProjectPrefs, 'public'>;
  viewPrefs: Pick<ViewPrefs, 'public'>;
  /** First prompts of chats with no other title (remote/payloads.ts TitleCache), when there is one. */
  firstPrompt?: (id: string) => string;
}

export interface WatcherOptions {
  stateDir: string | null;
  onFire: (fires: Fire[]) => void | Promise<void>;
  pollMs?: number;
  clock?: () => number;
  /** How long a chat must stay done before "finished" (SETTLE_MS). */
  settleMs?: number;
  /** Called after every look (the presence model ends phones that stopped polling then). */
  afterPoll?: () => void;
  /** Every chat list read (the phone's home keeps when each chat last changed state from it: remote/payloads.ts StateTimes). */
  onList?: (listing: unknown) => void;
  /** The folder kinds (worktree / scratch, a worktree's main checkout); tests pass their own. */
  kinds?: (path: string) => { worktree: boolean; scratch: boolean; worktreeOf?: string };
}

/** The page's chat key: provider:sessionId (chat.js aliasKey), the connection id until the chat has a session. */
export function chatKey(c: Json): string {
  return `${str(c.provider, 60)}:${str(c.sessionId, 300) || str(c.id, 100)}`;
}

export class AttentionWatcher {
  readonly fired: FiredStore;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #stopped = false;
  #busy: Promise<void> | null = null;
  /** chat id -> [signature of its waiting requests, their keys] (a permission's key needs one state read per change). */
  #needKeys = new Map<string, [string, string[]]>();
  #kinds = new Map<string, [number, { worktree: boolean; scratch: boolean; worktreeOf?: string }]>();
  /** Finished turns seen done (turn key -> since when, ms): announced once they stayed done for SETTLE_MS. */
  #settling = new Map<string, number>();
  readonly clock: () => number;

  constructor(readonly sources: WatchSources, readonly options: WatcherOptions) {
    this.clock = options.clock ?? Date.now;
    this.fired = new FiredStore(options.stateDir, () => this.clock() / 1000);
  }

  start(): void {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    const loop = async () => {
      if (!this.#running) return;
      await this.poll();
      try {
        this.options.afterPoll?.();
      } catch { /* never stops the loop */ }
      if (this.#running) this.#timer = setTimeout(loop, this.options.pollMs ?? POLL_MS);
    };
    this.#timer = setTimeout(loop, 0);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#running = false;
    if (this.#timer !== null) clearTimeout(this.#timer);
    await this.#busy?.catch(() => {});
  }

  /** One look at every chat (the loop calls it; tests call it directly). Never throws. */
  poll(): Promise<void> {
    if (this.#busy) return this.#busy;
    const run = this.#poll().catch((error) =>
      log.info('attention: could not read the chats (%s)', error instanceof Error ? error.message : error)
    )
      .finally(() => {
        this.#busy = null;
      });
    this.#busy = run;
    return run;
  }

  #kindOf(path: string) {
    const given = this.options.kinds;
    if (given) return given(path);
    const now = this.clock();
    const hit = this.#kinds.get(path);
    if (hit && now - hit[0] < KIND_CACHE_MS) return hit[1];
    const kind = folderKinds([path], true)[path] ?? { worktree: false, scratch: false };
    this.#kinds.set(path, [now, kind]);
    while (this.#kinds.size > 500) this.#kinds.delete(this.#kinds.keys().next().value!);
    return kind;
  }

  /** What the page knows of a live chat for the rules (workspace-ui.js normalize): its marks, its project's key and folder kind. */
  facts(c: Json, marks: Record<string, unknown>): ChatFacts {
    const mark = obj(marks[`${str(c.provider, 60)}:${str(c.sessionId, 300)}`]);
    const base = str(c.projectRoot, 2000) || str(c.cwd, 2000);
    const kind = base ? this.#kindOf(base) : { worktree: false, scratch: false };
    const root = (kind.worktreeOf && str(kind.worktreeOf, 2000)) || base; // a worktree chat is filed under its repository (sidebar-ui rootOf)
    const rootKind = root === base ? kind : this.#kindOf(root);
    return {
      archived: !!mark.archivedAt,
      deleted: !!mark.deletedAt,
      held: !!mark.holdAt,
      projectKey: RULES.pathKey(root) || 'none',
      worktree: !!rootKind.worktree || RULES.isWorktreePath(root),
      scratch: !!rootKind.scratch || RULES.isScratchPath(root),
    };
  }

  /** A chat's title as the page shows it: your name for it, the agent's session title, the saved title, its first prompt. */
  title(c: Json, names: Record<string, unknown>, marks: Record<string, unknown>): string {
    const key = chatKey(c);
    const mark = obj(marks[`${str(c.provider, 60)}:${str(c.sessionId, 300)}`]);
    return str(names[key], 170) || str(obj(obj(c.breadth).sessionInfo).title, 170) || str(mark.title, 170) ||
      str(this.sources.firstPrompt?.(str(c.id, 100)), 170) || 'Conversation';
  }

  /**
   * The lasting names of a waiting chat's requests (questions, approvals, sign-in), read again only when they change. A request's
   * own key is random and a chat rebuilt from the keeper's record (an AIB restart) gets new ones, so each request is named by the
   * event that announced it: its number and time, which a rebuild keeps (the record replays them) and a new agent never repeats.
   */
  async #requestKeys(c: Json, needs: number): Promise<string[]> {
    const id = str(c.id, 100);
    const elicitations = (Array.isArray(c.elicitations) ? c.elicitations : []).map((e) => str(obj(e).key, 300)).filter(Boolean);
    const sig = `${needs}|${elicitations.join(',')}|${c.auth ? 1 : 0}`;
    const known = this.#needKeys.get(id);
    if (known && known[0] === sig) return known[1];
    const cursor = Math.max(0, Math.trunc(Number(c.cursor) || 0));
    // The last events (a waiting chat adds few); the whole chat only when a request is older than that. Never cursor 0 (that read
    // also refreshes the account's usage limits).
    let state = obj(await this.sources.host.liveState(id, Math.max(1, cursor - 100)));
    const keysOf = (list: unknown) => (Array.isArray(list) ? list : []).map((p) => str(obj(p).key, 300)).filter(Boolean);
    const permissions = keysOf(state.permissions);
    const pending = [...permissions, ...elicitations];
    const named = new Map<string, string>();
    const look = (events: unknown) => {
      for (const e of (Array.isArray(events) ? events : []).map(obj)) {
        const k = str(obj(e.data).key, 300);
        if ((e.kind === 'permission' || e.kind === 'elicitation') && pending.includes(k)) named.set(k, `${e.seq}@${e.time}`);
      }
    };
    look(state.events);
    if (pending.some((k) => !named.has(k)) && cursor > 100) {
      state = obj(await this.sources.host.liveState(id, 1));
      look(state.events);
    }
    const name = (k: string) => named.get(k) ?? 'k:' + k;
    const keys = [...permissions.map((k) => 'p:' + name(k)), ...elicitations.map((k) => 'e:' + name(k)), ...(c.auth ? ['auth'] : [])];
    if (!keys.length) keys.push(`n:${needs}`); // a request with no key the list shows: one announcement per count
    this.#needKeys.set(id, [sig, keys]);
    return keys;
  }

  async #poll(): Promise<void> {
    const listing = obj(await this.sources.host.liveList());
    const connections = (Array.isArray(listing.connections) ? listing.connections : []).map(obj);
    if (listing.instanceId === 'host-unavailable') return; // the agent host is starting or gone: nothing to compare
    try {
      this.options.onList?.(listing);
    } catch { /* never stops a look */ }
    let still: Set<string> | null = null; // chats whose helpers or background shells still run
    const marks = this.sources.conversations.public().entries as Record<string, unknown>;
    const prefs = this.sources.projectPrefs.public();
    const viewPrefs = this.sources.viewPrefs.public().prefs;
    let names: Record<string, unknown> = {};
    try {
      names = obj(JSON.parse(viewPrefs['studio-conversation-names'] ?? '{}'));
    } catch { /* no names */ }
    const nowSeconds = this.clock() / 1000;
    const news: (Fire & { fk: string; flags: Flags })[] = [];
    const quiet: string[] = [];
    const seen = new Set<string>();
    const done = new Set<string>(); // turn keys seen done in this look
    for (const c of connections) {
      const id = str(c.id, 100);
      if (!id || c.closed) continue;
      seen.add(id);
      const attention = obj(c.attention);
      const state = str(attention.state, 20);
      const key = chatKey(c);
      const flags = RULES.flags(this.facts(c, marks), prefs);
      const title = () => this.title(c, names, marks);
      if (state === 'needs_you') {
        const needs = Math.max(1, Number(attention.needs) || 1);
        for (const request of await this.#requestKeys(c, needs)) {
          const fk = `needs|${key}|${request}`;
          if (this.fired.has(fk) || news.some((n) => n.fk === fk)) continue;
          if (RULES.notifies('needs', flags)) news.push({ key, chat: id, kind: 'needs', title: title(), fk, flags });
          else quiet.push(fk);
        }
        continue;
      }
      const ended = attention.turnEndedAt;
      if (state !== 'idle' || typeof ended !== 'string' || !ended) continue;
      const fk = `turn|${key}|${ended}`;
      if (this.fired.has(fk)) continue;
      const at = Date.parse(ended) / 1000;
      if (!(at >= Math.floor(this.fired.since) - 1) || nowSeconds - at > TURN_FRESH_SECONDS) {
        quiet.push(fk); // old news: a turn that ended before this AIB watched
        continue;
      }
      // The queue sends its next message now: this turn is not the end of the work.
      const queue = obj(c.queue);
      if (Array.isArray(queue.items) && queue.items.length && !queue.paused) continue;
      // Helpers or a background shell of this chat still run: finished only once they are done (checked again next time).
      still ??= new Set(
        ((await this.sources.host.busyConnections()) as unknown[]).map(obj).filter((b) => b.state === 'helpers' || b.state === 'background')
          .map((b) => str(b.id, 100)),
      );
      if (still.has(id)) continue;
      // done now: announced once it stayed done a moment (a helper's follow-up or the queue's next message comes right after)
      done.add(fk);
      const since = this.#settling.get(fk);
      if (since === undefined) this.#settling.set(fk, this.clock());
      if (since === undefined || this.clock() - since < (this.options.settleMs ?? SETTLE_MS)) continue;
      if (RULES.notifies('turn', flags)) news.push({ key, chat: id, kind: 'turn', title: title(), fk, flags });
      else quiet.push(fk);
    }
    for (const fk of [...this.#settling.keys()]) if (!done.has(fk)) this.#settling.delete(fk);
    for (const id of [...this.#needKeys.keys()]) if (!seen.has(id)) this.#needKeys.delete(id);
    if (quiet.length) this.fired.add(quiet);
    if (!news.length) return;
    const fresh = new Set(this.fired.add(news.map((n) => n.fk)));
    const fires = news.filter((n) => fresh.has(n.fk)).map(({ key, chat, kind, title }) => ({ key, chat, kind, title }));
    // One fire per chat and kind in one look (several requests of one chat at once are one piece of news).
    const once = new Map<string, Fire>();
    for (const f of fires) once.set(`${f.kind}|${f.key}`, f);
    if (once.size) await this.options.onFire([...once.values()]);
  }
}

// ---- where the news goes ------------------------------------------------------------------------------------------------------

/** A desktop notification (server/desktop/notify.ts DesktopNotifications.show). */
export type DesktopShow = (
  req: { title: string; body: string; target: { type: 'chat'; key: string } | { type: 'inbox' }; test: boolean },
) => Promise<{ shown: boolean; reason?: string }>;

export interface NotifierOptions {
  /** The desktop app's notifications; null in a server run (a browser shows its own). */
  desktop: () => DesktopShow | null;
  /** Sends one push to every phone that may get it (remote/push.ts); null while there is nothing to send to. */
  push: () => ((text: ReturnType<typeof RULES.pushText>) => Promise<unknown>) | null;
  presence: Presence;
  /** The saved view preferences (the desktop app's notification choices live there). */
  viewPrefs: Pick<ViewPrefs, 'public'>;
  /** Marks a chat read on the PC (its page key): its turn ended while a phone showed it. */
  markRead?: (key: string) => void;
  clock?: () => number;
  /** Tests: everything sent, in order. */
  record?: (what: { to: 'desktop' | 'push' | 'banner' | 'read'; text: unknown; fires: Fire[] }) => void;
}

const bare = ({ key, chat, kind, title }: Fire): Fire => ({ key, chat, kind, title });

/**
 * The 60 s groups and where news goes, by where the owner is looking (notify-rules.js route, attention/presence.ts):
 *   desktop  when no AIB window has focus (Presence.focused), no phone shows that chat, and the desktop app's choices want this
 *            kind; one notification per group (a newer one replaces the older), its click opens the chat (one) or the inbox.
 *   push     to the paired phones whose Push switch is on, unless the owner is active at the PC (Presence.active) or a phone page
 *            is on screen: then each visible phone's page gets it as a banner instead (the one showing that chat already sees it;
 *            a finished turn there also marks the chat read on the PC). A banner no phone got (the page was hidden before its next
 *            poll) goes out the usual way when that phone's time on screen ends.
 */
export class Notifier {
  #desktop: Group | null = null;
  #push: Group | null = null;
  readonly clock: () => number;
  #off: () => void;
  /** Sends for phones whose time on screen ended, in order. */
  #queue: Promise<void> = Promise.resolve();

  constructor(readonly options: NotifierOptions) {
    this.clock = options.clock ?? Date.now;
    this.#off = options.presence.onPhoneEnded((e) => {
      if (!e.undelivered.length) return;
      const fires = e.undelivered.map(bare);
      const desktop = e.undelivered.filter((u) => u.desktopSkipped).map(bare);
      this.#queue = this.#queue.then(() => this.#send(desktop, fires, fires)).catch(() => {});
    });
  }

  /** Stops listening to the presence model (the watcher stopped). */
  close(): void {
    this.#off();
  }

  /** Everything queued so far has been sent (tests). */
  settled(): Promise<void> {
    return this.#queue;
  }

  async fire(fires: Fire[]): Promise<void> {
    const presence = this.options.presence;
    const view = { pcFocused: presence.focused(), pcActive: presence.active(), phones: presence.phones().map((p) => p.chat) };
    const desktop: Fire[] = [];
    const push: Fire[] = [];
    for (const f of fires) {
      const r = RULES.route(f.kind, f.chat, view);
      if (r.desktop) desktop.push(f);
      if (r.push) push.push(f);
      if (r.banner) {
        presence.hold(bare(f), !r.desktop && !view.pcFocused);
        this.options.record?.({ to: 'banner', text: { kind: f.kind, title: f.title, chat: f.chat }, fires: [f] });
      }
      if (r.read) {
        this.options.record?.({ to: 'read', text: { key: f.key }, fires: [f] });
        try {
          this.options.markRead?.(f.key);
        } catch { /* the read position is a nicety */ }
      }
    }
    await this.#send(desktop, push, fires);
  }

  async #send(desktopFires: Fire[], pushFires: Fire[], fires: Fire[]): Promise<void> {
    const now = this.clock();
    const entries = (list: Fire[]): GroupEntry[] => list.map((f) => ({ key: f.key, title: f.title, kind: f.kind, chat: f.chat }));
    const prefs = RULES.appPrefs(this.options.viewPrefs.public().prefs['studio-notifications-app']);
    const show = this.options.desktop();
    if (this.options.presence.focused()) this.#desktop = null; // AIB in front: the group has done its job (the page's comeBack)
    else if (show) {
      const wanted = entries(desktopFires).filter((i) => RULES.desktopWants(i.kind, prefs));
      if (wanted.length) {
        this.#desktop = RULES.addToGroup(this.#desktop, wanted, now).group;
        const d = RULES.describe(this.#desktop);
        const text = { title: d.title, body: d.body, target: d.target, test: false };
        this.options.record?.({ to: 'desktop', text, fires });
        try {
          await show(text);
        } catch (error) {
          log.info('attention: desktop notification failed (%s)', error instanceof Error ? error.message : error);
        }
      }
    }
    const push = this.options.push();
    if (!push) return;
    if (this.options.presence.active()) {
      this.#push = null;
      return;
    }
    if (!pushFires.length) return;
    this.#push = RULES.addToGroup(this.#push, entries(pushFires), now).group;
    const text = RULES.pushText(this.#push);
    this.options.record?.({ to: 'push', text, fires });
    try {
      await push(text);
    } catch (error) {
      log.info('attention: push failed (%s)', error instanceof Error ? error.message : error);
    }
  }
}

// ---- the web server's watcher ---------------------------------------------------------------------------------------------------

/** What startAttention needs of the web context (web/server.ts WebContext). */
export interface AttentionContext extends WatchSources {
  stateDir: string;
  presence: Presence;
  readState: Pick<ReadState, 'update'>;
  desktopNotify: { show: DesktopShow } | null;
  phone: {
    on: boolean;
    titles: { titles: Map<string, string>; seeList?: (listing: unknown) => void };
    push: { any(): boolean; send(m: ReturnType<typeof RULES.pushText>): Promise<unknown> };
  };
}

/**
 * The watcher main.ts starts once the server listens, in every mode: desktop notifications in the desktop app (ctx.desktopNotify),
 * pushes to the paired phones while Phone access is on. Tests (AGENT_STUDIO_TEST=1) may name a file in AIB_TEST_ATTENTION_LOG that
 * gets one JSON line per notification or push sent, instead of reading the OS.
 */
export function startAttention(ctx: AttentionContext, options: { pollMs?: number } = {}): AttentionWatcher {
  const logFile = Deno.env.get('AGENT_STUDIO_TEST') === '1' ? Deno.env.get('AIB_TEST_ATTENTION_LOG') ?? '' : '';
  const notifier = new Notifier({
    desktop: () => (ctx.desktopNotify ? (req) => ctx.desktopNotify!.show(req) : null),
    push: () => (ctx.phone.on && ctx.phone.push.any() ? (text) => ctx.phone.push.send(text) : null),
    presence: ctx.presence,
    viewPrefs: ctx.viewPrefs,
    // read now: a phone showed the chat when its turn ended (the PC's unread dot and the watcher agree)
    markRead: (key) => void ctx.readState.update({ set: { [key]: { seenAt: Date.now() } } }).catch(() => {}),
    record: logFile
      ? (what) => {
        try {
          Deno.writeTextFileSync(logFile, JSON.stringify({ ...what, at: Date.now() }) + '\n', { append: true });
        } catch { /* a test log only */ }
      }
      : undefined,
  });
  let sending: Promise<void> = Promise.resolve();
  const watcher = new AttentionWatcher(
    { ...ctx, firstPrompt: (id) => ctx.phone.titles.titles.get(id) ?? '' },
    {
      stateDir: ctx.stateDir,
      pollMs: options.pollMs,
      afterPoll: () => ctx.presence.sweep(),
      onList: (listing) => ctx.phone.titles.seeList?.(listing),
      // in order, without holding up the next look (a slow push service never delays a "needs you")
      onFire: (fires) => {
        sending = sending.then(() => notifier.fire(fires)).catch(() => {});
      },
    },
  );
  const stop = watcher.stop.bind(watcher);
  watcher.stop = async () => {
    notifier.close();
    await stop();
  };
  watcher.start();
  return watcher;
}
