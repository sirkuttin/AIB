/**
 * Model servers, the Settings section and what hangs off it (owner decisions 2026-11-23: Q1a, Q2a, Q3a). Server side, against a fake
 * Anthropic-compatible server (never the owner's real one); the page side is work/test_model_servers_ui.js and the phone's screen is
 * work/deno/model_servers_phone_e2e_test.ts.
 *   - adding a server: the API kinds are found with empty POSTs (400/422 speaks it, 401/403 wants a key, 404/405 does not), and no
 *     request that could make a model write anything is ever sent
 *   - "Use with": one switch per agent (Claude Code, Codex, Maki, Qwen Code), ALL the same: each adds exactly one separate New chat
 *     entry `<agent>@<server>` (PC list and phone list), switched off it is gone; the agent's normal entry never changes; the
 *     agent's card gets the read-only "Also on model servers" data; every switch is greyed with the reason when the API kinds do not fit
 *   - Edit, Remove and Check (Check always asks the server)
 *   - a server that does not answer greys its entries with "<name> is not answering at <address>"; checked when New chat opens and
 *     kept 30 s
 *   - the key never reaches the page
 *   - Maki and Qwen Code entries launch with the server's address, key and model; their normal entries keep their own settings
 *   - the migration script (work/migrate/beta_addresses_to_model_servers.ts): dry run changes nothing, --apply turns the addresses
 *     into servers with "Use with" on, which gives the owner a "Maki 路 <server>" entry
 *   - saved-chat discovery launches with the server's env; the WSL listing asks a live Claude-family chat of the distro
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { fake } from './_connection.ts';
import '../../outputs/agent-studio/agent-choice.js';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { SettingsStore } from '../../outputs/agent-studio/server/state/settings.ts';
import { describeAgents, modelServersView, settingsView, type StudioContext } from '../../outputs/agent-studio/server/web/shared.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { eligibleAgents, MODEL_SERVERS_GROUP, reasonWords } from '../../outputs/agent-studio/server/agents/eligibility.ts';
import { HEALTH_MS, inspectModelServer, notAnsweringLine, ServerHealth, USE_WITH, useWithProblem } from '../../outputs/agent-studio/server/agents/model_servers.ts';
import { main as migrate } from '../migrate/beta_addresses_to_model_servers.ts';

type Json = Record<string, unknown>;
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
Deno.env.set('AGENT_STUDIO_TEST', '1');
const KEY = 'test-key-not-real-55bb12';

interface Seen {
  method: string;
  path: string;
  key: string;
  body: string;
}

class Lab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-msui-' }));
  readonly state = this.dir + SEP + 'state';
  readonly launcher = this.dir + SEP + 'claude-launcher.js';
  readonly codexLauncher = this.dir + SEP + 'codex-launcher.js';
  /** Fake qwen and maki programs (empty files): found on PATH while a test puts this folder in front. */
  readonly bin = this.dir + SEP + 'bin';
  readonly servers: Deno.HttpServer[] = [];
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.state, { recursive: true });
    Deno.writeTextFileSync(this.launcher, '');
    Deno.writeTextFileSync(this.codexLauncher, '');
    Deno.mkdirSync(this.bin);
    for (const name of ['qwen', 'qwen.exe', 'maki', 'maki.exe']) Deno.writeTextFileSync(this.bin + SEP + name, '');
    Deno.env.set('PATH', this.bin + (WIN ? ';' : ':') + this.pathBefore); // the same Qwen Code and Maki programs whatever this PC has installed
  }
  readonly pathBefore = Deno.env.get('PATH') ?? '';

  /** Runs `fn` with the fake qwen and maki programs first on PATH. */
  async withPrograms<T>(fn: () => Promise<T>): Promise<T> {
    const before = Deno.env.get('PATH') ?? '';
    Deno.env.set('PATH', this.bin + (WIN ? ';' : ':') + before);
    try {
      return await fn();
    } finally {
      Deno.env.set('PATH', before);
    }
  }

  /**
   * A fake model server. anthropic / responses: the route rejects an empty body (400, so it speaks the kind), else 404. chat: true
   * rejects an empty body (422), 'key' answers 401 without the key, false is 404. GET /v1/models lists `models`.
   */
  serve(o: { models?: string[]; anthropic?: boolean; responses?: boolean; chat?: boolean | 'key' } = {}): { url: string; seen: Seen[] } {
    const seen: Seen[] = [];
    const models = o.models ?? ['m-one', 'm-two'];
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (request) => {
      const path = new URL(request.url).pathname;
      const key = request.headers.get('x-api-key') ?? '';
      seen.push({ method: request.method, path, key, body: request.method === 'POST' ? await request.text() : '' });
      if (request.method === 'GET' && path === '/v1/models') return Response.json({ data: models.map((id) => ({ id })) });
      if (request.method !== 'POST') return new Response('no', { status: 404 });
      if (path === '/v1/messages') return new Response('{"error":"empty"}', { status: o.anthropic ? 400 : 404 });
      if (path === '/v1/responses') return new Response('{"error":"empty"}', { status: o.responses ? 400 : 405 });
      if (path === '/v1/chat/completions') {
        if (o.chat === 'key' && key !== KEY) return new Response('{"error":"key"}', { status: 401 });
        return new Response('{"error":"empty"}', { status: o.chat ? 422 : 404 });
      }
      return new Response('no', { status: 404 });
    });
    this.servers.push(server);
    return { url: `http://127.0.0.1:${server.addr.port}`, seen };
  }

  deadAddress(): string {
    const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    return `http://127.0.0.1:${port}`;
  }

  store(): SettingsStore {
    return new SettingsStore(this.state);
  }

  options() {
    return { claudeLauncher: this.launcher, codexLauncher: this.codexLauncher, nodeCommand: Deno.execPath(), stateDir: this.state };
  }

  /** What a route gets: the settings store, the agent options, and a host with no chats. */
  ctx(store: SettingsStore) {
    return {
      settings: store,
      agentOptions: this.options(),
      conversations: { public: () => ({ entries: {} }) },
      host: { liveList: () => ({ connections: [] }), liveCall: () => [200, {}], studioOwns: () => false, hostInfo: null, waitingChats: 0 },
    } as never;
  }

  view(store: SettingsStore): StudioContext {
    const c = this.ctx(store) as unknown as { agentOptions: StudioContext['options']; host: Json };
    return {
      options: c.agentOptions,
      settings: store,
      conversations: {} as never,
      liveList: () => ({ connections: [] }),
      liveCall: () => [200, {}],
      studioOwns: () => false,
    };
  }

  studio(launched: { provider: string; env: Record<string, string> | null }[], flags: string[] = []): Studio {
    const studio = new Studio(
      { stateDir: this.state, port: 0, ownersDir: null, noArtifactTool: true, claudeLauncher: this.launcher, codexLauncher: this.codexLauncher, nodeCommand: Deno.execPath() },
      { keeper: null },
    );
    studio.ownerProbe = () => null;
    studio.connectionFactory = (_command, cwd, provider, options) => {
      launched.push({ provider, env: options?.env ?? null });
      return new Connection(fake(...flags), cwd, provider);
    };
    this.studios.push(studio);
    return studio;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    Deno.env.set('PATH', this.pathBefore);
    for (const s of this.studios.reverse()) await s.close().catch(() => {});
    for (const s of this.servers) await s.shutdown().catch(() => {});
    for (let i = 0; i < 20; i++) {
      try {
        Deno.removeSync(this.dir, { recursive: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

const AC = (globalThis as unknown as {
  AgentChoice: {
    mergeRegistry(r: unknown): { all: Json[]; enabled: Json[]; unavailable: Json[] };
    setRegistry(r: unknown): unknown;
    menuRows(): Json[];
  };
}).AgentChoice;

const get = (name: string) => studioRoutes().get(name)!;

Deno.test('adding a server: the API kinds are found with empty POSTs, and nothing a model could answer is ever sent', async () => {
  await using lab = new Lab();
  const up = lab.serve({ anthropic: true, chat: 'key', models: ['qwen-a', 'qwen-b'] });
  const found = await inspectModelServer(up.url);
  assertEquals(found.kinds.map((k) => [k.kind, k.speaks, k.needsKey]), [['anthropic', true, false], ['responses', false, false], ['chat', true, true]]);
  assertEquals([found.reachable, found.models, found.needsKey], [true, ['qwen-a', 'qwen-b'], true]);
  // exactly one GET of the model list and one empty POST per kind: {} and nothing else
  assertEquals(up.seen.filter((s) => s.method === 'GET').map((s) => s.path), ['/v1/models']);
  assertEquals(up.seen.filter((s) => s.method === 'POST').map((s) => [s.path, s.body]).sort(), [
    ['/v1/chat/completions', '{}'],
    ['/v1/messages', '{}'],
    ['/v1/responses', '{}'],
  ]);
  // with the key the chat route answers its 422: still speaks it
  assertEquals((await inspectModelServer(up.url, KEY)).kinds.find((k) => k.kind === 'chat')!.needsKey, false);
  // a server with only OpenAI Responses: Claude Code's kind is not spoken
  const resp = lab.serve({ responses: true });
  assertEquals((await inspectModelServer(resp.url)).kinds.filter((k) => k.speaks).map((k) => k.kind), ['responses']);
  // the routes the page uses: the typed address (before adding) and the saved list
  const store = lab.store();
  const typed = await get('POST /api/live/model-servers/check')(lab.ctx(store), new URL('http://x/'), { url: up.url }, undefined as never) as [number, Json];
  assertEquals([typed[0], typed[1].kinds, typed[1].models, typed[1].needsKey], [200, ['anthropic', 'chat'], ['qwen-a', 'qwen-b'], true]);
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'qwen-b', key: KEY } } } });
  const list = await get('GET /api/live/model-servers')(lab.ctx(store), new URL('http://x/api/live/model-servers'), {}, undefined as never) as [number, { servers: Json[] }];
  assertEquals(list[0], 200);
  const row = list[1].servers[0];
  assertEquals([row.id, row.name, row.url, row.model, row.reachable, row.kinds, row.down, row.useWith], [
    'strata',
    'strata',
    up.url,
    'qwen-b',
    true,
    ['anthropic', 'chat'],
    '',
    ['claude'],
  ]);
  assertEquals(row.models, ['qwen-a', 'qwen-b']);
});

