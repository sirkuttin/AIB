'use strict';
const { APP: APP_DIR } = require('./_paths');
/* views.js: the pure projection behind the Chat and Prompts views. Live and saved row shapes come from chat.js itself
   (liveRows and normalized), so the two are compared the way the page builds them. */
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { makePage } = require('./chat_harness.js');

const APP = APP_DIR;
const Views = require(path.join(APP, 'views.js'));
const { project, isPrompt } = Views;

const user = (value, time, extra) => ({ role: 'user', label: 'You', value, time, ...extra });
const asst = (value, time) => ({ role: 'assistant', label: 'Assistant', value, time });
const tool = (name, time, failed) => ({
  role: 'tool',
  label: name,
  value: '{}',
  time,
  call: { name, input: {}, ...(failed ? { result: { text: 'boom', isError: true } } : {}) },
});
const think = (value, time) => ({ role: 'thinking', label: 'Thinking', value, time });
const notice = (label, value, time, actions) => ({
  role: 'notice',
  label,
  value,
  time,
  ...(actions ? { actions } : {}),
});
const bodyRows = (u) => u.body.filter((b) => b.row).map((b) => b.row);
const lines = (u) => u.body.filter((b) => b.line).map((b) => b.line);

test('isPrompt: your own text or files, never an injected note, boilerplate or interrupt', () => {
  assert.equal(isPrompt(user('fix the test', 1)), true);
  assert.equal(
    isPrompt(user('', 1, { attachments: [{ type: 'transcript-image', url: '/api/transcript/image?x=1' }] })),
    true,
  );
  assert.equal(isPrompt(user('', 1)), false, 'empty');
  assert.equal(isPrompt(asst('hi', 1)), false);
  const task =
    '<task-notification><task-id>b1</task-id><status>completed</status><summary>Build done</summary></task-notification>';
  assert.equal(isPrompt(user(task, 1)), false, 'task-notification');
  assert.equal(isPrompt(user('<system-reminder>be brief</system-reminder>', 1)), false, 'system-reminder');
  assert.equal(
    isPrompt(user('[Subagent hand-back]\nfrom x\n\nThe report follows:\nall done', 1)),
    false,
    'subagent hand-back',
  );
  assert.equal(isPrompt(user('<agent-message from="peer">hello</agent-message>', 1)), false, 'agent message');
  assert.equal(isPrompt(user('[Request interrupted by user for tool use]', 1)), false, 'interrupt');
  assert.equal(isPrompt(user('[Request interrupted by user]', 1)), false, 'interrupt');
  assert.equal(
    isPrompt(user('This session is being continued from a previous conversation that ran out of context.', 1)),
    false,
    'compaction summary',
  );
  assert.equal(isPrompt(user('<local-command-stdout>ok</local-command-stdout>', 1)), false, 'local command');
  assert.equal(isPrompt(user('<artifact-view-context>{"a":1}</artifact-view-context>', 1)), false, 'view context only');
});

test('notes and interrupts do not start a group; they stay in the group of the prompt before them', () => {
  const rows = [
    user('one', 1),
    asst('working on it', 2),
    user('<task-notification><summary>done</summary></task-notification>', 3),
    user('[Request interrupted by user]', 4),
    user('two', 5),
    asst('ok', 6),
  ];
  const p = project(rows, 'chat');
  assert.deepEqual(
    p.units.map((u) => u.prompt.value),
    ['one', 'two'],
  );
});

/* ---- the same session in the two shapes chat.js builds ---- */
const SESSION = 's1';
const live = (kind, data, time) => ({ kind, time, data: { sessionId: SESSION, ...data } });
const chunk = (sessionUpdate, text, time) => live('update', { update: { sessionUpdate, content: { text } } }, time);
const toolCall = (id, title, status, time) =>
  live('update', { update: { sessionUpdate: 'tool_call', toolCallId: id, title, status, kind: 'execute' } }, time);

