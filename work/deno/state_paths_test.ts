/**
 * server/state/paths.ts: the state_paths cases of work/test_state_migration.py and work/test_package_context.py, parity with Python
 * through work/parity/state_paths_shim.py, and interop (an owner-only folder made by one side passes the other's check; Python's
 * migrate does the move inside Deno's prepare). Temp folders and fake environments only: the real per-user folder is never resolved
 * except to prove the hard block refuses it.
 */
import { createHash } from 'node:crypto';
import { assert, assertEquals, assertRejects, assertThrows } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  aclProblems,
  adoptSandboxCopy,
  ensurePrivateDir,
  type Env,
  ENV_STATE_DIR,
  ENV_TEST,
  isWorktreeCheckout,
  MIGRATED_MARKER,
  type MigrateFn,
  type Migration,
  NO_PACKAGE,
  oldDefaultDir,
  packageContext,
  packageLabel,
  pathOf,
  prepare,
  RealFolderBlocked,
  realUserStateDir,
  resolve,
  samePath,
  sandboxCopies,
  StateDirInsecure,
  underTest,
  userStateDir,
} from '../../outputs/agent-studio/server/state/paths.ts';
import { windowsCurrentUserSid, windowsDacl } from '../../outputs/agent-studio/server/platform/acl.ts';
import type { PackageKernel } from '../../outputs/agent-studio/server/platform/acl.ts';

const WIN = Deno.build.os === 'windows';
const FAMILY = 'Claude_pzs8sxrjxfjjc';
const APP_PARTS = ['outputs', 'agent-studio'];
const SHIM = 'state_paths_shim';

function tempRoot(): { root: string; [Symbol.dispose](): void } {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-state-paths-' })).replace(/^\\\\\?\\/, '');
  return {
    root,
    [Symbol.dispose]() {
      try {
        Deno.removeSync(root, { recursive: true });
      } catch { /* a folder icacls locked down; the OS cleans temp */ }
    },
  };
}

function checkout(root: string, name: string, gitFile: boolean): string {
  const repo = pathOf(root, name);
  const code = pathOf(repo, ...APP_PARTS);
  Deno.mkdirSync(code, { recursive: true });
  if (gitFile) Deno.writeTextFileSync(pathOf(repo, '.git'), 'gitdir: elsewhere\n');
  else Deno.mkdirSync(pathOf(repo, '.git'));
  return code;
}

function fakeEnv(root: string, extra: Env = {}): Env {
  return { LOCALAPPDATA: pathOf(root, 'local'), XDG_STATE_HOME: pathOf(root, 'xdg'), [ENV_TEST]: '1', ...extra };
}

/** The real environment of this process with the test flag on and no state folder override: what must hit the hard block. */
function realEnv(): Env {
  const env: Env = { ...Deno.env.toObject(), [ENV_TEST]: '1' };
  delete env[ENV_STATE_DIR];
  return env;
}

function snapshot(folder: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const entry of [...Deno.readDirSync(dir)].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = pathOf(dir, entry.name);
      if (entry.isDirectory) walk(path, prefix + entry.name + '/');
      else if (entry.isFile) out[prefix + entry.name] = createHash('sha256').update(Deno.readFileSync(path)).digest('hex');
    }
  };
  walk(folder, '');
  return out;
}

const exists = (path: string) => {
  try {
    Deno.statSync(path);
    return true;
  } catch {
    return false;
  }
};

/** Python's migrate.migrate, through the parity bridge, as the migrate function of Deno's prepare/adoptSandboxCopy. */
function pythonMigrate(py: PyParity): MigrateFn {
  return async (source, target, say) => {
    const reply = await py.call(SHIM, 'migrate', [source, target]) as { result: Migration; messages: string[] };
    reply.messages.forEach(say);
    return reply.result;
  };
}

