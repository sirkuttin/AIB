'use strict';
/* AIB remembers where you were across restarts and new build folders (owner's bug, beta.8): the sidebar's project, its open tabs
   and last chat, live in the data folder (studio-view.json, through view-prefs.js), not only in the WebView2 profile next to
   AIB.exe that a build unzipped somewhere else starts without. These page tests load the real view-prefs.js and workspace-ui.js
   in the fake DOM, with an EMPTY localStorage (a new build folder) and the server's data block in the page. */
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const SCRIPTS = [
  'view-prefs.js',
  'status-words.js',
  'ownership-ui.js',
  'sidebar-ui.js',
  'workspace-state.js',
  'split-tree.js',
  'workspace-ui.js',
];
const conv = (id, cwd) => ({ provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 });
const LIST = [conv('a1', 'C:/work/alpha'), conv('b1', 'C:/work/beta'), conv('b2', 'C:/work/beta'), conv('c1', 'C:/work/gamma')];
const ALPHA = 'w:c:/work/alpha',
  BETA = 'w:c:/work/beta',
  GAMMA = 'w:c:/work/gamma';

/* localStorage as in a browser: methods on Storage.prototype, which view-prefs.js hooks. */
class FakeStorage {
  constructor(init) {
    this.m = new Map(Object.entries(init || {}));
  }
  get length() {
    return this.m.size;
  }
  key(i) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k) {
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    this.m.set(String(k), String(v));
  }
  removeItem(k) {
    this.m.delete(String(k));
  }
}

function start({ saved, local = {}, list = LIST, getJson = async () => ({}) }) {
  const shell = D.page({ ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'activityHead', 'composerHelp', 'new'] });
  const block = shell.make('script', 'aibViewPrefs', shell.body);
  block.textContent = JSON.stringify({ prefs: saved });
  const Storage = class extends FakeStorage {};
  const storage = new Storage(local);
  const posts = [];
  shell.localStorage = storage;
  shell.window.localStorage = storage;
  shell.window.Storage = Storage;
  shell.window.fetch = async (url, o) => {
    if (url === '/api/live/bootstrap') return { ok: true, status: 200, json: async () => ({ token: 't' }) };
    posts.push(JSON.parse(o.body).set);
    return { ok: true, status: 200, json: async () => ({ refused: [] }) };
  };
  const delays = [];
  const plain = shell.window.setTimeout;
  shell.window.setTimeout = (fn, ms) => (delays.push(ms || 0), plain(fn, ms));
  const ctx = D.load(shell, SCRIPTS);
  const opened = [];
  const host = {
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => list,
    rerender() {},
    getJson,
    postJson: async () => ({}),
    open: (c) => (opened.push(c), true),
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
    getSelected: () => null,
  };
  const W = ctx.AgentWorkspaceUI;
  W.init(host);
  W.sync(list, null);
  const flush = async () => {
    for (let i = 0; i < 5; i++) {
      shell.window.runTimers();
      await new Promise((r) => setImmediate(r));
    }
  };
  return { shell, ctx, W, storage, posts, opened, flush, delays };
}

test('a new build folder (empty localStorage): the last project, its tabs and its last chat come back from the data folder', async () => {
  const ws = { v: 1, active: BETA, tabs: { [BETA]: ['claude:b1', 'claude:b2'] }, last: { [BETA]: 'claude:b2' }, recent: BETA };
  const t = start({ saved: { 'studio-workspace-v1': JSON.stringify(ws) } });
  assert.equal(t.W._state().active, BETA, 'the project you had open, not the first one (Alpha)');
  assert.deepEqual([...t.W._state().tabs[BETA]], ['claude:b1', 'claude:b2'], 'its open tabs');
  const back = t.W.restoreTarget();
  assert.equal(back && back.id, 'b2', 'and the chat you were in is the one that opens');
  await t.flush();
  assert.deepEqual(t.posts, [], 'nothing to send back: the server already has it');
});

test('control: with nothing saved anywhere, a new folder starts on the first project (what the owner saw)', () => {
  const t = start({ saved: {} });
  assert.equal(t.W._state().active, ALPHA);
});

