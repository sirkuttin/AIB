/**
 * server/agents/installer.ts: the cases of work/test_agent_installer.py that need no web server, plus interop of the job files with
 * agent_installer.py both ways. work/fake_npm.py stands in for npm (run by Python, passed as "node"): nothing uses the network or
 * installs anything, and every folder is a temp folder.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { deadPid, exists, FAKE_NPM, join, makeInstall, PY, tempDir, waitFor, withEnv } from './_agents.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import * as adapters from '../../outputs/agent-studio/server/agents/adapters.ts';
import * as installer from '../../outputs/agent-studio/server/agents/installer.ts';
import { Installer, type InstallerOptions, InstallRefused } from '../../outputs/agent-studio/server/agents/installer.ts';
import { installState } from '../../outputs/agent-studio/server/web/shared.ts';
import { pidAlive } from '../../outputs/agent-studio/server/host/host_client.ts';
import { APP_ROOT } from '../../outputs/agent-studio/server/core/app.ts';

const ALLOW = {
  claude: { package: '@agentclientprotocol/claude-agent-acp', version: '0.102.0', packageBytes: 1000, minFreeBytes: 0 },
  codex: { package: '@agentclientprotocol/codex-acp', version: '2.6.0', packageBytes: 1000, minFreeBytes: 0 },
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const sanitize = { sanitizeOps: false, sanitizeResources: false }; // the jobs run in the background between awaits

/** test_agent_installer.InstallerBase */
function base() {
  const dir = tempDir();
  const root = dir.root;
  const restore = withEnv({ FAKE_NPM_LOG: join(root, 'npm.log'), FAKE_NPM_MODE: 'ok', FAKE_NPM_CHILD: join(root, 'child.pid') });
  const installers: Installer[] = [];
  const ctx = {
    root,
    state: join(root, 'state'),
    make(options: InstallerOptions = {}): Installer {
      const made = new Installer(ctx.state, {
        nodeCommand: PY,
        allowList: clone(ALLOW),
        nodeProbe: () => '22.4.0',
        npmCli: FAKE_NPM,
        diskFree: () => 10 ** 12,
        ...options,
      });
      installers.push(made);
      return made;
    },
    runs(): { args: string[]; cwd: string }[] {
      const log = join(root, 'npm.log');
      return exists(log) ? Deno.readTextFileSync(log).split('\n').filter((l) => l).map((l) => JSON.parse(l)) : [];
    },
    finish(agentId = 'claude', which?: Installer) {
      const target = which ?? ctx.installer;
      return waitFor(async () => {
        const s = await target.status(agentId);
        return s.state === 'done' || s.state === 'failed' ? s : null;
      });
    },
    versionDir(agentId: 'claude' | 'codex' = 'claude') {
      return join(ctx.state, 'agents', agentId, ALLOW[agentId].version);
    },
    installer: null as unknown as Installer,
    async [Symbol.asyncDispose]() {
      for (const one of installers) for (const id of [...one.jobs.keys()]) await one.cancel(id).catch(() => {});
      restore();
      delete adapters.adapterHooks.findNode;
      dir[Symbol.dispose]();
    },
  };
  ctx.installer = ctx.make();
  return ctx;
}

// ---- success (InstallSucceeds) -------------------------------------------------------------------------------------------

