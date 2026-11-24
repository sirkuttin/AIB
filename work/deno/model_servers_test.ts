/**
 * Model servers (server/agents/model_servers.ts): a server appears as its own entry per agent turned on for it, `<agent>@<server id>`
 * ("Claude Code · <server name>", "Codex · ...", "Maki · ...", "Qwen Code · ..."), that runs the SAME adapter as its base agent with
 * another environment (Codex: its own CODEX_HOME with a generated config.toml). The plumbing, with no UI:
 *   - the family helpers (baseAgent / isServerEntry / isClaudeFamily / isCodexFamily: codex@ acts like codex), and the settings list (add, edit, remove; key sealed in the data folder, never in the page's view)
 *   - the agent row, New chat on the PC (agent-choice.js) and on the phone (eligibility.ts)
 *   - the launch env (address, key or dummy, model), the same adapter argv as `claude`, an unreachable server's plain error
 *   - the model picker lists the server's models, not the adapter's
 *   - Claude-only behaviour (subagent tracking and hooks wiring, the session prompt rule, ownership, the allow matcher) treats the
 *     entries as Claude
 *   - a WSL launch gets the same env (fake helper: no real distro)
 * A fake Anthropic-compatible server (GET /v1/models) and the fake ACP agent; temp folders only. Never the owner's real server.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { fake } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import '../../app/page/agent-choice.js';
import { baseAgent, claudeBase, isClaudeFamily, isCodexFamily, isModelServerId, isServerEntry, modelServerAgentId, sameAgent, serverIdOf } from '../../app/server/agents/claude_family.ts';
import { isProvider } from '../../app/server/agents/agent_registry.ts';
import {
  betaServerEnv,
  checkModelServer,
  CODEX_KEY_ENV,
  codexConfigToml,
  codexWireApi,
  DUMMY_KEY,
  isLoopbackAddress,
  modelServerEnv,
  modelServerLabel,
  WSL_LOOPBACK_NOTE,
} from '../../app/server/agents/model_servers.ts';
import { isSealed, DPAPI_PREFIX } from '../../app/server/state/secrets.ts';
import { SettingsStore } from '../../app/server/state/settings.ts';
import { describeAgents } from '../../app/server/web/shared.ts';
import { eligibleAgents } from '../../app/server/agents/eligibility.ts';
import { aibRoutes } from '../../app/server/web/aib_routes.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { setDistroSource, setWslHostResolver } from '../../app/server/wsl/access.ts';
import { match, type MatchContext } from '../../app/server/allow/matcher.ts';
import { readSubagents, type SubagentChat, SubagentWorktrees } from '../../app/server/subagents/service.ts';
import { OwnershipProbe } from '../../app/server/ownership/probe.ts';
import { withServerModels } from '../../app/server/acp/breadth.ts';
import { makeMethods } from '../../app/server/wsl/helper/methods.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const WIN = Deno.build.os === 'windows';
const SEP = WIN ? '\\' : '/';
Deno.env.set('AGENT_STUDIO_TEST', '1');

const KEY = 'test-key-not-real-77aa31';

/** A temp folder outside the home folder when it can be made there (C:\ on Windows), else the OS temp folder. */
function outsideHome(prefix: string): string {
  if (WIN) {
    try {
      return Deno.realPathSync(Deno.makeTempDirSync({ dir: 'C:\\', prefix }));
    } catch { /* no write access at the drive root: the OS temp folder */ }
  }
  return Deno.realPathSync(Deno.makeTempDirSync({ prefix }));
}

class Lab {
  readonly dir = outsideHome('aib-modelserver-');
  readonly state = this.dir + SEP + 'state';
  readonly launcher = this.dir + SEP + 'claude-launcher.js';
  readonly codexLauncher = this.dir + SEP + 'codex-launcher.js';
  readonly studios: Aib[] = [];
  readonly servers: Deno.HttpServer[] = [];
  constructor() {
    Deno.writeTextFileSync(this.launcher, '');
    Deno.writeTextFileSync(this.codexLauncher, '');
  }