// ---- locations ---------------------------------------------------------------------------------
Deno.test('per-user folder per platform, same as Python', async () => {
  await using py = new PyParity();
  const env = { LOCALAPPDATA: 'C:/Users/x/AppData/Local', XDG_STATE_HOME: '/state' };
  assertEquals(userStateDir(env, 'win32', 'C:/Users/x'), pathOf('C:/Users/x/AppData/Local', 'AgentStudio'));
  assertEquals(userStateDir({}, 'darwin', '/Users/x'), pathOf('/Users/x/Library/Application Support/AgentStudio'));
  assertEquals(userStateDir(env, 'linux', '/home/x'), pathOf('/state/agent-studio'));
  assertEquals(userStateDir({}, 'linux', '/home/x'), pathOf('/home/x/.local/state/agent-studio'));
  assertEquals(userStateDir({}, 'win32', 'C:/Users/x'), pathOf('C:/Users/x/AppData/Local/AgentStudio'));
  for (
    const [e, platform, home] of [
      [env, 'win32', 'C:/Users/x'],
      [{}, 'darwin', '/Users/x'],
      [env, 'linux', '/home/x'],
      [{}, 'linux', '/h'],
      [{}, 'win32', 'D:/u'],
    ] as const
  ) {
    assertEquals(userStateDir(e, platform, home), await py.call(SHIM, 'user_state_dir', [e, platform, home]), `${platform} ${home}`);
  }
});

Deno.test('worktree detection, same as Python', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const wt = checkout(tmp.root, 'wt', true);
  const main = checkout(tmp.root, 'main', false);
  const nested = pathOf(tmp.root, 'x', '.claude', 'worktrees', 'a', ...APP_PARTS);
  Deno.mkdirSync(nested, { recursive: true });
  Deno.mkdirSync(pathOf(tmp.root, 'x', '.claude', 'worktrees', 'a', '.git'));
  const installed = pathOf(tmp.root, 'installed', 'app');
  Deno.mkdirSync(installed, { recursive: true });
  assertEquals(isWorktreeCheckout(wt), true);
  assertEquals(isWorktreeCheckout(main), false);
  assertEquals(isWorktreeCheckout(nested), true, 'a .claude/worktrees path counts as a worktree even with a .git folder');
  for (const code of [wt, main, nested, installed, pathOf(tmp.root, 'missing', 'deep')]) {
    assertEquals(isWorktreeCheckout(code), await py.call('state_paths', 'is_worktree_checkout', [code]), code);
  }
  assertEquals(oldDefaultDir(wt), await py.call(SHIM, 'old_default_dir', [wt]));
  assertEquals(oldDefaultDir(wt), pathOf(tmp.root, 'wt', 'work', 'agent-studio-state'));
});

Deno.test('precedence: --state-dir, then the environment, then the default; same as Python', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const main = checkout(tmp.root, 'main', false);
  const wt = checkout(tmp.root, 'wt', true);
  const env = fakeEnv(tmp.root, { [ENV_STATE_DIR]: pathOf(tmp.root, 'from-env') });
  assertEquals(resolve(pathOf(tmp.root, 'cli'), env, main).path, pathOf(tmp.root, 'cli'));
  assertEquals(resolve(null, env, main).path, pathOf(tmp.root, 'from-env'));
  const noOverride = fakeEnv(tmp.root);
  const user = resolve(null, noOverride, main);
  assertEquals(user.path, WIN ? pathOf(tmp.root, 'local', 'AgentStudio') : userStateDir(noOverride));
  assert(user.isUserFolder);
  const old = resolve(null, noOverride, wt);
  assertEquals(old.path, pathOf(tmp.root, 'wt', 'work', 'agent-studio-state'));
  assertEquals(old.isUserFolder, false);
  const cases: [string | null, Env, string][] = [
    [pathOf(tmp.root, 'cli'), env, main],
    [null, env, main],
    [null, noOverride, main],
    [null, noOverride, wt],
    [pathOf(tmp.root, 'local', 'AgentStudio'), noOverride, wt], // asking for the (fake) per-user folder by name
    ['relative-dir', noOverride, main],
    [null, fakeEnv(tmp.root, { [ENV_STATE_DIR]: '~/elsewhere' }), main],
  ];
  for (const [cli, e, code] of cases) {
    const mine = resolve(cli, e, code);
    assertEquals(
      { path: mine.path, source: mine.source, isUserFolder: mine.isUserFolder },
      await py.call(SHIM, 'resolve', [cli, e, code]),
      JSON.stringify([cli, e[ENV_STATE_DIR], code]),
    );
  }
});

