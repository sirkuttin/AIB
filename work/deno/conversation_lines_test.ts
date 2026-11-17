/**
 * AIB's own lines are history (owner rule, 2026-11-17): the "turn finished" dividers and AIB's notes survive a rebuild under a new
 * chat id. They are kept by conversation (provider + session, history/lines.ts) and put back after their turns when a chat loads
 * the session from the agent's transcript (session/load), then survive a keeper take-over of that chat.
 *
 * With the real keeper, the fake ACP agent (its --replay-file is the transcript) and temp folders.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { anchorOf, LineMerger } from '../../outputs/agent-studio/server/history/lines.ts';

type Json = Record<string, unknown>;
Deno.env.set('AIB_HISTORY_V2', '1');
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-lines-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly transcript = this.dir + SEP + 'transcript.json';
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    Deno.writeTextFileSync(this.transcript, '[]');
  }
  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake('--replay-file', this.transcript), cwd, provider, options ?? {});
    this.studios.push(studio);
    return studio;
  }
  async leave(studio: Studio): Promise<void> {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    await studio.historyClient()?.shutdown().catch(() => {});
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

async function say(studio: Studio, c: Connection, text: string, id: string): Promise<void> {
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: `say:${text}`, clientMessageId: id }))[0], 200);
  await until(() => !c.busy && c.events.some((e) => e.kind === 'turn_end' && (e.time as number) >= 0) &&
    c.events.filter((e) => e.kind === 'turn_end').length >= Number(id.slice(1)), `the end of ${id}`, 10);
}

/** The history as the reader sees it: user messages, turn ends and AIB notes, in order. */
function story(events: Json[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    const data = e.data as Json;
    if (e.kind === 'user') out.push(`you: ${data.text}`);
    else if (e.kind === 'update') {
      const u = (data?.update ?? {}) as Json;
      if (u.sessionUpdate === 'user_message_chunk') out.push(`you: ${(u.content as Json).text}`);
    } else if (e.kind === 'turn_end') out.push('turn finished');
    else if (e.kind === 'studio_note') out.push(`AIB: ${data.message}`);
  }
  return out;
}

const timesOf = (events: Json[]) => events.filter((e) => e.kind === 'turn_end' || e.kind === 'studio_note').map((e) => e.time);

Deno.test('conversation lines: the merger puts each turn\'s lines after it, skips turns the transcript lost, and splits repeats', () => {
  const line = (kind: string, after: string, n: number) => ({ kind, data: { n }, time: n, after: anchorOf(after) });
  const m = new LineMerger([
    line('turn_end', 'gone (before a compaction)', 1),
    line('turn_end', 'continue', 2),
    line('studio_note', 'continue', 3),
    line('turn_end', 'continue', 4),
    line('turn_end', 'last  one\n', 5),
  ]);
  assertEquals(m.take('continue').map((l) => (l.data as Json).n), [2, 3]);
  assertEquals(m.take('continue').map((l) => (l.data as Json).n), [4]);
  assertEquals(m.take('nothing kept'), []);
  assertEquals(m.take(anchorOf('last one')).map((l) => (l.data as Json).n), [5]);
});

Deno.test({
  name: 'conversation lines: a chat rebuilt from the agent\'s transcript under a new chat id has its turn ends and AIB notes, in order',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await say(a, c, 'one', 'm1');
    c.recordedEvent('studio_note', { message: 'Merged subagent “Docs” into main', kind: 'swarm-merge', sessionId: c.sessionId });
    await say(a, c, 'two', 'm2');
    await say(a, c, 'three', 'm3');
    const before = story(c.events);
    assertEquals(before, [
      'you: say:one',
      'turn finished',
      'AIB: Merged subagent “Docs” into main',
      'you: say:two',
      'turn finished',
      'you: say:three',
      'turn finished',
    ]);
    const times = timesOf(c.events);
    const session = c.sessionId!;
    const ledger = a.conversationLines!.read('omp', session);
    assertEquals(ledger.length, 4, 'three turn ends and the note are kept by conversation');
    // The chat goes (its store with it); the agent's transcript is all that is left of the conversation.
    await c.close();
    Deno.writeTextFileSync(
      lab.transcript,
      JSON.stringify(['one', 'two', 'three'].flatMap((t) => [{ role: 'user', text: `say:${t}` }, { role: 'agent', text: t }])),
    );
    const r = await a.connect('omp', lab.work, session);
    assert(r.id !== c.id, 'a new chat id');
    assertEquals(story(r.events), before, 'every turn end and note back in place');
    assertEquals(timesOf(r.events), times, 'with their own times');
    assert(r.events.filter((e) => e.kind === 'turn_end').every((e) => (e.data as Json).restored === true));
    assertEquals(a.conversationLines!.read('omp', session).length, 4, 'lines put back are not kept twice');
    // A keeper take-over of the new chat rebuilds them from its record, same numbers.
    // (right away: before its first checkpoint the take-over rebuilds everything from the record)
    const shape = (events: Json[]) => events.map((e) => JSON.stringify([e.seq, e.kind, e.time]));
    const kept = shape(r.events);
    await lab.leave(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const back = b.connections.get(r.id)!;
    await until(() => back.historyState === 'claimed' || back.historyState === 'dead', 'the store claimed', 10);
    assertEquals(story(back.events), before);
    assertEquals(shape(back.events), kept, 'same events, same numbers, same times');
    // A new turn's end is kept again, after the turn it ends.
    await say(b, back, 'four', 'm4');
    const last = b.conversationLines!.read('omp', session).at(-1)!;
    assertEquals([last.kind, last.after], ['turn_end', 'say:four']);
  },
});
