'use strict';
/* Regressions from QA of the conversation view (0.1.0-beta.2): reused tool call ids, per-chat open state, and the other
   page-logic fixes that have no better home. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { makePage, El } = require('./chat_harness.js');

const ev = (kind, data, time) => ({ kind, time, data: { sessionId: 's', ...data } });
const say = (text, time) => ev('user', { text }, time);
const call = (id, title, time, status = 'completed') =>
  ev('update', { update: { sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status } }, time);
const end = (time) => ev('turn_end', { stopReason: 'end_turn' }, time);

test('a later turn that reuses a tool call id gets its own row', () => {
  const page = makePage({ scripts: ['tool-views.js'] });
  const rows = page.hook.liveRows(
    's',
    [
      say('one', 1),
      call('call-1', 'first turn ls', 2),
      end(3),
      say('two', 4),
      call('call-1', 'second turn pwd', 5),
      ev('update', { update: { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'failed' } }, 6),
    ],
    { sessionId: 's' },
  );
  const tools = rows.filter((r) => r.role === 'tool');
  assert.equal(tools.length, 2, 'both calls are drawn');
  assert.equal(tools[0].raw.title, 'first turn ls');
  assert.equal(tools[0].raw.status, 'completed', 'the update goes to the newest call with that id');
  assert.equal(tools[1].raw.title, 'second turn pwd');
  assert.equal(tools[1].raw.status, 'failed');
  assert.notEqual(tools[1].uid, undefined, 'the second one has its own key for its open state');
});

test('within one turn a repeated tool_call still updates the same row', () => {
  const page = makePage({ scripts: ['tool-views.js'] });
  const rows = page.hook.liveRows(
    's',
    [say('one', 1), call('a', 'Bash', 2, 'pending'), call('a', 'Bash ls', 3, 'completed')],
    { sessionId: 's' },
  );
  const tools = rows.filter((r) => r.role === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].raw.title, 'Bash ls');
});

test('saved chats: a reused call id gets its own key too', () => {
  const page = makePage({ scripts: ['tool-views.js'] });
  const TV = page.context.window.ToolViews;
  const out = TV.pairSaved([
    { role: 'tool', label: 'Bash', value: '{}', callId: 'x' },
    { role: 'result', value: 'one', callId: 'x' },
    { role: 'tool', label: 'Bash', value: '{}', callId: 'x' },
    { role: 'result', value: 'two', callId: 'x' },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].call.result.text, 'one');
  assert.equal(out[1].call.result.text, 'two');
  assert.equal(out[0].uid, undefined);
  assert.equal(out[1].uid, 'x#2');
});

test('an open step group stays in its own chat', () => {
  const page = makePage({ scripts: ['tool-views.js'] });
  const TV = page.context.window.ToolViews;
  const run = ['a', 'b', 'c', 'd'].map((id) => ({
    role: 'tool',
    raw: { toolCallId: id, title: id, kind: 'execute', status: 'completed' },
  }));
  const draw = () => TV.groupRows(run, (r) => TV.line(r, () => new El('detail')))[0];
  TV.setScope('claude:chat-1');
  const group = draw();
  group.children[0].listeners.click();
  assert.match(draw().className, /\bopen\b/, 'open in chat 1');
  TV.setScope('claude:chat-2');
  assert.doesNotMatch(draw().className, /\bopen\b/, 'chat 2 uses the same ids: still closed');
  TV.setScope('claude:chat-1');
  assert.match(draw().className, /\bopen\b/, 'back in chat 1: still open');
});

test('a tool row: "open ↗" comes before the opened detail in Tab order', () => {
  const page = makePage({
    scripts: ['tool-views.js'],
    window: { AgentEditors: { init() {}, canOpenFile: () => true, fileTip: () => 'Open in editor', openFile() {} } },
  });
  const TV = page.context.window.ToolViews;
  const row = {
    role: 'tool',
    raw: {
      toolCallId: 'r1',
      title: 'Read a.py',
      kind: 'read',
      status: 'completed',
      locations: [{ path: 'C:/x/a.py' }],
    },
  };
  const box = TV.line(row, () => new El('detail'));
  const order = box.children.map((c) => String(c.className).split(' ')[0]);
  assert.ok(order.includes('tool-open'), order.join(','));
  assert.ok(order.indexOf('tool-open') < order.indexOf('tool-detail'), order.join(','));
  assert.equal(order.at(-1), 'tool-detail');
});

test('header: "Your turn" as soon as the turn ends, not after the next list refresh', () => {
  const page = makePage();
  const now = Date.now();
  page.run("selected={provider:'claude',id:'a',key:'a',yourTurn:false}");
  page.hook.state.listedAt = now - 2000; // the list was fetched 2 s ago, before the turn ended
  page.hook.state.events = [say('go', now / 1000 - 5), end(now / 1000 - 1)];
  assert.equal(page.hook.headerYourTurn(), undefined, 'the stale flag is not used: the events decide (Your turn)');
  page.hook.state.events = [say('go', now / 1000 - 5), end(now / 1000 - 1), say('more', now / 1000)];
  assert.equal(page.hook.headerYourTurn(), false, 'you replied: not your turn');
  /* the list was fetched well after the turn ended and still says no: handled elsewhere */
  page.hook.state.events = [say('go', now / 1000 - 100), end(now / 1000 - 60)];
  assert.equal(page.hook.headerYourTurn(), false);
  page.run("selected={provider:'claude',id:'a',key:'a',yourTurn:true}");
  assert.equal(page.hook.headerYourTurn(), true);
});