function liveEvents() {
  return [
    live('user', { text: 'fix the flaky test' }, 1),
    chunk('agent_message_chunk', 'Looking at the test first.', 2),
    toolCall('t1', 'Read test.py', 'completed', 3),
    toolCall('t2', 'Run tests', 'completed', 4),
    chunk('agent_message_chunk', 'Fixed. It retries now.', 5),
    live('turn_end', { stopReason: 'end_turn' }, 6),
    live('user', { text: 'now merge it' }, 7),
    chunk('agent_message_chunk', 'Merging.', 8),
    toolCall('t3', 'git merge', 'in_progress', 9),
    live('turn_end', { stopReason: 'cancelled' }, 10),
    live('user', { text: 'start a build in the background' }, 11),
    chunk('agent_message_chunk', 'Started it.', 12),
    live(
      'user',
      {
        text: '<task-notification><task-id>b1</task-id><status>completed</status><summary>Build done</summary></task-notification>',
      },
      13,
    ),
    chunk('agent_message_chunk', 'The build finished fine.', 14),
    live('turn_end', { stopReason: 'end_turn' }, 15),
  ];
}
function savedEvents() {
  const e = (kind, text, time, extra) => ({ kind, label: kind, text, time, ...extra });
  return [
    e('user', 'fix the flaky test', 1),
    e('assistant', 'Looking at the test first.', 2),
    e('tool', '{}', 3, { label: 'Read', callId: 'a' }),
    e('result', 'ok', 3.5, { callId: 'a' }),
    e('tool', '{}', 4, { label: 'Bash', callId: 'b' }),
    e('result', 'ok', 4.5, { callId: 'b' }),
    e('assistant', 'Fixed. It retries now.', 5),
    e('user', 'now merge it', 7),
    e('assistant', 'Merging.', 8),
    e('tool', '{}', 9, { label: 'Bash', callId: 'c' }),
    e('user', '[Request interrupted by user]', 10),
    e('user', 'start a build in the background', 11),
    e('assistant', 'Started it.', 12),
    e(
      'user',
      '<task-notification><task-id>b1</task-id><status>completed</status><summary>Build done</summary></task-notification>',
      13,
    ),
    e('assistant', 'The build finished fine.', 14),
  ];
}
/* what a group draws, in order: messages by text, folds by their label, lines by name */
const flow = (u) =>
  u.body.map((b) => (b.row ? b.row.value : b.fold ? '[' + Views.stepsLabel(b.fold.counts) + ']' : '(' + b.line + ')'));
const shape = (p) =>
  p.units.map((u) => ({
    prompt: u.prompt && u.prompt.value,
    flow: flow(u),
    after: u.body.some((b) => b.after),
  }));

test('live and saved rows of one session give the same groups', () => {
  const page = makePage({ scripts: ['stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js'] });
  const liveRows = page.hook.liveRows(SESSION, liveEvents(), { sessionId: SESSION }, true);
  const savedRows = page.hook.normalized({ events: savedEvents() }, 'k');
  const a = shape(project(liveRows, 'chat')),
    b = shape(project(savedRows, 'chat'));
  assert.deepEqual(a, b);
  assert.deepEqual(
    a.map((g) => g.prompt),
    ['fix the flaky test', 'now merge it', 'start a build in the background'],
  );
  assert.deepEqual(a[0].flow, ['Looking at the test first.', '[2 tool calls]', 'Fixed. It retries now.']);
  assert.deepEqual(
    a[1].flow,
    ['Merging.', '[1 tool call]', '(stopped)'],
    'a cancel (live) and an interrupt row (saved) both end as Stopped',
  );
});

