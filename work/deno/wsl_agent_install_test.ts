/**
 * AIB-managed agent installs in a distro (server/wsl/helper/agent_install.ts in the helper, server/wsl/agent_install.ts on Windows,
 * the /api/live/wsl/agents* routes), with no distro: the helper's methods run in-process (installer.ts is path-agnostic) with
 * work/fake_npm.py as npm (python passed as "node", as installer_test.ts does), and a fake host that hands the Windows side's calls to
 * those methods. Nothing uses the network; nothing is installed anywhere but a temp folder. wsl_agent_install_e2e_test.ts runs the real
 * thing in a distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { exists, FAKE_NPM, join, makeInstall, PY, tempDir, waitFor, withEnv } from './_agents.ts';
import { checkLock, checkRequest, installMethods, type InstallContext } from '../../outputs/agent-studio/server/wsl/helper/agent_install.ts';
import { makeMethods } from '../../outputs/agent-studio/server/wsl/helper/methods.ts';
import { handleLine, type Handlers } from '../../outputs/agent-studio/server/wsl/helper/rpc.ts';
import { adapterHooks } from '../../outputs/agent-studio/server/agents/adapters.ts';
import {
  installFacts,
  installParams,
  lastProgress,
  NODE_INSTALL,
  nodeBlockLine,
  pinnedVersion,
  resetInstallProgress,
  wslInstallCall,
} from '../../outputs/agent-studio/server/wsl/agent_install.ts';
import { type HelperMethods, WslHelperError, type WslHost } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { APP_ROOT } from '../../outputs/agent-studio/server/core/app.ts';

const T = { sanitizeOps: false, sanitizeResources: false }; // install jobs run in the background between awaits
const ALLOW = JSON.parse(Deno.readTextFileSync(`${APP_ROOT}/agent_versions.json`)).agents;
const LOCK = (id: string) => Deno.readTextFileSync(`${APP_ROOT}/${ALLOW[id].lockfile}`);
const params = (id = 'claude') => ({ agent: id, entry: { package: ALLOW[id].package, version: ALLOW[id].version }, lock: LOCK(id) });

/** An in-process helper: its install methods over a temp root, notifications recorded. */
function helper(root: string, extra: Partial<InstallContext> = {}) {
  const notes: Record<string, unknown>[] = [];
  const handlers = installMethods({
    root,
    notify: (method, p) => notes.push({ method, ...p }),
    nodeCommand: PY,
    nodeProbe: () => '22.11.0',
    npmCli: FAKE_NPM,
    diskFree: () => 10 ** 12,
    ...extra,
  });
  return { handlers, notes, call: (method: string, p: Record<string, unknown>) => rpc(handlers, method, p) };
}

async function rpc(handlers: Handlers, method: string, p: Record<string, unknown>) {
  const reply = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: p }), handlers);
  return reply as { result?: Record<string, unknown>; error?: { code: number; message: string; data?: { code?: string } } };
}

