'use strict';
// Smoke test for workspace-ui.js (project rail, tab strip, inbox) in a vm with a minimal fake DOM.
// workspace-state.js (the pure logic) has its own tests; this one checks that the drawing module loads, starts, draws and reacts.
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
const conv = (id, cwd, extra = {}) =>
  Object.assign(
    { provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 },
    extra,
  );
const liveChat = (extra = {}) => Object.assign({ id: 'L1', closed: false, busy: false, state: 'ready' }, extra);

function setup({ store = {}, conversations = [], selected = null } = {}) {
  const shell = D.page({
    store,
    ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'activityHead', 'composerHelp', 'new'],
  });
  const ctx = D.load(shell, SCRIPTS);
  const calls = { rerender: 0, post: [], get: [], opened: [] };
  const host = {
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => state.conversations,
    rerender: () => {
      calls.rerender++;
    },
    getJson: async (route) => {
      calls.get.push(route);
      return {};
    },
    postJson: async (name, body) => {
      calls.post.push([name, body]);
      return {};
    },
    open: (key) => {
      calls.opened.push(key);
      return true;
    },
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  };
  const state = { conversations };
  const W = ctx.AgentWorkspaceUI;
  W.init(host);
  const sync = (list = state.conversations, sel = selected) => {
    state.conversations = list;
    W.sync(list, sel);
  };
  return { shell, ctx, W, host, calls, sync, state };
}

const inbox = (shell) => shell.body.querySelector('#wsInbox');
const tabLabels = (shell) => shell.byId.chatTabs.querySelectorAll('.ws-tab').map((t) => t.textContent);

test('the module loads, exports its API and starts without any chats', () => {
  const t = setup();
  assert.equal(typeof t.W.init, 'function');
  assert.equal(typeof t.W.sync, 'function');
  assert.equal(t.W.hasWorkspace(), true, 'init ran');
  assert.equal(t.W.activeProject(), null, 'no project yet');
  t.sync([]);
  assert.deepEqual(t.W._items(), []);
  assert.ok(t.shell.byId.chatTabs.querySelector('.ws-tab-new'), 'the + button is always drawn');
  assert.ok(t.shell.byId.chatTabs.querySelector('.ws-inbox-btn'), 'the inbox envelope is always drawn');
});

