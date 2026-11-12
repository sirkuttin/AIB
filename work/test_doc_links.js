'use strict';
// Local docs, the ways in (doc-links.js + files-state.js + files-ui.js, with workspace-ui.js): one Files row per doc (its files
// hidden, a user's docs/README.md stays a file), "+ New doc", doc tabs and frames by the doc-tab contract, the open rule (Files and
// Ctrl+K: a tab; a chat: beside at 1280 px and wider), DOC tool rows with "open ↗" and the doc-created card, page chips resolved by
// page id at click, /doc with its page list, the Artifacts picker's doc rows, Ctrl+K's doc hits. Fake DOM, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');
const FS = require('../outputs/agent-studio/files-state.js');
const L = require('../outputs/agent-studio/doc-links.js');
const A = require('../outputs/agent-studio/artifacts-ui.js');
const R = require('../outputs/agent-studio/commands-registry.js');

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
  'doc-links.js',
];
const ROOT = 'C:/work/alpha';
const conv = (id, cwd, extra) =>
  Object.assign({ provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 }, extra || {});
const entry = (path, o) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return Object.assign({ name, path, dir: false, ignored: false, status: '', changed: 0, size: 10 }, o || {});
};
const PLAN_OWNED = ['aib-docs/release-plan/doc.aibdoc', 'aib-docs/release-plan/01-overview.md', 'aib-docs/release-plan/02-risks.md'];
const plan = () => ({
  name: 'release-plan',
  title: 'Release plan',
  dir: 'aib-docs/release-plan',
  owned: PLAN_OWNED.slice(),
  pages: 2,
  pageList: [
    { id: 'p1', title: 'Overview' },
    { id: 'p2', title: 'Risks' },
  ],
  chat: 'claude:a1',
  open: false,
  editedAt: 1000,
  editedBy: 'You',
  writing: [],
});
const LISTING = {
  '': [entry('aib-docs', { dir: true, changed: 1 }), entry('docs', { dir: true }), entry('src', { dir: true }), entry('README.md')],
  'aib-docs': [entry('aib-docs/README.md'), entry('aib-docs/release-plan', { dir: true, changed: 1 }), entry('aib-docs/stray.txt')],
  docs: [entry('docs/README.md'), entry('docs/notes', { dir: true })],
  'docs/notes': [entry('docs/notes/todo.txt')],
  src: [entry('src/app.js')],
};
const CHANGES = [
  { path: 'aib-docs/release-plan/02-risks.md', status: 'M', added: 3, removed: 1 },
  { path: 'aib-docs/release-plan/doc.aibdoc', status: 'M', added: 9, removed: 2 },
  { path: 'src/app.js', status: 'M', added: 1, removed: 0 },
];

function setup(o) {
  const opts = o || {};
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new', 'connections', 'promptForm'], width: opts.width || 1400, store: opts.store || {} });
  shell.make('b', 'wsListName', shell.byId.wsProjectBtn);
  const find = shell.make('button', 'findChat');
  shell.body.insertBefore(find, shell.byId.connections);
  find.append(shell.make('span'));
  const ctx = D.load(shell, SCRIPTS);
  ctx.location = { origin: 'http://127.0.0.1:9' };
  const calls = [],
    posts = [],
    notices = [];
  const docs = opts.docs || [plan()];
  ctx.AgentChangesUI = {
    hunkRows: () => [],
    _live: () => ({
      data: () => ({ git: true, prefix: '', files: opts.changes || CHANGES }),
      chatId: () => 'claude:a1',
      focusFile() {},
      reveal() {},
    }),
  };
  ctx.AgentArtifactsUI = { state: () => ({ list: [] }), open() {} };
  const list = opts.list || [conv('a1', ROOT), conv('a2', ROOT)];
  const getJson = async (path, q) => {
    calls.push({ path, q: Object.assign({}, q) });
    if (path === '/api/live/files/list') {
      const l = (opts.listing || LISTING)[q.dir];
      if (!l) throw Object.assign(new Error('Not found'), { status: 404 });
      return { root: ROOT, dir: q.dir, git: true, entries: l };
    }
    if (path === '/api/live/files/search') {
      const all = ['aib-docs/release-plan/02-risks.md', 'docs/README.md', 'src/app.js'];
      const matches = all.filter((p) => p.includes(q.q)).map((p) => ({ path: p, name: p.split('/').pop(), dir: p.slice(0, p.lastIndexOf('/')) }));
      return { root: ROOT, matches, total: matches.length };
    }
    if (path === '/api/live/docs/list') return { ok: true, docs: JSON.parse(JSON.stringify(docs)), others: opts.others || ['aib-docs/stray.txt'] };
    if (path === '/api/live/artifacts') return { artifacts: [] };
    return {};
  };
  const post = async (path, body) => {
    posts.push([path, JSON.parse(JSON.stringify(body))]);
    if (path === 'docs/open') {
      if (body.create !== undefined) {
        if (opts.taken && body.name === opts.taken) throw Object.assign(new Error('A doc of that name exists'), { code: 'doc_exists' });
        const name = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        const d = { name, title: body.name, dir: 'aib-docs/' + name, owned: ['aib-docs/' + name + '/doc.aibdoc'], pages: 1, pageList: [{ id: 'n1', title: 'Page 1' }], chat: body.id };
        docs.push(d);
        return { ok: true, doc: 'id-' + name, name, title: body.name, dir: d.dir, pages: [{ id: 'n1', title: 'Page 1', blocks: 1 }] };
      }
      const d = docs.find((x) => x.name === body.name);
      return { ok: true, doc: 'id-' + d.name, name: d.name, title: d.title, dir: d.dir, pages: d.pageList.map((p) => Object.assign({ blocks: 1 }, p)) };
    }
    if (path === 'docs/page') {
      const d = docs.find((x) => 'id-' + x.name === body.doc);
      const page = { id: 'new' + d.pageList.length, title: body.title };
      d.pageList.push(page);
      d.pages = d.pageList.length;
      return { ok: true, page: page.id, title: page.title, pages: d.pageList };
    }
    return { ok: true };
  };
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => list,
    rerender() {
      W.sync(list, list[0]);
    },
    getJson,
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  const DL = ctx.AgentDocLinks;
  DL.init({ getJson, post, notice: (m) => notices.push(m) });
  const FU = ctx.AgentFilesUI;
  FU.init({ aliasKey: (c) => c.provider + ':' + c.id, titleOf: (c) => c.title || c.id, getJson, post, conversations: () => list, open: async () => {} });
  W.sync(list, list[0]);
  FU.sync(list[0]);
  return { shell, ctx, W, FU, DL, calls, posts, notices, list, docs };
}
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const rows = (t) => t.shell.body.querySelectorAll('.fx-row').filter((r) => r.dataset.path);
const rowOf = (t, p) => rows(t).find((r) => r.dataset.path === p);
const frames = (t, where) => Array.from(t.FU._state().frames.values()).filter((r) => !where || r.where === where);
const query = (src) => Object.fromEntries(new URLSearchParams(String(src).split('?')[1] || ''));
// Files, with the aib-docs folder opened by a click like any folder
async function openDocsFolder(t) {
  t.FU.setMode('files');
  await flush();
  const row = rowOf(t, 'aib-docs');
  if (row.getAttribute('aria-expanded') !== 'true') row.click();
  await flush();
}
const docRowOf = (t, name) => rowOf(t, 'aib-docs/' + name);