/** A WslHost whose helper is `handlers` (what the Windows side calls), with the notifications it would forward. */
function fakeHost(handlers: Handlers, methods = Object.keys(handlers)): WslHost & { methods: string[]; emit(m: string, p: Record<string, unknown>): void; down: boolean } {
  const listeners = new Set<(m: string, p: Record<string, unknown>) => void>();
  const host = {
    distro: 'Ubuntu',
    state: 'ready' as const,
    note: '',
    link: null,
    helperVersion: '0.1.0-test',
    methods,
    down: false,
    async call<M extends keyof HelperMethods>(method: M, p: HelperMethods[M]['params']): Promise<HelperMethods[M]['result']> {
      if (host.down) throw new WslHelperError('The AIB helper in Ubuntu ended', 'helper_exited');
      if (!methods.includes(method)) throw new WslHelperError(`does not offer ${method}`, 'unknown_method');
      const reply = await rpc(handlers, method, p as Record<string, unknown>);
      if (reply.error) throw new WslHelperError(reply.error.message, String(reply.error.data?.code ?? reply.error.code));
      return reply.result as HelperMethods[M]['result'];
    },
    env: () => Promise.resolve({}),
    onOpenUrl: () => () => {},
    onNotify(fn: (m: string, p: Record<string, unknown>) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit: (m: string, p: Record<string, unknown>) => listeners.forEach((fn) => fn(m, p)),
    start: () => Promise.resolve(),
    reconnect: () => Promise.resolve(),
  };
  return host;
}

Deno.test('checkRequest: only a known agent, one of its own packages, an exact version; AIB\'s real lockfiles pass', () => {
  for (const id of ['claude', 'codex']) assertEquals(checkRequest(params(id)).agent, id);
  const bad = (p: Record<string, unknown>) => {
    try {
      checkRequest(p);
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };
  assert(bad({ ...params(), agent: 'omp' }).includes('cannot install'));
  assert(bad({ ...params(), agent: '../x' }).includes('cannot install'));
  assert(bad({ ...params(), entry: { package: 'left-pad', version: '1.0.0' } }).includes('not a package of claude'));
  assert(bad({ ...params(), entry: { package: ALLOW.claude.package, version: '^1.0.0' } }).includes('exact version'));
  assert(bad({ ...params(), entry: { package: ALLOW.claude.package, version: '0.0.1' } }).includes(`does not depend on`), 'lock and entry must agree');
  assertEquals(checkRequest({ ...params(), lock: null }).lock, null, 'no lockfile: npm install <pkg>@<exact>');
});

Deno.test('checkLock: refuses a lockfile that does not pin the package or misses an integrity hash', () => {
  const pkg = '@agentclientprotocol/claude-agent-acp';
  const lock = (extra: Record<string, unknown> = {}, own: Record<string, unknown> = {}) =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { dependencies: { [pkg]: '1.2.3' } },
        [`node_modules/${pkg}`]: { version: '1.2.3', resolved: 'https://registry.npmjs.org/x.tgz', integrity: 'sha512-abc', ...own },
        ...extra,
      },
    });
  const why = (text: string) => {
    try {
      checkLock(text, pkg, '1.2.3');
      return '';
    } catch (e) {
      return (e as Error).message;
    }
  };
  assertEquals(why(lock()), '');
  assert(why('{').includes('not JSON'));
  assert(why(JSON.stringify({ lockfileVersion: 1, dependencies: {} })).includes('version 2 or 3'));
  assert(why(lock({}, { version: '1.2.4' })).includes('does not pin'));
  assert(why(lock({ 'node_modules/evil': { version: '1.0.0', resolved: 'https://x/evil.tgz' } })).includes('node_modules/evil has no integrity'));
  assertEquals(why(lock({ 'node_modules/local': { link: true, resolved: '../local' } })), '', 'a workspace link downloads nothing');
});

Deno.test('agents.install: npm ci into <root>/agents/<id>/<version> from the lockfile AIB sent, npm cache inside the root, progress notified', T, async () => {
  using dir = tempDir();
  const restore = withEnv({ FAKE_NPM_LOG: join(dir.root, 'npm.log'), FAKE_NPM_MODE: 'ok' });
  try {
    const root = join(dir.root, 'aib-server');
    const h = helper(root);
    const started = await h.call('agents.install', params());
    assertEquals(started.result?.state, 'running');
    const done = await waitFor(async () => {
      const s = (await h.call('agents.installStatus', params())).result!;
      return s.state === 'done' || s.state === 'failed' ? s : null;
    });
    assertEquals(done?.state, 'done', JSON.stringify(done));
    const folder = join(root, 'agents', 'claude', ALLOW.claude.version);
    assert(exists(join(folder, '.complete')), 'the marker is written last');
    assertEquals(Deno.readTextFileSync(join(folder, 'package-lock.json')), LOCK('claude'), 'the lockfile AIB sent, byte for byte');
    const [run] = Deno.readTextFileSync(join(dir.root, 'npm.log')).trim().split('\n').map((l) => JSON.parse(l));
    assertEquals(run.args.slice(0, 3), ['ci', '--prefix', folder]);
    assert(run.args.includes('--ignore-scripts') && !run.args.includes('-g') && !run.args.includes('--global'));
    assertEquals(run.cache, `${root}/agents/.npm-cache`, "npm's cache stays inside AIB's folder");
    const states = h.notes.filter((n) => n.method === 'agents.installProgress').map((n) => n.state);
    assertEquals(states[0], 'running');
    assertEquals(states[states.length - 1], 'done');
    // a second Install of the same version is done at once (nothing runs)
    assertEquals((await h.call('agents.install', params())).result?.state, 'done');
  } finally {
    restore();
  }
});

Deno.test('agents.installCancel: kills npm and removes the half-made folder; the row is back to Install', T, async () => {
  using dir = tempDir();
  const restore = withEnv({ FAKE_NPM_MODE: 'slow', FAKE_NPM_DELAY: '20' });
  try {
    const root = join(dir.root, 'aib-server');
    const h = helper(root);
    await h.call('agents.install', params('codex'));
    const folder = join(root, 'agents', 'codex', ALLOW.codex.version);
    // npm is running (slow mode writes its half-made file first)
    assert(await waitFor(() => exists(join(folder, 'node_modules', ...ALLOW.codex.package.split('/'), 'dist', 'partial.bin'))), 'npm started');
    const cancelled = (await h.call('agents.installCancel', params('codex'))).result!;
    assertEquals(cancelled.state, 'idle');
    assert(!exists(folder), 'the half-made folder is gone');
  } finally {
    restore();
  }
});

