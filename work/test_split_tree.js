'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const T = require(path.join(APP_DIR, 'split-tree.js'));

const tabsOfGroups = (L) => T.groups(L.tree).map((g) => g.tabs.join('+'));
// Two panes side by side: [a b | c]
const two = () => {
  const l = T.group(['a', 'b'], 'a'),
    r = T.group(['c'], 'c');
  return { tree: T.split('row', [l, r]), focus: l.id };
};
const firstId = (L) => T.groups(L.tree)[0].id,
  lastId = (L) => T.groups(L.tree).slice(-1)[0].id;

test('one pane is a single group and counts as one', () => {
  const L = T.single(['a', 'b', 'a', ''], 'b');
  assert.deepEqual(
    T.groups(L.tree).map((g) => g.tabs),
    [['a', 'b']],
  );
  assert.equal(T.focused(L).active, 'b');
  assert.equal(T.countGroups(L), 1);
});

test('drop on an edge splits the pane and the dropped chat gets the new half', () => {
  const L = T.single(['a', 'b'], 'a'),
    id = firstId(L);
  const right = T.drop(L, 'b', id, 'right');
  assert.deepEqual(tabsOfGroups(right), ['a', 'b']);
  assert.equal(right.tree.dir, 'row');
  assert.equal(T.focused(right).active, 'b', 'the new pane takes focus');
  const left = T.drop(L, 'b', id, 'left');
  assert.deepEqual(tabsOfGroups(left), ['b', 'a']);
  const down = T.drop(L, 'b', id, 'bottom');
  assert.equal(down.tree.dir, 'col');
  assert.deepEqual(tabsOfGroups(down), ['a', 'b']);
  const up = T.drop(L, 'b', id, 'top');
  assert.deepEqual(tabsOfGroups(up), ['b', 'a']);
});

test('splitting the only tab of a pane away from itself changes nothing', () => {
  const L = T.single(['a'], 'a');
  assert.equal(T.drop(L, 'a', firstId(L), 'right'), L);
});

test('a split the same way as its parent joins the parent instead of nesting; the other way nests', () => {
  let L = T.single(['a', 'b', 'c'], 'a');
  L = T.drop(L, 'b', firstId(L), 'right');
  const a = T.holder(L.tree, 'a');
  L = T.drop(L, 'c', a.id, 'right'); // row inside a row: flat
  assert.equal(L.tree.dir, 'row');
  assert.equal(L.tree.ch.length, 3);
  assert.deepEqual(tabsOfGroups(L), ['a', 'c', 'b']);
  const b = T.holder(L.tree, 'b');
  const n = T.drop(L, 'a', b.id, 'bottom'); // a column inside the row
  assert.equal(
    n.tree.ch.some((c) => c.k === 's' && c.dir === 'col'),
    true,
  );
});

test('the new pane takes half of the space of the pane it split', () => {
  let L = T.single(['a', 'b'], 'a');
  L = T.drop(L, 'b', firstId(L), 'right');
  const [x, y] = T.groups(L.tree);
  assert.equal(x.f, y.f);
  L = T.drop(L, 'a', y.id, 'left');
  assert.equal(T.groups(L.tree).length, 2, 'a moved: its old pane closed');
});

test('center and the tab bar move a chat in as a tab, with an insertion index', () => {
  const L = two(),
    l = firstId(L);
  const moved = T.drop(L, 'c', l, 'center');
  assert.equal(T.countGroups(moved), 1, 'the emptied pane closes');
  assert.deepEqual(T.groups(moved.tree)[0].tabs, ['a', 'b', 'c']);
  assert.equal(T.focused(moved).active, 'c');
  const mid = T.drop(L, 'c', l, 'tabs', 1);
  assert.deepEqual(T.groups(mid.tree)[0].tabs, ['a', 'c', 'b']);
  const front = T.drop(L, 'c', l, 'tabs', 0);
  assert.deepEqual(T.groups(front.tree)[0].tabs, ['c', 'a', 'b']);
});

