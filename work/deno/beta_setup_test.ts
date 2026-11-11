/**
 * Setting up a Beta agent (server/agents/beta_setup.ts): the install method per agent and OS, the prerequisites and their states, the
 * exact commands the card's terminal runs, the Windows PATH refresh after an installer, and OpenCode's native npm install. Nothing here
 * runs an installer or downloads anything: probes, PATH folders and registry answers are stand-ins.
 */
import { assert, assertEquals } from './_assert.ts';
import { join, tempDir, touch } from './_agents.ts';
import { betaAgent, type OsName } from '../../outputs/agent-studio/server/agents/beta_catalog.ts';
import { nativeProgram, resolveBeta } from '../../outputs/agent-studio/server/agents/beta_agents.ts';
import {
  checkPrereq,
  expandWindowsVars,
  hasWinget,
  installPlan,
  mergedPath,
  NODE_LTS_MAJOR,
  parseVersion,
  refreshWindowsPath,
  regPathValue,
  setupCommand,
  type SetupProbe,
  setupView,
  stepShell,
  versionBelow,
} from '../../outputs/agent-studio/server/agents/beta_setup.ts';
import { Installer } from '../../outputs/agent-studio/server/agents/installer.ts';
import type { ShellSpec } from '../../outputs/agent-studio/server/platform/pty.ts';

const NVM =
  'curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash && \\. "$HOME/.nvm/nvm.sh" && nvm install --lts';
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

/** A probe: this OS, this environment, this node (with this --version), and fixed --version answers per program. */
function probe(
  os: OsName,
  env: Record<string, string>,
  node = '',
  versions: Record<string, string> = {},
): SetupProbe {
  return {
    os,
    env: { SystemRoot: 'C:\\Windows', ...env },
    findNode: () => node,
    version: (p) => Promise.resolve(versions[p] ?? ''),
  };
}

/** A folder with a fake winget.exe, as a Windows PATH. */
function wingetDir(root: string): string {
  const dir = join(root, 'winget');
  touch(join(dir, 'winget.exe'), '');
  return dir;
}

Deno.test('install method per agent and OS: npm agents by AIB, the rest by the vendor installer from its docs', () => {
  const plan = (id: string, os: OsName) => installPlan(betaAgent(id)!, os);
  for (
    const id of [
      'copilot',
      'opencode',
      'gemini',
      'qwen',
      'cline',
      'kimi',
      'kilo',
    ]
  ) {
    for (const os of ['windows', 'darwin', 'linux'] as const) {
      assertEquals([plan(id, os).kind, plan(id, os).needs], ['npm', ['node']]);
    }
  }
  const cursorUnix = 'curl https://cursor.com/install -fsS | bash';
  assertEquals(plan('cursor', 'windows').step, {
    shell: 'powershell',
    command: "irm 'https://cursor.com/install?win32=true' | iex",
  });
  assertEquals(plan('cursor', 'darwin').step, {
    shell: 'bash',
    command: cursorUnix,
  });
  assertEquals(plan('cursor', 'linux').step, {
    shell: 'bash',
    command: cursorUnix,
  });
  const gooseUnix = 'curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash';
  assertEquals(
    plan('goose', 'windows').step?.command,
    "$f = Join-Path $env:TEMP 'download_cli.ps1'; " +
      'Invoke-WebRequest -Uri "https://raw.githubusercontent.com/aaif-goose/goose/main/download_cli.ps1" -OutFile $f; & $f',
  );
  assertEquals(
    plan('goose', 'windows').needs,
    [],
    'the PowerShell installer needs no Git Bash',
  );
  assertEquals(plan('goose', 'linux').step, {
    shell: 'bash',
    command: gooseUnix,
  });
  assertEquals(plan('vibe', 'windows'), {
    kind: 'terminal',
    step: {
      shell: 'powershell',
      command: 'uv tool install mistral-vibe',
      needs: ['uv'],
    },
    needs: ['uv'],
  });
  assertEquals(plan('vibe', 'darwin'), {
    kind: 'terminal',
    step: {
      shell: 'bash',
      command: 'curl -LsSf https://mistral.ai/vibe/install.sh | bash',
    },
    needs: [],
  });
});

