/**
 * History loading phase 2A (design v2 3.2-3.5): a keeper chat writes its events to its history store, checkpoints at quiet points
 * in the order keeper note (at the quiet moment) -> flush -> commit -> truncate, and a take-over starts at the store's checkpoint (attach from
 * ckpt.record + 1) instead of rebuilding the history from chunk notes. With the real keeper, the fake ACP agent and temp folders.
 *
 *   - take-over from the checkpoint: only the records after it are replayed; every event, same numbers; the journal was truncated
 *   - a crash after each checkpoint step (flush / note / commit) restores the right state and history
 *   - fencing: an old owner's store refuses its writes once the new owner claimed it
 *   - rollback round trip: an older build (AIB_HISTORY_V2=0: chunked snapshots) in between keeps the store's older history
 *   - migration: a chat whose journal has chunked history (built by the old path) gets a store on its first take-over
 *   - a store whose checkpoint is past the end of the journal (a reset WSL distro, faked) is dropped, the chat rebuilt from the journal
 *   - the store is deleted when the chat is closed (its channel removed)
 *   - /api/live/events pages and single events served from the store
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { HistoryStore } from '../../outputs/agent-studio/server/history/store.ts';

type Json = Record<string, unknown>;
Deno.env.set('AIB_HISTORY_V2', '1'); // the store path is off by default for now
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-history-2a-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly studios: Studio[] = [];
  constructor(readonly keeperArgs: string[] = []) {
    Deno.mkdirSync(this.work, { recursive: true });
  }
  get historyDir(): string {
    return this.state + SEP + 'history';
  }
  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s', ...this.keeperArgs] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => new Connection(fake('--cancel-aware'), cwd, provider, options ?? {});
    this.studios.push(studio);
    return studio;
  }
  /** The AIB stops without a word (its chats keep running in the keeper). */
  async crash(studio: Studio, keepStores = false): Promise<void> {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    // a crashed host's files are closed by the OS (Windows cannot delete a file a live handle holds)
    if (!keepStores) await studio.historyClient()?.shutdown().catch(() => {});
  }
  /** Open the chat's store read-only-ish (a separate handle; never claims). */
  peek(id: string): { last: number | null; first: number | null; ckpt: { sequence: number; record: number } | null } {
    const { store, info } = HistoryStore.open(this.historyDir, id);
    store.close();
    return { last: info.last, first: info.first, ckpt: info.ckpt };
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    const info = readKeeperInfo(this.state);
    if (info && pidAlive(info.pid)) {
      try {
        const client = await KeeperClient.connect(info);
        await client.shutdown(true).catch(() => {});
        client.close();
      } catch { /* gone */ }
      await until(() => !pidAlive(info.pid), 'keeper exit', 5).catch(() => Deno.kill(info.pid, 'SIGKILL'));
    }
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await pause(200);
      }
    }
  }
}

const shape = (events: Json[]) => events.map((e) => JSON.stringify([e.seq, e.kind, e.data]));
/** As shape, but a question's key left out: a turn replayed from the journal (above the checkpoint) asks with a new key. */
const replayShape = (events: Json[]) =>
  events.map((e) => JSON.stringify([e.seq, e.kind, e.kind === 'permission' ? { ...(e.data as Json), key: '' } : e.data]));

