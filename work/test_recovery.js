'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadChat } = require('./chat_harness.js');
const vm = require('node:vm');
function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
function harness(fetch) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id))
      elements.set(id, {
        value: '',
        checked: false,
        hidden: false,
        addEventListener() {},
        setAttribute() {},
        append() {},
        replaceChildren() {},
        classList: { add() {}, remove() {} },
        style: {},
      });
    return elements.get(id);
  };
  const context = vm.createContext({
    localStorage: storage(),
    sessionStorage: storage(),
    document: {
      getElementById: element,
      createElement: () => element('created'),
      body: { classList: { add() {}, remove() {} } },
    },
    window: { addEventListener() {} },
    fetch,
    setInterval() {},
    clearInterval() {},
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimeout,
    URLSearchParams,
    AbortController,
    console,
    Date,
    Math,
  });
  const chat = loadChat(context);
  context.run = chat.run;
  return context;
}
test('attempt id survives reload and is scoped to provider/session and exact draft', () => {
  const backing = storage();
  const context = harness(() => new Promise(() => {}));
  context.localStorage = backing;
  const first = context.run("attemptId('omp:session-a','same text')");
  const reloaded = harness(() => new Promise(() => {}));
  reloaded.localStorage = backing;
  assert.equal(reloaded.run("attemptId('omp:session-a','same text')"), first);
  assert.notEqual(reloaded.run("attemptId('claude:session-a','same text')"), first);
  assert.notEqual(reloaded.run("attemptId('omp:session-a','changed text')"), first);
});
test('403 refreshes token but never replays the POST', async () => {
  let calls = [];
  const context = harness(async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/live/bootstrap') return { ok: true, status: 200, json: async () => ({ token: 'fresh' }) };
    return { ok: false, status: 403, json: async () => ({ error: 'expired' }) };
  });
  await context.run('refreshToken()');
  await assert.rejects(
    context.run("post('prompt',{id:'connection',text:'keep this',clientMessageId:'attempt-1'})"),
    /Retry this action explicitly/,
  );
  assert.equal(calls.filter((c) => c.url === '/api/live/prompt').length, 1);
  assert.equal(calls.filter((c) => c.url === '/api/live/bootstrap').length, 2);
  assert.equal(calls.find((c) => c.url === '/api/live/prompt').options.headers['X-Studio-Token'], 'fresh');
});
