const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const W = require(path.join(APP_DIR, 'workspace-state.js'));

test('folder leaf and default project name', () => {
  assert.equal(W.folderLeaf('C:\\REPOS\\my-app'), 'my-app');
  assert.equal(W.folderLeaf('C:\\REPOS\\my-app\\'), 'my-app');
  assert.equal(W.folderLeaf('C:/REPOS/my-app/'), 'my-app');
  assert.equal(W.folderLeaf('/home/me/app'), 'app');
  assert.equal(W.folderLeaf('C:\\'), '');
  assert.equal(W.folderLeaf(''), '');
});

test('trailing separator follows the path style', () => {
  assert.equal(W.withTrailingSep('C:\\Users\\me'), 'C:\\Users\\me\\');
  assert.equal(W.withTrailingSep('C:\\Users\\me\\'), 'C:\\Users\\me\\');
  assert.equal(W.withTrailingSep('/home/me'), '/home/me/');
  assert.equal(W.withTrailingSep(''), '');
});

test('smart start: remembered parent first', () => {
  assert.equal(
    W.smartStart({ source: 'last', start: 'D:\\Work', home: 'C:\\Users\\me' }, ['C:\\R\\a', 'C:\\R\\b']),
    'D:\\Work\\',
  );
});

test('smart start: the parent holding most projects, case and slash insensitive', () => {
  const paths = ['C:\\REPOS\\a', 'c:/repos/b', 'C:\\Other\\c', 'D:\\x\\d', ''];
  assert.equal(W.smartStart({ source: 'home', home: 'C:\\Users\\me' }, paths), 'C:\\REPOS\\');
});

test('smart start: ties are stable, drive roots are not parents, no projects means home', () => {
  assert.equal(W.smartStart({ source: 'home', home: 'H:\\me' }, ['C:\\b\\x', 'C:\\a\\y']), 'C:\\a\\');
  assert.equal(W.smartStart({ source: 'home', home: 'C:\\Users\\me' }, ['C:\\solo']), 'C:\\Users\\me\\');
  assert.equal(W.smartStart({ source: 'home', home: 'C:\\Users\\me' }, []), 'C:\\Users\\me\\');
  assert.equal(W.smartStart({ source: 'home', home: '/home/me' }, ['/srv/p/a', '/srv/p/b']), '/srv/p/');
  assert.equal(W.smartStart(null, null), '');
});

test('hint: empty, partial and checking', () => {
  for (const c of [null, { valid: false, reason: 'empty' }, { valid: false, reason: 'partial' }]) {
    const h = W.hintState(c);
    assert.equal(h.text, 'Type a folder path, or Browse');
    assert.deepEqual([h.canSubmit, h.showGit, h.preview], [false, false, '']);
  }
  const k = W.hintState(null, { checking: true });
  assert.deepEqual([k.kind, k.canSubmit], ['checking', false]);
});

test('hint: new folder says what it creates and offers git, disabled when git is missing', () => {
  const h = W.hintState({ valid: true, reason: 'new', exists: false, gitAvailable: true, path: 'C:\\R\\app' });
  assert.deepEqual(
    [h.kind, h.text, h.preview, h.previewTone, h.primary, h.canSubmit, h.showGit, h.gitEnabled],
    ['new', 'New folder', 'Creates C:\\R\\app', 'ok', 'Create project', true, true, true],
  );
  const g = W.hintState({ valid: true, reason: 'new', exists: false, gitAvailable: false, path: 'C:\\R\\app' });
  assert.deepEqual([g.showGit, g.gitEnabled, g.gitNote], [true, false, 'git not found']);
});

test('hint: existing folder and existing project', () => {
  const e = W.hintState({ valid: true, exists: true, isDir: true, path: 'C:\\REPOS' }, { isProject: false });
  assert.deepEqual(
    [e.text, e.preview, e.primary, e.canSubmit, e.showGit],
    ['Existing folder', 'Uses C:\\REPOS (already there)', 'Open project', true, false],
  );
  const p = W.hintState({ valid: true, exists: true, isDir: true, path: 'C:\\R\\a' }, { isProject: true });
  assert.deepEqual(
    [p.kind, p.text, p.preview, p.primary],
    ['project', 'Already a project', 'Opens C:\\R\\a (already a project)', 'Open project'],
  );
});

