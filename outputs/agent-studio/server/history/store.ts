/**
 * The per-chat history store (history-loading design v2, phase 1A): one SQLite file per running chat, `<dir>/<chatId>.sqlite`, WAL,
 * synchronous=NORMAL, through node:sqlite's DatabaseSync (linked into the Deno runtime on every target, FTS5 on).
 *
 * This module is synchronous and has no I/O besides the database files: store_worker.ts runs every store of the agent host in one
 * Worker (a WAL checkpoint or a virus scan of *.sqlite-wal can stall a synchronous call; in the Worker that never delays another
 * chat), and client.ts is the main thread's side. Tests use it directly.
 *
 * Tables:
 *   events(seq PK, session NULL = the chat itself else the helper's session id, kind, time (seconds), row_start, bytes, data = event JSON text)
 *   meta(key PK, value)       schema, eventsId, epoch, written_seq, ckpt = {state, sequence, record, noteSeq}
 *   messages(row_start PK, role, text) + messages_fts (fts5, external content): one row per message, upserted as chunks arrive;
 *   your own prompts are rows too. Tool output and helper events are never indexed.
 *
 * The rules this store owns (design 3.2-3.5):
 * - Two watermarks, never mixed. append() moves written_seq (events above ckpt.sequence are provisional). setCheckpoint() is the only
 *   writer of ckpt, refuses a ckpt whose sequence was not flushed first, and never moves ckpt.record back. truncateBefore() is
 *   ckpt.record + 1, never further.
 * - Take-over: open() never deletes anything; dropProvisional(above) removes events above ckpt.sequence (or above a newer keeper
 *   note's state.sequence, when the replay met one: crash between note and commit) before the replay makes them again.
 * - Fencing: every write transaction is BEGIN IMMEDIATE plus "is meta.epoch still mine?". A store whose epoch was taken by another
 *   owner refuses the write (FencedError) and closes itself. claim() never goes back to a lower epoch.
 * - Damage and disk full never stop the chat: a file that fails quick_check (or is not a database) is renamed *.broken and a new one
 *   is started (open() reports damaged); SQLITE_FULL rolls the transaction back and the store stops writing (writes report
 *   stopped: 'full'), reads go on.
 * - Retention (owner decision 1a): the chat's own events are kept up to maxChatBytes (1 GB); helper events are capped separately at
 *   the newest maxHelperEvents (50,000) and helperMaxAgeSec (30 days), whichever keeps fewer.
 * - row_start is view-free: the first seq of a run of the chat's own *_chunk events (agent message and thought chunks share a run,
 *   the user's own chunks run separately; any other event of the chat ends a run; helper events never do). Every other event is
 *   its own row_start. A page never starts inside a run.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const SCHEMA = 1;
export const MAX_CHAT_BYTES = 1024 ** 3;
export const MAX_HELPER_EVENTS = 50_000;
export const HELPER_MAX_AGE_SEC = 30 * 86400;
export const PAGE_EVENTS = 400;
export const PAGE_BYTES = 1024 * 1024;

/** SQLite primary result codes (node:sqlite's error.errcode may be an extended code: the low byte is the primary one). */
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;

export interface StoreEvent {
  seq: number;
  kind: string;
  time?: number;
  data?: unknown;
  /** The helper's session id, or null for the chat itself. Left out: derived from data.sessionId against the chat's session. */
  session?: string | null;
  [key: string]: unknown;
}

export interface StoredEvent {
  seq: number;
  session: string | null;
  kind: string;
  time: number;
  rowStart: number;
  bytes: number;
  /** The event as JSON text (kept as text, spliced into responses without parsing again). */
  data: string;
}

export interface Checkpoint {
  state: unknown;
  /** The last event seq the state covers. */
  sequence: number;
  /** The last keeper record the state covers (upTo). */
  record: number;
  /** The seq of the keeper note written for it. */
  noteSeq: number;
}

export interface StoreOptions {
  maxChatBytes?: number;
  maxHelperEvents?: number;
  helperMaxAgeSec?: number;
  /** Seconds now (tests). */
  now?: () => number;
  /** Tests: PRAGMA max_page_count, to make the disk "full". */
  maxPageCount?: number;
}

