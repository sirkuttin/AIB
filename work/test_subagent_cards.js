'use strict';
/* Subagent cards in the Activity tab: working helpers are cards (name + run time; model · type + tokens; what it is doing now),
   finished ones one line (outcome when not Done, short model, run time); the inspector subtitle; where model, tokens and the
   activity line come from in a live chat's recorded adapter updates. */
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const { page, load } = require('./fake_dom.js');
const { cssRules, declarationsFor } = require('./css_rules.js');
const { makePage } = require('./chat_harness.js');

const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'subagent-cards-fixture', 'claude_acp_updates.json'), 'utf8'),
);
const NOW = 10000;

function setup() {
  const shell = page();
  const ctx = load(shell, ['composer-chips.js', 'subagents-ui.js']);
  const U = ctx.SubagentsUI;
  const box = shell.make('div');
  shell.body.append(box);
  const draw = (rows, extra = {}) => {
    U.render({
      box,
      rows,
      now: NOW,
      convKey: 'c1',
      empty: 'No subagents yet',
      chatModel: 'claude-opus-5-5',
      onOpen: () => {},
      rerender: () => draw(rows, extra),
      ...extra,
    });
    return box;
  };
  return { U, box, draw, shell };
}
const cardOf = (box, key) => box.querySelectorAll('.subagent-card').find((n) => n.dataset.key === key);
const textIn = (node, sel) => node.querySelector(sel)?.textContent ?? null;

const working = (over = {}) => ({
  key: 'w1',
  live: true,
  state: 'running',
  name: 'Scroll e2e tests',
  agentType: 'general-purpose',
  created: NOW - 130,
  model: 'claude-opus-5-5',
  tokens: 198000,
  activity: 'Running: deno test scroll_e2e_test.ts',
  ...over,
});

test('a working subagent is a three-line card: name + run time, model · type + tokens, what it is doing', () => {
  const { draw } = setup();
  const box = draw([working()]);
  const c = cardOf(box, 'w1');
  assert.ok(c.classList.contains('sa-big'));
  assert.equal(textIn(c, '.sa-title'), 'Scroll e2e tests');
  assert.equal(textIn(c, '.sa-when'), 'running 2m');
  assert.equal(textIn(c, '.sa-meta'), 'Opus 5.5 · general-purpose');
  assert.equal(textIn(c, '.sa-tokens'), '198k tokens');
  assert.equal(textIn(c, '.sa-doing'), 'Running: deno test scroll_e2e_test.ts');
  assert.ok(c.querySelector('.sa-l1') && c.querySelector('.sa-l2') && c.querySelector('.sa-l3'), 'three lines');
  assert.ok(c.querySelector('.sa-l1').contains(c.querySelector('.sa-when')), 'run time on line 1');
  assert.ok(c.querySelector('.sa-l2').contains(c.querySelector('.sa-tokens')), 'tokens on the right of line 2');
  assert.match(c.title, /Model: Opus 5\.5/);
});

test('a helper that names no model shows the chat model; a family alone borrows the chat version', () => {
  const { draw } = setup();
  let box = draw([working({ model: '' })]);
  assert.equal(textIn(cardOf(box, 'w1'), '.sa-meta'), 'Opus 5.5 · general-purpose');
  assert.match(cardOf(box, 'w1').title, /Model: Opus 5\.5 \(the chat’s model\)/);
  box = draw([working({ model: 'opus' })]);
  assert.equal(textIn(cardOf(box, 'w1'), '.sa-meta'), 'Opus 5.5 · general-purpose');
  box = draw([working({ model: 'haiku' })]);
  assert.equal(textIn(cardOf(box, 'w1'), '.sa-meta'), 'Haiku · general-purpose');
  box = draw([working({ model: 'claude-sonnet-4-5-20250929' })]);
  assert.equal(textIn(cardOf(box, 'w1'), '.sa-meta'), 'Sonnet 4.5 · general-purpose');
  box = draw([working({ model: '' })], { chatModel: '' });
  assert.equal(textIn(cardOf(box, 'w1'), '.sa-meta'), 'general-purpose', 'no model known at all: the part is left out');
});

