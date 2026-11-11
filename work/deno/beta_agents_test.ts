/**
 * The Beta agents (server/agents/beta_catalog.ts, beta_agents.ts, beta_signin.ts): their launch commands, the Windows npm .cmd shims,
 * the VS Code `copilot` shim trap, the model set after session/new, the settings that keep them off, and ACP terminal auth end to end.
 * Nothing here installs or runs a real agent: work/fake_acp.py stands in, every program file is a temp file, every folder a temp folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { exists, join, PY, tempDir, touch, waitFor, withEnv } from './_agents.ts';
import { FAKE, Lab } from './_connection.ts';
import { BETA_AGENTS, BETA_IDS, betaAgent } from '../../outputs/agent-studio/server/agents/beta_catalog.ts';
import {
  type BetaLaunch,
  isVsCodeCopilotShim,
  pathCandidates,
  resolveBeta,
  shimArgv,
  signinArgv,
} from '../../outputs/agent-studio/server/agents/beta_agents.ts';
import { BetaSigner, readTerminalArgs } from '../../outputs/agent-studio/server/agents/beta_signin.ts';
import { readJob } from '../../outputs/agent-studio/server/agents/signin.ts';
import { isProvider } from '../../outputs/agent-studio/server/agents/agent_registry.ts';
import { SettingsStore } from '../../outputs/agent-studio/server/state/settings.ts';
import { describeBeta } from '../../outputs/agent-studio/server/web/shared.ts';
import { TerminalSessions } from '../../outputs/agent-studio/server/terminal/sessions.ts';
import * as installer from '../../outputs/agent-studio/server/agents/installer.ts';

const WIN = Deno.build.os === 'windows';
const sanitize = { sanitizeOps: false, sanitizeResources: false }; // sign-in jobs run in the background between awaits
const noNode = () => '';

/** A PATH made of these folders only (no current folder, nothing from the machine). */
const envWith = (...dirs: string[]) => ({ PATH: dirs.join(WIN ? ';' : ':'), ComSpec: 'C:\\Windows\\System32\\cmd.exe' });

// ---- launch commands ---------------------------------------------------------------------------------------------------

Deno.test('the Beta list: ten agents in the brief order, unique ids that are providers, all off-by-default material', () => {
  assertEquals(BETA_IDS, ['copilot', 'opencode', 'gemini', 'qwen', 'cursor', 'goose', 'vibe', 'cline', 'kimi', 'kilo']);
  for (const id of BETA_IDS) assert(isProvider(id), id);
  assert(!isProvider('beta-nothing'));
  for (const a of BETA_AGENTS) {
    assert(a.install && a.docs.startsWith('https://') && a.cost, a.id);
    assert(['terminal', 'agent', 'key'].includes(a.signin.kind), a.id);
    if (a.signin.kind === 'terminal') assert(a.signin.terminalArgs?.length, a.id);
  }
});

Deno.test('each Beta agent starts with its own command and ACP args (Qwen with --approval-mode default)', async () => {
  using dir = tempDir();
  const expected: Record<string, string[]> = {
    copilot: ['--acp'],
    opencode: ['acp'],
    gemini: ['--acp'],
    qwen: ['--acp', '--experimental-skills', '--approval-mode', 'default'],
    cursor: ['acp'],
    goose: ['acp'],
    vibe: [],
    cline: ['--acp'],
    kimi: ['acp'],
    kilo: ['acp'],
  };
  for (const agent of BETA_AGENTS) {
    const folder = join(dir.root, agent.id === 'cursor' ? 'cursor-agent' : agent.id);
    const program = touch(join(folder, agent.commands[0] + (WIN ? '.exe' : '')), '');
    if (!WIN) Deno.chmodSync(program, 0o755);
    const row = await resolveBeta(agent.id, { env: envWith(folder), findNode: noNode });
    assert(row.found, `${agent.id}: ${row.problem}`);
    assertEquals(row.argv, [program, ...expected[agent.id]], agent.id);
    assertEquals(row.base, [program]);
    assertEquals(row.source, 'path');
    assertEquals(row.shim, false);
  }
  assertEquals(betaAgent('qwen')!.args.slice(-2), ['--approval-mode', 'default'], 'Qwen never starts in Auto');
});