export interface OpenInfo {
  chatId: string;
  /** The file failed quick_check (or was not a database): it was renamed *.broken and this store started empty. */
  damaged: boolean;
  created: boolean;
  eventsId: string | null;
  /** The store held events under another eventsId (the caller decides: reset() it, design 3.4 H4). */
  eventsIdChanged: boolean;
  epoch: number;
  writtenSeq: number;
  ckpt: Checkpoint | null;
  first: number | null;
  last: number | null;
}

export interface WriteResult {
  written: number;
  skipped: number;
  writtenSeq: number;
  /** Set when the store no longer writes (disk full); the chat carries on from RAM and the journal. */
  stopped?: 'full';
}

export interface Page {
  events: StoredEvent[];
  from: number | null;
  to: number | null;
  /** More events beyond this page in the direction it was read. */
  more: boolean;
}

export interface RangeOptions {
  /** null or undefined: the chat itself; a string: that helper's events. */
  session?: string | null;
  limit?: number;
  bytes?: number;
}

export interface SearchHit {
  rowStart: number;
  role: string;
  snippet: string;
}

export class FencedError extends Error {
  readonly code = 'fenced';
  constructor(readonly chatId: string, readonly mine: number, readonly owner: number) {
    super(`history store ${chatId}: epoch ${mine} is no longer the owner (${owner})`);
    this.name = 'FencedError';
  }
}

export class StoreClosedError extends Error {
  readonly code = 'closed';
  constructor(readonly chatId: string) {
    super(`history store ${chatId} is closed`);
    this.name = 'StoreClosedError';
  }
}

export class CheckpointError extends Error {
  readonly code = 'checkpoint';
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointError';
  }
}

const CHAT_ID = /^[A-Za-z0-9._-]{1,128}$/;
export function storePath(dir: string, chatId: string): string {
  if (!CHAT_ID.test(chatId) || chatId.startsWith('.')) throw new Error(`not a chat id: ${JSON.stringify(chatId)}`);
  return join(dir, `${chatId}.sqlite`);
}

/**
 * The primary SQLite result code of an error. Deno's node:sqlite (2.9.8) sets only code 'ERR_SQLITE_ERROR' and SQLite's own message
 * (no errcode), so the message is matched too: these strings are sqlite3ErrStr()'s, fixed in SQLite's source.
 */
function sqliteCode(error: unknown): number {
  const code = (error as { errcode?: unknown })?.errcode;
  if (typeof code === 'number') return code & 0xff;
  const message = String((error as { message?: unknown })?.message ?? '');
  if (message.includes('database or disk is full')) return SQLITE_FULL;
  if (message.includes('database disk image is malformed')) return SQLITE_CORRUPT;
  if (message.includes('file is not a database')) return SQLITE_NOTADB;
  return -1;
}

const enc = new TextEncoder();
const isDict = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** What an event is for the row and search rules: its sessionUpdate (for `update`s) and the text it adds to its message. */
interface Shape {
  chunk: 'agent' | 'user' | null;
  role: 'agent' | 'user' | null;
  text: string;
}
function shapeOf(event: StoreEvent): Shape {
  if (event.kind === 'user') {
    const text = isDict(event.data) && typeof event.data.text === 'string' ? event.data.text : '';
    return { chunk: null, role: 'user', text };
  }
  if (event.kind !== 'update' || !isDict(event.data) || !isDict(event.data.update)) return { chunk: null, role: null, text: '' };
  const update = event.data.update;
  const kind = update.sessionUpdate;
  const content = isDict(update.content) && update.content.type === 'text' && typeof update.content.text === 'string'
    ? update.content.text
    : '';
  if (kind === 'agent_message_chunk') return { chunk: 'agent', role: 'agent', text: content };
  if (kind === 'agent_thought_chunk') return { chunk: 'agent', role: null, text: '' }; // thinking: not a reply, not searched
  if (kind === 'user_message_chunk') return { chunk: 'user', role: 'user', text: content };
  return { chunk: null, role: null, text: '' };
}

/** The helper an event belongs to (null: the chat itself). */
export function sessionOf(event: StoreEvent, mainSession: string | null): string | null {
  if (event.session !== undefined) return event.session ?? null;
  if (event.kind !== 'update' || !isDict(event.data)) return null;
  const id = event.data.sessionId;
  return typeof id === 'string' && id && mainSession && id !== mainSession ? id : null;
}

/**
 * row_start over a list of events, as pure function (tests, and phase 1B's page edges): `run` is the open run before the list
 * ({rowStart, chunk} of the chat's last event when it was a chunk, else null). Returns each event's row_start and the open run after.
 */