Deno.test('Use with: Claude Code makes the New chat entry on the PC and the phone; the Claude card says "also on" and the entry is not a card', async () => {
  await using lab = new Lab();
  const store = lab.store();
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: 'http://127.0.0.1:8080', model: 'm', useWith: ['claude'] } } } });
  await store.update({ agents: { modelServer: { upsert: { name: 'lms', url: 'http://127.0.0.1:1234', useWith: [] } } } });
  let rows = await describeAgents(lab.options(), store);
  assertEquals(rows.filter((r) => r.modelServer).map((r) => r.id), ['claude@strata'], 'only the server that is switched on');
  assertEquals(rows.find((r) => r.id === 'claude')!.alsoOnServers, ['strata']);
  assertEquals(rows.find((r) => r.id === 'codex')!.alsoOnServers, undefined, 'only the agents a server is switched on for say so');
  // PC New chat: the entry sits in its own group, after the tested agents
  const pc = AC.mergeRegistry(rows);
  const entry = pc.all.find((a) => a.id === 'claude@strata')!;
  assertEquals([entry.name, entry.group, entry.enabled], ['Claude Code 路 strata', 'Model servers', true]);
  // phone New chat: the same entry, the same group label
  const phone = eligibleAgents(rows).find((a) => a.id === 'claude@strata')!;
  assertEquals([phone.name, phone.ok, phone.group], ['Claude Code 路 strata', true, MODEL_SERVERS_GROUP]);
  // the Settings view: both servers are in the section's list, with what they are switched on for
  const view = await modelServersView({ options: lab.options(), settings: store });
  assertEquals(view.map((s) => [s.id, s.useWith]), [['strata', ['claude']], ['lms', []]]);
  // turn the switch off: the entry and the "also on" line go; the server stays
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', useWith: [] } } } });
  rows = await describeAgents(lab.options(), store);
  assert(!rows.some((r) => r.modelServer), 'no entry');
  assertEquals(rows.find((r) => r.id === 'claude')!.alsoOnServers, undefined);
  assertEquals(store.modelServers().length, 2);
  // switches for agents that are not offered are dropped; every agent can be on several servers (each makes its own entry)
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', useWith: ['codex', 'qwen', 'bogus'] } } } });
  assertEquals(store.modelServer('strata')!.useWith, ['codex', 'qwen']);
  await store.update({ agents: { modelServer: { upsert: { id: 'lms', useWith: ['qwen', 'maki'] } } } });
  assertEquals([store.modelServer('strata')!.useWith, store.modelServer('lms')!.useWith], [['codex', 'qwen'], ['maki', 'qwen']]);
  const beta = await describeAgents(lab.options(), store);
  assertEquals(beta.filter((r) => r.modelServer).map((r) => r.id), ['codex@strata', 'qwen@strata', 'maki@lms', 'qwen@lms']);
  assertEquals((beta.find((r) => r.id === 'qwen')!.betaInfo as Json).server, undefined, 'a Beta card is not changed by a server');
  assertEquals(beta.find((r) => r.id === 'qwen')!.alsoOnServers, ['strata', 'lms']);
});

