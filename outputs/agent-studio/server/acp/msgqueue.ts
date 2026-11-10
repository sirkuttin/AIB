/**
 * Queued messages (msgqueue.py): what the user types while the agent is working waits here and goes out when the turn ends.
 *
 * The queue lives on the Connection, so it is owned by the agent host (it survives web-server restarts and a closed tab).
 * This module holds the pure bookkeeping (items, edit leases, pause reasons) and the small on-disk store; the Connection
 * decides when to send.
 *
 * Rules the owner asked for:
 *   * One message per turn, first in first out.
 *   * The queue pauses when a turn ends needing the user (a question, approval or sign-in), when the user interrupts, and
 *     when a turn fails. It stays paused until the user resumes it.
 *   * EDITING PAUSES THE QUEUE. An item opened for editing holds an "edit lease". An item with a lease is never sent. If it is
 *     first in the queue the whole queue waits, however long the edit takes. Saving or cancelling the edit releases the lease.
 *     A lease that is not renewed expires (default 10 minutes) but is NOT released: the queue stays paused on that item
 *     ("a queued message was being edited") until the user resumes or removes it. Nothing abandoned is ever auto-sent.
 */
import { writeJsonAtomic } from '../core/fs.ts';
import { clip, isDict, isStr } from '../core/py.ts';

export const VERSION = 1;
export const LEASE_SECONDS = 600;
export const MAX_ITEMS = 50;
export const MAX_SESSIONS = 50;

export const HOLD_MESSAGES: Record<string, string> = {
  needs_you: 'Paused - the agent needs you',
  interrupted: 'Paused - you interrupted the agent',
  error: 'Paused - the last turn failed',
  restart: 'Paused - restored after a restart',
  unknown: 'Paused - a queued message may already have been sent',
  manual: 'Paused',
};

/** Python's ValueError: the queue's refusals, whose messages reach the HTTP API unchanged. */
export class ValueError extends Error {
  override name = 'ValueError';
}

export interface Lease {
  id: string;
  expires: number;
}

/** A queued message. Key order is Python's, so saved files and API answers are byte-identical. */
export interface QueueItem {
  id: string;
  text: string;
  attachments: unknown[];
  fingerprint: unknown;
  queuedAt: number;
  lease: Lease | null;
  note: string;
}

/** The saved form of an item (as read back from a store file it may be any JSON). */
export type SavedItem = Record<string, unknown>;

export type Clock = () => number;

/** time.time(): seconds as a float. */
export const wallClock: Clock = () => Date.now() / 1000;

export class MessageQueue {
  /** Tests inject a fake clock to expire an edit lease without waiting. */
  clock: Clock;
  /** Waiting items, first = next up. */
  items: QueueItem[] = [];
  /** The item being handed to the agent right now (kept so it can be persisted and put back). */
  inflight: QueueItem | null = null;
  /** A HOLD_MESSAGES key, or '' when nothing but an edit lease can pause the queue. */
  hold = '';
  leaseSeconds: number;
  /** The user asked to interrupt the running turn and send the first item. */
  sendNow = false;

  constructor(leaseSeconds?: number | null, clock?: Clock | null) {
    this.clock = clock || wallClock;
    this.leaseSeconds = leaseSeconds || LEASE_SECONDS;
  }

  // ---- items ---------------------------------------------------------------------------------
  find(itemId: string): QueueItem | null {
    return this.items.find((item) => item.id === itemId) ?? null;
  }

  has(itemId: string): boolean {
    return this.find(itemId) !== null || (this.inflight !== null && this.inflight.id === itemId);
  }

  add(itemId: string, text: string, attachments: unknown[] | null | undefined, fingerprint: unknown): QueueItem {
    if (this.items.length >= MAX_ITEMS) throw new ValueError(`At most ${MAX_ITEMS} messages can wait in the queue`);
    // queuedAt is wall time even with an injected clock, as in Python (the clock only drives leases).
    const item: QueueItem = {
      id: itemId,
      text,
      attachments: pyOr(attachments, []) as unknown[],
      fingerprint,
      queuedAt: wallClock(),
      lease: null,
      note: '',
    };
    this.items.push(item);
    return item;
  }

