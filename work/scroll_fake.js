'use strict';
/* A small fake layout for scroll-controller.js tests: a list of rows with heights, a scrollTop the "browser" clamps, and observers
   the test fires by hand (the ResizeObserver after layout, the MutationObserver on child changes). */
const path = require('node:path');
const { APP } = require('./_paths');
const SC = require(path.join(APP, 'scroll-controller.js'));

/* ---- a fake list: rows stacked from the top, each with a height; the list is clientHeight tall at y = TOP on the page ---- */
const TOP = 100;
class Row {
  constructor(list, attrs, h) {
    this.list = list;
    this.dataset = { ...attrs };
    this.h = h;
    this.hidden = false;
    this.nodeType = 1;
    this.attrs = {};
    this.parentElement = list;
    this.parentNode = list;
    this.children = [];
  }
  get offsetTop() {
    let y = 0;
    for (const r of this.list.children) {
      if (r === this) return y;
      if (!r.hidden) y += r.h;
    }
    return y;
  }
  getBoundingClientRect() {
    const top = TOP + this.offsetTop - this.list._top;
    return { top, bottom: top + (this.hidden ? 0 : this.h), height: this.hidden ? 0 : this.h };
  }
  getClientRects() {
    return this.hidden ? [] : [1];
  }
  getAttribute(k) {
    return k in this.attrs ? this.attrs[k] : null;
  }
  closest(sel) {
    for (let x = this; x && x !== this.list; x = x.parentElement) if (x.matchesSel && x.matchesSel(sel)) return x;
    return null;
  }
}
class List {
  constructor(heights, { clientHeight = 500, clientWidth = 800, prefix = 'L:' } = {}) {
    this.children = [];
    this.dataset = {};
    this.clientHeight = clientHeight;
    this.clientWidth = clientWidth;
    this._top = 0;
    this.writes = 0;
    this.listeners = {};
    this.isConnected = true;
    this.classes = new Set();
    this.classList = { add: (c) => this.classes.add(c) };
    heights.forEach((h, i) => this.add(prefix + (i + 1), h));
  }
  add(rid, h, attrs = {}) {
    const r = new Row(this, rid ? { rid, ...attrs } : attrs, h);
    this.children.push(r);
    return r;
  }
  get scrollHeight() {
    return Math.max(this.clientHeight, this.children.reduce((n, r) => n + (r.hidden ? 0 : r.h), 0));
  }
  get scrollTop() {
    return this._top;
  }
  set scrollTop(v) {
    this.writes++;
    this._top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, Math.round(v)));
  }
  /* the browser clamps the position when the content got shorter (no event of its own until the next frame) */
  layout() {
    this._top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, this._top));
  }
  getBoundingClientRect() {
    return { top: TOP, bottom: TOP + this.clientHeight, height: this.clientHeight };
  }
  addEventListener(t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  }
  removeEventListener() {}
  fire(t, e = {}) {
    for (const fn of this.listeners[t] || []) fn({ type: t, ...e });
  }
  contains(n) {
    for (let x = n; x; x = x.parentElement) if (x === this) return true;
    return false;
  }
  /* you scroll: the position moves, then the browser sends the scroll event */
  userScroll(top) {
    this._top = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, top));
    this.fire('scroll');
  }
  get gap() {
    return this.scrollHeight - this.scrollTop - this.clientHeight;
  }
  topOf(rid) {
    const r = this.children.find((x) => x.dataset.rid === rid);
    return r ? r.getBoundingClientRect().top - TOP : null;
  }
}
function observers() {
  const made = { ro: null, mo: null };
  class RO {
    constructor(fn) {
      this.fn = fn;
      this.watched = new Set();
      made.ro = this;
    }
    observe(el) {
      this.watched.add(el);
    }
    unobserve(el) {
      this.watched.delete(el);
    }
    disconnect() {}
    fire(entries = []) {
      this.fn(entries);
    }
  }
  class MO {
    constructor(fn) {
      this.fn = fn;
      made.mo = this;
    }
    observe() {}
    disconnect() {}
    fire(records) {
      this.fn(records);
    }
  }
  return { made, RO, MO };
}
function setup(heights, o = {}) {
  const box = new List(heights, o);
  const obs = observers();
  const changes = [];
  const ctl = SC.attach(box, {
    role: o.role || 'sub',
    ResizeObserver: obs.RO,
    MutationObserver: obs.MO,
    onChange: (next, prev, cause) => changes.push([prev.mode, next.mode, cause]),
    nearTop: o.nearTop,
  });
  return { box, ctl, ro: obs.made.ro, mo: obs.made.mo, changes };
}
const rows = (n, h = 100) => Array.from({ length: n }, () => h);


module.exports = { SC, TOP, Row, List, observers, setup, rows };
