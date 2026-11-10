'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const dir = APP_DIR;
const slash = require(path.join(dir, 'commands-ui.js'));
const configUi = require(path.join(dir, 'config-ui.js'));
const ops = require(path.join(dir, 'session-ops.js'));

class Node {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.textContent = '';
    this.hidden = false;
    this.value = '';
    this.className = '';
    this.disabled = false;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  appendChild(n) {
    this.children.push(n);
    return n;
  }
  append(...n) {
    this.children.push(...n);
  }
  insertBefore(n, ref) {
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, n);
    return n;
  }
  replaceChildren(...n) {
    this.children = n;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  fire(type, ev = {}) {
    for (const fn of this.listeners[type] || []) fn(ev);
  }
  focus() {}
  get firstChild() {
    return this.children[0] || null;
  }
  querySelector() {
    return null;
  }
}
const document = { createElement: (tag) => new Node(tag) };

const COMMANDS = [
  { name: 'plan', description: 'Make a plan', hint: 'what to plan' },
  { name: 'compact', description: 'Compact' },
  { name: 'review', description: 'Review' },
];

function setup(commands = COMMANDS) {
  const textarea = new Node('textarea'),
    popup = new Node('div'),
    hintBox = new Node('div');
  let changes = 0;
  const controller = slash.createController({ textarea, popup, hintBox, document, onChange: () => changes++ });
  controller.setCommands(commands);
  const type = (value) => {
    textarea.value = value;
    controller.refresh();
  };
  const key = (k, extra = {}) => {
    const ev = {
      key: k,
      prevented: false,
      preventDefault() {
        this.prevented = true;
      },
      ...extra,
    };
    ev.consumed = controller.handleKey(ev);
    return ev;
  };
  return { textarea, popup, hintBox, controller, type, key, changes: () => changes };
}

test('popup opens only for a leading slash token and filters by prefix first', () => {
  const t = setup();
  t.type('hello');
  assert.equal(t.controller.isOpen(), false);
  t.type('/');
  assert.deepEqual(t.controller.state().items, ['plan', 'compact', 'review']);
  t.type('/c');
  assert.deepEqual(t.controller.state().items, ['compact']);
  t.type('/o');
  assert.deepEqual(t.controller.state().items, ['compact']); // substring match, after prefix matches
  t.type('/plan x');
  assert.equal(t.controller.isOpen(), false);
  t.type('text /plan');
  assert.equal(t.controller.isOpen(), false);
  t.type('/zzz');
  assert.equal(t.controller.isOpen(), false);
});

test('Up and Down move and wrap; Tab accepts and keeps the text editable', () => {
  const t = setup();
  t.type('/');
  let ev = t.key('ArrowDown');
  assert.ok(ev.consumed && ev.prevented);
  assert.equal(t.controller.state().index, 1);
  t.key('ArrowDown');
  t.key('ArrowDown');
  assert.equal(t.controller.state().index, 0);
  t.key('ArrowUp');
  assert.equal(t.controller.state().index, 2);
  ev = t.key('Tab');
  assert.ok(ev.consumed && ev.prevented);
  assert.equal(t.textarea.value, '/review ');
  assert.equal(t.controller.isOpen(), false);
  assert.equal(t.changes(), 1);
});

test('Enter accepts the highlighted command, then sends once the popup is closed', () => {
  const t = setup();
  t.type('/p');
  let ev = t.key('Enter');
  assert.ok(ev.consumed && ev.prevented);
  assert.equal(t.textarea.value, '/plan ');
  assert.equal(t.hintBox.textContent, 'what to plan');
  ev = t.key('Enter');
  assert.equal(ev.consumed, false);
  assert.equal(ev.prevented, false); // popup closed: normal send path
});

test('Enter on a fully typed command name is not swallowed, and plain text is untouched', () => {
  const t = setup();
  t.type('/compact');
  assert.equal(t.controller.isOpen(), true);
  assert.equal(t.key('Enter').consumed, false);
  t.type('hello');
  assert.equal(t.key('Enter').consumed, false);
  assert.equal(t.key('ArrowDown').consumed, false);
});

test('Escape closes until the text changes; Shift+Enter, composition and modifiers pass through', () => {
  const t = setup();
  t.type('/c');
  let ev = t.key('Escape');
  assert.ok(ev.consumed && ev.prevented);
  assert.equal(t.controller.isOpen(), false);
  t.controller.refresh();
  assert.equal(t.controller.isOpen(), false);
  assert.equal(t.key('Enter').consumed, false);
  t.type('/co');
  assert.equal(t.controller.isOpen(), true);
  for (const extra of [{ shiftKey: true }, { ctrlKey: true }, { isComposing: true }])
    assert.equal(t.key('Enter', extra).consumed, false);
  assert.equal(t.controller.isOpen(), true);
});

