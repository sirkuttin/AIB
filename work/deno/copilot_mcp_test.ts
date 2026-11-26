/**
 * GitHub Copilot CLI gets AIB's tools (server/agents/copilot_mcp.ts): the config file and the launch arguments, the chat started with
 * them (a fake agent whose command has `--acp`), the approval of Copilot's own naming (`studio_artifact-<tool>`), the cleanup, and the
 * WSL route (a fake WSL host: Copilot is not installed in the distro here). The real program is in e2e_copilot_aib_tools_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { withEnv } from './_agents.ts';
import { Sandbox } from './_worktree_fixtures.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection, ownToolAction } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { keeperBinary } from '../../app/server/keeper/client.ts';
import {
  configFileOf,
  COPILOT_MCP_FLAG,
  copilotMcpCommand,
  copilotMcpConfig,
  copilotToolName,
  removeConfig,
  serversOf,
  splitCopilotToolName,
  sweepConfigs,
  writeConfigFile,
} from '../../app/server/agents/copilot_mcp.ts';
import { COPILOT_FLAG, COPILOT_TOOLS_PROMPT, nativeOffNote, nativeOffPrompt } from '../../app/server/subagents/native_off.ts';
import { BETA_AGENTS } from '../../app/server/agents/beta_catalog.ts';
import { join } from '../../app/server/platform/ospath.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const STDIO = {
  name: 'studio_artifact',
  command: 'C:/AIB/AIB.exe',
  args: ['mcp-artifact'],
  env: [{ name: 'STUDIO_ARTIFACT_KEY', value: 'k1' }, { name: 'STUDIO_CONVERSATION_ID', value: 'c1' }],
};
const HTTP = {
  type: 'http',
  name: 'studio_artifact',
  url: 'http://127.0.0.1:5/mcp',
  headers: [{ name: 'X-Studio-Artifact-Key', value: 'k1' }],
};

Deno.test('Copilot config: the same servers other agents get, in the shape Copilot reads, every tool allowed', () => {
  const stdio = JSON.parse(copilotMcpConfig([STDIO as never])!);
  assertEquals(stdio, {
    mcpServers: {
      studio_artifact: {
        type: 'stdio',
        command: 'C:/AIB/AIB.exe',
        args: ['mcp-artifact'],
        env: { STUDIO_ARTIFACT_KEY: 'k1', STUDIO_CONVERSATION_ID: 'c1' },
        tools: ['*'],
      },
    },
  });
  // the http entry is listed first and the stdio one is its fallback under the same name: the first of a name is the one
  const both = JSON.parse(copilotMcpConfig([HTTP as never, STDIO as never])!);
  assertEquals(both.mcpServers.studio_artifact, {
    type: 'http',
    url: 'http://127.0.0.1:5/mcp',
    headers: { 'X-Studio-Artifact-Key': 'k1' },
    tools: ['*'],
  });
  assertEquals(copilotMcpConfig([]), null, 'no servers: no file');
  assertEquals(serversOf(copilotMcpConfig([STDIO as never])!).studio_artifact !== undefined, true);
  assertEquals(serversOf('not json'), {});
});

Deno.test('Copilot launch args: --additional-mcp-config @file right after --acp; once; unchanged input; no --acp: nothing', () => {
  const command = ['C:/tools/copilot.exe', '--acp', '--no-auto-update'];
  const before = [...command];
  assertEquals(copilotMcpCommand(command, 'C:/s/mcp.json'), [
    'C:/tools/copilot.exe',
    '--acp',
    COPILOT_MCP_FLAG,
    '@C:/s/mcp.json',
    '--no-auto-update',
  ]);
  assertEquals(command, before);
  const again = copilotMcpCommand(command, 'C:/s/mcp.json')!;
  assertEquals(copilotMcpCommand(again, 'C:/s/mcp.json'), again, 'never added twice');
  // beside the subagents-off flag AIB adds: both are single arguments, so neither can swallow the other
  const off = ['C:/tools/copilot.exe', '--acp', COPILOT_FLAG];
  assertEquals(copilotMcpCommand(off, '/s/mcp.json'), ['C:/tools/copilot.exe', '--acp', COPILOT_MCP_FLAG, '@/s/mcp.json', COPILOT_FLAG]);
  assertEquals(copilotMcpCommand(['copilot'], '/s/mcp.json'), null);
  assertEquals(copilotMcpCommand(['--acp'], '/s/mcp.json'), null, 'the program is first');
});

Deno.test("Copilot tool names: <server>-<tool>; AIB's own are told apart and map back to the tool and action AIB's approvals use", () => {
  assertEquals(copilotToolName('studio_artifact', 'doc'), 'studio_artifact-doc');
  for (const tool of ['publish', 'artifacts', 'doc', 'drawing', 'helper', 'merge_into_project']) {
    assertEquals(splitCopilotToolName(`studio_artifact-${tool}`), { server: 'studio_artifact', tool });
  }
  assertEquals(splitCopilotToolName('other-doc'), null);
  assertEquals(splitCopilotToolName('studio_artifact'), null);
  assertEquals(splitCopilotToolName('powershell'), null);
  // Copilot (1.0.109): tool_call titled studio_artifact-doc with the arguments as rawInput; the permission request titled just `doc`.
  // The tool is known from the tool_call (ToolSeen.mcp), as Codex's is, so tool + action reach the same rules as every agent's.
  const permission = { toolCallId: 't1', title: 'doc', kind: 'other', status: 'pending', rawInput: { action: 'list' } };
  assertEquals(ownToolAction(permission, null), null, "a bare `doc` alone is nobody's tool");
  const seen = { server: 'studio_artifact', tool: 'doc', action: 'list' };
  assertEquals(ownToolAction(permission, seen), { tool: 'doc', action: 'list' });
  assertEquals(ownToolAction({ ...permission, rawInput: { action: 'create' } }, { ...seen, action: 'create' }), {
    tool: 'doc',
    action: 'create',
  });
});

Deno.test("Copilot config files: written in AIB's own folder, the same bytes on a reopen, removed, and swept when old and not in use", () => {
  const box = new Sandbox();
  try {
    const chat = 'a'.repeat(32);
    const other = 'b'.repeat(32);
    const file = configFileOf(box.state, chat);
    assertEquals(file, join(box.state, 'copilot', chat, 'mcp.json'));
    const text = copilotMcpConfig([STDIO as never])!;
    writeConfigFile(file, text);
    assertEquals(Deno.readTextFileSync(file), text);
    writeConfigFile(file, text);
    assertEquals(Deno.readTextFileSync(file), text, 'the same bytes again');
    writeConfigFile(configFileOf(box.state, other), text);
    // young files stay; an old one of a chat that is not in use goes; one in use stays
    assertEquals(sweepConfigs(box.state, new Set()), 0);
    const old = new Date(Date.now() - 2 * 3600 * 1000);
    Deno.utimeSync(join(box.state, 'copilot', chat), old, old);
    Deno.utimeSync(join(box.state, 'copilot', other), old, old);
    assertEquals(sweepConfigs(box.state, new Set([other])), 1);
    assert(!exists(file) && exists(configFileOf(box.state, other)));
    removeConfig(box.state, other);
    assert(!exists(configFileOf(box.state, other)));
    removeConfig(box.state, other); // gone already: never throws
  } finally {
    box[Symbol.dispose]();
  }
});

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

Deno.test('Copilot card and chat text: AIB tools available, own subagents off, AIB helpers for parallel work', () => {
  const copilot = BETA_AGENTS.find((a) => a.id === 'copilot')!;
  assert(copilot.note!.includes('are available in Copilot chats'), copilot.note);
  assert(!/not available/.test(copilot.note!), copilot.note);
  assert(/subagents stay off/.test(copilot.note!) && /helpers \(Claude, Codex or Gemini\)/.test(copilot.note!), copilot.note);
  assert(nativeOffNote('copilot').includes("AIB's own tools are available") && nativeOffNote('copilot').includes('AIB helpers'));
  assert(nativeOffPrompt('copilot').includes(COPILOT_TOOLS_PROMPT));
  assert(COPILOT_TOOLS_PROMPT.includes('studio_artifact-helper') && COPILOT_TOOLS_PROMPT.includes('studio_artifact-doc'));
  assert(!nativeOffPrompt('maki').includes('studio_artifact'), 'Maki names its tools another way and is not told this');
  for (const text of [COPILOT_TOOLS_PROMPT, nativeOffNote('copilot'), copilot.note!]) {
    assert(!/\p{Extended_Pictographic}|used to|no longer|instead of/u.test(text), text);
  }
});

// ---- a chat opened through AIB (a fake agent whose command has --acp) ----

class Host {
  readonly box = new Sandbox();
  readonly connections: Connection[] = [];
  readonly aibs: Aib[] = [];
  readonly #restore = withEnv({ AGENT_STUDIO_ALLOW_REAL_AGENT: '1' }); // the command is not a fixture: the rule applies

  aib(command: string[]): Aib {
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.box.state, port: 0, ownersDir: null });
    aib.ownerProbe = () => null;
    aib.settings.worktreePerChat = () => false;
    aib.agentLaunch = () => Promise.resolve([command, {}]);
    // the fake agent stands in for the program; its command keeps the `--acp` the real one has
    aib.connectionFactory = (_launch, cwd, provider, options) => {
      const c = new Connection(fake('--acp', '--rich'), cwd, provider, options);
      this.connections.push(c);
      return c;
    };
    this.aibs.push(aib);
    return aib;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
    this.#restore();
    this.box[Symbol.dispose]();
  }
}

const notes = (c: Connection) => c.events.filter((e) => e.kind === 'studio_note').map((e) => String((e.data as Json).message));

Deno.test({
  name: "Copilot chat: AIB's server goes in the chat's own config file and the agent is started with it; the file holds AIB's entry only",
  ...T,
  async fn() {
    await using host = new Host();
    const c = await host.aib(['C:/tools/copilot.exe', '--acp']).connect('copilot', host.box.project, null, {});
    await until(() => c.ready, 'the chat is ready', 30);
    const file = configFileOf(host.box.state, c.id);
    const base = fake('--acp', '--rich');
    assertEquals(c.command, [...base.slice(0, 3), COPILOT_MCP_FLAG, `@${file}`, ...base.slice(3)], c.command.join(' '));
    const servers = serversOf(Deno.readTextFileSync(file));
    assertEquals(Object.keys(servers), ['studio_artifact']);
    assertEquals((servers.studio_artifact as Json).tools, ['*']);
    assert(file.startsWith(host.box.state), "AIB's own state folder: never ~/.copilot, never the project");
    assert(!exists(join(host.box.project, '.copilot')) && !exists(join(host.box.project, '.github')));
    // the chat says: tools available, subagents off, helpers for parallel work; it carries the rule with the tool names
    const said = notes(c).filter((n) => n.includes('subagents are off in this chat'));
    assertEquals(said, [nativeOffNote('copilot')]);
    assertEquals(c.subagentHooks!.prompt, nativeOffPrompt('copilot'));
    assert(!notes(c).some((n) => n.includes('not available')), notes(c).join('\n'));
  },
});

Deno.test({
  name: 'Copilot chat: a command with no --acp is left as it is (not the program AIB knows), and another agent gets no Copilot file',
  ...T,
  async fn() {
    await using host = new Host();
    const aib = host.aib(['C:/tools/copilot.exe']);
    aib.connectionFactory = (_launch, cwd, provider, options) => new Connection(fake('--rich'), cwd, provider, options);
    const c = await aib.connect('copilot', host.box.project, null, {});
    await until(() => c.ready, 'the chat is ready', 30);
    assert(!c.command.includes(COPILOT_MCP_FLAG));
    const claude = await host.aib(['C:/tools/claude.exe']).connect('claude', host.box.project, null, {});
    await until(() => claude.ready, 'the claude chat is ready', 30);
    assert(!exists(join(host.box.state, 'copilot', claude.id)));
    assert(!claude.command.includes(COPILOT_MCP_FLAG));
  },
});

Deno.test({
  name: 'Copilot chat: under test a fixture agent is left as it is (no file, no change)',
  ...T,
  async fn() {
    await using host = new Host();
    const keep = withEnv({ AGENT_STUDIO_TEST: '1' });
    try {
      const aib = host.aib([import.meta.filename!, '--acp']);
      const c = await aib.connect('copilot', host.box.project, null, {});
      await until(() => c.ready, 'the chat is ready', 30);
      assert(!c.command.includes(COPILOT_MCP_FLAG));
      assert(!exists(join(host.box.state, 'copilot')));
    } finally {
      keep();
    }
  },
});

// ---- WSL: the config file is written in the distro by its helper; the flag names that path (FakeWslHost: Copilot is not in the distro here) ----

class WslLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-copilot-' }));
  readonly state = this.dir + SEP + 'state';
  readonly host: FakeWslHost;
  readonly aibs: Aib[] = [];
  readonly connections: Connection[] = [];
  /** What the helper was asked to write: [chat id, json]. */
  readonly written: [string, string][] = [];

  constructor() {
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu');
    this.host.folders.set('/home/u/app', this.dir);
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
    this.host.handlers['mcpconfig.write'] = (p: Json) => {
      this.written.push([String(p.id), String(p.json)]);
      return { path: `/home/u/.aib-server/copilot/${p.id}/mcp.json` };
    };
  }

  aib(): Aib {
    const keeper = new KeeperLink({ dataDir: this.state, orphan: null, extraArgs: ['--exit-after', '2s', '--orphan-after', '30s'] });
    const aib = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: this.state, port: 0, ownersDir: null }, {
      keeper,
    });
    aib.ownerProbe = () => null;
    aib.connectionFactory = (_command, cwd, provider, options) => {
      const wsl = options?.wsl ? { ...options.wsl, program: undefined } : options?.wsl;
      const c = new Connection(fake('--acp', '--cancel-aware'), cwd, provider, { ...options, wsl });
      this.connections.push(c);
      return c;
    };
    this.aibs.push(aib);
    return aib;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    for (const s of this.aibs.reverse()) await s.close().catch(() => {});
    setWslHostResolver(null);
    await this.host.stopKeeper();
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

