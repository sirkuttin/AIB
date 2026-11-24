/**
 * Studio-side pin / hold / archive / delete / your-turn marks (state_store.ConversationState), shared by every browser and
 * every AIB (Python or Deno) on the state folder.
 *
 * One small JSON file keyed by 'provider:sessionId'. Nothing here touches the agent's own transcripts: "delete" is a tombstone
 * that hides a conversation from AIB and can be undone. Only entries that carry a mark are kept, and the file is bounded.
 */
import { isDict, isStr, pyFloat, pyLen, pyStrip, pyTruthy, ValueError } from '../core/py.ts';
import { isProvider } from '../agents/agent_registry.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson, VERSION } from './base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from './json.ts';
import { text } from './recovery.ts';

export interface Marks {
  pinnedAt: number;
  archivedAt: number;
  deletedAt: number;
  holdAt: number;
  yourTurnAt: number;
  /** When you last acted on the chat (sent, or Mark handled): a failure or a question the agent reported before it is handled. */
  handledAt: number;
  holdNote: string;
  agentDeleted: boolean;
  title: string;
  cwd: string;
  projectRoot: string;
  /** Inbox v3.1 snooze: the row stays out of the inbox until this time (s), unless it changed (its signature differs from
   * snoozeSig). Only kept while set. Never Hold: Hold clears Your turn and moves the chat in the sidebar. */
  snoozedUntil?: number;
  snoozedAt?: number;
  snoozeSig?: string;
  /** Inbox v3.1 stalled: the agent stopped mid-work (died mid-turn, or ended without a final message), as the watcher saw it. A
   * closed connection can leave the agent host's list, so the mark keeps the row. Only kept while set. */
  stalledAt?: number;
  stallKind?: string;
  stallStep?: string;
}

/** The inbox's own fields of a mark (setInbox): a snooze and a saved stall. 0 / '' clears one. */
export interface InboxMarks {
  snoozedUntil?: number;
  snoozedAt?: number;
  snoozeSig?: string;
  stalledAt?: number;
  stallKind?: string;
  stallStep?: string;
}

const ACTIONS = ['pin', 'unpin', 'hold', 'resume', 'archive', 'unarchive', 'delete', 'restore', 'your_turn', 'handled'] as const;

function hasControl(value: string): boolean {
  for (const ch of value) if (ch.codePointAt(0)! < 32) return true;
  return false;
}

export class ConversationState extends JsonFileStore {
  static FILE = 'studio-conversations.json';
  static MAX_ENTRIES = 2000;
  static ACTIONS: readonly string[] = ACTIONS;
  static MAX_NOTE = 120;

  /** 'provider:sessionId' -> marks (a Map: insertion order breaks pruning ties as Python's dict does). */
  entries = new Map<string, Marks>();

  /** No directory means in-memory only (used when an AIB is built without --state-dir). */
  constructor(stateDir: string | null = null) {
    super();
    this.path = stateDir ? inDir(stateDir, (this.constructor as typeof ConversationState).FILE) : null;
    this.reload();
  }