Deno.test('hard block: the real per-user folder is refused under test, with the same message as Python', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const main = checkout(tmp.root, 'main', false);
  const env = realEnv();
  const first = assertThrows(() => resolve(null, env, main), RealFolderBlocked);
  const second = assertThrows(() => realUserStateDir(env), RealFolderBlocked);
  const third = assertThrows(() => resolve(userStateDir(), env, main), RealFolderBlocked); // even when asked for by --state-dir
  const pyFirst = await py.raw(SHIM, 'resolve', [null, env, main]);
  const pyThird = await py.raw(SHIM, 'resolve', [userStateDir(), env, main]);
  assertEquals(pyFirst, { error: 'RealFolderBlocked', message: first.message });
  assertEquals(second.message, first.message);
  assertEquals(pyThird, { error: 'RealFolderBlocked', message: third.message });
  assert(first.message.includes('AGENT_STUDIO_TEST=1'));
  assert(!exists(pathOf(tmp.root, 'local')), 'nothing created');
});

Deno.test('hard block: a Deno test run counts as under test even without AGENT_STUDIO_TEST', () => {
  const env = realEnv();
  delete env[ENV_TEST];
  assert(underTest(env), 'a *_test.ts main module is the analogue of a loaded unittest');
  assertThrows(() => realUserStateDir(env), RealFolderBlocked);
});

Deno.test('a fake environment or home is not the real folder, so it resolves', () => {
  using tmp = tempRoot();
  const env = fakeEnv(tmp.root);
  assertEquals(realUserStateDir(env, 'win32'), pathOf(tmp.root, 'local', 'AgentStudio'));
  assertEquals(
    realUserStateDir({ [ENV_TEST]: '1' }, 'linux', pathOf(tmp.root, 'home')),
    pathOf(tmp.root, 'home', '.local', 'state', 'agent-studio'),
  );
  assertEquals(samePath(pathOf(tmp.root, 'a', '..', 'b'), pathOf(tmp.root, 'b')), true);
  assertEquals(samePath(pathOf(tmp.root, 'a'), pathOf(tmp.root, 'b')), false);
});

// ---- packaged parent app -----------------------------------------------------------------------
/** kernel32 with GetCurrentPackageFullName answering like Windows does (size query, then the name). */
class FakeKernel implements PackageKernel {
  constructor(readonly code: number, readonly name = '') {}
  GetCurrentPackageFullName(length: Uint32Array, buffer: Uint16Array | null): number {
    if (this.code === NO_PACKAGE) return this.code;
    if (buffer === null) {
      length[0] = this.name.length + 1;
      return 122;
    }
    for (let i = 0; i < this.name.length; i++) buffer[i] = this.name.charCodeAt(i);
    buffer[this.name.length] = 0;
    return 0;
  }
}

Deno.test('package detection: packaged, unpackaged, not Windows', () => {
  using tmp = tempRoot();
  assertEquals(packageContext({ platform: 'win32', kernel: new FakeKernel(0, 'Claude_4.23118.1.0_x64__pzs8sxrjxfjjc') }), FAMILY);
  assertEquals(packageContext({ env: { LOCALAPPDATA: tmp.root }, platform: 'win32', kernel: new FakeKernel(NO_PACKAGE) }), null);
  assertEquals(packageContext({ platform: 'linux', kernel: new FakeKernel(0, 'Claude_1_x64__abc') }), null);
  assertEquals(
    packageContext({ env: { LOCALAPPDATA: tmp.root }, platform: 'win32', kernel: new FakeKernel(0, '') }),
    null,
    'an empty name means no package',
  );
  assertEquals(packageLabel(FAMILY), 'Claude');
  assertEquals(packageLabel(null), '');
});

