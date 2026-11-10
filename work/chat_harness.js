'use strict';
const { APP: APP_DIR } = require('./_paths');
/* Shared by the tests that run chat.js. chat.js is one IIFE, so a test reaches it only through window.StudioChat (its test hook):
   loadChat() runs the file in a vm context that has a fake page, and run() evaluates a short expression against the hook, where
   functions and the `state` accessors read like plain names, e.g. run("current='conn-1';refresh()").
   Not a test file: node --test work/test_*.js does not pick it up. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CHAT_JS = path.join(APP_DIR, 'chat.js');

function scopeOf(hook) {
  const scope = {};
  for (const [name, value] of Object.entries(hook)) if (name !== 'state') scope[name] = value;
  for (const name of Object.keys(hook.state)) {
    Object.defineProperty(scope, name, {
      enumerable: true,
      get: () => hook.state[name],
      set: (value) => {
        hook.state[name] = value;
      },
    });
  }
  return scope;
}

function loadChat(context) {
  vm.runInContext(fs.readFileSync(CHAT_JS, 'utf8'), context);
  const hook = context.window.StudioChat;
  if (!hook) throw new Error('chat.js did not set window.StudioChat');
  context.__studioChat = scopeOf(hook);
  return { hook, state: hook.state, run: (code) => vm.runInContext('with(__studioChat){' + code + '\n}', context) };
}

/* A small fake page: every element id is a plain object, timers are recorded instead of run, and fetch is whatever the test gives. */
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
    this.clientHeight = 0;
    this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }
  get childNodes() {
    return this.children;
  }
  addEventListener(name, fn) {
    this.listeners[name] = fn;
  }
  setAttribute() {}
  removeAttribute() {}
  showModal() {}
  select() {}
  focus() {}
  remove() {}
  matches() {
    return false;
  }
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
  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }
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
}
/* every descendant that carries the class */
const byClass = (el, cls) => {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      if (String(child.className).split(/\s+/).includes(cls)) out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
};
const flat = (el) => (el.textContent || '') + (el.children || []).map(flat).join('');

function storage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

/* routes: { '/api/path': (query, body) => ({ body, status? }) }. The first bootstrap request (made by the page when it loads) never answers, so a test drives everything itself. */
function makePage({ routes = {}, window: extraWindow = {}, scripts = [] } = {}) {
  const elements = new Map(),
    calls = [],
    intervals = [],
    handlers = {};
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new El(id));
    return elements.get(id);
  };
  let firstBootstrap = true;
  const fetch = async (url, options = {}) => {
    const parsed = new URL(url, 'http://127.0.0.1');
    calls.push({ url: parsed.pathname, query: Object.fromEntries(parsed.searchParams), options });
    if (parsed.pathname === '/api/live/bootstrap' && firstBootstrap) {
      firstBootstrap = false;
      return new Promise(() => {});
    }
    const handler =
      routes[parsed.pathname] || (parsed.pathname === '/api/live/bootstrap' ? () => ({ body: { token: 't' } }) : null);
    if (!handler) return { ok: false, status: 404, json: async () => ({ error: 'no route ' + parsed.pathname }) };
    const result = await handler(
      Object.fromEntries(parsed.searchParams),
      options.body ? JSON.parse(options.body) : null,
    );
    return {
      ok: result.status === undefined || result.status < 400,
      status: result.status || 200,
      json: async () => result.body,
    };
  };
  const document = {
    hidden: false,
    getElementById: element,
    createElement: () => new El('created'),
    createDocumentFragment: () => new El('fragment'),
    body: { classList: { add() {}, remove() {} }, dataset: {} },
    addEventListener: (name, fn) => {
      (handlers[name] = handlers[name] || []).push(fn);
    },
  };
  const context = vm.createContext({
    AgentChoice: require(path.join(APP_DIR, 'agent-choice.js')),
    localStorage: storage(),
    sessionStorage: storage(),
    document,
    window: { addEventListener() {}, ...extraWindow },
    fetch,
    URLSearchParams,
    AbortController,
    URL,
    console,
    Date,
    Math,
    clearInterval() {},
    clearTimeout,
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
  });
  for (const file of scripts)
    vm.runInContext(fs.readFileSync(path.join(APP_DIR, file), 'utf8'), context); // page modules chat.js uses, loaded the way chat.html loads them
  const chat = loadChat(context);
  return {
    ...chat,
    context,
    document,
    element,
    calls,
    intervals,
    fire: (name) => (handlers[name] || []).forEach((fn) => fn()),
    tick: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

/* What chat.html loads, read from its tags (not from their exact spelling): { scripts: ['/markdown.js', ...] in load order, styles: ['/chat.css', ...] }. */
function pageAssets() {
  const html = fs.readFileSync(path.join(APP_DIR, 'chat.html'), 'utf8');
  const attr = (tag, name) => {
    const m = new RegExp('\\s' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'i').exec(tag);
    return m ? (m[1] ?? m[2]) : '';
  };
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => attr(m[0], 'src')).filter(Boolean);
  const styles = [...html.matchAll(/<link\b[^>]*>/gi)]
    .filter((m) => /stylesheet/i.test(attr(m[0], 'rel')))
    .map((m) => attr(m[0], 'href'));
  return { scripts, styles, html };
}

module.exports = { loadChat, makePage, pageAssets, El, byClass, flat, CHAT_JS };