Deno.test('not found: Not installed, with the official install command; nothing is downloaded', async () => {
  using dir = tempDir();
  for (const agent of BETA_AGENTS) {
    const row = await resolveBeta(agent.id, { env: envWith(dir.root), findNode: noNode, windows: WIN });
    assertEquals(row.found, false, agent.id);
    assertEquals(row.source, 'missing');
    assertEquals(row.problem, `Not installed. Install it with: ${agent.install}`);
  }
});

Deno.test('an npm Beta agent installed by AIB runs its package bin with node, before anything on PATH', async () => {
  using dir = tempDir();
  const state = join(dir.root, 'state');
  const version = join(state, 'agents', 'gemini', '0.68.0');
  const pkg = join(version, 'node_modules', '@google', 'gemini-cli');
  touch(join(pkg, 'package.json'), JSON.stringify({ name: '@google/gemini-cli', version: '0.68.0', bin: { gemini: 'bundle/gemini.js' } }));
  const entry = touch(join(pkg, 'bundle', 'gemini.js'));
  touch(join(version, '.complete'), '{}');
  const onPath = join(dir.root, 'bin');
  touch(join(onPath, 'gemini' + (WIN ? '.cmd' : '')), '@echo off');
  const row = await resolveBeta('gemini', { stateDir: state, env: envWith(onPath), findNode: () => 'C:\\node\\node.exe' });
  assertEquals(row.source, 'studio');
  assertEquals(row.argv, ['C:\\node\\node.exe', Deno.realPathSync(entry), '--acp']);
});

Deno.test('a global npm install runs its bin file with node (no .cmd shim involved)', async () => {
  using dir = tempDir();
  const root = join(dir.root, 'npm-global', 'node_modules');
  const pkg = join(root, '@qwen-code', 'qwen-code');
  touch(join(pkg, 'package.json'), JSON.stringify({ name: '@qwen-code/qwen-code', bin: { qwen: 'cli.js' } }));
  const entry = touch(join(pkg, 'cli.js'));
  const row = await resolveBeta('qwen', { env: envWith(), findNode: () => 'node', globalRoots: () => [root] });
  assertEquals(row.source, 'installed');
  assertEquals(row.argv, ['node', Deno.realPathSync(entry), '--acp', '--experimental-skills', '--approval-mode', 'default']);
});

// ---- Windows npm .cmd shims --------------------------------------------------------------------------------------------

