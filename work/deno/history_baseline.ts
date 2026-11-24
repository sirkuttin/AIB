/**
 * History loading, Phase 0B (not a test; run by hand): where today's keeper take-over time goes, and what opening a chat costs.
 *
 * Reads a COPY of keeper journals (never the owner's folder), then for each chat:
 *   disk     read every <firstSeq>.journal file of the channel
 *   decode   split the files into records (the keeper's on-disk format, PROTOCOL.md section 5; CRC not checked)
 *   notes    TextDecoder + JSON.parse of every note record, split into chunk notes (t:'event', sv:2 snapshot events) and the rest
 *   feed     a real Connection rebuild (options.rebuild, a fake keeper link that hands it the records): the replay buffering, which
 *            parses every note again (parseNote) and keeps the chunks
 *   restore  live() until `rebuilt` with the records cut after the newest snapshot note: #restoreSnapshot (state + chunk events)
 *   replay   the same with every record: restore + the raw records after the snapshot (replay = live(all) - restore)
 *   open     public(0) (what /api/live/state returns for a first open) JSON.stringify'd: bytes and time; and public(0, true)
 *
 * The fake keeper link answers claim/notes/writes with nothing: the rebuild sends nothing anywhere, and the Connection gets a stub
 * for its client capabilities (no file writes, no terminals). Its cwd is a temp folder, not the chat's folder.
 *
 *   deno run -A work/deno/history_baseline.ts <copied keeper dir> [--top N] [--runs R] [--only <channel>]
 *
 * Prints one JSON line per chat and run, then a table (medians).
 */
import { Connection } from '../../app/server/acp/connection.ts';
import type { ChannelInfo, KeeperRecord } from '../../app/server/keeper/client.ts';

type Json = Record<string, unknown>;
const KINDS = ['', 'out', 'err', 'in', 'note', 'exit', 'resize'] as const;

const argv = [...Deno.args];
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : fallback;
};
const TOP = Number(flag('--top', '4'));
const RUNS = Number(flag('--runs', '3'));
const ONLY = flag('--only', '');
const KEEPER_DIR = argv[0];
if (!KEEPER_DIR) throw new Error('usage: history_baseline.ts <copied keeper dir> [--top N] [--runs R]');
if (/AppData[\\/]Local[\\/]AgentStudio[\\/]keeper/i.test(KEEPER_DIR)) throw new Error('never point this at the real keeper folder');

const now = () => performance.now();

async function readChannel(dir: string): Promise<{ files: Uint8Array[]; bytes: number; ms: number }> {
  const t = now();
  const names = [...Deno.readDirSync(dir)].filter((e) => e.name.endsWith('.journal')).map((e) => e.name).sort();
  const files: Uint8Array[] = [];
  for (const name of names) files.push(await Deno.readFile(`${dir}/${name}`));
  return { files, bytes: files.reduce((s, f) => s + f.length, 0), ms: now() - t };
}

function decode(channel: string, files: Uint8Array[]): KeeperRecord[] {
  const out: KeeperRecord[] = [];
  for (const f of files) {
    const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
    let at = 0;
    while (at + 25 <= f.length) {
      const len = view.getUint32(at, true);
      if (at + 25 + len > f.length) break; // a torn tail (copied while the keeper wrote): cut, as the keeper does
      const kind = KINDS[f[at + 4]] ?? 'out';
      const seq = Number(view.getBigUint64(at + 5, true));
      const time = Number(view.getBigUint64(at + 13, true));
      out.push({ channel, seq, kind: kind as KeeperRecord['kind'], time, body: f.subarray(at + 21, at + 21 + len) });
      at += 25 + len;
    }
  }
  return out;
}

function noteStats(records: KeeperRecord[]) {
  const dec = new TextDecoder();
  let decodeMs = 0, parseMs = 0, chunkBytes = 0, chunkNotes = 0, otherBytes = 0, otherNotes = 0, chunkParseMs = 0;
  let lastSnapshot = -1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.kind !== 'note') continue;
    let t = now();
    const text = dec.decode(r.body);
    decodeMs += now() - t;
    t = now();
    let note: Json | null = null;
    try {
      note = JSON.parse(text);
    } catch { /* not JSON */ }
    const ms = now() - t;
    parseMs += ms;
    const chunk = note?.t === 'event' || (note?.t === 'snapshot' && Array.isArray(note.events) && note.events.length > 0);
    if (note?.t === 'snapshot') lastSnapshot = i;
    if (chunk) (chunkNotes++, chunkBytes += r.body.length, chunkParseMs += ms);
    else (otherNotes++, otherBytes += r.body.length);
  }
  return { decodeMs, parseMs, chunkParseMs, chunkNotes, chunkBytes, otherNotes, otherBytes, lastSnapshot };
}

/** Everything the Connection may call on its keeper channel or link: nothing happens, promises resolve. */
function inert<T extends object>(base: T): T {
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      if (prop === 'then') return undefined;
      return () => Promise.resolve(1);
    },
  });
}

function capsStub(): never {
  return inert({ terminals: new Map(), terminalBackend: null }) as never;
}

