/**
 * A chat's history is permanent and a conversation is one chat (owner rules, 2026-11-17; the 0.12.1 blocker: an idle Quit AIB
 * deleted the lead chat's history store and the next start brought the conversation back under a new chat id):
 *
 *   - quitting AIB with an idle chat (Studio.close: what tray > Quit AIB runs when nothing works) keeps its store; the next start
 *     reopens the conversation as the SAME chat id, going on in the SAME store with every event, turn ends and AIB notes included;
 *     the agent's replay of the transcript is not shown again, a turn made outside AIB meanwhile is; a keeper take-over of the reopened
 *     chat numbers everything the same
 *   - after a crash that took the keeper (and the agent) with it, the reopen reuses the id too
 *   - several stores of one conversation (from before this fix): the newest is continued
 *   - deleting the chat still removes its store
 *
 * With the real keeper, the fake ACP agent (its --replay-file is the agent's transcript) and temp folders.
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
Deno.env.set('AIB_HISTORY_V2', '1');
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-kept-history-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly transcript = this.dir + SEP + 'transcript.json';
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    Deno.writeTextFileSync(this.transcript, '[]');
  }
  get historyDir(): string {
    return this.state + SEP + 'history';
  }
  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake('--replay-file', this.transcript), cwd, provider, options ?? {});
    this.studios.push(studio);
    return studio;
  }
  /** The agent's transcript as session/load replays it. */
  transcriptOf(turns: string[]): void {
    Deno.writeTextFileSync(this.transcript, JSON.stringify(turns.flatMap((t) => [{ role: 'user', text: `say:${t}` }, { role: 'agent', text: t }])));
  }
  storeFile(id: string): string {
    return this.historyDir + SEP + id + '.sqlite';
  }
  exists(path: string): boolean {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  }
  /** A separate read of the store (never claims). */
  peek(id: string): { last: number | null; turnEnds: number; notes: number; count: number } {
    const { store, info } = HistoryStore.open(this.historyDir, id);
    try {
      const all = store.after(0, { limit: 100_000, bytes: 64 * 1024 * 1024 }).events;
      return {
        last: info.last,
        turnEnds: all.filter((e) => e.kind === 'turn_end').length,
        notes: all.filter((e) => e.kind === 'studio_note').length,
        count: all.length,
      };
    } finally {
      store.close();
    }
  }
  async killKeeper(): Promise<void> {
    const info = readKeeperInfo(this.state);
    if (!info || !pidAlive(info.pid)) return;
    try {
      const client = await KeeperClient.connect(info);
      await client.shutdown(true).catch(() => {});
      client.close();
    } catch { /* gone */ }
    await until(() => !pidAlive(info.pid), 'keeper exit', 10).catch(() => Deno.kill(info.pid, 'SIGKILL'));
  }
  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    await this.killKeeper();
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

async function say(studio: Studio, c: Connection, text: string, id: string): Promise<void> {
  const ends = c.events.filter((e) => e.kind === 'turn_end').length;
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: `say:${text}`, clientMessageId: id }))[0], 200);
  await until(() => !c.busy && c.events.filter((e) => e.kind === 'turn_end').length > ends, `the end of ${id}`, 10);
}

const shape = (events: Json[]) => events.map((e) => JSON.stringify([e.seq, e.kind, e.data]));
const replayed = (events: Json[]) => events.filter((e) => e.replay === true);

/** What the reader sees: user messages, agent replies, turn ends and AIB notes, in order. */
function story(events: Json[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const data = e.data as Json;
    if (e.kind === 'user') out.push(`you: ${data.text}`);
    else if (e.kind === 'update') {
      const u = (data?.update ?? {}) as Json;
      if (u.sessionUpdate === 'user_message_chunk') out.push(`you: ${(u.content as Json).text}`);
      if (u.sessionUpdate === 'agent_message_chunk') out.push(`agent: ${(u.content as Json).text}`);
    } else if (e.kind === 'turn_end') out.push('turn finished');
    else if (e.kind === 'studio_note') out.push(`AIB: ${data.message}`);
  }
  return out;
}

