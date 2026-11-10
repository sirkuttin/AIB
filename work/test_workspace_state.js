const { APP: APP_DIR } = require('./_paths');
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
    },
    extra,
  );
const sample = () => [
  item('a1', 'a', { state: 'needs_you', needs: 2, activity: 500, elicitations: 1 }),
  item('a2', 'a', { state: 'working', activity: 900 }),
  item('a3', 'a', { state: 'saved', activity: 10, archived: true }),
  item('b1', 'b', { state: 'idle', activity: 300, pinned: true }),
  item('b2', 'b', { state: 'needs_you', needs: 1, activity: 700, auth: true }),
  item('c1', 'c', { state: 'unread', unread: true, activity: 50, held: true }),
];

test('projects are derived from the list, in stable alphabetical order, with attention counts', () => {
  const ps = W.buildProjects(sample());
  assert.deepEqual(
    ps.map((p) => p.key),
    ['a', 'b', 'c'],
  );
  const later = sample().map((i) => (i.key === 'c1' ? Object.assign({}, i, { activity: 9999 }) : i));
  assert.deepEqual(
    W.buildProjects(later).map((p) => p.key),
    ['a', 'b', 'c'],
    'new activity does not reorder the rail',
  );
  const a = ps[0];
  assert.equal(a.total, 2, 'archived chats do not count');
  assert.equal(a.needs, 1);
  assert.equal(a.needsItems, 2);
  assert.equal(a.working, 1);
  assert.equal(a.state, 'needs_you');
  assert.equal(ps[2].unread, 1);
  assert.equal(ps[2].state, 'unread');
  assert.deepEqual(W.buildProjects([]), []);
});

test('totals add up across projects', () => {
  const t = W.totals(sample());
  assert.deepEqual([t.total, t.needs, t.working, t.unread], [5, 2, 1, 1]);
});

test('hues are stable', () => {
  assert.equal(W.hueOf('w:c/repos/app'), W.hueOf('w:c/repos/app'));
  assert.ok(W.hueOf('x') >= 0 && W.hueOf('x') < 360);
});

test('the list filter keeps pinned and held chats in their own project and "all" shows everything', () => {
  const items = sample();
  assert.equal(W.filterItems(items, 'all').length, items.length);
  assert.deepEqual(
    W.filterItems(items, 'b').map((i) => i.key),
    ['b1', 'b2'],
  );
  assert.ok(
    W.filterItems(items, 'b').some((i) => i.pinned),
    'pinned b1 stays in project b',
  );
  assert.ok(W.filterItems(items, 'c').some((i) => i.held));
  assert.equal(W.inProject(item('x', 'z'), 'all'), true);
  assert.equal(W.inProject(item('x', 'z'), 'y'), false);
});

test('inbox lists every waiting chat across projects, one row each, with kinds', () => {
  const rows = W.inbox(sample());
  assert.deepEqual(
    rows.map((r) => r.key),
    ['b2', 'a1'],
    'newest activity first',
  );
  assert.deepEqual(rows[0].kinds, [{ kind: 'auth', count: 1 }]);
  assert.deepEqual(rows[1].kinds, [
    { kind: 'question', count: 1 },
    { kind: 'permission', count: 1 },
  ]);
  assert.equal(rows[1].needs, 2);
  assert.equal(rows[1].summary, 'Question, Permission');
  assert.equal(rows[0].projectName, 'P-b');
  assert.deepEqual(
    W.inbox([item('z', 'p', { state: 'needs_you', needs: 1, archived: true })]),
    [],
    'archived chats never nag',
  );
  assert.deepEqual(W.inbox([item('z', 'p', { state: 'working' })]), []);
});

test('need kinds: questions, permissions and sign-in', () => {
  assert.deepEqual(W.classifyNeeds({ needs: 3, elicitations: 1, auth: true }), [
    { kind: 'question', count: 1 },
    { kind: 'permission', count: 1 },
    { kind: 'auth', count: 1 },
  ]);
  assert.deepEqual(W.classifyNeeds({ needs: 1 }), [{ kind: 'permission', count: 1 }]);
  assert.deepEqual(
    W.classifyNeeds({ needs: 4, elicitations: 9 }),
    [{ kind: 'question', count: 4 }],
    'cannot exceed the server total',
  );
  assert.deepEqual(W.classifyNeeds({ needs: 0 }), []);
  assert.equal(W.describeNeeds([{ kind: 'permission', count: 2 }]), 'Permission x2');
});