  remove(itemId: string): QueueItem {
    const item = this.find(itemId);
    if (item === null) throw new ValueError('That message is no longer queued');
    this.items.splice(this.items.indexOf(item), 1);
    if (!this.items.length && (this.hold === 'unknown' || this.hold === 'error')) this.hold = '';
    return item;
  }

  move(itemId: string, toIndex: unknown): QueueItem {
    const item = this.find(itemId);
    if (item === null) throw new ValueError('That message is no longer queued');
    this.items.splice(this.items.indexOf(item), 1);
    // As in Python, the item is taken out before the index is converted, so a non-numeric index drops it (a known quirk).
    this.items.splice(Math.max(0, Math.min(pyInt(toIndex), this.items.length)), 0, item);
    return item;
  }

  // ---- edit leases ---------------------------------------------------------------------------
  leaseActive(item: QueueItem, now?: number | null): boolean {
    const lease = item.lease;
    return !!lease && lease.expires > (now || this.clock());
  }

  acquire(itemId: string, leaseId?: string | null): QueueItem {
    const item = this.find(itemId);
    if (item === null) throw new ValueError('That message is no longer queued (it may already have been sent)');
    const lease = item.lease;
    const id = leaseId || crypto.randomUUID().replaceAll('-', '');
    if (lease && lease.id !== id && this.leaseActive(item)) throw new ValueError('That message is already open for editing');
    item.lease = { id, expires: this.clock() + this.leaseSeconds };
    return item;
  }

  #leased(itemId: string, leaseId: string | null | undefined): QueueItem & { lease: Lease } {
    const item = this.find(itemId);
    if (item === null) throw new ValueError('That message is no longer queued (it may already have been sent)');
    if (!item.lease || item.lease.id !== leaseId) throw new ValueError('This edit is no longer open');
    return item as QueueItem & { lease: Lease };
  }

  renew(itemId: string, leaseId: string | null | undefined): QueueItem {
    const item = this.#leased(itemId, leaseId);
    item.lease.expires = this.clock() + this.leaseSeconds;
    return item;
  }

  release(itemId: string, leaseId: string | null | undefined): QueueItem {
    const item: QueueItem = this.#leased(itemId, leaseId);
    item.lease = null;
    return item;
  }

  // ---- what may be sent ----------------------------------------------------------------------
  head(): QueueItem | null {
    return this.items.length ? this.items[0] : null;
  }

  /** '' when the next item may go out, else why not: editing | abandoned | one of HOLD_MESSAGES. */
  pauseReason(): string {
    const head = this.head();
    if (head === null) return '';
    if (head.lease) return this.leaseActive(head) ? 'editing' : 'abandoned';
    return this.hold;
  }

  /** The user resumed: clear the hold and any edit lease on the first item (an abandoned edit is dropped, the saved text stays). */
  resume(): void {
    this.hold = '';
    const head = this.head();
    if (head) {
      head.lease = null;
      head.note = '';
    }
  }

  // ---- wire form -----------------------------------------------------------------------------
  /** What the page shows of the attachments: kind and a name, never the data. */
  static attachmentSummary(attachments: unknown): { kind: unknown; name: string }[] {
    const out: { kind: unknown; name: string }[] = [];
    for (const entry of Array.isArray(attachments) ? attachments : []) {
      if (isDict(entry)) {
        out.push({
          kind: 'type' in entry ? entry.type : 'image',
          name: clip(pyStr(pyOr(pyOr(entry.name, entry.mimeType), 'attachment')), 120),
        });
      }
    }
    return out;
  }

  /** The queue as the page sees it; `light` clips each text to 300 characters. */
  public(light = false): Record<string, unknown> {
    const now = this.clock();
    const withInflight = [...(this.inflight ? [this.inflight] : []), ...this.items];
    const items = withInflight.map((item) => ({
      id: item.id,
      text: light ? clip(item.text, 300) : item.text,
      attachments: MessageQueue.attachmentSummary(item.attachments),
      queuedAt: item.queuedAt,
      sending: item === this.inflight,
      editing: !!item.lease,
      leaseActive: this.leaseActive(item, now),
      leaseExpiresAt: item.lease ? item.lease.expires : null,
      note: item.note,
    }));
    const reason = this.pauseReason();
    const messages: Record<string, string> = {
      ...HOLD_MESSAGES,
      editing: 'Paused while you edit',
      abandoned: 'Paused - a queued message was being edited',
    };
    return { items, paused: !!reason, reason, message: reason ? (messages[reason] ?? '') : '', leaseSeconds: this.leaseSeconds };
  }

  // ---- persistence ---------------------------------------------------------------------------
  /** Every item (the one in flight first) without its edit lease: what the store keeps. */
  toSaved(): SavedItem[] {
    return [...(this.inflight ? [this.inflight] : []), ...this.items].map((item) => ({ ...item, lease: null }));
  }

  /** Replace the items with saved ones (invalid entries dropped); the queue starts paused with `hold` if anything was restored. */
  load(saved: unknown, hold = 'restart'): void {
    this.items = [];
    for (const raw of Array.isArray(saved) ? saved : []) {
      if (isDict(raw) && isStr(raw.id) && isStr(raw.text)) {
        this.items.push({
          id: clip(raw.id, 128),
          text: raw.text,
          attachments: Array.isArray(raw.attachments) ? raw.attachments : [],
          fingerprint: pyStr(pyOr(raw.fingerprint, '')),
          queuedAt: pyFloat(pyOr(raw.queuedAt, 0)),
          lease: null,
          note: pyStr(pyOr(raw.note, '')),
        });
      }
    }
    this.items = this.items.slice(0, MAX_ITEMS);
    this.hold = this.items.length ? hold : '';
  }
}

