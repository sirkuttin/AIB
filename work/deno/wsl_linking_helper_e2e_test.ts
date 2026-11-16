/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the Linking (WSL) phase 2 helper methods through the real helper channel
 * (docs/wsl/linking-design.md section 12). Everything is inside the test's AIB_WSL_ROOT (/tmp/aib-wsl-test-<random>), removed
 * afterwards; no network, no real agent, no real credential.
 *   1. env.prereqs on the distro as it is (the user's own login shell, read-only): Node.js found with npm (on this PC an asdf shim
 *      whose npm is only next to the node it really runs: 'ok', manager 'asdf', no nvm offer), git, curl, disk, arch, env mode.
 *   2. A stand-in login shell (named bash, HOME inside the root): Node.js missing (nvm offered), then too old, then an asdf-like shim
 *      with no version set, each seen after `force` (the login PATH read again).
 *   3. agents.uninstall: a fake AIB install of Claude Code is refused while a process the test started runs from it, then removed;
 *      a fake Codex folder and a file next to the agents folder stay; an agents/<id> that is a link is left alone.
 *   4. agents.signinStatus: fake credential files in CLAUDE_CONFIG_DIR / CODEX_HOME (set by the stand-in shell): signed in with the
 *      display e-mail, and the fake token never appears in the answer.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, DISTRO, inDistro, newAib, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { helperEnv } from '../../outputs/agent-studio/server/wsl/hosts.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const SECRET = 'sk-ant-oat01-E2E-FAKE-SECRET-9f8e7d';

async function sh(
  script: string,
  args: string[] = [],
  stdin?: string,
): Promise<string> {
  const done = await inDistro(
    script,
    args,
    stdin === undefined ? undefined : enc(stdin),
  );
  if (done.code !== 0) throw new Error(`in ${DISTRO}: ${script}\n${done.err}`);
  return done.out;
}
const put = (path: string, text: string, mode = '644') =>
  sh(
    `mkdir -p "$(dirname "$1")" && cat > "$1" && chmod ${mode} "$1"`,
    [path],
    text,
  );

Deno.test({
  name:
    'wsl e2e: env.prereqs on the distro as it is: Node.js with npm (also behind an asdf shim), git, curl, disk, env mode; nothing changed',
  ...T,
  async fn() {
    try {
      const host = await readyHost();
      const got = await host.call('env.prereqs', { force: true });
      console.log(`  ${DISTRO}: ${JSON.stringify(got)}`);
      assert(['login-interactive', 'login'].includes(got.envMode), got.envMode);
      assertEquals([got.arch, typeof got.diskFreeMB], [
        Deno.build.arch === 'aarch64' ? 'arm64' : 'amd64',
        'number',
      ]);
      assert(got.loginShell.startsWith('/'), got.loginShell);
      // the package manager family from the distro's own /etc/os-release (Ubuntu, Debian: apt)
      const osRelease = await sh('cat /etc/os-release 2>/dev/null || cat /usr/lib/os-release', []);
      if (/^ID(_LIKE)?=.*\b(ubuntu|debian)\b/m.test(osRelease)) assertEquals(got.pkgManager, 'apt');
      else assert(['apt', 'dnf', 'yum', 'zypper', 'pacman', 'apk', 'unknown'].includes(String(got.pkgManager)), String(got.pkgManager));
      if (got.node.manager === 'asdf' || got.node.manager === 'mise') {
        assert(/^\d+\.\d+\.\d+$/.test(String(got.node.managerVersion)), `the manager's version: ${got.node.managerVersion}`);
      }
      if (got.node.state === 'ok') {
        assertEquals(
          got.npm.state,
          'ok',
          'npm found next to the node that really runs',
        );
        if (got.node.manager === 'asdf') {
          assert(
            String(got.node.path).includes('/.asdf/shims/'),
            String(got.node.path),
          );
          assertEquals(got.canInstallNode, false, 'never nvm next to asdf');
        }
      } else {console.log(
          `  ${DISTRO} has no usable Node.js (${got.node.state}): the stand-in cases run in the next test`,
        );}
    } finally {
      await cleanRoot();
    }
  },
});