Deno.test('Node.js: missing, too old, the minimum, a newer non-LTS; the offer installs the current LTS', async () => {
  using dir = tempDir();
  const gemini = betaAgent('gemini')!, kimi = betaAgent('kimi')!;
  const winget = {
    PATH: wingetDir(dir.root),
    LOCALAPPDATA: join(dir.root, 'none'),
  };
  let view = await setupView(gemini, probe('windows', winget));
  assertEquals(view.prereqs[0].need, 'Node.js 22 or newer');
  assertEquals([view.prereqs[0].state, view.blockedBy], [
    'missing',
    'Install Node.js first',
  ]);
  assertEquals(
    view.prereqs[0].installLabel,
    `Install Node.js ${NODE_LTS_MAJOR} (LTS)`,
  );
  assertEquals(NODE_LTS_MAJOR, 26, 'nodejs.org/dist/index.json on 2026-11-11');
  assertEquals(
    view.prereqs[0].command,
    'winget install -e --id OpenJS.NodeJS.LTS',
  );
  assertEquals(view.command, 'npm install -g @google/gemini-cli');

  const node = 'C:\\node\\node.exe';
  const at = async (
    v: string,
    agent = gemini,
  ) => (await checkPrereq(
    'node',
    agent === kimi ? '22.19.0' : '22',
    probe('windows', winget, node, { [node]: v }),
  ));
  assertEquals([(await at('v20.11.1')).state, (await at('v20.11.1')).version], [
    'old',
    '20.11.1',
  ]);
  assertEquals((await at('v22.0.0')).state, 'found');
  assertEquals(
    (await at('v27.1.0')).state,
    'found',
    'a newer non-LTS Node.js that meets the minimum: no nag',
  );
  assertEquals(
    (await at('v22.5.0', kimi)).state,
    'old',
    "Kimi's own engines.node is >=22.19.0",
  );
  view = await setupView(
    kimi,
    probe('windows', winget, node, { [node]: 'v22.19.0' }),
  );
  assertEquals([view.prereqs[0].need, view.prereqs[0].state, view.blockedBy], [
    'Node.js 22.19 or newer',
    'found',
    '',
  ]);

  const noWinget = await checkPrereq(
    'node',
    '22',
    probe('windows', { PATH: '', LOCALAPPDATA: join(dir.root, 'none') }),
  );
  assertEquals([noWinget.command, noWinget.page], [
    '',
    'https://nodejs.org/en/download',
  ], 'no winget: the download page');
  const mac = await checkPrereq(
    'node',
    '22',
    probe('darwin', { HOME: dir.root, PATH: '' }),
  );
  assertEquals(mac.command, NVM);
  assertEquals(
    (await checkPrereq(
      'node',
      '22',
      probe('linux', { HOME: dir.root, PATH: '' }),
    )).command,
    NVM,
  );
});