Deno.test('package detection: a child of a packaged app is found by its redirected write, and the probe is removed', () => {
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const mirror = pathOf(local, 'Packages', FAMILY, 'LocalCache', 'Local');
  Deno.mkdirSync(mirror, { recursive: true });
  Deno.writeFileSync(pathOf(mirror, `.studio-package-probe-${Deno.pid}-cafebabe`), new Uint8Array()); // what Windows would have mirrored
  const found = packageContext({
    env: { LOCALAPPDATA: local },
    platform: 'win32',
    kernel: new FakeKernel(NO_PACKAGE),
    probeSuffix: () => 'cafebabe',
  });
  assertEquals(found, FAMILY);
  assertEquals([...Deno.readDirSync(local)].map((e) => e.name), ['Packages'], 'the probe file is removed again');
  Deno.removeSync(pathOf(mirror, `.studio-package-probe-${Deno.pid}-cafebabe`));
  assertEquals(
    packageContext({ env: { LOCALAPPDATA: local }, platform: 'win32', kernel: new FakeKernel(NO_PACKAGE) }),
    null,
    'no redirection, no package',
  );
});

Deno.test({
  name: 'package detection: the real GetCurrentPackageFullName binding agrees with Python',
  ignore: !WIN,
  async fn() {
    await using py = new PyParity();
    using tmp = tempRoot();
    const env = { LOCALAPPDATA: tmp.root };
    assertEquals(packageContext({ env }), await py.call('state_paths', 'package_context', [env]));
  },
});

// ---- sandbox copies ----------------------------------------------------------------------------
function makeSandbox(local: string, family = FAMILY, text = 'chats'): string {
  const folder = pathOf(local, 'Packages', family, 'LocalCache', 'Local', 'AgentStudio');
  Deno.mkdirSync(pathOf(folder, 'artifacts', 'a1'), { recursive: true });
  Deno.writeTextFileSync(pathOf(folder, 'studio-conversations.json'), JSON.stringify({ text }));
  Deno.writeTextFileSync(pathOf(folder, 'studio-settings.json'), '{}');
  Deno.writeTextFileSync(pathOf(folder, 'artifacts', 'a1', 'v1.html'), '<p>hi</p>');
  Deno.mkdirSync(pathOf(folder, 'agents', 'codex', '2.6.0'), { recursive: true });
  Deno.writeFileSync(pathOf(folder, 'agents', 'codex', '2.6.0', 'adapter.bin'), new Uint8Array([0, 1, 97]));
  return folder;
}

Deno.test('sandbox copies: Claude packages only, unless exactly one other has data; same as Python', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const env = { LOCALAPPDATA: local };
  const check = async (expected: [string, string][], message: string) => {
    assertEquals(sandboxCopies(env, 'win32'), expected, message);
    assertEquals(await py.call(SHIM, 'sandbox_copies', [env, 'win32']), expected, 'python: ' + message);
  };
  await check([], 'no Packages folder');
  Deno.mkdirSync(pathOf(local, 'Packages', FAMILY, 'LocalCache', 'Local', 'AgentStudio'), { recursive: true });
  await check([], 'an empty sandbox folder is not a copy');
  const other = makeSandbox(local, 'Other_abc');
  await check([['Other_abc', other]], 'one other package');
  makeSandbox(local, 'Third_def');
  await check([], 'two non-Claude packages: do not guess');
  const claude = makeSandbox(local, FAMILY);
  await check([[FAMILY, claude]], 'a Claude package wins');
  assertEquals(sandboxCopies(env, 'linux'), []);
  Deno.writeTextFileSync(pathOf(claude, 'MIGRATED-TO.txt'), 'moved');
  await check([], 'a copy already moved is ignored (and two others remain)');
});