test('opening tabs: per project, no duplicates, new tab goes next to the current one', () => {
  let st = W.empty();
  st = W.openTab(st, 'a', 'x');
  st = W.openTab(st, 'a', 'y');
  st = W.openTab(st, 'a', 'z', 'x');
  assert.deepEqual(st.tabs.a, ['x', 'z', 'y']);
  st = W.openTab(st, 'a', 'y');
  assert.deepEqual(st.tabs.a, ['x', 'z', 'y'], 'reopening only focuses');
  assert.equal(st.last.a, 'y');
  st = W.openTab(st, 'b', 'q');
  assert.deepEqual(st.tabs.b, ['q']);
  assert.equal(W.openTab(st, 'all', 'k'), st, 'all is not a project');
  assert.equal(W.openTab(st, '', 'k'), st);
});

test('state is immutable', () => {
  const st = W.openTab(W.empty(), 'a', 'x');
  const frozen = JSON.stringify(st);
  W.openTab(st, 'a', 'y');
  W.closeTab(st, 'a', 'x');
  W.renameTab(st, 'x', 'w');
  W.pruneTabs(st, []);
  assert.equal(JSON.stringify(st), frozen);
});

test('closing the active tab picks the right neighbour, then the left, then nothing', () => {
  let st = W.empty();
  for (const k of ['x', 'y', 'z']) st = W.openTab(st, 'a', k);
  let r = W.closeTab(st, 'a', 'y', 'y');
  assert.equal(r.next, 'z');
  assert.deepEqual(r.state.tabs.a, ['x', 'z']);
  assert.equal(r.state.last.a, 'z');
  r = W.closeTab(r.state, 'a', 'z', 'z');
  assert.equal(r.next, 'x');
  r = W.closeTab(r.state, 'a', 'x', 'x');
  assert.equal(r.next, null);
  assert.equal(r.state.tabs.a, undefined);
  assert.equal(r.state.last.a, undefined);
  // closing a background tab keeps the active one
  r = W.closeTab(st, 'a', 'x', 'z');
  assert.equal(r.next, 'z');
  assert.deepEqual(r.state.tabs.a, ['y', 'z']);
  assert.equal(W.closeTab(st, 'a', 'nope', 'z').closed, false);
});

test('Ctrl+Tab cycles with wrap-around, Ctrl+1..9 jumps', () => {
  const tabs = ['a', 'b', 'c'];
  assert.equal(W.cycle(tabs, 'a', 1), 'b');
  assert.equal(W.cycle(tabs, 'c', 1), 'a');
  assert.equal(W.cycle(tabs, 'a', -1), 'c');
  assert.equal(W.cycle(tabs, 'zzz', 1), 'a');
  assert.equal(W.cycle(tabs, null, -1), 'c');
  assert.equal(W.cycle([], 'a', 1), null);
  assert.equal(W.jump(tabs, 1), 'a');
  assert.equal(W.jump(tabs, 3), 'c');
  assert.equal(W.jump(tabs, 5), null);
  assert.equal(W.jump(tabs, 9), 'c', '9 is the last tab');
  assert.equal(W.jump([], 1), null);
});

test('overflow keeps the active tab visible and flags hidden tabs that need you', () => {
  const tabs = ['a', 'b', 'c', 'd', 'e'];
  let o = W.overflow(tabs, 'a', 3, new Set(['e']));
  assert.deepEqual(o.shown, ['a', 'b', 'c']);
  assert.deepEqual(o.hidden, ['d', 'e']);
  assert.equal(o.hiddenNeeds, 1);
  o = W.overflow(tabs, 'e', 3, new Set());
  assert.deepEqual(o.shown, ['a', 'b', 'e']);
  assert.deepEqual(o.hidden, ['c', 'd']);
  assert.equal(o.hiddenNeeds, 0);
  o = W.overflow(tabs, 'b', 9, []);
  assert.deepEqual(o.shown, tabs);
  assert.deepEqual(o.hidden, []);
  assert.deepEqual(W.overflow(tabs, 'b', 0, []).shown, ['b'], 'always room for one');
});

