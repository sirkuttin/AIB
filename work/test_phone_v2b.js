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
