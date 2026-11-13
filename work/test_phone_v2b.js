'use strict';
/* Phone UI v2 part 2 (owner, prototypes round 4), the pure parts:
   - phone.js: the card menu's items (Mark as read / unread on running chats only, Mark handled only on your turn), Archive's two
     choices (End its session needs Send), the Delete confirmation's words, the version menu line, New chat's checks;
   - themes.js: the phone follows the PC's theme in its own light or dark (teal and high contrast switch to their pair, the others
     fall back to AIB teal), its own pick wins;
   - devices-ui.js: "Start new chats" is a child of Send (goes with it, comes back as it was);
   - read-state.js: a phone's "Mark as unread" shows on the PC until the chat is looked at again. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const P = require(path.join(APP, 'phone.js'));
const T = require(path.join(APP, 'themes.js'));
const D = require(path.join(APP, 'devices-ui.js'));

const live = (over) => ({ kind: 'live', title: 'Fix it', chat: { id: 'c1', key: 'claude:s1', state: 'idle', needs: 0, ...over } });

test('card menu: View artifacts, Mark as read / unread (running only), Mark handled (your turn only), Rename, Archive, Delete; nothing else', () => {
  assert.deepEqual(P.menuItems(live({ unread: true })), ['arts', 'read', 'rename', 'archive', 'delete']);
  assert.deepEqual(P.menuItems(live({ unread: false })), ['arts', 'unread', 'rename', 'archive', 'delete']);
  assert.deepEqual(P.menuItems(live({ yourTurn: true })), ['arts', 'unread', 'handled', 'rename', 'archive', 'delete']);
  assert.deepEqual(P.menuItems(live({ yourTurn: true, state: 'working' })), ['arts', 'unread', 'rename', 'archive', 'delete']);
  assert.deepEqual(P.menuItems(live({ yourTurn: true, needs: 1 })), ['arts', 'unread', 'rename', 'archive', 'delete']);
  assert.deepEqual(P.menuItems({ kind: 'saved', title: 'Old', chat: { key: 'claude:s2' } }), ['arts', 'rename', 'archive', 'delete']);
});

test('archive and delete of a running chat: ending its session needs Send; the confirmation says what happens', () => {
  assert.deepEqual(P.archiveChoices(true, { send: true }), ['keep', 'end']);
  assert.deepEqual(P.archiveChoices(true, { send: false }), ['keep']);
  assert.deepEqual(P.archiveChoices(false, { send: true }), []);
  assert.equal(P.deleteBlocked(true, { send: false }), true);
  assert.equal(P.deleteBlocked(true, { send: true }), false);
  assert.equal(P.deleteBlocked(false, { send: false }), false);
  const t = P.deleteText('Fix it', true, 'DESK-PC', { send: true });
  assert.match(t, /Delete “Fix it”\? It leaves AIB’s chat lists on DESK-PC and goes to Recently deleted there, where you can restore it\./);
  assert.match(t, /saved transcript is not touched/);
  assert.match(t, /ends its session first, which drops its queued messages and stops its helpers and terminals/);
  assert.match(t, /own copy of the project with no changes, that copy is removed/);
  assert.doesNotMatch(P.deleteText('Old', false, 'DESK-PC', { send: true }), /ends its session/);
});

test('version menu line: time, what made it, latest', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(P.versionMeta({ n: 3, at: now / 1000 - 300, by: 'Made by the agent', latest: true }, now), '5m ago · Made by the agent · latest');
  assert.equal(P.versionMeta({ n: 1, at: now / 1000 - 7200, by: 'File changed' }, now), '2h ago · File changed');
  assert.equal(P.versionMeta({ n: 1 }, now), '');
});

test('New chat: Start chat needs a project, an agent that can start, and a message; "/" commands and long messages are refused', () => {
  const nc = { project: 'p1', agent: 'claude', agents: [{ id: 'claude', ok: true }, { id: 'kimi', ok: false }] };
  assert.equal(P.newChatReady(nc, 'Fix the bug'), true);
  assert.equal(P.newChatReady({ ...nc, agent: 'kimi' }, 'Fix'), false, 'an agent that cannot start');
  assert.equal(P.newChatReady({ ...nc, project: '' }, 'Fix'), false);
  assert.equal(P.newChatReady(nc, '   '), false);
  assert.equal(P.firstMessageProblem(''), 'Type your first message.');
  assert.match(P.firstMessageProblem('/doc x'), /start with \/ are commands/);
  assert.match(P.firstMessageProblem('x'.repeat(8001)), /at most 8000/);
  assert.equal(P.firstMessageProblem('😀'.repeat(4000)), '', '8000 characters of emoji');
});

test('theme: Follow PC = the PC theme in the phone’s light or dark; teal and high contrast switch to their pair; others fall back to teal; a pick wins', () => {
  assert.equal(T.phoneTheme('teal-dark', 'follow', true), 'teal-light');
  assert.equal(T.phoneTheme('teal-dark', 'follow', false), 'teal-dark');
  assert.equal(T.phoneTheme('hc-light', 'follow', false), 'hc-dark');
  assert.equal(T.phoneTheme('hc-light', 'follow', true), 'hc-light');
  assert.equal(T.phoneTheme('dracula', 'follow', false), 'dracula');
  assert.equal(T.phoneTheme('dracula', 'follow', true), 'teal-light', 'dark only: AIB teal light');
  assert.equal(T.phoneTheme('github-light', 'follow', false), 'teal-dark', 'light only: AIB teal dark');
  assert.equal(T.phoneTheme('system', 'follow', true), 'teal-light');
  assert.equal(T.phoneTheme('classic', 'follow', false), 'dracula', 'renamed themes');
  assert.equal(T.phoneTheme('dracula', 'system', true), 'teal-light', 'Match system');
  assert.equal(T.phoneTheme('teal-dark', 'nord', true), 'nord', 'the phone’s own pick');
  assert.equal(T.phoneTheme(undefined, undefined, false), 'teal-dark');
  for (const t of T.THEMES) if (T.PAIR[t.id]) assert.notEqual(T.THEMES.find((x) => x.id === T.PAIR[t.id]).scheme, t.scheme);
});

test('Settings → Remote control: Start new chats is a child of Send (goes with it, comes back as it was)', () => {
  assert.equal(D.SCOPES.findIndex(([s]) => s === 'phone.start'), D.SCOPES.findIndex(([s]) => s === 'phone.prompt') + 1);
  const all = ['phone.read', 'phone.answer', 'phone.prompt', 'phone.start', 'phone.approve', 'phone.push'];
  assert.deepEqual(D.scopesAfter(all, 'phone.prompt', false), ['phone.read', 'phone.answer', 'phone.approve', 'phone.push']);
  assert.deepEqual(D.scopesAfter(['phone.read'], 'phone.prompt', true, true), ['phone.read', 'phone.prompt', 'phone.start']);
  assert.deepEqual(D.scopesAfter(['phone.read'], 'phone.prompt', true, false), ['phone.read', 'phone.prompt'], 'Start was off: stays off');
  assert.deepEqual(D.scopesAfter(['phone.read', 'phone.prompt', 'phone.start'], 'phone.start', false), ['phone.read', 'phone.prompt']);
  assert.deepEqual(D.scopesAfter(['phone.read'], 'phone.start', true), ['phone.read'], 'never without Send');
});

test('read-state.js: a phone’s "Mark as unread" shows until the chat is looked at again', async () => {
  const store = {};
  const window = {
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] },
    setTimeout: () => 1,
  };
  vm.runInNewContext(fs.readFileSync(path.join(APP, 'read-state.js'), 'utf8'), { window, Object, Array, Number, Math, JSON, isNaN, isFinite, RegExp, Promise, Error });
  const rs = window.AgentReadState;
  let server = { revision: 'r1', chats: { 'claude:a': { seenAt: 1000, markedUnreadAt: 5000 } } };
  rs.init({ get: async () => server, post: async () => ({ revision: 'r2' }) });
  await rs.sync('r1');
  assert.equal(rs.markedUnread('claude:a'), 5000);
  rs.mark('claude:a', 6000);
  assert.equal(rs.markedUnread('claude:a'), 0, 'looked at again');
  server = { revision: 'r3', chats: { 'claude:a': { seenAt: 6000 } } };
  await rs.sync('r3');
  assert.equal(rs.markedUnread('claude:a'), 0);
});

/* ---- the code review's findings (phone-v2-code-review.md), the page parts ---- */
test('review 1: a forgotten start (AIB restarted): the first message went if the chat shows its id, else it goes back in the box', () => {
  const job = { id: 'c9', cmid: 'phone-abc', text: 'Fix it', state: 'opening' };
  const events = [{ seq: 1, kind: 'user', data: { text: 'Fix it', clientMessageId: 'phone-abc' } }];
  assert.equal(P.firstMessageFate(job, events), 'sent');
  assert.equal(P.firstMessageFate(job, [{ seq: 1, kind: 'user', data: { text: 'Fix it', clientMessageId: 'other' } }]), 'restore');
  assert.equal(P.firstMessageFate(job, []), 'restore');
  assert.equal(P.firstMessageFate({ ...job, cmid: '' }, events), 'restore');
  // Send: new/first only for a message the PC holds; a forgotten one goes as a normal message with the same id
  for (const state of ['held', 'failed', 'pc']) assert.deepEqual(P.firstSend({ ...job, state }, 'c9'), { first: true, cmid: 'phone-abc' });
  assert.deepEqual(P.firstSend({ ...job, state: 'gone' }, 'c9'), { first: false, cmid: 'phone-abc' });
  assert.deepEqual(P.firstSend({ ...job, state: 'sent' }, 'c9'), { first: false, cmid: '' });
  assert.deepEqual(P.firstSend({ ...job, state: 'held' }, 'other'), { first: false, cmid: '' });
  assert.deepEqual(P.firstSend(null, 'c9'), { first: false, cmid: '' });
});

