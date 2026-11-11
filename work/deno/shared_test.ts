/**
 * server/web/shared.ts: builtinLaunch, describeAgents, settingsView, the notices and conversationAction. The cases of
 * work/test_adapters.py, test_settings.py (DescribeTests, LaunchTests), test_studio_install_lookup.py (WebServerAndHostReadFresh),
 * test_agent_signin.py (SettingsListAndGating) and test_conversation_state.py (the conversation_action parts) that need no whole
 * Studio, plus parity of the agent list and notices with studio_shared.py on the same temp fixture.
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { FAKE_SIGNIN, join, makeInstall, PY, PY_REAL, tempDir, touch } from './_agents.ts';
import * as adapters from '../../outputs/agent-studio/server/agents/adapters.ts';
import * as installer from '../../outputs/agent-studio/server/agents/installer.ts';
import * as signin from '../../outputs/agent-studio/server/agents/signin.ts';
import * as shared from '../../outputs/agent-studio/server/web/shared.ts';
import { ConversationState, SettingsStore } from '../../outputs/agent-studio/server/state/store.ts';
import { HostUnavailable } from '../../outputs/agent-studio/server/host/host_client.ts';
import { ValueError } from '../../outputs/agent-studio/server/core/py.ts';

const CLAUDE = '@agentclientprotocol/claude-agent-acp';
const agent = (name = 'Fake agent', extra: Record<string, unknown> = {}) => ({
  name,
  command: PY,
  args: [FAKE_SIGNIN],
  env: [{ name: 'FAKE_TOKEN', value: 'abc' }],
  enabled: true,
  ...extra,
});

/** A temp root whose only global npm folder is `modules`; Codex is not on PATH and shows no signs; the Node.js check is fixed. */
function machine(block: [string, boolean] = ['', true]) {
  const dir = tempDir();
  const modules = join(dir.root, 'global', 'node_modules');
  adapters.resetCache();
  adapters.adapterHooks.globalRoots = () => [modules];
  adapters.adapterHooks.codexOnPath = () => '';
  adapters.adapterHooks.codexPresent = () => false;
  installer.installerHooks.nodeBlock = () => block;
  return {
    root: dir.root,
    state: join(dir.root, 'state'),
    modules,
    [Symbol.dispose]() {
      delete adapters.adapterHooks.globalRoots;
      delete adapters.adapterHooks.codexOnPath;
      delete adapters.adapterHooks.codexPresent;
      delete installer.installerHooks.nodeBlock;
      dir[Symbol.dispose]();
    },
  };
}

// ---- builtinLaunch (test_adapters.test_studio_uses_flag_then_settings_then_installed) ------------------------------------