  /** A fake server that speaks the kinds asked for (an empty POST is rejected with 400: it speaks it, else 404) and lists models. */
  serveKinds(kinds: ('anthropic' | 'responses' | 'chat')[], models = ['fake-model-a']): { url: string } {
    const path = { anthropic: '/v1/messages', responses: '/v1/responses', chat: '/v1/chat/completions' };
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
      const at = new URL(request.url).pathname;
      if (request.method === 'GET' && at === '/v1/models') return Response.json({ data: models.map((id) => ({ id })) });
      const speaks = kinds.some((k) => path[k] === at);
      return new Response('{}', { status: request.method === 'POST' && speaks ? 400 : 404 });
    });
    this.servers.push(server);
    return { url: `http://127.0.0.1:${server.addr.port}` };
  }

  /** A fake Anthropic-compatible server: GET /v1/models lists these models; with `needKey` it answers 401 to any other key. */
  serve(models: string[] = ['fake-model-a', 'fake-model-b'], needKey = ''): { url: string; seen: Json[] } {
    const seen: Json[] = [];
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, (request) => {
      const key = request.headers.get('x-api-key') ?? '';
      seen.push({ path: new URL(request.url).pathname, key });
      if (needKey && key !== needKey) return new Response('{"error":"bad key"}', { status: 401 });
      return Response.json({ data: models.map((id) => ({ id, type: 'model' })) });
    });
    this.servers.push(server);
    return { url: `http://127.0.0.1:${server.addr.port}`, seen };
  }

  /** The address of a port nothing listens on. */
  deadAddress(): string {
    const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    return `http://127.0.0.1:${port}`;
  }

  studio(flags: string[] = []): Aib {
    const studio = new Aib(
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
const launched: { provider: string; env: Record<string, string> | null }[] = [];

Deno.test('the Claude family: claude and every claude@<slug>, nothing else', () => {
  for (const id of ['claude', 'claude@strata', 'claude@my-server-2']) assert(isClaudeFamily(id), id);
  for (const id of ['codex', 'custom-claude', 'claude@', 'claude@Bad Id', 'claude@a--', '', null, undefined, 3]) assert(!isClaudeFamily(id), String(id));
  assert(isModelServerId('claude@strata') && !isModelServerId('claude'));
  assertEquals([claudeBase('claude@strata'), claudeBase('claude'), claudeBase('codex')], ['claude', 'claude', 'codex']);
  assert(isProvider('claude@strata') && !isProvider('claude@'), 'the stores accept a model-server id as an agent id');
});

Deno.test('the family is Claude where AIB keys behaviour on it: the allow matcher, ownership keys, the subagent service', async () => {
  // allow matcher: a Bash request of a model-server chat is read like Claude's (not "unknown")
  const params = { toolCall: { toolCallId: 't1', kind: 'execute', title: 'Bash', rawInput: { command: 'git status' } } };
  const base = { toolName: 'Bash', mode: 'default', cwd: 'C:/aib-x/proj', project: 'C:/aib-x/proj' } as unknown as MatchContext;
  const a = match(params, { ...base, provider: 'claude' }, [], {} as never);
  const b = match(params, { ...base, provider: 'claude@strata' }, [], {} as never);
  assertEquals(JSON.stringify(b), JSON.stringify(a));
  // ownership: the same session is one claim whichever Claude entry opened it
  const probe = new OwnershipProbe({ registry: null, ownedByStudio: () => false, inspectProcesses: false, lockProbe: () => [] });
  probe.noteReleased('claude@strata', 's1');
  assert(probe.releasedAt('claude', 's1') !== null, 'a release by a model-server chat is the Claude session released');
  // subagent tracking: the same hooks, stream settling and turn cancel as claude
  const dir = outsideHome('aib-ms-sub-');
  try {
    const state = dir + SEP + 'state';
    const project = dir + SEP + 'proj';
    Deno.mkdirSync(project, { recursive: true });
    const git = (...args: string[]) =>
      new Deno.Command('git', { args: ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], cwd: project, stdout: 'null', stderr: 'null' }).outputSync();
    git('init', '-q', '-b', 'main');
    Deno.writeTextFileSync(project + SEP + 'a.txt', 'one\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    const chat: SubagentChat = {
      id: 'ab12ab12ab', provider: 'claude@strata', lasting: 'claude@strata:s1', folder: project, project,
      hooks: { readOnly: new Set(['Explore']), userWorktreeHook: false },
    };
    const service = new SubagentWorktrees(state, state + SEP + 'worktrees', (id) => (id === chat.id ? chat : null));
    const start = async (n: number, background: boolean) => {
      const input = { prompt: 'x', description: `sub ${n}`, ...(background ? { run_in_background: true } : {}) };
      await service.hook('pre-tool', chat.id, { tool_name: 'Agent', tool_use_id: `toolu_m${n}`, tool_input: input });
      await service.hook('worktree-create', chat.id, { name: `agent-mg${n}` });
    };
    const stateOf = (agentId: string) => Object.values(readSubagents(state)).find((r) => r.agentId === agentId)!;
    await start(1, true);
    await start(2, false);
    await service.turnCancelled(chat.id, 'claude@strata');
    assertEquals(stateOf('mg1').state, 'running', 'a background subagent is not part of the stopped turn (the Claude rule)');
    assertEquals(stateOf('mg2').state, 'stopped');
    await service.reconcileEnded(chat.id, new Map([['mg1', 'end_turn']]));
    assertEquals(stateOf('mg1').state, 'done');
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('settings: add, edit and remove a server; the key is sealed in the data folder and never reaches the page', async () => {
  await using lab = new Lab();
  const store = new SettingsStore(lab.state);
  Deno.mkdirSync(lab.state, { recursive: true });
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: ' http://127.0.0.1:8080/ ', model: 'qwen3.8-flash-next-iq3_s', key: KEY } } } });
  assertEquals(store.modelServers(), [{ id: 'strata', name: 'strata', url: 'http://127.0.0.1:8080', model: 'qwen3.8-flash-next-iq3_s', useWith: ['claude'] }]);
  assertEquals(store.betaKey('strata'), KEY);
  // at rest: never plain text, sealed with DPAPI on Windows (an owner-only file elsewhere)
  const file = Deno.readTextFileSync(lab.state + SEP + 'studio-settings.json');
  assert(!file.includes(KEY), 'the settings file holds the plain key');
  const stored = JSON.parse(file).agents.betaKeys['strata'] as string;
  assert(isSealed(stored), stored);
  if (WIN) assert(stored.startsWith(DPAPI_PREFIX), stored);
  assertEquals(new SettingsStore(lab.state).betaKey('strata'), KEY, 'read back after a restart');
  assert(!JSON.stringify(store.public()).includes(KEY), 'the page never gets the key');
  assert(JSON.stringify(store.public()).includes('strata'), 'the list itself is public: name, address, model');
  // a second server with the same name is refused; the same host with another name is a new entry with its own id
  await assertRejects(() => store.update({ agents: { modelServer: { upsert: { name: 'Strata', url: 'http://127.0.0.1:9' } } } }));
  await store.update({ agents: { modelServer: { upsert: { url: 'http://localhost:9000' } } } }); // no name: the address's host
  assertEquals(store.modelServers().map((s) => [s.id, s.name]), [['strata', 'strata'], ['localhost-9000', 'localhost:9000']]);
  // a bad address, a missing one, and an unknown field are refused; nothing is saved
  for (const url of ['ftp://x', 'strata', '', 'http://<host>:8080']) {
    await assertRejects(() => store.update({ agents: { modelServer: { upsert: { name: 'bad', url } } } }), Error);
  }
  assertEquals(store.modelServers().length, 2);
  // edit: a missing key keeps the stored one; '' clears it
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', model: 'other' } } } });
  assertEquals([store.modelServer('strata')!.model, store.betaKey('strata')], ['other', KEY]);
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', key: '' } } } });
  assertEquals(store.betaKey('strata'), '');
  // remove: the entry, its key and every default that named it go
  await store.update({ agents: { modelServer: { upsert: { id: 'strata', key: KEY } } } });
  await store.update({ defaults: { agent: 'claude@strata', byAgent: { 'claude@strata': { model: 'other' } } } });
  await store.update({ agents: { modelServer: { remove: 'strata' } } });
  assertEquals(store.modelServers().map((s) => s.id), ['localhost-9000']);
  assertEquals([store.betaKey('strata'), store.snapshot().defaults.agent, store.snapshot().defaults.byAgent], ['', '', {}]);
  assert(!Deno.readTextFileSync(lab.state + SEP + 'studio-settings.json').includes(KEY));
  await assertRejects(() => store.update({ agents: { modelServer: { remove: 'strata' } } }));
});

