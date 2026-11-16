/**
 * Allow rules in a WSL chat through Studio, Connection and the keeper (FakeWslHost lab, fake ACP agent; audit F1, F3, F6): the agent
 * asks to edit files with absolute Linux paths, AIB fetches the distro facts (the fake helper's `allow.facts` over the mapped temp
 * folder), offers "Always allow", saves an edit rule keyed by the project's ref, answers the next edit itself, asks for an edit
 * outside the project, answers `git status` with the built-in Safe reads, and the sweep answers another WSL chat's waiting card.
 * Temp folders only; never a real distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, pause, PYTHON, until } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { setWslHostResolver } from '../../outputs/agent-studio/server/wsl/access.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';
Deno.env.set('AIB_WSL_ROOT', '/tmp/aib-wsl-test-allowchat');

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-allow-wsl-chat-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'app';
  readonly host: FakeWslHost;
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.work + SEP + 'src', { recursive: true });
    Deno.mkdirSync(this.dir + SEP + 'other', { recursive: true });
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu', {});
    this.host.folders.set('/home/u/app', this.work);
    this.host.folders.set('/home/u/other', this.dir + SEP + 'other');
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
  }
  studio(): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      // every agent names its session differently (two chats of one project at once)
      return new Connection([PYTHON, FAKE.replace(/fake_acp\.py$/, 'fake_acp_unique.py'), '--cancel-aware'], cwd, provider, {
        ...options,
        wsl,
      });
    };
    this.studios.push(studio);
    return studio;
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

const said = (c: Connection) =>
  c.events.filter((e) => e.kind === 'update').map((e) => {
    const u = (e.data as Json).update as Json;
    return u.sessionUpdate === 'agent_message_chunk' ? String((u.content as Json).text) : '';
  }).join('');
const autos = (c: Connection) => c.events.filter((e) => e.kind === 'permission_auto').map((e) => (e.data as Json).label);
const card = (c: Connection) => ((c.public() as Json).permissions as Json[])[0];

Deno.test({
  name: 'allow wsl chat: Always allow on an edit in a WSL chat, the next edit answered by the rule, outside asks, git status answered',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const studio = lab.studio();
    studio.allow!.store.setEnabled(true);
    const c = await studio.connect('claude', REF);
    assertEquals([c.cwd, c.agentCwd], [REF, '/home/u/app']);

    await studio.liveCall('prompt', { id: c.id, text: 'allowedit:/home/u/app/src/main.ts', clientMessageId: 'm1' });
    await until(() => c.permissions.size === 1, 'the edit card', 10);
    const first = card(c);
    const project = (first.allow as Json).project as Json;
    assertEquals([project.available, project.hideAgentAlways], [true, true], JSON.stringify(project));
    const [status, saved] = await studio.liveCall('allow-answer', { id: c.id, key: first.key, option: 'yes', scope: 'project' });
    assertEquals(status, 200, JSON.stringify(saved));
    assertEquals(((saved as Json).rules as Json[])[0].project, REF, 'keyed by the ref (F3)');
    await until(() => !c.busy, 'turn end', 10);

    await studio.liveCall('prompt', { id: c.id, text: 'allowedit:/home/u/app/src/b.ts', clientMessageId: 'm2' });
    await until(() => said(c).includes('allow outcome=yes;allow outcome=yes;'), 'answered by the rule', 10);
    await until(() => !c.busy, 'turn end', 10);
    assertEquals(c.permissions.size, 0);
    assertEquals(autos(c), ['Edits in src/']);

    await studio.liveCall('prompt', { id: c.id, text: 'allowedit:/home/u/other/x.ts', clientMessageId: 'm3' });
    await until(() => c.permissions.size === 1, 'outside the project asks', 10);
    const out = (card(c).allow as Json).project as Json;
    assertEquals(out.reason, 'Not available: AIB never auto-allows files outside the project.');
    await studio.liveCall('permission', { id: c.id, key: card(c).key, option: 'no' });
    await until(() => !c.busy, 'turn end', 10);

    await studio.liveCall('prompt', { id: c.id, text: 'allow:git status', clientMessageId: 'm4' });
    await until(() => autos(c).length === 2, 'Safe reads', 10);
    assertEquals(autos(c)[1], 'Safe reads');
    assert(lab.host.calls.some(([m]) => m === 'allow.facts'), 'the facts came from the helper');
  },
});

Deno.test({
  name: 'allow wsl chat: saving a project rule answers a waiting card of another WSL chat in the same project (sweep)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const studio = lab.studio();
    studio.allow!.store.setEnabled(true);
    const a = await studio.connect('claude', REF);
    const b = await studio.connect('claude', REF);
    await studio.liveCall('prompt', { id: b.id, text: 'allowedit:/home/u/app/src/deep/y.ts', clientMessageId: 'b1' });
    await until(() => b.permissions.size === 1, 'b waits', 10);
    await studio.liveCall('prompt', { id: a.id, text: 'allowedit:/home/u/app/x.ts', clientMessageId: 'a1' });
    await until(() => a.permissions.size === 1, 'a waits', 10);
    const [status, saved] = await studio.liveCall('allow-answer', { id: a.id, key: card(a).key, option: 'yes', scope: 'project' });
    assertEquals(status, 200, JSON.stringify(saved));
    assertEquals((saved as Json).alsoAllowed, 1);
    await until(() => said(b).includes('allow outcome=yes;'), 'b answered by the new rule', 10);
  },
});