Deno.test('uv for Mistral Vibe on Windows: missing blocks Install; found (PATH or ~/.local/bin) unblocks it', async () => {
  using dir = tempDir();
  const vibe = betaAgent('vibe')!;
  const home = join(dir.root, 'home');
  let view = await setupView(
    vibe,
    probe('windows', {
      PATH: wingetDir(dir.root),
      USERPROFILE: home,
      LOCALAPPDATA: home,
    }),
  );
  assertEquals(view.prereqs.map((p) => [p.need, p.state, p.command]), [[
    'uv',
    'missing',
    'winget install --id=astral-sh.uv -e',
  ]]);
  assertEquals(view.blockedBy, 'Install uv first');
  view = await setupView(
    vibe,
    probe('windows', { PATH: '', USERPROFILE: home, LOCALAPPDATA: home }),
  );
  assertEquals(
    view.prereqs[0].command,
    'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"',
    "no winget: uv's PowerShell installer",
  );
  const uv = touch(join(home, '.local', 'bin', 'uv.exe'), '');
  view = await setupView(
    vibe,
    probe('windows', { PATH: '', USERPROFILE: home, LOCALAPPDATA: home }, '', {
      [uv]: 'uv 0.9.9 (x 2026-11-01)',
    }),
  );
  assertEquals(
    [view.prereqs[0].state, view.prereqs[0].version, view.blockedBy],
    ['found', '0.9.9', ''],
  );
  // macOS and Linux: the vendor script installs uv itself, so nothing is needed first.
  assertEquals(
    (await setupView(vibe, probe('darwin', { HOME: home, PATH: '' }))).prereqs,
    [],
  );
  assertEquals(
    (await checkPrereq(
      'uv',
      '',
      probe('linux', { HOME: join(dir.root, 'nobody'), PATH: '' }),
    )).command,
    'curl -LsSf https://astral.sh/uv/install.sh | sh',
  );
});

Deno.test('the terminal runs the catalog command for this OS, never one from the page; refusals are one plain line', async () => {
  using dir = tempDir();
  const home = join(dir.root, 'home');
  const win = probe('windows', {
    PATH: wingetDir(dir.root),
    USERPROFILE: home,
    LOCALAPPDATA: home,
  });
  const spec = await setupCommand('cursor', 'install', win) as ShellSpec;
  assertEquals(spec, {
    file: PS,
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      "irm 'https://cursor.com/install?win32=true' | iex",
    ],
  });
  assertEquals(
    await setupCommand(
      'cursor',
      'install',
      probe('linux', { HOME: home, PATH: '' }),
    ),
    {
      file: '/bin/bash',
      args: ['-c', 'curl https://cursor.com/install -fsS | bash'],
    },
  );
  assertEquals(
    await setupCommand('vibe', 'install', win),
    'Install uv first.',
    'Install stays off until uv is there',
  );
  assertEquals(
    (await setupCommand('vibe', 'prereq:uv', win) as ShellSpec).args.at(-1),
    'winget install --id=astral-sh.uv -e',
  );
  assertEquals(
    (await setupCommand('gemini', 'prereq:node', win) as ShellSpec).args.at(-1),
    'winget install -e --id OpenJS.NodeJS.LTS',
  );
  assertEquals(
    await setupCommand('cursor', 'prereq:node', win),
    'Cursor CLI does not need that installed first.',
  );
  assertEquals(
    await setupCommand('gemini', 'install', win),
    'AIB cannot run an installer for Gemini CLI on this computer.',
  );
  assertEquals(
    await setupCommand('cursor', 'prereq:../evil', win),
    'Cursor CLI does not need that installed first.',
  );
  assertEquals(
    await setupCommand('nobody', 'install', win),
    'AIB does not know that agent.',
  );
  assertEquals(
    await setupCommand(
      'gemini',
      'prereq:node',
      probe('windows', { PATH: '', LOCALAPPDATA: home }),
    ),
    'AIB has no installer it can run for Node.js here. Get it from https://nodejs.org/en/download',
  );
  assertEquals(stepShell({ shell: 'sh', command: 'x' }, 'darwin', {}), {
    file: '/bin/sh',
    args: ['-c', 'x'],
  });
});

Deno.test('versions: parsed from --version lines and compared part by part', () => {
  assertEquals([
    parseVersion('v26.13.1\n'),
    parseVersion('uv 0.9.9 (abc 2026-11-01)'),
    parseVersion('nothing'),
  ], ['26.13.1', '0.9.9', '']);
  assert(
    versionBelow('22.5.0', '22.19.0') && !versionBelow('22.19.0', '22.19') &&
      !versionBelow('27.0.0', '22'),
  );
  assert(!hasWinget({ PATH: '' }, 'darwin'));
});