test('reordering inside one tab bar uses the slot between tabs', () => {
  const L = T.single(['a', 'b', 'c', 'd'], 'a'),
    id = firstId(L);
  assert.deepEqual(T.groups(T.drop(L, 'a', id, 'tabs', 3).tree)[0].tabs, ['b', 'c', 'a', 'd']);
  assert.deepEqual(T.groups(T.drop(L, 'd', id, 'tabs', 0).tree)[0].tabs, ['d', 'a', 'b', 'c']);
  assert.deepEqual(T.groups(T.drop(L, 'b', id, 'tabs', 4).tree)[0].tabs, ['a', 'c', 'd', 'b']);
  assert.deepEqual(
    T.groups(T.drop(L, 'b', id, 'tabs', 1).tree)[0].tabs,
    ['a', 'b', 'c', 'd'],
    'dropping on its own gap',
  );
  assert.deepEqual(
    T.groups(T.drop(L, 'b', id, 'center').tree)[0].tabs,
    ['a', 'b', 'c', 'd'],
    'center in its own pane: nothing moves',
  );
});

test('a chat that is in no pane yet (a card from the list) can be dropped anywhere', () => {
  const L = two();
  const split = T.drop(L, 'z', lastId(L), 'bottom');
  assert.equal(T.countGroups(split), 3);
  assert.equal(T.holder(split.tree, 'z').tabs.length, 1);
  const tab = T.drop(L, 'z', firstId(L), 'tabs', 1);
  assert.deepEqual(T.groups(tab.tree)[0].tabs, ['a', 'z', 'b']);
});

test('a chat is in one pane only: dragging moves it', () => {
  let L = two();
  L = T.drop(L, 'a', lastId(L), 'center');
  const all = T.tabsFlat(L);
  assert.equal(all.filter((t) => t === 'a').length, 1);
  assert.deepEqual(
    T.groups(L.tree).map((g) => g.tabs),
    [['b'], ['c', 'a']],
  );
});

test('closing the last tab of a pane closes the pane and a neighbour takes the focus and the space', () => {
  const L = two();
  const gone = T.removeTab(L, 'c');
  assert.equal(T.countGroups(gone), 1);
  assert.equal(T.focused(gone).id, firstId(L));
  const three = T.drop(L, 'c', lastId(L), 'bottom'); // [a b | (c)] -> still two; build three panes
  const grid = T.drop(three, 'b', firstId(three), 'bottom');
  assert.equal(T.countGroups(grid), 3);
  const c = T.holder(grid.tree, 'c');
  const closed = T.removeTab({ ...grid, focus: c.id }, 'c');
  assert.equal(T.countGroups(closed), 2);
  assert.notEqual(T.focused(closed).id, c.id);
});

test('closing a tab that is not the last keeps the pane and picks a neighbour tab', () => {
  const L = T.single(['a', 'b', 'c'], 'b');
  const r = T.removeTab(L, 'b');
  assert.deepEqual(T.groups(r.tree)[0].tabs, ['a', 'c']);
  assert.equal(T.focused(r).active, 'c', 'the tab to the right takes over');
  const last = T.removeTab(T.single(['a', 'b'], 'b'), 'b');
  assert.equal(T.focused(last).active, 'a', 'at the end it is the left one');
});

test('closing panes nests back: a split with one child is replaced by the child', () => {
  let L = T.single(['a', 'b', 'c'], 'a');
  L = T.drop(L, 'b', firstId(L), 'right');
  L = T.drop(L, 'c', T.holder(L.tree, 'b').id, 'bottom');
  assert.equal(L.tree.ch[1].k, 's');
  const r = T.removeTab(L, 'c');
  assert.equal(r.tree.ch[1].k, 'g');
});