test('one-time move: the open state a copy from before this fix kept only in its WebView profile is pushed to the data folder', async () => {
  const ws = { v: 1, active: BETA, tabs: { [BETA]: ['claude:b1'] }, last: { [BETA]: 'claude:b1' }, recent: BETA };
  const t = start({
    saved: {},
    local: {
      'studio-workspace-v1': JSON.stringify(ws),
      'studio-seen-turns': '{"claude:b1":5}',
      'aib-file-tabs-v1': '{"w:c:/work/beta":{"tabs":[]}}',
    },
  });
  assert.equal(t.W._state().active, BETA);
  await t.flush();
  const sent = Object.assign({}, ...t.posts);
  assert.equal(JSON.parse(sent['studio-workspace-v1']).active, BETA);
  assert.equal(sent['studio-seen-turns'], '{"claude:b1":5}');
  assert.equal(sent['aib-file-tabs-v1'], '{"w:c:/work/beta":{"tabs":[]}}');
});

test('picking a project is sent to the data folder on the next tick, without waiting for the page to close (quit is immediate)', async () => {
  const t = start({ saved: { 'studio-workspace-v1': JSON.stringify({ v: 1, active: ALPHA, tabs: {}, last: {} }) } });
  await t.flush();
  t.posts.length = 0;
  t.delays.length = 0;
  t.W.selectProject(BETA);
  assert.deepEqual(t.delays, [0], 'the send is planned for the next tick, not after a debounce or at unload');
  await t.flush();
  const last = t.posts.filter((p) => p['studio-workspace-v1']).pop();
  assert.ok(last, 'sent: ' + JSON.stringify(t.posts));
  assert.equal(JSON.parse(last['studio-workspace-v1']).active, BETA);
});

test('a project picked with no open tabs is still the project after a restart, even though the chat that reopens is from another', () => {
  // You worked in Beta, then picked Gamma (no tabs there yet: Beta's chat stays in the middle) and quit.
  const ws = { v: 1, active: GAMMA, tabs: { [BETA]: ['claude:b1'] }, last: { [BETA]: 'claude:b1' }, recent: BETA };
  const t = start({ saved: { 'studio-workspace-v1': JSON.stringify(ws) } });
  assert.equal(t.W._state().active, GAMMA);
  const back = t.W.restoreTarget();
  assert.equal(back && back.id, 'b1', 'the chat that was in the middle reopens');
  t.W.keepProjectFor(back); // what chat.js does before opening it at start
  t.W.noteOpened(back);
  assert.equal(t.W._state().active, GAMMA, 'the sidebar stays on Gamma (it used to jump to Beta)');
  // any later open moves the sidebar to the chat's project, as before
  t.W.noteOpened(LIST[0]);
  assert.equal(t.W._state().active, ALPHA);
});

/* beta.8-test6 (owner's data, trimmed and anonymised): the saved project is "Main" (C:/work/main); its only open chat runs in an
   AIB worktree made from a Claude worktree of Main (C:/work/main/.claude/worktrees/wt-one), so the server files it under that
   Claude worktree and only the folder-kinds answer (worktreeOf) files it under Main. The Claude worktree is not listed in the
   dropdown, so at the first list Main looked gone: the sidebar moved to the first project ("artifact-test", a scratch folder whose
   only chat then opened). The same chat was also still listed under the Claude worktree's key from an earlier start. */
const MAIN = 'w:c:/work/main',
  CLAUDE_WT = 'w:c:/work/main/.claude/worktrees/wt-one',
  ART = 'w:c:/temp/scratchpad/artifact-test',
  ZETA = 'w:c:/work/zeta';
const OWNER_LIST = [
  {
    provider: 'claude',
    id: 's-main',
    title: 'Main work',
    cwd: 'C:/data/worktrees/0a1b2c/chat-0a1b2c3d',
    projectRoot: 'C:/work/main/.claude/worktrees/wt-one',
    created: 100,
    modified: 300,
  },
  { provider: 'claude', id: 's-art', title: 'Artifact test', cwd: 'C:/temp/scratchpad/artifact-test', created: 100, modified: 200 },
  { provider: 'claude', id: 's-zeta', title: 'Zeta', cwd: 'C:/work/zeta', created: 100, modified: 100 },
];
const OWNER_WS = {
  v: 1,
  active: MAIN,
  tabs: { [MAIN]: ['claude:s-main'], [ZETA]: ['claude:s-zeta'], [CLAUDE_WT]: ['claude:s-main'], [ART]: ['claude:s-art'] },
  last: { [ZETA]: 'claude:s-zeta', [CLAUDE_WT]: 'claude:s-main', [ART]: 'claude:s-art', [MAIN]: 'claude:s-main' },
  recent: MAIN,
};
function ownerStart() {
  let answer;
  const kindsAsked = new Promise((r) => (answer = r));
  const t = start({
    saved: { 'studio-workspace-v1': JSON.stringify(OWNER_WS) },
    list: OWNER_LIST,
    getJson: (url) => (url === '/api/live/folders/kinds' ? kindsAsked : Promise.resolve({})),
  });
  const kindsAnswer = () =>
    answer({ kinds: { 'C:/work/main/.claude/worktrees/wt-one': { worktree: true, worktreeOf: 'C:/work/main', branch: 'wt-one' } } });
  return { ...t, kindsAnswer };
}

