'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const dir = APP_DIR + '/';
const T = require(dir + 'textsize-ui.js'),
  R = require(dir + 'resize-ui.js'),
  Reg = require(dir + 'commands-registry.js');

/* ---- a tiny fake page: just what init() touches ------------------------------------------------------------ */
function fakePage(width, stored) {
  const store = new Map(Object.entries(stored || {}));
  const listeners = { doc: {}, win: {} };
  const attrs = {},
    props = {};
  const rootEl = {
    dataset: {},
    style: {
      setProperty: (k, v) => {
        props[k] = v;
      },
      removeProperty: (k) => {
        delete props[k];
      },
      getPropertyValue: (k) => props[k] || '',
    },
    setAttribute: (k, v) => {
      attrs[k] = v;
    },
    removeAttribute: (k) => {
      delete attrs[k];
    },
  };
  const body = { appendChild() {} };
  const inChatEl = { closest: (sel) => (/#chat/.test(sel) ? inChatEl : null) };
  const outEl = { closest: () => null };
  const doc = {
    documentElement: rootEl,
    body,
    activeElement: body,
    getElementById: () => null,
    createElement: () => ({ getContext: () => null, classList: { add() {}, remove() {} }, setAttribute() {} }),
    addEventListener: (t, f) => {
      listeners.doc[t] = f;
    },
  };
  const win = {
    document: doc,
    innerWidth: width,
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => {
        store.set(k, String(v));
      },
    },
    addEventListener: (t, f) => {
      listeners.win[t] = f;
    },
    setTimeout: () => 0,
    clearTimeout() {},
    getComputedStyle: () => ({ zoom: '1' }),
    ResizeUI: R,
  };
  return { win, doc, body, rootEl, attrs, props, store, listeners, inChatEl, outEl };
}
const key = (o) => ({
  ctrlKey: true,
  altKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  preventDefault() {
    this.pd = true;
  },
  stopPropagation() {},
  ...o,
});

test('percent steps clamp to range and snap to the step', () => {
  assert.equal(T.clampPct(100, T.CHAT), 100);
  assert.equal(T.clampPct(10, T.CHAT), 80);
  assert.equal(T.clampPct(500, T.CHAT), 160);
  assert.equal(T.clampPct(104, T.CHAT), 100);
  assert.equal(T.clampPct(116, T.CHAT), 120);
  assert.equal(T.clampPct(10, T.UI), 90);
  assert.equal(T.clampPct(500, T.UI), 150);
  for (const bad of [NaN, undefined, null, 'x', {}, Infinity]) assert.equal(T.clampPct(bad, T.CHAT), 100);
  assert.equal(T.clampPct('120', T.CHAT), 120);
});
test('stepping walks 80..160 chat and 90..150 interface in 10 % steps and stops at the ends', () => {
  let v = 100;
  const seen = [v];
  for (let i = 0; i < 10; i++) {
    v = T.stepPct(v, 1, T.CHAT);
    seen.push(v);
  }
  assert.deepEqual(seen, [100, 110, 120, 130, 140, 150, 160, 160, 160, 160, 160]);
  v = 100;
  for (let i = 0; i < 5; i++) v = T.stepPct(v, -1, T.CHAT);
  assert.equal(v, 80);
  assert.equal(T.stepPct(150, 1, T.UI), 150);
  assert.equal(T.stepPct(90, -1, T.UI), 90);
  assert.equal(T.stepPct(100, -1, T.UI), 90);
  assert.equal(T.stepPct(NaN, 1, T.UI), 110);
});
test('stored settings are sanitised: bad numbers clamp, unknown font or spacing means default, junk means defaults', () => {
  assert.deepEqual(T.sanitize(null), T.DEFAULTS);
  assert.deepEqual(T.sanitize('not json'), T.DEFAULTS);
  assert.deepEqual(T.sanitize({ chat: 999, ui: 1, font: 'Comic Sans', spacing: 'huge' }), {
    chat: 160,
    ui: 90,
    font: '',
    spacing: 'comfortable',
  });
  assert.deepEqual(T.sanitize(JSON.stringify({ chat: 120, ui: 110, font: 'Consolas', spacing: 'roomy' })), {
    chat: 120,
    ui: 110,
    font: 'Consolas',
    spacing: 'roomy',
  });
});
test('storage key reuses resize-ui bucket helper', () => {
  assert.equal(T.storageKey(1200, R), 'studio-textsize-v1:<1400');
  assert.equal(T.storageKey(1500, R), 'studio-textsize-v1:<1800');
  assert.equal(T.storageKey(2560, R), 'studio-textsize-v1:>=1800');
  assert.equal(T.bucketKey(1500, { bucketKey: () => 'X' }), 'X'); // the helper decides when given
  assert.equal(T.bucketKey(1500), R.bucketKey(1500));
});

test('key scope: Ctrl+= - 0 change chat text only inside the chat area, Ctrl+Shift+= - 0 the interface anywhere', () => {
  assert.deepEqual(T.keyAction(key({ key: '=', code: 'Equal' }), true), { target: 'chat', dir: 1 });
  assert.deepEqual(T.keyAction(key({ key: '+', code: 'Equal' }), true), { target: 'chat', dir: 1 });
  assert.deepEqual(T.keyAction(key({ key: '-', code: 'Minus' }), true), { target: 'chat', dir: -1 });
  assert.deepEqual(T.keyAction(key({ key: '0', code: 'Digit0' }), true), { target: 'chat', dir: 0 });
  assert.deepEqual(T.keyAction(key({ key: '+', code: 'NumpadAdd' }), true), { target: 'chat', dir: 1 });
  // outside the chat the browser keeps its zoom
  for (const k of [
    { key: '=', code: 'Equal' },
    { key: '-', code: 'Minus' },
    { key: '0', code: 'Digit0' },
  ])
    assert.equal(T.keyAction(key(k), false), null);
  // interface: shifted, in or out of the chat
  for (const inChat of [true, false]) {
    assert.deepEqual(T.keyAction(key({ key: '+', code: 'Equal', shiftKey: true }), inChat), { target: 'ui', dir: 1 });
    assert.deepEqual(T.keyAction(key({ key: '_', code: 'Minus', shiftKey: true }), inChat), { target: 'ui', dir: -1 });
    assert.deepEqual(T.keyAction(key({ key: ')', code: 'Digit0', shiftKey: true }), inChat), { target: 'ui', dir: 0 });
  }
  // not ours: no Ctrl, Alt (AltGr), Meta, other keys
  assert.equal(T.keyAction(key({ key: '=', ctrlKey: false }), true), null);
  assert.equal(T.keyAction(key({ key: '=', altKey: true }), true), null);
  assert.equal(T.keyAction(key({ key: '=', metaKey: true }), true), null);
  assert.equal(T.keyAction(key({ key: 'b', code: 'KeyB' }), true), null);
  assert.equal(T.keyAction(null, true), null);
});
test('Ctrl+wheel: only over the chat, one step per notch, touchpad deltas accumulate', () => {
  const w = (d, o) => ({ ctrlKey: true, deltaY: d, ...o });
  assert.deepEqual(T.wheelAction(w(-100), false, 0), { handled: false, steps: 0, acc: 0 });
  assert.equal(T.wheelAction({ ctrlKey: false, deltaY: -100 }, true, 0).handled, false);
  assert.equal(T.wheelAction(w(-100, { shiftKey: true }), true, 0).handled, false);
  assert.deepEqual(T.wheelAction(w(-100), true, 0), { handled: true, steps: 1, acc: -40 });
  assert.equal(T.wheelAction(w(100), true, 0).steps, -1);
  let acc = 0,
    total = 0;
  for (let i = 0; i < 6; i++) {
    const r = T.wheelAction(w(-25), true, acc);
    acc = r.acc;
    total += r.steps;
  }
  assert.equal(total, 2); // 150 px of small deltas = two steps
  assert.deepEqual(T.wheelAction(w(30), true, -50), { handled: true, steps: 0, acc: 30 }); // reversing direction drops the old remainder
  assert.equal(T.wheelAction(w(0), true, 0).steps, 0);
});

test('font availability: shown only when a width differs from a plain fallback', () => {
  const have = new Set(['Consolas', 'Fira Code']);
  // a fake canvas: width depends on the first family that exists
  const measure = (css) => {
    const m = /^72px (?:"([^"]+)", )?([\w-]+)$/.exec(css),
      fam = m[1],
      base = m[2];
    const baseW = { monospace: 600, 'sans-serif': 640, serif: 620 }[base];
    return fam && have.has(fam) ? baseW + (fam === 'Consolas' ? 7 : 13) : baseW;
  };
  assert.equal(T.fontAvailable('Consolas', measure), true);
  assert.equal(T.fontAvailable('Cascadia Mono', measure), false);
  assert.deepEqual(T.availableFonts(measure), ['Consolas', 'Fira Code']);
  assert.deepEqual(
    T.availableFonts(() => NaN),
    [],
  ); // no canvas: nothing is offered
  assert.deepEqual(
    T.availableFonts(() => {
      throw new Error('x');
    }),
    [],
  ); // a throwing canvas never breaks the page
  assert.deepEqual(T.FONTS, [
    'Cascadia Mono',
    'Cascadia Code',
    'Consolas',
    'JetBrains Mono',
    'Fira Code',
    'Courier New',
  ]);
  // a remembered font that is gone falls back to the default stack
  assert.equal(T.resolveFont('Consolas', ['Consolas']), 'Consolas');
  assert.equal(T.resolveFont('Fira Code', ['Consolas']), '');
  assert.equal(T.resolveFont('Evil;}', ['Evil;}']), '');
  assert.equal(T.resolveFont('', ['Consolas']), '');
});

