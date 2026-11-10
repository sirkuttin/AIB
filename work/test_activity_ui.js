'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const S = require(path.join(APP_DIR, 'subagents-ui.js'));
const A = require(path.join(APP_DIR, 'activity-ui.js'));
const NOW = 10000;
const rows = [
  { key: 'p', agentId: 'p', live: true, state: 'running', name: 'Parent', created: NOW - 600, runningCommands: 1 },
  { key: 'c', agentId: 'c', parentAgentId: 'p', live: true, state: 'running', name: 'Child', created: NOW - 300 },
  { key: 'x', agentId: 'x', live: true, state: 'failed', name: 'Broken', created: NOW - 900, since: NOW - 120 },
  { key: 'z', agentId: 'z', live: true, state: 'idle', name: 'Done', created: NOW - 900, since: NOW - 60 },
];

test('children follow their parent and are indented one level', () => {
  const m = S.model(rows.slice().reverse(), NOW);
  assert.deepEqual(
    m.working.map((i) => [i.key, i.depth]),
    [
      ['p', 0],
      ['c', 1],
    ],
  );
});
test('a parent in another group or a parent cycle never drops or loops rows', () => {
  const m = S.model(
    [
      { key: 'a', agentId: 'a', parentAgentId: 'b', live: true, state: 'running', created: 1 },
      { key: 'b', agentId: 'b', parentAgentId: 'a', live: true, state: 'running', created: 2 },
      { key: 'k', agentId: 'k', parentAgentId: 'gone', live: true, state: 'idle', created: 3 },
    ],
    NOW,
  );
  assert.equal(m.working.length, 2);
  assert.equal(m.finished.length, 1);
  assert.equal(m.finished[0].depth, 0);
});
test('strip shows only non-zero parts', () => {
  const m = S.model(rows, NOW);
  assert.equal(S.strip(m), '2 working · 1 failed · 1 cmd');
  assert.equal(S.strip(m, 3), '2 working · 1 failed · 3 cmds');
  assert.equal(S.strip(S.model([], NOW)), 'No activity');
  assert.equal(S.strip(S.model([rows[3]], NOW)), '1 finished');
});
test('cmd chip count rides on the row model', () => {
  const m = S.model(rows, NOW);
  assert.equal(m.working[0].cmds, 1);
  assert.equal(m.cmds, 1);
});
test('header gives title, type, state and duration', () => {
  const h = S.header(
    {
      live: true,
      state: 'running',
      name: 'Parent',
      description: 'Build it',
      agentType: 'Explore',
      created: NOW - 600,
      runningCommands: 2,
    },
    NOW,
  );
  assert.deepEqual([h.title, h.type, h.state, h.duration, h.cmds], ['Build it', 'Explore', 'Working', '10m', 2]);
  const f = S.header({ key: 'q', live: false, finished: true, modified: NOW - 100, created: NOW - 700 }, NOW);
  assert.deepEqual([f.state, f.duration], ['Completed', '10m']);
});
test('childrenOf matches parentAgentId to agentId', () => {
  assert.deepEqual(
    S.childrenOf(rows, rows[0]).map((r) => r.key),
    ['c'],
  );
  assert.deepEqual(S.childrenOf(rows, rows[1]), []);
  assert.deepEqual(S.childrenOf(rows, {}), []);
});
test('strip layout starts below 1100 px', () => {
  assert.equal(A.isNarrow(1099), true);
  assert.equal(A.isNarrow(1100), false);
  assert.equal(A.NARROW, 1100);
});
test('strip chips: working, failed and running counts (not the subagent total)', () => {
  assert.deepEqual(
    A.chips({ subagents: 28, failed: 0, processes: 2, working: 1 }).map((c) => c.text),
    ['1 working', '0 failed', '2 running'],
  );
  assert.deepEqual(
    A.chips({ subagents: 3, failed: 1, processes: 0, working: 0 }).map((c) => c.text),
    ['0 working', '1 failed', '0 running'],
  );
  assert.deepEqual(A.chips({}), []);
  assert.equal(A.chips({ subagents: 2, working: 1 })[0].cls.includes('working'), true);
  assert.equal(A.chips({ subagents: 2 })[0].cls.includes('working'), false);
  assert.equal(A.chips({ subagents: 2, failed: 1 })[1].cls.includes('has'), true);
  assert.equal(A.chips({ subagents: 2 })[1].cls.includes('has'), false);
});
test('process duration is compact and heading says how many run', () => {
  assert.equal(A.shortDuration(42), '42s');
  assert.equal(A.shortDuration(185), '3m 05s');
  assert.equal(A.shortDuration(3720), '1h 02m');
  assert.equal(A.shortDuration(NaN), '');
  assert.equal(A.shortDuration(-1), '');
  assert.equal(A.processHeading(2), '2 running');
});
test('hidden flag round-trips and survives a broken store', () => {
  const mem = {
    d: {},
    getItem(k) {
      return k in this.d ? this.d[k] : null;
    },
    setItem(k, v) {
      this.d[k] = v;
    },
  };
  assert.equal(A.readHidden(mem), false);
  A.writeHidden(true, mem);
  assert.equal(A.readHidden(mem), true);
  A.writeHidden(false, mem);
  assert.equal(A.readHidden(mem), false);
  const broken = {
    getItem() {
      throw Error('no');
    },
    setItem() {
      throw Error('no');
    },
  };
  assert.equal(A.readHidden(broken), false);
  A.writeHidden(true, broken);
});