test('no commands means no popup; agent text is rendered as text, never markup', () => {
  const t = setup([]);
  t.type('/');
  assert.equal(t.controller.isOpen(), false);
  const evil = setup([{ name: 'x', description: '<img src=x onerror=alert(1)>', hint: '<b>h</b>' }]);
  evil.type('/');
  const row = evil.popup.children[0];
  assert.equal(row.children[2].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(row.children[1].textContent, ' <b>h</b>');
  assert.equal(row.innerHTML, undefined);
});

test('mouse selection accepts a command', () => {
  const t = setup();
  t.type('/');
  let prevented = false;
  t.popup.children[1].fire('mousedown', {
    preventDefault() {
      prevented = true;
    },
  });
  assert.ok(prevented);
  assert.equal(t.textarea.value, '/compact ');
});

test('hint shows for a hinted command followed by a space', () => {
  assert.equal(slash.hintFor(COMMANDS, '/plan '), 'what to plan');
  assert.equal(slash.hintFor(COMMANDS, '/plan do it'), '');
  assert.equal(slash.hintFor(COMMANDS, '/compact '), '');
});

test('config controls cover select, grouped select, boolean and read-only unknown types', () => {
  const box = new Node('div');
  box.ownerDocument = document;
  const calls = [];
  const settings = {
    modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
    configOptions: [
      { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: true },
      {
        id: 'tweak',
        name: 'Tweak',
        category: 'model_config',
        type: 'select',
        currentValue: 'a',
        options: [{ value: 'a', name: 'A' }],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'deep',
        options: [{ group: 'g', name: 'Large', options: [{ value: 'deep', name: 'Deep' }] }],
      },
      { id: 'dial', name: 'Dial', type: 'slider', currentValue: 7 },
      {
        id: 'mode',
        name: 'Mode dup',
        type: 'select',
        currentValue: 'code',
        options: [{ value: 'code', name: 'Code' }],
      },
    ],
  };
  assert.deepEqual(
    configUi.orderOptions(settings.configOptions).map((o) => o.id),
    ['verbose', 'model', 'tweak', 'dial', 'mode'],
  );
  configUi.render(box, settings, { disabled: false, onMode() {}, onConfig: (...a) => calls.push(a) });
  const labels = box.children.map((c) => c.children[0].textContent || c.textContent);
  assert.equal(box.children.length, 5); // mode, verbose, model, tweak, dial (duplicate "mode" option skipped)
  const toggle = box.children[1].children[0];
  assert.equal(toggle.checked, true);
  toggle.checked = false;
  toggle.fire('change');
  return Promise.resolve().then(() => {
    assert.deepEqual(calls, [['verbose', false, 'boolean']]);
    const dial = box.children[4];
    assert.match(dial.children[0].textContent, /7 \(read-only\)/);
    assert.equal(dial.children.length, 1);
    assert.ok(labels.length);
    const grouped = box.children[2].children[0];
    assert.equal(grouped.children[0].tag, 'optgroup');
    assert.equal(grouped.value, 'deep');
  });
});

test('config controls are disabled while a turn is running', () => {
  const box = new Node('div');
  box.ownerDocument = document;
  configUi.render(
    box,
    { configOptions: [{ id: 'verbose', name: 'V', type: 'boolean', currentValue: false }] },
    { disabled: true },
  );
  assert.equal(box.children[0].children[0].disabled, true);
});

test('usage strip shows only reported values', () => {
  assert.deepEqual(ops.formatUsage(null), []);
  assert.deepEqual(ops.formatUsage({ size: 200000, used: 50000, cost: { amount: 0.25, currency: 'USD' } }), [
    'Context 50,000 / 200,000 tokens (25%)',
    'Cost 0.25 USD',
  ]);
  assert.deepEqual(ops.formatUsage({ size: null, used: 5, cost: null }), ['Context 5 tokens']);
  const s = ops.stripSummary({
    usage: null,
    sessionInfo: { title: 'T' },
    notices: [1, 2, 3, 4].map((id) => ({ id })),
    compaction: [],
  });
  assert.equal(s.title, 'T');
  assert.equal(s.notices.length, 3);
  assert.deepEqual(s.usage, []);
});