test('Chat folds each run of steps between two messages into one closed line, where it happened', () => {
  const rows = [
    user('go', 1),
    tool('Read', 2),
    asst('first', 3),
    think('hmm', 4),
    tool('Bash', 5),
    tool('Edit', 6, true),
    asst('second', 7),
    asst('third', 8),
    tool('Bash', 9),
  ];
  const u = project(rows, 'chat').units[0];
  assert.deepEqual(flow(u), [
    '[1 tool call]',
    'first',
    '[2 tool calls, 1 failed, thinking]',
    'second',
    'third',
    '[1 tool call]',
  ]);
  const folds = u.body.filter((b) => b.fold).map((b) => b.fold);
  assert.deepEqual(
    folds[1].rows.map((r) => r.role),
    ['thinking', 'tool', 'tool'],
    'the rows are the ones between those two messages',
  );
  /* only the parts that exist are listed */
  assert.equal(Views.stepsLabel({ messages: 0, tools: 3, failed: 0, thinking: 0 }), '3 tool calls');
  assert.equal(Views.stepsLabel({ messages: 0, tools: 0, failed: 0, thinking: 1 }), 'thinking');
  assert.equal(
    Views.stepsLabel({ messages: 0, tools: 1, failed: 1, thinking: 1, partial: true }),
    'partial: 1 tool call, 1 failed, thinking',
  );
  /* nothing to fold between two messages: no line */
  assert.deepEqual(flow(project([user('a', 1), asst('x', 2), asst('y', 3)], 'chat').units[0]), ['x', 'y']);
  /* the fold key is the time of its first row plus the prompt: new turns and older prompts do not move it */
  const keyOf = (list) => list.units.at(-1).body.find((b) => b.fold).fold.key;
  const k1 = keyOf(project(rows, 'chat'));
  const k2 = keyOf(
    project([user('older', 0), asst('o', 0.5), ...rows, user('next', 20), asst('n', 21)], 'chat').units.at(-2)
      ? {
          units: project(
            [user('older', 0), asst('o', 0.5), ...rows, user('next', 20), asst('n', 21)],
            'chat',
          ).units.slice(0, -1),
        }
      : null,
  );
  assert.equal(k1, k2);
  assert.match(k1, /^f:2\|p:/);
});

test('error rows, disconnect notices, rows with actions, unknown sends and the Stopped line are never folded', () => {
  const clash = notice('Studio', 'Your edits clash', 5, [{ id: 'keep', label: 'Keep my version' }]);
  const rows = [
    user('one', 1),
    think('hmm', 2),
    tool('Bash', 3),
    notice('error', 'Lost the connection briefly', 4),
    tool('Edit', 5, true),
    { role: 'error', label: 'Error', value: 'agent failed', time: 6 },
    tool('Read', 6.5),
    notice('disconnected', 'Offline', 7),
    notice('Studio', 'plain note', 8),
    clash,
    tool('Bash', 8.5),
    { role: 'unknown-send', unknownSend: { id: 'u1', text: 'x' } },
    asst('final', 9),
    { role: 'turn-end', value: 'cancelled', time: 10 },
  ];
  const u = project(rows, 'chat').units[0];
  assert.deepEqual(flow(u), [
    '[1 tool call, thinking]',
    'Lost the connection briefly',
    '[1 tool call, 1 failed]',
    'agent failed',
    '[1 tool call]',
    'Offline',
    'Your edits clash',
    '[1 tool call]',
    undefined,
    'final',
    '(stopped)',
  ]);
  assert.ok(!flow(u).includes('plain note'), 'an ordinary notice is not drawn');
  const stop = project([user('p', 1), asst('x', 2), { role: 'turn-end', value: 'cancelled', time: 3 }], 'chat')
    .units[0];
  assert.deepEqual(flow(stop), ['x', '(stopped)']);
  const interrupted = project([user('p', 1), asst('half', 2), user('[Request interrupted by user]', 3)], 'chat')
    .units[0];
  assert.deepEqual(flow(interrupted), ['half', '(stopped)']);
});

test('a turn that ends in steps still shows them; with nothing else a prompt has its fold, and a bare running turn says Working', () => {
  assert.deepEqual(flow(project([user('p', 1), asst('Let me look.', 2), tool('Bash', 3)], 'chat').units[0]), [
    'Let me look.',
    '[1 tool call]',
  ]);
  assert.deepEqual(flow(project([user('p', 1), tool('Bash', 2)], 'chat').units[0]), ['[1 tool call]']);
  assert.deepEqual(flow(project([user('p', 1)], 'chat').units[0]), ['(none)']);
  assert.deepEqual(flow(project([user('p', 1)], 'chat', { working: true }).units[0]), ['(working)']);
  /* a bare running turn with steps, no live status known: the fold stays and nothing else is added */
  assert.deepEqual(flow(project([user('p', 1), tool('Bash', 2)], 'chat', { working: true }).units[0]), [
    '[1 tool call]',
  ]);
});

