/**
 * 0.15 slice 3: a chat that was served other AIB tools or another AIB prompt than this AIB would serve now (an update) restarts
 * itself when it is idle, through the existing Continue path (same chat id, history, queue, helper links). Real keeper (built from
 * keeper/ with Go), fake ACP agent (work/fake_acp.py), temp state folders. Headless.
 *   - a stale idle chat restarts once and keeps id, history, queue and helper links; "Restarted to pick up new AIB tools" follows
 *   - a mid-turn chat does not restart, and does once it is idle
 *   - a chat with a background process does not restart
 *   - a queued message triggers restart-then-send (the restart is in the agent's log before the message)
 *   - a failed reload leaves the chat reopenable and shows the error; it is not tried again by this version
 *   - no restart loop (one try per app version, and none after a fresh list)
 *   - Maki's hyphenated tool names are AIB's own tools (no approval asked)
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, PYTHON, pause, until } from './_connection.ts';
import { Connection, ownToolName } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { keeperBinary, KeeperClient, readKeeperInfo } from '../../app/server/keeper/client.ts';
import { pidAlive } from '../../app/server/host/host_client.ts';
import * as artifactKeys from '../../app/server/artifacts/keys.ts';
import { staleReasons, toolsHash } from '../../app/server/artifacts/served.ts';
import { toolNames } from '../../app/server/artifacts/mcp.ts';
import { Registry, readHelpers } from '../../app/server/swarm/registry.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-stale-restart-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'work';
  readonly log = this.dir + SEP + 'agent-received.log';
  readonly aibs: Aib[] = [];
  /** Flags of the fake agent for the next agents started, one entry per start (the last repeats). */
  flags: string[][] = [['--cancel-aware', '--held-turn', '--not-claude']];
  started = 0;

  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }

  aib(): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, { keeper });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (_command, cwd, provider, options) => {
      const flags = this.flags[Math.min(this.started++, this.flags.length - 1)];
      const command = flags[0] === '!die' ? [PYTHON, '-c', 'raise SystemExit(3)'] : fake(...flags); // '!die': an agent that exits at once
      return new Connection(command, cwd, provider, { ...options, env: { FAKE_ACP_LOG: this.log } });
    };
    this.aibs.push(aib);
    return aib;
  }

  received(): Json[] {
    try {
      return Deno.readTextFileSync(this.log).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
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

/** One tools/list for a chat, asked of this AIB's artifact server the way the keeper forwarder asks (this records what was served). */
async function list(aib: Aib, id: string): Promise<string[]> {
  const key = artifactKeys.issue(id)!;
  const answer = await aib.artifactMcpHttp().tunneled(key, id, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
  assertEquals(answer.status, 200);
  return (((JSON.parse(answer.body).result as Json).tools) as Json[]).map((t) => String(t.name));
}

/** The chat as an update leaves it: it was served another tool list than this AIB serves now. */
function makeStale(aib: Aib, id: string): void {
  aib.served!.tools(id, ['publish', 'update', 'list']);
}

/** A chat that has been served the current list, has talked, and works in the project folder. */
async function openChat(lab: Lab, aib: Aib): Promise<Connection> {
  const c = await aib.connect('claude', lab.work);
  await list(aib, c.id);
  await c.prompt('hello before the restart', 'm-hello');
  await until(() => !c.busy, 'the first turn ends');
  return c;
}

const said = (c: Connection) =>
  c.events.filter((e) => e.kind === 'update').map((e) => JSON.stringify((e.data as Json).update)).join('\n');
const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));
const methods = (lines: Json[]) => lines.map((m) => String(m.method ?? ''));

Deno.test({
  name: 'stale chat: an idle stale chat restarts once and keeps its id, history, queue and helper links',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await openChat(lab, a);
    assertEquals(a.staleWhy(c), [], 'a chat served the current list is fresh');
    const sessionId = c.sessionId!;
    // what must survive: a scheduled message, a helper of this chat
    await c.scheduleAdd('later today', Date.now() + 3_600_000, 'sched-1');
    const registry = new Registry(lab.state);
    await registry.update('h_stale001', () =>
      <never> {
        id: 'h_stale001', title: 'A helper', project: lab.work, parent: { live: c.id, lasting: `claude:${sessionId}` },
        chat: { live: '', lasting: '', provider: 'claude', model: '', mode: '' }, state: 'working', reason: '', createdAt: 1,
        worktree: { path: lab.work, branch: 'b', base: 'main', start: 'x' }, brief: { title: 'A helper' }, picked_by: 'main agent', rule: '', why: '',
      });
    makeStale(a, c.id);
    assertEquals(a.staleWhy(c), ['tools'], 'another list was served: stale');

    assertEquals(await a.staleScan(), [c.id], 'the scan restarts it');
    const next = a.connections.get(c.id)!;
    assert(next !== c && c.closed && !next.closed && next.ready, 'the old connection is replaced by a ready one under the same id');
    assertEquals(next.id, c.id);
    assertEquals(next.sessionId, sessionId, 'the same conversation');
    assert(said(next).includes('hello before the restart') || next.events.some((e) => JSON.stringify(e.data).includes('hello before the restart')), 'the history stays');
    assertEquals(next.queue.scheduled.map((i) => i.text), ['later today'], 'the scheduled message stays');
    assertEquals(readHelpers(lab.state)['h_stale001'].parent.live, next.id, 'the helper link stays');
    assertEquals(next.swarm?.role, 'main');
    assertEquals(notes(next).filter((n) => n === 'Restarted to pick up new AIB tools').length, 1, 'one plain line says so');
    assert(methods(lab.received()).includes('session/load'), 'it went through session/load (Continue)');

    // no loop: the new agent asks for its list (fresh now); a later difference is not retried by this app version
    await list(a, next.id);
    assertEquals(a.staleWhy(next), []);
    assertEquals(await a.staleScan(), []);
    makeStale(a, next.id);
    assertEquals(await a.staleScan(), [], 'one try per app version, never a loop');
    assertEquals(a.connections.get(c.id), next);
    assertEquals(methods(lab.received()).filter((m) => m === 'session/load').length, 1);
  },
});

