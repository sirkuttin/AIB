'use strict';
const { APP: APP_DIR } = require('./_paths');
// The New chat page's "Works in" chip (build plan 1.2 / 1.3, architect MF 9): the fixed slot, the pre-set rule, the notes and
// the folder line. Pure helpers of composer-chips.js; the page itself is covered by work/deno/works_in_e2e_test.ts.
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
globalThis.AgentConfigUI = require(path.join(APP_DIR, 'config-ui.js'));
const chips = require(path.join(APP_DIR, 'composer-chips.js'));

const chipOf = (worksIn, extra) =>
  chips.describe(Object.assign({ settings: null, worksIn }, extra || {})).chips.find((c) => c.id === 'worksin') || null;

test('the chip reads "Works in: Project folder" by default with the two rows and their second lines', () => {
  const c = chipOf({ ownCopy: false, copyable: true });
  assert.equal(c.label, 'Works in');
  assert.equal(c.value, 'Project folder');
  assert.equal(c.locked, false);
  assert.deepEqual(
    c.items.map((i) => [i.value, i.name, i.description, !!i.disabled]),
    [
      ['folder', 'Project folder', 'Edits your files directly, like the agent in a terminal.', false],
      ['copy', 'Own copy', "Works on its own branch in a separate copy. You merge it when it's done.", false],
    ],
  );
  assert.equal(chipOf({ ownCopy: true, copyable: true }).value, 'Own copy');
});

test('the slot is there before the server answers: greyed, "Checking…" on the Own copy row [MF 9]', () => {
  const c = chipOf({ ownCopy: false, copyable: null });
  assert.ok(c, 'never missing while checking');
  assert.equal(c.locked, true);
  assert.equal(c.items[1].description, 'Checking\u2026');
  assert.equal(c.items[1].disabled, true);
  assert.equal(c.items[0].disabled, true, 'nothing to pick until the folder is known');
});

test('a folder that cannot have a copy: greyed with whyNot, and the value is the folder', () => {
  const c = chipOf({ ownCopy: true, copyable: false, whyNot: 'Not a git repository' });
  assert.equal(c.locked, true);
  assert.equal(c.value, 'Project folder');
  assert.equal(c.items[1].description, 'Not a git repository');
  assert.equal(c.items[1].disabled, true);
  assert.equal(c.items[0].disabled, false);
  assert.equal(chipOf({ ownCopy: false, copyable: false, whyNot: 'x', hidden: true }), null, 'hidden only on request');
});

test('the chip comes after Effort and the Model stand-in, before Branch', () => {
  const settings = {
    configOptions: [
      { id: 'effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'high', name: 'High' }] },
    ],
  };
  const ids = chips
    .describe({
      settings,
      agent: 'Claude Code',
      extraChips: [{ id: 'model', label: 'Model', value: 'Checking\u2026' }],
      worksIn: { ownCopy: false, copyable: true },
      branch: 'main',
      cwd: 'C:\\p',
    })
    .chips.map((c) => c.id);
  assert.deepEqual(ids, ['agent', 'effort', 'model', 'worksin', 'branch']);
  assert.equal(chipOf(undefined), null, 'a chat (not the New chat page) has no Works in chip');
});

test('pre-set rule: an open folder chat in this project that is busy or has queued messages', () => {
  const key = (p) => String(p).toLowerCase();
  const title = (c) => c.title;
  const busy = { title: 'Fix login', live: { cwd: 'C:\\Shop', projectRoot: 'C:\\Shop', busy: true } };
  assert.equal(chips.workingFolderChat([busy], 'c:\\shop', key, title), 'Fix login');
  const queued = { title: 'Q', live: { cwd: 'C:\\Shop', busy: false, queue: { items: [{ id: 1 }] } } };
  assert.equal(chips.workingFolderChat([queued], 'C:\\Shop', key, title), 'Q');
  const none = [
    { title: 'idle', live: { cwd: 'C:\\Shop', busy: false, queue: { items: [] } } },
    { title: 'copy', live: { cwd: 'C:\\wt\\x', projectRoot: 'C:\\Shop', busy: true, worktree: { branch: 'studio/x' } } },
    { title: 'helper', live: { cwd: 'C:\\Shop', busy: true, swarm: { role: 'helper' } } },
    { title: 'closed', live: { cwd: 'C:\\Shop', busy: true, closed: true } },
    { title: 'other', live: { cwd: 'C:\\Other', busy: true } },
    { title: 'saved', cwd: 'C:\\Shop' },
  ];
  assert.equal(chips.workingFolderChat(none, 'C:\\Shop', key, title), '');
  assert.equal(chips.workingFolderChat([busy], '', key, title), '', 'no folder yet');
});

test('notes: the pre-set reason, the amber warning after the user picked the folder, nothing otherwise', () => {
  assert.deepEqual(chips.worksInNote({ ownCopy: true, preset: 'Fix login', copyable: true }), {
    text: 'Own copy is on because \u201CFix login\u201D is working in this folder.',
    amber: false,
  });
  assert.deepEqual(chips.worksInNote({ ownCopy: false, preset: 'Fix login', amber: true, copyable: true }), {
    text: 'Both chats will edit the same files. If one runs tests or git while the other is mid-edit, things can break.',
    amber: true,
  });
  assert.equal(chips.worksInNote({ ownCopy: false, preset: '', copyable: true }).text, '');
  assert.equal(chips.worksInNote({ ownCopy: true, preset: 'X', copyable: false }).text, '', 'no copy possible: no reason line');
  assert.equal(chips.worksInNote(null).text, '');
});

test('the folder line names the branch, or "own copy from" it', () => {
  assert.equal(chips.folderLine('C:\\REPOS\\shop', 'main', { ownCopy: false, copyable: true }), 'C:\\REPOS\\shop \u00B7 main');
  assert.equal(
    chips.folderLine('C:\\REPOS\\shop', 'main', { ownCopy: true, copyable: true }),
    'C:\\REPOS\\shop \u00B7 own copy from main',
  );
  assert.equal(chips.folderLine('C:\\REPOS\\shop', '', { ownCopy: true, copyable: true }), 'C:\\REPOS\\shop');
  assert.equal(chips.folderLine('C:\\REPOS\\shop', 'main', null), 'C:\\REPOS\\shop \u00B7 main');
});
