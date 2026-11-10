const { APP: APP_DIR } = require('./_paths');
// Inbox list building, project dropdown filtering, and tab math (pure functions from workspace-state.js).
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const W = require(path.join(APP_DIR, 'workspace-state.js'));

const item = (key, projectKey, extra = {}) =>
  Object.assign(
    {
      key,
      title: 't-' + key,
      projectKey,
      projectName: 'P-' + projectKey,
      projectPath: '/' + projectKey,
      provider: 'claude',
      state: 'idle',
      needs: 0,
      unread: false,
      activity: 100,
      pinned: false,
      held: false,
      archived: false,
      deleted: false,
      yourTurn: false,
      yourTurnAt: 0,
    },
    extra,
  );

// ---- inbox: one flat list --------------------------------------------------------------------------------
test('inbox is one flat list: needs-you and your-turn chats at the same level, newest first, one row per chat', () => {
  const items = [
    item('a1', 'a', { state: 'needs_you', needs: 1, activity: 500, ask: 'approve running build.cmd' }),
    item('a2', 'a', { state: 'idle', yourTurn: true, yourTurnAt: 800, snippet: 'Should I start a batch to fix them?' }),
    item('b1', 'b', { state: 'unread', unread: true, yourTurn: true, yourTurnAt: 600, snippet: '' }),
    item('b2', 'b', { state: 'needs_you', needs: 1, yourTurn: true, yourTurnAt: 100, activity: 700, auth: true }),
    item('c1', 'c', { state: 'idle', yourTurn: false }),
    item('c2', 'c', { state: 'idle', yourTurn: true, yourTurnAt: 900, archived: true }),
    item('c3', 'c', { state: 'working', yourTurn: false, activity: 999 }),
  ];
  const rows = W.inbox(items);
  assert.deepEqual(
    rows.map((r) => r.key),
    ['a2', 'b2', 'b1', 'a1'],
    'newest first; archived and working chats left out; a blocked your-turn chat is one row',
  );
  assert.deepEqual(
    rows.map((r) => r.kind),
    ['yourTurn', 'needs', 'yourTurn', 'needs'],
  );
  assert.equal(rows[0].line, 'Your turn: \u201CShould I start a batch to fix them?\u201D');
  assert.equal(rows[2].line, 'Your turn', 'no snippet, no quotes');
  assert.equal(rows[3].line, 'Needs you: approve running build.cmd');
  assert.equal(rows[1].line, 'Needs you: Sign-in');
  assert.deepEqual(
    rows.map((r) => r.handled),
    [true, true, true, false],
    'Mark handled only where it is your turn',
  );
  assert.equal(rows[0].projectName, 'P-a');
  assert.equal(W.counts(items).waiting, 4, 'the badge counts every row');
  assert.equal(W.counts(items).yourTurn, 2, 'your-turn chats that are not also blocked');
});

test('inbox ignores looking: only the yourTurn flag decides, unread alone is not enough', () => {
  const rows = W.inbox([
    item('u', 'a', { state: 'unread', unread: true }),
    item('v', 'a', { state: 'idle', unread: false, yourTurn: true, yourTurnAt: 5 }),
  ]);
  assert.deepEqual(
    rows.map((r) => r.key),
    ['v'],
  );
});

test('snippetOf keeps the first real line of the agent message, trimmed', () => {
  assert.equal(W.snippetOf('\n\n## Done\nMore text'), 'Done');
  assert.equal(W.snippetOf('> Should I start a batch?\r\nsecond'), 'Should I start a batch?');
  assert.equal(W.snippetOf(null), '');
  const long = W.snippetOf('x'.repeat(300));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith('\u2026'));
});

test('project counts include your-turn chats next to blocked ones', () => {
  const list = W.buildProjects([
    item('a1', 'a', { state: 'needs_you', needs: 1 }),
    item('a2', 'a', { state: 'idle', yourTurn: true }),
    item('a3', 'a', { state: 'idle' }),
    item('b1', 'b', { state: 'idle', yourTurn: true }),
  ]);
  assert.deepEqual(
    list.map((p) => [p.key, p.waiting, p.needs]),
    [
      ['a', 2, 1],
      ['b', 1, 0],
    ],
  );
});

