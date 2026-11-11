const { APP: APP_DIR } = require('./_paths');
// Package B UI tests: URL elicitation, routing labels, withdrawal and authentication cards.
const test = require('node:test');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.options = [];
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.className = '';
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
    n.parent = this;
    return n;
  }
  append(...ns) {
    ns.forEach((n) => this.appendChild(n));
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute(k, v) {
    (this.attrs = this.attrs || {})[k] = String(v);
  }
  removeAttribute(k) {
    if (this.attrs) delete this.attrs[k];
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((x) => x !== this);
  }
  click() {
    return this.listeners.click && this.listeners.click();
  }
}
const find = (node, pred, out = []) => {
  if (pred(node)) out.push(node);
  node.children.forEach((c) => find(c, pred, out));
  return out;
};
const byClass = (node, cls) => find(node, (n) => String(n.className).split(' ').includes(cls));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function load() {
  const window = {},
    opened = [];
  window.open = (...args) => opened.push(args);
  const document = { createElement: (tag) => new Node(tag) };
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
    URL,
    RegExp,
  });
  return { ui: window.AgentElicitationUI, opened };
}
const urlRequest = (url, extra = {}) => ({
  key: 'u1',
  params: { mode: 'url', sessionId: 'main', elicitationId: 'e1', message: 'Sign in <b>now</b>', url, ...extra },
});

test('url card shows the full destination with the host emphasized and never opens by itself', async () => {
  const { ui, opened } = load();
  const root = new Node('main');
  let answer;
  ui.render(root, [urlRequest('https://accounts.example.com:8443/oauth/start?client=1#frag')], {
    providerName: 'Claude',
    mainSessionId: 'main',
    onRespond: async (...a) => {
      answer = a;
    },
  });
  const card = root.children[0];
  assert.ok(card.textContent.includes('Sign in <b>now</b>'));
  const line = byClass(card, 'elicitation-url')[0];
  assert.equal(line.textContent, 'https://accounts.example.com:8443/oauth/start?client=1#frag');
  const host = find(line, (n) => n.tagName === 'strong')[0];
  assert.equal(host.textContent, 'accounts.example.com:8443');
  const link = byClass(card, 'elicitation-open')[0];
  assert.equal(link.href, 'https://accounts.example.com:8443/oauth/start?client=1#frag');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(opened.length, 0);
  const [confirm, decline, cancel] = byClass(card, 'elicitation-actions')[0].children;
  assert.equal(confirm.disabled, true, 'completion cannot be confirmed before the link was opened');
  link.click();
  assert.equal(confirm.disabled, false);
  confirm.click();
  await tick();
  assert.equal(JSON.stringify(answer), JSON.stringify(['u1', 'accept', {}]));
  assert.equal(root.children.length, 0);
  assert.ok(decline && cancel);
});

test('url decline and cancel are always available and send explicit actions', async () => {
  const { ui } = load();
  for (const action of ['decline', 'cancel']) {
    const root = new Node('main');
    let answer;
    ui.render(root, [urlRequest('http://localhost:3000/cb')], {
      onRespond: async (...a) => {
        answer = a;
      },
    });
    const buttons = byClass(root.children[0], 'elicitation-actions')[0].children;
    buttons[action === 'decline' ? 1 : 2].click();
    await tick();
    assert.equal(JSON.stringify(answer), JSON.stringify(['u1', action, {}]));
  }
});

test('unsafe or credentialed urls are shown as unusable: no link, no confirmation', () => {
  const { ui } = load();
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,hi',
    'file:///c:/secret',
    'https://user:pw@example.com/',
    'ftp://example.com/',
    'not a url',
    '',
    undefined,
  ]) {
    const root = new Node('main');
    ui.render(root, [urlRequest(bad)], { onRespond: async () => {} });
    const card = root.children[0];
    assert.equal(byClass(card, 'elicitation-open').length, 0, String(bad));
    assert.equal(find(card, (n) => n.tagName === 'a').length, 0);
    assert.equal(byClass(card, 'elicitation-actions')[0].children[0].disabled, true);
    assert.ok(byClass(card, 'elicitation-issue').length >= 1);
  }
  assert.equal(ui.safeUrl('https://example.com/ok').host, 'example.com');
  assert.equal(ui.safeUrl('https://exa mple.com'), null);
});

test('requests are labeled with the asking agent and subagents can be shown', () => {
  const { ui } = load();
  let shown;
  const root = new Node('main');
  const ctx = {
    providerName: 'Claude',
    mainSessionId: 'main',
    sessionNames: { child: 'Researcher' },
    onShowAgent: (id) => {
      shown = id;
    },
    onRespond: async () => {},
  };
  const form = (key, sessionId, route) => ({
    key,
    route,
    params: { mode: 'form', sessionId, message: 'm', requestedSchema: { type: 'object', properties: {} } },
  });
  ui.render(
    root,
    [
      form('a', 'main', 'main'),
      form('b', 'child', 'subagent'),
      form('c', 'mystery', 'unknown'),
      form('d', undefined, 'setup'),
    ],
    ctx,
  );
  const [main, sub, unknown, setup] = root.children;
  assert.ok(main.textContent.startsWith('Claude asks'));
  assert.equal(main.dataset.route, 'main');
  assert.ok(sub.textContent.startsWith('Researcher asks'));
  assert.ok(sub.textContent.includes('Subagent: Researcher'));
  assert.equal(sub.dataset.route, 'subagent');
  byClass(sub, 'elicitation-show')[0].click();
  assert.equal(shown, 'child');
  assert.equal(byClass(main, 'elicitation-show').length, 0);
  assert.equal(unknown.dataset.route, 'unknown');
  assert.ok(unknown.textContent.includes('Unrecognized session mystery'));
  assert.ok(setup.textContent.startsWith('Claude asks'));
  assert.equal(setup.dataset.route, 'setup');
  assert.deepEqual(
    { ...ui.routeInfo('child', 'subagent', { mainSessionId: 'main' }) },
    { kind: 'subagent', name: 'Subagent child', sessionId: 'child' },
  );
  assert.equal(ui.routeInfo('x', undefined, { mainSessionId: 'main' }).kind, 'unknown');
  /* an unnamed subagent: the heading already says "Subagent child-se…", so no "Subagent: Subagent …" line under it */
  assert.equal(ui.routeNote(ui.routeInfo('child-session-1', 'subagent', { mainSessionId: 'main' })), '');
  assert.equal(ui.routeNote({ kind: 'subagent', name: 'Researcher' }), 'Subagent: Researcher');
});