Deno.test('every agent works the same: each switch adds exactly ONE separate entry next to the normal one, which is never changed', async () => {
  await using lab = new Lab();
  const store = lab.store();
  const plain = await describeAgents(lab.options(), store);
  const normal = ['claude', 'codex', 'maki', 'qwen'].map((id) => JSON.stringify(plain.find((r) => r.id === id)));
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: 'http://127.0.0.1:8080', model: 'm', useWith: [], key: KEY } } } });
  const labels: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', maki: 'Maki', qwen: 'Qwen Code' };
  const on: string[] = [];
  for (const agent of ['claude', 'codex', 'maki', 'qwen']) {
    on.push(agent);
    await store.update({ agents: { modelServer: { upsert: { id: 'strata', useWith: [...on] } } } });
    const rows = await describeAgents(lab.options(), store);
    const entries = rows.filter((r) => r.modelServer);
    assertEquals(entries.map((r) => r.id), on.map((a) => `${a}@strata`), 'one entry per switch that is on');
    assertEquals(entries.map((r) => r.name), on.map((a) => `${labels[a]} \u00b7 strata`));
    assertEquals(entries.map((r) => r.baseAgent), on);
    // the normal entries are exactly what they were with no server (the "also on" line is data for the card, not a change of the agent)
    const now = ['claude', 'codex', 'maki', 'qwen'].map((id) => {
      const row = { ...(rows.find((r) => r.id === id) as Json) };
      delete row.alsoOnServers;
      return JSON.stringify(row);
    });
    assertEquals(now, normal);
    // the entry shows on the PC and the phone, in the Model servers group
    const pc = AC.mergeRegistry(rows).all.find((a) => a.id === `${agent}@strata`)!;
    const phone = eligibleAgents(rows).find((a) => a.id === `${agent}@strata`)!;
    assertEquals([pc.group, phone.group, pc.enabled, phone.ok], ['Model servers', MODEL_SERVERS_GROUP, true, true]);
  }
  assert(!JSON.stringify(await describeAgents(lab.options(), store)).includes(KEY));
});