test('tokens are hidden while unknown (never "0 tokens"); the activity line is left out when unknown', () => {
  const { draw } = setup();
  for (const tokens of [0, undefined, null, '']) {
    const c = cardOf(draw([working({ tokens, activity: '' })]), 'w1');
    assert.equal(c.querySelector('.sa-tokens'), null);
    assert.equal(c.querySelector('.sa-doing'), null);
    assert.doesNotMatch(c.textContent, /0 tokens/);
  }
});

test('the activity line updates live as the helper moves on', () => {
  const { draw } = setup();
  let c = cardOf(draw([working()]), 'w1');
  assert.equal(textIn(c, '.sa-doing'), 'Running: deno test scroll_e2e_test.ts');
  c = cardOf(draw([working({ activity: 'Editing chat.js', tokens: 204000 })]), 'w1');
  assert.equal(textIn(c, '.sa-doing'), 'Editing chat.js');
  assert.equal(textIn(c, '.sa-tokens'), '204k tokens');
});

test('finished subagents are one line: outcome only when not Done, short model, run time; tokens only in the tooltip', () => {
  const { draw, box } = setup();
  const rows = [
    {
      key: 'd',
      live: true,
      state: 'idle',
      name: 'Done one',
      created: NOW - 600,
      since: NOW - 300,
      model: 'claude-sonnet-5-5',
      tokens: 41250,
    },
    { key: 'f', live: true, state: 'failed', name: 'Failed one', created: NOW - 900, since: NOW - 840 },
    { key: 's', live: true, state: 'cancelled', name: 'Stopped one', created: NOW - 400, since: NOW - 100 },
  ];
  localStorage_open(box, draw, rows);
  const d = cardOf(box, 'd'),
    f = cardOf(box, 'f'),
    s = cardOf(box, 's');
  for (const c of [d, f, s]) {
    assert.ok(!c.classList.contains('sa-big'), 'finished is not a card');
    assert.equal(c.querySelector('.sa-line'), null, 'one line');
    assert.equal(c.querySelector('.sa-tokens'), null);
  }
  assert.equal(d.querySelector('.sa-outcome'), null, 'a normal finish names no outcome');
  assert.equal(textIn(d, '.sa-model'), 'Sonnet 5.5');
  assert.equal(textIn(d, '.sa-when'), '5m', 'run time, not "ago"');
  assert.match(d.title, /Tokens: 41k/);
  assert.match(d.title, /Ran 5m, finished 5m ago/);
  assert.equal(textIn(f, '.sa-outcome'), 'Failed');
  assert.equal(textIn(f, '.sa-model'), 'Opus 5.5', 'chat model');
  assert.equal(textIn(f, '.sa-when'), '1m');
  assert.equal(textIn(s, '.sa-outcome'), 'Stopped');
  assert.equal(textIn(s, '.sa-when'), '5m');
  assert.match(box.querySelector('.sa-toggle').textContent, /2 finished/, 'the fold stays');
});
function localStorage_open(box, draw, rows) {
  draw(rows);
  box.querySelector('.sa-toggle').onclick(); // open the "N finished" fold (it re-renders through ctx.rerender)
}

test('long titles, meta and activity end in an ellipsis on one line', () => {
  const css = cssRules(fs.readFileSync(path.join(APP_DIR, 'activity.css'), 'utf8'));
  for (const sel of ['.sa-title', '.sa-meta', '.sa-doing', '.sa-model']) {
    const d = declarationsFor(css, sel);
    assert.equal(d['text-overflow'], 'ellipsis', sel);
    assert.equal(d.overflow, 'hidden', sel);
  }
  assert.equal(declarationsFor(css, '.sa-card')['white-space'], 'nowrap');
  assert.equal(declarationsFor(css, '.sa-card')['height'], '28px', 'finished lines stay 28 px');
  assert.equal(declarationsFor(css, '.sa-card.sa-big')['height'], 'auto');
});