test('defaults leave the page untouched: no attributes, no custom properties', () => {
  const p = fakePage(1500);
  const ctl = T.init(p.win, { fonts: ['Consolas'] });
  assert.deepEqual(p.attrs, {});
  assert.deepEqual(p.props, {});
  assert.equal(ctl.getChat(), 100);
  assert.equal(ctl.getUi(), 100);
  assert.equal(ctl.getCodeFont(), '');
  assert.equal(ctl.getLineSpacing(), 'comfortable');
  ctl.bigger('chat');
  assert.equal(p.attrs['data-chat-scaled'], '');
  assert.equal(p.props['--chat-scale'], '1.1');
  ctl.reset('chat');
  assert.deepEqual(p.attrs, {});
  assert.deepEqual(p.props, {});
});
test('API: set/get, clamping, onChange, font and spacing', () => {
  const p = fakePage(1500);
  const ctl = T.init(p.win, { fonts: ['Consolas', 'Courier New'] });
  const seen = [];
  const off = ctl.onChange((s, w) => seen.push([w, s.chat, s.ui]));
  ctl.setChat(135);
  assert.equal(ctl.getChat(), 140);
  ctl.setChat(9999);
  assert.equal(ctl.getChat(), 160);
  ctl.setUi(5);
  assert.equal(ctl.getUi(), 90);
  assert.equal(p.props['--ui-scale'], '0.9');
  ctl.setChat(160);
  assert.equal(seen.filter((x) => x[0] === 'chat').length, 2); // setting the same value again is not a change
  ctl.setCodeFont('Courier New');
  assert.equal(p.attrs['data-code-font'], '');
  assert.equal(p.props['--code-font'], '"Courier New"');
  ctl.setCodeFont('Cascadia Mono');
  assert.equal(ctl.getCodeFont(), ''); // not drawable here: default
  assert.equal(p.attrs['data-code-font'], undefined);
  ctl.setLineSpacing('roomy');
  assert.equal(p.attrs['data-line-spacing'], 'roomy');
  ctl.setLineSpacing('comfortable');
  assert.equal(p.attrs['data-line-spacing'], undefined);
  ctl.setLineSpacing('bogus');
  assert.equal(ctl.getLineSpacing(), 'comfortable');
  assert.deepEqual(
    ctl.fontOptions().map((o) => o.name),
    ['', 'Consolas', 'Courier New'],
  );
  assert.deepEqual(
    ctl.spacingOptions().map((o) => o.label),
    ['Compact', 'Comfortable', 'Roomy'],
  );
  off();
  const n = seen.length;
  ctl.setChat(100);
  assert.equal(seen.length, n);
});
test('bucket persistence: each window-width bucket keeps its own sizes; a resize across buckets switches', () => {
  const p = fakePage(1500, {
    'studio-textsize-v1:<1800': JSON.stringify({ chat: 130, ui: 110, font: '', spacing: 'roomy' }),
    'studio-textsize-v1:>=1800': JSON.stringify({ chat: 90 }),
  });
  const ctl = T.init(p.win, { fonts: [] });
  assert.deepEqual(ctl.get(), { chat: 130, ui: 110, font: '', spacing: 'roomy' });
  ctl.setChat(150);
  assert.equal(JSON.parse(p.store.get('studio-textsize-v1:<1800')).chat, 150);
  assert.equal(JSON.parse(p.store.get('studio-textsize-v1:>=1800')).chat, 90); // the other bucket is untouched
  p.win.innerWidth = 2200;
  p.listeners.win.resize();
  assert.equal(ctl.getChat(), 90);
  assert.equal(ctl.getUi(), 100);
  assert.equal(p.props['--chat-scale'], '0.9');
  p.win.innerWidth = 1000;
  p.listeners.win.resize();
  assert.equal(ctl.getChat(), 100);
  assert.deepEqual(p.attrs, {}); // an empty bucket is all defaults
  p.win.innerWidth = 1700;
  p.listeners.win.resize();
  assert.equal(ctl.getChat(), 150);
});
test('storage that throws never breaks it', () => {
  const p = fakePage(1500);
  p.win.localStorage = {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
  };
  const ctl = T.init(p.win, { fonts: [] });
  ctl.setChat(120);
  assert.equal(ctl.getChat(), 120);
});
test('keydown handler: acts by focus/pointer scope and swallows only handled keys', () => {
  const p = fakePage(1500);
  const ctl = T.init(p.win, { fonts: [] });
  const kd = p.listeners.doc.keydown;
  // nothing focused, pointer last over the chat: chat text
  p.listeners.doc.mouseover({ target: p.inChatEl });
  let e = key({ key: '=', code: 'Equal' });
  kd(e);
  assert.equal(ctl.getChat(), 110);
  assert.equal(e.pd, true);
  // focus outside the chat wins over a pointer inside it: the browser zoom keeps working
  p.doc.activeElement = p.outEl;
  e = key({ key: '=', code: 'Equal' });
  kd(e);
  assert.equal(ctl.getChat(), 110);
  assert.equal(e.pd, undefined);
  // focus in the chat
  p.doc.activeElement = p.inChatEl;
  e = key({ key: '-', code: 'Minus' });
  kd(e);
  assert.equal(ctl.getChat(), 100);
  // interface keys work with focus anywhere
  p.doc.activeElement = p.outEl;
  e = key({ key: '+', code: 'Equal', shiftKey: true });
  kd(e);
  assert.equal(ctl.getUi(), 110);
  assert.equal(e.pd, true);
  e = key({ key: '_', code: 'Minus', shiftKey: true });
  kd(e);
  assert.equal(ctl.getUi(), 100);
  // pointer outside the chat and nothing focused
  p.doc.activeElement = p.body;
  p.listeners.doc.mouseover({ target: p.outEl });
  e = key({ key: '=', code: 'Equal' });
  kd(e);
  assert.equal(ctl.getChat(), 100);
  assert.equal(e.pd, undefined);
  // an unrelated key is left alone
  e = key({ key: 'b', code: 'KeyB' });
  kd(e);
  assert.equal(e.pd, undefined);
});