Deno.test('builtinLaunch uses the flag, then Settings, then the installed adapter', async () => {
  using m = machine();
  const installed = touch(join(m.modules, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'));
  const flag = touch(join(m.root, 'flag.js'));
  const saved = touch(join(m.root, 'saved.js'));
  const options = { ompCommand: '', claudeLauncher: '', nodeCommand: PY, stateDir: m.state };
  const settings = new SettingsStore(m.state);
  assertEquals((await shared.builtinLaunch(options, settings, 'claude')).argv, [PY_REAL, installed]);
  await settings.update({ launchers: { claude: saved } });
  assertEquals((await shared.builtinLaunch(options, settings, 'claude')).argv, [PY_REAL, Deno.realPathSync(saved)]);
  options.claudeLauncher = flag;
  assertEquals((await shared.builtinLaunch(options, settings, 'claude')).argv, [PY_REAL, Deno.realPathSync(flag)]);
  await assertRejects(() => settings.update({ launchers: { claude: 'relative.js' } }), ValueError);
  await assertRejects(() => settings.update({ launchers: { bogus: saved } }), ValueError);
  await settings.update({ launchers: { claude: null } });
  options.claudeLauncher = '';
  assertEquals((await shared.builtinLaunch(options, settings, 'claude')).argv, [PY_REAL, installed]);
  assertEquals((await shared.builtinLaunch(options, null, 'claude')).source, 'installed');
  assertEquals((await shared.builtinLaunch({ ompCommand: PY }, null, 'omp')).argv.slice(1), ['acp']);
  assertEquals((await shared.builtinLaunch({ codexLauncher: flag, nodeCommand: PY }, null, 'codex')).source, 'flag');
});

// ---- describeAgents ------------------------------------------------------------------------------------------------------

Deno.test('the list: built-ins first, status from open chats, found and hidden env (DescribeTests)', async () => {
  using m = machine();
  const store = new SettingsStore(m.root);
  await store.update({ agents: { upsert: agent() } });
  await store.update({ agents: { upsert: agent('Missing one') } });
  const options = { ompCommand: 'nothing-here-xyz', claudeLauncher: join(m.root, 'x.js'), nodeCommand: PY };
  const listed = await shared.describeAgents(options, store, [
    { provider: 'custom-fake-agent', ready: true },
    { provider: 'custom-missing-one', auth: { x: 1 }, ready: false },
    { provider: 'omp', closed: true, ready: true },
  ]);
  const by = Object.fromEntries(listed.map((a) => [a.id, a]));
  assertEquals(listed.slice(0, 3).map((a) => a.id), ['omp', 'claude', 'codex']);
  assert(!by.omp.found && by.omp.problem);
  assert(!by.claude.found);
  assertEquals(by.omp.status, '', 'a closed chat tells nothing');
  assert(by['custom-fake-agent'].found);
  assertEquals([by['custom-fake-agent'].status, by['custom-missing-one'].status], ['running', 'signin']);
  assertEquals(by['custom-fake-agent'].env, [{ name: 'FAKE_TOKEN', set: true }]);
  assert(by.omp.builtin && !by['custom-fake-agent'].builtin);
});

Deno.test('Codex shows not installed when missing', async () => {
  using m = machine();
  const options = { ompCommand: '', claudeLauncher: '', nodeCommand: PY, stateDir: m.state };
  const listed = Object.fromEntries((await shared.describeAgents(options, new SettingsStore(m.state))).map((a) => [a.id, a]));
  const codex = listed.codex;
  assert(codex.builtin && !codex.found);
  assertEquals([codex.launcherSource, codex.launcher], ['missing', 'Not installed']);
  assert(String(codex.problem).startsWith('Not installed.'));
  assertEquals([codex.installable, codex.installBlock, codex.installHint, codex.install, codex.signin], [true, '', '', null, null]);
  assert(Number(codex.packageBytes) > 0, 'the size comes from the shipped allow-list');
});

Deno.test('Node.js missing: the block line on missing agents and the npm hint for Codex', async () => {
  using m = machine(['Node.js 22 or newer is needed to install this agent.', false]);
  const listed = Object.fromEntries((await shared.describeAgents({ stateDir: m.state }, new SettingsStore(m.state))).map((a) => [a.id, a]));
  assertEquals(listed.claude.installBlock, 'Node.js 22 or newer is needed to install this agent.');
  assertEquals(listed.codex.installHint, 'Or install it yourself with: npm i -g @agentclientprotocol/codex-acp');
  assertEquals([listed.omp.installBlock, listed.omp.installable], ['', false]);
});

Deno.test('a new install is seen by the next lookup with no restart (WebServerAndHostReadFresh)', async () => {
  using m = machine();
  const options = { stateDir: m.state, nodeCommand: PY, claudeLauncher: '', codexLauncher: '', ompCommand: '' };
  const settings = new SettingsStore(join(m.root, 'settings-state'));
  const claudeRow = async () => (await shared.describeAgents(options, settings)).find((a) => a.id === 'claude')!;
  const first = await claudeRow();
  assertEquals([first.found, first.launcherSource], [false, 'missing']);
  makeInstall(m.state, 'claude', '0.102.0', CLAUDE);
  const again = await claudeRow();
  assertEquals([again.found, again.launcherSource], [true, 'studio']);
  assertEquals((await shared.builtinLaunch(options, settings, 'claude')).source, 'studio');
  assertEquals(again.signin, { state: 'unknown', checkedAt: 0, job: null }, 'found: the sign-in column, from the cache only');
  Deno.removeSync(join(m.state, 'agents'), { recursive: true });
  assert(!(await shared.builtinLaunch(options, settings, 'claude')).found);
});

Deno.test('describeAgents reads only the cache and the job files, and never runs the agent', async () => {
  using m = machine();
  makeInstall(m.state, 'claude', '0.102.0', CLAUDE);
  const log = join(m.root, 'fake.log');
  Deno.env.set('FAKE_SIGNIN_LOG', log);
  try {
    const options = { stateDir: m.state, nodeCommand: PY };
    const settings = new SettingsStore(m.state);
    let rows = Object.fromEntries((await shared.describeAgents(options, settings, [])).map((a) => [a.id, a]));
    assertEquals((rows.claude.signin as shared.SigninView).state, 'unknown');
    assertEquals(rows.omp.signin, null);
    const folder = join(m.state, 'agents', 'claude');
    installer.writeJson(join(folder, signin.CACHE_NAME), { state: 'signin', checkedAt: 7 });
    installer.writeJson(join(folder, signin.JOB_NAME), { state: 'manual', message: 'Run this', command: 'x', pid: Deno.pid, updatedAt: 1 });
    installer.writeJson(join(folder, installer.STATE_NAME), {
      state: 'failed',
      stage: '',
      percent: 10,
      message: 'The disk is full.',
      version: '0.103.0',
      pid: 1,
    });
    rows = Object.fromEntries(
      (await shared.describeAgents(options, settings, [{ provider: 'claude', ready: true }])).map((a) => [a.id, a]),
    );
    assertEquals(rows.claude.signin, {
      state: 'ready',
      checkedAt: 7,
      job: { agent: 'claude', state: 'manual', message: 'Run this', command: 'x' },
    });
    assertEquals((rows.claude.install as installer.InstallView).message, 'The disk is full.');
    assertEquals(rows.claude.status, 'running');
    let exists = true;
    try {
      Deno.statSync(log);
    } catch {
      exists = false;
    }
    assert(!exists, 'no agent process was started');
  } finally {
    Deno.env.delete('FAKE_SIGNIN_LOG');
  }
});

Deno.test('the agent list matches Python on the same fixture', async () => {
  await using py = new PyParity();
  using m = machine();
  const settingsDir = join(m.root, 'settings');
  const store = new SettingsStore(settingsDir);
  await store.update({ agents: { upsert: agent() } });
  await store.update({ agents: { upsert: agent('Off one', { enabled: false }) } });
  await store.update({ agents: { enabled: { codex: false } } });
  const flag = touch(join(m.root, 'flag.js'));
  makeInstall(m.state, 'claude', '0.102.0', CLAUDE);
  touch(join(m.modules, '@zed-industries', 'codex-acp', 'bin', 'codex-acp.js'));
  installer.writeJson(join(m.state, 'agents', 'codex', installer.STATE_NAME), {
    state: 'running',
    stage: 'downloading',
    percent: 20,
    message: '',
    version: '2.6.0',
    pid: Deno.pid,
  });
  installer.writeJson(join(m.state, 'agents', 'claude', signin.CACHE_NAME), { state: 'ready', checkedAt: 123.5 });
  const connections = [{ provider: 'claude', auth: true }, { provider: 'custom-fake-agent', ready: true }, {
    provider: 'codex',
    ready: true,
    closed: true,
  }];
  const cases: [Record<string, string>, [string, boolean]][] = [
    [{ node_command: PY, omp_command: PY, claude_launcher: '', codex_launcher: '' }, ['', true]],
    [{ node_command: PY, omp_command: 'nothing-here-xyz', claude_launcher: flag, codex_launcher: join(m.root, 'gone.js') }, ['', true]],
    [{ node_command: 'no-node-xyz', omp_command: '', claude_launcher: '', codex_launcher: '' }, [
      'Node.js 22 or newer is needed to install this agent.',
      false,
    ]],
  ];
  for (const [opts, block] of cases) {
    installer.installerHooks.nodeBlock = () => block;
    const options = {
      stateDir: m.state,
      nodeCommand: opts.node_command,
      ompCommand: opts.omp_command,
      claudeLauncher: opts.claude_launcher,
      codexLauncher: opts.codex_launcher,
    };
    const mine = await shared.describeAgents(options, new SettingsStore(settingsDir), connections);
    const theirs = await py.call('agents_shim', 'describe', [m.state, settingsDir, opts, connections, [m.modules], '', false, block]);
    assertEquals(mine, theirs, JSON.stringify(opts));
  }
});

// ---- settingsView and the notices ----------------------------------------------------------------------------------------

function context(root: string, overrides: Partial<shared.StudioContext> = {}): shared.StudioContext {
  return {
    options: { stateDir: root, nodeCommand: PY },
    settings: new SettingsStore(root),
    conversations: new ConversationState(root),
    liveList: () => ({ connections: [] }),
    liveCall: () => [200, {}],
    studioOwns: () => false,
    findWorktree: () => null,
    ...overrides,
  };
}

Deno.test('settingsView: the stored settings, the list and the notices; an unreachable host lists no chats', async () => {
  using m = machine();
  const ctx = context(m.state, {
    liveList: () => {
      throw new HostUnavailable('The agent host is not running.', 'host_unreachable');
    },
    waitingChats: 2,
  });
  const view = await shared.settingsView(ctx);
  assertEquals((view.agents as { id: string }[]).map((a) => a.id), ['omp', 'claude', 'codex']);
  assert(typeof view.revision === 'string' && 'settings' in view && 'warning' in view);
  assertEquals(view.migration, { state: 'none' });
  assertEquals(view.hostTakeoverWaiting, 2);
  assertEquals([view.hostCodeWarning, view.sandboxNotice], ['', '']);
  assert('packageContext' in view && 'packageNotice' in view);
  const live = await shared.settingsView(
    context(m.state, { liveList: () => Promise.resolve({ connections: [{ provider: 'codex', auth: {} }] }) }),
  );
  assertEquals((live.agents as { id: string; status: string }[]).find((a) => a.id === 'codex')!.status, 'signin');
  await assertRejects(
    () => shared.settingsView(context(m.state, { liveList: () => Promise.reject(new SyntaxError('a bug')) })),
    SyntaxError,
  );
});

Deno.test('the notice lines match Python', async () => {
  await using py = new PyParity();
  for (const pkg of [null, '', 'Claude_pzs8sxrjxfjjc', 'Other']) {
    assertEquals(shared.packageNotice(pkg, 'C:\\state'), await py.call('studio_shared', 'package_notice', [pkg, 'C:\\state']));
  }
  const migrations = [
    null,
    {},
    { kind: 'local', state: 'waiting' },
    { kind: 'sandbox', state: 'none' },
    { kind: 'sandbox', state: 'done' },
    { kind: 'sandbox', state: 'done', worktreesLeft: 1, source: 'C:\\old' },
    { kind: 'sandbox', state: 'done', worktreesLeft: 3, source: 'C:\\old' },
    { kind: 'sandbox', state: 'conflict', source: 'C:\\pkg' },
    { kind: 'sandbox', state: 'conflict' },
    { kind: 'sandbox', state: 'waiting', reason: 'a chat is working' },
    { kind: 'sandbox', state: 'waiting' },
    { kind: 'sandbox', state: 'refused', reason: 'no space' },
    { kind: 'sandbox', state: 'failed' },
  ];
  for (const m of migrations) {
    assertEquals(shared.sandboxNotice(m), await py.call('studio_shared', 'sandbox_notice', [m]), JSON.stringify(m));
  }
  const notices = await shared.notices({ options: { stateDir: 'x', migration: { kind: 'sandbox', state: 'conflict' } }, hostInfo: null });
  assertEquals(notices.migration, { kind: 'sandbox', state: 'conflict' });
  assert(String(notices.sandboxNotice).startsWith('AIB data exists in two places'));
  assertEquals(notices.hostTakeoverWaiting, 0);
});

// ---- conversationAction (test_conversation_state.RouteTests / SessionDeleteGatingTests, the action itself) ---------------

Deno.test('pin, archive, delete and restore round-trip and survive a new store', async () => {
  using dir = tempDir();
  const ctx = context(dir.root);
  let [status, body] = await shared.conversationAction(ctx, { action: 'pin', provider: 'claude', sessionId: 's1' });
  assertEquals(status, 200);
  assert((body.entry as { pinnedAt: number }).pinnedAt > 0);
  assertEquals(body.ok, true);
  assertEquals(body.revision, ctx.conversations.revision());
  assertEquals((await shared.conversationAction(ctx, { action: 'archive', provider: 'omp', sessionId: 's2' }))[0], 200);
  assertEquals(
    (await shared.conversationAction(ctx, { action: 'delete', provider: 'claude', sessionId: 's3', title: 'Gone', cwd: 'C:\\w' }))[0],
    200,
  );
  const entries = new ConversationState(dir.root).public().entries;
  assertEquals(Object.keys(entries).sort(), ['claude:s1', 'claude:s3', 'omp:s2']);
  assertEquals(entries['claude:s3'].title, 'Gone');
  [status, body] = await shared.conversationAction(ctx, { action: 'restore', provider: 'claude', sessionId: 's3' });
  assertEquals([status, body.entry], [200, null]);
});

Deno.test('invalid requests are a ValueError; odd but valid input is stored as data only', async () => {
  using dir = tempDir();
  const ctx = context(dir.root);
  const bad: unknown[] = [
    {},
    { action: 'explode', provider: 'claude', sessionId: 's' },
    { action: 'pin', provider: 'x', sessionId: 's' },
    { action: 'pin', provider: 'claude' },
    { action: 'pin', provider: 'claude', sessionId: 7 },
    { action: 'pin', provider: 'claude', sessionId: 's'.repeat(600) },
    { action: 'restore', provider: ['claude'], sessionId: 's' },
    [1, 2],
    null,
  ];
  for (const body of bad) await assertRejects(() => shared.conversationAction(ctx, body), ValueError);
  assertEquals(Object.keys(new ConversationState(dir.root).public().entries), []);
  const [status, payload] = await shared.conversationAction(ctx, {
    action: 'delete',
    provider: 'claude',
    sessionId: 's',
    title: ['x'],
    cwd: 5,
  });
  assertEquals(status, 200);
  assertEquals([(payload.entry as { title: string }).title, (payload.entry as { cwd: string }).cwd], ['', '']);
});

Deno.test('a Studio delete of a live conversation is refused until it is ended; archive is allowed', async () => {
  using dir = tempDir();
  let live = true;
  const ctx = context(dir.root, {
    studioOwns: (provider, sessionId) => Promise.resolve(live && provider === 'omp' && sessionId === 'live-1'),
  });
  const body = { action: 'delete', provider: 'omp', sessionId: 'live-1' };
  const [status, payload] = await shared.conversationAction(ctx, body);
  assertEquals([status, payload.code], [409, 'session_live']);
  assertEquals(payload.error, 'This conversation is live in AIB. End the AIB session first; nothing was deleted.');
  assertEquals(Object.keys(new ConversationState(dir.root).public().entries), []);
  assertEquals((await shared.conversationAction(ctx, { ...body, action: 'archive' }))[0], 200);
  live = false;
  assertEquals((await shared.conversationAction(ctx, body))[0], 200);
});

Deno.test('archiving a chat in its own worktree asks the host to remove it; other chats call nothing; a failure never fails the action', async () => {
  using dir = tempDir();
  const calls: [string, unknown][] = [];
  const asked: string[] = [];
  let answer: [number, unknown] = [200, { worktree: { removed: true, path: 'C:\\wt' } }];
  const ctx = context(dir.root, {
    findWorktree: (session) => (asked.push(session), session === 'claude:wt-1' ? { path: 'C:\\wt' } : null),
    liveCall: (name, args) => (calls.push([name, args]), answer),
  });
  let [, payload] = await shared.conversationAction(ctx, { action: 'archive', provider: 'claude', sessionId: 'wt-1' });
  assertEquals(payload.worktree, { removed: true, path: 'C:\\wt' });
  assertEquals(calls, [['worktree-archive', { provider: 'claude', sessionId: 'wt-1' }]]);
  [, payload] = await shared.conversationAction(ctx, { action: 'archive', provider: 'claude', sessionId: 'plain' });
  assert(!('worktree' in payload));
  assertEquals(calls.length, 1, 'nothing is called for a chat without a worktree');
  [, payload] = await shared.conversationAction(ctx, { action: 'pin', provider: 'claude', sessionId: 'other' });
  assertEquals(asked, ['claude:wt-1', 'claude:plain'], 'only archive and delete look for a worktree');
  answer = [503, { error: 'host down' }];
  [, payload] = await shared.conversationAction(ctx, { action: 'delete', provider: 'claude', sessionId: 'wt-1' });
  assert(!('worktree' in payload));
  const error = console.error;
  console.error = () => {};
  try {
    const failing = context(dir.root, {
      findWorktree: () => ({ path: 'x' }),
      liveCall: () => {
        throw new HostUnavailable('gone', 'host_unreachable');
      },
    });
    const [status, body] = await shared.conversationAction(failing, { action: 'archive', provider: 'codex', sessionId: 'z' });
    assertEquals([status, 'worktree' in body], [200, false]);
  } finally {
    console.error = error;
  }
  // the default lookup is the worktrees registry of the state folder: no record, nothing called
  const plain = context(dir.root, { liveCall: (name, args) => (calls.push([name, args]), answer) });
  delete plain.findWorktree;
  await shared.conversationAction(plain, { action: 'archive', provider: 'omp', sessionId: 'no-wt' });
  assertEquals(calls.length, 2);
});
