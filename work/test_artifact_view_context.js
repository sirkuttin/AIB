'use strict';
const { APP: APP_DIR } = require('./_paths');
/* The desktop app's <artifact-view-context> block is hidden from user bubbles (display only). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makePage, byClass, flat } = require('./chat_harness.js');
const StreamUI = require(path.join(APP_DIR, 'stream-ui.js'));

const BLOCK =
  '<artifact-view-context artifact="https://claude.ai/artifact/x">{"a":1}\n<artifact-content-authored-by-others/></artifact-view-context>';
const user = (value, time) => ({ role: 'user', label: 'You', value, time });
const paint = (rows) => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const box = page.element('pane1');
  box.dataset.mirror = 'omp:sess-1';
  page.hook.paintMirror(box, rows);
  return byClass(box, 'bubble');
};

test('stripViewContext keeps only the user text', () => {
  assert.equal(
    StreamUI.stripViewContext(BLOCK + '\n\nchat message style. i want option A'),
    'chat message style. i want option A',
  );
  assert.equal(StreamUI.stripViewContext('before ' + BLOCK + ' after'), 'before after');
  assert.equal(StreamUI.stripViewContext(BLOCK), '');
  assert.equal(StreamUI.stripViewContext('plain  text\n'), 'plain  text\n');
});

test('a user bubble shows only the text, and nothing when only the block was sent', () => {
  const [shown] = paint([user(BLOCK + '\n\nchat message style. i want option A', 1)]);
  assert.match(flat(shown), /chat message style\. i want option A/);
  assert.doesNotMatch(flat(shown), /artifact-view-context|claude\.ai/);
  assert.equal(paint([user(BLOCK, 1)]).length, 0);
  const [plain] = paint([user('hello <b>there</b>', 1)]);
  assert.match(flat(plain), /hello <b>there<\/b>/);
});
