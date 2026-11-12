/**
 * Studio with agents in the keeper (always on), in one process: a chat runs through the keeper; a Studio that
 * "crashes" (drops its keeper connection without touching the agent) is replaced by a new Studio that rebuilds the chat from the
 * keeper's record at several points of a turn (streaming, a question waiting, after the answer, idle) and goes on live; the keeper
 * dying ends the agent and the chat comes back "Interrupted" without anything sent twice. Real keeper (built from keeper/ with
 * Go), fake ACP agent (work/fake_acp.py), temp state folders.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection, KEEPER_LOST } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import {
  compareKeeperVersions,
  KEEPER_NEEDS,
  keeperBinary,
  KeeperClient,
  keeperSourceDir,
  missingFeatures,
  programVersion,
  readKeeperInfo,
} from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class KeeperStudioLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-keeper-studio-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly agentLog = this.dir + SEP + 'agent-received.log';
  readonly studios: Studio[] = [];

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }

  studio(flags: string[] = ['--cancel-aware']): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake(...flags), cwd, provider, { ...options, env: { FAKE_ACP_LOG: this.agentLog } });
    this.studios.push(studio);
    return studio;
  }

  /** What a crashed AIB leaves: its keeper connection gone, its agents untouched, its session leases released by the OS. */
  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1); // never closed: a crashed process closes nothing
  }

  /** Every line the agent(s) received, parsed. */
  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
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

/** The text of every agent_message_chunk the chat shows, in order. */
function said(c: Connection): string {
  return c.events.filter((e) => e.kind === 'update').map((e) => {
    const update = (e.data as Json).update as Json;
    return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
  }).join('');
}

const prompts = (lines: Json[]) => lines.filter((m) => m.method === 'session/prompt');
const answers = (lines: Json[], id: string) => lines.filter((m) => m.id === id && !m.method);

Deno.test({
  name: 'keeper studio: a chat runs through the keeper (prompt, question, answer, turn end); closing it removes its channel',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new KeeperStudioLab();
    const studio = lab.studio();
    const c = await studio.connect('omp', lab.work);
    assert(c.channel !== null, 'the agent runs in the keeper');
    const [status] = await studio.liveCall('prompt', { id: c.id, text: 'stream:6:20', clientMessageId: 'm1' });
    assertEquals(status, 200);
    await until(() => c.permissions.size === 1, 'the question', 10);
    const key = [...c.permissions.keys()][0];
    assertEquals((await studio.liveCall('permission', { id: c.id, key, option: 'yes' }))[0], 200);
    await until(() => !c.busy, 'turn end', 10);
    assertEquals(said(c), 'chunk0 chunk1 chunk2 answer=yes chunk3 chunk4 chunk5 ');
    assertEquals(prompts(lab.received()).length, 1);
    const client = (await studio.keeper!.client(false))!;
    assertEquals((await client.list()).map((ch) => ch.channel), [`chat-${c.id}`]);
    await studio.liveCall('disconnect', { id: c.id });
    await until(async () => (await client.list()).length === 0, 'channel removed', 10);
  },
});

