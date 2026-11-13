/** Local-only folders: AIB's block in .git/info/exclude (read, write, escape, refuse, Undo), the default /private, and the Q3 move. */
import { assert, assertEquals } from './_assert.ts';
import { git, HAVE_GIT, write } from './_git_repo.ts';
import * as osp from '../../outputs/agent-studio/server/platform/ospath.ts';
import * as lo from '../../outputs/agent-studio/server/worktrees/local_only.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function tempRepo(): { root: string; repo: string; p: (...parts: string[]) => string; exclude: string; dispose: () => void } {
  const root = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-local-only-' }));
  const repo = osp.join(root, 'repo');
  Deno.mkdirSync(repo);
  git(repo, 'init', '-q');
  write(osp.join(repo, 'README.md'), '# r\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return {
    root,
    repo,
    p: (...parts) => osp.join(repo, ...parts),
    exclude: osp.join(repo, '.git', 'info', 'exclude'),
    dispose: () => {
      try {
        Deno.removeSync(root, { recursive: true });
      } catch { /* a git process may still hold a file */ }
    },
  };
}

const ignored = (repo: string, rel: string) =>
  new Deno.Command('git', { args: ['check-ignore', '-q', '--no-index', '--', rel], cwd: repo, stdout: 'null', stderr: 'null' }).outputSync().code === 0;

const opts = { ignore: !HAVE_GIT, sanitizeResources: false, sanitizeOps: false };

Deno.test('escapeLine / unescapeLine: anchored, no trailing slash, globs and trailing spaces escaped', () => {
  assertEquals(lo.escapeLine('', 'private'), '/private');
  assertEquals(lo.escapeLine('sub/', 'private'), '/sub/private');
  assertEquals(lo.escapeLine('', 'a*b[1]?\\c.md'), '/a\\*b\\[1]\\?\\\\c.md');
  assertEquals(lo.escapeLine('', 'x  '), '/x\\ \\ ');
  assertEquals(lo.escapeLine('', '#n !m'), '/#n !m');
  let threw = false;
  try {
    lo.escapeLine('', 'a\nb');
  } catch {
    threw = true;
  }
  assert(threw, 'a newline is refused');
  for (const rel of ['private', 'a*b[1]?\\c.md', 'x  ', 'deep/er/path.txt']) assertEquals(lo.unescapeLine(lo.escapeLine('', rel)), rel);
  assertEquals(lo.unescapeLine('/private/'), 'private');
  assertEquals(lo.unescapeLine('*.log'), null);
  assertEquals(lo.unescapeLine('/build/*'), null);
  assertEquals(lo.unescapeLine('!/private'), null);
  assertEquals(lo.unescapeLine('# c'), null);
  assertEquals(lo.unescapeLine('notes'), null, 'unanchored lines are not one path');
  assertEquals(lo.entriesOf(['/sub/private', '/other/x', '/sub/notes/'], 'sub/'), ['private', 'notes']);
});

Deno.test('isLocalPath: entries and what is inside them; case-insensitive on Windows', () => {
  const l: lo.LocalOnly = { project: 'x', excludeFile: 'e', prefix: '', entries: ['private', 'notes/today.md'], existing: [], defaultState: 'on' };
  assert(lo.isLocalPath(l, 'private'));
  assert(lo.isLocalPath(l, 'private/designs/x.html'));
  assert(lo.isLocalPath(l, 'notes/today.md'));
  assert(!lo.isLocalPath(l, 'notes'));
  assert(!lo.isLocalPath(l, 'privateer'));
  assert(!lo.isLocalPath(l, ''));
  assertEquals(lo.isLocalPath(l, 'Private/X.md'), Deno.build.os === 'windows');
  assertEquals(lo.entryOf(l, 'private/a/b'), 'private');
});

