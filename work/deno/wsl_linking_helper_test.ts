/**
 * Linking (WSL) phase 2, the helper side (docs/wsl/linking-design.md section 12): env.prereqs (helper/prereqs.ts), agents.uninstall
 * (helper/agent_install.ts) and agents.signinStatus (helper/signin_status.ts), in-process with no distro. The checks are
 * path-agnostic, so they run on Windows too: env.prereqs gets fake programs (a runner, file checks) for each Node.js case, uninstall
 * a temp root with fake agent folders and a fake process list, signinStatus fake credential files in temp folders (and never a secret
 * in its answer). wsl_linking_helper_e2e_test.ts runs the same in a real distro.
 */
import { assert, assertEquals } from './_assert.ts';
import { makeMethods } from '../../app/server/wsl/helper/methods.ts';
import { installMethods, type ProcRow, procsUsing } from '../../app/server/wsl/helper/agent_install.ts';
import { handleLine, type Handlers } from '../../app/server/wsl/helper/rpc.ts';
import {
  asdfIsModern,
  atLeast,
  envModeOf,
  envPrereqs,
  managerOf,
  managerVersionOf,
  parseDf,
  pkgInstallLine,
  pkgManagerOf,
  type PrereqDeps,
  profileFor,
  type RunResult,
  versionParts,
  whichOn,
} from '../../app/server/wsl/helper/prereqs.ts';
import { displayAccount, signinStatus } from '../../app/server/wsl/helper/signin_status.ts';

const T = { sanitizeOps: false, sanitizeResources: false };
type Json = Record<string, unknown>;

async function rpc(handlers: Handlers, method: string, p: Json) {
  const reply = await handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: p }), handlers);
  return reply as { result?: Json; error?: { code: number; message: string; data?: { code?: string } } };
}

// ---- env.prereqs --------------------------------------------------------------------------------------------------------

const HOME = '/home/u';
const ASDF_SHIM = `${HOME}/.asdf/shims/node`;
const ASDF_REAL = `${HOME}/.asdf/installs/nodejs/24.22.1/bin/node`;
const ASDF_NPM = `${HOME}/.asdf/installs/nodejs/24.22.1/lib/node_modules/npm/bin/npm-cli.js`;

/** A fake distro: the files that exist, the executables, and what each program prints. */
function fakeDistro(o: {
  path: string;
  exes: string[];
  files?: string[];
  runs?: Record<string, RunResult | null>;
  npm?: Record<string, string>;
  shims?: string[];
  shell?: string;
  env?: Record<string, string>;
  free?: number | null;
  /** The text of /etc/os-release (none: the file is missing). */
  osRelease?: string;
}): PrereqDeps {
  const files = new Set([...(o.files ?? []), ...o.exes]);
  return {
    env: { PATH: o.path, HOME, ...o.env },
    home: HOME,
    arch: 'amd64',
    loginShell: o.shell ?? '/usr/bin/zsh',
    envMode: 'login-interactive',
    run: (argv) => Promise.resolve(o.runs?.[argv.join(' ')] ?? null),
    isFile: (p) => files.has(p),
    isExecutable: (p) => o.exes.includes(p),
    findNpmCli: (node) => o.npm?.[node] ?? '',
    isShim: (p) => (o.shims ?? []).includes(p),
    readText: (p) =>
      p.endsWith('/npm/package.json') ? JSON.stringify({ version: '11.6.0' }) : p === '/etc/os-release' ? o.osRelease ?? null : null,
    diskFree: () => Promise.resolve(o.free === undefined ? 5 * 1024 ** 3 : o.free),
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });
const UBUNTU = 'PRETTY_NAME="Ubuntu 24.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nID_LIKE=debian\n';