export function rowStarts(
  events: StoreEvent[],
  mainSession: string | null,
  run: { rowStart: number; chunk: 'agent' | 'user' } | null = null,
): { starts: number[]; run: { rowStart: number; chunk: 'agent' | 'user' } | null } {
  const starts: number[] = [];
  for (const event of events) {
    if (sessionOf(event, mainSession) !== null) { // a helper's event: its own row, never ends the chat's run
      starts.push(event.seq);
      continue;
    }
    const { chunk } = shapeOf(event);
    if (chunk && run && run.chunk === chunk) starts.push(run.rowStart);
    else {
      starts.push(event.seq);
      run = chunk ? { rowStart: event.seq, chunk } : null;
    }
  }
  return { starts, run };
}

export class HistoryStore {
  readonly path: string;
  #db: DatabaseSync | null = null;
  #epoch = 0;
  #mainSession: string | null = null;
  #run: { rowStart: number; chunk: 'agent' | 'user' } | null = null;
  #mainBytes = 0;
  #helperCount = 0;
  #writtenSeq = 0;
  #maxSeq = 0;
  #stopped: 'full' | null = null;
  #trimmed = false;
  #stmts = new Map<string, StatementSync>();
  readonly #opts: Required<Omit<StoreOptions, 'maxPageCount'>> & { maxPageCount?: number };

