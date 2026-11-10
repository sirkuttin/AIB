const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.options = [];
    this.value = '';
    this.checked = false;
    this.selected = false;
    this.disabled = false;
    this.hidden = false;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text || this.children.map((x) => x.textContent).join('');
  }
  appendChild(n) {
    this.children.push(n);
    if (n.tagName === 'option') {
      this.options.push(n);
      if (this.selectedIndex == null) this.selectedIndex = 0;
    }
    n.parent = this;
    return n;
  }
  append(...ns) {
    ns.forEach((n) => this.appendChild(n));
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
  }
  click() {
    return this.listeners.click && this.listeners.click();
  }
  get value() {
    return this._value || '';
  }
  set value(v) {
    this._value = String(v);
    if (this.tagName === 'select' && this.options) {
      const i = this.options.findIndex((o) => o.value === this._value);
      if (i >= 0) this.selectedIndex = i;
    }
  }
}
const document = { createElement: (tag) => new Node(tag) };
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'elicitation-ui.js'), 'utf8'), {
  window,
  document,
  Set,
  Map,
  WeakMap,
  Array,
  Object,
  String,
  Number,
  JSON,
  Error,
});
const root = new Node('main');
const req = {
  key: 'r1',
  params: {
    mode: 'form',
    sessionId: 'sub',
    message: '<img onerror=x>',
    requestedSchema: {
      type: 'object',
      required: ['approved', 'count'],
      properties: {
        approved: { type: 'boolean' },
        count: { type: 'integer', minimum: 1, maximum: 9 },
        flavor: {
          type: 'string',
          oneOf: [
            { const: 'a', title: 'A', description: '<script>tradeoff</script>' },
            { const: 'b', title: 'B', description: 'Second option tradeoff' },
          ],
        },
        extras: {
          type: 'array',
          items: { anyOf: [{ const: 'x', title: 'X', description: 'Extra option description' }] },
        },
      },
    },
  },
};
let sent, staleSent;
const context = {
  providerName: 'Provider',
  mainSessionId: 'main',
  sessionNames: { sub: 'Researcher' },
  onRespond: async (...args) => {
    staleSent = args;
  },
};
window.AgentElicitationUI.render(root, [req], context);
assert.equal(root.children.length, 1);
const card = root.children[0];
assert.equal(
  card.children.some((n) => n.textContent.includes('<img onerror=x>')),
  true,
); // displayed as literal text
assert.ok(card.textContent.includes('Subagent: Researcher'));
assert.ok(card.textContent.includes('A: <script>tradeoff</script>'));
assert.ok(card.textContent.includes('B: Second option tradeoff'));
assert.ok(card.textContent.includes('X: Extra option description'));
const inputs = card.children
  .find((n) => n.className === 'elicitation-fields')
  .children.map((label) => label.children.find((n) => n.tagName === 'input' || n.tagName === 'select'));
inputs[1].value = '4';
let latestContext = {
  ...context,
  onRespond: async (...args) => {
    sent = args;
  },
};
window.AgentElicitationUI.render(root, [req], latestContext);
assert.ok(card.textContent.includes('approved (required)'));
// Required false checkbox is a valid explicit boolean answer.
card.children.find((n) => n.className === 'elicitation-actions').children[0].click();
setImmediate(async () => {
  assert.equal(JSON.stringify(sent), JSON.stringify(['r1', 'accept', { approved: false, count: 4 }]));
  assert.equal(staleSent, undefined);
  assert.equal(root.children.length, 0);
  window.AgentElicitationUI.render(root, [req], context);
  const preserved = root.children[0];
  const count = preserved.children
    .find((n) => n.className === 'elicitation-fields')
    .children[1].children.find((n) => n.tagName === 'input');
  count.value = '6';
  window.AgentElicitationUI.render(root, [req], context);
  assert.equal(root.children[0], preserved);
  assert.equal(count.value, '6');
  const emptyRoot = new Node('main');
  let emptyAnswer;
  window.AgentElicitationUI.render(
    emptyRoot,
    [{ key: 'empty', params: { mode: 'form', requestedSchema: { type: 'object', properties: {} } } }],
    {
      onRespond: async (...args) => {
        emptyAnswer = args;
      },
    },
  );
  emptyRoot.children[0].children.find((n) => n.className === 'elicitation-actions').children[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(emptyAnswer), JSON.stringify(['empty', 'accept', {}]));

  const optionalRoot = new Node('main');
  let optionalAnswer;
  window.AgentElicitationUI.render(
    optionalRoot,
    [
      {
        key: 'optional',
        params: { mode: 'form', requestedSchema: { type: 'object', properties: { maybe: { type: 'boolean' } } } },
      },
    ],
    {
      onRespond: async (...args) => {
        optionalAnswer = args;
      },
    },
  );
  optionalRoot.children[0].children.find((n) => n.className === 'elicitation-actions').children[0].click();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(optionalAnswer), JSON.stringify(['optional', 'accept', {}]));
  console.log('elicitation UI tests passed');
});