Deno.test('withLine / withoutLine: CRLF, BOM and a missing last newline survive byte for byte outside the block', () => {
  const user = '﻿# user notes\r\n/.test-logs/\r\nlast line';
  const before = enc.encode(user);
  const after = lo.withLine(before, '/notes')!;
  const text = dec.decode(after, { stream: false });
  assert(after[0] === 0xef && after[1] === 0xbb && after[2] === 0xbf, 'BOM kept');
  assert(text.includes('# user notes\r\n/.test-logs/\r\nlast line\r\n'), 'user lines kept, the last one gets a newline');
  assert(text.endsWith(`${lo.BLOCK_START}\r\n/notes\r\n${lo.BLOCK_END}\r\n`), 'block uses CRLF like the file: ' + JSON.stringify(text));
  assertEquals(lo.withLine(after, '/notes'), null, 'already there');
  const two = lo.withLine(after, '/more')!;
  assert(dec.decode(two).endsWith(`/notes\r\n/more\r\n${lo.BLOCK_END}\r\n`));
  const back = lo.withoutLine(two, '/more')!;
  assertEquals([...back], [...after]);
  const dropped = lo.withoutLine(after, '/notes', true)!;
  assertEquals(dec.decode(dropped), user.slice(1) + '\r\n', 'the emptied block is dropped; the BOM stays (decoded away here)');
  assertEquals(lo.withoutLine(after, '/user'), null);
  // LF file without a block
  assertEquals(dec.decode(lo.withLine(enc.encode('a\n'), '/p')!), `a\n${lo.BLOCK_START}\n/p\n${lo.BLOCK_END}\n`);
  assertEquals(dec.decode(lo.withLine(new Uint8Array(), '/p')!), `${lo.BLOCK_START}\n/p\n${lo.BLOCK_END}\n`);
});

Deno.test('blocks: two blocks are both read and the first is written; a start with no end is left alone', () => {
  const two = `${lo.BLOCK_START}\n/a\n${lo.BLOCK_END}\nuser\n${lo.BLOCK_START}\n/b\n${lo.BLOCK_END}\n`;
  assertEquals(lo.blockLines(enc.encode(two)), ['/a', '/b']);
  assertEquals(dec.decode(lo.withLine(enc.encode(two), '/c')!), `${lo.BLOCK_START}\n/a\n/c\n${lo.BLOCK_END}\nuser\n${lo.BLOCK_START}\n/b\n${lo.BLOCK_END}\n`);
  const broken = `${lo.BLOCK_START}\n/x\nuser\n`;
  assertEquals(lo.blockLines(enc.encode(broken)), [], 'a broken block does not count');
  assertEquals(dec.decode(lo.withLine(enc.encode(broken), '/y')!), `${broken}${lo.BLOCK_START}\n/y\n${lo.BLOCK_END}\n`);
});

Deno.test('ensureDefault: /private once, state on, idempotent; a removed line stays removed', opts, async () => {
  const r = tempRepo();
  try {
    const first = await lo.ensureDefault(r.repo);
    assert(first);
    assertEquals(first.entries, ['private']);
    assertEquals(first.defaultState, 'on');
    assertEquals(first.existing, [], 'nothing is made on disk');
    assert(ignored(r.repo, 'private/x.md'));
    const bytes = Deno.readFileSync(r.exclude);
    await lo.ensureDefault(r.repo);
    assertEquals([...Deno.readFileSync(r.exclude)], [...bytes], 'second call writes nothing');
    Deno.mkdirSync(r.p('private'));
    assertEquals((await lo.localOnlyOf(r.repo))!.existing, [r.p('private')]);
    // the user takes it out: AIB does not put it back
    Deno.writeTextFileSync(r.exclude, dec.decode(bytes).replace('/private\n', ''));
    lo._cache.clear();
    const after = await lo.ensureDefault(r.repo);
    assertEquals(after!.entries, []);
    assertEquals(after!.defaultState, 'off');
  } finally {
    r.dispose();
  }
});

Deno.test('ensureDefault: a project that tracks private/ gets no line and state tracked', opts, async () => {
  const r = tempRepo();
  try {
    Deno.mkdirSync(r.p('private'));
    write(r.p('private', 'a.md'), 'a');
    git(r.repo, 'add', '-A');
    git(r.repo, 'commit', '-q', '-m', 'p');
    const before = osp.exists(r.exclude) ? Deno.readTextFileSync(r.exclude) : '';
    const l = await lo.ensureDefault(r.repo);
    assertEquals(l!.entries, []);
    assertEquals(l!.defaultState, 'tracked');
    assertEquals(osp.exists(r.exclude) ? Deno.readTextFileSync(r.exclude) : '', before);
  } finally {
    r.dispose();
  }
});

Deno.test('ensureDefault: a .gitignore that negates private gets no line and state negated', opts, async () => {
  const r = tempRepo();
  try {
    write(r.p('.gitignore'), '!private\n');
    const l = await lo.ensureDefault(r.repo);
    assertEquals(l!.entries, []);
    assertEquals(l!.defaultState, 'negated');
    // a negation added after the line was written: the line stays, the state says it is not in force
    write(r.p('.gitignore'), '');
    lo._cache.clear();
    assertEquals((await lo.ensureDefault(r.repo))!.defaultState, 'on');
    // a folder-only negation counts once the folder exists (git can't tell a missing path is a folder)
    Deno.mkdirSync(r.p('private'));
    write(r.p('.gitignore'), '!private/\n');
    lo._cache.clear();
    assertEquals((await lo.localOnlyOf(r.repo))!.defaultState, 'negated');
  } finally {
    r.dispose();
  }
});

