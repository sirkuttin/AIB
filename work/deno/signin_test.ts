/**
 * server/agents/signin.ts: the cases of work/test_agent_signin.py that need no web server, plus interop of the cache and job files
 * with agent_signin.py both ways. work/fake_signin_agent.py stands in for Claude Code and Codex: nothing here runs a real login or
 * status command, touches the network or uses an account, and every folder is a temp folder.
 */
import { assert, assertEquals, assertRejects, assertThrows } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { deadPid, exists, FAKE_SIGNIN, join, PY, tempDir, touch, waitFor, withEnv } from './_agents.ts';
import * as signin from '../../outputs/agent-studio/server/agents/signin.ts';
import { Signer, type SignerOptions, SignInRefused, type Spawned } from '../../outputs/agent-studio/server/agents/signin.ts';
import { signinView } from '../../outputs/agent-studio/server/web/shared.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { treeSpawnOptions } from '../../outputs/agent-studio/server/platform/process_tree.ts';

const SIGNED_IN = '{"loggedIn": true, "authMethod": "claude.ai", "email": "placeholder-account", "subscriptionType": "max"}';
const SIGNED_OUT = '{"loggedIn": false}';
const sanitize = { sanitizeOps: false, sanitizeResources: false }; // the jobs run in the background between awaits

/** The console launcher of tests: a hidden child process; it records what it was asked to run. */
function quietConsole(record: string[][]) {
  return (argv: string[], env: Record<string, string>): Spawned => {
    record.push([...argv]);
    return new Deno.Command(argv[0], {
      args: argv.slice(1),
      env,
      clearEnv: true,
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
      ...treeSpawnOptions(),
    }).spawn();
  };
}

/** test_agent_signin.SignerBase */
function base() {
  const dir = tempDir();
  const root = dir.root;
  const statusFile = join(root, 'status.json');
  Deno.writeTextFileSync(statusFile, SIGNED_OUT);
  const restore = withEnv({
    FAKE_SIGNIN_LOG: join(root, 'fake.log'),
    FAKE_SIGNIN_STATUS_FILE: statusFile,
    FAKE_SIGNIN_LOGIN: 'ok',
    FAKE_SIGNIN_METHODS: 'claude',
    FAKE_SIGNIN_CHILD: join(root, 'child.pid'),
    FAKE_SIGNIN_AUTH: '',
  });
  const consoles: string[][] = [];
  const signers: Signer[] = [];
  const ctx = {
    root,
    state: join(root, 'state'),
    statusFile,
    consoles,
    make(found = true, options: SignerOptions = {}): Signer {
      const launch = found
        ? () => ({ argv: [PY, FAKE_SIGNIN], found: true, problem: '' })
        : () => ({ argv: [] as string[], found: false, problem: 'Not installed' });
      const made = new Signer(ctx.state, launch, { spawnConsole: quietConsole(consoles), systemIsWindows: true, ...options });
      signers.push(made);
      return made;
    },
    events(kind?: string): Record<string, unknown>[] {
      const log = join(root, 'fake.log');
      const rows = exists(log) ? Deno.readTextFileSync(log).split('\n').filter((l) => l).map((l) => JSON.parse(l)) : [];
      return rows.filter((r) => kind === undefined || r.kind === kind);
    },
    statusRuns() {
      return ctx.events('cli').filter((r) => JSON.stringify((r.args as string[]).slice(0, 2)) === '["auth","status"]');
    },
    finish(agentId = 'claude', which?: Signer) {
      const target = which ?? ctx.signer;
      return waitFor(() => {
        const job = target.status(agentId).job;
        return job.state !== 'idle' && job.state !== 'waiting' ? job : null;
      });
    },
    signer: null as unknown as Signer,
    async [Symbol.asyncDispose]() {
      for (const one of signers) for (const id of [...one.jobs.keys()]) await one.cancel(id).catch(() => {});
      restore();
      dir[Symbol.dispose]();
    },
  };
  ctx.signer = ctx.make();
  return ctx;
}

// ---- status parsing (StatusParsing) ------------------------------------------------------------------------------------

