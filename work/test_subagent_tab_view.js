'use strict';
/* Regression: a subagent history opened from the Activity tab stayed drawn over the Changes and Artifacts tabs. The history
   belongs to the Activity tab: hidden (but kept open, same subagent, same scroll) on the other two tabs, at every width, and
   shown again on Activity. Also: switching tabs while it is open must not be undone by later class changes on <body>, and
   Escape or a click in the chat must not close a history you cannot see. */
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const { cssRules } = require('./css_rules.js');
const { page } = require('./fake_dom.js');
const { loadChat } = require('./chat_harness.js');
const C = require(path.join(APP_DIR, 'changes-ui.js'));

const css = (name) => cssRules(fs.readFileSync(path.join(APP_DIR, name), 'utf8'));
const ALL_CSS = [
  'chat.css',
  'activity.css',
  'changes.css',
  'artifacts.css',
  'split.css',
  'textsize.css',
  'workspace.css',
]
  .map(css)
  .flat();

/* What the CSS says about #subchatPane for a pane class, ignoring the at-rule condition (so wide and narrow both count). */
function subchatDisplayRules() {
  return ALL_CSS.filter((r) => /#subchatPane\b/.test(r.selector) && r.declarations.display);
}

test('CSS: the subagent history is hidden on the Changes and Artifacts tabs at every width, and wins over the narrow rules', () => {
  const rules = subchatDisplayRules();
  for (const tab of ['tab-changes', 'tab-artifacts']) {
    const hide = rules.find((r) => r.selector === `#subagentsPane.${tab} #subchatPane`);
    assert.ok(hide, `a rule hides #subchatPane under .${tab}`);
    assert.equal(hide.declarations.display, 'none !important');
    assert.equal(hide.context, '', 'outside any @media, so it holds in the wide column and in the narrow strip');
  }
  /* Nothing else may show it with !important (that would beat the hide rule). */
  for (const r of rules)
    if (r.declarations.display !== 'none !important')
      assert.ok(!/!important/.test(r.declarations.display), `${r.selector} must not force the history visible`);
  /* The Activity tab has no such rule: the history shows there as before. */
  assert.ok(!rules.some((r) => /tab-activity/.test(r.selector)));
});

/* changes-ui.js on a fake page with a MutationObserver we fire by hand (the browser fires it after a class change on <body>). */
function setup(width) {
  const shell = page({ width, ids: ['activityStrip', 'chat'] });
  const pane = shell.byId.subagentsPane;
  shell.make('div', 'activityBody', pane);
  const subchat = shell.make('section', 'subchatPane', pane);
  subchat.hidden = true;
  const observers = [];
  shell.window.MutationObserver = class {
    constructor(fn) {
      this.fn = fn;
      observers.push(this);
    }
    observe(target) {
      this.target = target;
    }
  };
  shell.window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ git: true, files: [] }) });
  shell.window.setInterval = () => 1;
  shell.window.clearInterval = () => {};
  shell.window.matchMedia = () => ({ matches: width < 1100, addEventListener() {} });
  C.init(shell.window);
  C.sync({ id: 'chat1', busy: false });
  const bodyChanged = () => observers.filter((o) => o.target === shell.body).forEach((o) => o.fn([]));
  /* What chat.js does when you open a subagent from the Activity list (or from a card in the chat). */
  const openSubagent = () => {
    subchat.hidden = false;
    shell.body.classList.add('subchat-open');
    C.show('activity');
    bodyChanged();
  };
  const tab = () => C._live().state().tab;
  /* The history is on screen only on the Activity tab: on the others the pane carries the class the CSS rule hides it by. */
  const historyShown = () =>
    !subchat.hidden && !pane.classList.contains('tab-changes') && !pane.classList.contains('tab-artifacts');
  return { shell, pane, subchat, openSubagent, bodyChanged, tab, historyShown };
}