Deno.test('the server answers: reachable with its models, refused key, and an unreachable address named in one plain line', async () => {
  await using lab = new Lab();
  const up = lab.serve(['m1', 'm2'], KEY);
  const ok = await checkModelServer(up.url, KEY);
  assertEquals([ok.reachable, ok.models, ok.error], [true, ['m1', 'm2'], '']);
  assertEquals(up.seen.at(-1), { path: '/v1/models', key: KEY });
  const bad = await checkModelServer(up.url, 'wrong');
  assert(bad.reachable && bad.error.includes('refused the key') && bad.error.includes(up.url), bad.error);
  const dead = lab.deadAddress();
  const started = Date.now();
  const down = await checkModelServer(dead);
  assert(!down.reachable && down.error.includes(dead) && down.error.startsWith('Cannot reach the model server'), down.error);
  assert(Date.now() - started < 4000, 'a refused connection answers at once');
  // a server that never answers: gives up at the time limit, never hangs
  const hung = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const hungUrl = `http://127.0.0.1:${(hung.addr as Deno.NetAddr).port}`;
  const silent = await checkModelServer(hungUrl, '', 300);
  hung.close();
  assert(!silent.reachable && silent.error.includes(hungUrl) && silent.error.includes('no answer'), silent.error);
  // the route the page calls (a saved id, or an address being typed)
  const check = aibRoutes().get('POST /api/live/model-servers/check')!;
  const store = new SettingsStore(lab.state);
  Deno.mkdirSync(lab.state, { recursive: true });
  await store.update({ agents: { modelServer: { upsert: { name: 'fake', url: up.url, key: KEY } } } });
  const ctx = { settings: store } as never;
  const url = new URL('http://x/');
  const [s1, saved] = await check(ctx, url, { id: 'fake' }, undefined as never) as [number, Json];
  assertEquals([s1, saved.reachable, saved.models, saved.address], [200, true, ['m1', 'm2'], up.url]);
  const [s2, typed] = await check(ctx, url, { url: dead }, undefined as never) as [number, Json];
  assertEquals([s2, typed.reachable], [200, false]);
  assertEquals((await check(ctx, url, { url: 'nope' }, undefined as never) as [number, Json])[0], 400);
  assertEquals((await check(ctx, url, { id: 'gone' }, undefined as never) as [number, Json])[0], 404);
  assert(!JSON.stringify(saved).includes(KEY));
});