test("review 13: New chat sends a model or mode only when you picked one or one is saved, never the agent's own shown as default", () => {
  const list = { choices: [{ value: 'opus' }, { value: 'sonnet' }], default: '', current: 'sonnet' };
  assert.equal(P.pickToSend(list, 'sonnet'), '', 'the agent’s own: no pick');
  assert.equal(P.pickToSend(list, 'opus'), 'opus');
  assert.equal(P.pickToSend({ ...list, default: 'sonnet' }, 'sonnet'), 'sonnet', 'your saved default');
  assert.equal(P.pickToSend(list, 'gpt-9'), '', 'not on the list');
  assert.equal(P.pickToSend(null, 'opus'), '');
  assert.equal(P.pickToSend(list, ''), '');
});

function pcSidebar(server) {
  const listeners = {};
  const document = {
    title: 'AIB',
    visibilityState: 'visible',
    createElement: () => ({ append() {}, setAttribute() {}, classList: { add() {} }, style: {} }),
    addEventListener: (type, fn) => (listeners[type] = listeners[type] || []).push(fn),
  };
  const store = { 'studio-sidebar-epoch': '1' };
  const window = {
    document,
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] },
    setTimeout: () => 1,
    addEventListener: (type, fn) => (listeners['win:' + type] = listeners['win:' + type] || []).push(fn),
  };
  const sandbox = { window, Object, Array, String, Number, Promise, Error, Map, Set, Date, JSON, Math, isNaN, isFinite, RegExp };
  for (const f of ['read-state.js', 'ownership-ui.js', 'status-words.js', 'notify-rules.js', 'sidebar-ui.js'])
    vm.runInNewContext(fs.readFileSync(path.join(APP, f), 'utf8'), sandbox);
  window.AgentReadState.init({ get: async () => server.value, post: async () => ({ revision: 'r9' }) });
  const fire = (type) => (listeners[type] || []).forEach((fn) => fn({}));
  return { rs: window.AgentReadState, ui: window.AgentSidebarUI, document, fire };
}

