'use strict';
const { APP: APP_DIR } = require('./_paths');
/* Condensed views, QA fixes: Chat's never-fold rule, the working spinner, and the header switch in a narrow split pane. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const fakeDom = require('./fake_dom.js');
const { cssRules } = require('./css_rules.js');

const APP = APP_DIR;
const { project } = require(path.join(APP, 'views.js'));
const SCRIPTS = ['stream-ui.js', 'views.js', 'views-ui.js'];
const user = (value, time) => ({ role: 'user', label: 'You', value, time });
const asst = (value, time) => ({ role: 'assistant', label: 'Assistant', value, time });
const tool = (name, time) => ({ role: 'tool', label: name, value: '{}', time, call: { name, input: {} } });
const notice = (label, value, time, actions) => ({
  role: 'notice',
  label,
  value,
  time,
  ...(actions ? { actions } : {}),
});
const bodyRows = (u) => u.body.filter((b) => b.row).map((b) => b.row);
const texts = (u) => bodyRows(u).map((r) => r.value || r.role);

test('Chat always shows error/disconnected notices, rows with actions and unknown sends, and folds only steps', () => {
  const clash = notice('Studio', 'Your edits clash', 5, [{ id: 'keep', label: 'Keep my version' }]);
  const rows = [
    user('go', 1),
    tool('Bash', 2),
    notice('Studio', 'plain note', 2.5),
    notice('disconnected', 'Agent connection closed', 3),
    asst('partial', 4),
    notice('error', 'Agent crashed', 5),
    clash,
    { role: 'unknown-send', unknownSend: { id: 'u1', text: 'x' } },
  ];
  const chat = project(rows, 'chat').units[0];
  for (const v of ['Agent connection closed', 'Agent crashed', 'Your edits clash', 'unknown-send'])
    assert.ok(texts(chat).includes(v), 'Chat shows ' + v);
  assert.ok(!texts(chat).includes('plain note'), 'a plain notice is not drawn');
  assert.ok(!chat.body.some((b) => b.fold && b.fold.rows.some((r) => r.role === 'notice')), 'notices are never folded');
  /* the repro: the agent is killed mid-turn */
  const killed = project(
    [user('go', 1), tool('Bash', 2), notice('disconnected', 'Agent connection closed', 3), notice('error', 'boom', 4)],
    'chat',
  ).units[0];
  assert.deepEqual(texts(killed), ['Agent connection closed', 'boom']);
  assert.equal(killed.body.filter((b) => b.fold).length, 1, 'only the tool call is behind Show steps');
});

test('a running turn shows the plan card spinner before "Working…"', () => {
  const shell = fakeDom.page();
  const ctx = fakeDom.load(shell, SCRIPTS);
  const unit = {
    key: 'p:1',
    prompt: null,
    earlier: false,
    body: [{ line: 'working', text: 'Working…' }],
  };
  const nodes = ctx.ChatViewsUI.unitNodes(unit, {
    bubble: () => shell.document.createElement('div'),
    groupRows: (l) => l,
  });
  assert.ok(nodes[0].children[0].className.includes('plan-spin'));
  assert.equal(nodes[0].textContent, 'Working…');
});

test('the switch collapses by the header width, not the window width, and the title keeps a readable minimum', () => {
  /* a wide window (1400) whose header is only a split pane wide */
  const shell = fakeDom.page({ width: 1400 });
  let observed = null;
  shell.window.ResizeObserver = class {
    constructor(fn) {
      observed = { fn };
    }
    observe(el) {
      observed.el = el;
    }
  };
  const ctx = fakeDom.load(shell, SCRIPTS);
  const header = shell.make('header', 'hd', shell.body);
  const host = shell.make('div', 'viewSwitch', header);
  ctx.ChatViewsUI.mount(host, { get: () => 'full', set() {}, visible: () => true });
  assert.equal(observed.el, header, 'the header is watched');
  const at = (width) => {
    observed.fn([{ contentRect: { width } }]);
    return [header.classList.contains('vs-compact'), header.classList.contains('vs-narrow')];
  };
  assert.deepEqual(at(1100), [false, false], 'a wide header keeps the radio buttons');
  assert.deepEqual(at(510), [true, true], 'a 510px split pane gets the compact select and wrapped chips');
  assert.deepEqual(at(760), [true, false]);
  const rules = cssRules(fs.readFileSync(path.join(APP, 'views.css'), 'utf8'));
  const decl = (sel) => rules.find((r) => r.selector === sel && r.context === '')?.declarations || {};
  assert.equal(decl('header.vs-compact .vs-select').display, 'inline-block');
  assert.equal(decl('header.vs-compact .vs-group').display, 'none');
  assert.equal(decl('header:has(.view-switch:not([hidden])) .hd-main')['min-width'], '120px');
  assert.equal(decl('header.vs-narrow').hasOwnProperty('flex-wrap'), true);
  assert.ok(!rules.some((r) => r.context.startsWith('@media') && /vs-/.test(r.selector)), 'no window-width query');
});