Deno.test('Windows PATH refresh: the registry folders an installer added go to the end of AIB PATH, %VARS% expanded, no repeats', async () => {
  const machine = '    Path    REG_EXPAND_SZ    C:\\Windows;%ProgramFiles%\\nodejs\\\r\n';
  assertEquals(regPathValue(machine), 'C:\\Windows;%ProgramFiles%\\nodejs\\');
  assertEquals(
    regPathValue(
      'ERROR: The system was unable to find the specified registry key or value.',
    ),
    '',
  );
  assertEquals(
    expandWindowsVars('%PROGRAMFILES%\\x;%NOPE%', { ProgramFiles: 'C:\\PF' }),
    'C:\\PF\\x;%NOPE%',
  );
  const env = {
    ProgramFiles: 'C:\\Program Files',
    USERPROFILE: 'C:\\Users\\a',
  };
  assertEquals(
    mergedPath(
      'C:\\Windows\\;C:\\tools',
      'C:\\Windows;%ProgramFiles%\\nodejs\\',
      '%USERPROFILE%\\.local\\bin;C:\\tools',
      env,
    ),
    'C:\\Windows\\;C:\\tools;C:\\Program Files\\nodejs\\;C:\\Users\\a\\.local\\bin',
  );
  const before = Deno.env.get('PATH') ?? '';
  try {
    const queried: string[] = [];
    const changed = await refreshWindowsPath((key) => {
      queried.push(key);
      return Promise.resolve(key.startsWith('HKCU') ? '    Path    REG_SZ    C:\\aib-test-new-folder\r\n' : '');
    }, 'windows');
    assert(changed);
    assertEquals(queried, [
      'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
      'HKCU\\Environment',
    ]);
    assert((Deno.env.get('PATH') ?? '').endsWith(';C:\\aib-test-new-folder'));
    assertEquals(
      await refreshWindowsPath(() => Promise.resolve(''), 'darwin'),
      false,
      'only on Windows',
    );
  } finally {
    Deno.env.set('PATH', before);
  }
});

Deno.test("OpenCode installs with npm into AIB's folder and runs its platform binary (no node), not the postinstall placeholder", async () => {
  using dir = tempDir();
  const state = join(dir.root, 'state');
  const version = join(state, 'agents', 'opencode', '2.2.7');
  const pkg = join(version, 'node_modules', '@opencode', 'cli');
  touch(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@opencode/cli',
      version: '2.2.7',
      bin: { opencode: 'bin/opencode.exe' },
    }),
  );
  touch(
    join(pkg, 'bin', 'opencode.exe'),
    'echo "Error: postinstall was not run" >&2',
  );
  touch(join(version, '.complete'), '{}');
  assertEquals(
    Installer.verify(version, '@opencode/cli', '2.2.7').startsWith(
      'The download finished, but the program',
    ),
    true,
  );
  const exe = touch(
    join(
      version,
      'node_modules',
      '@opencode',
      'cli-windows-x64',
      'bin',
      'opencode.exe',
    ),
    '',
  );
  const binary = touch(
    join(
      version,
      'node_modules',
      '@opencode',
      'cli-linux-x64',
      'bin',
      'opencode',
    ),
    '',
  );
  const opencode = betaAgent('opencode')!;
  assertEquals(nativeProgram(opencode, version, 'windows-x86_64'), exe);
  assertEquals(nativeProgram(opencode, version, 'linux-x86_64'), binary);
  assertEquals(
    nativeProgram(opencode, version, 'windows-aarch64'),
    '',
    'not downloaded',
  );
  const row = await resolveBeta('opencode', {
    stateDir: state,
    env: { PATH: '' },
    platform: 'windows-x86_64',
    findNode: () => '',
  });
  assertEquals(
    [row.source, row.argv],
    ['studio', [exe, 'acp']],
    'no node needed to run it',
  );
  if (Deno.build.os === 'windows' && Deno.build.arch === 'x86_64') {
    assertEquals(Installer.verify(version, '@opencode/cli', '2.2.7'), '');
  }
});