Deno.test('the agent row, New chat on the PC and New chat on the phone list "Claude Code · <name>" next to Claude Code', async () => {
  await using lab = new Lab();
  const store = new SettingsStore(lab.state);
  Deno.mkdirSync(lab.state, { recursive: true });
  await store.update({ agents: { modelServer: { upsert: { name: 'strata', url: 'http://127.0.0.1:8080', model: 'm', key: KEY } } } });
  const rows = await describeAgents({ claudeLauncher: lab.launcher, nodeCommand: Deno.execPath(), stateDir: lab.state }, store);
  const row = rows.find((r) => r.id === 'claude@strata')!;
  assertEquals([row.name, row.builtin, row.modelServer, row.enabled, row.signin], ['Claude Code \u00b7 strata', false, true, true, null]);
  assertEquals(rows.slice(0, 3).map((r) => r.id), ['claude', 'codex', 'claude@strata']);
  const info = row.modelServerInfo as Json;
  assertEquals([info.url, info.model, info.keySet, info.wslNote], ['http://127.0.0.1:8080', 'm', true, WSL_LOOPBACK_NOTE]);
  assert(!JSON.stringify(rows).includes(KEY), 'no key in the agent list');
  // PC
  const AC = (globalThis as unknown as { AgentChoice: { mergeRegistry(r: unknown): { all: { id: string; name: string; enabled: boolean }[] } } }).AgentChoice;
  const pc = AC.mergeRegistry(rows).all.find((a) => a.id === 'claude@strata')!;
  assertEquals([pc.name, pc.enabled], ['Claude Code \u00b7 strata', true]);
  // phone: the same agents, the same verdicts
  const phone = eligibleAgents(rows);
  assertEquals(phone.map((a) => [a.id, a.ok]), AC.mergeRegistry(rows).all.map((a) => [a.id, a.enabled]));
  assertEquals(phone.find((a) => a.id === 'claude@strata')!.name, 'Claude Code \u00b7 strata');
  // the adapter missing: the entry says so like Claude Code does
  const noAdapter = eligibleAgents(await describeAgents({ claudeLauncher: lab.dir + SEP + 'nope.js', nodeCommand: Deno.execPath(), stateDir: lab.state }, store));
  assertEquals(noAdapter.find((a) => a.id === 'claude@strata')!.reason, noAdapter.find((a) => a.id === 'claude')!.reason);
});

Deno.test('the launch env: the same adapter as claude, with the server address, key (or a dummy) and model', async () => {
  await using lab = new Lab();
  const up = lab.serve(['fake-model-a', 'fake-model-b']);
  const studio = lab.studio();
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'fake-model-b', key: KEY } } } });
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'plain', url: up.url } } } });
  const [claudeArgv] = await studio.agentLaunch('claude');
  const [argv, env] = await studio.agentLaunch('claude@strata');
  assertEquals(argv, claudeArgv, 'the same adapter command');
  assertEquals(env.ANTHROPIC_BASE_URL, up.url);
  assertEquals([env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY], [KEY, KEY]);
  assertEquals([env.ANTHROPIC_MODEL, env.ANTHROPIC_SMALL_FAST_MODEL, env.ANTHROPIC_DEFAULT_HAIKU_MODEL], ['fake-model-b', 'fake-model-b', 'fake-model-b']);
  assert(!('CLAUDE_CONFIG_DIR' in env), 'nothing else is set differently');
  // what claude itself gets is not changed, and a server with no key gets a dummy
  assert(!('ANTHROPIC_BASE_URL' in (await studio.agentLaunch('claude'))[1]));
  const [, plainEnv] = await studio.agentLaunch('claude@plain');
  assertEquals([plainEnv.ANTHROPIC_AUTH_TOKEN, plainEnv.ANTHROPIC_API_KEY, 'ANTHROPIC_MODEL' in plainEnv], [DUMMY_KEY, DUMMY_KEY, false]);
  assertEquals(modelServerEnv({ id: 'x', name: 'x', url: 'http://h', model: '', useWith: ['claude'] }, ''), { ANTHROPIC_BASE_URL: 'http://h', ANTHROPIC_AUTH_TOKEN: DUMMY_KEY, ANTHROPIC_API_KEY: DUMMY_KEY });
  // a removed server is a plain error, not a launch
  await studio.settings.update({ agents: { modelServer: { remove: 'plain' } } });
  await assertRejects(() => studio.agentLaunch('claude@plain'));
});