test('inspector subtitle: model · type · state · run time · tokens · live, unknown parts left out', () => {
  const { U } = setup();
  const h = U.header(working(), NOW, 'claude-opus-5-5');
  assert.equal(U.subtitle(h, true), 'Opus 5.5 · general-purpose · Working · 2m · 198k tokens · live');
  const h2 = U.header(working({ model: '', tokens: 0 }), NOW, 'claude-sonnet-5-5');
  assert.equal(U.subtitle(h2, true), 'Sonnet 5.5 · general-purpose · Working · 2m · live');
  const h3 = U.header({ key: 'x', name: 'Saved', created: NOW - 60, modified: NOW, finished: true }, NOW, '');
  assert.equal(U.subtitle(h3, false), 'Completed · 1m · saved transcript');
});

test('tokensText and modelName formats', () => {
  const { U } = setup();
  assert.equal(U.tokensText(842), '842 tokens');
  assert.equal(U.tokensText(4210), '4.2k tokens');
  assert.equal(U.tokensText(198400), '198k tokens');
  assert.equal(U.tokensText(1340000), '1.3M tokens');
  assert.equal(U.tokensText(0), '');
  assert.equal(U.modelName('inherit', 'claude-opus-5-5'), 'Opus 5.5');
  assert.equal(U.modelName('', ''), '');
  assert.equal(U.modelName('gpt-5.1-codex', 'x'), 'gpt-5.1-codex', 'other providers keep their own name');
});

test('details: model, tokens, type and activity from recorded Claude ACP adapter updates', () => {
  const { U } = setup();
  const d = U.details(FIXTURE.events, FIXTURE.mainSessionId);
  const A = d.get('child-A'),
    B = d.get('child-B'),
    C = d.get('child-C'),
    D = d.get('child-D');
  // Running helper: Agent input model + subagent_type, its own usage_update so far, its latest tool call (title filled in later).
  assert.equal(A.model, 'opus');
  assert.equal(A.agentType, 'general-purpose');
  assert.equal(A.tokens, 52000);
  assert.equal(A.activity, 'Running: deno test scroll_e2e_test.ts');
  assert.equal(A.toolUseId, 'toolu_A');
  // Finished helper: no model named; tokens from the Task result's totalTokens; its last message is what it was doing.
  assert.equal(B.model, undefined);
  assert.equal(B.agentType, 'Explore');
  assert.equal(B.tokens, 41250);
  assert.equal(B.activity, 'Found three unused imports in chat.js.');
  // Background helper: tokens from the task-notification of the agentId its launch reported.
  assert.equal(C.tokens, 198400);
  assert.equal(C.activity, 'Reading CHANGELOG.md');
  // A helper nothing is known about: every part hidden.
  assert.deepEqual({ ...D }, {});
});

test('activityOf phrases tool calls in a few words', () => {
  const { U } = setup();
  assert.equal(U.activityOf({ kind: 'execute', rawInput: { command: 'npm test' } }), 'Running: npm test');
  assert.equal(U.activityOf({ kind: 'edit', rawInput: { file_path: 'C:/a/b/chat.js' } }), 'Editing chat.js');
  assert.equal(
    U.activityOf({ kind: 'edit', rawInput: { file_path: '/x/new.md' }, _meta: { claudeCode: { toolName: 'Write' } } }),
    'Writing new.md',
  );
  assert.equal(U.activityOf({ kind: 'read', locations: [{ path: '/x/y/z.ts' }] }), 'Reading z.ts');
  assert.equal(U.activityOf({ kind: 'search', rawInput: { pattern: 'TODO' } }), 'Searching: TODO');
  assert.equal(U.activityOf({ title: 'Some tool' }), 'Some tool');
});

