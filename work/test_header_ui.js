'use strict';
const { APP: APP_DIR } = require('./_paths');
// Header pill text, chip order (Agent, Model, Mode, Effort, Project, Branch, Ctx), ownership bar dismissal and branch lookup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const path = require('node:path');
const dir = path.join(APP_DIR);
const attention = require(path.join(dir, 'attention-ui.js'));
globalThis.AgentConfigUI = require(path.join(dir, 'config-ui.js'));
globalThis.AgentChoice = require(path.join(dir, 'agent-choice.js'));
const chips = require(path.join(dir, 'composer-chips.js'));

test('pill text per turn state', () => {
  const d = (m) => attention.describe({ now: 1e7, connected: true, ...m });
  const idle = { busy: false, permissions: [], elicitations: [] };
  assert.equal(d({ snapshot: idle }).pill, 'Idle', 'connected, nothing pending, no finished turn on record');
  assert.equal(
    d({
      snapshot: idle,
      events: [
        { kind: 'user', time: 1 },
        { kind: 'turn_end', time: 2 },
      ],
    }).pill,
    'Your turn',
    'turn ended after the last message',
  );
  assert.equal(
    d({
      snapshot: idle,
      events: [
        { kind: 'turn_end', time: 2 },
        { kind: 'user', time: 3 },
      ],
    }).pill,
    'Idle',
    'the user spoke after it',
  );
  assert.equal(
    d({ snapshot: idle, events: [{ kind: 'turn_end', time: 2 }], handledAt: 2 }).pill,
    'Idle',
    'Mark handled hides that turn end',
  );
  assert.equal(d({ snapshot: idle, yourTurn: true }).pill, 'Your turn', 'the conversation flag wins');
  assert.equal(d({ snapshot: idle, yourTurn: false, events: [{ kind: 'turn_end', time: 2 }] }).pill, 'Idle');
  const working = d({ snapshot: { busy: true, permissions: [], elicitations: [] }, busySince: 1e7 - 4 * 60000 - 5000 });
  assert.equal(working.pill, 'Working · 4m');
  assert.equal(working.line, 'Working · 4m');
  assert.equal(working.text, 'Agent is working… (4m 05s)');
  const q = d({
    snapshot: { busy: true, permissions: [], elicitations: [{ params: { sessionId: 's' } }], sessionId: 's' },
  });
  assert.equal(q.pill, 'Needs you');
  assert.equal(q.status.detail, 'question');
  assert.equal(d({ snapshot: { busy: false, permissions: [{ params: {} }], elicitations: [] } }).pill, 'Needs you');
  assert.equal(d({ connected: false }).pill, 'Not running');
  assert.equal(d({ connected: false }).status.title, 'No agent is attached. Send a message to start it again.');
  assert.equal(
    d({ connected: false, hint: { verdict: 'possibly_active' }, elsewhereWorking: true }).pill,
    'Elsewhere · Working',
  );
  assert.equal(d({ connected: false, hint: { verdict: 'owned_elsewhere' } }).pill, 'Elsewhere · Idle');
  assert.equal(d({ connectionIssue: true }).pill, 'Reconnecting…');
  assert.equal(attention.shortElapsed(45000), '45s');
  assert.equal(attention.shortElapsed(3900000), '1h 05m');
});

test('chip order and the read-only Branch and Ctx chips', () => {
  const settings = {
    modes: { currentModeId: 'm', availableModes: [{ id: 'm', name: 'Code' }] },
    configOptions: [
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'low',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'fast',
        options: [
          { value: 'fast', name: 'Fast' },
          { value: 'deep', name: 'Deep' },
        ],
      },
    ],
  };
  const d = chips.describe({
    settings,
    cwd: 'C:\\w\\proj',
    agent: 'Claude Code',
    branch: 'feat/x',
    usage: { used: 90000, size: 100000 },
  });
  assert.deepEqual(
    d.chips.map((c) => c.id),
    ['agent', 'model', 'mode', 'effort', 'branch', 'ctx'],
  );
  assert.equal(d.chips[4].value, 'feat/x');
  assert.equal(d.chips[5].value, '90%');
  assert.equal(d.chips[5].tone, 'high');
  assert.equal(d.chips[3].subset.configOptions[0].id, 'effort');
  const none = chips.describe({ settings: null, cwd: 'C:\\w\\proj', agent: 'OMP' });
  assert.deepEqual(
    none.chips.map((c) => c.id),
    ['agent'],
  );
});

