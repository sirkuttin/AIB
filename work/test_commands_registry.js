const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const C = require(path.join(APP_DIR, 'commands-registry.js'));

const chatItem = (title, extra = {}) =>
  Object.assign(
    {
      title,
      original: title,
      project: 'Alpha',
      path: 'C:\\Repos\\Alpha',
      provider: 'Claude Code',
      archived: false,
      activity: 100,
    },
    extra,
  );
const ids = (list) => list.map((a) => a.id);
const baseCtx = (over = {}) =>
  Object.assign(
    {
      chat: { id: 'x' },
      menu: new Set(['rename', 'pin', 'hold', 'archive', 'delete', 'end', 'thinking', 'handoff']),
      thinking: false,
      projects: [
        { key: 'a', name: 'Alpha', path: 'C:\\Repos\\Alpha', active: true },
        { key: 'b', name: 'Beta', path: 'C:\\Repos\\Beta', active: false },
      ],
      keys: {},
      do: {
        chat() {},
        newChat() {},
        newProject() {},
        switchProject() {},
        openInbox() {},
        toggleSide() {},
        toggleActivity() {},
        showSheet() {},
      },
    },
    over,
  );

test('score: substrings beat scattered letters, non-subsequences fail', () => {
  assert.ok(C.score('arch', 'Archive this chat') > C.score('arch', 'a r c h'));
  assert.equal(C.score('zzz', 'Archive'), -1);
  assert.ok(C.score('nct', 'New chat') > 0);
});

test('parseQuery: leading > forces actions; modes cycle both ways', () => {
  assert.deepEqual(C.parseQuery('> hold', 'chats'), { mode: 'actions', query: 'hold', prefixed: true });
  assert.deepEqual(C.parseQuery('>', 'all'), { mode: 'actions', query: '', prefixed: true });
  assert.deepEqual(C.parseQuery('  hold', 'projects'), { mode: 'projects', query: 'hold', prefixed: false });
  assert.equal(C.parseQuery('x', 'bogus').mode, 'all');
  assert.equal(C.nextMode('all', 1), 'actions');
  assert.equal(C.nextMode('projects', 1), 'all');
  assert.equal(C.nextMode('all', -1), 'projects');
});

test('when() gates actions on the current chat and on missing functions', () => {
  const full = ids(C.buildActions(baseCtx()));
  for (const id of [
    'chat:rename',
    'chat:pin',
    'chat:hold',
    'chat:archive',
    'chat:delete',
    'chat:end',
    'chat:thinking',
    'chat:handoff',
    'new-project',
    'switch-project',
    'open-inbox',
    'toggle-side',
    'toggle-activity',
    'shortcuts',
    'new-in:a',
    'new-in:b',
  ])
    assert.ok(full.includes(id), id);
  assert.ok(!full.includes('chat:handled'), 'Mark handled only when it is your turn');
  assert.ok(!full.includes('chat:unpin'));
  const noChat = ids(C.buildActions(baseCtx({ chat: null, menu: new Set() })));
  assert.ok(!noChat.some((i) => i.startsWith('chat:')), 'no chat actions without a chat');
  assert.ok(noChat.includes('new-project'));
  const d = baseCtx().do;
  delete d.toggleSide;
  delete d.toggleActivity;
  delete d.openInbox;
  delete d.newChat;
  const lean = ids(C.buildActions(baseCtx({ do: d })));
  assert.ok(
    !lean.includes('toggle-side') && !lean.includes('toggle-activity') && !lean.includes('open-inbox'),
    'missing modules hide their actions',
  );
  assert.ok(!lean.some((i) => i.startsWith('new-in:')));
  const handled = ids(C.buildActions(baseCtx({ menu: new Set(['rename', 'handled', 'unpin', 'unarchive']) })));
  assert.ok(handled.includes('chat:handled') && handled.includes('chat:unpin') && handled.includes('chat:unarchive'));
});

test('a throwing when() hides the action instead of breaking the bar', () => {
  const bad = baseCtx();
  bad.menu = null;
  assert.doesNotThrow(() => C.buildActions(bad));
});