Deno.test('every switch is greyed the same way, with the reason, when the server\u2019s API kinds do not fit', async () => {
  const kinds = (...k: ('anthropic' | 'responses' | 'chat')[]) => k;
  assertEquals(useWithProblem('claude', kinds('chat')), 'Claude Code needs a server that speaks Anthropic Messages.');
  assertEquals(useWithProblem('claude', kinds('anthropic', 'chat')), '');
  assertEquals(useWithProblem('codex', kinds('anthropic')), 'Codex needs a server that speaks OpenAI Responses or Chat Completions.');
  assertEquals([useWithProblem('codex', kinds('responses')), useWithProblem('codex', kinds('chat'))], ['', '']);
  assertEquals(useWithProblem('maki', kinds('responses', 'chat')), 'Maki needs a server that speaks Anthropic Messages.');
  assertEquals(useWithProblem('qwen', kinds('anthropic')), 'Qwen Code needs a server that speaks Chat Completions.');
  assertEquals([USE_WITH.map((u) => u.agent), USE_WITH.every((u) => u.kinds.length > 0)], [['claude', 'codex', 'maki', 'qwen'], true]);
  // the page's own table (settings-ui.js) holds the same agents and kinds
  const page = Deno.readTextFileSync(new URL('../../outputs/agent-studio/settings-ui.js', import.meta.url));
  for (const u of USE_WITH) {
    const list = u.kinds.map((k) => `'${k}'`).join(', ');
    assert(page.includes(`{ agent: '${u.agent}', label: '${u.label}', kinds: [${list}] }`), `${u.agent} in settings-ui.js`);
  }
});

