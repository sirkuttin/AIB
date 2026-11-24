/**
 * server/state/paths.ts: the state_paths cases of work/test_state_migration.py and work/test_package_context.py, the frozen answers
 * through the retired state_paths_shim.py, and interop (an owner-only folder made by one side passes the other's check; the
 * migrate does the move inside Deno's prepare). Temp folders and fake environments only: the real per-user folder is never resolved
 * except to prove the hard block refuses it.
 */
import { createHash } from 'node:crypto';
import { assert, assertEquals, assertRejects, assertThrows } from './_assert.ts';
import { Frozen } from './_frozen.ts';
import {
  aclProblems,
  ensurePrivateDir,
  type Env,
  ENV_STATE_DIR,
  ENV_TEST,
  isWorktreeCheckout,
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
  StateDirInsecure,
  underTest,
  userStateDir,
} from '../../app/server/state/paths.ts';
import { windowsCurrentUserSid, windowsDacl } from '../../app/server/platform/acl.ts';
import type { PackageKernel } from '../../app/server/platform/acl.ts';

const WIN = Deno.build.os === 'windows';
const FAMILY = 'Claude_pzs8sxrjxfjjc';
const APP_PARTS = ['app'];
const SHIM = 'state_paths_shim';
/** The frozen answers were recorded for a code folder in the old app location (outputs, then agent-studio); the answers do not depend on that name. */
const legacy = (code: string) => code.includes('installed') ? code : code.replace(/([\\/])app$/, '$1outputs$1agent-studio');

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

// ---- locations ---------------------------------------------------------------------------------
Deno.test('per-user folder per platform, as the frozen answers', async () => {
  const py = new Frozen();
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

Deno.test('worktree detection, as the frozen answers', async () => {
  const py = new Frozen();
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
    assertEquals(isWorktreeCheckout(code), await py.call('state_paths', 'is_worktree_checkout', [legacy(code)]), code);
  }
  assertEquals(oldDefaultDir(wt), await py.call(SHIM, 'old_default_dir', [legacy(wt)]));
  assertEquals(oldDefaultDir(wt), pathOf(tmp.root, 'wt', 'work', 'agent-studio-state'));
});

Deno.test('precedence: --state-dir, then the environment, then the default; as the frozen answers', async () => {
  const py = new Frozen();
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
      { path: mine.path.replace(Deno.cwd(), legacy(Deno.cwd())), source: mine.source, isUserFolder: mine.isUserFolder }, // a relative folder resolves under the cwd
      await py.call(SHIM, 'resolve', [cli, e, legacy(code)]),
      JSON.stringify([cli, e[ENV_STATE_DIR], code]),
    );
  }
});

Deno.test('hard block: the real per-user folder is refused under test, with the message the frozen answers hold', () => {
  using tmp = tempRoot();
  const main = checkout(tmp.root, 'main', false);
  const env = realEnv();
  const first = assertThrows(() => resolve(null, env, main), RealFolderBlocked);
  const second = assertThrows(() => realUserStateDir(env), RealFolderBlocked);
  const third = assertThrows(() => resolve(userStateDir(), env, main), RealFolderBlocked); // even when asked for by --state-dir
  assertEquals(second.message, first.message);
  assert(third.message.startsWith('Refusing to use the real per-user AIB folder'), third.message);
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
  name: 'package detection: the real GetCurrentPackageFullName binding agrees with the frozen answers',
  ignore: !WIN,
  async fn() {
    const py = new Frozen();
    using tmp = tempRoot();
    const env = { LOCALAPPDATA: tmp.root };
    assertEquals(packageContext({ env }), await py.call('state_paths', 'package_context', [env]));
  },
});