test('the live line takes the place of the newest fold while the AI works, else it comes last', () => {
  const liveInfo = { step: { kind: 'thinking' }, n: 2, since: 1000 };
  const mid = project([user('p', 1), tool('A', 2), asst('first', 3), tool('B', 4), tool('C', 5)], 'chat', {
    working: true,
    live: liveInfo,
  }).units[0];
  assert.deepEqual(flow(mid), ['[1 tool call]', 'first', '(working)'], 'the last fold became the live line');
  assert.equal(mid.body.at(-1).live, liveInfo);
  const talking = project([user('p', 1), tool('A', 2), asst('first', 3)], 'chat', { working: true, live: liveInfo })
    .units[0];
  assert.deepEqual(
    flow(talking),
    ['[1 tool call]', 'first', '(working)'],
    'the newest row is a message: the line comes after it',
  );
  const bare = project([user('p', 1)], 'chat', { working: true, live: liveInfo }).units[0];
  assert.deepEqual(flow(bare), ['(working)']);
  /* only the newest prompt works; older ones keep their folds */
  const two = project([user('a', 1), tool('A', 2), user('b', 3), tool('B', 4)], 'chat', {
    working: true,
    live: liveInfo,
  });
  assert.deepEqual(flow(two.units[0]), ['[1 tool call]']);
  assert.deepEqual(flow(two.units[1]), ['(working)']);
  /* the turn ended: the fold is back */
  assert.deepEqual(flow(project([user('b', 3), tool('B', 4)], 'chat', { live: liveInfo }).units[0]), ['[1 tool call]']);
});

test('Chat: a running plan shows (last), a finished one is hidden', () => {
  const plan = (status) => ({
    role: 'plan',
    label: 'Plan',
    time: 3,
    entries: [
      { content: 'a', status },
      { content: 'b', status: 'completed' },
    ],
  });
  const running = project([user('p', 1), asst('x', 2), plan('in_progress')], 'chat');
  assert.equal(running.tail.role, 'plan');
  assert.equal(running.flat.at(-1).role, 'plan');
  const done = project([user('p', 1), asst('x', 2), plan('completed')], 'chat');
  assert.equal(done.tail, null);
  assert.ok(!done.flat.some((r) => r.role === 'plan'));
});

test('a 600-row turn keeps its prompt and its last message after the cap', () => {
  const rows = [user('the big one', 1)];
  for (let i = 0; i < 600; i++) rows.push(i % 3 === 0 ? asst('m' + i, 2 + i) : tool('T' + i, 2 + i));
  rows.push(asst('the answer', 9999));
  const p = project(rows, 'chat');
  assert.equal(p.units.at(-1).prompt.value, 'the big one');
  assert.equal(p.flat[0].value, 'the big one');
  assert.equal(bodyRows(p.units.at(-1)).at(-1).value, 'the answer');
  /* older groups go first when the cap is hit */
  const many = [];
  for (let g = 0; g < 400; g++) many.push(user('q' + g, g * 10), asst('a' + g, g * 10 + 1), tool('T', g * 10 + 2));
  const q = project(many, 'chat', { cap: 500 });
  assert.equal(q.units.at(-1).prompt.value, 'q399');
  assert.ok(q.dropped > 0);
  /* chat.js: the live rows are not sliced before projecting */
  const page = makePage({ scripts: ['stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js'] });
  const events = [live('user', { text: 'start' }, 1)];
  for (let i = 0; i < 600; i++) events.push(toolCall('t' + i, 'Run ' + i, 'completed', 2 + i));
  const capped = page.hook.liveRows(SESSION, events, { sessionId: SESSION });
  assert.ok(!capped.some((r) => r.role === 'user'), 'Full still slices to the newest 500, as before');
  const whole = page.hook.liveRows(SESSION, events, { sessionId: SESSION }, true);
  assert.equal(project(whole, 'chat').units[0].prompt.value, 'start');
});

