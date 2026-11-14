'use strict';
/* Three app bugs from the styling review (B1-B3):
   1. A chat's sidebar card said "Elsewhere · Idle" while the header said "Elsewhere · Working": the header read the raw
      ownership facts, the card the steady conversation.elsewhere verdict. Both must read the same verdict.
   2. At <=1100 px the open chat-list drawer drew under the Activity strip and the scrim: the plain `body > aside` rule
      (z-index 5) came after the narrow-width block and beat its z-index 40.
   3. A saved tool call with no result (read from another app's transcript) had no status mark at all. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { makePage, pageAssets } = require('./chat_harness.js');
const { cssRules } = require('./css_rules');

// ---- 1. header and sidebar card say the same status words -----------------------------------------------------------

function elsewherePage() {
  const page = makePage({
    scripts: ['status-words.js', 'attention-ui.js', 'notify-rules.js', 'sidebar-ui.js'],
    window: { setInterval: () => 0, clearInterval() {} },
  });
  const c = {
    key: 'omp:s1',
    provider: 'omp',
    id: 's1',
    cwd: 'C:\\repo',
    title: 'Elsewhere chat',
    modified: Date.now() / 1000 - 600,
    elsewhere: { working: false, confirmed: true, verdict: 'owned_elsewhere' },
  };
  page.state.conversations = [c];
  page.state.selected = c;
  page.state.current = null;
  // The raw hint says "working" (recent transcript writes); the steady verdict still says idle (it lags ~12 s).
  page.state.ownershipHints = { 'omp:s1': { verdict: 'owned_elsewhere', reasons: [{ signal: 'transcript' }] } };
  return { page, c };
}
const words = (page, c) => {
  page.run('renderHeader()');
  const card = page.context.window.AgentSidebarUI.phrase(c, { hint: page.state.ownershipHints['omp:s1'] });
  return {
    header: page.element('status').textContent,
    line: page.element('turnStatus').dataset.status,
    card: card.text,
  };
};

test('header, turn line and sidebar card agree on Elsewhere · Idle / Working across the transition', () => {
  const { page, c } = elsewherePage();
  let w = words(page, c);
  assert.equal(w.card, 'Elsewhere · Idle');
  assert.equal(w.header, w.card, 'header must not run ahead of the card on the raw facts');
  assert.equal(w.line, 'elsewhere-idle');
  c.elsewhere = { ...c.elsewhere, working: true }; // the steady verdict catches up
  w = words(page, c);
  assert.equal(w.card, 'Elsewhere · Working');
  assert.equal(w.header, w.card);
  assert.equal(w.line, 'elsewhere-working');
  c.elsewhere = { ...c.elsewhere, working: false };
  page.state.ownershipHints = { 'omp:s1': { verdict: 'owned_elsewhere', reasons: [] } };
  w = words(page, c);
  assert.equal(w.header, 'Elsewhere · Idle');
  assert.equal(w.header, w.card);
});

// ---- 2. the narrow-width drawer sits over the Activity strip and the scrim -------------------------------------------

/* A small cascade for one viewport width: the last declaration of the exact selector wins, over chat.html's stylesheets in
   load order, counting only top-level rules and @media width conditions that hold at `width`. */
function cascade(width, selector) {
  const holds = (context) => {
    if (!context) return true;
    if (!context.startsWith('@media')) return false;
    const conds = [...context.matchAll(/\((min|max)-width:(\d+)px\)/g)];
    if (!conds.length || /\((?!min-width|max-width)[a-z-]+:/.test(context)) return false; // other features: not assumed
    return conds.every(([, kind, px]) => (kind === 'min' ? width >= Number(px) : width <= Number(px)));
  };
  const out = {};
  for (const href of pageAssets().styles) {
    const css = fs.readFileSync(path.join(APP, href.replace(/^\//, '')), 'utf8');
    for (const rule of cssRules(css))
      if (rule.selector === selector && holds(rule.context)) Object.assign(out, rule.declarations);
  }
  return out;
}

test('at 760 px the open chat-list drawer stacks over the Activity strip and the scrim', () => {
  const aside = cascade(760, 'body > aside'),
    pane = cascade(760, '#subagentsPane'),
    scrim = cascade(760, '.ws-scrim:not([hidden])'),
    drawer = cascade(760, '.aside-main');
  assert.equal(drawer.position, 'fixed');
  assert.notEqual(aside.position || 'static', 'static', 'the aside makes the stacking context that holds the drawer');
  const z = (d) => Number(d['z-index']);
  assert.ok(z(aside) > z(pane), 'aside z-index ' + aside['z-index'] + ' must beat #subagentsPane ' + pane['z-index']);
  assert.ok(z(aside) > z(scrim), 'aside z-index ' + aside['z-index'] + ' must beat the scrim ' + scrim['z-index']);
  assert.equal(aside.overflow, 'visible');
  // the scrim and the Activity pane are siblings of the aside under <body>, so the z-index comparison above is the real one
  assert.match(fs.readFileSync(path.join(APP, 'workspace-ui.js'), 'utf8'), /d\.body\.append\([^)]*scrim\)/);
  assert.match(pageAssets().html, /<\/main>\s*<section id="subagentsPane"/);
});

test('wide windows keep the side-by-side aside under the panes (z-index 5)', () => {
  assert.equal(cascade(1400, 'body > aside')['z-index'], '5');
});

// ---- 3. a saved tool call with no result shows running (Elsewhere · Working) or pending ------------------------------

const TV = makePage({ scripts: ['tool-views.js'] }).context.window.ToolViews;

test('ToolViews.summarize: a saved call without a result is pending, or running when marked', () => {
  const call = (extra) => ({ role: 'tool', call: { name: 'Bash', input: { command: 'ls' }, ...extra } });
  assert.equal(TV.summarize(call({})).status, 'pending');
  assert.equal(TV.summarize(call({ running: true })).status, 'running');
  assert.equal(TV.summarize(call({ result: { text: 'ok' } })).status, 'ok');
  assert.equal(TV.summarize(call({ running: true, result: { text: 'x', isError: true } })).status, 'failed');
});

function savedRows(working) {
  const page = makePage({ scripts: ['tool-views.js'] });
  const c = { key: 'omp:s2', provider: 'omp', id: 's2' };
  if (working !== undefined) c.elsewhere = { working, confirmed: true, verdict: 'owned_elsewhere' };
  page.state.conversations = [c];
  const data = {
    events: [
      { kind: 'user', text: 'go', time: 1 },
      { kind: 'tool', label: 'Bash', text: '{"command":"a"}', callId: 'c1', time: 2 },
      { kind: 'tool', label: 'Bash', text: '{"command":"b"}', callId: 'c2', time: 3 },
      { kind: 'result', text: 'done b', callId: 'c2', time: 4 },
      { kind: 'tool', label: 'Bash', text: '{"command":"c"}', callId: 'c3', time: 5 },
    ],
  };
  page.context.__data = data;
  const rows = page.run('normalized(__data, "omp:s2", true)');
  return [...rows].filter((r) => r.role === 'tool').map((r) => page.context.window.ToolViews.summarize(r).status);
}

test('Elsewhere · Working chat: the last call without a result is running, older ones pending', () => {
  assert.deepEqual(savedRows(true), ['pending', 'ok', 'running']);
});

test('Elsewhere · Idle or a plain saved chat: a call without a result is pending (•), never blank', () => {
  assert.deepEqual(savedRows(false), ['pending', 'ok', 'pending']);
  assert.deepEqual(savedRows(undefined), ['pending', 'ok', 'pending']);
});