for (const [label, width] of [
  ['wide', 1400],
  ['narrow (strip below 1100 px)', 900],
]) {
  test(`${label}: open a subagent, switch to Artifacts and Changes (history hidden), back to Activity (shown again)`, () => {
    const t = setup(width);
    t.openSubagent();
    assert.equal(t.tab(), 'activity');
    assert.equal(t.historyShown(), true);

    for (const name of ['artifacts', 'changes']) {
      C.show(name);
      t.bodyChanged(); // any later class change on <body> (busy, widened column...) must not pull you back to Activity
      assert.equal(t.tab(), name, `still on ${name}`);
      assert.ok(t.pane.classList.contains('tab-' + name));
      assert.equal(t.historyShown(), false, `history hidden on ${name}`);
      assert.equal(t.subchat.hidden, false, 'kept open, so nothing is lost');
    }

    C.show('activity');
    assert.equal(t.historyShown(), true, 'shown again on Activity');
    assert.ok(!t.pane.classList.contains('tab-changes') && !t.pane.classList.contains('tab-artifacts'));
  });
}

test('opening a subagent while Changes or Artifacts is showing switches to Activity (open counts, staying open does not)', () => {
  const t = setup(1400);
  C.show('artifacts');
  t.openSubagent();
  assert.equal(t.tab(), 'activity');
  C.show('changes');
  t.bodyChanged();
  assert.equal(t.tab(), 'changes');
  /* closed, then opened again through the class alone (the observer fallback): back to Activity */
  t.shell.body.classList.remove('subchat-open');
  t.bodyChanged();
  t.shell.body.classList.add('subchat-open');
  t.bodyChanged();
  assert.equal(t.tab(), 'activity');
});

test('the reverse: the Changes view (and its open diffs) is hidden on Activity and Artifacts', () => {
  const t = setup(1400);
  const views = () => ({ changes: !t.pane.querySelector('.changes-pane').hidden });
  C.show('changes');
  assert.equal(views().changes, true);
  C.show('artifacts');
  assert.equal(views().changes, false);
  C.show('activity');
  assert.equal(views().changes, false);
  for (const sel of ['.changes-pane[hidden]', '.artifacts-pane[hidden]'])
    assert.ok(
      ALL_CSS.some((r) => r.selector === sel && r.declarations.display === 'none'),
      `${sel} is display:none`,
    );
});

/* chat.js: Escape and a click in the chat close the history only while you can see it. */
test('chat.js: on Changes or Artifacts, Escape and a click in the chat leave the hidden history open', () => {
  const els = new Map();
  const classes = new Set();
  const el = (id) => {
    if (!els.has(id))
      els.set(id, {
        id,
        value: '',
        checked: false,
        hidden: false,
        addEventListener() {},
        classList: {
          contains: (c) => id === 'subagentsPane' && classes.has(c),
          add() {},
          remove() {},
          toggle() {},
        },
      });
    return els.get(id);
  };
  const listeners = {};
  const storage = () => ({ getItem: () => null, setItem() {}, removeItem() {} });
  const context = vm.createContext({
    localStorage: storage(),
    sessionStorage: storage(),
    document: {
      getElementById: el,
      querySelector: () => null,
      body: { classList: { add() {}, remove() {}, contains: () => false, toggle() {} } },
    },
    window: {
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
    },
    fetch: () => new Promise(() => {}),
    setInterval() {},
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimeout,
    URLSearchParams,
    AbortController,
    Date,
    console,
  });
  loadChat(context);
  const fire = (type, event) => {
    for (const f of listeners[type] || [])
      try {
        f(event);
      } catch (e) {
        /* closeInspector repaints lists this fake page does not have; hiding the pane comes first */
      }
  };
  const escape = () => fire('keydown', { key: 'Escape', target: { tagName: 'DIV' }, preventDefault() {} });
  const clickChat = () => fire('pointerdown', { target: { closest: (sel) => (sel === 'main' ? {} : null) } });

  for (const tab of ['tab-artifacts', 'tab-changes']) {
    classes.clear();
    classes.add(tab);
    el('subchatPane').hidden = false;
    escape();
    assert.equal(el('subchatPane').hidden, false, `Escape on ${tab} keeps the history`);
    clickChat();
    assert.equal(el('subchatPane').hidden, false, `a click in the chat on ${tab} keeps the history`);
  }
  classes.clear();
  escape();
  assert.equal(el('subchatPane').hidden, true, 'on Activity, Escape closes it as before');
  el('subchatPane').hidden = false;
  clickChat();
  assert.equal(el('subchatPane').hidden, true, 'on Activity, a click in the chat closes it as before');
});
