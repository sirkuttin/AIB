/**
 * T18 (B4): a steer survives AIB stopping. In the keeper (the agent runs on): a steer in flight takes its answer from the record or
 * live and is never sent again, the user's bubble shows once; a steer the agent answered promptRequired goes as the next prompt
 * after the rebuild. Without the keeper (the agent restarts with AIB): the lane comes back as queued messages, paused, and one that
 * was being sent says it may have arrived. The keeper is the real one (built from keeper/ with Go); the agent is a Puppet.
 */
import { assert, assertEquals } from './_assert.ts';
import { pause, until } from './_connection.ts';
import { type Json, promptText, Puppet, puppetCommand, userEvents } from './_steer.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { MessageQueue, QueueStore, STEER_RESTART_NOTE } from '../../outputs/agent-studio/server/acp/msgqueue.ts';
import { StateStore } from '../../outputs/agent-studio/server/state/recovery.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class KeeperLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-steer-keeper-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly studios: Studio[] = [];
  readonly puppet = new Puppet('omp');

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }

  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper, keeperForNew: true });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(puppetCommand(this.puppet.port), cwd, provider, options);
    this.studios.push(studio);
    return studio;
  }

  /** This AIB stops without a word (its chats run on in the keeper). */
  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1);
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
    this.puppet.close();
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

Deno.test({
  name: 'T18 (B4): in the keeper, a steer in flight is answered after the rebuild and never resent; a promptRequired one goes as a prompt',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new KeeperLab();
    const p = lab.puppet;
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    assertEquals((await a.liveCall('prompt', { id: c.id, text: 'go', clientMessageId: 'm1' }))[0], 200);
    const prompt = await p.take('session/prompt');
    void a.liveCall('steer', { id: c.id, text: 'while you work', clientMessageId: 's1' });
    const steer = await p.take('_session/steering');
    await pause(400); // the lane reached the queue store, the steer note and request the record
    lab.crash(a);

    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals(r.rebuildError, '');
    assert(r.busy, 'the turn still runs');
    assertEquals((r.public().steerLane as Json[]).map((i) => [i.text, i.state]), [['while you work', 'sending']]);
    await p.reply(steer.id, { outcome: 'injected', queue: 'steering' });
    await until(() => !(r.public().steerLane as Json[]).length, 'the answer applied');
    assertEquals(userEvents(r).filter((u) => u.text === 'while you work').map((u) => u.steered), [true], 'the bubble, once');
    await pause(300);
    assertEquals(p.all('_session/steering').length, 1, 'never sent again');

    void b.liveCall('steer', { id: r.id, text: 'second', clientMessageId: 's2' });
    const second = await p.take('_session/steering');
    await p.reply(second.id, { outcome: 'promptRequired', reason: 'noRunningTurn' });
    await until(() => (r.public().steerLane as Json[])[0]?.state === 'fallback', 'waits to go as a prompt');
    await pause(400);
    lab.crash(b);

    const d = lab.studio();
    assertEquals(await d.adoptKeeper(), 1);
    const r2 = d.connections.get(c.id)!;
    assertEquals((r2.public().steerLane as Json[]).map((i) => [i.text, i.state]), [['second', 'fallback']], 'not lost (B4)');
    await p.reply(prompt.id, { stopReason: 'end_turn' });
    const next = await p.take('session/prompt');
    assertEquals(promptText(next), 'second');
    assertEquals(p.all('_session/steering').length, 2);
    await p.reply(next.id, { stopReason: 'end_turn' });
    await until(() => !r2.busy, 'done');
    assertEquals(p.all('session/prompt').length, 2);
  },
});

Deno.test('T18 (B4): without the keeper the lane comes back as paused queued messages; a steer in flight says it may have arrived', () => {
  const dir = Deno.makeTempDirSync({ prefix: 'aib-steer-store-' });
  try {
    const q = new MessageQueue();
    q.add('q1', 'after the turn', [], 'f1');
    q.steer.push({ id: 's1', text: 'in flight', attachments: [], fingerprint: 'f2', queuedAt: 1, state: 'sending', heldReason: '' });
    q.steer.push({ id: 's2', text: 'held', attachments: [], fingerprint: 'f3', queuedAt: 2, state: 'held', heldReason: 'approval' });
    const store = new QueueStore(dir, 'queues-test');
    store.put('claude', 'sess', q.toSaved());
    const saved = new QueueStore(dir, 'queues-test').get('claude', 'sess');

    const restarted = new MessageQueue();
    restarted.load(saved, 'restart');
    assertEquals(restarted.items.map((i) => [i.id, i.note]), [['s1', STEER_RESTART_NOTE], ['s2', ''], ['q1', '']]);
    assertEquals([restarted.steer, restarted.pauseReason()], [[], 'restart']);

    const rebuilt = new MessageQueue();
    rebuilt.load(saved, '', true);
    assertEquals(rebuilt.steer.map((i) => [i.id, i.state]), [['s1', 'sending'], ['s2', 'held']]);
    assertEquals(rebuilt.items.map((i) => i.id), ['q1']);

    // A steer receipt in flight when AIB stopped is unknown afterwards; one the agent took stays final.
    const receipts = new StateStore(dir);
    receipts.setReceipt('claude', 'sess', 's1', 'f2', 'steering');
    receipts.setReceipt('claude', 'sess', 's3', 'f4', 'injected');
    const reread = new StateStore(dir);
    assertEquals(reread.receipt('claude', 'sess', 's1')?.state, 'unknown');
    assertEquals(reread.receipt('claude', 'sess', 's3')?.state, 'injected');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});
