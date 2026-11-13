/**
 * What the user has seen in each chat (state_store.ReadState), kept on disk so it survives restarts and is the same in every
 * browser.
 *
 * Keyed by the chat's stable identity 'provider:sessionId' (what saved chats use), never a live connection id. seenAt is the
 * newest event time (epoch ms) the user has seen; seenIndex (optional) is how many messages had been seen, which places the
 * unread line again after a restart replays history without original times. Least recently written chats are dropped past
 * MAX_CHATS.
 *
 * markedUnreadAt (optional, epoch ms): "Mark as unread" from a phone (owner, phone card menu). The chat shows unread on the PC and the
 * phone until a read position newer than it arrives (any page or phone looking at the chat again), which clears it.
 */
import { isDict, isStr, pyLen, ValueError } from '../core/py.ts';
import { deepCopy, errorText, inDir, isOSError, JsonFileStore, sameJson, VERSION } from './base.ts';
import { entriesOf, now, quarantine, readJsonFile, saveJson } from './json.ts';

export interface ReadPosition {
  seenAt: number;
  seenIndex?: number;
  /** write order (time.time()), for the LRU cap */
  at: number;
  /** "Mark as unread" (epoch ms); cleared by a newer seenAt */
  markedUnreadAt?: number;
}

const PROVIDER = /^[a-z0-9][a-z0-9_-]*$/;

function hasControl(value: string): boolean {
  for (const ch of value) if (ch.codePointAt(0)! < 32) return true;
  return false;
}

export class ReadState extends JsonFileStore {
  static FILE = 'studio-read-state.json';
  static MAX_CHATS = 2000;
  static MAX_KEY = 300;
  static MAX_SET = 500;
  static MAX_TIME = 4102444800000; // year 2100, in ms: anything above is a unit mistake
  static MAX_INDEX = 10_000_000;

  chats = new Map<string, ReadPosition>();

  constructor(stateDir: string | null = null) {
    super();
    this.path = stateDir ? inDir(stateDir, (this.constructor as typeof ReadState).FILE) : null;
    this.reload();
  }