Deno.test({
  name: 'success writes .complete last and the lookup then picks it',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_NPM_MODE', 'slow');
    Deno.env.set('FAKE_NPM_DELAY', '1.5');
    const first = await t.installer.start('claude');
    assertEquals([first.state, first.stage, first.attached], ['running', 'preparing', false]);
    const folder = t.versionDir();
    assert(await waitFor(() => exists(join(folder, 'node_modules'))));
    assert(!exists(join(folder, adapters.COMPLETE_MARKER)));
    assertEquals(adapters.findStudioInstall('claude', t.state), null);
    const done = await t.finish();
    assertEquals([done!.state, done!.percent, done!.stage], ['done', 100, 'done'], JSON.stringify(done));
    const marker = join(folder, adapters.COMPLETE_MARKER);
    let newest = 0;
    const walk = (dir: string) => {
      for (const entry of Deno.readDirSync(dir)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory) walk(path);
        else if (path !== marker) newest = Math.max(newest, Deno.statSync(path).mtime!.getTime());
      }
    };
    walk(folder);
    assert(Deno.statSync(marker).mtime!.getTime() >= newest, 'the marker is written after every other file');
    adapters.adapterHooks.globalRoots = () => [];
    try {
      const row = await adapters.resolveClaude({ nodeCommand: PY, stateDir: t.state });
      assertEquals([row.found, row.source], [true, 'studio']);
      assert(row.path.replaceAll('\\', '/').endsWith('claude-agent-acp/dist/index.js'));
    } finally {
      delete adapters.adapterHooks.globalRoots;
    }
    assert(!exists(join(t.state, 'agents', 'claude', installer.LOCK_NAME)), 'the lock is released');
    Deno.env.delete('FAKE_NPM_DELAY');
  },
});

Deno.test({
  name: 'without a lockfile: npm install with the exact version and safe flags, run through node',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await t.installer.start('claude');
    assertEquals((await t.finish())!.state, 'done');
    const runs = t.runs();
    assertEquals(runs.length, 1);
    assertEquals(runs[0].args.slice(0, 2), ['install', '@agentclientprotocol/claude-agent-acp@0.102.0']);
    for (const flag of ['--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', '--prefix']) assert(runs[0].args.includes(flag), flag);
    assertEquals(Deno.realPathSync(runs[0].cwd), Deno.realPathSync(t.versionDir()));
  },
});

Deno.test({
  name: 'with a lockfile: npm ci in the version folder',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const lock = join(t.root, 'claude.lock.json');
    Deno.writeTextFileSync(lock, '{"lockfileVersion": 3}');
    const allow = clone(ALLOW) as Record<string, Record<string, unknown>>;
    allow.claude.lockfile = lock;
    const made = t.make({ allowList: allow });
    await made.start('claude');
    assertEquals((await t.finish('claude', made))!.state, 'done');
    const [run] = t.runs();
    assertEquals(run.args[0], 'ci');
    assert(run.args.includes('--ignore-scripts'));
    assert(exists(join(t.versionDir(), 'package-lock.json')));
    const manifest = JSON.parse(Deno.readTextFileSync(join(t.versionDir(), 'package.json')));
    assertEquals(manifest.dependencies, { '@agentclientprotocol/claude-agent-acp': '0.102.0' });
  },
});

Deno.test({
  name: 'Codex installs under the current registry name',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await t.installer.start('codex');
    assertEquals((await t.finish('codex'))!.state, 'done');
    const found = adapters.findStudioInstall('codex', t.state)!;
    assertEquals([found.package, found.version], ['@agentclientprotocol/codex-acp', '2.6.0']);
  },
});

Deno.test({
  name: 'the wrong version from npm is a failure and leaves nothing',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const restore = withEnv({ FAKE_NPM_VERSION: '9.9.9' });
    try {
      await t.installer.start('claude');
      const done = (await t.finish())!;
      assertEquals(done.state, 'failed');
      assert(done.message.includes('9.9.9'), done.message);
      assert(!exists(t.versionDir()));
      assertEquals(adapters.findStudioInstall('claude', t.state), null);
    } finally {
      restore();
      Deno.env.delete('FAKE_NPM_VERSION');
    }
  },
});

Deno.test({
  name: 'an install that is already complete is not run again',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await t.installer.start('claude');
    await t.finish();
    assertEquals((await t.installer.start('claude')).state, 'done');
    assertEquals(t.runs().length, 1);
  },
});

// ---- one job per agent (OneJobPerAgent) ----------------------------------------------------------------------------------