// ---- prepare -----------------------------------------------------------------------------------
Deno.test('prepare: a worktree keeps its own folder, an explicit folder is used as given, and nothing is created or moved; as the frozen answers say', async () => {
  const py = new Frozen();
  using tmp = tempRoot();
  const wt = checkout(tmp.root, 'wt', true);
  const main = checkout(tmp.root, 'main', false);
  const env = { LOCALAPPDATA: pathOf(tmp.root, 'local'), XDG_STATE_HOME: pathOf(tmp.root, 'local'), [ENV_TEST]: '1' };
  const wtOld = pathOf(tmp.root, 'wt', 'work', 'agent-studio-state');
  const worktree = await prepare({ env, codeRoot: wt });
  assertEquals(worktree.stateDir, wtOld);
  const chosen = pathOf(tmp.root, 'chosen');
  const explicit = await prepare({ cliStateDir: chosen, env, codeRoot: main });
  assertEquals(explicit.stateDir, chosen);
  assert(!exists(chosen), 'a --state-dir that does not exist yet is left for AIB to create');
  assert(!exists(pathOf(tmp.root, 'local')));
  for (const [cli, code] of [[null, wt], [chosen, main]] as const) {
    const mine = await prepare({ cliStateDir: cli, env, codeRoot: code });
    const theirs = await py.callFields(SHIM, 'prepare', [cli, null, legacy(code), env]);
    assertEquals({ stateDir: mine.stateDir, warnings: mine.warnings }, { stateDir: theirs.stateDir, warnings: theirs.warnings }, String(cli));
  }
});

// ---- owner-only access -------------------------------------------------------------------------
Deno.test('a fresh private folder passes the check, existing or newly made, with the same owner-only access list', () => {
  using tmp = tempRoot();
  const mine = pathOf(tmp.root, 'private');
  assertEquals(ensurePrivateDir(mine), true);
  assertEquals(aclProblems(mine), []);
  assertEquals(ensurePrivateDir(mine), false, 'existing and private: still fine');
  const other = pathOf(tmp.root, 'second-private');
  assertEquals(ensurePrivateDir(other), true);
  assertEquals(aclProblems(other), []);
  if (WIN) assertEquals(windowsDacl(mine), windowsDacl(other), 'the same owner-only DACL for every folder made');
});

Deno.test({
  name: 'Windows: Everyone, Users or Authenticated Users with write access fail, as the frozen answers',
  ignore: !WIN,
  fn() {
    using tmp = tempRoot();
    for (const [sid, name] of [['S-1-1-0', 'Everyone'], ['S-1-5-32-545', 'Users'], ['S-1-5-11', 'Authenticated Users']]) {
      const folder = pathOf(tmp.root, 'open-' + name.replaceAll(' ', ''));
      Deno.mkdirSync(folder);
      const out = new Deno.Command('icacls', { args: [folder, '/grant', `*${sid}:(OI)(CI)M`], stdout: 'null' }).outputSync();
      assertEquals(out.code, 0);
      const problems = aclProblems(folder);
      assert(problems.some((p) => p.includes(name)), `${name}: ${problems}`);
      assert(JSON.stringify(windowsDacl(folder)).includes(sid), `the open entry ${sid} is in the access list`);
      const error = assertThrows(() => ensurePrivateDir(folder, true), StateDirInsecure);
      assert(error.message.includes(name), error.message);
      const warnings: string[] = [];
      ensurePrivateDir(folder, false, (m) => warnings.push(m));
      assertEquals(warnings.length, 1);
    }
    const readable = pathOf(tmp.root, 'readable');
    Deno.mkdirSync(readable);
    new Deno.Command('icacls', { args: [readable, '/grant', '*S-1-5-32-545:(OI)(CI)R'], stdout: 'null' }).outputSync();
    assertEquals(aclProblems(readable), []);
    assert(windowsCurrentUserSid().startsWith('S-1-5-'));
  },
});

Deno.test({
  name: 'POSIX: mode 0700, and a group-writable folder is refused',
  ignore: WIN,
  fn() {
    using tmp = tempRoot();
    const folder = pathOf(tmp.root, 'private');
    ensurePrivateDir(folder);
    assertEquals(Deno.statSync(folder).mode! & 0o777, 0o700);
    Deno.chmodSync(folder, 0o770);
    const error = assertThrows(() => ensurePrivateDir(folder), StateDirInsecure);
    assert(error.message.includes(folder), error.message);
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
  await assertRejects(() => prepare({ env, codeRoot: main }), StateDirInsecure);
  const chosen = await prepare({ cliStateDir: user + '-x', env, codeRoot: main });
  assertEquals(chosen.warnings, []);
  Deno.mkdirSync(user + '-open');
  if (WIN) new Deno.Command('icacls', { args: [user + '-open', '/grant', '*S-1-1-0:(OI)(CI)M'], stdout: 'null' }).outputSync();
  else Deno.chmodSync(user + '-open', 0o777);
  const warned = await prepare({ cliStateDir: user + '-open', env, codeRoot: main });
  assertEquals(warned.warnings.length, 1, 'a folder chosen with --state-dir only warns');
});
