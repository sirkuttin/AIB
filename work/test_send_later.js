'use strict';
const { PAGE: APP_DIR } = require('./_paths');
// Send later (owner, 2026-11-23): the page side. The Send menu's "Send later…" panel (quick picks, a date and time field, keyboard),
// the "Scheduled for …" cards in the queue box with their always-visible ✎ ↑ ✕, and chat.js posting the schedule and clearing the box.
// The server side (timer, restart, late) is work/deno/send_later_test.ts.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { page } = require('./fake_dom.js');
const { makePage } = require('./chat_harness.js');

const SM = require(path.join(APP_DIR, 'send-menu-ui.js'));
const Q = require(path.join(APP_DIR, 'queue-ui.js'));
const C = SM.COPY;
const base = { busy: false, hasQueue: false, steerable: false, agentId: 'claude', agent: 'Claude Code', text: 'hello', commands: [] };
const tick = () => new Promise((r) => setImmediate(r));

/* ---- pure rules ---- */
test('quick picks: in 30 minutes, in 1 hour, in 3 hours, tomorrow 9:00 (local time)', () => {
  const now = new Date(2026, 10, 23, 14, 10).getTime();
  const picks = SM.laterPicks(now);
  assert.deepEqual(picks.map((p) => p.label), ['In 30 minutes', 'In 1 hour', 'In 3 hours', 'Tomorrow 9:00']);
  assert.deepEqual(picks.slice(0, 3).map((p) => p.at - now), [30 * 60000, 60 * 60000, 3 * 3600000]);
  assert.equal(picks[3].at, new Date(2026, 10, 24, 9, 0).getTime());
});

test('a time in words: today, tomorrow, later', () => {
  const now = new Date(2026, 10, 23, 14, 10).getTime();
  assert.equal(SM.whenWords(new Date(2026, 10, 23, 15, 30).getTime(), now), '3:30 PM');
  assert.equal(SM.whenWords(new Date(2026, 10, 24, 9, 0).getTime(), now), 'tomorrow 9:00 AM');
  assert.equal(SM.whenWords(new Date(2026, 10, 30, 9, 5).getTime(), now), 'Mon, Nov 30, 9:05 AM');
  assert.equal(C.scheduledFor('3:30 PM'), 'Scheduled for 3:30 PM');
});

test('the date and time field: a future time is taken, a past or empty one says why', () => {
  const now = new Date(2026, 10, 23, 14, 10).getTime();
  assert.equal(SM.customAt('2026-11-24T09:00', now).at, new Date(2026, 10, 24, 9, 0).getTime());
  assert.equal(SM.customAt('2026-11-23T09:00', now).error, C.laterPast);
  assert.equal(SM.customAt('', now).error, C.laterNone);
  assert.equal(SM.localValue(new Date(2026, 10, 23, 15, 7).getTime()), '2026-11-23T15:10');
});

test('the menu item is greyed with the reason while the box is empty; the menu is there idle too', () => {
  const v = SM.view({ ...base, hasContent: false });
  assert.equal(v.more, true);
  assert.deepEqual(v.items.map((i) => [i.id, i.label, i.disabled, i.hint]), [['later', 'Send later…', true, C.laterNeedsText]]);
  assert.equal(SM.view({ ...base, hasContent: true }).items[0].disabled, false);
});

/* ---- the menu ---- */
function menu(over) {
  const shell = page({ ids: ['bar'] });
  const send = shell.make('button', 'send', shell.byId.bar);
  const scheduled = [];
  const m = SM.init({ doc: shell.document, root: shell.document, send, onPick() {}, onSchedule: (at) => scheduled.push(at) });
  m.update(SM.view({ ...base, ...over }));
  const key = (k, extra) => m.onKey(Object.assign({ key: k, preventDefault() {} }, extra));
  return { shell, m, send, scheduled, key };
}

test('Send later… opens the picks in the same menu; a quick pick schedules and closes', () => {
  const { m, scheduled } = menu({});
  m.state.more.click();
  assert.equal(m.state.menu.querySelectorAll('.send-item').length, 1);
  m.state.buttons[0].click(); // Send later…
  assert.equal(m.state.open, true);
  assert.equal(m.state.mode, 'later');
  const items = m.state.menu.querySelectorAll('.send-item');
  assert.deepEqual(items.map((b) => b.querySelector('b').textContent), ['In 30 minutes', 'In 1 hour', 'In 3 hours', 'Tomorrow 9:00', 'Schedule', C.laterBack]);
  const before = Date.now();
  items[1].click();
  assert.equal(scheduled.length, 1);
  assert.ok(Math.abs(scheduled[0] - (before + 3600000)) < 5000, 'an hour from now');
  assert.equal(m.state.open, false);
});

