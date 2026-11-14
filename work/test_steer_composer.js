'use strict';
// chat.js wiring of steer-on-send: which route the composer posts to for Enter, Alt+Enter, the menu and slash commands,
// the "Sent while working" tag, and the Stop button on a backgrounded tool row. Snapshots follow the steer contract
// (steerable, steerLane, tool.background); the server side lands separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePage, flat, byClass } = require('./chat_harness.js');

function setup({ snapshot = {}, text = 'also, what does --retry do?' } = {}) {
  const posts = [];
  const ok = (name) => (_q, body) => {
    posts.push([name, body]);
    return { body: { ok: true, accepted: true, queue: { items: [] } } };
  };
  const page = makePage({
    scripts: ['send-menu-ui.js', 'queue-ui.js', 'inbox-reply.js'],
    routes: {
      '/api/live/prompt': ok('prompt'),
      '/api/live/queue': ok('queue'),
      '/api/live/steer': ok('steer'),
      '/api/live/queue-send-now': ok('queue-send-now'),
      '/api/live/tool-stop': ok('tool-stop'),
      '/api/live/state': () => ({ body: { id: 'c1', ready: true, closed: false, ...snapshot } }),
      '/api/live/list': () => ({ body: { connections: [], recovered: [], instanceId: 'A' } }),
    },
  });
  page.run(
    "selected = { provider: 'claude', id: 's1', cwd: 'C:/p', key: 'claude:s1' }; current = 'c1'; snapshot = " +
      JSON.stringify({ id: 'c1', ready: true, closed: false, busy: true, steerable: true, queue: { items: [] }, ...snapshot }),
  );
  page.element('prompt').value = text;
  const submit = () => page.element('promptForm').onsubmit({ preventDefault() {} });
  page.element('promptForm').requestSubmit = () => submit();
  const key = (over) => page.element('prompt').onkeydown(Object.assign({ key: 'Enter', preventDefault() {} }, over));
  return { page, posts, submit, key };
}

const names = (posts) => posts.map((p) => p[0]);

test('Enter while the agent works and can steer posts to the steer route', async () => {
  const { posts, key, page } = setup();
  key();
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['steer']);
  assert.equal(posts[0][1].text, 'also, what does --retry do?');
  assert.equal(posts[0][1].id, 'c1');
  assert.ok(posts[0][1].clientMessageId, 'a client message id rides along so a retry cannot send twice');
});

test('Alt+Enter posts to the existing queue ("Send after this turn")', async () => {
  const { posts, key, page } = setup();
  key({ altKey: true });
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['queue']);
});

test('Shift+Enter does not send (it is a new line)', async () => {
  const { posts, key, page } = setup();
  key({ shiftKey: true });
  await page.tick();
  assert.deepEqual(names(posts), []);
});

test('an agent that cannot steer: Enter queues, as today', async () => {
  const { posts, key, page } = setup({ snapshot: { steerable: false } });
  key();
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['queue']);
});

test('a slash command the agent lists goes after the turn even when it can steer', async () => {
  const { posts, key, page } = setup({ text: '/compact', snapshot: { breadth: { commands: [{ name: 'compact' }] } } });
  key();
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['queue']);
});

test('idle: Enter is an ordinary prompt, exactly as before', async () => {
  const { posts, key, page } = setup({ snapshot: { busy: false, steerable: false } });
  key();
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['prompt']);
});

test('menu pick "Send after this turn" queues; "Interrupt and send" queues then sends it now (cancels the turn)', async () => {
  const { posts, page, submit } = setup();
  page.run("sendWith('after')");
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['queue']);
  posts.length = 0;
  page.run('snapshot = { ...snapshot, busy: true, steerable: true }'); // the refresh after the first send read a plain state
  page.element('prompt').value = 'stop and do this instead';
  page.run("sendWith('interrupt')");
  await page.tick();
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['queue', 'queue-send-now']);
  assert.equal(posts[1][1].messageId, posts[0][1].clientMessageId);
  void submit;
});

