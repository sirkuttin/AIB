/**
 * Settings > AIB Linking (WSL), phase 2, the Windows server side (docs/wsl/linking-design.md section 12, "Routes"), with no distro:
 *   1. The per-distro On/Off switch: settings `agentsByDistro` (on when unset, kept apart from the Windows switch, public), POST
 *      /api/live/wsl/agents/enabled, and Studio's WSL launch reading only it (the matrix: Windows off + Ubuntu on starts in Ubuntu;
 *      Windows on + Ubuntu off refuses only the WSL chat, for a new chat and a Continue, never the automatic reconnect).
 *   2. GET /api/live/wsl/agents rows: enabled, signin (helper agents.signinStatus, 'unknown' when it cannot say), canUninstall (AIB's
 *      own install only), the Codex row's limits (the chip's snapshot from the distro's ~/.codex; null when none).
 *   3. POST /api/live/wsl/agents/uninstall: refused while the install job or the sign-in runs, helper refusals verbatim, never a start.
 *   4. GET /api/live/wsl/prereqs: peek never starts a distro, start=1 does, the two shapes.
 *   5. The Node.js terminal (setup=wsl-node): refused unless canInstallNode, the steps, PROFILE by login shell, fail closed without a
 *      checksum; the nvm tag and checksum are single-sourced (agents/nvm.ts).
 * FakeWslHost (work/deno/_wsl_fake.ts) answers the three phase 2 helper methods from this file's own handlers (the helper builder's
 * real methods are tested on the Linux side). Temp folders only; nothing runs nvm, node, npm or an agent.
 */
import { assert, assertEquals } from './_assert.ts';
import { FakeWslHost } from './_wsl_fake.ts';
import { setDistroSource, setWslHostResolver } from '../../app/server/wsl/access.ts';
import { wslRoutes } from '../../app/server/web/wsl_routes.ts';
import { wslNodeSetupCommand } from '../../app/server/web/terminal_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';
import { SettingsStore } from '../../app/server/state/settings.ts';
import { Aib, wslAgentOffLine } from '../../app/server/host/aib.ts';
import type { EnvPrereqs } from '../../app/server/wsl/contract.ts';
import { WslHelperError } from '../../app/server/wsl/contract.ts';
import { NODE_INSTALL, resetInstallProgress } from '../../app/server/wsl/agent_install.ts';
import { PREREQS } from '../../app/server/agents/beta_setup.ts';
import {
  NVM_INSTALL_SHA256,
  NVM_INSTALL_URL,
  NVM_NOT_PINNED,
  NVM_VERSION,
  nvmInstallLine,
} from '../../app/server/agents/nvm.ts';
import { profileFor, wslNodeCommand, wslNodeScript, wslNodeSteps } from '../../app/server/wsl/node_setup.ts';

type Json = Record<string, unknown>;
const T = { sanitizeResources: false, sanitizeOps: false };
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const TEST_ROOT = '/tmp/aib-wsl-test-linking-routes';
Deno.env.set('AGENT_STUDIO_TEST', '1');
Deno.env.set('AIB_WSL_ROOT', TEST_ROOT);

/** A host the way wsl/hosts.ts makes it before anything asked it to start (`begun` false), counting every start(). */
class CountingHost extends FakeWslHost {
  starts = 0;
  begun = false;
  override start(): Promise<void> {
    this.starts++;
    this.begun = true;
    this.state = 'ready';
    this.note = '';
    return Promise.resolve();
  }
}

function withHost(host: FakeWslHost | null): void {
  setWslHostResolver((d) => (host && d === host.distro.toLowerCase() ? host : null));
  setDistroSource(() => Promise.resolve([{ name: 'Ubuntu', version: 2, isDefault: true }]));
}

function tempDir(): string {
  return Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-wsl-linking-routes-' }));
}

const PREREQS_OK: EnvPrereqs = {
  node: { state: 'missing', manager: '' },
  npm: { state: 'missing' },
  git: { state: 'ok', version: '2.43.0' },
  curl: { state: 'ok' },
  diskFreeMB: 20480,
  arch: 'x86_64',
  loginShell: '/usr/bin/zsh',
  envMode: 'login-interactive',
  nvm: { present: false },
  canInstallNode: true,
};