const STATUS_TABLE: [string, string][] = [
  [SIGNED_IN, 'ready'],
  ['{"loggedIn": true}', 'ready'],
  ['{"loggedIn": false}', 'signin'],
  ['{"loggedIn": false, "apiKeySource": "ANTHROPIC_API_KEY"}', 'ready'],
  ['{"loggedIn": false, "apiProvider": "bedrock"}', 'ready'],
  ['{"loggedIn": false, "apiProvider": "firstParty"}', 'signin'],
  ['{"kind": "account", "label": "Claude Max"}', 'ready'],
  ['{"kind": "api_key", "label": "Anthropic API key"}', 'ready'],
  ['{"kind": "none", "label": "Not logged in"}', 'signin'],
  ['', 'unknown'],
  ['not json', 'unknown'],
  ['{}', 'unknown'],
  ['[]', 'unknown'],
  ['null', 'unknown'],
  ['{"loggedIn": "yes"}', 'unknown'],
  ['{"loggedIn": tru', 'unknown'],
  ['{"kind": "", "loggedIn": false, "apiKeySource": ""}', 'signin'],
  ['{"kind": 5, "loggedIn": true}', 'ready'],
];

Deno.test('signed in, signed out and unknown, as Python reads them', async () => {
  await using py = new PyParity();
  for (const [text, expected] of STATUS_TABLE) {
    assertEquals(signin.parseStatus(text), expected, text);
    assertEquals(await py.call('agent_signin', 'parse_status', [text]), expected, text);
  }
});

Deno.test('the effective state prefers an open chat', async () => {
  assertEquals(signin.effectiveState('ready', 'signin'), 'signin');
  assertEquals(signin.effectiveState('signin', 'running'), 'ready');
  assertEquals(signin.effectiveState('signin', ''), 'signin');
  assertEquals(signin.effectiveState('', ''), 'unknown');
  assertEquals(signin.effectiveState('bogus', ''), 'unknown');
  await using py = new PyParity();
  for (const cached of ['ready', 'signin', 'unknown', '', 'bogus']) {
    for (const live of ['', 'signin', 'running', 'x']) {
      assertEquals(signin.effectiveState(cached, live), await py.call('agent_signin', 'effective_state', [cached, live]));
    }
  }
});

// ---- status and cache (StatusAndCache) ---------------------------------------------------------------------------------

Deno.test({
  name: "Claude's status is read from the agent's own status command only",
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.writeTextFileSync(t.statusFile, SIGNED_IN);
    const view = await t.signer.check('claude');
    assertEquals([view.state, view.checked], ['ready', true]);
    assertEquals(t.statusRuns()[0].args, ['auth', 'status', '--json']);
    assertEquals([...t.events('initialize'), ...t.events('session')], [], 'no ACP handshake and never a session, so no transcript');
    const saved = JSON.parse(Deno.readTextFileSync(join(t.state, 'agents', 'claude', signin.CACHE_NAME)));
    assertEquals(Object.keys(saved).sort(), ['checkedAt', 'state']);
    assert(!JSON.stringify(saved).includes('placeholder-account'), 'the email in the status output is never kept');
  },
});

Deno.test({
  name: 'signed out exits with 1 but is still read',
  ...sanitize,
  fn: async () => {
    await using t = base();
    assertEquals((await t.signer.check('claude')).state, 'signin');
  },
});

Deno.test({
  name: 'unreadable output is unknown, and a missing program too',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.writeTextFileSync(t.statusFile, 'garbage');
    assertEquals((await t.signer.check('claude', true)).state, 'unknown');
    const broken = new Signer(t.state, () => ({ argv: [join(t.root, 'nothing-here.exe')], found: true, problem: '' }));
    assertEquals((await broken.check('claude', true)).state, 'unknown');
  },
});