test('Interrupt: a subagent not heard from since shows Interrupted, not still working; one that goes on stays working', () => {
  const page = makePage({ scripts: ['subagents-ui.js'] });
  const sub = (id, state, time) =>
    ev(
      'update',
      { update: { sessionUpdate: 'subagent_update', sessionId: id, title: 'Review ' + id, state: { state } } },
      time,
    );
  page.run("snapshot={sessionId:'s',busy:false}");
  page.hook.state.events = [
    say('delegate', 1),
    sub('child-1', 'running', 2),
    sub('child-2', 'running', 3),
    ev('turn_end', { stopReason: 'cancelled' }, 4),
    {
      kind: 'update',
      time: 5,
      data: { sessionId: 'child-2', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'still here' } } },
    },
  ];
  page.hook.collectChildren();
  const SU = page.context.window.SubagentsUI;
  assert.equal(SU.classify(page.hook.children.get('child-1')).label, 'Interrupted');
  assert.equal(SU.classify(page.hook.children.get('child-1')).group, 'finished');
  assert.equal(SU.classify(page.hook.children.get('child-2')).group, 'working', 'it spoke after the interrupt');
  /* the same events again (the next poll) give the same answer */
  page.hook.collectChildren();
  assert.equal(SU.classify(page.hook.children.get('child-1')).label, 'Interrupted');
});

test('an unfinished plan stays in its own turn once you have sent another message', () => {
  /* the fragment's children land in the list (as in test_views_unread.js) */
  El.prototype.replaceChildren = function (...items) {
    this.children = items.flatMap((i) => (i.id === 'fragment' ? i.children : [i]));
  };
  const page = makePage({ scripts: ['stream-ui.js', 'tool-views.js', 'plan-ui.js'] });
  page.run("selected={provider:'claude',id:'a',key:'a'}");
  const box = page.element('messages');
  const plan = {
    role: 'plan',
    label: 'Plan',
    time: 3,
    entries: [{ content: 'step one', status: 'pending' }],
    value: 'x',
  };
  const turn1 = [
    { role: 'user', label: 'You', value: 'plan', time: 1 },
    { role: 'assistant', label: 'Assistant', value: 'Here is the plan.', time: 2 },
    plan,
    { role: 'turn-end', label: 'Turn finished', value: 'end_turn', time: 4 },
  ];
  const kinds = () => box.children.map((c) => String(c.className));
  page.hook.showRows(box, turn1, 'main');
  let k = kinds();
  assert.ok(k.findIndex((c) => /plan/.test(c)) >= 0, k.join(' | '));
  assert.ok(
    k.findIndex((c) => /plan/.test(c)) < k.length - 1,
    'before the closing "turn finished" line: ' + k.join(' | '),
  );
  page.hook.showRows(
    box,
    [
      ...turn1,
      { role: 'user', label: 'You', value: 'url', time: 5 },
      { role: 'assistant', label: 'Assistant', value: 'Rich reply', time: 6 },
      { role: 'turn-end', label: 'Turn finished', value: 'end_turn', time: 7 },
    ],
    'main',
  );
  k = kinds();
  const planAt = k.findIndex((c) => /plan/.test(c)),
    users = k.map((c, i) => (/bubble user/.test(c) ? i : -1)).filter((i) => i >= 0);
  assert.equal(users.length, 2, k.join(' | '));
  assert.ok(planAt > users[0] && planAt < users[1], 'the plan stays above your next message: ' + k.join(' | '));
});

test('an answered approval or question leaves one compact line in the chat; pending or withdrawn ones do not', () => {
  const page = makePage({ scripts: ['tool-views.js'] });
  const ask = (kind, key, params, time) => ({ kind, time, data: { key, params } });
  const evs = [
    say('approve', 1),
    ask(
      'permission',
      'p1',
      { sessionId: 's', toolCall: { title: 'Bash: rm -rf build', kind: 'execute' }, options: [] },
      2,
    ),
    ask('elicitation', 'e1', { sessionId: 's', mode: 'form', message: 'Which colour?' }, 3),
    ask('permission', 'p2', { sessionId: 's', toolCall: { title: 'Write notes.md' } }, 4),
    ask('permission', 'p3', { sessionId: 's', toolCall: { title: 'Edit x' } }, 5),
    { kind: 'request_withdrawn', time: 6, data: { key: 'p3', kind: 'permission', reason: 'The turn was cancelled.' } },
  ];
  const rows = page.hook.liveRows('s', evs, { sessionId: 's', permissions: [{ key: 'p2' }], elicitations: [] });
  const lines = rows.filter((r) => r.role === 'answered').map((r) => r.value);
  assert.deepEqual([...lines], ['Approval · Bash: rm -rf build · Answered', 'Question · Which colour? · Answered']);
});
