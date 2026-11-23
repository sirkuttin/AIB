/**
 * WSL audit (docs/wsl/audit-beta10.md), Group A: the per-chat history store, the recovery list and the startup reconnect for a WSL
 * chat, against a FakeWslHost (a real keeper standing in for the distro's Linux keeper, the fake ACP agent, temp folders only).
 *   - a WSL chat in the distro's keeper writes its history to <state>/history/<id>.sqlite (keyed by chat id, never by its ref);
 *   - a crashed AIB's next process rebuilds the chat from the distro's keeper and the store: its earlier turn is still on the page;
 *   - the recovery list keeps the ref (cwd and projectRoot), and the next AIB's automatic reconnect reopens it in the distro
 *     (session/load with the Linux folder) when its agent no longer runs;
 *   - the page's older-pages query (liveEvents before=) answers from the store for a rebuilt WSL chat.
 * Never a real distro, never the owner's homes.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { KeeperClient, keeperBinary, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';
Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-audit');

class WslLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-audit-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'app';
  readonly agentLog = this.dir + SEP + 'agent-received.log';
  readonly host: FakeWslHost;
  readonly studios: Studio[] = [];

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu', { FAKE_ACP_LOG: this.agentLog });
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }

  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware', '--breadth'), cwd, provider, { ...options, wsl });
    };
    this.studios.push(studio);
    return studio;
  }

  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    this.host.link.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1);
    this.host.renewLink();
  }

  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.agentLog).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    await this.host.stopKeeper();
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

function said(c: Connection): string {
  return c.events.filter((e) => e.kind === 'update').map((e) => {
    const update = (e.data as Json).update as Json;
    return update.sessionUpdate === 'agent_message_chunk' ? String((update.content as Json).text) : '';
  }).join('');
}

async function turn(studio: Studio, c: Connection, id = 'm1'): Promise<void> {
  assertEquals((await studio.liveCall('prompt', { id: c.id, text: 'stream:4:20', clientMessageId: id }))[0], 200);
  await until(() => c.permissions.size === 1, 'the question', 15);
  await studio.liveCall('permission', { id: c.id, key: [...c.permissions.keys()][0], option: 'yes' });
  await until(() => !c.busy, 'turn end', 15);
}

Deno.test({
  name: 'audit wsl history: a WSL chat writes its store by chat id; a rebuilt one keeps its turn and pages older events from the store',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    const c = await a.connect('claude', REF);
    assertEquals(c.historyState === 'off', false, 'a keeper chat in a distro gets the history store too');
    await turn(a, c);
    assertEquals(said(c), 'chunk0 chunk1 answer=yes chunk2 chunk3 ');
    await until(() => c.historyCkpt !== null, 'the quiet-point checkpoint', 30);
    const store = `${lab.state}${SEP}history${SEP}${c.id}.sqlite`;
    assert(Deno.statSync(store).isFile, 'the store file is keyed by chat id in the Windows state folder');
    // nothing named after the ref (a wsl: path used as a Windows file name would be a bug)
    for (const e of Deno.readDirSync(`${lab.state}${SEP}history`)) assert(!/wsl|ubuntu/i.test(e.name), e.name);
    lab.crash(a);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assert(r && r.ready && !r.closed, 'rebuilt');
    assertEquals([r.cwd, r.agentCwd, r.projectRoot], [REF, '/home/u/app', REF]);
    const tail = await b.liveEvents(c.id, {}) as Json;
    const texts = JSON.stringify(tail.events);
    assert(texts.includes('chunk3'), 'the earlier turn is on the rebuilt chat\'s page');
    // a second turn on the rebuilt chat goes through and is stored
    await turn(b, r, 'm2');
    const first = Number(tail.first ?? 1);
    const older = await b.liveEvents(c.id, { before: String(first + 3) }) as Json;
    assert(Array.isArray(older.events), 'an older page answers');
  },
});

Deno.test({
  name: 'audit wsl recovery: the recovery list keeps the ref; the next AIB auto-reconnects the WSL chat in its distro (agent gone)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    const c = await a.connect('claude', REF);
    await turn(a, c);
    const sid = c.sessionId!;
    const saved = [...a.store!.conversations.values()].find((x) => x.sessionId === sid)!;
    assertEquals([saved.cwd, saved.projectRoot], [REF, REF]);
    lab.crash(a);
    await lab.host.stopKeeper(); // the distro's keeper and its agent are gone (a WSL restart)
    lab.host.renewLink();
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 0);
    assertEquals(b.recovered().map((x) => x.cwd), [REF]);
    assertEquals(b.startAutoReconnect(1, 0, 1, 0), 1);
    await until(() => [...b.connections.values()].some((x) => x.sessionId === sid && x.ready), 'reconnected', 30);
    assertEquals([...b.connections.values()].find((x) => x.sessionId === sid)!.id, c.id, 'the same chat id (it goes on in its store)');
    const r = [...b.connections.values()].find((x) => x.sessionId === sid)!;
    assertEquals([r.cwd, r.agentCwd], [REF, '/home/u/app']);
    assert(r.keeper === lab.host.link, 'in the distro keeper');
    const load = lab.received().filter((m) => m.method === 'session/load').at(-1)!;
    assertEquals((load.params as Json).cwd, '/home/u/app');
    // (the interop forwarder entry is a Windows program, so its Windows argument is right; the agent's own folders must be Linux)
    const extra = ((load.params as Json).additionalDirectories ?? []) as string[];
    assert(extra.every((d) => d.startsWith('/')), 'additionalDirectories are Linux paths: ' + JSON.stringify(extra));
    assertEquals(b.reconnectFailed(), []);
  },
});

Deno.test({
  name: 'audit wsl startup: window-first order (Windows take-over, then auto-reconnect) takes the running WSL agent over, never a second one',
  ...T,
  async fn() {
    // main.ts: adoptKeeperWindows() resolves before the distros are asked, and startAutoReconnect() starts then; a WSL chat's
    // reconnect must wait for its distro's take-over (connect -> #wslTakeOverFirst) instead of starting a second agent.
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    const c = await a.connect('claude', REF);
    await turn(a, c);
    const pid = c.process!.pid;
    lab.crash(a);
    const spawnsBefore = lab.host.link.spawned.length;
    const b = lab.studio();
    await b.adoptKeeperWindows();
    b.startAutoReconnect(2, 0, 1, 0);
    await until(() => b.connections.get(c.id)?.ready, 'the chat taken over', 30);
    await b.adoptKeeper();
    await pause(500);
    const live = [...b.connections.values()].filter((x) => x.sessionId === c.sessionId && !x.closed);
    assertEquals(live.length, 1, 'one chat for the session');
    assertEquals(live[0].process!.pid, pid, 'the agent that kept running (not a new one)');
    assertEquals(lab.host.link.spawned.length - spawnsBefore, 0, 'nothing new spawned in the distro keeper');
  },
});

Deno.test({
  name: 'KNOWN-BROKEN: audit wsl discover: "Find more chats via agent" is never answered by a WSL chat\'s Linux agent',
  ...T,
  async fn() {
    // Studio.listAgentSessions picks ANY live chat of the provider (studio.ts:991). With a WSL Claude chat open, the Windows
    // "Find more chats via agent" button asks the agent inside the distro: it lists the distro's sessions (Linux cwds, filtered
    // out by filterSessions as not an added project) and never the Windows ones.
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    await a.connect('claude', REF);
    const [status, payload] = await a.liveCall('discover', { provider: 'claude' });
    const asked = lab.received().filter((m) => m.method === 'session/list');
    assertEquals(asked.length, 0, `the Linux agent was asked for the Windows list (${status} ${JSON.stringify(payload)})`);
  },
});

Deno.test({
  name: 'F4: "Find more chats via agent" for a WSL project asks the running agent in its distro (Linux folder) and lists refs',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    a.connectionFactory = (_command, cwd, provider, options) => { // the fake agent's session/list answers Linux cwds (/fixture/project)
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      return new Connection(fake('--cancel-aware', '--list-sessions'), cwd, provider, { ...options, wsl });
    };
    await a.connect('claude', REF);
    const [status, payload] = await a.liveCall('discover', { provider: 'claude', cwd: REF });
    assertEquals(status, 200);
    const asked = lab.received().filter((m) => m.method === 'session/list');
    assertEquals(asked.length, 1, 'the Linux agent was asked once');
    assertEquals((asked[0].params as Json).cwd, '/home/u/app', 'with the Linux folder, never the ref');
    const p = payload as Json;
    assertEquals(p.via, 'studio-connection');
    assertEquals((p.sessions as Json[]).map((s) => s.cwd), ['wsl://ubuntu/fixture/project', 'wsl://ubuntu/fixture/project']);
    assertEquals(p.nextCursor, 'offset:2');
  },
});

Deno.test({
  name: 'F4: "Find more chats via agent" for a WSL project with no running agent there answers empty with a one-line reason (nothing started)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const a = lab.studio();
    const spawned = lab.host.link.spawned.length;
    const [status, payload] = await a.liveCall('discover', { provider: 'claude', cwd: 'wsl://debian/home/u/app' });
    assertEquals(status, 200);
    const p = payload as Json;
    assertEquals([p.supported, p.sessions, p.via], [true, [], 'none']);
    assert(/Open a Claude Code chat in .+ first/.test(String(p.note)), String(p.note));
    assertEquals(lab.host.link.spawned.length, spawned, 'nothing started in a distro');
    assertEquals(lab.received().filter((m) => m.method === 'session/list').length, 0);
  },
});

Deno.test({
  name: "F8 (not reproduced): a WSL worktree chat's keeper note carries projectRoot = the project ref (what a rebuild files it under)",
  ...T,
  async fn() {
    // Studio.connect sets worktree/projectRoot right after the factory (studio.ts; the `record` path starts the agent at once).
    // The keeper writes the chat note only after its spawn answers (keeper/link.ts spawn: `first` runs after awaits), so the note
    // has the project ref, and a rebuild (studio.ts #rebuildChat: c.projectRoot = note.projectRoot) files the chat under its project.
    await keeperBinary();
    await using lab = new WslLab();
    const WT = '/home/u/.aib-server/data-x/worktrees/app-abc';
    const wtDir = lab.dir + SEP + 'wt';
    Deno.mkdirSync(wtDir);
    lab.host.folders.set(WT, wtDir);
    const a = lab.studio();
    const c = a.connectionFactory(['unused'], 'wsl://ubuntu' + WT, 'claude', {
      keeper: lab.host.link,
      wsl: { distro: 'ubuntu', linuxPath: WT },
      history: a.historyClient(),
    });
    c.worktree = { branch: 'aib/chat-1', base: 'main' };
    c.projectRoot = REF;
    a.connections.set(c.id, c);
    const client = await lab.host.link.check();
    let note: Json | null = null;
    await until(async () => {
      const listed = await client.list();
      const ch = listed.find((x) => x.channel === `chat-${c.id}`);
      note = ch ? await lab.host.link.firstNote(client, ch.channel) as Json | null : null;
      return note;
    }, 'the chat note in the distro keeper', 20);
    const n = note as unknown as Json;
    assertEquals([n.cwd, n.projectRoot, (n.worktree as Json).branch], ['wsl://ubuntu' + WT, REF, 'aib/chat-1']);
  },
});
