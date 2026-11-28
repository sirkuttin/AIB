/**
 * Per-project tool servers inside AIB (toolservers/*, host/aib_toolservers.ts), over a real keeper (built from keeper/ with Go) and the
 * fake ACP agent (work/fake_acp.mjs, which logs what AIB sends it), temp state and a temp Claude config folder. Headless.
 *   - a NEW project's first chat starts with servers that run on this PC off and remote ones on (the owner's default): its session/new
 *     carries deniedMcpServers for the local one only; a project that already was one of AIB's has no entry and loads everything
 *   - a change through the section's call ({op: 'set'}) reaches the next chat at once, and an open idle chat restarts itself ("stale"
 *     reason `servers`), once, with the chat line "Restarted to load this project's tool servers: rea on"; no loop afterwards
 *   - a single tool off becomes a permissions.deny rule in the same session settings
 *   - the view the page draws: AIB's tools first and locked, kinds, where each comes from, memory marked as an estimate until measured,
 *     the open chats that still run the older list
 *   - a chat that is mid-turn is left alone until it is idle
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { testHomeEnv } from '../../app/server/acp/launch_env.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-toolservers-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly log = this.dir + SEP + 'agent-received.log';
  readonly aibs: Aib[] = [];

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
    // The user's Claude config. Under test AIB reads the agents' folders only inside the throwaway home a real agent gets (never the
    // owner's): one server that runs on this PC (rea), one remote (github), one claude.ai connector.
    const claude = testHomeEnv([Deno.execPath()]).CLAUDE_CONFIG_DIR;
    Deno.mkdirSync(claude, { recursive: true });
    Deno.writeTextFileSync(
      claude + SEP + '.claude.json',
      JSON.stringify({
        mcpServers: {
          rea: { type: 'stdio', command: 'node', args: ['rea.js'] },
          github: { type: 'http', url: 'https://example.invalid/mcp' },
        },
        claudeAiMcpEverConnected: ['claude.ai Gmail'],
      }),
    );
  }

  aib(): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, {
      keeper,
    });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (_command, cwd, provider, options) =>
      new Connection(fake('--cancel-aware', '--held-turn', '--not-claude'), cwd, provider, { ...options, env: { FAKE_ACP_LOG: this.log } });
    this.aibs.push(aib);
    return aib;
  }

  /** What the agent received, by method. */
  received(method: string): Json[] {
    try {
      return Deno.readTextFileSync(this.log).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((m) =>
        m.method === method
      );
    } catch {
      return [];
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
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

const settingsOf = (message: Json): Json => {
  const params = message.params as Json;
  const meta = (params._meta ?? {}) as Json;
  const code = (meta.claudeCode ?? {}) as Json;
  const options = (code.options ?? {}) as Json;
  return (options.settings ?? {}) as Json;
};
const denied = (message: Json) => ((settingsOf(message).deniedMcpServers ?? []) as Json[]).map((d) => String(d.serverName)).sort();
const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));

