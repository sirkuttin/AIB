/**
 * Allow rules end to end (server/allow, host Studio, keeper, fake ACP agent): a safe read is answered by AIB with the agent's
 * allow-once and a "permission_auto" line; a card offers AIB's Always choice (the agent's own always hidden, decision 2a); answer +
 * rule in one call; the next matching request is answered by the rule; a floor item is greyed out; a rebuilt chat (keeper replay)
 * shows the same lines and never answers again. Real keeper (built from keeper/ with Go), temp state folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, fake, pause, PYTHON, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { KeeperLink } from '../../outputs/agent-studio/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../outputs/agent-studio/server/keeper/client.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class AllowLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-allow-e2e-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly agentLog = this.dir + SEP + 'agent-received.log';
  readonly studios: Studio[] = [];

  constructor() {
    Deno.mkdirSync(this.work + SEP + 'src', { recursive: true });
    Deno.writeTextFileSync(this.work + SEP + 'src' + SEP + 'a.js', 'x\n');
  }

  studio(unique = false): Studio {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const studio = new Studio({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(
        unique ? [PYTHON, FAKE.replace(/fake_acp\.py$/, 'fake_acp_unique.py'), '--cancel-aware'] : fake('--cancel-aware'),
        cwd,
        provider,
        { ...options, env: { FAKE_ACP_LOG: this.agentLog } },
      );
    this.studios.push(studio);
    return studio;
  }

  crash(studio: Studio): void {
    studio.keeper!.disconnect();
    for (const c of studio.connections.values()) c.sessionLease?.release();
    studio.reconnectStop.set();
    this.studios.splice(this.studios.indexOf(studio), 1);
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
const kinds = (c: Connection, kind: string) => c.events.filter((e) => e.kind === kind);
const answersTo = (lines: Json[], id: string) => lines.filter((m) => m.id === id && !m.method);

Deno.test({
  name:
    'allow rules e2e: safe read auto-allowed, Always on a card, next request allowed by the rule, floor greyed, replay never re-answers',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new AllowLab();
    const a = lab.studio();
    const c = await a.connect('claude', lab.work);
    assert(c.scratchDir && !c.scratchDir.startsWith(lab.work), 'scratch folder outside the chat folder');

    // 1. A safe read: AIB answers with the agent's allow-once; no card, one green line.
    await a.liveCall('prompt', { id: c.id, text: 'allow:ls src', clientMessageId: 'm1' });
    await until(() => said(c).includes('allow outcome=yes;'), 'auto-allowed', 10);
    await until(() => !c.busy, 'turn end', 10);
    assertEquals(kinds(c, 'permission').length, 0);
    assertEquals(kinds(c, 'permission_auto').map((e) => (e.data as Json).label), ['Safe reads']);

    // 2. npm test: a card with AIB's Always choice; the agent's own always is to be hidden (2a).
    await a.liveCall('prompt', { id: c.id, text: 'allow:npm test', clientMessageId: 'm2' });
    await until(() => c.permissions.size === 1, 'the npm test card', 10);
    const card = (c.public() as Json).permissions as Json[];
    const allow = card[0].allow as Json;
    const project = allow.project as Json;
    assert(project.available === true && project.hideAgentAlways === true, JSON.stringify(allow));
    assert(String(project.preview).includes('npm test'), String(project.preview));
    const key = card[0].key as string;
    const [status, saved] = await a.liveCall('allow-answer', { id: c.id, key, option: 'yes', scope: 'project' });
    assertEquals(status, 200, JSON.stringify(saved));
    assertEquals(((saved as Json).rules as Json[])[0].label, 'npm test');
    await until(() => said(c).split('allow outcome=yes;').length === 3, 'answered yes', 10);
    await until(() => !c.busy, 'turn end', 10);
    // the agent-only always option can't be sent with the Always tick
    assertEquals((await a.liveCall('allow-rules', {}))[0], 200);

    // 3. The next npm test is answered by the rule.
    await a.liveCall('prompt', { id: c.id, text: 'allow:npm test', clientMessageId: 'm3' });
    await until(() => said(c).split('allow outcome=yes;').length === 4, 'allowed by the rule', 10);
    await until(() => !c.busy, 'turn end', 10);
    assertEquals(kinds(c, 'permission_auto').map((e) => (e.data as Json).label), ['Safe reads', 'npm test']);

    // 4. A floor item: Always greyed out, with the reason.
    await a.liveCall('prompt', { id: c.id, text: 'allow:git push -f origin feature/x', clientMessageId: 'm4' });
    await until(() => c.permissions.size === 1, 'the push card', 10);
    const push = (((c.public() as Json).permissions as Json[])[0].allow as Json).project as Json;
    assert(push.available === false && push.floor === true && String(push.reason).includes('force-push'), JSON.stringify(push));
    const pushKey = [...c.permissions.keys()][0];
    const refused = await a.liveCall('allow-answer', { id: c.id, key: pushKey, option: 'yes', scope: 'project' });
    assertEquals(refused[0], 400);
    c.permission(pushKey, 'no');
    await until(() => !c.busy, 'turn end', 10);
    const before = c.events.map((e) => e.kind).join(',');

    // 5. Keeper replay on a new Studio: the same lines and events, and no request is answered twice.
    lab.crash(a);
    await pause(300);
    const b = lab.studio();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assert(r && r.ready && r.rebuildError === '', 'rebuilt');
    assertEquals(r.events.map((e) => e.kind).join(','), before);
    assertEquals(kinds(r, 'permission_auto').length, 2);
    assertEquals(r.permissions.size, 0);
    await pause(300);
    const got = lab.received();
    for (const id of ['allow-1', 'allow-2', 'allow-3', 'allow-4']) assertEquals(answersTo(got, id).length, 1, id);
  },
});

Deno.test({
  name: 'allow rules e2e: rules file edited outside AIB switches rules off (cards come back) until reviewed',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new AllowLab();
    const a = lab.studio();
    const c = await a.connect('claude', lab.work);
    const file = lab.state + SEP + 'allow-rules.json';
    await a.liveCall('allow-enable', { on: true });
    Deno.writeTextFileSync(file, Deno.readTextFileSync(file).replace('"enabled": true', '"enabled": true '));
    Deno.utimeSync(file, new Date(), new Date(Date.now() + 5000));
    await a.liveCall('prompt', { id: c.id, text: 'allow:ls src', clientMessageId: 'm1' });
    await until(() => c.permissions.size === 1, 'a card: rules are off', 10);
    const pub = (await a.liveCall('allow-rules', {}))[1] as Json;
    assert(pub.tampered === true);
    assert(a.liveListSync().allowRulesTampered === true, 'the page list carries the banner flag');
    const off = (((c.public() as Json).permissions as Json[])[0].allow as Json).off as string;
    assert(off.includes('changed outside AIB'), off);
    c.permission([...c.permissions.keys()][0], 'yes');
    await until(() => !c.busy, 'turn end', 10);
    await a.liveCall('allow-review', {});
    assertEquals(a.liveListSync().allowRulesTampered, false);
    await a.liveCall('prompt', { id: c.id, text: 'allow:ls src', clientMessageId: 'm2' });
    await until(() => kinds(c, 'permission_auto').length === 1, 'allowed again after review', 10);
  },
});

Deno.test({
  name: 'allow rules e2e: saving a rule answers the other waiting cards it covers (another chat in the project)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new AllowLab();
    const a = lab.studio(true);
    a.settings.worktreePerChat = () => false;
    const c1 = await a.connect('claude', lab.work);
    const c2 = await a.connect('claude', lab.work);
    await a.liveCall('prompt', { id: c1.id, text: 'allow:npm run lint', clientMessageId: 'm1' });
    await a.liveCall('prompt', { id: c2.id, text: 'allow:npm run lint', clientMessageId: 'm2' });
    await until(() => c1.permissions.size === 1 && c2.permissions.size === 1, 'two waiting cards', 10);
    const key = [...c1.permissions.keys()][0];
    const [status, saved] = await a.liveCall('allow-answer', { id: c1.id, key, option: 'yes', scope: 'project' });
    assertEquals(status, 200, JSON.stringify(saved));
    assertEquals((saved as Json).alsoAllowed, 1);
    await until(() => said(c2).includes('allow outcome=yes;'), 'the other card answered', 10);
    assertEquals(c2.permissions.size, 0);
    assertEquals(kinds(c2, 'permission_auto').map((e) => (e.data as Json).label), ['npm run lint']);
    await until(() => !c1.busy && !c2.busy, 'both turns ended', 10);
    // the same card answered again (a phone first): "save anyway?" instead of a silent save
    await a.liveCall('prompt', { id: c1.id, text: 'allow:git commit -m x', clientMessageId: 'm3' });
    await until(() => c1.permissions.size === 1, 'the commit card', 10);
    const k2 = [...c1.permissions.keys()][0];
    c1.public(); // the page has seen the card (its draft is kept for "save anyway")
    c1.permission(k2, 'yes'); // answered elsewhere first
    const late = await a.liveCall('allow-answer', { id: c1.id, key: k2, option: 'yes', scope: 'project' });
    assertEquals(late[0], 409);
    assertEquals((late[1] as Json).code, 'answered_elsewhere');
    const anyway = await a.liveCall('allow-answer', { id: c1.id, key: k2, scope: 'project', saveOnly: true });
    assertEquals(anyway[0], 200, JSON.stringify(anyway[1]));
  },
});