Deno.test('an npm .cmd shim on PATH is started through cmd.exe, and a native .exe later on PATH wins over it', async () => {
  if (!WIN) return;
  using dir = tempDir();
  const first = join(dir.root, 'npm');
  const later = join(dir.root, 'native');
  const shim = touch(join(first, 'cline.cmd'), '@echo off');
  let row = await resolveBeta('cline', { env: envWith(first), findNode: noNode });
  assertEquals(row.shim, true);
  assertEquals(row.argv, ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', shim, '--acp']);
  assertEquals(row.base, [shim]);
  assertEquals(
    signinArgv(row, 'cline'),
    ['C:\\Windows\\System32\\cmd.exe', '/d', '/c', shim, 'auth'],
    'the sign-in goes through cmd.exe too',
  );
  const exe = touch(join(later, 'cline.exe'), '');
  assertEquals(pathCandidates('cline', envWith(first, later)), [exe, shim]);
  row = await resolveBeta('cline', { env: envWith(first, later), findNode: noNode });
  assertEquals(row.argv, [exe, '--acp']);
});

Deno.test('cmd.exe really starts a .cmd shim in a folder with spaces, hidden, with its arguments', async () => {
  if (!WIN) return;
  using dir = tempDir();
  const shim = touch(join(dir.root, 'with space', 'fake agent.cmd'), '@echo off\r\necho ARGS=%*\r\nexit /b 0\r\n');
  const argv = shimArgv(shim, ['--acp', '--approval-mode', 'default'], Deno.env.get('ComSpec') ?? 'cmd.exe');
  const out = await new Deno.Command(argv[0], { args: argv.slice(1), stdin: 'null', stdout: 'piped', stderr: 'piped' }).output();
  assertEquals(out.code, 0, new TextDecoder().decode(out.stderr));
  assert(new TextDecoder().decode(out.stdout).includes('ARGS=--acp --approval-mode default'), new TextDecoder().decode(out.stdout));
});

Deno.test('shimArgv refuses anything cmd.exe would read as syntax', () => {
  for (const bad of ['a&b', 'x|y', '<in', 'out>', '^', '%PATH%', '!x!', '"q"']) {
    let threw = false;
    try {
      shimArgv('C:\\x\\agent.cmd', [bad]);
    } catch {
      threw = true;
    }
    assert(threw, bad);
  }
});

// ---- the VS Code copilot shim ------------------------------------------------------------------------------------------

Deno.test("VS Code's copilot install-prompt shim on PATH is not the Copilot CLI", async () => {
  using dir = tempDir();
  const vscode = join(dir.root, 'Code', 'User', 'globalStorage', 'github.copilot-chat', 'copilotCli');
  touch(join(vscode, 'copilot' + (WIN ? '.bat' : '')), '@echo off\r\necho Install GitHub Copilot CLI\r\n');
  let row = await resolveBeta('copilot', { env: envWith(vscode), findNode: noNode });
  assertEquals(row.found, false);
  assert(row.problem.includes("VS Code's install prompt"), row.problem);
  assert(row.problem.includes('npm install -g @github/copilot'), row.problem);

  // a shim anywhere else that only talks about VS Code (the content check)
  const other = join(dir.root, 'tools');
  const prompt = touch(
    join(other, 'copilot' + (WIN ? '.cmd' : '')),
    '@echo off\r\necho Run "Install Copilot CLI" from Visual Studio Code\r\n',
  );
  assert(isVsCodeCopilotShim(prompt));
  // the real npm shim mentions its package: it counts
  const real = join(dir.root, 'npm');
  const npmShim = touch(
    join(real, 'copilot' + (WIN ? '.cmd' : '')),
    '@echo off\r\nnode "%~dp0\\node_modules\\@github\\copilot\\index.js" %*\r\n',
  );
  assert(!isVsCodeCopilotShim(npmShim));
  row = await resolveBeta('copilot', { env: envWith(vscode, other, real), findNode: noNode });
  assertEquals(row.found, true);
  assertEquals(row.path, npmShim, 'the VS Code shims are skipped, the real CLI later on PATH is used');
});

Deno.test("Cursor's generic `agent` name counts only inside a Cursor folder", async () => {
  using dir = tempDir();
  const plain = join(dir.root, 'bin');
  touch(join(plain, 'agent' + (WIN ? '.exe' : '')), '');
  assertEquals((await resolveBeta('cursor', { env: envWith(plain), findNode: noNode })).found, false);
  const cursor = join(dir.root, 'cursor-agent');
  const program = touch(join(cursor, 'agent' + (WIN ? '.exe' : '')), '');
  const row = await resolveBeta('cursor', { env: envWith(plain, cursor), findNode: noNode });
  assertEquals(row.argv, [program, 'acp']);
});

// ---- settings: off by default, keys hidden -----------------------------------------------------------------------------

Deno.test('Beta agents are off by default; turning one on and storing its key never shows the key to the page', async () => {
  using dir = tempDir();
  const store = new SettingsStore(dir.root);
  for (const id of BETA_IDS) assertEquals(store.betaEnabled(id), false, id);
  await store.update({ agents: { enabled: { gemini: true } } });
  assertEquals(store.betaEnabled('gemini'), true);
  await store.update({ agents: { betaKey: { gemini: 'test-key-not-real' } } });
  assertEquals(store.betaKey('gemini'), 'test-key-not-real');
  const shown = JSON.stringify(store.public());
  assert(!shown.includes('test-key-not-real') && !shown.includes('betaKeys'), shown);
  const again = new SettingsStore(dir.root); // read back from the file
  assertEquals(again.betaEnabled('gemini'), true);
  assertEquals(again.betaEnabled('qwen'), false);
  let refused = '';
  try {
    await store.update({ agents: { betaKey: { opencode: 'x' } } });
  } catch (error) {
    refused = (error as Error).message;
  }
  assertEquals(refused, 'That agent does not take an API key');
  try {
    await store.update({ agents: { remove: 'gemini' } });
  } catch (error) {
    refused = (error as Error).message;
  }
  assertEquals(refused, 'Built-in agents cannot be removed; turn them off instead');
  const rows = await describeBeta({ stateDir: dir.root }, again.snapshot());
  assertEquals(rows.map((r) => r.id), BETA_IDS);
  const gemini = rows.find((r) => r.id === 'gemini')!;
  assertEquals([gemini.beta, gemini.builtin, gemini.enabled], [true, false, true]);
  assertEquals((gemini.betaInfo as Record<string, unknown>).keySet, true);
  assert(!JSON.stringify(rows).includes('test-key-not-real'));
  assert(rows.filter((r) => r.id !== 'gemini').every((r) => r.enabled === false));
  await store.update({ agents: { enabled: { gemini: false }, betaKey: { gemini: null } } });
  assertEquals([store.betaEnabled('gemini'), store.betaKey('gemini')], [false, '']);
});

Deno.test('the Beta npm agents are installable from the allow-list (exact registry versions), the built-ins keep their lockfiles', () => {
  const beta = installer.loadBetaAllowList() as Record<string, Record<string, string>>;
  assertEquals(Object.keys(beta).sort(), ['cline', 'copilot', 'gemini', 'kilo', 'kimi', 'qwen']);
  for (const [id, entry] of Object.entries(beta)) {
    assertEquals(entry.package, betaAgent(id)!.npm!.package);
    assertEquals(entry.version, betaAgent(id)!.npm!.version);
  }
  const inst = new installer.Installer(tempDir().root);
  assertEquals(inst.entry('qwen').package, '@qwen-code/qwen-code');
  assertEquals(inst.entry('claude').package, '@agentclientprotocol/claude-agent-acp');
});

// ---- the model set after session/new -----------------------------------------------------------------------------------

/** The JSON-RPC requests fake_acp.py received, in order. */
function received(log: string): Record<string, unknown>[] {
  return exists(log) ? Deno.readTextFileSync(log).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) : [];
}