async function turn(studio: Studio, c: Connection, n: number, messageId: string): Promise<void> {
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: `stream:${n}:10`, clientMessageId: messageId }))[0], 200);
  await until(() => c.permissions.size === 1, `the question of ${messageId}`, 10);
  assertEquals((await studio.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' }))[0], 200);
  await until(() => !c.busy, `the end of ${messageId}`, 10);
}

async function adopted(lab: Lab, id: string): Promise<{ studio: Studio; r: Connection }> {
  const studio = lab.studio();
  assertEquals(await studio.adoptKeeper(), 1);
  const r = studio.connections.get(id)!;
  await until(() => r.historyState === 'claimed' || r.historyState === 'dead', 'the store claimed', 10);
  await r.historySettled();
  return { studio, r };
}

function withV2Off<T>(fn: () => Promise<T>): Promise<T> {
  Deno.env.set('AIB_HISTORY_V2', '0');
  return fn().finally(() => Deno.env.set('AIB_HISTORY_V2', '1'));
}

Deno.test({
  name: 'history 2A: a turn end checkpoints (flush, note, commit, truncate); a take-over attaches from ckpt.record + 1 and has every event',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await turn(a, c, 4, 'm1');
    await turn(a, c, 4, 'm2');
    await until(() => c.historyCkpt !== null && !c.busy, 'a checkpoint at the turn end', 10);
    assertEquals(c.historyState, 'claimed');
    assertEquals(c.snapshotChunkBytes, 0, 'no chunk notes: the history is in the store');
    const before = shape(c.events);
    const ckpt = c.historyCkpt!;
    await lab.crash(a);
    const { studio: b, r } = await adopted(lab, c.id);
    assertEquals(r.rebuildError, '');
    assertEquals(r.attachedFrom, ckpt.record + 1, 'attached from the checkpoint, not from 0');
    assert(r.replayedRecords <= 3, `only records after the checkpoint were replayed (${r.replayedRecords})`);
    assertEquals(shape(r.events), before, 'every event, same numbers, read from the store');
    // live/events served from the store: an older page and one event by seq
    const tail = await b.liveEvents(c.id, {}) as Json;
    assertEquals(tail.first, 1);
    const older = await b.liveEvents(c.id, { before: 5 }) as Json;
    assertEquals((older.events as Json[]).map((e) => e.seq).filter((s) => (s as number) >= 5), []);
    const fromStore = await r.storePage({ before: 5 });
    assert(fromStore && fromStore.events.length > 0, 'the store answers a page older than seq 5');
    assertEquals((await r.storeEvent(1))?.seq, 1);
    await turn(b, r, 2, 'm3');
    await until(() => r.historyCkpt!.record > ckpt.record, 'the next checkpoint', 10);
    // closing the chat removes its channel and deletes its store
    await r.close();
    await r.historySettled();
    await until(() => !Deno.statSync(lab.historyDir).isFile && ![...Deno.readDirSync(lab.historyDir)].some((e) => e.name.startsWith(c.id)), 'store deleted', 10);
  },
});

for (const step of ['flush', 'note', 'commit'] as const) {
  Deno.test({
    name: `history 2A: a crash right after the checkpoint's ${step} step restores the newest state with every event`,
    ...T,
    async fn() {
      await keeperBinary();
      await using lab = new Lab();
      const a = lab.studio();
      const c = await a.connect('omp', lab.work);
      await turn(a, c, 3, 'm1');
      await until(() => c.historyCkpt !== null && !c.busy, 'a first checkpoint', 10);
      const first = c.historyCkpt!;
      c.historyStopAfter = step;
      await turn(a, c, 3, 'm2');
      await until(() => c.historyState === 'dead', `the checkpoint stopped after ${step}`, 10);
      const before = c.events.slice();
      const sequence = c.sequence;
      await lab.crash(a);
      await pause(200);
      const seen = lab.peek(c.id);
      if (step === 'commit') assert(seen.ckpt!.record > first.record, 'the new checkpoint was committed');
      else assertEquals(seen.ckpt!.record, first.record, 'the old checkpoint stands');
      const { r } = await adopted(lab, c.id);
      assertEquals(r.rebuildError, '');
      assertEquals(r.sequence, sequence);
      assertEquals(replayShape(r.events), replayShape(before), 'every event, same numbers');
      assertEquals(r.historyState, 'claimed');
      // after a crash between note and commit, the take-over commits the checkpoint the note describes
      // After note + flush (stopped before the commit) the take-over commits the checkpoint the note describes. After the note alone
      // it does so only if the 200 ms writer had already stored every event; otherwise the old checkpoint stands and the replay
      // rebuilt the turn (either way the events above are right).
      if (step === 'flush') assertEquals(r.historyCkpt!.sequence, sequence);
      if (step === 'note') assert([first.sequence, sequence].includes(r.historyCkpt!.sequence), `ckpt ${r.historyCkpt!.sequence}`);
    },
  });
}

