/**
 * The per-chat history store (server/history/store.ts, design v2 phase 1A): every API call, the checkpoint order rules at each
 * crash point, epoch fencing, the retention caps, the FTS message rows, quick_check damage and disk full. Plus one round trip
 * through the Worker (client.ts + store_worker.ts).
 */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import {
  CheckpointError,
  FencedError,
  HistoryStore,
  rowStarts,
  type StoreEvent,
  storePath,
} from '../../outputs/agent-studio/server/history/store.ts';
import { HistoryClient, HistoryError } from '../../outputs/agent-studio/server/history/client.ts';
import { existsSync } from 'node:fs';

const MAIN = 'main-session';

function tempDir(): string {
  return Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-history-store-' })).replace(/^\\\\\?\\/, '');
}
function cleanup(dir: string): void {
  try {
    Deno.removeSync(dir, { recursive: true });
  } catch { /* a Windows file lock lingers: the temp folder goes later */ }
}

let seq = 0;
const T0 = 1_800_000_000;
function chunk(text: string, kind = 'agent_message_chunk', sessionId = MAIN, time = T0): StoreEvent {
  return { seq: ++seq, kind: 'update', time, data: { sessionId, update: { sessionUpdate: kind, content: { type: 'text', text } } } };
}
function tool(sessionId = MAIN, time = T0, output = 'tool output text'): StoreEvent {
  return { seq: ++seq, kind: 'update', time, data: { sessionId, update: { sessionUpdate: 'tool_call', title: output } } };
}
function user(text: string): StoreEvent {
  return { seq: ++seq, kind: 'user', time: T0, data: { text, sessionId: MAIN } };
}

function withStore(fn: (dir: string, store: HistoryStore) => void, options: Parameters<typeof HistoryStore.open>[2] = {}): void {
  const dir = tempDir();
  seq = 0;
  const { store } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1', mainSession: MAIN, ...options });
  try {
    store.claim(1);
    fn(dir, store);
  } finally {
    store.close();
    cleanup(dir);
  }
}

Deno.test('open: creates the file in WAL mode, reports meta; a bad chat id is refused', () => {
  const dir = tempDir();
  try {
    const { store, info } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1' });
    assertEquals([info.created, info.damaged, info.eventsId, info.eventsIdChanged, info.writtenSeq, info.ckpt], [
      true,
      false,
      'E1',
      false,
      0,
      null,
    ]);
    assert(existsSync(storePath(dir, 'chat-1')));
    store.close();
    const again = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1' });
    assertEquals(again.info.created, false);
    again.store.close();
    assertThrows(() => storePath(dir, '../escape'));
    assertThrows(() => storePath(dir, '..'));
  } finally {
    cleanup(dir);
  }
});

Deno.test('append moves written_seq, skips what is stored, splits helper events by session', () => {
  withStore((_dir, store) => {
    const events = [user('hello'), chunk('Hi '), chunk('there'), tool(), chunk('helper says', 'agent_message_chunk', 'child-1')];
    const r = store.append(events);
    assertEquals([r.written, r.skipped, r.writtenSeq], [5, 0, 5]);
    assertEquals(store.append(events.slice(2)).skipped, 3); // a rebuild that continues the store: nothing twice
    assertEquals(store.checkpoint(), { writtenSeq: 5, ckpt: null });
    const info = store.info();
    assertEquals([info.first, info.last, info.helperEvents], [1, 5, 1]);
    assertEquals(store.helpers(), [{ session: 'child-1', count: 1, last: 5 }]);
    assertEquals(JSON.parse(store.event(2)!.data).data.update.content.text, 'Hi ');
    assertEquals(store.event(99), null);
  });
});