Deno.test('a chat on an unreachable model server says so with the address; nothing hangs, no agent is started', async () => {
  await using lab = new Lab();
  const dead = lab.deadAddress();
  const studio = lab.studio();
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'down', url: dead } } } });
  launched.length = 0;
  const started = Date.now();
  const error = await assertRejects(() => studio.connect('claude@down', lab.dir));
  assert(error.message.includes(dead) && error.message.startsWith('Cannot reach the model server'), error.message);
  assert(Date.now() - started < 8000, 'answered quickly');
  assertEquals(launched.length, 0, 'the adapter was never started');
  // the new chat's model lists (the quiet probe) say the same
  const probe = await studio.agentOptionsFor({ agent: 'claude@down', cwd: lab.dir, probe: true });
  assert(String(probe.probeError ?? '').includes(dead), JSON.stringify(probe));
});

Deno.test('a chat of a model server is a Claude chat: its env, its Claude wiring, and the server\'s models in the picker', async () => {
  await using lab = new Lab();
  const up = lab.serve(['srv-one', 'srv-two']);
  const studio = lab.studio(['--breadth']);
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'srv-two', key: KEY } } } });
  launched.length = 0;
  const chat = await studio.connect('claude@strata', lab.dir);
  assertEquals(launched.length, 1);
  assertEquals(launched[0].provider, 'claude@strata');
  assertEquals([launched[0].env!.ANTHROPIC_BASE_URL, launched[0].env!.ANTHROPIC_MODEL, launched[0].env!.ANTHROPIC_API_KEY], [up.url, 'srv-two', KEY]);
  // the picker: the server's models, the configured one current; the adapter's own list (fast/deep) is gone
  const model = ((chat.public().settings as Json).configOptions as Json[]).find((o) => o.category === 'model')!;
  assertEquals((model.options as Json[]).map((o) => o.value), ['srv-two', 'srv-one']);
  assertEquals(model.currentValue, 'srv-two');
  // picking another model goes to the adapter as a normal config change and is kept
  await chat.setConfig('model', 'srv-one');
  const after = ((chat.public().settings as Json).configOptions as Json[]).find((o) => o.category === 'model')!;
  assertEquals([after.currentValue, (after.options as Json[]).length], ['srv-one', 2]);
  // the same wiring claude gets (subagent hooks and turn rules)
  assertEquals(typeof chat.onClaudeTool, 'function', 'subagent tracking is wired to the chat the way it is for claude');
  assertEquals(typeof chat.onTurnCancelled, 'function');
  assertEquals(chat.provider, 'claude@strata');
  // and the model option withServerModels leaves a chat of another agent alone
  const other = { configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'fast', options: [{ value: 'fast' }] }] };
  assertEquals(withServerModels(other, [], 'x'), other);
});

Deno.test({
  name: 'WSL: a model-server chat in a distro gets the same env (fake helper, no real distro)',
  ...T,
  async fn() {
    await using lab = new Lab();
    const up = lab.serve();
    const host = new FakeWslHost(lab.dir + SEP + 'linux-keeper', 'Ubuntu');
    host.handlers['agents.detect'] = (p) => ({
      agents: ((p.ids as string[]) ?? []).map((id) => ({ id, found: true, command: ['/usr/bin/claude-agent-acp'] })),
    });
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, isDefault: true }]));
    const studio = lab.studio();
    await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'srv-two', key: KEY } } } });
    const wsl = { distro: 'ubuntu', linuxPath: '/home/u/app' };
    const launch = await studio.wslLaunch('claude@strata', wsl, true);
    assertEquals(launch.command, ['/usr/bin/claude-agent-acp'], 'the distro\u2019s own Claude adapter');
    for (const [name, value] of Object.entries(modelServerEnv(studio.settings.modelServer('strata')!, KEY))) assertEquals(launch.extra[name], value, name);
    assertEquals(host.calls.find(([m]) => m === 'agents.detect')![1], { ids: ['claude'] }, 'detects claude, not a made-up agent');
    // the plain note for an address that points at this PC
    assert(isLoopbackAddress('http://127.0.0.1:8080') && isLoopbackAddress('http://localhost:1') && !isLoopbackAddress('http://192.168.1.5:8080'));
    assert(WSL_LOOPBACK_NOTE.includes('WSL'));
  },
});