test('titles and shortcuts follow state', () => {
  const on = C.buildActions(baseCtx({ thinking: true })).find((a) => a.id === 'chat:thinking');
  assert.equal(on.title, 'Hide thinking');
  assert.equal(C.buildActions(baseCtx()).find((a) => a.id === 'chat:thinking').title, 'Show thinking');
  const a = C.buildActions(baseCtx({ keys: { inbox: 'Alt+I' } }));
  assert.equal(a.find((x) => x.id === 'open-inbox').shortcut, 'Alt+I');
  assert.equal(C.buildActions(baseCtx()).find((x) => x.id === 'open-inbox').shortcut, '');
  assert.equal(a.find((x) => x.id === 'new-in:a').shortcut, 'Ctrl+Shift+N');
  assert.equal(a.find((x) => x.id === 'new-in:b').shortcut, '');
  assert.equal(a.find((x) => x.id === 'toggle-side').shortcut, 'Ctrl+B');
  assert.equal(a.find((x) => x.id === 'toggle-activity').shortcut, 'Ctrl+Alt+B');
  assert.equal(a.find((x) => x.id === 'chat:rename').shortcut, 'F2');
});

test('run calls the context function it is wired to', () => {
  const calls = [];
  const ctx = baseCtx({
    do: {
      chat: (id) => calls.push('chat:' + id),
      newChat: (p) => calls.push('new:' + p.key),
      toggleSide: () => calls.push('side'),
      showSheet: () => calls.push('sheet'),
    },
  });
  const all = C.buildActions(ctx);
  for (const id of ['chat:hold', 'new-in:b', 'toggle-side', 'shortcuts']) all.find((a) => a.id === id).run();
  assert.deepEqual(calls, ['chat:hold', 'new:b', 'side', 'sheet']);
});

test('danger actions are flagged: Delete and End Studio session only', () => {
  const danger = C.buildActions(baseCtx())
    .filter((a) => a.danger)
    .map((a) => a.id)
    .sort();
  assert.deepEqual(danger, ['chat:delete', 'chat:end']);
});

test('confirmStep: first Enter arms with a prompt, second runs; other actions run at once', () => {
  const acts = C.buildActions(baseCtx());
  const del = acts.find((a) => a.id === 'chat:delete'),
    pin = acts.find((a) => a.id === 'chat:pin');
  const first = C.confirmStep(null, del);
  assert.deepEqual(first, { run: false, armed: 'chat:delete', prompt: 'Press Enter again to delete' });
  assert.equal(C.confirmStep(first.armed, del).run, true);
  assert.equal(C.confirmStep('chat:end', del).run, false, 'arming another action does not carry over');
  assert.equal(C.confirmStep(null, pin).run, true);
  assert.equal(
    C.confirmStep(
      null,
      acts.find((a) => a.id === 'chat:end'),
    ).prompt,
    'Press Enter again to end the Studio session',
  );
});

const sources = () => ({
  chats: [
    chatItem('Refactor the parser', { activity: 50 }),
    chatItem('Archive notes', { activity: 90 }),
    chatItem('Old thing', { archived: true, activity: 999 }),
  ],
  projects: [
    { key: 'a', name: 'Alpha', path: 'C:\\Repos\\Alpha' },
    { key: 'b', name: 'Parser tools', path: 'C:\\Repos\\Beta' },
  ],
  actions: C.buildActions(baseCtx()),
});
const kinds = (r) => r.map((x) => x.kind + ':' + (x.id || x.key || x.title || x.name));

test('empty query: recent chats first (archived last), then the common actions', () => {
  const r = C.compose(sources(), '', 'all');
  const k = r.map((x) => x.kind);
  const firstAction = k.indexOf('action');
  assert.deepEqual(k.slice(0, firstAction), ['chat', 'chat', 'chat']);
  assert.ok(k.slice(firstAction).every((x) => x === 'action'));
  assert.deepEqual(
    r.slice(0, 3).map((x) => x.title),
    ['Archive notes', 'Refactor the parser', 'Old thing'],
  );
  assert.ok(
    r.filter((x) => x.kind === 'action').every((a) => a.common),
    'only common actions',
  );
  assert.ok(!r.some((x) => x.kind === 'project'));
});

test('empty query caps recent chats at the limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => chatItem('Chat ' + i, { activity: i }));
  const r = C.compose({ chats: many, projects: [], actions: [] }, '', 'all');
  assert.equal(r.length, C.RECENT_CHATS);
});

test('mixed ranking: all three sources compete; archived chats sink', () => {
  const r = C.compose(sources(), 'arch', 'all');
  const k = kinds(r);
  assert.ok(k.includes('action:chat:archive') && k.includes('chat:Archive notes'));
  assert.ok(!k.includes('chat:Old thing'), 'no match');
  const p = C.compose(sources(), 'parser', 'all');
  assert.deepEqual(new Set(p.map((x) => x.kind)), new Set(['chat', 'project']));
  const arch = C.compose(
    {
      chats: [chatItem('Parser old', { archived: true, activity: 999 }), chatItem('Parser new', { activity: 1 })],
      projects: [],
      actions: [],
    },
    'parser',
    'all',
  );
  assert.deepEqual(
    arch.map((x) => x.title),
    ['Parser new', 'Parser old'],
  );
});