Deno.test('Edit, Remove and Check: Edit keeps the id and the key, Remove forgets everything, Check always asks the server', async () => {
  await using lab = new Lab();
  const up = lab.serve({ anthropic: true });
  const store = lab.store();
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, key: KEY } } } });
  await store.update({ defaults: { agent: 'claude@strata' } });
  // Check: every call asks (a kept answer is replaced), and refreshes what New chat reads
  const asked = () => up.seen.filter((s) => s.method === 'GET').length;
  const check = get('POST /api/live/model-servers/check');
  const before = asked();
  await check(lab.ctx(store), new URL('http://x/'), { id: 'strata' }, undefined as never);
  await check(lab.ctx(store), new URL('http://x/'), { id: 'strata' }, undefined as never);
  assertEquals(asked() - before, 2, 'Check again asks the server each time');
  // Edit: a new name and address; the id, the key and the model stay
  const other = lab.serve({ anthropic: true });
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', name: 'Strata 2', url: other.url } } } });
  const s = store.modelServer('strata')!;
  assertEquals([s.id, s.name, s.url], ['strata', 'Strata 2', other.url]);
  assertEquals(store.betaKey('strata'), KEY);
  assertEquals((await describeAgents(lab.options(), store)).find((r) => r.id === 'claude@strata')!.name, 'Claude Code 路 Strata 2');
  // Remove: the server, its key, its entry and the defaults that named it
  await store.update({ agents: { modelServer: { remove: 'strata' } } });
  assertEquals([store.modelServers().length, store.betaKey('strata'), store.snapshot().defaults.agent], [0, '', '']);
});

Deno.test('a server that does not answer greys its entries with the reason, on the PC and the phone; New chat checks and keeps the answer 30 s', async () => {
  await using lab = new Lab();
  const up = lab.serve({ anthropic: true });
  const dead = lab.deadAddress();
  const store = lab.store();
  await store.update({ agents: { modelServer: { upsert: { name: 'up', url: up.url } } } });
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: dead } } } });
  const self = lab.view(store);
  const view = await settingsView(self, false, { health: true });
  const rows = view.agents as Json[];
  const line = notAnsweringLine('strata', dead);
  assert(line.startsWith('strata is not answering at 127.0.0.1:'), line);
  assertEquals(rows.find((r) => r.id === 'claude@strata')!.down, line);
  assertEquals(rows.find((r) => r.id === 'claude@up')!.down, undefined);
  // PC: unavailable and never pickable, listed under Model servers with the line as its reason; the working one is pickable
  const pc = AC.mergeRegistry(rows);
  assertEquals(pc.unavailable.filter((a) => a.group === 'Model servers').map((a) => [a.id, a.reason]), [['claude@strata', line]]);
  assert(pc.enabled.some((a) => a.id === 'claude@up') && !pc.enabled.some((a) => a.id === 'claude@strata'));
  AC.setRegistry(rows);
  const menu = AC.menuRows();
  assertEquals(menu.filter((r) => r.group === 'Model servers').map((r) => [r.value, !!r.disabled, r.reason ?? '']), [['claude@up', false, ''], ['claude@strata', true, line]]);
  assert(menu.findIndex((r) => r.value === 'claude@up') > menu.findIndex((r) => r.value === 'codex'), 'after the tested agents');
  AC.setRegistry([]); // leave the shared registry as it was found
  // phone: the same verdict with the words the phone shows, and a Start of that entry is refused with them
  const phone = eligibleAgents(rows);
  const down = phone.find((a) => a.id === 'claude@strata')!;
  assertEquals([down.ok, down.reason, down.detail, down.group], [false, 'Not answering', line, 'Model servers']);
  assertEquals(reasonWords(down.reason, down.detail), line + '. Start it on your PC.');
  assert(phone.find((a) => a.id === 'claude@up')!.ok);
  // the check is kept 30 s: another New chat open does not ask the live server again; Check again does
  const asked = () => up.seen.filter((s) => s.method === 'GET').length;
  const before = asked();
  await settingsView(self, false, { health: true });
  await settingsView(self, false, { health: true });
  assertEquals(asked(), before, 'kept');
  await settingsView(self, false, { health: true, fresh: true });
  assertEquals(asked(), before + 1, 'asked again');
  // and by the clock: the cache is HEALTH_MS = 30 s
  let now = 1000;
  let calls = 0;
  const health = new ServerHealth(() => (calls++, Promise.resolve({ reachable: true, models: [], error: '', kinds: [], needsKey: false, at: now })), () => now);
  await health.check({ id: 'a', url: 'http://x' }, '');
  now += HEALTH_MS - 1;
  await health.check({ id: 'a', url: 'http://x' }, '');
  assertEquals(calls, 1);
  now += 2;
  await health.check({ id: 'a', url: 'http://x' }, '');
  assertEquals(calls, 2, 'a new ask after 30 s');
  await health.check({ id: 'a', url: 'http://y' }, '');
  assertEquals(calls, 3, 'an edited address is never answered from the old check');
  // nothing is polled: no timer is left behind by the cache (the test would leak one)
});