Deno.test({
  name: 'the status is cached and only Check again or age refreshes it',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await t.signer.check('claude');
    await t.signer.check('claude');
    await t.signer.check('claude');
    assertEquals(t.statusRuns().length, 1, 'opening Settings again within a minute does not run the command again');
    Deno.writeTextFileSync(t.statusFile, SIGNED_IN);
    assertEquals((await t.signer.check('claude')).state, 'signin', 'the cache still answers');
    const forced = await t.signer.check('claude', true); // "Check again"
    assertEquals([forced.state, t.statusRuns().length], ['ready', 2]);
    Deno.writeTextFileSync(
      join(t.state, 'agents', 'claude', signin.CACHE_NAME),
      JSON.stringify({ state: 'ready', checkedAt: Date.now() / 1000 - signin.CACHE_SECONDS - 5 }),
    );
    await t.signer.check('claude');
    assertEquals(t.statusRuns().length, 3, 'an old answer is refreshed');
  },
});

Deno.test({
  name: 'checks at once run the status command once',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await Promise.all([t.signer.check('claude'), t.signer.check('claude'), t.signer.check('claude')]);
    assertEquals(t.statusRuns().length, 1);
  },
});

// ---- Codex: `codex login status` exit code, else whether auth.json exists ------------------------------------------------

/** A fake `codex` CLI: records its args, prints a line that must never be read, exits with the code in <root>/codex-exit. */
function fakeCodex(root: string): { argv: string[]; exit(code: number): void; runs(): string[][] } {
  const script = join(root, 'fake_codex.py');
  Deno.writeTextFileSync(
    script,
    [
      'import json, os, sys',
      'root = os.path.dirname(os.path.abspath(__file__))',
      "open(os.path.join(root, 'codex-runs.log'), 'a').write(json.dumps(sys.argv[1:]) + '\\n')",
      "print('Logged in using ChatGPT: placeholder-account')",
      "sys.exit(int(open(os.path.join(root, 'codex-exit')).read()))",
    ].join('\n'),
  );
  const exitFile = join(root, 'codex-exit');
  Deno.writeTextFileSync(exitFile, '0');
  return {
    argv: [PY, script],
    exit: (code) => Deno.writeTextFileSync(exitFile, String(code)),
    runs: () => {
      const log = join(root, 'codex-runs.log');
      return exists(log) ? Deno.readTextFileSync(log).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    },
  };
}

Deno.test({
  name: 'Codex: `codex login status` decides by exit code alone, and Check again really re-checks',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const codex = fakeCodex(t.root);
    const asked: string[][] = [];
    const signer = t.make(true, { codexCli: (argv) => (asked.push(argv), Promise.resolve(codex.argv)) });
    const first = await signer.check('codex', true);
    assertEquals([first.state, first.checked], ['ready', true]);
    assertEquals(codex.runs(), [['login', 'status']]);
    assertEquals(asked[0], [PY, FAKE_SIGNIN], 'the CLI is looked up from the adapter launch');
    assertEquals(t.events(), [], 'the adapter itself is not started for a status check');
    codex.exit(1);
    assertEquals((await signer.check('codex')).checked, false, 'within a minute Settings reuses the answer');
    const again = await signer.check('codex', true); // "Check again"
    assertEquals([again.state, again.checked], ['signin', true]);
    assertEquals(signin.readCached(t.state, 'codex').state, 'signin');
    assertEquals(codex.runs().length, 2);
  },
});

Deno.test({
  name: 'Codex without a CLI: auth.json under CODEX_HOME or ~/.codex decides, by existence only',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const home = join(t.root, 'home');
    const codexHome = join(t.root, 'codex-home');
    Deno.mkdirSync(join(home, '.codex'), { recursive: true });
    Deno.mkdirSync(codexHome, { recursive: true });
    const restore = withEnv({ HOME: home, USERPROFILE: home, CODEX_HOME: '' });
    try {
      const none = t.make(true, { codexCli: () => Promise.resolve(null) });
      assertEquals((await none.check('codex', true)).state, 'signin');
      Deno.writeTextFileSync(join(home, '.codex', 'auth.json'), '{}');
      assertEquals((await none.check('codex', true)).state, 'ready');
      Deno.env.set('CODEX_HOME', codexHome); // Codex honours CODEX_HOME: ~/.codex no longer counts
      assertEquals((await none.check('codex', true)).state, 'signin');
      Deno.writeTextFileSync(join(codexHome, 'auth.json'), '{}');
      assertEquals((await none.check('codex', true)).state, 'ready');
      // A CLI that cannot be started falls back to the file too.
      const broken = t.make(true, { codexCli: () => Promise.resolve([join(t.root, 'missing', 'codex.exe')]) });
      assertEquals((await broken.check('codex', true)).state, 'ready');
      Deno.removeSync(join(codexHome, 'auth.json'));
      assertEquals((await broken.check('codex', true)).state, 'signin');
    } finally {
      restore();
    }
    assertEquals(signin.codexAuthState({}), 'unknown', 'no CLI and no home folder: Not checked');
    assertEquals(signin.codexAuthFile({ CODEX_HOME: codexHome }), join(codexHome, 'auth.json'));
  },
});