/** One crash point: run the turn on Studio A until `when` holds, crash A, rebuild on Studio B, finish the turn there. */
async function crashAt(when: 'streaming' | 'question' | 'answered' | 'idle'): Promise<void> {
  await keeperBinary();
  await using lab = new KeeperStudioLab();
  const a = lab.studio();
  const c = await a.connect('omp', lab.work);
  await a.liveCall('prompt', { id: c.id, text: 'stream:8:120', clientMessageId: 'm1' });
  if (when === 'streaming') await until(() => said(c).includes('chunk1 '), 'streaming', 10);
  if (when !== 'streaming') await until(() => c.permissions.size === 1, 'the question', 10);
  if (when === 'answered' || when === 'idle') {
    a.connections.get(c.id)!.permission([...c.permissions.keys()][0], 'yes');
    await until(() => said(c).includes('answer=yes chunk4 '), 'streaming after the answer', 10);
  }
  if (when === 'idle') await until(() => !c.busy, 'turn end', 10);
  const agentPid = c.process!.pid;
  lab.crash(a);
  await pause(300); // the agent keeps streaming into the keeper meanwhile

  const b = lab.studio();
  assertEquals(await b.adoptKeeper(), 1);
  const r = b.connections.get(c.id)!;
  assert(r && !r.closed && r.ready, 'rebuilt under the same id');
  assertEquals(r.rebuildError, '');
  assertEquals(r.process!.pid, agentPid); // the same agent process
  assertEquals(r.sessionId, 'fake-session');
  assertEquals(r.events.filter((e) => e.kind === 'user').length, 1);
  assertEquals((r.events.find((e) => e.kind === 'user')!.data as Json).text, 'stream:8:120');
  assertEquals(b.store!.receipt('omp', 'fake-session', 'm1')!.state, when === 'idle' ? 'finished' : 'working');
  if (when === 'streaming' || when === 'question') {
    await until(() => r.permissions.size === 1, 'the question, shown once', 10);
    assertEquals(r.events.filter((e) => e.kind === 'permission').length, 1);
    assertEquals(r.attention().state, 'needs_you');
    const key = [...r.permissions.keys()][0];
    assertEquals((await b.liveCall('permission', { id: r.id, key, option: 'yes' }))[0], 200);
  }
  await until(() => !r.busy, 'turn end on the new Studio', 15);
  assertEquals(said(r), 'chunk0 chunk1 chunk2 chunk3 answer=yes chunk4 chunk5 chunk6 chunk7 '); // every chunk once, in order
  assertEquals(r.events.filter((e) => e.kind === 'turn_end').length, 1);
  assertEquals(b.store!.receipt('omp', 'fake-session', 'm1')!.state, 'finished');
  const got = lab.received();
  assertEquals(prompts(got).length, 1); // the prompt reached the agent once
  assertEquals(answers(got, 'stream-ask').length, 1); // and the question was answered once

  // It goes on as a normal chat: the next prompt works, and its id does not collide with the old AIB's.
  await b.liveCall('prompt', { id: r.id, text: 'stream:2:10', clientMessageId: 'm2' });
  await until(() => r.permissions.size === 1, 'the next question', 10);
  r.permission([...r.permissions.keys()][0], 'no');
  await until(() => !r.busy, 'second turn end', 10);
  const ids = prompts(lab.received()).map((m) => m.id);
  assertEquals(ids.length, 2);
  assert(ids[1] !== ids[0], `prompt ids ${ids}`);
}

for (const when of ['streaming', 'question', 'answered', 'idle'] as const) {
  Deno.test({
    name: `keeper studio: crash while ${when}: the next Studio rebuilds the chat and nothing is sent twice`,
    ...T,
    fn: () => crashAt(when),
  });
}

Deno.test({
  name: "keeper studio: crash while Claude Code holds an ended turn for its helper: the rebuild shows it idle, the follow-up as working",
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new KeeperStudioLab();
    const flags = ['--held-turn'];
    const a = lab.studio(flags);
    const c = await a.connect('omp', lab.work);
    const gate = lab.dir + SEP + 'helper-gate';
    await a.liveCall('prompt', { id: c.id, text: `helper:${gate}`, clientMessageId: 'm1' });
    await until(() => !c.busy && c.events.some((e) => e.kind === 'turn_end'), 'the reply ended', 10);
    assertEquals(c.pending.size, 1); // the held response
    lab.crash(a);
    await pause(300);

    const b = lab.studio(flags);
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assert(r && !r.closed && r.ready && !r.rebuildError, 'rebuilt under the same id');
    assert(!r.busy, 'the ended turn stays ended');
    assertEquals(r.events.filter((e) => e.kind === 'turn_end').length, 1);
    assertEquals(b.store!.receipt('omp', 'fake-session', 'm1')!.state, 'finished');
    assertEquals(r.subagents.get('helper-1')?.state, 'running');
    Deno.writeTextFileSync(gate, 'go');
    await until(() => r.busy && r.autonomous, 'the follow-up working', 10);
    Deno.writeTextFileSync(gate + '.end', 'go');
    await until(() => !r.busy && r.pending.size === 0, 'the follow-up ended and the held response came', 10);
    assertEquals(r.events.filter((e) => e.kind === 'turn_end').length, 2);
    await b.liveCall('prompt', { id: r.id, text: 'after', clientMessageId: 'm2' });
    await until(() => !r.busy && said(r).includes('Fixture reply: after'), 'the next turn', 10);
    assertEquals(prompts(lab.received()).length, 2);
  },
});

