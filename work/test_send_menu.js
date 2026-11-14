'use strict';
const { APP: APP_DIR } = require('./_paths');
// The composer while the agent works (send-menu-ui.js): what Enter / Alt+Enter / Shift+Enter do, the words per agent, the keyboard
// menu, the background pill, the held rows (queue-ui.js) and the inbox quick reply. Snapshots are shaped per the steer contract
// (steerable, steerLane, tool.background); the server side lands separately.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { page } = require('./fake_dom.js');

const SM = require(path.join(APP_DIR, 'send-menu-ui.js'));
const Q = require(path.join(APP_DIR, 'queue-ui.js'));
const R = require(path.join(APP_DIR, 'inbox-reply.js'));
const C = SM.COPY;
const base = {
  busy: true,
  hasQueue: false,
  steerable: true,
  agentId: 'claude',
  agent: 'Claude Code',
  text: 'hello',
  commands: [],
};

/* ---- idle: exactly as today ---- */
test('idle: no menu, no key hint, plain Send and Enter', () => {
  const v = SM.view({ ...base, busy: false });
  assert.equal(v.working, false);
  assert.equal(v.more, false);
  assert.equal(v.keyHint, '');
  assert.deepEqual(v.items, []);
  assert.equal(SM.route({ ...base, busy: false }, 'default'), 'prompt');
  assert.equal(SM.route({ ...base, busy: false, hasQueue: true }, 'default'), 'queue');
});

/* ---- Claude Code's own follow-up cycle (T27): the plain Send of before, Enter waits for the cycle ---- */
test("the agent's own cycle (autonomous): no menu, no key hint, Enter waits for it to end as before", () => {
  const ctx = { ...base, autonomous: true, steerable: false };
  const v = SM.view(ctx);
  assert.equal(v.more, false);
  assert.equal(v.keyHint, '', 'no Send tooltip');
  assert.deepEqual(v.items, []);
  assert.equal(v.placeholder, C.placeholderQueue('Claude Code'));
  assert.equal(SM.route(ctx, 'default'), 'queue');
});

/* ---- working and steerable ---- */
test('working + steerable: Enter steers, Alt+Enter queues after the turn, the Send tooltip says so', () => {
  assert.equal(SM.route(base, 'default'), 'steer');
  assert.equal(SM.route(base, 'now'), 'steer');
  assert.equal(SM.route(base, 'after'), 'queue');
  assert.equal(SM.route(base, 'interrupt'), 'interrupt');
  const v = SM.view(base);
  assert.equal(v.more, true);
  assert.equal(v.keyHint, 'Enter sends now · Alt+Enter after this turn · Shift+Enter for a new line');
  assert.equal(v.placeholder, 'Message Claude Code… Enter sends now');
  assert.deepEqual(
    v.items.map((i) => [i.id, i.label, i.disabled]),
    [
      ['now', 'Send now', false],
      ['after', 'Send after this turn', false],
      ['interrupt', 'Interrupt and send', false],
    ],
  );
  assert.deepEqual(
    v.items.map((i) => i.key),
    ['Enter', 'Alt+Enter', ''],
  );
});

test('keys: Enter = default, Alt+Enter = after (only while working), Shift+Enter and composing are left alone', () => {
  const working = { busy: true },
    idle = { busy: false };
  assert.equal(SM.keyIntent({ key: 'Enter' }, working), 'default');
  assert.equal(SM.keyIntent({ key: 'Enter', altKey: true }, working), 'after');
  assert.equal(SM.keyIntent({ key: 'Enter', altKey: true }, idle), '');
  assert.equal(SM.keyIntent({ key: 'Enter', shiftKey: true }, working), '');
  assert.equal(SM.keyIntent({ key: 'Enter', isComposing: true }, working), '');
  assert.equal(SM.keyIntent({ key: 'Enter', ctrlKey: true }, working), '');
  assert.equal(SM.keyIntent({ key: 'a' }, working), '');
});

/* ---- the copy table ---- */
test('the grey line under Send now, per agent, in the brief words', () => {
  const now = (agentId, agent) => SM.view({ ...base, agentId, agent }).items[0].hint;
  assert.equal(
    now('claude', 'Claude Code'),
    'Claude Code answers right away. A command or helper it is running keeps going in the background.',
  );
  assert.equal(
    now('codex', 'Codex'),
    "Codex answers right away. A command it is running keeps going in the background, and Codex isn't told when it ends.",
  );
  assert.equal(
    now('omp', 'OMP'),
    'OMP answers right away. A command it is running moves to the background, and OMP stops it after 2 minutes in total.',
  );
  assert.equal(now('newagent', 'NewAgent'), 'NewAgent reads it during this turn.');
});

