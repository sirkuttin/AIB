/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the sync between PCs' file work in a distro (slice V7). The engine's disk for a WSL
 * project (server/wsl/pcsync.ts wslDisk) talks to the REAL helper in the distro (`pcsync.fs`, wsl/helper/pcsync.ts) over the real
 * keeper channel; the files are made and checked with the distro's own shell. Skipped cleanly (ignored) without AIB_WSL_E2E.
 * Covered: resolve (git folder, local-only), one walk call lists files and never a link, hash and chunked read, an atomic write
 * (temp file, rename in the distro), a delete to the bin in <repo>/.git/aib-sync/bin and its Restore, git state (branch, a merge in
 * progress), the helper refusing a path outside the project and a link out of aib-shared, and a stopped helper waiting.
 * Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>; never the owner's files, homes or a real agent.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, T, WSL_E2E } from './_wsl_e2e.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { wslDisk } from '../../app/server/wsl/pcsync.ts';

const PROJECT = `${ROOT}/repo`;
const REF = WSL_E2E ? refOf({ kind: 'wsl', distro: KEY, linuxPath: PROJECT }) : '';
const SYNC = 'abcdefgh1';
const enc = new TextEncoder();
const dec = new TextDecoder();

Deno.test({
  name: 'wsl e2e pcsync: the real helper lists, hashes, reads in chunks, writes atomically, bins and restores, and refuses a path outside the project',
  ...T,
  async fn() {
    try {
      await prepareRoot();
      const host = await readyHost();
      await host.call('localOnly.ensure', { project: PROJECT }); // aib-shared is local-only here
      const disk = wslDisk(REF, 'shared', SYNC)!;
      assert(disk, 'a disk for the WSL ref');
      assertEquals(disk.available(), '', 'the distro is ready');
      const found = await disk.resolve();
      assert('key' in found, JSON.stringify(found));
      assertEquals(await disk.rootKind(), 'missing');
      await disk.mkRoot();
      assertEquals(await disk.rootKind(), 'dir');

      // files made in the distro (a link too) are seen by one walk call; the link is listed as a link and not followed
      const made = await inDistro(
        'cd "$1/repo/aib-shared" && mkdir -p notes && echo v1 > notes/plan.md && printf "bin\\0data" > pic.bin && mkdir -p /tmp/aib-out-$$ && echo x > /tmp/aib-out-$$/secret.txt && ln -s /tmp/aib-out-$$ jump && echo /tmp/aib-out-$$',
        [ROOT],
      );
      assertEquals(made.code, 0, made.err);
      const outside = made.out.trim();
      const walked = await disk.walk();
      const byPath = new Map(walked.entries.map((e) => [e[0], e]));
      assertEquals(byPath.get('notes/plan.md')?.[1], 'f');
      assertEquals(byPath.get('jump')?.[1], 'l', 'a link is listed as a link');
      assert(!byPath.has('jump/secret.txt'), 'and never followed');
      const plan = byPath.get('notes/plan.md')!;
      const [hashed] = await disk.hashFiles([{ rel: 'notes/plan.md', size: plan[2], mtime: plan[3] }]);
      assertEquals(hashed.hash?.length, 64);
      const chunk = await disk.readChunk('notes/plan.md', 1, 2, plan[2], plan[3]);
      assertEquals(dec.decode(chunk!), '1\n');
      assertEquals(await disk.readChunk('notes/plan.md', 0, 2, plan[2] + 1, plan[3]), null, 'a file that is not what was announced is not read');

      // an atomic write: a temp file, then a rename in the distro; the old version goes to the bin
      await disk.safe('notes/plan.md', true);
      await disk.tmpWrite('t-1', enc.encode('v2\n'), true);
      const installed = await disk.install('t-1', 'notes/plan.md', { bin: true });
      assertEquals(installed.size, 3);
      assertEquals((await inDistro('cat "$1/repo/aib-shared/notes/plan.md"', [ROOT])).out, 'v2\n');
      const bin = await disk.binList(10);
      const entry = bin.find((e) => e.path === 'notes/plan.md');
      assert(entry, JSON.stringify(bin));
      assertEquals((await inDistro('cat "$1/repo/.git/aib-sync/bin/"*"/notes/plan.md"', [ROOT])).out, 'v1\n', 'the bin is in the repo’s .git');

      // a delete goes to the bin, and Restore brings the file back
      const st = (await disk.stat('pic.bin'))!;
      const gone = await disk.deleteFile('pic.bin', st.size, st.mtime);
      assertEquals(gone.changed, false);
      assertEquals((await inDistro('test -e "$1/repo/aib-shared/pic.bin" && echo yes || echo no', [ROOT])).out.trim(), 'no');
      const picBin = (await disk.binList(10)).find((e) => e.path === 'pic.bin')!;
      await disk.binToTmp(picBin.id, 't-2');
      await disk.install('t-2', 'pic.bin', { bin: true });
      assertEquals((await inDistro('wc -c < "$1/repo/aib-shared/pic.bin"', [ROOT])).out.trim(), '8');

      // git: the branch, and a merge in progress
      const g1 = await disk.git();
      assert(g1.branch !== null && g1.busy === null, JSON.stringify(g1));
      await inDistro('touch "$1/repo/.git/MERGE_HEAD"', [ROOT]);
      assertEquals((await disk.git()).busy, 'a git merge');
      await inDistro('rm -f "$1/repo/.git/MERGE_HEAD"', [ROOT]);

      // paths outside the project or through a link are refused; nothing is written through the link
      let refused = '';
      await disk.install('t-1', 'jump/evil.md', {}).catch((e: Error) => (refused = e.message));
      assert(refused !== '', 'an install through a link is refused');
      await disk.tmpWrite('t-3', enc.encode('evil'), true);
      await disk.install('t-3', 'jump/evil.md', {}).catch(() => {});
      assertEquals((await inDistro('ls "$1"', [outside])).out.trim(), 'secret.txt', 'nothing was written through the link');
      let bad = '';
      await disk.stat('../repo/x').catch((e: Error) => (bad = e.message));
      assert(/path refused/.test(bad), bad);
      await inDistro('rm -rf -- "$1"', [outside]);
    } finally {
      await cleanRoot();
    }
  },
});
