/**
 * History loading, Phase 0B (not a test; run by hand): the keeper side of a take-over. Starts the repo's keeper on a COPY of a
 * state folder (<copy>/keeper/channels/*, channels.json; never the owner's folder), then for each of the biggest channels times
 *   firstNote   what Studio reads first (link.ts firstNote: attach from 0 until the chat note, then detach)
 *   attach      attach from 0 until `live` (what adopt() does): records, bytes, time; JS-side handling is only counting
 * A copied channel that was live gets the keeper's `keeper_lost` exit record in the copy (the copy only). Stops the keeper after.
 *
 *   takeover    with --takeover: Studio's take-over loop replayed in one process, in keeper list order: firstNote, then a real
 *               Connection rebuild through the real KeeperLink.adopt (attach from 0, buffer, restore, raw replay) until `rebuilt`
 *               settles. The copied channels have ended (keeper_lost), so the final claim fails after all the work: the time is
 *               the take-over's history cost, without the session lease, live sync and the other per-chat work.
 *
 *   deno run -A work/deno/history_keeper_read.ts <copied state dir> [--top N] [--runs R] [--takeover]
 */
import { ensureKeeper, type KeeperClient, type KeeperRecord } from '../../app/server/keeper/client.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { Connection } from '../../app/server/acp/connection.ts';

const argv = [...Deno.args];
const flag = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv.splice(i, 2)[1] : fallback;
};
const TOP = Number(flag('--top', '4'));
const RUNS = Number(flag('--runs', '3'));
const TAKEOVER = argv.includes('--takeover');
const DATA = argv.filter((a) => a !== '--takeover')[0];
if (!DATA) throw new Error('usage: history_keeper_read.ts <copied state dir>');
if (/AppData[\\/]Local[\\/]AgentStudio[\\/]?$/i.test(DATA)) throw new Error('never point this at the real state folder');

const channelsDir = `${DATA}/keeper/channels`;
const sizes = [...Deno.readDirSync(channelsDir)].filter((e) => e.isDirectory).map((e) => {
  const dir = `${channelsDir}/${e.name}`;
  return { channel: e.name, bytes: [...Deno.readDirSync(dir)].reduce((s, f) => s + Deno.statSync(`${dir}/${f.name}`).size, 0) };
}).sort((a, b) => b.bytes - a.bytes).slice(0, TOP);

const client: KeeperClient = await ensureKeeper(DATA, { waitSeconds: 20 });
const link = new KeeperLink({ dataDir: DATA } as never);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function attachAll(channel: string) {
  let records = 0, bytes = 0, notes = 0;
  const t = performance.now();
  await new Promise<void>((resolve, reject) => {
    client.attach(channel, 0, {
      record(r: KeeperRecord) {
        records++;
        bytes += r.body.length;
        if (r.kind === 'note') notes++;
      },
      live: () => resolve(),
      removed: () => reject(new Error('removed')),
    } as never).catch(reject);
  });
  const ms = performance.now() - t;
  await client.detach(channel).catch(() => {});
  return { records, bytes, notes, ms };
}

async function takeover() {
  const listed = (await client.list()).filter((i) => i.kind === 'pipe' && !i.channel.startsWith('ct-') && sizes.length);
  const cwd = Deno.makeTempDirSync({ prefix: 'aib-hist-cwd-', dir: DATA });
  const stub = () =>
    new Proxy({ terminals: new Map(), terminalBackend: null } as Record<string | symbol, unknown>, {
      get: (t, p) => (p in t ? t[p] : p === 'then' ? undefined : () => Promise.resolve(1)),
    }) as never;
  let total = 0;
  for (const info of listed) {
    const t0 = performance.now();
    const note = await link.firstNote(client, info.channel);
    const t1 = performance.now();
    if (!note || note.t !== 'chat') continue;
    const c = new Connection([], cwd, String(note.provider), {
      keeper: link,
      id: String(note.id),
      rebuild: info,
      start: false,
      capsFactory: stub,
    });
    await c.rebuilt?.catch(() => {});
    const t2 = performance.now();
    total += t2 - t0;
    console.log(JSON.stringify({
      takeover: info.channel,
      firstNoteMs: +(t1 - t0).toFixed(0),
      rebuildMs: +(t2 - t1).toFixed(0),
      replayedFrom: c.replayedFrom,
      replayedRecords: c.replayedRecords,
      events: c.events.length,
      rebuildError: String(c.rebuildError ?? '').slice(0, 100), // expected: the claim of an ended channel (after the work)
    }));
    void c.close().catch(() => {});
  }
  console.log(JSON.stringify({ takeoverTotalMs: +total.toFixed(0), chats: listed.length }));
}

try {
  if (TAKEOVER) await takeover();
  else {for (const s of sizes) {
      const first: number[] = [], all: number[] = [];
      let last = { records: 0, bytes: 0, notes: 0, ms: 0 };
      for (let run = 0; run < RUNS; run++) {
        const t = performance.now();
        await link.firstNote(client, s.channel);
        first.push(performance.now() - t);
        last = await attachAll(s.channel);
        all.push(last.ms);
      }
      console.log(JSON.stringify({
        channel: s.channel,
        journalMB: +(s.bytes / 1048576).toFixed(1),
        records: last.records,
        notes: last.notes,
        bodyMB: +(last.bytes / 1048576).toFixed(1),
        firstNoteMs: +median(first).toFixed(0),
        attachMs: +median(all).toFixed(0),
        attachMBps: +((last.bytes / 1048576) / (median(all) / 1000)).toFixed(0),
      }));
    }}
} finally {
  await client.shutdown(true).catch(() => {});
  client.close();
}
Deno.exit(0);