test('withdrawn requests disappear and a stale answer reports the server error', async () => {
  const { ui } = load();
  const root = new Node('main');
  const request = {
    key: 'w1',
    params: { mode: 'form', message: 'q', requestedSchema: { type: 'object', properties: {} } },
  };
  ui.render(root, [request], {
    onRespond: async () => {
      throw new Error('This request was withdrawn: The turn that asked for this has ended.');
    },
  });
  const card = root.children[0];
  byClass(card, 'elicitation-actions')[0].children[0].click();
  await tick();
  const error = byClass(card, 'elicitation-error')[0];
  assert.equal(error.hidden, false);
  assert.ok(error.textContent.includes('withdrawn'));
  assert.equal(root.children.length, 1);
  ui.render(root, [], {});
  assert.equal(root.children.length, 0);
  ui.render(root, [request], { onRespond: async () => {} });
  ui.render(root, [request, { ...request, key: 'w2' }], { onRespond: async () => {} });
  assert.equal(root.children.length, 2);
  ui.render(root, [{ ...request, key: 'w2' }], { onRespond: async () => {} });
  assert.equal(root.children.length, 1);
  assert.equal(root.children[0].dataset.elicitationKey, 'w2');
});

test('sign-in card offers in-app methods, shows terminal instructions as text, and supports retry and cancel', async () => {
  const { ui } = load();
  const root = new Node('div');
  const calls = [];
  const auth = {
    message: 'Authentication required',
    error: '',
    working: false,
    methods: [
      { id: 'm1', name: 'Browser sign-in', description: 'Sign in with your account', kind: 'agent', instructions: '' },
      {
        id: 'm2',
        name: 'Terminal login',
        description: '',
        kind: 'terminal',
        instructions: 'Run `claude /login` in a terminal <b>now</b>, then choose Retry.',
      },
    ],
  };
  ui.renderAuth(root, auth, {
    providerName: 'Claude',
    onAuth: async (...a) => {
      calls.push(a);
    },
  });
  const card = root.children[0];
  assert.ok(card.textContent.includes('Claude needs you to sign in'));
  assert.ok(card.textContent.includes('Run `claude /login` in a terminal <b>now</b>'));
  const methodBoxes = byClass(card, 'auth-method');
  assert.equal(find(methodBoxes[0], (n) => n.tagName === 'button').length, 1);
  assert.equal(
    find(methodBoxes[1], (n) => n.tagName === 'button').length,
    0,
    'terminal methods are never run by Studio',
  );
  find(methodBoxes[0], (n) => n.tagName === 'button')[0].click();
  await tick();
  const [retry, cancel] = byClass(card, 'elicitation-actions')[0].children;
  retry.click();
  await tick();
  cancel.click();
  await tick();
  assert.deepEqual(calls, [
    ['authenticate', 'm1'],
    ['retry', undefined],
    ['cancel', undefined],
  ]);
  // identical state keeps the same card; changed state replaces it; null removes it
  ui.renderAuth(root, auth, { onAuth: async () => {} });
  assert.equal(root.children[0], card);
  ui.renderAuth(root, { ...auth, error: 'Sign-in failed: nope' }, { onAuth: async () => {} });
  assert.notEqual(root.children[0], card);
  assert.ok(root.children[0].textContent.includes('Sign-in failed: nope'));
  ui.renderAuth(root, null, {});
  assert.equal(root.children.length, 0);
});

test('sign-in errors from the server are shown and buttons recover', async () => {
  const { ui } = load();
  const root = new Node('div');
  ui.renderAuth(
    root,
    { message: '', error: '', working: false, methods: [{ id: 'm1', name: 'Sign in', kind: 'agent' }] },
    {
      onAuth: async () => {
        throw new Error('Unknown sign-in method');
      },
    },
  );
  const card = root.children[0];
  const button = find(card, (n) => n.tagName === 'button')[0];
  button.click();
  await tick();
  assert.equal(byClass(card, 'elicitation-error')[0].textContent, 'Unknown sign-in method');
  assert.equal(button.disabled, false);
  const empty = new Node('div');
  ui.renderAuth(empty, { methods: [], working: false }, { onAuth: async () => {} });
  assert.ok(empty.children[0].textContent.includes('did not offer a method'));
  assert.equal(byClass(empty.children[0], 'elicitation-actions')[0].children.length, 2);
});