test('hint: with a name, the hint is about Folder and the preview names <folder>\\<name>', () => {
  const made = W.hintState({
    valid: true,
    exists: false,
    path: 'C:\\REPOS\\spaghetti',
    folder: 'C:\\REPOS',
    gitAvailable: true,
  });
  assert.deepEqual(
    [made.text, made.preview, made.primary, made.canSubmit, made.showGit],
    ['Folder found', 'Creates C:\\REPOS\\spaghetti', 'Create project', true, true],
  );
  const there = W.hintState({
    valid: true,
    exists: true,
    isDir: true,
    path: 'C:\\REPOS\\spaghetti',
    folder: 'C:\\REPOS',
  });
  assert.deepEqual(
    [there.text, there.preview, there.primary, there.showGit],
    ['Folder found', 'Uses C:\\REPOS\\spaghetti (already there)', 'Open project', false],
  );
});

test('hint: a bad name is red on the preview line, the Folder hint stays fine', () => {
  const h = W.hintState({
    valid: false,
    reason: 'invalid_name',
    field: 'name',
    folder: 'C:\\R',
    message: '"CON" is a reserved Windows name',
  });
  assert.deepEqual(
    [h.kind, h.text, h.tone, h.preview, h.previewTone, h.canSubmit],
    ['bad_name', 'Folder found', 'ok', '"CON" is a reserved Windows name', 'error', false],
  );
  const gone = W.hintState({
    valid: false,
    reason: 'folder_missing',
    field: 'folder',
    message: "C:\\x doesn't exist. Leave…",
  });
  assert.deepEqual(
    [gone.kind, gone.tone, gone.previewTone, gone.canSubmit],
    ['folder_missing', 'error', 'hint', false],
  );
});

test('hint: errors are red, show the server message and disable the button', () => {
  const bad = W.hintState({ valid: false, reason: 'invalid_name', message: '"a<b" can\'t contain <' });
  assert.deepEqual([bad.tone, bad.canSubmit, bad.text], ['error', false, '"a<b" can\'t contain <']);
  const gone = W.hintState({ valid: false, reason: 'parent_missing', message: "C:\\x doesn't exist" });
  assert.deepEqual(
    [gone.kind, gone.tone, gone.text, gone.canSubmit],
    ['parent_missing', 'error', "C:\\x doesn't exist", false],
  );
});

test('pending projects show until a real one exists and never duplicate', () => {
  let pending = W.addPending({}, 'w:c/r/new', 'C:\\R\\New');
  assert.equal(pending['w:c/r/new'].name, 'New');
  const real = [{ key: 'w:c/r/a', name: 'a', total: 2 }];
  const list = W.withPending(real, pending);
  assert.deepEqual(
    list.map((p) => p.key),
    ['w:c/r/a', 'w:c/r/new'],
  );
  assert.deepEqual([list[1].total, list[1].pending], [0, true]);
  assert.equal(W.withPending([{ key: 'w:c/r/new', name: 'New', total: 1 }], pending).length, 1);
  assert.deepEqual(W.prunePending(pending, new Set(['w:c/r/new'])), {});
  assert.deepEqual(Object.keys(W.prunePending(pending, ['other'])), ['w:c/r/new']);
  assert.deepEqual(W.sanitizePending({ a: { path: 'C:\\x', name: ' n ' }, b: 5, c: { name: 'z' } }), {
    a: { key: 'a', path: 'C:\\x', name: 'n' },
  });
  assert.deepEqual(W.sanitizePending([1]), {});
});

test('a pending project merges with a saved display name', () => {
  const list = W.applyPrefs(W.withPending([], W.addPending({}, 'w:c/r/new', 'C:\\R\\New')), {
    order: [],
    projects: { 'w:c/r/new': { name: 'Shiny', color: '', hidden: false } },
  });
  assert.deepEqual([list[0].name, list[0].autoName, list[0].custom], ['Shiny', 'New', true]);
});

test('which chat opens for a project that already has chats', () => {
  const items = [
    { key: 'a', projectKey: 'p', activity: 5, state: 'idle' },
    { key: 'b', projectKey: 'p', activity: 9, state: 'idle' },
    { key: 'x', projectKey: 'q', activity: 99, state: 'idle' },
    { key: 'z', projectKey: 'p', activity: 100, archived: true },
  ];
  const st = W.empty();
  assert.equal(W.chatToOpen(st, 'p', items), 'b', 'newest non-archived');
  assert.equal(W.chatToOpen(W.openTab(st, 'p', 'a'), 'p', items), 'a', 'the last one used');
  assert.equal(W.chatToOpen(st, 'none', items), null);
  assert.equal(W.isKnownProject('p', new Set(['p'])), true);
  assert.equal(W.isKnownProject('', ['p']), false);
});
