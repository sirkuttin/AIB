'use strict';
const path = require('path');
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test');
const assert = require('node:assert/strict');
const { plan } = require(path.join(APP_DIR, 'merge-ui.js'));

const ready = { worktree: true, base: 'main', label: 'Merge into main', enabled: true, state: 'ready', message: '' };

test('a chat without its own worktree shows nothing', () => {
  assert.equal(plan({ worktree: false }, { branchView: false, files: 3 }).show, false);
  assert.equal(plan(null, { branchView: true, files: 3 }).show, false);
  assert.equal(plan(ready, { branchView: false, files: 3 }).show, false);
});

test('a worktree chat with changes gets an enabled button named after the base', () => {
  assert.deepEqual(plan(ready, { branchView: true, files: 2 }), {
    show: true,
    enabled: true,
    label: 'Merge into main',
    line: '',
  });
});

test('busy, merging and conflicts disable it with one line', () => {
  assert.equal(plan(ready, { branchView: true, files: 2, busy: true }).enabled, false);
  assert.equal(plan(ready, { branchView: true, files: 2, busy: true }).line, 'Wait for the chat to finish its turn');
  assert.equal(plan(ready, { branchView: true, files: 2, merging: true }).line, 'Merging…');
  const waiting = Object.assign({}, ready, {
    enabled: false,
    state: 'conflicts',
    message: 'Waiting for the chat to resolve conflicts',
  });
  const p = plan(waiting, { branchView: true, files: 0 });
  assert.deepEqual([p.show, p.enabled, p.line], [true, false, 'Waiting for the chat to resolve conflicts']);
});

test('no changes hides the footer', () => {
  const none = Object.assign({}, ready, { enabled: false, state: 'nochanges', message: 'Nothing to merge yet' });
  assert.equal(plan(none, { branchView: true, files: 0 }).show, false);
});
