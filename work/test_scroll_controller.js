'use strict';
/* The scroll controller (scroll-controller.js) on a small fake layout: a list of rows with heights, a scrollTop the "browser"
   clamps, and observers the test fires by hand (the ResizeObserver after layout, the MutationObserver on child changes).
   Covers every row of the design's table "What changes the state" (outputs/scroll-architecture 2.3): only you change the state;
   redraws, resizes, zoom, clamping and the controller's own writes never do. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { SC, TOP, Row, setup, rows } = require('./scroll_fake.js');

test('following: a redraw that adds rows keeps the list at its end; data-paused is off', () => {
  const { box, ctl } = setup(rows(20));
  ctl.afterRedraw();
  assert.equal(box.gap, 0);
  box.add('L:21', 300);
  ctl.afterRedraw();
  assert.equal(box.gap, 0);
  assert.equal(box.dataset.paused, undefined);
  assert.ok(box.classes.has('scroll-list'), 'the list is marked (overflow-anchor: none in CSS)');
});

test('a scroll you make (not the controller) anchors on the row at the top; at the very bottom it follows again', () => {
  const { box, ctl, changes } = setup(rows(20));
  ctl.afterRedraw();
  box.userScroll(730); // row L:8 starts at 700: 30 px of it are above the view
  assert.equal(ctl.state.mode, 'anchor');
  assert.equal(ctl.state.rid, 'L:8');
  assert.equal(ctl.state.off, -30);
  assert.equal(box.dataset.paused, '1');
  assert.deepEqual(changes.at(-1), ['follow', 'anchor', 'user']);
  box.add('L:21', 400);
  ctl.afterRedraw();
  assert.equal(box.scrollTop, 730, 'new rows below do not move what you read');
  box.userScroll(box.scrollHeight - box.clientHeight - 1); // 1 px short of the end: the end
  assert.equal(ctl.following, true);
  assert.deepEqual(changes.at(-1), ['anchor', 'follow', 'user']);
});

test("the controller's own writes and the browser re-stating them are never taken as you", () => {
  const { box, ctl, changes } = setup(rows(20));
  ctl.afterRedraw();
  box.add('L:21', 300);
  ctl.afterRedraw();
  box.fire('scroll'); // the event for the controller's own write arrives a frame later
  assert.equal(ctl.following, true);
  box._top += 1; // rounding at 150 % zoom
  box.fire('scroll');
  assert.equal(ctl.following, true);
  assert.equal(changes.length, 0);
});

test('a clamp (the content got shorter under you at the end) is layout, not you', () => {
  const { box, ctl, ro } = setup(rows(20));
  box.userScroll(1450); // 50 px above the end
  assert.equal(ctl.state.rid, 'L:15');
  box.children[19].h = 20; // the last row is clamped: the list is 80 px shorter, the browser clamps scrollTop
  box.layout();
  ro.fire();
  assert.equal(ctl.state.mode, 'anchor', 'still reading');
  assert.equal(ctl.state.rid, 'L:15', 'still the same row');
  box.fire('scroll'); // the clamp's own scroll event, a frame later
  assert.equal(ctl.state.rid, 'L:15');
});

test('a zoom or a shorter list (the list itself resized and the browser moved scrollTop) is layout, not you', () => {
  const { box, ctl, ro } = setup(rows(30));
  ctl.afterRedraw();
  box.clientHeight = 420; // a card pinned below / interface zoom: the list is shorter and the browser moved the position
  box._top -= 35;
  ro.fire();
  assert.equal(ctl.following, true, 'a following list keeps following');
  assert.equal(box.gap, 0, 'and is at its end again before paint');
  box.userScroll(1000);
  const at = ctl.state.rid;
  box.clientHeight = 380;
  box._top += 20;
  ro.fire();
  assert.equal(ctl.state.rid, at, 'a reading list keeps its row');
  assert.equal(box.topOf(at), 0, 'at the same place');
});

test('rows that re-wrap after a width change keep the line you were on (negative offsets scale with the row height)', () => {
  const { box, ctl, ro } = setup(rows(20));
  box.userScroll(750); // L:8 at -50 of its 100 px: you read its middle
  box.clientWidth = 400;
  for (const r of box.children) r.h *= 2; // half the width: every row twice as tall
  ro.fire();
  assert.equal(box.topOf('L:8'), -100, 'the middle of the row is still at the top');
  box.clientWidth = 800;
  for (const r of box.children) r.h /= 2;
  ro.fire();
  assert.equal(box.topOf('L:8'), -50, 'and back');
});

test('a row that grows at the same width (you opened something in it) keeps its top, it is not rescaled', () => {
  const { box, ctl, ro } = setup(rows(20));
  box.userScroll(750);
  box.children[7].h = 400;
  ro.fire();
  assert.equal(box.topOf('L:8'), -50);
});

test('rows growing or shrinking above you (pictures loading, clamping) never move the row you read', () => {
  const { box, ctl, ro } = setup(rows(20));
  box.userScroll(1000);
  box.children[2].h = 230; // a picture above loaded
  box.children[5].h = 40; // a block above was clamped
  ro.fire();
  assert.equal(box.topOf('L:11'), 0);
  assert.equal(ctl.state.rid, 'L:11');
});

test('an anchor on a row a fold hides puts the fold there; the state keeps the real row, so it comes back exactly', () => {
  const { box, ctl } = setup(rows(20));
  box.userScroll(1000); // L:11 at the top
  const real = box.children.slice(8, 14); // L:9..L:14 fold into "6 steps"
  const at = box.children.indexOf(real[0]);
  box.children.splice(at, real.length);
  const fold = box.add('', 40, { ridFrom: 'L:9', ridTo: 'L:14' });
  box.children.pop();
  box.children.splice(at, 0, fold);
  ctl.afterRedraw();
  assert.equal(ctl.state.rid, 'L:11', 'the state is untouched by a redraw');
  assert.equal(fold.getBoundingClientRect().top - TOP, 0, 'the fold is where the row was');
  box.children.splice(at, 1, ...real); // back to the full view
  ctl.afterRedraw();
  assert.equal(box.topOf('L:11'), 0);
});

test('a row that is not drawn at all falls back to the nearest drawn row, earlier first; another kind of id keeps the pixels', () => {
  const { box, ctl } = setup(rows(20));
  box.userScroll(1000);
  box.children.splice(10, 1); // L:11 gone
  ctl.afterRedraw();
  assert.equal(box.topOf('L:10'), 0);
  const saved = setup(rows(20), { prefix: 'T:' });
  saved.ctl._set({ mode: 'anchor', rid: 'L:5', off: 0, h: 100, w: 800 }, 'test');
  saved.box._top = 333;
  saved.ctl.afterRedraw();
  assert.equal(saved.box.scrollTop, 333, 'a live id in a saved list: no jump');
});

test('with nothing to scroll and the anchored row drawn, the list follows (there is no place to keep)', () => {
  const { box, ctl, changes } = setup(rows(20));
  box.userScroll(300); // L:4 at the top
  box.children.splice(4); // only L:1..L:4 left: 400 px in a 500 px list
  box.layout();
  ctl.afterRedraw();
  assert.equal(ctl.following, true);
  assert.deepEqual(changes.at(-1), ['anchor', 'follow', 'fits']);
});

test('wheel up, PageUp, Home, Shift+Space and a downward touch stop following at once, before the list moves', () => {
  for (const fire of [
    (b) => b.fire('wheel', { deltaY: -100 }),
    (b) => b.fire('keydown', { key: 'PageUp', target: { closest: () => null } }),
    (b) => b.fire('keydown', { key: 'Home', target: { closest: () => null } }),
    (b) => b.fire('keydown', { key: ' ', shiftKey: true, target: { closest: () => null } }),
    (b) => {
      b.fire('touchstart', { touches: [{ clientY: 100 }] });
      b.fire('touchmove', { touches: [{ clientY: 140 }] });
    },
  ]) {
    const { box, ctl } = setup(rows(20));
    ctl.afterRedraw();
    fire(box);
    assert.equal(ctl.state.mode, 'anchor');
    box.add('L:21', 300);
    ctl.afterRedraw();
    assert.equal(box.scrollTop, 1500, 'an update in between does not pull you down');
  }
  const { box, ctl } = setup(rows(20));
  ctl.afterRedraw();
  box.fire('wheel', { deltaY: 100 });
  box.fire('keydown', { key: 'PageUp', target: { closest: () => ({}) } }); // typing in a box inside the list
  assert.equal(ctl.following, true, 'wheel down and keys in a text box change nothing');
  const short = setup(rows(2));
  short.box.fire('wheel', { deltaY: -100 });
  assert.equal(short.ctl.following, true, 'a list with nothing to scroll never stops following');
});

test('opening something you clicked keeps that row where you clicked it; closing and other buttons change nothing', () => {
  const { box, ctl, ro } = setup(rows(20));
  ctl.afterRedraw();
  const row = box.children[18],
    toggle = { tagName: 'BUTTON', parentElement: row, attrs: { 'aria-expanded': 'false' } };
  toggle.getAttribute = (k) => toggle.attrs[k] ?? null;
  toggle.closest = (sel) => (sel.includes('aria-expanded') ? toggle : null);
  const at = box.topOf('L:19');
  box.fire('click', { target: toggle });
  assert.equal(ctl.state.rid, 'L:19');
  row.h = 900; // the step opened
  ro.fire();
  assert.equal(box.topOf('L:19'), at, 'the step stays where you clicked');
  box.add('L:21', 200);
  ctl.afterRedraw();
  assert.equal(box.topOf('L:19'), at, 'also when the next update arrives');
  const open = setup(rows(20));
  open.ctl.afterRedraw();
  const t2 = { tagName: 'BUTTON', parentElement: open.box.children[18], getAttribute: () => 'true', closest: () => t2 };
  open.box.fire('click', { target: t2 });
  assert.equal(open.ctl.following, true, 'closing changes nothing');
  const link = { tagName: 'A', parentElement: open.box.children[18], closest: () => null };
  open.box.fire('click', { target: link });
  assert.equal(open.ctl.following, true, 'Open doc, links: nothing');
});

test('anchorTo puts an element at an offset (the New line, a find hit); past the end it follows', () => {
  const { box, ctl } = setup(rows(20));
  ctl.afterRedraw();
  const line = box.children[9];
  ctl.anchorTo(line, 12, 'line');
  assert.equal(box.topOf('L:10'), 12);
  assert.equal(ctl.state.rid, 'L:10');
  ctl.anchorTo(box.children[18], 12, 'line');
  assert.equal(ctl.following, true, 'short unread part: the end');
  ctl.anchorTop('earlier');
  assert.equal(ctl.state.mode, 'anchor');
  ctl.follow('jump');
  assert.equal(box.gap, 0);
});

test('a scroll you made that the browser has not reported yet is taken before a redraw (beforeRedraw)', () => {
  const { box, ctl } = setup(rows(20));
  ctl.afterRedraw();
  box._top = 600; // your scrollbar drag moved it; the scroll event comes next frame
  ctl.beforeRedraw();
  box.add('L:21', 300);
  ctl.afterRedraw();
  assert.equal(box.scrollTop, 600);
  assert.equal(ctl.state.rid, 'L:7');
});

test('a hidden list keeps its state; shown again (the browser reset its position) it is put back, not taken as you', () => {
  const { box, ctl, ro } = setup(rows(20));
  box.userScroll(800);
  box.clientHeight = 0;
  ro.fire([{ target: box, contentRect: { width: 0, height: 0 } }]);
  box._top = 0;
  box.fire('scroll');
  box.clientHeight = 500;
  ro.fire([{ target: box, contentRect: { width: 800, height: 500 } }]);
  assert.equal(ctl.state.rid, 'L:9');
  assert.equal(box.scrollTop, 800);
  ctl.reattached(); // moved in the page (split view): the same
  assert.equal(box.scrollTop, 800);
});

test('switchTo keeps one place per key and loads the fallback for a key it never saw', () => {
  const { box, ctl } = setup(rows(20), { role: 'sub' });
  ctl.switchTo('child-1');
  ctl.afterRedraw(); // the drawer applies a switch once it drew the new rows
  box.userScroll(700);
  const first = ctl.state;
  assert.equal(first.rid, 'L:8');
  ctl.switchTo('child-2', () => SC.FOLLOW);
  ctl.afterRedraw();
  assert.equal(ctl.following, true, 'another subagent opens following');
  assert.equal(box.gap, 0);
  assert.equal(box.dataset.paused, undefined);
  ctl.switchTo('child-1');
  ctl.afterRedraw();
  assert.deepEqual(ctl.state, first, 'back where you were');
  assert.equal(box.scrollTop, 700);
  assert.equal(SC.store.get('sub:child-1'), first);
});

test('"Show earlier": rows added above do not move the row under the button', () => {
  const { box, ctl } = setup(rows(20));
  box.userScroll(0);
  ctl.anchorTop('earlier');
  const before = box.topOf('L:1');
  for (let i = 0; i < 5; i++) box.children.unshift(new Row(box, { rid: 'L:0.' + i }, 120));
  ctl.afterRedraw();
  assert.equal(box.topOf('L:1'), before);
});

test('removing rows outside a redraw (the New line going) re-applies through the MutationObserver', () => {
  const { box, ctl, mo } = setup(rows(20));
  box.userScroll(1000);
  const gone = box.children.splice(4, 1)[0];
  gone.parentNode = null;
  mo.fire([{ addedNodes: [], removedNodes: [gone] }]);
  assert.equal(box.topOf('L:11'), 0);
});

test('the side pane grows its window when you near the top (nearTop), only on your own scroll', () => {
  let grown = 0;
  const { box, ctl } = setup(rows(20), { nearTop: { px: 200, fn: () => grown++ } });
  ctl.afterRedraw();
  box.userScroll(150);
  assert.equal(grown, 1);
  ctl.anchorTo(box.children[0], 0, 'x');
  assert.equal(grown, 1);
});

test('anchorIndex: where the anchored row is among the rows a list could draw (to keep it inside the drawn window)', () => {
  const { box, ctl } = setup(rows(20));
  assert.equal(ctl.anchorIndex(['L:1', 'L:2']), -1, 'following');
  box.userScroll(1000);
  assert.equal(ctl.anchorIndex(['L:5', 'L:9', 'L:11', 'L:30']), 2);
  assert.equal(ctl.anchorIndex(['L:5', 'L:9', 'L:12']), 1, 'not there: the nearest earlier one');
});

test('the main lists persist their places (newest 200) through a storage key; a fresh page loads them back', () => {
  const data = new Map();
  const storage = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => data.set(k, String(v)) };
  SC.configure({ storage, storageKey: 'studio-scroll-v1', max: 3 });
  const { box, ctl } = setup(rows(20), { role: 'main' });
  for (const k of ['a', 'b', 'c', 'd']) ctl.switchTo('claude:' + k);
  ctl.afterRedraw();
  box.userScroll(900);
  SC.saveNow();
  const saved = JSON.parse(data.get('studio-scroll-v1'));
  assert.deepEqual(Object.keys(saved), ['main:claude:b', 'main:claude:c', 'main:claude:d'], 'the newest three');
  assert.equal(saved['main:claude:d'].rid, 'L:10');
  assert.ok(!Object.keys(saved).some((k) => k.startsWith('sub:')), 'only the chats');
  SC.store.clear();
  SC.configure({ storage, storageKey: 'studio-scroll-v1', max: 3 });
  assert.equal(SC.store.get('main:claude:d').rid, 'L:10');
  data.set('studio-scroll-v1', '{"main:x":{"mode":"anchor","rid":5},"main:y":{"mode":"follow"}}');
  SC.store.clear();
  SC.configure({ storage, storageKey: 'studio-scroll-v1', max: 3 });
  assert.equal(SC.store.has('main:x'), false, 'a bad entry is dropped');
  assert.equal(SC.store.get('main:y').mode, 'follow');
});

test('row ids order by their number; sends not shown yet come last', () => {
  assert.ok(SC.orderOf('L:9') < SC.orderOf('L:10'));
  assert.ok(SC.orderOf('P:1') > SC.orderOf('L:999999'));
  assert.equal(SC.kindOf('T:4'), 'T');
  assert.equal(SC.kindOf('x'), '');
});