test('the workspace signature changes when a chat becomes your turn', () => {
  const st = W.empty();
  assert.notEqual(W.signature([item('a1', 'a')], st, ''), W.signature([item('a1', 'a', { yourTurn: true })], st, ''));
});

// ---- the project dropdown hides worktrees and scratch folders ---------------------------------------------
test('worktree and scratch folders are recognised by their path', () => {
  for (const p of [
    'C:\\Users\\me\\AppData\\Roaming\\Claude\\scratch-workspaces\\x',
    'C:\\x\\scratch-2026-10-17-aab61c',
    '/home/me/Scratch-2026-11-07-e1b5a5',
  ])
    assert.equal(W.isScratchPath(p), true, p);
  for (const p of ['C:\\REPOS\\demo-project-real\\mod', '/home/me/scratchpad', '']) assert.equal(W.isScratchPath(p), false, p);
  for (const p of ['C:\\repo\\.claude\\worktrees\\agent-1', '/repo/.git/worktrees/x/sub'])
    assert.equal(W.isWorktreePath(p), true, p);
  for (const p of ['C:\\repo\\worktrees-notes', '/repo/.claude', '']) assert.equal(W.isWorktreePath(p), false, p);
});

test('the dropdown lists neither worktree nor scratch projects and keeps the saved order; their chats stay reachable', () => {
  const items = [
    item('a1', 'a', { state: 'needs_you', needs: 1 }),
    item('w1', 'w', { projectWorktree: true, state: 'idle', yourTurn: true, yourTurnAt: 9 }),
    item('s1', 's', { projectScratch: true }),
    item('b1', 'b'),
    item('c1', 'c'),
  ];
  const all = W.applyPrefs(W.buildProjects(items), { order: ['c', 'a'], projects: {} });
  assert.equal(all.find((p) => p.key === 'w').isWorktree, true);
  assert.equal(all.find((p) => p.key === 's').isScratch, true);
  assert.deepEqual(
    W.dropdownProjects(all).map((p) => p.key),
    ['c', 'a', 'b'],
    'saved order first, then the rest alphabetically',
  );
  assert.equal(W.totals(items).total, 5, '"All chats" still counts every chat');
  assert.equal(W.filterItems(items, W.ALL).length, 5);
  assert.deepEqual(
    W.filterItems(items, 'w').map((i) => i.key),
    ['w1'],
    'a hidden project is still reachable as a list filter',
  );
  assert.ok(
    W.inbox(items).some((r) => r.key === 'w1'),
    'its chats still reach the inbox',
  );
});

// ---- tabs ----------------------------------------------------------------------------------------------------------
test('opening a chat adds a tab next to the current one and never replaces it; nothing auto-closes', () => {
  let st = W.openTab(W.empty(), 'p', 'k1');
  st = W.openTab(st, 'p', 'k2', 'k1');
  st = W.openTab(st, 'p', 'k3', 'k1');
  assert.deepEqual(st.tabs.p, ['k1', 'k3', 'k2'], 'the new tab sits right of the current one');
  st = W.openTab(st, 'p', 'k2', 'k1');
  assert.deepEqual(st.tabs.p, ['k1', 'k3', 'k2'], 'opening an open chat just focuses it');
  let many = W.empty();
  for (let i = 0; i < 60; i++) many = W.openTab(many, 'p', 'x' + i, 'x' + (i - 1));
  assert.equal(many.tabs.p.length, 60, 'sixty tabs all stay');
  assert.ok(W.MAX_TABS >= 100);
});