/** A stand-in login shell named bash: HOME, CLAUDE_CONFIG_DIR and CODEX_HOME inside the root; PATH picked by the file <root>/mode. */
async function standIn(): Promise<void> {
  await sh(
    'mkdir -p "$1/sh" "$1/home" && chmod 700 "$1" && touch "$1/home/.bashrc"',
    [ROOT],
  );
  await put(
    `${ROOT}/sh/bash`,
    `#!/bin/sh
# AIB e2e: a stand-in login shell (ignores -lic / -lc)
PATH="/usr/bin:/bin"
case "$(cat "${ROOT}/mode" 2>/dev/null)" in
  old) PATH="${ROOT}/oldbin:$PATH";;
  unset) PATH="${ROOT}/home/.asdf/shims:$PATH";;
esac
export PATH
HOME="${ROOT}/home"; CLAUDE_CONFIG_DIR="${ROOT}/cc"; CODEX_HOME="${ROOT}/cx"; export HOME CLAUDE_CONFIG_DIR CODEX_HOME
shift
exec /bin/sh -c "$1"
`,
    '755',
  );
  await put(
    `${ROOT}/oldbin/node`,
    '#!/bin/sh\n# AIB e2e: an old Node.js\necho v18.19.1\n',
    '755',
  );
  await put(
    `${ROOT}/home/.asdf/shims/node`,
    '#!/usr/bin/env bash\n# asdf-plugin: nodejs\necho "No version is set for command node" >&2\nexit 126\n',
    '755',
  );
  newAib({
    helperEnv: (install) => ({
      ...helperEnv(install),
      SHELL: `${ROOT}/sh/bash`,
    }),
  });
}

Deno.test({
  name: 'wsl e2e: env.prereqs with a stand-in login shell: missing (nvm offered), too old, asdf shim with no version, each after force',
  ...T,
  async fn() {
    try {
      const nodeOnSystem = (await sh(
        '[ -x /usr/bin/node ] || [ -x /bin/node ] && echo y || echo n',
      )).trim() === 'y';
      await standIn();
      const host = await readyHost();
      const missing = await host.call('env.prereqs', {});
      assertEquals([missing.loginShell, missing.nvm.present], [
        `${ROOT}/sh/bash`,
        false,
      ]);
      if (!nodeOnSystem) {
        assertEquals([missing.node.state, missing.npm.state], [
          'missing',
          'missing',
        ], JSON.stringify(missing));
        const curl = missing.curl.state === 'ok';
        assertEquals(
          missing.canInstallNode,
          curl,
          String(missing.nodeInstallBlocked),
        );
      }
      await sh('echo old > "$1/mode"', [ROOT]);
      assertEquals(
        (await host.call('env.prereqs', {})).node.state,
        missing.node.state,
        'the login PATH is read again only on force',
      );
      const old = await host.call('env.prereqs', { force: true });
      assertEquals([old.node.state, old.node.version, old.node.path], [
        'old',
        '18.19.1',
        `${ROOT}/oldbin/node`,
      ], JSON.stringify(old.node));
      await sh('echo unset > "$1/mode"', [ROOT]);
      const unset = await host.call('env.prereqs', { force: true });
      assertEquals(
        [unset.node.state, unset.node.manager, unset.canInstallNode],
        ['shim_unset', 'asdf', false],
        JSON.stringify(unset),
      );
      assert(String(unset.nodeInstallBlocked).includes('asdf'));
      assertEquals(
        (await sh('ls -A "$1/home" | sort | tr "\\n" " "', [ROOT])).trim(),
        '.asdf .bashrc',
        'nothing was written to the home folder',
      );
    } finally {
      await cleanRoot();
    }
  },
});

