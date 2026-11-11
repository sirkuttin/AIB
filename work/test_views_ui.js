'use strict';
/* The view switch and Chat in the main pane: chat.js showRows with a view, the switch's keyboard use, and the scroll anchor. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { makePage, byClass, flat } = require('./chat_harness.js');
const fakeDom = require('./fake_dom.js');

const SCRIPTS = ['stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js', 'views-ui.js'];
const user = (value, time) => ({ role: 'user', label: 'You', value, time });
const asst = (value, time) => ({ role: 'assistant', label: 'Assistant', value, time });
const tool = (name, time) => ({ role: 'tool', label: name, value: '{}', time, call: { name, input: {} } });

function chatPage(extraWindow) {
  const page = makePage({ scripts: SCRIPTS, window: extraWindow });
  page.run("selected={provider:'claude',id:'a',key:'a'}");
  return page;
}
const drawn = (page) => flat(page.element('messages'));
const history = (n) => {
  const rows = [];
  for (let i = 0; i < n; i++)
    rows.push(
      user('question ' + i, i * 10 + 1),
      asst('interim ' + i, i * 10 + 2),
      tool('Bash', i * 10 + 3),
      asst('answer ' + i, i * 10 + 4),
    );
  return rows;
};

test('the change signature includes the view: a switch repaints, and Full keeps drawing every row', () => {
  const page = chatPage();
  const box = page.element('messages');
  page.hook.showRows(box, history(2), 'main');
  const full = drawn(page);
  const sigFull = page.run('mainSignature');
  assert.match(full, /interim 0/);
  assert.match(sigFull, /\|full$/);
  page.hook.setView('chat');
  page.hook.showRows(box, history(2), 'main');
  assert.notEqual(page.run('mainSignature'), sigFull);
  assert.match(page.run('mainSignature'), /\|chat\|/);
  const out = drawn(page);
  assert.match(out, /question 0/);
  assert.match(out, /interim 0/, 'Chat keeps the AI messages');
  assert.match(out, /answer 1/);
  assert.match(out, /Show steps \(1 tool call\)/, 'the tool call between two messages is one closed line');
  assert.doesNotMatch(out, /Bash/, 'and its row is not drawn');
  assert.equal(page.run('viewOf()'), 'chat');
  page.hook.setView('full');
  page.hook.showRows(box, history(2), 'main');
  assert.equal(drawn(page), full, 'back to Full: the same list as before');
  /* sub pane: always Full, whatever the main view is */
  page.hook.setView('chat');
  const sub = page.element('submessages');
  page.hook.showRows(sub, history(2), 'sub');
  assert.match(flat(sub), /interim 0/);
  assert.match(page.run('subSignature'), /\|full$/);
});

test('the choice is remembered per chat and carried from New chat to the real chat on first send', () => {
  const page = chatPage();
  page.hook.setView('chat');
  assert.equal(page.run('viewOf()'), 'chat');
  page.run("selected={provider:'claude',id:'b',key:'b'}");
  assert.equal(page.run('viewOf()'), 'full', 'another chat has its own choice');
  page.run("selected={provider:'claude',id:'a',key:'a'}");
  assert.equal(page.run('viewOf()'), 'chat');
  const stored = JSON.parse(page.context.localStorage.getItem('studio-chat-views'));
  assert.equal(stored['claude:a'], 'chat');
  page.run("selected=null;newDraft={provider:'claude'}");
  page.hook.setView('prompts');
  assert.equal(JSON.parse(page.context.localStorage.getItem('studio-chat-views'))['new-chat'], 'prompts');
  page.hook.viewStore.adopt('new-chat', 'claude:c'); // what startNewChat does before opening the real chat
  page.run("newDraft=null;selected={provider:'claude',id:'c',key:'c'}");
  assert.equal(page.run('viewOf()'), 'prompts');
});