test('chat.js: live children get model, tokens and activity; the inspector subtitle names them', () => {
  const h = makePage({
    window: {
      AgentComposerChips: require(path.join(APP_DIR, 'composer-chips.js')),
      SubagentsUI: require(path.join(APP_DIR, 'subagents-ui.js')),
    },
  });
  h.run("current='conn';snapshot={sessionId:'main-1',inUse:{model:'claude-opus-5-5'},subagents:{}}");
  const t0 = Date.now() / 1000 - 30;
  h.state.events = FIXTURE.events.map((e) => ({ ...e, time: t0 + (e.time - 1000) / 100 }));
  h.run('children.clear();collectChildren()');
  const a = h.run("children.get('child-A')");
  assert.equal(a.model, 'opus');
  assert.equal(a.tokens, 52000);
  assert.equal(a.activity, 'Running: deno test scroll_e2e_test.ts');
  assert.equal(h.run('chatModel()'), 'claude-opus-5-5');
  h.run("subSelection={key:'child-A',live:true}");
  h.run('renderSubHead()');
  assert.match(
    h.element('subchatStatus').textContent,
    /^Opus 5\.5 · general-purpose · Working · <1m · 52k tokens · live$/,
  );
  h.run("subSelection={key:'child-D',live:true}");
  h.run('renderSubHead()');
  assert.equal(h.element('subchatStatus').textContent, 'Opus 5.5 · Working · <1m · live');
});

/* A real claude-agent-acp 0.97.0 stream (subagents form, which AIB declares), trimmed: two background helpers started with the
   Agent input model "sonnet" by an Opus chat; the owner pressed Interrupt while both were in long commands; both ran on and ended
   on their own. The parent's Agent call never reaches the client in this form: the model comes as the child's config option. */
const RFD = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'subagent-cards-fixture', 'claude_acp_rfd_interrupt.json'), 'utf8'),
);
const WIDEN = 'a4ea6b53148419096',
  QA = 'a3771e24db1406b8d';
const at = (iso) => Date.parse('2026-11-12T' + iso + 'Z') / 1000;
function rfdPage(events) {
  const h = makePage({
    window: {
      AgentComposerChips: require(path.join(APP_DIR, 'composer-chips.js')),
      SubagentsUI: require(path.join(APP_DIR, 'subagents-ui.js')),
    },
  });
  h.run(`current='conn';snapshot={sessionId:'${RFD.mainSessionId}',inUse:{model:'claude-opus-5-5'},subagents:{}}`);
  h.state.events = events;
  h.run('children.clear();collectChildren()');
  const U = h.context.window.SubagentsUI;
  const rows = (now) => {
    const m = U.model([...h.hook.children.values()], now, 'claude-opus-5-5');
    return Object.fromEntries([...m.top, ...m.done].map((i) => [i.key, i]));
  };
  return { h, U, rows };
}

test('recorded stream: a background helper started with model "sonnet" shows Sonnet 5.5, not the chat model', () => {
  const { U } = setup();
  const d = U.details(RFD.events, RFD.mainSessionId);
  assert.equal(d.get(WIDEN).model, 'Sonnet 5.5');
  assert.equal(d.get(WIDEN).agentType, 'general-purpose');
  assert.equal(d.get(QA).model, 'Sonnet 5.5');
  assert.equal(d.get(QA).agentType, 'studio-qa');
  const { rows } = rfdPage(RFD.events.slice(0, 10)); // both started, working
  const r = rows(at('05:46:00'));
  assert.equal(r[WIDEN].group, 'working');
  assert.equal(r[WIDEN].modelText, 'Sonnet 5.5');
  assert.equal(r[QA].modelText, 'Sonnet 5.5');
  assert.doesNotMatch(r[WIDEN].tip, /the chat’s model/);
});