test('the composer words while working: button Send, placeholder, the shortcuts in the Send tooltip, no hint row (idle: no tooltip)', async () => {
  const { page } = setup();
  page.run('renderHeader()');
  assert.equal(page.element('send').textContent, 'Send');
  assert.equal(page.element('prompt').placeholder, 'Message Claude Code\u2026 Enter sends now');
  assert.equal(page.element('send').title, 'Enter sends now \u00b7 Alt+Enter after this turn \u00b7 Shift+Enter for a new line');
  assert.equal(page.run('typeof window.AgentSendMenu.keyHintNode'), 'undefined', 'owner, 2026-11-12: no key hint row under the box');
  page.element('prompt').value = '/doc plan';
  page.run('renderHeader()');
  assert.equal(page.element('send').title, 'Commands run after this turn');
  page.element('prompt').value = '';
  page.run('snapshot = { ...snapshot, busy: true, steerable: false }; renderHeader()');
  assert.equal(page.element('send').title, 'Claude Code can\u2019t read messages mid-turn \u00b7 Enter sends when it ends');
  page.run('snapshot = { ...snapshot, busy: false, steerable: false }; renderHeader()');
  assert.equal(page.element('send').textContent, 'Send');
  assert.equal(page.element('send').title, '');
});

test('a steered message shows the "Sent while working" tag on its bubble; a normal one does not', () => {
  const { page } = setup();
  const tagged = page.run("bubbleFull({ role: 'user', label: 'You', value: 'hi', time: 1, steered: true })");
  assert.equal(byClass(tagged, 'sent-tag').length, 1);
  assert.equal(flat(byClass(tagged, 'sent-tag')[0]), 'Sent while working');
  const plain = page.run("bubbleFull({ role: 'user', label: 'You', value: 'hi', time: 1 })");
  assert.equal(byClass(plain, 'sent-tag').length, 0);
});

test('a backgrounded tool row shows "Still running in the background" and its Stop posts the tool-stop route', async () => {
  const { page, posts } = setup();
  const row = {
    role: 'tool',
    label: 'Bash',
    value: '{}',
    time: 1,
    raw: { toolCallId: 'tc1', title: 'Bash', status: 'completed', background: { state: 'running', stoppable: true } },
  };
  const article = page.run('bubbleFull(' + JSON.stringify(row) + ')');
  const pills = byClass(article, 'bg-pill');
  assert.equal(pills.length, 1);
  assert.match(flat(pills[0]), /Still running in the background/);
  const stop = byClass(pills[0], 'bg-stop')[0];
  assert.ok(stop);
  stop.listeners.click();
  await page.tick();
  await page.tick();
  assert.deepEqual(names(posts), ['tool-stop']);
  assert.deepEqual(posts[0][1], { id: 'c1', toolCallId: 'tc1' });
});

/* ---- a stale page (QA beta.9): the page knows the chat from its last poll, up to 1.5 s old ---- */
function staleSetup({ refuse = 'Wait for the current turn, or interrupt it before sending another prompt', live = {} } = {}) {
  const posts = [];
  const states = [];
  const page = makePage({
    scripts: ['send-menu-ui.js', 'queue-ui.js', 'inbox-reply.js'],
    routes: {
      // the server already runs a turn (an approval card is open): it refuses a prompt, as Connection.prompt() does
      '/api/live/prompt': (_q, body) => {
        posts.push(['prompt', body]);
        return { status: 400, body: { error: refuse } };
      },
      '/api/live/steer': (_q, body) => {
        posts.push(['steer', body]);
        return { body: { ok: true, accepted: true, state: 'held', queue: { items: [] } } };
      },
      '/api/live/queue': (_q, body) => {
        posts.push(['queue', body]);
        return { body: { ok: true, accepted: true, queue: { items: [] } } };
      },
      '/api/live/state': (q) => {
        states.push(q);
        return {
          body: {
            id: 'c1',
            ready: true,
            closed: false,
            busy: true,
            steerable: true,
            permissions: [{ key: 'k1', params: { sessionId: 's1' } }],
            queue: { items: [] },
            events: [],
            cursor: 3,
            ...live,
          },
        };
      },
      '/api/live/list': () => ({ body: { connections: [], recovered: [], instanceId: 'A' } }),
    },
  });
  // the page's last poll still saw the chat idle
  page.run(
    "selected = { provider: 'claude', id: 's1', cwd: 'C:/p', key: 'claude:s1' }; current = 'c1'; snapshot = " +
      JSON.stringify({ id: 'c1', ready: true, closed: false, busy: false, steerable: false, queue: { items: [] } }),
  );
  page.element('prompt').value = 'message during card';
  page.element('promptForm').requestSubmit = () => page.element('promptForm').onsubmit({ preventDefault() {} });
  const key = (over) => page.element('prompt').onkeydown(Object.assign({ key: 'Enter', preventDefault() {} }, over));
  const settle = async () => {
    for (let i = 0; i < 12; i++) await page.tick();
  };
  return { page, posts, states, key, settle };
}