test('filter modes restrict the sources, with and without a query', () => {
  const s = sources();
  assert.deepEqual(new Set(C.compose(s, 'parser', 'chats').map((x) => x.kind)), new Set(['chat']));
  assert.deepEqual(new Set(C.compose(s, 'parser', 'projects').map((x) => x.kind)), new Set(['project']));
  assert.deepEqual(new Set(C.compose(s, 'a', 'actions').map((x) => x.kind)), new Set(['action']));
  assert.equal(C.compose(s, '', 'projects').length, 2);
  assert.equal(C.compose(s, '', 'chats').length, 3);
  const acts = C.compose(s, '', 'actions');
  assert.equal(acts.length, s.actions.length, 'every action is listed');
  assert.ok(acts[0].common, 'common ones first');
});

test('leading > shows actions only whatever the filter', () => {
  const s = sources();
  assert.deepEqual(C.compose(s, '> parser', 'chats'), [], 'no action is called parser');
  assert.deepEqual(
    C.compose(s, '>hold', 'projects').map((x) => x.id),
    ['chat:hold'],
  );
  assert.ok(C.compose(s, '>', 'all').every((x) => x.kind === 'action'));
});

test('keywords find actions', () => {
  assert.equal(C.compose(sources(), 'sidebar', 'all')[0].id, 'toggle-side');
  assert.equal(C.compose(sources(), 'snooze', 'actions')[0].id, 'chat:hold');
});

test('sheet model: four groups, registry shortcuts plus the static ones, absent modules add no rows', () => {
  const groups = C.sheetModel(baseCtx({ keys: { inbox: 'Alt+I' } }));
  assert.deepEqual(
    groups.map((g) => g.name),
    ['Moving around', 'This chat', 'Panels', 'Text size'],
  );
  const flat = groups.flatMap((g) => g.rows.map((r) => g.name + '|' + r.keys));
  for (const k of [
    'Moving around|Ctrl+K',
    'Moving around|Ctrl+P',
    'Moving around|Ctrl+Tab / Ctrl+Shift+Tab',
    'Moving around|Alt+PgDn / Alt+PgUp',
    'Moving around|Ctrl+W / Alt+W',
    'Moving around|Alt+I',
    'This chat|F2',
    'This chat|Shift+F10 / Menu key',
    'Panels|Ctrl+B',
    'Panels|Ctrl+Alt+B',
    'Panels|?',
  ])
    assert.ok(flat.includes(k), k);
  assert.equal(new Set(flat).size, flat.length, 'no duplicate rows');
  const none = C.sheetModel(baseCtx({ chat: null, menu: new Set(), do: { showSheet() {} } })).flatMap((g) =>
    g.rows.map((r) => r.keys),
  );
  assert.ok(none.includes('F2'), 'chat keys are documented even with no chat open');
  assert.ok(
    !none.includes('Ctrl+B') && !none.includes('Ctrl+P') && !none.includes('Alt+I'),
    'absent modules add no rows',
  );
  assert.ok(none.includes('?'));
});

test('QA M1: an archived title match beats scattered letters and path matches, even past the result limit', () => {
  const longRoot = 'C:\\Users\\someone\\AppData\\Local\\Temp\\agent-studio-demo-8813\\projects\\';
  const chats = [];
  for (let i = 0; i < 60; i++)
    chats.push(
      chatItem('Chat ' + i + ' about refactoring the session cookies', {
        path: longRoot + 'proj' + i,
        project: 'proj' + i,
        activity: 1000 + i,
      }),
    );
  chats.push(
    chatItem('Old spike: try the legacy parser', { archived: true, activity: 1, path: longRoot + 'beta', project: 'beta' }),
  );
  const projects = chats.slice(0, 15).map((c, i) => ({ key: 'p' + i, name: c.project, path: c.path }));
  for (const q of ['parser', 'old', 'legacy']) {
    const r = C.compose({ chats, projects, actions: [] }, q, 'all');
    assert.equal(r[0] && r[0].title, 'Old spike: try the legacy parser', q + ' ranks the archived chat first');
    assert.ok(!r.some((x) => x.kind === 'project'), q + ': project paths only match on a substring');
  }
  // A folder path still matches on a real substring.
  const byPath = C.compose({ chats: [], projects: [{ key: 'x', name: 'App', path: 'D:\\Work\\billing-api' }], actions: [] }, 'billing', 'all');
  assert.equal(byPath.length, 1);
  // search() (the chats-only switcher) follows the same rule.
  assert.equal(C.search(chats, 'parser')[0].title, 'Old spike: try the legacy parser');
});
