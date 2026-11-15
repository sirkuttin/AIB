/**
 * History loading, Phase 0B (not a test; run by hand): the event-loop delay a node:sqlite store adds to the agent host's loop.
 *
 * 14 synthetic chats stream events on the main loop (each: a ~300 B message chunk every 25 ms, a 4-40 KB tool output every 1 s,
 * JSON.stringify'd like the real event path). A writer commits each chat's queued events every 200 ms into its own database
 * (<dir>/<chat>.sqlite, WAL, synchronous=NORMAL, the design's events table), and every 2 s one chat's newest 300 events are read
 * (an open). Modes:
 *   none     no store (the loop's own delay: the baseline)
 *   main     DatabaseSync on the main loop (commits and reads block it)
 *   main-ckpt  main with a checkpoint every ~400 KB of WAL (10x the default), to make checkpoint stalls show in a short run
 *   worker   one Worker owns every database; the loop only posts batches and range requests
 * The loop delay: every gap between two turns of a MessageChannel ping (see the probe). Prints p50/p99/max per mode.
 *
 *   deno run -A work/deno/history_loop_bench.ts <scratch dir> [--seconds 20] [--modes none,main,worker]
 */
import { DatabaseSync } from 'node:sqlite';

const argv = [...Deno.args];
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : fallback;
};
const SECONDS = Number(flag('--seconds', '20'));
const MODES = flag('--modes', 'none,main,worker').split(',');
const DIR = argv[0];
const CHATS = 14;

