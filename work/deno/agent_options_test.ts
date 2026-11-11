/**
 * The model / mode / effort lists a new chat can offer before its session exists (server/state/agent_options.ts), the quiet probe and
 * the picks applied before the first prompt (Studio.connect picks -> Connection.applyStartPicks). Fake ACP agent only (fake_acp.py
 * --models), temp state folders.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { readPicks, Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { AgentOptionsCache, extract, FILE, folderKey } from '../../outputs/agent-studio/server/state/agent_options.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-options-test-' }));
  readonly state = this.dir + SEP + 'state';
  readonly work = this.dir + SEP + 'project';
  readonly studios: Studio[] = [];
  made = 0;
  constructor() {
    Deno.mkdirSync(this.work, { recursive: true });
  }

  manager(flags: string[] = ['--models']): Studio {
    const studio = new Studio({ ompCommand: 'unused', stateDir: this.state, port: 0, autoReconnect: false });
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider) => (this.made++, new Connection(fake(...flags), cwd, provider));
    this.studios.push(studio);
    return studio;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
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

const texts = (c: Connection) =>
  c.events
    .filter((e) => e.kind === 'update')
    .map((e) => ((e.data as Json).update as Json))
    .filter((u) => u.sessionUpdate === 'agent_message_chunk')
    .map((u) => String(((u.content as Json) || {}).text || ''))
    .join('\n');

const modelOf = (c: Connection) => ((c.settings.configOptions as Json[]).find((o) => o.id === 'model') as Json).currentValue;
const effortOf = (c: Connection) => ((c.settings.configOptions as Json[]).find((o) => o.id === 'reasoning_effort') as Json).currentValue;
const modeOf = (c: Connection) => (c.settings.modes as Json).currentModeId;

Deno.test('extract: model, effort and session modes, with groups and descriptions; nothing for an agent without lists', () => {
  const got = extract({
    modes: { currentModeId: 'b', availableModes: [{ id: 'a', name: 'A', description: 'first' }, { id: 'b' }] },
    configOptions: [
      {
        id: 'model',
        category: 'model',
        type: 'select',
        currentValue: 'x',
        options: [{ group: 'g', name: 'Big', options: [{ value: 'x', name: 'X' }] }, { value: 'y' }],
      },
      { id: 'thinking', type: 'select', currentValue: 'hi', options: [{ value: 'hi', name: 'High' }] },
      { id: 'verbose', type: 'boolean', currentValue: true },
    ],
  });
  assertEquals(got.model, {
    kind: 'config',
    configId: 'model',
    current: 'x',
    choices: [{ value: 'x', name: 'X', group: 'Big' }, { value: 'y', name: 'y' }],
  });
  assertEquals(got.effort, { kind: 'config', configId: 'thinking', current: 'hi', choices: [{ value: 'hi', name: 'High' }] });
  assertEquals(got.mode, {
    kind: 'mode',
    current: 'b',
    choices: [{ value: 'a', name: 'A', description: 'first' }, { value: 'b', name: 'b' }],
  });
  assertEquals(extract({ modes: { availableModes: [] }, configOptions: [] }), {});
  assertEquals(extract(null), {});
  assertEquals(folderKey('C:\\Repos\\App\\'), folderKey('c:/repos/app'));
});

Deno.test('the cache: a folder entry wins, "current" only comes from a fresh session, it survives a restart', () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-options-cache-' }));
  try {
    const settings = (model: string, models: string[]) => ({
      configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: model, options: models.map((value) => ({ value })) }],
    });
    const cache = new AgentOptionsCache(dir);
    assertEquals(cache.lookup('codex', 'C:/a'), null);
    assert(cache.record('codex', 'C:/a', settings('m1', ['m1', 'm2']), true));
    assert(!cache.record('codex', 'C:/a', settings('m1', ['m1', 'm2']), true), 'nothing changed: not written again');
    // A reopened chat that runs m2 does not change what "Default" means; its list still refreshes the memory.
    assert(cache.record('codex', 'C:/b', settings('m2', ['m1', 'm2', 'm3']), false));
    assertEquals(cache.lookup('codex', 'C:/b')!.source, 'folder');
    assertEquals(cache.lookup('codex', 'C:/b')!.model!.current, undefined);
    assertEquals(cache.lookup('codex', 'C:/a')!.model!.choices.length, 2, 'the folder entry of C:/a is kept');
    assertEquals(cache.lookup('codex', 'D:/never')!.source, 'agent');
    assertEquals(cache.lookup('codex', 'D:/never')!.model!.current, 'm1', 'the agent entry keeps the default from the fresh session');
    assertEquals(cache.lookup('codex', 'D:/never')!.model!.choices.map((c) => c.value), ['m1', 'm2', 'm3']);
    assertEquals(cache.lookup('claude', 'C:/a'), null, 'another agent has nothing');
    const again = new AgentOptionsCache(dir);
    assertEquals(again.lookup('codex', 'c:\\A')!.model!.choices.length, 2, 'read back from ' + FILE);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name: 'picks are applied after session/new and before the first prompt; the first reply already runs with them',
  ...T,
  async fn() {
    await using lab = new Lab();
    const studio = lab.manager();
    const c = await studio.connect('omp', lab.work, null, { picks: { model: 'luna-4', mode: 'full', effort: 'high' } });
    assert(c.ready);
    assertEquals([modelOf(c), modeOf(c), effortOf(c)], ['luna-4', 'full', 'high']);
    assertEquals(c.pickResults.map((r) => [r.kind, r.ok]), [['model', true], ['mode', true], ['effort', true]]);
    assertEquals((c.public().pickResults as Json[]).length, 3);
    await c.prompt('settings?');
    await until(() => !c.busy && texts(c).includes('Fixture settings'));
    assert(texts(c).includes('model=luna-4 mode=full effort=high sessions=1'), texts(c));
    // The lists were remembered, with the agent's own defaults (from the reply before the picks) as "current".
    const hit = studio.agentOptions.lookup('omp', lab.work)!;
    assertEquals(hit.source, 'folder');
    assertEquals([hit.model!.current, hit.mode!.current, hit.effort!.current], ['sol-6-1', 'auto', 'medium']);
    assertEquals(hit.model!.choices.length, 16);
    assertEquals(hit.mode!.kind, 'mode');
    assertEquals(hit.effort!.configId, 'reasoning_effort');
  },
});

Deno.test({
  name: 'a remembered model that is gone, or one the agent refuses, is reported and the chat still opens with the agent default',
  ...T,
  async fn() {
    await using lab = new Lab();
    const gone = await lab.manager().connect('omp', lab.work, null, { picks: { model: 'retired-model', effort: 'low' } });
    assert(gone.ready);
    assertEquals(modelOf(gone), 'sol-6-1');
    assertEquals(effortOf(gone), 'low', 'the other pick still applies');
    assertEquals(gone.pickResults[0].ok, false);
    assertEquals(gone.pickResults[0].message, 'No longer offered by the agent');
    await gone.close(); // the fixture's session id is always the same: one chat at a time
    const refused = await lab.manager(['--models', '--reject-config']).connect('omp', lab.work, null, {
      picks: { model: 'luna-4', mode: 'ask' },
    });
    assert(refused.ready);
    assertEquals([modelOf(refused), modeOf(refused)], ['sol-6-1', 'auto']);
    assertEquals(refused.pickResults.map((r) => r.ok), [false, false]);
    assert(String(refused.pickResults[0].message).includes('Fixture refuses this setting'), String(refused.pickResults[0].message));
    await refused.close();
    // A reopened chat never gets picks.
    const plain = await lab.manager().connect('omp', lab.work, null, {});
    assertEquals(plain.pickResults, []);
  },
});

Deno.test('readPicks keeps short strings for model, mode and effort and refuses anything else', () => {
  assertEquals(readPicks(undefined), null);
  assertEquals(readPicks({ model: '', mode: null }), null);
  assertEquals(readPicks({ model: 'm', other: 'x' }), { model: 'm' });
  let refused = 0;
  for (const bad of ['m', { model: 5 }, { effort: 'x'.repeat(301) }]) {
    try {
      readPicks(bad);
    } catch {
      refused++;
    }
  }
  assertEquals(refused, 3);
});

Deno.test({
  name: 'agent-options: nothing remembered -> one quiet probe (no prompt, no MCP servers, closed again), then from memory',
  ...T,
  async fn() {
    await using lab = new Lab();
    const studio = lab.manager();
    const [status0, none] = await studio.liveCall('agent-options', { agent: 'omp', cwd: lab.work });
    assertEquals([status0, (none as Json).options, (none as Json).probed], [200, null, false]);
    assertEquals(lab.made, 0, 'no probe unless asked');
    const both = await Promise.all([
      studio.liveCall('agent-options', { agent: 'omp', cwd: lab.work, probe: true }),
      studio.liveCall('agent-options', { agent: 'omp', cwd: lab.work, probe: true }),
    ]);
    assertEquals(lab.made, 1, 'two pages asking at once share one probe');
    const [status, body] = both[0] as [number, Json];
    assertEquals([status, body.probed], [200, true]);
    const options = body.options as Json;
    assertEquals(((options.model as Json).choices as unknown[]).length, 16);
    assertEquals((options.model as Json).current, 'sol-6-1');
    assertEquals(studio.connections.size, 0, 'the probe is not a chat');
    const [, cached] = await studio.liveCall('agent-options', { agent: 'omp', cwd: lab.work, probe: true });
    assertEquals([(cached as Json).probed, lab.made], [false, 1], 'from memory now');
    // A later Studio (an app restart) reads the same memory.
    const later = lab.manager();
    const [, after] = await later.liveCall('agent-options', { agent: 'omp', cwd: 'C:\\elsewhere', probe: true });
    assertEquals([(after as Json).probed, ((after as Json).options as Json).source, lab.made], [false, 'agent', 1]);
    const [bad] = await studio.liveCall('agent-options', { agent: 'nope' });
    assertEquals(bad, 400);
  },
});

Deno.test({
  name: 'agent-options: a probe that fails is not repeated for a while, and never asks for sign-in',
  ...T,
  async fn() {
    await using lab = new Lab();
    const studio = lab.manager(['--auth-required']);
    const [, first] = await studio.liveCall('agent-options', { agent: 'omp', cwd: lab.work, probe: true });
    assertEquals([(first as Json).options, (first as Json).probed], [null, true]);
    assert(String((first as Json).probeError).length > 0);
    const [, second] = await studio.liveCall('agent-options', { agent: 'omp', cwd: lab.work, probe: true });
    assertEquals([(second as Json).probed, (second as Json).probeError, lab.made], [false, 'tried recently', 1]);
    studio.clock = () => Date.now() / 1000 + 3600;
    await studio.liveCall('agent-options', { agent: 'omp', cwd: lab.work, probe: true });
    assertEquals(lab.made, 2, 'tried again after the cool-down');
  },
});

Deno.test({
  name: 'an open chat of the agent refreshes the memory, and a settings change keeps it current',
  ...T,
  async fn() {
    await using lab = new Lab();
    const studio = lab.manager();
    const c = await studio.connect('omp', lab.work, null, {});
    const [, body] = await studio.liveCall('config', { id: c.id, configId: 'model', value: 'terra-5' });
    assertEquals((body as Json).ok, true);
    const hit = studio.agentOptions.lookup('omp', lab.work)!;
    assertEquals(hit.model!.current, 'sol-6-1', '"Default" stays the session/new value');
    const text = Deno.readTextFileSync(lab.state + SEP + FILE);
    assert(text.includes('terra-5') && text.includes('"version":1'));
  },
});
