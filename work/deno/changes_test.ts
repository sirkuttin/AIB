/**
 * server/worktrees/changes.ts: the ChangesTests of work/test_changes.py (real git in temp repos), plus parity with Python on the
 * same repositories. Skipped: ChangesRouteTests (HTTP routes; the response logic is covered in chat_folders_test.ts).
 */
import { assert, assertEquals, assertRejects } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { git, HAVE_GIT, TempRepo, write, writeBytes } from './_git_repo.ts';
import {
  ChangesError,
  type ChangesResult,
  getChanges,
  getFileDiff,
  MAX_DIFF_BYTES,
  MAX_FILES,
  MAX_LINE_CHARS,
  parseHunks,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  safeRelpath,
  statusLetter,
} from '../../outputs/agent-studio/server/worktrees/changes.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';

const enc = (text: string) => new TextEncoder().encode(text);
const test = (name: string, fn: () => Promise<void> | void) => Deno.test({ name, ignore: !HAVE_GIT, fn });

async function listing(cwd: string): Promise<Record<string, NonNullable<ChangesResult['files']>[number]>> {
  return Object.fromEntries(((await getChanges(cwd)).files ?? []).map((f) => [f.path, f]));
}

test('a non-git folder', async () => {
  using r = new TempRepo();
  const plain = osp.join(r.root, 'plain');
  Deno.mkdirSync(plain);
  assertEquals(await getChanges(plain), { git: false });
  assertEquals(await getChanges(osp.join(r.root, 'missing')), { git: false });
});

test('a clean repo has no files', async () => {
  using r = new TempRepo();
  const data = await getChanges(r.repo);
  assertEquals([data.git, data.files, data.totals!.files, data.truncated], [true, [], 0, false]);
});

function everyKind(r: TempRepo): void {
  write(r.p('mod.txt'), 'a\nB\nc\nd\ne\n');
  Deno.removeSync(r.p('gone.txt'));
  write(r.p('new.txt'), 'one\ntwo\nthree\n');
  git(r.repo, 'add', 'new.txt');
  write(r.p('loose.txt'), 'l1\nl2\n');
  writeBytes(r.p('pic.bin'), [0, 9, 9, 9, 9]);
  writeBytes(r.p('bin-new.dat'), [97, 98, 0, 99, 100]);
  git(r.repo, 'mv', 'old.txt', 'renamed.txt');
}

test('every kind of change, and Python sees the same', async () => {
  using r = new TempRepo();
  everyKind(r);
  const files = await listing(r.repo);
  assertEquals(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.status])), {
    'mod.txt': 'M',
    'gone.txt': 'D',
    'new.txt': 'A',
    'loose.txt': 'U',
    'pic.bin': 'M',
    'bin-new.dat': 'U',
    'renamed.txt': 'R',
  });
  assertEquals([files['mod.txt'].added, files['mod.txt'].removed], [2, 1]);
  assertEquals([files['gone.txt'].added, files['gone.txt'].removed], [0, 2]);
  assertEquals([files['new.txt'].added, files['loose.txt'].added], [3, 2]);
  assert(files['pic.bin'].binary);
  assert(files['bin-new.dat'].binary);
  assertEquals(files['bin-new.dat'].added, 0);
  assertEquals(files['renamed.txt'].oldPath, 'old.txt');
  const data = await getChanges(r.repo);
  assertEquals(data.totals!.files, 7);
  assertEquals(data.totals!.added, data.files!.reduce((s, f) => s + f.added, 0));
  assert(osp.isdir(data.root!));
  await using py = new PyParity();
  assertEquals(data, await py.call('changes', 'get_changes', [r.repo]));
  for (const path of ['mod.txt', 'gone.txt', 'new.txt', 'loose.txt', 'pic.bin', 'bin-new.dat', 'renamed.txt', 'sub/in.txt', 'nope']) {
    let mine: unknown;
    try {
      mine = await getFileDiff(r.repo, path);
    } catch (error) {
      mine = { error: (error as ChangesError).message, code: (error as ChangesError).code };
    }
    assertEquals(mine, await py.call('desktop_shim', 'changes_file_diff', [r.repo, path]), path);
  }
});

test('file diff hunks', async () => {
  using r = new TempRepo();
  write(r.p('mod.txt'), 'a\nB\nc\nd\ne\n');
  const diff = await getFileDiff(r.repo, 'mod.txt');
  assertEquals([diff.status, diff.binary, diff.truncated, diff.added, diff.removed], ['M', false, false, 2, 1]);
  assertEquals(diff.hunks!.length, 1);
  assert(diff.hunks![0].header.startsWith('@@ -1,4 +1,5 @@'));
  assertEquals(diff.hunks![0].lines.filter((l) => '+-'.includes(l[0])), ['-b', '+B', '+e']);
  assert(osp.isabs(diff.abs!));
});