  #cls(): typeof ConversationState {
    return this.constructor as typeof ConversationState;
  }

  static sessionKey(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
  }

  /** A mark time: float(value) when it is a positive finite number, else 0. */
  static stamp(value: unknown): number {
    let number: number;
    try {
      number = pyFloat(value);
    } catch {
      return 0;
    }
    return number > 0 && number < Infinity ? number : 0;
  }

  static clean(key: unknown, item: unknown): Marks | null {
    if (!isStr(key) || !isDict(item)) return null;
    const index = key.indexOf(':');
    const provider = index < 0 ? key : key.slice(0, index);
    const sessionId = index < 0 ? '' : key.slice(index + 1);
    if (!isProvider(provider) || !sessionId || pyLen(sessionId) > 512) return null;
    const stamp = ConversationState.stamp;
    const pinnedAt = stamp(item.pinnedAt);
    const archivedAt = stamp(item.archivedAt);
    const deletedAt = stamp(item.deletedAt);
    const holdAt = stamp(item.holdAt);
    const yourTurnAt = stamp(item.yourTurnAt);
    const handledAt = stamp(item.handledAt);
    const snoozedUntil = stamp(item.snoozedUntil);
    const stalledAt = stamp(item.stalledAt);
    if (!pinnedAt && !archivedAt && !deletedAt && !holdAt && !yourTurnAt && !handledAt && !snoozedUntil && !stalledAt) return null;
    const cwd = text(item.cwd, 1024);
    // the inbox's fields, only while set (an entry without them reads exactly as before)
    const inbox: InboxMarks = {};
    if (snoozedUntil) {
      inbox.snoozedUntil = snoozedUntil;
      inbox.snoozedAt = stamp(item.snoozedAt);
      const sig = text(item.snoozeSig, 400);
      if (sig) inbox.snoozeSig = sig;
    }
    if (stalledAt) {
      inbox.stalledAt = stalledAt;
      inbox.stallKind = text(item.stallKind, 20);
      inbox.stallStep = text(item.stallStep, 200);
    }
    return {
      ...inbox,
      pinnedAt,
      archivedAt,
      deletedAt,
      holdAt,
      yourTurnAt,
      handledAt,
      holdNote: holdAt ? pyStrip(text(item.holdNote, this.MAX_NOTE)) : '',
      agentDeleted: pyTruthy(item.agentDeleted) && !!deletedAt,
      title: text(item.title, 200),
      cwd,
      projectRoot: text(item.projectRoot, 1024) || cwd, // a missing projectRoot means cwd
    };
  }

  protected reload(): void {
    if (this.path === null) {
      this.entries = new Map();
      return;
    }
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === 'busy') {
      // Keep the in-memory marks; the file is left alone until a read succeeds.
      this.unreadableNow('Saved pin/archive/delete marks could not be read just now; changes are paused.');
      return;
    }
    this.unreadable = false;
    this.entries = new Map();
    if (status === 'missing') return;
    if (status === 'corrupt') {
      this.warning = 'Saved pin/archive/delete marks were unreadable and were ignored.';
      quarantine(this.path);
      this.seen = this.stamp();
      return;
    }
    const entries = isDict(raw) && raw.version === VERSION ? raw.entries : null;
    if (!isDict(entries)) {
      this.warning = 'Saved pin/archive/delete marks have an unknown format and were ignored.';
      return;
    }
    this.warning = '';
    for (const [key, item] of entriesOf(entries).slice(0, this.#cls().MAX_ENTRIES)) {
      const entry = this.#cls().clean(key, item);
      if (entry) this.entries.set(key, entry);
    }
  }

  public(): { revision: string; entries: Record<string, Marks>; warning: string } {
    this.sync();
    const entries: Record<string, Marks> = {};
    for (const [key, value] of this.entries) entries[key] = { ...value };
    return { revision: `${this.nonce}.${this.counter}`, entries, warning: this.warning };
  }

  #prune(): void {
    const max = this.#cls().MAX_ENTRIES;
    if (this.entries.size <= max) return;
    const rank = (entry: Marks): [number, number] => [
      entry.agentDeleted ? 0 : entry.deletedAt ? 1 : entry.archivedAt ? 2 : 3,
      Math.max(entry.pinnedAt, entry.archivedAt, entry.deletedAt, entry.holdAt, entry.yourTurnAt, entry.handledAt),
    ];
    const sorted = [...this.entries].sort((a, b) => {
      const [x, y] = [rank(a[1]), rank(b[1])];
      return x[0] - y[0] || x[1] - y[1];
    });
    for (const [key] of sorted.slice(0, this.entries.size - max)) this.entries.delete(key);
  }

  #save(): void {
    if (this.path === null) return;
    this.requireReadable();
    saveJson(this.path, { version: VERSION, savedAt: now(), entries: this.entries }, '.studio-conversations-');
    this.seen = this.stamp();
  }

  /** Apply one action; the entry as saved (null when it carries no mark any more). Error messages reach the HTTP API. */
  apply(
    action: unknown,
    provider: unknown,
    sessionId: unknown,
    title: unknown = '',
    cwd: unknown = '',
    agentDeleted: unknown = false,
    note: unknown = '',
    projectRoot: unknown = '',
  ): Promise<Marks | null> {
    if (!isStr(action) || !this.#cls().ACTIONS.includes(action)) return Promise.reject(new ValueError('Unknown conversation action'));
    if (!isProvider(provider)) return Promise.reject(new ValueError('Choose a provider'));
    if (!isStr(sessionId) || !sessionId || pyLen(sessionId) > 512 || hasControl(sessionId)) {
      return Promise.reject(new ValueError('Choose a saved conversation'));
    }
    const key = ConversationState.sessionKey(provider, sessionId);
    const time = now();
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.entries);
      const entry: Marks = {
        ...(this.entries.get(key) ?? {
          pinnedAt: 0,
          archivedAt: 0,
          deletedAt: 0,
          holdAt: 0,
          holdNote: '',
          agentDeleted: false,
          title: '',
          cwd: '',
          projectRoot: '',
          yourTurnAt: 0,
          handledAt: 0,
        }),
      };
      if ((action === 'pin' || action === 'archive' || action === 'hold') && entry.deletedAt) {
        throw new ValueError('Restore this conversation first');
      }
      if (action === 'pin') {
        if (entry.archivedAt) throw new ValueError('Unarchive this conversation before pinning it');
        entry.pinnedAt = entry.pinnedAt || time;
        entry.holdAt = 0; // pinning a held chat takes it off hold
        entry.holdNote = '';
      } else if (action === 'unpin') {
        entry.pinnedAt = 0;
      } else if (action === 'hold') {
        if (entry.archivedAt) throw new ValueError('Unarchive this conversation before putting it on hold');
        entry.holdAt = entry.holdAt || time; // re-holding only updates the note
        entry.holdNote = pyStrip(text(note, this.#cls().MAX_NOTE));
        entry.pinnedAt = 0; // putting a pinned chat on hold unpins it
        entry.yourTurnAt = 0; // holding is acting on it
      } else if (action === 'resume') {
        entry.holdAt = 0;
        entry.holdNote = '';
      } else if (action === 'archive') {
        entry.archivedAt = entry.archivedAt || time;
        entry.pinnedAt = 0; // archiving unpins
        entry.holdAt = 0; // and clears on hold
        entry.holdNote = '';
        entry.yourTurnAt = 0;
      } else if (action === 'unarchive') {
        entry.archivedAt = 0;
      } else if (action === 'delete') {
        entry.deletedAt = entry.deletedAt || time;
        entry.pinnedAt = 0;
        entry.yourTurnAt = 0;
        entry.agentDeleted = entry.agentDeleted || pyTruthy(agentDeleted);
        entry.title = text(title, 200) || entry.title;
        entry.cwd = text(cwd, 1024) || entry.cwd;
        entry.projectRoot = text(projectRoot, 1024) || entry.projectRoot || entry.cwd;
      } else if (action === 'restore') {
        entry.deletedAt = 0;
        entry.agentDeleted = false;
      } else if (action === 'your_turn') {
        // The agent finished a turn. Parked chats (held / archived / deleted) are not waiting on anyone.
        if (entry.holdAt || entry.archivedAt || entry.deletedAt) return null;
        entry.yourTurnAt = time;
      } else if (action === 'handled') {
        entry.yourTurnAt = 0; // the user acted: replied, or clicked Mark handled
        // ...which also handles a failure or a question the agent reported until now (inbox-rules.js phaseOf). Only a chat
        // that carries another mark, or has one of those to clear, keeps the entry: nothing else needs remembering.
        entry.handledAt = time;
        delete entry.snoozedUntil; // a snooze is dropped once the row is handled
        delete entry.snoozedAt;
        delete entry.snoozeSig;
      }
      const cleaned = this.#cls().clean(key, entry);
      if (cleaned) this.entries.set(key, cleaned);
      else this.entries.delete(key);
      if (sameJson(this.entries, before)) return cleaned ? { ...cleaned } : null;
      this.#prune();
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.entries = before;
        this.warning = `AIB could not save pin/archive/delete marks: ${errorText(error)}`;
        throw new ValueError(this.warning);
      }
      this.warning = '';
      this.counter++;
      const saved = this.entries.get(key);
      return saved ? { ...saved } : null;
    });
  }

  /**
   * The inbox's own fields of one chat's mark (Inbox v3.1): a snooze (snoozedUntil, snoozedAt, snoozeSig) or a saved stall
   * (stalledAt, stallKind, stallStep). 0 / '' clears a field; the other marks are kept. `about` fills a new entry's title and folder
   * (a stalled chat may leave the agent host's list, and its row still needs them). The entry as saved, or null.
   */
  setInbox(
    provider: unknown,
    sessionId: unknown,
    patch: InboxMarks,
    about: { title?: string; cwd?: string; projectRoot?: string } = {},
  ): Promise<Marks | null> {
    if (!isProvider(provider)) return Promise.reject(new ValueError('Choose a provider'));
    if (!isStr(sessionId) || !sessionId || pyLen(sessionId) > 512 || hasControl(sessionId)) {
      return Promise.reject(new ValueError('Choose a saved conversation'));
    }
    const key = ConversationState.sessionKey(provider, sessionId);
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.entries);
      const entry: Record<string, unknown> = {
        ...(this.entries.get(key) ?? { pinnedAt: 0, archivedAt: 0, deletedAt: 0, holdAt: 0, yourTurnAt: 0, handledAt: 0 }),
      };
      for (const [k, v] of Object.entries(patch)) entry[k] = v;
      if (!entry.title && about.title) entry.title = about.title;
      if (!entry.cwd && about.cwd) entry.cwd = about.cwd;
      if (!entry.projectRoot && about.projectRoot) entry.projectRoot = about.projectRoot;
      const cleaned = this.#cls().clean(key, entry);
      if (cleaned) this.entries.set(key, cleaned);
      else this.entries.delete(key);
      if (sameJson(this.entries, before)) return cleaned ? { ...cleaned } : null;
      this.#prune();
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.entries = before;
        this.warning = `AIB could not save pin/archive/delete marks: ${errorText(error)}`;
        throw new ValueError(this.warning);
      }
      this.warning = '';
      this.counter++;
      const saved = this.entries.get(key);
      return saved ? { ...saved } : null;
    });
  }
}