test('shortcuts: Ctrl and Alt variants, never with Meta or in unrelated combinations', () => {
  const k = (key, mods = {}) => W.shortcutFor(Object.assign({ key }, mods));
  assert.deepEqual(k('Tab', { ctrlKey: true }), { action: 'next' });
  assert.deepEqual(k('Tab', { ctrlKey: true, shiftKey: true }), { action: 'prev' });
  assert.deepEqual(k('w', { ctrlKey: true }), { action: 'close' });
  assert.deepEqual(k('W', { ctrlKey: true }), { action: 'close' });
  assert.deepEqual(k('4', { ctrlKey: true }), { action: 'jump', n: 4 });
  assert.deepEqual(k('PageDown', { altKey: true }), { action: 'next' });
  assert.deepEqual(k('PageUp', { altKey: true }), { action: 'prev' });
  assert.deepEqual(k('2', { altKey: true }), { action: 'jump', n: 2 });
  assert.equal(k('0', { ctrlKey: true }), null);
  assert.equal(k('w', { ctrlKey: true, shiftKey: true }), null);
  assert.equal(k('w', {}), null);
  assert.equal(k('Tab', { metaKey: true, ctrlKey: true }), null);
  assert.equal(k('k', { ctrlKey: true }), null, 'Ctrl+K stays with the switcher');
  assert.equal(k('n', { ctrlKey: true, shiftKey: true }), null);
  assert.equal(k('1', { ctrlKey: true, altKey: true }), null);
  assert.equal(W.shortcutFor(null), null);
});

test('active project: "all" follows the open chat, a chosen project wins', () => {
  let st = W.empty();
  assert.equal(W.effectiveProject(st, 'p'), 'p');
  assert.equal(W.effectiveProject(st, ''), 'all');
  st = W.setActive(st, 'q');
  assert.equal(W.effectiveProject(st, 'p'), 'q');
  assert.equal(W.setActive(st, 'q'), st);
});

test('renaming a tab follows a new chat whose key changed', () => {
  let st = W.empty();
  for (const k of ['x', 'live:1', 'z']) st = W.openTab(st, 'a', k);
  st = W.renameTab(st, 'live:1', 'claude:s1');
  assert.deepEqual(st.tabs.a, ['x', 'claude:s1', 'z']);
  assert.equal(st.last.a, 'z');
  st = W.openTab(st, 'a', 'claude:s1');
  st = W.renameTab(st, 'claude:s1', 'x');
  assert.deepEqual(st.tabs.a, ['x', 'z'], 'no duplicates');
});

test('pruning drops tabs of chats that are gone', () => {
  let st = W.empty();
  for (const k of ['x', 'y']) st = W.openTab(st, 'a', k);
  st = W.openTab(st, 'b', 'q');
  st = W.pruneTabs(st, ['x', 'q']);
  assert.deepEqual(st.tabs, { a: ['x'], b: ['q'] });
  st = W.pruneTabs(st, new Set());
  assert.deepEqual(st.tabs, {});
  assert.deepEqual(st.last, {});
});

test('stored state is validated before use', () => {
  assert.deepEqual(W.sanitize(null), W.empty());
  assert.deepEqual(W.sanitize('x'), W.empty());
  assert.deepEqual(W.sanitize([1]), W.empty());
  const st = W.sanitize({
    active: 'a',
    tabs: { a: ['x', 'x', 7, '', 'y'], b: 'nope', c: [] },
    last: { a: 'y', b: 'zzz' },
  });
  assert.equal(st.active, 'a');
  assert.deepEqual(st.tabs, { a: ['x', 'y'] });
  assert.deepEqual(st.last, { a: 'y' });
  const big = W.sanitize({ tabs: { a: Array.from({ length: W.MAX_TABS + 100 }, (_, i) => 'k' + i) } });
  assert.equal(big.tabs.a.length, W.MAX_TABS);
  assert.deepEqual(W.sanitize(JSON.parse(JSON.stringify(st))), st, 'round-trips through JSON');
});

test('opening past the tab cap drops an old tab, never the new or current one', () => {
  let st = W.empty();
  for (let i = 0; i < W.MAX_TABS; i++) st = W.openTab(st, 'a', 'k' + i);
  st = W.openTab(st, 'a', 'new', 'k0');
  assert.equal(st.tabs.a.length, W.MAX_TABS);
  assert.ok(st.tabs.a.includes('new') && st.tabs.a.includes('k0'));
});