Deno.test({
  name: "tool servers: a new project starts with this PC's servers off; a change restarts an idle chat once, with its line",
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await a.connect('claude', lab.work);
    await c.prompt('hello', 'm-1');
    await until(() => !c.busy, 'the first turn ends');

    // the new project's default: rea (stdio) off, github and the claude.ai connector (remote) on
    assertEquals(
      lab.received('session/new').map(denied),
      [['rea']],
      "only the server that runs on this PC is denied in the new chat's session",
    );
    assertEquals(a.staleWhy(c), [], 'a chat launched with the project list is fresh');
    const first = await a.$toolServersCall({ op: 'view', path: lab.work, chats: [c.id] });
    const view = first as { servers: Json[]; stale: string[]; summary: Json };
    assertEquals(
      view.servers.map((s) => s.id),
      ['studio_artifact', 'claude.ai Gmail', 'github', 'rea'],
      "AIB's tools first and locked, then the others by name",
    );
    assertEquals(view.servers.map((s) => s.on), [true, true, true, false]);
    assertEquals(view.servers[0].locked, true);
    assertEquals(view.servers.map((s) => s.kind), ['local', 'remote', 'remote', 'local']);
    assertEquals(view.stale, [], 'no open chat runs an older list');
    assertEquals((view.servers[3].memory as Json).measured, false, 'a server that never ran in a chat is an estimate');
    assertEquals(view.summary.estimate, true);

    // turn rea on: new chats get it at once, the open idle chat restarts itself once
    const after = await a.$toolServersCall({ op: 'set', path: lab.work, server: 'rea', on: true, chats: [c.id] }) as { stale: string[] };
    assertEquals(after.stale, [c.id], 'the open chat still runs the older list: the apply line names it');
    assertEquals(a.staleWhy(c), ['servers']);
    assertEquals(await a.staleScan(), [c.id], 'the scan restarts the idle chat');
    const next = a.connections.get(c.id)!;
    assert(next !== c && c.closed && next.ready, 'the same chat id, a new connection');
    assertEquals(notes(next).filter((n) => n.startsWith('Restarted to load')), ["Restarted to load this project's tool servers: rea on"]);
    const loads = lab.received('session/load');
    assertEquals(loads.map(denied), [[]], 'the restarted session denies nothing: rea runs again');
    assertEquals(a.staleWhy(next), [], 'fresh after the restart');
    assertEquals(await a.staleScan(), [], 'no loop');

    // one tool off: a permission deny rule in the session settings, not a server switch
    await a.$toolServersCall({ op: 'set', path: lab.work, server: 'rea', tool: 'decompile_all', toolOn: false });
    assertEquals(a.staleWhy(next), ['servers']);
    assertEquals(await a.staleScan(), [next.id]);
    const last = lab.received('session/load').at(-1)!;
    assertEquals(denied(last), []);
    assertEquals((settingsOf(last).permissions as Json).deny, ['mcp__rea__decompile_all']);
    assertEquals(notes(a.connections.get(c.id)!).at(-1), "Restarted to load this project's tool servers: rea: 1 tool off");
  },
});

Deno.test({
  name: "tool servers: a project that already was one of AIB's keeps loading everything; the New projects list is its own page",
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const { path } = { path: lab.work };
    // an existing project: the folder is already shown by AIB, so it has no entry and nothing is denied
    a.addedProjects!.shows = () => true;
    const c = await a.connect('claude', path);
    await c.prompt('hello', 'm-1');
    await until(() => !c.busy, 'the turn ends');
    assertEquals(lab.received('session/new').map(denied), [[]], 'no entry: every server loads, as before this feature');
    // the New projects page: servers on this PC off by default, one switch changes what the next new project starts with
    const rule = await a.$toolServersCall({ op: 'view', path: '_new' }) as { rule: Json; servers: Json[] };
    assertEquals(rule.rule.offLocal, true);
    assertEquals(rule.servers.filter((s) => s.id === 'rea').map((s) => s.on), [false]);
    const changed = await a.$toolServersCall({ op: 'set', path: '_new', server: 'rea', on: true }) as { servers: Json[] };
    assertEquals(changed.servers.filter((s) => s.id === 'rea').map((s) => s.on), [true]);
    assertEquals(
      a.toolServers!.store.choice(a.toolServers!.keyOf(path)),
      null,
      'an existing project is not touched by the New projects list',
    );
  },
});

Deno.test({
  name: 'tool servers: a chat that is mid-turn is left alone until it is idle',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await a.connect('claude', lab.work);
    await c.prompt('hello', 'm-1');
    await until(() => !c.busy, 'the first turn ends');
    const gate = lab.dir + SEP + 'gate';
    void c.prompt(`gate:${gate}`, 'm-gate').catch(() => {});
    await until(() => c.busy, 'the turn runs');
    await a.$toolServersCall({ op: 'set', path: lab.work, server: 'rea', on: true });
    assertEquals(await a.staleScan(), [], 'mid-turn: left alone');
    Deno.writeTextFileSync(gate, 'go');
    await until(() => !c.busy, 'the turn ends');
    assertEquals(await a.staleScan(), [c.id], 'idle: restarted');
  },
});