Deno.test('a server has its own id; agent entries and their label are built from it; its key is stored under the server id', async () => {
  await using lab = new Lab();
  const store = new SettingsStore(lab.state);
  Deno.mkdirSync(lab.state, { recursive: true });
  // a name that is another agent's id gets a suffix: the key store id never collides with an agent's
  await store.update({ agents: { modelServer: { upsert: { name: 'Claude', url: 'http://127.0.0.1:1', key: KEY } } } });
  await store.update({ agents: { modelServer: { upsert: { name: 'gemini', url: 'http://127.0.0.1:2' } } } });
  assertEquals(store.modelServers().map((s) => s.id), ['claude-2', 'gemini-2']);
  assertEquals(typeof JSON.parse(Deno.readTextFileSync(lab.state + SEP + 'studio-settings.json')).agents.betaKeys['claude-2'], 'string');
  const options = { claudeLauncher: lab.launcher, nodeCommand: Deno.execPath(), stateDir: lab.state };
  const row = (await describeAgents(options, store)).find((r) => r.id === 'claude@claude-2')!;
  assertEquals([row.name, row.serverId, (row.modelServerInfo as Json).id], ['Claude Code · Claude', 'claude-2', 'claude-2']);
  assertEquals(modelServerLabel('claude', 'strata'), 'Claude Code · strata');
  assertEquals([modelServerAgentId('claude', 'strata'), serverIdOf('claude@strata'), serverIdOf('claude')], ['claude@strata', 'strata', null]);
  // removing the server drops the agent entries built from it, their defaults and the key
  await store.update({ defaults: { agent: 'claude@claude-2' } });
  await store.update({ agents: { modelServer: { remove: 'claude-2' } } });
  assertEquals([store.snapshot().defaults.agent, store.betaKey('claude-2')], ['', '']);
  assert(!(await describeAgents(options, store)).some((r) => r.id === 'claude@claude-2'));
});

Deno.test('parity helpers: codex@, maki@ and qwen@ are entries that act like their base agent; the Claude family is unchanged', () => {
  for (const id of ['claude@strata', 'codex@strata', 'maki@strata', 'qwen@my-server-2']) assert(isModelServerId(id) && isServerEntry(id) && isProvider(id), id);
  for (const id of ['claude', 'codex', 'maki', 'qwen', 'gemini@x', 'codex@', 'codex@Bad', 'custom-codex@x', 'codex@a--']) assert(!isServerEntry(id), id);
  assertEquals(['claude@a', 'codex@a', 'maki@a', 'qwen@a', 'codex', 'custom-x'].map(baseAgent), ['claude', 'codex', 'maki', 'qwen', 'codex', 'custom-x']);
  assertEquals(['claude@a', 'codex@a', 'maki@a', 'qwen@a'].map((id) => claudeBase(id)), ['claude', 'codex', 'maki', 'qwen']);
  assert(isCodexFamily('codex') && isCodexFamily('codex@strata') && !isCodexFamily('claude@strata') && !isCodexFamily('maki@strata'));
  assert(isClaudeFamily('claude@strata') && !isClaudeFamily('codex@strata'), 'codex@ is not the Claude family');
  assertEquals([serverIdOf('codex@strata'), serverIdOf('maki@x'), serverIdOf('qwen')], ['strata', 'x', null]);
  assertEquals([modelServerAgentId('codex', 'strata'), modelServerLabel('codex', 'strata'), modelServerLabel('maki', 's'), modelServerLabel('qwen', 's')], ['codex@strata', 'Codex \u00b7 strata', 'Maki \u00b7 s', 'Qwen Code \u00b7 s']);
  assert(sameAgent('claude', 'claude@x') && !sameAgent('codex', 'codex@x'), 'only the Claude family shares one saved-chat folder');
});

Deno.test('parity: the allow matcher, ownership and the subagent service treat codex@ like codex', async () => {
  const params = { toolCall: { toolCallId: 't1', kind: 'execute', title: 'Run', rawInput: { command: 'git status' } } };
  const base = { toolName: 'Run', cwd: 'C:/aib-x/proj', project: 'C:/aib-x/proj' } as unknown as MatchContext;
  for (const mode of ['auto', 'read-only', 'full-access', 'default']) {
    const a = match(params, { ...base, mode, provider: 'codex' }, [], {} as never);
    const b = match(params, { ...base, mode, provider: 'codex@strata' }, [], {} as never);
    assertEquals(JSON.stringify(b), JSON.stringify(a), mode);
  }
  const probe = new OwnershipProbe({ registry: null, ownedByStudio: () => false, inspectProcesses: false, lockProbe: () => [] });
  probe.noteReleased('codex@strata', 's9');
  assert(probe.releasedAt('codex', 's9') !== null, 'a release by a codex@ chat is the Codex session released');
});