Deno.test(
  'Copilot (setModelAfterNew): the model is set explicitly right after session/new; other agents are left alone',
  sanitize,
  async () => {
    await using lab = new Lab();
    for (const [provider, expectSet] of [['copilot', true], ['omp', false], ['gemini', false]] as const) {
      const log = lab.path(`${provider}.log`);
      const restore = withEnv({ FAKE_ACP_LOG: log });
      try {
        const c = await lab.open(['--models'], { provider });
        const methods = received(log).map((m) => m.method);
        const at = methods.indexOf('session/new');
        const sets = received(log).filter((m) => m.method === 'session/set_config_option');
        if (expectSet) {
          assertEquals(sets.length, 1, provider);
          assertEquals((sets[0].params as Record<string, unknown>).configId, 'model');
          assertEquals((sets[0].params as Record<string, unknown>).value, 'sol-6-1', 'the model the agent reported');
          assert(methods.indexOf('session/set_config_option') > at, 'after session/new');
        } else assertEquals(sets.length, 0, provider);
        assert(c.ready, provider);
      } finally {
        restore();
      }
    }
  },
);

// ---- ACP terminal auth, end to end with the fake agent -----------------------------------------------------------------

function fakeLaunch(authFile: string, id = 'opencode'): BetaLaunch {
  const base = [PY, FAKE, '--auth-required', '--beta-auth', '--auth-file', authFile];
  return { argv: base, base, source: 'path', path: FAKE, found: true, problem: '', text: id, shim: false };
}

