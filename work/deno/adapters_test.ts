/**
 * server/agents/adapters.ts: the cases of work/test_adapters.py and test_studio_install_lookup.py that need no whole Studio, plus
 * parity with adapters.py on the same temp fixtures. No real npm folder or machine install decides a result.
 */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { join, makeInstall, PY, PY_REAL, SEP, tempDir, touch } from './_agents.ts';
import * as adapters from '../../outputs/agent-studio/server/agents/adapters.ts';

const CLAUDE = '@agentclientprotocol/claude-agent-acp';
const WIN = Deno.build.os === 'windows';

/** The fixture of test_adapters.Fixture: a temp root with one global npm folder holding the Claude adapter. */
function fixture() {
  const dir = tempDir();
  const modules = join(dir.root, 'global', 'node_modules');
  const installed = touch(join(modules, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'));
  const codexInstalled = join(modules, '@zed-industries', 'codex-acp', 'bin', 'codex-acp.js');
  adapters.resetCache();
  adapters.adapterHooks.globalRoots = () => [modules];
  return {
    root: dir.root,
    state: join(dir.root, 'state'),
    modules,
    installed,
    codexInstalled,
    [Symbol.dispose]() {
      delete adapters.adapterHooks.globalRoots;
      delete adapters.adapterHooks.findNode;
      dir[Symbol.dispose]();
    },
  };
}

const claude = (flag = '', saved = '', node = PY, stateDir: string | null = null) =>
  adapters.resolveClaude({ flag, saved, nodeCommand: node, stateDir });

// ---- launcher precedence (test_adapters.LauncherPrecedenceTests) ---------------------------------------------------------

Deno.test('the installed adapter is run with node from its dist/index.js', async () => {
  using f = fixture();
  const row = await claude();
  assert(row.found, JSON.stringify(row));
  assertEquals([row.source, row.argv], ['installed', [PY_REAL, f.installed]]);
  assert(row.argv[1].endsWith('index.js'), 'the .cmd shim is never started');
});

Deno.test('flag beats saved launcher beats installed', async () => {
  using f = fixture();
  const flag = touch(join(f.root, 'flag.js'));
  const saved = touch(join(f.root, 'saved.js'));
  assertEquals((await claude(flag, saved)).argv.slice(1), [Deno.realPathSync(flag)]);
  assertEquals((await claude(flag, saved)).source, 'flag');
  assertEquals((await claude('', saved)).argv.slice(1), [Deno.realPathSync(saved)]);
  assertEquals((await claude('', saved)).source, 'settings');
  assertEquals((await claude()).source, 'installed');
});

Deno.test('a missing flag launcher is an error, not a silent fallback', async () => {
  using f = fixture();
  const row = await claude(join(f.root, 'gone.js'));
  assert(!row.found);
  assert(row.problem.includes('not found'));
});

Deno.test('nothing installed says not installed with the install command', async () => {
  using f = fixture();
  Deno.removeSync(f.installed);
  const row = await claude();
  assertEquals([row.found, row.source, row.text], [false, 'missing', 'Not installed']);
  assert(row.problem.includes('npm i -g @agentclientprotocol/claude-agent-acp'));
});

// ---- Codex (test_adapters.CodexTests) ------------------------------------------------------------------------------------

Deno.test('the Codex problem text depends on signs of Codex', async () => {
  using _f = fixture();
  const withCodex = await adapters.resolveCodex({ nodeCommand: PY, onPath: () => '', codexPresent: () => true });
  assertEquals(withCodex.problem, 'The Codex app is on this PC, but Studio needs its ACP adapter.');
  assertEquals([withCodex.found, withCodex.text], [false, 'Not installed']);
  const without = await adapters.resolveCodex({ nodeCommand: PY, onPath: () => '', codexPresent: () => false });
  assert(without.problem.startsWith('Not installed.'));
});

Deno.test('signs that Codex itself is installed', () => {
  using f = fixture();
  const home = join(f.root, 'home');
  const local = join(f.root, 'local');
  Deno.mkdirSync(home);
  Deno.mkdirSync(local);
  const look = (which: (n: string) => string | null = () => null, win = true) =>
    adapters.codexLooksInstalled({ which, home, localAppdata: local, systemWindows: win });
  assert(!look());
  assert(look((n) => (n === 'codex' ? 'C:/bin/codex.exe' : null)));
  Deno.mkdirSync(join(home, '.codex'));
  assert(look(undefined, false));
  Deno.removeSync(join(home, '.codex'));
  Deno.mkdirSync(join(local, 'Packages', 'OpenAI.Codex_abc'), { recursive: true });
  assert(look());
  assert(!look(undefined, false));
  Deno.removeSync(join(local, 'Packages', 'OpenAI.Codex_abc'));
  touch(join(local, 'Microsoft', 'WindowsApps', 'codex-1.exe'));
  assert(look());
});

Deno.test('Codex shows not installed when missing', async () => {
  using _f = fixture();
  const row = await adapters.resolveCodex({ nodeCommand: PY, onPath: () => '' });
  assertEquals([row.found, row.source, row.text], [false, 'missing', 'Not installed']);
});

Deno.test('Codex is found in the npm global folder, then on PATH', async () => {
  using f = fixture();
  touch(f.codexInstalled);
  let row = await adapters.resolveCodex({ nodeCommand: PY, onPath: () => '/nope/codex-acp' });
  assertEquals([row.found, row.source], [true, 'installed']);
  assertEquals(row.argv, [PY_REAL, f.codexInstalled]);
  Deno.removeSync(f.codexInstalled);
  const native = touch(join(f.root, 'bin', 'codex-acp'));
  row = await adapters.resolveCodex({ nodeCommand: PY, onPath: () => native });
  assertEquals([row.found, row.source, row.argv], [true, 'path', [native]]);
});

// ---- OMP (test_adapters.OmpLookupTests) ----------------------------------------------------------------------------------

Deno.test('the OMP Windows fallback is used only on Windows', () => {
  using f = fixture();
  const exe = touch(join(f.root, 'omp', 'omp.exe'));
  assertEquals(adapters.defaultOmpCommand({ which: () => null, systemWindows: true, localAppdata: f.root }), exe);
  assertEquals(
    adapters.defaultOmpCommand({ which: () => null, systemWindows: false, localAppdata: f.root }),
    '',
    'elsewhere: PATH or not installed',
  );
  assertEquals(adapters.defaultOmpCommand({ which: (n) => (n === 'omp' ? '/usr/bin/omp' : null), systemWindows: false }), '/usr/bin/omp');
  assertEquals(adapters.defaultOmpCommand({ which: () => null, systemWindows: true, localAppdata: join(f.root, 'none') }), '');
});

Deno.test('a missing OMP is not installed', () => {
  const row = adapters.resolveOmp('');
  assertEquals([row.found, row.text], [false, 'Not installed']);
  assert(adapters.resolveOmp(PY).found);
  assertEquals(adapters.resolveOmp(PY).argv.slice(1), ['acp']);
});

// ---- login-shell PATH (test_adapters.LoginShellPathTests) ----------------------------------------------------------------

const S = adapters.PATH_START, E = adapters.PATH_END;
const BAD_MARKED: unknown[] = [
  '',
  'no markers',
  `${S}/usr/bin`,
  `${E}/usr/bin${S}`,
  `${S}${E}`,
  `${S}/a\n/b${E}`,
  `${S}/a\x00b${E}`,
  null,
  5,
];

Deno.test('parse takes the text between the markers', () => {
  assertEquals(adapters.parseMarkedPath(`Welcome back!\nmotd\n${S}/usr/local/bin:/usr/bin${E}\n`), '/usr/local/bin:/usr/bin');
  assertEquals(adapters.parseMarkedPath(`${S}/old${E} noise ${S}/new:/bin${E}`), '/new:/bin', 'the last pair wins');
  for (const bad of BAD_MARKED) assertEquals(adapters.parseMarkedPath(bad), '', String(bad));
});

Deno.test('merge puts login entries first without repeats', () => {
  assertEquals(adapters.mergePaths('/a:/b', '/b:/c::', ':'), '/a:/b:/c');
  assertEquals(adapters.mergePaths('', '/x:/y', ':'), '/x:/y');
});

Deno.test('the login shell runs without the interactive flag and with a timeout', async () => {
  const seen: { argv?: string[]; options?: Record<string, unknown> } = {};
  const run: adapters.RunFn = (argv, options) => {
    Object.assign(seen, { argv, options });
    return Promise.resolve({ stdout: `banner\n${S}/opt/x/bin:/usr/bin${E}` });
  };
  assertEquals(await adapters.loginShellPath({ SHELL: PY, PATH: '/usr/bin' }, 'Linux', run), '/opt/x/bin:/usr/bin');
  assertEquals(seen.argv!.slice(0, 3), [PY, '-l', '-c']);
  assert(!seen.argv!.includes('-i'));
  assert(seen.argv![3].includes('printf %s "$PATH"'));
  assertEquals(seen.options!.timeout, 3.0);
  assertEquals(seen.options!.stdin, 'null');
});

Deno.test('a timeout, a failure or a bad shell gives nothing', async () => {
  const failing: adapters.RunFn = () => Promise.reject(new Error('timed out'));
  const never: adapters.RunFn = () => {
    throw new Error('must not run');
  };
  assertEquals(await adapters.loginShellPath({ SHELL: PY }, 'Linux', failing), '');
  for (const shell of ['', 'bash', '/no/such/shell']) assertEquals(await adapters.loginShellPath({ SHELL: shell }, 'Linux', never), '');
  assertEquals(await adapters.loginShellPath({}, 'Linux', never), '');
});

Deno.test('Windows is a no-op', async () => {
  const never: adapters.RunFn = () => {
    throw new Error('must not run');
  };
  const env = { SHELL: PY, PATH: 'C:\\x' };
  assertEquals(await adapters.loginShellPath(env, 'Windows', never), '');
  assertEquals(await adapters.initEnvironment(env, 'Windows', never), '');
  assertEquals(env.PATH, 'C:\\x');
});

Deno.test('initEnvironment merges into the given environment', async () => {
  const env: Record<string, string> = { SHELL: PY, PATH: '/usr/bin:/bin' };
  const run: adapters.RunFn = () => Promise.resolve({ stdout: `${S}/opt/homebrew/bin:/usr/bin${E}` });
  const added = await adapters.initEnvironment(env, 'Darwin', run);
  assertEquals(env.PATH, '/opt/homebrew/bin:/usr/bin:/bin');
  assertEquals(added, env.PATH);
  assertEquals(await adapters.initEnvironment(env, 'Darwin', run), '', 'nothing new the second time');
  const env2: Record<string, string> = { SHELL: PY, PATH: '/usr/bin' };
  assertEquals(await adapters.initEnvironment(env2, 'Darwin', () => Promise.resolve({ stdout: '' })), '');
  assertEquals(env2.PATH, '/usr/bin', 'a failed shell leaves PATH alone');
});

// ---- Studio's own installs (test_studio_install_lookup.StudioInstallLookup) ----------------------------------------------

Deno.test('a complete install is found and run with node', async () => {
  using f = fixture();
  Deno.removeSync(join(f.modules, '@agentclientprotocol'), { recursive: true });
  const [, pkg] = makeInstall(f.state, 'claude', '0.102.0', CLAUDE);
  const row = await claude('', '', PY, f.state);
  assert(row.found, JSON.stringify(row));
  assertEquals(row.source, 'studio');
  assertEquals(row.argv, [PY_REAL, Deno.realPathSync(join(pkg, 'dist', 'index.js'))]);
});

Deno.test('a folder without the complete marker is ignored', async () => {
  using f = fixture();
  Deno.removeSync(join(f.modules, '@agentclientprotocol'), { recursive: true });
  makeInstall(f.state, 'claude', '0.102.0', CLAUDE, { complete: false });
  const row = await claude('', '', PY, f.state);
  assertEquals([row.found, row.source], [false, 'missing']);
});

Deno.test('a half-made newer folder does not hide an older complete one', async () => {
  using f = fixture();
  makeInstall(f.state, 'claude', '0.101.0', CLAUDE);
  makeInstall(f.state, 'claude', '0.102.0', CLAUDE, { complete: false });
  assert((await claude('', '', PY, f.state)).path.includes('0.101.0'));
});

Deno.test('the newest complete version wins by number, not by text', () => {
  using f = fixture();
  for (const version of ['0.9.0', '0.10.0', '0.2.0']) makeInstall(f.state, 'claude', version, CLAUDE);
  makeInstall(f.state, 'claude', '0.11.0-preview.1', CLAUDE);
  assertEquals(adapters.findStudioInstall('claude', f.state)!.version, '0.11.0-preview.1');
  makeInstall(f.state, 'claude', '0.11.0', CLAUDE);
  assertEquals(adapters.findStudioInstall('claude', f.state)!.version, '0.11.0', 'a release beats its own prerelease');
});

Deno.test('order: flag, then Settings, then Studio, then global, then missing', async () => {
  using f = fixture();
  const flag = touch(join(f.root, 'flag.js'), '//');
  const saved = touch(join(f.root, 'saved.js'), '//');
  makeInstall(f.state, 'claude', '0.102.0', CLAUDE);
  const order = async (fl: string, sv: string) => (await claude(fl, sv, PY, f.state)).source;
  assertEquals(await order(flag, saved), 'flag');
  assertEquals(await order('', saved), 'settings');
  assertEquals(await order('', ''), 'studio');
  assertEquals((await claude('', '', PY, join(f.root, 'nowhere'))).source, 'installed');
  assertEquals((await claude('', '', PY)).source, 'installed');
  Deno.renameSync(join(f.modules, '@agentclientprotocol'), join(f.root, 'gone'));
  assertEquals((await claude('', '', PY, join(f.root, 'nowhere'))).source, 'missing');
});

Deno.test('Codex order and both package names', async () => {
  using f = fixture();
  const options = { nodeCommand: PY, onPath: () => '', codexPresent: () => false, stateDir: f.state };
  assertEquals((await adapters.resolveCodex(options)).source, 'missing');
  makeInstall(f.state, 'codex', '1.0.0', '@zed-industries/codex-acp', { bin: null, files: ['bin/codex-acp.js'] });
  let row = await adapters.resolveCodex(options);
  assertEquals(row.source, 'studio');
  assert(row.path.endsWith('codex-acp.js'), 'the known path is used when package.json has no bin');
  makeInstall(f.state, 'codex', '2.6.0', '@agentclientprotocol/codex-acp', { bin: { 'codex-acp': 'dist/index.js' } });
  row = await adapters.resolveCodex(options);
  assert(row.path.replaceAll('\\', '/').endsWith('@agentclientprotocol/codex-acp/dist/index.js'), row.path);
});

Deno.test('the entry comes from the bin field', () => {
  using f = fixture();
  makeInstall(f.state, 'claude', '0.102.0', CLAUDE, { bin: { 'claude-agent-acp': 'lib/start.js' }, files: ['lib/start.js'] });
  assert(adapters.findStudioInstall('claude', f.state)!.entry.replaceAll('\\', '/').endsWith('claude-agent-acp/lib/start.js'));
});

Deno.test('a bin that escapes the version folder is refused', async () => {
  using f = fixture();
  Deno.removeSync(join(f.modules, '@agentclientprotocol'), { recursive: true });
  const secret = touch(join(f.root, 'outside.js'), '//');
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const hostile of ['../../../../../../outside.js', secret, { 'claude-agent-acp': '../../../../../../outside.js' }]) {
      const [folder] = makeInstall(f.state, 'claude', '9.9.9', CLAUDE, { bin: hostile, files: [] });
      assertEquals(adapters.findStudioInstall('claude', f.state), null, JSON.stringify(hostile));
      assertEquals((await claude('', '', PY, f.state)).source, 'missing');
      Deno.removeSync(folder, { recursive: true });
    }
  } finally {
    console.warn = warn;
  }
});