Deno.test('adoptSandboxCopy: none, conflict, waiting; same as Python', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const env = { LOCALAPPDATA: local };
  const real = pathOf(local, 'AgentStudio');
  const both = async (attempt = true) => {
    const messages: string[] = [];
    const [use, migration] = await adoptSandboxCopy(real, { env, platform: 'win32', say: (m) => messages.push(m), attempt });
    const python = await py.call(SHIM, 'adopt_sandbox_copy', [real, env, 'win32', attempt]);
    assertEquals({ use, migration, messages }, python);
    return { use, migration };
  };
  assertEquals((await both()).migration.state, 'none');
  assert(!exists(real) && !exists(pathOf(local, 'Packages')), 'nothing created');
  const sandbox = makeSandbox(local);
  const waiting = await both(false);
  assertEquals([waiting.use, waiting.migration.state], [sandbox, 'waiting']);
  Deno.mkdirSync(real, { recursive: true });
  Deno.writeTextFileSync(pathOf(real, 'studio-conversations.json'), '{"mine": 1}');
  const before = [snapshot(sandbox), snapshot(real)];
  const conflict = await both();
  assertEquals([conflict.use, conflict.migration.state], [real, 'conflict']);
  assert(String(conflict.migration.reason).includes(sandbox) && String(conflict.migration.reason).includes(real));
  assertEquals([snapshot(sandbox), snapshot(real)], before, 'nothing merged or overwritten');
});

Deno.test('adoptSandboxCopy moves the copy with Python migrate (interop): byte for byte, source kept, not offered again', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const env = { LOCALAPPDATA: local };
  const real = pathOf(local, 'AgentStudio');
  const sandbox = makeSandbox(local);
  Deno.mkdirSync(pathOf(sandbox, 'worktrees', 'chat1'), { recursive: true });
  Deno.mkdirSync(pathOf(sandbox, 'worktrees', 'chat2'));
  const before = snapshot(sandbox);
  const [use, result] = await adoptSandboxCopy(real, { env, platform: 'win32', say: () => {}, migrate: pythonMigrate(py) });
  assertEquals([use, result.state, result.kind, result.package, result.worktreesLeft], [real, 'done', 'sandbox', FAMILY, 2]);
  const copied = snapshot(real);
  for (const [name, digest] of Object.entries(before)) assertEquals(copied[name], digest, name);
  assert(!exists(pathOf(real, 'worktrees')), 'worktrees stay');
  assert(exists(pathOf(real, MIGRATED_MARKER)));
  const after = snapshot(sandbox);
  delete after['MIGRATED-TO.txt'];
  assertEquals(after, before);
  assertEquals((await adoptSandboxCopy(real, { env, platform: 'win32' }))[1].state, 'none', 'a copy that was moved is not offered again');
});

Deno.test('adoptSandboxCopy: waits while the sandbox host runs; several copies take the newest and say so', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const local = pathOf(tmp.root, 'Local');
  const env = { LOCALAPPDATA: local };
  const real = pathOf(local, 'AgentStudio');
  const old = makeSandbox(local, 'Claude_old');
  const fresh = makeSandbox(local, 'Claude_new');
  const stamp = new Date(Date.now() - 1_000_000);
  for (const name of ['studio-conversations.json', 'studio-settings.json']) Deno.utimeSync(pathOf(old, name), stamp, stamp);
  Deno.writeTextFileSync(pathOf(fresh, 'agent-host.json'), JSON.stringify({ pid: Deno.pid })); // a live process
  const messages: string[] = [];
  const before = snapshot(fresh);
  const [use, result] = await adoptSandboxCopy(real, { env, platform: 'win32', say: (m) => messages.push(m), migrate: pythonMigrate(py) });
  assertEquals([use, result.state, result.source], [fresh, 'waiting', fresh]);
  assert(String(result.reason).includes('agent host'), String(result.reason));
  assert(messages.some((m) => m.includes('Several sandbox copies')), messages.join('\n'));
  assert(messages.some((m) => m.startsWith(`Studio data will move from ${fresh} to ${real} at a later start.`)), messages.join('\n'));
  assertEquals(snapshot(fresh), before);
  assert(!exists(real));
});