test('signature changes with status, tabs and selection but not with unrelated reordering of input', () => {
  const st = W.openTab(W.empty(), 'a', 'a1');
  const base = W.signature(sample(), st, 'a1');
  assert.equal(W.signature(sample(), st, 'a1'), base);
  const changed = sample();
  changed[1].state = 'idle';
  assert.notEqual(W.signature(changed, st, 'a1'), base);
  assert.notEqual(W.signature(sample(), W.openTab(st, 'a', 'a2'), 'a1'), base);
  assert.notEqual(W.signature(sample(), st, 'a2'), base);
});

test('strip project: draft pins it, otherwise rail, open chat, then the most recent project', () => {
  const st = W.openTab(W.openTab(W.empty(), 'a', 'a1'), 'b', 'b1');
  assert.equal(st.recent, 'b');
  assert.equal(W.stripProject(st, 'a'), 'a');
  assert.equal(W.stripProject(st, ''), 'b', 'nothing open: most recent project, never an empty strip');
  assert.equal(W.stripProject(W.setActive(st, 'a'), 'b'), 'a');
  assert.equal(W.stripProject(st, '', 'a'), 'a', 'draft project wins');
  assert.equal(W.stripProject(W.empty(), ''), W.ALL);
});

test('draft tab is appended once, never stored, and exits to the tab we came from', () => {
  const st = W.openTab(W.openTab(W.empty(), 'a', 'a1'), 'a', 'a2');
  assert.deepEqual(W.withDraftTab(['a1', 'a2'], true), ['a1', 'a2', W.DRAFT]);
  assert.deepEqual(W.withDraftTab(['a1', W.DRAFT], true), ['a1', W.DRAFT]);
  assert.deepEqual(W.withDraftTab(['a1', W.DRAFT], false), ['a1']);
  assert.equal(W.draftProject(st, 'a'), 'a');
  assert.equal(W.draftProject(W.setActive(st, 'a'), ''), 'a');
  assert.equal(W.draftProject(st, ''), 'a', 'falls back to the most recent project');
  assert.equal(W.draftProject(W.empty(), ''), '');
  assert.equal(W.draftExit(st, 'a', 'a1'), 'a1');
  assert.equal(W.draftExit(st, 'a', 'gone'), 'a2', 'last chat of the project');
  assert.equal(W.draftExit(W.empty(), 'a', 'x'), null);
  assert.ok(!JSON.stringify(st).includes(W.DRAFT));
});

test('inbox groups by project and carries the question text; unviewed counts finished chats', () => {
  const items = sample().map((i) => (i.key === 'a1' ? Object.assign({}, i, { ask: '  Which database?  ' }) : i));
  const rows = W.inbox(items);
  assert.equal(rows.find((r) => r.key === 'a1').ask, 'Which database?');
  assert.equal(rows.find((r) => r.key === 'b2').ask, '');
  const groups = W.groupInbox(rows);
  assert.deepEqual(
    groups.map((g) => [g.projectKey, g.rows.map((r) => r.key)]),
    [
      ['a', ['a1']],
      ['b', ['b2']],
    ],
  );
  assert.equal(W.unviewed(items), 1);
  assert.equal(W.unviewed([]), 0);
});

test('restore candidates: rail project first, then the most recent, then the rest', () => {
  const st = W.rememberLast(W.openTab(W.openTab(W.empty(), 'a', 'a1'), 'b', 'b1'), 'a', 'a1');
  assert.deepEqual(W.restoreCandidates(st), ['b1', 'a1']);
  assert.deepEqual(W.restoreCandidates(W.setActive(st, 'a')).slice(0, 2), ['a1', 'b1']);
  assert.deepEqual(W.restoreCandidates(W.empty()), []);
  assert.equal(W.sanitize(JSON.parse(JSON.stringify(st))).recent, 'b');
});

// ---- project preferences -------------------------------------------------------------------------------
const projs = () =>
  ['alpha', 'beta', 'gamma', 'delta'].map((n) => ({ key: 'k-' + n, name: n, autoName: n, path: '/' + n, total: 1 }));