Deno.test('a missing entry file or package.json is not found', () => {
  using f = fixture();
  makeInstall(f.state, 'claude', '0.1.0', CLAUDE, { files: [] });
  assertEquals(adapters.findStudioInstall('claude', f.state), null);
  const folder = join(f.state, 'agents', 'claude', '0.2.0');
  Deno.mkdirSync(folder, { recursive: true });
  Deno.writeTextFileSync(join(folder, adapters.COMPLETE_MARKER), 'ok');
  assertEquals(adapters.findStudioInstall('claude', f.state), null);
});

Deno.test('no state dir means no Studio lookup', () => {
  using f = fixture();
  assertEquals(adapters.findStudioInstall('claude', null), null);
  assertEquals(adapters.findStudioInstall('omp', f.state), null);
});

Deno.test('Node.js missing is a problem, not a crash', async () => {
  using f = fixture();
  makeInstall(f.state, 'claude', '0.102.0', CLAUDE);
  adapters.adapterHooks.findNode = () => '';
  const row = await claude('', '', '', f.state);
  assertEquals([row.found, row.source], [false, 'studio']);
  assert(row.problem.includes('Node.js'));
});

Deno.test('the constants the page and the installer rely on', () => {
  assertEquals(adapters.CODEX_NEEDS_ADAPTER, 'The Codex app is on this PC, but Studio needs its ACP adapter.');
  assert(adapters.CODEX_INSTALL.includes('@agentclientprotocol/codex-acp'));
  assertEquals(Object.keys(adapters.STUDIO_PACKAGES), ['claude', 'codex']);
});