test('expanded steps stay open when a new turn arrives (keyed by position: the time of the first row of the run, plus the prompt)', () => {
  const page = chatPage();
  const box = page.element('messages');
  page.hook.setView('chat');
  page.hook.showRows(box, history(2), 'main');
  const toggles = () => byClass(box, 'steps-toggle');
  assert.equal(toggles().length, 2);
  assert.match(toggles()[1].textContent, /^▸ Show steps/);
  toggles()[1].listeners.click();
  assert.match(toggles()[1].textContent, /^▾ Hide steps/);
  assert.match(drawn(page), /interim 1/, 'the steps are drawn in place');
  /* a new turn arrives: the list is rebuilt, and the same prompt is still open */
  page.hook.showRows(box, [...history(2), user('question 2', 99), asst('answer 2', 100)], 'main');
  assert.equal(toggles().length, 2, 'the new turn has no steps (a bare reply)');
  assert.match(toggles()[1].textContent, /^▾ Hide steps/, 'question 1 is still open');
  assert.match(toggles()[0].textContent, /^▸ Show steps/, 'question 0 is still closed');
  /* a turn earlier in the list changes the positions; the key still finds its prompt */
  page.hook.showRows(
    box,
    [user('older', 0), asst('older reply', 0.5), tool('Bash', 0.6), asst('older answer', 0.7), ...history(2)],
    'main',
  );
  const t = toggles();
  assert.equal(t.length, 3);
  assert.match(t[2].textContent, /^▾ Hide steps/);
  assert.match(t[0].textContent, /^▸ Show steps/);
});

test('a switch repaints even while text is selected; ordinary updates still wait', () => {
  let hold = false;
  const page = chatPage({ CopyUI: { holdRender: () => hold, decorate: (c) => c } });
  const box = page.element('messages');
  page.run("current='c1';snapshot={sessionId:'s',busy:false,unknownReceipts:[]};events=[]");
  const live = (kind, data, time) => ({ kind, time, data: { sessionId: 's', ...data } });
  page.run(
    'events=' +
      JSON.stringify([
        live('user', { text: 'hello' }, 1),
        live('update', { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'first reply' } } }, 2),
        live(
          'update',
          {
            update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Run', status: 'completed', kind: 'execute' },
          },
          3,
        ),
        live('update', { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'last reply' } } }, 4),
      ]),
  );
  page.hook.repaintMain();
  assert.match(drawn(page), /first reply/);
  hold = true; // the user is selecting text
  page.run(
    'events=events.concat(' +
      JSON.stringify([
        live('update', { update: { sessionUpdate: 'agent_message_chunk', content: { text: ' more' } } }, 5),
      ]) +
      ')',
  );
  page.hook.repaintMain();
  assert.doesNotMatch(drawn(page), /more/, 'an ordinary update waits for the selection');
  page.hook.setView('chat');
  assert.match(drawn(page), /Show steps/, 'the switch repainted');
  assert.match(drawn(page), /last reply more/, 'and with the newest rows');
});

test('a switch stays at the bottom if you were there', () => {
  const page = chatPage();
  const box = page.element('messages');
  page.hook.showRows(box, history(3), 'main');
  box.scrollHeight = 5000;
  box.scrollTop = 4000;
  page.run("current='c1';snapshot={sessionId:'s',busy:false,unknownReceipts:[]};events=[]");
  page.hook.setView('chat');
  page.hook.showRows(box, history(3), 'main');
  assert.equal(box.scrollTop, 5000);
});

/* ---- the scroll anchor ---- */
const { anchorOf, restoreAnchor } = (() => {
  const shell = fakeDom.page();
  const context = fakeDom.load(shell, SCRIPTS);
  return context.ChatViewsUI;
})();
const el = (pk, top, bottom) => ({ dataset: pk ? { pk } : {}, getBoundingClientRect: () => ({ top, bottom }) });
const boxOf = (...children) => ({ scrollTop: 100, children, getBoundingClientRect: () => ({ top: 0, bottom: 600 }) });

