/**
 * The keeper with real processes, on by default (no setting; an old saved `server.keeper: false` is ignored; no AIB_KEEPER in the
 * environment): AIB (`serve`, one process: no agent host with the keeper) and the keeper, the fake
 * agent mid-turn streaming. Killing AIB hard (TerminateProcess) leaves the agent running in the keeper; with no client for 5 s the
 * keeper starts AIB again (its orphan command, rule V1), and the new AIB rebuilds the chat from the keeper's record under the same
 * id: it is still streaming, the question shows once, answering it works, and the keeper's record shows nothing was sent twice.
 * Then killing the keeper ends the agent; the chat says Interrupted, comes back by session/load, and nothing is resent. Temp state
 * folder, OS-picked ports, only PIDs this test started (and the AIB its keeper started) are killed.
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
    const env: Record<string, string> = { ...super.env, AIB_KEEPER_BIN: this.keeperBin, FAKE_ACP_LOG: this.agentLog };
    delete env.AIB_KEEPER; // the default: the keeper on (the split-host fixture turns it off)
    return env;
  }

  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  override async cleanup(): Promise<void> {
    // The keeper first: with a live chat and no client it would start AIB again (its orphan command).
    const keeper = readKeeperInfo(this.state);
    if (keeper && pidAlive(keeper.pid)) Deno.kill(keeper.pid, 'SIGKILL'); // the keeper this test's AIB started
    try { // the AIB the keeper started (not our child)
      const owner = JSON.parse(Deno.readTextFileSync(this.state + SEP + 'aib-owner.json'));
      if (typeof owner.pid === 'number' && owner.pid !== Deno.pid) this.hostPids.add(owner.pid);
    } catch { /* none */ }
    await super.cleanup().catch(() => {});
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

/** One channel's list entry, through a short-lived client (a client left connected would count as AIB for the orphan rule). */
async function channelInfo(state: string, channel: string) {
  const client = await KeeperClient.connect(readKeeperInfo(state)!, 'keeper e2e test');
  try {
    return (await client.list()).find((c) => c.channel === channel);
  } finally {
    client.close();
  }
}

const inLines = (records: KeeperRecord[]) =>
  records.filter((r) => r.kind === 'in').flatMap((r) => DEC.decode(r.body).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)));

Deno.test({
  name:
    'keeper e2e: kill AIB mid-turn: the keeper starts it again, the chat goes on, the question shows once and is answered once; kill the keeper: Interrupted, never resent',
  ...TEST_OPTIONS,
  async fn() {
    const fixture = new KeeperFixture();
    try {
      fixture.keeperBin = await keeperBinary();
      // An old saved switch (the setting is gone): ignored, the keeper is on anyway.
      Deno.writeTextFileSync(fixture.state + SEP + 'studio-settings.json', JSON.stringify({ version: 1, server: { keeper: false } }));
      // The keeper restarts AIB with its command line, so that names the port: one the OS picked (pinPort).
      const web: Web = await fixture.startWeb([], { pinPort: true });
      assertEquals(web.boot.hostMode, 'keeper', 'one AIB process with the keeper');
      assertEquals(await readInfo(fixture.state), null, 'no separate agent host');
      const id = await openConversation(web, fixture);
      const channel = `chat-${id}`;
      const [status] = await web.post('prompt', { id, text: 'stream:24:150', clientMessageId: 'k1' });
      assertEquals(status, 200);
      await until(async () => said(await web.state(id)).includes('chunk2 '), 'streaming', 20);

      const before = (await channelInfo(fixture.state, channel))!;
      assert(before.live && pidAlive(before.pid));
      const oldAib = web.process.pid;
      const oldToken = web.token;
      await web.kill(); // TerminateProcess: nothing is closed, nothing is said
      const killed = Date.now();

      // The keeper starts AIB again (no client for 5 s); it rebuilds the chat under the same id, on the same port.
      await until(
        async () => {
          const [status, boot] = await web.get('/api/live/bootstrap');
          if (status !== 200 || boot.token === oldToken) return false;
          web.token = String(boot.token);
          return true;
        },
        'AIB started again by the keeper',
        40,
      ).catch((error) => {
        throw new Error(`${error.message}
${fixture.read(fixture.state + SEP + 'keeper' + SEP + 'keeper.log')}
${fixture.read(fixture.state + SEP + 'studio.log').slice(-2500)}`);
      });
      const owner = JSON.parse(Deno.readTextFileSync(fixture.state + SEP + 'aib-owner.json'));
      fixture.hostPids.add(owner.pid);
      assert(owner.pid !== oldAib, 'a new AIB process');
      const back = (Date.now() - killed) / 1000;
      assert(back >= 4 && back <= 20, `started by the keeper's orphan rule (5 s without a client): ${back} s`);
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
      const after = (await channelInfo(fixture.state, channel))!;
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
      const live = (await channelInfo(fixture.state, channel))!;
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