test('splitGroup moves the active tab to a new pane, or opens a New chat when it is the only tab', () => {
  const L = T.single(['a', 'b'], 'b');
  const s = T.splitGroup(L, firstId(L), 'row');
  assert.deepEqual(tabsOfGroups(s), ['a', 'b']);
  assert.equal(T.focused(s).active, 'b');
  const down = T.splitGroup(L, firstId(L), 'col', 'a');
  assert.equal(down.tree.dir, 'col');
  assert.deepEqual(tabsOfGroups(down), ['b', 'a']);
  const one = T.single(['a'], 'a');
  const fresh = T.splitGroup(one, firstId(one), 'row');
  assert.deepEqual(tabsOfGroups(fresh), ['a', T.DRAFT]);
  assert.equal(T.focused(fresh).active, T.DRAFT);
});

test('Ctrl+Alt+arrow: a tab moves to the next or previous pane, wrapping', () => {
  const L = two();
  const next = T.moveToNeighbour(L, 'a', 1);
  assert.deepEqual(
    T.groups(next.tree).map((g) => g.tabs),
    [['b'], ['c', 'a']],
  );
  assert.equal(T.focused(next).active, 'a');
  const wrap = T.moveToNeighbour(next, 'a', 1);
  assert.deepEqual(
    T.groups(wrap.tree).map((g) => g.tabs),
    [['b', 'a'], ['c']],
  );
  const back = T.moveToNeighbour(L, 'c', -1);
  assert.deepEqual(T.groups(back.tree)[0].tabs, ['a', 'b', 'c']);
  assert.equal(T.moveToNeighbour(T.single(['a', 'b'], 'a'), 'a', 1).tree.k, 'g', 'one pane: nothing to move to');
});

test('Ctrl+1..9 focus the nth pane in reading order', () => {
  let L = T.single(['a', 'b', 'c'], 'a');
  L = T.drop(L, 'b', firstId(L), 'right');
  L = T.drop(L, 'c', T.holder(L.tree, 'b').id, 'bottom');
  assert.equal(T.focusIndex(L, 1).focus, T.holder(L.tree, 'a').id);
  assert.equal(T.focusIndex(L, 2).focus, T.holder(L.tree, 'b').id);
  assert.equal(T.focusIndex(L, 3).focus, T.holder(L.tree, 'c').id);
  assert.equal(T.focusIndex(L, 4), L, 'no fourth pane');
});

test('minimum pane size: a split that would go below 360 x 200 is not offered', () => {
  const rect = (w, h) => ({ left: 100, top: 50, width: w, height: h });
  assert.equal(T.MIN_W, 360);
  assert.equal(T.MIN_H, 200);
  assert.equal(T.canSplit(rect(720, 600), 'right'), true);
  assert.equal(T.canSplit(rect(719, 600), 'right'), false);
  assert.equal(T.canSplit(rect(900, 400), 'bottom'), true);
  assert.equal(T.canSplit(rect(900, 399), 'bottom'), false);
  assert.equal(T.canSplit(rect(10, 10), 'center'), true);
  // zoneAt: near the right edge of a wide pane splits, of a narrow pane it falls back to a tab
  assert.equal(T.zoneAt(rect(1000, 700), 100 + 960, 300), 'right');
  assert.equal(T.zoneAt(rect(600, 700), 100 + 570, 300), 'center');
  assert.equal(T.zoneAt(rect(1000, 700), 100 + 500, 50 + 20), 'top');
  assert.equal(T.zoneAt(rect(1000, 380), 100 + 500, 50 + 360), 'center', 'too short to stack');
});

test('drop zones: the middle is a tab, the edges are splits, the nearest edge wins in a corner', () => {
  const r = { left: 0, top: 0, width: 1000, height: 1000 };
  assert.equal(T.zoneAt(r, 500, 500), 'center');
  assert.equal(T.zoneAt(r, 20, 500), 'left');
  assert.equal(T.zoneAt(r, 980, 500), 'right');
  assert.equal(T.zoneAt(r, 500, 20), 'top');
  assert.equal(T.zoneAt(r, 500, 980), 'bottom');
  assert.equal(T.zoneAt(r, 100, 50), 'top', 'closer to the top edge than the left');
  assert.equal(T.zoneAt(r, 50, 100), 'left');
  assert.equal(T.zoneAt(r, 310, 500), 'center', 'just outside the edge band');
  assert.deepEqual(T.hintRect('right'), { x: 0.5, y: 0, w: 0.5, h: 1 });
  assert.deepEqual(T.hintRect('center'), { x: 0, y: 0, w: 1, h: 1 });
});

