'use strict';
/* Condensed views, stage 5: split-pane mirrors draw their own chat's view (the view is in paintMirror's signature and in
   mirrorShouldReset), the subagent pane stays Full, and Settings > Default chat view decides what new chats start in. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { makePage, byClass, flat } = require('./chat_harness.js');
const fakeDom = require('./fake_dom.js');

const SCRIPTS = ['stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js', 'views-ui.js'];
const user = (value, time) => ({ role: 'user', label: 'You', value, time });
const asst = (value, time) => ({ role: 'assistant', label: 'Assistant', value, time });
const tool = (name, time) => ({
  role: 'tool',
  label: name,
  value: '{}',
  time,
  call: { name, input: { command: 'ls -la' } },
});
const rows = () => [
  user('question 0', 1),
  asst('interim 0', 2),
  tool('Bash', 3),
  asst('answer 0', 4),
  user('question 1', 5),
  asst('answer 1', 6),
];

function mirrorPage(settings) {
  const page = makePage({ scripts: SCRIPTS, window: settings ? { AgentSettingsUI: settings } : {} });
  const box = page.element('mirror1');
  box.dataset.mirror = 'claude:a';
  page.run("conversations=[{key:'a',provider:'claude',id:'a'}]");
  return { page, box };
}

test('mirrorShouldReset: another view resets the pane', () => {
  const { StreamUI } = makePage({ scripts: SCRIPTS }).context.window;
  const prev = { total: 6, thinking: false, hist: null, histStart: 0, key: 'claude:a', view: 'full' };
  assert.equal(StreamUI.mirrorShouldReset(prev, { ...prev }), false);
  for (const view of ['chat', 'prompts']) assert.equal(StreamUI.mirrorShouldReset(prev, { ...prev, view }), true, view);
});

test("a split pane draws its chat's view, with the view in its signature, and resets when the view is switched", () => {
  const { page, box } = mirrorPage();
  page.hook.paintMirror(box, rows());
  assert.match(box._sig, /\|full\|/, 'the view is part of the signature');
  assert.match(flat(box), /interim 0/);
  assert.match(flat(box), /ls -la/);
  const full = box._sig;
  const first = box._mirrorWin;
  first.extra = 160; // the reader had grown the window
  page.hook.viewStore.set('claude:a', 'chat');
  page.hook.paintMirror(box, rows());
  assert.notEqual(box._sig, full);
  assert.match(box._sig, /\|chat\|/);
  assert.notEqual(box._mirrorWin, first, 'the pane was reset by the switch');
  assert.equal(box._mirrorWin.extra, 0);
  assert.equal(box._mirrorWin.view, 'chat');
  assert.match(flat(box), /interim 0/, 'Chat keeps the AI messages');
  assert.match(flat(box), /Show steps \(1 tool call\)/, 'and folds the tool call between them');
  assert.doesNotMatch(flat(box), /ls -la/);
  assert.match(flat(box), /answer 1/);
  /* the same view again: nothing is drawn again */
  const nodes = box.children;
  page.hook.paintMirror(box, rows());
  assert.equal(box.children, nodes);
  /* Prompts */
  page.hook.viewStore.set('claude:a', 'prompts');
  page.hook.paintMirror(box, rows());
  assert.match(box._sig, /\|prompts\|/);
  assert.equal(byClass(box, 'pv-item').length, 2);
  assert.doesNotMatch(flat(box), /answer/);
  /* back to Full: exactly as before */
  page.hook.viewStore.set('claude:a', 'full');
  page.hook.paintMirror(box, rows());
  assert.match(flat(box), /ls -la/);
});

test('each pane keeps the view of its own chat', () => {
  const { page, box } = mirrorPage();
  const other = page.element('mirror2');
  other.dataset.mirror = 'claude:b';
  page.run("conversations=[{key:'a',provider:'claude',id:'a'},{key:'b',provider:'claude',id:'b'}]");
  page.hook.viewStore.set('claude:a', 'chat');
  page.hook.paintMirror(box, rows());
  page.hook.paintMirror(other, rows());
  assert.match(box._sig, /\|chat\|/);
  assert.match(other._sig, /\|full\|/);
});