Deno.test('env.prereqs: helpers (df, versions, PATH lookup without /mnt, manager, profile file, env mode)', () => {
  assertEquals(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sdc 1000 10 2048 1% /\n'), 2048 * 1024);
  assertEquals(parseDf('nonsense'), null);
  assertEquals(versionParts('v22.19.0\n'), [22, 19, 0]);
  assertEquals(versionParts('No version is set'), null);
  assert(atLeast([22, 19, 0], [22, 19, 0]) && atLeast([24, 0, 0], [22, 19, 0]) && !atLeast([22, 18, 9], [22, 19, 0]));
  assertEquals(whichOn('node', '/mnt/c/nodejs:/usr/bin', (p) => p === '/mnt/c/nodejs/node' || p === '/usr/bin/node'), '/usr/bin/node');
  assertEquals(whichOn('node', '/mnt/c/nodejs', (p) => p === '/mnt/c/nodejs/node'), '', 'a Windows node.exe folder is never used');
  assertEquals(managerOf(ASDF_SHIM, {}, HOME), 'asdf');
  assertEquals(managerOf(`${HOME}/.local/share/mise/shims/node`, {}, HOME), 'mise');
  assertEquals(managerOf(`${HOME}/.nvm/versions/node/v24.1.0/bin/node`, {}, HOME), 'nvm');
  assertEquals(managerOf('/opt/n/bin/node', { NVM_DIR: '/opt/n' }, HOME), 'nvm');
  assertEquals(managerOf('/r/node/bin/node', {}, HOME, '/r'), 'aib');
  assertEquals(managerOf('/usr/bin/node', {}, HOME), 'system');
  assertEquals(profileFor('/usr/bin/zsh', {}, HOME), `${HOME}/.zshrc`);
  assertEquals(profileFor('/usr/bin/zsh', { ZDOTDIR: '/z' }, HOME), '/z/.zshrc');
  assertEquals(profileFor('/bin/bash', {}, HOME), `${HOME}/.bashrc`);
  assertEquals(profileFor('/usr/bin/fish', {}, HOME), '');
  assertEquals([envModeOf('-lic'), envModeOf('-lc'), envModeOf('none')], ['login-interactive', 'login', 'plain']);
});

Deno.test('env.prereqs: an asdf shim with no npm beside it is ok (npm next to the node it really runs), manager asdf, no nvm offer', async () => {
  const got = await envPrereqs(fakeDistro({
    path: `${HOME}/.asdf/shims:/usr/bin:/mnt/c/Windows`,
    exes: [ASDF_SHIM, '/usr/bin/git', '/usr/bin/curl'],
    files: [ASDF_NPM, `${HOME}/.zshrc`],
    shims: [ASDF_SHIM],
    runs: {
      [`${ASDF_SHIM} --version`]: ok('v24.22.1\n'),
      [`${ASDF_SHIM} -p process.execPath`]: ok(`${ASDF_REAL}\n`),
      '/usr/bin/git --version': ok('git version 2.43.0\n'),
    },
    npm: { [ASDF_REAL]: ASDF_NPM },
  }));
  assertEquals(got.node, { state: 'ok', manager: 'asdf', path: ASDF_SHIM, version: '24.22.1' });
  assertEquals(got.npm, { state: 'ok', version: '11.6.0' });
  assertEquals(got.git, { state: 'ok', version: '2.43.0' });
  assertEquals(got.curl, { state: 'ok' });
  assertEquals([got.diskFreeMB, got.arch, got.loginShell, got.envMode, got.nvm], [5120, 'amd64', '/usr/bin/zsh', 'login-interactive', {
    present: false,
  }]);
  assertEquals(got.canInstallNode, false);
  assert(String(got.nodeInstallBlocked).includes('managed by asdf'), String(got.nodeInstallBlocked));
});

Deno.test('env.prereqs: missing, old, shim with no version set, broken; nvm offer only with bash/zsh and its start-up file and curl', async () => {
  const missing = await envPrereqs(fakeDistro({ path: '/usr/bin', exes: ['/usr/bin/curl'], files: [`${HOME}/.zshrc`] }));
  assertEquals([missing.node.state, missing.node.manager, missing.npm.state, missing.git.state], ['missing', '', 'missing', 'missing']);
  assertEquals([missing.canInstallNode, missing.nodeInstallBlocked], [true, undefined]);

  const old = await envPrereqs(fakeDistro({
    path: '/usr/bin',
    exes: ['/usr/bin/node', '/usr/bin/curl'],
    files: [`${HOME}/.bashrc`, '/usr/share/nodejs/npm/bin/npm-cli.js'],
    shell: '/bin/bash',
    runs: { '/usr/bin/node --version': ok('v18.19.1\n'), '/usr/bin/node -p process.execPath': ok('/usr/bin/node\n') },
    npm: { '/usr/bin/node': '/usr/share/nodejs/npm/bin/npm-cli.js' },
  }));
  assertEquals([old.node.state, old.node.version, old.node.manager, old.npm.state], ['old', '18.19.1', 'system', 'ok']);
  assert(String(old.node.note).includes('22.19.0'), String(old.node.note));
  assertEquals(old.canInstallNode, true);

  const unset = await envPrereqs(fakeDistro({
    path: `${HOME}/.asdf/shims:/usr/bin`,
    exes: [ASDF_SHIM, '/usr/bin/curl'],
    files: [`${HOME}/.zshrc`],
    shims: [ASDF_SHIM],
    runs: { [`${ASDF_SHIM} --version`]: { code: 126, stdout: '', stderr: 'No version is set for command node\n' } },
  }));
  assertEquals([unset.node.state, unset.node.manager, unset.npm.state, unset.canInstallNode], ['shim_unset', 'asdf', 'missing', false]);
  assert(String(unset.node.note).includes('asdf set -u nodejs'), String(unset.node.note));
  assert(String(unset.nodeInstallBlocked).includes('asdf'), String(unset.nodeInstallBlocked));

  const broken = await envPrereqs(fakeDistro({
    path: '/usr/local/bin',
    exes: ['/usr/local/bin/node', '/usr/bin/curl'],
    runs: { '/usr/local/bin/node --version': { code: 139, stdout: '', stderr: 'Segmentation fault' } },
  }));
  assertEquals([broken.node.state, broken.node.manager], ['broken', 'system']);
  assert(String(broken.node.note).includes('/usr/local/bin/node'), String(broken.node.note));

  const fish = await envPrereqs(fakeDistro({ path: '/usr/bin', exes: ['/usr/bin/curl'], shell: '/usr/bin/fish' }));
  assertEquals(fish.canInstallNode, false);
  assert(String(fish.nodeInstallBlocked).includes('fish'), String(fish.nodeInstallBlocked));
  const noRc = await envPrereqs(fakeDistro({ path: '/usr/bin', exes: ['/usr/bin/curl'] }));
  assert(
    !noRc.canInstallNode && String(noRc.nodeInstallBlocked).includes(`${HOME}/.zshrc does not exist`),
    String(noRc.nodeInstallBlocked),
  );
  const noCurl = await envPrereqs(fakeDistro({ path: '/usr/bin', exes: [], files: [`${HOME}/.zshrc`], free: null, osRelease: UBUNTU }));
  assertEquals([noCurl.curl.state, noCurl.canInstallNode, noCurl.diskFreeMB], ['missing', false, null]);
  assert(String(noCurl.nodeInstallBlocked).includes('sudo apt install curl'));
  const nvm = await envPrereqs(fakeDistro({ path: '/usr/bin', exes: ['/usr/bin/curl'], files: [`${HOME}/.zshrc`, `${HOME}/.nvm/nvm.sh`] }));
  assertEquals(nvm.nvm, { present: true });
});

Deno.test('env.prereqs: the package manager family from /etc/os-release ID / ID_LIKE and the programs found; copy-only lines per family', async () => {
  const exe = (...ps: string[]) => (p: string) => ps.includes(p);
  const rel = (id: string, like = '') => `NAME="x"\nID=${id}\n${like ? `ID_LIKE="${like}"\n` : ''}VERSION_ID="1"\n`;
  assertEquals(pkgManagerOf(UBUNTU, '/usr/bin', exe('/usr/bin/apt-get')), 'apt');
  assertEquals(pkgManagerOf(rel('debian'), '/usr/bin', exe()), 'apt', 'os-release alone is enough');
  assertEquals(pkgManagerOf(rel('fedora'), '/usr/bin', exe('/usr/bin/dnf')), 'dnf');
  assertEquals(pkgManagerOf(rel('almalinux', 'rhel centos fedora'), '/usr/bin', exe('/usr/bin/dnf')), 'dnf');
  assertEquals(pkgManagerOf(rel('centos', 'rhel fedora'), '/usr/bin', exe('/usr/bin/yum')), 'yum', 'an old CentOS has only yum');
  assertEquals(pkgManagerOf(rel('opensuse-tumbleweed', 'opensuse suse'), '/usr/bin', exe('/usr/bin/zypper')), 'zypper');
  assertEquals(pkgManagerOf(rel('sles'), '/usr/bin', exe()), 'zypper');
  assertEquals(pkgManagerOf(rel('archlinux', 'arch'), '/usr/bin', exe('/usr/bin/pacman')), 'pacman');
  assertEquals(pkgManagerOf(rel('manjaro'), '/usr/bin', exe()), 'pacman');
  assertEquals(pkgManagerOf(rel('alpine'), '/usr/bin', exe('/sbin/apk')), 'apk');
  assertEquals(pkgManagerOf(rel('kali', 'debian'), '/usr/bin', exe()), 'apt', 'a derivative by its ID_LIKE');
  assertEquals(pkgManagerOf(null, '/home/u/bin', exe('/usr/sbin/zypper')), 'zypper', 'no os-release: the program found (system folders too)');
  assertEquals(pkgManagerOf(rel('nixos'), '/run/current-system/sw/bin', exe()), 'unknown');
  assertEquals(pkgManagerOf(null, '/usr/bin', exe()), 'unknown');
  assertEquals(
    (['apt', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'unknown'] as const).map((pm) => pkgInstallLine(pm, 'git')),
    ['sudo apt install git', 'sudo dnf install git', 'sudo yum install git', 'sudo zypper install git', 'sudo pacman -S git', 'sudo apk add git', ''],
  );
  // in the answer, and in the curl reason that blocks the nvm offer
  const fedora = await envPrereqs(fakeDistro({ path: '/usr/bin', exes: ['/usr/bin/dnf'], files: [`${HOME}/.zshrc`], osRelease: rel('fedora') }));
  assertEquals(fedora.pkgManager, 'dnf');
  assert(String(fedora.nodeInstallBlocked).includes('sudo dnf install curl'), String(fedora.nodeInstallBlocked));
  const nix = await envPrereqs(fakeDistro({ path: '/usr/bin', exes: [], files: [`${HOME}/.zshrc`], osRelease: rel('nixos') }));
  assertEquals(nix.pkgManager, 'unknown');
  assert(String(nix.nodeInstallBlocked).includes("Install curl with your distro's package manager"), String(nix.nodeInstallBlocked));
  assertEquals((await envPrereqs(fakeDistro({ path: '/usr/bin', exes: ['/usr/bin/curl'], osRelease: UBUNTU }))).pkgManager, 'apt');
});

Deno.test("env.prereqs: asdf's own version picks its generation's command (0.16+ asdf set -u, older asdf global); unknown names both", async () => {
  assertEquals(managerVersionOf('asdf version v0.18.0 (revision 2114f1e)\n'), '0.18.0');
  assertEquals(managerVersionOf('v0.15.0-31e8c93\n'), '0.15.0');
  assertEquals(managerVersionOf('2025.11.3 linux-x64 (2025-11-20)'), '2025.11.3');
  assertEquals(managerVersionOf('nonsense'), '');
  assertEquals([asdfIsModern('0.16.0'), asdfIsModern('0.18.0'), asdfIsModern('0.15.0'), asdfIsModern('')], [true, true, false, null]);
  const unsetWith = (asdfSays: RunResult | null) =>
    envPrereqs(fakeDistro({
      path: `${HOME}/.asdf/shims:/usr/bin`,
      exes: [ASDF_SHIM, '/usr/bin/curl', '/usr/local/bin/asdf'],
      files: [`${HOME}/.zshrc`],
      shims: [ASDF_SHIM],
      runs: {
        [`${ASDF_SHIM} --version`]: { code: 126, stdout: '', stderr: 'No version is set for command node\n' },
        '/usr/local/bin/asdf --version': asdfSays,
      },
    }));
  const modern = await unsetWith(ok('asdf version v0.18.0 (revision 2114f1e)\n'));
  assertEquals([modern.node.state, modern.node.managerVersion], ['shim_unset', '0.18.0']);
  assert(String(modern.node.note).endsWith('asdf set -u nodejs latest'), String(modern.node.note));
  assert(!String(modern.node.note).includes('asdf global'), String(modern.node.note));
  const legacy = await unsetWith(ok('v0.14.1-f00f00f\n'));
  assertEquals(legacy.node.managerVersion, '0.14.1');
  assert(String(legacy.node.note).endsWith('asdf global nodejs latest') && !String(legacy.node.note).includes('asdf set'), String(legacy.node.note));
  const unknown = await unsetWith(null);
  assertEquals('managerVersion' in unknown.node, false);
  assert(String(unknown.node.note).includes('asdf set -u nodejs latest (asdf older than 0.16: asdf global nodejs latest)'), String(unknown.node.note));
});

Deno.test({
  name:
    'env.prereqs through the helper: force reads the login environment again first; envMode from the capture; all three methods are listed',
  ...T,
  async fn() {
    const calls: string[] = [];
    const root = Deno.makeTempDirSync({ prefix: 'aib-linking-' });
    addEventListener('unload', () => Deno.removeSync(root, { recursive: true }));
    const methods = makeMethods({
      env: () => Promise.resolve({ env: { PATH: '/nowhere', HOME }, shell: '/bin/bash', home: HOME, arch: 'arm64' }),
      root,
      refreshPath: () => (calls.push('refresh'), Promise.resolve()),
      envMode: () => 'login',
      prereqDeps: { isExecutable: () => false, isFile: () => false, diskFree: () => Promise.resolve(null) },
    });
    for (const name of ['env.prereqs', 'agents.uninstall', 'agents.signinStatus']) assert(name in methods, name);
    const first = (await rpc(methods, 'env.prereqs', {})).result!;
    assertEquals([first.arch, first.loginShell, first.envMode, (first.node as Json).state, calls.length], [
      'arm64',
      '/bin/bash',
      'login',
      'missing',
      0,
    ]);
    await rpc(methods, 'env.prereqs', { force: true });
    assertEquals(calls, ['refresh']);
  },
});

// ---- agents.uninstall ---------------------------------------------------------------------------------------------------

function uninstallHelper(root: string, procs: () => Promise<ProcRow[] | null>) {
  return installMethods({ root, notify: () => {}, nodeCommand: 'node-never', diskFree: () => 10 ** 12, processes: procs });
}

function fakeInstall(root: string, id: string, version: string): string {
  const folder = `${root}/agents/${id}/${version}`;
  Deno.mkdirSync(`${folder}/node_modules/x`, { recursive: true });
  Deno.writeTextFileSync(`${folder}/node_modules/x/index.js`, '//\n');
  Deno.writeTextFileSync(`${folder}/.complete`, '');
  return folder;
}

const exists = (p: string) => {
  try {
    Deno.lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

Deno.test({
  name:
    'agents.uninstall: removes every version of that agent only, idempotent, refused while a process runs from it or the list is unreadable',
  ...T,
  async fn() {
    const root = Deno.makeTempDirSync({ prefix: 'aib-linking-un-' }).replaceAll('\\', '/');
    try {
      let rows: ProcRow[] | null = [{ pid: 1, exe: '/sbin/init', cmdline: '/sbin/init' }];
      const h = uninstallHelper(root, () => Promise.resolve(rows));
      assertEquals((await rpc(h, 'agents.uninstall', { id: 'claude' })).result, { ok: true, removed: [] }, 'nothing installed: ok');
      const a = fakeInstall(root, 'claude', '0.101.0');
      const b = fakeInstall(root, 'claude', '0.102.0');
      const other = fakeInstall(root, 'codex', '2.6.0');
      Deno.writeTextFileSync(`${root}/agents/claude/install.json`, '{"state":"done"}');

      rows = [...rows!, { pid: 4242, exe: '/usr/bin/node', cmdline: `/usr/bin/node ${b}/node_modules/x/index.js` }];
      const busy = (await rpc(h, 'agents.uninstall', { id: 'claude' })).result!;
      assertEquals([busy.ok, busy.blocked, busy.removed], [false, 'running', []]);
      assert(String(busy.message).includes('4242') && String(busy.message).includes('Claude Code'), String(busy.message));
      assert(exists(a) && exists(b), 'nothing removed while it runs');

      rows = null;
      const unknown = (await rpc(h, 'agents.uninstall', { id: 'claude' })).result!;
      assertEquals([unknown.ok, unknown.blocked], [false, 'unchecked']);

      rows = [{ pid: 7, exe: `${other}/bin/codex`, cmdline: 'codex' }]; // Codex running does not block Claude Code
      const done = (await rpc(h, 'agents.uninstall', { id: 'claude' })).result!;
      assertEquals([done.ok, (done.removed as string[]).sort()], [true, ['0.101.0', '0.102.0']]);
      assert(!exists(a) && !exists(b) && !exists(`${root}/agents/claude/install.json`), 'all versions and the job file are gone');
      assert(exists(other), "the other agent's folder stays");
      assertEquals((await rpc(h, 'agents.uninstall', { id: 'claude' })).result, { ok: true, removed: [] }, 'again: ok, nothing');

      const bad = await rpc(h, 'agents.uninstall', { id: 'omp' });
      assertEquals(bad.error?.data?.code, 'install_refused');
      assertEquals((await rpc(h, 'agents.uninstall', { id: '../codex' })).error?.data?.code, 'install_refused');
      assert(exists(other));
    } finally {
      Deno.removeSync(root, { recursive: true });
    }
  },
});

Deno.test({
  name: 'agents.uninstall: refused while another live process holds the install lock',
  ...T,
  async fn() {
    const root = Deno.makeTempDirSync({ prefix: 'aib-linking-lock-' }).replaceAll('\\', '/');
    const child = new Deno.Command(Deno.execPath(), {
      args: ['eval', 'setTimeout(() => {}, 30000)'],
      stdout: 'null',
      stderr: 'null',
      stdin: 'null',
    }).spawn();
    try {
      const folder = fakeInstall(root, 'codex', '2.6.0');
      Deno.writeTextFileSync(`${root}/agents/codex/install.lock`, JSON.stringify({ pid: child.pid }));
      const h = uninstallHelper(root, () => Promise.resolve([]));
      const got = (await rpc(h, 'agents.uninstall', { id: 'codex' })).result!;
      assertEquals([got.ok, got.blocked], [false, 'installing']);
      assert(exists(folder));
    } finally {
      child.kill();
      await child.status;
      Deno.removeSync(root, { recursive: true });
    }
  },
});

Deno.test('agents.uninstall: procsUsing matches a program or command line inside the folder, never this process', () => {
  const rows: ProcRow[] = [
    { pid: 1, exe: '/r/agents/claude/1.0.0/x/claude', cmdline: 'claude' },
    { pid: 2, exe: '/usr/bin/node', cmdline: 'node /r/agents/claude/1.0.0/dist/index.js' },
    { pid: 3, exe: '/usr/bin/node', cmdline: 'node /r/agents/claudette/index.js' },
    { pid: Deno.pid, exe: '/r/agents/claude/helper', cmdline: '' },
  ];
  assertEquals(procsUsing(rows, ['/r/agents/claude']).map((r) => r.pid), [1, 2]);
});

// ---- agents.signinStatus ------------------------------------------------------------------------------------------------

const SECRET = 'sk-ant-oat01-FAKE-SECRET-TOKEN-0123456789';

Deno.test({
  name: 'agents.signinStatus: credential files read for shape only, CLAUDE_CONFIG_DIR / CODEX_HOME honoured, no secret in the answer',
  ...T,
  async fn() {
    const tmp = Deno.makeTempDirSync({ prefix: 'aib-linking-signin-' }).replaceAll('\\', '/');
    try {
      const claude = `${tmp}/cc`, codex = `${tmp}/cx`, home = `${tmp}/home`;
      for (const d of [claude, codex, home]) Deno.mkdirSync(d, { recursive: true });
      const env = { HOME: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex, PATH: '/usr/bin' };
      const methods = makeMethods({ env: () => Promise.resolve({ env, shell: '/bin/sh', home, arch: 'amd64' }) });
      const status = async (ids?: string[]) => {
        const reply = await rpc(methods, 'agents.signinStatus', ids ? { ids } : {});
        assert(!JSON.stringify(reply).includes(SECRET) && !JSON.stringify(reply).includes('FAKE-SECRET'), 'a secret leaked');
        return (reply.result!.agents as Json[]);
      };

      assertEquals(await status(), [
        { id: 'claude', state: 'signed_out' },
        { id: 'codex', state: 'signed_out' },
      ]);

      Deno.writeTextFileSync(
        `${claude}/.credentials.json`,
        JSON.stringify({ claudeAiOauth: { accessToken: SECRET, refreshToken: SECRET, expiresAt: 1 } }),
      );
      Deno.writeTextFileSync(
        `${claude}/.claude.json`,
        JSON.stringify({ oauthAccount: { emailAddress: 'kim@example.com', accountUuid: SECRET }, userID: SECRET }),
      );
      Deno.writeTextFileSync(
        `${codex}/auth.json`,
        JSON.stringify({ OPENAI_API_KEY: null, tokens: { id_token: SECRET, access_token: SECRET } }),
      );
      assertEquals(await status(['claude', 'codex']), [
        { id: 'claude', state: 'signed_in', account: 'kim@example.com' },
        { id: 'codex', state: 'signed_in' },
      ]);

      // a broken file quoting the token: unknown, and the parse error (which can quote the file) is not passed on
      Deno.writeTextFileSync(`${claude}/.credentials.json`, `{"claudeAiOauth": ${SECRET}`);
      Deno.writeTextFileSync(`${codex}/auth.json`, JSON.stringify({ OPENAI_API_KEY: '', tokens: null }));
      const [c, x] = await status(['claude', 'codex']);
      assertEquals([c.state, x.state], ['unknown', 'signed_out']);

      // Codex with its keyring store: auth.json says nothing
      Deno.removeSync(`${codex}/auth.json`);
      Deno.writeTextFileSync(`${codex}/config.toml`, 'model = "o3"\ncli_auth_credentials_store = "keyring"\n');
      assertEquals((await status(['codex']))[0].state, 'unknown');
      assertEquals((await status(['gemini']))[0].state, 'unknown');
      assertEquals((await rpc(methods, 'agents.signinStatus', { ids: ['../x'] })).error?.code, -32602);
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});

Deno.test('agents.signinStatus: an API key in the login environment counts, its value never shown; display account rules', () => {
  const tmp = Deno.makeTempDirSync({ prefix: 'aib-linking-key-' }).replaceAll('\\', '/');
  try {
    const rows = signinStatus(['claude'], { HOME: tmp, ANTHROPIC_API_KEY: SECRET }, tmp);
    assertEquals(rows, [{ id: 'claude', state: 'signed_in', note: 'Uses ANTHROPIC_API_KEY from the login environment.' }]);
    assertEquals(signinStatus(['claude'], {}, ''), [{ id: 'claude', state: 'unknown', note: 'The distro user has no home folder.' }]);
    assertEquals([displayAccount('a@b.c'), displayAccount('not an email'), displayAccount(5), displayAccount('x'.repeat(300) + '@b')], [
      'a@b.c',
      '',
      '',
      '',
    ]);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
