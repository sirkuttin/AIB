/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the Files view and Changes of a WSL project through the distro's helper (design
 * section 7, wsl_files_changes_e2e): list, search, read, a changed and an untracked file, the diff, an exec-bit change, and the
 * case-distinct files Foo and foo (which Windows rules would merge).
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, T } from './_wsl_e2e.ts';
import { refOf } from '../../app/server/platform/location.ts';
import { wslLoc } from '../../app/server/wsl/access.ts';
import { wslFiles } from '../../app/server/web/wsl_routes.ts';
import { changesResponse } from '../../app/server/worktrees/chat_folders.ts';

type Json = Record<string, unknown>;

Deno.test({
  name: 'wsl e2e: Files and Changes of a WSL repo come from the distro (Foo and foo kept apart, exec bit, untracked, diff)',
  ...T,
  async fn() {
    await prepareRoot();
    try {
      await readyHost();
      const made = await inDistro(
        'cd "$1/repo" && echo F > Foo && echo f > foo && git add Foo foo && git commit -qm two && echo two >> a.txt && ' +
          'echo new > untracked.txt && printf "#!/bin/sh\\n" > run.sh && git add run.sh && git commit -qm three && chmod +x run.sh',
        [ROOT],
      );
      assertEquals(made.code, 0, made.err);
      const ref = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/repo` });
      const wsl = wslLoc(ref)!;
      const [s1, list] = await wslFiles('list', ref, wsl, {});
      assertEquals(s1, 200);
      const names = JSON.stringify(list);
      assert(names.includes('"Foo"') && names.includes('"foo"'), 'both case-distinct files are listed');
      const [, read] = await wslFiles('read', ref, wsl, { path: ['Foo'] });
      assertEquals((read as Json).text, 'F\n');
      const [, found] = await wslFiles('search', ref, wsl, { q: ['untracked'] });
      assert(JSON.stringify(found).includes('untracked.txt'));
      const aib = { liveState: () => ({ cwd: ref }), token: 't', stateDir: null };
      const [s2, changes] = await changesResponse(aib, '/api/live/changes', { id: ['c'] }, { 'X-Studio-Token': 't' });
      assertEquals(s2, 200);
      const text = JSON.stringify(changes);
      assert(text.includes('a.txt') && text.includes('untracked.txt') && text.includes('run.sh'), text);
      const [s3, diff] = await changesResponse(aib, '/api/live/changes/file', { id: ['c'], path: ['a.txt'] }, { 'X-Studio-Token': 't' });
      assertEquals(s3, 200);
      assert(JSON.stringify(diff).includes('two'));
    } finally {
      await cleanRoot();
    }
  },
});
