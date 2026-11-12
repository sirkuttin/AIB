const { APP: APP_DIR } = require('./_paths');
const test = require('node:test');
const path = require('node:path');
const assert = require('node:assert');
const C = require(path.join(APP_DIR, 'clamp-ui.js'));

test('line count ignores trailing newlines', () => {
  assert.equal(C.lineCount(''), 0);
  assert.equal(C.lineCount('a'), 1);
  assert.equal(C.lineCount('a\nb\n\n'), 2);
});

test('block keys combine position and opening text', () => {
  assert.equal(C.blockKey(3, 'hello'), '3:hello');
  assert.equal(C.blockKey(0, 'x'.repeat(200)).length, 2 + 80);
  assert.equal(C.LINES, 12);
});

test('rebuilt rows are clamped inside the observer, not on a later timer', () => {
  // A timer let the browser paint one frame of a long block at full height on every update, so the history flashed.
  let observerCallback = null;
  let scans = 0;
  const box = { id: 'messages', querySelectorAll: () => (scans++, []), addEventListener() {} };
  const saved = { document: global.document, MutationObserver: global.MutationObserver };
  global.document = { getElementById: () => box };
  global.MutationObserver = class {
    constructor(cb) {
      observerCallback = cb;
    }
    observe() {}
  };
  try {
    C.watch('messages');
    const before = scans;
    observerCallback([]);
    assert.equal(scans, before + 1, 'the observer callback scans the box right away');
  } finally {
    global.document = saved.document;
    global.MutationObserver = saved.MutationObserver;
  }
});