test('"Deny and send" is gone from every word the page shows', () => {
  const words = JSON.stringify(C, (k, v) => (typeof v === 'function' ? v('X') : v));
  assert.doesNotMatch(words, /Deny and send/);
  assert.doesNotMatch(JSON.stringify(Q.TEXT), /Deny and send/);
});

/* ---- working, agent cannot steer ---- */
test('working, cannot steer: button stays Send, Enter queues, Send now is greyed with the reason, key hint says why', () => {
  const ctx = { ...base, steerable: false, agentId: 'gemini', agent: 'Gemini CLI' };
  assert.equal(SM.route(ctx, 'default'), 'queue');
  const v = SM.view(ctx);
  assert.equal(v.more, true);
  assert.equal(v.keyHint, 'Gemini CLI can’t read messages mid-turn · Enter sends when it ends');
  assert.equal(v.placeholder, 'Message Gemini CLI… Enter sends when this turn ends');
  assert.equal(v.items[0].disabled, true);
  assert.equal(
    v.items[0].hint,
    'Gemini CLI can’t read messages during a turn. Use "Send after this turn" or "Interrupt and send".',
  );
  assert.equal(v.items[1].key, 'Enter'); // Enter is what sends after the turn here
  assert.equal(SM.route(ctx, 'interrupt'), 'interrupt');
});

/* ---- slash commands ---- */
test('slash commands (the agent own names and /doc) always go after the turn, with their own hint', () => {
  const commands = [{ name: 'compact' }, { name: '/model' }];
  const c = (text) => ({ ...base, text, commands });
  assert.equal(SM.route(c('/compact now'), 'default'), 'queue');
  assert.equal(SM.route(c('/model'), 'default'), 'queue');
  assert.equal(SM.route(c('/doc notes: brief'), 'default'), 'queue');
  assert.equal(SM.route(c('/unknown thing'), 'default'), 'steer'); // not a command of this agent: plain words
  assert.equal(SM.route(c('/usr/bin is a path'), 'default'), 'steer');
  const v = SM.view(c('/compact'));
  assert.equal(v.keyHint, 'Commands run after this turn');
  assert.equal(v.items[0].disabled, true);
  assert.equal(SM.isSlashCommand('hello /compact', commands), false);
});

/* ---- the menu: drawn, keyboard ---- */
function menu(viewOver) {
  const shell = page({ ids: ['bar'] });
  const bar = shell.byId.bar;
  const send = shell.make('button', 'send', bar);
  const picked = [];
  const m = SM.init({ doc: shell.document, root: shell.document, send, onPick: (id) => picked.push(id) });
  m.update(SM.view({ ...base, ...viewOver }));
  const key = (k, extra) => m.onKey(Object.assign({ key: k, preventDefault() {} }, extra));
  return { shell, m, send, picked, key };
}

test('the arrow menu shows only while working and opens with ArrowDown on the Send button', () => {
  const { m, send, key } = menu({ busy: false });
  assert.equal(m.state.more.hidden, true);
  assert.equal(key('ArrowDown'), false, 'idle: ArrowDown is left alone');
  m.update(SM.view(base));
  assert.equal(m.state.more.hidden, false);
  assert.equal(m.state.wrap.contains(send), true, 'Send sits inside the split');
  assert.equal(key('ArrowDown'), true);
  assert.equal(m.state.open, true);
  assert.equal(m.state.menu.hidden, false);
  assert.equal(m.state.more.getAttribute('aria-expanded'), 'true');
});

test('menu keyboard: arrows move, Enter picks, Esc closes and returns to Send', () => {
  const { m, send, picked, shell, key } = menu({});
  key('ArrowDown'); // open, first item active
  assert.equal(m.state.index, 0);
  key('ArrowDown');
  assert.equal(m.state.index, 1);
  key('ArrowDown');
  assert.equal(m.state.index, 2);
  key('ArrowDown'); // wraps
  assert.equal(m.state.index, 0);
  key('ArrowUp');
  assert.equal(m.state.index, 2);
  key('Escape');
  assert.equal(m.state.open, false);
  assert.equal(shell.document.activeElement, send);
  key('ArrowDown');
  key('ArrowDown');
  key('Enter');
  assert.deepEqual(picked, ['after']);
  assert.equal(m.state.open, false);
  key('ArrowDown');
  key('End');
  key(' ');
  assert.deepEqual(picked, ['after', 'interrupt']);
});

