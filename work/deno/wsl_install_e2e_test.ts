/**
 * wsl/install.ts in a real WSL distro (docs/wsl/design.md section 7): copy over wsl.exe stdin, SHA-256 checked, 0700 folders and
 * 0755 programs, a second run copies nothing, and older <ver> folders are cleaned while data-* and other folders stay.
 *
 * Runs only with AIB_WSL_E2E=<distro> (a WSL2 distro of this PC), e.g. AIB_WSL_E2E=Ubuntu; ignored otherwise. Everything goes to
 * AIB_WSL_ROOT-style /tmp/aib-wsl-test-<random> (never ~/.aib-server), which is removed at the end. The "programs" are small shell
 * scripts (no Linux build needed); every wsl.exe is hidden and gets the minimal environment. Never `wsl --shutdown`/`--terminate`.
 */
import { createHash } from 'node:crypto';
import { assert, assertEquals } from './_assert.ts';
import { findDistro } from '../../outputs/agent-studio/server/wsl/detect.ts';
import { dataDirName, HELPER_FILE, installWsl, KEEPER_FILE, runWsl, versionOf } from '../../outputs/agent-studio/server/wsl/install.ts';

const WANTED = Deno.env.get('AIB_WSL_E2E') ?? '';
const DISTRO = WANTED ? findDistro(WANTED)?.name ?? '' : '';
const T = { sanitizeResources: false, sanitizeOps: false, ignore: !DISTRO };
const ENC = new TextEncoder();
const DEC = new TextDecoder();

async function sh(script: string, ...args: string[]): Promise<string> {
  const out = await runWsl(DISTRO, ['/bin/sh', '-c', script, 'sh', ...args]);
  if (out.code !== 0) throw new Error(`sh failed (${out.code}): ${out.stderr}`);
  return DEC.decode(out.stdout).trim();
}

function programs(tag: string) {
  return {
    keeper: ENC.encode(`#!/bin/sh\n# keeper ${tag} ${crypto.randomUUID()}\necho keeper\n`),
    helper: ENC.encode(`#!/bin/sh\n# helper ${tag} ${crypto.randomUUID()}\necho helper\n`),
    from: `test ${tag}`,
  };
}

Deno.test({
  name: `install into ${DISTRO || 'a WSL distro (AIB_WSL_E2E unset)'}: copy, checksums, modes, no-op rerun, old versions cleaned`,
  ...T,
  async fn() {
    const root = `/tmp/aib-wsl-test-${crypto.randomUUID().slice(0, 12)}`;
    const stateDir = await Deno.makeTempDir({ prefix: 'aib-wsl-install-' });
    try {
      const first = programs('one');
      const a = await installWsl(DISTRO, {
        stateDir,
        programs: first,
        root,
        appVersion: '0.9.0-test',
      });
      assertEquals(a.version, versionOf(first, '0.9.0-test'));
      assertEquals([a.root, a.keeper, a.helper], [root, `${root}/${a.version}/${KEEPER_FILE}`, `${root}/${a.version}/${HELPER_FILE}`]);
      assertEquals(a.data, `${root}/${dataDirName(stateDir)}`);
      assertEquals(a.copied.length, 2);
      assert(a.home.startsWith('/') && a.uid >= 0 && a.user !== '', JSON.stringify(a));
      assertEquals(await sh('"$1"', a.keeper), 'keeper', 'the copy runs');
      assertEquals(await sh('stat -c %a "$1" "$1/$2" "$1/$2/$3"', root, a.version, KEEPER_FILE), '700\n700\n755');
      const sums = await sh('sha256sum "$1" "$2" | cut -d" " -f1', a.keeper, a.helper);
      const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
      assertEquals(sums.split('\n'), [hex(first.keeper), hex(first.helper)]);
      assertEquals(await sh('ls -A "$1/$2"', root, a.version), `${KEEPER_FILE}\n${HELPER_FILE}`, 'no .part left behind');

      const again = await installWsl(DISTRO, {
        stateDir,
        programs: first,
        root,
        appVersion: '0.9.0-test',
      });
      assertEquals([again.copied, again.removed, again.version], [[], [], a.version], 'a second run is a no-op');

      // A new app version with the same programs (a test build): both are copied inside the distro, nothing over wsl.exe; then
      // the older version's folder is cleaned.
      const same = await installWsl(DISTRO, { stateDir, programs: first, root, appVersion: '0.9.0-test2' });
      assert(same.version !== a.version);
      assertEquals([same.copied, same.reused, same.removed], [[], [same.keeper, same.helper], [a.version]]);
      assertEquals(await sh('"$1"', same.keeper), 'keeper', 'the reused copy runs');
      assertEquals(await sh('stat -c %a "$1"', same.helper), '755');
      assertEquals(await sh('ls -A "$1/$2"', root, same.version), `${KEEPER_FILE}\n${HELPER_FILE}`, 'no .part left behind');

      await sh('mkdir -p "$1/0.0.1-deadbeef" "$1/data-123456789abc" "$1/notes" && touch "$1/0.0.1-deadbeef/x"', root);
      const second = await installWsl(DISTRO, {
        stateDir,
        programs: programs('two'),
        root,
        appVersion: '0.9.1-test',
      });
      assertEquals(second.copied.length, 2);
      assertEquals(second.removed.sort(), ['0.0.1-deadbeef', same.version].sort());
      assertEquals((await sh('ls -A "$1"', root)).split('\n').sort(), [second.version, 'data-123456789abc', 'notes'].sort());
    } finally {
      await sh('case "$1" in /tmp/aib-wsl-test-*) rm -rf -- "$1";; esac', root)
        .catch(() => {});
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: 'install refuses what it cannot use: another CPU, and never runs with a ~ path',
  ...T,
  async fn() {
    const root = `/tmp/aib-wsl-test-${crypto.randomUUID().slice(0, 12)}`;
    const stateDir = await Deno.makeTempDir({ prefix: 'aib-wsl-install-' });
    const seen: string[][] = [];
    try {
      let code = '';
      try {
        await installWsl(DISTRO, {
          stateDir,
          programs: programs('arch'),
          root,
          arch: 'riscv64',
          run: (d, argv, o) => (seen.push(argv), runWsl(d, argv, o)),
        });
      } catch (error) {
        code = (error as { code?: string }).code ?? '';
      }
      assertEquals(code, 'arch');
      assert(seen.length === 1 && seen.flat().every((a) => !a.startsWith('~')), JSON.stringify(seen));
      assertEquals(await sh('[ -e "$1" ] && echo there || echo absent', root), 'absent', 'nothing copied');
    } finally {
      await sh('case "$1" in /tmp/aib-wsl-test-*) rm -rf -- "$1";; esac', root)
        .catch(() => {});
      await Deno.remove(stateDir, { recursive: true }).catch(() => {});
    }
  },
});