Deno.test('the Codex entry launches with its OWN CODEX_HOME and a generated config.toml (wire_api from the API kinds); the key goes in its env', async () => {
  await using lab = new Lab();
  const both = lab.serveKinds(['responses', 'chat'], ['gpt-local', 'other']);
  const chatOnly = lab.serveKinds(['chat']);
  const studio = lab.studio();
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: both.url + '/', model: 'gpt-local', key: KEY, useWith: ['codex'] } } } });
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'plain chat', url: chatOnly.url, useWith: ['codex'] } } } });
  const [normalArgv, normalEnv] = await studio.agentLaunch('codex');
  const [argv, env] = await studio.agentLaunch('codex@strata');
  assertEquals(argv, normalArgv, 'the same Codex adapter command as normal Codex');
  assert(!('CODEX_HOME' in normalEnv) && !(CODEX_KEY_ENV in normalEnv), 'normal Codex is not changed');
  const home = lab.state + SEP + 'codex-home' + SEP + 'strata';
  assertEquals(env.CODEX_HOME, home, 'a folder AIB owns, in its data folder');
  assertEquals(env[CODEX_KEY_ENV], KEY);
  const toml = Deno.readTextFileSync(home + SEP + 'config.toml');
  assertEquals(
    toml.split('\n').filter((l) => l && !l.startsWith('#')),
    [
      'model_provider = "strata"',
      'model = "gpt-local"',
      '[model_providers.strata]',
      'name = "strata"',
      `base_url = "${both.url}/v1"`,
      `env_key = "${CODEX_KEY_ENV}"`,
      'wire_api = "responses"',
    ],
  );
  assert(!toml.includes(KEY), 'the key is never written to the file');
  assert(!home.includes(SEP + '.codex'), 'never the owner\u2019s ~/.codex');
  // a server that speaks only Chat Completions: wire_api = "chat"; no key: a dummy
  const [, chatEnv] = await studio.agentLaunch('codex@plain-chat');
  assertEquals(chatEnv[CODEX_KEY_ENV], DUMMY_KEY);
  const chatToml = Deno.readTextFileSync(lab.state + SEP + 'codex-home' + SEP + 'plain-chat' + SEP + 'config.toml');
  assert(chatToml.includes('wire_api = "chat"') && !chatToml.includes('model = '), chatToml);
  assertEquals([codexWireApi([]), codexWireApi(['anthropic']), codexWireApi(['chat']), codexWireApi(['chat', 'responses'])], ['responses', 'responses', 'chat', 'responses']);
  // an address that already ends in /v1, and a provider id that Codex reserves
  const text = codexConfigToml({ id: 'ollama', name: 'o', url: 'http://h:1/v1', model: '', useWith: ['codex'] }, 'responses');
  assert(text.includes('model_provider = "aib-ollama"') && text.includes('[model_providers.aib-ollama]') && text.includes('base_url = "http://h:1/v1"'), text);
  // the unreachable server: a plain error naming the address, nothing written, no adapter started
  const dead = lab.deadAddress();
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'down', url: dead, useWith: ['codex'] } } } });
  const error = await assertRejects(() => studio.agentLaunch('codex@down'));
  assert(error.message.includes(dead), error.message);
});

Deno.test('a Codex entry chat starts the Codex adapter with CODEX_HOME and the key, and is wired like a Codex chat', async () => {
  await using lab = new Lab();
  const up = lab.serveKinds(['responses'], ['srv-one', 'srv-two']);
  const studio = lab.studio(['--breadth']);
  await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'srv-two', key: KEY, useWith: ['codex'] } } } });
  launched.length = 0;
  const chat = await studio.connect('codex@strata', lab.dir);
  assertEquals(launched.length, 1);
  assertEquals(launched[0].provider, 'codex@strata');
  assertEquals([launched[0].env!.CODEX_HOME, launched[0].env![CODEX_KEY_ENV]], [lab.state + SEP + 'codex-home' + SEP + 'strata', KEY]);
  assertEquals(typeof chat.onTurnCancelled, 'function', 'a Codex chat\u2019s subagent wiring');
  assertEquals((chat.public() as Json).steerAgent, 'codex', 'steering is the Codex chat\u2019s');
  const model = ((chat.public().settings as Json).configOptions as Json[]).find((o) => o.category === 'model')!;
  assertEquals((model.options as Json[]).map((o) => o.value), ['srv-two', 'srv-one'], 'the server\u2019s models in the picker');
});

Deno.test('Maki and Qwen Code entries start their normal adapter with the server env; the normal entries are not given it', async () => {
  await using lab = new Lab();
  const bin = lab.dir + SEP + 'bin';
  Deno.mkdirSync(bin);
  for (const name of ['qwen', 'qwen.exe', 'maki', 'maki.exe']) Deno.writeTextFileSync(bin + SEP + name, '');
  const before = Deno.env.get('PATH') ?? '';
  Deno.env.set('PATH', bin + (WIN ? ';' : ':') + before);
  try {
    const up = lab.serve(['m-a', 'm-b']);
    const studio = lab.studio();
    await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'm-b', key: KEY, useWith: ['maki', 'qwen'] } } } });
    launched.length = 0;
    await studio.connect('qwen@strata', lab.dir);
    await studio.connect('maki@strata', lab.dir);
    assertEquals(launched.map((l) => l.provider), ['qwen@strata', 'maki@strata']);
    assertEquals(launched[0].env, { OPENAI_BASE_URL: up.url, OPENAI_API_KEY: KEY, OPENAI_MODEL: 'm-b' });
    assertEquals(launched[1].env, { ANTHROPIC_BASE_URL: up.url, ANTHROPIC_API_KEY: KEY });
    const [qwenArgv] = await studio.agentLaunch('qwen@strata');
    assertEquals(qwenArgv.slice(-2), ['--auth-type', 'openai'], 'Qwen Code is told to use OpenAI auth (a stale selectedType in its settings cannot win)');
    assert(!(await studio.agentLaunch('qwen').then(([a]) => a.includes('--auth-type'), () => false)), 'the normal Qwen entry is unchanged');
    assertEquals(betaServerEnv('qwen', studio.settings.modelServer('strata')!, ''), { OPENAI_BASE_URL: up.url, OPENAI_API_KEY: DUMMY_KEY, OPENAI_MODEL: 'm-b' });
  } finally {
    Deno.env.set('PATH', before);
  }
});

