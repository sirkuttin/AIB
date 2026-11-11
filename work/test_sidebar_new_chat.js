'use strict';
// The "+" after a project heading's count (a new chat in that project), the "+" on the Chats row, and the folder icon on
// the project switcher (stacked folders for "All chats", one folder for a project). Fake DOM, no browser.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const SCRIPTS = [
  'status-words.js',
  'ownership-ui.js',
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
  assert.equal(t.W._state().active, 'all', 'the rail stays on All chats');
  assert.equal(head.getAttribute('aria-expanded'), 'true', 'still open');
  assert.equal(body.hidden, false);
  // A later plain New chat is not pinned to beta by the +.
  t.W.selectProject(t.W._items().find((i) => i.projectName === 'alpha').projectKey);
  t.shell.byId.new.onclick();
  assert.equal(t.W.activeProject().name, 'alpha');
});

test('the project switcher shows stacked folders on All chats and one folder on a project, in the button and the list', () => {
  const t = setup(list);
  const btn = t.shell.byId.wsProjectBtn;
  t.W.selectProject('all');
  t.W.sync(list, null); // the page redraws after rerender()
  let ico = btn.querySelectorAll('.ws-proj-ico');
  assert.equal(ico.length, 1, 'one icon, before the label');
  assert.ok(ico[0].classList.contains('all'));
  assert.equal(btn.children.indexOf(ico[0]), btn.children.indexOf(t.shell.byId.wsListName) - 1);
  const alpha = t.W._items().find((i) => i.projectName === 'alpha').projectKey;
  t.W.selectProject(alpha);
  t.W.sync(list, null);
  ico = btn.querySelectorAll('.ws-proj-ico');
  assert.equal(ico.length, 1, 'redrawing replaces the icon, never adds a second');
  assert.ok(ico[0].classList.contains('one'));
  assert.equal(ico[0].getAttribute('aria-hidden'), 'true');
  t.W.openProjectMenu();
  const rows = t.shell.body.querySelectorAll('.ws-prow-main');
  assert.ok(rows.length >= 3);
  assert.ok(rows[0].querySelector('.ws-proj-ico').classList.contains('all'), 'All chats row: stacked folders');
  for (const r of rows.slice(1)) assert.ok(r.querySelector('.ws-proj-ico').classList.contains('one'));
  assert.equal(rows[0].children[0].className.split(' ')[0], 'ws-proj-ico', 'the icon comes before the name');
});