test('review 4: a phone’s Mark as unread stays while the chat is open in a visible PC window nobody touches; looking or a new message clears it', async () => {
  const marked = Date.now() - 1000;
  const ended = Date.now() - 60000;
  const server = { value: { revision: 'r1', chats: { 'claude:a': { seenAt: ended + 1, markedUnreadAt: marked } } } };
  const pc = pcSidebar(server);
  const chat = (endedAt) => ({
    provider: 'claude',
    id: 'a',
    key: 'k-a',
    cwd: 'C:/x',
    live: { id: 'L', closed: false, busy: false, state: 'ready', attention: { state: 'idle', needs: 0, turnEndedAt: new Date(endedAt).toISOString() } },
  });
  const c = chat(ended);
  pc.ui.init({ aliasKey: (x) => x.provider + ':' + x.id, getSelected: () => c, rerender() {} });
  await pc.rs.sync('r1');
  assert.equal(pc.rs.markedUnread('claude:a'), marked);
  // the open chat, the window "visible" (covered, say): list updates do not undo the mark
  for (let i = 0; i < 3; i++) pc.ui.sync([c], c);
  assert.equal(pc.rs.markedUnread('claude:a'), marked, 'still marked unread');
  assert.equal(pc.ui.statusOf(c).unread, true);
  // a click in the page (you are looking): the next update marks it seen
  pc.fire('pointerdown');
  pc.ui.sync([c], c);
  assert.equal(pc.rs.markedUnread('claude:a'), 0, 'looked at');

  // again, then a new message in the chat (a turn that ended after the mark): seen as usual while it is open
  const pc2 = pcSidebar({ value: { revision: 'r1', chats: { 'claude:a': { seenAt: ended + 1, markedUnreadAt: marked } } } });
  const fresh = chat(Date.now());
  pc2.ui.init({ aliasKey: (x) => x.provider + ':' + x.id, getSelected: () => fresh, rerender() {} });
  await pc2.rs.sync('r1');
  pc2.ui.sync([fresh], fresh);
  assert.equal(pc2.rs.markedUnread('claude:a'), 0, 'a new message');
  // and focus on the window clears it too
  const pc3 = pcSidebar({ value: { revision: 'r1', chats: { 'claude:a': { seenAt: ended + 1, markedUnreadAt: marked } } } });
  pc3.ui.init({ aliasKey: (x) => x.provider + ':' + x.id, getSelected: () => c, rerender() {} });
  await pc3.rs.sync('r1');
  pc3.ui.sync([c], c);
  assert.equal(pc3.rs.markedUnread('claude:a'), marked);
  pc3.fire('win:focus');
  assert.equal(pc3.rs.markedUnread('claude:a'), 0, 'focus');
});
