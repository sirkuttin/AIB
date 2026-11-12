'use strict';
/* Unread state is kept against the chat's underlying message rows, never against the bubbles a view draws: switching
   Full / Chat / Prompts changes neither what is read nor where the "New" line points, a message that arrives is
   unread in every view, and in Prompts only the replies of an opened prompt are seen. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { makePage, El, byClass, flat } = require('./chat_harness.js');

/* the harness' fake elements do not know selectors: teach them the one the unread code asks (.bubble.user,.bubble.assistant) */
El.prototype.matches = function (selector) {
  const classes = String(this.className).split(/\s+/);
  return selector.split(',').some((part) =>
    part
      .trim()
      .split('.')
      .filter(Boolean)
      .every((c) => classes.includes(c)),
  );
};

/* and the two things the line needs: a fragment's children land in the list, and insertBefore really inserts before */
El.prototype.replaceChildren = function (...items) {
  this.children = items.flatMap((i) => (i.id === 'fragment' ? i.children : [i]));
};
El.prototype.insertBefore = function (node, ref) {
  const i = this.children.indexOf(ref);
  this.children.splice(i < 0 ? this.children.length : i, 0, node);
};

const SCRIPTS = ['read-state.js', 'stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js', 'views-ui.js', 'scroll-controller.js'];
const ev = (kind, data, time) => ({ kind, time, data: { sessionId: 's', ...data } });
const say = (text, time) => ev('user', { text }, time);
const reply = (text, time) =>
  ev('update', { update: { sessionUpdate: 'agent_message_chunk', content: { text } } }, time);
const run = (id, time) =>
  ev(
    'update',
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: id,
        title: 'Bash',
        kind: 'execute',
        status: 'completed',
        rawInput: { command: 'ls' },
      },
    },
    time,
  );

/* three turns: a prompt, an interim message, a tool call and the final reply */
const turns = (n, from = 0) => {
  const out = [];
  for (let i = from; i < from + n; i++) {
    const t = 1000 + i * 10;
    out.push(say('question ' + i, t), reply('interim ' + i, t + 1), run('c' + i, t + 2), reply('answer ' + i, t + 3));
  }
  return out;
};

function unreadPage(view = 'full') {
  const page = makePage({ scripts: SCRIPTS });
  page.run("selected={provider:'claude',id:'a',key:'a'};current='c1'");
  page.hook.setView(view);
  page.hook.UNREAD.holdUntil = 0;
  const box = page.element('messages');
  const set = (evs) => {
    page.run("snapshot={sessionId:'s',busy:false,unknownReceipts:[]}");
    page.run('events=' + JSON.stringify(evs));
    page.hook.repaintMain();
  };
  /* the reader scrolls up: what the scroll handler does when you leave the bottom */
  const scrollUp = () => {
    box.scrollHeight = 5000;
    box.clientHeight = 500;
    page.hook.mainCtl().apply(); // laid out on screen (its ResizeObserver): the list follows, at its end
    box.scrollTop = 100;
    box.listeners.scroll();
  };
  const lines = () => byClass(box, 'new-line');
  const pending = () => ({
    count: page.hook.unreadCount(),
    read: page.hook.readIndex(),
    mark: JSON.stringify(page.hook.UNREAD.mark),
  });
  /* the line sits right before this text (the next visible message when the first unread one is hidden) */
  const lineBefore = () => {
    const i = box.children.findIndex((c) => String(c.className).includes('new-line'));
    return i < 0 ? null : flat(box.children[i + 1] || { textContent: '' });
  };
  return { page, box, set, scrollUp, lines, pending, lineBefore };
}

test('read some messages, switch Full > Chat > Prompts > Full: the unread count and position do not change', () => {
  const t = unreadPage('full');
  t.set(turns(3));
  t.scrollUp(); // you have read all of it, and scrolled up
  assert.equal(t.pending().count, 0);
  const evs = [
    ...turns(3),
    say('question 3', 2000),
    reply('interim 3', 2001),
    run('c3', 2002),
    reply('answer 3', 2003),
  ];
  t.set(evs); // a prompt and two replies arrive while you are scrolled up: only the agent's two are unread
  const first = t.pending();
  assert.equal(first.count, 2);
  assert.equal(t.lines().length, 1);
  assert.match(t.lineBefore(), /interim 3/);
  const seen = [];
  for (const view of ['chat', 'prompts', 'full']) {
    t.page.hook.setView(view);
    /* the browser lays the list out again and fires scroll events by itself when the content changes height. The scroll
       controller (scroll-controller.js) has put the list back after layout, before those events arrive (its ResizeObserver,
       here called by hand), so they report the place it left the list at: none of that is you scrolling. */
    t.box.scrollHeight = 4000;
    t.page.hook.mainCtl().apply();
    t.box.listeners.scroll();
    t.box.scrollHeight = 5000;
    t.page.hook.mainCtl().apply();
    t.box.listeners.scroll();
    assert.deepEqual(t.pending(), first, view + ': nothing became read or unread');
    /* Prompts draws no message bubbles, so it draws no line; the others put it before the first unread row */
    assert.equal(t.lines().length, view === 'prompts' ? 0 : 1, view);
    seen.push(view + ': ' + t.lineBefore());
  }
  assert.match(seen[0], /chat: .*interim 3/);
  assert.equal(seen[1], 'prompts: null');
  assert.match(seen[2], /full: .*interim 3/);
});

