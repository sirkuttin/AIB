'use strict';
// workspace-ui.js and the server's added-projects list (studio-added-projects.json): a project the user added shows in the
// project list even before it has a chat; a page's older New project entries (browser storage only) are sent to the server once;
// Delete project takes it off.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const SCRIPTS = ['status-words.js', 'ownership-ui.js', 'sidebar-ui.js', 'workspace-state.js', 'split-tree.js', 'workspace-ui.js'];
const plain = (x) => JSON.parse(JSON.stringify(x));
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

function setup({ store = {}, prefs = {} } = {}) {
  const shell = D.page({ store, ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'activityHead', 'composerHelp', 'new'] });
  const ctx = D.load(shell, SCRIPTS);
  const calls = { post: [] };
  const server = { prefs: Object.assign({ revision: 'r1', order: [], projects: {}, removed: {}, added: {} }, prefs) };
  const host = {
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => [],
    rerender() {},
    getJson: async (route) => (route === '/api/live/project-prefs' ? server.prefs : {}),
    postJson: async (name, body) => {
      calls.post.push([name, body]);
      if (name === 'project-add') {
        const added = Object.assign({}, server.prefs.added);
        for (const p of body.paths || [body.path]) added[ctx.AgentSidebarUI.pathKey(p)] = { path: p, at: 1 };
        server.prefs = Object.assign({}, server.prefs, { added, revision: 'r' + Math.random() });
      }
      return server.prefs;
    },
    open: () => true,
    showStart() {},
    notice() {},
  };
  const W = ctx.AgentWorkspaceUI;
  W.init(host);
  return { W, calls, server, ctx };
}

test('no added project: the page has no project; an added project with no chat yet is listed', async () => {
  const t = setup();
  t.W.sync([], null);
  await t.W.syncPrefs('');
  t.W.sync([], null);
  assert.equal(t.W.noProjects(), true);
  assert.deepEqual(plain(t.W.paletteProjects()), []);
  t.server.prefs = Object.assign({}, t.server.prefs, {
    revision: 'r2',
    added: { 'w:c:/work/alpha': { path: 'C:/work/alpha', at: 1 } },
  });
  await t.W.syncPrefs('r2');
  t.W.sync([], null);
  assert.equal(t.W.noProjects(), false);
  assert.deepEqual(
    plain(t.W.paletteProjects().map((p) => [p.key, p.name, p.path])),
    [['w:c:/work/alpha', 'alpha', 'C:/work/alpha']],
  );
});

test("projects made with the New project dialog before (only in this browser's storage) are sent to the server once", async () => {
  const store = {
    'studio-pending-projects-v1': JSON.stringify({ 'w:c:/work/beta': { path: 'C:/work/beta' } }),
  };
  const t = setup({ store });
  t.W.sync([], null);
  await t.W.syncPrefs('');
  await flush();
  const adds = t.calls.post.filter(([n]) => n === 'project-add');
  assert.deepEqual(plain(adds), [['project-add', { paths: ['C:/work/beta'] }]]);
  await t.W.syncPrefs('again');
  await flush();
  assert.equal(t.calls.post.filter(([n]) => n === 'project-add').length, 1, 'sent once');
  t.W.sync([], null);
  assert.deepEqual(
    plain(t.W.paletteProjects().map((p) => p.key)),
    ['w:c:/work/beta'],
  );
});