// ---- prepare -----------------------------------------------------------------------------------
Deno.test({
  name: 'prepare moves the sandbox copy when unpackaged and leaves it when packaged',
  ignore: !WIN, // prepare() resolves %LOCALAPPDATA% only on Windows
  async fn() {
    await using py = new PyParity();
    for (const packaged of [false, true]) {
      using tmp = tempRoot();
      const local = pathOf(tmp.root, 'Local');
      makeSandbox(local);
      const code = pathOf(tmp.root, 'installed', 'app');
      Deno.mkdirSync(code, { recursive: true });
      const env = { LOCALAPPDATA: local, [ENV_TEST]: '1' };
      const plan = await prepare({
        env,
        codeRoot: code,
        say: () => {},
        migrate: pythonMigrate(py),
        packageContext: () => (packaged ? FAMILY : null),
      });
      assertEquals(plan.stateDir, pathOf(local, 'AgentStudio'));
      if (packaged) {
        assertEquals(plan.migration.state, 'none');
        assert(!exists(pathOf(local, 'Packages', FAMILY, 'LocalCache', 'Local', 'AgentStudio', 'MIGRATED-TO.txt')));
      } else {
        assertEquals(plan.migration.state, 'done');
        assert(exists(pathOf(local, 'AgentStudio', 'studio-conversations.json')));
      }
      assertEquals(aclProblems(plan.stateDir), [], 'the per-user folder is owner-only');
    }
  },
});

function buildOld(old: string): Record<string, string> {
  Deno.mkdirSync(pathOf(old, 'artifacts', 'x'), { recursive: true });
  Deno.writeTextFileSync(pathOf(old, 'studio-settings.json'), JSON.stringify({ version: 1, settings: { theme: 'dark' } }));
  Deno.writeTextFileSync(
    pathOf(old, 'studio-conversations.json'),
    JSON.stringify({ version: 1, entries: [{ key: 'omp:s1', pinned: true }] }),
  );
  Deno.writeTextFileSync(pathOf(old, 'artifacts', 'x', 'page.html'), '<p>hi</p>');
  return snapshot(old);
}

Deno.test('prepare: a main checkout moves its old default into the user folder once (Python migrate)', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const code = checkout(tmp.root, 'main', false);
  const old = pathOf(tmp.root, 'main', 'work', 'agent-studio-state');
  const before = buildOld(old);
  const env = { LOCALAPPDATA: pathOf(tmp.root, 'local'), XDG_STATE_HOME: pathOf(tmp.root, 'local'), [ENV_TEST]: '1' };
  const options = { env, codeRoot: code, say: () => {}, migrate: pythonMigrate(py), packageContext: () => null };
  const plan = await prepare(options);
  const user = userStateDir(env);
  assertEquals([plan.stateDir, plan.migration.state], [user, 'done']);
  assert(exists(pathOf(user, MIGRATED_MARKER)));
  assertEquals(aclProblems(user), []);
  assertEquals(Object.keys(snapshot(old)).filter((k) => !(k in before)), ['MIGRATED-TO.txt']);
  const again = await prepare(options);
  assertEquals([again.stateDir, again.migration.state], [user, 'none'], 'once marked, no second attempt');
});

Deno.test('prepare: not attempted runs on the old folder; without a migrate the old folder is kept too', async () => {
  using tmp = tempRoot();
  const code = checkout(tmp.root, 'main', false);
  const old = pathOf(tmp.root, 'main', 'work', 'agent-studio-state');
  buildOld(old);
  const env = { LOCALAPPDATA: pathOf(tmp.root, 'local'), XDG_STATE_HOME: pathOf(tmp.root, 'local'), [ENV_TEST]: '1' };
  const waiting = await prepare({ env, codeRoot: code, attemptMigration: false, packageContext: () => null });
  assertEquals([waiting.stateDir, waiting.migration.state, waiting.migration.reason], [
    old,
    'waiting',
    'migration not attempted by this command',
  ]);
  assert(!exists(pathOf(tmp.root, 'local')), 'nothing was created in the per-user location');
  const messages: string[] = [];
  const unported = await prepare({ env, codeRoot: code, say: (m) => messages.push(m), packageContext: () => null });
  assertEquals([unported.stateDir, unported.migration.state], [old, 'failed']);
  assert(
    messages[0].startsWith(`Agent Studio data will move to ${userStateDir(env)} at a later start. This run uses ${old}: `),
    messages[0],
  );
});