Deno.test({
  name: 'stale chat: a mid-turn chat does not restart, and does once it is idle',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await openChat(lab, a);
    const gate = lab.dir + SEP + 'gate';
    void c.prompt(`gate:${gate}`, 'm-gate').catch(() => {});
    await until(() => c.busy, 'the turn runs');
    makeStale(a, c.id);
    assertEquals(await a.staleScan(), [], 'mid-turn: left alone');
    assert(a.connections.get(c.id) === c && !c.closed);
    Deno.writeTextFileSync(gate, 'go');
    await until(() => !c.busy, 'the turn ends');
    assertEquals(await a.staleScan(), [c.id], 'idle: restarted');
    assert(a.connections.get(c.id)!.ready);
  },
});

Deno.test({
  name: 'stale chat: a pending approval counts as mid-turn and blocks; a waiting queued message does not',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    lab.flags = [['--cancel-aware', '--held-turn', '--not-claude']];
    const a = lab.aib();
    const c = await openChat(lab, a);
    void c.prompt('approve', 'm-approve').catch(() => {});
    await until(() => c.permissions.size > 0, 'an approval is pending');
    makeStale(a, c.id);
    assertEquals(c.restartBlocker(), 'mid-turn');
    assertEquals(await a.staleScan(), []);
    const [key, pending] = [...c.permissions.entries()][0];
    c.permission(key, ((pending.params as Json).options as Json[])[0].optionId);
    await until(() => !c.busy, 'the turn ends');
    assertEquals(c.restartBlocker(), '');
  },
});

Deno.test({
  name: 'stale chat: a chat with a background process running does not restart',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await openChat(lab, a);
    makeStale(a, c.id);
    let running = true;
    c.backgroundShellsRunning = () => running; // what Claude Code's run_in_background shell looks like to the chat
    assertEquals(c.restartBlocker(), 'background process');
    assertEquals(await a.staleScan(), []);
    assert(a.connections.get(c.id) === c && !c.closed);
    running = false;
    assertEquals(await a.staleScan(), [c.id]);
  },
});