// ---- pure ----------------------------------------------------------------------------------------------------------------------
test('/doc parses as <name>[ > page][: brief]; names and pages match loosely; Tab completes', () => {
  assert.deepEqual(L.parseDocCommand('/doc release notes'), { name: 'release notes', page: null, brief: '' });
  assert.deepEqual(L.parseDocCommand('/doc release plan > risks'), { name: 'release plan', page: 'risks', brief: '' });
  assert.deepEqual(L.parseDocCommand('/doc release plan > risks: add the iOS 17 fix date'), {
    name: 'release plan',
    page: 'risks',
    brief: 'add the iOS 17 fix date',
  });
  assert.deepEqual(L.parseDocCommand("/doc release notes: from this week's merged PRs"), {
    name: 'release notes',
    page: null,
    brief: "from this week's merged PRs",
  });
  assert.equal(L.parseDocCommand('/docs x'), null);
  assert.equal(L.isDocCommand('/doc'), true);
  assert.equal(L.isDocCommand('/diff'), false);
  const docs = [plan()];
  assert.equal(L.matchDoc(docs, 'release').name, 'release-plan');
  assert.equal(L.matchDoc(docs, 'release-plan').name, 'release-plan');
  assert.equal(L.matchDoc(docs, 'refund'), null);
  assert.equal(L.matchPage(plan().pageList, 'risk').title, 'Risks');
  assert.equal(L.matchPage(plan().pageList, 'launch notes'), null);
  // after ">" the list shows that doc's pages; an unknown name offers to make it
  const c = L.completions('/doc release plan > ri', docs);
  assert.equal(c.kind, 'page');
  assert.deepEqual(c.items.map((i) => i.title), ['Risks']);
  assert.equal(c.create, 'Ri');
  assert.equal(L.complete('/doc release plan > ri', c, c.items[0]), '/doc release plan > Risks');
  const all = L.completions('/doc release plan >', docs);
  assert.deepEqual(all.items.map((i) => i.title), ['Overview', 'Risks']);
  const names = L.completions('/doc rel', docs);
  assert.equal(names.kind, 'doc');
  assert.equal(L.complete('/doc rel', names, names.items[0]), '/doc Release plan ');
  assert.equal(L.completions('/doc release plan > risks: go', docs), null, 'no list once the brief starts');
});

test('chips resolve by page id: a renamed page still opens under its new name, a deleted one is "deleted page"', () => {
  assert.deepEqual(L.parseDocHref('aib-doc://release-plan/p2'), { name: 'release-plan', page: 'p2' });
  assert.deepEqual(L.parseDocHref('aib-doc://release-plan'), { name: 'release-plan', page: '' });
  assert.equal(L.parseDocHref('https://x/y'), null);
  const docs = [plan()];
  let r = L.resolveChip(docs, 'release-plan', 'p2');
  assert.equal(r.state, 'ok');
  assert.equal(L.chipLabel(r.doc, r.page), 'Release plan \u203a Risks');
  docs[0].pageList[1].title = 'Top risks';
  r = L.resolveChip(docs, 'release-plan', 'p2');
  assert.equal(L.chipLabel(r.doc, r.page), 'Release plan \u203a Top risks');
  docs[0].pageList.pop();
  assert.equal(L.resolveChip(docs, 'release-plan', 'p2').state, 'deleted');
  assert.equal(L.resolveChip(docs, 'gone', '').state, 'nodoc');
  assert.equal(L.resolveChip(docs, 'Release plan', '').state, 'ok', 'a title works as well as the folder name');
});

test('Ctrl+K hits: "risks" finds "Risks · page in Release plan"; a doc by its title; New doc is an action', () => {
  const hits = L.searchDocs([plan()], 'risks');
  assert.equal(hits[0].kind, 'page');
  assert.equal(hits[0].page.title, 'Risks');
  assert.equal(hits[0].doc.title, 'Release plan');
  assert.equal(L.searchDocs([plan()], 'release')[0].kind, 'doc');
  assert.deepEqual(L.searchDocs([plan()], 'r'), [], 'two letters at least');
  let ran = 0;
  const acts = R.buildActions({ chat: null, menu: new Set(), projects: [], do: { newDoc: () => ran++ } });
  const nd = acts.find((a) => a.id === 'new-doc');
  assert.equal(nd.title, 'New doc');
  nd.run();
  assert.equal(ran, 1);
  assert.ok(!R.buildActions({ chat: null, menu: new Set(), projects: [], do: {} }).some((a) => a.id === 'new-doc'));
});

