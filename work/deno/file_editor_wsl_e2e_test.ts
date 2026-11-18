/**
 * Real WSL (AIB_WSL_E2E=<distro>; see _wsl_e2e.ts): the file editor on a WSL project's files (AIB 0.13.0; files/file_io.ts WslIo,
 * wsl/helper/editor.ts), through the real Linux keeper and helper built from this checkout (tools/build.ts --wsl-only).
 *   - open, type, save: the bytes land in the distro (read back with cat there), no temp file left
 *   - an agent changes another line inside WSL: it merges into the unsaved text; the same line: the save answers 'merged', then
 *     "keep mine" saves
 *   - CRLF and BOM kept (the raw bytes checked with od in the distro); the file's mode (751) and owner kept by the atomic save
 *   - a symlink inside the project: the save writes its target, the link stays a link
 *   - refused: .git, a link out of the project, and the agents' sign-in folders (under test, the agents' home in AIB_WSL_ROOT:
 *     <root>/home/.ssh and .claude)
 * Ignored without AIB_WSL_E2E (or without that distro as WSL2). Everything is inside AIB_WSL_ROOT=/tmp/aib-wsl-test-<random>, removed
 * at the end (cleanRoot); never the owner's homes.
 */
import { assert, assertEquals } from './_assert.ts';
import { cleanRoot, inDistro, KEY, prepareRoot, readyHost, ROOT, T, WSL_E2E } from './_wsl_e2e.ts';
import { LiveFiles } from '../../outputs/agent-studio/server/files/live_files.ts';
import { refOf } from '../../outputs/agent-studio/server/platform/location.ts';