test('keyboard: ArrowDown opens, Enter on Send later… shows the picks, arrows and Enter pick one', () => {
  const { m, scheduled, key } = menu({});
  assert.equal(key('ArrowDown'), true);
  assert.equal(m.state.open, true);
  key('Enter');
  assert.equal(m.state.mode, 'later');
  assert.equal(m.state.index, 0);
  key('ArrowDown');
  key('ArrowDown');
  assert.equal(m.state.index, 2);
  key('Enter');
  assert.equal(scheduled.length, 1);
  assert.ok(Math.abs(scheduled[0] - (Date.now() + 3 * 3600000)) < 5000, 'in 3 hours');
  assert.equal(m.state.open, false);
});

test('keyboard: Tab walks the panel (the menu does not close), Escape closes it', () => {
  const { m, key } = menu({});
  key('ArrowDown');
  key('Enter');
  assert.equal(key('Tab'), false, 'left to the browser: the field and the buttons are reached with Tab');
  assert.equal(m.state.open, true);
  key('Escape');
  assert.equal(m.state.open, false);
});

test('the date and time field: Enter in it schedules; a past time shows the error and keeps the panel', () => {
  const { m, scheduled } = menu({});
  m.state.more.click();
  m.state.buttons[0].click();
  const input = m.state.input;
  assert.equal(input.type, 'datetime-local');
  input.value = '2000-01-01T09:00';
  m.state.menu.querySelector('.send-later-go').click();
  assert.equal(scheduled.length, 0);
  assert.equal(m.state.open, true);
  const err = m.state.menu.querySelector('.send-later-error');
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, C.laterPast);
  const future = new Date(Date.now() + 2 * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  input.value = future.getFullYear() + '-' + pad(future.getMonth() + 1) + '-' + pad(future.getDate()) + 'T10:30';
  input.dispatch('keydown', { key: 'Enter' });
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0], new Date(future.getFullYear(), future.getMonth(), future.getDate(), 10, 30).getTime());
  assert.equal(m.state.open, false);
});

test('Back returns to the list', () => {
  const { m } = menu({});
  m.state.more.click();
  m.state.buttons[0].click();
  m.state.menu.querySelector('.send-later-back').click();
  assert.equal(m.state.mode, 'list');
  assert.equal(m.state.menu.querySelectorAll('.send-item').length, 1);
});

/* ---- the cards in the queue box ---- */
function cards(scheduled, extra = {}) {
  const shell = page();
  const box = shell.make('div', 'q', shell.body);
  const posts = [];
  const ctx = {
    box,
    connection: 'c1',
    busy: false,
    post: async (name, body) => {
      posts.push([name, body]);
      return {};
    },
    refresh: async () => {},
    fail(e) {
      throw e;
    },
    ...extra,
  };
  const at = Date.now() + 90 * 60000;
  const items = scheduled || [{ id: 's1', text: 'run the nightly check', attachments: [], queuedAt: 1, at }];
  const render = () => Q.render(ctx, { items: [], reason: '', scheduled: items }, []);
  Q.state.sig = ''; // the module remembers the last drawing: a new box always draws
  Q.state.sched = null;
  render();
  return { box, posts, ctx, render, at, items, shell };
}

test('a scheduled message shows as a card that reads "Scheduled for <time>" with ✎ ↑ ✕ always visible', () => {
  const { box, at } = cards();
  assert.equal(box.hidden, false);
  assert.match(box.querySelector('.q-head').textContent, /1 scheduled/);
  const row = box.querySelector('.q-sched');
  assert.match(row.querySelector('.q-text').textContent, /run the nightly check/);
  assert.equal(row.querySelector('.q-lane-note').textContent, 'Scheduled for ' + SM.whenWords(at, Date.now()));
  const btns = row.querySelectorAll('.q-btn');
  assert.deepEqual(btns.map((b) => b.textContent), ['✎', '↑', '✕']);
  assert.equal(row.querySelector('.q-actions').hidden, false, 'never behind a hover or a menu');
  assert.ok(btns.every((b) => !b.hidden && b.getAttribute('aria-label')));
});