Deno.test({
  name: 'Codex not installed: nothing runs and it stays Not checked',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const codex = fakeCodex(t.root);
    const view = await t.make(false, { codexCli: () => Promise.resolve(codex.argv) }).check('codex', true);
    assertEquals([view.state, view.checked], ['unknown', false]);
    assertEquals(codex.runs(), []);
  },
});

Deno.test('the Codex CLI is found in the adapter\'s own node_modules tree, then a native codex on PATH (never a .cmd shim)', async () => {
  using dir = tempDir();
  const none = { which: () => null };
  const outside = join(dir.root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  touch(outside); // above the adapter's tree: never used
  const nm = join(dir.root, 'agents', 'codex', '2.6.0', 'node_modules');
  const adapter = join(nm, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js');
  touch(adapter);
  assertEquals(await signin.findCodexCli(['node.exe', adapter], none), null);
  const cli = join(nm, '@openai', 'codex', 'bin', 'codex.js');
  touch(cli); // hoisted next to the adapter, as npm ci installs it
  assertEquals(await signin.findCodexCli(['node.exe', adapter], none), ['node.exe', cli]);
  const nested = join(nm, '@agentclientprotocol', 'codex-acp', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  touch(nested); // a global `npm i -g` nests it
  assertEquals(await signin.findCodexCli(['node.exe', adapter], none), ['node.exe', nested], 'the nearest one, as Node resolves it');
  const loose = touch(join(dir.root, 'fake-adapter.js')); // a launcher outside any node_modules: no walk at all
  assertEquals(await signin.findCodexCli(['node.exe', loose], none), null);
  const exe = Deno.build.os === 'windows' ? 'C:/bin/codex.exe' : '/usr/bin/codex';
  assertEquals(await signin.findCodexCli(null, { ...none, which: () => exe }), [exe]);
  assertEquals(await signin.findCodexCli(null, { ...none, which: () => 'C:/npm/codex.cmd' }), null);
});

Deno.test({
  name: 'an agent that is not installed has nothing to check, and a stale answer is dropped',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await t.signer.check('claude');
    const gone = t.make(false);
    assertEquals((await gone.check('claude', true)).state, 'unknown');
    assert(!exists(join(t.state, 'agents', 'claude', signin.CACHE_NAME)));
  },
});

Deno.test({
  name: 'only the built-in agents can be asked',
  ...sanitize,
  fn: async () => {
    await using t = base();
    for (const bad of ['omp', '../x', 7, null, 'custom-a', 'constructor']) {
      await assertRejects(() => t.signer.check(bad), SignInRefused);
      await assertRejects(() => t.signer.start(bad), SignInRefused);
      assertThrows(() => t.signer.status(bad), SignInRefused);
    }
    const error = await assertRejects(() => t.signer.start('omp'), SignInRefused);
    assertEquals([(error as SignInRefused).code, error.message], [
      'signin_refused',
      'AIB cannot check or start a sign-in for that agent.',
    ]);
  },
});

// ---- the Sign in button (SignInButton) ---------------------------------------------------------------------------------

Deno.test({
  name: 'the argv comes from the advertised method and authenticate is never called',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_METHODS', 'claude-custom');
    await t.signer.start('claude');
    const job = (await t.finish())!;
    assertEquals(job.state, 'done', JSON.stringify(job));
    assertEquals(t.consoles, [[PY, FAKE_SIGNIN, '--cli', 'auth', 'login', '--claudeai', '--custom-flag']]);
    const inits = t.events('initialize');
    assertEquals(inits.length, 1);
    assert((inits[0].caps as { auth: { terminal: boolean } }).auth.terminal, 'Studio says it can run terminal sign-ins');
    assertEquals(t.events('authenticate'), [], 'ACP authenticate is never sent for a terminal method');
    assertEquals(t.events('session'), [], 'and no session is created');
  },
});

Deno.test({
  name: 'without an advertised method the documented Claude login is used',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_METHODS', 'none');
    await t.signer.start('claude');
    assertEquals((await t.finish())!.state, 'done');
    assertEquals(t.consoles, [[PY, FAKE_SIGNIN, '--cli', 'auth', 'login', '--claudeai']]);
    assertEquals(t.events('authenticate'), []);
  },
});