test('untracked files show as all added, per file inside a new folder', async () => {
  using r = new TempRepo();
  write(r.p('loose.txt'), 'l1\nl2\n');
  const diff = await getFileDiff(r.repo, 'loose.txt');
  assertEquals(diff.status, 'U');
  assertEquals(diff.hunks, [{ header: '@@ -0,0 +1,2 @@', lines: ['+l1', '+l2'] }]);
  Deno.mkdirSync(r.p('newdir', 'deep'), { recursive: true });
  write(r.p('newdir', 'deep', 'f.txt'), 'q\n');
  assert('newdir/deep/f.txt' in await listing(r.repo));
});

test('binary files have no content', async () => {
  using r = new TempRepo();
  writeBytes(r.p('pic.bin'), [0, 9, 9, 9, 9]);
  const diff = await getFileDiff(r.repo, 'pic.bin');
  assert(diff.binary);
  assertEquals(diff.hunks, []);
  writeBytes(r.p('u.dat'), [120, 0, 121]);
  const again = await getFileDiff(r.repo, 'u.dat');
  assert(again.binary);
  assertEquals(again.hunks, []);
});

test('deleted and renamed diffs', async () => {
  using r = new TempRepo();
  Deno.removeSync(r.p('gone.txt'));
  assertEquals((await getFileDiff(r.repo, 'gone.txt')).removed, 2);
  git(r.repo, 'mv', 'old.txt', 'renamed.txt');
  const diff = await getFileDiff(r.repo, 'renamed.txt');
  assertEquals([diff.status, diff.oldPath], ['R', 'old.txt']);
});

test('the file cap marks the listing truncated', async () => {
  using r = new TempRepo();
  for (let i = 0; i < MAX_FILES + 5; i++) write(r.p(`f${String(i).padStart(4, '0')}.txt`), 'x\n');
  const data = await getChanges(r.repo);
  assertEquals(data.files!.length, MAX_FILES);
  assert(data.truncated);
  assertEquals(data.filesTotal, MAX_FILES + 5);
  // QA M5: the totals count every file (new files off the page are not read: partial), and the next page reaches the rest.
  assertEquals(data.totals, { files: MAX_FILES + 5, added: MAX_FILES, removed: 0, partial: true });
  const rest = await getChanges(r.repo, null, MAX_FILES);
  assertEquals(rest.offset, MAX_FILES);
  assertEquals(rest.files!.map((f) => f.path), ['f0300.txt', 'f0301.txt', 'f0302.txt', 'f0303.txt', 'f0304.txt']);
  assertEquals(rest.truncated, false);
  assertEquals(rest.totals!.files, MAX_FILES + 5);
  git(r.repo, 'add', '-A');
  git(r.repo, 'commit', '-qm', 'many');
  for (let i = 0; i < MAX_FILES + 5; i++) write(r.p(`f${String(i).padStart(4, '0')}.txt`), 'y\n');
  const tracked = await getChanges(r.repo);
  assertEquals(tracked.totals, { files: MAX_FILES + 5, added: MAX_FILES + 5, removed: MAX_FILES + 5 }); // numstat counts them all
  await using py = new PyParity();
  assertEquals(await getChanges(r.repo, null, MAX_FILES), await py.call('changes', 'get_changes', [r.repo, null, MAX_FILES]));
});

test('the diff size cap', async () => {
  using r = new TempRepo();
  write(r.p('mod.txt'), Array.from({ length: 5000 }, (_, i) => `line ${i} ` + 'x'.repeat(60) + '\n').join(''));
  const diff = await getFileDiff(r.repo, 'mod.txt');
  assert(diff.truncated);
  assert(diff.hunks!.reduce((s, h) => s + h.lines.reduce((t, l) => t + l.length + 1, 0), 0) <= MAX_DIFF_BYTES + 5000);
  write(r.p('huge.txt'), 'y'.repeat(100) + '\n' + ('z'.repeat(100) + '\n').repeat(5000));
  const big = await getFileDiff(r.repo, 'huge.txt');
  assert(big.truncated);
  assert((await listing(r.repo))['huge.txt'].partial);
  await using py = new PyParity();
  assertEquals(big, await py.call('changes', 'get_file_diff', [r.repo, 'huge.txt']));
  assertEquals(diff, await py.call('changes', 'get_file_diff', [r.repo, 'mod.txt']));
});

test('long lines are cut', async () => {
  using r = new TempRepo();
  write(r.p('mod.txt'), 'q'.repeat(5000) + '\n');
  const lines = (await getFileDiff(r.repo, 'mod.txt')).hunks![0].lines;
  assert(lines[lines.length - 1].length <= MAX_LINE_CHARS);
});

