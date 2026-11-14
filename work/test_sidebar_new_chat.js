'use strict';
// The "+" after a project heading's count (a new chat in that project), the "+" on the Chats row, and the folder icon on
// the project switcher (one folder: the sidebar always shows one project, "All chats" is gone). Fake DOM, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const SCRIPTS = [
  'status-words.js',
  'ownership-ui.js',
  'notify-rules.js',
  'sidebar-ui.js',
  'workspace-state.js',
  'split-tree.js',
  'workspace-ui.js',
];
const conv = (id, cwd) => ({
  provider: 'claude',
  id,
  key: 'k-' + id,
  title: 'Title ' + id,
  cwd,
  created: 100,
  modified: 100,
});

function setup(list) {
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new'] });
  shell.make('b', 'wsListName', shell.byId.wsProjectBtn);
  const ctx = D.load(shell, SCRIPTS);
  const W = ctx.AgentWorkspaceUI;
  const state = { conversations: list, newChats: 0 };
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => state.conversations,
    rerender() {},
    getJson: async () => ({}),
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  // What chat.js's showNewChat does first: tell the workspace a new chat is starting (it then reads activeProject()).
  shell.byId.new.onclick = () => {
    state.newChats++;
    W.noteNewChat(null);
  };
  W.sync(list, null);
  return { shell, ctx, W, state };
}
const list = [conv('a1', 'C:/work/alpha'), conv('a2', 'C:/work/alpha'), conv('b1', 'C:/work/beta')];
const groups = (t) => t.ctx.AgentSidebarUI.projectGroups(list, () => t.shell.document.createElement('div'), {});
const byName = (nodes, name) => nodes.find((n) => n.querySelector('.project-name').textContent === name);

test('every project heading has a "+" after its count, named "New chat in <project>"', () => {
  const t = setup(list);
  const nodes = groups(t);
  assert.equal(nodes.length, 2);
  for (const name of ['alpha', 'beta']) {
    const row = byName(nodes, name).querySelector('.project-head-row');
    const add = row.querySelector('.project-add');
    assert.ok(add, name + ' has a +');
    assert.equal(add.tagName.toLowerCase(), 'button');
    assert.equal(add.getAttribute('aria-label'), 'New chat in ' + name);
    assert.equal(add.title, 'New chat in ' + name);
    const kids = row.children,
      head = row.querySelector('.project-head');
    assert.equal(
      kids.indexOf(add),
      kids.indexOf(head) + 1,
      'the + comes right after the heading (count is its last part)',
    );
    const parts = head.children.map((c) => c.className);
    assert.equal(parts[parts.length - 1], 'project-count');
    assert.ok(!head.contains(add), 'not nested inside the toggle button');
  }
});

test("clicking the + opens New chat with that project's folder, keeps the rail and does not toggle the project", () => {
  const t = setup(list);
  const nodes = groups(t);
  const beta = byName(nodes, 'beta');
  const head = beta.querySelector('.project-head'),
    body = beta.querySelector('.project-rows');
  assert.equal(head.getAttribute('aria-expanded'), 'true');
  beta.querySelector('.project-add').click();
  assert.equal(t.state.newChats, 1, 'the New chat view opened');
  const p = t.W.activeProject();
  assert.equal(p.name, 'beta');
  assert.equal(p.path, 'C:/work/beta', 'the folder is pre-filled from the project');
  assert.equal(t.W._state().active, t.W._items().find((i) => i.projectName === 'alpha').projectKey, 'the rail stays where it was');
  assert.equal(head.getAttribute('aria-expanded'), 'true', 'still open');
  assert.equal(body.hidden, false);
  // A later plain New chat is not pinned to beta by the +.
  t.W.selectProject(t.W._items().find((i) => i.projectName === 'alpha').projectKey);
  t.shell.byId.new.onclick();
  assert.equal(t.W.activeProject().name, 'alpha');
});