Deno.test({
  name: 'kept history: an idle chat survives Quit AIB and a restart with the SAME chat id and store, every event and turn end kept',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('claude', lab.work);
    await say(a, c, 'one', 'm1');
    c.recordedEvent('studio_note', { message: 'Merged subagent “Docs” into main', sessionId: c.sessionId });
    await say(a, c, 'two', 'm2');
    const id = c.id;
    const session = c.sessionId!;
    assertEquals(c.events.filter((e) => e.kind === 'turn_end').length, 2);
    // Quit AIB with nothing working (tray > Quit AIB: main.ts close() -> Studio.close()): every chat closes...
    await a.close();
    const before = shape(c.events);
    const sequence = c.sequence;
    // ...and keeps its store, with everything in it
    assert(lab.exists(lab.storeFile(id)), 'the store is still there after the quit');
    const kept = lab.peek(id);
    assertEquals(kept.last, sequence, 'every event reached the store before it closed');
    assertEquals([kept.turnEnds, kept.notes], [2, 1], 'turn ends and the AIB note are in it');
    // Meanwhile the conversation went on in another app (the transcript has one more turn than AIB saw).
    lab.transcriptOf(['one', 'two', 'outside']);
    // The next start reopens it (the automatic reconnect: the same connect() Continue uses)
    const b = lab.studio();
    await b.reconnectOne(['claude', session, lab.work], 1, 0);
    const r = [...b.connections.values()].find((x) => x.sessionId === session && !x.closed)!;
    assert(r, 'reopened');
    assertEquals(r.id, id, 'the SAME chat id');
    assertEquals(r.continuedFrom, sequence, 'it goes on in its store');
    assertEquals(shape(r.events.slice(0, before.length)), before, 'every earlier event, same numbers, from the store');
    assertEquals(replayed(r.events), [], "the agent's replay of the transcript is not shown again");
    const after = story(r.events.slice(before.length));
    assertEquals(after.filter((s) => s.startsWith('you: ')), ['you: say:outside'], 'only the turn made outside AIB is new');
    assert(after.includes('AIB: 1 turn from outside AIB above.'), after.join(' | '));
    // it goes on: a new turn ends in the same store
    await say(b, r, 'three', 'm3');
    await until(() => r.historyWrittenSeq === r.sequence, 'the store caught up', 10);
    const now = lab.peek(id);
    assertEquals(now.last, r.sequence);
    assertEquals(now.turnEnds, 3, 'the earlier turn ends and the new one, in one store');
    assertEquals([...Deno.readDirSync(lab.historyDir)].filter((e) => e.name.endsWith('.sqlite')).length, 1, 'no second store');
    // A keeper take-over of the reopened chat (AIB crashes, or updates) numbers everything the same.
    const all = shape(r.events);
    b.keeper!.disconnect();
    for (const x of b.connections.values()) x.sessionLease?.release();
    b.reconnectStop.set();
    await b.historyClient()?.shutdown().catch(() => {});
    const t = lab.studio();
    assertEquals(await t.adoptKeeper(), 1);
    const back = t.connections.get(id)!;
    await until(() => back.historyState === 'claimed' || back.historyState === 'dead', 'the store claimed', 10);
    await back.historySettled();
    assertEquals(back.rebuildError, '');
    assertEquals(back.historyState, 'claimed');
    assertEquals(shape(back.events), all, 'same events, same numbers');
  },
});

