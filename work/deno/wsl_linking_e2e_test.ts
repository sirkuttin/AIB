/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): Settings > AIB Linking (WSL), phase 1 (docs/wsl/linking-design.md section 11
 * items 1 and 4). No network, nothing real installed, nothing run but shell stubs: everything lives in the test's AIB_WSL_ROOT
 * (/tmp/aib-wsl-test-<random>), removed afterwards.
 *   1. Peek: before anything used the distro, GET /api/live/wsl/agents?peek=1 and the status poll answer 'off' and make no host
 *      (so nothing can start the distro).
 *   2. Codex through an asdf shim: a stand-in login shell whose PATH is <root>/asdf/shims (asdf's layout: shell-script shims for
 *      node, npm and codex-acp; the real prefix in <root>/asdf/installs/nodejs/24.0.0 with a fake @agentclientprotocol/codex-acp and
 *      the @openai/codex CLI it ships). npm's shim fails ("No version is set"), so the global lookup cannot see the package and only
 *      the codex-acp shim on PATH is left: agents.detect resolves it to [real node, entry], finds the bundled CLI (signin,
 *      bundledCli), the /wsl/agents row says so, and the Codex sign-in uses that CLI.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, DISTRO, inDistro, KEY, newAib, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { helperEnv, wslHostsInUse } from '../../app/server/wsl/hosts.ts';
import { wslRoutes, wslStatus } from '../../app/server/web/wsl_routes.ts';
import { wslSigninCommand } from '../../app/server/web/terminal_routes.ts';
import type { WebContext } from '../../app/server/web/server.ts';

type Json = Record<string, unknown>;
const enc = (s: string) => new TextEncoder().encode(s);

async function sh(script: string, args: string[] = [], stdin?: string): Promise<string> {
  const done = await inDistro(script, args, stdin === undefined ? undefined : enc(stdin));
  if (done.code !== 0) throw new Error(`in ${DISTRO}: ${script}\n${done.err}`);
  return done.out;
}

async function agentsRoute(query: string): Promise<[number, Json]> {
  const handler = wslRoutes().get('GET /api/live/wsl/agents')!;
  const url = new URL(`http://127.0.0.1/api/live/wsl/agents?${query}`);
  const ctx = { token: 't', stateDir: null } as unknown as WebContext;
  const [status, body] = await handler(ctx, url, null, new Request(url, { headers: { 'X-Studio-Token': 't' } }));
  return [status, body as Json];
}

const PREFIX = `${ROOT}/asdf/installs/nodejs/24.0.0`;
const NODE = `${PREFIX}/bin/node`;
const ADAPTER = `${PREFIX}/lib/node_modules/@agentclientprotocol/codex-acp`;
const CLI = `${ADAPTER}/node_modules/@openai/codex/bin/codex.js`;

/** asdf's layout inside the root, a stand-in login shell with only its shims on PATH. */
async function prepareShims(): Promise<void> {
  await sh('mkdir -p "$1/bin" "$1/home" "$1/asdf/shims" "$2/bin" "$3/dist" "$3/node_modules/@openai/codex/bin" && chmod 700 "$1"', [ROOT, PREFIX, ADAPTER]);
  const put = (path: string, text: string, mode = '644') => sh(`cat > "$1" && chmod ${mode} "$1"`, [path], text);
  await put(
    `${ROOT}/bin/loginsh`,
    `#!/bin/sh
# AIB e2e: a stand-in login shell (ignores -lic / -lc): PATH has asdf's shims, HOME is inside the test root
PATH="${ROOT}/asdf/shims:/usr/local/bin:/usr/bin:/bin"; export PATH
HOME="${ROOT}/home"; export HOME
shift
exec /bin/sh -c "$1"
`,
    '755',
  );
  // asdf's shims are shell scripts that run the program through asdf; these run the stand-in prefix directly
  await put(`${ROOT}/asdf/shims/node`, `#!/bin/sh\n# asdf-plugin: nodejs 24.0.0\nexec "${NODE}" "$@"\n`, '755');
  await put(`${ROOT}/asdf/shims/npm`, `#!/bin/sh\n# asdf-plugin: nodejs 24.0.0\necho "No version is set for command npm" >&2\nexit 126\n`, '755');
  await put(`${ROOT}/asdf/shims/codex-acp`, `#!/bin/sh\n# asdf-plugin: nodejs 24.0.0\nexec asdf exec "codex-acp" "$@"\n`, '755');
  // the real node of that prefix: a stub that answers --version and process.execPath, nothing else
  await put(NODE, `#!/bin/sh\n# AIB e2e: a stub node\ncase "$1" in --version) echo v24.0.0;; -p) echo "$0";; *) exit 1;; esac\n`, '755');
  await put(`${ADAPTER}/package.json`, JSON.stringify({ name: '@agentclientprotocol/codex-acp', version: '2.6.0', bin: { 'codex-acp': 'dist/index.js' } }));
  await put(`${ADAPTER}/dist/index.js`, '// AIB e2e: a fake adapter entry (never run)\n');
  await put(CLI, '// AIB e2e: a fake codex CLI (never run)\n');
}

Deno.test({
  name: 'wsl e2e: Settings peek before AIB used the distro makes no host (nothing starts it)',
  ...T,
  async fn() {
    try {
      newAib();
      const [status, body] = await agentsRoute(`distro=${KEY}&peek=1`);
      assertEquals([status, body.state, body.line, body.agents], [200, 'off', '', []]);
      const seen = ((await wslStatus({ stateDir: null })).distros as Json[]).find((d) => d.key === KEY);
      assertEquals([seen?.state, seen?.line, typeof seen?.isDefault], ['off', '', 'boolean']);
      const signin = await wslSigninCommand('codex', KEY);
      assert(typeof signin === 'string' && signin.includes('is not running'), String(signin));
      assertEquals(wslHostsInUse()?.peek(KEY) ?? null, null, 'no host was made for the distro');
    } finally {
      await cleanRoot();
    }
  },
});

Deno.test({
  name: 'wsl e2e: Codex behind an asdf shim: detect resolves it to [real node, entry], finds the bundled CLI, the sign-in uses it',
  ...T,
  async fn() {
    try {
      await prepareShims();
      newAib({ helperEnv: (install) => ({ ...helperEnv(install), SHELL: `${ROOT}/bin/loginsh` }) });
      const host = await readyHost();
      const row = (await host.call('agents.detect', { ids: ['codex', 'claude'] })).agents;
      const codex = row.find((a) => a.id === 'codex')!;
      assertEquals([codex.found, codex.source, codex.version], [true, 'installed', '2.6.0'], JSON.stringify(codex));
      assertEquals(codex.command, [NODE, `${ADAPTER}/dist/index.js`]);
      assertEquals(codex.signin, [NODE, CLI]);
      assertEquals(codex.bundledCli, true);
      const claude = row.find((a) => a.id === 'claude')!;
      assertEquals([claude.found, claude.bundledCli], [false, false]);

      // Settings' row, peeking at the ready distro
      const [status, body] = await agentsRoute(`distro=${KEY}&peek=1`);
      assertEquals([status, body.state], [200, 'ready']);
      const shown = (body.agents as Json[]).find((a) => a.id === 'codex')!;
      assertEquals([shown.found, shown.bundledCli, shown.version], [true, true, '2.6.0']);

      // the Codex sign-in runs the CLI the adapter ships, never a `codex` from PATH
      assertEquals(await wslSigninCommand('codex', KEY), { file: NODE, args: [CLI, 'login'] });
    } finally {
      await cleanRoot();
    }
  },
});