Deno.test({
  name: 'two installs at once become one job',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_NPM_MODE', 'slow');
    Deno.env.set('FAKE_NPM_DELAY', '1.5');
    const results = await Promise.all([t.installer.start('claude'), t.installer.start('claude')]);
    assertEquals(results.map((r) => r.attached).sort(), [false, true]);
    assertEquals((await t.finish())!.state, 'done');
    assertEquals(t.runs().length, 1, 'npm ran once');
    Deno.env.delete('FAKE_NPM_DELAY');
  },
});

Deno.test({
  name: 'a live process holding the lock makes a new request attach',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const holder = new Deno.Command(PY, { args: ['-c', 'import time; time.sleep(60)'] }).spawn();
    try {
      const folder = join(t.state, 'agents', 'claude');
      Deno.mkdirSync(folder, { recursive: true });
      Deno.writeTextFileSync(join(folder, installer.LOCK_NAME), JSON.stringify({ pid: holder.pid }));
      Deno.writeTextFileSync(
        join(folder, installer.STATE_NAME),
        JSON.stringify({ state: 'running', stage: 'downloading', percent: 40, version: '0.102.0', pid: holder.pid }),
      );
      const answer = await t.installer.start('claude');
      assertEquals([answer.attached, answer.state, answer.percent], [true, 'running', 40]);
      assertEquals(t.runs(), []);
    } finally {
      holder.kill();
      await holder.status;
    }
  },
});

Deno.test({
  name: 'a lock of a dead process is taken over',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const folder = join(t.state, 'agents', 'claude');
    Deno.mkdirSync(folder, { recursive: true });
    Deno.writeTextFileSync(join(folder, installer.LOCK_NAME), JSON.stringify({ pid: await deadPid() }));
    assertEquals((await t.installer.start('claude')).attached, false);
    assertEquals((await t.finish())!.state, 'done');
  },
});

// ---- cancel and failure (CancelAndFailure) -------------------------------------------------------------------------------

Deno.test({
  name: 'cancel kills the whole tree and removes the half-made folder',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_NPM_MODE', 'hang');
    await t.installer.start('claude');
    const childFile = join(t.root, 'child.pid');
    const child = Number(await waitFor(() => (exists(childFile) && Deno.readTextFileSync(childFile).trim()) || null));
    assert(pidAlive(child));
    assert(exists(join(t.versionDir(), 'node_modules')));
    const answer = await t.installer.cancel('claude');
    assertEquals(answer.state, 'idle');
    assert(await waitFor(() => !pidAlive(child), 15), 'the grandchild of npm was killed too');
    assert(!exists(t.versionDir()), 'the half-made folder is deleted');
    assert(!exists(join(t.state, 'agents', 'claude', installer.LOCK_NAME)));
    assertEquals(adapters.findStudioInstall('claude', t.state), null);
    Deno.env.set('FAKE_NPM_MODE', 'ok'); // and a new install can start right away
    assertEquals((await t.installer.start('claude')).attached, false);
    assertEquals((await t.finish())!.state, 'done');
  },
});

Deno.test({
  name: 'a failure is one plain line and retry works',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_NPM_MODE', 'fail');
    await t.installer.start('claude');
    const done = (await t.finish())!;
    assertEquals(done.state, 'failed');
    assertEquals(done.message, 'Could not reach the npm registry. Check the internet connection and try again.');
    assert(!done.message.includes('\n'));
    assert(!exists(t.versionDir()));
    Deno.env.set('FAKE_NPM_MODE', 'ok');
    await t.installer.start('claude'); // Retry is the same call
    assertEquals((await t.finish())!.state, 'done');
  },
});

const FAILURE_LOGS: [string, number][] = [
  ['npm error code ENOSPC', 1],
  ['', 3],
  ['npm error something odd happened\nnpm error A complete log of this run', 1],
  ['npm ERR! code E404\nnpm ERR! 404 Not Found', 1],
  ['npm error code EINTEGRITY', 1],
  ['npm error code EUSAGE', 1],
  ['npm ERR! code ENOENT\nnpm ERR! syscall open\nnpm ERR! path C:\\x\\package-lock.json', 254],
  ['npm error EACCES: permission denied', 1],
  ['npm error code EPERM', 1],
  ['some output\n  npm error   ' + 'x'.repeat(300), 1],
  ['npm error code 1\nnpm error path C:\\x\nnpm error errno 5\nnpm error syscall spawn', 2],
  ['npm error \u00e9t\u00e9 \ud83d\ude00 '.repeat(20), 1],
];