Deno.test('prepare: worktree and explicit folders never migrate unless asked; same as Python', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const wt = checkout(tmp.root, 'wt', true);
  const main = checkout(tmp.root, 'main', false);
  const env = { LOCALAPPDATA: pathOf(tmp.root, 'local'), XDG_STATE_HOME: pathOf(tmp.root, 'local'), [ENV_TEST]: '1' };
  const wtOld = pathOf(tmp.root, 'wt', 'work', 'agent-studio-state');
  const mainOld = pathOf(tmp.root, 'main', 'work', 'agent-studio-state');
  const wtBefore = buildOld(wtOld);
  const mainBefore = buildOld(mainOld);
  const plain = (p: { stateDir: string; migration: Migration; warnings: string[] }) => ({
    stateDir: p.stateDir,
    migration: p.migration,
    warnings: p.warnings,
  });
  const worktree = await prepare({ env, codeRoot: wt, say: () => {} });
  assertEquals([worktree.stateDir, worktree.migration.state], [wtOld, 'none']);
  const chosen = pathOf(tmp.root, 'chosen');
  const explicit = await prepare({ cliStateDir: chosen, env, codeRoot: main });
  assertEquals([explicit.stateDir, explicit.migration.state], [chosen, 'none']);
  assert(!exists(chosen), 'a --state-dir that does not exist yet is left for Studio to create');
  assert(!exists(pathOf(tmp.root, 'local')));
  for (const [cli, code] of [[null, wt], [chosen, main]] as const) {
    const mine = plain(await prepare({ cliStateDir: cli, env, codeRoot: code, say: () => {} }));
    const theirs = await py.call(SHIM, 'prepare', [cli, null, code, env]) as Record<string, unknown>;
    assertEquals(mine, { stateDir: theirs.stateDir, migration: theirs.migration, warnings: theirs.warnings }, String(cli));
  }
  assertEquals(snapshot(wtOld), wtBefore);
  assertEquals(snapshot(mainOld), mainBefore);
  const peruser = pathOf(tmp.root, 'peruser');
  const requested = await prepare({
    cliStateDir: peruser,
    migrateFrom: wtOld,
    env,
    codeRoot: wt,
    say: () => {},
    migrate: pythonMigrate(py),
  });
  assertEquals(requested.migration.state, 'done');
  assert(exists(pathOf(peruser, MIGRATED_MARKER)));
});

// ---- owner-only access -------------------------------------------------------------------------
Deno.test('a fresh private folder passes, and passes Python check too (and the other way round)', async () => {
  await using py = new PyParity();
  using tmp = tempRoot();
  const mine = pathOf(tmp.root, 'private');
  assertEquals(ensurePrivateDir(mine), true);
  assertEquals(aclProblems(mine), []);
  assertEquals(ensurePrivateDir(mine), false, 'existing and private: still fine');
  assertEquals(await py.call(SHIM, 'acl_problems', [mine]), [], 'python accepts the folder Deno restricted');
  const theirs = pathOf(tmp.root, 'python-private');
  assertEquals(await py.call(SHIM, 'ensure_private_dir', [theirs]), { created: true, messages: [] });
  assertEquals(aclProblems(theirs), [], 'deno accepts the folder Python restricted');
  if (WIN) {
    assertEquals(windowsDacl(mine), await py.call(SHIM, 'windows_dacl', [theirs]), 'the same owner-only DACL from both');
  }
});

