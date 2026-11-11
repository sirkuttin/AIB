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
    title: 'Ask this chat to merge its work into main',
  });
});

test('a busy chat may be asked (the message is queued); asking and conflicts disable it with one line', () => {
  assert.equal(plan(ready, { branchView: true, files: 2, busy: true }).enabled, true);
  assert.equal(plan(ready, { branchView: true, files: 2, busy: true }).line, '');
  assert.equal(plan(ready, { branchView: true, files: 2, merging: true }).line, 'Asking the chat to merge…');
  const waiting = Object.assign({}, ready, {
    enabled: false,
    state: 'conflicts',
    message: 'Waiting for the chat to resolve conflicts',
  });
  const p = plan(waiting, { branchView: true, files: 0 });
  assert.deepEqual([p.show, p.enabled, p.line], [true, false, 'Waiting for the chat to resolve conflicts']);
});

test('a closed, archived, read-only or elsewhere chat shows the button disabled with the reason as text and tooltip', () => {
  const reason = 'This chat is archived. Unarchive it to merge its work';
  for (const status of [ready, null, { worktree: false }]) {
    const p = plan(status, { branchView: true, files: 2, worktree: true, blocked: reason });
    assert.deepEqual([p.show, p.enabled, p.line, p.title, p.label], [true, false, reason, reason, 'Merge into main']);
  }
  assert.equal(plan(null, { branchView: true, files: 0, worktree: true, blocked: reason }).show, false, 'nothing to merge');
  assert.equal(plan(null, { branchView: true, files: 2, worktree: false, blocked: reason }).show, false, 'no worktree, no button');
});

test('no changes hides the footer', () => {
  const none = Object.assign({}, ready, { enabled: false, state: 'nochanges', message: 'Nothing to merge yet' });
  assert.equal(plan(none, { branchView: true, files: 0 }).show, false);
});