Deno.test('failure lines match Python', async () => {
  assertEquals(installer.failureLine('npm error code ENOSPC', 1), 'The disk is full.');
  assert(installer.failureLine('', 3).includes('exit code 3'));
  assert(
    installer.failureLine('npm error something odd happened\nnpm error A complete log of this run', 1).startsWith(
      'npm said: something odd',
    ),
  );
  await using py = new PyParity();
  for (const [text, code] of FAILURE_LOGS) {
    assertEquals(installer.failureLine(text, code), await py.call('agent_installer', 'failure_line', [text, code]), text);
  }
  for (const size of [0, 1, 5 * 1024 ** 2, 1.5 * 1024 ** 2, 2.5 * 1024 ** 2, 900 * 1024 ** 2, 1024 ** 3, 1.25 * 1024 ** 3, 420000000 * 2]) {
    assertEquals(installer.sizeText(size), await py.call('agent_installer', '_size', [size]), String(size));
  }
});

// ---- refused before npm runs (RefusedBeforeNpmRuns) ----------------------------------------------------------------------

async function assertRefused(t: ReturnType<typeof base>, made: Installer, text: string, agentId = 'claude') {
  const error = await assertRejects(() => made.start(agentId), InstallRefused);
  assert(error.message.includes(text), error.message);
  assert(!error.message.includes('\n'));
  assertEquals((error as InstallRefused).code, 'install_refused');
  assertEquals(t.runs(), [], 'npm never ran');
  assert(!exists(join(t.state, 'agents', agentId)), 'nothing was created');
  assertEquals((await made.status(agentId)).state, 'idle');
}

Deno.test({
  name: 'refused: Node.js missing',
  ...sanitize,
  fn: async () => {
    await using t = base();
    adapters.adapterHooks.findNode = () => '';
    await assertRefused(t, t.make({ nodeCommand: '' }), 'Node.js was not found');
  },
});

Deno.test({
  name: 'refused: Node.js older than 22, or one that does not start',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await assertRefused(t, t.make({ nodeProbe: () => '20.11.0' }), 'this PC has Node.js 20.11.0');
    await assertRefused(t, t.make({ nodeProbe: () => '18.0.0' }), 'Node.js 22 or newer');
    await assertRefused(t, t.make({ nodeProbe: () => '' }), 'did not start');
    await t.make({ nodeProbe: () => '22.0.0' }).preflight('claude', ALLOW.claude);
  },
});

Deno.test({
  name: 'refused: npm missing next to node',
  ...sanitize,
  fn: async () => {
    await using t = base();
    await assertRefused(t, t.make({ npmCli: join(t.root, 'nope', 'npm-cli.js') }), 'npm was not found');
  },
});

Deno.test({
  name: 'refused: a full disk, and Claude needs one gigabyte even when its package is small',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const allow = clone(ALLOW);
    allow.codex.packageBytes = 500 * 1024 ** 2;
    await assertRefused(t, t.make({ allowList: allow, diskFree: () => 800 * 1024 ** 2 }), 'Not enough free disk space for Codex', 'codex');
    const big = clone(ALLOW);
    Object.assign(big.claude, { packageBytes: 100 * 1024 ** 2, minFreeBytes: 1024 ** 3 });
    await assertRefused(t, t.make({ allowList: big, diskFree: () => 900 * 1024 ** 2 }), '1.0 GB');
    await t.make({ allowList: big, diskFree: () => 1100 * 1024 ** 2 }).preflight('claude', big.claude);
    // a drive that cannot be asked is not a refusal (Python: OSError -> no check)
    await t.make({
      allowList: big,
      diskFree: () => {
        throw new Error('no');
      },
    }).preflight('claude', big.claude);
  },
});

