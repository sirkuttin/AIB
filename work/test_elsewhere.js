'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');

function load() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'ownership-ui.js'), 'utf8'), {
    window,
    document: {},
    Object,
    Array,
    String,
    Promise,
    Error,
    Map,
    Set,
  });
  return window.AgentOwnershipUI;
}
const hint = (verdict) => ({ verdict, reasons: [{ text: 'evidence for ' + verdict }] });

test('stabilizer: a value changes only after two agreeing checks', () => {
  const s = load().makeStabilizer();
  assert.equal(s.observe('k', 'a'), 'a'); // first sight is trusted
  assert.equal(s.observe('k', 'b'), 'a'); // one dissent: no change
  assert.equal(s.observe('k', 'a'), 'a'); // back to a: dissent forgotten
  assert.equal(s.observe('k', 'b'), 'a');
  assert.equal(s.observe('k', 'b'), 'b'); // two in a row: change
  assert.equal(s.observe('k', 'c'), 'b');
  assert.equal(s.observe('k', 'b'), 'b');
});

test('hints: the first check is shown at once, later flips need two checks, red needs confirmation', () => {
  const O = load(),
    id = 'omp:s1';
  let out = O.stabilizeHints({ [id]: hint('possibly_active') }, 100);
  assert.equal(out[id].verdict, 'possibly_active');
  out = O.stabilizeHints({ [id]: hint('owned_elsewhere') }, 110); // one strong sighting: still amber
  assert.equal(out[id].verdict, 'possibly_active');
  out = O.stabilizeHints({ [id]: hint('owned_elsewhere') }, 120); // second: red
  assert.equal(out[id].verdict, 'owned_elsewhere');
  out = O.stabilizeHints({}, 130); // gone for one check: label stays
  assert.equal(out[id].verdict, 'owned_elsewhere');
  assert.ok(out[id].reasons.length, 'evidence text is kept while the label holds');
  out = O.stabilizeHints({ [id]: hint('owned_elsewhere') }, 140);
  assert.equal(out[id].verdict, 'owned_elsewhere');
  out = O.stabilizeHints({}, 150);
  out = O.stabilizeHints({}, 160); // gone twice: label removed
  assert.equal(out[id], undefined);
});

test('hints: a new sighting after load needs two checks; checks closer than 2 s count once', () => {
  const O = load(),
    id = 'claude:s2';
  assert.equal(Object.keys(O.stabilizeHints({}, 100)).length, 0);
  assert.equal(O.stabilizeHints({ [id]: hint('possibly_active') }, 110)[id], undefined);
  assert.equal(O.stabilizeHints({ [id]: hint('possibly_active') }, 110.5)[id], undefined); // same check
  assert.equal(O.stabilizeHints({ [id]: hint('possibly_active') }, 120)[id].verdict, 'possibly_active');
});

test('annotate: elsewhere working follows the transcript, with hysteresis; red only when confirmed', () => {
  const O = load(),
    id = 'omp:s3',
    c = { provider: 'omp', id: 's3', modified: 1000 };
  const ctx = (now) => ({ now, key: '', activeWork: false });
  O.annotate([c], { [id]: hint('possibly_active') }, ctx(1010));
  assert.deepEqual({ ...c.elsewhere }, { working: true, confirmed: false, verdict: 'possibly_active' });
  O.annotate([c], { [id]: hint('possibly_active') }, ctx(1200)); // transcript quiet for 200 s: first dissent
  assert.equal(c.elsewhere.working, true);
  O.annotate([c], { [id]: hint('possibly_active') }, ctx(1210)); // second: Idle
  assert.equal(c.elsewhere.working, false);
  O.annotate([c], { [id]: hint('owned_elsewhere') }, ctx(1220));
  assert.equal(c.elsewhere.confirmed, true);
  O.annotate([c], {}, ctx(1230));
  assert.equal(c.elsewhere, undefined);
});

test('annotate: Activity work on the selected chat counts as working; Studio-live chats never get the field', () => {
  const O = load(),
    c = { provider: 'omp', id: 's4', modified: 1 },
    live = { provider: 'omp', id: 's5', modified: 1, live: { id: 'x' } };
  const hints = { 'omp:s4': hint('owned_elsewhere'), 'omp:s5': hint('owned_elsewhere') };
  O.annotate([c, live], hints, {
    now: 5000,
    key: 'omp:s4',
    activeWork: true,
    aliasKey: (x) => x.provider + ':' + x.id,
  });
  assert.equal(c.elsewhere.working, true);
  assert.equal(live.elsewhere, undefined);
});