test('doc tool rows read DOC: "Created Release plan · 2 pages", "Wrote Risks in Release plan", "Added page Metrics to Release plan"', () => {
  const docs = [plan()];
  const row = (name, input, result) => ({ role: 'tool', call: { id: 'c', name: 'mcp__studio_artifact__' + name, input, result: { text: JSON.stringify(result) } } });
  const create = L.toolCall(row('doc_create', { doc: 'release-plan' }, { doc: 'release-plan', created: true, pages: [{ id: 'p1', title: 'Overview' }, { id: 'p2', title: 'Risks' }] }));
  assert.equal(create.tool, 'doc_create');
  assert.equal(L.toolText(create, docs), 'Created Release plan \u00b7 2 pages');
  const edit = L.toolCall(row('doc_edit', { doc: 'release-plan', page: 'Risks', ops: [] }, { doc: 'release-plan', ok: true, page: 'p2', rev: 4 }));
  assert.equal(L.toolText(edit, docs), 'Wrote Risks in Release plan');
  assert.equal(L.toolPage(edit, docs), 'p2');
  const add = L.toolCall(row('doc_page', { doc: 'release-plan', action: 'add', title: 'Metrics' }, { doc: 'release-plan', page: 'p3', title: 'Metrics' }));
  assert.equal(L.toolText(add, docs), 'Added page Metrics to Release plan');
  const failed = L.toolCall({ role: 'tool', call: { id: 'x', name: 'mcp__studio_artifact__doc_edit', input: { doc: 'release-plan' }, result: { isError: true, text: 'no' } } });
  assert.equal(failed.status, 'failed');
  assert.equal(L.toolCall({ role: 'tool', call: { id: 'r', name: 'Read', input: { file_path: 'a' } } }), null);
  // live ACP rows carry the name in _meta and the answer in rawOutput
  const live = L.toolCall({
    role: 'tool',
    raw: { toolCallId: 't', status: 'completed', _meta: { claudeCode: { toolName: 'mcp__studio_artifact__doc_edit' } }, rawInput: { doc: 'release-plan', page: 'p1' }, rawOutput: { content: [{ type: 'text', text: '{"doc":"release-plan","page":"p1","ok":true}' }] } },
  });
  assert.equal(L.toolText(live, docs), 'Wrote Overview in Release plan');
});

test('files-state: aib-docs is a folder like any other; inside it one row per doc, its other files, then "+ New doc"', () => {
  const idx = FS.docIndex([plan()]);
  const cache = { '': LISTING[''], docs: LISTING.docs, 'aib-docs': LISTING['aib-docs'] };
  // closed: a plain folder row with a caret
  const shut = FS.treeRows(cache, new Set(['docs']), { docs: idx, changes: FS.changesMap(CHANGES, ''), newDoc: true });
  assert.deepEqual(
    shut.map((r) => [r.kind, r.path]),
    [
      ['dir', 'aib-docs'],
      ['dir', 'docs'],
      ['file', 'docs/README.md'],
      ['dir', 'docs/notes'],
      ['dir', 'src'],
      ['file', 'README.md'],
    ],
  );
  assert.equal(shut[0].canOpen, true, 'it expands like any folder');
  assert.equal(shut[0].changed, 2, 'the doc\'s changed files count on the folder');
  // open: the doc as ONE row (title, pages, badge), never its files; the other files; "+ New doc" last
  const opened = FS.treeRows(cache, new Set(['aib-docs']), { docs: idx, changes: FS.changesMap(CHANGES, ''), newDoc: true });
  assert.deepEqual(opened.slice(0, 5).map((r) => [r.kind, r.path, r.depth]), [
    ['dir', 'aib-docs', 0],
    ['file', 'aib-docs/README.md', 1],
    ['doc', 'aib-docs/release-plan', 1],
    ['file', 'aib-docs/stray.txt', 1],
    ['newdoc', FS.NEW_DOC, 1],
  ]);
  const d = opened[2];
  assert.deepEqual([d.name, d.pages, d.canOpen, d.badge.text], ['Release plan', 2, false, 'M']);
  assert.ok(!opened.some((r) => PLAN_OWNED.includes(r.path)), 'doc.aibdoc and the page copies are never rows');
  // without the docs feature (newDoc off) there is no "+ New doc"
  assert.ok(!FS.treeRows(cache, new Set(['aib-docs']), { docs: idx }).some((r) => r.kind === 'newdoc'));
  assert.deepEqual(FS.treeRows({ '': [entry('README.md')] }, new Set(), {}).map((r) => r.kind), ['file']);
  // no aib-docs on disk yet: an empty aib-docs folder in its place among the folders, holding only "+ New doc"
  const bare = { '': [entry('docs', { dir: true }), entry('src', { dir: true }), entry('README.md')] };
  const none = FS.treeRows(bare, new Set(), { docs: FS.docIndex([]), newDoc: true });
  assert.deepEqual(none.map((r) => [r.kind, r.path]), [
    ['dir', 'aib-docs'],
    ['dir', 'docs'],
    ['dir', 'src'],
    ['file', 'README.md'],
  ]);
  assert.equal(none[0].virtual, true);
  const noneOpen = FS.treeRows(bare, new Set(['aib-docs']), { docs: FS.docIndex([]), newDoc: true });
  assert.deepEqual(noneOpen.slice(0, 2).map((r) => [r.kind, r.path, r.depth]), [
    ['dir', 'aib-docs', 0],
    ['newdoc', FS.NEW_DOC, 1],
  ]);
  assert.ok(!FS.treeRows(bare, new Set(), {}).some((r) => r.path === 'aib-docs'), 'no docs feature: no folder');
  // a project with only files, or folders after "aib-docs" in order: the folder still sits first among the folders
  assert.deepEqual(FS.treeRows({ '': [entry('a.txt')] }, new Set(), { newDoc: true }).map((r) => r.path), ['aib-docs', 'a.txt']);
  assert.deepEqual(FS.treeRows({ '': [entry('.git', { dir: true }), entry('zeta', { dir: true })] }, new Set(), { newDoc: true }).map((r) => r.path), ['.git', 'aib-docs', 'zeta']);
  // the Changed list: the doc's files are one doc row
  const flat = FS.flatRows(['docs/README.md', 'aib-docs/release-plan/02-risks.md', 'aib-docs/release-plan/doc.aibdoc', 'src/app.js'], { docs: idx });
  assert.deepEqual(flat.map((r) => [r.kind, r.path]), [
    ['file', 'docs/README.md'],
    ['doc', 'aib-docs/release-plan'],
    ['file', 'src/app.js'],
  ]);
  // a new doc.aibdoc makes the badge A
  assert.equal(FS.docBadge(plan(), FS.changesMap([{ path: 'aib-docs/release-plan/doc.aibdoc', status: 'U', added: 4 }], '')).text, 'A');
});

