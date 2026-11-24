/* The chat's sign-in card (elicitation-ui.js signinCard): a mid-session "needs you to sign in again" card with one Sign in button,
   a choice only when there are several ways, the agent's words under Details; Sign in runs the terminal command (fake runner) and
   nothing before the click; exit 0 asks the server to retry; a failure says so and offers Try again. */
const { PAGE: APP_DIR } = require('./_paths');
const test = require('node:test');
const path = require('node:path');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag) {
    Object.assign(this, { tagName: tag, children: [], listeners: {}, dataset: {}, checked: false, disabled: false, hidden: false });
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
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute(k, v) {
    (this.attrs = this.attrs || {})[k] = String(v);
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
  const window = {};
  const document = { createElement: (tag) => new Node(tag) };
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'elicitation-ui.js'), 'utf8'), { window, document });
  return window.AgentElicitationUI;
}

const CLAUDE = [
  { id: 'claude-ai-login', name: 'Claude Subscription', kind: 'terminal', args: ['--cli', 'auth', 'login', '--claudeai'] },
  { id: 'console-login', name: 'Anthropic Console', kind: 'terminal', args: ['--cli', 'auth', 'login', '--console'] },
];
const EXPIRED = {
  methods: CLAUDE,
  message: 'Authentication required',
  error: '',
  working: false,
  during: 'prompt',
  detail: 'Failed to authenticate: OAuth session expired and could not be refreshed\nAuthentication required',
};

function context(log) {
  const runs = [];
  return {
    runs,
    providerName: 'Claude Code',
    onAuth: async (...a) => log.push(a),
    runTerminal: (method, box, hooks) => {
      const run = { method, box, hooks, closed: false, close: () => (run.closed = true) };
      runs.push(run);
      return run;
    },
  };
}

test('mid-session auth failure: one clear card, a method choice, the raw error pair under Details', () => {
  const ui = load();
  const root = new Node('div');
  const log = [];
  const ctx = context(log);
  ui.renderAuth(root, EXPIRED, ctx);
  const card = root.children[0];
  assert.equal(byClass(card, 'elicitation-heading')[0].textContent, 'Claude Code needs you to sign in again');
  assert.equal(byClass(card, 'auth-signin-option').length, 2, 'two ways: Subscription and Console');
  const go = byClass(card, 'auth-signin-go')[0];
  assert.equal(go.textContent, 'Sign in');
  const detail = byClass(card, 'auth-signin-detail')[0];
  assert.match(detail.textContent, /Failed to authenticate: OAuth session expired/);
  assert.match(detail.textContent, /Authentication required/);
  assert.equal(ctx.runs.length, 0, 'nothing runs before the click');
  assert.deepEqual(log, []);
  const one = new Node('div');
  ui.renderAuth(one, { ...EXPIRED, methods: [CLAUDE[0]] }, context([]));
  assert.equal(byClass(one, 'auth-signin-option').length, 0, 'one method: no choice');
});

test('Sign in runs the chosen terminal method; exit 0 retries automatically', async () => {
  const ui = load();
  const root = new Node('div');
  const log = [];
  const ctx = context(log);
  ui.renderAuth(root, EXPIRED, ctx);
  const card = root.children[0];
  const radios = find(card, (n) => n.tagName === 'input');
  radios[1].checked = true;
  radios[1].listeners.change();
  byClass(card, 'auth-signin-go')[0].click();
  await tick();
  assert.equal(ctx.runs.length, 1);
  assert.deepEqual([...ctx.runs[0].method.args], ['--cli', 'auth', 'login', '--console']);
  assert.equal(ctx.runs[0].box.hidden, false, 'the terminal is shown in the card');
  ctx.runs[0].hooks.onReady();
  assert.match(byClass(card, 'auth-signin-status')[0].textContent, /Finish the sign-in in this terminal/);
  ctx.runs[0].hooks.onExit(0);
  await tick();
  assert.deepEqual(log, [['retry']]);
  assert.match(byClass(card, 'auth-signin-status')[0].textContent, /Sending your message again/);
  ui.renderAuth(root, null, ctx); // the server cleared the sign-in: the card goes
  assert.equal(root.children.length, 0);
});

test('a failed sign-in says what happened and offers Try again, which runs it again', async () => {
  const ui = load();
  const root = new Node('div');
  const log = [];
  const ctx = context(log);
  ui.renderAuth(root, EXPIRED, ctx);
  const card = root.children[0];
  const go = byClass(card, 'auth-signin-go')[0];
  go.click();
  await tick();
  ctx.runs[0].hooks.onExit(3);
  await tick();
  const err = byClass(card, 'elicitation-error')[0];
  assert.equal(err.hidden, false);
  assert.match(err.textContent, /did not finish \(it ended with code 3\)/);
  assert.equal(go.textContent, 'Try again');
  assert.equal(go.disabled, false);
  assert.deepEqual(log, [], 'no retry after a failure');
  go.click();
  await tick();
  assert.equal(ctx.runs.length, 2);
  const again = new Node('div');
  const still = 'AIB sent your message again after the sign-in, but the agent still asks for sign-in. Try again.';
  ui.renderAuth(again, { ...EXPIRED, error: still }, context([]));
  assert.equal(byClass(again, 'auth-signin-go')[0].textContent, 'Try again');
  assert.match(again.textContent, /still asks for sign-in/);
});

test('an in-app method (Codex) authenticates on click; Dismiss cancels', async () => {
  const ui = load();
  const root = new Node('div');
  const log = [];
  const auth = { ...EXPIRED, methods: [{ id: 'chat-gpt', name: 'ChatGPT', kind: 'agent' }] };
  ui.renderAuth(root, auth, { ...context(log), providerName: 'Codex' });
  const card = root.children[0];
  assert.equal(byClass(card, 'elicitation-heading')[0].textContent, 'Codex needs you to sign in again');
  byClass(card, 'auth-signin-go')[0].click();
  await tick();
  const dismiss = find(card, (n) => n.tagName === 'button' && n.textContent === 'Dismiss')[0];
  dismiss.click();
  await tick();
  assert.deepEqual(log, [['authenticate', 'chat-gpt'], ['cancel']]);
});

test('at setup with a runner: the same card, without "again"', () => {
  const ui = load();
  const root = new Node('div');
  const auth = { methods: [CLAUDE[0]], message: 'Authentication required', error: '', working: false };
  ui.renderAuth(root, auth, context([]));
  assert.equal(byClass(root.children[0], 'elicitation-heading')[0].textContent, 'Claude Code needs you to sign in');
  assert.equal(byClass(root.children[0], 'auth-signin-go').length, 1);
});