/**
 * studio-<name>.json in the state dir (Python names it studio-queues-<port>.json). Unlike the recovery file this holds message
 * text (and attachment data), because the whole point is to send it later; it is only readable by your user and an entry is
 * deleted as soon as the message is sent. Python and Deno hosts read each other's files.
 */
export class QueueStore {
  readonly directory: string;
  readonly path: string;
  /** 'provider:sessionId' -> saved items, oldest first (a Map keeps insertion order for any key). */
  sessions = new Map<string, unknown[]>();
  warning = '';

  constructor(directory: string, name: string) {
    this.directory = directory;
    this.path = `${directory.replace(/[\\/]+$/, '')}/studio-${name}.json`;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Deno.readFileSync(this.path));
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) this.warning = 'Saved queued messages were unreadable and were ignored.';
      return;
    }
    try {
      const raw = JSON.parse(text);
      if (isDict(raw) && raw.version === VERSION && isDict(raw.sessions)) {
        for (const [key, items] of Object.entries(raw.sessions).slice(0, MAX_SESSIONS)) {
          if (Array.isArray(items) && items.length) this.sessions.set(key, items);
        }
      }
    } catch {
      this.warning = 'Saved queued messages were unreadable and were ignored.';
    }
  }

  static key(provider: string, sessionId: string): string {
    return `${provider}:${sessionId}`;
  }

  /** A copy of the saved items of one chat ([] when none). */
  get(provider: string, sessionId: string): SavedItem[] {
    // Python copies each item with dict(item); a non-object item (only possible in a hand-edited file) is passed through here
    // instead of raising, and MessageQueue.load drops it.
    return (this.sessions.get(QueueStore.key(provider, sessionId)) ?? []).map((item) => (isDict(item) ? { ...item } : item) as SavedItem);
  }

  /** Save one chat's items (empty forgets it); the chat moves to the newest end and the oldest chats fall off past MAX_SESSIONS. */
  put(provider: string, sessionId: string, saved: unknown[] | null | undefined): void {
    const key = QueueStore.key(provider, sessionId);
    if (saved && saved.length) {
      this.sessions.delete(key);
      this.sessions.set(key, saved);
      while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    } else if (!this.sessions.delete(key)) {
      return;
    }
    this.#save();
  }

  forget(provider: string, sessionId: string): void {
    this.put(provider, sessionId, []);
  }

  #save(): void {
    try {
      writeJsonAtomic(this.path, { version: VERSION, savedAt: wallClock(), sessions: Object.fromEntries(this.sessions) }, {
        prefix: '.studio-queues-',
        suffix: '.tmp',
      });
      this.warning = '';
    } catch (error) {
      this.warning = `Studio could not save queued messages: ${error instanceof Error ? error.message : error}`;
    }
  }
}