test('sanitizePrefs keeps only valid entries and caps lengths', () => {
  const p = W.sanitizePrefs({
    order: ['a', 'a', 3, '', 'b'],
    projects: {
      a: { name: '  Hi\n there ', color: 'blue', hidden: true },
      b: { color: 'neon' },
      c: 'x',
      d: { name: 'z'.repeat(200) },
    },
  });
  assert.deepEqual(p.order, ['a', 'b']);
  assert.deepEqual(p.projects.a, { name: 'Hi there', color: 'blue', hidden: true });
  assert.equal(p.projects.b, undefined, 'an unknown colour alone is not a preference');
  assert.equal(p.projects.c, undefined);
  assert.equal(p.projects.d.name.length, 60);
  assert.deepEqual(W.sanitizePrefs(null), { order: [], projects: {} });
  assert.deepEqual(W.sanitizePrefs([1]), { order: [], projects: {} });
});

test('applyPrefs puts saved positions first and new projects after them, alphabetically', () => {
  const prefs = { order: ['k-gamma', 'k-alpha', 'k-gone'], projects: {} };
  assert.deepEqual(
    W.applyPrefs(projs(), prefs).map((p) => p.key),
    ['k-gamma', 'k-alpha', 'k-beta', 'k-delta'],
  );
  assert.deepEqual(
    W.applyPrefs(projs(), W.emptyPrefs()).map((p) => p.name),
    ['alpha', 'beta', 'delta', 'gamma'],
  );
});

test('applyPrefs merges name, colour and hidden without touching its input', () => {
  const input = projs(),
    prefs = W.setPref(W.setPref(W.emptyPrefs(), 'k-beta', { name: 'Billing', color: 'teal' }), 'k-delta', {
      hidden: true,
    });
  const out = W.applyPrefs(input, prefs);
  const beta = out.find((p) => p.key === 'k-beta');
  assert.equal(beta.name, 'Billing');
  assert.equal(beta.autoName, 'beta');
  assert.equal(beta.custom, true);
  assert.equal(beta.color, 'teal');
  assert.equal(input[1].name, 'beta', 'input not mutated');
  assert.deepEqual(
    W.visibleProjects(out).map((p) => p.key),
    ['k-alpha', 'k-beta', 'k-gamma'],
  );
  assert.deepEqual(
    W.hiddenProjects(out).map((p) => p.key),
    ['k-delta'],
  );
});

test('displayName reads the custom name, else the fallback', () => {
  const prefs = W.setPref(W.emptyPrefs(), 'x', { name: ' Mine ', color: 'violet' });
  assert.equal(W.displayName(prefs, 'x', 'folder'), 'Mine');
  assert.equal(W.displayName(prefs, 'y', 'folder'), 'folder');
  assert.equal(W.displayName(null, 'y', ''), 'No folder');
});

test('setPref clears empty fields, drops empty entries and ignores bad colours', () => {
  let p = W.setPref(W.emptyPrefs(), 'a', { name: 'A', color: 'pink' });
  p = W.setPref(p, 'a', { name: '' });
  assert.deepEqual(p.projects.a, { name: '', color: 'pink', hidden: false });
  p = W.setPref(p, 'a', { color: '' });
  assert.deepEqual(p.projects, {});
  assert.deepEqual(W.setPref(W.emptyPrefs(), 'a', { color: 'puce' }).projects, {});
});

