/**
 * Startup PATH for tools and agents on macOS / Linux (server/agents/adapters.ts initToolPath): the interactive login shell's PATH
 * between markers, the one fallback, a bare PATH, and the log line. Pure: the shell run and the folders are injected.
 */
import { assert, assertEquals } from './_assert.ts';
import { join, tempDir, touch } from './_agents.ts';
import * as adapters from '../../outputs/agent-studio/server/agents/adapters.ts';

const S = adapters.PATH_START, E = adapters.PATH_END;
const SHELL = Deno.execPath(); // any real absolute file: the shell is never really run here
const HOME = '/home/u';

Deno.test('shellToRun takes $SHELL, then /bin/bash, then /bin/sh', () => {
  const has = (...files: string[]) => (p: string) => files.includes(p);
  assertEquals(adapters.shellToRun({ SHELL: '/usr/bin/zsh' }, has('/usr/bin/zsh', '/bin/bash')), '/usr/bin/zsh');
  assertEquals(adapters.shellToRun({ SHELL: '/gone/zsh' }, has('/bin/bash', '/bin/sh')), '/bin/bash');
  assertEquals(adapters.shellToRun({}, has('/bin/sh')), '/bin/sh');
  assertEquals(adapters.shellToRun({ SHELL: 'zsh' }, has('/bin/sh')), '/bin/sh', 'a relative $SHELL is not used');
  assertEquals(adapters.shellToRun({}, has()), '');
});

const fakeFs = (dirs: string[]) => ({
  names: (d: string) => dirs.filter((x) => x.startsWith(d + '/')).map((x) => x.slice(d.length + 1).split('/')[0]),
  isDir: (p: string) => dirs.some((x) => x === p || x.startsWith(p + '/')),
});

Deno.test('fallbackPath: the newest nvm node bin, then ~/.local/bin, only what exists', () => {
  const nvm = `${HOME}/.nvm/versions/node`;
  const fs = fakeFs([`${nvm}/v9.1.0/bin`, `${nvm}/v26.13.1/bin`, `${nvm}/v10.0.0/bin`, `${HOME}/.local/bin`]);
  assertEquals(adapters.fallbackPath(HOME, fs), `${nvm}/v26.13.1/bin:${HOME}/.local/bin`);
  assertEquals(adapters.fallbackPath(HOME, fakeFs([`${HOME}/.local/bin`])), `${HOME}/.local/bin`);
  assertEquals(adapters.fallbackPath(HOME, fakeFs([])), '');
});

Deno.test('initToolPath: shell route, fallback route, bare, Windows', async () => {
  const fs = fakeFs([`${HOME}/.local/bin`]);
  const never: adapters.RunFn = () => {
    throw new Error('must not run');
  };
  const shell: adapters.RunFn = () => Promise.resolve({ stdout: `motd\n${S}/nvm/bin:/usr/bin${E}\n` });
  let env: Record<string, string> = { SHELL, PATH: '/usr/bin:/bin', HOME, AIB_OWN: '1' };
  assertEquals(await adapters.initToolPath(env, 'Linux', shell, HOME, fs), 'shell');
  assertEquals(env.PATH, '/nvm/bin:/usr/bin:/bin');
  assertEquals(env.AIB_OWN, '1', "AIB's own variables stay");

  env = { SHELL, PATH: '/usr/bin', HOME };
  const hung: adapters.RunFn = () => Promise.reject(new Error('timed out'));
  assertEquals(await adapters.initToolPath(env, 'Linux', hung, HOME, fs), 'fallback');
  assertEquals(env.PATH, `${HOME}/.local/bin:/usr/bin`);

  env = { SHELL, PATH: '/usr/bin' };
  assertEquals(await adapters.initToolPath(env, 'Darwin', () => Promise.resolve({ stdout: 'noise only' }), HOME, fakeFs([])), 'bare');
  assertEquals(env.PATH, '/usr/bin');

  env = { SHELL, PATH: 'C:\\x' };
  assertEquals(await adapters.initToolPath(env, 'Windows', never), '');
  assertEquals(env.PATH, 'C:\\x');
});

Deno.test('toolReport lists the source and each tool', () => {
  const found: Record<string, string> = { npm: '/n/npm', node: '/n/node', 'codex-acp': '/n/codex-acp' };
  assertEquals(
    adapters.toolReport('shell', (name) => found[name]),
    'tool PATH from shell; npm: /n/npm, node: /n/node, claude-agent-acp: not found, codex-acp: /n/codex-acp, claude: not found, codex: not found',
  );
});

Deno.test('a standalone claude-agent-acp on PATH is how Claude starts (macOS / Linux)', async () => {
  if (Deno.build.os === 'windows') return;
  using dir = tempDir();
  const bin = touch(join(dir.root, 'bin', 'claude-agent-acp'), '\x7fELF binary\n');
  Deno.chmodSync(bin, 0o755);
  adapters.adapterHooks.globalRoots = () => [];
  try {
    const row = await adapters.resolveClaude({ stateDir: join(dir.root, 'state'), onPath: () => bin, nodeCommand: '' });
    assertEquals([row.found, row.source, row.argv], [true, 'path', [bin]]);
  } finally {
    delete adapters.adapterHooks.globalRoots;
  }
  assert(true);
});
