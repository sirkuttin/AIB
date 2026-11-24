/**
 * Ending a finished helper through the REAL keeper (keeper/ built with Go, fake agents, temp folders, no windows), and quitting AIB:
 *  - a merged helper's channel is removed from the keeper and its agent, background shell and child process are gone;
 *  - quit keeps a working helper: release() leaves it running in the keeper, the next AIB takes it over, and a swarm that polls
 *    with a zero idle limit does not end it while its turn runs; once it is done and idle it is ended.
 * The no-keeper cases are swarm_end_helper_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, FAKE_UNIQUE, pause, NODE, until } from './_connection.ts';
import { commit, makeRepo, runGit } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import { Swarm } from '../../app/server/swarm/service.ts';
import { setSwarmEnabled } from '../../app/server/swarm/settings.ts';
import { pathOf } from '../../app/server/state/paths.ts';
import { processList } from '../../app/server/platform/process_info.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE_UNIQUE;
const BRIEF: Json = {
  title: 'Login tests',
  job: 'tests',
  goal: 'Make the login tests pass every time.',
  owns: ['test/login/**'],
  done_when: 'the login tests pass',
  reply_with: 'cause in one line',
  test_cmd: "node -e \"require('fs').writeFileSync('AIB_RAN_TEST_CMD','')\"",
};

const alive = (pid: number) => (Deno.build.os === 'windows' ? processList().some((p) => p.pid === pid) : pidAlive(pid));
const exists = (p: string) => {
  try {
    return Deno.statSync(p).isFile;
  } catch {
    return false;
  }
};
async function gone(pids: number[], what: string, seconds = 15): Promise<void> {
  const end = Date.now() + seconds * 1000;
  while (pids.some(alive)) {
    if (Date.now() > end) throw new Error(`still running after ${seconds} s (${what}): ${pids.filter(alive)}`);
    await pause(100);
  }
}

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-endhelper-keeper-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly childFile = pathOf(this.dir, 'child.pid');
  readonly gate = pathOf(this.dir, 'bg.gate');
  readonly aibs: Aib[] = [];
  readonly swarms: Swarm[] = [];

  constructor() {
    setSwarmEnabled(this.state, true);
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
  }

  aib(): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    aib.ownerProbe = () => null;
    aib.agentLaunch = () => Promise.resolve([['unused'], {}]);
    aib.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(
        [NODE, UNIQUE, '--models', '--held-turn', '--not-claude', ...(provider === 'codex' ? ['--child-pid-file', this.childFile] : [])],
        cwd,
        provider,
        options ?? {},
      );
    this.aibs.push(aib);
    return aib;
  }

  swarm(aib: Aib): Swarm {
    const swarm = new Swarm({ stateDir: this.state, host: aib, settings: aib.settings });
    swarm.openMs = 30_000;
    this.swarms.push(swarm);
    return swarm;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.swarms) await s.stopWatching().catch(() => {});
    try {
      Deno.writeTextFileSync(this.gate, 'x');
    } catch { /* gone */ }
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
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

/** A main chat starts a helper; its brief turn ends. */
async function start(aib: Aib, swarm: Swarm, lab: Lab) {
  const main = await aib.connect('claude', lab.project, null, { ownCopy: true });
  const [, out] = await swarm.tool(main.id, 'start_helper', BRIEF);
  const id = String((out as Json).helper);
  await until(() => swarm.registry.get(id)?.state === 'working', 'the helper working', 30);
  const helper = aib.connections.get(swarm.registry.get(id)!.chat.live)!;
  await until(() => !helper.busy, 'the brief turn ended', 15);
  return { id, main, helper };
}

Deno.test({
  ...T,
  name: "end helper (real keeper): a merged helper's channel is removed and its agent, shell and child process are gone",
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const aib = lab.aib();
    const swarm = lab.swarm(aib);
    const { id, main, helper } = await start(aib, swarm, lab);
    assert(helper.channel !== null, 'the helper runs in the keeper');
    const h = swarm.registry.get(id)!;
    commit(h.worktree.path, 'test/login/a.test.txt', 'fixed\n', 'fix the login tests');
    await swarm.poll();
    await until(() => swarm.registry.get(id)?.state === 'done', 'done', 15);
    await helper.prompt(`bgshell:${lab.gate}`, 'swarm-test-bg');
    await until(() => exists(lab.childFile + '.shell'), 'the background shell', 10);
    const pids = [Number(Deno.readTextFileSync(lab.childFile)), Number(Deno.readTextFileSync(lab.childFile + '.shell')), helper.process!.pid];
    assert(pids.every(alive), `all run: ${pids}`);
    await until(() => !helper.busy, 'idle', 10);
    const client = (await aib.keeper!.client(false))!;
    const channels = async () => (await client.list()).map((c) => c.channel);
    assert((await channels()).includes(`chat-${helper.id}`));
    const merged = await swarm.tool(main.id, 'merge_helper', { helper: id });
    assertEquals((merged[1] as Json).state, 'merged', JSON.stringify(merged[1]));
    await swarm.poll();
    await gone(pids, 'the helper, its shell and its child process');
    await until(async () => !(await channels()).includes(`chat-${helper.id}`), 'the channel removed', 10);
    assert(!!swarm.registry.get(id)?.ended);
    assert(alive(main.process!.pid), "the main chat's agent still runs");
  },
});

Deno.test({
  ...T,
  name: 'end helper (real keeper): quit keeps a working helper; after the take-over it is not ended while its turn runs, then it is',
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const swarmA = lab.swarm(a);
    const { id, helper } = await start(a, swarmA, lab);
    const h = swarmA.registry.get(id)!;
    commit(h.worktree.path, 'test/login/a.test.txt', 'fixed\n', 'fix the login tests');
    await helper.prompt(`gate:${lab.gate}`, 'swarm-test-run'); // a turn that runs until the gate file exists
    await until(() => helper.busy, 'the helper works');
    const agent = helper.process!.pid;
    swarmA.endIdleMs = 0;
    await swarmA.poll();
    assert(!helper.closed, 'working: left alone');
    assertEquals(await a.release(), 2, 'quitting AIB keeps both chats running in the keeper'); // the main chat and the helper
    lab.aibs.splice(lab.aibs.indexOf(a), 1);
    assert(alive(agent), 'the helper keeps running after the quit');
    const b = lab.aib();
    assertEquals(await b.adoptKeeper(), 2);
    const swarmB = lab.swarm(b);
    swarmB.endIdleMs = 0;
    for (let i = 0; i < 3; i++) await swarmB.poll();
    const r = b.connections.get(helper.id)!;
    assert(!r.closed && alive(agent) && !swarmB.registry.get(id)?.ended, 'still working after the take-over: not ended');
    Deno.writeTextFileSync(lab.gate, 'x');
    await until(() => !r.busy, 'the turn ended', 15);
    await until(async () => (await swarmB.poll(), !!swarmB.registry.get(id)?.ended), 'ended once done and idle', 20);
    await gone([agent], 'the helper agent');
  },
});
