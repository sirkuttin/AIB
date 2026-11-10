'use strict';
const { APP: APP_DIR } = require('./_paths');
/* The pinned plan and "N running tasks" survive when the update_plan call that set the plan is older than the loaded page:
   the saved-history API hands back those older events as `context`, and chat.js folds them without drawing them. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const dir = APP_DIR;
const PlanUI = require(path.join(dir, 'plan-ui.js'));
require(path.join(dir, 'tool-views.js'));
const ToolViews = globalThis.ToolViews;
const { loadChat } = require('./chat_harness.js');
/* chat.js runs in a fake page; normalized() is reached through its test hook (window.StudioChat). */
const element = () => ({ value: '', checked: false, hidden: false, addEventListener() {} });
const context = vm.createContext({
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: { getElementById: element },
  window: { addEventListener() {}, PlanUI, ToolViews },
  fetch: () => new Promise(() => {}),
  setInterval() {},
  URLSearchParams,
  console,
});
const chat = loadChat(context);
const normalized = (data, dock) => chat.hook.normalized(data, 'k', dock);

let n = 0;
const ev = (kind, label, text, extra) => ({ id: 'e' + ++n, kind, label, text, time: '', ...extra });
const call = (name, input, callId) => ev('tool', name, JSON.stringify(input), { callId });
const plan = call(
  'mcp__ccd_turn__update_plan',
  {
    items: [
      { content: 'A', status: 'in_progress' },
      { content: 'B', status: 'pending' },
    ],
  },
  'p1',
);
const launch = call('Agent', { run_in_background: true }, 'b1');
const launched = ev('result', 'Tool result', 'Async agent launched successfully.\nagentId: bx1 (internal ID)', {
  callId: 'b1',
}); // a background agent: the running count counts agents only
const chatter = (i) => ev('assistant', 'Assistant', 'step ' + i);
const olderContext = [ev('user', 'User', ''), plan, launch, launched].map((e) => ({ ...e, ctx: true }));

test('a plan whose update_plan is older than the page is still pinned, and its running task counts', () => {
  const page = [chatter(1), chatter(2)];
  const rows = normalized({ events: page, context: olderContext }, true);
  const docked = rows.filter((r) => r.role === 'plan');
  assert.equal(docked.length, 1);
  assert.deepEqual(
    docked[0].entries.map((e) => e.status),
    ['in_progress', 'pending'],
  );
  assert.equal(docked[0].running, 1);
  /* without the context the plan is simply lost */
  assert.equal(
    normalized({ events: page }, true).some((r) => r.role === 'plan'),
    false,
  );
});

test('rows from the context are never drawn as history', () => {
  const rows = normalized({ events: [chatter(3)], context: olderContext }, true);
  assert.equal(
    rows.some((r) => r.ctx && r.role !== 'plan'),
    false,
  );
  assert.deepEqual(
    rows.filter((r) => !r.ctx).map((r) => r.role),
    ['assistant'],
  );
  /* panes without a pinned plan draw nothing from it */
  assert.deepEqual(
    normalized({ events: [chatter(3)], context: olderContext }, false).map((r) => r.role),
    ['assistant'],
  );
});

test('a later wrap_up is held by a still-running task from the context; a finish clears the count', () => {
  const wrap = call('mcp__ccd_turn__wrap_up', { recap: 'Done' }, 'w1');
  const still = normalized({ events: [chatter(4), wrap], context: olderContext }, true).filter(
    (r) => r.role === 'plan',
  );
  assert.equal(still.length, 1);
  assert.equal(still[0].running, 1);
  const done = ev('task-done', 'Background task finished', 'bx1');
  /* finished only: still pinned, no running tasks */
  assert.equal(normalized({ events: [done], context: olderContext }, true).find((r) => r.role === 'plan').running, 0);
});

test("a background launch from before the plan's turn does not count (as in Claude's app)", () => {
  const earlier = [{ ...launched, ctx: true }];
  const rows = normalized(
    {
      events: [
        ev('user', 'User', 'go'),
        call('mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'in_progress' }] }, 'p2'),
      ],
      context: earlier,
    },
    true,
  );
  assert.equal(rows.find((r) => r.role === 'plan').running, 0);
});

test('without context nothing changes', () => {
  const rows = normalized({ events: [ev('user', 'User', 'hi'), chatter(5)] }, true);
  assert.deepEqual(
    rows.map((r) => r.role),
    ['user', 'assistant'],
  );
});