test('unsafe or unchanged paths are refused', async () => {
  using r = new TempRepo();
  for (const bad of ['', '../x', 'a/../b', '/etc/passwd', 'C:/x', 'a\\b', './mod.txt', 'a//b', 'x\0y']) {
    const error = await assertRejects(() => getFileDiff(r.repo, bad), ChangesError) as ChangesError;
    assertEquals(error.code, 'bad_path', bad);
  }
  const error = await assertRejects(() => getFileDiff(r.repo, 'mod.txt'), ChangesError) as ChangesError; // exists but unchanged
  assertEquals([error.code, error.message], ['not_changed', 'That file has no uncommitted changes']);
});

test('a subfolder scopes the listing', async () => {
  using r = new TempRepo();
  write(r.p('mod.txt'), 'changed\n');
  write(r.p('sub', 'in.txt'), 'y\n');
  const data = await getChanges(r.p('sub'));
  assertEquals(data.files!.map((f) => f.path), ['sub/in.txt']);
  assertEquals(data.prefix, 'sub/');
  const error = await assertRejects(() => getFileDiff(r.p('sub'), 'mod.txt'), ChangesError) as ChangesError;
  assertEquals(error.code, 'outside');
});

test('a repo without commits diffs against the empty tree', async () => {
  using r = new TempRepo();
  const fresh = osp.join(r.root, 'fresh');
  Deno.mkdirSync(fresh);
  git(fresh, 'init', '-q');
  write(osp.join(fresh, 'a.txt'), '1\n2\n');
  git(fresh, 'add', 'a.txt');
  write(osp.join(fresh, 'b.txt'), '3\n');
  const files = await listing(fresh);
  assertEquals([files['a.txt'].status, files['a.txt'].added], ['A', 2]);
  assertEquals(files['b.txt'].status, 'U');
  await using py = new PyParity();
  assertEquals(await getChanges(fresh), await py.call('changes', 'get_changes', [fresh]));
});

test('reading does not modify the repo', async () => {
  using r = new TempRepo();
  write(r.p('mod.txt'), 'z\n');
  const before = git(r.repo, 'status', '--porcelain=v1');
  await getChanges(r.repo);
  await getFileDiff(r.repo, 'mod.txt');
  assertEquals(git(r.repo, 'status', '--porcelain=v1'), before);
});

Deno.test('parsers', async () => {
  assertEquals(parseStatus(enc(' M a b.txt\0R  new\0old\0?? u\0')), [[' M', 'a b.txt', ''], ['R ', 'new', 'old'], ['??', 'u', '']]);
  assertEquals(
    Object.fromEntries(parseNumstat(enc('1\t2\ta.txt\0-\t-\tb.bin\0' + '0\t0\t\0old\0new\0'))),
    { 'a.txt': [1, 2, false], 'b.bin': [0, 0, true], new: [0, 0, false] },
  );
  assertEquals(['??', 'UU', 'AA', 'R ', ' D', 'A ', 'AM', ' M', 'MM', 'T '].map(statusLetter), [
    'U',
    'C',
    'C',
    'R',
    'D',
    'A',
    'A',
    'M',
    'M',
    'M',
  ]);
  const hunks = parseHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n \n@@ -9 +9 @@\n+z\n\\ No newline at end of file\n');
  assertEquals(hunks.map((h) => h.lines), [['-a', '+b', ' '], ['+z', '\\ No newline at end of file']]);
  await using py = new PyParity();
  const status = ' M a b.txt\0R  new\0old\0?? u\0C  c2\0c1\0x\0UU ü😀\0';
  assertEquals(parseStatus(enc(status)), await py.call('desktop_shim', 'changes_parse', ['parse_status', status]));
  const names = 'M\0a\0R100\0old\0new\0C075\0src\0copy\0D\0gone\0U\0both\0A\0added\0T\0typ\0R100\0cut';
  assertEquals(parseNameStatus(enc(names)), await py.call('desktop_shim', 'changes_parse', ['parse_name_status', names]));
  const nums = '1\t2\ta.txt\0-\t-\tb.bin\0' + '0\t0\t\0old\0new\0garbage\0' + '3\t\tx\0';
  assertEquals(Object.fromEntries(parseNumstat(enc(nums))), await py.call('desktop_shim', 'changes_numstat', [nums]));
  const text = '@@ -1 +1 @@ ' + 'h'.repeat(400) + '\n-a\r\n+' + 'b'.repeat(3000) + '\n\nnoise\n';
  assertEquals(parseHunks(text), await py.call('changes', 'parse_hunks', [text]));
  for (const path of ['', 'a', 'a/b', '../x', 'a/./b', 'C:/x', 'x:y', '/x', 'a\\b', 'a//b', 'x'.repeat(1025), 'é/😀']) {
    assertEquals(safeRelpath(path), await py.call('changes', 'safe_relpath', [path]), path);
  }
});
