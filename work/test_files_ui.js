'use strict';
// Project files in the left sidebar (files-state.js + files-ui.js, with workspace-ui.js): the Chats | Files switch and its count,
// the lazy tree (ignored rows, filter, Changed toggle, badges from the Changes data), the scope menu, preview tabs, and the link
// rule for paths in replies. Fake DOM, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');
const FS = require('../outputs/agent-studio/files-state.js');

const SCRIPTS = [
  'status-words.js',
  'ownership-ui.js',
  'sidebar-ui.js',
  'workspace-state.js',
  'split-tree.js',
  'workspace-ui.js',
  'tool-views.js',
  'files-state.js',
  'files-ui.js',
];
const ROOT = 'C:/work/alpha';
const conv = (id, cwd, extra) =>
  Object.assign({ provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 }, extra || {});
const entry = (path, o) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign({ name, path, dir: false, ignored: false, status: '', changed: 0, size: 10 }, o || {});
};
const LISTING = {
  '': [
    entry('data', { dir: true }),
    entry('node_modules', { dir: true, ignored: true }),
    entry('outputs', { dir: true, changed: 1 }),
    entry('scripts', { dir: true, changed: 2 }),
    entry('README.md'),
  ],
  data: [entry('data/sales-2026.csv')],
  outputs: [entry('outputs/bar-charts.html', { status: 'U' }), entry('outputs/logo.png')],
  scripts: [entry('scripts/make_charts.py', { status: 'U' }), entry('scripts/load_sales.py', { status: 'M' })],
  node_modules: [entry('node_modules/lib', { dir: true })],
};
const CHANGES = [
  { path: 'outputs/bar-charts.html', status: 'U', added: 86, removed: 0, binary: false },
  { path: 'scripts/make_charts.py', status: 'U', added: 54, removed: 0, binary: false },
  { path: 'scripts/load_sales.py', status: 'M', added: 6, removed: 2, binary: false },
];

