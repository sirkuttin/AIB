/**
 * Swarm helpers on model-server entries (server/swarm/service.ts, owner decision 2026-11-23): a main chat can hand a job to
 * `claude@strata` / `codex@strata`. helper_providers lists every entry whose "Use with" switch is on (label "<Agent> · <server>",
 * its base agent's workspace mode, ok/reason); start_helper accepts one and launches it exactly as a New chat of that entry
 * (same env, CODEX_HOME and argv, in its own worktree, with its label in the Activity line); a server that does not answer is
 * refused in one plain line, never a hang; WSL projects get the same env from the same launch (fake helper) and the same refusal
 * every helper gets there. A fake Anthropic-compatible model server, the fake ACP agent, temp folders and git only.
 */
import { assert, assertEquals } from './_assert.ts';
import { FAKE, FAKE_UNIQUE, NODE, pause, until } from './_connection.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { makeRepo, runGit } from './_worktree_fixtures.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { modelServerEnv } from '../../app/server/agents/model_servers.ts';
import { Swarm } from '../../app/server/swarm/service.ts';
import { setSwarmEnabled } from '../../app/server/swarm/settings.ts';
import { setDistroSource, setWslHostResolver } from '../../app/server/wsl/access.ts';
import { pathOf } from '../../app/server/state/paths.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const UNIQUE = FAKE_UNIQUE;
const KEY = 'test-key-not-real-55cc12';
Deno.env.set('AGENT_STUDIO_TEST', '1');

const BRIEF: Json = {
  title: 'Local summaries',
  job: 'other',
  goal: 'Summarise the docs folder.',
  owns: ['docs/**'],
  done_when: 'a summary is written',
  reply_with: 'the summary in one line',
  test_cmd: 'none: a writing job',
  provider: 'claude@strata',
  why: 'private and cheap: keep it on the local server',
};

class Box {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-swarm-ms-' }));
  readonly state = pathOf(this.dir, 'state');
  readonly project = makeRepo(pathOf(this.dir, 'proj'));
  readonly launcher = pathOf(this.dir, 'launcher.js');
  readonly aib: Aib;
  readonly swarm: Swarm;
  readonly launched: { provider: string; command: string[]; cwd: string; env: Record<string, string> | null }[] = [];
  readonly servers: Deno.HttpServer[] = [];

  constructor() {
    setSwarmEnabled(this.state, true);
    Deno.writeTextFileSync(this.launcher, '');
    runGit(this.project, 'config', 'user.name', 't');
    runGit(this.project, 'config', 'user.email', 't@t');
    const aib = new Aib(
      { stateDir: this.state, port: 0, ownersDir: null, noArtifactTool: false, claudeLauncher: this.launcher, codexLauncher: this.launcher, nodeCommand: Deno.execPath() },
      { keeper: null },
    );
    aib.ownerProbe = () => null;
    aib.connectionFactory = (command, cwd, provider, options) => {
      this.launched.push({ provider, command, cwd, env: options?.env ?? null });
      return new Connection([NODE, UNIQUE, '--models', ...(provider.startsWith('claude') ? ['--claude-modes'] : [])], cwd, provider, options ?? {});
    };
    this.aib = aib;
    this.swarm = new Swarm({ stateDir: this.state, host: aib, settings: aib.settings });
    this.swarm.openMs = 30_000;
  }

