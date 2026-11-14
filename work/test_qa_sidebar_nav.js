'use strict';
// QA round 2 (sidebar and navigation): the tab strip, inbox and drawer fixes in workspace-ui.js, and the Ctrl+K focus fix in
// switcher-ui.js, in a vm with the minimal fake DOM.
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
  'inbox-reply.js',
  'workspace-ui.js',
];
const conv = (id, cwd, extra = {}) =>
  Object.assign({ provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 }, extra);
const liveChat = (extra = {}) => Object.assign({ id: 'L-' + Math.random(), closed: false, busy: false, state: 'ready' }, extra);
const asking = (id, cwd, modified) =>
  conv(id, cwd, {
    modified,
    live: liveChat({ elicitations: [{ id: 'q', params: { message: 'Pick one' } }], attention: { state: 'needs_you', needs: 1 } }),
  });

function setup({ conversations = [], entries = {} } = {}) {
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'activityHead', 'new'] });
  // The drawer (#wsAsideMain) with Find chat inside, as in chat.html.
  const aside = shell.make('aside', '', shell.body);
  const drawer = shell.make('div', 'wsAsideMain', aside);
  shell.make('button', 'findChat', drawer);
  const ctx = D.load(shell, SCRIPTS);
  // Archived / held flags come from organize-ui's entries.
  ctx.AgentOrganizeUI = { entryOf: (c) => entries[c.provider + ':' + c.id] || {} };
  const state = { conversations };
  const host = {
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
  };
  const W = ctx.AgentWorkspaceUI;
  W.init(host);
  const sync = (list, sel) => {
    state.conversations = list;
    W.sync(list, sel);
  };
  return { shell, ctx, W, sync, drawer };
}
const tabs = (t) => t.shell.byId.chatTabs.querySelectorAll('.ws-tab');

test('QA m4: an archived chat you open gets a tab marked Archived; it goes when you open another chat', () => {
  const list = [conv('a1', 'C:/w/alpha'), conv('a2', 'C:/w/alpha')];
  const t = setup({ conversations: list, entries: { 'claude:a2': { archivedAt: 5 } } });
  t.sync(list, list[0]);
  t.sync(list, list[1]);
  const shown = tabs(t);
  assert.equal(shown.length, 2);
  const arch = shown.find((n) => n.dataset.key === 'claude:a2');
  assert.ok(arch.className.includes('ws-tab-archived'));
  assert.ok(arch.className.includes(' on'), 'the archived chat is the active tab');
  assert.match(arch.textContent, /Archived/);
  t.sync(list, list[0]);
  assert.deepEqual(
    tabs(t).map((n) => n.dataset.key),
    ['claude:a1'],
  );
});

test('QA m14: the open chat stays in the inbox while it needs you; stable order; R only where a reply works', () => {
  const zeta = asking('a1', 'C:/w/zeta', 100),
    beta = asking('b1', 'C:/w/beta', 100),
    idle = conv('c1', 'C:/w/gamma');
  const t = setup({ conversations: [beta, idle] });
  t.sync([beta, idle], idle); // beta starts waiting first
  const until = Date.now() + 5;
  while (Date.now() < until);
  const list = [zeta, beta, idle];
  t.sync(list, zeta); // zeta starts waiting later, and it is the open chat
  const badge = t.shell.byId.chatTabs.querySelector('.ws-badge');
  assert.equal(badge && badge.textContent, '2', 'the badge counts the open chat too');
  t.W.toggleInbox(true);
  const pop = t.shell.body.querySelector('#wsInbox');
  const order = () => pop.querySelectorAll('.ws-inbox-item').map((n) => n.dataset.key);
  assert.deepEqual(order(), ['claude:a1', 'claude:b1'], 'newest wait first, the open chat included');
  const keys = pop.querySelector('.ws-inbox-keys').textContent;
  assert.doesNotMatch(keys, /R reply/, 'questions cannot be answered with R');
  // Polls and re-openings keep the order (a blocked chat's activity is "now" on every poll).
  t.W.toggleInbox(false);
  for (let i = 0; i < 3; i++) t.sync(list.slice(), i % 2 ? beta : idle);
  t.W.toggleInbox(true);
  assert.deepEqual(order(), ['claude:a1', 'claude:b1']);
});

test('QA m12: overflowing tabs get scroll arrows and a fade on the hidden side', () => {
  const list = [conv('a1', 'C:/w/alpha'), conv('a2', 'C:/w/alpha'), conv('a3', 'C:/w/alpha')];
  const t = setup({ conversations: list });
  for (const c of list) t.sync(list, c);
  const strip = t.shell.byId.chatTabs,
    list0 = strip.querySelector('.ws-tablist'),
    back = strip.querySelector('.ws-tab-scroll-l'),
    fwd = strip.querySelector('.ws-tab-scroll-r');
  assert.ok(back && fwd, 'both arrows exist');
  assert.equal(back.hidden && fwd.hidden, true, 'hidden while everything fits');
  list0.scrollWidth = 1000;
  list0.clientWidth = 300;
  list0.scrollLeft = 0;
  for (const f of t.shell.window.listeners.resize || []) f();
  assert.equal(fwd.hidden, false);
  assert.equal(back.disabled, true, 'at the start: nothing to the left');
  assert.equal(fwd.disabled, false);
  assert.ok(list0.classList.contains('fade-r') && !list0.classList.contains('fade-l'));
  fwd.onclick();
  assert.ok(list0.scrollLeft > 0);
  assert.equal(back.disabled, false);
  assert.ok(list0.classList.contains('fade-l'));
});

test('QA m8: the narrow drawer takes focus, makes the page behind it inert, and Esc gives focus back to the list button', () => {
  const list = [conv('a1', 'C:/w/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  const toggle = t.shell.byId.chatTabs.querySelector('.ws-list-toggle');
  toggle.focus();
  toggle.onclick();
  assert.ok(t.shell.body.classList.contains('ws-list-open'));
  assert.equal(t.shell.main.inert, true, 'Tab cannot reach the chat behind the scrim');
  assert.equal(t.shell.document.activeElement, t.shell.byId.findChat, 'focus moved into the drawer');
  t.shell.document.dispatch('keydown', { key: 'Escape' });
  assert.ok(!t.shell.body.classList.contains('ws-list-open'));
  assert.equal(t.shell.main.inert, false);
  const back = t.shell.byId.chatTabs.querySelector('.ws-list-toggle');
  assert.equal(t.shell.document.activeElement, back, 'focus is back on the list button');
});