Deno.test({
  name: 'when the process exits the status is checked again and cached',
  ...sanitize,
  fn: async () => {
    await using t = base();
    assertEquals((await t.signer.check('claude')).state, 'signin');
    await t.signer.start('claude');
    assertEquals((await t.finish())!.state, 'done');
    assertEquals(t.signer.status('claude').state, 'ready');
    assertEquals(t.statusRuns().length, 2, 'one check before, one after the login exited');
  },
});

Deno.test({
  name: 'a login that fails or changes nothing is reported in one line',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_LOGIN', 'fail');
    await t.signer.start('claude');
    let job = (await t.finish())!;
    assertEquals(job.state, 'failed');
    assert(job.message.includes('code 3'), job.message);
    Deno.env.set('FAKE_SIGNIN_LOGIN', 'nochange');
    await t.signer.start('claude');
    job = (await waitFor(() => (t.signer.jobs.get('claude')!.alive ? null : t.signer.status('claude').job)))!;
    assertEquals(job.state, 'failed');
    assert(job.message.includes('still shows as signed out'), job.message);
    assertEquals(t.signer.status('claude').state, 'signin');
  },
});

Deno.test({
  name: 'cancel kills the console process tree and the row goes back',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_LOGIN', 'hang');
    await t.signer.start('claude');
    const childFile = join(t.root, 'child.pid');
    const child = Number(await waitFor(() => (exists(childFile) && Deno.readTextFileSync(childFile).trim()) || null));
    assert(pidAlive(child));
    assertEquals(t.signer.status('claude').job.state, 'waiting');
    const answer = await t.signer.cancel('claude');
    assertEquals(answer.state, 'idle');
    assert(await waitFor(() => !pidAlive(child), 15), 'the grandchild of the login was killed too');
    assertEquals(t.signer.status('claude').job.state, 'idle');
    Deno.env.set('FAKE_SIGNIN_LOGIN', 'ok'); // and a new attempt can start right away
    await t.signer.start('claude');
    assertEquals((await t.finish())!.state, 'done');
  },
});

Deno.test({
  name: 'two clicks are one job',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_LOGIN', 'hang');
    const [first, second] = await Promise.all([t.signer.start('claude'), t.signer.start('claude')]);
    assertEquals([first.state, first.attached, second.attached], ['waiting', false, true]);
    await waitFor(() => t.consoles.length);
    assertEquals(t.consoles.length, 1);
  },
});

Deno.test({
  name: 'on macOS and Linux the command is shown instead of started',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const made = t.make(true, { systemIsWindows: false });
    await made.start('claude');
    const job = (await t.finish('claude', made))!;
    assertEquals(job.state, 'manual');
    assert(job.command.includes('--cli auth login --claudeai'), job.command);
    assert(job.command.startsWith(PY.includes(' ') ? `"${PY}"` : PY), 'a part with a space is quoted');
    assertEquals(t.consoles, []);
    await made.check('claude', true); // "Check again" clears the instruction
    assertEquals(made.status('claude').job.state, 'idle');
  },
});