test('doc tabs: one per doc; a single click is a preview the next one replaces; opening again keeps it', () => {
  const sc = { id: 'claude:a1', root: 'main' };
  let st = FS.openDocTab(FS.emptyTabs(), sc, { name: 'release-plan', title: 'Release plan' }, { keep: false });
  assert.equal(st.tabs.length, 1);
  assert.equal(st.tabs[0].kind, 'doc');
  assert.equal(st.tabs[0].preview, true);
  st = FS.openTab(st, sc, 'src/app.js', { keep: false });
  assert.equal(st.tabs.length, 1, 'the preview was replaced');
  st = FS.openDocTab(st, sc, { name: 'release-plan', title: 'Release plan', page: 'p2' }, { keep: true });
  st = FS.openDocTab(st, sc, { name: 'release-plan', title: 'Release plan', page: 'p1' }, { keep: true });
  assert.equal(st.tabs.filter((x) => x.kind === 'doc').length, 1, 'the same doc is one tab');
  assert.equal(st.tabs.find((x) => x.kind === 'doc').doc.page, 'p1');
});

test('the Artifacts picker: artifacts, then "Docs this chat wrote" under a divider; no other docs, never a doc history', () => {
  const list = [
    { id: 'a1', title: 'Checkout v2 timeline', kind: 'html', version: 2, conversationId: 'claude:a1', updatedAt: 10 },
    { id: 'h1', title: 'release-plan', kind: 'md', version: 6, conversationId: null, sourcePath: null, updatedAt: 20 },
  ];
  const docs = [plan(), Object.assign(plan(), { name: 'onboarding', title: 'Onboarding', pages: 3, chat: 'claude:zz' })];
  const g = A.pickerGroups(list, 'a1', 0, docs, ['claude:a1']);
  assert.deepEqual(g.map((x) => x.label), ['This chat', 'Docs this chat wrote']);
  assert.deepEqual(g[0].items.map((i) => [i.badge, i.title, i.meta.replace(/ · .*/, '')]), [['html', 'Checkout v2 timeline', 'v2']]);
  assert.deepEqual(g[1].items.map((i) => [i.doc, i.title, i.meta]), [[true, 'Release plan', '2 pages']]);
  assert.equal(g[1].note, 'Opens beside the chat, where you can edit it');
  assert.equal(g[1].divider, true);
  assert.ok(!g.some((x) => x.items.some((i) => i.title === 'Onboarding')), 'a doc another chat wrote is left out');
  assert.ok(!g.some((x) => x.items.some((i) => i.id === 'h1')), 'the doc history is left out');
  assert.equal(A.isDocHistory(list[1]), true);
  // no artifacts: the doc group alone, no divider
  const only = A.pickerGroups([], '', 0, docs, ['claude:a1']);
  assert.deepEqual(only.map((x) => [x.label, x.divider]), [['Docs this chat wrote', false]]);
  assert.deepEqual(A.pickerGroups([], '', 0, docs, ['claude:other']), []);
  assert.equal(A.pickerIsPlain([list[0]], [], ['claude:a1']), true);
  assert.equal(A.pickerIsPlain([list[0]], docs, ['claude:a1']), false, 'a doc this chat wrote makes it a dropdown');
  assert.equal(A.pickerIsPlain([list[0]], docs, ['claude:other']), true, 'docs of other chats do not');
});

// ---- the Files view ---------------------------------------------------------------------------------------------------------------
test('the sidebar switch is exactly Chats | Files: no Docs tab, no Docs pane', async () => {
  const t = setup();
  const sw = t.shell.body.querySelector('.sf-mode');
  assert.deepEqual(sw.querySelectorAll('button').map((b) => b.querySelector('span').textContent), ['Chats', 'Files']);
  assert.equal(sw.getAttribute('aria-label'), 'Show chats or files');
  assert.equal(t.shell.body.querySelector('.sf-mode-docs'), null);
  assert.equal(t.shell.body.querySelector('#docsPane'), null);
  assert.equal(t.shell.body.querySelector('.dt-row'), null);
  t.FU.setMode('docs'); // nothing asks for it any more; were it asked, Files shows
  assert.equal(t.FU.mode(), 'files');
  assert.equal(t.shell.body.classList.contains('sf-docs-mode'), false);
});

test('an old saved "docs" sidebar mode opens Files, never a blank sidebar; a per-project saved mode is ignored', async () => {
  const t = setup({ store: { 'aib-sidebar-mode': 'docs', ['aib-sidebar-mode|' + 'C:/work/alpha']: 'docs' } });
  await flush();
  assert.equal(t.FU.mode(), 'files');
  assert.ok(t.shell.body.classList.contains('sf-files-mode'));
  assert.equal(t.shell.body.querySelector('#filesPane').hidden, false);
  assert.ok(rows(t).length > 0, 'the Files tree shows');
  assert.equal(t.shell.body.querySelector('.sf-mode-files').getAttribute('aria-pressed'), 'true');
  t.FU.setMode('chats');
  assert.equal(t.shell.window.localStorage.getItem('aib-sidebar-mode'), 'chats');
  // anything else unknown: Chats
  const u = setup({ store: { 'aib-sidebar-mode': 'outputs' } });
  assert.equal(u.FU.mode(), 'chats');
  assert.equal(u.shell.body.classList.contains('sf-files-mode'), false);
  assert.equal(u.shell.body.querySelector('#filesPane').hidden, true);
  assert.equal(u.shell.body.querySelector('.sf-mode-chats').getAttribute('aria-pressed'), 'true');
});