test('the insertion line sits before the first tab whose middle is right of the pointer', () => {
  assert.equal(T.tabIndexAt([50, 150, 250], 10), 0);
  assert.equal(T.tabIndexAt([50, 150, 250], 100), 1);
  assert.equal(T.tabIndexAt([50, 150, 250], 400), 3);
  assert.equal(T.tabIndexAt([], 5), 0);
});

test('dividers: dragging moves the share between the two neighbours and respects the minimum', () => {
  const L = two(),
    s = L.tree.id;
  const r = T.resize(L, s, 1, 500, 1000, 360, 360);
  assert.equal(Math.round(r.tree.ch[0].f * 100) / 100, 1); // 500 of 1000: still half
  const wide = T.resize(L, s, 1, 700, 1000, 360, 360);
  assert.ok(wide.tree.ch[0].f > wide.tree.ch[1].f);
  assert.ok(Math.abs(wide.tree.ch[0].f + wide.tree.ch[1].f - 2) < 1e-9, 'the total share is kept');
  const clampedLow = T.resize(L, s, 1, 100, 1000, 360, 360);
  assert.ok(
    Math.abs(clampedLow.tree.ch[0].f / (clampedLow.tree.ch[0].f + clampedLow.tree.ch[1].f) - 0.36) < 1e-9,
    'not under 360 px',
  );
  const clampedHigh = T.resize(L, s, 1, 990, 1000, 360, 360);
  assert.ok(Math.abs(clampedHigh.tree.ch[1].f / (clampedHigh.tree.ch[0].f + clampedHigh.tree.ch[1].f) - 0.36) < 1e-9);
  assert.equal(T.resize(L, s, 1, 400, 600, 360, 360), L, 'no room to move at all');
  assert.equal(T.resize(L, 'nope', 1, 400, 1000, 0, 0), L);
});

test('double-click on a divider evens the panes out', () => {
  const L = two(),
    s = L.tree.id;
  const dragged = T.resize(L, s, 1, 800, 1000, 360, 360);
  assert.notEqual(dragged.tree.ch[0].f, dragged.tree.ch[1].f);
  const even = T.evenOut(dragged, s);
  assert.equal(even.tree.ch[0].f, 1);
  assert.equal(even.tree.ch[1].f, 1);
});

test('the layout is never changed in place', () => {
  const L = two(),
    before = JSON.stringify(L);
  T.drop(L, 'c', firstId(L), 'center');
  T.removeTab(L, 'a');
  T.splitGroup(L, firstId(L), 'col');
  T.resize(L, L.tree.id, 1, 700, 1000, 100, 100);
  T.evenOut(L, L.tree.id);
  T.openTab(L, 'zz');
  T.reconcile(L, { valid: new Set(['a']) });
  assert.equal(JSON.stringify(L), before);
});

test('focusing, activating and renaming', () => {
  const L = two(),
    r = lastId(L);
  assert.equal(T.focusGroup(L, r).focus, r);
  assert.equal(T.focusGroup(L, 'nope'), L);
  const act = T.setActive(L, firstId(L), 'b');
  assert.equal(T.groups(act.tree)[0].active, 'b');
  assert.equal(T.setActive(L, firstId(L), 'zz'), L);
  const ren = T.rename(L, 'b', 'b2');
  assert.deepEqual(T.groups(ren.tree)[0].tabs, ['a', 'b2']);
  assert.equal(T.rename(L, 'zz', 'y'), L);
});