// ---- Python conversions the queue relies on ---------------------------------------------------

/** Python truthiness of a JSON value: None, False, 0, '', [] and {} are false. */
function pyTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return !!value;
}

/** Python's `a or b`. */
function pyOr(a: unknown, b: unknown): unknown {
  return pyTruthy(a) ? a : b;
}

function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'string') return 'str';
  return Array.isArray(value) ? 'list' : 'dict';
}

/** repr() of a str: single quotes unless the text has a single quote and no double quote. */
function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === quote) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 0x20 || (code >= 0x7f && code < 0xa0)) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  return quote + out + quote;
}

/** repr() of a float from JSON: Python switches to exponent form at 1e16 and below 1e-4, with a two-digit exponent. */
function pyNumberRepr(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return String(value);
  if (!Number.isFinite(value)) return Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf';
  const abs = Math.abs(value);
  if (abs >= 1e16 || abs < 1e-4) {
    const [mantissa, exponent] = value.toExponential().split('e');
    const sign = exponent.startsWith('-') ? '-' : '+';
    return `${mantissa}e${sign}${exponent.replace(/^[+-]/, '').padStart(2, '0')}`;
  }
  return String(value);
}

function pyRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return pyNumberRepr(value);
  if (typeof value === 'string') return pyStrRepr(value);
  if (Array.isArray(value)) return '[' + value.map(pyRepr).join(', ') + ']';
  return '{' + Object.entries(value as object).map(([k, v]) => `${pyStrRepr(k)}: ${pyRepr(v)}`).join(', ') + '}';
}

/** str() of a JSON value. */
function pyStr(value: unknown): string {
  return typeof value === 'string' ? value : pyRepr(value);
}

/** Python's str.strip() whitespace (also what int() and float() skip around a number). */
const PY_SPACE = '[\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*';

/** int() of a JSON value: truncates floats, parses decimal strings, raises Python's ValueError/TypeError otherwise. */
function pyInt(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') {
    if (Number.isNaN(value)) throw new ValueError('cannot convert float NaN to integer');
    if (!Number.isFinite(value)) throw new RangeError('cannot convert float infinity to integer');
    return Math.trunc(value) || 0;
  }
  if (typeof value === 'string') {
    const match = new RegExp(`^${PY_SPACE}([+-]?[0-9]+(?:_[0-9]+)*)${PY_SPACE}$`).exec(value);
    if (!match) throw new ValueError(`invalid literal for int() with base 10: ${pyStrRepr(value)}`);
    return Number(match[1].replaceAll('_', ''));
  }
  throw new TypeError(`int() argument must be a string, a bytes-like object or a real number, not '${pyTypeName(value)}'`);
}

/** float() of a JSON value: raises Python's ValueError/TypeError for what Python refuses. */
function pyFloat(value: unknown): number {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const match = new RegExp(
      `^${PY_SPACE}([+-]?(?:(?:[0-9](?:_?[0-9])*)?\\.?[0-9](?:_?[0-9])*(?:[eE][+-]?[0-9](?:_?[0-9])*)?|[0-9](?:_?[0-9])*\\.(?:[eE][+-]?[0-9](?:_?[0-9])*)?|inf|infinity|nan))${PY_SPACE}$`,
      'i',
    ).exec(value);
    if (!match) throw new ValueError(`could not convert string to float: ${pyStrRepr(value)}`);
    const text = match[1].replaceAll('_', '').toLowerCase();
    if (text.endsWith('nan')) return NaN;
    if (text.endsWith('inf') || text.endsWith('infinity')) return text.startsWith('-') ? -Infinity : Infinity;
    return Number(text);
  }
  throw new TypeError(`float() argument must be a string or a real number, not '${pyTypeName(value)}'`);
}
