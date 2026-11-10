'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  vm = require('node:vm');
const { loadChat } = require('./chat_harness.js');
const storage = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
const element = () => ({ value: '', checked: false, hidden: false, addEventListener() {} });
const context = vm.createContext({
  localStorage: storage(),
  sessionStorage: storage(),
  document: { getElementById: element },
  window: { addEventListener() {} },
  fetch: () => new Promise(() => {}),
  setInterval() {},
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref();
    return timer;
  },
  clearTimeout,
  URLSearchParams,
  AbortController,
  Date,
  console,
});
const chat = loadChat(context);
const evaluate = chat.run;

test('active agents stay first and each group sorts by creation time', () => {
  const rows = [
    { key: 'idle-new', created: 40, live: true, state: 'idle' },
    { key: 'working-old', created: 10, live: true, state: { state: 'running' } },
    { key: 'working-new', created: 30, live: true, state: 'working' },
    { key: 'saved-new', created: 50, active: false },
    { key: 'saved-active-old', created: 5, active: true },
  ];
  assert.deepEqual(
    [...evaluate('sortAgents(' + JSON.stringify(rows) + ').map(a=>a.key)')],
    ['working-new', 'working-old', 'saved-active-old', 'saved-new', 'idle-new'],
  );
});
test('timestamp fallback and deterministic key ties are supported', () => {
  const rows = [
    { key: 'z', createdAt: '2026-01-02T00:00:00Z', live: true, state: 'idle' },
    { key: 'b', created: '2026-01-03T00:00:00Z', live: true, state: 'idle' },
    { key: 'a', created: '2026-01-03T00:00:00Z', live: true, state: 'idle' },
  ];
  assert.deepEqual([...evaluate('sortAgents(' + JSON.stringify(rows) + ').map(a=>a.key)')], ['a', 'b', 'z']);
});
test('live state objects sort as active or inactive and display readable labels', () => {
  assert.equal(evaluate("agentIsActive({live:true,state:{status:'running'}})"), true);
  assert.equal(evaluate("agentIsActive({live:true,state:{state:'idle'}})"), false);
  assert.equal(evaluate("agentStateLabel({live:true,state:{state:'running'}})"), 'Working');
  assert.equal(evaluate("agentStateLabel({live:true,state:{state:'idle'}})"), 'Idle');
});
