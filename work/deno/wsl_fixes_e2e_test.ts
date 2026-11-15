/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts) for two fixes that had no test (unit side: wsl_fixes_test.ts):
 *   1. The first set-up's probe gets '-' for "no AIB_WSL_ROOT" (wsl.exe fails with E_INVALIDARG on an empty argument): through the
 *      real runWsl the script answers root=$HOME/.aib-server. Read-only: it prints and checksums files that are not there; nothing
 *      is installed or written in the owner's ~/.aib-server.
 *   2. The New project dialog's check and create of a WSL path run in the distro's helper, inside the test root only
 *      (/tmp/aib-wsl-test-<random>), and answer with refs.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, DISTRO, inDistro, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { PROBE_SCRIPT, runWsl } from '../../outputs/agent-studio/server/wsl/install.ts';
import { WSL_ROOT_DIR } from '../../outputs/agent-studio/server/wsl/contract.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';
import { studioRoutes } from '../../outputs/agent-studio/server/web/studio_routes.ts';
import type { WebContext } from '../../outputs/agent-studio/server/web/server.ts';

type Json = Record<string, unknown>;
const DEC = new TextDecoder();
const ref = (linuxPath: string) => refOf({ kind: 'wsl', distro: KEY, linuxPath });

function probeValues(stdout: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of DEC.decode(stdout).split('\n')) {
    const at = line.indexOf('=');
    if (at > 0 && !out.has(line.slice(0, at))) out.set(line.slice(0, at), line.slice(at + 1));
  }
  return out;
}

Deno.test({
  name: 'wsl e2e: the set-up probe with "-" (no AIB_WSL_ROOT) answers the default root $HOME/.aib-server; with a root, that root',
  ...T,
  async fn() {
    const version = '0.0.0-aib-probe-test'; // a version folder that does not exist: the checksums come back empty
    const plain = await runWsl(DISTRO, ['/bin/sh', '-c', PROBE_SCRIPT, 'sh', '-', version]);
    assertEquals(plain.code, 0, plain.stderr);
    const values = probeValues(plain.stdout);
    const home = values.get('home') ?? '';
    assert(home.startsWith('/'), `home: ${home}`);
    assertEquals(values.get('root'), `${home}/${WSL_ROOT_DIR}`);
    assert(!DEC.decode(plain.stdout).split('\n').some((l) => l.startsWith('sha=') && l !== 'sha='), 'nothing of that version is there');
    const given = await runWsl(DISTRO, ['/bin/sh', '-c', PROBE_SCRIPT, 'sh', ROOT, version]);
    assertEquals([given.code, probeValues(given.stdout).get('root')], [0, ROOT]);
  },
});

Deno.test({
  name: 'wsl e2e: the New project dialog checks and creates folders in the distro (new, existing, missing parent; with and without a name)',
  ...T,
  async fn() {
    await prepareRoot();
    try {
      await readyHost();
      const routes = studioRoutes();
      const ctx = {} as WebContext;
      const check = async (query: Record<string, string>) => {
        const url = new URL('http://127.0.0.1/api/live/folders/check?' + new URLSearchParams(query));
        return await routes.get('GET /api/live/folders/check')!(ctx, url, null, new Request(url)) as [number, Json];
      };
      const create = async (body: Json) => {
        const url = new URL('http://127.0.0.1/api/live/folders/create');
        return await routes.get('POST /api/live/folders/create')!(ctx, url, body, new Request(url)) as [number, Json];
      };
      // a new project named inside an existing folder
      const [s1, fresh] = await check({ path: ref(ROOT), name: 'proj1' });
      assertEquals([s1, fresh.valid, fresh.exists, fresh.path], [200, true, false, ref(`${ROOT}/proj1`)]);
      // an existing folder (the test repo), a missing one whose parent exists, one whose parent is missing
      const [, existing] = await check({ path: ref(`${ROOT}/repo`) });
      assertEquals([existing.valid, existing.exists, existing.path], [true, true, ref(`${ROOT}/repo`)]);
      const [, missing] = await check({ path: ref(`${ROOT}/fresh`) });
      assertEquals([missing.valid, missing.exists], [true, false]);
      const [, orphan] = await check({ path: ref(`${ROOT}/nope/child`) });
      assertEquals(orphan.valid, false, JSON.stringify(orphan));
      // create: with a name and git init, then a folder as the project itself without
      const [s2, made] = await create({ path: ref(ROOT), name: 'proj1', gitInit: true });
      assertEquals([s2, made.path, made.git], [200, ref(`${ROOT}/proj1`), true], JSON.stringify(made));
      const [s3, plain] = await create({ path: ref(`${ROOT}/fresh`), gitInit: false });
      assertEquals([s3, plain.path, plain.git], [200, ref(`${ROOT}/fresh`), false], JSON.stringify(plain));
      const there = await inDistro('test -d "$1/proj1/.git" && test -d "$1/fresh" && ! test -e "$1/fresh/.git" && echo yes', [ROOT]);
      assertEquals(there.out.trim(), 'yes', there.err);
      // now it exists: the check says so, and creating the folder again is refused with the helper's message
      const [, again] = await check({ path: ref(ROOT), name: 'proj1' });
      assertEquals([again.valid, again.exists], [true, true]);
      const [s4, twice] = await create({ path: ref(`${ROOT}/fresh`) });
      assertEquals(s4, 400, JSON.stringify(twice));
      assert(String(twice.error).length > 0);
    } finally {
      await cleanRoot();
    }
  },
});