// ---- parity with adapters.py ---------------------------------------------------------------------------------------------

Deno.test('parseMarkedPath, mergePaths and the version order match Python', async () => {
  await using py = new PyParity();
  const texts = [`Welcome\n${S}/usr/local/bin:/usr/bin${E}\n`, `${S}/old${E} x ${S}/new:/bin${E}`, `${S}  /padded  ${E}`, ...BAD_MARKED];
  for (const text of texts) {
    assertEquals(adapters.parseMarkedPath(text), await py.call('adapters', 'parse_marked_path', [text]), String(text));
  }
  for (const [a, b] of [['/a:/b', '/b:/c::'], ['', '/x:/y'], ['/a::/a', ''], ['', '']]) {
    assertEquals(adapters.mergePaths(a, b, ':'), await py.call('adapters', 'merge_paths', [a, b, ':']));
  }
  const names = [
    '0.9.0',
    '0.10.0',
    '0.2.0',
    '0.11.0-preview.1',
    '0.11.0',
    'v2.0.0',
    'latest',
    '1.0',
    '1.0.0',
    '1',
    '0.11.0-alpha',
    'zzz',
    '1.5.0-',
  ]; // no equal keys: their order is the listing's
  const expected = await py.call('agents_shim', 'version_order', [names]) as string[];
  using f = fixture();
  for (const name of names) {
    Deno.mkdirSync(join(f.state, 'agents', 'claude', name), { recursive: true });
    Deno.writeTextFileSync(join(f.state, 'agents', 'claude', name, '.complete'), '');
  }
  const ordered = adapters.completeVersions(f.state, 'claude').map((folder) => folder.slice(folder.lastIndexOf(SEP) + 1));
  assertEquals(ordered, expected);
});

