'use strict';
const { APP: APP_DIR } = require('./_paths');
/* Claude Code's to-do list reaches the chat as its plan. The fixture is a real claude-agent-acp 0.97.0 stream (Claude Code 2.1.310,
   claude-haiku-5-5, CLAUDE_CODE_ENABLE_TODO_TOOLS=1, prompt "make a 3-item to-do list for boiling an egg, then mark each item
   done"), trimmed to its plan, tool and message updates: the agent loads TaskCreate/TaskUpdate through ToolSearch and the adapter
   turns every task change into an ACP `plan` update. chat.js's liveRows() and PlanUI.fold() must give one plan card that follows
   the list as it is ticked off. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const PlanUI = require(path.join(APP_DIR, 'plan-ui.js'));
require(path.join(APP_DIR, 'tool-views.js'));
const ToolViews = globalThis.ToolViews;
const { loadChat } = require('./chat_harness.js');

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

const updates = fs
  .readFileSync(path.join(__dirname, 'claude-plan-fixture', 'task_tools_stream.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

function planCards(upTo) {
  const events = [
    { kind: 'user', time: 1, data: { sessionId: 's1', text: 'Make a 3-item to-do list for boiling an egg', attachments: [] } },
    ...updates.slice(0, upTo).map((data, i) => ({ kind: 'update', time: 2 + i, data })),
  ];
  context.__events = events;
  chat.run("snapshot={sessionId:'s1'};events=globalThis.__events");
  return PlanUI.fold(chat.run("liveRows('s1')"), {}).filter((r) => r.role === 'plan');
}
const brief = (card) => card.entries.map((e) => e.status + ':' + e.content);

test('the recorded stream has the to-do list as ACP plan updates and no TodoWrite/Task* tool cards', () => {
  const kinds = updates.map((u) => u.update.sessionUpdate);
  assert.ok(kinds.filter((k) => k === 'plan').length >= 3);
  const tools = updates.filter((u) => u.update.sessionUpdate === 'tool_call').map((u) => u.update.title);
  assert.deepEqual(tools, ['ToolSearch']); // the Task* tools load deferred; the adapter draws them as the plan, not as tool calls
});

test('the finished turn shows one plan card with all three steps done', () => {
  const cards = planCards(updates.length);
  assert.equal(cards.length, 1);
  assert.deepEqual(brief(cards[0]), [
    'completed:Gather ingredients and equipment',
    'completed:Boil the egg',
    'completed:Cool and peel the egg',
  ]);
});

test('mid-turn the same card shows the step in progress and the ones still to do', () => {
  const at = updates.findIndex(
    (u) => u.update.sessionUpdate === 'plan' && u.update.entries.some((e) => e.content === 'Boil the egg' && e.status === 'in_progress'),
  );
  assert.ok(at > 0);
  const cards = planCards(at + 1);
  assert.equal(cards.length, 1);
  assert.deepEqual(brief(cards[0]), [
    'completed:Gather ingredients and equipment',
    'in_progress:Boil the egg',
    'pending:Cool and peel the egg',
  ]);
});

test("in-progress steps spin while the chat's helpers still work after the reply ended, and show dots when nothing works", () => {
  const at = updates.findIndex(
    (u) => u.update.sessionUpdate === 'plan' && u.update.entries.some((e) => e.status === 'in_progress'),
  );
  context.__events = [
    { kind: 'user', time: 1, data: { sessionId: 's1', text: 'go', attachments: [] } },
    ...updates.slice(0, at + 1).map((data, i) => ({ kind: 'update', time: 2 + i, data })),
    { kind: 'turn_end', time: 999, data: { sessionId: 's1', stopReason: 'end_turn' } }, // the reply ended with steps still open
  ];
  const planOf = (snap) => {
    context.__snap = snap;
    chat.run('snapshot=globalThis.__snap;events=globalThis.__events');
    return chat.run("liveRows('s1')").filter((r) => r.role === 'plan').pop();
  };
  assert.equal(!!planOf({ sessionId: 's1', busy: false, subagents: { h1: { state: 'running' } } }).active, true, 'a helper is running');
  assert.equal(!!planOf({ sessionId: 's1', busy: true, subagents: {} }).active, true, 'the agent is replying');
  assert.equal(!!planOf({ sessionId: 's1', busy: false, subagents: { h1: { state: 'completed' } } }).active, false, 'nothing works');
});