test('no All chats: a stored All moves to the first project, the switcher shows one folder, the list has no All row', () => {
  const t = setup(list);
  const btn = t.shell.byId.wsProjectBtn;
  t.W.selectProject('all');
  t.W.sync(list, null); // the page redraws after rerender()
  assert.notEqual(t.W._state().active, 'all', 'All chats is never kept');
  assert.equal(t.shell.byId.wsListName.textContent, 'alpha', 'the first project');
  let ico = btn.querySelectorAll('.ws-proj-ico');
  assert.equal(ico.length, 1, 'one icon, before the label');
  assert.ok(ico[0].classList.contains('one'));
  assert.equal(btn.children.indexOf(ico[0]), btn.children.indexOf(t.shell.byId.wsListName) - 1);
  assert.equal(btn.querySelectorAll('.ws-badge').length, 0, 'no count on the folder icon');
  const alpha = t.W._items().find((i) => i.projectName === 'alpha').projectKey;
  t.W.selectProject(alpha);
  t.W.sync(list, null);
  ico = btn.querySelectorAll('.ws-proj-ico');
  assert.equal(ico.length, 1, 'redrawing replaces the icon, never adds a second');
  assert.ok(ico[0].classList.contains('one'));
  assert.equal(ico[0].getAttribute('aria-hidden'), 'true');
  t.W.openProjectMenu();
  const rows = t.shell.body.querySelectorAll('.ws-prow-main');
  assert.equal(rows.length, 2, 'one row per project, no All chats row');
  assert.ok(!rows.some((r) => /All chats/.test(r.textContent)));
  for (const r of rows) assert.ok(r.querySelector('.ws-proj-ico').classList.contains('one'));
  assert.equal(rows[0].children[0].className.split(' ')[0], 'ws-proj-ico', 'the icon comes before the name');
  assert.equal(t.shell.body.querySelectorAll('.ws-prow-more').length, 2, 'every row has its ⋯');
  const foot = t.shell.body.querySelector('.ws-pfoot');
  assert.ok(foot, 'the dropdown has a footer');
  assert.equal(foot.querySelector('.ws-pfoot-text').textContent, 'Nothing needs you in any project');
  assert.equal(foot.querySelector('.ws-pfoot-inbox').textContent, 'Open inbox');
  foot.querySelector('.ws-pfoot-inbox').click();
  assert.equal(t.shell.body.querySelector('#wsInbox').hidden, false, 'Open inbox opens the inbox');
});

test('the dropdown footer counts the chats that need you in all projects', () => {
  const waiting = (c) => Object.assign(c, { yourTurn: true, yourTurnAt: 200 });
  const l2 = [waiting(conv('a1', 'C:/work/alpha')), conv('a2', 'C:/work/alpha'), waiting(conv('b1', 'C:/work/beta'))];
  const t = setup(l2);
  t.W.openProjectMenu();
  const text = t.shell.body.querySelector('.ws-pfoot-text').textContent;
  assert.match(text, /^\d+ chats? needs? you in all projects$/);
});

test('a chat in a git worktree folder AIB did not make is filed under its parent repo and marked with its branch', () => {
  const wt = conv('w1', 'C:/work/alpha/.claude/worktrees/feat');
  const l3 = [conv('a1', 'C:/work/alpha'), wt];
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'new'] });
  shell.make('b', 'wsListName', shell.byId.wsProjectBtn);
  const ctx = D.load(shell, SCRIPTS);
  const W = ctx.AgentWorkspaceUI;
  let asked = null;
  let rerenders = 0;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => l3,
    rerender() {
      rerenders++;
    },
    getJson: async (path, q) => {
      asked = { path, q };
      return { kinds: { 'C:/work/alpha/.claude/worktrees/feat': { worktree: true, scratch: false, worktreeOf: 'C:/work/alpha', branch: 'claude/feat' } } };
    },
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  W.sync(l3, null);
  const S = ctx.AgentSidebarUI;
  assert.notEqual(S.projectOf(wt).key, S.projectOf(l3[0]).key, 'before the server answers: its own folder');
  return new Promise((r) => setTimeout(r, 0)).then(() => {
    assert.equal(asked.path, '/api/live/folders/kinds');
    assert.equal(asked.q.parents, '1');
    assert.ok(rerenders > 0);
    assert.equal(S.projectOf(wt).key, S.projectOf(l3[0]).key, 'filed under the parent repo');
    assert.equal(S.branchOf(wt), 'claude/feat', 'marked with ⎇ and its branch');
    W.sync(l3, null);
    assert.equal(W._items().filter((i) => i.projectName === 'alpha').length, 2);
    assert.ok(!W._items().some((i) => i.projectWorktree), 'not hidden as a worktree folder any more');
  });
});