test('Files: aib-docs expands to one row per doc (title, page count, badge, no caret) and "+ New doc" last; the project\'s docs/ stays plain files', async () => {
  const docs = [plan(), Object.assign(plan(), { name: 'onboarding', title: 'Onboarding', dir: 'aib-docs/onboarding', owned: ['aib-docs/onboarding/doc.aibdoc', 'aib-docs/onboarding/01-start.md'], pages: 1, chat: 'codex:z' })];
  // as the server sorts it: folders first, then files
  const listing = Object.assign({}, LISTING, {
    'aib-docs': [entry('aib-docs/onboarding', { dir: true }), entry('aib-docs/release-plan', { dir: true, changed: 1 }), entry('aib-docs/README.md'), entry('aib-docs/stray.txt')],
  });
  const t = setup({ docs, listing });
  t.FU.setMode('files');
  await flush();
  const folder = rowOf(t, 'aib-docs');
  assert.equal(folder.dataset.kind, 'dir');
  assert.equal(folder.querySelector('.fx-caret').textContent, '\u25b8', 'a closed folder caret');
  assert.ok(!rows(t).some((r) => r.dataset.path.startsWith('aib-docs/')), 'closed: nothing inside shows');
  folder.click();
  await flush();
  assert.equal(rowOf(t, 'aib-docs').getAttribute('aria-expanded'), 'true');
  const inside = rows(t).filter((r) => r.dataset.path.startsWith('aib-docs/'));
  assert.deepEqual(inside.map((r) => [r.dataset.kind, r.dataset.path]), [
    ['doc', 'aib-docs/onboarding'],
    ['doc', 'aib-docs/release-plan'],
    ['file', 'aib-docs/README.md'],
    ['file', 'aib-docs/stray.txt'],
    ['newdoc', 'aib-docs/+new-doc'],
  ]);
  const rp = docRowOf(t, 'release-plan');
  assert.equal(rp.querySelector('.fx-name').textContent, 'Release plan', 'the title, not the folder name');
  assert.equal(rp.querySelector('.fx-docpages').textContent, '2 pages');
  assert.equal(rp.querySelector('.fx-caret').textContent, '', 'no caret');
  assert.ok(rp.querySelector('.fx-docico'), 'the page icon');
  assert.equal(rp.querySelector('.fx-chg').textContent, 'M');
  assert.equal(docRowOf(t, 'onboarding').querySelector('.fx-docpages').textContent, '1 page');
  const nd = rowOf(t, 'aib-docs/+new-doc');
  assert.equal(nd.querySelector('.fx-name').textContent, 'New doc');
  assert.equal(nd.querySelector('.fx-newdoc-plus').textContent, '+');
  assert.ok(!rows(t).some((r) => PLAN_OWNED.includes(r.dataset.path) || r.dataset.path === 'aib-docs/onboarding/doc.aibdoc'), 'storage files are never rows');
  // a click on a doc row never expands it
  rp.click();
  await flush();
  assert.ok(!rows(t).some((r) => r.dataset.path.startsWith('aib-docs/release-plan/')));
  // collapses like any folder
  rowOf(t, 'aib-docs').click();
  await flush();
  assert.ok(!rows(t).some((r) => r.dataset.path.startsWith('aib-docs/')));
  // the project's docs/ is ordinary files
  rowOf(t, 'docs').click();
  await flush();
  assert.ok(rowOf(t, 'docs/README.md'), "the project's docs/README.md is a file");
  assert.equal(rowOf(t, 'docs/notes').dataset.kind, 'dir');
  // the filter never lists a doc's files, and finds the doc by its title
  const filter = t.shell.body.querySelector('.fx-search');
  filter.value = 'risks';
  filter.dispatch('input');
  t.shell.window.runTimers();
  await flush();
  assert.ok(!rows(t).some((r) => PLAN_OWNED.includes(r.dataset.path)));
  filter.value = 'release';
  filter.dispatch('input');
  t.shell.window.runTimers();
  await flush();
  assert.equal(rows(t)[0].dataset.kind, 'doc');
  const s = await t.FU.search('md');
  assert.deepEqual(s.matches.map((m) => m.path), ['docs/README.md']);
});

test('Files: a doc row opens a preview tab on one click and keeps it on a double-click; Enter keeps it', async () => {
  const t = setup();
  await openDocsFolder(t);
  docRowOf(t, 'release-plan').click();
  await flush();
  let tab = t.FU._state().tabs.tabs[0];
  assert.equal(tab.kind, 'doc');
  assert.equal(tab.preview, true);
  const [rec] = frames(t, 'main');
  const q = query(rec.frame.src);
  assert.ok(rec.frame.src.startsWith('/doc.html?'));
  assert.deepEqual([q.chat, q.name, q.preview, q.where], ['claude:a1', 'release-plan', '1', 'tab']);
  docRowOf(t, 'release-plan').dispatch('dblclick');
  await flush();
  tab = t.FU._state().tabs.tabs[0];
  assert.equal(tab.preview, false);
  assert.equal(frames(t, 'main').length, 1, 'the same frame: no reload');
  // a file click after it does not replace the kept doc
  rowOf(t, 'aib-docs/stray.txt').click();
  await flush();
  assert.ok(t.FU._state().tabs.tabs.some((x) => x.kind === 'doc' && !x.preview));
  // open in chat B: the frame names chat B for the project, and nothing links the doc to it
  t.W.sync(t.list, t.list[1]);
  t.FU.sync(t.list[1]);
  t.FU.openDoc({ id: 'claude:a2', root: 'main' }, { name: 'onboarding', title: 'Onboarding', where: 'tab' });
  await flush();
  const b = frames(t, 'main').find((r) => r.tab.doc.name === 'onboarding');
  assert.equal(query(b.frame.src).chat, 'claude:a2');
  assert.equal(t.posts.filter(([p]) => p === 'docs/link').length, 0, 'opening never links');
});

test('Files: a doc an agent is writing shows a live dot on its row (what it writes in the tooltip); the change badge stays', async () => {
  const docs = [Object.assign(plan(), { writing: [{ chat: 'claude:a1', name: 'Claude Code', page: 'Overview', section: 'Risks' }] })];
  const t = setup({ docs });
  await openDocsFolder(t);
  const row = docRowOf(t, 'release-plan');
  const dot = row.querySelector('.fx-docdot');
  assert.ok(dot, 'the pulsing dot');
  assert.equal(dot.getAttribute('aria-label'), 'Claude Code is writing Risks');
  assert.match(row.title, /Claude Code is writing Risks/);
  assert.equal(row.querySelector('.fx-chg').textContent, 'M');
  // nobody writing: no dot
  const q = setup();
  await openDocsFolder(q);
  assert.equal(docRowOf(q, 'release-plan').querySelector('.fx-docdot'), null);
});

