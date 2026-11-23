/**
 * The 2026-11-17 lead-chat loss: an update's take-over stopped a working chat as "no chat record".
 *
 * The journal is truncated after each checkpoint at a segment boundary, so the kept segment can start with AIB notes written before
 * the snapshot note (here, as on the owner's machine, a Send-now `steer` note). The take-over's record reader stopped at the first
 * note it did not know and the chat's agent was killed.
 *
 *   - regression: a journal that starts with a steer note before the snapshot is taken over (the chat keeps running, same id)
 *   - a chat channel whose record cannot be found at all is never stopped: its record is made again from the keeper (session from
 *     the agent lines, provider and folder from the recovery list) and the chat is taken over; the next snapshot carries the record
 *
 * With the real keeper, the fake ACP agent and temp folders.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { parseNote } from '../../outputs/agent-studio/server/keeper/link.ts';

type Json = Record<string, unknown>;
Deno.env.set('AIB_HISTORY_V2', '1');
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-lost-record-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }
  studio(): Studio {
    const keeper = new KeeperLink({
      dataDir: this.state,
      orphan: null,
      extraArgs: ['--exit-after', '2s', '--orphan-after', '30s', '--segment-bytes', '65536'],
    });
    const studio = new Studio({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => new Connection(fake('--cancel-aware'), cwd, provider, options ?? {});
    this.studios.push(studio);
    return studio;
  }
  /** The AIB goes away the way an update leaves it: its chats keep running in the keeper. */
  async leave(studio: Studio): Promise<void> {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    await studio.historyClient()?.shutdown().catch(() => {});
  }
  async client(): Promise<KeeperClient> {
    return await KeeperClient.connect(readKeeperInfo(this.state)!);
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

async function turn(studio: Studio, c: Connection, n: number, messageId: string): Promise<void> {
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: `stream:${n}:10`, clientMessageId: messageId }))[0], 200);
  await until(() => c.permissions.size === 1, `the question of ${messageId}`, 10);
  assertEquals((await studio.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' }))[0], 200);
  await until(() => !c.busy, `the end of ${messageId}`, 10);
}

/** The `t` of every note the channel's journal still holds, oldest first. */
async function notesOf(client: KeeperClient, channel: string): Promise<string[]> {
  const out: string[] = [];
  let live: () => void = () => {};
  const done = new Promise<void>((resolve) => (live = resolve));
  await client.attach(channel, 0, {
    record(record) {
      if (record.kind === 'note') out.push(String(parseNote(record.body)?.t ?? '?'));
    },
    live: () => live(),
  });
  await done;
  await client.detach(channel).catch(() => {});
  return out;
}

/** A chat whose journal, after its second checkpoint, starts with a steer note written before that checkpoint's snapshot. */
async function steerFirst(lab: Lab): Promise<{ c: Connection; pid: number; channel: string }> {
  const a = lab.studio();
  const c = await a.connect('claude', lab.work);
  await turn(a, c, 2, 'm1');
  await until(() => c.historyCkpt !== null && !c.busy, 'a first checkpoint', 10);
  const first = c.historyCkpt!.record;
  // Two large notes AIB's take-over always skipped force the journal into a new segment; the steer note follows in it.
  for (const n of [1, 2]) assert(await c.channel!.sendNote({ t: 'receipt', pad: 'x'.repeat(40_000), n }));
  assert(await c.channel!.sendNote({ t: 'steer', rpc: 99, receipt: 'r-1', text: '', files: [], fingerprint: 'f' }));
  await turn(a, c, 2, 'm2');
  await until(() => c.historyCkpt!.record > first && !c.busy, 'the second checkpoint', 10);
  await pause(300); // the truncate after the commit is not awaited
  const channel = `chat-${c.id}`;
  const client = await lab.client();
  try {
    const notes = await notesOf(client, channel);
    const steer = notes.indexOf('steer');
    assert(steer >= 0 && !notes.slice(0, steer).some((t) => t === 'chat' || t === 'snapshot'), `the steer note comes first: ${notes}`);
    assert(notes.slice(steer).includes('snapshot'), `a snapshot follows it: ${notes}`);
  } finally {
    client.close();
  }
  const pid = c.channel!.pid ?? 0;
  assert(pid && pidAlive(pid), 'the agent runs');
  await lab.leave(a);
  return { c, pid, channel };
}

Deno.test({
  name: 'lost record: a journal that starts with a steer note before the snapshot is taken over; the agent is never stopped',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const { c, pid } = await steerFirst(lab);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1, 'taken over');
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assert(r.ready && !r.closed, 'ready');
    assert(pidAlive(pid), 'the same agent still runs');
    assertEquals(r.events.filter((e) => e.kind === 'turn_end').length, 2, 'both turn ends are in its history');
  },
});

Deno.test({
  name: 'lost record: a chat channel with no record at all keeps running, gets its record back from the keeper, and is taken over',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const { c, pid, channel } = await steerFirst(lab);
    const b = lab.studio();
    // As if the record were gone: the reader finds no chat note (the session it reads from the agent's lines is still real).
    const link = b.keeper!;
    const real = link.channelFacts.bind(link);
    link.channelFacts = async (client, id, timeoutMs) => ({ ...(await real(client, id, timeoutMs)), note: null });
    assertEquals(await b.adoptKeeper(), 1, 'taken over with a record made from the keeper');
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assert(r.ready && !r.closed, 'ready');
    assertEquals(r.sessionId, c.sessionId, 'the same session');
    assert(pidAlive(pid), 'the same agent still runs');
    // It works on, and its next snapshot carries the chat record again.
    link.channelFacts = real;
    await turn(b, r, 2, 'm3');
    await until(() => r.snapshots > 0, 'a snapshot after the take-over', 10);
    const client = await lab.client();
    try {
      const facts = await real(client, channel);
      assertEquals((facts.note as Json | null)?.id, c.id, 'the record is back');
    } finally {
      client.close();
    }
  },
});
