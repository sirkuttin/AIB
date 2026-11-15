/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): Settings > AIB Linking (WSL), phase 2, the Windows routes (docs/wsl/linking-design.md
 * section 12). Everything lives in the test's AIB_WSL_ROOT (/tmp/aib-wsl-test-<random>), removed afterwards. No network, nothing real
 * installed: nvm's installer never runs; a stand-in install.sh (served with file://) stands in for it.
 *   1. Before AIB used the distro: agents?peek=1, prereqs?peek=1, Uninstall and the Node.js terminal make no host (nothing starts it).
 *   2. With the real helper (a stand-in login shell: HOME inside the root, a minimal PATH): prereqs?peek=1&start=1 starts it, the agent
 *      rows carry enabled (the distro's switch), signin, canUninstall, the Codex limits (null: no session files in the test home), and
 *      Uninstall and the Node.js terminal answer. The three helper methods (env.prereqs, agents.uninstall, agents.signinStatus) are the
 *      helper builder's: while this branch's helper does not offer them, the routes' "too old" answers are checked instead (noted).
 *   3. The Node.js button's script, run in the distro with bash exactly as the terminal runs it, against stand-ins: the pinned-checksum
 *      check passes for the right file and stops everything for a changed one, PROFILE is the login shell's start-up file, an old
 *      Node.js is refused, each command is printed first, the temp file is removed.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, DISTRO, inDistro, KEY, newAib, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { helperEnv, wslHostsInUse } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { wslRoutes } from '../../outputs/agent-studio/server/web/wsl_routes.ts';
import { wslNodeSetupCommand } from '../../outputs/agent-studio/server/web/terminal_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';
import { SettingsStore } from '../../outputs/agent-studio/server/state/settings.ts';
import { wslNodeScript, wslNodeSteps } from '../../outputs/agent-studio/server/wsl/node_setup.ts';

type Json = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);

async function sh(script: string, args: string[] = [], stdin?: string): Promise<string> {
  const done = await inDistro(script, args, stdin === undefined ? undefined : enc(stdin));
  if (done.code !== 0) throw new Error(`in ${DISTRO}: ${script}\n${done.err}`);
  return done.out;
}

async function route(
  settings: SettingsStore | undefined,
  method: 'GET' | 'POST',
  path: string,
  query = '',
  body: Json | null = null,
  terminals: { key: string }[] = [],
): Promise<[number, Json]> {
  const handler = wslRoutes().get(`${method} ${path}`)!;
  const url = new URL(`http://127.0.0.1${path}${query ? '?' + query : ''}`);
  const ctx = { token: 't', stateDir: null, settings, terminals: { list: () => terminals } } as unknown as WebContext;
  const [status, out] = await handler(ctx, url, body, new Request(url, { headers: { 'X-Studio-Token': 't' } }));
  return [status, out as Json];
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc(text)));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

Deno.test({
  name: 'wsl e2e linking routes: before AIB used the distro, peek, Uninstall and the Node.js terminal make no host',
  ...T,
  async fn() {
    try {
      newAib();
      const [code, prereqs] = await route(undefined, 'GET', '/api/live/wsl/prereqs', `distro=${KEY}&peek=1`);
      assertEquals([code, prereqs.distro, prereqs.state, prereqs.line, prereqs.prereqs], [200, KEY, 'off', '', null]);
      assertEquals(String(prereqs.name).toLowerCase(), KEY);
      const [, agents] = await route(undefined, 'GET', '/api/live/wsl/agents', `distro=${KEY}&peek=1`);
      assertEquals([agents.state, agents.agents], ['off', []]);
      const [status, uninstall] = await route(undefined, 'POST', '/api/live/wsl/agents/uninstall', '', { distro: KEY, id: 'claude' });
      assertEquals([status, uninstall.code], [409, 'wsl_unavailable']);
      const node = await wslNodeSetupCommand(KEY);
      assert(typeof node === 'string' && node.includes('is not running'), String(node));
      assertEquals(wslHostsInUse()?.peek(KEY) ?? null, null, 'no host was made for the distro');
    } finally {
      await cleanRoot();
    }
  },
});