test('Files with no doc yet: aib-docs shows as an empty folder holding only "+ New doc"; it is never listed from disk; the first doc makes it real', async () => {
  const listing = { '': [entry('docs', { dir: true }), entry('src', { dir: true }), entry('README.md')], docs: LISTING.docs, src: LISTING.src };
  const t = setup({ docs: [], listing });
  t.FU.setMode('files');
  await flush();
  const folder = rowOf(t, 'aib-docs');
  assert.ok(folder, 'the empty aib-docs folder row');
  assert.equal(folder.dataset.kind, 'dir');
  assert.deepEqual(rows(t).map((r) => r.dataset.path).slice(0, 3), ['aib-docs', 'docs', 'src']);
  folder.click();
  await flush();
  assert.ok(!t.calls.some((c) => c.path === '/api/live/files/list' && c.q.dir === 'aib-docs'), 'not on disk: never listed');
  assert.ok(!t.shell.body.querySelector('.fx-note-row'), 'no Loading or error row');
  assert.deepEqual(rows(t).filter((r) => r.dataset.path.startsWith('aib-docs/')).map((r) => r.dataset.kind), ['newdoc']);
  rowOf(t, 'aib-docs/+new-doc').click();
  await flush();
  const input = t.shell.body.querySelector('.fx-newdoc-in');
  assert.ok(input);
  // the first doc: aib-docs appears on disk
  listing[''] = [entry('aib-docs', { dir: true })].concat(listing['']);
  listing['aib-docs'] = [entry('aib-docs/README.md'), entry('aib-docs/launch-notes', { dir: true })];
  input.value = 'Launch notes';
  input.dispatch('input');
  input.dispatch('keydown', { key: 'Enter' });
  await flush();
  await flush();
  assert.equal(rowOf(t, 'aib-docs/launch-notes').dataset.kind, 'doc', 'the new doc is a row inside aib-docs');
  assert.equal(rows(t).filter((r) => r.dataset.path === 'aib-docs').length, 1, 'one aib-docs folder');
  assert.equal(rows(t).filter((r) => r.dataset.path.startsWith('aib-docs/')).pop().dataset.kind, 'newdoc', '"+ New doc" stays last');
});

test('Files: "+ New doc" turns into a name field reading "Untitled doc"; Enter makes the doc and opens it; a taken name says so', async () => {
  const t = setup({ taken: 'Release plan' });
  await openDocsFolder(t);
  rowOf(t, 'aib-docs/+new-doc').click();
  await flush();
  let input = t.shell.body.querySelector('.fx-newdoc-in');
  assert.ok(input);
  assert.equal(input.value, 'Untitled doc');
  input.value = 'Release plan';
  input.dispatch('input');
  input.dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.match(t.shell.body.querySelector('.fx-newdoc-err').textContent, /taken/);
  input = t.shell.body.querySelector('.fx-newdoc-in');
  input.value = 'Launch notes';
  input.dispatch('input');
  input.dispatch('keydown', { key: 'Enter' });
  await flush();
  const made = t.posts.filter(([p, b]) => p === 'docs/open' && b.create !== undefined).pop();
  assert.deepEqual(made[1], { id: 'claude:a1', name: 'Launch notes', create: '' });
  const tab = t.FU._state().tabs.tabs.find((x) => x.kind === 'doc');
  assert.equal(tab.doc.name, 'launch-notes');
  assert.equal(tab.preview, false);
  assert.equal(t.FU._state().newDoc, null);
  // right-click on a folder in Files offers New doc: aib-docs opens with the name field as its last row
  rowOf(t, 'aib-docs').click(); // close it
  await flush();
  assert.ok(!rowOf(t, 'aib-docs/+new-doc'));
  rowOf(t, 'docs').dispatch('contextmenu', { clientX: 10, clientY: 10 });
  const item = t.shell.body.querySelectorAll('.fx-menu-it').find((b) => b.textContent === 'New doc');
  assert.ok(item);
  item.click();
  await flush();
  assert.equal(t.FU.mode(), 'files');
  const field = t.shell.body.querySelector('.fx-newdoc-in');
  assert.ok(field);
  assert.equal(field.parentNode.dataset.path, 'aib-docs/+new-doc');
  // Ctrl+K's New doc (the same entry point) from Chats: Files shows with the field
  field.dispatch('keydown', { key: 'Escape' });
  t.FU.setMode('chats');
  await t.FU.startNewDoc();
  await flush();
  assert.equal(t.FU.mode(), 'files');
  assert.ok(t.shell.body.querySelector('.fx-newdoc-in'));
});

// ---- from a chat ------------------------------------------------------------------------------------------------------------------
const docRow = (name, input, result) => ({
  role: 'tool',
  uid: name + JSON.stringify(input),
  call: { id: 'c', name: 'mcp__studio_artifact__' + name, input, result: { text: JSON.stringify(result) } },
});
async function draw(t, row) {
  const TV = t.ctx.ToolViews;
  const line = TV.line(row, () => TV.renderCall(row.call));
  const out = t.DL.decorateToolRow(line, row);
  t.shell.byId.messages.append(out);
  await flush();
  return { line, out };
}

test('a DOC tool row names doc › page and its "open ↗" opens it beside the chat at 1280 px and wider, else as a tab', async () => {
  const t = setup();
  await t.DL.listFor('claude:a1', 'main');
  const { line } = await draw(t, docRow('doc_edit', { doc: 'release-plan', page: 'Risks', ops: [] }, { doc: 'release-plan', page: 'p2', ok: true }));
  assert.equal(line.querySelector('.tool-line-kind').textContent, 'doc');
  assert.equal(line.querySelector('.tool-line-text').textContent, 'Wrote Risks in Release plan');
  const open = line.querySelector('.doc-open');
  assert.equal(open.textContent, 'open \u2197');
  assert.equal(open.title, 'Open Release plan \u203a Risks');
  open.click();
  await flush();
  const [b] = frames(t, 'beside');
  assert.ok(b, 'beside the chat');
  assert.deepEqual([query(b.frame.src).page, query(b.frame.src).where], ['p2', 'beside']);
  assert.ok(t.shell.body.classList.contains('sf-beside-on'));
  // narrow window: a tab below
  const n = setup({ width: 1000 });
  await n.DL.listFor('claude:a1', 'main');
  n.ctx.innerWidth = 1000;
  const r2 = await draw(n, docRow('doc_edit', { doc: 'release-plan', page: 'p1' }, { doc: 'release-plan', page: 'p1', ok: true }));
  r2.line.querySelector('.doc-open').click();
  await flush();
  assert.equal(frames(n, 'beside').length, 0);
  assert.equal(query(frames(n, 'main')[0].frame.src).page, 'p1');
  assert.equal(frames(n, 'main')[0].tab.preview, false);
});