const FAST = { pollMs: 200, tickMs: 100, settleMs: 60, storeMs: 50, closeGraceMs: 300, saveWaitMs: 1500 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

async function sh(script: string, ...args: string[]): Promise<string> {
  const r = await inDistro(script, args);
  if (r.code !== 0) throw new Error(`in the distro: ${script}: ${r.err}`);
  return r.out;
}

Deno.test({
  name: 'WSL file editor: open, save, merge, conflict, CRLF/BOM, mode, symlink, guard (real distro)',
  ...T,
  fn: async () => {
    if (!WSL_E2E) return;
    const state = Deno.makeTempDirSync({ prefix: 'aib-fe-wsl-e2e-' });
    const files = new LiveFiles({
      stateDir: state,
      liveCall: (name) => Promise.resolve(name === 'files-changed' ? [200, { instance: 'i', seq: 0, events: [] }] : [200, { chats: [] }]),
      conversations: () => [],
      connectionOf: () => null,
    }, FAST);
    try {
      await prepareRoot();
      await readyHost();
      const repo = `${ROOT}/repo`;
      const root = refOf({ kind: 'wsl', distro: KEY, linuxPath: repo });
      await sh(
        `cd "$1" && printf 'a\\nb\\nc\\nd\\n' > notes.txt && printf '\\357\\273\\277one\\r\\ntwo\\r\\n' > crlf.txt && ` +
          `printf '#!/bin/sh\\necho hi\\n' > run.sh && chmod 751 run.sh && mkdir -p real && printf 'target\\n' > real/target.txt && ` +
          `ln -s real/target.txt link.txt && printf 'outside\\n' > "$2/outside.txt" && ln -s "$2/outside.txt" out.txt && ` +
          `mkdir -p "$2/home/.ssh" "$2/home/.claude" && printf 'Host x\\n' > "$2/home/.ssh/config" && printf '{}\\n' > "$2/home/.claude/settings.json"`,
        repo,
        ROOT,
      );
      files.start();

      // open, type, save
      const opened = await files.openFile(root, 'notes.txt');
      assert('file' in opened, 'a WSL file opens for editing: ' + JSON.stringify(opened));
      const lf = opened.file;
      assertEquals(lf.place.abs, `wsl://${KEY}${repo}/notes.txt`);
      assertEquals(lf.text.toString(), 'a\nb\nc\nd\n');
      const r1 = await files.save(lf.id, { text: 'A typed\nb\nc\nd\n' });
      assert(r1.ok, 'saved: ' + JSON.stringify(r1));
      assertEquals(await sh('cat "$1/notes.txt"', repo), 'A typed\nb\nc\nd\n');
      assertEquals((await sh('ls -a "$1" | grep -c "^.aib-save-" || true', repo)).trim(), '0', 'no temp file left');

      // the agent changes another line inside WSL: merged into the unsaved text
      lf.doc.transact(() => lf.text.insert(0, 'user '));
      await sh(`printf 'A typed\\nb\\nc\\nd by agent\\n' > "$1/notes.txt.tmp" && mv "$1/notes.txt.tmp" "$1/notes.txt"`, repo);
      await until(
        () => lf.text.toString() === 'user A typed\nb\nc\nd by agent\n',
        'the agent change merged: ' + JSON.stringify(lf.text.toString()),
      );
      const r2 = await files.save(lf.id, {});
      assert(r2.ok, JSON.stringify(r2));
      assertEquals(await sh('cat "$1/notes.txt"', repo), 'user A typed\nb\nc\nd by agent\n');

      // save conflict: the same line on both sides; the overlap is shown and nothing is written until the user saves again
      lf.doc.transact(() => lf.text.insert(0, 'mine '));
      await sh(`printf 'agent wrote line one\\nb\\nc\\nd by agent\\n' > "$1/notes.txt"`, repo);
      await until(() => lf.overlaps.length > 0, 'the overlap');
      assertEquals(await sh('head -1 "$1/notes.txt"', repo), 'agent wrote line one\n');
      assertEquals(lf.text.toString().split('\n')[0], 'mine user A typed', 'the user line stays');
      const r4 = await files.save(lf.id, {});
      assert(r4.ok, 'keep mine: ' + JSON.stringify(r4));
      assertEquals(await sh('head -1 "$1/notes.txt"', repo), 'mine user A typed\n');

      // CRLF and BOM kept
      const crlf = await files.openFile(root, 'crlf.txt');
      assert('file' in crlf);
      assertEquals(crlf.file.base.bom, true);
      assertEquals(crlf.file.base.eolKind, 'crlf');
      const r5 = await files.save(crlf.file.id, { text: 'one\nTWO\nthree\n' });
      assert(r5.ok, JSON.stringify(r5));
      assertEquals(
        (await sh('od -An -tx1 "$1/crlf.txt" | tr -s " \\n" " "', repo)).trim(),
        'ef bb bf 6f 6e 65 0d 0a 54 57 4f 0d 0a 74 68 72 65 65 0d 0a',
      );

      // mode and owner kept
      const before = (await sh('stat -c "%a %u %g" "$1/run.sh"', repo)).trim();
      assert(before.startsWith('751 '), before);
      const run = await files.openFile(root, 'run.sh');
      assert('file' in run);
      const r6 = await files.save(run.file.id, { text: '#!/bin/sh\necho hello\n' });
      assert(r6.ok, JSON.stringify(r6));
      assertEquals((await sh('stat -c "%a %u %g" "$1/run.sh"', repo)).trim(), before, 'mode, owner and group kept');
      assertEquals(await sh('"$1/run.sh"', repo), 'hello\n', 'still runs');

      // a symlink: the save writes its target, the link stays
      const link = await files.openFile(root, 'link.txt');
      assert('file' in link);
      assertEquals(link.file.place.abs, `wsl://${KEY}${repo}/real/target.txt`, 'the link resolves to its target in the distro');
      const r7 = await files.save(link.file.id, { text: 'target edited\n' });
      assert(r7.ok, JSON.stringify(r7));
      assertEquals(await sh('test -L "$1/link.txt" && echo link', repo), 'link\n');
      assertEquals(await sh('cat "$1/real/target.txt"', repo), 'target edited\n');

      // refused: .git, a link out of the project, the agents' sign-in folders
      const codeOf = async (rootRef: string, rel: string) => {
        try {
          const got = await files.openFile(rootRef, rel);
          return 'refused' in got ? String(got.refused) : 'editable';
        } catch (e) {
          return String((e as { code?: string }).code ?? e);
        }
      };
      assertEquals(await codeOf(root, '.git/config'), 'hidden');
      assertEquals(await codeOf(root, 'out.txt'), 'outside');
      const home = refOf({ kind: 'wsl', distro: KEY, linuxPath: `${ROOT}/home` });
      assertEquals(await codeOf(home, '.ssh/config'), 'blocked');
      assertEquals(await codeOf(home, '.claude/settings.json'), 'blocked');
      assertEquals(await sh('cat "$1/home/.ssh/config"', ROOT), 'Host x\n', 'untouched');
    } finally {
      files.close();
      await cleanRoot();
      try {
        Deno.removeSync(state, { recursive: true });
      } catch { /* in use */ }
    }
  },
});