  private constructor(readonly dir: string, readonly chatId: string, options: StoreOptions) {
    this.path = storePath(dir, chatId);
    this.#opts = {
      maxChatBytes: options.maxChatBytes ?? MAX_CHAT_BYTES,
      maxHelperEvents: options.maxHelperEvents ?? MAX_HELPER_EVENTS,
      helperMaxAgeSec: options.helperMaxAgeSec ?? HELPER_MAX_AGE_SEC,
      now: options.now ?? (() => Date.now() / 1000),
      maxPageCount: options.maxPageCount,
    };
  }

  /**
   * Open (or create) the chat's store. Runs quick_check; a damaged file is renamed *.broken and a new store starts. Nothing is
   * deleted here: the caller calls claim(), then dropProvisional() once it knows the ckpt the replay starts from.
   */
  static open(dir: string, chatId: string, options: StoreOptions & { eventsId?: string | null; mainSession?: string | null } = {}) {
    const store = new HistoryStore(dir, chatId, options);
    const info = store.#open(options.eventsId ?? null);
    store.#mainSession = options.mainSession ?? null;
    return { store, info };
  }

  #open(eventsId: string | null): OpenInfo {
    let damaged = false;
    let created = !existsSync(this.path);
    try {
      this.#connect();
      const check = this.#db!.prepare('PRAGMA quick_check').all().map((r) => String(Object.values(r)[0]));
      if (check.length !== 1 || check[0] !== 'ok') {
        throw Object.assign(new Error(`quick_check: ${check.slice(0, 3).join('; ')}`), { errcode: SQLITE_CORRUPT });
      }
      this.#schema();
    } catch (error) {
      const code = sqliteCode(error);
      if (code !== SQLITE_CORRUPT && code !== SQLITE_NOTADB) throw error;
      this.#disconnect();
      damaged = true;
      created = true;
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(this.path + suffix)) {
          rmSync(this.path + suffix + '.broken', { force: true });
          renameSync(this.path + suffix, this.path + suffix + '.broken');
        }
      }
      this.#connect();
      this.#schema();
    }
    const stored = this.#meta('eventsId');
    let eventsIdChanged = false;
    if (eventsId) {
      if (stored === null) this.#setMetaNow('eventsId', eventsId);
      else if (stored !== eventsId) eventsIdChanged = this.#count() > 0;
      if (stored !== eventsId && !eventsIdChanged) this.#setMetaNow('eventsId', eventsId);
    }
    this.#loadCounters();
    return {
      chatId: this.chatId,
      damaged,
      created,
      eventsId: this.#meta('eventsId'),
      eventsIdChanged,
      epoch: Number(this.#meta('epoch') ?? 0),
      writtenSeq: this.#writtenSeq,
      ckpt: this.checkpoint().ckpt,
      first: this.#firstMain(),
      last: this.#maxSeq || null,
    };
  }

  #connect(): void {
    const db = new DatabaseSync(this.path);
    this.#db = db;
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA auto_vacuum = INCREMENTAL'); // only takes on a new file (before the first table)
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    if (this.#opts.maxPageCount) db.exec(`PRAGMA max_page_count = ${Math.floor(this.#opts.maxPageCount)}`);
  }

  #disconnect(): void {
    this.#stmts.clear();
    try {
      this.#db?.close();
    } catch { /* already closed */ }
    this.#db = null;
  }

  #schema(): void {
    this.#db!.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS events(
        seq INTEGER PRIMARY KEY, session TEXT, kind TEXT NOT NULL, time REAL NOT NULL,
        row_start INTEGER NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_by_session ON events(session, seq);
      CREATE TABLE IF NOT EXISTS messages(row_start INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='row_start');
      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, text) VALUES (new.row_start, new.text); END;
      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.row_start, old.text); END;
      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.row_start, old.text);
        INSERT INTO messages_fts(rowid, text) VALUES (new.row_start, new.text); END;
      INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', '${SCHEMA}');
    `);
  }

  #stmt(sql: string): StatementSync {
    if (!this.#db) throw new StoreClosedError(this.chatId);
    let s = this.#stmts.get(sql);
    if (!s) this.#stmts.set(sql, s = this.#db.prepare(sql));
    return s;
  }

  #meta(key: string): string | null {
    const row = this.#stmt('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }
  #setMetaNow(key: string, value: string): void {
    this.#stmt('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  #count(): number {
    return Number((this.#stmt('SELECT count(*) AS n FROM events').get() as { n: number }).n);
  }
  #firstMain(): number | null {
    const row = this.#stmt('SELECT min(seq) AS s FROM events WHERE session IS NULL').get() as { s: number | null };
    return row.s ?? null;
  }

  #loadCounters(): void {
    this.#writtenSeq = Number(this.#meta('written_seq') ?? 0);
    this.#maxSeq = Number((this.#stmt('SELECT max(seq) AS s FROM events').get() as { s: number | null }).s ?? 0);
    this.#mainBytes = Number((this.#stmt('SELECT total(bytes) AS b FROM events WHERE session IS NULL').get() as { b: number }).b);
    this.#helperCount = Number((this.#stmt('SELECT count(*) AS n FROM events WHERE session IS NOT NULL').get() as { n: number }).n);
    this.#run = this.#lastRun();
  }

  /** The open run at the end of what is stored: the chat's last event, when it is a chunk. */
  #lastRun(): { rowStart: number; chunk: 'agent' | 'user' } | null {
    const row = this.#stmt('SELECT seq, row_start, data FROM events WHERE session IS NULL ORDER BY seq DESC LIMIT 1').get() as
      | { seq: number; row_start: number; data: string }
      | undefined;
    if (!row) return null;
    const chunk = shapeOf(JSON.parse(row.data)).chunk;
    return chunk ? { rowStart: Number(row.row_start), chunk } : null;
  }

  get closed(): boolean {
    return this.#db === null;
  }
  get epoch(): number {
    return this.#epoch;
  }
  get stopped(): 'full' | null {
    return this.#stopped;
  }
  set mainSession(id: string | null) {
    this.#mainSession = id;
  }

  /**
   * One write transaction: BEGIN IMMEDIATE, then "is the epoch still mine?". Fenced: refused, and this store closes. Disk full:
   * rolled back, the store stops writing (returns null). Any other error is rolled back and thrown.
   */
  #write<T>(body: () => T, claimEpoch?: number): T | null {
    if (!this.#db) throw new StoreClosedError(this.chatId);
    if (this.#stopped && claimEpoch === undefined) return null;
    const db = this.#db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const owner = Number(this.#meta('epoch') ?? 0);
      if (claimEpoch === undefined && owner !== this.#epoch) throw new FencedError(this.chatId, this.#epoch, owner);
      if (claimEpoch !== undefined && claimEpoch < owner) throw new FencedError(this.chatId, claimEpoch, owner);
      const result = body();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch { /* the transaction is already gone */ }
      if (error instanceof FencedError) {
        if (claimEpoch === undefined) this.close();
        throw error;
      }
      if (sqliteCode(error) === SQLITE_FULL) {
        this.#stopped = 'full';
        this.#loadCounters(); // what the rolled-back transaction counted is gone
        return null;
      }
      this.#loadCounters();
      throw error;
    }
  }

  /** Take the store for this owner (the keeper channel's epoch). A lower epoch than the stored owner's is refused. */
  claim(epoch: number): void {
    if (!Number.isInteger(epoch) || epoch < 1) throw new Error(`not an epoch: ${epoch}`);
    this.#write(() => this.#setMetaNow('epoch', String(epoch)), epoch);
    this.#epoch = epoch;
  }

  /** Is the epoch this store wrote still the owner's? (False once another owner claimed it.) */
  checkEpoch(): boolean {
    if (!this.#db) return false;
    return Number(this.#meta('epoch') ?? 0) === this.#epoch;
  }

  /**
   * The ~200 ms writer: append events (ascending seq). Events at or below the newest stored seq are skipped (a rebuild that
   * continues the store, design H4). Moves written_seq; never touches ckpt.
   */
  append(events: StoreEvent[]): WriteResult {
    const fresh = events.filter((e) => Number.isInteger(e.seq) && e.seq > this.#maxSeq).sort((a, b) => a.seq - b.seq);
    const skipped = events.length - fresh.length;
    if (!fresh.length) return { written: 0, skipped, writtenSeq: this.#writtenSeq, ...(this.#stopped ? { stopped: this.#stopped } : {}) };
    const ok = this.#write(() => {
      const { starts, run } = rowStarts(fresh, this.#mainSession, this.#run);
      const insert = this.#stmt('INSERT INTO events(seq, session, kind, time, row_start, bytes, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const texts = new Map<number, { role: string; text: string }>();
      fresh.forEach((event, i) => {
        const session = sessionOf(event, this.#mainSession);
        const { session: _drop, ...plain } = event;
        const data = JSON.stringify(plain);
        const bytes = enc.encode(data).length;
        const time = typeof event.time === 'number' ? event.time : this.#opts.now();
        insert.run(event.seq, session, String(event.kind), time, starts[i], bytes, data);
        if (session === null) {
          this.#mainBytes += bytes;
          const { role, text } = shapeOf(event);
          if (role) {
            const entry = texts.get(starts[i]) ?? { role, text: '' };
            entry.text += text;
            texts.set(starts[i], entry);
          }
        } else this.#helperCount += 1;
      });
      const upsert = this.#stmt(
        'INSERT INTO messages(row_start, role, text) VALUES (?, ?, ?) ON CONFLICT(row_start) DO UPDATE SET text = messages.text || excluded.text',
      );
      for (const [rowStart, { role, text }] of texts) upsert.run(rowStart, role, text);
      this.#run = run;
      this.#maxSeq = fresh.at(-1)!.seq;
      this.#writtenSeq = this.#maxSeq;
      this.#setMetaNow('written_seq', String(this.#writtenSeq));
      this.#retainCounts();
      return true;
    });
    if (ok === null) { // disk full: #write reloaded the counters from what is on disk
      return { written: 0, skipped, writtenSeq: this.#writtenSeq, stopped: 'full' };
    }
    return { written: fresh.length, skipped, writtenSeq: this.#writtenSeq };
  }

  /** Size caps that are cheap to check on every append: the chat's bytes and the helpers' count. */
  #retainCounts(): void {
    if (this.#mainBytes > this.#opts.maxChatBytes) {
      const excess = this.#mainBytes - this.#opts.maxChatBytes;
      // The oldest of the chat's events, until at least `excess` bytes are gone (the newest one always stays).
      const rows = this.#stmt('SELECT seq, bytes FROM events WHERE session IS NULL ORDER BY seq').iterate() as Iterable<
        { seq: number; bytes: number }
      >;
      let gone = 0;
      let cut = 0;
      for (const row of rows) {
        if (gone >= excess || row.seq === this.#maxSeq) break;
        gone += Number(row.bytes);
        cut = Number(row.seq);
      }
      if (cut) {
        this.#stmt('DELETE FROM events WHERE session IS NULL AND seq <= ?').run(cut);
        this.#stmt('DELETE FROM messages WHERE row_start <= ?').run(cut);
        this.#mainBytes -= gone;
        this.#trimmed = true;
      }
    }
    if (this.#helperCount > this.#opts.maxHelperEvents) {
      const extra = this.#helperCount - this.#opts.maxHelperEvents;
      this.#stmt(
        'DELETE FROM events WHERE seq IN (SELECT seq FROM events WHERE session IS NOT NULL ORDER BY seq LIMIT ?)',
      ).run(extra);
      this.#helperCount -= extra;
      this.#trimmed = true;
    }
  }

  /** The age cap (a scan, so at quiet points only): helper events older than helperMaxAgeSec. Then free the pages. */
  #retainAge(): void {
    const cutoff = this.#opts.now() - this.#opts.helperMaxAgeSec;
    const removed = Number(this.#stmt('DELETE FROM events WHERE session IS NOT NULL AND time < ?').run(cutoff).changes);
    if (removed) {
      this.#helperCount -= removed;
      this.#trimmed = true;
    }
  }

  /** The two watermarks: written_seq (moved by append) and ckpt (moved only by setCheckpoint). */
  checkpoint(): { writtenSeq: number; ckpt: Checkpoint | null } {
    const raw = this.#meta('ckpt');
    return { writtenSeq: this.#writtenSeq, ckpt: raw ? JSON.parse(raw) as Checkpoint : null };
  }

  /**
   * Commit a checkpoint (a quiet point, after the keeper note: design 3.2 step 3). Refused when its events were not flushed first
   * (sequence above written_seq) or it goes back (record or noteSeq below the stored ckpt's). Runs the age cap and frees pages.
   * False: the store stopped writing (disk full).
   */
  setCheckpoint(ckpt: Checkpoint): boolean {
    for (const key of ['sequence', 'record', 'noteSeq'] as const) {
      if (!Number.isInteger(ckpt[key]) || ckpt[key] < 0) throw new CheckpointError(`ckpt.${key} is not a seq: ${ckpt[key]}`);
    }
    if (ckpt.sequence > this.#writtenSeq) {
      throw new CheckpointError(`ckpt.sequence ${ckpt.sequence} is above written_seq ${this.#writtenSeq}: flush first`);
    }
    const old = this.checkpoint().ckpt;
    if (old && (ckpt.record < old.record || ckpt.noteSeq < old.noteSeq || ckpt.sequence < old.sequence)) {
      throw new CheckpointError(`ckpt goes back (record ${old.record} -> ${ckpt.record})`);
    }
    const ok = this.#write(() => {
      this.#setMetaNow('ckpt', JSON.stringify({ state: ckpt.state, sequence: ckpt.sequence, record: ckpt.record, noteSeq: ckpt.noteSeq }));
      this.#retainAge();
      return true;
    });
    if (ok && this.#trimmed) {
      this.#trimmed = false;
      try {
        this.#db!.exec('PRAGMA incremental_vacuum');
      } catch { /* a later quiet point tries again */ }
    }
    return ok === true;
  }

  /** The keeper may drop records before this (design 3.2 step 4): ckpt.record + 1, never further. 0: nothing to drop. */
  truncateBefore(): number {
    const ckpt = this.checkpoint().ckpt;
    return ckpt ? ckpt.record + 1 : 0;
  }

  /**
   * Take-over: delete the provisional events above `above` (default ckpt.sequence; a newer keeper note's state.sequence when the
   * replay met one, crash between note and commit), so the replay makes them again with the same numbers. Returns how many.
   */
  dropProvisional(above?: number): number {
    const limit = above ?? this.checkpoint().ckpt?.sequence ?? 0;
    const removed = this.#write(() => {
      const n = Number(this.#stmt('DELETE FROM events WHERE seq > ?').run(limit).changes);
      this.#stmt('DELETE FROM messages WHERE row_start > ?').run(limit);
      this.#writtenSeq = Math.min(this.#writtenSeq, limit);
      this.#setMetaNow('written_seq', String(this.#writtenSeq));
      // The message whose run crosses `limit` lost its tail: build its text again from what is left.
      const run = this.#stmt('SELECT row_start FROM events WHERE session IS NULL AND seq <= ? ORDER BY seq DESC LIMIT 1').get(limit) as
        | { row_start: number }
        | undefined;
      if (run && n) this.#rebuildMessage(Number(run.row_start));
      return n;
    });
    this.#loadCounters();
    return removed ?? 0;
  }

  #rebuildMessage(rowStart: number): void {
    const rows = this.#stmt('SELECT data FROM events WHERE session IS NULL AND row_start = ? ORDER BY seq').all(rowStart) as {
      data: string;
    }[];
    let role: string | null = null;
    let text = '';
    for (const row of rows) {
      const shape = shapeOf(JSON.parse(row.data));
      if (shape.role) {
        role ??= shape.role;
        text += shape.text;
      }
    }
    this.#stmt('DELETE FROM messages WHERE row_start = ?').run(rowStart);
    if (role) this.#stmt('INSERT INTO messages(row_start, role, text) VALUES (?, ?, ?)').run(rowStart, role, text);
  }

  /** Throw everything away and start over under a new eventsId (design H4: only when the eventsId differs). Keeps the epoch. */
  reset(eventsId: string): void {
    this.#write(() => {
      this.#db!.exec("DELETE FROM events; DELETE FROM messages; DELETE FROM meta WHERE key IN ('ckpt', 'written_seq');");
      this.#setMetaNow('eventsId', eventsId);
      return true;
    });
    this.#loadCounters();
  }

  // ---- reads -------------------------------------------------------------------------------------------------------------------
  #row(r: Record<string, unknown>): StoredEvent {
    return {
      seq: Number(r.seq),
      session: (r.session as string | null) ?? null,
      kind: String(r.kind),
      time: Number(r.time),
      rowStart: Number(r.row_start),
      bytes: Number(r.bytes),
      data: String(r.data),
    };
  }

  #where(session: string | null | undefined): string {
    return session ? 'session = ?' : 'session IS NULL';
  }
  #args(session: string | null | undefined): unknown[] {
    return session ? [session] : [];
  }

  /** Newest first, until `limit` events or `bytes` (the first event always fits). */
  #collectDown(below: number, options: RangeOptions): { rows: StoredEvent[]; more: boolean } {
    const limit = options.limit ?? PAGE_EVENTS;
    const budget = options.bytes ?? PAGE_BYTES;
    const it = this.#stmt(`SELECT * FROM events WHERE ${this.#where(options.session)} AND seq < ? ORDER BY seq DESC`)
      .iterate(...this.#args(options.session) as never[], below as never) as Iterable<Record<string, unknown>>;
    const rows: StoredEvent[] = [];
    let used = 0;
    let more = false;
    for (const r of it) {
      const row = this.#row(r);
      if (rows.length && (rows.length >= limit || used + row.bytes > budget)) {
        more = true;
        break;
      }
      rows.push(row);
      used += row.bytes;
    }
    rows.reverse();
    if (!options.session && rows.length) {
      // A page never starts inside a run: drop the partial run at its old end, or, when the page is all one run, take it whole.
      const first = rows[0];
      if (first.rowStart < first.seq) {
        if (rows.every((r) => r.rowStart === first.rowStart)) {
          const rest = (this.#stmt('SELECT * FROM events WHERE session IS NULL AND row_start = ? AND seq < ? ORDER BY seq')
            .all(first.rowStart, first.seq) as Record<string, unknown>[]).map((r) => this.#row(r));
          rows.unshift(...rest);
          more = this.#exists(options.session, rows[0].seq, 'below');
        } else {
          while (rows.length && rows[0].rowStart === first.rowStart) rows.shift();
          more = true;
        }
      }
    }
    return { rows, more };
  }

  #exists(session: string | null | undefined, seq: number, side: 'below' | 'above'): boolean {
    const op = side === 'below' ? '<' : '>';
    return !!this.#stmt(`SELECT 1 AS x FROM events WHERE ${this.#where(session)} AND seq ${op} ? LIMIT 1`)
      .get(...this.#args(session) as never[], seq as never);
  }

  #page(rows: StoredEvent[], more: boolean): Page {
    return { events: rows, from: rows[0]?.seq ?? null, to: rows.at(-1)?.seq ?? null, more };
  }

  /** The newest page (the chat's own events, or one helper's). */
  tail(options: RangeOptions = {}): Page {
    const { rows, more } = this.#collectDown(Number.MAX_SAFE_INTEGER, options);
    return this.#page(rows, more);
  }

  /** The page just older than `seq`. */
  before(seq: number, options: RangeOptions = {}): Page {
    const { rows, more } = this.#collectDown(seq, options);
    return this.#page(rows, more);
  }

  /** The page just newer than `seq`, oldest first. */
  after(seq: number, options: RangeOptions = {}): Page {
    const limit = options.limit ?? PAGE_EVENTS;
    const budget = options.bytes ?? PAGE_BYTES;
    const it = this.#stmt(`SELECT * FROM events WHERE ${this.#where(options.session)} AND seq > ? ORDER BY seq`)
      .iterate(...this.#args(options.session) as never[], seq as never) as Iterable<Record<string, unknown>>;
    const rows: StoredEvent[] = [];
    let used = 0;
    let more = false;
    for (const r of it) {
      const row = this.#row(r);
      if (rows.length && (rows.length >= limit || used + row.bytes > budget)) {
        more = true;
        break;
      }
      rows.push(row);
      used += row.bytes;
    }
    return this.#page(rows, more);
  }

  /** One helper's events: its newest page, or older than `before`. */
  helper(session: string, options: Omit<RangeOptions, 'session'> & { before?: number } = {}): Page {
    return options.before ? this.before(options.before, { ...options, session }) : this.tail({ ...options, session });
  }

  /** One event in full. */
  event(seq: number): StoredEvent | null {
    const r = this.#stmt('SELECT * FROM events WHERE seq = ?').get(seq) as Record<string, unknown> | undefined;
    return r ? this.#row(r) : null;
  }

  /** The helpers that have events here, with their count and newest seq. */
  helpers(): { session: string; count: number; last: number }[] {
    return (this.#stmt(
      'SELECT session, count(*) AS n, max(seq) AS last FROM events WHERE session IS NOT NULL GROUP BY session ORDER BY last DESC',
    )
      .all() as { session: string; n: number; last: number }[]).map((r) => ({
        session: r.session,
        count: Number(r.n),
        last: Number(r.last),
      }));
  }

  /** Find in your messages and the agent's replies (never tool output, never helpers). Newest first. */
  search(query: string, limit = 50): SearchHit[] {
    const terms = query.split(/\s+/).filter(Boolean).map((t) => `"${t.replaceAll('"', '""')}"`);
    if (!terms.length) return [];
    const rows = this.#stmt(
      `SELECT m.row_start AS row_start, m.role AS role, snippet(messages_fts, 0, '[', ']', '…', 12) AS snippet
       FROM messages_fts JOIN messages m ON m.row_start = messages_fts.rowid
       WHERE messages_fts MATCH ? ORDER BY m.row_start DESC LIMIT ?`,
    ).all(terms.join(' '), limit) as { row_start: number; role: string; snippet: string }[];
    return rows.map((r) => ({ rowStart: Number(r.row_start), role: r.role, snippet: r.snippet }));
  }

  /** Sizes and marks (tests, logs). */
  info(): {
    first: number | null;
    last: number | null;
    writtenSeq: number;
    mainBytes: number;
    helperEvents: number;
    epoch: number;
    stopped: 'full' | null;
  } {
    return {
      first: this.#firstMain(),
      last: this.#maxSeq || null,
      writtenSeq: this.#writtenSeq,
      mainBytes: this.#mainBytes,
      helperEvents: this.#helperCount,
      epoch: this.#epoch,
      stopped: this.#stopped,
    };
  }

  close(): void {
    this.#disconnect();
  }

  /** Close and delete the file (the chat's agent ended, or the chat was deleted). */
  destroy(): void {
    this.close();
    deleteStoreFiles(this.path);
  }
}

export function deleteStoreFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
}

/** Every store of one agent host (what the Worker holds), by chat id. */
export class Stores {
  #open = new Map<string, HistoryStore>();
  constructor(readonly dir: string, readonly options: StoreOptions = {}) {}

  open(chatId: string, options: { eventsId?: string | null; mainSession?: string | null } = {}): OpenInfo {
    this.#open.get(chatId)?.close();
    const { store, info } = HistoryStore.open(this.dir, chatId, { ...this.options, ...options });
    this.#open.set(chatId, store);
    return info;
  }

  get(chatId: string): HistoryStore {
    const store = this.#open.get(chatId);
    if (!store || store.closed) {
      this.#open.delete(chatId);
      throw new StoreClosedError(chatId);
    }
    return store;
  }

  close(chatId: string): void {
    this.#open.get(chatId)?.close();
    this.#open.delete(chatId);
  }

  delete(chatId: string): void {
    const store = this.#open.get(chatId);
    this.#open.delete(chatId);
    if (store) store.destroy();
    else deleteStoreFiles(storePath(this.dir, chatId));
  }

  closeAll(): void {
    for (const store of this.#open.values()) store.close();
    this.#open.clear();
  }
}
