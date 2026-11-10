'use strict';
const { APP: APP_DIR } = require('./_paths');
/* chat.js behaviour that used to be checked by looking for text in its source: side panes, the split hand-off, the change signature,
   the hidden-tab poll and the screen-reader announcements. chat.js runs in a fake page and is reached through window.StudioChat. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { makePage, byClass, flat } = require('./chat_harness.js');

const StreamUI = require(path.join(APP_DIR, 'stream-ui.js'));
const savedSession = (over = {}) => ({
  key: 'omp/p/s.jsonl',
  provider: 'omp',
  id: 'sess-1',
  cwd: 'C:/proj',
  title: 'Saved chat',
  hasMessages: true,
  created: 1,
  modified: 1,
  subagentCount: 0,
  ...over,
});
const listRoutes = {
  '/api/sessions': () => ({ body: { sessions: [savedSession()] } }),
  '/api/live/list': () => ({ body: { connections: [], recovered: [], instanceId: 'A' } }),
};
const assistant = (value, time) => ({ role: 'assistant', label: 'Assistant', value, time });
const user = (value, time) => ({ role: 'user', label: 'You', value, time });
const turnEnd = (time) => ({ role: 'turn-end', label: 'Turn finished', value: 'end_turn', time });

/* ---- what chat.js still gives the other scripts, now that it is an IIFE ---- */
test('chat.js puts exactly these things on window: the image check tool-views.js uses, the GET helper, the view hooks and the test hook', () => {
  const page = makePage();
  const exported = Object.keys(page.context.window)
    .filter((name) => name !== 'addEventListener')
    .sort();
  assert.deepEqual(exported, ['AgentChatView', 'AgentStudioGet', 'StudioChat', 'safeImageBlock']);
  assert.equal(page.context.window.safeImageBlock({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }), true);
  assert.equal(
    page.context.window.safeImageBlock({ type: 'image', mimeType: 'image/svg+xml', data: 'aGVsbG8=' }),
    false,
  );
  assert.deepEqual(Object.keys(page.context.window.AgentChatView).sort(), [
    'getThinking',
    'notices',
    'renameChat',
    'setThinking',
    'startHandoff',
  ]);
  assert.equal(typeof page.context.window.AgentStudioGet, 'function');
});

/* ---- side panes ---- */
test('a side pane draws a window of the rows, with no show-earlier or load-history button', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const rows = Array.from({ length: 300 }, (_, i) => user('message ' + i, i + 1));
  const box = page.element('pane1');
  box.dataset.mirror = 'omp:sess-1';
  page.hook.paintMirror(box, rows);
  const drawn = byClass(box, 'bubble');
  assert.ok(drawn.length > 0 && drawn.length < 300, 'only a window of the 300 rows is drawn: ' + drawn.length);
  assert.ok(drawn.length <= StreamUI.MIRROR_BASE);
  assert.match(flat(drawn.at(-1)), /message 299/, 'the newest row is the last one drawn');
  assert.equal(byClass(box, 'show-earlier').length + byClass(box, 'load-history').length, 0);
  assert.equal(
    typeof page.hook.fetchEarlier,
    'function',
    'older saved pages are fetched by the same code as the main view',
  );
});

test('a side pane never needs the #thinking checkbox: its last value is remembered while the main view is detached', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const thought = {
    kind: 'update',
    time: 1,
    data: { sessionId: 's', update: { sessionUpdate: 'agent_thought_chunk', content: { text: 'pondering' } } },
  };
  page.element('thinking').checked = true;
  assert.equal(
    page.hook.liveRows('s', [thought], { sessionId: 's' }).length,
    1,
    'thoughts show while the box is ticked',
  );
  const detached = page.document.getElementById;
  page.document.getElementById = (id) => (id === 'thinking' ? null : detached(id)); // the main view is out of the document
  assert.equal(page.hook.liveRows('s', [thought], { sessionId: 's' }).length, 1, 'the remembered value is used');
  const box = page.element('pane2');
  box.dataset.mirror = 'omp:sess-1';
  assert.doesNotThrow(() => page.hook.paintMirror(box, [user('hello', 1), assistant('hi', 2)]));
  const fresh = makePage({ scripts: ['stream-ui.js'] });
  fresh.document.getElementById = (id) => (id === 'thinking' ? null : fresh.element(id));
  assert.equal(
    fresh.hook.liveRows('s', [thought], { sessionId: 's' }).length,
    0,
    'with no box and nothing remembered, thinking is off',
  );
});