test('doc_create adds a doc-created card whose Open opens the doc; an already open doc is sent to the page instead of reloading', async () => {
  const t = setup();
  await t.DL.listFor('claude:a1', 'main');
  const { out, line } = await draw(t, docRow('doc_create', { doc: 'release-plan' }, { doc: 'release-plan', created: true, pages: [{ id: 'p1', title: 'Overview' }] }));
  assert.notEqual(out, line, 'wrapped with a card');
  const card = out.querySelector('.doc-card');
  assert.equal(card.querySelector('.art-card-title').textContent, 'Release plan');
  assert.equal(card.querySelector('.art-card-sub').textContent, 'Doc \u00b7 2 pages \u00b7 in Files under aib-docs, you and agents edit it');
  assert.equal(card.querySelector('.art-btn').textContent, 'Open doc');
  assert.ok(card.querySelector('.doc-card-ic'), 'the solid square doc icon');
  card.querySelector('.art-btn').click();
  await flush();
  const [rec] = frames(t, 'beside');
  const sent = [];
  rec.frame.contentWindow = { postMessage: (m, o) => sent.push([m, o]) };
  t.DL.openDoc({ name: 'release-plan', page: 'p2', chat: { id: 'claude:a1' }, from: 'chat' });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [[{ type: 'aib-doc:goto', page: 'p2', block: '', thread: '' }, 'http://127.0.0.1:9']]);
  assert.equal(frames(t, 'beside').length, 1);
});

test('page chips: named from the doc list, resolved by page id at click (renamed or deleted), live and after a reload', async () => {
  const t = setup();
  const chip = (page) => {
    const a = t.shell.make('a', '', t.shell.byId.messages);
    a.className = 'doc-chip';
    a.dataset.docName = 'release-plan';
    a.dataset.docPage = page;
    const label = t.shell.make('span', '', a);
    label.className = 'doc-chip-t';
    label.textContent = 'Release plan \u203a Risks';
    return a;
  };
  const a = chip('p2');
  t.DL.decorate(t.shell.byId.messages);
  await flush();
  assert.equal(a.querySelector('.doc-chip-t').textContent, 'Release plan \u203a Risks');
  // the page is renamed after the reply: the chip opens it by id, under its new name
  t.docs[0].pageList[1].title = 'Top risks';
  t.shell.document.dispatch('click', { target: a });
  await flush();
  assert.equal(a.querySelector('.doc-chip-t').textContent, 'Release plan \u203a Top risks');
  const [rec] = frames(t, 'beside');
  assert.equal(query(rec.frame.src).page, 'p2');
  // deleted: "deleted page", a note, nothing opens
  t.docs[0].pageList.pop();
  const b = chip('p2');
  t.shell.document.dispatch('click', { target: b });
  await flush();
  assert.equal(b.querySelector('.doc-chip-t').textContent, 'Release plan \u203a deleted page');
  assert.ok(b.classList.contains('gone'));
  assert.match(t.notices.pop(), /deleted/);
  // a reloaded transcript draws the same chips: decorate names them again
  const c = chip('p1');
  t.DL.decorate(t.shell.byId.messages);
  await flush();
  assert.equal(c.querySelector('.doc-chip-t').textContent, 'Release plan \u203a Overview');
});

test('/doc with a page: an existing page opens; an unknown page is made; a new doc is made and linked; the brief goes to the agent', async () => {
  const t = setup();
  const chat = { id: 'claude:a1', key: 'claude:a1' };
  let r = await t.DL.runCommand('/doc release plan > risk', chat);
  assert.equal(r.message, '');
  let rec = frames(t, 'beside')[0];
  assert.equal(query(rec.frame.src).page, 'p2');
  r = await t.DL.runCommand('/doc release plan > launch notes: list what ships', chat);
  const added = t.posts.find(([p]) => p === 'docs/page');
  assert.deepEqual(added[1], { doc: 'id-release-plan', action: 'add', title: 'Launch notes' });
  assert.equal(r.page.title, 'Launch notes');
  assert.match(r.message, /^In the doc "Release plan", page "Launch notes" \(doc name "release-plan"\): list what ships$/);
  assert.equal(t.posts.filter(([p, b]) => p === 'docs/open' && b.create !== undefined).length, 0, 'an existing doc is never re-made');
  r = await t.DL.runCommand('/doc release notes', chat);
  const made = t.posts.find(([p, b]) => p === 'docs/open' && b.create !== undefined);
  assert.deepEqual(made[1], { id: 'claude:a1', name: 'Release notes', create: '' });
  rec = frames(t, 'beside').find((x) => x.tab.doc.name === 'release-notes');
  assert.ok(rec, 'opened beside the chat');
  assert.deepEqual(JSON.parse(JSON.stringify(await t.DL.runCommand('/doc', chat))), { error: 'Name the doc: /doc release plan' });
});

test('doc frames: show-in-files selects the doc row in Files, open from beside moves it to a tab, duplicate and trash list the docs again', async () => {
  const t = setup();
  await openDocsFolder(t);
  t.FU.openDoc(t.FU.currentScope(), { name: 'release-plan', title: 'Release plan', where: 'beside' });
  await flush();
  const [rec] = frames(t, 'beside');
  assert.ok(rec, 'a doc beside the chat');
  rec.frame.contentWindow = { postMessage() {} };
  const send = (data) => t.FU.onFrameMessage({ origin: 'http://127.0.0.1:9', source: rec.frame.contentWindow, data });
  rowOf(t, 'aib-docs').click(); // closed
  t.FU.setMode('chats');
  await flush();
  send({ type: 'aib-doc:show-in-files', dir: 'aib-docs/release-plan' });
  await flush();
  t.shell.window.runTimers();
  assert.equal(t.FU.mode(), 'files', 'Files shows');
  assert.equal(t.FU._state().sel, 'aib-docs/release-plan');
  assert.ok(docRowOf(t, 'release-plan').classList.contains('sel'), 'aib-docs opened, the doc row selected');
  const before = t.calls.filter((c) => c.path === '/api/live/docs/list').length;
  send({ type: 'aib-doc:docs-changed' });
  await flush();
  assert.ok(t.calls.filter((c) => c.path === '/api/live/docs/list').length > before, 'duplicate: the docs are listed again');
  send({ type: 'aib-doc:open', name: 'release-plan', where: 'tab' });
  await flush();
  assert.equal(frames(t, 'beside').length, 0, '"Open as tab" leaves the beside column');
  assert.equal(t.FU._state().tabs.tabs.length, 1);
  assert.equal(t.FU._state().tabs.tabs[0].doc.name, 'release-plan');
  await flush();
  const [main] = frames(t, 'main');
  main.frame.contentWindow = { postMessage() {} };
  const mid = t.calls.filter((c) => c.path === '/api/live/docs/list').length;
  t.FU.onFrameMessage({ origin: 'http://127.0.0.1:9', source: main.frame.contentWindow, data: { type: 'aib-doc:closed' } });
  await flush();
  assert.equal(t.FU._state().tabs.tabs.length, 0, 'moved to the trash: the tab closes');
  assert.ok(t.calls.filter((c) => c.path === '/api/live/docs/list').length > mid, 'trash: the docs are listed again');
});

