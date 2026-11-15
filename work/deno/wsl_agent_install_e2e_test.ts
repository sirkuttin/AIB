/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): AIB-managed agent installs inside the distro (helper/agent_install.ts through
 * the real helper channel, wsl/agent_install.ts on the Windows side). No network and no real agent: everything lives in the test's
 * AIB_WSL_ROOT (/tmp/aib-wsl-test-<random>), removed afterwards.
 *   1. The distro as it is: when its login shell has no Node.js, the check, the panel line and the refused Install say so, with the
 *      command that installs it, and nothing is created. On a distro that has Node.js (also through asdf / mise / volta shims), the
 *      check finds it and its npm; nothing is installed.
 *   2. A stand-in login shell whose PATH starts at <root>/bin: first no Node.js; then (as nvm would, by a new PATH entry) a stub `node` (a shell script that answers
 *      --version 22 and runs its script with sh) and a stub npm-cli.js that copies the adapter from a local "registry" folder. Check
 *      again sees the new node, Install runs `npm ci` into <root>/agents/claude/<version> with AIB's lockfile and the npm cache inside
 *      the root, progress arrives as notifications, agents.detect and a WSL chat's launch use AIB's install, and Cancel kills npm and
 *      removes the half-made folder.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, DISTRO, inDistro, KEY, newAib, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { helperEnv } from '../../outputs/agent-studio/server/wsl/hosts.ts';
import { installFacts, lastProgress, NODE_INSTALL, wslInstallCall } from '../../outputs/agent-studio/server/wsl/agent_install.ts';
import { Studio } from '../../outputs/agent-studio/server/host/studio.ts';
import { APP_ROOT } from '../../outputs/agent-studio/server/core/app.ts';

type Json = Record<string, unknown>;
const ALLOW = JSON.parse(Deno.readTextFileSync(`${APP_ROOT}/agent_versions.json`)).agents;
const CLAUDE = { pkg: ALLOW.claude.package as string, version: ALLOW.claude.version as string };
const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sh(script: string, args: string[] = [], stdin?: string): Promise<string> {
  const done = await inDistro(script, args, stdin === undefined ? undefined : enc(stdin));
  if (done.code !== 0) throw new Error(`in ${DISTRO}: ${script}\n${done.err}`);
  return done.out;
}

async function until<V>(what: string, check: () => Promise<V | null | undefined | false>, seconds = 60): Promise<V> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(300);
  }
}

Deno.test({
  name: 'wsl e2e: agent install in the distro as it is: Node.js and npm found (also behind a version manager shim), or a clear line and nothing created',
  ...T,
  async fn() {
    try {
      const host = await readyHost();
      const check = await host.call('agents.installCheck', { force: true });
      if (check.code === '') {
        // Node.js is there (for example through a version manager's shim, whose npm is next to the node it really runs): the check
        // finds node and npm; nothing is installed here. The Node.js-missing case is then covered by the next test only.
        console.log(`  ${DISTRO} has Node.js ${check.nodeVersion} (${check.node}) with npm: the Node.js-missing case runs in the next test`);
        assertEquals(check.npm, true);
        assert(Number(check.nodeVersion.split('.')[0]) >= 22, check.nodeVersion);
        return;
      }
      assertEquals(check.code, 'node_missing', JSON.stringify(check));
      const facts = await installFacts(host, KEY, DISTRO, [{ id: 'claude', found: false }]);
      assertEquals(facts.claude.installBlock, `Node.js 22 or newer is needed in ${DISTRO} to install Claude Code, and ${DISTRO} has no Node.js.`);
      assertEquals(facts.claude.nodeInstall, NODE_INSTALL);
      const [status, body] = await wslInstallCall(host, KEY, DISTRO, 'start', 'claude');
      assertEquals([status, (body as Json).code, (body as Json).nodeInstall], [409, 'node_missing', NODE_INSTALL]);
      assertEquals((await sh('[ -e "$1/agents/claude" ] && echo yes || echo no', [ROOT])).trim(), 'no', 'nothing was created');
    } finally {
      await cleanRoot();
    }
  },
});

