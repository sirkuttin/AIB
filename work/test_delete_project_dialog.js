'use strict';
// "Delete project…": the in-page question (delete-project-ui.js) and its place in the project menu (workspace-ui.js). Fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const flush = () => new Promise((r) => setImmediate(r));
function dialog(opts = {}) {
  const shell = D.page({});
  const ctx = D.load(shell, ['delete-project-ui.js']);
  const calls = [];
  const o = Object.assign(
    {
      name: 'alpha',
      path: 'C:\\work\\alpha',
      chats: 3,
      running: 0,
      check: () => Promise.resolve({ exists: true, refusal: '', trash: 'recycle', worktreeOf: '' }),
      confirm: (choice) => {
        calls.push(choice);
        return Promise.resolve();
      },
    },
    opts,
  );
  const ui = ctx.AgentDeleteProjectUI.show(o);
  const q = (cls) => ui.box.querySelector('.' + cls);
  return { shell, ctx, ui, q, calls, box: ui.box };
}

test('by default only the project leaves AIB: unticked, the folder stays, Cancel has focus', async () => {
  const t = dialog();
  assert.equal(t.box.getAttribute('role'), 'alertdialog');
  assert.equal(
    t.q('dp-main').textContent,
    'Removes alpha from AIB. Its 3 chats move to Recently deleted. The folder C:\\work\\alpha stays on your disk.',
  );
  const disk = t.box.querySelector('#dpDisk');
  assert.equal(disk.checked, false, 'unticked by default');
  assert.equal(disk.disabled, true, 'disabled until the server said what would happen');
  assert.equal(t.shell.document.activeElement, t.q('dp-cancel'), 'Cancel is focused');
  assert.equal(t.q('dp-ok').textContent, 'Delete project');
  assert.equal(t.q('dp-running').hidden, true, 'nothing running: no line');
  await flush();
  assert.equal(disk.disabled, false);
  assert.equal(t.q('dp-warn').hidden, true);
  t.q('dp-ok').click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls)), [{ disk: false, expect: '', cleanup: { remove: [] } }]);
  assert.equal(t.box.parentNode, null, 'closed after the work is done');
});

test('ticking "Delete from disk as well" shows the warning and switches the button; the server\'s trash kind is said', async () => {
  const t = dialog({
    check: () => Promise.resolve({ exists: true, refusal: '', trash: 'recycle', worktreeOf: 'C:\\repos\\main' }),
  });
  await flush();
  const disk = t.box.querySelector('#dpDisk');
  disk.checked = true;
  disk.dispatch('change');
  const warn = t.q('dp-warn');
  assert.equal(warn.hidden, false);
  assert.match(warn.textContent, /^This deletes the folder C:\\work\\alpha and everything in it\./);
  assert.match(warn.textContent, /Recycle Bin/);
  assert.match(warn.textContent, /git worktree of C:\\repos\\main/);
  assert.equal(t.q('dp-ok').textContent, 'Delete project and folder');
  assert.doesNotMatch(t.q('dp-main').textContent, /stays on your disk/);
  disk.checked = false;
  disk.dispatch('change');
  assert.equal(warn.hidden, true);
  assert.equal(t.q('dp-ok').textContent, 'Delete project');
  disk.checked = true;
  disk.dispatch('change');
  t.q('dp-ok').click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls)), [{ disk: true, expect: 'recycle', cleanup: { remove: [] } }]);
});

test('no trash: the warning says "permanently" before you confirm', async () => {
  const t = dialog({ check: () => Promise.resolve({ exists: true, refusal: '', trash: 'permanent', worktreeOf: '' }) });
  await flush();
  const disk = t.box.querySelector('#dpDisk');
  disk.checked = true;
  disk.dispatch('change');
  assert.match(t.q('dp-warn').textContent, /deleted permanently/);
  assert.match(t.q('dp-warn').textContent, /cannot be undone/);
});

