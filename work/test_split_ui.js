'use strict';
// Smoke test for split-ui.js (the panes) in a vm with a minimal fake DOM. split-tree.js (the pure layout logic) has its own tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const SCRIPTS = ['split-tree.js', 'split-ui.js'];
const TITLES = { a: 'Chat A', b: 'Chat B', c: 'Chat C' };

function setup({ width = 1400, store = {}, tabs = ['a', 'b'], selected = 'a' } = {}) {
  const shell = D.page({ width, store });
  const ctx = D.load(shell, SCRIPTS);
  const log = { opened: [], redraws: 0, notices: [], ordered: [], started: 0 };
  const state = { selected, tabs };
  const host = {
    selectedKey: () => state.selected,
    singleTabs: () => state.tabs,
    orderTabs: (list) => {
      log.ordered.push(list);
    },
    convOf: (key) => (TITLES[key] ? { key, title: TITLES[key], provider: 'claude' } : null),
    titleOf: (c) => c.title,
    statusText: () => ({ text: 'Idle', tone: 'idle' }),
    draftOf: () => '',
    agentName: () => 'Claude Code',
    dotFor: () => null,
    open: (c) => {
      log.opened.push(c.key);
      state.selected = c.key;
    },
    redraw: () => {
      log.redraws++;
    },
    notice: (text) => {
      log.notices.push(text);
    },
    showStart: () => {
      log.started++;
    },
    mirror: { rows: () => null, paint() {}, wake() {}, stash() {} },
  };
  const S = ctx.AgentSplitUI;
  S.init(host);
  const sync = (o = {}) =>
    S.sync(
      Object.assign(
        {
          key: 'p:proj',
          selectedKey: state.selected,
          valid: new Set(Object.keys(TITLES)),
          allowed: null,
          add: [],
          wantDraft: false,
        },
        o,
      ),
    );
  return { shell, ctx, S, host, log, state, sync };
}

const panesOf = (t) => t.shell.body.querySelectorAll('.pane');

test('the module loads and, with one pane, draws nothing and leaves the page alone', () => {
  const t = setup();
  assert.equal(typeof t.S.init, 'function');
  assert.equal(t.S.ready(), true);
  assert.equal(t.S.active(), false);
  const result = t.sync();
  assert.equal(JSON.stringify(result), '{"collapsed":null}');
  assert.equal(panesOf(t).length, 0);
  assert.equal(t.shell.byId.chatTabs.hidden, false, 'the single strip stays visible');
  assert.equal(t.S.signature(), '');
  assert.equal(t.S.panes().length, 0);
});

test('init does nothing when the page has no main or tab strip', () => {
  const shell = D.page();
  shell.byId.chatTabs.remove();
  delete shell.byId.chatTabs;
  const ctx = D.load(shell, SCRIPTS);
  ctx.AgentSplitUI.init({ selectedKey: () => '' });
  assert.equal(ctx.AgentSplitUI.ready(), false);
});

test('splitting right makes two panes, hides the single strip and moves focus to the new pane', () => {
  const t = setup();
  t.sync();
  t.S.splitTab('b', 'row');
  assert.equal(t.S.active(), true);
  assert.equal(panesOf(t).length, 2);
  assert.equal(t.shell.byId.chatTabs.hidden, true, 'the single strip gives way to one strip per pane');
  assert.ok(t.shell.body.classList.contains('split-on'));
  assert.equal(t.S.panes().length, 2);
  assert.equal(t.S.panes().filter((p) => p.focused).length, 1);
  assert.ok(t.S.signature().length > 0);
  assert.equal(t.S.layout().tree.k, 's');
  assert.equal(t.S.layout().tree.dir, 'row');
});

test('the unfocused pane shows a read-only copy of its chat with title and status; the focused pane shows the real view', () => {
  const t = setup();
  t.sync();
  t.S.splitTab('b', 'row');
  const mirrors = t.shell.body.querySelectorAll('.mirror');
  assert.equal(mirrors.length, 1, 'one mirror, for the pane that is not focused');
  const title = mirrors[0].querySelector('.mirror-title').textContent;
  assert.ok(Object.values(TITLES).includes(title), title);
  assert.equal(mirrors[0].querySelector('.mirror-status').textContent, 'Idle');
  assert.equal(t.S.mirrorTargets().length, 1);
});

