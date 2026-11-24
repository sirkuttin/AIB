/**
 * Linux tool PATH e2e, with the Ubuntu WSL distro as a stand-in Linux machine (skips cleanly without it). Everything lives in a temp
 * HOME under /tmp inside the distro and is removed at the end; nothing is installed system-wide. AIB's own code runs on Windows here
 * (initToolPath, fallbackPath, toolReport); only the shell run, the folder reads and the tool lookups go to the distro, because there
 * is no Deno in it. Headless: wsl.exe with piped stdio.
 *
 * The fake machine: ~/.nvm/versions/node/v26.13.1/bin with stub node, npm and codex-acp, ~/.local/bin/claude-agent-acp, and a ~/.zshrc
 * that adds both to PATH for interactive shells only. AIB starts with PATH=/usr/bin:/bin and SHELL=zsh, like the app menu.
 */
import { assert, assertEquals } from './_assert.ts';
import * as adapters from '../../app/server/agents/adapters.ts';

const DISTRO = 'Ubuntu';

function listedDistros(): string[] {
  if (Deno.build.os !== 'windows') return [];
  try {
    const out = new Deno.Command('wsl.exe', { args: ['-l', '-q'], stdout: 'piped', stderr: 'null', stdin: 'null' }).outputSync();
    return new TextDecoder('utf-16le').decode(out.stdout).split(/\r?\n/).map((l) => l.replaceAll('\0', '').trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function hasZsh(): boolean {
  return wsl(['--exec', 'test', '-x', '/usr/bin/zsh']).code === 0;
}

function wsl(args: string[], stdin?: string): { code: number; stdout: string } {
  // stdin is piped through a spawn so a script can be fed in; sync spawn has no stdin text, so a temp script argument is used instead
  const argv = stdin === undefined ? args : ['--exec', 'sh', '-c', stdin];
  const out = new Deno.Command('wsl.exe', { args: ['-d', DISTRO, ...argv], stdout: 'piped', stderr: 'null', stdin: 'null' }).outputSync();
  return { code: out.code, stdout: new TextDecoder().decode(out.stdout) };
}

const READY = listedDistros().some((d) => d.toLowerCase() === DISTRO.toLowerCase());
const ZSH = READY && hasZsh();

Deno.test({
  name: 'linux tool PATH: the shell route finds npm, node and both adapters; a hung shell falls back within the timeout',
  ignore: !ZSH,
  async fn() {
    const tmp = `/tmp/aib-path-e2e-${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const home = `${tmp}/home`;
    const nvmBin = `${home}/.nvm/versions/node/v26.13.1/bin`;
    const stub = (path: string) => `printf '#!/bin/sh\\necho stub\\n' > ${path} && chmod +x ${path}`;
    const zshrc = (body: string) => `printf '%s\\n' '${body}' > ${home}/.zshrc`;
    const GOOD = `case $- in *i*) export PATH="${nvmBin}:${home}/.local/bin:$PATH";; esac`;
    try {
      const made = wsl([], [
        `mkdir -p ${nvmBin} ${home}/.local/bin`,
        stub(`${nvmBin}/node`),
        stub(`${nvmBin}/npm`),
        stub(`${nvmBin}/codex-acp`),
        stub(`${home}/.local/bin/claude-agent-acp`),
        zshrc(GOOD),
      ].join(' && '));
      assertEquals(made.code, 0, 'the fake machine was built');

      // AIB's side: the real code, with the shell run, folder reads and lookups going to the distro
      const startPath = '/usr/bin:/bin';
      const run: adapters.RunFn = (argv, o) =>
        adapters.runCapture(['wsl.exe', '-d', DISTRO, '--exec', 'env', '-i', `HOME=${home}`, `PATH=${startPath}`, ...argv], { timeout: o.timeout });
      const fs = {
        names: (d: string) => wsl(['--exec', 'ls', d]).stdout.split('\n').map((s) => s.trim()).filter(Boolean),
        isDir: (p: string) => wsl(['--exec', 'test', '-d', p]).code === 0,
      };
      const lookup = (path: string) => (name: string) => {
        const r = wsl(['--exec', 'env', '-i', `PATH=${path}`, 'sh', '-c', `command -v ${name}`]);
        return r.code === 0 ? r.stdout.trim() : null;
      };
      const start = (): Record<string, string> => ({ SHELL: '/usr/bin/zsh', PATH: startPath, HOME: home });
      const always = () => true;

      // the app-menu PATH alone finds nothing
      const before = lookup(startPath);
      for (const name of ['npm', 'node', 'claude-agent-acp', 'codex-acp']) assertEquals(before(name), null, `${name} is not on the bare PATH`);

      // 1. shell route: the interactive login shell reads ~/.zshrc
      let env = start();
      assertEquals(await adapters.initToolPath(env, 'Linux', run, home, fs, always), 'shell');
      const find = lookup(env.PATH!);
      const report = adapters.toolReport('shell', find);
      for (const name of ['npm', 'node', 'codex-acp']) assertEquals(find(name), `${nvmBin}/${name}`);
      assertEquals(find('claude-agent-acp'), `${home}/.local/bin/claude-agent-acp`);
      assert(report.includes(`codex-acp: ${nvmBin}/codex-acp`) && report.includes('claude: not found'), report);
      console.log(report);

      // 2. a .zshrc that hangs: the shell route times out and the fallback finds the same four
      assertEquals(wsl([], zshrc('sleep 61.7')).code, 0);
      env = start();
      const t0 = performance.now();
      assertEquals(await adapters.initToolPath(env, 'Linux', run, home, fs, always), 'fallback');
      const seconds = (performance.now() - t0) / 1000;
      assert(seconds < adapters.LOGIN_SHELL_TIMEOUT + 4, `fell back after ${seconds.toFixed(1)} s`);
      const found2 = lookup(env.PATH!);
      for (const name of ['npm', 'node', 'codex-acp']) assertEquals(found2(name), `${nvmBin}/${name}`);
      assertEquals(found2('claude-agent-acp'), `${home}/.local/bin/claude-agent-acp`);
      console.log(adapters.toolReport('fallback', found2), `(${seconds.toFixed(1)} s)`);
    } finally {
      // the hung shell keeps running in the distro after its client was killed: end it, then remove the temp HOME
      wsl(['--exec', 'sh', '-c', `pkill -f 'sleep 61[.]7'; pkill -f 'STUDIO_PATH_STAR[T]'; rm -rf ${tmp}`]);
      assertEquals(wsl(['--exec', 'test', '-e', tmp]).code === 0, false, 'the temp HOME is gone');
    }
  },
});