Deno.test({
  name: 'refused: a path that is too long',
  ...sanitize,
  fn: async () => {
    await using t = base();
    t.state = join(t.root, 'deep'.repeat(70));
    await assertRefused(t, t.make(), 'characters long');
  },
});

Deno.test({
  name: 'refused: an agent that is not on the list, or a hostile id',
  ...sanitize,
  fn: async () => {
    await using t = base();
    for (const bad of ['omp', '../x', '', null, 5, 'constructor', '__proto__']) {
      await assertRejects(() => t.installer.start(bad), InstallRefused);
      await assertRejects(() => t.installer.status(bad), InstallRefused);
    }
  },
});

Deno.test('the real free-space probe answers for the temp folder', () => {
  using dir = tempDir();
  const free = new Installer(dir.root).diskFree(dir.root);
  assert(Number.isFinite(free) && free > 0, String(free));
});

// ---- a web server restarted mid-install (WebRestartMidInstall) -----------------------------------------------------------

Deno.test({
  name: 'a new web server still sees progress from the job files',
  ...sanitize,
  fn: async () => {
    await using t = base();
    Deno.env.set('FAKE_NPM_MODE', 'slow');
    Deno.env.set('FAKE_NPM_DELAY', '2.5');
    await t.installer.start('claude');
    await waitFor(() => exists(join(t.versionDir(), 'node_modules')));
    const options = { stateDir: t.state, nodeCommand: PY, claudeLauncher: '', codexLauncher: '', ompCommand: '' };
    const row = installState(options, 'claude')!;
    assertEquals(row.state, 'running');
    assert(['preparing', 'downloading'].includes(row.stage));
    assert(row.percent > 0);
    assertEquals(installState(options, 'codex'), null);
    assertEquals((await t.finish())!.state, 'done');
    assertEquals(installState(options, 'claude'), null, 'a finished install is a found agent, not a job');
    Deno.env.delete('FAKE_NPM_DELAY');
  },
});

Deno.test({
  name: 'a job whose process died is reported failed and cleaned up',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const folder = join(t.state, 'agents', 'claude');
    Deno.mkdirSync(join(folder, '0.102.0', 'node_modules'), { recursive: true });
    Deno.writeTextFileSync(
      join(folder, installer.STATE_NAME),
      JSON.stringify({ state: 'running', stage: 'downloading', percent: 30, version: '0.102.0', pid: await deadPid() }),
    );
    assertEquals(installer.readStatus(t.state, 'claude').state, 'failed');
    const view = await t.installer.status('claude');
    assertEquals(view.state, 'failed');
    assert(view.message.includes('interrupted'));
    assert(!exists(join(folder, '0.102.0')));
    assertEquals((await t.installer.status('claude')).state, 'failed');
  },
});

// ---- the shipped allow-list (Allowlist) ----------------------------------------------------------------------------------

Deno.test('the shipped list pins exact versions with matching lockfiles', () => {
  const agents = installer.loadAllowList() as Record<string, Record<string, string>>;
  assertEquals(Object.keys(agents).sort(), ['claude', 'codex']);
  for (const [agentId, entry] of Object.entries(agents)) {
    assert(/^\d+\.\d+\.\d+$/.test(entry.version), entry.version);
    const lock = JSON.parse(Deno.readTextFileSync(join(APP_ROOT, ...entry.lockfile.split('/'))));
    assertEquals(lock.packages[''].dependencies, { [entry.package]: entry.version });
    assertEquals(lock.packages[`node_modules/${entry.package}`].version, entry.version);
    assert(Object.entries(lock.packages).every(([key, p]) => !key || 'integrity' in (p as object)));
    assert(adapters.STUDIO_PACKAGES[agentId].map((p) => p[0]).includes(entry.package));
  }
  assertRejects(() => Promise.resolve().then(() => installer.loadAllowList(join(APP_ROOT, 'no-such-list.json'))));
});

// ---- the Node.js check (NodeBlockTest) -----------------------------------------------------------------------------------