Deno.test({
  name: 'history 2A: a fenced writer: once a new owner claimed the store, the old one is refused and closes it',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await turn(a, c, 2, 'm1');
    await until(() => c.historyCkpt !== null && !c.busy, 'a checkpoint', 10);
    await lab.crash(a, true);
    const { r } = await adopted(lab, c.id);
    assertEquals(r.historyState, 'claimed');
    // the old host writes an event after the take-over: refused, its store closes, the new owner's store is untouched
    const last = lab.peek(c.id).last;
    c.event('studio_note', { message: 'late write from the old host' });
    await until(() => c.historyState === 'dead', 'the old writer stopped', 5);
    await c.historySettled();
    assertEquals(lab.peek(c.id).last, last);
  },
});

Deno.test({
  name: 'history 2A: rollback round trip: an older build (chunked snapshots) in between, then this build keeps the older history',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await turn(a, c, 3, 'm1');
    await until(() => c.historyCkpt !== null && !c.busy, 'a checkpoint', 10);
    const firstEvents = shape(c.events);
    await lab.crash(a);
    // the older build: no store, opens the chat without its older history, writes chunked snapshots
    const old = await withV2Off(async () => {
      const b = lab.studio();
      assertEquals(await b.adoptKeeper(), 1);
      const r = b.connections.get(c.id)!;
      await until(() => !r.replaying, 'the older build took over', 10);
      assertEquals(r.historyState, 'off');
      await turn(b, r, 3, 'm2');
      await until(() => r.snapshots >= 1, 'a chunked snapshot', 10);
      return { b, r };
    });
    const eventsId = old.r.eventsId;
    const all = shape(old.r.events);
    await lab.crash(old.b);
    const { r } = await adopted(lab, c.id);
    assertEquals(r.rebuildError, '');
    assertEquals(r.eventsId, eventsId, 'the same numbering');
    assertEquals(shape(r.events).slice(0, firstEvents.length), firstEvents, 'the history from before the rollback is kept');
    assertEquals(shape(r.events).slice(-all.length), all, 'and what the older build made follows it');
    assertEquals(lab.peek(r.id).last, r.sequence, 'the store has everything');
  },
});

Deno.test({
  name: 'history 2A: migration: a chat with a chunked journal (switch off) gets its store on the first take-over; the next checkpoint truncates',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const { a, c } = await withV2Off(async () => {
      const a = lab.studio();
      const c = await a.connect('omp', lab.work);
      await turn(a, c, 3, 'm1');
      await until(() => c.snapshots >= 1 && c.snapshotChunkBytes + c.snapshotBytes > 0, 'a chunked snapshot', 10);
      return { a, c };
    });
    assertEquals(c.historyState, 'off');
    const before = shape(c.events);
    await lab.crash(a);
    const { studio: b, r } = await adopted(lab, c.id);
    assertEquals(shape(r.events), before);
    assertEquals(lab.peek(c.id).last, r.sequence, 'the store was built from the rebuilt events');
    await turn(b, r, 2, 'm2');
    await until(() => r.historyCkpt !== null && !r.busy, 'a store checkpoint', 10);
    assertEquals(r.snapshotChunkBytes, 0);
  },
});

Deno.test({
  name: 'history 2A: a store whose checkpoint is past the end of the journal (a reset WSL distro) is dropped; the chat is rebuilt from its journal',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await turn(a, c, 2, 'm1');
    await until(() => c.historyCkpt !== null && !c.busy, 'a checkpoint', 10);
    const before = shape(c.events);
    const sequence = c.sequence;
    await lab.crash(a);
    await pause(200);
    // fake: the store says it covers far more of the record than the journal holds
    const { store } = HistoryStore.open(lab.historyDir, c.id);
    const ckpt = store.checkpoint().ckpt!;
    store.claim(store.epoch + 1000);
    store.setCheckpoint({ ...ckpt, record: ckpt.record + 100000, noteSeq: ckpt.noteSeq + 100000 });
    store.close();
    const { r } = await adopted(lab, c.id);
    assertEquals(r.attachedFrom, 0, 'not attached from the stale checkpoint');
    assertEquals(r.rebuildError, '', 'the chat goes on (its older history is gone with the store)');
    assertEquals(r.sequence, sequence, 'same numbering from the snapshot in the journal');
    assertEquals(before.length > 0, true);
    const seen = lab.peek(c.id);
    assert(!seen.ckpt || seen.ckpt.record < ckpt.record + 100000, 'the stale checkpoint is gone');
  },
});