test('/doc in the composer: the doc list, then after ">" its pages; Tab completes; arrows move', async () => {
  const t = setup();
  const form = t.shell.byId.promptForm;
  const box = t.shell.byId.prompt;
  t.shell.byId.messages.after(form);
  box.value = '/doc release plan > ';
  t.DL.refreshPopup();
  await flush();
  let pop = t.shell.body.querySelector('#docPopup') || t.shell.body.querySelector('.doc-popup');
  assert.ok(pop && !pop.hidden);
  assert.deepEqual(pop.querySelectorAll('.doc-option').map((n) => n.querySelector('strong').textContent), ['Overview', 'Risks']);
  const key = (k) => {
    const e = { key: k, preventDefault() {}, isComposing: false, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
    return t.DL.handleKey(e);
  };
  assert.equal(key('ArrowDown'), true);
  assert.equal(key('Tab'), true);
  assert.equal(box.value, '/doc release plan > Risks');
  box.value = '/doc release plan > launch';
  t.DL.refreshPopup();
  await flush();
  pop = t.shell.body.querySelector('.doc-popup');
  assert.deepEqual(pop.querySelectorAll('.doc-option').map((n) => n.querySelector('strong').textContent), ['+ New page Launch']);
});

test('doc frames talk by the contract: pin keeps the preview, title names the tab, closed closes it, pick-chat answers', async () => {
  const t = setup();
  await openDocsFolder(t);
  docRowOf(t, 'release-plan').click();
  await flush();
  const [rec] = frames(t, 'main');
  const got = [];
  rec.frame.contentWindow = { postMessage: (m) => got.push(m) };
  const send = (data, origin) => t.FU.onFrameMessage({ origin: origin || 'http://127.0.0.1:9', source: rec.frame.contentWindow, data });
  send({ type: 'aib-doc:pin' }, 'http://evil.example');
  assert.equal(t.FU._state().tabs.tabs[0].preview, true, 'another origin is ignored');
  t.FU.onFrameMessage({ origin: 'http://127.0.0.1:9', source: {}, data: { type: 'aib-doc:pin' } });
  assert.equal(t.FU._state().tabs.tabs[0].preview, true, 'a window that is no doc frame is ignored');
  send({ type: 'aib-doc:pin' });
  assert.equal(t.FU._state().tabs.tabs[0].preview, false);
  send({ type: 'aib-doc:title', title: 'Release plan', page: 'p2', pageTitle: 'Risks' });
  await flush();
  assert.equal(t.shell.byId.chatTabs.querySelector('.sf-doctab').querySelector('.ws-tab-title').textContent, 'Release plan \u203a Risks');
  assert.equal(t.FU._state().tabs.tabs[0].doc.page, 'p2', 'reopening lands on the last page');
  t.DL.pickChat = async () => 'claude:a2';
  send({ type: 'aib-doc:pick-chat', requestId: 7, purpose: 'send' });
  await flush();
  assert.deepEqual(JSON.parse(JSON.stringify(got.pop())), { type: 'aib-doc:picked', requestId: 7, chat: 'claude:a2' });
  send({ type: 'aib-doc:closed' });
  await flush();
  assert.equal(t.FU._state().tabs.tabs.length, 0);
  assert.equal(frames(t).length, 0);
});

test('the "+ New doc" name field survives a repaint: still there, same words, focused', async () => {
  const t = setup({});
  await openDocsFolder(t);
  rowOf(t, 'aib-docs/+new-doc').click();
  await flush();
  const first = t.shell.body.querySelector('.fx-newdoc-in');
  assert.ok(first);
  first.focus();
  first.value = 'Launch notes';
  first.dispatch('input');
  t.FU.paint(); // a repaint builds a new field
  await flush();
  t.shell.window.runTimers(); // the focus goes to the new field on the next tick (nothing else repaints in between)
  const again = t.shell.body.querySelector('.fx-newdoc-in');
  assert.ok(again, 'the field is still there');
  assert.notEqual(again, first, 'a new node: the old one was replaced');
  assert.equal(again.value, 'Launch notes');
  assert.equal(t.shell.document.activeElement, again, 'and it has the focus');
  assert.ok(t.FU._state().newDoc, 'the editing state is kept');
  first.dispatch('blur'); // the replaced field's blur handler must not cancel the editing
  t.shell.window.runTimers();
  await flush();
  assert.ok(t.shell.body.querySelector('.fx-newdoc-in'), 'not cancelled');
  assert.ok(t.FU._state().newDoc);
});

test('a doc named by its slug shows its title everywhere, the slug only when there is no title', () => {
  const slugDoc = Object.assign(plan(), { name: 'checkout-rounding-release', title: 'Checkout rounding fix: release plan', dir: 'aib-docs/checkout-rounding-release' });
  const oldNotes = Object.assign(plan(), { name: 'old-notes', title: '', dir: 'aib-docs/old-notes', owned: [] });
  const cache = { '': [entry('aib-docs', { dir: true })], 'aib-docs': [entry('aib-docs/checkout-rounding-release', { dir: true }), entry('aib-docs/old-notes', { dir: true })] };
  const docRows = FS.treeRows(cache, new Set(['aib-docs']), { docs: FS.docIndex([slugDoc, oldNotes]) }).filter((r) => r.kind === 'doc');
  assert.deepEqual(docRows.map((r) => r.name), ['Checkout rounding fix: release plan', 'old-notes'], 'the Files row shows the title');
  assert.equal(FS.docIndex([slugDoc]).byDir.size, 1);
  // a doc tool row whose doc is not in the list yet: the title the tool result carries, not the capitalised slug
  const create = { tool: 'doc_create', doc: 'checkout-rounding-release', input: {}, result: { docTitle: 'Checkout rounding fix: release plan', pages: [{ id: 'p1', title: 'Overview' }] } };
  assert.equal(L.toolText(create, []), 'Created Checkout rounding fix: release plan · 1 page');
  assert.equal(L.toolText(Object.assign({}, create, { tool: 'doc_read' }), []), 'Read Checkout rounding fix: release plan');
  assert.equal(L.toolText(create, [slugDoc]), 'Created Checkout rounding fix: release plan · 1 page');
  assert.equal(L.toolText({ tool: 'doc_read', doc: 'old-notes', result: {} }, []), 'Read old-notes');
});
