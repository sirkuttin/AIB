/**
 * One-off repair for the owner's machine (owner rule: one-time migrations are scripts he runs, never app code), after the
 * 2026-11-17 lead-chat losses. The lead chat (Claude session a16e40ca-...) came back under a new AIB chat id several times, each with
 * its own history store, and only the transcript replay of the earlier part:
 *   c533d888... (before the 2026-11-16 restart) -> 7e47dbe3... (before the update to beta.12.test.12) -> dd6c555f... ->
 *   c5a93885... (GONE: an idle Quit AIB at 10:24 deleted its store; its agent turns are still in Claude's transcript) ->
 *   24c0ee2a... (the chat in use now: the target)
 * From 0.12.1 on (the fix that ships with this version of the script) quitting AIB, an agent exit or closing a chat never deletes a
 * store, and a reopened conversation goes on in its newest store under the same chat id, so this is the last time it is needed.
 *
 * What it does (dry run by default; --apply to write):
 *   1. Merges the earlier stores into the target store, oldest first, without repeats. Each later store starts with the transcript
 *      its session/load replayed (events flagged "replay"); those are left out where an earlier store has the real thing (cards,
 *      tool rows, turn ends, notes). The first store keeps its replay (the oldest part exists nowhere else). Of the TARGET's replay,
 *      the turns after the last one the earlier stores have are kept (that is what the gone store c5a93885... had: the agent's side
 *      of those turns, without their AIB lines, which are lost with that store).
 *      Every event is renumbered 1..N in that order. The target's own events (from its "connected" on) all move up by the same
 *      amount, and so do its checkpoint (ckpt.sequence, state.sequence, state.eventsFrom) and written_seq.
 *   2. Writes the conversation's kept lines (<data>/conversation-lines/claude_<session>.jsonl): every turn end and AIB note of the
 *      merged history (history/lines.ts).
 *   The earlier stores stay as they are (only read). At the next start AIB reopens the conversation as the target chat (the newest
 *   store of the conversation) with the whole merged history.
 *
 * Steps for the owner (in this order):
 *   1. Update AIB to the build with the fix (0.12.1, or the test build that carries "a chat's history store is never deleted")
 *      FROM INSIDE AIB (the update prompt, or Settings > Updates > Install now). Do NOT quit 0.12.1-beta.test.1 first: that build
 *      still deletes an idle chat's store when it quits, and the target is the lead chat's store.
 *   2. Quit AIB: tray icon > Quit AIB. (The idle lead chat closes and keeps its store.)
 *   3. Dry run, from the repo folder (C:\Users\sirku\Documents\Codex\AIB), and read the plan it prints:
 *        deno run -A --config app/deno.json work/migrate/repair_lead_chat_history.ts
 *   4. The same with --apply:
 *        deno run -A --config app/deno.json work/migrate/repair_lead_chat_history.ts --apply
 *   5. Start AIB. The lead chat reopens as chat 24c0ee2a... with the whole history.
 *
 * Safety:
 *   - Runs only while AIB is quit (it takes AIB's data-folder lock, so AIB cannot start meanwhile).
 *   - Refuses, changing nothing, when the target store (or a source store) is missing, or when the chat still runs in the keeper
 *     (quit while it was working) and its keeper record has a snapshot newer than the store's checkpoint (a crash between note and
 *     commit): send the chat any message, let it finish, quit AIB, run again.
 *   - Before writing, every file it changes is copied to <data>/repair-backups/lead-chat-<time>/ (the target store with its -wal and
 *     -shm, and the kept-lines file if there is one). The source stores are only read. Nothing is deleted.
 *   - The merged store is built in a new file next to the target and checked by opening it the way AIB does; only then the target
 *     is replaced. A failure leaves the target as it was.
 *   - Safe to run again: a target that already starts with the first source's events is reported as done.
 *
 * Options: --data <AIB data folder> (default %LOCALAPPDATA%\AgentStudio), --chain <id,id,...,target> (default
 * c533d888fad641608dbfdb228368a8eb,7e47dbe343944eddb36570b5037b6f7a,dd6c555f19f54621bb3b9436d32e9dc8,24c0ee2a942e4e9faa0fc8c1d2f7fd78),
 * --session <id> (default a16e40ca-fbee-46c2-9e61-388e4b23cb4e), --provider <name> (default claude), --no-lock (tests only).
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryLockNow } from '../../app/server/platform/lock.ts';
import { LOCK_FILE } from '../../app/server/desktop/single_instance.ts';
import { HistoryStore } from '../../app/server/history/store.ts';
import { anchorOf, ConversationLines, KEPT_KINDS, type KeptLine } from '../../app/server/history/lines.ts';

type Json = Record<string, unknown>;

const DEFAULT_CHAIN = [
  'c533d888fad641608dbfdb228368a8eb',
  '7e47dbe343944eddb36570b5037b6f7a',
  'dd6c555f19f54621bb3b9436d32e9dc8',
  '24c0ee2a942e4e9faa0fc8c1d2f7fd78', // the target: the chat in use (c5a93885... between dd6c555f and it is gone)
];
const DEFAULT_SESSION = 'a16e40ca-fbee-46c2-9e61-388e4b23cb4e';

interface Options {
  apply: boolean;
  data: string;
  chain: string[];
  session: string;
  provider: string;
  lock: boolean;
}

function options(args: string[]): Options {
  const value = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const local = Deno.env.get('LOCALAPPDATA') ?? '';
  const data = value('--data') ?? join(local, 'AgentStudio');
  const chain = (value('--chain') ?? DEFAULT_CHAIN.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
  if (chain.length < 2) throw new Error('--chain needs at least one source and the target');
  return {
    apply: args.includes('--apply'),
    data,
    chain,
    session: value('--session') ?? DEFAULT_SESSION,
    provider: value('--provider') ?? 'claude',
    lock: !args.includes('--no-lock'),
  };
}

// ---- reading ---------------------------------------------------------------------------------------------------------------------
interface Row {
  seq: number;
  /** While planning: the row_start it had in its own store. */
  oldRowStart?: number;
  session: string | null;
  kind: string;
  time: number;
  rowStart: number;
  data: string;
}

