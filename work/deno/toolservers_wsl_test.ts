/**
 * Per-project tool servers in WSL projects (wsl/helper/toolservers.ts, wsl/toolservers.ts): the distro's own agent config is read by the
 * distro's helper (`toolservers.discover`, read only) and the choice is AIB's, on Windows. A fake WSL host (work/deno/_wsl_fake.ts:
 * no distro, temp folders only; a real distro has none of these CLIs here):
 *   - the helper method itself, run in-process over a temp "distro home" (Claude, Codex, Gemini, Qwen, Copilot, Antigravity files)
 *   - a Claude chat and a Copilot chat in a NEW WSL project start with the server that runs on the PC off (deniedMcpServers /
 *     --disable-mcp-server), the remote one on
 *   - a helper that can't answer switches nothing off (and caches nothing): the chat loads everything, as before this feature
 * Not applied in WSL yet (said in the chat's tool: `skipped`): Gemini's policy file and Qwen's settings file, which the helper would
 * have to write in the distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { fake, pause, until } from './_connection.ts';
import { withEnv } from './_agents.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { Connection } from '../../app/server/acp/connection.ts';
import { Aib } from '../../app/server/host/aib.ts';
import { setWslHostResolver } from '../../app/server/wsl/access.ts';
import { KeeperLink } from '../../app/server/keeper/link.ts';
import { keeperBinary } from '../../app/server/keeper/client.ts';
import { makeMethods } from '../../app/server/wsl/helper/methods.ts';
import { COPILOT_MCP_FLAG } from '../../app/server/agents/copilot_mcp.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const REF = 'wsl://ubuntu/home/u/app';

const SERVERS = [
  {
    id: 'github',
    kind: 'remote',
    from: 'user',
    fromText: 'Your user settings',
    agents: ['claude', 'copilot'],
    entries: { claude: { type: 'http', url: 'https://x.invalid/mcp' } },
  },
  {
    id: 'rea',
    kind: 'local',
    from: 'user',
    fromText: 'Your user settings',
    agents: ['claude', 'copilot'],
    entries: { claude: { type: 'stdio', command: 'rea' } },
  },
];

class WslLab {
  readonly dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-toolservers-' }));
  readonly state = this.dir + SEP + 'state';
  readonly host: FakeWslHost;
  readonly aibs: Aib[] = [];
  /** What the fake helper answers to `toolservers.discover` (null: it fails). */
  answer: Json[] | null = SERVERS;
  readonly asked: string[] = [];
  /** The commands Copilot would be started with (the fake agent stands in for the program, so it is given its own flags instead). */
  readonly commands: string[][] = [];

  constructor() {
    this.host = new FakeWslHost(this.dir + SEP + 'linux-keeper', 'Ubuntu');
    this.host.folders.set('/home/u/app', this.dir);
    this.host.folders.set('/home/u', this.dir);
    setWslHostResolver((d) => (d === 'ubuntu' ? this.host : null));
    this.host.handlers['toolservers.discover'] = (p: Json) => {
      this.asked.push(String(p.folder));
      if (!this.answer) throw new Error('the helper is away');
      return { servers: this.answer };
    };
    this.host.handlers['mcpconfig.write'] = (p: Json) => ({ path: `/home/u/.aib-server/copilot/${p.id}/mcp.json` });
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
      const use = c.useCommand.bind(c);
      c.useCommand = (command: string[]) => {
        this.commands.push(command);
        use(fake('--acp', '--cancel-aware'));
      };
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

const denied = (c: Connection) => {
  const meta = c.claudeMeta() as Json;
  const settings = ((((meta._meta ?? {}) as Json).claudeCode ?? {}) as Json).options as Json | undefined;
  return (((settings?.settings ?? {}) as Json).deniedMcpServers as Json[] | undefined ?? []).map((d) => String(d.serverName));
};

Deno.test({
  name: "tool servers in WSL: the helper reads the distro's agent config files (read only), every agent's format",
  ...T,
  async fn() {
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-ts-helper-' }));
    try {
      const home = dir + SEP + 'home';
      const folder = dir + SEP + 'app';
      const mk = (p: string, text: string) => {
        Deno.mkdirSync(p.slice(0, p.lastIndexOf(SEP)), { recursive: true });
        Deno.writeTextFileSync(p, text);
      };
      const stdio = { command: 'node', args: ['s.js'] };
      mk(
        home + SEP + '.claude.json',
        JSON.stringify({ mcpServers: { rea: { type: 'stdio', ...stdio } }, claudeAiMcpEverConnected: ['claude.ai Gmail'] }),
      );
      mk(folder + SEP + '.mcp.json', JSON.stringify({ mcpServers: { playwright: stdio } }));
      mk(
        home + SEP + '.codex' + SEP + 'config.toml',
        '[mcp_servers.context7]\ncommand = "npx"\nargs = ["-y", "c7"]\n[mcp_servers.context7.env]\nA = "b"\n[mcp_servers.docs]\nurl = "https://d.invalid/mcp"\n',
      );
      mk(home + SEP + '.gemini' + SEP + 'settings.json', JSON.stringify({ mcpServers: { gem: stdio } }));
      mk(home + SEP + '.qwen' + SEP + 'settings.json', JSON.stringify({ mcpServers: { qw: stdio } }));
      mk(home + SEP + '.copilot' + SEP + 'mcp-config.json', JSON.stringify({ mcpServers: { cop: stdio } }));
      mk(
        home + SEP + '.gemini' + SEP + 'config' + SEP + 'mcp_config.json',
        JSON.stringify({ mcpServers: { agy: { ...stdio, disabled: false } } }),
      );
      const before = [...Deno.readDirSync(home)].map((e) => e.name).sort();
      const methods = makeMethods({ env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home, arch: 'x86_64' }) });
      const answer = await methods['toolservers.discover']({ folder }) as { servers: Json[] };
      const by = Object.fromEntries(answer.servers.map((s) => [s.id as string, s]));
      assertEquals(Object.keys(by).sort(), ['agy', 'claude.ai Gmail', 'context7', 'cop', 'docs', 'gem', 'playwright', 'qw', 'rea']);
      assertEquals([by.rea.kind, by['claude.ai Gmail'].kind, by.context7.kind, by.docs.kind], ['local', 'remote', 'local', 'remote']);
      assertEquals(by.playwright.from, 'project');
      assertEquals(by['claude.ai Gmail'].fromText, 'claude.ai connector');
      assertEquals(by.context7.agents, ['codex']);
      assertEquals([...Deno.readDirSync(home)].map((e) => e.name).sort(), before, 'nothing was written in the distro home');
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: 'tool servers in WSL: a Claude chat and a Copilot chat in a new WSL project start with the PC-local server off',
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    // Claude: no real-agent hooks under test, so the session settings carry only AIB's tool server patch
    const claudeEnv = withEnv({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-fake' });
    lab.host.handlers['agents.detect'] = () => ({
      agents: [{ id: 'claude', found: true, command: ['/usr/local/bin/claude-agent-acp'], version: '0.97.0' }],
    });
    try {
      const c = await lab.aib().connect('claude', REF);
      await until(() => c.ready, 'the Claude chat is ready', 30);
      assertEquals(denied(c), ['rea'], 'only the server that runs on the PC is denied');
      assertEquals(lab.asked, ['/home/u/app'], "the distro's helper was asked for the project folder as a Linux path");
      const view = await lab.aibs[0].$toolServersCall({ op: 'view', path: REF }) as { wsl: boolean; servers: Json[] };
      assertEquals(view.wsl, true);
      assertEquals(
        (view as unknown as { reach: Json[] }).reach.filter((r) => r.agent === 'gemini' || r.agent === 'qwen').map((r) => r.reach),
        ['partial', 'none'],
        'the card says what a WSL project does not follow yet',
      );
      assertEquals(view.servers.map((s) => [s.id, s.on]), [['studio_artifact', true], ['github', true], ['rea', false]]);
    } finally {
      claudeEnv();
    }
    // Copilot: the flags ride on the launch command that the distro's keeper starts
    const copilotEnv = withEnv({ AGENT_STUDIO_ALLOW_REAL_AGENT: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-fake' });
    lab.host.handlers['agents.detect'] = () => ({
      agents: [{ id: 'copilot', found: true, command: ['/usr/local/bin/copilot', '--acp'], version: '1.0.109' }],
    });
    try {
      const folder2 = 'wsl://ubuntu/home/u/app2';
      lab.host.folders.set('/home/u/app2', lab.dir);
      const c = await lab.aib().connect('copilot', folder2);
      await until(() => c.ready, 'the Copilot chat is ready', 30);
      assert(c.ready);
      const command = lab.commands.at(-1)!;
      const at = command.indexOf('--disable-mcp-server');
      assert(at > 0 && command[at + 1] === 'rea', command.join(' '));
      assert(command.indexOf(COPILOT_MCP_FLAG) > 0, "AIB's own tools stay");
      assertEquals(command.filter((a) => a === '--disable-mcp-server').length, 1, 'github (remote) stays on');
    } finally {
      copilotEnv();
    }
  },
});

Deno.test({
  name: "tool servers in WSL: a helper that can't answer switches nothing off and caches nothing",
  ...T,
  async fn() {
    await keeperBinary();
    await using lab = new WslLab();
    const env = withEnv({ AGENT_STUDIO_TEST: '1', AIB_WSL_ROOT: '/tmp/aib-wsl-test-fake' });
    lab.host.handlers['agents.detect'] = () => ({
      agents: [{ id: 'claude', found: true, command: ['/usr/local/bin/claude-agent-acp'], version: '0.97.0' }],
    });
    lab.answer = null;
    try {
      const a = lab.aib();
      const c = await a.connect('claude', REF);
      await until(() => c.ready, 'the chat is ready', 30);
      assertEquals(denied(c), [], 'the helper was away: everything loads, as before this feature');
      lab.answer = SERVERS;
      const view = await a.$toolServersCall({ op: 'view', path: REF }) as { servers: Json[] };
      assertEquals(
        view.servers.map((s) => s.id),
        ['studio_artifact', 'github', 'rea'],
        'the next read asks again (the empty answer was not cached)',
      );
    } finally {
      env();
    }
  },
});