test('openTab: a chat that is in a pane focuses that pane; any other joins the focused pane after its active tab', () => {
  const L = two();
  const seen = T.openTab(L, 'c');
  assert.equal(T.focused(seen).active, 'c');
  assert.equal(T.focused(seen).id, lastId(L));
  const joined = T.openTab(L, 'n');
  assert.deepEqual(T.groups(joined.tree)[0].tabs, ['a', 'n', 'b']);
  assert.equal(T.focused(joined).active, 'n');
  assert.equal(T.tabsFlat(joined).filter((t) => t === 'n').length, 1);
});

test('the New chat tab: one at a time, in the focused pane, replaced by the chat once it has a key', () => {
  let L = two();
  L = T.openDraft(L);
  assert.deepEqual(T.groups(L.tree)[0].tabs, ['a', 'b', T.DRAFT]);
  assert.equal(T.focused(L).active, T.DRAFT);
  const moved = T.openDraft({ ...L, focus: lastId(L) });
  assert.equal(T.tabsFlat(moved).filter((t) => t === T.DRAFT).length, 1);
  const real = T.openTab(L, 'new1');
  assert.deepEqual(T.groups(real.tree)[0].tabs, ['a', 'b', 'new1']);
  const away = T.openTab(L, 'c');
  assert.equal(T.tabsFlat(away).includes(T.DRAFT), false, 'opening another chat throws the draft away');
});

test('reconcile drops chats that are gone, adds new tabs to the focused pane and keeps the draft in step', () => {
  const L = two();
  const r = T.reconcile(L, { valid: new Set(['a', 'c', 'd']), allowed: new Set(['a', 'c', 'd']), add: ['d', 'a'] });
  assert.deepEqual(
    T.groups(r.tree).map((g) => g.tabs),
    [['a', 'd'], ['c']],
  );
  const d = T.reconcile(L, { draft: true });
  assert.equal(T.tabsFlat(d).includes(T.DRAFT), true);
  const none = T.reconcile(d, { draft: false });
  assert.equal(T.tabsFlat(none).includes(T.DRAFT), false);
  assert.equal(T.reconcile(L, { valid: new Set(['zz']) }), null, 'nothing left');
  const unknown = T.reconcile(L, { valid: null });
  assert.deepEqual(tabsOfGroups(unknown), ['a+b', 'c'], 'unknown validity keeps everything');
});

test("restoreKey is the focused pane's chat, never the New chat tab", () => {
  const L = two();
  assert.equal(T.restoreKey(L), 'a');
  assert.equal(T.restoreKey(T.openDraft(L)), '');
});