Deno.test({
  name: 'Windows: Everyone, Users or Authenticated Users with write access fail, same as Python',
  ignore: !WIN,
  async fn() {
    await using py = new PyParity();
    using tmp = tempRoot();
    for (const [sid, name] of [['S-1-1-0', 'Everyone'], ['S-1-5-32-545', 'Users'], ['S-1-5-11', 'Authenticated Users']]) {
      const folder = pathOf(tmp.root, 'open-' + name.replaceAll(' ', ''));
      Deno.mkdirSync(folder);
      const out = new Deno.Command('icacls', { args: [folder, '/grant', `*${sid}:(OI)(CI)M`], stdout: 'null' }).outputSync();
      assertEquals(out.code, 0);
      const problems = aclProblems(folder);
      assert(problems.some((p) => p.includes(name)), `${name}: ${problems}`);
      assertEquals(problems, await py.call(SHIM, 'acl_problems', [folder]));
      assertEquals(windowsDacl(folder), await py.call(SHIM, 'windows_dacl', [folder]), 'same ACEs read by SID');
      const error = assertThrows(() => ensurePrivateDir(folder, true), StateDirInsecure);
      assertEquals(await py.raw(SHIM, 'ensure_private_dir', [folder, true]), { error: 'StateDirInsecure', message: error.message });
      const warnings: string[] = [];
      ensurePrivateDir(folder, false, (m) => warnings.push(m));
      assertEquals(warnings, (await py.call(SHIM, 'ensure_private_dir', [folder, false]) as { messages: string[] }).messages);
      assertEquals(warnings.length, 1);
    }
    const readable = pathOf(tmp.root, 'readable');
    Deno.mkdirSync(readable);
    new Deno.Command('icacls', { args: [readable, '/grant', '*S-1-5-32-545:(OI)(CI)R'], stdout: 'null' }).outputSync();
    assertEquals(aclProblems(readable), []);
    assertEquals(windowsCurrentUserSid(), await py.call(SHIM, 'windows_current_user_sid'));
    assert(windowsCurrentUserSid().startsWith('S-1-5-'));
  },
});

Deno.test({
  name: 'POSIX: mode 0700, and a group-writable folder is refused',
  ignore: WIN,
  async fn() {
    await using py = new PyParity();
    using tmp = tempRoot();
    const folder = pathOf(tmp.root, 'private');
    ensurePrivateDir(folder);
    assertEquals(Deno.statSync(folder).mode! & 0o777, 0o700);
    Deno.chmodSync(folder, 0o770);
    const error = assertThrows(() => ensurePrivateDir(folder), StateDirInsecure);
    assertEquals(await py.raw(SHIM, 'ensure_private_dir', [folder, true]), { error: 'StateDirInsecure', message: error.message });
  },
});

Deno.test('the per-user folder must be private: prepare refuses an open one', async () => {
  using tmp = tempRoot();
  const main = checkout(tmp.root, 'main', false);
  const env = fakeEnv(tmp.root);
  const user = userStateDir(env);
  Deno.mkdirSync(user, { recursive: true });
  if (WIN) new Deno.Command('icacls', { args: [user, '/grant', '*S-1-1-0:(OI)(CI)M'], stdout: 'null' }).outputSync();
  else Deno.chmodSync(user, 0o777);
  await assertRejects(() => prepare({ env, codeRoot: main, packageContext: () => null }), StateDirInsecure);
  const chosen = await prepare({ cliStateDir: user + '-x', env, codeRoot: main });
  assertEquals(chosen.warnings, []);
  Deno.mkdirSync(user + '-open');
  if (WIN) new Deno.Command('icacls', { args: [user + '-open', '/grant', '*S-1-1-0:(OI)(CI)M'], stdout: 'null' }).outputSync();
  else Deno.chmodSync(user + '-open', 0o777);
  const warned = await prepare({ cliStateDir: user + '-open', env, codeRoot: main });
  assertEquals(warned.warnings.length, 1, 'a folder chosen with --state-dir only warns');
});
