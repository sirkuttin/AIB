'use strict';
// Allow rules on the page (allow-rules-ui.js): the "Always allow" choice on an approval card (preview per scope; greyed out with the
// reason on floor items; none on plan cards), answer + rule in one call with "answered elsewhere: save anyway?", the Undo note, and
// Settings > Allow rules (tamper banner, delete).
const test = require('node:test');
const assert = require('node:assert/strict');
const { page, load } = require('./fake_dom.js');

function ui() {
  const shell = page();
  const ctx = load(shell, ['allow-rules-ui.js']);
  return { shell, UI: ctx.AllowRulesUI };
}

const draft = (over = {}) => ({
  offer: true,
  hideAgentAlways: true,
  available: true,
  reason: '',
  floor: false,
  rules: [{ kind: 'command', words: ['npm', 'test'], label: 'npm test' }],
  preview: 'Rule: npm test + file paths and flags inside the project, in shop-web.',
  ...over,
});

test('the Always choice shows the rule for the chosen scope and can be ticked', () => {
  const { UI } = ui();
  const c = UI.choice({ project: draft(), global: draft({ preview: 'Rule: npm test …, everywhere.' }), off: '' });
  assert.ok(c);
  const box = c.element;
  assert.match(box.textContent, /Always allow commands like this/);
  assert.match(box.textContent, /in shop-web/);
  const tick = box.querySelector('input');
  assert.equal(tick.disabled, false);
  tick.checked = true;
  assert.equal(c.ticked(), true);
  const select = box.querySelector('select');
  select.value = 'global';
  select.onchange();
  assert.equal(c.scope(), 'global');
  assert.match(box.querySelector('.allow-preview').textContent, /everywhere/);
});

test('a floor item greys the choice out with the reason; plan cards get none', () => {
  const { UI } = ui();
  const no = draft({ available: false, floor: true, rules: [], preview: '', reason: 'Not available: AIB never auto-allows force-push.' });
  const c = UI.choice({ project: no, global: no, off: '' });
  assert.equal(c.element.querySelector('input').disabled, true);
  assert.equal(c.ticked(), false);
  assert.match(c.element.textContent, /never auto-allows force-push/);
  assert.ok(c.element.className.includes('unavailable'));
  assert.equal(UI.choice({ project: draft({ offer: false, hideAgentAlways: false }), global: draft(), off: '' }), null);
  assert.equal(UI.choice(null), null);
  const off = UI.choice({ project: draft(), global: draft(), off: 'Allow rules are off: the rules file was changed outside AIB.' });
  assert.equal(off.element.querySelector('input').disabled, true);
  assert.match(off.element.textContent, /changed outside AIB/);
});

test('answer + rule: answered elsewhere offers "Save rule", and Undo removes the rule', async () => {
  const { UI } = ui();
  const sent = [];
  const post = async (body) => {
    sent.push(body);
    if (!body.saveOnly) {
      const e = Error('This request was already answered elsewhere. Save the rule anyway?');
      e.code = 'answered_elsewhere';
      throw e;
    }
    return { ok: true, rules: [{ id: 'r1', label: 'npm test', scope: 'project' }], alsoAllowed: 2 };
  };
  const saved = await UI.answer(post, 'project');
  assert.equal(saved.elsewhere, true);
  const removed = [];
  const note = UI.toast(saved, async (id) => removed.push(id));
  const parent = note.ownerDocument.createElement('div');
  parent.append(note);
  assert.match(note.textContent, /already answered elsewhere/);
  await note.querySelector('button').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ scope: 'project' }, { scope: 'project', saveOnly: true }]);
  const added = parent.firstChild;
  assert.match(added.textContent, /Rule added: npm test\. Also allowed 2 waiting requests\./);
  await added.querySelector('button').onclick();
  assert.deepEqual(removed, ['r1']);
  assert.match(added.textContent, /Rule removed/);
});

test('Settings > Allow rules: tamper banner, built-ins and Delete', async () => {
  const { UI, shell } = ui();
  const calls = [];
  let data = {
    enabled: true,
    tampered: true,
    builtins: { safeReads: true, syntax: true, scratch: true },
    rules: [{ id: 'r1', label: 'npm test', scope: 'project', project: 'C:\\code\\shop-web', pins: { x: 'y' } }],
  };
  const host = {
    post: async (path, body) => {
      calls.push([path, body]);
      if (path === 'allow/review') data = { ...data, tampered: false };
      if (path === 'allow/remove') data = { ...data, rules: [] };
      return data;
    },
  };
  const box = shell.document.createElement('div');
  UI.renderSettings(box, host);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(box.textContent, /changed outside AIB/);
  assert.match(box.textContent, /npm test · in shop-web · runs project code/);
  assert.match(box.textContent, /Safe reads/);
  const review = box.querySelector('.allow-banner').querySelector('button');
  review.onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.doesNotMatch(box.textContent, /changed outside AIB/);
  [...box.querySelectorAll('.allow-rule')].find((r) => r.dataset.rule === 'r1').querySelector('button').onclick();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(box.textContent, /None yet/);
  assert.deepEqual(calls.map((c) => c[0]), ['allow/rules', 'allow/review', 'allow/remove']);
});