test('✕ cancels and ↑ sends now: the schedule routes, by message id', async () => {
  const { box, posts } = cards();
  const [, up, cancel] = box.querySelector('.q-sched').querySelectorAll('.q-btn');
  up.click();
  await tick();
  cancel.click();
  await tick();
  assert.deepEqual(posts, [
    ['schedule-send-now', { id: 'c1', messageId: 's1' }],
    ['schedule-cancel', { id: 'c1', messageId: 's1' }],
  ]);
});

test('✎ opens the text and the time; Save posts both, a past time is refused on the page', async () => {
  const { box, posts, shell, render } = cards();
  box.querySelector('.q-sched').querySelector('.q-btn').click();
  await tick();
  render(); // the page's refresh draws the open editor
  const row = box.querySelector('.q-sched-edit');
  assert.ok(row, 'the editing row replaces the card');
  const area = row.querySelector('.q-area'),
    when = row.querySelector('.q-when');
  assert.equal(area.value, 'run the nightly check');
  assert.equal(when.type, 'datetime-local');
  when.value = '2000-01-01T09:00';
  row.querySelector('.q-save').click();
  await tick();
  assert.equal(posts.length, 0);
  assert.equal(row.querySelector('.q-sched-error').hidden, false);
  const d = new Date(Date.now() + 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  when.value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T08:15';
  area.value = 'run the nightly check, then the report';
  row.querySelector('.q-save').click();
  await tick();
  assert.deepEqual(posts, [
    [
      'schedule-edit',
      {
        id: 'c1',
        messageId: 's1',
        text: 'run the nightly check, then the report',
        at: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 15).getTime(),
      },
    ],
  ]);
  void shell;
});

test('with queued messages too, the scheduled card sits below them; nothing scheduled: no card', () => {
  const shell = page();
  const box = shell.make('div', 'q', shell.body);
  const ctx = { box, connection: 'c9', busy: true, post: async () => ({}), refresh: async () => {}, fail() {} };
  const q = {
    items: [{ id: 'a', text: 'queued one', attachments: [] }],
    reason: '',
    scheduled: [{ id: 's', text: 'later one', attachments: [], at: Date.now() + 60000 }],
  };
  Q.render(ctx, q, []);
  assert.deepEqual(box.querySelectorAll('.q-row').map((r) => r.querySelector('.q-text').textContent), ['queued one', 'later one']);
  Q.render(ctx, { items: [{ id: 'a', text: 'queued one', attachments: [] }], reason: '' }, []);
  assert.equal(box.querySelectorAll('.q-sched').length, 0);
});

/* ---- chat.js: the menu pick posts the schedule and clears the box ---- */
test('scheduling from the composer posts the schedule with the time, clears the box, and refreshes', async () => {
  const posts = [];
  const p = makePage({
    scripts: ['send-menu-ui.js', 'queue-ui.js', 'inbox-reply.js'],
    routes: {
      '/api/live/schedule': (_q, body) => {
        posts.push(['schedule', body]);
        return { body: { ok: true, queue: { items: [] } } };
      },
      '/api/live/prompt': (_q, body) => {
        posts.push(['prompt', body]);
        return { body: { ok: true } };
      },
      '/api/live/state': () => ({ body: { id: 'c1', ready: true, closed: false, busy: false } }),
      '/api/live/list': () => ({ body: { connections: [], recovered: [], instanceId: 'A' } }),
    },
  });
  p.run(
    "selected = { provider: 'claude', id: 's1', cwd: 'C:/p', key: 'claude:s1' }; current = 'c1'; snapshot = " +
      JSON.stringify({ id: 'c1', ready: true, closed: false, busy: false, queue: { items: [] } }),
  );
  p.element('prompt').value = 'send the weekly report';
  const at = Date.now() + 3600000;
  p.run('scheduleSend(' + at + ')');
  await p.tick();
  await p.tick();
  await p.tick();
  assert.deepEqual(posts.map((x) => x[0]), ['schedule'], 'nothing is sent now');
  assert.equal(posts[0][1].id, 'c1');
  assert.equal(posts[0][1].text, 'send the weekly report');
  assert.equal(posts[0][1].at, at);
  assert.ok(posts[0][1].clientMessageId, 'a client message id rides along so a retry cannot schedule twice');
  assert.equal(p.element('prompt').value, '', 'the message box clears');
});