Deno.test("row_start is view-free: a run of the chat's own chunks; thoughts join; helpers and user chunks do not", () => {
  seq = 0;
  const events = [
    user('q'), // 1
    chunk('a'), // 2 run 2
    chunk('t', 'agent_thought_chunk'), // 3 run 2 (thinking does not end a reply's run)
    chunk('h', 'agent_message_chunk', 'child'), // 4 helper: own row, run goes on
    chunk('b'), // 5 run 2
    tool(), // 6 own
    chunk('c'), // 7 run 7
    chunk('u', 'user_message_chunk'), // 8 the user's own chunk: a new run
    chunk('v', 'user_message_chunk'), // 9 run 8
  ];
  const { starts, run } = rowStarts(events, MAIN);
  assertEquals(starts, [1, 2, 2, 4, 2, 6, 7, 8, 8]);
  assertEquals(run, { rowStart: 8, chunk: 'user' });
  // The same in two batches through the store (the open run carries over, also across a reopen).
  const dir = tempDir();
  try {
    let { store } = HistoryStore.open(dir, 'c', { mainSession: MAIN });
    store.claim(1);
    store.append(events.slice(0, 3));
    store.close();
    ({ store } = HistoryStore.open(dir, 'c', { mainSession: MAIN }));
    store.claim(1);
    store.append(events.slice(3));
    assertEquals(store.after(0, { limit: 100 }).events.map((e) => e.rowStart), [1, 2, 2, 2, 6, 7, 8, 8]);
    store.close();
  } finally {
    cleanup(dir);
  }
});

Deno.test('reads: tail, before, after, helper, by limit and bytes; a page never starts inside a run', () => {
  withStore((_dir, store) => {
    const events: StoreEvent[] = [];
    for (let i = 0; i < 10; i++) events.push(user(`q${i}`), chunk(`a${i}-1 `), chunk(`a${i}-2`), tool('child', T0)); // 4 per turn
    store.append(events);
    // the chat's own events are 3 per turn (q, a-1, a-2); the newest 4 would start at turn 8's a-2 (seq 35), inside a run
    const tail = store.tail({ limit: 4 });
    assertEquals(tail.events.map((e) => e.seq), [37, 38, 39], 'the partial run at the old end is dropped');
    assert(tail.more);
    const before = store.before(37, { limit: 3 });
    assertEquals(before.events.map((e) => e.seq), [33, 34, 35]);
    const after = store.after(33, { limit: 4 });
    assertEquals(after.events.map((e) => e.seq), [34, 35, 37, 38]);
    assert(after.more);
    const end = store.after(38);
    assertEquals([end.events.map((e) => e.seq), end.more], [[39], false]);
    const first = store.before(5);
    assertEquals([first.events.map((e) => e.seq), first.more], [[1, 2, 3], false]);
    const helper = store.helper('child', { limit: 2 });
    assertEquals(helper.events.map((e) => e.seq), [36, 40]);
    assertEquals(store.helper('child', { before: 36, limit: 1 }).events.map((e) => e.seq), [32]);
    const oneByBytes = store.tail({ bytes: 1 }); // the first event always fits; then the run rule keeps whole runs
    assertEquals(oneByBytes.events.map((e) => e.seq), [38, 39], 'a page that is all one run takes the run whole');
    assertEquals([store.tail({ session: 'nobody' }).from, store.tail({ session: 'nobody' }).more], [null, false]);
  });
});

Deno.test('FTS: one row per message, upserted as chunks arrive; your prompts too; tool output and helpers never', () => {
  withStore((_dir, store) => {
    store.append([user('where is the lighthouse'), chunk('The light'), chunk('house is')]);
    store.append([chunk(' on the hill'), tool(MAIN, T0, 'secretword in a tool'), chunk('helperword', 'agent_message_chunk', 'child')]);
    const hits = store.search('lighthouse'); // the reply's "The light" + "house is": one word across two chunks
    assertEquals(hits.map((h) => [h.rowStart, h.role]), [[2, 'agent'], [1, 'user']]);
    assertEquals(store.search('hill').map((h) => h.rowStart), [2], 'the chunks of one reply are one row, keyed by its row_start');
    assert(store.search('hill')[0].snippet.includes('[hill]'));
    assertEquals(store.search('secretword'), []);
    assertEquals(store.search('helperword'), []);
    assertEquals(store.search('"unbalanced'), [], 'a stray quote is not FTS syntax');
    assertEquals(store.search('   '), []);
  });
});