Deno.test('the Node.js check: missing, old and fine', async () => {
  installer.clearNodeCache();
  try {
    adapters.adapterHooks.findNode = () => '';
    assertEquals(await installer.nodeBlock('x'), ['Node.js 22 or newer is needed to install this agent.', false]);
    installer.clearNodeCache();
    adapters.adapterHooks.findNode = () => 'node';
    const [line, found] = await installer.nodeBlock('x', false, () => '20.1.0');
    assert(line.includes('this PC has Node.js 20.1.0'));
    assert(found);
    assertEquals((await installer.nodeBlock('x', true, () => '22.4.0'))[0], '');
    assertEquals(await installer.nodeBlock('z', true, () => ''), [
      'Node.js 22 or newer is needed to install this agent, but Node.js did not start.',
      true,
    ]);
  } finally {
    delete adapters.adapterHooks.findNode;
    installer.clearNodeCache();
  }
});

Deno.test('the Node.js check is cached until forced', async () => {
  installer.clearNodeCache();
  adapters.adapterHooks.findNode = () => 'node';
  try {
    let calls = 0;
    for (const force of [false, false, true]) await installer.nodeBlock('y', force, () => (calls++, '22.0.0'));
    assertEquals(calls, 2);
    let clock = 1000;
    await installer.nodeBlock('w', false, () => (calls++, '22.0.0'), () => clock);
    clock += installer.NODE_CACHE_SECONDS + 1;
    await installer.nodeBlock('w', false, () => (calls++, '22.0.0'), () => clock);
    assertEquals(calls, 4, 'an answer older than 30 seconds is asked again');
  } finally {
    delete adapters.adapterHooks.findNode;
    installer.clearNodeCache();
  }
});

Deno.test('nodeVersion reads `node --version` and gives nothing when it does not run', async () => {
  const run: adapters.RunFn = () => Promise.resolve({ stdout: 'v22.4.0\n' });
  assertEquals(await installer.nodeVersion('node', run), '22.4.0');
  assertEquals(await installer.nodeVersion('node', () => Promise.reject(new Error('no'))), '');
  assertEquals(await installer.nodeVersion(join(Deno.cwd(), 'no-such-node-xyz.exe')), '');
});

// ---- interop with agent_installer.py ---------------------------------------------------------------------------------

Deno.test({
  name: 'the job files are interchangeable with the Python installer, both ways',
  ...sanitize,
  fn: async () => {
    await using py = new PyParity();
    await using t = base();
    // Deno runs a job; Python reads its state file
    await t.installer.start('codex');
    assertEquals((await t.finish('codex'))!.state, 'done');
    const mine = installer.readStatus(t.state, 'codex');
    assertEquals(await py.call('agent_installer', 'read_status', [t.state, 'codex']), mine);
    assertEquals(mine, { agent: 'codex', state: 'done', stage: 'done', percent: 100, message: '', version: '2.6.0' });
    assertEquals(await py.call('adapters', 'find_studio_install', ['codex', t.state]), adapters.findStudioInstall('codex', t.state));

    // the same keys in the same order with the same spacing; only updatedAt differs
    const path = join(t.state, 'agents', 'claude', installer.STATE_NAME);
    t.installer.save('claude', 'running', 'downloading', 40.7, '', '0.102.0', Deno.pid);
    const ours = Deno.readTextFileSync(path);
    await py.call('agents_shim', 'installer_save', [t.state, 'claude', 'running', 'downloading', 40.7, '', '0.102.0', Deno.pid]);
    const theirs = Deno.readTextFileSync(path);
    const strip = (text: string) => text.replace(/"updatedAt": [0-9.e+-]+/, '"updatedAt": 0');
    assertEquals(strip(ours), strip(theirs));
    // a Python job record (alive: this process's pid) reads the same on both sides; a dead pid is interrupted on both sides
    assertEquals(installer.readStatus(t.state, 'claude'), await py.call('agent_installer', 'read_status', [t.state, 'claude']));
    await py.call('agents_shim', 'installer_save', [t.state, 'claude', 'running', 'downloading', 40, '', '0.102.0', await deadPid()]);
    const dead = installer.readStatus(t.state, 'claude');
    assertEquals(dead, await py.call('agent_installer', 'read_status', [t.state, 'claude']));
    assertEquals([dead.state, dead.interrupted], ['failed', true]);
    for (const odd of ['{broken', '[]', '{"state": "weird"}', '{"state": "failed", "message": 5, "percent": 12.9}']) {
      Deno.writeTextFileSync(path, odd);
      assertEquals(installer.readStatus(t.state, 'claude'), await py.call('agent_installer', 'read_status', [t.state, 'claude']), odd);
    }
  },
});

