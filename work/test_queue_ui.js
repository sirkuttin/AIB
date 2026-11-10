const { APP: APP_DIR } = require('./_paths');
const test = require('node:test');
const path = require('node:path');
const assert = require('node:assert');
const Q = require(path.join(APP_DIR, 'queue-ui.js'));

const item = (id) => ({ id, text: 'm ' + id, attachments: [] });

test('no items: nothing is shown', () => {
  assert.strictEqual(Q.summary({ items: [], reason: '' }, true).show, false);
  assert.strictEqual(Q.summary(null, true).show, false);
});

test('waiting items: one tiny header line and a short turn-line note', () => {
  const s = Q.summary({ items: [item('a'), item('b')], reason: '' }, true);
  assert.strictEqual(s.head, '2 queued · send when this turn ends');
  assert.strictEqual(s.note, '2 queued');
  assert.strictEqual(s.resume, false);
});

test('editing the next message shows "Paused while you edit" in both places', () => {
  const s = Q.summary({ items: [item('a')], reason: 'editing', message: 'Paused while you edit' }, true);
  assert.strictEqual(s.head, 'Paused while you edit');
  assert.strictEqual(s.note, 'Paused while you edit');
  assert.strictEqual(s.tone, 'paused');
  assert.strictEqual(s.resume, false);
});

test('an abandoned edit or a needs-you pause offers Resume', () => {
  const abandoned = Q.summary(
    { items: [item('a')], reason: 'abandoned', message: 'Paused - a queued message was being edited' },
    false,
  );
  assert.match(abandoned.head, /was being edited/);
  assert.strictEqual(abandoned.resume, true);
  assert.strictEqual(
    Q.summary({ items: [item('a')], reason: 'needs_you', message: 'Paused - the agent needs you' }, false).resume,
    true,
  );
});

test('every icon button has a tooltip text', () => {
  assert.strictEqual(Q.TEXT.edit, 'Edit - pauses the queue while you edit');
  assert.strictEqual(Q.TEXT.sendNow, 'Send now - interrupts the agent');
  assert.strictEqual(Q.TEXT.remove, 'Remove from queue');
});
