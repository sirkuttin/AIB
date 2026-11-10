/**
 * The keeper with real processes (AIB_KEEPER=1): a web server (`serve`), its agent host and the keeper, the fake agent mid-turn
 * streaming. Killing the host hard (TerminateProcess) leaves the agent running in the keeper; the next host rebuilds the chat
 * from the keeper's record under the same id: it is still streaming, the question shows once, answering it works, and the
 * keeper's record shows nothing was sent twice. Then killing the keeper ends the agent; the chat says Interrupted, comes back by
 * session/load, and nothing is resent. Temp state folder, random high ports, only PIDs this test started are killed.
 */
import { assert, assertEquals } from './_assert.ts';
import { Fixture, nativePath, openConversation, SEP, sleep, TEST_OPTIONS, until, type Web } from './_host_fixture.ts';
import { WORK } from './_parity.ts';
import { keeperBinary, KeeperClient, type KeeperRecord, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive, readInfo } from '../../outputs/agent-studio/server/host/host_client.ts';
import { KEEPER_LOST } from '../../outputs/agent-studio/server/acp/connection.ts';

type Json = Record<string, unknown>;
const KEEPER_AGENT = nativePath(new URL('keeper-fixture/agent.py', WORK));
const DEC = new TextDecoder();

class KeeperFixture extends Fixture {
  readonly agentLog = this.root + SEP + 'agent-received.log';
  keeperBin = '';

  override agentFlags(): string[] {
    const flags = super.agentFlags();
    flags[flags.indexOf('--claude-launcher') + 1] = KEEPER_AGENT;
    return flags;
  }

  override get env(): Record<string, string> {
    return { ...super.env, AIB_KEEPER: '1', AIB_KEEPER_BIN: this.keeperBin, FAKE_ACP_LOG: this.agentLog };
  }

  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  override async cleanup(): Promise<void> {
    const keeper = readKeeperInfo(this.state);
    await super.cleanup().catch(() => {});
    if (keeper && pidAlive(keeper.pid)) Deno.kill(keeper.pid, 'SIGKILL'); // the keeper this test's hosts started
  }
}

function said(state: Json): string {
  return (state.events as Json[]).filter((e) => e.kind === 'update').map((e) => {
    const update = (e.data as Json).update as Json;
    return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
  }).join('');
}

/** The keeper's whole record of one channel, read through a client of our own. */
async function journal(state: string, channel: string): Promise<KeeperRecord[]> {
  const client = await KeeperClient.connect(readKeeperInfo(state)!);
  const records: KeeperRecord[] = [];
  let live = false;
  try {
    await client.attach(channel, 0, { record: (r) => records.push(r), live: () => (live = true) });
    await until(() => live, 'journal read', 10);
    return records;
  } finally {
    client.close();
  }
}

const inLines = (records: KeeperRecord[]) =>
  records.filter((r) => r.kind === 'in').flatMap((r) => DEC.decode(r.body).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));

Deno.test({
  name:
    'keeper e2e: kill the host mid-turn: the chat goes on, the question shows once and is answered once; kill the keeper: Interrupted, never resent',
  ...TEST_OPTIONS,
  async fn() {
    const fixture = new KeeperFixture();
    try {
      fixture.keeperBin = await keeperBinary();
      const web: Web = await fixture.startWeb();
      const id = await openConversation(web, fixture);
      const channel = `chat-${id}`;
      const [status] = await web.post('prompt', { id, text: 'stream:24:150', clientMessageId: 'k1' });
      assertEquals(status, 200);
      await until(async () => said(await web.state(id)).includes('chunk2 '), 'streaming', 20);

      const before = (await (await KeeperClient.connect(readKeeperInfo(fixture.state)!)).list()).find((c) => c.channel === channel)!;
      assert(before.live && pidAlive(before.pid));
      const oldHost = (await readInfo(fixture.state))!.pid as number;
      Deno.kill(oldHost, 'SIGKILL'); // TerminateProcess: nothing is closed, nothing is said
      await until(() => !pidAlive(oldHost), 'old host gone', 10);

      // A new host (started by the web server, or by the keeper's orphan command) rebuilds the chat under the same id.
      await until(
        async () => {
          const info = await fixture.hostInfo();
          return info && info.pid !== oldHost && pidAlive(info.pid);
        },
        'new host',
        40,
      );
      const restarted = await until(
        async () => {
          const s = await web.state(id);
          return s && s.id === id && s.ready ? s : null;
        },
        'chat rebuilt on the new host',
        40,
      );
      assertEquals(restarted.error, '');
      assert(restarted.busy, 'the turn is still running');
      const after = (await (await KeeperClient.connect(readKeeperInfo(fixture.state)!)).list()).find((c) => c.channel === channel)!;
      assertEquals([after.live, after.pid], [true, before.pid]); // the same agent process, never restarted

      // Still streaming, the question shows once, and the answer reaches the agent once.
      const asked = await until(
        async () => {
          const s = await web.state(id);
          return (s.permissions as Json[]).length === 1 ? s : null;
        },
        'the question',
        40,
      );
      assertEquals((asked.events as Json[]).filter((e) => e.kind === 'permission').length, 1);
      assertEquals((asked.events as Json[]).filter((e) => e.kind === 'user').length, 1);
      const key = (asked.permissions as Json[])[0].key;
      const [answered] = await web.post('permission', { id, key, option: 'yes' });
      assertEquals(answered, 200);
      const done = await until(
        async () => {
          const s = await web.state(id);
          return !s.busy ? s : null;
        },
        'turn end',
        40,
      );
      const expected = Array.from({ length: 24 }, (_, i) => (i === 12 ? 'answer=yes ' : '') + `chunk${i} `).join('');
      assertEquals(said(done), expected); // every chunk once, in order, across the restart
      const sent = inLines(await journal(fixture.state, channel));
      assertEquals(sent.filter((m) => m.method === 'session/prompt').length, 1);
      assertEquals(sent.filter((m) => m.id === 'stream-ask' && !m.method).length, 1);
      assertEquals(fixture.received().filter((m) => m.method === 'session/prompt').length, 1);
      assertEquals(fixture.received().filter((m) => m.id === 'stream-ask' && !m.method).length, 1);

      // Kill the keeper: the agent ends with it; the chat says Interrupted and comes back by session/load; nothing is resent.
      await web.post('prompt', { id, text: 'stream:200:100', clientMessageId: 'k2' });
      await until(async () => said(await web.state(id)).split('chunk2 ').length > 2, 'second turn streaming', 20);
      const live = (await (await KeeperClient.connect(readKeeperInfo(fixture.state)!)).list()).find((c) => c.channel === channel)!;
      Deno.kill(readKeeperInfo(fixture.state)!.pid, 'SIGKILL');
      const interrupted = await until(
        async () => {
          const s = await web.state(id);
          return s.closed ? s : null;
        },
        'interrupted',
        20,
      );
      assertEquals(interrupted.error, KEEPER_LOST);
      await until(() => !pidAlive(live.pid), 'agent ended with the keeper', 10);
      await until(
        async () => {
          const list = await web.listing();
          return (list.connections as Json[]).some((c) => c.id !== id && c.sessionId === 'fake-session' && c.ready);
        },
        'reconnected by session/load',
        40,
      );
      const got = fixture.received();
      assertEquals(got.filter((m) => m.method === 'session/prompt').length, 2); // k1 and k2, each once
      assertEquals(got.filter((m) => m.method === 'session/load').length, 1);
      await sleep(500);
      assertEquals(fixture.received().filter((m) => m.method === 'session/prompt').length, 2);
    } finally {
      await fixture.cleanup();
    }
  },
});