/* ---- the split view gets what it needs ---- */
test('the page hands the split code its hooks, and chat cards can be dragged into a pane', async () => {
  let host = null;
  const drags = [];
  const page = makePage({
    routes: listRoutes,
    window: {
      AgentSplitUI: {
        init: (h) => {
          host = h;
        },
        active: () => false,
        startCardDrag: (event, key) => drags.push(key),
      },
    },
  });
  for (const name of [
    'convOf',
    'selectedKey',
    'open',
    'showStart',
    'singleTabs',
    'orderTabs',
    'titleOf',
    'redraw',
    'notice',
  ])
    assert.equal(typeof host[name], 'function', name);
  for (const name of ['rows', 'paint', 'stash', 'wake'])
    assert.equal(typeof host.mirror[name], 'function', 'mirror.' + name);
  await page.hook.refreshToken();
  await page.hook.listConversations();
  const card = byClass(page.element('connections'), 'connection')[0];
  assert.ok(card, 'the saved chat is listed');
  card.listeners.pointerdown({});
  assert.deepEqual(drags, ['omp:sess-1']);
  assert.equal(host.convOf('omp:sess-1').id, 'sess-1');
});

/* ---- the change signature ---- */
function paintCounter(page) {
  const box = page.element('messages');
  let paints = 0;
  const replace = box.replaceChildren.bind(box);
  box.replaceChildren = (...items) => {
    paints++;
    replace(...items);
  };
  return { box, paints: () => paints };
}
const toolEvent = (kind, status, text) => ({
  kind: 'update',
  time: 1,
  data: {
    sessionId: 's',
    update: { sessionUpdate: kind, toolCallId: 't1', title: 'Bash', status, ...(text ? { content: text } : {}) },
  },
});
const chunk = (text) => ({
  kind: 'update',
  time: 2,
  data: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { text } } },
});

test('an unchanged list of rows is not repainted, even when the rows are new objects', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const { box, paints } = paintCounter(page);
  const rows = () => [user('go', 1), assistant('working', 2)];
  page.hook.showRows(box, rows(), 'main');
  assert.equal(paints(), 1);
  page.hook.showRows(box, rows(), 'main');
  assert.equal(paints(), 1);
});

test('an update to a middle row repaints: a tool call finishing above streaming text', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const { box, paints } = paintCounter(page);
  const rows = (status) =>
    page.hook.liveRows(
      's',
      [
        toolEvent('tool_call', 'in_progress'),
        chunk('Looking at the results'),
        ...(status === 'done' ? [toolEvent('tool_call_update', 'completed')] : []),
      ],
      { sessionId: 's' },
    );
  page.hook.showRows(box, rows('running'), 'main');
  assert.equal(paints(), 1);
  page.hook.showRows(box, rows('running'), 'main');
  assert.equal(paints(), 1, 'same events, same picture');
  const after = rows('done');
  assert.equal(after.length, 2, 'the finished call updated the row above the text; no row was added or removed');
  page.hook.showRows(box, after, 'main');
  assert.equal(paints(), 2, 'the first row changed, the last did not');
});

test('a middle row changes only in its revision, or in a same-length word: still a repaint', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const { box, paints } = paintCounter(page);
  const make = (label, rev) => [user('go', 1), { role: 'tool', label, value: 'x', time: 2, rev }, assistant('tail', 3)];
  page.hook.showRows(box, make('Bash · failed', 0), 'main');
  assert.equal(paints(), 1);
  page.hook.showRows(box, make('Bash · denied', 0), 'main');
  assert.equal(paints(), 2, 'same length, different word');
  page.hook.showRows(box, make('Bash · denied', 1), 'main');
  assert.equal(paints(), 3, 'only the revision moved');
});

test('a permission resolving (the plan or tool row above the text changes) repaints', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const { box, paints } = paintCounter(page);
  const plan = (status) => ({
    role: 'plan',
    label: 'Plan',
    entries: [
      { content: 'Edit the file', status },
      { content: 'Run tests', status: 'pending' },
    ],
    value: '',
  });
  page.hook.showRows(box, [plan('pending'), assistant('waiting for you', 2)], 'main');
  assert.equal(paints(), 1);
  page.hook.showRows(box, [plan('in_progress'), assistant('waiting for you', 2)], 'main');
  assert.equal(paints(), 2);
});