test('scroll anchor: the topmost visible group is found by its prompt and put back where it was', () => {
  /* the prompt of group A is above the view; its steps link is the first thing visible */
  const before = boxOf(el('p:A', -90, -40), el('', -40, 20), el('', 20, 90), el('p:B', 90, 140));
  const a = anchorOf(before);
  assert.deepEqual({ ...a }, { pk: 'p:A', off: 0 }, 'a prompt that is scrolled off anchors at the top of the view');
  /* the other view has a different layout: A's prompt is now 400px down */
  const after = boxOf(el('p:Z', 0, 300), el('p:A', 400, 450), el('', 450, 500));
  assert.equal(restoreAnchor(after, a), true);
  assert.equal(after.scrollTop, 100 + 400, "scrollTop moved so that A's prompt sits at the top");
  /* the prompt itself is the first thing visible, 30px below the top */
  const visible = anchorOf(boxOf(el('p:A', 30, 80), el('', 80, 120)));
  assert.deepEqual({ ...visible }, { pk: 'p:A', off: 30 });
  const moved = boxOf(el('p:A', 230, 280));
  restoreAnchor(moved, visible);
  assert.equal(moved.scrollTop, 100 + 200);
  /* nothing to anchor to */
  assert.equal(anchorOf(boxOf(el('', 0, 50))), null);
  assert.equal(restoreAnchor(boxOf(el('p:Q', 0, 50)), a), false);
});

/* ---- the switch ---- */
function switchPage() {
  const shell = fakeDom.page();
  const context = fakeDom.load(shell, SCRIPTS);
  const host = shell.make('div', 'viewSwitch', shell.body);
  let view = 'full';
  const calls = [];
  const sw = context.ChatViewsUI.mount(host, {
    get: () => view,
    set: (v) => {
      view = v;
      calls.push(v);
    },
    visible: () => true,
  });
  const radios = () => host.querySelectorAll('button').filter((b) => b.getAttribute('role') === 'radio');
  return { shell, host, sw, radios, calls, view: () => view };
}

test('the switch is Full · Chat · Prompts: a radiogroup with labelled radios, roving tabindex and arrow keys', () => {
  const t = switchPage();
  const group = t.host.querySelectorAll('div').find((d) => d.getAttribute('role') === 'radiogroup');
  assert.ok(group, 'radiogroup');
  assert.deepEqual(
    t.radios().map((r) => r.getAttribute('aria-label')),
    ['View: Full', 'View: Chat', 'View: Prompts'],
  );
  assert.deepEqual(
    t.radios().map((r) => r.textContent),
    ['Full', 'Chat', 'Prompts'],
    'no Outcomes',
  );
  assert.deepEqual(
    t.radios().map((r) => r.getAttribute('aria-checked')),
    ['true', 'false', 'false'],
  );
  assert.deepEqual(
    t.radios().map((r) => r.tabIndex),
    [0, -1, -1],
    'only the checked radio is in the tab order',
  );
  const key = (k) => {
    const e = group.dispatch('keydown', { key: k });
    return e.defaultPrevented;
  };
  assert.equal(key('ArrowRight'), true);
  assert.equal(t.view(), 'chat');
  assert.equal(t.shell.document.activeElement, t.radios()[1], 'focus follows the selection and stays on the switch');
  assert.deepEqual(
    t.radios().map((r) => r.tabIndex),
    [-1, 0, -1],
  );
  key('ArrowRight');
  assert.equal(t.view(), 'prompts');
  key('ArrowRight');
  assert.equal(t.view(), 'full', 'wraps around');
  key('ArrowLeft');
  assert.equal(t.view(), 'prompts');
  key('Home');
  assert.equal(t.view(), 'full');
  key('End');
  assert.equal(t.view(), 'prompts');
  t.radios()[1].click();
  assert.equal(t.view(), 'chat');
  assert.equal(t.radios()[1].getAttribute('aria-checked'), 'true');
  /* the narrow-header fallback */
  const select = t.host.querySelectorAll('select')[0];
  assert.deepEqual(
    select.querySelectorAll('option').map((o) => o.value),
    ['full', 'chat', 'prompts'],
  );
  assert.equal(select.getAttribute('aria-label'), 'Chat view');
  select.value = 'prompts';
  select.dispatch('change');
  assert.equal(t.view(), 'prompts');
});