test('test6 state: the saved project stays while the folder kinds are on their way, and its chat is the one that reopens', async () => {
  const t = ownerStart();
  assert.equal(t.W._state().active, MAIN, 'the saved project, not the first in the dropdown (artifact-test)');
  const done = t.W.settled(1500);
  t.kindsAnswer();
  await new Promise((r) => setImmediate(r)); // the answer arrives before the 1.5 s cap
  await t.flush();
  assert.equal(await done, true, 'settled once the kinds answered');
  for (let i = 0; i < 3; i++) {
    t.W.sync(OWNER_LIST, null); // what host.rerender does in the page after each answer
    await t.flush();
  }
  assert.equal(t.W._state().active, MAIN);
  assert.equal(t.W._items().find((i) => i.key === 'claude:s-main').projectKey, MAIN, 'its chat is filed under Main');
  const back = t.W.restoreTarget();
  assert.equal(back && back.id, 's-main', "last session's chat, not artifact-test's");
  t.W.keepProjectFor(back);
  t.W.noteOpened(back);
  assert.equal(t.W._state().active, MAIN);
  assert.deepEqual([...t.W._state().tabs[MAIN]], ['claude:s-main']);
  assert.equal(t.W._state().tabs[CLAUDE_WT], undefined, "the chat's older key under the Claude worktree is dropped");
  assert.equal(t.W._state().last[CLAUDE_WT], undefined);
  assert.deepEqual([...t.W._state().tabs[ART]], ['claude:s-art'], "other projects' tabs stay");
  await t.flush();
  const sent = t.posts.filter((p) => p['studio-workspace-v1']).pop();
  const saved = JSON.parse(sent['studio-workspace-v1']);
  assert.equal(saved.active, MAIN, 'and that is what the data folder keeps');
  assert.equal(saved.tabs[CLAUDE_WT], undefined, 'without the stale duplicate');
});

test('test6 state: a chat opened before the kinds answer keeps the saved project and its stray tab goes once they do', async () => {
  const t = ownerStart();
  const back = t.W.restoreTarget();
  assert.equal(back && back.id, 's-main');
  t.W.keepProjectFor(back);
  t.W.noteOpened(back); // filed under the Claude worktree for now
  assert.equal(t.W._state().active, MAIN, 'the sidebar stays on Main');
  t.W.sync(OWNER_LIST, null);
  assert.equal(t.W._state().active, MAIN, 'and a list update while the kinds are pending does not move it either');
  t.kindsAnswer();
  // each answer can ask about the folder it names (Main); the page draws the list again after every answer (host.rerender)
  for (let i = 0; i < 3; i++) {
    await t.flush();
    t.W.sync(OWNER_LIST, null);
  }
  assert.equal(t.W._state().active, MAIN);
  assert.equal(t.W._state().tabs[CLAUDE_WT], undefined, 'the stray tab under the Claude worktree is gone');
  assert.equal(t.W._state().recent, MAIN, 'and the project used last is Main, not the Claude worktree');
});

test('control: a saved project that is really gone still moves to one that exists once the kinds answered', async () => {
  const ws = { ...OWNER_WS, active: 'w:c:/work/gone', tabs: { ...OWNER_WS.tabs, 'w:c:/work/gone': ['claude:s-gone'] } };
  const t = start({ saved: { 'studio-workspace-v1': JSON.stringify(ws) }, list: OWNER_LIST });
  await t.flush();
  t.W.sync(OWNER_LIST, null);
  assert.notEqual(t.W._state().active, 'w:c:/work/gone');
});
