'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const R = require(path.join(APP_DIR, 'resize-ui.js'));

test('bucket key separates laptop and big-monitor layouts', () => {
  assert.equal(R.bucketKey(1399), '<1400');
  assert.equal(R.bucketKey(1400), '<1800');
  assert.equal(R.bucketKey(1799), '<1800');
  assert.equal(R.bucketKey(1800), '>=1800');
  assert.equal(R.bucketKey(3840), '>=1800');
  assert.equal(R.storageKey(1440), 'studio-layout-v1:<1800');
});
test('clamp keeps values inside and survives a reversed range', () => {
  assert.equal(R.clamp(5, 10, 20), 10);
  assert.equal(R.clamp(25, 10, 20), 20);
  assert.equal(R.clamp(15, 10, 20), 15);
  assert.equal(R.clamp(5, 10, 3), 10);
});
test('side panel limits leave 420 px for the chat', () => {
  assert.equal(R.maxSide(1920, 280), 480); // the chat list stops at 480 px (QA m13)
  assert.equal(R.maxSide(1000, 280), 300);
  assert.equal(R.maxSide(1100, 280), 400);
  assert.equal(R.maxSide(900, 280), 200);
  assert.equal(R.maxActivity(1920, 240), 1260);
  assert.equal(R.maxActivity(1200, 240), 540);
  assert.equal(R.maxActivity(800, 240), 220);
});
test('dragging 40 px or more under the minimum collapses; less stays at the minimum', () => {
  assert.deepEqual(R.dragResult(300, 200, 480, true), { collapsed: false, size: 300 });
  assert.deepEqual(R.dragResult(165, 200, 480, true), { collapsed: false, size: 200 });
  assert.deepEqual(R.dragResult(160, 200, 480, true), { collapsed: false, size: 200 });
  assert.equal(R.dragResult(159, 200, 480, true).collapsed, true);
  assert.equal(R.dragResult(0, 200, 480, true).collapsed, true);
  assert.deepEqual(R.dragResult(900, 200, 480, true), { collapsed: false, size: 480 });
  assert.deepEqual(R.dragResult(10, 56, 400, false), { collapsed: false, size: 56 });
});
test('arrow keys move 16 px, Shift 64, Home/End jump, Enter resets', () => {
  const o = { value: 240, min: 200, max: 480, def: 240, axis: 'x', inverted: false };
  assert.equal(R.keyStep('ArrowRight', o), 256);
  assert.equal(R.keyStep('ArrowLeft', o), 224);
  assert.equal(R.keyStep('ArrowRight', { ...o, shift: true }), 304);
  assert.equal(R.keyStep('ArrowLeft', { ...o, shift: true }), 200);
  assert.equal(R.keyStep('Home', o), 200);
  assert.equal(R.keyStep('End', o), 480);
  assert.equal(R.keyStep('Enter', { ...o, value: 300 }), 240);
  assert.equal(R.keyStep('ArrowUp', o), null);
  assert.equal(R.keyStep('a', o), null);
  assert.equal(R.keyStep('ArrowRight', { ...o, value: 476 }), 480);
});
test('inverted handles (Activity left edge, message box top edge) grow the other way', () => {
  const act = { value: 280, min: 220, max: 600, def: 280, axis: 'x', inverted: true };
  assert.equal(R.keyStep('ArrowLeft', act), 296);
  assert.equal(R.keyStep('ArrowRight', act), 264);
  const box = { value: 100, min: 56, max: 450, def: 56, axis: 'y', inverted: true };
  assert.equal(R.keyStep('ArrowUp', box), 116);
  assert.equal(R.keyStep('ArrowDown', box), 84);
  assert.equal(R.keyStep('ArrowLeft', box), null);
  const split = { value: 200, min: 96, max: 500, def: 200, axis: 'y', inverted: false };
  assert.equal(R.keyStep('ArrowDown', split), 216);
});
test('layout defaults, user widths, and a hidden panel', () => {
  assert.deepEqual(R.computeLayout({ vw: 1440, sideOn: true, actOn: true }), { side: 240, activity: 280 });
  assert.deepEqual(R.computeLayout({ vw: 1920, side: 400, activity: 500, sideOn: true, actOn: true }), {
    side: 400,
    activity: 500,
  });
  assert.deepEqual(R.computeLayout({ vw: 1440, side: 400, activity: 500, sideOn: false, actOn: true }), {
    side: 0,
    activity: 500,
  });
  assert.deepEqual(R.computeLayout({ vw: 1440, side: 400, activity: 500, sideOn: true, actOn: false }), {
    side: 400,
    activity: 0,
  });
  assert.deepEqual(R.computeLayout({ vw: 1440, side: 9999, activity: 1, sideOn: true, actOn: true }), {
    side: 480,
    activity: 220,
  });
});
test('side panels yield before the chat drops under 420 px', () => {
  for (const vw of [1100, 1150, 1280, 1366, 1440, 1600]) {
    const r = R.computeLayout({ vw, side: 480, activity: 600, sideOn: true, actOn: true });
    assert.ok(vw - r.side - r.activity >= 420, vw + ' ' + JSON.stringify(r));
    assert.ok(r.side >= 200 && r.activity >= 220, String(vw));
  }
});
test('a subagent history widens Activity to max(your width, 480) within the room', () => {
  assert.equal(R.computeLayout({ vw: 1920, activity: 280, sideOn: true, actOn: true, subchat: true }).activity, 480);
  assert.equal(R.computeLayout({ vw: 1920, activity: 550, sideOn: true, actOn: true, subchat: true }).activity, 550);
  assert.equal(
    R.computeLayout({ vw: 1440, activity: 280, side: 240, sideOn: true, actOn: true, subchat: true }).activity,
    480,
  );
  const tight = R.computeLayout({ vw: 1100, activity: 280, side: 240, sideOn: true, actOn: true, subchat: true });
  assert.equal(tight.activity, 1100 - 240 - 420);
  assert.ok(1100 - tight.side - tight.activity >= 420);
  assert.equal(R.computeLayout({ vw: 1440, activity: 280, sideOn: true, actOn: true, subchat: false }).activity, 280);
  assert.equal(R.computeLayout({ vw: 1440, activity: 280, sideOn: true, actOn: false, subchat: true }).activity, 0);
});
test('Changes expanded widens Activity to about 60% of the window, never squeezing the chat below its minimum', () => {
  assert.equal(R.computeLayout({ vw: 1920, activity: 280, sideOn: true, actOn: true, expand: true }).activity, 1152);
  assert.equal(R.computeLayout({ vw: 1920, activity: 280, sideOn: true, actOn: true, expand: false }).activity, 280);
  const tight = R.computeLayout({ vw: 1200, activity: 280, sideOn: true, actOn: true, expand: true });
  assert.ok(1200 - tight.side - tight.activity >= 420 && tight.activity >= 280, JSON.stringify(tight));
  assert.equal(R.computeLayout({ vw: 1920, activity: 280, sideOn: true, actOn: false, expand: true }).activity, 0);
});
test('message box: floor 56, no fixed ceiling (about 200 px of the window stay free), typing grows up to the cap', () => {
  assert.equal(R.clampComposer(10, 900), 56);
  assert.equal(R.clampComposer(300, 900), 300);
  assert.equal(R.clampComposer(800, 900), 700);
  assert.equal(R.composerMax(900), 700);
  assert.equal(R.composerMax(60), 56);
  assert.equal(R.growCap(null, 900), 200);
  assert.equal(R.growCap(300, 900), 300);
  assert.equal(R.growCap(700, 900), 700);
  assert.equal(R.growCap(null, 300), 100);
});
test('Subagents/Processes split keeps 96 px each', () => {
  assert.deepEqual(R.splitBounds(500), { min: 96, max: 404 });
  assert.equal(R.clampSplit(10, 500), 96);
  assert.equal(R.clampSplit(450, 500), 404);
  assert.deepEqual(R.splitBounds(150), { min: 96, max: 96 });
});
test('stored sizes: junk becomes defaults', () => {
  assert.deepEqual(R.sanitize('{"side":300.4,"activity":"x","composer":-5,"split":120}'), {
    side: 300,
    activity: null,
    composer: null,
    split: 120,
  });
  assert.deepEqual(R.sanitize('not json'), { side: null, activity: null, composer: null, split: null });
  assert.deepEqual(R.sanitize(null), { side: null, activity: null, composer: null, split: null });
});

test('QA M3/m13: the chat list stops at 480 px; split panes side by side raise the chat column floor', () => {
  assert.equal(R.SIDE.max, 480);
  assert.deepEqual(R.computeLayout({ vw: 1440, side: 724, activity: 280, sideOn: true, actOn: true }), {
    side: 480,
    activity: 280,
  });
  // Two panes across need 725 px: the chat list and Activity give way before the panes shrink.
  const two = R.computeLayout({ vw: 1440, side: 480, activity: 400, sideOn: true, actOn: true, minChat: 725 });
  assert.ok(1440 - two.side - two.activity >= 725, JSON.stringify(two));
  assert.equal(R.maxSide(1440, 280, 1, 725), 435);
  assert.equal(R.maxActivity(1440, 240, 1, 725), 475);
  // A floor under MIN_CHAT changes nothing.
  assert.equal(R.maxSide(1100, 280, 1, 100), R.maxSide(1100, 280));
});