// ---- the store (the same code runs on the main loop or in the Worker) -----------------------------------------------------------
export class Stores {
  dbs = new Map<string, { db: DatabaseSync; insert: ReturnType<DatabaseSync['prepare']>; recent: ReturnType<DatabaseSync['prepare']> }>();
  constructor(readonly dir: string, readonly autoCheckpoint = 1000) {}
  #open(chat: string) {
    let s = this.dbs.get(chat);
    if (s) return s;
    const db = new DatabaseSync(`${this.dir}/${chat}.sqlite`);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=${this.autoCheckpoint};`);
    db.exec(`CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, session TEXT NULL, kind TEXT, time REAL, row_start INTEGER,
      bytes INTEGER, clipped INTEGER, data TEXT)`);
    db.exec('CREATE INDEX IF NOT EXISTS events_by_session ON events(session, seq)');
    s = {
      db,
      insert: db.prepare(
        'INSERT OR REPLACE INTO events(seq, session, kind, time, row_start, bytes, clipped, data) VALUES (?,?,?,?,?,?,0,?)',
      ),
      recent: db.prepare('SELECT data FROM events WHERE session IS NULL ORDER BY seq DESC LIMIT ?'),
    };
    this.dbs.set(chat, s);
    return s;
  }
  write(chat: string, rows: [number, string, number, string][]): number {
    const s = this.#open(chat);
    s.db.exec('BEGIN');
    for (const [seq, kind, time, data] of rows) s.insert.run(seq, null, kind, time, seq, data.length, data);
    s.db.exec('COMMIT');
    return rows.length;
  }
  recent(chat: string, n: number): number {
    const rows = this.#open(chat).recent.all(n) as { data: string }[];
    return rows.reduce((sum, r) => sum + r.data.length, 0);
  }
  close() {
    for (const s of this.dbs.values()) s.db.close();
    this.dbs.clear();
  }
}

// ---- the bench --------------------------------------------------------------------------------------------------------------------
function pct(sorted: Float64Array, p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function run(mode: string) {
  const dir = `${DIR}/${mode}-${Date.now()}`;
  Deno.mkdirSync(dir, { recursive: true });
  // main-ckpt: main, with a WAL checkpoint every ~100 pages (400 KB) instead of 1000, so checkpoint stalls show up in a short run
  const stores = mode === 'main' ? new Stores(dir) : mode === 'main-ckpt' ? new Stores(dir, 100) : null;
  const worker = mode === 'worker' ? new Worker(new URL('./history_loop_worker.ts', import.meta.url).href, { type: 'module' }) : null;
  const waiting = new Map<number, (v: unknown) => void>();
  let ids = 0;
  if (worker) {
    worker.onmessage = (e) => waiting.get(e.data.id)?.(e.data);
    worker.postMessage({ op: 'open', dir });
  }
  const queues = Array.from({ length: CHATS }, () => [] as [number, string, number, string][]);
  const seqs = new Array(CHATS).fill(0);
  let written = 0, reads = 0, readBytes = 0;
  const filler = 'x'.repeat(40000);
  const timers: ReturnType<typeof setInterval>[] = [];
  const emit = (c: number, kind: string, text: string) => {
    const event = { seq: ++seqs[c], kind: 'update', time: Date.now() / 1000, data: { update: { sessionUpdate: kind, content: { text } } } };
    queues[c].push([event.seq, kind, event.time, JSON.stringify(event)]);
  };
  for (let c = 0; c < CHATS; c++) {
    timers.push(setInterval(() => emit(c, 'agent_message_chunk', filler.slice(0, 250 + (c * 7) % 100)), 25));
    timers.push(setInterval(() => emit(c, 'tool_call_update', filler.slice(0, 4000 + Math.floor(Math.random() * 36000))), 1000));
  }
  timers.push(setInterval(() => {
    for (let c = 0; c < CHATS; c++) {
      if (!queues[c].length) continue;
      const rows = queues[c];
      queues[c] = [];
      written += rows.length;
      if (stores) stores.write(`chat${c}`, rows);
      else if (worker) worker.postMessage({ op: 'write', chat: `chat${c}`, rows });
    }
  }, 200));
  timers.push(setInterval(async () => {
    const chat = `chat${Math.floor(Math.random() * CHATS)}`;
    reads++;
    if (stores) readBytes += stores.recent(chat, 300);
    else if (worker) {
      const id = ++ids;
      const answer = await new Promise((resolve) => (waiting.set(id, resolve), worker.postMessage({ op: 'recent', id, chat, n: 300 })));
      waiting.delete(id);
      readBytes += (answer as { bytes: number }).bytes;
    }
  }, 2000));
  // The loop delay probe. Windows timers are ~15 ms coarse, so a MessageChannel ping-pong measures each macrotask gap exactly: a gap
  // is how long the loop was busy with something else (the synthetic chats' own work included). Reported time-weighted: p99 = the wait a message arriving at a random moment
  // sees at most 99% of the time. The first second (start-up, JIT) is left out.
  const gaps = new Float64Array(SECONDS * 2_000_000); // preallocated: a growing array's own GC would show up as loop delay
  let n = 0;
  const skipUntil = performance.now() + 1000;
  const end = performance.now() + SECONDS * 1000;
  const ping = new MessageChannel();
  await new Promise<void>((resolve) => {
    let last = performance.now();
    ping.port1.onmessage = () => {
      const t = performance.now();
      if (t > skipUntil && n < gaps.length) gaps[n++] = t - last;
      last = t;
      if (t > end) return resolve();
      ping.port2.postMessage(0); // back-to-back: the probe spins one core, but sees every block whole
    };
    ping.port2.postMessage(0);
  });
  ping.port1.close();
  const delays = gaps.subarray(0, n).sort();
  for (const t of timers) clearInterval(t);
  if (worker) {
    const id = ++ids;
    await new Promise((resolve) => (waiting.set(id, resolve), worker.postMessage({ op: 'close', id })));
    worker.terminate();
  }
  stores?.close();
  let dbBytes = 0;
  for (const f of Deno.readDirSync(dir)) dbBytes += Deno.statSync(`${dir}/${f.name}`).size;
  Deno.removeSync(dir, { recursive: true });
  const total = delays.reduce((a, b) => a + b, 0);
  const weighted = (p: number) => { // the gap length below which p% of the wall time lies
    let acc = 0;
    for (const g of delays) if ((acc += g) >= (p / 100) * total) return g;
    return delays.at(-1) ?? 0;
  };
  return {
    mode,
    seconds: SECONDS,
    samples: delays.length,
    p50: +pct(delays, 50).toFixed(2),
    p99: +pct(delays, 99).toFixed(2),
    p999: +pct(delays, 99.9).toFixed(2),
    max: +(delays.at(-1) ?? 0).toFixed(1),
    over5ms: delays.filter((d) => d > 5).length,
    over20ms: delays.filter((d) => d > 20).length,
    timeP99: +weighted(99).toFixed(2),
    eventsWritten: written,
    reads,
    readKB: Math.round(readBytes / 1024 / Math.max(1, reads)),
    dbMB: +(dbBytes / 1048576).toFixed(1),
  };
}

if (import.meta.main) {
  if (!DIR) throw new Error('usage: history_loop_bench.ts <scratch dir> [--seconds 20] [--modes none,main,worker]');
  await run('none'); // warm-up (JIT, first database open), not reported
  for (const mode of MODES) console.log(JSON.stringify(await run(mode)));
  Deno.exit(0);
}