const RATE = {
  limit_id: 'codex',
  primary: { used_percent: 12.0, window_minutes: 300, resets_at: 1794388969 },
  secondary: { used_percent: 48.0, window_minutes: 10080, resets_at: 1794613768 },
  plan_type: 'plus',
};

/** The three phase 2 helper methods, as simple stand-ins (the real ones are the helper builder's, on the Linux side). */
function phase2Helper(host: FakeWslHost, prereqs: EnvPrereqs = PREREQS_OK): void {
  host.handlers['env.prereqs'] = () => structuredClone(prereqs);
  host.handlers['agents.signinStatus'] = (p) => ({
    agents: ((p.ids as string[]) ?? []).map((id) =>
      id === 'claude'
        ? { id, state: 'signed_in', account: 'u@example.com' }
        : id === 'codex'
        ? { id, state: 'signed_out' }
        : { id, state: 'unknown' }
    ),
  });
  host.handlers['agents.uninstall'] = (p) => ({ ok: true, removed: [`${TEST_ROOT}/agents/${p.id}/0.0.1`] });
  host.handlers['agents.detect'] = () => ({
    agents: [
      {
        id: 'claude',
        found: true,
        command: ['node', '/r/agents/claude/0.102.0/x.js'],
        version: '0.102.0',
        source: 'studio',
        bundledCli: true,
      },
      { id: 'codex', found: true, command: ['codex-acp'], version: '2.6.0', source: 'global', bundledCli: true },
    ],
  });
}

function ctxOf(settings: SettingsStore | undefined, terminals: { key: string }[] = []): WebContext {
  return { token: 't', stateDir: null, settings, terminals: { list: () => terminals } } as unknown as WebContext;
}

async function route(
  ctx: WebContext,
  method: 'GET' | 'POST',
  path: string,
  query = '',
  body: Json | null = null,
  token = 't',
): Promise<[number, Json]> {
  const handler = wslRoutes().get(`${method} ${path}`)!;
  assert(handler, `${method} ${path} is a route`);
  const url = new URL(`http://127.0.0.1${path}${query ? '?' + query : ''}`);
  const [status, out] = await handler(ctx, url, body, new Request(url, { headers: { 'X-Studio-Token': token } }));
  return [status, out as Json];
}

// ---- 1. the per-distro switch -----------------------------------------------------------------------------------------------------

