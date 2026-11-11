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
  const registered = [],
    registeredIn = [];
  ctx.AgentArtifactsUI = {
    state: () => ({ list: opts.ownList || [{ id: 'art1', sourcePath: ROOT + '/outputs/bar-charts.html' }] }),
    open: (id) => (opened.push(id), !opts.openFails),
    registerFile: async (abs, chatId) => {
      registered.push(abs);
      registeredIn.push(chatId);
      if (opts.registerFail) throw new Error(opts.registerFail);
      (opts.arts = opts.arts || {})[chatId || 'claude:a1'] = [{ id: 'new1', sourcePath: abs }];
      opened.push('new1'); // the real one opens it in the right column
      return { id: 'new1' };
    },
  };
  const list = opts.list || [conv('a1', ROOT), conv('a2', ROOT), conv('b1', 'C:/work/beta')];
  const getJson = async (path, q) => {
    calls.push({ path, q: Object.assign({}, q) });
    if (path === '/api/live/files/list') {
      const l = (opts.listing || LISTING)[q.dir];
      if (!l) throw Object.assign(new Error('Not found'), { status: 404 });
      const own = q.root === 'chat' ? list.find((c) => 'claude:' + c.id === q.id) : null;
      return { root: own ? own.cwd : ROOT, dir: q.dir, git: true, entries: l };
    }
    if (path === '/api/live/files/search')
      return { root: ROOT, matches: [{ path: 'outputs/bar-charts.html', name: 'bar-charts.html', dir: 'outputs' }], total: 1 };
    if (path === '/api/live/files/read') {
      // a chat's own copy ('chat' root) is that chat's folder; the main folder is ROOT
      const own = q.root === 'chat' ? list.find((c) => 'claude:' + c.id === q.id) : null,
        base = own ? own.cwd : ROOT;
      return { root: base, path: q.path, abs: base + '/' + q.path, name: q.path.split('/').pop(), size: 20, binary: false, tooBig: false, image: false, page: /\.(html?|svg|md)$/.test(q.path), text: 'a = 1\nb = 2\n', lines: 2, viewUrl: '' };
    }
    if (path === '/api/live/files/outside') {
      const r = (opts.outside || {})[q.path];
      if (!r) throw Object.assign(new Error('This chat never named that file'), { status: 403 });
      const name = q.path.split(/[\\/]/).pop();
      return Object.assign({ path: q.path, abs: q.path, name, size: 12, binary: false, tooBig: false, image: false, page: false, text: q.peek ? null : 'x = 1\n', lines: 1, viewUrl: '' }, r);
    }
    if (path === '/api/live/artifacts') return { artifacts: (opts.arts || {})[q.conversationId] || [] };
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
  // notice: what chat.js passes (fail): the page's #error line, inside <main>, shows the message.
  const notice = (m) => {
    const e = shell.byId.error;
    if (!e) return;
    e.textContent = m;
    e.hidden = false;
  };
  FU.init({ aliasKey: (c) => c.provider + ':' + c.id, titleOf: (c) => c.title || c.id, getJson, notice, conversations: () => list, open: async () => {} });
  W.sync(list, list[0]);
  FU.sync(list[0]);
  return { shell, ctx, W, FU, calls, list, focused, opened, registered, registeredIn };
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

test("⧉ counts any chat of the project: a file another chat registered is marked, and opens in the open chat's viewer", async () => {
  // The open chat (a1) has no artifacts of its own; a2 made bar-charts.html. The Artifacts viewer only knows a1's list.
  const t = setup({ ownList: [], arts: { 'claude:a2': [{ id: 'other1', sourcePath: ROOT + '/outputs/bar-charts.html' }] } });
  t.FU.setMode('files');
  await flush();
  const asked = t.calls.filter((c) => c.path === '/api/live/artifacts').map((c) => c.q.conversationId);
  assert.ok(asked.includes('claude:a1') && asked.includes('claude:a2'), 'every chat of the project is asked');
  assert.ok(!asked.includes('claude:b1'), 'not chats of other projects');
  rowOf(t, 'outputs').click();
  await flush();
  const mark = rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-art');
  assert.ok(mark, 'marked although the open chat did not register it');
  mark.click();
  assert.deepEqual(t.opened, ['other1'], 'opened by id in the current viewer');
  // the file view has the button too
  rowOf(t, 'outputs/bar-charts.html').click();
  await flush();
  const b = t.shell.body.querySelector('#fileView').querySelectorAll('.fx-btn').find((x) => /Open in Artifacts/.test(x.textContent));
  assert.ok(b);
  b.click();
  await flush();
  assert.deepEqual(t.opened, ['other1', 'other1']);
  assert.deepEqual(t.registered, [], 'an existing artifact is never registered again');
});

test('Open in Artifacts shows for every page file; on one no chat registered it registers it in the open chat, then the ⧉ appears', async () => {
  const t = setup({ ownList: [] });
  t.FU.setMode('files');
  await flush();
  rowOf(t, 'outputs').click();
  await flush();
  assert.equal(rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-art'), null, 'not an artifact yet: no marker');
  rowOf(t, 'outputs/bar-charts.html').click();
  await flush();
  const view = t.shell.body.querySelector('#fileView');
  const b = view.querySelectorAll('.fx-btn').find((x) => /Open in Artifacts/.test(x.textContent));
  assert.ok(b, 'shown for an html file');
  b.click();
  await flush();
  await flush();
  assert.deepEqual(t.registered, [ROOT + '/outputs/bar-charts.html'], 'registered in the open chat on click');
  assert.deepEqual(t.registeredIn, ['claude:a1'], 'the open chat works in this folder');
  assert.deepEqual(t.opened, ['new1'], 'and it is shown in the Artifacts tab');
  assert.ok(rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-art'), 'now marked');
  // not for a file that has no page
  rowOf(t, 'README.md').click();
  await flush();
  rowOf(t, 'scripts').click();
  await flush();
  rowOf(t, 'scripts/load_sales.py').click();
  await flush();
  const v2 = t.shell.body.querySelector('#fileView');
  assert.equal(v2.querySelectorAll('.fx-btn').filter((x) => /Open in Artifacts/.test(x.textContent)).length, 0, 'a .py file has no page');
});

const artBtn = (t) => t.shell.body.querySelector('#fileView').querySelectorAll('.fx-btn').find((x) => /Open in Artifacts/.test(x.textContent));
async function openHtml(t) {
  rowOf(t, 'outputs').click();
  await flush();
  rowOf(t, 'outputs/bar-charts.html').click();
  await flush();
  await flush();
}

test("Open in Artifacts from a file tab in another chat's copy registers it in THAT chat and shows it, not in the open chat", async () => {
  // The owner's case: chat a1 is open (main folder); the Files sidebar browses chat w1's copy (⎇ ec360be) and a file of it is a tab.
  const wt = conv('w1', ROOT + '/.claude/worktrees/proto', { projectRoot: ROOT, worktree: { branch: 'ec360be' }, title: 'Prototype' });
  const t = setup({ ownList: [], list: [conv('a1', ROOT), wt] });
  t.FU.setMode('files');
  await flush();
  t.shell.body.querySelector('.fx-scope').click();
  t.shell.body.querySelector('.fx-menu').querySelectorAll('.fx-menu-it').find((b) => /Prototype/.test(b.textContent)).click();
  await flush();
  await openHtml(t);
  assert.ok(t.shell.body.classList.contains('sf-file-on'), 'a file tab is showing, not the chat');
  const b = artBtn(t);
  assert.ok(b && !b.disabled, 'the button works here');
  assert.match(b.title, /"Prototype"/, 'its tooltip names the chat that will keep it');
  b.click();
  await flush();
  await flush();
  assert.deepEqual(t.registered, [ROOT + '/.claude/worktrees/proto/outputs/bar-charts.html']);
  assert.deepEqual(t.registeredIn, ['claude:w1'], "registered in the copy's chat: the open chat's folder does not hold the file");
  assert.deepEqual(t.opened, ['new1'], 'shown in the Artifacts tab');
  assert.equal(t.shell.body.querySelector('.sf-fv-alert'), null, 'no error');
  assert.ok(t.shell.body.classList.contains('sf-file-on'), 'the file tab stays open; the artifact shows in the right column');
});

test('Open in Artifacts with no chat working in the folder is disabled and its tooltip says why', async () => {
  // Only a worktree chat: its copy's files can be registered, the main folder's cannot (no chat works there).
  const wt = conv('w1', ROOT + '/.claude/worktrees/proto', { projectRoot: ROOT, worktree: { branch: 'ec360be' }, title: 'Prototype' });
  const t = setup({ ownList: [], list: [wt] });
  t.FU.setMode('files');
  await flush();
  t.shell.body.querySelector('.fx-scope').click();
  t.shell.body.querySelector('.fx-menu').querySelectorAll('.fx-menu-it').find((b) => /Main folder/.test(b.textContent)).click();
  await flush();
  await openHtml(t);
  const b = artBtn(t);
  assert.ok(b, 'still shown, so it is clear the feature exists');
  assert.equal(b.disabled, true);
  assert.match(b.title, /No chat works in this folder/);
  assert.deepEqual(t.registered, []);
});

test('a failed Open in Artifacts shows an alert in the file view (the page error line is hidden while a file shows); × dismisses it', async () => {
  const t = setup({ ownList: [], registerFail: 'That file does not exist.' });
  t.FU.setMode('files');
  await flush();
  await openHtml(t);
  artBtn(t).click();
  await flush();
  await flush();
  const alert = t.shell.body.querySelector('#fileView').querySelector('.sf-fv-alert');
  assert.ok(alert, 'a visible notice, never silence');
  assert.equal(alert.getAttribute('role'), 'alert');
  assert.match(alert.textContent, /Could not open in Artifacts: That file does not exist\./);
  alert.querySelector('.sf-fv-alert-x').click();
  assert.equal(t.shell.body.querySelector('#fileView').querySelector('.sf-fv-alert'), null);
});

test("an error notice raised while a file tab shows is visible: files.css's file-on rule spares the page's error and notice lines", async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { cssRules, declarationsFor } = require('./css_rules.js');
  const rules = cssRules(fs.readFileSync(path.join(__dirname, '../outputs/agent-studio/files.css'), 'utf8'));
  // Every "body.sf-file-on main > :not(#a):not(#b)…" rule that hides: the ids it spares.
  const hiders = rules
    .filter((r) => r.context === '' && /^body\.sf-file-on main > :not\(/.test(r.selector) && /^none/.test(r.declarations.display || ''))
    .map((r) => [...r.selector.matchAll(/:not\(#([\w-]+)\)/g)].map((m) => m[1]));
  assert.ok(hiders.length, 'the rule that swaps the chat for the file is there');
  const hiddenByCss = (el, body) =>
    body.classList.contains('sf-file-on') && el.parentNode && el.parentNode.tagName === 'MAIN' && hiders.some((ids) => !ids.includes(el.id));
  const visible = (el, body) => !el.hidden && !hiddenByCss(el, body);

  const t = setup({ openFails: true, arts: { 'claude:a1': [] } });
  const main = t.shell.body.querySelector('main');
  // the page's lines, as chat.html has them: direct children of <main>
  const mk = (id) => {
    const n = t.shell.make('div', id, main);
    n.hidden = true;
    return n;
  };
  const error = mk('error');
  mk('updateBanner');
  mk('studioNotice');
  t.FU.setMode('files');
  await flush();
  rowOf(t, 'outputs').click();
  await flush();
  rowOf(t, 'outputs/bar-charts.html').click();
  await flush();
  assert.ok(t.shell.body.classList.contains('sf-file-on'), 'a file tab is showing');
  assert.ok(hiddenByCss(t.shell.byId.messages, t.shell.body), 'the chat is hidden behind the file');
  // the ⧉ marker in the tree: its viewer refuses, which raises the page notice (no file-view alert on this path)
  rowOf(t, 'outputs/bar-charts.html').querySelector('.fx-art').click();
  await flush();
  await flush();
  assert.match(error.textContent, /Could not open in Artifacts/);
  assert.ok(visible(error, t.shell.body), 'the error line shows over the file view');
  for (const id of ['updateBanner', 'studioNotice']) assert.ok(!hiddenByCss(t.shell.byId[id], t.shell.body), id + ' is spared too');
  assert.equal(declarationsFor(rules, 'body.sf-file-on main > #fileView').order, '1', 'the file view sits under the notices');
});

// ---- write / edit rows: the open-file icon and the clickable path ----------------------------------------------------------
const writeRow = (id, path, o) => ({
  role: 'tool',
  uid: id,
  call: Object.assign({ id, name: 'Write', input: { file_path: path, content: 'x = 1\n' }, result: { text: 'File written' } }, o || {}),
});
const editRow = (id, path) => ({
  role: 'tool',
  uid: id,
  call: { id, name: 'Edit', input: { file_path: path, old_string: 'a', new_string: 'b' }, result: { text: 'Edited' } },
});
const readRow = (id, path) => ({ role: 'tool', uid: id, call: { id, name: 'Read', input: { file_path: path }, result: { text: 'a' } } });
// A tool row the way chat.js draws it, inside `box` (#messages, #submessages or a split pane's .mirror-msgs).
async function drawRow(t, row, box) {
  const TV = t.ctx.ToolViews;
  const line = TV.line(row, () => (row.raw ? TV.render(row.raw) : TV.renderCall(row.call)));
  box.append(line);
  await flush();
  await flush();
  return line;
}
const actsOf = (line) => line.children.find((c) => c.classList.contains('tool-acts'));
const fileBtn = (line) => line.querySelector('.tool-file');
const withEditor = (t, edits) => {
  t.ctx.AgentEditors = {
    canOpenFile: () => true,
    fileTip: (l) => 'Open in VS Code' + (l ? ' at line ' + l : ''),
    fileEditor: () => ({ name: 'VS Code' }),
    openFile: (p, l) => edits.push([p, l]),
  };
};
const expand = (line) => line.querySelector('.tool-toggle').dispatch('click');

test('a write row in the main chat gets a visible open-file icon (tooltip, "Open <name>"), beside "editor ↗"; it opens the file view', async () => {
  const t = setup();
  const edits = [];
  withEditor(t, edits);
  const messages = t.shell.make('div', 'messages');
  const line = await drawRow(t, writeRow('w1', ROOT + '/scripts/make_charts.py'), messages);
  const b = fileBtn(line);
  assert.ok(b, 'the icon button is there');
  assert.equal(b.hidden, false, 'visible, not hover-only');
  assert.equal(b.getAttribute('aria-label'), 'Open make_charts.py');
  assert.match(b.title, /^Open make_charts\.py\n/);
  assert.ok(b.querySelector('.tool-file-ico'), 'an icon');
  // the editor button stays and says what it does; exactly one of each, file icon first
  const acts = actsOf(line);
  assert.deepEqual(acts.children.map((c) => c.className), ['tool-file', 'tool-open']);
  const ed = acts.querySelector('.tool-open');
  assert.equal(ed.textContent, 'editor ↗');
  assert.equal(ed.getAttribute('aria-label'), 'Open in VS Code');
  assert.equal(line.querySelectorAll('.art-preview').length, 0, 'no "Show file" button');
  // Tab order: the actions come before the opened detail
  assert.equal(line.children.at(-1).className.split(' ')[0], 'tool-detail');
  // a click opens the file (beside the chat at 1400 px); the row does not expand
  b.dispatch('click');
  await flush();
  assert.equal(t.FU._state().beside.tabs[0].path, 'scripts/make_charts.py');
  assert.doesNotMatch(line.className, /\bopen\b/);
  assert.deepEqual(edits, [], 'the icon never opens the editor');
  ed.dispatch('click');
  assert.deepEqual(edits, [[ROOT + '/scripts/make_charts.py', null]], '"editor ↗" opens the editor');
});

test('an edit row gets the icon too; read rows and failed writes do not', async () => {
  const t = setup({ width: 1000 });
  const box = t.shell.make('div', 'messages');
  const edit = await drawRow(t, editRow('e1', ROOT + '/scripts/load_sales.py'), box);
  assert.equal(fileBtn(edit).getAttribute('aria-label'), 'Open load_sales.py');
  fileBtn(edit).dispatch('click');
  await flush();
  assert.equal(t.FU._state().tabs.tabs[0].path, 'scripts/load_sales.py', 'below 1280 px: a tab');
  const read = await drawRow(t, readRow('r1', ROOT + '/README.md'), box);
  assert.equal(fileBtn(read), null, 'a read row has no open-file icon');
  const failed = await drawRow(t, writeRow('w2', ROOT + '/README.md', { result: { text: 'Error: denied', isError: true } }), box);
  assert.equal(fileBtn(failed), null, 'a failed write has none');
});

test('the path in an expanded write detail is a file link: click opens it, Ctrl+click opens the editor, right-click gives the link menu', async () => {
  const t = setup();
  const edits = [];
  withEditor(t, edits);
  const box = t.shell.make('div', 'messages');
  const line = await drawRow(t, writeRow('w3', ROOT + '/scripts/make_charts.py'), box);
  expand(line);
  const a = line.querySelector('.tool-detail').querySelector('a.fx-path');
  assert.ok(a, 'the path box became a link');
  assert.equal(a.dataset.filePath, 'scripts/make_charts.py');
  assert.ok(a.querySelector('.fx-pico'), 'file icon');
  assert.ok(a.querySelector('code').classList.contains('tool-path-text'), 'still the code box');
  t.shell.document.dispatch('click', { target: a, ctrlKey: true });
  assert.deepEqual(edits, [[ROOT + '/scripts/make_charts.py', 0]]);
  t.shell.document.dispatch('click', { target: a, ctrlKey: false });
  await flush();
  assert.equal(t.FU._state().beside.tabs[0].path, 'scripts/make_charts.py');
  t.shell.document.dispatch('contextmenu', { target: a, clientX: 20, clientY: 30 });
  const items = t.shell.body.querySelectorAll('.fx-menu-it').map((x) => x.textContent);
  assert.deepEqual(items.slice(0, 3), ['Open to the side', 'Show in Files', 'Copy path']);
  // a row already open when the check finishes is linked too
  const t2 = setup();
  const box2 = t2.shell.make('div', 'messages');
  const TV = t2.ctx.ToolViews;
  const row = writeRow('w4', ROOT + '/README.md');
  const l2 = TV.line(row, () => TV.renderCall(row.call));
  box2.append(l2);
  expand(l2);
  await flush();
  await flush();
  assert.ok(l2.querySelector('.tool-detail').querySelector('a.fx-path'));
});

test('a missing file or one outside the folder the chat never named: plain path, no open-file icon', async () => {
  const t = setup();
  const box = t.shell.make('div', 'messages');
  for (const p of [ROOT + '/data/missing.csv', 'C:/elsewhere/x.py']) {
    const line = await drawRow(t, writeRow('m-' + p, p), box);
    assert.equal(fileBtn(line), null, p);
    expand(line);
    assert.equal(line.querySelector('.tool-detail').querySelector('a.fx-path'), null, p);
    assert.equal(line.querySelector('code.tool-path-text').textContent, p);
  }
  const asked = t.calls.filter((c) => c.path === '/api/live/files/outside');
  assert.deepEqual(asked.map((c) => c.q.path), ['C:/elsewhere/x.py'], 'only the outside path is asked about, by the chat');
  assert.equal(asked[0].q.id, 'claude:a1');
});

test('outside the folder but named by the chat (a discovered chat): icon and link open it read only, labelled "Outside this project"', async () => {
  const OUT = 'C:/Users/me/AIB-keeper-terms/work/deno/keeper_terminal_test.ts';
  const t = setup({
    width: 1000,
    outside: { [OUT]: { outside: { kind: 'worktree', branch: 'keeper-terms', repo: 'AIB', text: '⎇ keeper-terms · git worktree of AIB' } } },
  });
  const box = t.shell.make('div', 'submessages'); // the subagent history view
  const line = await drawRow(t, writeRow('o1', OUT), box);
  const asked = t.calls.find((c) => c.path === '/api/live/files/outside');
  assert.equal(asked.q.id, 'claude:a1', 'a discovered chat is named by provider:session');
  assert.equal(asked.q.peek, 1);
  const b = fileBtn(line);
  assert.equal(b.getAttribute('aria-label'), 'Open keeper_terminal_test.ts');
  assert.match(b.title, /Outside this project · ⎇ keeper-terms · git worktree of AIB, read only/);
  b.dispatch('click');
  await flush();
  await flush();
  const tab = t.FU._state().tabs.tabs[0];
  assert.equal(tab.scope.root, 'outside');
  assert.equal(tab.path, OUT);
  const ftab = t.shell.byId.chatTabs.querySelectorAll('.sf-ftab')[0];
  assert.match(ftab.querySelector('.ws-tab-main').title, /Outside this project · ⎇ keeper-terms · git worktree of AIB/);
  const view = t.shell.body.querySelector('#fileView');
  const chip = view.querySelector('.sf-fv-from');
  assert.equal(chip.textContent, 'Outside this project· ⎇ keeper-terms · git worktree of AIB');
  assert.equal(view.querySelector('.fx-chg'), null, 'no change badge');
  assert.match(view.querySelector('.fx-pv-foot').textContent, /Read-only/);
  assert.ok(t.calls.some((c) => c.path === '/api/live/files/outside' && !c.q.peek), 'read through the outside route');
  assert.ok(!t.calls.some((c) => c.path === '/api/live/changes/file'), 'no Changes jump');
  // the path in the detail links the same way; its menu has no "Show in Files"
  expand(line);
  const a = line.querySelector('.tool-detail').querySelector('a.fx-path');
  assert.ok(a);
  t.shell.document.dispatch('contextmenu', { target: a, clientX: 1, clientY: 1 });
  const items = t.shell.body.querySelectorAll('.fx-menu-it').map((x) => x.textContent);
  assert.ok(!items.includes('Show in Files'), items.join(','));
});

test('folder label variants: worktree, ordinary repo, plain folder', async () => {
  const P = { wt: 'C:/x/wt/a.ts', repo: 'C:/x/repo/b.ts', plain: 'C:/x/plain/c.ts' };
  const t = setup({
    width: 1000,
    outside: {
      [P.wt]: { outside: { kind: 'worktree', text: '⎇ feat · git worktree of AIB' } },
      [P.repo]: { outside: { kind: 'repo', text: '⎇ main' } },
      [P.plain]: { outside: { kind: 'folder', text: 'C:\\x\\plain' } },
    },
  });
  const box = t.shell.make('div', 'messages');
  const want = {
    wt: 'Outside this project · ⎇ feat · git worktree of AIB',
    repo: 'Outside this project · ⎇ main',
    plain: 'Outside this project · C:\\x\\plain',
  };
  for (const k of Object.keys(P)) {
    const line = await drawRow(t, writeRow('l-' + k, P[k]), box);
    fileBtn(line).dispatch('click');
    await flush();
    await flush();
    const chip = t.shell.body.querySelector('#fileView').querySelector('.sf-fv-from');
    assert.equal(chip.textContent.replace('project·', 'project ·'), want[k], k);
    assert.ok(chip.title.startsWith(want[k]), k);
  }
});

test("split panes: a row in another pane is checked against that pane's chat", async () => {
  // b1's folder is C:/work/beta: a file in alpha is outside it, so the outside route is asked with b1's id.
  const t = setup({ outside: { [ROOT + '/README.md']: { outside: { kind: 'folder', text: ROOT } } } });
  const pane = t.shell.make('div');
  pane.className = 'mirror-msgs';
  pane.dataset.mirror = 'claude:b1';
  const line = await drawRow(t, writeRow('s1', ROOT + '/README.md'), pane);
  const asked = t.calls.filter((c) => c.path === '/api/live/files/outside');
  assert.deepEqual(asked.map((c) => c.q.id), ['claude:b1']);
  assert.equal(fileBtn(line).getAttribute('aria-label'), 'Open README.md');
});

test('no duplicate actions: one open-file icon however often the row is checked, and "Show file" is gone from artifacts-ui', async () => {
  const t = setup();
  const box = t.shell.make('div', 'messages');
  const line = await drawRow(t, writeRow('d1', ROOT + '/README.md'), box);
  await t.FU.toolFile(line, ROOT + '/README.md');
  assert.equal(line.querySelectorAll('.tool-file').length, 1);
  expand(line);
  await t.FU.toolFile(line, ROOT + '/README.md');
  assert.equal(line.querySelector('.tool-detail').querySelectorAll('a.fx-path').length, 1, 'the path is linked once');
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../outputs/agent-studio/artifacts-ui.js'), 'utf8');
  assert.ok(!/Show file|art-preview/.test(src), 'the old "Show file" button (same action as the icon) is removed');
});