test('chats are grouped into projects by their folder, and the selected chat opens as a tab in its project', () => {
  const list = [conv('a1', 'C:/work/alpha'), conv('a2', 'C:/work/alpha'), conv('b1', 'C:/work/beta')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  const items = t.W._items();
  assert.equal(items.length, 3);
  assert.deepEqual(Array.from(new Set(items.map((i) => i.projectName))).sort(), ['alpha', 'beta']);
  assert.ok(
    items.every((i) => i.projectKey.startsWith('w:c:/work/')),
    'project keys come from the folder path',
  );
  t.W.selectProject(items[0].projectKey);
  assert.equal(t.W.activeProject().key, items[0].projectKey);
  assert.ok(t.calls.opened.length <= 1, 'picking a project opens at most its last chat');
  assert.deepEqual(tabLabels(t.shell).length, 1, 'only the opened chat has a tab');
  assert.match(tabLabels(t.shell)[0], /Title a1/);
  t.sync(list, list[1]);
  assert.equal(tabLabels(t.shell).length, 2, 'opening a second chat of the project adds a tab');
});

test('project tabs, keys and colours follow projectRoot, not cwd', () => {
  const list = [
    conv('a1', 'C:/work/alpha/wt/one', { projectRoot: 'C:/work/alpha' }),
    conv('a2', 'C:/work/alpha/wt/two', { projectRoot: 'C:/work/alpha' }),
    conv('b1', 'C:/work/beta'),
  ];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  const items = t.W._items();
  const alpha = items.filter((i) => i.projectName === 'alpha');
  assert.equal(alpha.length, 2, 'both worktree chats are in the alpha project');
  assert.equal(new Set(alpha.map((i) => i.projectKey)).size, 1);
  assert.equal(alpha[0].projectKey, 'w:c:/work/alpha');
  assert.equal(alpha[0].projectPath, 'C:/work/alpha');
  assert.equal(items.find((i) => i.projectName === 'beta').projectKey, 'w:c:/work/beta', 'no projectRoot: cwd');
  const St = t.ctx.AgentWorkspaceState;
  assert.equal(St.autoColorId(alpha[0].projectKey), St.autoColorId('w:c:/work/alpha'), 'colour is keyed by the root');
  t.sync(list, list[1]);
  assert.equal(tabLabels(t.shell).length, 2, 'both worktree chats are tabs of the one project');
});

test('titles and paths are drawn as text, never as HTML', () => {
  const evil = conv('x1', 'C:/work/<img src=x onerror=1>', { title: '<script>alert(1)</script>' });
  const t = setup({ conversations: [evil] });
  assert.doesNotThrow(() => t.sync([evil], evil), 'a fake DOM that throws on innerHTML would catch any use');
  assert.match(tabLabels(t.shell).join(' '), /<script>alert\(1\)<\/script>/);
});

test('the layout is saved to localStorage, and a new page restores the open tabs', () => {
  const list = [conv('a1', 'C:/work/alpha'), conv('a2', 'C:/work/alpha')];
  const first = setup({ conversations: list });
  first.sync(list, list[0]);
  first.sync(list, list[1]);
  const saved = first.shell.localStorage.getItem('studio-workspace-v1');
  assert.ok(saved, 'workspace state is written');
  const second = setup({ store: { 'studio-workspace-v1': saved }, conversations: list });
  second.sync(list, null);
  assert.equal(tabLabels(second.shell).length, 2, 'both tabs come back without selecting anything');
});

test('a corrupt saved workspace is ignored, not fatal', () => {
  const list = [conv('a1', 'C:/work/alpha')];
  const t = setup({
    store: { 'studio-workspace-v1': '{nope', 'studio-pending-projects-v1': '[[[' },
    conversations: list,
  });
  assert.doesNotThrow(() => t.sync(list, list[0]));
  assert.equal(tabLabels(t.shell).length, 1);
});

test('closing a tab removes it from the strip', () => {
  const list = [conv('a1', 'C:/work/alpha'), conv('a2', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  t.sync(list, list[1]);
  const key = t.W._items()[0].key;
  t.W.closeTab(key);
  t.sync(list, list[1]);
  assert.equal(tabLabels(t.shell).length, 1);
});

test('a chat that needs you shows in the inbox, and the inbox opens and closes', () => {
  const asking = conv('a1', 'C:/work/alpha', {
    live: liveChat({ elicitations: [{ id: 'q', params: { message: 'Pick one' } }] }),
    attention: { state: 'needs_you', needs: 1, endedAt: 0 },
  });
  const list = [asking, conv('a2', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[1]);
  assert.equal(t.W._items().filter((i) => i.needs > 0).length, 1);
  assert.equal(inbox(t.shell).hidden, true);
  t.W.toggleInbox(true);
  assert.equal(inbox(t.shell).hidden, false);
  assert.match(inbox(t.shell).textContent, /Title a1/);
  t.W.toggleInbox(false);
  assert.equal(inbox(t.shell).hidden, true);
});

test('Escape closes the inbox', () => {
  const list = [conv('a1', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  t.W.toggleInbox(true);
  t.shell.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(inbox(t.shell).hidden, true);
});

test('syncing the same list twice does not redraw the strip', () => {
  const list = [conv('a1', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  const strip = t.shell.byId.chatTabs.children.slice();
  t.sync(list, list[0]);
  assert.deepEqual(t.shell.byId.chatTabs.children, strip, 'an unchanged signature leaves the DOM alone');
});

test('a shown chat the list no longer has keeps its tab: never "No open chats" over an open chat (QA 4)', () => {
  const fresh = conv('n1', 'C:/work/alpha', { title: 'New conversation', live: liveChat() });
  const t = setup({ conversations: [fresh] });
  t.sync([fresh], fresh);
  assert.equal(tabLabels(t.shell).length, 1);
  // Its session was ended; the agent does not list it (yet), but the page still shows it.
  const ended = Object.assign({}, fresh, { live: null });
  t.sync([], ended);
  assert.equal(tabLabels(t.shell).length, 1, 'the tab stays while the chat is shown');
  assert.match(tabLabels(t.shell)[0], /New conversation/);
  assert.doesNotMatch(t.shell.byId.chatTabs.textContent, /No open chats/);
  t.sync([], null); // another view: the phantom tab goes
  assert.equal(tabLabels(t.shell).length, 0);
});
