/**
 * Model servers, the Settings section and what hangs off it (owner decisions 2026-11-23: Q1a, Q2a, Q3a). Server side, against a fake
 * Anthropic-compatible server (never the owner's real one); the page side is work/test_model_servers_ui.js and the phone's screen is
 * work/deno/model_servers_phone_e2e_test.ts.
 *   - adding a server: the API kinds are found with empty POSTs (400/422 speaks it, 401/403 wants a key, 404/405 does not), and no
 *     request that could make a model write anything is ever sent
 *   - "Use with": one switch per agent; Claude Code's makes the New chat entry (PC list and phone list), switched off it is gone; the
 *     Claude card gets the read-only "Also on model servers" data
 *   - Edit, Remove and Check (Check always asks the server)
 *   - a server that does not answer greys its entries with "<name> is not answering at <address>"; checked when New chat opens and
 *     kept 30 s
 *   - the key never reaches the page
 *   - Maki and Qwen Code read their address from the server that is switched on for them
 *   - the migration script (work/migrate/beta_addresses_to_model_servers.ts): dry run changes nothing, --apply moves the addresses
 *   - saved-chat discovery launches with the server's env; the WSL listing asks a live Claude-family chat of the distro
 */
import { assert, assertEquals } from './_assert.ts';
import { fake } from './_connection.ts';
import '../../outputs/agent-studio/agent-choice.js';
import { Connection } from '../../outputs/agent-studio/server/acp/connection.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { SettingsStore } from '../../outputs/agent-studio/server/state/settings.ts';
import { describeAgents, modelServersView, settingsView, type StudioContext } from '../../outputs/agent-studio/server/web/shared.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import { eligibleAgents, MODEL_SERVERS_GROUP, reasonWords } from '../../outputs/agent-studio/server/agents/eligibility.ts';
import { HEALTH_MS, inspectModelServer, notAnsweringLine, ServerHealth } from '../../outputs/agent-studio/server/agents/model_servers.ts';
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
  readonly servers: Deno.HttpServer[] = [];
  readonly studios: Studio[] = [];
  constructor() {
    Deno.mkdirSync(this.state, { recursive: true });
    Deno.writeTextFileSync(this.launcher, '');
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
    return { claudeLauncher: this.launcher, nodeCommand: Deno.execPath(), stateDir: this.state };
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
      { stateDir: this.state, port: 0, ownersDir: null, noArtifactTool: true, claudeLauncher: this.launcher, nodeCommand: Deno.execPath() },
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
  assertEquals(rows.find((r) => r.id === 'codex')!.alsoOnServers, undefined, 'no Codex switch: codex@ entries do not exist yet');
  // PC New chat: the entry sits in its own group, after the tested agents
  const pc = AC.mergeRegistry(rows);
  const entry = pc.all.find((a) => a.id === 'claude@strata')!;
  assertEquals([entry.name, entry.group, entry.enabled], ['Claude Code · strata', 'Model servers', true]);
  // phone New chat: the same entry, the same group label
  const phone = eligibleAgents(rows).find((a) => a.id === 'claude@strata')!;
  assertEquals([phone.name, phone.ok, phone.group], ['Claude Code · strata', true, MODEL_SERVERS_GROUP]);
  // the Settings view: both servers are in the section's list, with what they are switched on for
  const view = await modelServersView({ options: lab.options(), settings: store });
  assertEquals(view.map((s) => [s.id, s.useWith]), [['strata', ['claude']], ['lms', []]]);
  // turn the switch off: the entry and the "also on" line go; the server stays
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', useWith: [] } } } });
  rows = await describeAgents(lab.options(), store);
  assert(!rows.some((r) => r.modelServer), 'no entry');
  assertEquals(rows.find((r) => r.id === 'claude')!.alsoOnServers, undefined);
  assertEquals(store.modelServers().length, 2);
  // switches for agents that are not offered are dropped; Maki and Qwen Code read ONE server each
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', useWith: ['codex', 'qwen', 'bogus'] } } } });
  assertEquals(store.modelServer('strata')!.useWith, ['qwen']);
  await store.update({ agents: { modelServer: { upsert: { id: 'lms', useWith: ['qwen', 'maki'] } } } });
  assertEquals([store.modelServer('strata')!.useWith, store.modelServer('lms')!.useWith], [[], ['maki', 'qwen']]);
  // the Beta cards say which server their address comes from
  const beta = await describeAgents(lab.options(), store);
  assertEquals((beta.find((r) => r.id === 'qwen')!.betaInfo as Json).server, { id: 'lms', name: 'lms', url: 'http://127.0.0.1:1234' });
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
  assertEquals((await describeAgents(lab.options(), store)).find((r) => r.id === 'claude@strata')!.name, 'Claude Code · Strata 2');
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

Deno.test('Maki and Qwen Code read their address from the server switched on for them (their own key stays on the card)', async () => {
  await using lab = new Lab();
  const launched: { provider: string; env: Record<string, string> | null }[] = [];
  const studio = lab.studio(launched);
  const store = studio.settings;
  // nothing switched on: as before (no address, and the card's address when one is still saved)
  assertEquals(studio.betaEnv('qwen'), {});
  await store.update({ agents: { betaUrl: { qwen: 'https://old.example.invalid/v1' }, betaKey: { qwen: 'card-key-1' } } });
  assertEquals(studio.betaEnv('qwen'), { OPENAI_API_KEY: 'card-key-1', OPENAI_BASE_URL: 'https://old.example.invalid/v1' });
  // a server switched on wins over the saved address; the card key stays
  await store.update({ agents: { modelServer: { upsert: { name: 'local', url: 'http://127.0.0.1:8080', model: 'qwen3-x', useWith: ['qwen', 'maki'], key: KEY } } } });
  assertEquals(studio.betaEnv('qwen'), { OPENAI_API_KEY: 'card-key-1', OPENAI_BASE_URL: 'http://127.0.0.1:8080', OPENAI_MODEL: 'qwen3-x' });
  // no card key: the server's key (or a dummy for a server that needs none)
  await store.update({ agents: { betaKey: { qwen: null } } });
  assertEquals(studio.betaEnv('qwen').OPENAI_API_KEY, KEY);
  const maki = studio.betaEnv('maki');
  assertEquals([maki.ANTHROPIC_BASE_URL, maki.ANTHROPIC_API_KEY], ['http://127.0.0.1:8080', KEY]);
  await store.update({ agents: { modelServer: { upsert: { id: 'local', key: null } } } });
  assertEquals(studio.betaEnv('qwen').OPENAI_API_KEY, 'aib-model-server');
  // switched off again: the agent's own address (here the old saved one)
  await store.update({ agents: { modelServer: { upsert: { id: 'local', useWith: [] } } } });
  assertEquals(studio.betaEnv('qwen').OPENAI_BASE_URL, 'https://old.example.invalid/v1');
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
  assertEquals(after.modelServerFor('qwen')!.name, 'ws-1.ap-southeast-1.maas.aliyuncs.com');
  // again: nothing is left to move
  const again = await quiet(['--data', lab.state, '--apply']);
  assertEquals(again.code, 0);
  assert(again.lines.some((l) => l.includes('nothing to move')), again.lines.join('\n'));
  // an agent that already reads a server keeps its saved address and is told so
  await after.update({ agents: { betaUrl: { maki: 'https://x.invalid/a' } } });
  assert((await quiet(['--data', lab.state])).lines.some((l) => l.includes('skip') && l.includes('Maki')), 'skipped');
  assertEquals(new SettingsStore(lab.state).betaUrl('maki'), 'https://x.invalid/a');
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