Deno.test({
  name: 'keeper studio: the picks of a new chat (model, mode, effort) survive a crash and rebuild and are never applied twice',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new KeeperStudioLab();
    const flags = ['--cancel-aware', '--models'];
    const a = lab.studio(flags);
    const c = await a.connect('omp', lab.work, null, { picks: { model: 'luna-4', mode: 'full', effort: 'high' } });
    assert(c.channel !== null, 'the agent runs in the keeper');
    assertEquals(c.pickResults.map((p) => p.ok), [true, true, true]);
    const optionsFile = lab.state + SEP + 'agent-options.json';
    const remembered = Deno.readTextFileSync(optionsFile);
    const sets = () => lab.received().filter((m) => m.method === 'session/set_config_option' || m.method === 'session/set_mode');
    assertEquals(sets().length, 3);
    lab.crash(a);
    await pause(300);

    const b = lab.studio(flags);
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assert(r && !r.closed && r.ready && !r.rebuildError, 'rebuilt under the same id');
    const option = (id: string) => ((r.settings.configOptions as Json[]).find((o) => o.id === id) as Json).currentValue;
    assertEquals([option('model'), (r.settings.modes as Json).currentModeId, option('reasoning_effort')], ['luna-4', 'full', 'high']);
    assertEquals(r.pickResults, [], 'the rebuild replays the answers; it applies nothing');
    assertEquals(r.public().pickResults, undefined);
    assertEquals(sets().length, 3, 'no setting was sent to the agent again');
    assertEquals(lab.received().filter((m) => m.method === 'session/new').length, 1);
    assertEquals(Deno.readTextFileSync(optionsFile), remembered, 'the replay does not write agent-options.json');
    // The first prompt after the rebuild runs with the picks.
    await b.liveCall('prompt', { id: r.id, text: 'settings?', clientMessageId: 'm1' });
    await until(() => !r.busy && said(r).includes('Fixture settings'), 'the reply', 10);
    assert(said(r).includes('model=luna-4 mode=full effort=high sessions=1'), said(r));
  },
});

Deno.test({
  name: 'keeper studio: the keeper dies mid-turn: the agent ends, the chat says Interrupted, comes back by session/load, never resent',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new KeeperStudioLab();
    const studio = lab.studio();
    const c = await studio.connect('omp', lab.work);
    await studio.liveCall('prompt', { id: c.id, text: 'stream:40:200', clientMessageId: 'm1' });
    await until(() => said(c).includes('chunk1 '), 'streaming', 10);
    const agentPid = c.process!.pid;
    Deno.kill(readKeeperInfo(lab.state)!.pid, 'SIGKILL');
    await until(() => c.closed, 'interrupted', 10);
    assertEquals(c.error, KEEPER_LOST);
    assert(c.interrupted);
    await until(() => !pidAlive(agentPid), 'agent ended with the keeper', 10);
    assertEquals(studio.store!.receipt('omp', 'fake-session', 'm1')!.state, 'error'); // never offered for an automatic resend
    // It comes back: a new connection for the same session, by session/load, with a new keeper. Nothing is sent again.
    await until(
      () => [...studio.connections.values()].some((x) => x !== c && x.sessionId === 'fake-session' && x.ready),
      'reconnected',
      30,
    );
    const got = lab.received();
    assertEquals(prompts(got).length, 1);
    assertEquals(got.filter((m) => m.method === 'session/load').length, 1);
  },
});

Deno.test({
  name: 'keeper studio: release() for an update leaves the chat running in the keeper; the next Studio takes it over under the same ids',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new KeeperStudioLab();
    const a = lab.studio();
    const c = await a.connect('omp', lab.work);
    await a.liveCall('prompt', { id: c.id, text: 'stream:10:150', clientMessageId: 'm1' });
    await until(() => said(c).includes('chunk1 '), 'streaming', 10);
    assertEquals(a.keeperHandover(), '', 'every working chat runs in the keeper');
    const agentPid = c.process!.pid;
    assertEquals(await a.release(), 1);
    lab.studios.splice(lab.studios.indexOf(a), 1); // released, not to be closed again
    assert(pidAlive(agentPid), 'the agent keeps running');
    assertEquals(a.store!.receipt('omp', 'fake-session', 'm1')!.state, 'working', 'not marked unknown: the turn goes on');

    const b = lab.studio();
    assertEquals(b.instanceId, a.instanceId, 'the same keeper: open pages keep their connection ids');
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assertEquals([r.ready, r.rebuildError, r.process!.pid], [true, '', agentPid]);
    await until(() => r.permissions.size === 1, 'the question, shown once', 10);
    assertEquals(r.events.filter((e) => e.kind === 'permission').length, 1);
    assertEquals((await b.liveCall('permission', { id: r.id, key: [...r.permissions.keys()][0], option: 'yes' }))[0], 200);
    await until(() => !r.busy, 'turn end on the new Studio', 15);
    assertEquals(said(r), 'chunk0 chunk1 chunk2 chunk3 chunk4 answer=yes chunk5 chunk6 chunk7 chunk8 chunk9 ');
    assertEquals(prompts(lab.received()).length, 1);
    assertEquals(answers(lab.received(), 'stream-ask').length, 1);
  },
});