function setup(o) {
  const opts = o || {};
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new', 'connections'], width: opts.width || 1400 });
  shell.make('b', 'wsListName', shell.byId.wsProjectBtn);
  const find = shell.make('button', 'findChat');
  shell.body.insertBefore(find, shell.byId.connections);
  find.append(shell.make('span'));
  const ctx = D.load(shell, SCRIPTS);
  const calls = [];
  const focused = [];
  const opened = [];
  ctx.AgentChangesUI = {
    hunkRows: () => [],
    _live: () => ({
      data: () => ({ git: true, prefix: '', files: opts.changes || CHANGES }),
      chatId: () => 'claude:a1',
      focusFile: (p) => focused.push(p),
    }),
  };
  ctx.AgentArtifactsUI = {
    state: () => ({ list: [{ id: 'art1', sourcePath: ROOT + '/outputs/bar-charts.html' }] }),
    open: (id) => opened.push(id),
  };
  const list = opts.list || [conv('a1', ROOT), conv('a2', ROOT), conv('b1', 'C:/work/beta')];
  const getJson = async (path, q) => {
    calls.push({ path, q: Object.assign({}, q) });
    if (path === '/api/live/files/list') {
      const l = (opts.listing || LISTING)[q.dir];
      if (!l) throw Object.assign(new Error('Not found'), { status: 404 });
      return { root: ROOT, dir: q.dir, git: true, entries: l };
    }
    if (path === '/api/live/files/search')
      return { root: ROOT, matches: [{ path: 'outputs/bar-charts.html', name: 'bar-charts.html', dir: 'outputs' }], total: 1 };
    if (path === '/api/live/files/read')
      return { root: ROOT, path: q.path, abs: ROOT + '/' + q.path, name: q.path.split('/').pop(), size: 20, binary: false, tooBig: false, image: false, page: false, text: 'a = 1\nb = 2\n', lines: 2, viewUrl: '' };
    return {};
  };
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => list,
    rerender() {
      W.sync(list, list[0]); // what the page does: draw the list again, which syncs the workspace
    },
    getJson,
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  const FU = ctx.AgentFilesUI;
  FU.init({ aliasKey: (c) => c.provider + ':' + c.id, titleOf: (c) => c.title || c.id, getJson, conversations: () => list, open: async () => {} });
  W.sync(list, list[0]);
  FU.sync(list[0]);
  return { shell, ctx, W, FU, calls, list, focused, opened };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const rows = (t) => t.shell.body.querySelectorAll('.fx-row').filter((r) => r.dataset.path);
const rowOf = (t, p) => rows(t).find((r) => r.dataset.path === p);

test('the Chats | Files switch sits under Find, Find says "chat or file", and the Chats half counts this project\'s chats that need you', () => {
  const waiting = conv('a2', ROOT, { yourTurn: true, yourTurnAt: 300 });
  const t = setup({ list: [conv('a1', ROOT), waiting, conv('b1', 'C:/work/beta', { yourTurn: true, yourTurnAt: 300 })] });
  const sw = t.shell.body.querySelector('.sf-mode');
  assert.ok(sw, 'the switch exists');
  const kids = t.shell.body.children;
  assert.equal(kids.indexOf(sw), kids.indexOf(t.shell.byId.findChat) + 1, 'right under Find');
  assert.equal(t.shell.byId.findChat.querySelector('span').textContent, 'Find chat or file\u2026');
  const chats = sw.querySelector('.sf-mode-chats');
  assert.equal(chats.getAttribute('aria-pressed'), 'true');
  const badge = chats.querySelector('.ws-badge');
  assert.equal(badge.hidden, false);
  assert.equal(badge.textContent, '1', 'only this project: beta\'s waiting chat is not counted');
  // no Needs-you strip in Files mode, and no count on the switcher's folder icon (owner decisions)
  t.FU.setMode('files');
  assert.equal(t.shell.body.querySelectorAll('.sf-needs').length, 0);
  assert.equal(t.shell.byId.wsProjectBtn.querySelectorAll('.ws-badge').length, 0);
});

test('Ctrl+Shift+E toggles Chats and Files; the mode is remembered', () => {
  const t = setup();
  const key = (k) => t.shell.document.dispatch('keydown', { key: k, ctrlKey: true, shiftKey: true, altKey: false, metaKey: false });
  key('E');
  assert.equal(t.FU.mode(), 'files');
  assert.ok(t.shell.body.classList.contains('sf-files-mode'), 'the chat list hides (CSS on body.sf-files-mode)');
  assert.equal(t.shell.body.querySelector('#filesPane').hidden, false);
  assert.equal(t.shell.localStorage.getItem('aib-sidebar-mode'), 'files');
  key('E');
  assert.equal(t.FU.mode(), 'chats');
  assert.equal(t.shell.body.querySelector('#filesPane').hidden, true);
});

test('the tree is lazy: one folder per request; ignored entries are one dimmed row that does not open until Show ignored', async () => {
  const t = setup();
  t.FU.setMode('files');
  await flush();
  const lists = t.calls.filter((c) => c.path === '/api/live/files/list');
  assert.deepEqual(lists.map((c) => c.q.dir), [''], 'only the top folder so far');
  assert.equal(lists[0].q.id, 'claude:a1');
  assert.equal(lists[0].q.root, 'main', 'a chat without its own copy shows the project folder');
  assert.deepEqual(rows(t).map((r) => r.dataset.path), ['data', 'node_modules', 'outputs', 'scripts', 'README.md']);
  const nm = rowOf(t, 'node_modules');
  assert.ok(nm.classList.contains('ignored'));
  assert.equal(nm.querySelector('.fx-tag').textContent, 'ignored');
  nm.click();
  await flush();
  assert.ok(!t.calls.some((c) => c.q && c.q.dir === 'node_modules'), 'an ignored folder is not listed');
  rowOf(t, 'scripts').click();
  await flush();
  assert.deepEqual(t.calls.filter((c) => c.path === '/api/live/files/list').map((c) => c.q.dir), ['', 'scripts']);
  assert.ok(rowOf(t, 'scripts/load_sales.py'), 'opened folder shows its files');
  assert.equal(rowOf(t, 'scripts/load_sales.py').style['--d'], '1', 'indented one level');
  const show = t.shell.body.querySelector('.fx-foot-link');
  assert.equal(show.textContent, 'Show ignored');
  show.click();
  rowOf(t, 'node_modules').click();
  await flush();
  assert.ok(t.calls.some((c) => c.q && c.q.dir === 'node_modules'), 'after Show ignored it opens');
});

test('badges come from the Changes data (A +86, M +6 −2); a badge opens that file in the Changes tab; folders say "n changed"; ⧉ marks artifacts', async () => {
  const t = setup();
  t.FU.setMode('files');
  await flush();
  assert.equal(rowOf(t, 'scripts').querySelector('.fx-dirchg').textContent, '2 changed');
  assert.equal(rowOf(t, 'outputs').querySelector('.fx-dirchg').textContent, '1 changed');
  rowOf(t, 'scripts').click();
  rowOf(t, 'outputs').click();
  await flush();
  assert.equal(rowOf(t, 'scripts/load_sales.py').querySelector('.fx-chg').textContent, 'M+6\u22122');
  assert.equal(rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-chg').textContent, 'A+86');
  assert.equal(rowOf(t, 'outputs/logo.png').querySelector('.fx-chg'), null);
  assert.ok(rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-art'), 'artifact marker');
  assert.equal(rowOf(t, 'outputs/logo.png').querySelector('.fx-art'), null);
  rowOf(t, 'scripts/load_sales.py').querySelector('.fx-chg').click();
  assert.deepEqual(t.focused, ['scripts/load_sales.py'], 'the Changes tab opens on that diff');
  rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-art').click();
  assert.deepEqual(t.opened, ['art1']);
});

test('the filter gives a flat list of matches with their folder; Changed n lists the changed files', async () => {
  const t = setup();
  t.FU.setMode('files');
  await flush();
  const changed = t.shell.body.querySelector('.fx-toggle');
  assert.equal(changed.textContent, 'Changed 3');
  changed.click();
  assert.equal(changed.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(rows(t).map((r) => r.dataset.path), ['outputs/bar-charts.html', 'scripts/load_sales.py', 'scripts/make_charts.py']);
  assert.equal(rowOf(t, 'scripts/make_charts.py').querySelector('.fx-dirpath').textContent, 'scripts');
  changed.click();
  const f = t.shell.body.querySelector('.fx-search');
  f.value = 'chart';
  f.dispatch('input');
  t.shell.window.runTimers();
  await flush();
  const s = t.calls.find((c) => c.path === '/api/live/files/search');
  assert.equal(s.q.q, 'chart');
  assert.deepEqual(rows(t).map((r) => r.dataset.path), ['outputs/bar-charts.html']);
  assert.equal(rowOf(t, 'outputs/bar-charts.html').querySelector('mark').textContent, 'chart');
  assert.equal(rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-dirpath').textContent, 'outputs');
  assert.match(t.shell.body.querySelector('.fx-foot-t').textContent, /^1 match/);
});

test('arrow keys move and open folders, Enter opens a file', () => {
  const cache = { '': LISTING[''], scripts: LISTING.scripts };
  const open = new Set(['scripts']);
  const r = FS.treeRows(cache, open, {});
  assert.deepEqual(FS.keyMove(r, 'data', 'ArrowDown'), { sel: 'node_modules' });
  assert.deepEqual(FS.keyMove(r, 'data', 'ArrowRight'), { sel: 'data', open: 'data' });
  assert.deepEqual(FS.keyMove(r, 'scripts', 'ArrowRight'), { sel: 'scripts/make_charts.py' });
  assert.deepEqual(FS.keyMove(r, 'scripts', 'ArrowLeft'), { sel: 'scripts', close: 'scripts' });
  assert.deepEqual(FS.keyMove(r, 'scripts/load_sales.py', 'ArrowLeft'), { sel: 'scripts' });
  assert.deepEqual(FS.keyMove(r, 'README.md', 'Enter'), { sel: 'README.md', activate: 'README.md' });
  assert.deepEqual(FS.keyMove(r, 'node_modules', 'ArrowRight'), { sel: 'node_modules' }, 'an ignored folder does not open');
});

test('scope follows the open chat (its own copy when it has one); the menu lists copies and Follow, and unticking pins', async () => {
  const wt = conv('w1', 'C:/work/alpha/.claude/worktrees/feat', { projectRoot: ROOT, worktree: { branch: 'claude/feat' } });
  const t = setup({ list: [wt, conv('a1', ROOT), conv('a3', ROOT + '/.claude/worktrees/csv', { projectRoot: ROOT, worktree: { branch: 'codex/importer' }, title: 'Clean up CSV' })] });
  t.FU.setMode('files');
  await flush();
  const first = t.calls.find((c) => c.path === '/api/live/files/list');
  assert.deepEqual([first.q.id, first.q.root], ['claude:w1', 'chat'], "the chat's own copy");
  const btn = t.shell.body.querySelector('.fx-scope');
  assert.equal(btn.textContent, 'Copy\u2387 claude/feat\u25BE');
  btn.click();
  const menu = t.shell.body.querySelector('.fx-menu');
  const items = menu.querySelectorAll('.fx-menu-it').map((b) => b.textContent);
  assert.deepEqual(items, ["\u2713This chat's copyclaude/feat", 'Main folderC:/work/alpha', 'Clean up CSVcodex/importer', '\u2713Follow the open chat']);
  menu.querySelectorAll('.fx-menu-it')[1].click();
  await flush();
  const st = t.FU._state();
  assert.equal(st.following, false, 'choosing a scope pins it');
  assert.deepEqual([st.pinned.id, st.pinned.root], ['claude:w1', 'main']);
  assert.equal(t.shell.body.querySelector('.fx-scope').textContent, 'Folderalpha\u25BE');
  // opening another chat does not move a pinned scope
  t.FU.sync(t.list[1]);
  assert.equal(t.FU.currentScope().root, 'main');
  t.shell.body.querySelector('.fx-scope').click();
  t.shell.body.querySelector('.fx-menu').querySelectorAll('.fx-menu-it').pop().click();
  assert.equal(t.FU._state().following, true, 'Follow the open chat ticks again');
});

test('preview tabs: a single click opens an italic preview tab that the next click replaces; double-click keeps it', async () => {
  const t = setup();
  t.FU.setMode('files');
  await flush();
  rowOf(t, 'README.md').click();
  await flush();
  let tabs = t.shell.byId.chatTabs.querySelectorAll('.sf-ftab');
  assert.equal(tabs.length, 1);
  assert.ok(tabs[0].classList.contains('preview'), 'italic preview tab');
  assert.ok(tabs[0].classList.contains('on'));
  assert.ok(t.shell.body.classList.contains('sf-file-on'), 'the file shows in the middle');
  assert.equal(t.shell.byId.chatTabs.querySelectorAll('.ws-tab.on').length, 1, 'no chat tab is active while a file shows');
  rowOf(t, 'data').click();
  await flush();
  rowOf(t, 'data/sales-2026.csv').click();
  await flush();
  tabs = t.shell.byId.chatTabs.querySelectorAll('.sf-ftab');
  assert.equal(tabs.length, 1, 'the preview tab was replaced');
  assert.equal(tabs[0].querySelector('.ws-tab-title').textContent, 'sales-2026.csv');
  rowOf(t, 'data/sales-2026.csv').dispatch('dblclick');
  rowOf(t, 'README.md').click();
  await flush();
  tabs = t.shell.byId.chatTabs.querySelectorAll('.sf-ftab');
  assert.equal(tabs.length, 2, 'the kept tab stays, a new preview opens');
  assert.ok(!tabs[0].classList.contains('preview'));
  // the file view: breadcrumb, read only, line numbers, Open in editor visible
  const view = t.shell.body.querySelector('#fileView');
  assert.equal(view.hidden, false);
  assert.equal(view.querySelector('.sf-fv-crumb').querySelector('b').textContent, 'README.md');
  assert.deepEqual(view.querySelectorAll('.fx-no').map((n) => n.textContent), ['1', '2']);
  assert.match(view.querySelector('.fx-pv-foot').textContent, /Read-only/);
  // clicking a chat tab goes back to the chat
  t.shell.byId.chatTabs.querySelectorAll('.ws-tab').find((n) => !n.classList.contains('sf-ftab')).querySelector('.ws-tab-main').click();
  assert.ok(!t.shell.body.classList.contains('sf-file-on'));
});

test('link rule: a path to an existing file in the chat folder links (with :line), missing ones stay text, a repeat links once, nothing becomes an artifact', async () => {
  const t = setup();
  const D2 = t.shell.document;
  const p = D2.createElement('p');
  p.append(
    D2.createTextNode('They read data/sales-2026.csv and scripts/make_charts.py:12, not data/missing.csv or C:/elsewhere/x.py; again data/sales-2026.csv.'),
  );
  const box = D2.createElement('div');
  box.append(p);
  const n = await t.FU.linkPaths(box);
  assert.equal(n, 2);
  const links = box.querySelectorAll('a.fx-path');
  assert.deepEqual(links.map((a) => a.dataset.filePath), ['data/sales-2026.csv', 'scripts/make_charts.py']);
  assert.equal(links[1].dataset.line, '12');
  assert.ok(links[0].querySelector('.fx-pico'), 'file icon');
  assert.ok(links[0].querySelector('code'), 'code font');
  assert.match(box.textContent, /not data\/missing\.csv or C:\/elsewhere\/x\.py; again data\/sales-2026\.csv\./, 'missing, outside and repeat stay text');
  assert.ok(!t.calls.some((c) => /artifacts/.test(c.path)), 'no artifact call');
  // a click opens the file (beside the chat at 1280 px and wider), scrolled to the line; never an artifact
  t.shell.document.dispatch('click', { target: links[1], ctrlKey: false });
  await flush();
  const st = t.FU._state();
  assert.equal(st.beside.tabs.length, 1);
  assert.equal(st.beside.tabs[0].path, 'scripts/make_charts.py');
  assert.equal(st.beside.tabs[0].line, 12);
  assert.ok(t.shell.body.classList.contains('sf-beside-on'));
  assert.equal(t.FU.mode(), 'chats', 'the sidebar never switches modes on its own');
});

test('below 1280 px a clicked path opens as a tab; Ctrl+click asks the editor', async () => {
  const t = setup({ width: 1000 });
  const edits = [];
  t.ctx.AgentEditors = { openFile: (p, l) => edits.push([p, l]), fileEditor: () => ({ name: 'VS Code' }) };
  const D2 = t.shell.document;
  const p = D2.createElement('p');
  p.append(D2.createTextNode('see README.md:3'));
  await t.FU.linkPaths(p);
  const a = p.querySelector('a.fx-path');
  D2.dispatch('click', { target: a, ctrlKey: true });
  assert.deepEqual(edits, [[ROOT + '/README.md', 3]]);
  D2.dispatch('click', { target: a, ctrlKey: false });
  await flush();
  assert.equal(t.FU._state().beside.tabs.length, 0);
  assert.equal(t.FU._state().tabs.tabs[0].path, 'README.md');
  assert.equal(t.FU._state().tabs.tabs[0].preview, false, 'opened from a link: kept, not a preview');
});

test('files-state: badges, link candidates, dedupe and relTo', () => {
  assert.equal(FS.badgeOf({ status: 'U', added: 86, removed: 0 }).text, 'A +86');
  assert.equal(FS.badgeOf({ status: 'M', added: 6, removed: 2 }).text, 'M +6 \u22122');
  assert.equal(FS.badgeOf(null), null);
  const m = FS.changesMap([{ path: 'sub/a.js', status: 'M' }, { path: 'other/b.js', status: 'M' }], 'sub/');
  assert.deepEqual([...m.keys()], ['a.js']);
  const c = FS.pathCandidates('open a/b.py:7 and https://x.com/y/z.html or e.g. this.');
  assert.deepEqual(c.map((x) => [x.path, x.line]).filter((x) => !/^e\.g/.test(x[0])), [['a/b.py', 7]]);
  assert.equal(FS.relTo('C:\\work\\alpha\\x\\y.txt', 'C:\\work\\alpha'), 'x/y.txt');
  assert.equal(FS.relTo('../up.txt', 'C:/work/alpha'), null);
  assert.equal(FS.relTo('D:/other/y.txt', 'C:/work/alpha'), null);
  assert.equal(FS.relTo('.git/config', 'C:/work/alpha'), null);
  assert.equal(FS.dedupe(FS.pathCandidates('a.md then ./a.md then A.md'), 'C:/w').length, 1);
  assert.ok(FS.opensBeside(1280) && !FS.opensBeside(1279));
});