Deno.test('settings agentsByDistro: on when unset, per distro, apart from the Windows switch, cleaned, public, kept on reload', async () => {
  const dir = tempDir();
  try {
    const store = new SettingsStore(dir);
    assertEquals([store.distroAgentEnabled('ubuntu', 'claude'), store.distroAgents()], [true, {}]);
    assert(!('agentsByDistro' in (store.public().settings as Json)), 'a fresh store has no key');
    await store.update({ agentsByDistro: { ubuntu: { claude: false, codex: true } } });
    await store.update({ agents: { builtin: { claude: true } } });
    assertEquals([store.distroAgentEnabled('ubuntu', 'claude'), store.distroAgentEnabled('UBUNTU', 'claude')], [false, false]);
    assertEquals(
      [store.distroAgentEnabled('debian', 'claude'), store.builtinEnabled('claude')],
      [true, true],
      'other distros and Windows untouched',
    );
    assertEquals((store.public().settings as Json).agentsByDistro, { ubuntu: { claude: false, codex: true } });
    assertEquals(new SettingsStore(dir).distroAgents(), { ubuntu: { claude: false, codex: true } }, 'saved');
    // null forgets the value (on again); the last one gone drops the key
    await store.update({ agentsByDistro: { ubuntu: { claude: null, codex: null } } });
    assert(!('agentsByDistro' in (store.public().settings as Json)));
    for (
      const bad of [{ 'Bad Distro': { claude: false } }, { ubuntu: { 'not-an-agent': false } }, { ubuntu: { claude: 'off' } }, {
        ubuntu: 'x',
      }]
    ) {
      let refused = false;
      await store.update({ agentsByDistro: bad }).catch(() => (refused = true));
      assert(refused, `refused: ${JSON.stringify(bad)}`);
    }
    // a hand-edited file keeps only valid entries
    assertEquals(
      SettingsStore.cleanDoc({
        agentsByDistro: { ubuntu: { claude: false, junk: true, codex: 'x' }, 'BAD KEY': { claude: false }, debian: {} },
      }).agentsByDistro,
      { ubuntu: { claude: false } },
    );
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('POST /api/live/wsl/agents/enabled: {ok, enabled}, validated, needs the token, stored per distro', T, async () => {
  const dir = tempDir();
  try {
    const settings = new SettingsStore(dir);
    const ctx = ctxOf(settings);
    const post = (body: Json, token = 't') => route(ctx, 'POST', '/api/live/wsl/agents/enabled', '', body, token);
    assertEquals(await post({ distro: 'Ubuntu', id: 'claude', enabled: false }), [200, { ok: true, enabled: false }]);
    assertEquals(settings.distroAgents(), { ubuntu: { claude: false } });
    assertEquals(settings.builtinEnabled('claude'), true, 'the Windows switch is untouched');
    assertEquals(await post({ distro: 'ubuntu', id: 'claude', enabled: true }), [200, { ok: true, enabled: true }]);
    assertEquals((await post({ distro: 'ubuntu', id: 'claude', enabled: false }, 'wrong'))[0], 403);
    assertEquals((await post({ distro: 'bad distro', id: 'claude', enabled: false }))[1].code, 'bad_distro');
    assertEquals((await post({ distro: 'ubuntu', id: 'nope', enabled: false }))[1].code, 'bad_agent');
    assertEquals((await post({ distro: 'ubuntu', id: 'claude', enabled: 'no' }))[1].code, 'bad_enabled');
    assertEquals(await post({ distro: 'ubuntu', id: 'custom-gone', enabled: false }), [404, {
      error: 'That agent is not in the list',
      code: 'bad_agent',
    }]);
    assertEquals(await post({ distro: 'ubuntu', id: 'gemini', enabled: false }), [200, { ok: true, enabled: false }], 'Beta agents too');
    assertEquals(settings.distroAgents(), { ubuntu: { claude: true, gemini: false } });
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test({
  name:
    'the switch matrix: Windows off + Ubuntu on starts in Ubuntu; Windows on + Ubuntu off refuses only the WSL chat (new, Continue; not the reconnect)',
  ...T,
  async fn() {
    const dir = tempDir();
    const host = new FakeWslHost(dir + SEP + 'linux-keeper', 'Ubuntu');
    host.handlers['agents.detect'] = (p) => ({
      agents: ((p.ids as string[]) ?? []).map((id) => ({ id, found: true, command: [id === 'claude' ? '/usr/bin/claude-acp' : 'node', 'acp'] })),
    });
    withHost(host);
    const studio = new Aib({ claudeLauncher: import.meta.filename!, nodeCommand: 'node', stateDir: dir + SEP + 'state', port: 0, ownersDir: null });
    const wsl = { distro: 'ubuntu', linuxPath: '/home/u/app' };
    try {
      // Windows off, Ubuntu on (unset): the Windows chat is refused, the WSL chat starts in Ubuntu
      await studio.settings.update({ agents: { builtin: { claude: false } } });
      let windows = '';
      await studio.agentLaunch('claude', true).catch((e) => (windows = e.message));
      assertEquals(windows, 'Claude Code is turned off in Settings');
      const launched = await studio.wslLaunch('claude', wsl, true);
      assertEquals(launched.command, ['/usr/bin/claude-acp', 'acp']);
      // Windows on, Ubuntu off: Windows starts, the WSL chat is refused with the distro's line, before the distro is even asked
      await studio.settings.update({ agents: { builtin: { claude: true } }, agentsByDistro: { ubuntu: { claude: false } } });
      assertEquals((await studio.agentLaunch('claude', true))[0].at(-1), Deno.realPathSync(import.meta.filename!));
      const line = 'Claude Code is turned off for Ubuntu in Settings > AIB Linking (WSL)';
      host.calls.length = 0;
      for (const [fresh, continued] of [[true, false], [false, true]]) {
        let refused = '';
        await studio.wslLaunch('claude', wsl, fresh, continued).catch((e) => (refused = e.message));
        assertEquals(refused, line, `fresh ${fresh}, continued ${continued}`);
      }
      assertEquals(host.calls.length, 0, 'refused before the distro was asked anything');
      // the automatic reconnect at start (neither) is not refused: a running chat is never cut off by the switch
      assertEquals((await studio.wslLaunch('claude', wsl, false, false)).command, ['/usr/bin/claude-acp', 'acp']);
      // connect() itself: a new WSL chat and the person's Continue are refused with the same line
      for (const resume of [null, 'sess-1']) {
        let refused = '';
        await studio.connect('claude', 'wsl://ubuntu/home/u/app', resume).catch((e) => (refused = e.message));
        assertEquals(refused, line, `connect resume=${resume}`);
      }
      // another distro with no saved value is on
      assertEquals(studio.settings.distroAgentEnabled('debian', 'claude'), true);
      // a custom agent's own name in the line
      assertEquals(
        wslAgentOffLine('custom-x', 'Ubuntu', { customAgent: () => ({ name: 'My agent' }) }),
        'My agent is turned off for Ubuntu in Settings > AIB Linking (WSL)',
      );
      assertEquals(
        wslAgentOffLine('gemini', 'Debian', { customAgent: () => null }),
        'Gemini CLI is turned off for Debian in Settings > AIB Linking (WSL)',
      );
    } finally {
      await studio.close().catch(() => {});
      setWslHostResolver(null);
      setDistroSource(null);
      try {
        Deno.removeSync(dir, { recursive: true });
      } catch { /* a keeper file still held: the OS temp cleanup takes it */ }
    }
  },
});

// ---- 2. agents rows ---------------------------------------------------------------------------------------------------------------

Deno.test(
  "GET /api/live/wsl/agents rows: enabled per distro, signin, canUninstall only for AIB's own install, Codex limits",
  T,
  async () => {
    const dir = tempDir();
    const host = new FakeWslHost('unused', 'Ubuntu');
    phase2Helper(host);
    host.handlers['codex.limits'] = () => ({ found: { rateLimits: RATE, at: 1794380000 } });
    withHost(host);
    try {
      const settings = new SettingsStore(dir);
      await settings.update({ agentsByDistro: { ubuntu: { codex: false } }, agents: { builtin: { claude: false } } });
      const [status, body] = await route(ctxOf(settings), 'GET', '/api/live/wsl/agents', 'distro=Ubuntu&peek=1');
      assertEquals([status, body.state, body.line], [200, 'ready', '']);
      const rows = Object.fromEntries((body.agents as Json[]).map((r) => [r.id, r]));
      assertEquals(
        [rows.claude.enabled, rows.codex.enabled],
        [true, false],
        'the distro switch, not the Windows one',
      );
      assertEquals(rows.claude.signin, { state: 'signed_in', account: 'u@example.com' });
      assertEquals([rows.codex.signin], [{ state: 'signed_out' }]);
      assertEquals([rows.claude.canUninstall, rows.codex.canUninstall], [true, false]);
      const limits = rows.codex.limits as Json;
      assertEquals([limits.agent, limits.source, (limits.windows as Json[]).length], ['codex', 'codex-rollout', 2]);
      assert(!('limits' in rows.claude), 'limits only on the Codex row');
      assertEquals(
        host.calls.find(([m]) => m === 'codex.limits'),
        ['codex.limits', { codexDir: TEST_ROOT + '/home/.codex' }],
        'under test, the temp home',
      );
      // no numbers: null; the agent picker (no peek) gets the same fields
      host.handlers['codex.limits'] = () => ({ found: null });
      const [, picker] = await route(ctxOf(settings), 'GET', '/api/live/wsl/agents', 'distro=ubuntu');
      const codex = (picker.agents as Json[]).find((r) => r.id === 'codex')!;
      assertEquals([codex.limits, codex.enabled, 'state' in picker], [null, false, false]);
      // an older helper without agents.signinStatus: 'unknown' with the reason, the rest still answered
      delete host.handlers['agents.signinStatus'];
      const [, old] = await route(ctxOf(settings), 'GET', '/api/live/wsl/agents', 'distro=ubuntu&peek=1');
      assertEquals((old.agents as Json[])[0].signin, {
        state: 'unknown',
        note: 'The AIB helper in Ubuntu cannot check sign-ins yet. Restart AIB.',
      });
    } finally {
      setWslHostResolver(null);
      setDistroSource(null);
      Deno.removeSync(dir, { recursive: true });
    }
  },
);

// ---- 3. uninstall -----------------------------------------------------------------------------------------------------------------

Deno.test(
  'POST /api/live/wsl/agents/uninstall: the helper result; refused while the install or sign-in runs; helper refusals verbatim; never a start',
  T,
  async () => {
    const host = new CountingHost('unused', 'Ubuntu');
    phase2Helper(host);
    withHost(host);
    resetInstallProgress();
    const post = (body: Json, terminals: { key: string }[] = []) =>
      route(ctxOf(undefined, terminals), 'POST', '/api/live/wsl/agents/uninstall', '', body);
    try {
      // a distro AIB has not started: refused, not started
      assertEquals(await post({ distro: 'Ubuntu', id: 'claude' }), [409, { error: 'Ubuntu is not running.', code: 'wsl_unavailable' }]);
      assertEquals([host.starts, host.calls.length], [0, 0]);
      host.begun = true;
      assertEquals(await post({ distro: 'ubuntu', id: 'claude' }), [200, { ok: true, removed: [`${TEST_ROOT}/agents/claude/0.0.1`] }]);
      assertEquals(host.calls.at(-1), ['agents.uninstall', { id: 'claude' }]);
      assertEquals((await post({ distro: 'ubuntu', id: 'omp' }))[0], 400, 'only what AIB installs');
      // the install job runs (the same job state the install routes read)
      host.handlers['agents.installStatus'] = (p) => ({ agent: p.agent, state: 'running', stage: 'npm', percent: 40, message: '' });
      const n = host.calls.length;
      assertEquals(await post({ distro: 'ubuntu', id: 'codex' }), [200, {
        ok: false,
        removed: [],
        blocked: 'Codex is being installed in Ubuntu right now. Wait for it to finish, or cancel it, then uninstall.',
      }]);
      assert(!host.calls.slice(n).some(([m]) => m === 'agents.uninstall'), 'the helper was not asked to uninstall');
      host.handlers['agents.installStatus'] = (p) => ({ agent: p.agent, state: 'idle', stage: '', percent: 0, message: '' });
      // its sign-in terminal runs
      assertEquals(
        (await post({ distro: 'ubuntu', id: 'codex' }, [{ key: 'signin:codex@ubuntu' }]))[1].blocked,
        'A sign-in to Codex in Ubuntu is running. Finish or cancel it, then uninstall.',
      );
      // the helper's refusals, answered or thrown, verbatim
      host.handlers['agents.uninstall'] = () => ({ ok: false, removed: [], blocked: 'A chat runs Codex from this folder (pid 4242).' });
      assertEquals(await post({ distro: 'ubuntu', id: 'codex' }), [200, {
        ok: false,
        removed: [],
        blocked: 'A chat runs Codex from this folder (pid 4242).',
      }]);
      host.handlers['agents.uninstall'] = () => {
        throw new WslHelperError('AIB has not installed Codex in Ubuntu, so there is nothing to uninstall.', 'uninstall_refused');
      };
      assertEquals(
        (await post({ distro: 'ubuntu', id: 'codex' }))[1].blocked,
        'AIB has not installed Codex in Ubuntu, so there is nothing to uninstall.',
      );
      delete host.handlers['agents.uninstall'];
      assertEquals((await post({ distro: 'ubuntu', id: 'codex' }))[1].code, 'install_refused', 'an older helper: too old');
      assertEquals(host.starts, 0, 'nothing started the distro');
    } finally {
      setWslHostResolver(null);
      setDistroSource(null);
    }
  },
);

// ---- 4. prereqs -------------------------------------------------------------------------------------------------------------------

Deno.test(
  'GET /api/live/wsl/prereqs: peek never starts the distro (state and line), start=1 does, the ready shape, force passed on',
  T,
  async () => {
    const host = new CountingHost('unused', 'Ubuntu');
    phase2Helper(host);
    host.state = 'starting';
    withHost(host);
    const get = (q: string) => route(ctxOf(undefined), 'GET', '/api/live/wsl/prereqs', q);
    try {
      assertEquals(await get('distro=Ubuntu&peek=1'), [200, { distro: 'ubuntu', name: 'Ubuntu', state: 'off', line: '', prereqs: null }]);
      assertEquals(await get('distro=ubuntu&peek=1&force=1'), [200, {
        distro: 'ubuntu',
        name: 'Ubuntu',
        state: 'off',
        line: '',
        prereqs: null,
      }]);
      assertEquals([host.starts, host.calls.length], [0, 0]);
      host.begun = true;
      host.state = 'stopped';
      host.note = 'Ubuntu stopped (Windows restart or `wsl --shutdown`).';
      assertEquals(await get('distro=ubuntu&peek=1'), [200, {
        distro: 'ubuntu',
        name: 'Ubuntu',
        state: 'stopped',
        line: 'Ubuntu stopped (Windows restart or `wsl --shutdown`).',
        prereqs: null,
      }]);
      assertEquals(host.starts, 0);
      assertEquals(await get('distro=ubuntu&peek=1&start=1&force=1'), [200, {
        distro: 'ubuntu',
        name: 'Ubuntu',
        state: 'ready',
        line: '',
        prereqs: PREREQS_OK,
      }]);
      assertEquals([host.starts, host.calls.at(-1)], [1, ['env.prereqs', { force: true }]]);
      assertEquals((await get('distro=ubuntu&peek=1'))[1].prereqs, PREREQS_OK);
      assertEquals(host.calls.at(-1), ['env.prereqs', { force: false }]);
      assertEquals((await get('distro=no%20such'))[1].code, 'bad_distro');
    } finally {
      setWslHostResolver(null);
      setDistroSource(null);
    }
  },
);

Deno.test(
  'GET /api/live/wsl/agents/install: a status read never starts the distro (no job, with its state and line); start=1 does',
  T,
  async () => {
    const host = new CountingHost('unused', 'Ubuntu');
    phase2Helper(host);
    host.handlers['agents.installStatus'] = (p) => ({ state: 'idle', agent: p.agent });
    host.state = 'starting';
    withHost(host);
    const get = (q: string) => route(ctxOf(undefined), 'GET', '/api/live/wsl/agents/install', q);
    try {
      resetInstallProgress();
      assertEquals(await get('distro=Ubuntu&agent=claude'), [200, { ok: true, state: 'idle', distro: 'ubuntu', name: 'Ubuntu', distroState: 'off', line: '' }]);
      host.begun = true;
      host.state = 'stopped';
      host.note = 'Ubuntu stopped (Windows restart or `wsl --shutdown`).';
      assertEquals(await get('distro=ubuntu&agent=claude'), [200, {
        ok: true,
        state: 'idle',
        distro: 'ubuntu',
        name: 'Ubuntu',
        distroState: 'stopped',
        line: 'Ubuntu stopped (Windows restart or `wsl --shutdown`).',
      }]);
      assertEquals([host.starts, host.calls.length], [0, 0], 'a status read started nothing and asked nothing');
      // start=1 (a click): started, then the helper answers
      const [status, out] = await get('distro=ubuntu&agent=claude&start=1');
      assertEquals([status, out.state, out.ok], [200, 'idle', true]);
      assertEquals([host.starts, host.calls.at(-1)?.[0]], [1, 'agents.installStatus']);
      // ready: the helper's answer, still no start
      await get('distro=ubuntu&agent=claude');
      assertEquals([host.starts, host.calls.filter((c) => c[0] === 'agents.installStatus').length], [1, 2]);
    } finally {
      setWslHostResolver(null);
      setDistroSource(null);
    }
  },
);

// ---- 5. the Node.js terminal ------------------------------------------------------------------------------------------------------

Deno.test(
  'setup=wsl-node: refused unless canInstallNode (its reason), never starts a distro unasked, asks prereqs with force',
  T,
  async () => {
    const host = new CountingHost('unused', 'Ubuntu');
    phase2Helper(host);
    host.state = 'starting';
    withHost(host);
    try {
      assertEquals(
        await wslNodeSetupCommand('ubuntu'),
        'Ubuntu is not running. Start it in Settings > AIB Linking (WSL), then install Node.js.',
      );
      assertEquals(host.starts, 0);
      assertEquals(await wslNodeSetupCommand('no such'), 'Choose a distro.');
      phase2Helper(host, {
        ...PREREQS_OK,
        node: { state: 'shim_unset', manager: 'asdf' },
        canInstallNode: false,
        nodeInstallBlocked: 'asdf has no Node.js version set. Run: asdf install nodejs latest',
      });
      assertEquals(await wslNodeSetupCommand('ubuntu', true), 'asdf has no Node.js version set. Run: asdf install nodejs latest');
      assertEquals([host.starts, host.calls.at(-1)], [1, ['env.prereqs', { force: true }]]);
      phase2Helper(host);
      const ready = await wslNodeSetupCommand('ubuntu');
      assert(typeof ready !== 'string', String(ready));
      assertEquals([ready.home, ready.command.file, ready.command.args.slice(0, 3)], ['/home/u', '/bin/bash', [
        '--noprofile',
        '--norc',
        '-c',
      ]]);
      assertEquals(ready.command.args[3], wslNodeScript('/usr/bin/zsh'));
      host.handlers['env.prereqs'] = () => {
        throw new WslHelperError('nope', 'unknown_method');
      };
      assertEquals(await wslNodeSetupCommand('ubuntu'), 'The AIB helper in Ubuntu is too old to install Node.js. Restart AIB.');
    } finally {
      setWslHostResolver(null);
      setDistroSource(null);
    }
  },
);

Deno.test('the Node.js steps: pinned install.sh checked before it runs, PROFILE by login shell, --lts, 22.19 checked, no sudo/apt; fail closed', () => {
  assertEquals([profileFor('/usr/bin/zsh'), profileFor('/bin/bash'), profileFor('/usr/bin/fish'), profileFor('')], [
    '${ZDOTDIR:-$HOME}/.zshrc',
    '$HOME/.bashrc',
    '$HOME/.profile',
    '$HOME/.profile',
  ]);
  const steps = wslNodeSteps('/bin/bash');
  const at = (needle: string) => steps.findIndex((s) => s.includes(needle));
  assert(at(`curl -fsSLo "$t" ${NVM_INSTALL_URL}`) >= 0, 'downloads to a temp file');
  assert(at(`echo "${NVM_INSTALL_SHA256}  $t" | sha256sum -c -`) > at('curl'), 'checked after the download');
  assert(at('PROFILE="$HOME/.bashrc" bash "$t"') > at('sha256sum'), 'run only after the check, PROFILE set explicitly');
  assert(at('nvm install --lts') > at('PROFILE='), '--lts after nvm');
  assert(at('-ge 19') > at('nvm install'), 'the 22.19 minimum is checked last');
  assert(!steps.some((s) => /\bsudo\b|\bapt(-get)?\b/.test(s)), 'never sudo or apt');
  const script = wslNodeScript('/bin/bash');
  for (const step of steps) assert(script.includes(`aib_step '${step.replaceAll("'", `'\\''`)}'`), `printed and run: ${step}`);
  assert(script.includes('printf \'\\n$ %s\\n\' "$1"'), 'each command is printed before it runs');
  // no checksum: refused, nothing runs
  assertEquals(wslNodeCommand(PREREQS_OK, 'Ubuntu', ''), NVM_NOT_PINNED);
  assertEquals(nvmInstallLine({ sha256: '' }), `echo '${NVM_NOT_PINNED}' && false`);
  assertEquals(wslNodeCommand(null, 'Ubuntu'), 'AIB could not check what Ubuntu has. Choose Check again.');
  assertEquals(wslNodeCommand({ ...PREREQS_OK, canInstallNode: false }, 'Ubuntu'), 'AIB cannot install Node.js in Ubuntu.');
});

Deno.test('the nvm tag and checksum live only in agents/nvm.ts; the Beta card, the distro copy line and the button all use them', () => {
  assert(/^v\d+\.\d+\.\d+$/.test(NVM_VERSION) && /^[0-9a-f]{64}$/.test(NVM_INSTALL_SHA256), 'pinned');
  const node = PREREQS.node.install('linux', false).step!.command;
  for (const command of [NODE_INSTALL, node, wslNodeScript('/bin/bash')]) {
    assert(command.includes(NVM_INSTALL_URL) && command.includes(NVM_INSTALL_SHA256) && command.includes('nvm install --lts'), command);
  }
  assert(PREREQS.node.install('darwin', false).step!.command.includes('shasum -a 256 -c -'), 'macOS: shasum where sha256sum is missing');
  // no other server file names an nvm tag
  const root = new URL('../../app/server/', import.meta.url);
  const hits: string[] = [];
  const walk = (dir: URL) => {
    for (const entry of Deno.readDirSync(dir)) {
      const url = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir);
      if (entry.isDirectory) walk(url);
      else if (entry.name.endsWith('.ts') && /nvm-sh\/nvm\/v\d|v0\.4\d\.\d/.test(Deno.readTextFileSync(url))) {
        hits.push(url.pathname.split('/server/')[1]);
      }
    }
  };
  walk(root);
  assertEquals(hits, ['agents/nvm.ts']);
});