test('ownership bar: dismissing hides it for that verdict only', () => {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'ownership-ui.js'), 'utf8'), {
    window,
    document: { createElement: () => ({}) },
    Object,
    Array,
    String,
    Promise,
    Error,
  });
  const ui = window.AgentOwnershipUI,
    attrs = {},
    box = {
      hidden: true,
      textContent: '',
      setAttribute: (k, v) => {
        attrs[k] = v;
      },
      getAttribute: (k) => attrs[k],
    };
  const conv = { provider: 'claude', id: 's1' },
    hint = { verdict: 'possibly_active', reasons: [{ text: 'Written 5s ago.' }] };
  ui.renderHint(box, conv, false, hint);
  assert.equal(box.hidden, false);
  ui.dismissHint(conv, box);
  ui.renderHint(box, conv, false, hint);
  assert.equal(box.hidden, true);
  ui.renderHint(box, conv, false, { verdict: 'owned_elsewhere', reasons: [{ text: 'PID 9.' }] });
  assert.equal(box.hidden, false);
});

test('branchOf caches, refreshes in the background and reports a change once', async () => {
  const calls = [];
  const window = {
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({ branch: 'main' }) };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'header-ui.js'), 'utf8'), {
    window,
    Date,
    Promise,
    encodeURIComponent,
  });
  let changed = 0;
  assert.equal(
    window.AgentHeaderUI.branchOf('C:\\w', () => changed++),
    '',
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    window.AgentHeaderUI.branchOf('C:\\w', () => changed++),
    'main',
  );
  assert.equal(changed, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^\/api\/live\/branch\?cwd=C%3A%5Cw$/);
});

test('the header shows the branch chip only for a worktree chat, set with textContent', () => {
  const mk = (tag) => ({
    tag,
    hidden: false,
    textContent: '',
    title: '',
    className: '',
    setAttribute() {},
    addEventListener() {},
    after(n) {
      this.next = n;
    },
  });
  const h1 = mk('h1');
  h1.parentNode = {};
  const els = { title: h1 };
  const document = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => mk(tag),
  };
  const window = { document, AgentSidebarUI: require(path.join(dir, 'sidebar-ui.js')) };
  vm.runInNewContext(fs.readFileSync(path.join(dir, 'header-ui.js'), 'utf8'), {
    window,
    Date,
    Promise,
    encodeURIComponent,
  });
  const render = (selected) => window.AgentHeaderUI.render({ selected, connected: false, current: null, title: 't' });
  render({ provider: 'claude', id: 'a', cwd: 'C:\p' });
  assert.equal(h1.next.hidden, true, 'no chip for a chat without a worktree');
  assert.equal(h1.next.textContent, '');
  els.branchChip = h1.next;
  render({
    provider: 'claude',
    id: 'a',
    cwd: 'C:\w',
    live: { worktree: { branch: 'studio/silly-gif', base: 'main' } },
  });
  assert.equal(h1.next.hidden, false);
  assert.equal(h1.next.textContent, '⎇ studio/silly-gif');
  render({ provider: 'claude', id: 'a', cwd: 'C:\w', worktree: { branch: 'studio/saved', base: 'main' } });
  assert.equal(h1.next.textContent, '⎇ studio/saved', 'a saved chat carries it from the server');
  render({ provider: 'claude', id: 'b', cwd: 'C:\p' });
  assert.equal(h1.next.hidden, true);
});