/** The stand-ins: a login shell, node, npm-cli.js and the adapter package in a local registry folder. */
async function prepareStubs(): Promise<void> {
  await sh('mkdir -p "$1/bin" "$1/nodebin" "$1/lib/node_modules/npm/bin" "$1/home" "$1/registry/claude/dist" && chmod 700 "$1"', [ROOT]);
  const put = (path: string, text: string, mode = '644') => sh(`cat > "$1" && chmod ${mode} "$1"`, [path], text);
  await put(
    `${ROOT}/bin/loginsh`,
    `#!/bin/sh
# AIB e2e: a stand-in login shell (ignores -lic / -lc); its PATH starts at the test's bin folder, its HOME is inside the test root
PATH="${ROOT}/bin:/usr/local/bin:/usr/bin:/bin"
# what installing Node.js with nvm does: a new folder on the login PATH
if [ -f "${ROOT}/nvm-on" ]; then PATH="${ROOT}/nodebin:$PATH"; fi
export PATH
HOME="${ROOT}/home"; export HOME
shift
exec /bin/sh -c "$1"
`,
    '755',
  );
  await put(
    `${ROOT}/lib/node_modules/npm/bin/npm-cli.js`,
    `# AIB e2e: a stub npm (run by the stub node with sh). Only \`ci --prefix <folder>\`: copies the adapter from the local registry.
echo "$@" > "${ROOT}/npm-args.txt"
echo "$npm_config_cache" > "${ROOT}/npm-cache.txt"
cmd="$1"; shift; prefix=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift 2;; *) shift;; esac; done
[ "$cmd" = ci ] || { echo "npm error stub knows only ci" >&2; exit 1; }
[ -f "$prefix/package-lock.json" ] || { echo "npm error lock file missing" >&2; exit 1; }
cp "$prefix/package-lock.json" "${ROOT}/lock-used.json"
mkdir -p "$prefix/node_modules/@agentclientprotocol/x"
if [ -f "${ROOT}/slow" ]; then sleep 37.5; fi
mkdir -p "$prefix/node_modules/@agentclientprotocol"
rm -rf "$prefix/node_modules/@agentclientprotocol/x"
cp -R "${ROOT}/registry/claude" "$prefix/node_modules/${CLAUDE.pkg}"
`,
  );
  await put(
    `${ROOT}/registry/claude/package.json`,
    JSON.stringify({ name: CLAUDE.pkg, version: CLAUDE.version, bin: { 'claude-agent-acp': 'dist/index.js' } }),
  );
  await put(`${ROOT}/registry/claude/dist/index.js`, `exec python3 "${ROOT}/fake_acp.py" "$@"\n`);
}

const STUB_NODE = `#!/bin/sh
# AIB e2e: a stub node: answers --version like Node.js 22 and runs its script with sh
if [ "$1" = "--version" ]; then echo v22.11.0; exit 0; fi
exec /bin/sh "$@"
`;

