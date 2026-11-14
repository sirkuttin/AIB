'use strict';
// Smoke test for workspace-ui.js (project rail, tab strip, inbox) in a vm with a minimal fake DOM.
// workspace-state.js (the pure logic) has its own tests; this one checks that the drawing module loads, starts, draws and reacts.
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('./fake_dom.js');

const SCRIPTS = [
  'status-words.js',
  'ownership-ui.js',
  'notify-rules.js',
  'sidebar-ui.js',
  'workspace-state.js',
  'split-tree.js',
  'workspace-ui.js',
];
const conv = (id, cwd, extra = {}) =>
  Object.assign(
    { provider: 'claude', id, key: 'k-' + id, title: 'Title ' + id, cwd, created: 100, modified: 100 },
    extra,
  );
const liveChat = (extra = {}) => Object.assign({ id: 'L1', closed: false, busy: false, state: 'ready' }, extra);

function setup({ store = {}, conversations = [], selected = null, scripts = SCRIPTS } = {}) {
  const shell = D.page({
    store,
    ids: ['wsProjectBtn', 'wsRenameProj', 'wsNewProject', 'activityHead', 'composerHelp', 'new'],
  });
  const ctx = D.load(shell, scripts);
  const calls = { rerender: 0, post: [], get: [], opened: [] };
  const host = {
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title || c.id,
    conversations: () => state.conversations,
    rerender: () => {
      calls.rerender++;
    },
    getJson: async (route) => {
      calls.get.push(route);
      return {};
    },
    postJson: async (name, body) => {
      calls.post.push([name, body]);
      return {};
    },
    open: (key) => {
      calls.opened.push(key);
      return true;
    },
    showStart() {},
    notice() {},
    reload() {},
    quickPrompt() {},
  };
  const state = { conversations };
  const W = ctx.AgentWorkspaceUI;
  W.init(host);
  const sync = (list = state.conversations, sel = selected) => {
    state.conversations = list;
    W.sync(list, sel);
  };
  return { shell, ctx, W, host, calls, sync, state };
}

const inbox = (shell) => shell.body.querySelector('#wsInbox');
const tabLabels = (shell) => shell.byId.chatTabs.querySelectorAll('.ws-tab').map((t) => t.textContent);

test('the module loads, exports its API and starts without any chats', () => {
  const t = setup();
  assert.equal(typeof t.W.init, 'function');
  assert.equal(typeof t.W.sync, 'function');
  assert.equal(t.W.hasWorkspace(), true, 'init ran');
  assert.equal(t.W.activeProject(), null, 'no project yet');
  t.sync([]);
  assert.deepEqual(t.W._items(), []);
  assert.ok(t.shell.byId.chatTabs.querySelector('.ws-tab-new'), 'the + button is always drawn');
  assert.ok(t.shell.byId.chatTabs.querySelector('.ws-inbox-btn'), 'the inbox envelope is always drawn');
});