Deno.test('checkpoint: two watermarks; a ckpt needs its events flushed first and never goes back; truncate = record + 1', () => {
  withStore((_dir, store) => {
    assertEquals(store.truncateBefore(), 0);
    store.append([user('a'), chunk('b')]);
    assertThrows(() => store.setCheckpoint({ state: {}, sequence: 3, record: 10, noteSeq: 11 }), CheckpointError);
    assert(store.setCheckpoint({ state: { s: 1 }, sequence: 2, record: 10, noteSeq: 11 }));
    store.append([chunk('c')]);
    assertEquals(store.checkpoint(), { writtenSeq: 3, ckpt: { state: { s: 1 }, sequence: 2, record: 10, noteSeq: 11 } });
    assertEquals(store.truncateBefore(), 11);
    assertThrows(() => store.setCheckpoint({ state: {}, sequence: 3, record: 9, noteSeq: 12 }), CheckpointError);
    assertThrows(() => store.setCheckpoint({ state: {}, sequence: 1.5, record: 12, noteSeq: 12 }), CheckpointError);
  });
});

/** The quiet point's four steps (design 3.2), stopped after `crashAfter`; then a take-over on a new store handle. */
function quietPoint(dir: string, crashAfter: 'flush' | 'note' | 'commit' | 'truncate') {
  seq = 0;
  let { store } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1', mainSession: MAIN });
  store.claim(1);
  store.append([user('one'), chunk('reply one')]); // seq 1-2
  store.setCheckpoint({ state: { turn: 1 }, sequence: 2, record: 20, noteSeq: 21 }); // an earlier quiet point
  store.append([user('two'), chunk('reply '), chunk('two')]); // seq 3-5: provisional
  // 1. flush (already: append moved written_seq to 5)
  let note: { upTo: number; state: { sequence: number }; seq: number } | null = null;
  let truncated = 0;
  if (crashAfter !== 'flush') note = { upTo: 40, state: { sequence: 5 }, seq: 41 }; // 2. the keeper note
  if (crashAfter === 'commit' || crashAfter === 'truncate') {
    store.setCheckpoint({ state: { turn: 2 }, sequence: 5, record: 40, noteSeq: 41 });
  }
  if (crashAfter === 'truncate') truncated = store.truncateBefore();
  store.close(); // the crash
  // Take-over: a new host opens, claims a newer epoch, and reads the ckpt.
  ({ store } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1', mainSession: MAIN }));
  store.claim(2);
  const { ckpt } = store.checkpoint();
  // The replay's rule: a note with upTo > ckpt.record is the newest state; its events up to note.state.sequence are in the store.
  const newer = note && note.upTo > ckpt!.record ? note : null;
  const dropped = store.dropProvisional(newer ? newer.state.sequence : undefined);
  if (newer) store.setCheckpoint({ state: { turn: 2 }, sequence: newer.state.sequence, record: newer.upTo, noteSeq: newer.seq });
  return { store, ckpt, dropped, truncated, newer };
}

Deno.test('crash after flush, before the note: the old ckpt stands, provisional events go, replay from record + 1', () => {
  const dir = tempDir();
  try {
    const { store, ckpt, dropped } = quietPoint(dir, 'flush');
    assertEquals([ckpt!.sequence, ckpt!.record, dropped], [2, 20, 3]);
    assertEquals(store.checkpoint().writtenSeq, 2);
    assertEquals(store.truncateBefore(), 21);
    assertEquals(store.search('two'), [], 'the dropped reply left the index');
    // The replay makes them again with the same numbers.
    seq = 2;
    store.append([user('two'), chunk('reply '), chunk('two')]);
    assertEquals(store.after(0, { limit: 10 }).events.map((e) => [e.seq, e.rowStart]), [[1, 1], [2, 2], [3, 3], [4, 4], [5, 4]]);
    assertEquals(store.search('two').map((h) => h.rowStart), [4, 3]);
    store.close();
  } finally {
    cleanup(dir);
  }
});

Deno.test('crash after the note, before the commit: the newer note wins, its events are kept, its ckpt is committed', () => {
  const dir = tempDir();
  try {
    const { store, ckpt, dropped, newer } = quietPoint(dir, 'note');
    assert(newer);
    assertEquals([ckpt!.record, dropped], [20, 0]);
    assertEquals(store.checkpoint(), { writtenSeq: 5, ckpt: { state: { turn: 2 }, sequence: 5, record: 40, noteSeq: 41 } });
    assertEquals(store.truncateBefore(), 41);
    assertEquals(store.search('two').length, 2);
    store.close();
  } finally {
    cleanup(dir);
  }
});

Deno.test('crash after the commit, before truncate: the new ckpt stands; truncate again from it', () => {
  const dir = tempDir();
  try {
    const { store, ckpt, dropped, newer } = quietPoint(dir, 'commit');
    assertEquals([ckpt!.sequence, ckpt!.record, dropped, newer], [5, 40, 0, null]);
    assertEquals(store.truncateBefore(), 41);
    store.close();
  } finally {
    cleanup(dir);
  }
});

Deno.test('crash after truncate (the normal case): nothing to drop', () => {
  const dir = tempDir();
  try {
    const { store, ckpt, dropped, truncated } = quietPoint(dir, 'truncate');
    assertEquals([ckpt!.sequence, dropped, truncated, store.truncateBefore()], [5, 0, 41, 41]);
    store.close();
  } finally {
    cleanup(dir);
  }
});

Deno.test('dropProvisional mid-reply: the message row is built again from the chunks that are left', () => {
  withStore((_dir, store) => {
    store.append([user('q'), chunk('alpha '), chunk('beta ')]);
    store.setCheckpoint({ state: {}, sequence: 3, record: 1, noteSeq: 2 });
    store.append([chunk('gamma')]);
    assertEquals(store.search('gamma').length, 1);
    assertEquals(store.dropProvisional(), 1);
    assertEquals(store.search('gamma'), []);
    assertEquals(store.search('beta').map((h) => h.rowStart), [2]);
    store.append([chunk('delta')]); // seq 5 continues the run of 2 after a reopen of the run
    assertEquals(store.event(5)!.rowStart, 2);
  });
});

Deno.test('fencing: two writers, the second owner wins; the first is refused and closes', () => {
  const dir = tempDir();
  try {
    seq = 0;
    const a = HistoryStore.open(dir, 'chat-1', { mainSession: MAIN }).store;
    a.claim(3);
    a.append([user('from a')]);
    const b = HistoryStore.open(dir, 'chat-1', { mainSession: MAIN }).store;
    b.claim(4);
    assert(!a.checkEpoch());
    assertThrows(() => a.append([user('late a')]), FencedError);
    assert(a.closed, 'a fenced store closes itself');
    assertEquals(b.append([user('from b')]).written, 1);
    assertEquals(b.after(0).events.map((e) => JSON.parse(e.data).data.text), ['from a', 'from b']);
    // An old owner coming back with its lower epoch is refused too.
    const old = HistoryStore.open(dir, 'chat-1', { mainSession: MAIN }).store;
    assertThrows(() => old.claim(3), FencedError);
    assertThrows(() => old.setCheckpoint({ state: {}, sequence: 1, record: 1, noteSeq: 1 }), FencedError);
    assert(old.closed);
    b.close();
  } finally {
    cleanup(dir);
  }
});

Deno.test("retention: the chat's own events up to the byte cap; helper events by count and by age, separately", () => {
  let now = T0;
  withStore((_dir, store) => {
    for (let i = 0; i < 20; i++) store.append([user('x'.repeat(100))]); // ~150 bytes each
    const info = store.info();
    assert(info.mainBytes <= 1000, `kept ${info.mainBytes} bytes`);
    assert(info.first! > 1 && info.last === 20);
    assertEquals(store.search('x'.repeat(100)).length, 20 - info.first! + 1, 'removed messages left the index');
    // Helpers: the newest 5 by count.
    for (let i = 0; i < 8; i++) store.append([tool('child', T0 - 40 * 86400 + i)]); // old ones
    assertEquals(store.info().helperEvents, 5);
    assertEquals(store.helper('child', { limit: 100 }).events.map((e) => e.seq), [24, 25, 26, 27, 28]);
    store.append([tool('child', now)]);
    // Age: at the next quiet point everything older than 30 days goes (here: all but the new one).
    store.setCheckpoint({ state: {}, sequence: 29, record: 1, noteSeq: 1 });
    assertEquals(store.helper('child', { limit: 100 }).events.map((e) => e.seq), [29]);
    assert(store.info().mainBytes > 0, "the chat's own events are not touched by the helper caps");
    now += 1;
  }, { maxChatBytes: 1000, maxHelperEvents: 5, now: () => now });
});

Deno.test('eventsId: a different one is reported (the caller resets); the same one continues', () => {
  const dir = tempDir();
  try {
    seq = 0;
    let { store } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1' });
    store.claim(1);
    store.append([user('kept')]);
    store.close();
    let info;
    ({ store, info } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1' }));
    assertEquals(info.eventsIdChanged, false);
    store.close();
    ({ store, info } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E2' }));
    assertEquals([info.eventsIdChanged, info.eventsId, info.last], [true, 'E1', 1]);
    store.claim(2);
    store.reset('E2');
    assertEquals([store.info().last, store.checkpoint().writtenSeq, store.search('kept')], [null, 0, []]);
    store.close();
    ({ info } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E2' }));
    assertEquals([info.eventsId, info.eventsIdChanged, info.epoch], ['E2', false, 2]);
  } finally {
    cleanup(dir);
  }
});

Deno.test('quick_check: a damaged or foreign file is renamed .broken and a new store starts', () => {
  const dir = tempDir();
  try {
    const path = storePath(dir, 'chat-1');
    Deno.writeTextFileSync(path, 'this is not a database, just text that is long enough '.repeat(200));
    const { store, info } = HistoryStore.open(dir, 'chat-1', { eventsId: 'E1' });
    assertEquals([info.damaged, info.created, info.last], [true, true, null]);
    assert(existsSync(path + '.broken'));
    store.claim(1);
    seq = 0;
    assertEquals(store.append([user('after damage')]).written, 1);
    store.close();
    // A real database with a page overwritten in the middle.
    const dir2 = tempDir();
    try {
      const s2 = HistoryStore.open(dir2, 'chat-2', {}).store;
      s2.claim(1);
      for (let i = 0; i < 50; i++) s2.append([user('y'.repeat(2000))]);
      s2.setCheckpoint({ state: {}, sequence: 50, record: 1, noteSeq: 1 });
      s2.close();
      const p2 = storePath(dir2, 'chat-2'); // closing the last connection folded the WAL into the file
      assert(!existsSync(p2 + '-wal'));
      const bytes = Deno.readFileSync(p2);
      bytes.fill(0xa5, 4096 * 2, 4096 * 8); // b-tree pages 3-8 turned to garbage
      Deno.writeFileSync(p2, bytes);
      const opened = HistoryStore.open(dir2, 'chat-2', {});
      assertEquals([opened.info.damaged, opened.info.last], [true, null]);
      assert(existsSync(p2 + '.broken'));
      opened.store.close();
    } finally {
      cleanup(dir2);
    }
  } finally {
    cleanup(dir);
  }
});

Deno.test('SQLITE_FULL: the write is rolled back, the store stops writing, reads go on, nothing throws', () => {
  withStore((_dir, store) => {
    let full: ReturnType<HistoryStore['append']> | null = null;
    let i = 0;
    for (; i < 500 && !full; i++) {
      const r = store.append([user(`n${i} ` + 'z'.repeat(3000))]);
      if (r.stopped) full = r;
    }
    assert(full, 'the page cap made the disk full');
    assertEquals(full!.written, 0);
    assertEquals(store.stopped, 'full');
    const last = store.info().last!;
    assertEquals(last, i - 1, 'the failed batch is not half written');
    assertEquals(store.checkpoint().writtenSeq, last);
    assertEquals(store.append([user('more')]).stopped, 'full');
    assertEquals(store.setCheckpoint({ state: {}, sequence: 1, record: 1, noteSeq: 1 }), false);
    assertEquals(store.tail({ limit: 1 }).to, last);
    assert(store.search(`n${last - 1}`).length === 1);
  }, { maxPageCount: 40 });
});

Deno.test('delete: closes and removes the file and its WAL', () => {
  const dir = tempDir();
  try {
    const { store } = HistoryStore.open(dir, 'chat-1', {});
    store.claim(1);
    seq = 0;
    store.append([user('bye')]);
    store.destroy();
    for (const s of ['', '-wal', '-shm']) assert(!existsSync(storePath(dir, 'chat-1') + s), s);
  } finally {
    cleanup(dir);
  }
});

Deno.test('the Worker: every op through client.ts; fenced keeps its code', async () => {
  const dir = tempDir();
  const client = new HistoryClient(dir, { maxHelperEvents: 100 });
  const other = new HistoryClient(dir);
  try {
    const info = await client.open('chat-w', { eventsId: 'E', mainSession: MAIN });
    assertEquals(info.created, true);
    await client.claim('chat-w', 1);
    assertEquals(await client.checkEpoch('chat-w'), true);
    await client.setMainSession('chat-w', MAIN);
    seq = 0;
    const r = await client.append('chat-w', [user('worker hello'), chunk('reply'), chunk('x', 'agent_message_chunk', 'kid')]);
    assertEquals(r.writtenSeq, 3);
    assertEquals((await client.tail('chat-w')).events.map((e) => e.seq), [1, 2]);
    assertEquals((await client.before('chat-w', 2)).events.map((e) => e.seq), [1]);
    assertEquals((await client.after('chat-w', 1)).events.map((e) => e.seq), [2]);
    assertEquals((await client.helper('chat-w', 'kid')).events.map((e) => e.seq), [3]);
    assertEquals((await client.helpers('chat-w')).length, 1);
    assertEquals((await client.event('chat-w', 1))!.kind, 'user');
    assertEquals(await client.setCheckpoint('chat-w', { state: { a: 1 }, sequence: 3, record: 7, noteSeq: 8 }), true);
    assertEquals((await client.getCheckpoint('chat-w')).ckpt!.record, 7);
    assertEquals(await client.truncateBefore('chat-w'), 8);
    assertEquals(await client.dropProvisional('chat-w'), 0);
    assertEquals((await client.search('chat-w', 'hello')).map((h) => h.rowStart), [1]);
    assertEquals((await client.info('chat-w')).last, 3);
    // a second host's Worker takes the store
    await other.open('chat-w', {});
    await other.claim('chat-w', 2);
    let error: unknown = null;
    try {
      await client.append('chat-w', [user('late')]);
    } catch (e) {
      error = e;
    }
    assert(error instanceof HistoryError && error.code === 'fenced', String(error));
    let closed: unknown = null;
    try {
      await client.tail('chat-w');
    } catch (e) {
      closed = e;
    }
    assert(closed instanceof HistoryError && closed.code === 'closed', String(closed));
    await other.reset('chat-w', 'E2');
    await other.close('chat-w');
    await other.delete('chat-w');
    assert(!existsSync(storePath(dir, 'chat-w')));
  } finally {
    await client.shutdown();
    await other.shutdown();
    cleanup(dir);
  }
});
