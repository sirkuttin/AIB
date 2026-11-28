// The left list's manual order (drag to reorder), the page's pure part: a stored rank sorts each section (Pinned, Chats, On hold), a
// chat never placed by hand (a new one) goes first, ranks of other sections do not mix, helpers are left to the host's nesting, and
// the phone's list follows the same ranks. The drag itself (pointer, line, Esc, Alt+Up/Down) is in left_list_order_e2e_test.ts.
const { PAGE: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

function load(entries) {
  const document = {
    getElementById: () => null,
    addEventListener: () => {},
    createElement: () => ({}),
  };
  const window = { document, localStorage: { getItem: () => null, setItem: () => {} } };
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'organize-ui.js'), 'utf8'), {
    window,
    Object, Array, String, Number, Promise, Error, Map, Date, JSON, Math, isNaN,
  });
  const ui = window.AgentOrganizeUI;
  ui.init({
    get: async () => ({ revision: 'r1', entries, warning: '' }),
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.id,
    conversations: () => [],
    listedParent: () => null,
  });
  return ui;
}
const chat = (id) => ({ provider: 'claude', id });
const ids = (list) => Array.from(list, (c) => c.id);

test('partition: a stored rank orders each section; unplaced chats come first, in the incoming order', async () => {
  const ui = load({
    'claude:a': { rank: 3 },
    'claude:b': { rank: 1 },
    'claude:c': { rank: 2 },
    'claude:p1': { pinnedAt: 10, rank: 2 },
    'claude:p2': { pinnedAt: 20, rank: 1 },
    'claude:p3': { pinnedAt: 30 },
  });
  await ui.sync('');
  const view = ui.partition(['new1', 'a', 'b', 'c', 'new2', 'p1', 'p2', 'p3'].map(chat));
  assert.deepEqual(ids(view.main), ['new1', 'new2', 'b', 'c', 'a'], 'new chats first, then by rank');
  assert.deepEqual(ids(view.pinned), ['p3', 'p2', 'p1'], 'Pinned has its own ranks; an unplaced pin goes first');
});

test('partition: no rank anywhere keeps the incoming order and the pin order (nothing changes for an owner who never dragged)', async () => {
  const ui = load({ 'claude:p1': { pinnedAt: 10 }, 'claude:p2': { pinnedAt: 20 } });
  await ui.sync('');
  const view = ui.partition(['x', 'y', 'z', 'p1', 'p2'].map(chat));
  assert.deepEqual(ids(view.main), ['x', 'y', 'z']);
  assert.deepEqual(ids(view.pinned), ['p2', 'p1']);
});

test('partition: activity does not move a ranked chat (the order only follows the stored rank)', async () => {
  const ui = load({ 'claude:a': { rank: 1 }, 'claude:b': { rank: 2 } });
  await ui.sync('');
  const busy = { ...chat('b'), live: { busy: true }, modified: 999 };
  assert.deepEqual(ids(ui.partition([busy, chat('a')]).main), ['a', 'b']);
  assert.deepEqual(ids(ui.partition([chat('a'), busy]).main), ['a', 'b']);
});

test('phone list: the PC rank orders the home list (nothing re-sorts by activity), a never-placed chat is first, helpers follow their main chat by rank', () => {
  const P = require(path.join(APP_DIR, 'phone.js'));
  const live = (id, changedAt, extra) => ({ id, key: 'claude:' + id, title: id, agent: 'Claude', project: { id: 'p' }, changedAt, ...extra });
  const home = {
    chats: [
      live('a', '2026-11-12T10:00:00Z', { rank: 10002 }),
      live('b', '2026-11-12T09:00:00Z', { rank: 10001 }),
      live('fresh', '2026-11-01T09:00:00Z'),
      live('h1', '2026-11-12T08:00:00Z', { under: 'claude:b', listedAt: 1, rank: 10002 }),
      live('h2', '2026-11-12T08:00:00Z', { under: 'claude:b', listedAt: 2, rank: 10001 }),
    ],
    saved: [{ key: 'claude:old', title: 'old', agent: 'Claude', project: { id: 'p' }, lastActive: '2026-11-12T12:00:00Z', rank: 10003 }],
  };
  assert.deepEqual(P.orderHome(home, '').map((i) => i.id || i.key), ['fresh', 'b', 'h2', 'h1', 'a', 'claude:old']);
  const none = { chats: [live('x', '2026-11-12T10:00:00Z'), live('y', '2026-11-12T11:00:00Z')], saved: [] };
  assert.deepEqual(P.orderHome(none, '').map((i) => i.id), ['y', 'x'], 'no rank: newest change first, as before');
});