test('chat.js card: AIB Always replaces the agent own always (2a), and Yes with the tick answers + saves in one call', async () => {
  const { makePage, flat } = require('./chat_harness.js');
  const sent = [];
  const p = makePage({
    scripts: ['allow-rules-ui.js'],
    routes: {
      '/api/live/allow/answer': (_q, body) => {
        sent.push(body);
        return { body: { ok: true, rules: [{ id: 'r1', label: 'npm test', scope: 'project' }], alsoAllowed: 0 } };
      },
    },
  });
  const options = [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' },
    { optionId: 'always', name: 'Yes, always', kind: 'allow_always' },
    { optionId: 'no', name: 'No', kind: 'reject_once' },
  ];
  const command = { key: 'k1', params: { sessionId: 's', toolCall: { toolCallId: 't', kind: 'execute', title: 'npm test' }, options }, allow: { project: draft(), global: draft(), off: '' } };
  const plan = { key: 'k2', params: { sessionId: 's', toolCall: { toolCallId: 'p', title: 'Plan' }, options: [{ optionId: 'exit-plan-auto', name: 'Yes, and auto-accept', kind: 'allow_always' }] }, allow: { project: draft({ offer: false, hideAgentAlways: false }), global: draft(), off: '' } };
  p.run("current = 'c1'; snapshot = " + JSON.stringify({ permissions: [command, plan] }) + '; renderApprovals()');
  const [card, planCard] = p.element('approvals').children;
  const buttons = (c) => c.children.filter((n) => n.onclick && !n.className).map((n) => n.textContent);
  assert.deepEqual(buttons(card), ['Yes', 'No', 'Cancel request']);
  assert.match(flat(card), /Always allow commands like this/);
  assert.deepEqual(buttons(planCard), ['Yes, and auto-accept', 'Cancel request']);
  assert.doesNotMatch(flat(planCard), /Always allow/);
  const always = card.children.find((n) => String(n.className).includes('allow-always'));
  always.children[0].children[0].checked = true;
  await card.children.find((n) => n.textContent === 'Yes').onclick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ id: 'c1', key: 'k1', option: 'yes', scope: 'project' }]);
});

test('the desktop banner shows while the rules file was changed outside AIB, with Review opening Settings', () => {
  const shell = page();
  const ctx = load(shell, ['allow-rules-ui.js']);
  const opened = [];
  ctx.AgentSettingsUI = { open: (s) => opened.push(s) };
  ctx.AllowRulesUI.banner(true);
  const bar = shell.document.querySelector('main').querySelector('.allow-banner');
  assert.ok(bar && !bar.hidden);
  assert.match(bar.textContent, /changed outside AIB/);
  bar.querySelector('button').onclick();
  assert.deepEqual(opened, ['allow']);
  ctx.AllowRulesUI.banner(false);
  assert.equal(bar.hidden, true);
});

test('chat.js: an auto-allowed request is one "Allowed by rule" line with Stop allowing this', async () => {
  const { makePage, flat } = require('./chat_harness.js');
  const removed = [];
  const p = makePage({
    scripts: ['allow-rules-ui.js'],
    routes: { '/api/live/allow/remove': (_q, body) => (removed.push(body.ruleId), { body: { ok: true } }) },
  });
  const events = [
    { seq: 4, kind: 'permission_auto', time: 1, data: { label: 'npm test', ruleId: 'r9', params: { toolCall: { rawInput: { command: 'npm test' } } } } },
    { seq: 5, kind: 'permission_auto', time: 2, data: { label: 'Safe reads', ruleId: 'builtin:safe-reads', flagged: true, params: { toolCall: { rawInput: { command: 'ls' } } } } },
  ];
  const rows = p.run("liveRows('s', " + JSON.stringify(events) + ", { sessionId: 's' }, true)");
  const auto = Array.from(rows).filter((r) => r.ask === 'auto');
  assert.deepEqual(auto.map((r) => r.value), ['npm test · Allowed by rule · npm test', 'ls · Allowed by rule · Safe reads · Claude asked in bypass']);
  const line = p.run('answeredLine(' + JSON.stringify(auto[0]) + ')');
  assert.match(flat(line), /Allowed by rule · npm test/);
  const stop = line.children.find((n) => n.className === 'answered-rule');
  assert.equal(stop.textContent, 'Stop allowing this');
  await stop.onclick();
  assert.deepEqual(removed, ['r9']);
  const builtin = p.run('answeredLine(' + JSON.stringify(auto[1]) + ')').children.find((n) => n.className === 'answered-rule');
  assert.equal(builtin.textContent, 'Allow rules…');
});