test('page zoom: in the desktop app stray Ctrl+plus/minus/0 and Ctrl+wheel are swallowed; in a browser they are left alone', () => {
  assert.equal(T.isPageZoomKey(key({ key: '=', code: 'Equal' })), true);
  assert.equal(T.isPageZoomKey(key({ key: '-', code: 'NumpadSubtract' })), true);
  assert.equal(
    T.isPageZoomKey(key({ key: '0', code: 'Digit0' })),
    false,
    'Ctrl+0 only resets the page zoom: left alone',
  );
  assert.equal(T.isPageZoomKey(key({ key: 'b', code: 'KeyB' })), false);
  assert.equal(T.isPageZoomKey(key({ key: '=', code: 'Equal', ctrlKey: false })), false);
  assert.equal(T.isPageZoomKey(key({ key: '=', code: 'Equal', altKey: true })), false);
  assert.equal(T.isPageZoomWheel({ ctrlKey: true, deltaY: -100 }), true);
  assert.equal(T.isPageZoomWheel({ ctrlKey: false, deltaY: -100 }), false);
  const wheel = (target, o) => ({
    target,
    ctrlKey: true,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    deltaY: -100,
    preventDefault() {
      this.pd = true;
    },
    ...o,
  });
  for (const app of [true, false]) {
    const p = fakePage(1500);
    const ctl = T.init(p.win, { fonts: [], desktop: () => app });
    const kd = p.listeners.doc.keydown,
      wh = p.listeners.doc.wheel;
    // outside the chat: the app swallows the browser zoom keys and wheel, a browser keeps them
    p.doc.activeElement = p.outEl;
    for (const k of [
      { key: '=', code: 'Equal' },
      { key: '-', code: 'Minus' },
      { key: '+', code: 'NumpadAdd' },
    ]) {
      const e = key(k);
      kd(e);
      assert.equal(e.pd, app ? true : undefined, JSON.stringify(k) + ' app=' + app);
    }
    const reset = key({ key: '0', code: 'Digit0' });
    kd(reset);
    assert.equal(reset.pd, undefined, 'Ctrl+0 outside the chat still resets a page zoom');
    let e = wheel(p.outEl);
    wh(e);
    assert.equal(e.pd, app ? true : undefined);
    assert.equal(ctl.getChat(), 100);
    // the app's own text-size keys still work and still change the size (both modes)
    e = key({ key: '+', code: 'Equal', shiftKey: true });
    kd(e);
    assert.equal(ctl.getUi(), 110);
    assert.equal(e.pd, true);
    p.doc.activeElement = p.inChatEl;
    e = key({ key: '=', code: 'Equal' });
    kd(e);
    assert.equal(ctl.getChat(), 110);
    e = wheel(p.inChatEl);
    wh(e);
    assert.equal(e.pd, true);
    assert.equal(ctl.getChat(), 120);
    // Ctrl+Shift+wheel over the chat is not a text-size gesture: the app still keeps the page from zooming
    e = wheel(p.inChatEl, { shiftKey: true });
    wh(e);
    assert.equal(e.pd, app ? true : undefined);
    // a plain wheel (scrolling) and plain keys are never touched
    e = wheel(p.outEl, { ctrlKey: false });
    wh(e);
    assert.equal(e.pd, undefined);
    e = key({ key: 'b', code: 'KeyB' });
    kd(e);
    assert.equal(e.pd, undefined);
  }
});
test('page zoom: the app is detected through the desktop bridge when no override is given', () => {
  const p = fakePage(1500);
  p.win.AibDesktop = { available: () => true };
  T.init(p.win, { fonts: [] });
  p.doc.activeElement = p.outEl;
  const e = key({ key: '-', code: 'Minus' });
  p.listeners.doc.keydown(e);
  assert.equal(e.pd, true);
});

