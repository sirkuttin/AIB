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
