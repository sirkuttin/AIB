/**
 * Per-project tool servers in WSL projects (wsl/helper/toolservers.ts, wsl/toolservers.ts): the distro's own agent config is read by the
 * distro's helper (`toolservers.discover`, read only) and the choice is AIB's, on Windows. A fake WSL host (work/deno/_wsl_fake.ts:
 * no distro, temp folders only; a real distro has none of these CLIs here):
 *   - the helper method itself, run in-process over a temp "distro home" (Claude, Codex, Gemini, Qwen, Copilot, Antigravity files)
 *   - a Claude chat and a Copilot chat in a NEW WSL project start with the server that runs on the PC off (deniedMcpServers /
 *     --disable-mcp-server), the remote one on
 *   - a helper that can't answer switches nothing off (and caches nothing): the chat loads everything, as before this feature
 * Gemini's policy file and Qwen's settings file are written by the helper (`toolservers.write`, the last tests); an older helper skips both
 * (said in `skipped`) and the card keeps its note.
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
        ['enforced', 'enforced'],
        'a distro whose helper writes the Gemini and Qwen files shows the same card as Windows',
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

// ---- Gemini's policy file and Qwen's settings file, written by the helper in the distro ------------------------------------------
// The real helper method (`toolservers.write`) runs in-process behind the fake host over a temp "distro data folder". Real gemini and
// qwen are not installed in the WSL distro here, so there is no real distro run: what the CLIs do with these files is the Windows probe's
// (aib-shared/designs/tool-servers/probe.md); here the files and the launch pieces are checked.
const GQ_SERVERS = [
  {
    id: 'github',
    kind: 'remote',
    from: 'user',
    fromText: 'Your user settings',
    agents: ['gemini', 'qwen'],
    entries: { gemini: { httpUrl: 'https://x.invalid/mcp' }, qwen: { httpUrl: 'https://x.invalid/mcp' } },
  },
  {
    id: 'rea',
    kind: 'local',
    from: 'user',
    fromText: 'Your user settings',
    agents: ['gemini', 'qwen'],
    entries: { gemini: { command: 'rea' }, qwen: { command: 'rea' } },
  },
];

function gqLab(lab: WslLab) {
  const data = lab.dir + SEP + 'distro-data';
  const wslHome = lab.dir + SEP + 'distro-home';
  Deno.mkdirSync(data, { recursive: true });
  Deno.mkdirSync(wslHome, { recursive: true });
  lab.answer = GQ_SERVERS;
  const methods = makeMethods({
    env: () => Promise.resolve({ env: { HOME: wslHome }, shell: '/bin/sh', home: wslHome, arch: 'x86_64' }),
    data,
  });
  lab.host.handlers['toolservers.write'] = (p: Json) => methods['toolservers.write'](p) as never;
  const aib = lab.aib();
  const step = (provider: string, extra: Json = {}, prepared: Json | null = null) =>
    aib.$toolServersStep(
      {
        provider,
        resume: null,
        command: [],
        env: {},
        cwd: REF,
        workspace: REF,
        worktree: false,
        spawnEnv: null,
        chatId: null,
        distro: 'ubuntu',
        wsl: true,
        prepared: null,
        launchCommand: [],
        ...extra,
      } as never,
      prepared as never,
    );
  return { data, wslHome, aib, step };
}

Deno.test({
  name: 'tool servers in WSL: Gemini gets the allowed server names and a policy file in the distro (server off, tool off); nothing in the distro home',
  ...T,
  async fn() {
    await using lab = new WslLab();
    const { data, wslHome, aib, step } = gqLab(lab);
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'rea', on: false });
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'github', tool: 'search', toolOn: false });
    const out = (await step('gemini'))!;
    assertEquals(out.skipped, []);
    const i = out.args.indexOf('--allowed-mcp-server-names');
    assert(i >= 0 && out.args.slice(i + 1).includes('github') && !out.args.slice(i + 1).includes('rea'), `server off is not allowed: ${out.args}`);
    const p = out.args.indexOf('--admin-policy');
    assert(p >= 0, out.args.join(' '));
    const dir = out.args[p + 1];
    assert(dir.startsWith(data + SEP + 'toolservers' + SEP + 'gemini-'), `the policy folder is in AIB's own data folder: ${dir}`);
    const toml = Deno.readTextFileSync(dir + SEP + 'aib-toolservers.toml');
    assert(toml.includes('toolName = "mcp_github_search"') && toml.includes('decision = "deny"'), toml);
    assertEquals([...Deno.readDirSync(wslHome)].length, 0, 'nothing was written in the distro home (no ~/.gemini)');
    // with nothing to switch off a chat gets neither flag
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'rea', on: true });
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'github', tool: 'search', toolOn: true });
    assertEquals((await step('gemini'))!.args, []);
  },
});

Deno.test({
  name: "tool servers in WSL: Qwen gets a settings file in the distro (server excluded, tool off as a full copy) merged over the distro's system settings",
  ...T,
  async fn() {
    await using lab = new WslLab();
    const { data, wslHome, aib, step } = gqLab(lab);
    const system = lab.dir + SEP + 'system-settings.json'; // stands in for the distro's /etc/qwen-code/settings.json
    Deno.writeTextFileSync(system, JSON.stringify({ theme: 'dark', mcp: { excluded: ['old'] } }));
    const before = Deno.readTextFileSync(system);
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'rea', on: false });
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'github', tool: 'search', toolOn: false });
    const out = (await step('qwen', { env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: system } }))!;
    assertEquals(out.skipped, []);
    const file = out.env.QWEN_CODE_SYSTEM_SETTINGS_PATH;
    assert(file.startsWith(data + SEP + 'toolservers' + SEP + 'qwen-'), `the settings file is in AIB's own data folder: ${file}`);
    const settings = JSON.parse(Deno.readTextFileSync(file)) as Json;
    assertEquals(settings.theme, 'dark', "the distro's own system settings are kept");
    assertEquals((settings.mcp as Json).excluded, ['old', 'rea'], 'server off: excluded');
    assertEquals(((settings.mcpServers as Json).github as Json).excludeTools, ['search'], 'tool off: a full copy with excludeTools');
    assertEquals(((settings.mcpServers as Json).github as Json).httpUrl, 'https://x.invalid/mcp');
    assertEquals(Deno.readTextFileSync(system), before, "the distro's own file was not changed");
    assertEquals([...Deno.readDirSync(wslHome)].length, 0, 'nothing was written in the distro home (no ~/.qwen)');
    // a chat's own settings file in AIB's folder (its subagent hooks) is the base instead, and is left as it is
    const own = data + SEP + 'chat-settings.json';
    Deno.writeTextFileSync(own, JSON.stringify({ hooks: { x: 1 } }));
    const withOwn = (await step('qwen', {}, { env: { QWEN_CODE_SYSTEM_SETTINGS_PATH: own } }))!;
    const merged = JSON.parse(Deno.readTextFileSync(withOwn.env.QWEN_CODE_SYSTEM_SETTINGS_PATH)) as Json;
    assertEquals(merged.hooks, { x: 1 });
    assertEquals((merged.mcp as Json).excluded, ['rea']);
    assertEquals(Deno.readTextFileSync(own), JSON.stringify({ hooks: { x: 1 } }));
  },
});

Deno.test({
  name: 'tool servers in WSL: the helper keeps to its own folder, refuses a bad hash, ignores a base outside it, and sweeps old files',
  ...T,
  async fn() {
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-ts-write-' }));
    try {
      const data = dir + SEP + 'data';
      const m = makeMethods({ env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home: dir, arch: 'x86_64' }), data });
      let refused = '';
      try {
        await m['toolservers.write']({ agent: 'gemini', hash: '../x', toml: 'a' });
      } catch (error) {
        refused = (error as Error).message;
      }
      assert(refused.includes('hash'), refused);
      const root = data + SEP + 'toolservers';
      Deno.mkdirSync(root + SEP + 'gemini-old', { recursive: true });
      Deno.writeTextFileSync(root + SEP + 'qwen-old.json', '{}');
      const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
      Deno.utimeSync(root + SEP + 'gemini-old', old, old);
      Deno.utimeSync(root + SEP + 'qwen-old.json', old, old);
      Deno.mkdirSync(root + SEP + 'gemini-fresh', { recursive: true });
      await m['toolservers.write']({ agent: 'gemini', hash: 'abc', toml: '# x' });
      assertEquals([...Deno.readDirSync(root)].map((e) => e.name).sort(), ['gemini-abc', 'gemini-fresh'], 'the week-old files went, the fresh one stayed');
      const secret = dir + SEP + 'secret.json';
      Deno.writeTextFileSync(secret, JSON.stringify({ leaked: true }));
      const answer = await m['toolservers.write']({ agent: 'qwen', hash: 'q1', fragment: { mcp: { excluded: ['a'] } }, base: secret }) as { path: string };
      assert(!('leaked' in (JSON.parse(Deno.readTextFileSync(answer.path)) as Json)), 'a base outside the data folder is not read');
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: 'tool servers in WSL: an older helper (no toolservers.write) keeps the old behaviour and the card note',
  ...T,
  async fn() {
    await using lab = new WslLab();
    const { data, aib, step } = gqLab(lab);
    (lab.host as unknown as { methods: string[] }).methods = ['toolservers.discover', 'env.get'];
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'rea', on: false });
    await aib.$toolServersCall({ op: 'set', path: REF, server: 'github', tool: 'search', toolOn: false });
    const g = (await step('gemini'))!;
    assert(!g.args.includes('--admin-policy'), g.args.join(' '));
    assert(g.args.includes('--allowed-mcp-server-names'), 'the server switch still works');
    assertEquals(g.skipped.length, 1);
    const q = (await step('qwen'))!;
    assertEquals(q.env, {});
    assertEquals(q.skipped.length, 1);
    assertEquals([...Deno.readDirSync(data)].length, 0, 'nothing was written');
    assert(!lab.host.calls.some(([m]) => m === 'toolservers.write'), 'the old helper was not asked');
    const view = await aib.$toolServersCall({ op: 'view', path: REF }) as unknown as { reach: { agent: string; reach: string; text: string }[] };
    const card = view.reach.filter((r) => r.agent === 'gemini' || r.agent === 'qwen');
    assertEquals(card.map((r) => r.reach), ['partial', 'none']);
    assert(card.every((r) => r.text.includes('helper is updated')), JSON.stringify(card));
  },
});