test('a greyed "Send now" is skipped by the keyboard and cannot be picked by a click', () => {
  const { m, picked, key } = menu({ steerable: false, agentId: 'gemini', agent: 'Gemini CLI' });
  key('ArrowDown');
  assert.equal(m.state.index, 1, 'the first enabled item is "Send after this turn"');
  key('ArrowUp');
  assert.equal(m.state.index, 2, 'wraps over the greyed one');
  m.state.buttons[0].click();
  assert.deepEqual(picked, []);
  m.state.buttons[1].click();
  assert.deepEqual(picked, ['after']);
});

test('the menu closes by itself when the agent stops working', () => {
  const { m, key } = menu({});
  key('ArrowDown');
  m.update(SM.view({ ...base, busy: false }));
  assert.equal(m.state.open, false);
  assert.equal(m.state.more.hidden, true);
});

test('the arrow button toggles the menu; a click outside closes it', () => {
  const { m, shell } = menu({});
  m.state.more.click();
  assert.equal(m.state.open, true);
  m.state.more.click();
  assert.equal(m.state.open, false);
  m.state.more.click();
  shell.document.dispatch('mousedown', { target: shell.body });
  assert.equal(m.state.open, false);
});

/* ---- background pill ---- */
test('background pill: running + stoppable shows Stop; done / stopped / not stoppable do not', async () => {
  const shell = page();
  const stops = [];
  const mk = (bg) => SM.backgroundPill(shell.document, bg, async () => stops.push(1));
  const running = mk({ state: 'running', stoppable: true });
  assert.match(running.textContent, /Still running in the background/);
  const stop = running.querySelector('.bg-stop');
  stop.click();
  assert.equal(stops.length, 1);
  assert.equal(stop.textContent, 'Stopping…');
  assert.equal(mk({ state: 'running', stoppable: false }).querySelector('.bg-stop'), null);
  assert.equal(mk({ state: 'stopped' }).textContent, 'Stopped by you');
  assert.equal(mk({ state: 'done' }).querySelector('.bg-stop'), null);
  assert.deepEqual(SM.backgroundOf({ background: { state: 'running', stoppable: true } }), {
    state: 'running',
    stoppable: true,
  });
  assert.equal(SM.backgroundOf({ title: 'Bash' }), null);
  // a refused Stop (409) puts the button back
  const failing = SM.backgroundPill(shell.document, { state: 'running', stoppable: true }, async () => {
    throw Error('409');
  });
  const b = failing.querySelector('.bg-stop');
  b.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(b.disabled, false);
  assert.equal(b.textContent, 'Stop');
});

/* ---- held rows above the composer ---- */
test('queue box: a held message shows with the held words, no edit buttons; injected ones are not listed', () => {
  const shell = page();
  const box = shell.make('div', 'q', shell.body);
  const ctx = { box, connection: 'c1', busy: true, post: async () => ({}), refresh: async () => {}, fail() {} };
  const lane = [
    { id: 'a', text: 'No, keep the old back-off', state: 'held', heldReason: 'approval' },
    { id: 'b', text: 'already in', state: 'injected' },
    { id: 'c', text: 'failed one', state: 'fallback' },
  ];
  Q.render(ctx, { items: [], reason: '' }, lane);
  assert.equal(box.hidden, false);
  const rows = box.querySelectorAll('.q-lane');
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Waits for your answer above · then goes in at once/);
  assert.match(rows[1].textContent, /sends when this turn ends/);
  assert.equal(rows[0].querySelector('.q-btn'), null);
  // nothing waiting: hidden again
  Q.render(ctx, { items: [], reason: '' }, []);
  assert.equal(box.hidden, true);
});

/* ---- inbox quick reply ---- */
test('inbox quick reply: a typed reply steers while the agent works and can steer; commands and non-steering agents queue', () => {
  const working = { busy: true, steerable: true, queue: { items: [] }, breadth: { commands: [{ name: 'compact' }] } };
  assert.equal(R.sendRoute(working, 'yes, go ahead'), 'steer');
  assert.equal(R.sendRoute(working), 'steer');
  assert.equal(R.sendRoute(working, '/compact'), 'queue');
  assert.equal(R.sendRoute({ ...working, steerable: false }, 'yes'), 'queue');
  assert.equal(R.sendRoute({ busy: false, steerable: false, queue: { items: [] } }, 'yes'), 'prompt');
  assert.equal(R.sendRoute({ busy: false, queue: { items: [{ id: 'a' }] } }, 'yes'), 'queue');
});

test('queue row up-arrow tooltip reads "Interrupt and send"', () => {
  assert.equal(Q.TEXT.sendNow, 'Interrupt and send');
});