Deno.test({
  name: 'kept history: the reopened chat taken over before its first checkpoint replays its setup the same (store checkpoint at record 0)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('claude', lab.work);
    await say(a, c, 'one', 'm1');
    const session = c.sessionId!;
    await a.close();
    lab.transcriptOf(['one', 'elsewhere']);
    const b = lab.studio();
    const r = await b.connect('claude', lab.work, session);
    assertEquals(r.id, c.id);
    await until(() => r.historyState === 'claimed', 'the store claimed', 10);
    await r.historySettled();
    assertEquals(r.historyCkpt?.record, 0, 'the checkpoint a take-over starts from: before the new channel');
    const all = shape(r.events);
    // a crash right away (no turn, so no new checkpoint): the take-over replays the whole new channel from the store's state
    b.keeper!.disconnect();
    for (const x of b.connections.values()) x.sessionLease?.release();
    b.reconnectStop.set();
    await b.historyClient()?.shutdown().catch(() => {});
    const t = lab.studio();
    assertEquals(await t.adoptKeeper(), 1);
    const back = t.connections.get(c.id)!;
    await until(() => back.historyState === 'claimed' || back.historyState === 'dead', 'the store claimed', 10);
    await back.historySettled();
    assertEquals(back.rebuildError, '');
    assertEquals(back.attachedFrom, 1, 'attached from the new channel\'s first record');
    assertEquals(shape(back.events), all, 'same events, same numbers: the replay was dropped, the outside turn kept');
    assertEquals(replayed(back.events), []);
  },
});

Deno.test({
  name: 'kept history: after a crash that took the keeper and the agent with it, reopening reuses the chat id and its store',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('claude', lab.work);
    await say(a, c, 'one', 'm1');
    await say(a, c, 'two', 'm2');
    await until(() => c.historyCkpt !== null && c.historyWrittenSeq === c.sequence, 'the store caught up', 10);
    const before = shape(c.events);
    const session = c.sessionId!;
    // AIB crashes, then the keeper goes too (a bluescreen, a reboot): the agent is gone, the store and the journal stay on disk
    a.keeper!.disconnect();
    for (const x of a.connections.values()) x.sessionLease?.release();
    a.reconnectStop.set();
    await a.historyClient()?.shutdown().catch(() => {});
    await lab.killKeeper();
    lab.transcriptOf(['one', 'two']);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 0, 'nothing runs in the keeper any more');
    const r = await b.connect('claude', lab.work, session);
    assertEquals(r.id, c.id, 'the same chat id');
    assertEquals(shape(r.events.slice(0, before.length)), before, 'its history, from its store');
    assertEquals(replayed(r.events), []);
    await say(b, r, 'three', 'm3');
    await until(() => r.historyWrittenSeq === r.sequence, 'the store caught up', 10);
    assertEquals(lab.peek(c.id).turnEnds, 3);
  },
});

Deno.test({
  name: 'kept history: several stores of one conversation (from before the fix): the newest one is continued; deleting the chat removes them',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('claude', lab.work);
    await say(a, c, 'one', 'm1');
    const session = c.sessionId!;
    await a.close();
    // an older build brought the conversation back under a new chat id (a second store of the same conversation)
    const older = lab.storeFile(c.id);
    const newerId = 'f'.repeat(32);
    Deno.copyFileSync(older, lab.storeFile(newerId));
    {
      const { store } = HistoryStore.open(lab.historyDir, newerId);
      store.claim(1);
      const last = store.checkpoint().writtenSeq;
      store.append([{ seq: last + 1, kind: 'studio_note', time: Date.now() / 1000 + 60, data: { message: 'the newer store' } }]);
      store.close();
    }
    lab.transcriptOf(['one']);
    const b = lab.studio();
    const r = await b.connect('claude', lab.work, session);
    assertEquals(r.id, newerId, 'the newest store goes on');
    assert(story(r.events).includes('AIB: the newer store'));
    await r.close();
    await r.historySettled();
    assert(lab.exists(lab.storeFile(newerId)) && lab.exists(older), 'closing a chat keeps its stores');
    // the person deletes the chat (web/shared.ts conversationAction -> history-forget): every store of it goes
    const [status, answer] = await b.liveCall('history-forget', { provider: 'claude', sessionId: session });
    assertEquals(status, 200);
    assertEquals(((answer as Json).removed as string[]).sort(), [c.id, newerId].sort());
    assert(!lab.exists(lab.storeFile(newerId)) && !lab.exists(older), 'the deleted chat\'s stores are removed');
  },
});
