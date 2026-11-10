const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const dir = path.join(APP_DIR);
const attention = require(path.join(dir, 'attention-ui.js'));
globalThis.AgentConfigUI = require(path.join(dir, 'config-ui.js'));
const chips = require(path.join(dir, 'composer-chips.js'));

const conn = (id, state, needs = 0, turnEndedAt = null) => ({
  id,
  cwd: 'C:\\work\\' + id,
  attention: { state, needs, turnEndedAt },
});
const list = (connections, instanceId = 'i1') => ({ instanceId, connections });

test('status line: every state', () => {
  const d = (m) => attention.describe({ now: 1e6, ...m });
  assert.equal(d({ connectionIssue: true }).text, 'Connection lost · reconnecting');
  assert.equal(d({ opening: true }).text, 'Opening conversation…');
  assert.equal(d({ connected: false }).text, 'Saved conversation — Continue to talk to it');
  assert.equal(d({ connected: true, snapshot: { busy: false, permissions: [], elicitations: [] } }).text, 'Idle');
  assert.equal(
    d({ connected: true, yourTurn: true, snapshot: { busy: false, permissions: [], elicitations: [] } }).text,
    'Your turn',
  );
  const working = d({ connected: true, snapshot: { busy: true }, events: [{ kind: 'user', time: 1e6 / 1000 - 134 }] });
  assert.equal(working.text, 'Agent is working… (2m 14s)');
  const waiting = d({
    connected: true,
    snapshot: {
      sessionId: 'm',
      busy: true,
      permissions: [{ params: { sessionId: 'm' }, route: 'main' }],
      elicitations: [{ params: { sessionId: 'm' }, route: 'main' }],
    },
  });
  assert.equal(waiting.text, 'Waiting for you: 1 approval, 1 question');
  assert.equal(waiting.kind, 'needs');
  assert.equal(waiting.line, 'Needs you — 1 approval, 1 question', 'the composer line leads with the shared word');
  assert.equal(waiting.detail, '');
});

test('a chat reconnecting after a restart says Reconnecting… until it is connected', () => {
  const d = (m) => attention.describe({ now: 1e6, ...m });
  assert.equal(d({ reconnecting: true }).line, 'Reconnecting…');
  assert.equal(
    d({ reconnecting: true, current: 'c', connected: true, snapshot: { ready: false } }).line,
    'Reconnecting…',
  );
  assert.equal(d({ reconnecting: true, connected: true, snapshot: { ready: true, closed: false } }).line, 'Idle');
});

test('turn start ignores user events before the last turn end', () => {
  assert.equal(attention.turnStart([{ kind: 'user', time: 10 }, { kind: 'turn_end' }], 99000, 5000), 5000);
  assert.equal(attention.turnStart([{ kind: 'user', time: 10 }], 99000, 5000), 10000);
});

test('pending requests are grouped by agent', () => {
  const snap = {
    sessionId: 'm',
    permissions: [
      { params: { sessionId: 'sub' }, route: 'subagent' },
      { params: { sessionId: 'sub' }, route: 'subagent' },
    ],
    elicitations: [{ params: { sessionId: 'm' }, route: 'main' }],
    auth: { methods: [] },
  };
  const d = attention.describe({ connected: true, snapshot: snap, names: { sub: 'Reviewer' } });
  assert.equal(d.text, 'Waiting for you: 2 approvals, 1 question, sign-in');
  assert.equal(d.detail, 'Reviewer: 2 approvals · Main agent: 1 question, sign-in');
  assert.equal(d.short, 'Sign-in needed');
});

test('chips: agent first, then model, mode (no project chip); absent settings do not render', () => {
  const settings = {
    modes: {
      currentModeId: 'bypass',
      availableModes: [
        { id: 'default', name: 'Default' },
        { id: 'bypass', name: 'Bypass permissions' },
      ],
    },
    configOptions: [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'opus',
        options: [
          { value: 'sonnet', name: 'Sonnet' },
          { value: 'opus', name: 'Opus' },
        ],
      },
      { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false },
    ],
  };
  const d = chips.describe({ settings, cwd: 'C:\\REPOS\\my-project\\', agent: 'Claude Code', account: '' });
  assert.deepEqual(
    d.chips.map((c) => [c.id, c.value]),
    [
      ['agent', 'Claude Code'],
      ['model', 'Opus'],
      ['mode', 'Bypass permissions'],
    ],
    'no Project chip: the project dropdown names it',
  );
  assert.equal(d.hasPanel, true);
  assert.equal(chips.describe({ settings, cwd: '/a/b', agent: 'OMP', account: 'work' }).chips[0].value, 'OMP · work');
  const bare = chips.describe({ settings: null, cwd: '', agent: '' });
  assert.deepEqual(bare, { chips: [], hasPanel: false });
  const noModel = chips.describe({
    settings: { configOptions: [{ id: 'verbose', type: 'boolean', currentValue: true }] },
    cwd: '/x',
    agent: 'OMP',
  });
  assert.deepEqual(
    noModel.chips.map((c) => c.id),
    ['agent'],
  );
  assert.equal(chips.lastSegment('/a/b/'), 'b');
});