Deno.test('resolveClaude and resolveCodex give the rows Python gives on the same fixture', async () => {
  await using py = new PyParity();
  using f = fixture();
  const flag = touch(join(f.root, 'flag.js'));
  const saved = touch(join(f.root, 'saved.js'));
  makeInstall(f.state, 'claude', '0.101.0', CLAUDE);
  makeInstall(f.state, 'codex', '2.6.0', '@agentclientprotocol/codex-acp', { bin: { 'codex-acp': 'dist/index.js' } });
  const cases: [string, string, string, string, string | null][] = [
    ['claude', '', '', PY, null],
    ['claude', flag, saved, PY, f.state],
    ['claude', '', saved, PY, f.state],
    ['claude', join(f.root, 'gone.js'), '', PY, null],
    ['claude', '', '', PY, f.state],
    ['claude', '', '', 'no-such-node-xyz', f.state],
    ['codex', '', '', PY, null],
    ['codex', '', '', PY, f.state],
    ['codex', flag, '', PY, null],
  ];
  for (const [kind, fl, sv, node, state] of cases) {
    const options = { flag: fl, saved: sv, nodeCommand: node, stateDir: state, onPath: () => '', codexPresent: () => false };
    const mine = kind === 'claude' ? await adapters.resolveClaude(options) : await adapters.resolveCodex(options);
    const theirs = await py.call('agents_shim', 'resolve', [kind, fl, sv, node, state, [f.modules]]);
    assertEquals(mine, theirs, JSON.stringify([kind, fl, sv, node, state]));
  }
  Deno.removeSync(f.installed);
  for (const [present, kind] of [[true, 'codex'], [false, 'codex'], [false, 'claude']] as const) {
    const options = { nodeCommand: PY, onPath: () => '', codexPresent: () => present };
    const mine = kind === 'claude' ? await adapters.resolveClaude(options) : await adapters.resolveCodex(options);
    assertEquals(mine, await py.call('agents_shim', 'resolve', [kind, '', '', PY, null, [f.modules], '', present]));
  }
  if (WIN) assertEquals(adapters.resolveOmp(PY), await py.call('adapters', 'resolve_omp', [PY]));
  assertEquals(adapters.resolveOmp(''), await py.call('adapters', 'resolve_omp', ['']));
  assertEquals(adapters.resolveOmp('no-such-omp-xyz'), await py.call('adapters', 'resolve_omp', ['no-such-omp-xyz']));
});