Deno.test('an unreachable server greys EVERY entry built from it the same way, on the PC and the phone', async () => {
  await using lab = new Lab();
  const dead = lab.deadAddress();
  const store = lab.store();
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: dead, useWith: ['claude', 'codex', 'maki', 'qwen'] } } } });
  const rows = (await settingsView(lab.view(store), false, { health: true })).agents as Json[];
  const line = notAnsweringLine('strata', dead);
  const entries = rows.filter((r) => r.modelServer);
  assertEquals(entries.map((r) => [r.id, r.down]), ['claude', 'codex', 'maki', 'qwen'].map((a) => [`${a}@strata`, line]));
  const phone = eligibleAgents(rows).filter((a) => a.group === MODEL_SERVERS_GROUP);
  assertEquals(phone.map((a) => [a.id, a.ok, a.reason, a.detail]), entries.map((r) => [r.id, false, 'Not answering', line]));
  const pc = AC.mergeRegistry(rows).unavailable.filter((a) => a.group === 'Model servers');
  assertEquals(pc.map((a) => [a.id, a.reason]), entries.map((r) => [r.id, line]));
  // the agents' own normal entries are not greyed by their server
  assert(!rows.filter((r) => !r.modelServer).some((r) => r.down));
});

Deno.test('the key never reaches the page: not in the list, the settings view, the check answers, nor the agent rows', async () => {
  await using lab = new Lab();
  const up = lab.serve({ anthropic: true, chat: 'key' });
  const store = lab.store();
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, key: KEY } } } });
  const self = lab.view(store);
  const dump = JSON.stringify(await settingsView(self, false, { health: true }));
  assert(!dump.includes(KEY), 'the settings view');
  assertEquals((await modelServersView(self, { health: true })).map((s) => s.keySet), [true]);
  const answers = JSON.stringify([
    await get('POST /api/live/model-servers/check')(lab.ctx(store), new URL('http://x/'), { id: 'strata' }, undefined as never),
    await get('POST /api/live/model-servers/check')(lab.ctx(store), new URL('http://x/'), { url: up.url, key: KEY }, undefined as never),
    await get('GET /api/live/model-servers')(lab.ctx(store), new URL('http://x/'), {}, undefined as never),
  ]);
  assert(!answers.includes(KEY), 'the route answers');
  assert(up.seen.some((s) => s.key === KEY), 'the key did reach the model server itself');
  assert(!Deno.readTextFileSync(lab.state + SEP + 'studio-settings.json').includes(KEY), 'and it is sealed at rest');
  // removing the key shows in the list
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', key: null } } } });
  assertEquals((await modelServersView(self)).map((s) => s.keySet), [false]);
});