/** A keeper program built from keeper/ with another version stamped in (a "newer keeper ships" stand-in). */
async function keeperWithVersion(dir: string, version: string): Promise<string> {
  const go = Deno.env.get('GO') || (Deno.build.os === 'windows' ? 'C:/Program Files/Go/bin/go.exe' : 'go');
  const exe = `${dir}${SEP}AIB-keeper-${version}${Deno.build.os === 'windows' ? '.exe' : ''}`;
  const flags = `-s -w -X main.keeperVersion=${version}${Deno.build.os === 'windows' ? ' -H windowsgui' : ''}`;
  const out = await new Deno.Command(go, {
    args: ['build', '-trimpath', '-ldflags', flags, '-o', exe, '.'],
    cwd: keeperSourceDir()!,
    env: { CGO_ENABLED: '0' },
    stdout: 'piped',
    stderr: 'piped',
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  return exe;
}

Deno.test({
  name: 'keeper versions: a newer keeper shipped with AIB is used only once the running one holds no chats; then it replaces it',
  ...T,
  async fn() {
    await using lab = new KeeperStudioLab();
    const older = await keeperBinary();
    const newer = await keeperWithVersion(lab.dir, '1.3.1');
    assertEquals([await programVersion(older), await programVersion(newer)], ['1.3.0', '1.3.1']);
    const extraArgs = ['--exit-after', '2s', '--orphan-after', '30s'];
    // An AIB with the 1.3.0 keeper starts a long-running agent in it.
    const first = new KeeperLink({ dataDir: lab.state, orphan: null, binary: older, extraArgs });
    const sleeper = { command: Deno.execPath(), args: ['eval', 'setTimeout(() => {}, 60000)'], cwd: lab.work };
    const one = first.spawn({ channel: 'held', ...sleeper }, {});
    await one.ready;
    const oldPid = readKeeperInfo(lab.state)!.pid;
    first.disconnect();
    // The updated AIB ships 1.3.1: while 1.3.0 holds a live channel it is kept (the chat would die with it).
    const second = new KeeperLink({ dataDir: lab.state, orphan: null, binary: newer, extraArgs });
    const kept = await second.check();
    assertEquals([kept.keeperVersion, kept.keeperPid, second.problem], ['1.3.0', oldPid, '']);
    const two = second.spawn({ channel: 'also-old', ...sleeper }, {});
    await two.ready;
    assertEquals(two.client!.keeperVersion, '1.3.0', 'new chats go to the running keeper meanwhile');
    // Every chat ends: the next start replaces the keeper with the newer one.
    for (const id of ['held', 'also-old']) await kept.kill(id, await kept.claim(id));
    await until(async () => (await kept.list()).every((ch) => !ch.live), 'channels ended', 10);
    const renewed = await second.check();
    assertEquals(renewed.keeperVersion, '1.3.1');
    await until(() => !pidAlive(oldPid), 'the old keeper exited', 10);
    assertEquals(readKeeperInfo(lab.state)!.keeper, '1.3.1');
    const three = second.spawn({ channel: 'on-new', ...sleeper }, {});
    await three.ready;
    assertEquals(three.client!.keeperVersion, '1.3.1');
    assertEquals(compareKeeperVersions('1.0.10', '1.0.9'), 1);
    assertEquals(compareKeeperVersions('1.0', '1.0.0'), 0);
    assertEquals(compareKeeperVersions('', '1.0.0'), -1);
    second.disconnect();
  },
});

Deno.test('keeper versions: a keeper that lacks a needed feature is reported (missingFeatures) and the features AIB needs are listed', () => {
  assertEquals(KEEPER_NEEDS, ['notes', 'once', 'channel-ids']);
  assertEquals(missingFeatures(['pty', 'notes', 'once', 'channel-ids']), []);
  assertEquals(missingFeatures(['pty', 'notes']), ['once', 'channel-ids']);
});
