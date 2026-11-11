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

test('clicking Merge asks the chat: it posts merge-request (never the direct merge) and shows the answer', async () => {
  const doc = { createElement: (tag) => new Node(tag, doc) };
  const parts = footer(doc);
  const posts = [];
  const win = {
    document: doc,
    fetch: async (url, init) => {
      if (init && init.method === 'POST') posts.push([url, JSON.parse(init.body)]);
      const body = /bootstrap/.test(url)
        ? { token: 't' }
        : /merge-request/.test(url)
          ? { ok: true, state: 'requested', queued: true, message: 'Merge requested. The chat merges when it finishes its turn' }
          : ready;
      return { ok: true, status: 200, json: async () => body };
    },
  };
  let asked = null;
  const ui = init({
    win,
    line: parts.mergeLine,
    button: parts.merge,
    confirm: async (o) => ((asked = o), true),
  });
  ui.update({ id: 'c1', busy: true, files: 2, branchView: true, worktree: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(parts.merge.disabled, false, 'a busy chat can be asked');
  parts.merge.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(asked, { files: 2, base: 'main' });
  assert.deepEqual(posts, [['/api/live/worktree/merge-request', { id: 'c1' }]]);
  assert.equal(parts.mergeLine.textContent, 'Merge requested. The chat merges when it finishes its turn');
});

test('a blocked chat: the button is disabled with the reason, and a click sends nothing', async () => {
  const doc = { createElement: (tag) => new Node(tag, doc) };
  const parts = footer(doc);
  const posts = [];
  const win = {
    document: doc,
    fetch: async (url, init) => {
      if (init && init.method === 'POST') posts.push(url);
      return { ok: true, status: 200, json: async () => (/bootstrap/.test(url) ? { token: 't' } : ready) };
    },
  };
  const ui = init({ win, line: parts.mergeLine, button: parts.merge, confirm: async () => true });
  const reason = 'This chat is closed. Continue it to merge its work';
  ui.update({ id: 'c1', busy: false, files: 2, branchView: true, worktree: true, blocked: reason });
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual([parts.merge.hidden, parts.merge.disabled, parts.merge.title, parts.mergeLine.textContent], [false, true, reason, reason]);
  parts.merge.dispatch('click');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(posts, []);
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