interface Source {
  id: string;
  path: string;
  rows: Row[];
  messages: { rowStart: number; role: string; text: string }[];
  meta: Map<string, string>;
}

function readStore(dir: string, id: string): Source {
  const path = join(dir, `${id}.sqlite`);
  if (!existsSync(path)) throw new Error(`no history store ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = (db.prepare('SELECT seq, session, kind, time, row_start, data FROM events ORDER BY seq').all() as Json[]).map((r) => ({
      seq: Number(r.seq),
      session: (r.session as string | null) ?? null,
      kind: String(r.kind),
      time: Number(r.time),
      rowStart: Number(r.row_start),
      data: String(r.data),
    }));
    const messages = (db.prepare('SELECT row_start, role, text FROM messages ORDER BY row_start').all() as Json[]).map((r) => ({
      rowStart: Number(r.row_start),
      role: String(r.role),
      text: String(r.text),
    }));
    const meta = new Map((db.prepare('SELECT key, value FROM meta').all() as Json[]).map((r) => [String(r.key), String(r.value)]));
    return { id, path, rows, messages, meta };
  } finally {
    db.close();
  }
}

/** An event the agent re-sent on session/load (connection.ts marks those `replay: true`). */
function isReplay(row: Row): boolean {
  return row.kind === 'update' && row.data.includes('"replay":true') && (JSON.parse(row.data) as Json).replay === true;
}

/** A turn end or AIB note put back from the conversation's kept lines during a replay (connection.ts #restoreLine: restored: true). */
function isRestored(row: Row): boolean {
  if (!KEPT_KINDS.has(row.kind) || !row.data.includes('"restored":true')) return false;
  const d = (JSON.parse(row.data) as Json).data as Json | null;
  return !!d && d.restored === true;
}

/** Part of what a chat showed while its session/load replayed the transcript: the replay itself, and the kept lines put back in it. */
function inReplayBlock(row: Row): boolean {
  return isReplay(row) || isRestored(row);
}

/** The session the store's chat ran (its `connected` events), or ''. */
function sessionOfStore(src: Source): string {
  for (const r of src.rows) {
    if (r.kind !== 'connected') continue;
    const d = (JSON.parse(r.data) as Json).data as Json | undefined;
    if (d && typeof d.sessionId === 'string') return d.sessionId;
  }
  return '';
}

// ---- the keeper record of the target ---------------------------------------------------------------------------------------------
/** The newest snapshot note's upTo in the chat's keeper journal (read only), or null when there is none or no journal. */
function newestSnapshotUpTo(data: string, chatId: string): { upTo: number | null; journal: boolean } {
  const dir = join(data, 'keeper', 'channels', `chat-${chatId}`);
  if (!existsSync(dir)) return { upTo: null, journal: false };
  let upTo: number | null = null;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.journal')).sort()) {
    const buf = readFileSync(join(dir, name));
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let off = 0;
    while (off + 21 <= buf.length) {
      const len = view.getUint32(off, true);
      const kind = buf[off + 4];
      if (off + 21 + len + 4 > buf.length) break; // a torn tail
      if (kind === 4) { // a note
        try {
          const note = JSON.parse(new TextDecoder().decode(buf.subarray(off + 21, off + 21 + len))) as Json;
          if (note.t === 'snapshot' && typeof note.upTo === 'number') upTo = Math.max(upTo ?? 0, note.upTo);
        } catch { /* not JSON */ }
      }
      off += 21 + len + 4;
    }
  }
  return { upTo, journal: true };
}

// ---- the plan --------------------------------------------------------------------------------------------------------------------
interface Plan {
  rows: Row[]; // the merged events with their new seq (and rowStart), in order
  messages: { rowStart: number; role: string; text: string }[];
  shift: number; // how far the target's own events move up
  targetFrom: number; // the target's first own (non-replay) event, old number
  ckptOld: Json | null;
  ckptNew: Json | null;
  /** Of the target's replay: the turns after the last one the earlier stores have (a gone store's turns), and whether it found it. */
  gap: { turns: number; events: number; anchorFound: boolean };
  writtenOld: number;
  writtenNew: number;
  perSource: { id: string; kept: number; replayDropped: number; turnEnds: number; notes: number; from: number; to: number }[];
  lines: KeptLine[];
}

function plan(sources: Source[], target: Source, provider: string, session: string): Plan {
  const out: Row[] = [];
  const messages: Plan['messages'] = [];
  const perSource: Plan['perSource'] = [];
  const ckptRaw = target.meta.get('ckpt');
  const ckptOld = ckptRaw ? JSON.parse(ckptRaw) as Json : null; // (a chat that is not in the keeper does not need one)
  const writtenOld = Number(target.meta.get('written_seq') ?? 0);
  // The target's own part: everything from its first non-replay event after its replay block (its `connected` and later).
  const lastReplay = target.rows.reduce((m, r) => (inReplayBlock(r) ? Math.max(m, r.seq) : m), 0);
  const targetFrom = lastReplay + 1;

  const take = (src: Source, rows: Row[], map: Map<number, number>, next: () => number) => {
    let kept = 0, dropped = 0, turnEnds = 0, notes = 0, from = 0, to = 0;
    for (const r of rows) {
      const seq = next();
      map.set(r.seq, seq);
      const event = JSON.parse(r.data) as Json;
      event.seq = seq;
      out.push({ ...r, seq, rowStart: 0, oldRowStart: r.rowStart, data: JSON.stringify(event) });
      kept++;
      if (!from) from = seq;
      to = seq;
      if (r.kind === 'turn_end') turnEnds++;
      if (r.kind === 'studio_note') notes++;
    }
    dropped = src.rows.length - rows.length;
    return { kept, dropped, turnEnds, notes, from, to };
  };
  const remapRows = (src: Source, map: Map<number, number>, startIndex: number) => {
    for (let i = startIndex; i < out.length; i++) {
      out[i].rowStart = map.get(out[i].oldRowStart!) ?? out[i].seq; // a run whose start was left out starts here
      delete out[i].oldRowStart;
    }
    for (const m of src.messages) {
      const at = map.get(m.rowStart);
      if (at !== undefined) messages.push({ rowStart: at, role: m.role, text: m.text });
    }
  };

  let seq = 0;
  sources.forEach((src, i) => {
    const rows = i === 0 ? src.rows : src.rows.filter((r) => !inReplayBlock(r));
    const map = new Map<number, number>();
    const start = out.length;
    const s = take(src, rows, map, () => ++seq);
    remapRows(src, map, start);
    perSource.push({ id: src.id, kept: s.kept, replayDropped: s.dropped, turnEnds: s.turnEnds, notes: s.notes, from: s.from, to: s.to });
  });
  // The target: of its replay, the turns after the last one the merged sources have (what a gone store between them had); then its
  // own events, all moved by one shift.
  // (the sign-in notice an agent sends before its replay is not shown in a chat; the earlier stores have the same ones)
  const before = target.rows.filter((r) => r.seq < targetFrom && !inReplayBlock(r) && r.kind !== 'notice');
  if (before.length) throw new Error(`the target has ${before.length} event(s) of its own inside its replay; not handled`);
  const gap = replayGap(target.rows.filter((r) => r.seq < targetFrom && inReplayBlock(r)), lastUserText(out, session));
  const map = new Map<number, number>();
  const start = out.length;
  const g = take(target, gap.rows, map, () => ++seq);
  const shift = seq + 1 - targetFrom;
  const own = target.rows.filter((r) => r.seq >= targetFrom);
  const s = take(target, own, map, (() => {
    let i = 0;
    return () => own[i++].seq + shift;
  })());
  remapRows(target, map, start);
  perSource.push({
    id: target.id,
    kept: g.kept + s.kept,
    replayDropped: target.rows.length - g.kept - s.kept,
    turnEnds: s.turnEnds,
    notes: s.notes,
    from: g.from || s.from,
    to: s.to || g.to,
  });

  let ckptNew: Json | null = null;
  if (ckptOld) {
    const state = { ...(ckptOld.state as Json) };
    for (const k of ['sequence', 'eventsFrom'] as const) if (typeof state[k] === 'number') state[k] = (state[k] as number) + shift;
    ckptNew = { ...ckptOld, state, sequence: Number(ckptOld.sequence) + shift };
  }

  // The kept lines of the conversation: every turn end and AIB note, after the user message of its turn.
  const lines: KeptLine[] = [];
  let after = '';
  for (const r of out) {
    if (r.session !== null) continue; // a helper's
    const e = JSON.parse(r.data) as Json;
    const d = e.data as Json | null;
    if (r.kind === 'user' && d && typeof d.text === 'string' && (!d.sessionId || d.sessionId === session)) after = anchorOf(d.text);
    if (r.kind === 'update' && e.replay === true) {
      const u = (d?.update ?? {}) as Json;
      const c = u.content as Json | undefined;
      if (u.sessionUpdate === 'user_message_chunk' && c && typeof c.text === 'string' && (!d?.sessionId || d.sessionId === session)) {
        after = anchorOf(c.text); // (a replayed message's first chunk: enough for its anchor)
      }
    }
    if (KEPT_KINDS.has(r.kind)) lines.push({ kind: r.kind, data: d, time: r.time, after });
  }
  void provider;
  return {
    rows: out,
    messages,
    shift,
    targetFrom,
    ckptOld,
    ckptNew,
    gap: { turns: gap.turns, events: gap.rows.length, anchorFound: gap.anchorFound },
    writtenOld,
    writtenNew: Math.max(writtenOld + shift, seq),
    perSource,
    lines,
  };
}

/** The text of the last user message of the conversation in these rows (an AIB `user` event, or a replayed user message). */
function lastUserText(rows: Row[], session: string): string {
  let last = '';
  let run: string | null = null;
  for (const r of rows) {
    if (r.session !== null) continue; // a helper's
    const e = JSON.parse(r.data) as Json;
    const d = e.data as Json | null;
    const u = r.kind === 'update' ? ((d?.update ?? {}) as Json) : null;
    if (u && u.sessionUpdate === 'user_message_chunk' && (!d?.sessionId || d.sessionId === session)) {
      const c = u.content as Json | undefined;
      run = (run ?? '') + (c && typeof c.text === 'string' ? c.text : '');
      continue;
    }
    if (run !== null) {
      if (run.trim()) last = run;
      run = null;
    }
    if (r.kind === 'user' && d && typeof d.text === 'string' && d.text.trim() && (!d.sessionId || d.sessionId === session)) last = d.text;
  }
  if (run !== null && run.trim()) last = run;
  return last;
}

/**
 * Of a replay (rows in order), the turns after the last turn whose user message contains `anchor` (connection.ts outsideTurns, the
 * same rule AIB uses). Anchor not found (the replay starts after a compaction that came later than the earlier stores' last turn,
 * or there is no anchor): the whole replay is kept, since none of it is in the earlier stores.
 */
function replayGap(replay: Row[], anchor: string): { rows: Row[]; turns: number; anchorFound: boolean } {
  const turns: { text: string; rows: Row[] }[] = [];
  let inUser = false;
  for (const r of replay) {
    const d = (JSON.parse(r.data) as Json).data as Json | null;
    const u = (d?.update ?? {}) as Json;
    if (u.sessionUpdate === 'user_message_chunk') {
      if (!inUser || !turns.length) turns.push({ text: '', rows: [] });
      inUser = true;
      const c = u.content as Json | undefined;
      if (c && typeof c.text === 'string') turns.at(-1)!.text += c.text;
    } else {
      inUser = false;
      if (!turns.length) turns.push({ text: '', rows: [] });
    }
    turns.at(-1)!.rows.push(r);
  }
  const want = anchor.trim();
  let mine = -1;
  if (want) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].text.includes(want)) {
        mine = i;
        break;
      }
    }
  }
  const kept = mine >= 0 ? turns.slice(mine + 1) : turns;
  return { rows: kept.flatMap((t) => t.rows), turns: kept.filter((t) => t.text).length, anchorFound: mine >= 0 };
}

// ---- writing ---------------------------------------------------------------------------------------------------------------------
const SCHEMA_SQL = `
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
`;

function writeMerged(path: string, p: Plan, target: Source): void {
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(SCHEMA_SQL);
    db.exec('BEGIN');
    const meta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    for (const [k, v] of target.meta) if (k !== 'ckpt') meta.run(k, v);
    meta.run('written_seq', String(p.writtenNew));
    if (p.ckptNew) meta.run('ckpt', JSON.stringify(p.ckptNew));
    const enc = new TextEncoder();
    const ins = db.prepare('INSERT INTO events(seq, session, kind, time, row_start, bytes, data) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const r of p.rows) ins.run(r.seq, r.session, r.kind, r.time, r.rowStart, enc.encode(r.data).length, r.data);
    const msg = db.prepare('INSERT INTO messages(row_start, role, text) VALUES (?, ?, ?) ON CONFLICT(row_start) DO UPDATE SET text = messages.text || excluded.text');
    for (const m of p.messages) msg.run(m.rowStart, m.role, m.text);
    db.exec('COMMIT');
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

/** Open the merged file the way AIB does and check what a take-over reads. Throws on any mismatch. */
function verify(dir: string, id: string, p: Plan): void {
  const { store, info } = HistoryStore.open(dir, id);
  try {
    if (info.damaged) throw new Error('the merged store did not pass quick_check');
    if (info.first !== 1) throw new Error(`the merged store starts at ${info.first}, not 1`);
    if (info.writtenSeq !== p.writtenNew) throw new Error(`written_seq ${info.writtenSeq} != ${p.writtenNew}`);
    if (info.last !== p.rows.at(-1)!.seq) throw new Error(`the merged store ends at ${info.last}, not ${p.rows.at(-1)!.seq}`);
    if (p.ckptNew) {
      if (!info.ckpt || info.ckpt.sequence !== p.ckptNew.sequence) throw new Error('the checkpoint did not move with the events');
      const tail = store.before(info.ckpt.sequence + 1, { limit: 50 });
      if (!tail.events.length || tail.to! > info.ckpt.sequence) throw new Error('the checkpoint\'s history cannot be read');
    }
    const head = store.after(0, { limit: 5 });
    if (head.from !== 1) throw new Error('the oldest page cannot be read');
  } finally {
    store.close();
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------------------
async function main(): Promise<number> {
  const o = options(Deno.args);
  const historyDir = join(o.data, 'history');
  const say = (s: string) => console.log(s);
  say(`AIB data folder: ${o.data}`);
  say(o.apply ? 'Mode: APPLY (changes files)' : 'Mode: dry run (nothing is changed; add --apply to do it)');
  if (o.lock) {
    try {
      await tryLockNow(join(o.data, LOCK_FILE), true); // held until this process ends: AIB cannot start meanwhile
    } catch {
      console.error('AIB is running (its data folder is locked). Quit AIB (its chats keep running in the keeper), then run this again. Nothing was changed.');
      return 2;
    }
  }
  const ids = o.chain;
  const targetId = ids.at(-1)!;
  const targetPath = join(historyDir, `${targetId}.sqlite`);
  if (!existsSync(targetPath)) {
    console.error(
      `\nRefused: the target store ${targetPath} is missing (the chat in use, ${targetId}). Nothing was changed.\n` +
        'An AIB older than the fix deletes a chat\'s store when it quits with the chat idle: update AIB from inside AIB first ' +
        '(see the steps at the top of this script), and do not delete chats meanwhile. If the chat in use has another id now, ' +
        'pass the chain with --chain <id,...,target>.',
    );
    return 5;
  }
  const missing = ids.slice(0, -1).filter((id) => !existsSync(join(historyDir, `${id}.sqlite`)));
  if (missing.length) {
    console.error(`\nRefused: these source stores are missing: ${missing.join(', ')}. Leave them out with --chain. Nothing was changed.`);
    return 5;
  }
  const sources = ids.slice(0, -1).map((id) => readStore(historyDir, id));
  const target = readStore(historyDir, targetId);
  for (const s of [...sources, target]) {
    const sid = sessionOfStore(s);
    if (sid && sid !== o.session) throw new Error(`store ${s.id} belongs to session ${sid}, not ${o.session}`);
  }
  // Done already? The target then starts with the first source's first event.
  const first = sources[0].rows[0];
  if (target.rows[0] && first && target.rows[0].data === first.data && target.rows.length > sources[0].rows.length) {
    say(`Already repaired: ${target.id} starts with the history of ${sources[0].id}. Nothing to do.`);
    return 0;
  }
  const p = plan(sources, target, o.provider, o.session);
  const snap = newestSnapshotUpTo(o.data, targetId);
  say('');
  say(`Conversation: ${o.provider} ${o.session}`);
  say(`Target (the chat in use): ${target.id}`);
  for (const s of p.perSource) {
    say(`  ${s.id}: ${s.kept} events kept -> seq ${s.from}..${s.to} (${s.turnEnds} turn ends, ${s.notes} AIB notes)` +
      (s.replayDropped ? `; ${s.replayDropped} replayed transcript events left out (the earlier store has them)` : ''));
  }
  say(`  merged: ${p.rows.length} events, ${p.rows.filter((r) => r.kind === 'turn_end').length} turn ends, ` +
    `${p.rows.filter((r) => r.kind === 'studio_note').length} AIB notes, ${p.messages.length} searchable messages`);
  say(
    `  of ${target.id}'s replay: ${p.gap.events} events kept (${p.gap.turns} turn(s) no earlier store has: a gone store's)` +
      (p.gap.anchorFound ? '' : '; the last earlier turn is not in it (a later compaction), so all of it is kept'),
  );
  say(`  the current chat's own events move up by ${p.shift} (seq ${p.targetFrom} -> ${p.targetFrom + p.shift})`);
  say(
    p.ckptOld && p.ckptNew
      ? `  checkpoint: sequence ${p.ckptOld.sequence} -> ${p.ckptNew.sequence}, record ${p.ckptOld.record} (unchanged); written_seq ${p.writtenOld} -> ${p.writtenNew}`
      : `  no checkpoint (the chat is not in the keeper); written_seq ${p.writtenOld} -> ${p.writtenNew}`,
  );
  say(`  keeper record: ${snap.journal ? `newest snapshot covers record ${snap.upTo ?? 'none'}` : 'no journal found (the chat is not in the keeper: it reopens from its store)'}`);
  if (snap.journal && (!p.ckptOld || Number(p.ckptOld.sequence) < p.targetFrom)) {
    console.error(
      '\nRefused: the chat still runs in the keeper and its store checkpoint is missing or inside its replay. Open AIB, let the chat ' +
        'finish a turn, quit AIB (tray > Quit AIB), run this again. Nothing was changed.',
    );
    return 3;
  }
  const linesFile = new ConversationLines(join(o.data, 'conversation-lines')).path(o.provider, o.session);
  const existing = new ConversationLines(join(o.data, 'conversation-lines')).read(o.provider, o.session);
  const lastTime = p.lines.reduce((m, l) => Math.max(m, l.time), 0);
  const later = existing.filter((l) => l.time > lastTime);
  say(`  kept lines: ${linesFile} gets ${p.lines.length} lines from the merged history` + (existing.length ? ` + ${later.length} newer already there` : ''));
  if (snap.journal && p.ckptOld && snap.upTo !== null && snap.upTo > Number(p.ckptOld.record)) {
    console.error(
      `\nRefused: the chat's keeper record has a snapshot (record ${snap.upTo}) newer than its store checkpoint (${p.ckptOld.record}). ` +
        'Open AIB, send the chat any message and let it finish, quit AIB, then run this again. Nothing was changed.',
    );
    return 3;
  }
  if (!o.apply) {
    say('\nDry run: nothing was changed.');
    return 0;
  }
  // Backups of everything that changes.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(o.data, 'repair-backups', `lead-chat-${stamp}`);
  mkdirSync(backup, { recursive: true });
  for (const suffix of ['', '-wal', '-shm']) if (existsSync(target.path + suffix)) copyFileSync(target.path + suffix, join(backup, `${target.id}.sqlite${suffix}`));
  if (existsSync(linesFile)) copyFileSync(linesFile, join(backup, linesFile.split(/[\\/]/).at(-1)!));
  say(`\nBacked up to ${backup}`);
  // Build, check, replace.
  const tmpId = `${target.id}.repair`;
  const tmp = join(historyDir, `${tmpId}.sqlite`);
  writeMerged(tmp, p, target);
  verify(historyDir, tmpId, p);
  for (const suffix of ['-wal', '-shm']) rmSync(target.path + suffix, { force: true });
  rmSync(tmp + '-shm', { force: true });
  if (existsSync(tmp + '-wal') && statSync(tmp + '-wal').size === 0) rmSync(tmp + '-wal', { force: true });
  renameSync(tmp, target.path);
  if (existsSync(tmp + '-wal')) renameSync(tmp + '-wal', target.path + '-wal');
  verify(historyDir, target.id, p);
  say(`Merged history written to ${target.path}`);
  mkdirSync(join(o.data, 'conversation-lines'), { recursive: true });
  writeFileSync(linesFile, [...p.lines, ...later].map((l) => JSON.stringify(l) + '\n').join(''));
  say(`Kept lines written to ${linesFile}`);
  say(`Done. Start AIB: the conversation opens as chat ${target.id} with its whole history.`);
  return 0;
}

if (import.meta.main) {
  try {
    Deno.exit(await main());
  } catch (error) {
    console.error(`repair_lead_chat_history: ${error instanceof Error ? error.message : error}. The target store is only replaced as the last step; the backup folder printed above (if any) has the files as they were.`);
    Deno.exit(1);
  }
}

export { newestSnapshotUpTo, plan, readStore };
