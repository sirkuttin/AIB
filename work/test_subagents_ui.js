'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const U = require(path.join(APP_DIR, 'subagents-ui.js'));
const NOW = 10000;

test('live state decides the group; idle, completed, failed and stopped are finished', () => {
  const g = (s) => U.classify({ live: true, state: s });
  for (const s of ['running', 'working', { state: 'running' }, 'in-progress', 'queued'])
    assert.equal(g(s).group, 'working');
  for (const s of ['idle', 'completed', 'failed', 'cancelled', 'stopped', 'Available'])
    assert.equal(g(s).group, 'finished');
  assert.equal(g('failed').kind, 'failed');
  assert.equal(g({ state: 'idle' }).label, 'Idle');
});
test('saved data is only "probably running" when recent, unfinished and without an end marker', () => {
  assert.deepEqual(
    { ...U.classify({ active: true, finished: null }) },
    { group: 'working', kind: 'probable', label: 'Probably running' },
  );
  assert.equal(U.classify({ active: true, finished: true }).group, 'finished');
  assert.equal(U.classify({ active: true, completedMarker: true }).group, 'finished');
  assert.equal(U.classify({ active: true, failed: true }).kind, 'failed');
  assert.equal(U.classify({ active: false, finished: null }).group, 'finished');
});
test('names: description is the title and a type-like title becomes the secondary label', () => {
  let n = U.names({ live: true, key: 'x1', title: 'general-purpose', description: 'W3c HUD 16:9' });
  assert.equal(n.title, 'W3c HUD 16:9');
  assert.equal(n.type, 'general-purpose');
  n = U.names({
    key: 'claude/p/s/subagents/agent-abc.jsonl',
    name: 'Verify slice 06',
    agentId: 'abc',
    agentType: 'fork',
    description: 'Verify slice 06',
  });
  assert.equal(n.title, 'Verify slice 06');
  assert.equal(n.type, 'fork');
  assert.match(n.tip, /Id: abc/);
});
test('names: unnamed falls back to the first prompt, then to the id', () => {
  let n = U.names({ key: 'k', name: 'abc123', agentId: 'abc123', firstPrompt: 'Audit the importer\nand more' });
  assert.equal(n.title, 'Audit the importer');
  n = U.names({ live: true, key: 'a27d21b6-0000', name: 'Subagent a27d21b6' });
  assert.equal(n.title, 'Subagent a27d21b6');
  n = U.names({ live: true, key: 'a27d21b6-0000', name: 'Subagent a27d21b6', firstPrompt: 'Fix the HUD' });
  assert.equal(n.title, 'Fix the HUD');
});
test('model: groups, failed first in finished, elapsed and finished-ago text', () => {
  const rows = [
    { key: 'a', live: true, state: 'running', name: 'Alpha', created: NOW - 250 },
    { key: 'b', live: true, state: 'idle', name: 'Beta', created: NOW - 900, since: NOW - 180 },
    { key: 'c', live: true, state: 'failed', name: 'Gamma', created: NOW - 900, since: NOW - 3600 * 3 },
    { key: 'd', live: false, active: false, finished: true, name: 'Delta', modified: NOW - 10 },
  ];
  const m = U.model(rows, NOW);
  assert.deepEqual(
    m.working.map((i) => i.key),
    ['a'],
  );
  assert.equal(m.working[0].when, 'running 4m');
  assert.deepEqual(
    m.finished.map((i) => i.key),
    ['c', 'd', 'b'],
  );
  assert.equal(m.failed, 1);
  assert.equal(m.finished[2].when, '3m ago');
  assert.equal(m.finished[1].when, 'just now');
  assert.equal(m.finished[0].when, '3h ago');
  assert.equal(U.heading(m), '1 working · 3 finished');
});
test('enrich records finish time only when the state changes', () => {
  const old = { state: 'running', since: 5 };
  const same = { state: 'running', since: 5 };
  U.enrich(same, old, {}, 9);
  assert.equal(same.since, 5);
  const changed = { state: 'idle', since: 5 };
  U.enrich(changed, old, { title: 'T', agentType: 'general-purpose' }, 9);
  assert.equal(changed.since, 9);
  assert.equal(changed.title, 'T');
  assert.equal(changed.agentType, 'general-purpose');
});
test('noteEvent keeps the first prompt of a live child', () => {
  const c = {};
  const ev = (t) => ({ data: { update: { sessionUpdate: 'user_message_chunk', content: { text: t } } } });
  U.noteEvent(c, ev('Do the thing'));
  U.noteEvent(c, ev('later'));
  assert.equal(c.firstPrompt, 'Do the thing');
});
test('top list is working then failed; other finished rows are collapsed into done', () => {
  const rows = [
    { key: 'a', live: true, state: 'running', name: 'Alpha', created: NOW - 250 },
    { key: 'b', live: true, state: 'idle', name: 'Beta', created: NOW - 900, since: NOW - 180 },
    { key: 'c', live: true, state: 'failed', name: 'Gamma', created: NOW - 900, since: NOW - 300 },
    { key: 'd', live: true, state: 'completed', name: 'Delta', created: NOW - 900, since: NOW - 10 },
  ];
  const m = U.model(rows, NOW);
  assert.deepEqual(
    m.top.map((i) => i.key),
    ['a', 'c'],
  );
  assert.deepEqual(
    m.done.map((i) => i.key),
    ['d', 'b'],
  );
  assert.equal(U.sectionHeading(m), '1 working · 1 failed');
});
test('steer-on-send: a working helper marked as gone to the background says so; a finished one does not', () => {
  const m = U.model(
    [
      { key: 'a', live: true, state: 'running', name: 'Alpha', created: NOW - 60, background: true },
      { key: 'b', live: true, state: 'running', name: 'Beta', created: NOW - 60 },
      { key: 'c', live: true, state: 'idle', name: 'Gamma', created: NOW - 60, background: true },
    ],
    NOW,
  );
  const by = Object.fromEntries([...m.top, ...m.done].map((i) => [i.key, i.background]));
  assert.deepEqual(by, { a: true, b: false, c: false });
});