Deno.test({
  name: 'WSL: Codex, Maki and Qwen Code entries get the same env in a distro; Codex gets its own CODEX_HOME there (fake helper)',
  ...T,
  async fn() {
    await using lab = new Lab();
    const up = lab.serveKinds(['responses', 'chat'], ['srv-two']);
    const host = new FakeWslHost(lab.dir + SEP + 'linux-keeper', 'Ubuntu');
    host.handlers['agents.detect'] = (p) => ({
      agents: ((p.ids as string[]) ?? []).map((id) => ({ id, found: true, command: [`/usr/bin/${id}-acp`] })),
    });
    const written: Json[] = [];
    host.handlers['codexhome.write'] = (p) => {
      written.push(p);
      return { path: '/home/u/.aib-server/codex-home/' + p.id };
    };
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, isDefault: true }]));
    const studio = lab.studio();
    await studio.settings.update({ agents: { modelServer: { upsert: { name: 'strata', url: up.url, model: 'srv-two', key: KEY, useWith: ['claude', 'codex', 'maki', 'qwen'] } } } });
    const server = studio.settings.modelServer('strata')!;
    const wsl = { distro: 'ubuntu', linuxPath: '/home/u/app' };
    const codex = await studio.wslLaunch('codex@strata', wsl, true);
    assertEquals(codex.command, ['/usr/bin/codex-acp'], 'the distro\u2019s own Codex adapter');
    assertEquals(codex.extra.CODEX_HOME, '/home/u/.aib-server/codex-home/strata', 'its own folder inside the distro');
    assertEquals(codex.extra[CODEX_KEY_ENV], KEY);
    assertEquals(written, [{ id: 'strata', toml: codexConfigToml(server, 'responses') }], 'the same generated config.toml as on Windows');
    const qwen = await studio.wslLaunch('qwen@strata', wsl, true);
    assertEquals(qwen.command, ['/usr/bin/qwen-acp', '--auth-type', 'openai'], 'OpenAI auth by flag, whatever the distro settings say');
    for (const [name, value] of Object.entries(betaServerEnv('qwen', server, KEY))) assertEquals(qwen.extra[name], value, name);
    const maki = await studio.wslLaunch('maki@strata', wsl, true);
    for (const [name, value] of Object.entries(betaServerEnv('maki', server, KEY))) assertEquals(maki.extra[name], value, name);
    assert(!('CODEX_HOME' in maki.extra) && !('CODEX_HOME' in qwen.extra));
    assertEquals(host.calls.filter(([m]) => m === 'agents.detect').map(([, p]) => (p.ids as string[])[0]), ['codex', 'qwen', 'maki']);
    // normal Codex in the distro: no server env, no CODEX_HOME of ours
    const plain = await studio.wslLaunch('codex', wsl, true);
    assert(!('CODEX_HOME' in plain.extra) && !(CODEX_KEY_ENV in plain.extra));
  },
});

Deno.test('the helper writes the distro\u2019s Codex entry home inside AIB\u2019s own folder only', async () => {
  const root = outsideHome('aib-ms-helper-');
  try {
    const methods = makeMethods({
      env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home: root, arch: 'amd64' }),
      own: [root + SEP + '.aib-server'],
    });
    const write = methods['codexhome.write'];
    const answer = await write({ id: 'strata', toml: 'model_provider = "strata"\n' }) as { path: string };
    assertEquals(answer.path, root + SEP + '.aib-server' + SEP + 'codex-home' + SEP + 'strata');
    assertEquals(Deno.readTextFileSync(answer.path + SEP + 'config.toml'), 'model_provider = "strata"\n');
    await write({ id: 'strata', toml: 'again\n' });
    assertEquals(Deno.readTextFileSync(answer.path + SEP + 'config.toml'), 'again\n');
    for (const id of ['../x', 'A', '', 'a/b']) await assertRejects(async () => await write({ id, toml: 'x' }));
    assert(!Deno.statSync(root).isFile);
  } finally {
    Deno.removeSync(root, { recursive: true });
  }
});