async function rebuild(info: ChannelInfo, note: Json, records: KeeperRecord[], cwd: string) {
  let listener: Json = {};
  const channel = inert({ id: info.channel, client: null, pid: info.pid, epoch: 0, lost: false, owner: true, suspended: false });
  const link = inert({
    adopt(_info: ChannelInfo, l: Json) {
      listener = l;
      return channel;
    },
  });
  const c = new Connection([], cwd, String(note.provider ?? 'claude'), {
    keeper: link as never,
    id: String(note.id ?? info.channel),
    rebuild: info,
    start: false,
    capsFactory: capsStub,
  });
  c.sessionId = typeof note.resume === 'string' ? note.resume : null;
  await new Promise((r) => setTimeout(r, 0)); // channel.start() runs adopt's start callback (attach) — not used here
  const record = listener.record as (r: KeeperRecord) => void;
  let t = now();
  for (const r of records) record(r);
  const feedMs = now() - t;
  t = now();
  (listener.live as () => void)();
  let error = '';
  try {
    await c.rebuilt;
  } catch (e) {
    error = String(e);
  }
  const liveMs = now() - t;
  return { c, feedMs, liveMs, error: error || c.rebuildError || '' };
}

function openCost(c: Connection) {
  let t = now();
  const full = JSON.stringify(c.public(0));
  const fullMs = now() - t;
  t = now();
  const light = JSON.stringify(c.public(0, true));
  const lightMs = now() - t;
  return { openBytes: new TextEncoder().encode(full).length, openMs: fullMs, lightBytes: light.length, lightMs, events: c.events.length };
}

function chatNote(records: KeeperRecord[]): Json | null {
  const dec = new TextDecoder();
  for (const r of records) {
    if (r.kind !== 'note') continue;
    try {
      const n = JSON.parse(dec.decode(r.body));
      if (n?.t === 'chat') return n;
      if (n?.t === 'snapshot' && n.chat) return n.chat;
    } catch { /* no */ }
  }
  return null;
}

const channelsDir = `${KEEPER_DIR}/channels`;
const sizes = [...Deno.readDirSync(channelsDir)].filter((e) => e.isDirectory).map((e) => {
  const dir = `${channelsDir}/${e.name}`;
  const bytes = [...Deno.readDirSync(dir)].reduce((s, f) => s + Deno.statSync(`${dir}/${f.name}`).size, 0);
  return { channel: e.name, dir, bytes };
}).sort((a, b) => b.bytes - a.bytes);
const picked = ONLY ? sizes.filter((s) => s.channel === ONLY) : sizes.slice(0, TOP);
const cwd = Deno.makeTempDirSync({ prefix: 'aib-hist-cwd-', dir: `${KEEPER_DIR}/..` });
const rows: Json[] = [];
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

for (const ch of picked) {
  const runs: Json[] = [];
  for (let run = 0; run < RUNS; run++) {
    const read = await readChannel(ch.dir);
    const t = now();
    const records = decode(ch.channel, read.files);
    const decodeMs = now() - t;
    const notes = noteStats(records);
    const note = chatNote(records) ?? {};
    const info: ChannelInfo = {
      channel: ch.channel,
      kind: 'pipe',
      pid: 0,
      command: '',
      created: 0,
      live: true,
      exitCode: null,
      epoch: 0,
    } as ChannelInfo;
    // restore only: the records up to the newest snapshot note (the raw records after it left out)
    const cut = notes.lastSnapshot >= 0 ? records.slice(0, notes.lastSnapshot + 1) : [];
    const a = cut.length ? await rebuild(info, note, cut, cwd) : null;
    const restoreMs = a ? a.liveMs : 0;
    if (a) void a.c.close().catch(() => {}); // close() waits up to 13 s for an agent exit that never comes here
    const b = await rebuild(info, note, records, cwd);
    const open = openCost(b.c);
    const row = {
      channel: ch.channel,
      chat: note.id,
      session: note.resume,
      cwd: note.cwd,
      run,
      journalMB: +(read.bytes / 1048576).toFixed(1),
      records: records.length,
      replayedRecords: b.c.replayedRecords,
      replayedFrom: b.c.replayedFrom,
      diskMs: +read.ms.toFixed(0),
      decodeMs: +decodeMs.toFixed(0),
      noteDecodeMs: +notes.decodeMs.toFixed(0),
      noteParseMs: +notes.parseMs.toFixed(0),
      chunkParseMs: +notes.chunkParseMs.toFixed(0),
      chunkNotes: notes.chunkNotes,
      chunkMB: +(notes.chunkBytes / 1048576).toFixed(1),
      otherNotes: notes.otherNotes,
      feedMs: +b.feedMs.toFixed(0),
      restoreMs: +restoreMs.toFixed(0),
      liveMs: +b.liveMs.toFixed(0),
      replayMs: +(b.liveMs - restoreMs).toFixed(0),
      openMB: +(open.openBytes / 1048576).toFixed(2),
      openMs: +open.openMs.toFixed(0),
      lightMB: +(open.lightBytes / 1048576).toFixed(2),
      lightMs: +open.lightMs.toFixed(0),
      events: open.events,
      error: b.error || a?.error || '',
    };
    void b.c.close().catch(() => {});
    console.log(JSON.stringify(row));
    runs.push(row);
  }
  const med: Json = { ...runs[0] };
  for (const k of Object.keys(med)) if (typeof med[k] === 'number' && k !== 'run') med[k] = median(runs.map((r) => r[k] as number));
  rows.push(med);
}
Deno.removeSync(cwd, { recursive: true });

const cols = [
  'journalMB',
  'records',
  'replayedRecords',
  'diskMs',
  'decodeMs',
  'chunkNotes',
  'chunkMB',
  'noteDecodeMs',
  'chunkParseMs',
  'noteParseMs',
  'feedMs',
  'restoreMs',
  'replayMs',
  'liveMs',
  'events',
  'openMB',
  'openMs',
  'lightMB',
  'lightMs',
];
console.log('\nchannel  ' + cols.join('  '));
for (const r of rows) {
  console.log(`${String(r.channel).slice(5, 13)}  ${cols.map((c) => r[c]).join('  ')}  ${r.error ? 'ERR ' + r.error : ''}`);
}
Deno.exit(0);