test('recorded stream: Interrupt on the reply leaves running background helpers working, with their real run time', () => {
  const cancelled = RFD.events.findIndex((e) => e.kind === 'turn_end' && e.data.stopReason === 'cancelled');
  assert.ok(cancelled > 0);
  // Just after the interrupt, before either helper says anything again (each is in a long command).
  let { rows } = rfdPage(RFD.events.slice(0, cancelled + 1));
  let r = rows(at('05:51:19'));
  for (const id of [WIDEN, QA]) {
    assert.equal(r[id].group, 'working', id + ' is not marked Interrupted');
    assert.equal(r[id].label, 'Working');
    assert.equal(r[id].outcome, '');
  }
  assert.equal(r[WIDEN].when, 'running 7m', 'from its Agent call at 05:44:00');
  // The whole stream: both ended on their own after the interrupt; the run time is Agent call to end.
  ({ rows } = rfdPage(RFD.events));
  r = rows(at('05:53:00'));
  for (const id of [WIDEN, QA]) {
    assert.equal(r[id].group, 'finished');
    assert.equal(r[id].outcome, '', id + ' finished normally (no "Interrupted")');
    assert.equal(r[id].ran, '8m', id + ' ran about 8 minutes, not "<1m"');
    assert.equal(r[id].modelText, 'Sonnet 5.5');
  }
});

test('a family-only model from the Agent input takes the version the chat spent on it', () => {
  const { U } = setup();
  const ev = (sid, update, time = 1) => ({ kind: 'update', time, data: { sessionId: sid, update } });
  const agentCall = (id, input) =>
    ev('m', { sessionUpdate: 'tool_call', toolCallId: id, title: 'Agent', rawInput: input, _meta: { claudeCode: { toolName: 'Agent' } } });
  const child = (sid, use) =>
    ev(sid, { sessionUpdate: 'agent_thought_chunk', content: { text: 'x' }, _meta: { claudeCode: { parentToolUseId: use } } });
  const spent = { kind: 'turn_end', time: 2, data: { stopReason: 'end_turn', _meta: { quota: { model_usage: [
    { model: 'claude-opus-5-5' }, { model: 'claude-sonnet-5-5' }] } } } };
  const events = [
    agentCall('t1', { description: 'bg', model: 'sonnet', run_in_background: true, subagent_type: 'general-purpose' }),
    child('c1', 't1'),
    agentCall('t2', { description: 'fg', model: 'haiku' }),
    child('c2', 't2'),
    spent,
  ];
  const d = U.details(events, 'm');
  assert.equal(d.get('c1').model, 'claude-sonnet-5-5', 'background call input is read');
  assert.equal(U.modelName(d.get('c1').model, 'claude-opus-5-5'), 'Sonnet 5.5');
  assert.equal(d.get('c2').model, 'haiku', 'no Haiku spend seen: the family stays');
  assert.equal(U.modelName('haiku', 'claude-opus-5-5'), 'Haiku');
});

test('a child the agent stopped (idle, stopReason cancelled) is Stopped; an error end is Failed; a normal end is Done', () => {
  const { U } = setup();
  assert.equal(U.classify({ live: true, state: { state: 'idle', stopReason: 'cancelled' } }).label, 'Stopped');
  assert.equal(U.classify({ live: true, state: { state: 'idle', stopReason: 'error' } }).kind, 'failed');
  const done = U.classify({ live: true, state: { state: 'idle', stopReason: 'end_turn' } });
  assert.equal(done.group, 'finished');
  assert.equal(done.kind, 'idle');
});

test('the Activity tab shows how many subagents are working, and nothing when none are', () => {
  const h = makePage({});
  const tab = h.element('paneTab-activity');
  h.run('setActCounts({subagents:5,working:2,failed:0});paintActivityTabBadge()');
  const badge = () => tab.querySelector('.pane-badge');
  assert.ok(badge(), 'a count badge like Changes and Artifacts');
  assert.equal(badge().textContent, '2');
  assert.equal(badge().hidden, false);
  h.run('setActCounts({subagents:5,working:0,failed:0});paintActivityTabBadge()');
  assert.equal(badge().hidden, true);
});