test('the layout is saved to localStorage and a new page restores it', () => {
  const t = setup();
  t.sync();
  t.S.splitTab('b', 'row');
  const saved =
    t.shell.localStorage.getItem('studio-split-v1') ||
    Array.from(t.shell.localStorage._data.entries()).find(([k]) => /split/i.test(k));
  assert.ok(saved, 'a split layout key was written');
  const entries = Object.fromEntries(t.shell.localStorage._data);
  const again = setup({ store: entries });
  again.sync();
  assert.equal(again.S.active(), true, 'the second page comes up already split');
  assert.equal(panesOf(again).length, 2);
});

test('a window narrower than the breakpoint collapses to one pane without losing the layout', () => {
  const t = setup();
  t.sync();
  t.S.splitTab('b', 'row');
  assert.equal(t.S.active(), true);
  t.shell.window.innerWidth = 700;
  t.ctx.innerWidth = 700;
  t.sync();
  assert.equal(t.S.active(), false, 'narrow windows show one pane');
  assert.equal(panesOf(t).length, 0);
  assert.ok(t.S.layout(), 'the stored layout is kept for when the window is wide again');
  t.ctx.innerWidth = 1400;
  t.sync();
  assert.equal(t.S.active(), true);
  assert.equal(panesOf(t).length, 2);
});

test('Ctrl+1 and Ctrl+2 focus panes only while panes exist; Ctrl+\\ splits the focused pane', () => {
  const t = setup();
  t.sync();
  const keyed = (key) => {
    const e = {
      key,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {},
    };
    return [t.S.handleKey(e), e];
  };
  assert.equal(keyed('1')[0], false, 'with one pane Ctrl+1 stays "jump to tab"');
  assert.equal(keyed('\\')[0], true);
  assert.equal(t.S.active(), true);
  const [handled, event] = keyed('1');
  assert.equal(handled, true);
  assert.equal(event.prevented, true);
  assert.equal(t.S.panes().find((p) => p.index === 0).focused, true);
});

test('focusing the other pane opens its chat in the real view', () => {
  const t = setup();
  t.sync();
  t.S.splitTab('b', 'row');
  const other = t.S.panes().find((p) => !p.focused),
    before = t.log.opened.length;
  t.S.focusPane(other.id);
  assert.equal(t.S.panes().find((p) => p.id === other.id).focused, true);
  assert.equal(t.log.opened.length, before + 1);
  assert.equal(t.log.opened[before], other.group.active);
});

test("closing the second pane's last tab collapses back to one pane and hands the tabs to the single strip", () => {
  const t = setup();
  t.sync();
  t.S.splitTab('b', 'row');
  const keys = t.S.panes()
    .map((p) => p.group.active)
    .filter(Boolean);
  assert.equal(keys.length, 2);
  const result = t.S.closeTab(t.S.panes().find((p) => !p.focused).group.active);
  assert.ok(result && 'next' in result);
  t.state.tabs = result.order || t.state.tabs;
  t.sync();
  assert.equal(t.S.active(), false, "one pane left: back to today's page");
  assert.equal(panesOf(t).length, 0);
  assert.equal(t.shell.byId.chatTabs.hidden, false);
});

test('the split menu offers split right and split down, and "move to next pane" once panes exist', () => {
  const t = setup();
  t.sync();
  assert.equal(
    t.S.menuItems('a')
      .map((i) => i.id)
      .join(),
    'split-right,split-down',
  );
  t.S.splitTab('b', 'row');
  assert.equal(
    t.S.menuItems('a')
      .map((i) => i.id)
      .join(),
    'split-right,split-down,move-next',
  );
});

test('a corrupt saved layout is ignored', () => {
  const t = setup({ store: { 'studio-split-v1': '{nope' } });
  assert.doesNotThrow(() => t.sync());
  assert.equal(t.S.active(), false);
});