test('a message arriving while you are in Chat is unread in every view', () => {
  const t = unreadPage('chat');
  t.set(turns(2));
  t.scrollUp();
  const first = [...turns(2), say('question 2', 2000)];
  const evs = [...first, reply('interim 2', 2001), run('c2', 2002), reply('answer 2', 2003)];
  t.set(first);
  assert.equal(t.pending().count, 0, 'your own prompt is never unread');
  assert.equal(t.lines().length, 0);
  t.set(evs);
  const n = t.pending().count;
  assert.equal(n, 2, 'the interim message and the answer');
  assert.match(t.lineBefore(), /interim 2/, 'Chat: the line is before the first unread row');
  for (const view of ['full', 'prompts', 'chat']) {
    t.page.hook.setView(view);
    assert.equal(t.page.hook.unreadCount(), n, view);
  }
  /* the first unread row is the AI's message after a fold: the line goes right before it, after the folded steps */
  t.page.hook.UNREAD.mark = { key: t.page.hook.UNREAD.all[t.page.hook.UNREAD.all.length - 3].key, time: 2000 };
  t.set([...evs, run('x1', 2004)]);
  assert.match(t.lineBefore(), /interim 2/);
  t.page.hook.UNREAD.mark = { key: t.page.hook.UNREAD.all[t.page.hook.UNREAD.all.length - 2].key, time: 2001 };
  t.set([...evs, run('x2', 2005)]);
  assert.match(t.lineBefore(), /answer 2/);
  const kids = t.box.children.map((c) => String(c.className));
  assert.ok(
    kids.findIndex((c) => c.includes('new-line')) > kids.findIndex((c) => c.includes('steps-block')),
    'after the fold, not before it',
  );
});

test('at the bottom everything is seen, whatever the view', () => {
  for (const view of ['full', 'chat']) {
    const t = unreadPage(view);
    t.set(turns(2));
    assert.equal(t.page.hook.seenAtOf('claude:a'), 1000 * (1010 + 3), view + ': even the steps this view folds away');
  }
});

test('Prompts marks replies seen only when the prompt is opened; hidden replies are not seen', () => {
  const t = unreadPage('prompts');
  t.set(turns(3));
  /* prompts alone are seen; every reply is hidden */
  assert.equal(
    t.page.hook.seenAtOf('claude:a'),
    1000 * 1000,
    'the first prompt is seen, nothing after its hidden reply',
  );
  const heads = () => byClass(t.box, 'pv-head');
  heads()[1].listeners.click(); // open the second prompt: its replies are seen, but the first prompt's replies are still hidden
  assert.equal(t.page.hook.seenAtOf('claude:a'), 1000 * 1000, 'seen stops at the first hidden reply');
  heads()[0].listeners.click(); // now the first prompt is open too: through the third prompt, which is yours
  assert.equal(t.page.hook.seenAtOf('claude:a'), 1000 * 1020);
  heads()[2].listeners.click();
  assert.equal(t.page.hook.seenAtOf('claude:a'), 1000 * 1023, 'every reply of the chat is seen');
  /* a new reply arrives in a closed prompt: not seen */
  t.set([...turns(3), say('question 3', 2000), reply('answer 3', 2001)]);
  assert.equal(t.page.hook.seenAtOf('claude:a'), 1000 * 2000, 'the new prompt is seen, its reply is not');
});

test('paused with nothing to scroll: follow comes back on its own, and the button goes', () => {
  const t = unreadPage('full');
  t.set(turns(1));
  t.scrollUp();
  t.set([...turns(1), say('question 1', 2000), reply('answer 1', 2001)]);
  assert.equal(t.box.dataset.paused, '1', 'still scrolled up in a long chat');
  /* the chat is short: everything fits, so no scroll event will ever fire */
  t.box.scrollHeight = 400;
  t.box.clientHeight = 500;
  t.box.scrollTop = 0;
  t.set([...turns(1), say('question 1', 2000), reply('answer 1 grows', 2001)]);
  assert.equal(t.box.dataset.paused, undefined, 'follow is back on');
  assert.equal(t.page.hook.unreadCount(), 0);
  assert.equal(t.page.element('jumpNew').hidden, true, 'no "Latest" button with nothing below');
});

test('sending while scrolled up jumps to your message, and it is not counted as new', async () => {
  const t = unreadPage('full');
  t.set(turns(2));
  t.scrollUp();
  assert.equal(t.box.dataset.paused, '1');
  const sent = [];
  t.page.context.fetch = async (url, options) => {
    sent.push(String(url));
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  t.page.element('prompt').value = 'one more';
  await t.page.element('promptForm').onsubmit({ preventDefault() {} });
  assert.ok(
    sent.some((u) => u.includes('/api/live/prompt')),
    'the message went out',
  );
  assert.equal(t.box.dataset.paused, undefined, 'follow is on again');
  t.set([...turns(2), say('one more', 3000)]);
  assert.equal(t.page.hook.unreadCount(), 0, 'your own message is not "new"');
  assert.equal(t.lines().length, 0, 'no New line above your message');
  assert.equal(t.box.scrollTop, t.box.scrollHeight, 'the view is at the end, where your message is');
});
