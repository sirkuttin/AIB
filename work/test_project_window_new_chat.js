'use strict';
// A project window starts new chats in its own project even while it shows a chat of another project
// (owner bug 2026-11-28: the Act window showed a braveTV chat; "new chat" took braveTV's folder from it).
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
const conv = (id, cwd) => ({ provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 });

test('new chat in a project window: its own project, whatever chat is shown', () => {
  const list = [conv('b1', 'C:/repos/braveTV'), conv('a1', 'C:/repos/Act')];
  const shell = D.page({ store: {}, ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'activityHead', 'composerHelp', 'new'] });
  const ctx = D.load(shell, SCRIPTS);
  const own = {
    pinned: () => true,
    pinnedProject: () => 'w:c:/repos/act',
    canRoute: () => false,
    known: () => false,
    mayShowHere: () => true,
    kind: () => 'project',
    me: () => 'w2',
  };
  ctx.AibWindow = new Proxy(own, { get: (t, k) => (k in t ? t[k] : () => []) });
  const W = ctx.AgentWorkspaceUI;
  W.init({
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => list,
    rerender() {},
    getJson: async () => ({}),
    postJson: async () => ({}),
    open: () => true,
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  });
  W.sync(list, list[0]); // the braveTV chat is on screen
  assert.equal(W.activeProjectRef().key, 'w:c:/repos/act');
  W.noteNewChat(list[0]);
  assert.equal(W.activeProjectRef().key, 'w:c:/repos/act');
  const p = W.activeProject();
  if (p) assert.equal(p.key, 'w:c:/repos/act', 'never the shown chat project');
  assert.equal(W.ownsChat(list[0]), false, 'a restore must not open a braveTV chat in this window');
  assert.equal(W.ownsChat(list[1]), true);
});