test('a fold with a failed step stands out: a ✗ and "N failed" in the error colour, and it stays folded', () => {
  const failedTool = {
    role: 'tool',
    label: 'Bash',
    value: '{}',
    time: 3,
    call: { name: 'Bash', input: {}, result: { text: 'boom', isError: true } },
  };
  for (const failing of [failedTool, { role: 'error', label: 'Error', value: 'boom', time: 3, callId: 'c1' }]) {
    const page = chatPage();
    page.hook.setView('chat');
    const box = page.element('messages');
    page.hook.showRows(box, [user('go', 1), tool('Read', 2), failing, asst('done', 4)], 'main');
    const toggle = byClass(box, 'steps-toggle')[0];
    assert.match(toggle.className, /has-failed/);
    assert.equal(byClass(toggle, 'sf-x')[0].textContent, '✗ ');
    assert.equal(byClass(toggle, 'sf-failed')[0].textContent, '1 failed');
    assert.match(flat(toggle), /^✗ ▸ Show steps \(2 tool calls, 1 failed\)$/);
    assert.equal(byClass(box, 'group-steps')[0].hidden, true, 'still folded');
    /* a fold with no failure has no mark */
    page.hook.showRows(box, [user('go', 1), tool('Read', 2), asst('done', 4)], 'main');
    assert.doesNotMatch(byClass(box, 'steps-toggle')[0].className, /has-failed/);
  }
  const css = fs.readFileSync(path.join(__dirname, '../outputs/agent-studio/views.css'), 'utf8');
  assert.match(css, /\.sf-failed\s*\{[^}]*var\(--danger-text\)/);
});

test('Chat and Prompts fold a turn\'s steps once: no inner "N steps" group inside "Show steps", live or replayed, across a background-task note', () => {
  const note = user(
    '<task-notification><task-id>b1</task-id><status>completed</status><summary>Build done</summary></task-notification>',
    5,
  );
  /* replayed from a saved transcript: tool rows carry `call`; live: they carry the ACP `raw` tool call */
  const saved = (name, time) => tool(name, time);
  const live = (name, time) => ({
    role: 'tool',
    label: name,
    value: '{}',
    time,
    raw: { toolCallId: 'c' + time, title: name, kind: 'execute', status: 'completed' },
  });
  for (const [how, t] of [
    ['replayed', saved],
    ['live', live],
  ]) {
    const page = chatPage();
    const box = page.element('messages');
    const rows = [
      user('build it', 1),
      asst('Started.', 2),
      t('Bash', 3),
      t('Read', 3.1),
      t('Grep', 3.2),
      note, // dropped from the fold, so the five tool rows sit side by side inside it
      t('Bash', 5.1),
      t('Read', 5.2),
      asst('The build passed.', 6),
    ];
    /* Full: a run of more than 3 tool rows is one "N steps" group (the only fold there); the note is drawn, so leave it out */
    page.hook.showRows(box, rows.filter((r) => r !== note), 'main');
    assert.ok(byClass(box, 'tool-group').length >= 1, how + ': Full keeps its "N steps" group');
    page.hook.setView('chat');
    page.hook.showRows(box, rows, 'main');
    const toggles = byClass(box, 'steps-toggle');
    assert.equal(toggles.length, 1, how + ': one fold');
    assert.match(toggles[0].textContent, /Show steps \(5 tool calls\)/);
    toggles[0].listeners.click();
    assert.match(toggles[0].textContent, /^▾ Hide steps \(5 tool calls\)/);
    const list = byClass(box, 'group-steps')[0];
    assert.equal(list.hidden, false);
    assert.equal(byClass(list, 'tool-group').length, 0, how + ': no second "N steps" fold inside');
    assert.doesNotMatch(flat(list), /5 steps/, how);
    assert.equal(list.children.length, 5, how + ': the five rows are drawn directly');
    /* Prompts: the open prompt is the fold; its rows are drawn directly, no inner "N steps" group */
    page.hook.setView('prompts');
    const plain = rows.filter((r) => r !== note);
    page.hook.showRows(box, plain, 'main');
    const head = byClass(box, 'pv-head')[0];
    assert.ok(head, how + ': the prompt is drawn');
    if (byClass(box, 'pv-body')[0].hidden) head.listeners.click();
    const pbody = byClass(box, 'pv-body')[0];
    assert.equal(pbody.hidden, false, how + ': the prompt is open');
    assert.equal(byClass(pbody, 'tool-group').length, 0, how + ': no "N steps" fold inside the open prompt');
    assert.doesNotMatch(flat(pbody), /\d+ steps/, how);
    assert.equal(pbody.children.length, plain.length - 1, how + ': every reply row is drawn directly');
  }
});
