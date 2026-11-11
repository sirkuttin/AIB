/**
 * server/keeper/client.ts against the real keeper (built from keeper/ with Go into the temp folder, once per source change): hello,
 * spawn with our own channel id, attach with replay then live, claim and fencing, once-keys, notes, closeStdin, kill, truncate,
 * the lost-connection callback, and ensureKeeper starting one keeper per data folder. Temp data folders only; every keeper started
 * here is shut down or killed by the PID its own keeper.json reported.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, pause, PYTHON, until } from './_connection.ts';
import {
  encodeFrame,
  ensureKeeper,
  FrameReader,
  keeperBinary,
  KeeperClient,
  KeeperError,
  type KeeperRecord,
  readKeeperInfo,
} from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const FAST = ['--exit-after', '2s', '--orphan-after', '30s'];

class KeeperLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-keeper-client-' }));
  readonly clients: KeeperClient[] = [];

  async keeper(): Promise<KeeperClient> {
    const client = await ensureKeeper(this.dir, { extraArgs: FAST });
    this.clients.push(client);
    return client;
  }

  async connect(): Promise<KeeperClient> {
    const client = await KeeperClient.connect(readKeeperInfo(this.dir)!);
    this.clients.push(client);
    return client;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    const info = readKeeperInfo(this.dir);
    try {
      const client = this.clients.find((c) => !c.closed) ?? (info ? await KeeperClient.connect(info) : null);
      await client?.shutdown(true);
    } catch { /* already gone */ }
    for (const c of this.clients) c.close();
    if (info && pidAlive(info.pid)) {
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

/** Collects a channel's records and events. */
function recorder() {
  const records: KeeperRecord[] = [];
  const events: string[] = [];
  return {
    records,
    events,
    listener: {
      record: (r: KeeperRecord) => records.push(r),
      live: (seq: number) => events.push(`live:${seq}`),
      fenced: (epoch: number) => events.push(`fenced:${epoch}`),
      removed: () => events.push('removed'),
    },
    out: () => records.filter((r) => r.kind === 'out').map((r) => DEC.decode(r.body)).join(''),
  };
}

const line = (value: unknown) => ENC.encode(JSON.stringify(value) + '\n');

Deno.test('keeper frames: encoded and read back across any chunking; bad lengths are refused', () => {
  const frames = [encodeFrame({ op: 'write', id: 1 }, ENC.encode('hello')), encodeFrame({ ev: 'live', seq: 3 })];
  const joined = new Uint8Array(frames[0].length + frames[1].length);
  joined.set(frames[0]);
  joined.set(frames[1], frames[0].length);
  const reader = new FrameReader();
  const got: [Record<string, unknown>, string][] = [];
  for (let i = 0; i < joined.length; i += 3) {
    for (const [h, b] of reader.push(joined.subarray(i, i + 3))) got.push([h, DEC.decode(b)]);
  }
  assertEquals(got, [[{ op: 'write', id: 1 }, 'hello'], [{ ev: 'live', seq: 3 }, '']]);
  let refused = false;
  try {
    new FrameReader().push(new Uint8Array([0, 0, 2, 0, 0, 0]));
  } catch {
    refused = true;
  }
  assert(refused);
});

Deno.test({
  name: 'keeper client: hello, spawn with our id, replay then live, once-keys, notes, fencing, kill, removal',
  ...T,
  async fn() {
    await keeperBinary(); // builds it once (Go) before the timed part
    await using lab = new KeeperLab();
    const a = await lab.keeper();
    assert(a.has('once') && a.has('channel-ids') && a.has('notes') && a.has('truncate'), a.features.join(','));
    assertEquals(await a.list(), []);

    const spawned = await a.spawn({ channel: 'chat-test1', command: PYTHON, args: [FAKE], cwd: lab.dir });
    assertEquals([spawned.channel, spawned.epoch], ['chat-test1', 1]);
    assert(pidAlive(spawned.pid));
    const again = await a.spawn({ channel: 'chat-test1', command: PYTHON, args: [FAKE] }).catch((e) => e);
    assert(again instanceof KeeperError && again.code === 'exists', String(again)); // never a second process

    const live = recorder();
    await a.attach('chat-test1', 0, live.listener);
    await a.note('chat-test1', 1, ENC.encode('{"t":"chat"}'));
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } };
    assertEquals((await a.write('chat-test1', 1, line(init), 'req:1')).duplicate, false);
    assertEquals((await a.write('chat-test1', 1, line(init), 'req:1')).duplicate, true); // the key was used: nothing written
    await until(() => live.out().includes('"protocolVersion"'), 'initialize answer');
    assertEquals(live.records.filter((r) => r.kind === 'in').length, 1);

    // A second client replays the whole record, then follows it live.
    const b = await lab.connect();
    const replay = recorder();
    const attached = await b.attach('chat-test1', 0, replay.listener);
    assert(attached.live);
    await until(() => replay.events.some((e) => e.startsWith('live:')), 'live event');
    assertEquals(replay.records.map((r) => r.kind).slice(0, 2), ['note', 'in']);
    assertEquals(replay.records.map((r) => r.seq), replay.records.map((_, i) => i + 1)); // no holes

    // Claim: b is the only writer now; a is told and refused.
    const epoch = await b.claim('chat-test1');
    assertEquals(epoch, 2);
    await until(() => live.events.includes('fenced:2'), 'fenced event');
    const stale = await a.write('chat-test1', 1, line({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {} })).catch((e) => e);
    assert(stale instanceof KeeperError && stale.code === 'fenced', String(stale));
    const newSession = { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: lab.dir, mcpServers: [] } };
    await b.write('chat-test1', epoch, line(newSession), 'req:2');
    await until(() => replay.out().includes('fake-session'), 'session/new answer');

    // closeStdin: the agent exits on EOF; the exit record follows, then removal works.
    await b.closeStdin('chat-test1', epoch);
    await until(() => replay.records.some((r) => r.kind === 'exit'), 'exit record');
    const listed = (await b.list()).find((c) => c.channel === 'chat-test1')!;
    assertEquals([listed.live, listed.reason], [false, 'exit']);
    assertEquals((await b.truncate('chat-test1', epoch, Number.MAX_SAFE_INTEGER)).removed, true);
    assertEquals(await b.list(), []);

    // kill takes the whole tree down with an exit record (reason killed).
    const k = await b.spawn({ channel: 'chat-test2', command: PYTHON, args: [FAKE], cwd: lab.dir });
    const killed = recorder();
    await b.attach('chat-test2', 0, killed.listener);
    await b.kill('chat-test2', k.epoch);
    await until(() => killed.records.some((r) => r.kind === 'exit'), 'exit after kill');
    assertEquals(JSON.parse(DEC.decode(killed.records.find((r) => r.kind === 'exit')!.body)).reason, 'killed');
    await until(() => !pidAlive(k.pid), 'agent gone', 5);
  },
});

Deno.test({
  name: 'keeper client: one keeper per data folder; the lost callback fires when the keeper dies, and its agents die with it',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new KeeperLab();
    const first = await lab.keeper();
    const second = await lab.keeper(); // finds the running one
    assertEquals(first.keeperPid, second.keeperPid);
    const agent = await first.spawn({ channel: 'chat-x', command: PYTHON, args: [FAKE], cwd: lab.dir });
    let lost: Error | null | undefined;
    first.onClose = (error) => (lost = error);
    Deno.kill(first.keeperPid, 'SIGKILL');
    await until(() => lost !== undefined, 'lost callback', 5);
    await until(() => !pidAlive(agent.pid), 'agent ends with its keeper', 5);
    // The next keeper marks the channel keeper_lost; nothing is resent.
    const next = await lab.keeper();
    assert(next.keeperPid !== first.keeperPid);
    const entry = (await next.list()).find((c) => c.channel === 'chat-x')!;
    assertEquals([entry.live, entry.reason], [false, 'keeper_lost']);
  },
});
