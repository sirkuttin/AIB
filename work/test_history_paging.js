'use strict';
const path = require('path');
const { APP: APP_DIR } = require('./_paths');
// Saved-history paging in chat.js (pollHistory / fetchEarlier / loadEarlier) against a scripted transcript API.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadChat } = require('./chat_harness.js');
const vm = require('node:vm');

function storage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}
class El {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.listeners = {};
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute() {}
  removeAttribute() {}
  append(...items) {
    for (const item of items) this.children.push(item);
  }
  prepend(...items) {
    this.children.unshift(...items);
  }
  replaceChildren(...items) {
    this.children = items;
  }
  insertBefore(node) {
    this.children.push(node);
  }
  remove() {}
  querySelector(selector) {
    const cls = selector.startsWith('.') ? selector.slice(1) : null;
    const walk = (node) => {
      for (const child of node.children || []) {
        if (cls && String(child.className).split(/\s+/).includes(cls)) return child;
        const found = walk(child);
        if (found) return found;
      }
      return null;
    };
    return walk(this);
  }
  querySelectorAll() {
    return [];
  }
  showModal() {}
  select() {}
  focus() {}
}
const flat = (el) => (el.textContent || '') + (el.children || []).map(flat).join('');
function harness(routes, { confirmResult = true } = {}) {
  const elements = new Map(),
    calls = [];
  const element = (id) => {
    if (!elements.has(id)) {
      const el = new El(id);
      if (id === 'providerFilter') el.options = [new El(), new El(), new El()];
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'http://127.0.0.1');
    calls.push({ url: parsed.pathname, query: Object.fromEntries(parsed.searchParams), options });
    const handler =
      routes[parsed.pathname] || (parsed.pathname === '/api/live/bootstrap' ? () => ({ body: { token: 't' } }) : null); // get() fetches the token first
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: 'no route ' + parsed.pathname }) };
    const result = await handler(
      Object.fromEntries(parsed.searchParams),
      options.body ? JSON.parse(options.body) : null,
      options,
    );
    if (result instanceof Error) throw result;
    return {
      ok: result.status === undefined || result.status < 400,
      status: result.status || 200,
      json: async () => result.body,
    };
  };
  const context = vm.createContext({
    AgentChoice: require(path.join(APP_DIR, 'agent-choice.js')),
    localStorage: storage(),
    sessionStorage: storage(),
    document: {
      getElementById: element,
      createElement: () => new El('created'),
      createDocumentFragment: () => new El('fragment'),
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
    URL,
    console,
    Date,
    Math,
    confirm: () => confirmResult,
  });
  const chat = loadChat(context);
  return { context, calls, element, run: chat.run };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

const pagedRoute = (sizeOf, delay) => async (q) => {
  const size = sizeOf(),
    limit = Number(q.limit);
  let start, end;
  if (q.after !== undefined) {
    start = Math.min(size, Number(q.after));
    end = Math.min(size, start + limit);
  } else {
    end = Math.min(size, q.before !== undefined ? Number(q.before) : size);
    start = Math.max(0, end - limit);
  }
  if (delay) await delay(q);
  return {
    body: {
      events: Array.from({ length: end - start }, (_, i) => ({
        id: 'e' + (start + i),
        kind: 'user',
        label: 'User',
        text: 'MSG-' + (start + i),
        time: 't',
      })),
      before: start,
      end,
      total: size,
    },
  };
};

test('paging a 1679-event chat back page by page shows every message exactly once', async () => {
  const h = harness({ '/api/transcript': pagedRoute(() => 1679) });
  h.run("selected={key:'k',provider:'omp',id:'s',cwd:'c'}");
  await h.run("pollHistory('k')");
  const befores = [];
  for (let i = 0; i < 20; i++) {
    const w = h.run("historyWindows.get('k')");
    if (w.start <= 0) break;
    befores.push(w.start);
    await h.run("loadEarlier('k','main')");
  }
  assert.deepEqual([...befores.slice(0, 3)], [1559, 1439, 1319]);
  assert.equal(befores.at(-1), 119);
  const w = h.run("historyWindows.get('k')");
  assert.deepEqual([w.start, w.end, w.events.length], [0, 1679, 1679]);
  assert.equal(
    JSON.stringify(w.events.map((e) => e.text)),
    JSON.stringify(Array.from({ length: 1679 }, (_, i) => 'MSG-' + i)),
  );
});

test('two polls of one chat at once do not append the same events twice', async () => {
  let size = 200;
  const release = [];
  const h = harness({
    '/api/transcript': pagedRoute(
      () => size,
      (q) => (q.after !== undefined ? new Promise((r) => release.push(r)) : null),
    ),
  });
  h.run("selected={key:'k',provider:'omp',id:'s',cwd:'c'}");
  await h.run("pollHistory('k')");
  size = 230;
  const a = h.run("pollHistory('k')"),
    b = h.run("pollHistory('k')");
  await tick();
  release.forEach((r) => r());
  await Promise.all([a, b]);
  const w = h.run("historyWindows.get('k')");
  assert.deepEqual([w.start, w.end, w.events.length], [80, 230, 150]);
  assert.equal(new Set(w.events.map((e) => e.id)).size, 150);
});

test('the 3000-event cap never trims while an older page is arriving', async () => {
  let size = 3100;
  const release = [];
  const h = harness({
    '/api/transcript': pagedRoute(
      () => size,
      (q) => (q.before !== undefined ? new Promise((r) => release.push(r)) : null),
    ),
  });
  h.run("selected={key:'k',provider:'omp',id:'s',cwd:'c'}");
  await h.run("pollHistory('k')");
  size = 3200;
  await h.run("pollHistory('k')");
  let w = h.run("historyWindows.get('k')");
  assert.equal(w.end - w.start, w.events.length, 'window bounds always describe the held events');
  const early = h.run("fetchEarlier(historyWindows.get('k'),'k')");
  await tick();
  size = 6500;
  await h.run("pollHistory('k')"); // grows past the cap while the older page is in flight
  release.forEach((r) => r());
  await early;
  w = h.run("historyWindows.get('k')");
  assert.equal(w.end - w.start, w.events.length, 'no gap between the older page and the window');
  assert.equal(
    JSON.stringify(w.events.map((e) => e.text)),
    JSON.stringify(Array.from({ length: w.end - w.start }, (_, i) => 'MSG-' + (w.start + i))),
  );
});
