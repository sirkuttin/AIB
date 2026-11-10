'use strict';
const path = require('path');
const { APP: APP_DIR } = require('./_paths');
// Stage E2: the Changes tab has one footer row (status left, Discard then Merge right), and the amber clash line.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Node } = require('./fake_dom.js');
const { footer } = require(path.join(APP_DIR, 'changes-ui.js'));
const { init } = require(path.join(APP_DIR, 'merge-ui.js'));
const { plan: clashPlan } = require(path.join(APP_DIR, 'clash-ui.js'));

const ready = { worktree: true, base: 'main', label: 'Merge into main', enabled: true, state: 'ready', message: '' };

test('the footer is one row: status line on the left, Discard then Merge on the right', async () => {
  const doc = { createElement: (tag) => new Node(tag, doc) };
  const parts = footer(doc);
  assert.equal(parts.foot.className, 'cg-foot', 'one footer, not two stacked ones');
  assert.deepEqual(
    parts.foot.children.map((n) => n.className),
    ['cg-foot-status', 'cg-discard', 'primary cg-merge-btn'],
  );
  assert.deepEqual(
    parts.status.children.map((n) => n.className),
    ['cg-foot-note', 'cg-merge-line'],
  );
  assert.equal(parts.foot.children.filter((n) => n.tagName === 'BUTTON').length, 2, 'both buttons share the row');
  const win = {
    document: doc,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      json: async () => (/bootstrap/.test(url) ? { token: 't' } : ready),
    }),
  };
  let paints = 0;
  const ui = init({ win, line: parts.mergeLine, button: parts.merge, onPaint: () => paints++ });
  ui.update({ id: 'c1', busy: false, files: 2, branchView: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(parts.merge.hidden, false);
  assert.equal(parts.merge.textContent, 'Merge into main');
  assert.equal(parts.discard.textContent, 'Discard…');
  assert.ok(paints > 0, 'the footer is told to repaint');
});

test('the amber clash line shows only while something is unresolved', () => {
  assert.deepEqual(clashPlan({ unresolved: false }), { show: false, line: '' });
  assert.deepEqual(clashPlan(null), { show: false, line: '' });
  const line = 'README.md has unresolved edits. Ask the chat to fix it.';
  assert.deepEqual(clashPlan({ unresolved: true, line }), { show: true, line });
});

test('the amber line also shows a paused live sync, with a Resume, and a clash wins', () => {
  const syncLine = 'Lots of files changed in proj; live sync paused. Resume?';
  assert.deepEqual(clashPlan({ unresolved: false, syncPaused: true, syncLine }), {
    show: true,
    line: syncLine,
    resume: true,
  });
  assert.deepEqual(clashPlan({ unresolved: false, syncPaused: true }), { show: false, line: '' });
  const line = 'README.md has unresolved edits. Ask the chat to fix it.';
  assert.deepEqual(clashPlan({ unresolved: true, line, syncPaused: true, syncLine }), { show: true, line });
});