Deno.test('agents.installCheck and install: Node.js missing, too old, npm missing; Check again reads the PATH again', T, async () => {
  using dir = tempDir();
  const root = join(dir.root, 'aib-server');
  let refreshed = 0;
  const before = adapterHooks.findNode;
  try {
    adapterHooks.findNode = () => '';
    const h = helper(root, { nodeCommand: '', refreshPath: () => Promise.resolve(void refreshed++) });
    const check = (await h.call('agents.installCheck', {})).result!;
    assertEquals([check.code, check.minNode], ['node_missing', 22]);
    assertEquals(refreshed, 1, 'a missing Node.js makes the helper read the login PATH again');
    await h.call('agents.installCheck', {});
    assertEquals(refreshed, 1, '…but not on every call');
    await h.call('agents.installCheck', { force: true });
    assertEquals(refreshed, 2, 'Check again always does');
    const refused = await h.call('agents.install', params());
    assertEquals(refused.error?.data?.code, 'node_missing');
    assert(!exists(join(root, 'agents', 'claude', ALLOW.claude.version)), 'nothing was created');
    adapterHooks.findNode = () => PY;
    assertEquals((await helper(root, { nodeProbe: () => '18.19.1' }).call('agents.installCheck', {})).result?.code, 'node_old');
    assertEquals((await helper(root, { nodeProbe: () => '' }).call('agents.installCheck', {})).result?.code, 'node_broken');
    assertEquals((await helper(root, { npmCli: join(dir.root, 'none.js') }).call('agents.installCheck', {})).result?.code, 'npm_missing');
  } finally {
    adapterHooks.findNode = before;
  }
});

Deno.test("agents.detect with the helper's root: AIB's own install is found first (source studio, its version); Codex gets its CLI", async () => {
  using dir = tempDir();
  const root = join(dir.root, 'aib-server');
  makeInstall(root, 'claude', '0.101.0', ALLOW.claude.package);
  makeInstall(root, 'codex', '2.6.0', ALLOW.codex.package);
  // the @openai/codex CLI the adapter depends on, hoisted next to it in the same install
  Deno.mkdirSync(join(root, 'agents', 'codex', '2.6.0', 'node_modules', '@openai', 'codex', 'bin'), { recursive: true });
  Deno.writeTextFileSync(join(root, 'agents', 'codex', '2.6.0', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '//');
  const before = adapterHooks.findNode;
  try {
    adapterHooks.findNode = () => PY;
    const methods = makeMethods({ env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home: dir.root, arch: 'amd64' }), root });
    assert('agents.install' in methods && 'agents.installCheck' in methods, 'a helper with a root offers the install methods');
    const found = (await rpc(methods, 'agents.detect', { ids: ['claude', 'codex'] })).result!.agents as Record<string, unknown>[];
    const claude = found.find((a) => a.id === 'claude')!, codex = found.find((a) => a.id === 'codex')!;
    assertEquals([claude.found, claude.source, claude.version], [true, 'studio', '0.101.0']);
    assert(String((claude.command as string[])[1]).startsWith(join(root, 'agents', 'claude', '0.101.0')));
    assertEquals([codex.source, codex.version], ['studio', '2.6.0']);
    assertEquals((codex.signin as string[])[0], PY, 'the CLI runs with the same node');
    assert(String((codex.signin as string[])[1]).endsWith(join('@openai', 'codex', 'bin', 'codex.js')), String(codex.signin));
    const plain = makeMethods({ env: () => Promise.resolve({ env: {}, shell: '/bin/sh', home: dir.root, arch: 'amd64' }) });
    assert(!('agents.install' in plain), 'without a root: no install methods');
  } finally {
    adapterHooks.findNode = before;
  }
});

// ---- the Windows side ---------------------------------------------------------------------------------------------------------

Deno.test('installParams: the pinned entry and the reviewed lockfile; nothing for agents AIB does not install in WSL', () => {
  const p = installParams('claude')!;
  assertEquals([p.entry.package, p.entry.version, p.lock], [ALLOW.claude.package, ALLOW.claude.version, LOCK('claude')]);
  assertEquals(p.entry.minFreeBytes, ALLOW.claude.minFreeBytes);
  assertEquals(installParams('omp'), null);
  assertEquals(installParams('copilot'), null);
  assertEquals(pinnedVersion('codex'), ALLOW.codex.version);
});