Deno.test({
  name: 'stale chat: a queued message restarts first, then sends (restart is in the agent log before the message)',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await openChat(lab, a);
    const gate = lab.dir + SEP + 'gate2';
    void c.prompt(`gate:${gate}`, 'm-gate').catch(() => {});
    await until(() => c.busy, 'the turn runs');
    await c.queueAdd('send me after the restart', 'q-1');
    assertEquals(c.queue.items.length, 1);
    makeStale(a, c.id);
    Deno.writeTextFileSync(gate, 'go'); // the turn ends; the queue pump asks AIB before it sends
    await until(() => a.connections.get(c.id) !== c && !!a.connections.get(c.id)?.ready, 'the chat restarted', 20);
    const next = a.connections.get(c.id)!;
    await until(() => lab.received().some((m) => m.method === 'session/prompt' && JSON.stringify(m).includes('send me after the restart')), 'the message was sent', 20);
    const log = lab.received();
    const load = methods(log).indexOf('session/load');
    const sent = log.findIndex((m) => m.method === 'session/prompt' && JSON.stringify(m).includes('send me after the restart'));
    assert(load >= 0 && sent > load, `session/load (${load}) comes before the queued prompt (${sent})`);
    assertEquals(log.filter((m) => m.method === 'session/prompt' && JSON.stringify(m).includes('send me after the restart')).length, 1, 'sent once');
    assertEquals(next.queue.items.length, 0);
    assert(notes(next).includes('Restarted to pick up new AIB tools'));
  },
});

Deno.test({
  name: 'stale chat: a failed reload leaves the chat reopenable with the error shown, and this version does not try again',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    // the first agent is good; the one the restart starts dies at once; later ones are good
    lab.flags = [['--cancel-aware', '--held-turn', '--not-claude'], ['!die'], ['--cancel-aware', '--held-turn', '--not-claude']];
    const a = lab.aib();
    const c = await openChat(lab, a);
    const sessionId = c.sessionId!;
    makeStale(a, c.id);
    assertEquals(await a.staleScan(), [], 'the restart did not work');
    assert(c.closed && /Couldn't restart to pick up new AIB tools/.test(c.error ?? ''), `the chat says why: ${c.error}`);
    const failed = a.reconnectFailed().find((f) => f.sessionId === sessionId);
    assert(failed && String(failed.error).includes("Couldn't restart"), 'listed as "Couldn\'t reopen" with the error');
    const record = a.served!.get(c.id)!;
    assertEquals(record.restart?.ok, false);
    assert(a.served!.restartTried(c.id));
    assertEquals(await a.staleScan(), [], 'not tried again by this version');
    // reopenable: Continue works and the chat is the same chat with its history
    const again = await a.connect('claude', lab.work, sessionId, { continueAnyway: true });
    assertEquals(again.id, c.id);
    assert(again.ready);
    assert(again.events.some((e) => JSON.stringify(e.data).includes('hello before the restart')), 'history intact');
  },
});

Deno.test({
  name: 'stale chat: an agent that cannot reload sessions is left alone, a helper and a chat with no record are not stale',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await openChat(lab, a);
    makeStale(a, c.id);
    c.initial = { protocolVersion: 1, agentCapabilities: { loadSession: false } };
    assertEquals(c.canReloadSession(), false);
    assertEquals(await a.staleScan(), [], 'no session load/resume: not restarted (it would lose the agent\'s context)');
    assert(!c.closed);
  },
});