test('resize-ui: panel widths and limits grow with the interface size, unchanged at 100 %', () => {
  assert.equal(R.sc(240, 1), 240);
  assert.equal(R.sc(240, undefined), 240);
  assert.equal(R.sc(240, 1.2), 288);
  assert.equal(R.maxSide(1920, 280), 1220);
  assert.equal(R.maxSide(1920, 280, 1), 1220);
  assert.equal(R.maxSide(1920, 280, 1.5), 1220); // no fixed cap: only the chat's 420 px
  assert.equal(R.maxActivity(1100, 240, 1.5), Math.max(330, Math.min(900, 1100 - 240 - 420)));
  const base = { vw: 1500, side: null, activity: null, sideOn: true, actOn: true };
  assert.deepEqual(R.computeLayout(base), { side: 240, activity: 280 });
  assert.deepEqual(R.computeLayout({ ...base, scale: 1 }), { side: 240, activity: 280 });
  assert.deepEqual(R.computeLayout({ ...base, scale: 1.5 }), { side: 360, activity: 420 });
  // a narrow window still gives way before the chat column drops under 420 px
  const l = R.computeLayout({ ...base, vw: 1000, scale: 1.5 });
  assert.ok(l.side + l.activity + 420 <= 1000 || (l.side === 300 && l.activity === 330));
  // a stored width is kept, only clamped to the (scaled) limits
  assert.equal(R.computeLayout({ ...base, side: 250, scale: 1.5 }).side, 300);
});

test('Ctrl+K actions exist, appear with a context that offers them, and are hidden without', () => {
  const calls = [];
  const names = ['chatBigger', 'chatSmaller', 'chatReset', 'uiBigger', 'uiSmaller', 'uiReset'];
  const d = {};
  for (const n of names) d[n] = () => calls.push(n);
  const acts = Reg.buildActions({ chat: null, menu: new Set(), projects: [], keys: {}, do: d });
  const titles = acts.map((a) => a.title);
  for (const t of [
    'Bigger chat text',
    'Smaller chat text',
    'Reset chat text',
    'Bigger interface',
    'Smaller interface',
    'Reset interface size',
  ])
    assert.ok(titles.includes(t), t);
  for (const a of acts.filter((a) => a.group === 'Text size')) a.run();
  assert.deepEqual(calls, names);
  assert.equal(Reg.buildActions({ do: {} }).filter((a) => a.group === 'Text size').length, 0);
  assert.ok(
    Reg.sheetModel({ do: d }).some((g) => g.name === 'Text size' && g.rows.some((r) => r.keys === 'Ctrl+Wheel')),
  );
});