Deno.test({
  name:
    'wsl e2e: agents.uninstall refused while a process runs from the agent folder, then removes only that agent; a linked folder is left alone',
  ...T,
  async fn() {
    try {
      await standIn();
      const host = await readyHost();
      const folder = `${ROOT}/agents/claude/0.102.0`;
      await put(
        `${folder}/node_modules/x/run.sh`,
        `# AIB e2e: stands in for an agent running from AIB's copy (no exec: this sh keeps the folder in its command line)
echo $$ > "${ROOT}/busy.pid"
sleep 300
`,
      );
      await sh(
        'touch "$1/.complete" && mkdir -p "$2/agents/codex/2.6.0" "$2/elsewhere/9.9.9" && echo keep > "$2/agents-sibling.txt"',
        [folder, ROOT],
      );
      // the test's own stand-in process, under /tmp, held by a wsl.exe this test started (a detached one ends with its wsl.exe)
      const systemRoot = Deno.env.get('SystemRoot') ?? 'C:\\Windows';
      const holder = new Deno.Command(`${systemRoot}\\System32\\wsl.exe`, {
        args: ['--distribution', DISTRO, '--exec', 'sh', `${folder}/node_modules/x/run.sh`],
        env: { SystemRoot: systemRoot, WSL_UTF8: '1', WSLENV: '' },
        clearEnv: true,
        stdin: 'null',
        stdout: 'null',
        stderr: 'null',
      }).spawn();
      let pid = '';
      try {
        for (let i = 0; i < 50 && !pid; i++) {
          await new Promise((r) => setTimeout(r, 200));
          pid = (await sh('cat "$1/busy.pid" 2>/dev/null; exit 0', [ROOT])).trim();
        }
        assert(/^\d+$/.test(pid), 'the stand-in process started');
        const busy = await host.call('agents.uninstall', { id: 'claude' });
        assertEquals([busy.ok, busy.blocked, busy.removed], [false, 'running', []], JSON.stringify(busy));
        assert(String(busy.message).includes(pid), String(busy.message));
        assertEquals((await sh('[ -f "$1/.complete" ] && echo yes', [folder])).trim(), 'yes', 'nothing removed while it runs');
      } finally {
        // only the test's own process: its sh (by the pid it wrote) and that sh's sleep
        if (pid) await sh('pkill -P "$1" 2>/dev/null; kill "$1" 2>/dev/null; exit 0', [pid]);
        try {
          holder.kill();
        } catch { /* already gone */ }
        await holder.status;
      }
      if (pid) await sh('for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$1" 2>/dev/null || exit 0; sleep 0.3; done; exit 1', [pid]);
      const done = await host.call('agents.uninstall', { id: 'claude' });
      assertEquals(
        [done.ok, done.removed],
        [true, ['0.102.0']],
        JSON.stringify(done),
      );
      assertEquals(
        (await sh('[ -e "$1" ] && echo yes || echo no', [folder])).trim(),
        'no',
      );
      assertEquals(
        (await sh(
          'cd "$1" && ls -d agents/codex/2.6.0 agents-sibling.txt elsewhere/9.9.9 | LC_ALL=C sort | tr "\\n" " "',
          [ROOT],
        )).trim(),
        'agents-sibling.txt agents/codex/2.6.0 elsewhere/9.9.9',
      );
      assertEquals(await host.call('agents.uninstall', { id: 'claude' }), {
        ok: true,
        removed: [],
      });

      // agents/codex as a link to a folder elsewhere: refused, nothing behind the link deleted
      await sh(
        'rm -rf "$1/agents/codex" && ln -s "$1/elsewhere" "$1/agents/codex"',
        [ROOT],
      );
      const linked = await host.call('agents.uninstall', { id: 'codex' });
      assertEquals(
        [linked.ok, linked.blocked],
        [false, 'unsafe'],
        JSON.stringify(linked),
      );
      assertEquals((await sh('ls "$1/elsewhere"', [ROOT])).trim(), '9.9.9');
    } finally {
      await cleanRoot();
    }
  },
});

Deno.test({
  name:
    'wsl e2e: agents.signinStatus reads fake credential files in CLAUDE_CONFIG_DIR / CODEX_HOME for shape only; the token never appears',
  ...T,
  async fn() {
    try {
      await standIn();
      const host = await readyHost();
      const before = await host.call('agents.signinStatus', {
        ids: ['claude', 'codex'],
      });
      assertEquals(before.agents.map((a) => a.state), [
        'signed_out',
        'signed_out',
      ], JSON.stringify(before));
      await put(
        `${ROOT}/cc/.credentials.json`,
        JSON.stringify({
          claudeAiOauth: { accessToken: SECRET, refreshToken: SECRET },
        }),
        '600',
      );
      await put(
        `${ROOT}/cc/.claude.json`,
        JSON.stringify({
          oauthAccount: {
            emailAddress: 'e2e@example.com',
            accountUuid: SECRET,
          },
        }),
        '600',
      );
      await put(
        `${ROOT}/cx/auth.json`,
        JSON.stringify({
          OPENAI_API_KEY: null,
          tokens: { access_token: SECRET },
        }),
        '600',
      );
      const after = await host.call('agents.signinStatus', {});
      assert(
        !JSON.stringify(after).includes('E2E-FAKE-SECRET'),
        'a secret leaked',
      );
      assertEquals(after.agents, [
        { id: 'claude', state: 'signed_in', account: 'e2e@example.com' },
        { id: 'codex', state: 'signed_in' },
        {
          id: 'omp',
          state: 'unknown',
          note: 'AIB cannot tell whether OMP is signed in.',
        },
      ]);
    } finally {
      await cleanRoot();
    }
  },
});