test('persistence: a layout survives a round trip through storage JSON', () => {
  let L = T.single(['a', 'b', 'c'], 'b');
  L = T.drop(L, 'c', firstId(L), 'right');
  L = T.drop(L, 'b', T.holder(L.tree, 'c').id, 'bottom');
  L = T.resize(L, L.tree.id, 1, 700, 1000, 100, 100);
  const store = T.putLayout(T.emptyStore(), 'w:proj', L);
  const back = T.sanitizeStore(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(tabsOfGroups(back.layouts['w:proj']), tabsOfGroups(L));
  assert.equal(back.layouts['w:proj'].focus, L.focus);
  assert.equal(T.shape(back.layouts['w:proj']), T.shape(L));
  assert.equal(T.focused(back.layouts['w:proj']).active, T.focused(L).active);
  assert.equal(back.layouts['w:proj'].tree.ch[0].f, L.tree.ch[0].f, 'the sizes come back');
});

test('persistence: each project and All chats keep their own layout; one pane is not stored', () => {
  let store = T.emptyStore();
  store = T.putLayout(store, 'w:one', two());
  store = T.putLayout(store, 'all', two());
  assert.deepEqual(Object.keys(store.layouts).sort(), ['all', 'w:one']);
  assert.equal(T.getLayout(store, 'w:two'), null);
  store = T.putLayout(store, 'w:one', T.single(['a'], 'a'));
  assert.deepEqual(Object.keys(store.layouts), ['all'], 'a single pane is forgotten');
});

test('persistence: damaged storage never breaks the page', () => {
  assert.deepEqual(T.sanitizeStore(null), T.emptyStore());
  assert.deepEqual(T.sanitizeStore('x'), T.emptyStore());
  assert.deepEqual(T.sanitizeStore({ v: 1, layouts: [] }), T.emptyStore());
  const bad = T.sanitizeStore({
    v: 1,
    layouts: {
      one: { tree: { k: 'g', id: 'g1', tabs: ['a'], active: 'a' }, focus: 'g1' }, // one pane: not a layout
      two: {
        tree: {
          k: 's',
          id: 's1',
          dir: 'row',
          ch: [
            { k: 'g', id: 'g1', tabs: ['a', 'b'], active: 'q' },
            { k: 'g', id: 'g1', tabs: ['b', 'c'], active: 'c' },
          ],
        },
        focus: 'zz',
      },
      junk: { tree: { k: 'x' }, focus: 1 },
      empty: { tree: { k: 's', ch: [] } },
    },
  });
  assert.deepEqual(Object.keys(bad.layouts), ['two']);
  const two_ = bad.layouts.two,
    ids = T.groups(two_.tree).map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length, 'repeated ids are made unique');
  assert.deepEqual(tabsOfGroups(two_), ['a+b', 'c'], 'a chat in two panes keeps its first place');
  assert.equal(T.focused(two_).id, ids[0], 'an unknown focus falls back to the first pane');
  assert.equal(T.focused(two_).active, 'a', 'an unknown active tab falls back to the first tab');
  const draft = T.sanitizeStore({
    v: 1,
    layouts: {
      p: {
        tree: {
          k: 's',
          id: 's1',
          dir: 'col',
          ch: [
            { k: 'g', id: 'g1', tabs: ['a', T.DRAFT], active: T.DRAFT },
            { k: 'g', id: 'g2', tabs: ['b'], active: 'b' },
          ],
        },
        focus: 'g1',
      },
    },
  });
  assert.deepEqual(tabsOfGroups(draft.layouts.p), ['a', 'b'], 'the New chat tab is never stored');
});

test('persistence: read and write go through the storage object and survive it failing', () => {
  const mem = new Map(),
    storage = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => {
        mem.set(k, v);
      },
    };
  assert.deepEqual(T.read(storage), T.emptyStore());
  const store = T.putLayout(T.emptyStore(), 'all', two());
  assert.equal(T.write(storage, store), true);
  assert.equal(mem.has(T.STORE), true);
  assert.deepEqual(Object.keys(T.read(storage).layouts), ['all']);
  assert.equal(
    T.write(
      {
        setItem() {
          throw new Error('full');
        },
      },
      store,
    ),
    false,
  );
  assert.deepEqual(
    T.read({
      getItem() {
        throw new Error('blocked');
      },
    }),
    T.emptyStore(),
  );
  mem.set(T.STORE, '{not json');
  assert.deepEqual(T.read(storage), T.emptyStore());
});

test('shape changes with the arrangement of panes, not with tabs or sizes', () => {
  const L = two(),
    s0 = T.shape(L);
  assert.equal(T.shape(T.resize(L, L.tree.id, 1, 700, 1000, 0, 0)), s0);
  assert.equal(T.shape(T.drop(L, 'a', lastId(L), 'tabs', 0)), T.shape(T.drop(L, 'a', lastId(L), 'tabs', 0)));
  assert.notEqual(T.shape(T.drop(L, 'a', lastId(L), 'bottom')), s0);
  assert.notEqual(T.shape(T.focusGroup(L, lastId(L))), s0, 'focus is part of the shape');
});

test('there is a ceiling on the number of panes', () => {
  let L = T.single(['t0'], 't0');
  for (let i = 1; i < 40; i++) L = T.drop(L, 'x' + i, T.groups(L.tree)[0].id, i % 2 ? 'right' : 'bottom');
  assert.equal(T.countGroups(L), T.MAX_GROUPS);
});