Deno.test('stale chat: staleReasons compares the tool list and the fixed prompt, and a chat taken over with no record is stale', () => {
  const names = toolNames({ restricted: false, worktree: false, main: true });
  const served = { tools: { hash: toolsHash(names), names, at: 1 }, prompt: { hash: 'h', base: 'b1', at: 1 }, app: '1' };
  assertEquals(staleReasons(served, { tools: names, promptBase: 'b1' }, false), []);
  assertEquals(staleReasons(served, { tools: names.slice(1), promptBase: 'b1' }, false), ['tools']);
  assertEquals(staleReasons(served, { tools: names, promptBase: 'b2' }, false), ['prompt']);
  assertEquals(staleReasons(null, { tools: names, promptBase: 'b1' }, false), [], 'started by this AIB, has not asked for tools yet');
  assertEquals(staleReasons(null, { tools: names, promptBase: 'b1' }, true).length, 1, 'taken over, nothing recorded: it ran before AIB kept a record');
  assertEquals(staleReasons({ ...served, prompt: { hash: 'h', at: 1 } }, { tools: names, promptBase: 'b2' }, false), [], 'an old prompt record without the fixed hash says nothing');
  assertEquals(staleReasons(served, { tools: null, promptBase: null }, true), [], 'a chat with no AIB tools has nothing to be stale about');
  assertEquals(staleReasons({ prompt: { hash: 'h', at: 1 }, app: '1' }, { tools: names, promptBase: 'b1' }, true), [], 'a record with only its prompt: the agent has not listed its tools yet');
});

Deno.test('Maki names AIB tools studio-artifact__<tool> (hyphen): they are recognised as AIB\'s own, so no approval is asked', () => {
  const own = (call: Json) => ownToolName(call);
  assertEquals(own({ _meta: { claudeCode: { toolName: 'studio-artifact__publish' } } }), 'publish');
  assertEquals(own({ name: 'studio-artifact__update' }), 'update');
  assertEquals(own({ title: 'studio-artifact__publish', kind: 'other' }), 'publish');
  assertEquals(own({ title: 'mcp__studio-artifact__list', kind: 'other' }), 'list');
  assertEquals(own({ rawInput: { server: 'studio-artifact', tool: 'start_helper' } }), 'start_helper');
  assertEquals(own({ _meta: { is_mcp_tool_call: true }, title: 'mcp.studio-artifact.publish' }), 'publish');
  // the real Maki 0.7.2 permission request (recorded 2026-11-24): kind other, title "studio-artifact.publish: {args}", no name, no _meta
  assertEquals(
    own({
      toolCallId: 'call_1',
      kind: 'other',
      title: 'studio-artifact.publish: {"content":"<p>x</p>","title":"t","kind":"html"}',
      rawInput: { content: '<p>x</p>', title: 't', kind: 'html' },
    }),
    'publish',
  );
  assertEquals(own({ kind: 'other', title: 'studio-artifact.rm_rf: {}' }), '', 'not one of AIB\'s tools');
  assertEquals(own({ kind: 'execute', title: 'studio-artifact.publish: {}' }), '', 'a command titled alike is not AIB\'s tool');
  // the underscore forms still work
  assertEquals(own({ _meta: { claudeCode: { toolName: 'mcp__studio_artifact__publish' } } }), 'publish');
  // and a command or another tool named alike is not AIB's
  assertEquals(own({ kind: 'execute', title: 'studio-artifact__publish' }), '');
  assertEquals(own({ name: 'studio-artifact__delete_everything' }), '');
  assertEquals(own({ name: 'other-server__publish' }), '');
});

Deno.test({
  name: 'stale chat: an update (a newer AIB takes the chat over from the keeper) restarts a chat that ran before AIB kept a served record',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new Lab();
    const a = lab.aib();
    const c = await openChat(lab, a);
    // what an older AIB left: the chat runs in the keeper, and no served-tools record exists for it
    a.keeper!.disconnect();
    for (const x of a.connections.values()) x.sessionLease?.release();
    a.reconnectStop.set();
    lab.aibs.splice(lab.aibs.indexOf(a), 1);
    try {
      Deno.removeSync(lab.state + SEP + 'served-tools.json');
    } catch { /* nothing written yet */ }

    const b = lab.aib();
    assertEquals(await b.adoptKeeper(), 1);
    const r = b.connections.get(c.id)!;
    assert(r.adopted && r.ready);
    assertEquals(b.staleWhy(r).length, 1, 'taken over with no record: stale');
    assertEquals(await b.staleScan(), [c.id]);
    const next = b.connections.get(c.id)!;
    assert(next !== r && next.ready && next.sessionId === c.sessionId);
    assert(notes(next).includes('Restarted to pick up new AIB tools'));
    await list(b, next.id); // the restarted agent asks for its tools: recorded, fresh
    assertEquals(b.staleWhy(next), []);
  },
});