test('the wrap_up recap stays visible after the last message, buttons included', () => {
  const recap = {
    role: 'nextstep',
    label: 'Next step',
    time: 6,
    recap: 'Fixed.',
    ask: 'Merge?',
    actions: ['Merge'],
    value: 'Fixed.',
  };
  const rows = [user('a', 1), asst('work', 2), tool('Bash', 3), asst('final', 4), recap, user('b', 7), asst('ok', 8)];
  const p = project(rows, 'chat');
  assert.deepEqual(
    bodyRows(p.units[0]).map((r) => r.role),
    ['assistant', 'assistant', 'nextstep'],
  );
  assert.equal(bodyRows(p.units[0]).at(-1), recap, 'the same row, so its buttons are drawn');
  assert.equal(bodyRows(p.units[1]).length, 1);
  const noActions = { ...recap, actions: [] };
  assert.equal(bodyRows(project([user('a', 1), asst('x', 2), noActions], 'chat').units[0]).length, 2);
});

test('an AI reply after a background task is marked', () => {
  const note = user(
    '<task-notification><task-id>b1</task-id><status>completed</status><summary>Build done</summary></task-notification>',
    5,
  );
  const rows = [user('build it', 1), asst('Started.', 2), tool('Bash', 3), note, asst('The build passed.', 6)];
  const p = project(rows, 'chat');
  assert.equal(p.units.length, 1, 'the notice is not a prompt');
  const last = p.units[0].body.at(-1);
  assert.equal(last.row.value, 'The build passed.');
  assert.equal(last.after, true);
  const plain = project([user('x', 1), asst('a', 2), tool('B', 3), asst('b', 4)], 'chat').units[0];
  assert.ok(!plain.body.some((b) => b.after));
});

test('the view store: remembered per chat, newest 500 kept, a new chat hands its choice to the real key', () => {
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  const store = Views.viewStore(storage, () => 'full');
  assert.equal(store.get('claude:a'), 'full');
  store.set('claude:a', 'chat');
  assert.equal(Views.viewStore(storage, 'full').get('claude:a'), 'chat', 'read back from storage');
  store.set('claude:a', 'prompts');
  assert.equal(store.get('claude:a'), 'prompts', 'Prompts can be chosen for one chat');
  assert.equal(Views.viewStore(storage, () => 'prompts').get('claude:none'), 'full', 'but it can never be the default');
  assert.equal(Views.viewStore(storage, () => 'outcomes').get('claude:none'), 'full', 'Outcomes is gone');
  store.set('claude:a', 'outcomes');
  assert.equal(store.get('claude:a'), 'prompts', 'Outcomes cannot be chosen any more');
  store.set('claude:a', 'chat');
  store.set('new-chat', 'chat');
  store.adopt('new-chat', 'claude:new');
  assert.equal(store.get('claude:new'), 'chat');
  assert.equal(store.has('new-chat'), false);
  for (let i = 0; i < 520; i++) store.set('k' + i, 'chat');
  const kept = Object.keys(JSON.parse(data.get(Views.STORE_KEY)));
  assert.equal(kept.length, 500);
  assert.ok(kept.includes('k519') && !kept.includes('k0'), 'least recently set goes first');
  assert.equal(
    Views.viewStore(
      {
        getItem() {
          throw new Error('blocked');
        },
        setItem() {
          throw new Error('blocked');
        },
      },
      'full',
    ).get('x'),
    'full',
  );
});

test('Outcomes migration: a chat saved with the Outcomes view opens in Chat, and the choice list is Full, Chat, Prompts', () => {
  assert.deepEqual([...Views.VIEWS], ['full', 'chat', 'prompts']);
  assert.deepEqual([...Views.DEFAULTABLE], ['full', 'chat']);
  const storage = {
    getItem: () => JSON.stringify({ 'claude:old': 'outcomes', 'claude:keep': 'full', 'claude:p': 'prompts' }),
    setItem() {},
  };
  const store = Views.viewStore(storage, () => 'full');
  assert.equal(store.get('claude:old'), 'chat');
  assert.equal(store.has('claude:old'), true);
  assert.equal(store.get('claude:keep'), 'full');
  assert.equal(store.get('claude:p'), 'prompts');
  assert.equal(store.get('claude:unknown'), 'full');
});