  /** A fake Anthropic-compatible server (GET /v1/models). */
  serve(): string {
    const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, () => Response.json({ data: [{ id: 'srv-one' }, { id: 'srv-two' }] }));
    this.servers.push(server);
    return `http://127.0.0.1:${server.addr.port}`;
  }

  deadAddress(): string {
    const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (probe.addr as Deno.NetAddr).port;
    probe.close();
    return `http://127.0.0.1:${port}`;
  }

  async server(url: string, useWith: string[], name = 'strata'): Promise<void> {
    await this.aib.settings.update({ agents: { modelServer: { upsert: { id: 'strata', name, url, model: 'srv-two', key: KEY, useWith } } } });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.swarm.stopWatching();
    await this.aib.close().catch(() => {});
    for (const s of this.servers) await s.shutdown().catch(() => {});
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

const providers = async (box: Box, mainId: string): Promise<Json[]> => ((await box.swarm.tool(mainId, 'helper_providers', {}))[1] as Json).providers as Json[];

Deno.test({
  ...T,
  name: 'helper_providers lists claude@strata and codex@strata when their Use with is on, with label and base mode; not when off',
  async fn() {
    await using box = new Box();
    const main = await box.aib.connect('claude', box.project, null, { ownCopy: true });
    assert(!(await providers(box, main.id)).some((p) => String(p.id).includes('@')), 'no server: no entries');
    await box.server(box.serve(), ['claude', 'codex']);
    const on = await providers(box, main.id);
    const claude = on.find((p) => p.id === 'claude@strata')!;
    const codex = on.find((p) => p.id === 'codex@strata')!;
    assertEquals([claude.name, claude.ok, claude.reason, claude.workspaceMode], ['Claude Code · strata', true, '', 'acceptEdits']);
    assertEquals([codex.name, codex.ok, codex.workspaceMode], ['Codex · strata', true, 'workspace-write']);
    assert(on.some((p) => p.id === 'claude') && on.some((p) => p.id === 'gemini'), 'the built-ins stay');
    assert(!on.some((p) => p.id === 'maki@strata' || p.id === 'qwen@strata'), 'agents with no helper mode are not listed');
    await box.server(box.serve(), ['codex']);
    const codexOnly = await providers(box, main.id);
    assert(!codexOnly.some((p) => p.id === 'claude@strata') && codexOnly.some((p) => p.id === 'codex@strata'), 'a switch that is off adds nothing');
    await box.server(box.serve(), []);
    assert(!(await providers(box, main.id)).some((p) => String(p.id).includes('@')), 'all off: no entries');
    // switched off, naming it is refused
    const refused = await box.swarm.tool(main.id, 'start_helper', BRIEF);
    assertEquals([refused[0], (refused[1] as Json).code], [409, 'provider_unavailable']);
    assert(String((refused[1] as Json).error).includes('not switched on'), JSON.stringify(refused[1]));
  },
});

Deno.test({
  ...T,
  name: 'start_helper with claude@strata: the same launch as a New chat of that entry, its own worktree, the label in the Activity line',
  async fn() {
    await using box = new Box();
    const url = box.serve();
    await box.server(url, ['claude']);
    const main = await box.aib.connect('claude', box.project, null, { ownCopy: true });
    const [newChatArgv, newChatEnv] = await box.aib.agentLaunch('claude@strata');
    box.launched.length = 0;
    const [code, out] = await box.swarm.tool(main.id, 'start_helper', BRIEF);
    assertEquals(code, 200, JSON.stringify(out));
    assertEquals([(out as Json).provider, (out as Json).picked_by], ['claude@strata', 'main agent']);
    const id = String((out as Json).helper);
    await until(() => box.swarm.registry.get(id)?.state === 'working', 'the helper working', 30);
    const h = box.swarm.registry.get(id)!;
    const launch = box.launched.find((l) => l.provider === 'claude@strata')!;
    assertEquals(launch.command, newChatArgv, 'the same adapter argv as a New chat');
    assertEquals(launch.env, newChatEnv, 'the same env as a New chat');
    for (const [name, value] of Object.entries(modelServerEnv(box.aib.settings.modelServer('strata')!, KEY))) assertEquals(launch.env![name], value, name);
    assertEquals(launch.env!.ANTHROPIC_BASE_URL, url);
    const helper = box.aib.connections.get(h.chat.live)!;
    assert(h.worktree.branch.startsWith('studio/helper-') && helper.cwd !== box.project && helper.worktree, 'its own worktree, never the project folder');
    assertEquals(helper.swarm?.role, 'helper');
    assertEquals(h.chat.mode, 'acceptEdits', "Claude Code's edit-in-workspace mode");
    assertEquals((helper.settings.modes as Json).currentModeId, 'acceptEdits');
    // Activity: the start line names the entry; the registry keeps the label
    const line = main.events.filter((e) => e.kind === 'studio_note').map((e) => e.data as Json).find((n) => n.kind === 'swarm-start')!;
    assert(String(line.message).startsWith('Started helper “Local summaries” · Claude Code · strata ·'), String(line.message));
    assertEquals(h.chat.label, 'Claude Code · strata');
    // it counts toward the cap like any helper
    const cap = ((await box.swarm.tool(main.id, 'helper_providers', {}))[1] as Json).caps as Json;
    assertEquals([cap.running, cap.max], [1, 3]);
    await box.swarm.tool(main.id, 'stop_helper', { helper: id });
  },
});

Deno.test({
  ...T,
  name: "start_helper with codex@strata: the entry's own CODEX_HOME, the Codex mode",
  async fn() {
    await using box = new Box();
    await box.server(box.serve(), ['codex']);
    const main = await box.aib.connect('claude', box.project, null, { ownCopy: true });
    const [, newChatEnv] = await box.aib.agentLaunch('codex@strata');
    assert(newChatEnv.CODEX_HOME?.includes('strata'), JSON.stringify(newChatEnv));
    box.launched.length = 0;
    const [code, out] = await box.swarm.tool(main.id, 'start_helper', { ...BRIEF, provider: 'codex@strata' });
    assertEquals(code, 200, JSON.stringify(out));
    const id = String((out as Json).helper);
    await until(() => box.swarm.registry.get(id)?.state === 'working', 'the helper working', 30);
    const launch = box.launched.find((l) => l.provider === 'codex@strata')!;
    assertEquals(launch.env, newChatEnv, 'the same env, CODEX_HOME included');
    assertEquals(box.swarm.registry.get(id)!.chat.mode, 'auto');
  },
});

Deno.test({
  ...T,
  name: 'a model server that does not answer: refused in one plain line, quickly, no adapter started; helper_providers greys the entry',
  async fn() {
    await using box = new Box();
    const dead = box.deadAddress();
    await box.server(dead, ['claude']);
    const main = await box.aib.connect('claude', box.project, null, { ownCopy: true });
    box.launched.length = 0;
    const started = Date.now();
    const [code, out] = await box.swarm.tool(main.id, 'start_helper', BRIEF);
    assertEquals([code, (out as Json).code], [409, 'provider_unavailable']);
    assertEquals((out as Json).error, `strata is not answering at ${dead.replace('http://', '')}`);
    assert(Date.now() - started < 8000, 'answered quickly');
    assertEquals(box.launched.length, 0, 'no helper chat was started');
    assertEquals(box.swarm.registry.all().length, 0, 'no helper record was left');
    const entry = (await providers(box, main.id)).find((p) => p.id === 'claude@strata')!;
    assertEquals([entry.ok, entry.reason], [false, `strata is not answering at ${dead.replace('http://', '')}`]);
  },
});

Deno.test({
  ...T,
  name: 'WSL: a model-server helper gets the env a distro launch gets (fake helper); a WSL chat is refused helpers as for every provider',
  async fn() {
    await using box = new Box();
    const url = box.serve();
    await box.server(url, ['claude']);
    const host = new FakeWslHost(pathOf(box.dir, 'linux-keeper'), 'Ubuntu');
    host.handlers['agents.detect'] = (p) => ({ agents: ((p.ids as string[]) ?? []).map((id) => ({ id, found: true, command: ['/usr/bin/claude-agent-acp'] })) });
    setWslHostResolver((d) => (d === 'ubuntu' ? host : null));
    setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, isDefault: true }]));
    const launch = await box.aib.wslLaunch('claude@strata', { distro: 'ubuntu', linuxPath: '/home/u/app' }, true);
    const [, windowsEnv] = await box.aib.agentLaunch('claude@strata');
    for (const name of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) assertEquals(launch.extra[name], windowsEnv[name], name);
    // the swarm service refuses a WSL chat before it looks at the provider (Swarm.mainChat), so no helper starts there
    const state: Json = {
      id: 'wslchat1', provider: 'claude', sessionId: 's1', cwd: 'wsl://ubuntu/home/u/.aib-server/data-x/worktrees/app-abc',
      projectRoot: 'wsl://ubuntu/home/u/app', worktree: { branch: 'aib/chat-1', base: 'main' },
      wsl: { distro: 'ubuntu', name: 'Ubuntu', linuxPath: '/home/u/x' }, closed: false,
    };
    const calls: string[] = [];
    const swarm = new Swarm({
      stateDir: box.state,
      host: {
        liveList: () => Promise.resolve({ active: [state] }),
        liveState: () => Promise.resolve(state),
        liveCall: (name) => (calls.push(name), Promise.resolve([500, { error: 'stub' }] as [number, unknown])),
      },
      settings: box.aib.settings,
    });
    const [status, payload] = await swarm.tool('wslchat1', 'start_helper', BRIEF);
    assert(status >= 400 && (payload as Json).code === 'wsl', JSON.stringify(payload));
    assertEquals(calls, []);
  },
});