test('chats are grouped into projects by their folder, and the selected chat opens as a tab in its project', () => {
  const list = [conv('a1', 'C:/work/alpha'), conv('a2', 'C:/work/alpha'), conv('b1', 'C:/work/beta')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  const items = t.W._items();
  assert.equal(items.length, 3);
  assert.deepEqual(Array.from(new Set(items.map((i) => i.projectName))).sort(), ['alpha', 'beta']);
  assert.ok(
    items.every((i) => i.projectKey.startsWith('w:c:/work/')),
    'project keys come from the folder path',
  );
  t.W.selectProject(items[0].projectKey);
  assert.equal(t.W.activeProject().key, items[0].projectKey);
  assert.ok(t.calls.opened.length <= 1, 'picking a project opens at most its last chat');
  assert.deepEqual(tabLabels(t.shell).length, 1, 'only the opened chat has a tab');
  assert.match(tabLabels(t.shell)[0], /Title a1/);
  t.sync(list, list[1]);
  assert.equal(tabLabels(t.shell).length, 2, 'opening a second chat of the project adds a tab');
});

test('project tabs, keys and colours follow projectRoot, not cwd', () => {
  const list = [
    conv('a1', 'C:/work/alpha/wt/one', { projectRoot: 'C:/work/alpha' }),
    conv('a2', 'C:/work/alpha/wt/two', { projectRoot: 'C:/work/alpha' }),
    conv('b1', 'C:/work/beta'),
  ];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  const items = t.W._items();
  const alpha = items.filter((i) => i.projectName === 'alpha');
  assert.equal(alpha.length, 2, 'both worktree chats are in the alpha project');
  assert.equal(new Set(alpha.map((i) => i.projectKey)).size, 1);
  assert.equal(alpha[0].projectKey, 'w:c:/work/alpha');
  assert.equal(alpha[0].projectPath, 'C:/work/alpha');
  assert.equal(items.find((i) => i.projectName === 'beta').projectKey, 'w:c:/work/beta', 'no projectRoot: cwd');
  const St = t.ctx.AgentWorkspaceState;
  assert.equal(St.autoColorId(alpha[0].projectKey), St.autoColorId('w:c:/work/alpha'), 'colour is keyed by the root');
  t.sync(list, list[1]);
  assert.equal(tabLabels(t.shell).length, 2, 'both worktree chats are tabs of the one project');
});

test('titles and paths are drawn as text, never as HTML', () => {
  const evil = conv('x1', 'C:/work/<img src=x onerror=1>', { title: '<script>alert(1)</script>' });
  const t = setup({ conversations: [evil] });
  assert.doesNotThrow(() => t.sync([evil], evil), 'a fake DOM that throws on innerHTML would catch any use');
  assert.match(tabLabels(t.shell).join(' '), /<script>alert\(1\)<\/script>/);
});

test('the layout is saved to localStorage, and a new page restores the open tabs', () => {
  const list = [conv('a1', 'C:/work/alpha'), conv('a2', 'C:/work/alpha')];
  const first = setup({ conversations: list });
  first.sync(list, list[0]);
  first.sync(list, list[1]);
  const saved = first.shell.localStorage.getItem('studio-workspace-v1');
  assert.ok(saved, 'workspace state is written');
  const second = setup({ store: { 'studio-workspace-v1': saved }, conversations: list });
  second.sync(list, null);
  assert.equal(tabLabels(second.shell).length, 2, 'both tabs come back without selecting anything');
});

test('a corrupt saved workspace is ignored, not fatal', () => {
  const list = [conv('a1', 'C:/work/alpha')];
  const t = setup({
    store: { 'studio-workspace-v1': '{nope', 'studio-pending-projects-v1': '[[[' },
    conversations: list,
  });
  assert.doesNotThrow(() => t.sync(list, list[0]));
  assert.equal(tabLabels(t.shell).length, 1);
});

test('closing a tab removes it from the strip', () => {
  const list = [conv('a1', 'C:/work/alpha'), conv('a2', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  t.sync(list, list[1]);
  const key = t.W._items()[0].key;
  t.W.closeTab(key);
  t.sync(list, list[1]);
  assert.equal(tabLabels(t.shell).length, 1);
});

test('a chat that needs you shows in the inbox, and the inbox opens and closes', () => {
  const asking = conv('a1', 'C:/work/alpha', {
    live: liveChat({ elicitations: [{ id: 'q', params: { message: 'Pick one' } }] }),
    attention: { state: 'needs_you', needs: 1, endedAt: 0 },
  });
  const list = [asking, conv('a2', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[1]);
  assert.equal(t.W._items().filter((i) => i.needs > 0).length, 1);
  assert.equal(inbox(t.shell).hidden, true);
  t.W.toggleInbox(true);
  assert.equal(inbox(t.shell).hidden, false);
  assert.match(inbox(t.shell).textContent, /Title a1/);
  t.W.toggleInbox(false);
  assert.equal(inbox(t.shell).hidden, true);
});

test('Escape closes the inbox', () => {
  const list = [conv('a1', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  t.W.toggleInbox(true);
  t.shell.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(inbox(t.shell).hidden, true);
});

test('syncing the same list twice does not redraw the strip', () => {
  const list = [conv('a1', 'C:/work/alpha')];
  const t = setup({ conversations: list });
  t.sync(list, list[0]);
  const strip = t.shell.byId.chatTabs.children.slice();
  t.sync(list, list[0]);
  assert.deepEqual(t.shell.byId.chatTabs.children, strip, 'an unchanged signature leaves the DOM alone');
});

test('a shown chat the list no longer has keeps its tab: never "No open chats" over an open chat (QA 4)', () => {
  const fresh = conv('n1', 'C:/work/alpha', { title: 'New conversation', live: liveChat() });
  const t = setup({ conversations: [fresh] });
  t.sync([fresh], fresh);
  assert.equal(tabLabels(t.shell).length, 1);
  // Its session was ended; the agent does not list it (yet), but the page still shows it.
  const ended = Object.assign({}, fresh, { live: null });
  t.sync([], ended);
  assert.equal(tabLabels(t.shell).length, 1, 'the tab stays while the chat is shown');
  assert.match(tabLabels(t.shell)[0], /New conversation/);
  assert.doesNotMatch(t.shell.byId.chatTabs.textContent, /No open chats/);
  t.sync([], null); // another view: the phantom tab goes
  assert.equal(tabLabels(t.shell).length, 0);
});

test('the chat you have open is never Finished, even while AIB is in the background; Finished chats get a dot, never a count', () => {
  const open = conv('o', 'C:/p', { yourTurn: true, yourTurnAt: 50, live: liveChat({ attention: { state: 'idle' } }) }),
    other = conv('x', 'C:/p', { yourTurn: true, yourTurnAt: 60, live: liveChat({ id: 'L2', attention: { state: 'idle' } }) }),
    asks = conv('q', 'C:/p', { live: liveChat({ id: 'L3', attention: { state: 'idle', asksAt: '2026-11-13T10:00:00.000Z' } }) });
  const t = setup({ conversations: [open], selected: open });
  t.shell.document.visibilityState = 'hidden'; // AIB in the background: before the fix the open chat counted here
  t.sync([open], open);
  const env = () => t.shell.byId.chatTabs.querySelector('.ws-inbox-btn');
  const counted = () => /(^| )has( |$)/.test(env().className);
  const dotted = () => /(^| )done( |$)/.test(env().className);
  assert.equal(counted(), false, 'no count for the chat you are on');
  assert.equal(dotted(), false, 'and it is not Finished either');
  // another chat finished: listed under Finished, a small dot, no number
  t.sync([open, other], open);
  assert.equal(counted(), false);
  assert.equal(dotted(), true);
  assert.equal(env().querySelector('.ws-badge'), null);
  // a chat whose reply asks you something counts
  t.sync([open, other, asks], open);
  assert.equal(counted(), true);
  assert.equal(env().querySelector('.ws-badge').textContent, '1');
});

test('the inbox (v3): "Needs you" and "To review" headers alike; line 1 the request, line 2 title · project, the wait alone', () => {
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const live = (id, attention) => liveChat({ id, attention });
  const failed = conv('f1', 'C:/work/alpha', {
    live: live('L1', { state: 'idle', failedAt: ago(20), error: 'Usage limit reached. Resets at 16:00.', failKind: 'limit' }),
  });
  const asks = conv('q1', 'C:/work/beta', {
    live: live('L2', { state: 'idle', asksAt: ago(2), question: 'Should I start the review now?', helpers: 2 }),
  });
  const done = conv('d1', 'C:/work/beta', { yourTurn: true, yourTurnAt: Date.now() / 1000 - 60, live: live('L3', { state: 'idle' }) });
  const helping = conv('h1', 'C:/work/gamma', {
    yourTurn: true,
    yourTurnAt: Date.now() / 1000 - 30,
    live: live('L4', { state: 'idle', helpers: 3 }),
  });
  const here = conv('o', 'C:/work/gamma', { live: live('L5', { state: 'idle' }) });
  const list = [failed, asks, done, helping, here];
  const t = setup({ conversations: list, selected: here, scripts: ['inbox-rules.js', 'inbox-reply.js', ...SCRIPTS] });
  t.sync(list, here);
  const env = t.shell.byId.chatTabs.querySelector('.ws-inbox-btn');
  assert.equal(env.querySelector('.ws-badge').textContent, '2', 'the failed chat and the question; never the finished one');
  t.W.toggleInbox(true);
  const pop = inbox(t.shell);
  assert.equal(pop.querySelector('.ws-pop-head'), null, 'no title line of its own: the badge holds the count');
  const heads = pop.querySelectorAll('.ws-inbox-section').map((h) => h.textContent);
  assert.deepEqual(heads, ['Needs you', 'To review'], 'two headers, styled alike, no counts or notes');
  assert.equal(t.ctx.AgentInboxRules.REVIEW_LABEL, 'To review', 'the second name is one constant');
  const rows = pop.querySelectorAll('.ws-inbox-item');
  assert.deepEqual(
    rows.map((r) => r.dataset.key),
    ['claude:f1', 'claude:q1', 'claude:d1'],
    'the longest wait first; the chat with helpers still running is working, not listed',
  );
  const what = (r) => r.querySelector('.ws-inbox-what').textContent;
  assert.equal(what(rows[0]), 'Usage limit reached. Resets at 16:00.', 'line 1 is the error itself');
  assert.equal(what(rows[1]), 'Should I start the review now?', 'line 1 is the question itself');
  assert.equal(rows[0].querySelector('.ws-inbox-where').textContent, 'Title f1 \u00b7 alpha', 'line 2: chat title · project');
  assert.equal(pop.querySelector('.ws-inbox-reason'), null, 'no reason words');
  assert.equal(pop.querySelector('.ws-inbox-agent'), null, 'no agent or model name');
  assert.equal(pop.querySelector('.ws-inbox-helpers'), null, 'no "N subagents running"');
  assert.doesNotMatch(pop.textContent, /subagent|waited|Claude Code|Finished|Your turn|Open chat/);
  const age = (r) => r.querySelector('.ws-inbox-age');
  assert.equal(age(rows[0]).textContent, '20m', 'the wait alone');
  assert.ok(age(rows[0]).classList.contains('long'), 'orange after 15 minutes');
  assert.equal(age(rows[1]).textContent, '2m');
  assert.ok(!age(rows[1]).classList.contains('long'));
  // the 6 px inline dot only on Failed and To review rows; no dot column
  assert.ok(rows[0].querySelector('.ws-inbox-idot.fail'));
  assert.equal(rows[1].querySelector('.ws-inbox-idot'), null);
  assert.ok(rows[2].querySelector('.ws-inbox-idot.done'));
  assert.equal(pop.querySelector('.ws-inbox-row .d'), null);
  // the foot: the Working line (no subagent count) and the settings link share one line; no key-hint row
  const foot = pop.querySelector('.ws-inbox-foot');
  assert.equal(foot.querySelector('.ws-inbox-working').textContent, 'Working: 1 chat');
  assert.equal(pop.querySelector('.ws-inbox-keys'), null, 'no visible keyboard hints');
});

test('the inbox with nothing blocked: the Needs you header stays with one quiet "Nothing blocked" line', () => {
  const helping = conv('h1', 'C:/work/gamma', { live: liveChat({ id: 'L4', attention: { state: 'idle', helpers: 1 } }) });
  const t = setup({ conversations: [helping], scripts: ['inbox-rules.js', ...SCRIPTS] });
  t.sync([helping], null);
  t.W.toggleInbox(true);
  const pop = inbox(t.shell);
  assert.deepEqual(pop.querySelectorAll('.ws-inbox-section').map((h) => h.textContent), ['Needs you']);
  assert.equal(pop.querySelector('.ws-inbox-none').textContent, 'Nothing blocked');
  assert.equal(pop.querySelector('.ws-pop-empty'), null, 'no big empty block');
  assert.doesNotMatch(pop.textContent, /Four score|Nothing needs you/);
  assert.equal(pop.querySelector('.ws-inbox-working').textContent, 'Working: 1 chat');
  assert.equal(t.shell.byId.chatTabs.querySelector('.ws-inbox-btn .ws-badge'), null);
});

test('a Failed row: Retry / Reply / Mark handled on one row; Retry sends your last message again; no hand-over on the row', async () => {
  const failed = conv('f1', 'C:/work/alpha', {
    live: liveChat({ id: 'L1', attention: { state: 'idle', failedAt: new Date().toISOString(), error: 'Usage limit reached.' } }),
  });
  const asks = conv('q1', 'C:/work/alpha', {
    live: liveChat({ id: 'L2', attention: { state: 'idle', asksAt: new Date().toISOString(), question: 'Which one?' } }),
  });
  // with the inbox's quick actions (inbox-reply.js), as chat.html loads them
  const t = setup({ conversations: [failed, asks], scripts: ['inbox-reply.js', ...SCRIPTS] });
  const retried = [],
    notes = [];
  t.host.retryLast = async (c) => (retried.push(c.id), { queued: false, attachments: true });
  t.host.handoff = () => assert.fail('the hand-over is not on the row any more');
  t.host.notice = (m) => notes.push(m);
  t.sync([failed, asks], null);
  t.W.toggleInbox(true);
  const row = (key) => inbox(t.shell).querySelectorAll('.ws-inbox-item').find((r) => r.dataset.key === key);
  const labels = (r) => r.querySelectorAll('.ws-qa').map((b) => b.textContent);
  assert.deepEqual(labels(row('claude:f1')), ['Retry', 'Reply', 'Mark handled']);
  assert.equal(row('claude:f1').querySelectorAll('.ws-inbox-acts').length, 1, 'one action row');
  assert.ok(row('claude:f1').querySelector('.ws-qa-retry').classList.contains('def'), 'Retry is the teal-outlined default');
  assert.ok(row('claude:f1').querySelector('.ws-inbox-handled').classList.contains('ws-qa-quiet'), 'Mark handled is quiet text');
  assert.deepEqual(labels(row('claude:q1')), ['Reply', 'Mark handled'], 'a question in the reply: Reply, Mark handled');
  const ev = { stopPropagation() {} };
  row('claude:f1').querySelector('.ws-qa-retry').onclick(ev);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(retried, ['f1']);
  assert.deepEqual(notes, ['Sent your last message again, without its attachments.'], 'attachments are not resent, and it says so');
  // a failed Retry says why on the row
  t.host.retryLast = async () => {
    throw Error('There is no message of yours to send again.');
  };
  t.W.toggleInbox(true);
  row('claude:f1').querySelector('.ws-qa-retry').onclick(ev);
  await new Promise((r) => setTimeout(r, 0));
  assert.match(row('claude:f1').querySelector('.ws-inbox-err').textContent, /no message of yours/);
});

test('a To review row: Reply and a plain × that marks it read (E too); no Open chat; clicking the card opens the chat', async () => {
  const done = conv('d1', 'C:/work/beta', { yourTurn: true, yourTurnAt: Date.now() / 1000 - 60, live: liveChat({ id: 'L3', attention: { state: 'idle' } }) });
  const t = setup({ conversations: [done], scripts: ['inbox-reply.js', ...SCRIPTS] });
  const marked = [];
  t.ctx.AgentOrganizeUI = { markHandled: async (c) => marked.push(c.id) };
  t.sync([done], null);
  t.W.toggleInbox(true);
  const row = () => inbox(t.shell).querySelector('.ws-inbox-item');
  const labels = row()
    .querySelectorAll('.ws-qa')
    .map((b) => b.textContent);
  assert.deepEqual(labels, ['Reply', '\u00d7']);
  const x = row().querySelector('.ws-qa-read');
  assert.equal(x.title, 'Mark as read (E)');
  assert.doesNotMatch(inbox(t.shell).textContent, /Open chat/);
  x.onclick({ stopPropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(marked, ['d1'], '× marks it read');
  // E on the focused row does the same
  t.W.toggleInbox(true);
  row().querySelector('.ws-inbox-row').focus();
  inbox(t.shell).dispatch('keydown', { key: 'e', target: row().querySelector('.ws-inbox-row') });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(marked, ['d1', 'd1'], 'E marks it read');
  // clicking the card (not a control) opens that chat
  t.W.toggleInbox(true);
  row().onclick({ target: row() });
  assert.deepEqual(t.calls.opened.map((c) => c.id), ['d1']);
});

test('approvals: neutral buttons with a teal-outlined default; risky commands show Review first, then the full command and Allow / Deny', async () => {
  const opts = [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'no', name: 'Deny', kind: 'reject_once' },
  ];
  const req = (cmd) => ({ key: 'p1', params: { toolCall: { title: 'Bash', kind: 'execute', rawInput: { command: cmd } }, options: opts } });
  const needs = (id, live) => conv(id, 'C:/work/alpha', { live: liveChat(Object.assign({ id: live, attention: { state: 'needs_you', needs: 1 } })) });
  const safe = needs('a1', 'L1'),
    risky = needs('a2', 'L2'),
    long = needs('a3', 'L3');
  const bodies = {
    L1: req('npm install stripe@18.0.0'),
    L2: req('git push --force origin fix/vat'),
    L3: req('npx playwright test tests/checkout.spec.ts --project=chromium --retries=2'),
  };
  const t = setup({ conversations: [safe, risky, long], scripts: ['inbox-reply.js', ...SCRIPTS] });
  t.host.getJson = async (route, q) => ({ permissions: [bodies[q.id]] });
  t.sync([safe, risky, long], null);
  t.W.toggleInbox(true);
  await new Promise((r) => setTimeout(r, 0));
  const row = (key) => inbox(t.shell).querySelectorAll('.ws-inbox-item').find((r) => r.dataset.key === key);
  const labels = (r) => r.querySelectorAll('.ws-qa').map((b) => b.textContent);
  // a plain command: line 1 is the command; Allow / Always allow / Deny, Allow outlined; no green or red classes
  assert.equal(row('claude:a1').querySelector('.ws-inbox-what').textContent, 'Run npm install stripe@18.0.0');
  assert.equal(row('claude:a1').querySelector('.ws-inbox-what').querySelector('code').textContent, 'npm install stripe@18.0.0');
  assert.deepEqual(labels(row('claude:a1')), ['Allow', 'Always allow', 'Deny']);
  assert.deepEqual(
    row('claude:a1')
      .querySelectorAll('.ws-qa')
      .map((b) => b.classList.contains('def')),
    [true, false, false],
  );
  assert.equal(inbox(t.shell).querySelector('.ws-qa-choice.ok, .ws-qa-choice.no'), null, 'no green or red buttons');
  // risky: Review / Deny; Review opens the full command and what it does, then Allow / Deny, never Always allow
  assert.deepEqual(labels(row('claude:a2')), ['Review', 'Deny']);
  row('claude:a2').querySelector('.ws-qa-review').onclick({ stopPropagation() {} });
  const detail = row('claude:a2').querySelector('.ws-inbox-detail');
  assert.match(detail.textContent, /^\$ git push --force origin fix\/vat\nForce push/);
  assert.deepEqual(labels(row('claude:a2')), ['Allow', 'Deny']);
  // a long command: "Full command" as quiet text at the end of the one row
  const full = row('claude:a3').querySelector('.ws-qa-full');
  assert.equal(full.textContent, 'Full command');
  assert.ok(full.classList.contains('ws-qa-quiet'));
  full.onclick({ stopPropagation() {} });
  assert.match(row('claude:a3').querySelector('.ws-inbox-detail').textContent, /--retries=2/);
  assert.equal(row('claude:a3').querySelector('.ws-qa-full').textContent, 'Hide command');
});