test('a refused folder keeps the box off and says why; a missing folder says only the project goes', async () => {
  const t = dialog({
    check: () => Promise.resolve({ exists: true, refusal: 'This is your Documents folder.', trash: 'recycle' }),
  });
  await flush();
  assert.equal(t.box.querySelector('#dpDisk').disabled, true);
  assert.match(t.q('dp-note').textContent, /not possible: This is your Documents folder\./);
  const gone = dialog({ check: () => Promise.resolve({ exists: false, refusal: '', trash: 'permanent' }) });
  await flush();
  assert.equal(gone.box.querySelector('#dpDisk').disabled, true);
  assert.match(gone.q('dp-note').textContent, /not on disk any more/);
});

test('running chats are named; Escape and Cancel close without doing anything', async () => {
  const t = dialog({ running: 2 });
  assert.equal(t.q('dp-running').hidden, false);
  assert.equal(t.q('dp-running').textContent, '2 chats are running and will be stopped.');
  const ev = t.box.dispatch('keydown', { key: 'Escape' });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.box.parentNode, null, 'Escape closes');
  assert.equal(t.calls.length, 0);
  const u = dialog({ running: 1 });
  assert.equal(u.q('dp-running').textContent, '1 chat is running and will be stopped.');
  u.q('dp-cancel').click();
  assert.equal(u.box.parentNode, null);
  assert.equal(u.calls.length, 0);
});

test('a failure is shown in the dialog, which stays open', async () => {
  const t = dialog({ confirm: () => Promise.reject(new Error('This folder holds another AIB project.')) });
  await flush();
  t.q('dp-ok').click();
  await flush();
  await flush();
  assert.notEqual(t.box.parentNode, null);
  assert.equal(t.q('dp-error').hidden, false);
  assert.equal(t.q('dp-error').textContent, 'This folder holds another AIB project.');
});

test('the project menu ends with "Delete project…" after a separator', async () => {
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new'] });
  const ctx = D.load(shell, [
    'status-words.js',
    'ownership-ui.js',
    'notify-rules.js',
    'sidebar-ui.js',
    'workspace-state.js',
    'split-tree.js',
    'delete-project-ui.js',
    'workspace-ui.js',
  ]);
  const list = [
    { provider: 'claude', id: 'a1', key: 'k-a1', title: 'A', cwd: 'C:/work/alpha', created: 1, modified: 1 },
  ];
  const posts = [];
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title,
    conversations: () => list,
    rerender() {},
    getJson: async () => ({}),
    postJson: async (n, b) => {
      posts.push([n, b]);
      return { exists: true, refusal: '', trash: 'recycle' };
    },
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  W.sync(list, null);
  const pk = W._items()[0].projectKey;
  W.openProjectCtx(pk, 0, 0, null);
  const menu = shell.body.querySelector('.ws-menu');
  const kids = menu.children;
  const last = kids[kids.length - 1];
  assert.equal(last.textContent, 'Delete project\u2026');
  assert.equal(kids[kids.length - 2].className, 'ws-menu-sep');
  last.click();
  const box = shell.body.querySelector('.dp-dialog');
  assert.ok(box, 'the in-page question opened');
  assert.match(
    box.querySelector('.dp-main').textContent,
    /^Removes alpha from AIB\. Its 1 chat moves to Recently deleted\./,
  );
  await flush();
  assert.equal(posts[0][0], 'project-remove');
  assert.equal(posts[0][1].check, true);
  assert.equal(posts[0][1].path, 'C:/work/alpha');
});

test('a removed project stays gone after a chat list reload, and comes back when the server forgets the removal', async () => {
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new'] });
  const ctx = D.load(shell, [
    'status-words.js',
    'ownership-ui.js',
    'notify-rules.js',
    'sidebar-ui.js',
    'workspace-state.js',
    'split-tree.js',
    'workspace-ui.js',
  ]);
  const list = [
    { provider: 'claude', id: 'a1', key: 'k-a1', title: 'A', cwd: 'C:/work/alpha', created: 1, modified: 1 },
    { provider: 'claude', id: 'b1', key: 'k-b1', title: 'B', cwd: 'C:/work/beta', created: 1, modified: 1 },
  ];
  let removed = { 'w:c:/work/alpha': { path: 'C:/work/alpha', at: 1 } };
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title,
    conversations: () => list,
    rerender() {},
    getJson: async () => ({ revision: String(Object.keys(removed).length), order: [], projects: {}, removed }),
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  await W.syncPrefs('1');
  W.sync(list, null);
  W.sync(list.slice(), null); // the list arrives again (a poll, a reload): alpha's old chats do not bring it back
  assert.deepEqual([...W.paletteProjects().map((p) => p.name)], ['beta']);
  assert.equal(W.inProject(list[0]), false, 'its chats are left out of All chats');
  assert.equal(W.inProject(list[1]), true);
  removed = {};
  await W.syncPrefs('0');
  W.sync(list, null);
  assert.deepEqual([...W.paletteProjects().map((p) => p.name)].sort(), ['alpha', 'beta']);
});