Deno.test(
  'terminal auth: advertised only to a client with auth.terminal, run in an AIB terminal (PTY), then the check says Ready',
  sanitize,
  async () => {
    using dir = tempDir();
    const state = join(dir.root, 'state');
    const authFile = join(dir.root, 'auth.flag');
    const log = join(dir.root, 'agent.log');
    const restore = withEnv({ FAKE_ACP_LOG: log });
    try {
      const signer = new BetaSigner(state, () => fakeLaunch(authFile), () => ({}), { checkTimeout: 20 });
      assertEquals((await signer.check('opencode', true)).state, 'signin', 'session/new answered auth_required');
      const init = received(log).find((m) => m.method === 'initialize')!;
      assertEquals(
        ((init.params as Record<string, Record<string, unknown>>).clientCapabilities.auth as Record<string, unknown>).terminal,
        true,
      );

      const answer = await signer.start('opencode');
      assertEquals(answer.state, 'terminal');
      assertEquals(answer.args, ['--fixture-login'], "the agent's advertised terminal method, not the catalog's guess");
      assertEquals(readTerminalArgs(state, 'opencode'), ['--fixture-login'], 'saved for the web server');
      assert(!received(log).some((m) => m.method === 'authenticate'), 'ACP authenticate is never sent for a terminal method');

      // What the web server runs for the page: the agent's program with the method's args, in a headless pseudo-terminal.
      const argv = signinArgv(fakeLaunch(authFile), 'opencode', readTerminalArgs(state, 'opencode'))!;
      assertEquals(argv.slice(-1), ['--fixture-login']);
      const sessions = new TerminalSessions();
      try {
        const { session } = sessions.open('signin:opencode', dir.root, 100, 30, '', { file: argv[0], args: argv.slice(1) });
        const code = await session.pty.exited;
        assertEquals(code, 0);
      } finally {
        await sessions.endAll();
      }
      assert(exists(authFile), 'the terminal login ran');
      const after = await signer.check('opencode', true);
      assertEquals(after.state, 'ready', 'exit 0, then a fresh initialize + session/new: signed in');
    } finally {
      restore();
    }
  },
);

Deno.test('agent-type API key method: authenticate carries the stored key in _meta.api-key, then Ready', sanitize, async () => {
  using dir = tempDir();
  const state = join(dir.root, 'state');
  const authFile = join(dir.root, 'auth.flag');
  const log = join(dir.root, 'agent.log');
  const restore = withEnv({ FAKE_ACP_LOG: log });
  try {
    const signer = new BetaSigner(state, () => fakeLaunch(authFile, 'gemini'), () => ({ GEMINI_API_KEY: 'test-key-not-real' }), {
      checkTimeout: 20,
    });
    const job = await signer.start('gemini');
    assertEquals(job.state, 'waiting');
    const done = await waitFor(() => {
      const view = readJob(state, 'gemini');
      return view.state !== 'waiting' ? view : null;
    });
    assertEquals(done!.state, 'done', done!.message);
    const auth = received(log).find((m) => m.method === 'authenticate')!;
    assertEquals(auth.params, { methodId: 'gemini-api-key', _meta: { 'api-key': 'test-key-not-real' } });
    assertEquals(signer.status('gemini').state, 'ready');
  } finally {
    restore();
  }
});

Deno.test('a key-type agent has no Sign in job; an unknown id is refused', async () => {
  using dir = tempDir();
  const signer = new BetaSigner(dir.root, () => fakeLaunch(join(dir.root, 'x'), 'qwen'));
  let message = '';
  try {
    await signer.start('qwen');
  } catch (error) {
    message = (error as Error).message;
  }
  assert(message.includes('API key'), message);
  try {
    await signer.start('claude');
  } catch (error) {
    message = (error as Error).message;
  }
  assertEquals(message, 'AIB cannot check or start a sign-in for that agent.');
});

Deno.test('a chat with a Beta agent sends the key method the stored key (connection authenticateParams)', sanitize, async () => {
  await using lab = new Lab();
  const c = lab.connection([PY, FAKE], { env: { GEMINI_API_KEY: 'test-key-not-real' } }, lab.dir, 'gemini');
  assertEquals(c.authenticateParams('gemini-api-key'), { methodId: 'gemini-api-key', _meta: { 'api-key': 'test-key-not-real' } });
  assertEquals(c.authenticateParams('oauth-personal'), { methodId: 'oauth-personal' });
  const other = lab.connection([PY, FAKE], { env: { GEMINI_API_KEY: 'k' } }, lab.dir, 'omp');
  assertEquals(other.authenticateParams('gemini-api-key'), { methodId: 'gemini-api-key' });
});