test('reorder moves a tab into the gap it is dropped on and keeps the rest in order', () => {
  let st = W.empty();
  for (const k of ['a', 'b', 'c', 'd']) st = W.openTab(st, 'p', k);
  assert.deepEqual(W.reorderTabs(st, 'p', 'a', 3).tabs.p, ['b', 'c', 'a', 'd']);
  assert.deepEqual(W.reorderTabs(st, 'p', 'd', 0).tabs.p, ['d', 'a', 'b', 'c']);
  assert.deepEqual(W.reorderTabs(st, 'p', 'b', 4).tabs.p, ['a', 'c', 'd', 'b'], 'the far end');
  assert.equal(W.reorderTabs(st, 'p', 'b', 1), st, 'dropping on its own gap changes nothing');
  assert.equal(W.reorderTabs(st, 'p', 'b', 2), st);
  assert.equal(W.reorderTabs(st, 'p', 'zzz', 1), st, 'unknown tab');
  assert.deepEqual(st.tabs.p, ['a', 'b', 'c', 'd'], 'input is not changed');
  const saved = JSON.parse(JSON.stringify(W.reorderTabs(st, 'p', 'a', 3)));
  assert.deepEqual(W.sanitize(saved).tabs.p, ['b', 'c', 'a', 'd'], 'the order survives being saved and loaded');
  assert.equal(W.reorderTabs(st, 'p', 'a', 3).last.p, st.last.p, 'reordering does not change which tab is current');
});

test('scroll-into-view: the strip moves only as far as needed, with a little room', () => {
  const view = { left: 100, right: 500 };
  assert.equal(W.scrollToReveal({ left: 150, right: 250 }, view, 8), 100, 'already visible: stay');
  assert.equal(
    W.scrollToReveal({ left: 40, right: 140 }, view, 8),
    32,
    'hidden on the left: scroll back, plus padding',
  );
  assert.equal(
    W.scrollToReveal({ left: 450, right: 640 }, view, 8),
    248,
    'hidden on the right: scroll just far enough, plus padding',
  );
  assert.equal(W.scrollToReveal({ left: 2, right: 90 }, view, 8), 0, 'never negative');
  assert.equal(W.scrollToReveal({ left: 0, right: 80 }, { left: 0, right: 400 }, 8), 0);
});

test('the mouse wheel scrolls the strip sideways; a sideways trackpad swipe is left alone', () => {
  assert.equal(W.wheelScroll(0, 100), 100);
  assert.equal(W.wheelScroll(0, -60), -60);
  assert.equal(W.wheelScroll(80, 5), 0);
  assert.equal(W.wheelScroll(0, 0), 0);
});

test('in All chats the strip is labelled with the project it shows; in a project it is not', () => {
  assert.equal(W.stripLabel(W.empty(), 'mod'), 'mod');
  assert.equal(W.stripLabel(W.setActive(W.empty(), 'mod'), 'mod'), '');
  assert.equal(W.stripLabel(W.empty(), ''), '');
  // The strip follows the open chat's project; opening a chat from another project switches it.
  let st = W.openTab(W.empty(), 'a', 'a1');
  st = W.openTab(st, 'b', 'b1');
  assert.equal(W.stripProject(st, 'b', ''), 'b');
  assert.equal(W.stripProject(st, 'a', ''), 'a');
  assert.equal(W.stripProject(st, '', ''), 'b', 'nothing open: the project used last');
});

test('close shortcuts: Alt+W and Ctrl+W', () => {
  assert.deepEqual(W.shortcutFor({ key: 'w', altKey: true }), { action: 'close' });
  assert.deepEqual(W.shortcutFor({ key: 'W', ctrlKey: true }), { action: 'close' });
});

test('orderTabs puts the same tabs in a new order and ignores anything else (a split layout shrank to one pane)', () => {
  let st = W.empty();
  for (const k of ['a', 'b', 'c']) st = W.openTab(st, 'p', k);
  assert.deepEqual(W.orderTabs(st, 'p', ['c', 'a', 'b']).tabs.p, ['c', 'a', 'b']);
  assert.equal(W.orderTabs(st, 'p', ['a', 'b', 'c']), st, 'same order: nothing changes');
  assert.equal(W.orderTabs(st, 'p', ['c', 'a']), st, 'a different set of tabs is not a reorder');
  assert.equal(W.orderTabs(st, 'p', ['c', 'a', 'b', 'zzz']).tabs.p.length, 3, 'unknown keys are dropped');
  assert.equal(W.orderTabs(st, 'p', ['c', 'a', 'b']).last.p, st.last.p, 'which tab is current does not change');
});