Deno.test('Maki and Qwen Code entries launch with the server\u2019s address, key and model; their normal entries keep their own settings', async () => {
  await using lab = new Lab();
  const up = lab.serve({ chat: true, anthropic: true, models: ['qwen3-x', 'other'] });
  const launched: { provider: string; env: Record<string, string> | null }[] = [];
  const studio = lab.studio(launched);
  const store = studio.settings;
  assertEquals(studio.betaEnv('qwen'), {});
  await store.update({ agents: { betaUrl: { qwen: 'https://old.example.invalid/v1' }, betaKey: { qwen: 'card-key-1' } } });
  const own = { OPENAI_API_KEY: 'card-key-1', OPENAI_BASE_URL: 'https://old.example.invalid/v1' };
  assertEquals(studio.betaEnv('qwen'), own);
  await store.update({ agents: { modelServer: { upsert: { name: 'local', url: up.url, model: 'qwen3-x', useWith: ['qwen', 'maki'], key: KEY } } } });
  // the normal entries are exactly as before: a server never changes them
  assertEquals(studio.betaEnv('qwen'), own);
  assertEquals(studio.betaEnv('maki'), {});
  // the entries: the normal adapter (same argv) with the server's address, key and model in the agent's own variables
  const [qwenArgv] = await lab.withPrograms(() => studio.agentLaunch('qwen'));
  const [qArgv, qEnv] = await lab.withPrograms(() => studio.agentLaunch('qwen@local'));
  assertEquals(qArgv, [...qwenArgv, '--auth-type', 'openai'], 'the same adapter command as normal Qwen Code, plus the auth type that makes it read the server抯 variables');
  assertEquals(qEnv, { OPENAI_BASE_URL: up.url, OPENAI_API_KEY: KEY, OPENAI_MODEL: 'qwen3-x' });
  const [makiArgv] = await lab.withPrograms(() => studio.agentLaunch('maki'));
  const [mArgv, mEnv] = await lab.withPrograms(() => studio.agentLaunch('maki@local'));
  assertEquals(mArgv, makiArgv);
  assertEquals(mEnv, { ANTHROPIC_BASE_URL: up.url, ANTHROPIC_API_KEY: KEY });
  // the card key is not used by an entry; a server with no key gives the dummy; the normal entry still has its card key
  await store.update({ agents: { modelServer: { upsert: { id: 'local', key: null } } } });
  assertEquals((await lab.withPrograms(() => studio.agentLaunch('qwen@local')))[1].OPENAI_API_KEY, 'aib-model-server');
  assertEquals((await lab.withPrograms(() => studio.agentLaunch('maki@local')))[1].ANTHROPIC_API_KEY, 'aib-model-server');
  assertEquals((await lab.withPrograms(() => studio.agentLaunch('qwen')))[1], own);
  // switched off: the entry is gone, the normal entry is as before
  await store.update({ agents: { modelServer: { upsert: { id: 'local', useWith: [] } } } });
  assertEquals(studio.betaEnv('qwen'), own);
});