Deno.test({
  name: 'the lock file is honoured across Python and Deno',
  ...sanitize,
  fn: async () => {
    await using py = new PyParity();
    await using t = base();
    const folder = join(t.state, 'agents', 'claude');
    // Python takes the lock (its own live pid) and records a running job: a Deno start joins it instead of running npm
    assertEquals(await py.call('agents_shim', 'installer_lock', [t.state, 'claude', 'take']), true);
    const pyPid = JSON.parse(Deno.readTextFileSync(join(folder, installer.LOCK_NAME))).pid;
    assert(pyPid !== Deno.pid && pidAlive(pyPid));
    await py.call('agents_shim', 'installer_save', [t.state, 'claude', 'running', 'downloading', 33, '', '0.102.0', pyPid]);
    const joined = await t.installer.start('claude');
    assertEquals([joined.attached, joined.state, joined.percent], [true, 'running', 33]);
    assertEquals(t.runs(), []);
    assertEquals(await py.call('agents_shim', 'installer_lock', [t.state, 'claude', 'drop']), true);
    assert(!exists(join(folder, installer.LOCK_NAME)));
    // Deno runs a job and holds the lock: Python cannot take it
    Deno.env.set('FAKE_NPM_MODE', 'slow');
    Deno.env.set('FAKE_NPM_DELAY', '2');
    assertEquals((await t.installer.start('codex')).attached, false);
    assertEquals(JSON.parse(Deno.readTextFileSync(join(t.state, 'agents', 'codex', installer.LOCK_NAME))).pid, Deno.pid);
    assertEquals(await py.call('agents_shim', 'installer_lock', [t.state, 'codex', 'take']), false);
    assertEquals((await t.finish('codex'))!.state, 'done');
    Deno.env.delete('FAKE_NPM_DELAY');
  },
});

// ---- uninstall (Deno only: the Python server has none) -------------------------------------------------------------------

const CODEX_PKG = '@agentclientprotocol/codex-acp';

Deno.test({
  name: 'uninstall removes every AIB install folder of the agent and its job files, and nothing else',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const [current] = makeInstall(t.state, 'codex', '2.6.0', CODEX_PKG);
    const [older] = makeInstall(t.state, 'codex', '2.5.0', CODEX_PKG);
    const [leftover] = makeInstall(t.state, 'codex', '2.7.0-beta', CODEX_PKG, { complete: false });
    const [claude] = makeInstall(t.state, 'claude', '0.102.0', '@agentclientprotocol/claude-agent-acp');
    const agentFolder = join(t.state, 'agents', 'codex');
    for (const name of [installer.STATE_NAME, installer.LOG_NAME, 'signin.json']) Deno.writeTextFileSync(join(agentFolder, name), '{}');
    assert(adapters.findStudioInstall('codex', t.state));
    const view = await t.installer.uninstall('codex');
    assertEquals([view.state, view.agent], ['idle', 'codex']);
    assertEquals([...view.removed].sort(), ['2.5.0', '2.6.0', '2.7.0-beta']);
    for (const gone of [current, older, leftover, join(agentFolder, installer.STATE_NAME), join(agentFolder, 'signin.json')]) {
      assert(!exists(gone), gone);
    }
    assertEquals(adapters.findStudioInstall('codex', t.state), null, 'the row falls back to another install, or Install');
    assert(exists(join(claude, '.complete')), 'another agent is never touched');
    assertEquals((await t.installer.status('codex')).state, 'idle');
    const again = await assertRejects(() => t.installer.uninstall('codex'), InstallRefused);
    assert(again.message.includes('has not installed Codex itself'), again.message);
  },
});

