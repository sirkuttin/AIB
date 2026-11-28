'use strict';
/* A WSL chat's subagents are never invisible (owner 2026-11-28: three subagents of a chat whose distro answered after minutes showed
   nowhere in Activity): an Agent call of the chat's own stream is a row on its own until a child takes it, and while AIB's bookkeeping
   of the worktree lags the row says "Syncing its worktree", never "Not isolated". */
const test = require('node:test'),
  assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

function ui() {
  const shell = page();
  return load(shell, ['composer-chips.js', 'subagents-ui.js']).SubagentsUI;
}
const MAIN = 'main-session';
const call = (id, status, extra = {}, response) => ({
  kind: 'update',
  time: 100,
  data: {
    sessionId: MAIN,
    update: {
      sessionUpdate: status ? 'tool_call_update' : 'tool_call',
      toolCallId: id,
      ...(status ? { status } : {}),
      rawInput: { description: 'Build the game', subagent_type: 'general-purpose', prompt: 'do it', ...extra },
      _meta: { claudeCode: { toolName: 'Agent', ...(response ? { toolResponse: response } : {}) } },
    },
  },
});

test('an Agent call with no child session is a running row from the stream alone', () => {
  const U = ui();
  const rows = U.launched([call('toolu_1')], MAIN, new Map());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'launch:toolu_1');
  assert.equal(rows[0].name, 'Build the game');
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[0].live, true);
  assert.equal(U.classify(rows[0]).group, 'working');
  // its end: completed, or failed
  assert.equal(U.launched([call('toolu_1'), call('toolu_1', 'completed')], MAIN, new Map())[0].state, 'completed');
  assert.equal(U.launched([call('toolu_1'), call('toolu_1', 'failed')], MAIN, new Map())[0].state, 'failed');
});

test('a call a child already accounts for (its agentId, a subagent_update, a session message, its own events) adds no row', () => {
  const U = ui();
  const kids = new Map([['agent-1', { key: 'agent-1', name: 'Other', description: 'Other' }]]);
  assert.equal(U.launched([call('toolu_1', 'completed', {}, { agentId: 'agent-1' })], MAIN, kids).length, 0);
  const update = { kind: 'update', time: 1, data: { sessionId: MAIN, update: { sessionUpdate: 'subagent_update', sessionId: 'c1', toolCallId: 'toolu_1' } } };
  assert.equal(U.launched([call('toolu_1'), update], MAIN, new Map()).length, 0);
  const message = { kind: 'update', time: 1, data: { sessionId: MAIN, update: { sessionUpdate: 'session_message', messageId: 'toolu_1' } } };
  assert.equal(U.launched([call('toolu_1'), message], MAIN, new Map()).length, 0);
  const own = { kind: 'update', time: 1, data: { sessionId: 'c2', update: { sessionUpdate: 'agent_message_chunk', _meta: { claudeCode: { parentToolUseId: 'toolu_1' } } } } };
  assert.equal(U.launched([call('toolu_1'), own], MAIN, new Map()).length, 0);
  // a child of the same name (no link in the stream) is the same subagent
  const named = new Map([['c3', { key: 'c3', name: 'Build the game', description: 'Build the game' }]]);
  assert.equal(U.launched([call('toolu_1')], MAIN, named).length, 0);
});

test("a subagent's own tool calls and other tools are not launches", () => {
  const U = ui();
  const other = call('toolu_9', '', {});
  other.data.update._meta.claudeCode.toolName = 'Bash';
  const nested = call('toolu_8', '', {});
  nested.data.update._meta.claudeCode.parentToolUseId = 'toolu_1';
  assert.equal(U.launched([other, nested], MAIN, new Map()).length, 0);
});

test('worktree words: Syncing while the distro lags, else the old rules', () => {
  const U = ui();
  const a = { live: true, state: 'running', agentType: 'general-purpose', created: 1 };
  const iso = { on: true, reason: '', readOnly: ['Explore'] };
  // no word for it after 8 s used to read "Not isolated: AIB saw no worktree for it"
  assert.match(U.worktreeWords(a, iso, null, 100).where, /^Not isolated/);
  assert.equal(U.worktreeWords(a, { ...iso, syncing: true }, null, 100).where, 'Syncing its worktree…');
  // a record that names it wins over the sync note; a read-only type and a chat with isolation off keep their words
  assert.equal(U.worktreeWords(a, { ...iso, syncing: true }, { where: 'Own worktree', landing: 'x' }, 100).where, 'Own worktree');
  assert.match(U.worktreeWords({ ...a, agentType: 'Explore' }, { ...iso, syncing: true }, null, 100).where, /read-only/);
  assert.match(U.worktreeWords(a, { on: false, reason: 'hooks are off', syncing: true }, null, 100).where, /^Not isolated/);
});