Deno.test({
  name: 'Codex uses its agent method on a one-off process and no console',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_METHODS', 'codex');
    await t.signer.start('codex');
    const job = (await t.finish('codex'))!;
    assertEquals(job.state, 'done', JSON.stringify(job));
    assertEquals(
      t.events('authenticate').map((e) => e.methodId),
      ['chatgpt'],
      'an agent method is the one case where authenticate is sent',
    );
    assertEquals(t.consoles, []);
    assertEquals(t.events('session'), []);
    assertEquals(t.signer.status('codex').state, 'ready');
  },
});

Deno.test({
  name: 'Codex that refuses is a failure with one line',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_METHODS', 'codex');
    Deno.env.set('FAKE_SIGNIN_AUTH', 'fail');
    await t.signer.start('codex');
    const job = (await t.finish('codex'))!;
    assertEquals(job.state, 'failed');
    assert(job.message.includes('login refused'), job.message);
  },
});

Deno.test({
  name: 'an agent that offers nothing startable gets a plain failure',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_SIGNIN_METHODS', 'none');
    await t.signer.start('codex');
    const job = (await t.finish('codex'))!;
    assertEquals(job.state, 'failed');
    assert(job.message.includes('did not offer a sign-in'), job.message);
  },
});

Deno.test({
  name: 'an agent that is not installed is refused',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const error = await assertRejects(() => t.make(false).start('claude'), SignInRefused);
    assertEquals(error.message, 'Claude Code is not installed yet, so there is nothing to sign in to. Not installed');
  },
});

Deno.test('advertised methods are normalised and hostile args dropped, as Python does', async () => {
  const raw = [
    { id: 'a', type: 'terminal', args: ['--cli', 'x'] },
    { id: 'b', type: 'terminal', args: ['ok', 'bad\nline'] },
    { id: 'c', type: 'env_var', vars: [] },
    { id: 'd' },
    { name: 'no id' },
    'junk',
    { id: 'e', type: 'terminal', args: Array(40).fill('x') },
  ];
  const methods = signin.normalizeMethods(raw);
  assertEquals(methods.map((m) => [m.id, m.kind, m.args]), [['a', 'terminal', ['--cli', 'x']], ['b', 'terminal', []], ['d', 'agent', []], [
    'e',
    'terminal',
    [],
  ]]);
  await using py = new PyParity();
  const more = [
    raw,
    [{ id: 'x', type: null, name: '' }, { id: 'y', type: 'agent', args: ['a'], name: 'N'.repeat(100) }, { id: 'z'.repeat(257) }, {
      id: '',
    }],
    [{ id: 't', type: 'terminal', args: [] }, { id: 'u', type: 'terminal', args: ['', 'x'] }, {
      id: 'v',
      type: 'terminal',
      args: ['é'.repeat(200)],
    }],
    Array.from({ length: 25 }, (_, i) => ({ id: `m${i}` })),
    null,
    'x',
  ];
  for (const list of more) {
    const mine = signin.normalizeMethods(list);
    assertEquals(mine, await py.call('agent_signin', 'normalize_methods', [list]), JSON.stringify(list).slice(0, 80));
    for (const agent of ['claude', 'codex']) {
      assertEquals(signin.chooseMethod(agent, mine), await py.call('agent_signin', 'choose_method', [agent, mine]));
    }
  }
});

Deno.test({
  name: 'a waiting job whose process died is reported as failed',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const path = join(t.state, 'agents', 'claude', signin.JOB_NAME);
    Deno.mkdirSync(join(t.state, 'agents', 'claude'), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify({ state: 'waiting', pid: await deadPid() }));
    assertEquals(signin.readJob(t.state, 'claude').state, 'failed');
  },
});

// ---- the Settings list (SettingsListAndGating, the signin_view part) ---------------------------------------------------