Deno.test({
  name:
    "Copilot chat in WSL: the distro's helper writes the config file, and the distro's Copilot is started with its Linux path (fake host: not installed in WSL here)",
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const restore = withEnv({ AGENT_STUDIO_ALLOW_REAL_AGENT: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-fake' });
    lab.host.handlers['agents.detect'] = () => ({
      agents: [{ id: 'copilot', found: true, command: ['/usr/local/bin/copilot', '--acp'], version: '1.0.109' }],
    });
    try {
      const c = await lab.aib().connect('copilot', 'wsl://ubuntu/home/u/app');
      await until(() => c.ready, 'the chat is ready', 30);
      assert(c.mcpServers.length > 0, 'the WSL chat has its AIB entry (tunnel or interop)');
      assertEquals(lab.written.length, 1);
      assertEquals(lab.written[0][0], c.id);
      assertEquals(Object.keys(serversOf(lab.written[0][1])), ['studio_artifact']);
      const at = c.command.indexOf(COPILOT_MCP_FLAG);
      assertEquals(c.command[at + 1], `@/home/u/.aib-server/copilot/${c.id}/mcp.json`, c.command.join(' '));
      assert(!exists(join(lab.state, 'copilot')), 'nothing is written on the Windows side for a WSL chat');
    } finally {
      restore();
    }
  },
});
