'use strict';
const { APP: APP_DIR } = require('./_paths');
// A minimal fake DOM for the smoke tests of page modules that draw a lot (workspace-ui.js, split-ui.js).
// It is not a browser: just enough tree, class, attribute, event and selector support to run the code and look at what it drew.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP = path.join(APP_DIR);

class Node {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.attrs = {};
    this.dataset = {};
    this.style = {
      setProperty(k, v) {
        this[k] = String(v);
      },
    };
    this.listeners = {};
    this._text = '';
    this._class = new Set();
    this.hidden = false;
    this.id = '';
    this.scrollLeft = 0;
    this.scrollWidth = 0;
    this.clientWidth = 0;
    this.value = '';
    this.disabled = false;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach((x) => self._class.add(x)),
      remove: (...c) => c.forEach((x) => self._class.delete(x)),
      contains: (c) => self._class.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !self._class.has(c) : !!on;
        if (want) self._class.add(c);
        else self._class.delete(c);
        return want;
      },
    };
  }
  get className() {
    return Array.from(this._class).join(' ');
  }
  set className(v) {
    this._class = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get offsetParent() {
    return this.parentNode ? {} : null;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }
  get parentElement() {
    return this.parentNode && this.parentNode.tagName !== '#FRAGMENT' ? this.parentNode : null;
  }
  get nodeValue() {
    return this.tagName === '#TEXT' ? this._text : null;
  }
  set nodeValue(v) {
    if (this.tagName === '#TEXT') this._text = String(v);
  }
  // Insert nodes right after this one / put them in its place (fragments give their children).
  after(...ns) {
    const p = this.parentNode;
    if (!p) return;
    let ref = this.nextSibling;
    for (const n of ns) {
      const list = n.tagName === '#FRAGMENT' ? n.children.slice() : [n];
      for (const x of list) p.insertBefore(x, ref);
    }
  }
  replaceWith(...ns) {
    const p = this.parentNode;
    if (!p) return;
    const ref = this.nextSibling;
    this.remove();
    for (const n of ns) {
      const list = n.tagName === '#FRAGMENT' ? n.children.slice() : [n];
      for (const x of list) p.insertBefore(x, ref);
    }
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.children;
    return s[s.indexOf(this) + 1] || null;
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set innerHTML(v) {
    throw new Error('innerHTML must never be used');
  }
  _adopt(n) {
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((x) => x !== n);
    n.parentNode = this;
    return n;
  }
  append(...ns) {
    for (const n of ns) {
      if (typeof n === 'string') {
        const t = new Node('#text', this.ownerDocument);
        t._text = n;
        this.children.push(this._adopt(t));
        continue;
      }
      if (n.tagName === '#FRAGMENT') {
        for (const c of n.children) {
          c.parentNode = this;
          this.children.push(c);
        }
        n.children = [];
      } else this.children.push(this._adopt(n));
    }
  }
  prepend(...ns) {
    const keep = this.children;
    this.children = [];
    this.append(...ns);
    this.children.push(...keep);
  }
  appendChild(n) {
    this.append(n);
    return n;
  }
  insertBefore(n, ref) {
    this._adopt(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
    return n;
  }
  replaceChildren(...ns) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = '';
    this.append(...ns);
  }
  remove() {
    if (this.parentNode) {
      this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
      this.parentNode = null;
    }
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id') this.id = String(v);
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
  }
  dispatch(type, extra) {
    const event = Object.assign(
      {
        type,
        target: this,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
        stopImmediatePropagation() {},
      },
      extra,
    );
    for (const f of this.listeners[type] || []) f(event);
    return event;
  }
  click() {
    if (typeof this.onclick === 'function') this.onclick({ stopPropagation() {}, preventDefault() {}, target: this });
    this.dispatch('click');
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  blur() {}
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  closest(sel) {
    for (let x = this; x; x = x.parentNode) if (x.matches && x.matches(sel)) return x;
    return null;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  matches(sel) {
    return sel.split(',').some((part) => {
      part = part.trim();
      const m = /^([a-zA-Z][a-zA-Z0-9]*)?((?:[.#][\w-]+)*)(?:\[([\w-]+)(?:="?([^"\]]*)"?)?\])?$/.exec(part);
      if (!m) return false;
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      for (const piece of (m[2] || '').match(/[.#][\w-]+/g) || []) {
        if (piece[0] === '.' ? !this._class.has(piece.slice(1)) : this.id !== piece.slice(1)) return false;
      }
      if (m[3] && !(m[3] in this.attrs)) return false;
      if (m[3] && m[4] !== undefined && this.attrs[m[3]] !== m[4]) return false;
      return true;
    });
  }
  querySelectorAll(sel) {
    return this.all().filter((n) => n.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 1200, bottom: 700, width: 1200, height: 700 };
  }
  scrollIntoView() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  get find() {
    return (cls) => this.all().filter((n) => n._class.has(cls));
  }
}

function storage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    _data: data,
  };
}

// A page shell: <body> holding <main> (with the #chatTabs strip and a message list) plus whatever ids are asked for.
function page({ width = 1400, store = {}, ids = [] } = {}) {
  const document = { title: 'Agent Studio', visibilityState: 'visible', listeners: {}, activeElement: null };
  document.createElement = (tag) => new Node(tag, document);
  document.createTextNode = (text) => {
    const n = new Node('#text', document);
    n._text = String(text);
    return n;
  };
  document.createDocumentFragment = () => new Node('#fragment', document);
  // Text nodes in document order (whatToShow 4 = text only, the one use in the page code).
  document.createTreeWalker = (rootNode) => {
    const list = rootNode.all().filter((n) => n.tagName === '#TEXT');
    let i = -1;
    return { nextNode: () => list[++i] || null };
  };
  document.addEventListener = (type, fn) => {
    (document.listeners[type] = document.listeners[type] || []).push(fn);
  };
  document.removeEventListener = () => {};
  const body = (document.body = new Node('body', document));
  const byId = {};
  const make = (tag, id, parent) => {
    const n = new Node(tag, document);
    if (id) {
      n.id = id;
      byId[id] = n;
    }
    if (parent) parent.append(n);
    return n;
  };
  const main = make('main', '', body);
  make('div', 'chatTabs', main);
  make('div', 'messages', main);
  make('div', 'subagentsPane', main);
  make('textarea', 'prompt', main);
  for (const id of ids) make('div', id, body);
  document.getElementById = (id) => byId[id] || null;
  document.querySelector = (sel) => body.querySelector(sel);
  document.querySelectorAll = (sel) => body.querySelectorAll(sel);
  document.dispatch = (type, extra) => {
    const event = Object.assign(
      {
        type,
        target: body,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
      },
      extra,
    );
    for (const f of document.listeners[type] || []) f(event);
    return event;
  };
  const localStorage = storage(store);
  const timers = [];
  const window = {
    document,
    localStorage,
    innerWidth: width,
    innerHeight: 900,
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    removeEventListener() {},
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return timers.length;
    },
    clearTimeout() {},
    requestAnimationFrame: (fn) => {
      fn(0);
      return 1;
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    runTimers() {
      const due = timers.splice(0);
      for (const t of due) t.fn();
    },
  };
  return { document, window, body, main, byId, localStorage, make };
}

// Run page scripts (in order) the way the browser would: one shared global, `window` as the root, `document` and friends reachable by name.
function load(shell, scripts) {
  const sandbox = Object.assign(
    {
      console,
      Object,
      Array,
      String,
      Number,
      Boolean,
      Promise,
      Error,
      Map,
      Set,
      Date,
      JSON,
      Math,
      isNaN,
      RegExp,
      Symbol,
      parseInt,
      parseFloat,
      URL,
      URLSearchParams,
    },
    shell.window,
    { window: undefined },
  );
  sandbox.window = sandbox;
  sandbox.document = shell.document;
  sandbox.localStorage = shell.localStorage;
  const context = vm.createContext(sandbox);
  for (const name of scripts)
    vm.runInContext(fs.readFileSync(path.join(APP, name), 'utf8'), context, { filename: name });
  return context;
}

module.exports = { Node, storage, page, load, APP };