// ---- decision 6 (build plan 1b e2e 26): unmerged chat copies and another install's items, only when they exist ----------------
test('26: no unmerged work and nothing of another install: the dialog is unchanged (no list)', async () => {
  const t = dialog({
    check: () => Promise.resolve({ exists: true, refusal: '', trash: 'recycle', worktreeOf: '', cleanup: { items: [], silent: 3 } }),
  });
  await flush();
  assert.equal(t.q('dp-cleanup').hidden, true);
  assert.equal(t.box.querySelectorAll('.dp-cleanup-item').length, 0);
  t.q('dp-ok').click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls)), [{ disk: false, expect: '', cleanup: { remove: [] } }]);
});

test('26: unmerged copies are listed ticked, another install\'s items unticked; the ticked ids go with the confirm', async () => {
  const items = [
    { id: 'copy:a', kind: 'copy', own: true, unmerged: true, files: 4, title: 'Fix login', helper: false, clash: false },
    { id: 'copy:b', kind: 'copy', own: true, unmerged: true, files: 12, title: 'Refactor api', helper: false, clash: false },
    { id: 'branch:studio/helper-x', kind: 'branch', own: true, unmerged: true, files: 0, title: 'Add tests', helper: true, clash: false },
    { id: 'branch:studio/chat-zz', kind: 'branch', own: false, unmerged: false, files: 0, title: 'studio/chat-zz', helper: false, clash: false },
  ];
  const t = dialog({
    check: () => Promise.resolve({ exists: true, refusal: '', trash: 'recycle', worktreeOf: '', cleanup: { items, silent: 1 } }),
  });
  await flush();
  assert.equal(t.q('dp-cleanup').hidden, false);
  assert.equal(
    t.q('dp-cleanup-text').textContent,
    '3 chat copies have work that was never merged: "Fix login" (4 files), "Refactor api" (12 files), helper "Add tests". ' +
      "Removing the project deletes this work; restoring a chat from Recently deleted won't bring it back. " +
      'Another AIB install on this repository made 1 item here. They stay unless you tick them.',
  );
  const rows = Array.from(t.box.querySelectorAll('.dp-cleanup-item'));
  assert.deepEqual(
    rows.map((r) => r.querySelector('span').textContent),
    ['"Fix login" (4 files)', '"Refactor api" (12 files)', 'helper "Add tests"', '"studio/chat-zz" (made by another AIB install)'],
  );
  assert.deepEqual(
    rows.map((r) => r.querySelector('input').checked),
    [true, true, true, false],
  );
  rows[1].querySelector('input').checked = false; // keep "Refactor api"
  rows[3].querySelector('input').checked = true; // and remove the other install's branch
  t.q('dp-ok').click();
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(t.calls))[0].cleanup, { remove: ['copy:a', 'branch:studio/helper-x', 'branch:studio/chat-zz'] });
});

test('26: a kept clash stash is listed unticked, in plain words', async () => {
  const items = [{ id: 'stash:1', kind: 'stash', own: true, unmerged: true, files: 0, title: 'studio-merge-chat-ab-1', helper: false, clash: true }];
  const t = dialog({ check: () => Promise.resolve({ exists: true, refusal: '', trash: 'recycle', worktreeOf: '', cleanup: { items } }) });
  await flush();
  assert.equal(
    t.q('dp-cleanup-text').textContent,
    '1 git stash entry holds your edits that AIB set aside when a merge clashed. They stay unless you tick them.',
  );
  const row = t.box.querySelector('.dp-cleanup-item');
  assert.equal(row.querySelector('span').textContent, 'Your edits kept in the stash studio-merge-chat-ab-1');
  assert.equal(row.querySelector('input').checked, false);
});