Deno.test({
  name: 'wsl e2e linking routes: with the real helper, prereqs start=1, agent rows (enabled, signin, canUninstall, limits), Uninstall, Node.js terminal',
  ...T,
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-wsl-e2e-settings-' });
    try {
      await sh('mkdir -p "$1/bin" "$1/home" && chmod 700 "$1"', [ROOT]);
      await sh(
        'cat > "$1/bin/loginsh" && chmod 755 "$1/bin/loginsh"',
        [ROOT],
        `#!/bin/sh
# AIB e2e: a stand-in login shell (ignores -lic / -lc): HOME inside the test root, a minimal PATH
PATH="/usr/local/bin:/usr/bin:/bin"; export PATH
HOME="${ROOT}/home"; export HOME
shift
exec /bin/sh -c "$1"
`,
      );
      newAib({ helperEnv: (install) => ({ ...helperEnv(install), SHELL: `${ROOT}/bin/loginsh` }) });
      const settings = new SettingsStore(dir);
      await settings.update({ agentsByDistro: { [KEY]: { codex: false } } });

      // the click: start=1 starts the distro
      const [status, prereqs] = await route(settings, 'GET', '/api/live/wsl/prereqs', `distro=${KEY}&peek=1&start=1&force=1`);
      const host = await readyHost();
      const methods = (host as unknown as { methods?: string[] }).methods ?? [];
      const merged = methods.includes('env.prereqs');
      if (merged) {
        assertEquals([status, prereqs.state, prereqs.line], [200, 'ready', '']);
        const p = prereqs.prereqs as Json;
        assert(typeof p.canInstallNode === 'boolean' && typeof (p.node as Json).state === 'string', JSON.stringify(p));
      } else {
        console.log('NOTE: this helper has no env.prereqs yet (the helper builder\'s method): checked the clear refusal instead');
        assertEquals([status, prereqs.code], [400, 'unknown_method'], JSON.stringify(prereqs));
      }

      const [, body] = await route(settings, 'GET', '/api/live/wsl/agents', `distro=${KEY}&peek=1`);
      assertEquals(body.state, 'ready');
      const rows = Object.fromEntries((body.agents as Json[]).map((r) => [r.id, r]));
      assertEquals([rows.claude.enabled, rows.codex.enabled], [true, false], 'the distro switch');
      for (const id of ['claude', 'codex']) {
        assertEquals(rows[id].canUninstall, false, 'nothing installed by AIB in the test root');
        assert(['signed_in', 'signed_out', 'unknown'].includes((rows[id].signin as Json).state as string), JSON.stringify(rows[id].signin));
      }
      if (!methods.includes('agents.signinStatus')) {
        assertEquals((rows.claude.signin as Json).note, `The AIB helper in ${host.distro} cannot check sign-ins yet. Restart AIB.`);
      }
      assertEquals(rows.codex.limits, null, 'no Codex session files in the test home');

      const [code, removed] = await route(settings, 'POST', '/api/live/wsl/agents/uninstall', '', { distro: KEY, id: 'claude' });
      if (methods.includes('agents.uninstall')) {
        // nothing of AIB's installed in the test root: the helper answers ok with nothing removed (idempotent, the design)
        assertEquals([code, removed.ok, removed.removed], [200, true, []], JSON.stringify(removed));
        // its sign-in terminal runs: refused before the helper is asked
        const [busyCode, busy] = await route(settings, 'POST', '/api/live/wsl/agents/uninstall', '', { distro: KEY, id: 'claude' }, [
          { key: `signin:claude@${KEY}` },
        ]);
        assertEquals([busyCode, busy.ok, busy.removed], [200, false, []], JSON.stringify(busy));
        assert(String(busy.blocked).includes('A sign-in to Claude Code'), JSON.stringify(busy));
        // another agent's or another distro's sign-in does not block it
        const [, other] = await route(settings, 'POST', '/api/live/wsl/agents/uninstall', '', { distro: KEY, id: 'claude' }, [
          { key: `signin:codex@${KEY}` },
          { key: 'signin:claude@other' },
        ]);
        assertEquals([other.ok, other.removed], [true, []], JSON.stringify(other));
      } else {
        assertEquals([code, removed.error], [409, `The AIB helper in ${host.distro} is too old to uninstall agents. Restart AIB.`]);
      }

      const node = await wslNodeSetupCommand(KEY);
      if (merged) assert(typeof node === 'string' || node.command.file === '/bin/bash', JSON.stringify(node));
      else assertEquals(node, `The AIB helper in ${host.distro} is too old to install Node.js. Restart AIB.`);
      // nothing outside the test root: the stand-in login shell's HOME
      assertEquals((await host.env()).HOME, `${ROOT}/home`);
    } finally {
      await cleanRoot();
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

/** The stand-in nvm installer: it records PROFILE and writes an nvm whose `install` puts a node of `version` on $HOME/bin. */
function standIn(version: string): string {
  return `#!/bin/bash
# AIB e2e: a stand-in for nvm's install.sh (never the real one)
echo "PROFILE=$PROFILE" > "$HOME/installed"
mkdir -p "$HOME/.nvm"
cat > "$HOME/.nvm/nvm.sh" <<'NVM'
nvm() { mkdir -p "$HOME/bin"; printf '#!/bin/sh\\necho ${version}\\n' > "$HOME/bin/node"; chmod 755 "$HOME/bin/node"; echo "nvm $*"; }
NVM
`;
}

/** The button's script run with bash as the terminal runs it, with a clean environment inside the test root. */
async function runScript(script: string): Promise<{ code: number; out: string }> {
  await sh('mkdir -p "$1/tmp" && cat > "$1/node.sh"', [ROOT], script);
  const done = await inDistro(
    'env -i HOME="$1/home" PATH="$1/home/bin:/usr/bin:/bin" TMPDIR="$1/tmp" bash --noprofile --norc -c "$(cat "$1/node.sh")"',
    [ROOT],
  );
  return { code: done.code, out: done.out + done.err };
}

Deno.test({
  name: 'wsl e2e: the Node.js script in the distro: checksum-gated, PROFILE by login shell, 22.19 minimum, every command printed (stand-ins)',
  ...T,
  async fn() {
    try {
      const tools = await inDistro('command -v curl && command -v sha256sum && command -v bash');
      if (tools.code !== 0) {
        console.log(`NOTE: ${DISTRO} lacks curl, sha256sum or bash: the script test is skipped`);
        return;
      }
      const reset = () => sh('rm -rf -- "$1/home" "$1/tmp" "$1/standin" && mkdir -p "$1/home" "$1/tmp" "$1/standin"', [ROOT]);
      const url = `file://${ROOT}/standin/install.sh`;
      const good = standIn('v24.1.0');
      const sum = await sha256(good);

      // bash, the right file: everything runs, in order, each command printed first
      await reset();
      await sh('cat > "$1/standin/install.sh"', [ROOT], good);
      let run = await runScript(wslNodeScript('/bin/bash', sum, url));
      assertEquals(run.code, 0, run.out);
      for (const step of wslNodeSteps('/bin/bash', sum, url)) assert(run.out.includes(`$ ${step}`), `printed: ${step}\n${run.out}`);
      assert(run.out.includes('Node.js is installed. Choose Check again in AIB.'), run.out);
      assertEquals((await sh('cat "$1/home/installed"', [ROOT])).trim(), `PROFILE=${ROOT}/home/.bashrc`);
      assertEquals((await sh('test -f "$1/home/.bashrc" && ls -A "$1/tmp" | wc -l', [ROOT])).trim(), '0', 'the profile exists, the temp file is gone');

      // zsh: .zshrc
      await reset();
      await sh('cat > "$1/standin/install.sh"', [ROOT], good);
      run = await runScript(wslNodeScript('/usr/bin/zsh', sum, url));
      assertEquals(run.code, 0, run.out);
      assertEquals((await sh('cat "$1/home/installed"', [ROOT])).trim(), `PROFILE=${ROOT}/home/.zshrc`);

      // a changed installer: the check stops everything, it never runs
      await reset();
      await sh('cat > "$1/standin/install.sh"', [ROOT], good + 'echo changed\n');
      run = await runScript(wslNodeScript('/bin/bash', sum, url));
      assert(run.code !== 0 && run.out.includes('Stopped: that command failed'), run.out);
      assert(!run.out.includes('$ PROFILE=') && !run.out.includes('$ nvm install'), run.out);
      assertEquals((await inDistro('test -e "$1/home/installed"', [ROOT])).code, 1, 'the installer did not run');

      // an old Node.js after nvm: refused
      await reset();
      const old = standIn('v22.18.0');
      await sh('cat > "$1/standin/install.sh"', [ROOT], old);
      run = await runScript(wslNodeScript('/bin/bash', await sha256(old), url));
      assert(run.code !== 0 && run.out.includes('Node.js 22.18.0 is older than 22.19.'), run.out);
    } finally {
      await cleanRoot();
    }
  },
});
