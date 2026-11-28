/**
 * Aib methods: what the page reads: live list, state, events, writes, busy and working lists, ownership.
 * Moved out of aib.ts (no change).
 */
import { errorText, historyV2 } from '../acp/connection.ts';
import { HistoryClient } from '../history/client.ts';
import { fullEvent, page, type PageQuery, pageQuery } from '../acp/event_pages.ts';
import * as agentRegistry from '../agents/agent_registry.ts';
import { isDict, isStr, pyLen, pyRepr, ValueError } from '../core/py.ts';
import { ACTIVE_WINDOW_SECONDS } from '../ownership/probe.ts';
import { isNetworkPath } from '../web/security.ts';
import { isForeignPath } from '../platform/location.ts';
import { wslLoc } from '../wsl/access.ts';
import { blockedCount } from '../attention/inbox_rules.ts';
import { log, type Json, CLOSED_GRACE_SECONDS, MAX_CLOSED_CONNECTIONS, ADOPT_WAIT_MS } from './aib_util.ts';
import { pairKey } from './aib_options.ts';
import type { Aib } from './aib.ts';

export const viewMethods = {
  liveInfo(this: Aib): Promise<Json> {
    const openIds = [...this.connections.values()].filter((c) => !c.closed).map((c) => c.id);
    return Promise.resolve({
      instanceId: this.instanceId,
      pid: Deno.pid,
      durableRecovery: !!this.store,
      ownerAnnouncements: !!this.owners,
      connections: openIds,
    });
  },

  /**
   * Forget closed connections: any closed longer than CLOSED_GRACE_SECONDS, then the oldest beyond MAX_CLOSED_CONNECTIONS. Until then
   * a closed connection stays so the page can read its `disconnected` state. Dropping it frees its events and images.
   */
  evictClosed(this: Aib, nowSeconds: number | null = null): string[] {
    const now = nowSeconds ?? this.clock();
    const closed = [...this.connections.values()].filter((c) => c.closed && c.closedAt !== null).sort((a, b) => a.closedAt! - b.closedAt!);
    const drop = closed.filter((c) => now - c.closedAt! > CLOSED_GRACE_SECONDS);
    const keep = closed.filter((c) => !drop.includes(c));
    drop.push(...keep.slice(0, Math.max(0, keep.length - MAX_CLOSED_CONNECTIONS)));
    for (const c of drop) this.connections.delete(c.id);
    for (const c of drop) {
      try {
        c.tree?.kill();
      } catch (error) {
        log.exception(error, 'Closing a dropped connection failed');
      }
      c.events.length = 0;
      c.eventImageBytes = 0;
    }
    return drop.map((c) => c.id);
  },

  liveListSync(this: Aib): Json {
    this.evictClosed();
    const listed: Json[] = [];
    for (const c of [...this.connections.values()]) {
      const item = c.public(0, true);
      delete item.events;
      delete item.permissions;
      item.reconnecting = this.reconnectPending.has(pairKey(c.provider, c.sessionId)) && !c.closed;
      listed.push(item);
    }
    return {
      connections: listed,
      autoReconnect: !!(this.store && this.autoReconnect),
      recovered: this.recovered(),
      reconnectFailed: this.reconnectFailed(),
      recoveryWarning: this.store ? this.store.warning : '',
      instanceId: this.instanceId,
      takingOver: this.takingOver(), // the swarm ends no finished helper's chat before the take-over at start has finished
      allowRulesTampered: this.allow ? this.allow.tampered() : false, // the page's "Allow rules are off" banner
    };
  },

  liveList(this: Aib): Promise<Json> {
    return Promise.resolve(this.liveListSync());
  },

  /** Resolves when the take-over from the keeper has finished (at most 20 s); later calls resolve at once. */
  async $afterAdopting(this: Aib): Promise<void> {
    const adopting = this.$adopting;
    if (!adopting) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([adopting.catch(() => 0), new Promise((resolve) => (timer = setTimeout(resolve, ADOPT_WAIT_MS)))]);
    clearTimeout(timer);
  },

  liveState(this: Aib, connectionId: unknown, after: unknown = 0, wait = true): Promise<Json | null> {
    const connection = isStr(connectionId) ? this.connections.get(connectionId) : undefined;
    if (connection === undefined) {
      // Taking chats over from the keeper right now: the page's chat may be one of them. Wait for it (bounded) instead of telling
      // the page the connection is gone, so it keeps the chat without reloading its list.
      if (wait && this.$adopting && !this.$adoptDone && isStr(connectionId)) {
        return this.$afterAdopting().then(() => this.liveState(connectionId, after, false));
      }
      return Promise.resolve(null);
    }
    const cursor = Math.trunc(Number(after));
    if (Number.isNaN(cursor)) return Promise.reject(new ValueError(`invalid literal for int() with base 10: ${pyRepr(after)}`));
    if (cursor === 0) void this.limits.refresh(connection); // a page opened this chat (at most once a minute per account)
    // turnByUser / forkHow: for the swarm service (helper chat:true, Fork this session); left out of Connection.public() (frozen answers)
    return Promise.resolve({
      ...connection.public(cursor),
      limits: this.limits.view(connection),
      ...(connection.userTurn() ? { turnByUser: true } : {}),
      ...(connection.forkHow ? { forkHow: connection.forkHow } : {}),
    });
  },

  /**
   * The history Worker (history-loading 2A): one SQLite store per keeper chat in <state>/history. With the aib-history-v2 switch
   * off (AIB_HISTORY_V2=0) new chats get no store (snapshots carry the history in chunk notes, as in beta.10), but a chat taken over
   * from the keeper whose store an earlier store-on build wrote (`chatId` given, `<state>/history/<id>.sqlite` there) keeps using
   * it: that build's snapshot notes carry no chunks and its journal was truncated after them, so the store is the only copy of the
   * history AIB has (without it the rebuilt chat would show no history at all).
   */
  historyClient(this: Aib, chatId?: string): HistoryClient | null {
    if (!this.hasStateDir || this.$closed) return null;
    const dir = `${this.stateDir}/history`;
    if (!historyV2()) {
      if (!chatId) return null;
      try {
        // store.ts storePath() (not imported: it loads node:sqlite, which stays in the Worker)
        if (!/^[A-Za-z0-9._-]{1,128}$/.test(chatId) || chatId.startsWith('.')) return null;
        if (!Deno.statSync(`${dir}/${chatId}.sqlite`).isFile) return null;
      } catch {
        return null; // no store for this chat (or not a chat id)
      }
      log.info('history: %s has a store from a store-on build; it keeps using it (the switch is off)', chatId);
    }
    if (this.$history === undefined) {
      try {
        Deno.mkdirSync(dir, { recursive: true });
        this.$history = new HistoryClient(dir);
      } catch (error) {
        log.warning('history: no store folder (%s); chats keep their history in the keeper notes', errorText(error));
        this.$history = null;
      }
    }
    return this.$history;
  },

  /**
   * One page of a chat's events (history loading, event_pages.ts): the tail by bytes, before= / after= / around= a seq, or one
   * helper's events (session=<its id>), with the page's boundary state. null when the connection is gone. While the chat is being
   * rebuilt from the keeper's record: an empty page with rebuilding: true (the page asks again, as with liveState).
   */
  liveEvents(this: Aib, connectionId: unknown, query: unknown = {}, wait = true): Promise<Json | null> {
    const connection = isStr(connectionId) ? this.connections.get(connectionId) : undefined;
    if (connection === undefined) {
      if (wait && this.$adopting && !this.$adoptDone && isStr(connectionId)) {
        return this.$afterAdopting().then(() => this.liveEvents(connectionId, query, false));
      }
      return Promise.resolve(null);
    }
    const q: PageQuery = pageQuery(isDict(query) ? query : {});
    if (connection.replaying && !connection.rebuildError && !connection.closed) {
      return Promise.resolve({ rebuilding: true, events: [], cursor: connection.sequence, eventsId: connection.eventsId });
    }
    const ram = page(connection.pageSource(), q);
    // Older than RAM keeps, or a helper RAM no longer holds: read from the chat's history store.
    const older = q.before !== undefined || q.around !== undefined || q.after !== undefined;
    const helper = !!q.session && q.session !== 'main' && q.session !== connection.sessionId;
    if (connection.historyState === 'claimed' && ((older && !ram.more && !ram.newer) || (helper && !ram.events.length) || (!older && !ram.more))) {
      return connection.storePage(q).then((stored) => {
        if (!stored) return ram as unknown as Json;
        if (!older && !helper) { // the open page: RAM's, but the history reaches back as far as the store does
          if (stored.first && (!ram.first || stored.first < ram.first)) ram.first = stored.first;
          ram.more = ram.more || (!!ram.from && !!stored.first && stored.first < ram.from);
          return ram as unknown as Json;
        }
        return (stored.events.length || !ram.events.length ? stored : ram) as unknown as Json;
      });
    }
    return Promise.resolve(ram as unknown as Json);
  },

  /** One event whole by seq (a clipped tool output's "Show full output"); null when the connection or the event is gone. */
  liveEvent(this: Aib, connectionId: unknown, seq: unknown): Promise<Json | null> {
    const connection = isStr(connectionId) ? this.connections.get(connectionId) : undefined;
    const n = Math.trunc(Number(seq));
    if (connection === undefined || !Number.isFinite(n)) return Promise.resolve(null);
    const kept = fullEvent(connection.pageSource(), n);
    if (kept || connection.historyState !== 'claimed') return Promise.resolve(kept as Json | null);
    return connection.storeEvent(n) as Promise<Json | null>;
  },

  /** Artifact created / new version: push {"type":"artifact",...} to the page as a normal conversation event (kind 'artifact'). */
  emitArtifact(this: Aib, conversationId: unknown, data: unknown): Promise<boolean> {
    const connection = isStr(conversationId) ? this.connections.get(conversationId) : undefined;
    if (connection === undefined) return Promise.resolve(false);
    connection.recordedEvent('artifact', data); // in the keeper's record too: a rebuild shows it and numbers events the same
    return Promise.resolve(true);
  },

  /** {connection id: [file paths that connection's agent wrote]} for open connections (the artifact watcher's only source). */
  liveWrites(this: Aib): Promise<Record<string, string[]>> {
    const open = [...this.connections.values()].filter((c) => !c.closed);
    return Promise.resolve(Object.fromEntries(open.map((c) => [c.id, c.writes.written()])));
  },

  /**
   * Open connections that must not be cut off: working, still opening, waiting for a person, or idle with background helpers still
   * running ('helpers': a Claude Code turn ended while its helpers go on; stopping the agent would kill them), or with a background
   * shell still running ('background': a Bash command Claude Code started with run_in_background, such as a long test run; stopping
   * the agent would kill it). Neither of the last two shows as working in the chat or holds its queue.
   */
  busyList(this: Aib): Json[] {
    const busy: Json[] = [];
    for (const c of [...this.connections.values()]) {
      const state = c.attention().state;
      if (state === 'working' || state === 'opening' || state === 'needs_you') {
        busy.push({ id: c.id, provider: c.provider, cwd: c.cwd, state });
      } else if (state === 'idle' && c.helpersRunning?.()) {
        busy.push({ id: c.id, provider: c.provider, cwd: c.cwd, state: 'helpers' });
      } else if (state === 'idle' && c.backgroundShellsRunning?.()) {
        busy.push({ id: c.id, provider: c.provider, cwd: c.cwd, state: 'background' });
      }
    }
    return busy;
  },

  /**
   * Everything that keeps an app's agent host alive with no app attached (docs/agent-host.md "Lifecycle"): busyList (a turn running,
   * an agent opening, a chat waiting for the person) plus chats with queued prompts and running agent install or sign-in jobs. A chat
   * that is open but idle is not in it.
   */
  workingList(this: Aib): Json[] {
    const working = this.busyList();
    const listed = new Set(working.map((w) => w.id));
    for (const c of [...this.connections.values()]) {
      if (!c.closed && !listed.has(c.id) && c.queue.items.length) {
        working.push({ id: c.id, provider: c.provider, cwd: c.cwd, state: 'queued' });
      }
    }
    for (const [agent, job] of this.installer?.jobs ?? []) {
      if (job.alive) working.push({ id: `install:${agent}`, provider: agent, cwd: '', state: 'installing' });
    }
    for (const [agent, job] of this.signer?.jobs ?? []) {
      if (job.alive) working.push({ id: `signin:${agent}`, provider: agent, cwd: '', state: 'needs_you' });
    }
    return working;
  },

  busyConnections(this: Aib): Promise<Json[]> {
    return Promise.resolve(this.busyList());
  },

  /**
   * How many chats are blocked on the person (an open request, a failed turn, a question in the last reply): the one number of
   * the inbox (inbox-rules.js), which both tray icons show. A running sign-in job is not a chat and does not count. openOnPc: the
   * chats open in the AIB window (Presence.openOnPc), left out of the desktop's count.
   */
  blockedChats(this: Aib, openOnPc: string[] = []): number {
    const open = [...this.connections.values()].filter((c) => !c.closed);
    const chats = open.map((c) => ({ provider: c.provider, sessionId: c.sessionId, attention: c.attention() }));
    return blockedCount(chats, this.conversations.public().entries as unknown as Record<string, unknown>, Date.now() / 1000, openOnPc);
  },

  aibOwns(this: Aib, provider: unknown, sessionId: unknown): Promise<boolean> {
    return Promise.resolve(this.$aibOwns(provider as string, sessionId as string));
  },

  ownershipQuery(this: Aib, provider = '', sessionId = '', cwd = ''): Promise<unknown> {
    try {
      if (!provider && !sessionId) {
        this.probe.refreshProcessesAsync();
        this.$refreshWslHints();
        // a WSL session's hints come from its distro (session ids never repeat across systems), the Windows ones win a clash. The
        // distro cannot tell AIB's own transcript writes: a chat this AIB runs, or released in the last two minutes, has none.
        const wsl: Record<string, unknown> = {};
        for (const [key, hint] of Object.entries(Object.assign({}, ...[...this.$wslHints.values()].map((h) => h.hints)))) {
          const at = key.indexOf(':');
          const [p, s] = [key.slice(0, at), key.slice(at + 1)];
          const released = this.probe.releasedAt(p, s);
          if (this.$aibOwns(p, s) || (released !== null && this.probe.clock() - released < ACTIVE_WINDOW_SECONDS)) continue;
          wsl[key] = hint;
        }
        return Promise.resolve({ hints: { ...wsl, ...this.probe.hints() }, certainty: this.probe.listCertainty() });
      }
      if (!agentRegistry.isProvider(provider) || !sessionId || pyLen(sessionId) > 512) {
        throw new ValueError('Choose a provider and a saved session ID');
      }
      const wsl = wslLoc(cwd);
      if (wsl) {
        if (this.$aibOwns(provider, sessionId)) return Promise.resolve(this.probe.assess(provider, sessionId)); // owned_by_studio
        return this.$wslAssess(provider, sessionId, wsl, null).then((answer) => answer.assessment);
      }
      if (isNetworkPath(cwd) || isForeignPath(cwd)) throw new ValueError('Network and device paths are not supported');
      return Promise.resolve(this.probe.assess(provider, sessionId, { cwd: cwd || null, fresh: true }));
    } catch (error) {
      return Promise.reject(error);
    }
  },
};

export type ViewMethods = typeof viewMethods;