Deno.test('ensureDefault / localOnlyOf: a folder outside git gives null and writes nothing', opts, async () => {
  const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-local-nogit-' }));
  try {
    assertEquals(await lo.ensureDefault(dir), null);
    assertEquals(await lo.localOnlyOf(dir), null);
    assertEquals([...Deno.readDirSync(dir)].length, 0);
    assertEquals((await lo.addEntry(dir, 'notes')).ok, false);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

Deno.test('a project in a sub-folder of its repo gets /sub/private, and git agrees', opts, async () => {
  const r = tempRepo();
  try {
    Deno.mkdirSync(r.p('sub'));
    write(r.p('sub', 'x.txt'), 'x');
    const l = await lo.ensureDefault(r.p('sub'));
    assertEquals(l!.prefix, 'sub/');
    assertEquals(l!.entries, ['private']);
    assert(Deno.readTextFileSync(r.exclude).includes('\n/sub/private\n'));
    assert(ignored(r.repo, 'sub/private/a.md'));
    assert(!ignored(r.repo, 'private/a.md'), 'the repo top is not touched');
    // seen from the repo top, the same line is the path sub/private
    assertEquals((await lo.localOnlyOf(r.repo))!.entries, ['sub/private']);
  } finally {
    r.dispose();
  }
});

Deno.test('addEntry: glob characters are escaped and git check-ignore agrees; undo removes only that line', opts, async () => {
  const r = tempRepo();
  try {
    write(r.exclude, '# mine\r\n/.test-logs/\r\n');
    const name = 'a*b[1]?.md';
    const res = await lo.addEntry(r.repo, name);
    assert(res.ok, JSON.stringify(res));
    assert(ignored(r.repo, name));
    assert(!ignored(r.repo, 'axb1y.md'), 'the star is literal');
    assertEquals((await lo.localOnlyOf(r.repo))!.entries, [name]);
    const folder = await lo.addEntry(r.repo, 'notes/');
    assert(folder.ok);
    assert(ignored(r.repo, 'notes/deep/x.md'));
    assert(await lo.undoEntry(r.repo, res.undo));
    assert(!ignored(r.repo, name));
    assertEquals((await lo.localOnlyOf(r.repo))!.entries, ['notes']);
    assert(!(await lo.undoEntry(r.repo, res.undo)), 'a second undo finds nothing');
    assert(Deno.readTextFileSync(r.exclude).startsWith('# mine\r\n/.test-logs/\r\n'), 'user lines kept');
    assert(await lo.undoEntry(r.repo, folder.undo));
    assertEquals(
      Deno.readTextFileSync(r.exclude),
      `# mine\r\n/.test-logs/\r\n${lo.BLOCK_START}\r\n${lo.BLOCK_END}\r\n`,
      'an emptied block stays (it marks the default as done)',
    );
    assert(!(await lo.undoEntry(r.repo, '{"line":"/.test-logs/"}')), 'never a user line');
    assert(!(await lo.undoEntry(r.repo, 'junk')));
  } finally {
    r.dispose();
  }
});

Deno.test('addEntry refuses the project, .git, node_modules, aib-docs, tracked paths and paths already local only', opts, async () => {
  const r = tempRepo();
  try {
    await lo.ensureDefault(r.repo);
    const codes: Record<string, string> = {};
    for (const rel of ['', '.git', '.git/hooks', 'node_modules', 'a/node_modules/x', 'aib-docs', 'aib-docs/x.json', 'README.md', 'private', 'private/x.md', 'a\nb', '../up']) {
      const res = await lo.addEntry(r.repo, rel);
      assert(!res.ok, rel);
      codes[rel] = res.code;
    }
    assertEquals(codes, {
      '': 'reserved',
      '.git': 'reserved',
      '.git/hooks': 'reserved',
      'node_modules': 'reserved',
      'a/node_modules/x': 'reserved',
      'aib-docs': 'docs',
      'aib-docs/x.json': 'docs',
      'README.md': 'tracked',
      'private': 'already',
      'private/x.md': 'already',
      'a\nb': 'reserved',
      '../up': 'reserved',
    });
    const t = await lo.addEntry(r.repo, 'README.md');
    assert(!t.ok && t.error === "Git tracks this, so it can't be excluded");
  } finally {
    r.dispose();
  }
});

Deno.test('two addEntry calls at once both land', opts, async () => {
  const r = tempRepo();
  try {
    const results = await Promise.all(['one', 'two', 'three'].map((n) => lo.addEntry(r.repo, n)));
    assert(results.every((x) => x.ok));
    assertEquals((await lo.localOnlyOf(r.repo))!.entries.sort(), ['one', 'three', 'two']);
    assertEquals(Deno.readTextFileSync(r.exclude).split(lo.BLOCK_START).length, 2, 'one block');
  } finally {
    r.dispose();
  }
});

Deno.test('a user line appended between the read and the rename survives', opts, async () => {
  const r = tempRepo();
  try {
    write(r.exclude, 'user-a\n');
    let once = true;
    lo._hooks.afterTmp = (file) => {
      if (!once) return;
      once = false;
      Deno.writeTextFileSync(file, 'user-a\nuser-b\n');
    };
    const res = await lo.addEntry(r.repo, 'notes');
    assert(res.ok);
    assertEquals(Deno.readTextFileSync(r.exclude), `user-a\nuser-b\n${lo.BLOCK_START}\n/notes\n${lo.BLOCK_END}\n`);
    assert(!osp.exists(r.exclude + '.aib-tmp'));
  } finally {
    lo._hooks.afterTmp = null;
    r.dispose();
  }
});

Deno.test('a worktree reads and writes the common exclude file', opts, async () => {
  const r = tempRepo();
  try {
    const wt = osp.join(r.root, 'chat-1');
    git(r.repo, 'worktree', 'add', '-q', '-b', 'c1', wt);
    const l = await lo.ensureDefault(wt);
    assertEquals(osp.normcase(l!.excludeFile), osp.normcase(r.exclude));
    assertEquals((await lo.localOnlyOf(r.repo))!.entries, ['private']);
    git(r.repo, 'worktree', 'remove', '--force', wt);
  } finally {
    r.dispose();
  }
});

Deno.test('addEntry from a chat copy moves the file into the main folder first (Q3); clash and identical copies', opts, async () => {
  const r = tempRepo();
  try {
    const chat = osp.join(r.root, 'chat-53e6dc57');
    git(r.repo, 'worktree', 'add', '-q', '-b', 'c', chat);
    // only in the chat's copy
    write(osp.join(chat, 'notes.md'), 'chat notes');
    const res = await lo.addEntry(r.repo, 'notes.md', chat);
    assert(res.ok, JSON.stringify(res));
    assertEquals(Deno.readTextFileSync(r.p('notes.md')), 'chat notes');
    assert(!osp.exists(osp.join(chat, 'notes.md')));
    assertEquals(res.moved, [['notes.md', 'notes.md']]);
    // a folder in both: merged file by file; a clash gets the chat's name, an identical copy is deleted
    Deno.mkdirSync(r.p('ideas'));
    write(r.p('ideas', 'TASKS.md'), 'main');
    write(r.p('ideas', 'same.txt'), 'same');
    Deno.mkdirSync(osp.join(chat, 'ideas', 'deep'), { recursive: true });
    write(osp.join(chat, 'ideas', 'TASKS.md'), 'chat');
    write(osp.join(chat, 'ideas', 'same.txt'), 'same');
    write(osp.join(chat, 'ideas', 'deep', 'new.md'), 'n');
    const res2 = await lo.addEntry(r.repo, 'ideas', chat);
    assert(res2.ok);
    assertEquals(Deno.readTextFileSync(r.p('ideas', 'TASKS.md')), 'main');
    assertEquals(Deno.readTextFileSync(r.p('ideas', 'TASKS (from chat-53e6dc57).md')), 'chat');
    assertEquals(Deno.readTextFileSync(r.p('ideas', 'deep', 'new.md')), 'n');
    assert(!osp.exists(osp.join(r.p('ideas'), 'same (from chat-53e6dc57).txt')), 'identical copy not duplicated');
    assert(!osp.exists(osp.join(chat, 'ideas')), 'the chat copy has nothing left');
    assertEquals(lo.clashName(r.p('ideas', 'TASKS.md'), 'chat-53e6dc57'), r.p('ideas', 'TASKS (from chat-53e6dc57) 2.md'));
    assertEquals(osp.basename(lo.clashName(r.p('.env'), 'chat-1')), '.env (from chat-1)');
    git(r.repo, 'worktree', 'remove', '--force', chat);
  } finally {
    r.dispose();
  }
});