test('the live line shows in a split pane for a working chat, and its clock is not in the signature', () => {
  const { page, box } = mirrorPage();
  page.run("conversations=[{key:'a',provider:'claude',id:'a',live:{id:'c1',busy:true}}]");
  const since = Date.now() / 1000 - 30;
  const ev = (kind, data, time) => ({ kind, time, data: { sessionId: 's', ...data } });
  const m = page.hook.mirrorState;
  m.set('claude:a', {
    id: 'c1',
    sid: 's',
    cursor: 0,
    rows: null,
    events: [
      ev('user', { text: 'go' }, since),
      ev(
        'update',
        {
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 't',
            title: 'Bash',
            kind: 'execute',
            status: 'in_progress',
            rawInput: { command: 'npm test' },
          },
        },
        since + 1,
      ),
    ],
  });
  page.hook.viewStore.set('claude:a', 'chat');
  page.hook.paintMirror(box, [user('go', since)]);
  assert.equal(byClass(box, 'view-live').length, 1);
  assert.match(byClass(box, 'vl-meta')[0].textContent, /^step 1 · 0:3[0-2]$/);
  assert.match(box._sig, /\|chat\|1\|/, 'working is in the signature, the clock is not');
  const sig = box._sig;
  page.document.querySelectorAll = () => byClass(box, 'view-live');
  page.context.window.ChatViewsUI.tickLive(Date.now() + 20000);
  assert.match(byClass(box, 'vl-meta')[0].textContent, /^step 1 · 0:5[0-2]$/);
  page.hook.paintMirror(box, [user('go', since)]);
  assert.equal(box._sig, sig);
});

test('#submessages (the subagent pane) stays Full whatever the chat view is', () => {
  const page = makePage({ scripts: SCRIPTS });
  page.run("selected={provider:'claude',id:'a',key:'a'}");
  for (const view of ['chat', 'prompts']) {
    page.hook.setView(view);
    const sub = page.element('submessages');
    page.hook.showRows(sub, [...rows(), user('another ' + view, 9)], 'sub');
    assert.match(flat(sub), /interim 0/, view);
    assert.match(flat(sub), /ls -la/, view);
    assert.match(page.run('subSignature'), /\|full$/, view);
  }
});

/* ---- Settings > Default chat view ---- */
test('a new chat, and a chat with no saved view, start in the Settings default; a chat you switched keeps its own', () => {
  let dflt = 'chat';
  const page = makePage({
    scripts: SCRIPTS,
    window: { AgentSettingsUI: { init() {}, sync() {}, load: async () => {}, defaultView: () => dflt } },
  });
  page.run("selected=null;newDraft={provider:'claude'}");
  assert.equal(page.run('viewOf()'), 'chat', 'a new chat');
  page.run("newDraft=null;selected={provider:'claude',id:'a',key:'a'}");
  assert.equal(page.run('viewOf()'), 'chat', 'a chat with no saved view');
  page.hook.setView('prompts');
  dflt = 'full';
  assert.equal(page.run('viewOf()'), 'prompts', 'its own choice wins');
  page.run("selected={provider:'claude',id:'b',key:'b'}");
  assert.equal(page.run('viewOf()'), 'full', 'another chat follows the new default');
  dflt = 'prompts'; // never possible from the server; the page refuses it too
  assert.equal(page.run('viewOf()'), 'full');
  dflt = 'outcomes'; // the removed view
  assert.equal(page.run('viewOf()'), 'full');
  dflt = undefined;
  assert.equal(page.run('viewOf()'), 'full');
});

test('Settings > Appearance offers two radios, Full and Chat, with a note that Prompts is not offered; a pick is saved as appearance.defaultView', async () => {
  const shell = fakeDom.page();
  const context = fakeDom.load(shell, ['settings-ui.js']);
  const S = context.AgentSettingsUI;
  assert.deepEqual([...S.DEFAULT_VIEWS.map((v) => v[0])], ['full', 'chat']);
  assert.ok(
    S.INDEX.some((e) => e.id === 'default-view' && e.section === 'appearance' && e.label === 'Default chat view'),
  );
  const saved = [];
  S._state.host = {
    post: async (name, patch) => (
      saved.push([name, patch]),
      { agents: [], settings: { appearance: patch.appearance } }
    ),
    get: async () => ({}),
  };
  S._state.data = { settings: { appearance: { defaultView: 'chat' } } };
  assert.equal(S.defaultView(), 'chat');
  const box = shell.make('div', 'box', shell.body);
  S.renderDefaultView(box);
  const radios = box.querySelectorAll('input').filter((i) => i.type === 'radio');
  assert.deepEqual(
    radios.map((r) => r.value),
    ['full', 'chat'],
  );
  assert.deepEqual(
    radios.map((r) => r.checked),
    [false, true],
  );
  assert.match(flat(box), /Full · everything, as today/);
  assert.match(flat(box), /Chat · your prompts and the AI's messages/);
  assert.match(flat(box), /"Prompts" isn't offered here/);
  radios[0].checked = true;
  radios[0].dispatch('change');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.stringify(saved), JSON.stringify([['settings', { appearance: { defaultView: 'full' } }]]));
  S._state.data = { settings: { appearance: { defaultView: 'prompts' } } };
  assert.equal(S.defaultView(), 'full', 'an unknown value reads as Full');
});