test('streaming text at the end and the thinking toggle repaint as before', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const { box, paints } = paintCounter(page);
  page.hook.showRows(box, [user('go', 1), assistant('Hel', 2)], 'main');
  page.hook.showRows(box, [user('go', 1), assistant('Hello', 2)], 'main');
  assert.equal(paints(), 2);
  page.element('thinking').checked = true;
  page.hook.showRows(box, [user('go', 1), assistant('Hello', 2)], 'main');
  assert.equal(paints(), 3, 'the thinking toggle changes the picture');
});

test('the signature of a long chat is built without stringifying whole rows', () => {
  const big = {
    role: 'tool',
    label: 'Read',
    value: 'x'.repeat(40000),
    raw: { status: 'completed', title: 'Read', rawOutput: { text: 'y'.repeat(40000) } },
  };
  const signature = StreamUI.rowsSignature([big, big, big]);
  assert.ok(signature.length < 1500, 'long text is summed up by its length and tail: ' + signature.length);
  assert.notEqual(StreamUI.rowsSignature([big]), StreamUI.rowsSignature([{ ...big, value: 'x'.repeat(40001) }]));
});

/* ---- hidden tab ---- */
const stateCalls = (page) => page.calls.filter((c) => c.url === '/api/live/state').length;
const listCalls = (page) => page.calls.filter((c) => c.url === '/api/live/list').length;
const liveState = {
  '/api/live/state': () => ({
    body: {
      sessionId: 's',
      events: [],
      cursor: 0,
      permissions: [],
      elicitations: [],
      busy: false,
      closed: false,
      settings: {},
    },
  }),
};
const chatPollers = (page) => page.intervals.filter((i) => i.ms === 1500).map((i) => i.fn);
const listPoller = (page) => page.intervals.find((i) => i.ms === 5000).fn;

test('while the tab is hidden the 1.5 s chat poll pauses and the conversation-list poll keeps running', async () => {
  const page = makePage({ routes: { ...listRoutes, ...liveState } });
  await page.hook.refreshToken();
  page.state.selected = { provider: 'omp', id: 'sess-1', cwd: 'C:/proj', key: 'live:conn-1', title: 'T' };
  page.state.current = 'conn-1';
  page.document.hidden = false;
  for (const poll of chatPollers(page)) poll();
  await page.tick();
  assert.equal(stateCalls(page), 1, 'a visible tab polls the chat');
  page.document.hidden = true;
  const before = stateCalls(page),
    listsBefore = listCalls(page);
  for (const poll of chatPollers(page)) poll();
  await page.tick();
  assert.equal(stateCalls(page), before, 'a hidden tab does not poll the chat');
  listPoller(page)();
  await page.tick();
  assert.equal(listCalls(page), listsBefore + 1, 'the conversation list still polls, for desktop notifications');
});

test('showing the tab again refreshes the chat at once', async () => {
  const page = makePage({ routes: { ...listRoutes, ...liveState } });
  await page.hook.refreshToken();
  page.state.selected = { provider: 'omp', id: 'sess-1', cwd: 'C:/proj', key: 'live:conn-1', title: 'T' };
  page.state.current = 'conn-1';
  page.document.hidden = true;
  page.fire('visibilitychange');
  await page.tick();
  assert.equal(stateCalls(page), 0, 'becoming hidden does not poll');
  page.document.hidden = false;
  page.fire('visibilitychange');
  await page.tick();
  assert.equal(stateCalls(page), 1, 'becoming visible refreshes immediately, without waiting for the next tick');
});

/* ---- screen-reader announcements ---- */
test('#messages is not a live region; one hidden live region announces finished agent messages once', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  page.state.selected = { provider: 'omp', id: 'sess-1', cwd: 'C:/proj', key: 'omp/p/s.jsonl', title: 'T' };
  const live = page.element('liveAnnounce'),
    box = page.element('messages');
  page.hook.showRows(box, [user('go', 1), assistant('Hel', 2)], 'main');
  assert.equal(live.textContent, '', 'opening a chat announces nothing');
  page.hook.showRows(box, [user('go', 1), assistant('Hello there', 2)], 'main');
  assert.equal(live.textContent, '', 'text still streaming is not read out word by word');
  page.hook.showRows(box, [user('go', 1), assistant('Hello there', 2), turnEnd(3)], 'main');
  assert.equal(live.textContent, 'Hello there', 'the finished message is announced');
  live.textContent = '';
  page.hook.showRows(box, [user('go', 1), assistant('Hello there', 2), turnEnd(3), user('thanks', 4)], 'main');
  assert.equal(live.textContent, '', 'it is announced only once');
});