  #cls(): typeof ReadState {
    return this.constructor as typeof ReadState;
  }

  static key(value: unknown): string | null {
    if (!isStr(value)) return null;
    const length = pyLen(value);
    if (length < 3 || length > this.MAX_KEY || hasControl(value)) return null;
    const index = value.indexOf(':');
    const provider = index < 0 ? value : value.slice(0, index);
    const ident = index < 0 ? '' : value.slice(index + 1);
    return provider && ident && PROVIDER.test(provider) ? value : null;
  }

  /** int(value) for a non-negative number up to limit, else null (bool, NaN and text are refused). */
  static int(value: unknown, limit: number): number | null {
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > limit) return null;
    return Math.trunc(value);
  }

  static clean(item: unknown): ReadPosition | null {
    if (!isDict(item)) return null;
    const seenAt = this.int(item.seenAt, this.MAX_TIME);
    if (seenAt === null) return null;
    const out: Record<string, number> = { seenAt };
    const index = this.int(item.seenIndex, this.MAX_INDEX);
    if (index !== null) out.seenIndex = index;
    const at = item.at;
    out.at = typeof at === 'number' && !Number.isNaN(at) ? at : 0;
    const unread = this.int(item.markedUnreadAt, this.MAX_TIME);
    if (unread !== null && unread > seenAt) out.markedUnreadAt = unread;
    return out as unknown as ReadPosition;
  }

  protected reload(): void {
    if (this.path === null) {
      this.chats = new Map();
      return;
    }
    this.counter++;
    this.seen = this.stamp();
    const [status, raw] = readJsonFile(this.path);
    if (status === 'busy') {
      this.unreadableNow('Saved read positions could not be read just now; changes are paused.');
      return;
    }
    this.unreadable = false;
    this.chats = new Map();
    if (status === 'missing') return;
    if (status === 'corrupt') {
      this.warning = 'Saved read positions were unreadable and were ignored.';
      quarantine(this.path);
      this.seen = this.stamp();
      return;
    }
    if (!isDict(raw) || raw.version !== VERSION || !isDict(raw.chats)) {
      this.warning = 'Saved read positions have an unknown format and were ignored.';
      return;
    }
    this.warning = '';
    const cls = this.#cls();
    for (const [key, item] of entriesOf(raw.chats)) {
      const entry = cls.key(key) ? cls.clean(item) : null;
      if (entry) this.chats.set(key, entry);
    }
    this.#prune();
  }

  #prune(): void {
    const extra = this.chats.size - this.#cls().MAX_CHATS;
    if (extra > 0) {
      const sorted = [...this.chats].sort((a, b) => a[1].at - b[1].at); // stable, like Python's sorted
      for (const [key] of sorted.slice(0, extra)) this.chats.delete(key);
    }
  }

  public(): {
    revision: string;
    warning: string;
    chats: Record<string, { seenAt: number; seenIndex?: number; markedUnreadAt?: number }>;
  } {
    this.sync();
    const chats: Record<string, { seenAt: number; seenIndex?: number; markedUnreadAt?: number }> = {};
    for (const [key, value] of this.chats) {
      chats[key] = 'seenIndex' in value ? { seenAt: value.seenAt, seenIndex: value.seenIndex } : { seenAt: value.seenAt };
      if (value.markedUnreadAt) chats[key].markedUnreadAt = value.markedUnreadAt;
    }
    return { revision: `${this.nonce}.${this.counter}`, warning: this.warning, chats };
  }

  #save(): void {
    if (this.path === null) return;
    this.requireReadable();
    saveJson(this.path, { version: VERSION, savedAt: now(), chats: this.chats }, '.studio-read-');
    this.seen = this.stamp();
  }

  /**
   * Mark one chat unread (`unread` true: markedUnreadAt = now, so the PC and the phone show its unread dot until it is looked at
   * again) or read (its read position moves to now, which also clears a mark). Returns whether anything changed.
   */
  markUnread(key: string, unread: boolean, nowMs = Date.now()): Promise<boolean> {
    if (!this.#cls().key(key)) return Promise.reject(new ValueError('Invalid read position'));
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.chats);
      const old = this.chats.get(key);
      const at = Math.min(Math.trunc(nowMs), this.#cls().MAX_TIME);
      const next: Record<string, number> = { seenAt: old?.seenAt ?? 0, at: now() };
      if (old?.seenIndex !== undefined) next.seenIndex = old.seenIndex;
      if (unread) next.markedUnreadAt = Math.max(at, next.seenAt + 1);
      else next.seenAt = Math.max(next.seenAt, at);
      this.chats.set(key, next as unknown as ReadPosition);
      if (sameJson(this.chats, before)) return false;
      this.#prune();
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.chats = before;
        this.warning = `AIB could not save read positions: ${errorText(error)}`;
        throw new ValueError(this.warning);
      }
      this.warning = '';
      this.counter++;
      return true;
    });
  }

  /**
   * Apply {set: {key: {seenAt, seenIndex?}}}. A position only moves forward: an older seenAt is ignored, an equal one keeps the
   * larger index, and a newer one without an index keeps the stored index.
   */
  update(body: unknown): Promise<void> {
    if (!isDict(body) || !isDict(body.set)) return Promise.reject(new ValueError('Invalid request'));
    const changes = body.set;
    const cls = this.#cls();
    if (Object.keys(changes).length > cls.MAX_SET) return Promise.reject(new ValueError('Too many read positions at once'));
    const clean = new Map<string, ReadPosition>();
    for (const [key, item] of entriesOf(changes)) {
      const entry = cls.key(key) ? cls.clean(item) : null;
      if (entry === null) return Promise.reject(new ValueError('Invalid read position'));
      delete entry.markedUnreadAt; // only markUnread sets it
      clean.set(key, entry);
    }
    return this.locked(() => {
      this.sync();
      const before = deepCopy(this.chats);
      let time = now();
      for (const [key, next] of clean) {
        const old = this.chats.get(key);
        if (old && next.seenAt < old.seenAt) continue;
        const merged: Record<string, number> = { seenAt: next.seenAt };
        let index: number | undefined = next.seenIndex;
        if (old && next.seenAt === old.seenAt) {
          const both = [index, old.seenIndex].filter((i): i is number => i !== undefined);
          index = both.length ? Math.max(...both) : undefined;
        } else if (index === undefined && old) {
          index = old.seenIndex;
        }
        if (index !== undefined) merged.seenIndex = index;
        // a mark as unread stays until a newer read position passes it
        if (old?.markedUnreadAt && old.markedUnreadAt >= merged.seenAt) merged.markedUnreadAt = old.markedUnreadAt;
        if (old && old.seenAt === merged.seenAt && old.seenIndex === merged.seenIndex) continue;
        time += 1e-6; // a batch keeps its own order
        merged.at = time;
        this.chats.set(key, merged as unknown as ReadPosition);
      }
      if (sameJson(this.chats, before)) return;
      this.#prune();
      try {
        this.#save();
      } catch (error) {
        if (!isOSError(error)) throw error;
        this.chats = before;
        this.warning = `AIB could not save read positions: ${errorText(error)}`;
        throw new ValueError(this.warning);
      }
      this.warning = '';
      this.counter++;
    });
  }
}
