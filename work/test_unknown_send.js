'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const U = require(path.join(APP_DIR, 'unknown-send.js'));

const rec = { m1: { text: 'run the tests', attachments: [] } };
test('an unknown message with a local record is shown with its text', () => {
  const out = U.plan([{ clientMessageId: 'm1', at: 1000 }], rec, [], new Set());
  assert.deepEqual(
    out.map((i) => [i.id, i.text]),
    [['m1', 'run the tests']],
  );
});
test('no local record: still warned about, without text (so no Send again)', () => {
  assert.deepEqual(U.plan([{ clientMessageId: 'x', at: 1 }], {}, [], new Set()), [
    { id: 'x', text: null, attachments: [] },
  ]);
});
test('cleared when a live user event carries its clientMessageId', () => {
  assert.deepEqual(U.plan([{ clientMessageId: 'm1', at: 1000 }], rec, [], new Set(['m1'])), []);
});
test('cleared when the agent shows a user message with the same text at or after the receipt', () => {
  assert.deepEqual(
    U.plan([{ clientMessageId: 'm1', at: 1000 }], rec, [{ value: ' run the tests ', time: 1003 }], new Set()),
    [],
  );
  assert.deepEqual(
    U.plan(
      [{ clientMessageId: 'm1', at: 1000 }],
      rec,
      [{ value: 'run the tests', time: new Date(1010 * 1000).toISOString() }],
      new Set(),
    ),
    [],
  );
});
test('an older identical message, or one without a time, does not clear it', () => {
  assert.equal(
    U.plan([{ clientMessageId: 'm1', at: 1000 }], rec, [{ value: 'run the tests', time: 500 }], new Set()).length,
    1,
  );
  assert.equal(U.plan([{ clientMessageId: 'm1', at: 1000 }], rec, [{ value: 'run the tests' }], new Set()).length, 1);
  assert.equal(
    U.plan([{ clientMessageId: 'm1', at: 1000 }], rec, [{ value: 'something else', time: 2000 }], new Set()).length,
    1,
  );
});
test('bad input yields nothing', () => {
  assert.deepEqual(U.plan(null, rec, [], new Set()), []);
  assert.deepEqual(U.plan([{}], rec, [], new Set()), []);
});
test('new ids differ', () => assert.notEqual(U.newId(), U.newId()));