test('a chat opened with finished history, or another chat, announces nothing', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  const live = page.element('liveAnnounce'),
    box = page.element('messages');
  page.state.selected = { provider: 'omp', id: 'a', key: 'ka' };
  page.hook.showRows(box, [user('q', 1), assistant('old answer', 2), turnEnd(3)], 'main');
  assert.equal(live.textContent, '');
  page.state.selected = { provider: 'omp', id: 'b', key: 'kb' };
  page.hook.showRows(box, [user('q', 1), assistant('another old answer', 5), turnEnd(6)], 'main');
  assert.equal(live.textContent, '', 'switching chats sets a new baseline');
  page.hook.showRows(
    box,
    [
      user('q', 1),
      assistant('another old answer', 5),
      turnEnd(6),
      user('more', 7),
      assistant('new answer', 8),
      turnEnd(9),
    ],
    'main',
  );
  assert.equal(live.textContent, 'new answer');
});

test('split panes announce their own new turns, named by chat, through the same live region', () => {
  const page = makePage({ scripts: ['stream-ui.js'] });
  page.state.conversations = [savedSession({ id: 'sess-2', title: 'Release notes' })];
  const live = page.element('liveAnnounce'),
    pane = page.element('pane3');
  pane.dataset.mirror = 'omp:sess-2';
  page.hook.paintMirror(pane, [user('q', 1), assistant('first', 2)]);
  assert.equal(live.textContent, '');
  page.hook.paintMirror(pane, [user('q', 1), assistant('first', 2), turnEnd(3)]);
  assert.equal(live.textContent, 'Release notes: first');
});

test('StreamUI.newTurns: baseline, finished-only, in order, and no replay when older rows are loaded above', () => {
  const rows = [user('q', 1), assistant('one', 2), turnEnd(3), assistant('two', 4), turnEnd(5), assistant('three', 6)];
  assert.deepEqual(StreamUI.newTurns(rows, null).announce, [], 'first call is a baseline');
  const base = StreamUI.newTurns(rows.slice(0, 3), null).key;
  assert.deepEqual(
    StreamUI.newTurns(rows, base).announce.map((r) => r.value),
    ['two'],
    'three is still streaming',
  );
  const older = [assistant('ancient', 0), turnEnd(0.5), ...rows.slice(0, 3)];
  assert.deepEqual(StreamUI.newTurns(older, base).announce, [], 'older rows prepended are not new');
  assert.deepEqual(
    StreamUI.newTurns(rows.slice(3), base).announce,
    [],
    'if the remembered message is gone, set a new baseline instead of replaying',
  );
});

/* ---- ownership: what a chat with no evidence means, as the server reports it ---- */
test('the header hint says "unknown" for a saved chat when GET /api/live/ownership reports it could not check, and no-evidence wording otherwise', async () => {
  const header = async (certainty) => {
    const routes = {
      ...listRoutes,
      '/api/live/ownership': () => ({ body: { hints: {}, ...(certainty ? { certainty } : {}) } }),
    };
    const page = makePage({ routes, scripts: ['ownership-ui.js'] });
    await page.hook.listConversations();
    page.state.selected = page.state.conversations[0];
    await page.hook.refresh(); // the saved-history request has no route here, so it fails; the header is redrawn either way
    const hint = page.element('ownershipHint');
    return { text: hint.textContent, hidden: hint.hidden };
  };
  const unknown = await header('unknown');
  assert.equal(unknown.hidden, false);
  assert.match(unknown.text, /^Can't tell if this chat is open elsewhere on this system/);
  assert.doesNotMatch(unknown.text, /cannot prove it is free|No other app was detected/);
  for (const certainty of ['checked', undefined])
    assert.match((await header(certainty)).text, /cannot prove it is free/);
});