Deno.test({
  name: 'uninstall never follows a link out of the agent folder',
  ...sanitize,
  fn: async () => {
    await using t = base();
    makeInstall(t.state, 'codex', '2.6.0', CODEX_PKG);
    const outside = join(t.root, 'not-aib');
    Deno.mkdirSync(outside);
    Deno.writeTextFileSync(join(outside, 'keep.txt'), 'mine');
    const link = join(t.state, 'agents', 'codex', '9.9.9');
    let linked = false;
    try {
      Deno.symlinkSync(outside, link, { type: Deno.build.os === 'windows' ? 'junction' : 'dir' } as Deno.SymlinkOptions);
      linked = true;
    } catch { /* no link support here: the folder-only case still runs */ }
    const view = await t.installer.uninstall('codex');
    assertEquals(view.removed, ['2.6.0']);
    assertEquals(Deno.readTextFileSync(join(outside, 'keep.txt')), 'mine', 'the target of a link is untouched');
    if (linked) assert(Deno.lstatSync(link).isSymlink, 'the link itself is left alone');
  },
});

Deno.test({
  name: 'uninstall is refused while chats are open, a sign-in runs, an install runs, or for an unknown agent',
  ...sanitize,
  fn: async () => {
    await using t = base();
    const [folder] = makeInstall(t.state, 'codex', '2.6.0', CODEX_PKG);
    const one = await assertRejects(() => t.installer.uninstall('codex', 1), InstallRefused);
    assertEquals(one.message, 'Codex has a chat open in AIB. Close it first (wait for any work to finish), then uninstall.');
    const two = await assertRejects(() => t.installer.uninstall('codex', 2), InstallRefused);
    assert(two.message.includes('2 chats open'), two.message);
    const signing = await assertRejects(() => t.installer.uninstall('codex', 0, true), InstallRefused);
    assert(signing.message.includes('sign-in to Codex is running'), signing.message);
    Deno.writeTextFileSync(join(t.state, 'agents', 'codex', installer.LOCK_NAME), JSON.stringify({ pid: Deno.ppid, at: 0 }));
    const busy = await assertRejects(() => t.installer.uninstall('codex'), InstallRefused);
    assert(busy.message.includes('being installed right now'), busy.message);
    Deno.removeSync(join(t.state, 'agents', 'codex', installer.LOCK_NAME));
    await assertRejects(() => t.installer.uninstall('omp'), InstallRefused);
    await assertRejects(() => t.installer.uninstall('../codex'), InstallRefused);
    assert(exists(join(folder, '.complete')), 'nothing was removed by a refusal');
  },
});

Deno.test({
  name: 'the install route: action uninstall counts the open chats of that agent',
  ...sanitize,
  fn: async () => {
    using dir = tempDir();
    const state = join(dir.root, 'state');
    const [folder] = makeInstall(state, 'codex', '2.6.0', CODEX_PKG);
    const studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0 } as never);
    try {
      const chat = { id: 'c1', provider: 'codex', closed: false };
      studio.connections.set('c1', chat as never);
      studio.connections.set('c2', { id: 'c2', provider: 'claude', closed: false } as never);
      const [code, refused] = await studio.installCall('uninstall', 'codex') as [number, Record<string, unknown>];
      assertEquals([code, refused.code], [409, 'install_refused']);
      assert(String(refused.error).includes('Codex has a chat open'), String(refused.error));
      assert(exists(folder));
      chat.closed = true;
      const [ok, done] = await studio.installCall('uninstall', 'codex') as [number, Record<string, unknown>];
      assertEquals([ok, done.ok, done.removed], [200, true, ['2.6.0']]);
      assert(!exists(folder));
      studio.connections.clear();
    } finally {
      await studio.close().catch(() => {});
    }
  },
});
