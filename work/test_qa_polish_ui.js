'use strict';
// QA polish batch, page-level behaviour in a vm with the minimal fake DOM (the browser-level checks are work/deno/qa_polish_e2e_test.ts).
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const SCRIPTS = ['status-words.js', 'ownership-ui.js', 'notify-rules.js', 'sidebar-ui.js', 'workspace-state.js', 'split-tree.js', 'inbox-reply.js', 'workspace-ui.js'];
const conv = (id, cwd) => ({ provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 });

function workspace(list, selected) {
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'activityHead', 'new'] });
  const aside = shell.make('aside', '', shell.body);
  const drawer = shell.make('div', 'wsAsideMain', aside);
  shell.make('button', 'findChat', drawer);
  const ctx = D.load(shell, SCRIPTS);
  ctx.AgentOrganizeUI = { entryOf: () => ({}) };
  const state = { selected };
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => list,
    getSelected: () => state.selected,
    rerender() {},
    getJson: async () => ({}),
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  W.sync(list, selected);
  return { shell, W, state };
}

test('QA 6: starting the chat that is already open again does not close the narrow drawer; going to another chat does', () => {
  const list = [conv('a1', 'C:/w/alpha'), conv('a2', 'C:/w/alpha')];
  const t = workspace(list, list[0]);
  t.shell.byId.chatTabs.querySelector('.ws-list-toggle').onclick();
  assert.ok(t.shell.body.classList.contains('ws-list-open'));
  t.W.noteOpened(list[0]); // the same chat, started again (its live connection came up): not navigation
  assert.ok(t.shell.body.classList.contains('ws-list-open'), 'the drawer stays open');
  t.W.noteOpened(list[1]); // another chat: the drawer closes
  assert.ok(!t.shell.body.classList.contains('ws-list-open'));
});