Deno.test({
  name: 'wsl e2e: agent install with a stub node and npm: Check again finds node, npm ci into ~/.aib-server/agents, detect and launch use it, Cancel',
  ...T,
  async fn() {
    const state = Deno.makeTempDirSync({ prefix: 'aib-wsl-install-e2e-' });
    let studio: Studio | null = null;
    try {
      await prepareStubs();
      newAib({ helperEnv: (install) => ({ ...helperEnv(install), SHELL: `${ROOT}/bin/loginsh` }) });
      const host = await readyHost();
      assertEquals((await host.call('agents.installCheck', {})).code, 'node_missing', 'no node on the stand-in PATH yet');

      // the user installs Node.js in a terminal; the helper's PATH is read again only on Check again (force) or after a while
      await sh('cat > "$1/nodebin/node" && chmod 755 "$1/nodebin/node" && touch "$1/nvm-on"', [ROOT], STUB_NODE);
      assertEquals((await host.call('agents.installCheck', {})).code, 'node_missing', 'not read again on every call');
      const check = await host.call('agents.installCheck', { force: true });
      assertEquals([check.code, check.node, check.nodeVersion], ['', `${ROOT}/nodebin/node`, '22.11.0']);

      // Install in Ubuntu
      const [status, started] = await wslInstallCall(host, KEY, DISTRO, 'start', 'claude');
      assertEquals(status, 200, JSON.stringify(started));
      const done = await until('the install to finish', async () => {
        const [, s] = await wslInstallCall(host, KEY, DISTRO, 'status', 'claude');
        const state = (s as Json).state;
        if (state === 'failed') throw new Error(`the install failed: ${JSON.stringify(s)}`);
        return state === 'done' ? s : null;
      });
      assertEquals((done as Json).version, CLAUDE.version);
      const folder = `${ROOT}/agents/claude/${CLAUDE.version}`;
      assertEquals((await sh('[ -f "$1/.complete" ] && echo yes', [folder])).trim(), 'yes', 'the marker is written last');
      const args = (await sh('cat "$1/npm-args.txt"', [ROOT])).trim();
      assert(args.startsWith(`ci --prefix ${folder}`) && args.includes('--ignore-scripts') && !/(^| )(-g|--global)( |$)/.test(args), args);
      assertEquals((await sh('cat "$1/npm-cache.txt"', [ROOT])).trim(), `${ROOT}/agents/.npm-cache`, "npm's cache inside AIB's folder");
      const lockHash = (await sh('sha256sum "$1/lock-used.json"', [ROOT])).split(' ')[0];
      const want = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Deno.readFileSync(`${APP_ROOT}/${ALLOW.claude.lockfile}`))))
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      assertEquals(lockHash, want, "npm ci ran with AIB's reviewed lockfile, byte for byte");
      assertEquals((await sh('ls -A "$1" 2>/dev/null | wc -l', [`${ROOT}/home`])).trim(), '0', 'nothing was written to the home folder');
      await until('the done notification', () => Promise.resolve(lastProgress(KEY, 'claude')?.state === 'done'), 10);

      // agents.detect finds AIB's own install first; the panel calls it managed and current; a WSL chat would start it
      const row = (await host.call('agents.detect', { ids: ['claude'] })).agents[0];
      assertEquals([row.found, row.source, row.version], [true, 'studio', CLAUDE.version], JSON.stringify(row));
      assertEquals(row.command?.[0], `${ROOT}/nodebin/node`);
      assert(String(row.command?.[1]).startsWith(`${folder}/node_modules/${CLAUDE.pkg}/`), String(row.command));
      const facts = await installFacts(host, KEY, DISTRO, [row]);
      assertEquals(facts.claude, { installable: true, pinned: CLAUDE.version, managed: true });
      // Cancel: npm (here a stub sleeping in it) is killed with its children and the half-made folder removed
      await sh('touch "$1/slow" && rm -rf "$1/agents/claude"', [ROOT]);
      const [s2, b2] = await wslInstallCall(host, KEY, DISTRO, 'start', 'claude');
      assertEquals(s2, 200, JSON.stringify(b2));
      await until('npm to be running', async () => (await sh('[ -d "$1/node_modules/@agentclientprotocol/x" ] && echo y || echo n', [folder])).trim() === 'y', 30);
      const [s3, cancelled] = await wslInstallCall(host, KEY, DISTRO, 'cancel', 'claude');
      assertEquals([s3, (cancelled as Json).state], [200, 'idle']);
      assertEquals((await sh('[ -e "$1" ] && echo yes || echo no', [folder])).trim(), 'no', 'the half-made folder is gone');
      const left = (await sh('pgrep -f "slee[p] 37.5" | wc -l')).trim();
      assertEquals(left, '0', 'npm and what it started were killed');

      // a WSL chat with Claude Code starts AIB's install
      await sh('rm -f "$1/slow"', [ROOT]);
      await wslInstallCall(host, KEY, DISTRO, 'start', 'claude');
      await until('the reinstall', async () => ((await wslInstallCall(host, KEY, DISTRO, 'status', 'claude'))[1] as Json).state === 'done');
      studio = new Studio({ ompCommand: 'unused', stateDir: state, port: 0, ownersDir: null, noArtifactTool: true }, { keeper: null });
      const launch = await studio.wslLaunch('claude', { distro: KEY, linuxPath: ROOT });
      assertEquals(launch.command, row.command);
    } finally {
      await cleanRoot();
      await studio?.close().catch(() => {}); // after: closing a Studio stops its WSL hosts
      Deno.removeSync(state, { recursive: true });
    }
  },
});