Deno.test('nodeBlockLine: one plain line per case, naming the distro', () => {
  assertEquals(nodeBlockLine('', 'claude', 'Ubuntu'), '');
  assertEquals(nodeBlockLine('node_missing', 'claude', 'Ubuntu'), 'Node.js 22 or newer is needed in Ubuntu to install Claude Code, and Ubuntu has no Node.js.');
  assertEquals(nodeBlockLine('node_old', 'codex', 'Debian', '18.19.1'), 'Node.js 22 or newer is needed in Debian to install Codex; Debian has Node.js 18.19.1.');
  assert(NODE_INSTALL.includes('nvm install --lts') && !NODE_INSTALL.includes('sudo') && !NODE_INSTALL.includes('apt'), 'no root, no system package');
  assert(NODE_INSTALL.includes('sha256sum -c -'), 'install.sh is checked before it runs');
});

Deno.test('wslInstallCall and installFacts: start, status, a Node.js refusal with its command, update when AIB pins a newer version', T, async () => {
  using dir = tempDir();
  const restore = withEnv({ FAKE_NPM_MODE: 'ok' });
  const before = adapterHooks.findNode;
  resetInstallProgress();
  try {
    const root = join(dir.root, 'aib-server');
    const h = helper(root);
    const host = fakeHost(h.handlers);
    assertEquals((await wslInstallCall(host, 'ubuntu', 'Ubuntu', 'start', 'omp'))[0], 400);
    const [status, body] = await wslInstallCall(host, 'ubuntu', 'Ubuntu', 'start', 'claude');
    assertEquals([status, (body as { state: string }).state], [200, 'running']);
    const done = await waitFor(async () => {
      const [, s] = await wslInstallCall(host, 'ubuntu', 'Ubuntu', 'status', 'claude');
      return (s as { state: string }).state === 'done' ? s : null;
    });
    assert(done, 'the job finished');
    // the notifications the helper sent reach the Windows side; a status read while the helper restarts answers the last one
    host.emit('agents.installProgress', { agent: 'claude', state: 'running', stage: 'downloading', percent: 40, message: '' });
    assertEquals(lastProgress('ubuntu', 'claude')?.percent, 40);
    host.down = true;
    const [st, stale] = await wslInstallCall(host, 'ubuntu', 'Ubuntu', 'status', 'claude');
    assertEquals([st, (stale as { stale: boolean }).stale, (stale as { percent: number }).percent], [200, true, 40]);
    assertEquals((await wslInstallCall(host, 'ubuntu', 'Ubuntu', 'start', 'claude'))[0], 400, 'a start is never answered from memory');
    host.down = false;

    // AIB's install of an older version: Update; AIB's current one: nothing to offer
    const facts = await installFacts(host, 'ubuntu', 'Ubuntu', [
      { id: 'claude', found: true, version: '0.0.9', source: 'studio' },
      { id: 'codex', found: true, version: ALLOW.codex.version, source: 'studio' },
      { id: 'omp', found: false },
    ]);
    assertEquals(facts.claude, { installable: true, pinned: ALLOW.claude.version, managed: true, update: true });
    assertEquals(facts.codex, { installable: true, pinned: ALLOW.codex.version, managed: true });
    assertEquals(facts.omp, undefined);

    // Node.js missing: the row says so with the command; Install answers 409 with the line, the code and the command
    adapterHooks.findNode = () => '';
    const h2 = helper(join(dir.root, 'other'), { nodeCommand: '' });
    const host2 = fakeHost(h2.handlers);
    const missing = await installFacts(host2, 'ubuntu', 'Ubuntu', [{ id: 'codex', found: false }]);
    assertEquals(missing.codex.installBlock, 'Node.js 22 or newer is needed in Ubuntu to install Codex, and Ubuntu has no Node.js.');
    assertEquals(missing.codex.nodeInstall, NODE_INSTALL);
    const [code, refused] = await wslInstallCall(host2, 'ubuntu', 'Ubuntu', 'start', 'codex');
    assertEquals([code, (refused as { code: string }).code, (refused as { nodeInstall: string }).nodeInstall], [409, 'node_missing', NODE_INSTALL]);

    // an older helper without the install methods: no install facts (the copyable command only), and a clear refusal
    const old = fakeHost(h.handlers, ['agents.detect']);
    assertEquals(await installFacts(old, 'ubuntu', 'Ubuntu', [{ id: 'claude', found: false }]), {});
    const [oc, ob] = await wslInstallCall(old, 'ubuntu', 'Ubuntu', 'start', 'claude');
    assertEquals(oc, 409);
    assert((ob as { error: string }).error.includes('too old'));
  } finally {
    adapterHooks.findNode = before;
    restore();
  }
});