Deno.test('the agent list carries the cached state and a live chat overrides it', () => {
  using dir = tempDir();
  const options = { stateDir: dir.root, nodeCommand: '', ompCommand: '', claudeLauncher: '', codexLauncher: '' };
  Deno.mkdirSync(join(dir.root, 'agents', 'claude'), { recursive: true });
  Deno.writeTextFileSync(join(dir.root, 'agents', 'claude', signin.CACHE_NAME), JSON.stringify({ state: 'signin', checkedAt: 5 }));
  const view = signinView(options, 'claude')!;
  assertEquals([view.state, view.checkedAt, view.job], ['signin', 5, null]);
  assertEquals(signinView(options, 'claude', 'running')!.state, 'ready');
  assertEquals(signinView(options, 'codex')!.state, 'unknown');
  assertEquals(signinView(options, 'omp'), null);
});

// ---- interop with agent_signin.py --------------------------------------------------------------------------------------

Deno.test({
  name: 'the cache and job files are interchangeable with the Python signer, both ways',
  ...sanitize,
  fn: async () => {
    await using py = new PyParity();
    await using t = base();
    // Deno writes (a check, a manual job); Python reads
    await t.signer.check('claude');
    const made = t.make(true, { systemIsWindows: false });
    await made.start('claude');
    await t.finish('claude', made);
    assertEquals(await py.call('agent_signin', 'read_cached', [t.state, 'claude']), signin.readCached(t.state, 'claude'));
    assertEquals(await py.call('agent_signin', 'read_job', [t.state, 'claude']), signin.readJob(t.state, 'claude'));
    assertEquals(await py.call('agents_shim', 'signin_view', [t.state, 'claude', '']), signinView({ stateDir: t.state }, 'claude', ''));
    const ours = {
      cache: Deno.readTextFileSync(join(t.state, 'agents', 'claude', signin.CACHE_NAME)),
      job: Deno.readTextFileSync(join(t.state, 'agents', 'claude', signin.JOB_NAME)),
    };
    // Python writes the same records; the bytes match apart from the times, and Deno reads them back the same
    await py.call('agents_shim', 'signer_write', [t.state, 'claude', 'signin', [
      'manual',
      signin.readJob(t.state, 'claude').message,
      signin.readJob(t.state, 'claude').command,
      Deno.pid,
    ]]);
    const strip = (text: string) => text.replace(/"(checkedAt|updatedAt)": [0-9.e+-]+/g, '"$1": 0');
    assertEquals(strip(Deno.readTextFileSync(join(t.state, 'agents', 'claude', signin.CACHE_NAME))), strip(ours.cache));
    assertEquals(strip(Deno.readTextFileSync(join(t.state, 'agents', 'claude', signin.JOB_NAME))), strip(ours.job));
    for (
      const job of [['waiting', '', '', Deno.pid], ['waiting', '', '', await deadPid()], ['failed', 'nope', '', 1], ['done', '', '', 1]]
    ) {
      await py.call('agents_shim', 'signer_write', [t.state, 'codex', 'ready', job]);
      assertEquals(signin.readJob(t.state, 'codex'), await py.call('agent_signin', 'read_job', [t.state, 'codex']), JSON.stringify(job));
      assertEquals(signin.readCached(t.state, 'codex'), await py.call('agent_signin', 'read_cached', [t.state, 'codex']));
      assertEquals(
        signinView({ stateDir: t.state }, 'codex', 'signin'),
        await py.call('agents_shim', 'signin_view', [t.state, 'codex', 'signin']),
      );
    }
    // a Python job record makes a Deno "Check again" clear it, and a Deno cancel of a finished job removes it
    await py.call('agents_shim', 'signer_write', [t.state, 'claude', null, ['manual', 'Run this', 'x', 1]]);
    await t.signer.check('claude', true);
    assertEquals(t.signer.status('claude').job.state, 'idle');
    await py.call('agents_shim', 'signer_write', [t.state, 'claude', null, ['failed', 'x', '', 1]]);
    assertEquals((await t.signer.cancel('claude')).state, 'idle');
    for (const odd of ['{broken', '[]', '{"state": "weird"}', '{"state": "ready", "checkedAt": "12.5"}']) {
      Deno.writeTextFileSync(join(t.state, 'agents', 'claude', signin.CACHE_NAME), odd);
      assertEquals(signin.readCached(t.state, 'claude'), await py.call('agent_signin', 'read_cached', [t.state, 'claude']), odd);
    }
  },
});