test('drag math: slotAt, moveToSlot and slotMoves', () => {
  assert.equal(W.slotAt([20, 60, 100], 5), 0);
  assert.equal(W.slotAt([20, 60, 100], 61), 2);
  assert.equal(W.slotAt([20, 60, 100], 500), 3);
  assert.deepEqual(W.moveToSlot(['a', 'b', 'c', 'd'], 0, 3), ['b', 'c', 'a', 'd']);
  assert.deepEqual(W.moveToSlot(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(W.moveToSlot(['a', 'b', 'c', 'd'], 1, 1), ['a', 'b', 'c', 'd']);
  assert.deepEqual(W.moveToSlot(['a', 'b', 'c', 'd'], 1, 2), ['a', 'b', 'c', 'd']);
  assert.deepEqual(W.moveToSlot(['a', 'b'], 0, 99), ['b', 'a']);
  assert.equal(W.slotMoves(1, 1), false);
  assert.equal(W.slotMoves(1, 2), false);
  assert.equal(W.slotMoves(1, 3), true);
});

test('nudge and mergeOrder keep hidden projects in place', () => {
  assert.deepEqual(W.nudge(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(W.nudge(['a', 'b', 'c'], 'a', -1), ['a', 'b', 'c']);
  assert.deepEqual(W.nudge(['a', 'b', 'c'], 'c', 1), ['a', 'b', 'c']);
  assert.deepEqual(W.mergeOrder(['a', 'h', 'b', 'c'], ['c', 'a', 'b']), ['c', 'h', 'a', 'b']);
});

test('buildProjects carries the folder-derived name next to a custom one', () => {
  const ps = W.buildProjects([item('x', 'p', { projectName: 'Custom', projectAutoName: 'folder' })]);
  assert.equal(ps[0].name, 'Custom');
  assert.equal(ps[0].autoName, 'folder');
});

test('opening a chat from another project moves the active project; All stays All', () => {
  const st = { ...W.empty(), active: 'a' };
  assert.equal(W.activeAfterOpen(st, 'b').active, 'b');
  assert.equal(W.activeAfterOpen(st, 'a'), st);
  assert.equal(W.activeAfterOpen({ ...W.empty(), active: 'all' }, 'b').active, 'all');
  assert.equal(W.activeAfterOpen(st, ''), st);
});

test('filterProjects matches display name, folder name and path', () => {
  const ps = [
    { key: 'a', name: 'Billing', autoName: 'api', path: '/work/api' },
    { key: 'b', name: 'web', autoName: 'web', path: '/work/web' },
  ];
  assert.deepEqual(
    W.filterProjects(ps, 'bill').map((p) => p.key),
    ['a'],
  );
  assert.deepEqual(
    W.filterProjects(ps, 'API').map((p) => p.key),
    ['a'],
  );
  assert.equal(W.filterProjects(ps, 'work').length, 2);
  assert.equal(W.filterProjects(ps, '  ').length, 2);
  assert.deepEqual(W.filterProjects(ps, 'zzz'), []);
});

test('auto colours are deterministic, in the palette, and muted (not status amber/red/green)', () => {
  const ids = new Set(W.PALETTE.map((c) => c.id));
  assert.equal(W.autoColorId('w:c/app'), W.autoColorId('w:c/app'));
  assert.ok(ids.has(W.autoColorId('anything')));
  assert.equal(W.PALETTE.length, 8);
  for (const c of W.PALETTE) {
    assert.ok(c.s <= 60, c.id);
    assert.ok(c.hue >= 160 && c.hue <= 340, c.id + ' stays out of the status hues');
  }
  assert.match(W.cssColor('teal'), /^hsl\(172 \d+% \d+%\)$/);
});

test('neighbouring projects in the saved order do not share an automatic colour', () => {
  const keys = Array.from({ length: 40 }, (_, i) => 'k' + i);
  const list = keys.map((k) => ({ key: k }));
  const colors = W.assignColors(list, W.emptyPrefs());
  for (let i = 1; i < list.length; i++) assert.notEqual(colors.get(keys[i]), colors.get(keys[i - 1]), keys[i]);
  const again = W.assignColors(list, W.emptyPrefs());
  for (const k of keys) assert.equal(again.get(k), colors.get(k), 'stable');
  // reordering only changes a colour where the neighbour rule needs it
  const rev = W.assignColors(list.slice().reverse(), W.emptyPrefs());
  for (let i = 1; i < list.length; i++) assert.notEqual(rev.get(keys[i]), rev.get(keys[i - 1]));
});

test('an explicit colour is kept and its neighbours steer clear of it; Auto (empty) restores the automatic pick', () => {
  const list = [{ key: 'a' }, { key: 'b' }, { key: 'c' }];
  const auto = W.assignColors(list, W.emptyPrefs());
  const pick = auto.get('a') === 'blue' ? 'sky' : 'blue';
  const prefs = W.setPref(W.emptyPrefs(), 'b', { color: pick });
  const out = W.assignColors(list, prefs);
  assert.equal(out.get('b'), pick);
  assert.notEqual(out.get('a'), pick);
  assert.notEqual(out.get('c'), pick);
  assert.equal(W.assignColors(list, W.setPref(prefs, 'b', { color: '' })).get('b'), auto.get('b'));
});

test('applyPrefs exposes the effective colour id next to the explicit one', () => {
  const out = W.applyPrefs(projs(), W.setPref(W.emptyPrefs(), 'k-beta', { color: 'pink' }));
  const beta = out.find((p) => p.key === 'k-beta');
  assert.equal(beta.colorId, 'pink');
  assert.equal(beta.color, 'pink');
  const alpha = out.find((p) => p.key === 'k-alpha');
  assert.equal(alpha.color, '');
  assert.ok(W.PALETTE.some((c) => c.id === alpha.colorId));
});