Deno.test('the migration script: a dry run changes nothing, --apply moves the Maki and Qwen Code addresses into model servers', async () => {
  await using lab = new Lab();
  const store = lab.store();
  await store.update({
    agents: {
      betaUrl: { qwen: 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', maki: 'https://api.deepseek.invalid/anthropic' },
      betaKey: { qwen: KEY },
    },
  });
  const file = lab.state + SEP + 'studio-settings.json';
  const before = Deno.readTextFileSync(file);
  const quiet = async (args: string[]) => {
    const log = console.log;
    const lines: string[] = [];
    console.log = (...a: unknown[]) => void lines.push(a.join(' '));
    try {
      return { code: await migrate(args), lines };
    } finally {
      console.log = log;
    }
  };
  const dry = await quiet(['--data', lab.state]);
  assertEquals(dry.code, 0);
  assertEquals(Deno.readTextFileSync(file), before, 'a dry run writes nothing');
  assert(dry.lines.some((l) => l.includes('would') && l.includes('Qwen Code')) && dry.lines.some((l) => l.includes('Dry run')), dry.lines.join('\n'));
  assertEquals((await quiet(['--data', lab.state, '--bogus'])).code, 2);
  const done = await quiet(['--data', lab.state, '--apply']);
  assertEquals(done.code, 0, done.lines.join('\n'));
  const after = new SettingsStore(lab.state);
  assertEquals(after.modelServers().map((s) => [s.name, s.url, s.useWith]), [
    ['api.deepseek.invalid', 'https://api.deepseek.invalid/anthropic', ['maki']],
    ['ws-1.ap-southeast-1.maas.aliyuncs.com', 'https://ws-1.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', ['qwen']],
  ]);
  assertEquals([after.betaUrl('qwen'), after.betaUrl('maki')], ['', ''], 'the cards no longer hold an address');
  assertEquals(after.betaKey('qwen'), KEY, 'the key stays on the card');
  const qwenServer = after.modelServers().find((x) => x.useWith.includes('qwen'))!;
  assertEquals(after.betaKey(qwenServer.id), KEY, 'and is copied to the server for its entry');
  // the owner now has the entries "Maki 路 <server>" and "Qwen Code 路 <server>", next to the normal ones
  const rows = await describeAgents(lab.options(), after);
  assertEquals(rows.filter((r) => r.modelServer).map((r) => r.name), ['Maki \u00b7 api.deepseek.invalid', 'Qwen Code \u00b7 ws-1.ap-southeast-1.maas.aliyuncs.com']);
  assertEquals(eligibleAgents(rows).filter((a) => a.group === MODEL_SERVERS_GROUP).map((a) => a.id), rows.filter((r) => r.modelServer).map((r) => r.id));
  // again: nothing is left to move
  const again = await quiet(['--data', lab.state, '--apply']);
  assertEquals(again.code, 0);
  assert(again.lines.some((l) => l.includes('nothing to move')), again.lines.join('\n'));
  // an address that already has its entry stays saved on the card and is told so
  await after.update({ agents: { betaUrl: { maki: 'https://api.deepseek.invalid/anthropic' } } });
  assert((await quiet(['--data', lab.state])).lines.some((l) => l.includes('skip') && l.includes('Maki')), 'skipped');
  assertEquals(new SettingsStore(lab.state).betaUrl('maki'), 'https://api.deepseek.invalid/anthropic');
  // the same address from two agents is ONE server with both switches on
  await using lab2 = new Lab();
  const two = lab2.store();
  await two.update({ agents: { betaUrl: { maki: 'https://same.invalid/v1', qwen: 'https://same.invalid/v1' } } });
  assertEquals((await quiet(['--data', lab2.state, '--apply'])).code, 0);
  assertEquals(new SettingsStore(lab2.state).modelServers().map((s) => [s.url, s.useWith]), [['https://same.invalid/v1', ['maki', 'qwen']]]);
});

Deno.test('saved-chat discovery launches with the server env; the WSL listing asks any live Claude-family chat of the distro', async () => {
  await using lab = new Lab();
  const up = lab.serve({ anthropic: true });
  const launched: { provider: string; env: Record<string, string> | null }[] = [];
  const studio = lab.studio(launched, ['--list-sessions']);
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'm-two', key: KEY } } } });
  // Windows: no chat is running, so a short-lived adapter lists the sessions: with the server's address, key and model
  const found = await studio.listAgentSessions('claude@strata', null);
  assertEquals(found.via, 'temporary-process');
  assertEquals(launched.length, 1);
  assertEquals([launched[0].provider, launched[0].env?.ANTHROPIC_BASE_URL, launched[0].env?.ANTHROPIC_API_KEY, launched[0].env?.ANTHROPIC_MODEL], ['claude@strata', up.url, KEY, 'm-two']);
  // plain Claude is asked the way it was: no server env
  launched.length = 0;
  await studio.listAgentSessions('claude', null);
  assertEquals(launched[0].env, null);
  // WSL: the chat that answers may be Claude Code or any server entry of the same distro (they share the saved-chat folder)
  const live = (provider: string, distro: string) => ({
    provider,
    ready: true,
    closed: false,
    wsl: { distro },
    listSessions: (cwd: string | null) => Promise.resolve({ sessions: [{ id: 's1', cwd, title: provider }], nextCursor: null }),
  });
  const conns = (studio as unknown as { connections: Map<string, unknown> }).connections;
  const ref = 'wsl://ubuntu/home/u/app';
  const none = await studio.listAgentSessions('claude@strata', ref);
  assertEquals([none.via, none.sessions], ['none', []]);
  conns.set('c1', live('claude', 'ubuntu'));
  const viaClaude = await studio.listAgentSessions('claude@strata', ref) as Json;
  assertEquals([viaClaude.via, (viaClaude.sessions as Json[]).map((s) => [s.title, s.cwd])], ['studio-connection', [['claude', ref]]]);
  conns.clear();
  conns.set('c2', live('claude@strata', 'ubuntu'));
  const viaServer = await studio.listAgentSessions('claude', ref) as Json;
  assertEquals([viaServer.via, (viaServer.sessions as Json[]).length], ['studio-connection', 1]);
  conns.clear();
  conns.set('c3', live('claude@strata', 'debian'));
  assertEquals((await studio.listAgentSessions('claude', ref) as Json).via, 'none', 'another distro does not answer');
  conns.clear();
});