test('a turn the page has not polled yet (an approval card is open): the refused prompt is read again and goes to the steer route, no error', async () => {
  const { page, posts, states, key, settle } = staleSetup();
  key();
  await settle();
  assert.deepEqual(names(posts), ['prompt', 'steer'], 'refused as a prompt, then sent the way the chat is now');
  assert.equal(posts[1][1].clientMessageId, posts[0][1].clientMessageId, 'the same message id: the agent never took the first one');
  assert.equal(posts[1][1].text, 'message during card');
  assert.ok(states.length >= 1, 'the chat was read afresh');
  assert.equal(page.element('error').hidden, true, 'no error banner');
  assert.equal(page.element('prompt').value, '', 'the box is cleared: the message is held, not lost');
});

test('a turn the page has not polled yet on an agent that cannot steer: the refused prompt waits in the queue', async () => {
  const { posts, key, settle, page } = staleSetup({ live: { steerable: false, permissions: [] } });
  key();
  await settle();
  assert.deepEqual(names(posts), ['prompt', 'queue']);
  assert.equal(page.element('error').hidden, true);
});

test('a prompt refused for any other reason is not sent again: the error shows and the draft stays', async () => {
  const { posts, key, settle, page } = staleSetup({ refuse: 'This connection is not ready' });
  key();
  await settle();
  assert.deepEqual(names(posts), ['prompt']);
  assert.equal(page.element('error').hidden, false);
  assert.match(page.element('error').textContent, /not ready\. Your draft has been kept\./);
  assert.equal(page.element('prompt').value, 'message during card');
});

test('a refresh asked for while a poll runs reads the chat once more after it (the working composer shows without waiting a poll)', async () => {
  let release;
  let reads = 0;
  const page = makePage({
    scripts: ['send-menu-ui.js', 'queue-ui.js', 'inbox-reply.js'],
    routes: {
      '/api/live/state': async () => {
        reads += 1;
        if (reads === 1) await new Promise((r) => (release = r)); // the poll in flight left before the turn began
        return { body: { id: 'c1', ready: true, closed: false, busy: reads > 1, steerable: reads > 1, queue: { items: [] }, events: [], cursor: reads } };
      },
      '/api/live/list': () => ({ body: { connections: [], recovered: [], instanceId: 'A' } }),
    },
  });
  page.run("selected = { provider: 'claude', id: 's1', cwd: 'C:/p', key: 'claude:s1' }; current = 'c1'; snapshot = null");
  page.run('void refresh({ poll: true })');
  await page.tick();
  page.run('void refresh({ poll: true })'); // the next poll beat while one runs: skipped
  page.run('window.__after = refresh()'); // after a send: one more read once the running one is done
  release();
  await page.run('window.__after');
  for (let i = 0; i < 6; i++) await page.tick();
  assert.equal(reads, 2, 'one poll, then exactly one more read');
  assert.equal(page.run('snapshot.busy'), true, 'the page sees the turn that began during the poll');
});
