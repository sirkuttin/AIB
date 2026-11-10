const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');

class Node {
  constructor(tag, doc) {
    this.tagName = tag;
    this.ownerDocument = doc;
    this.children = [];
    this.attrs = {};
    this.className = '';
    this.hidden = false;
    this._text = '';
    this.dataset = {};
    this.style = {};
    this.listeners = {};
    this.open = false;
    this.parentNode = null;
    this.id = '';
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get textContent() {
    return this._text + this.children.map((x) => x.textContent).join('');
  }
  set innerHTML(v) {
    throw new Error('innerHTML must never be used');
  }
  _add(n) {
    if (n.tagName === '#fragment') {
      for (const c of n.children) {
        c.parentNode = this;
        this.children.push(c);
      }
      n.children = [];
    } else {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  append(...ns) {
    ns.forEach((n) => this._add(n));
  }
  appendChild(n) {
    this._add(n);
    return n;
  }
  replaceChildren(...ns) {
    this.children = [];
    this._text = '';
    this.append(...ns);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  fire(type, event = {}) {
    for (const fn of this.listeners[type] || []) fn(event);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  getBoundingClientRect() {
    return { left: 0, bottom: 10, right: 100 };
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  buttons() {
    return this.all().filter((n) => n.tagName === 'button');
  }
  button(label) {
    return this.buttons().find((n) => n.textContent === label);
  }
}

const STATIC = [
  'connections',
  'archivedBox',
  'archivedSummary',
  'archivedList',
  'deletedBox',
  'deletedSummary',
  'deletedList',
  'organizeCurrent',
  'findChat',
  'new',
];
const WARNING_TITLE = '<img src=x onerror=alert(1)> hostile';

function setup({ stored = {}, storageThrows = false } = {}) {
  const document = { activeElement: null, listeners: {} };
  document.createElement = (tag) => new Node(tag, document);
  document.createDocumentFragment = () => new Node('#fragment', document);
  document.addEventListener = (type, fn) => {
    (document.listeners[type] = document.listeners[type] || []).push(fn);
  };
  document.body = new Node('body', document);
  const byId = {};
  for (const id of STATIC) {
    const n = new Node(
      id.endsWith('Box')
        ? 'details'
        : id.endsWith('Summary')
          ? 'summary'
          : id === 'organizeCurrent' || id === 'new' || id === 'findChat'
            ? 'button'
            : 'div',
      document,
    );
    n.id = id;
    byId[id] = n;
  }
  byId.organizeCurrent.hidden = true;
  byId.archivedBox.children = [byId.archivedSummary];
  byId.archivedBox.children.forEach((c) => {
    c.parentNode = byId.archivedBox;
  });
  byId.deletedBox.children = [byId.deletedSummary];
  document.getElementById = (id) => byId[id] || null;
  const store = Object.assign({}, stored);
  const localStorage = {
    getItem: (k) => {
      if (storageThrows) throw new Error('blocked');
      return k in store ? store[k] : null;
    },
    setItem: (k, v) => {
      if (storageThrows) throw new Error('blocked');
      store[k] = String(v);
    },
  };
  const window = { document, localStorage };
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'organize-ui.js'), 'utf8'), {
    window,
    Object,
    Array,
    String,
    Number,
    Promise,
    Error,
    Map,
    Date,
    JSON,
    Math,
    isNaN,
  });
  return { ui: window.AgentOrganizeUI, document, byId, store, window };
}

// A tiny server double with the same rules as ConversationState.
function fakeServer() {
  const server = { entries: {}, revision: 1, calls: [], failNext: null, clock: 1000 };
  server.get = async (path) => {
    server.calls.push(['GET', path]);
    return { revision: 'r' + server.revision, entries: JSON.parse(JSON.stringify(server.entries)), warning: '' };
  };
  server.post = async (path, body) => {
    server.calls.push(['POST', path, body]);
    if (server.failNext) {
      const error = server.failNext;
      server.failNext = null;
      throw error;
    }
    if (path !== 'conversation-state') return { ok: true };
    const key = body.provider + ':' + body.sessionId,
      now = ++server.clock;
    const e = server.entries[key] || {
      pinnedAt: 0,
      archivedAt: 0,
      deletedAt: 0,
      holdAt: 0,
      holdNote: '',
      agentDeleted: false,
      title: '',
      cwd: '',
    };
    if (body.action === 'pin') e.pinnedAt = e.pinnedAt || now;
    if (body.action === 'unpin') e.pinnedAt = 0;
    if (body.action === 'hold') {
      e.holdAt = e.holdAt || now;
      e.holdNote = body.note || '';
    }
    if (body.action === 'resume') {
      e.holdAt = 0;
      e.holdNote = '';
    }
    if (body.action === 'archive') {
      e.archivedAt = e.archivedAt || now;
      e.pinnedAt = 0;
      e.holdAt = 0;
      e.holdNote = '';
    }
    if (body.action === 'unarchive') e.archivedAt = 0;
    if (body.action === 'delete') {
      e.deletedAt = now;
      e.pinnedAt = 0;
      e.title = body.title || e.title;
      e.cwd = body.cwd || e.cwd;
    }
    if (body.action === 'restore') {
      e.deletedAt = 0;
      e.agentDeleted = false;
    }
    if (body.action === 'handled') e.yourTurnAt = 0;
    if (['hold', 'archive', 'delete'].includes(body.action)) e.yourTurnAt = 0;
    if (e.pinnedAt || e.archivedAt || e.deletedAt || e.holdAt || e.yourTurnAt) server.entries[key] = e;
    else delete server.entries[key];
    server.revision++;
    return { ok: true };
  };
  return server;
}

const conv = (id, title, extra = {}) =>
  Object.assign(
    { provider: 'claude', id, key: 'k-' + id, title, cwd: 'C:\\w', created: 100 - Number(id.replace(/\D/g, '') || 0) },
    extra,
  );
const plain = (x) => JSON.parse(JSON.stringify(x));
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

function build(options = {}) {
  const env = setup(options.env),
    server = fakeServer();
  server.entries = options.entries || {};
  const conversations = options.conversations || [
    conv('a1', 'Alpha'),
    conv('a2', 'Beta'),
    conv('a3', 'Gamma'),
    conv('a4', 'Delta'),
  ];
  const log = { fail: [], ended: [], closed: 0, rerender: 0, renamed: [], listRefresh: 0, named: [], handoff: [] };
  let selected = options.selected || null;
  const host = {
    get: server.get,
    post: server.post,
    aliasKey: (c) => c.provider + ':' + c.id,
    titleOf: (c) => c.title,
    rename: (c) => log.renamed.push(c.id),
    conversations: () => conversations,
    setName: (c, v) => log.named.push([c.id, v]),
    handoff: (c) => log.handoff.push(c.id),
    getSelected: () => selected,
    fail: (e) => log.fail.push(e.message),
    rerender: () => {
      log.rerender++;
      draw();
    },
    refreshList: async () => {
      log.listRefresh++;
    },
    endSession: async (c) => {
      if (options.endFails) throw new Error('could not disconnect');
      log.ended.push(c.id);
      server.calls.push(['END', c.id]);
      c.live = null;
    },
    closeSelected: () => {
      log.closed++;
      selected = null;
    },
  };
  const buildRow = (c) => {
    const wrapper = env.document.createElement('div');
    const main = env.document.createElement('button');
    main.dataset.key = host.aliasKey(c);
    main.textContent = c.title;
    wrapper.append(main, env.ui.menuButton(c));
    return wrapper;
  };
  function draw(query = '') {
    env.ui.syncHeader(selected);
    const rows = conversations
      .filter((c) => c.provider === 'claude' && c.title.toLowerCase().includes(query))
      .sort((a, b) => Number(!!b.live) - Number(!!a.live) || b.created - a.created);
    env.ui.render(env.byId.connections, env.ui.partition(rows), {
      buildRow,
      all: conversations,
      provider: 'claude',
      query,
      emptyText: 'No saved conversations yet.',
    });
  }
  env.ui.init(host);
  return Object.assign(env, {
    server,
    host,
    log,
    conversations,
    draw,
    select: (c) => {
      selected = c;
    },
    titlesIn: (node) =>
      node
        .all()
        .filter((n) => n.dataset.key)
        .map((n) => n.textContent),
  });
}

async function loaded(t) {
  await t.ui.sync();
  t.draw();
  return t;
}
const flat = (n) =>
  n
    .all()
    .filter((x) => x._text)
    .map((x) => x._text.trim())
    .join(' ');
const sumOf = flat;
const holdToggleOf = (t) => t.byId.connections.all().find((n) => n.className === 'hold-toggle');
const holdLine = (t) => flat(holdToggleOf(t));
const holdRows = (t) => t.byId.connections.all().find((n) => n.className === 'hold-rows');
const headingsOf = (t) =>
  t.byId.connections
    .all()
    .filter((n) => n.tagName === 'h3')
    .map(flat);
const rowButton = (t, title) =>
  t.byId.connections
    .all()
    .concat(t.byId.archivedList.all())
    .find(
      (n) =>
        n.dataset.key &&
        (n.textContent === title || (n.textContent.startsWith(title) && n.textContent.includes(' held '))),
    );
const moreOf = (t, title) => {
  const row = rowButton(t, title).parentNode;
  return row.children[1];
};
const menuItems = (t) =>
  t.document.body
    .all()
    .filter((n) => /^menuitem/.test(n.attrs.role || ''))
    .map((n) => n.textContent);
const menuShape = (t) => {
  const m = t.document.body.all().find((n) => n.attrs.role === 'menu');
  return m.children.map((n) => (n.attrs.role === 'separator' ? '-' : n.textContent));
};
const menuItem = (t, label) =>
  t.document.body.all().find((n) => /^menuitem/.test(n.attrs.role || '') && n.textContent === label);
const dialogOf = (t) => t.document.body.all().find((n) => n.tagName === 'dialog');
const E = (pinnedAt = 0, archivedAt = 0, deletedAt = 0, extra = {}) =>
  Object.assign(
    {
      pinnedAt,
      archivedAt,
      deletedAt,
      holdAt: 0,
      holdNote: '',
      agentDeleted: false,
      title: '',
      cwd: '',
      yourTurnAt: 0,
    },
    extra,
  );
const TURN = (at = 500, extra = {}) => E(0, 0, 0, Object.assign({ yourTurnAt: at }, extra));

test('sections: pinned (most recently pinned first), main, archived and deleted are separated', async () => {
  const t = await loaded(
    build({
      entries: {
        'claude:a1': E(10),
        'claude:a3': E(20),
        'claude:a2': E(0, 5),
        'claude:a4': E(0, 0, 7, { title: 'Delta' }),
      },
    }),
  );
  assert.deepEqual(headingsOf(t), ['Pinned 2']); // pinned chats show only under Pinned; no empty Chats heading
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Gamma', 'Alpha'], 'latest pin first, each chat once');
  assert.deepEqual(t.titlesIn(t.byId.archivedList), ['Beta']);
  assert.equal(sumOf(t.byId.archivedSummary), 'Archived 1');
  assert.equal(t.byId.deletedSummary.textContent, 'Recently deleted1');
  assert.equal(t.ui.count(t.conversations, 'claude'), 2, 'tab count covers the visible list');
});

test('main list keeps its order under a Chats heading, with Pinned above it when something is pinned', async () => {
  const t = await loaded(build());
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.deepEqual(headingsOf(t), ['Chats 4']);
  t.server.entries = { 'claude:a3': E(5) };
  await t.ui.sync('different');
  t.draw();
  assert.deepEqual(headingsOf(t), ['Pinned 1', 'Chats 3']);
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Gamma', 'Alpha', 'Beta', 'Delta']);
});

test('search and provider filters apply to every section', async () => {
  const other = conv('o1', 'Alpha omp', { provider: 'omp' });
  const t = await loaded(
    build({
      conversations: [conv('a1', 'Alpha'), conv('a2', 'Beta'), other],
      entries: { 'claude:a1': E(1), 'claude:a2': E(0, 2), 'omp:o1': E(3) },
    }),
  );
  t.draw('alpha');
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Alpha'], 'a pinned chat shows once');
  assert.equal(sumOf(t.byId.archivedSummary), 'Archived 0');
  t.draw('beta');
  assert.equal(sumOf(t.byId.archivedSummary), 'Archived 1');
  assert.match(t.byId.connections.textContent, /No saved conversations yet|archived/i);
});

test('a live conversation is never hidden by a tombstone', async () => {
  const live = conv('a1', 'Alpha', { live: { id: 'c1', sessionId: 'a1' } });
  const t = await loaded(
    build({ conversations: [live, conv('a2', 'Beta')], entries: { 'claude:a1': E(0, 0, 9, { title: 'Alpha' }) } }),
  );
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Alpha', 'Beta']);
  assert.equal(t.byId.deletedSummary.textContent, 'Recently deleted0');
});

test('untrusted titles are text only in rows, menus, dialogs and the deleted list', async () => {
  const t = await loaded(
    build({
      conversations: [conv('a1', WARNING_TITLE)],
      entries: { 'claude:g1': E(0, 0, 4, { title: WARNING_TITLE }) },
    }),
  );
  const bad = (nodes) => nodes.some((n) => ['img', 'script'].includes(n.tagName));
  assert.equal(bad(t.byId.connections.all()), false);
  assert.ok(t.byId.deletedList.textContent.includes(WARNING_TITLE));
  t.ui._openMenu(moreOf(t, WARNING_TITLE), t.conversations[0], 'row');
  assert.ok(t.document.body.all().some((n) => (n.attrs['aria-label'] || '').includes(WARNING_TITLE)));
  menuItem(t, 'Hold\u2026').onclick();
  await flush();
  assert.ok(dialogOf(t).textContent.includes(WARNING_TITLE));
  assert.equal(bad(t.document.body.all()), false);
  assert.equal(bad(t.byId.deletedList.all()), false);
});

test('accordion: collapsed by default, state remembered, storage failures tolerated', () => {
  const fresh = setup();
  assert.equal(fresh.byId.archivedBox.open, false);
  const t = build();
  assert.equal(t.byId.archivedBox.open, false);
  assert.equal(t.byId.archivedSummary.attrs['aria-expanded'], 'false');
  t.byId.archivedBox.open = true;
  t.byId.archivedBox.fire('toggle');
  assert.equal(t.store['studio-archived-open'], '1');
  assert.equal(t.byId.archivedSummary.attrs['aria-expanded'], 'true');
  t.byId.deletedBox.open = true;
  t.byId.deletedBox.fire('toggle');
  assert.equal(t.store['studio-deleted-open'], '1');
  t.byId.archivedBox.open = false;
  t.byId.archivedBox.fire('toggle');
  assert.equal(t.store['studio-archived-open'], '0');

  const remembered = build({ env: { stored: { 'studio-archived-open': '1', 'studio-deleted-open': '1' } } });
  assert.equal(remembered.byId.archivedBox.open, true);
  assert.equal(remembered.byId.deletedBox.open, true);
  assert.equal(remembered.byId.archivedSummary.attrs['aria-expanded'], 'true');

  const blocked = build({ env: { storageThrows: true } });
  assert.equal(blocked.byId.archivedBox.open, false);
  blocked.byId.archivedBox.open = true;
  assert.doesNotThrow(() => blocked.byId.archivedBox.fire('toggle'));
});

test('re-rendering keeps the accordion open state and the focused row', async () => {
  const t = await loaded(build({ entries: { 'claude:a2': E(0, 5) } }));
  t.byId.archivedBox.open = true;
  t.byId.archivedBox.fire('toggle');
  rowButton(t, 'Alpha').focus();
  t.draw();
  assert.equal(t.byId.archivedBox.open, true);
  assert.equal(t.document.activeElement.textContent, 'Alpha');
  assert.equal(t.document.activeElement.dataset.key, 'claude:a1');
});

test('sync fetches only when the server revision changed and tolerates failures', async () => {
  const t = build();
  assert.equal(await t.ui.sync('r1'), true);
  assert.equal(t.ui.signature().startsWith('r1'), true);
  const gets = () => t.server.calls.filter((c) => c[0] === 'GET').length;
  const before = gets();
  assert.equal(await t.ui.sync('r1'), false);
  assert.equal(gets(), before, 'same revision: no request');
  t.server.entries = { 'claude:a1': E(1) };
  t.server.revision = 2;
  assert.equal(await t.ui.sync('r2'), true);
  assert.equal(t.ui._state().entries['claude:a1'].pinnedAt, 1);
  t.host.get = null; // not used again; swap the server to fail
  const failing = build();
  failing.server.get = async () => {
    throw new Error('offline');
  };
  const f2 = setup(); // a host whose GET throws
  f2.ui.init({
    get: async () => {
      throw new Error('offline');
    },
    post: async () => ({}),
    aliasKey: (c) => c.id,
    titleOf: (c) => c.title,
    getSelected: () => null,
  });
  assert.equal(await f2.ui.sync('x'), false);
  assert.deepEqual(plain(f2.ui._state().entries), {}, 'the list falls back to showing everything');
});

test('row menu: buttons with menu roles for each kind of row, keyboard navigation, Escape returns focus', async () => {
  const t = await loaded(build({ entries: { 'claude:a2': E(3), 'claude:a3': E(0, 4) } }));
  const alpha = t.conversations[0];
  t.ui._openMenu(moreOf(t, 'Alpha'), alpha, 'row');
  assert.deepEqual(menuItems(t), [
    'Rename',
    'Pin',
    'Hold\u2026',
    'Continue with another agent\u2026',
    'Archive',
    'Delete',
  ]);
  assert.ok(
    t.document.body
      .all()
      .filter((n) => n.attrs.role === 'menuitem')
      .every((n) => n.tagName === 'button'),
  );
  const menu = t.document.body.all().find((n) => n.attrs.role === 'menu');
  assert.equal(moreOf(t, 'Alpha').attrs['aria-expanded'], 'true');
  assert.equal(moreOf(t, 'Alpha').attrs['aria-haspopup'], 'menu');
  assert.equal(t.document.activeElement.textContent, 'Rename');
  const key = (k) => {
    let prevented = false;
    menu.onkeydown({
      key: k,
      preventDefault: () => {
        prevented = true;
      },
    });
    return prevented;
  };
  assert.equal(key('ArrowDown'), true);
  assert.equal(t.document.activeElement.textContent, 'Pin');
  key('End');
  assert.equal(t.document.activeElement.textContent, 'Delete');
  key('ArrowDown');
  assert.equal(t.document.activeElement.textContent, 'Rename', 'wraps around');
  key('ArrowUp');
  assert.equal(t.document.activeElement.textContent, 'Delete');
  key('Escape');
  assert.equal(
    t.document.body.all().some((n) => n.attrs.role === 'menu'),
    false,
  );
  assert.equal(t.document.activeElement, moreOf(t, 'Alpha'), 'focus goes back to the trigger');
  assert.equal(moreOf(t, 'Alpha').attrs['aria-expanded'], 'false');

  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  assert.deepEqual(menuItems(t), [
    'Rename',
    'Unpin',
    'Hold\u2026',
    'Continue with another agent\u2026',
    'Archive',
    'Delete',
  ]);
  t.ui._closeMenu(false);
  t.byId.archivedBox.open = true;
  t.ui._openMenu(moreOf(t, 'Gamma'), t.conversations[2], 'row');
  assert.deepEqual(menuItems(t), ['Rename', 'Continue with another agent\u2026', 'Unarchive', 'Delete']);
  menuItem(t, 'Rename').onclick();
  assert.equal(
    t.document.body.all().some((n) => n.attrs.role === 'menu'),
    false,
    'choosing an item closes the menu',
  );
});

test('the menu has exactly the drawn items in the drawn order, with separators, and only what applies', async () => {
  const live = conv('a1', 'Alpha', { live: { id: 'c1', sessionId: 'a1' } });
  const t = await loaded(build({ conversations: [live, conv('a2', 'Beta')], entries: { 'claude:a1': TURN() } }));
  t.window.AgentChatView = { getThinking: () => false, setThinking() {} };
  t.draw();
  t.ui._openMenu(moreOf(t, 'Alpha'), live, 'row');
  assert.deepEqual(menuShape(t), [
    'Rename',
    'Pin',
    'Hold\u2026',
    'Mark handled',
    '-',
    'Show thinking',
    'Continue with another agent\u2026',
    "End this chat's session",
    '-',
    'Archive',
    'Delete',
  ]);
  assert.equal(
    t.document.body.all().find((n) => n.textContent === 'Delete').className,
    'danger',
    'Delete is the red one',
  );
  t.ui._closeMenu(false);
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  assert.deepEqual(
    menuShape(t),
    [
      'Rename',
      'Pin',
      'Hold\u2026',
      '-',
      'Show thinking',
      'Continue with another agent\u2026',
      '-',
      'Archive',
      'Delete',
    ],
    'no Mark handled unless it is your turn, no End Studio session unless live',
  );
});

test('Show thinking is a toggle that follows the chat view, and is hidden when the view cannot do it', async () => {
  const t = await loaded(build());
  t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
  assert.equal(menuItem(t, 'Show thinking'), undefined, 'no chat view API: no item');
  t.ui._closeMenu(false);
  let on = false;
  t.window.AgentChatView = {
    getThinking: () => on,
    setThinking: (v) => {
      on = v;
    },
  };
  t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
  assert.equal(menuItem(t, 'Show thinking').attrs['aria-checked'], 'false');
  menuItem(t, 'Show thinking').onclick();
  assert.equal(on, true);
  t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
  assert.equal(menuItem(t, 'Show thinking').attrs['aria-checked'], 'true');
});

test('right-click and the ContextMenu key open the same menu on a card; Shift+F10 too', async () => {
  const t = await loaded(build());
  const row = rowButton(t, 'Alpha').parentNode;
  let prevented = 0;
  row.fire('contextmenu', {
    clientX: 120,
    clientY: 80,
    target: rowButton(t, 'Alpha'),
    preventDefault: () => {
      prevented++;
    },
  });
  assert.equal(prevented, 1, 'the browser menu is replaced');
  assert.equal(menuItems(t)[0], 'Rename');
  const menu = t.document.body.all().find((n) => n.attrs.role === 'menu');
  assert.equal(menu.style.left, '120px');
  assert.equal(menu.style.top, '80px', 'opens at the pointer');
  t.ui._closeMenu(false);
  row.fire('keydown', {
    key: 'ContextMenu',
    preventDefault: () => {
      prevented++;
    },
  });
  assert.equal(menuItems(t)[0], 'Rename');
  t.ui._closeMenu(false);
  row.fire('keydown', {
    key: 'F10',
    shiftKey: true,
    preventDefault: () => {
      prevented++;
    },
  });
  assert.equal(menuItems(t)[0], 'Rename');
  t.ui._closeMenu(false);
  row.fire('keydown', {
    key: 'F10',
    preventDefault: () => {
      prevented++;
    },
  });
  assert.equal(
    t.document.body.all().some((n) => n.attrs.role === 'menu'),
    false,
    'plain F10 is not ours',
  );
});

test('Rename: the open chat uses the header rename, any other chat is renamed on its card, Esc cancels', async () => {
  const t = await loaded(build());
  const alpha = t.conversations[0];
  t.select(alpha);
  t.draw();
  let started = 0;
  t.window.AgentHeaderUI = {
    startRename: () => {
      started++;
    },
  };
  t.ui._openMenu(moreOf(t, 'Alpha'), alpha, 'row');
  menuItem(t, 'Rename').onclick();
  assert.equal(started, 1, 'header inline rename for the open chat');
  assert.deepEqual(t.log.named, []);
  // Another chat: inline on the card.
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  menuItem(t, 'Rename').onclick();
  assert.equal(started, 1);
  const row = rowButton(t, 'Beta').parentNode;
  const input = row.children.find((n) => n.tagName === 'input');
  assert.ok(input, 'an input appears on the card');
  assert.equal(input.value, 'Beta');
  assert.equal(row.children[0].hidden, true);
  input.value = 'Beta two';
  input.onkeydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(plain(t.log.named), [['a2', 'Beta two']]);
  assert.equal(
    row.children.some((n) => n.tagName === 'input'),
    false,
  );
  assert.equal(row.children[0].hidden, false);
  t.ui._openMenu(moreOf(t, 'Gamma'), t.conversations[2], 'row');
  menuItem(t, 'Rename').onclick();
  const i2 = rowButton(t, 'Gamma').parentNode.children.find((n) => n.tagName === 'input');
  i2.value = 'ignored';
  i2.onkeydown({ key: 'Escape', preventDefault() {} });
  assert.equal(t.log.named.length, 1, 'Escape cancels');
  // No header rename available: the card is used for the open chat too.
  delete t.window.AgentHeaderUI;
  t.ui._openMenu(moreOf(t, 'Alpha'), alpha, 'row');
  menuItem(t, 'Rename').onclick();
  assert.ok(rowButton(t, 'Alpha').parentNode.children.some((n) => n.tagName === 'input'));
});

test('Continue with another agent hands the chat to the page, and End Studio session ends only a live one', async () => {
  const live = conv('a1', 'Alpha', { live: { id: 'c1', sessionId: 'a1' } });
  const t = await loaded(build({ conversations: [live, conv('a2', 'Beta')] }));
  t.ui._openMenu(moreOf(t, 'Alpha'), live, 'row');
  menuItem(t, 'Continue with another agent\u2026').onclick();
  assert.deepEqual(t.log.handoff, ['a1']);
  t.ui._openMenu(moreOf(t, 'Alpha'), live, 'row');
  menuItem(t, "End this chat's session").onclick();
  await flush();
  assert.deepEqual(t.log.ended, ['a1']);
  assert.deepEqual(
    t.server.calls.filter((c) => c[0] === 'POST'),
    [],
    'ending a session marks nothing',
  );
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  assert.equal(menuItem(t, "End this chat's session"), undefined);
});

test('your turn: the flag comes from the server entry, ignores parked chats, and only acting clears it', async () => {
  const t = await loaded(
    build({
      entries: {
        'claude:a1': TURN(900),
        'claude:a2': TURN(800, { holdAt: 5 }),
        'claude:a3': TURN(700, { archivedAt: 5 }),
      },
    }),
  );
  t.ui.flag(t.conversations);
  assert.deepEqual(
    t.conversations.map((c) => [c.id, c.yourTurn, c.yourTurnAt]),
    [
      ['a1', true, 900],
      ['a2', false, 0],
      ['a3', false, 0],
      ['a4', false, 0],
    ],
  );
  // Rendering, selecting and looking at the chat do not clear it.
  t.select(t.conversations[0]);
  t.draw();
  t.draw();
  assert.equal(t.server.entries['claude:a1'].yourTurnAt, 900);
  assert.deepEqual(
    t.server.calls.filter((c) => c[0] === 'POST'),
    [],
  );
  // Mark handled from the menu.
  t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
  menuItem(t, 'Mark handled').onclick();
  await flush();
  assert.deepEqual(plain(t.server.calls.find((c) => c[0] === 'POST').slice(1)), [
    'conversation-state',
    { action: 'handled', provider: 'claude', sessionId: 'a1' },
  ]);
  assert.equal(t.conversations[0].yourTurn, false, 'the page object is refreshed');
  // The API the composer button uses.
  t.server.entries['claude:a4'] = TURN(950);
  await t.ui.sync('again');
  t.ui.flag(t.conversations);
  assert.equal(t.conversations[3].yourTurn, true);
  await t.ui.markHandled(t.conversations[3]);
  assert.equal(t.conversations[3].yourTurn, false);
  // Holding, archiving and deleting are acting too (the server clears the mark).
  for (const [action, id, title] of [
    ['hold', 'a1', 'Alpha'],
    ['archive', 'a2', 'Beta'],
  ]) {
    t.server.entries['claude:' + id] = TURN(600);
    await t.ui.sync('r' + action);
    t.ui.flag(t.conversations);
    assert.equal(t.conversations.find((c) => c.id === id).yourTurn, true);
    await t.host.post('conversation-state', { action, provider: 'claude', sessionId: id });
    await t.ui.sync('s' + action);
    t.ui.flag(t.conversations);
    assert.equal(t.conversations.find((c) => c.id === id).yourTurn, false, action + ' clears it');
  }
});

test('header menu offers the same actions and reflects state on its button', async () => {
  const t = await loaded(build({ entries: { 'claude:a1': E(3) } }));
  assert.equal(t.byId.organizeCurrent.hidden, true);
  t.select(t.conversations[0]);
  t.draw();
  assert.equal(t.byId.organizeCurrent.hidden, false);
  assert.match(t.byId.organizeCurrent.textContent, /^Pinned/);
  t.byId.organizeCurrent.onclick();
  assert.deepEqual(menuItems(t), [
    'Rename',
    'Unpin',
    'Hold\u2026',
    'Continue with another agent\u2026',
    'Archive',
    'Delete',
  ]);
  menuItem(t, 'Unpin').onclick();
  await flush();
  assert.equal(t.server.entries['claude:a1'], undefined);
  assert.match(t.byId.organizeCurrent.textContent, /^Organize/);
  assert.equal(t.document.activeElement, t.byId.organizeCurrent, 'focus stays on the header control');
  t.select(null);
  t.draw();
  assert.equal(t.byId.organizeCurrent.hidden, true);
  t.select({ provider: 'claude', key: 'live:x', live: { id: 'x' } });
  t.draw();
  assert.equal(t.byId.organizeCurrent.hidden, true, 'a connection without a session ID cannot be organised yet');
});

test('pin posts the action, refreshes, re-renders and keeps focus on the row', async () => {
  const t = await loaded(build());
  t.ui._openMenu(moreOf(t, 'Gamma'), t.conversations[2], 'row');
  menuItem(t, 'Pin').onclick();
  await flush();
  const post = t.server.calls.find((c) => c[0] === 'POST');
  assert.deepEqual(plain(post.slice(1)), [
    'conversation-state',
    { action: 'pin', provider: 'claude', sessionId: 'a3' },
  ]);
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Gamma', 'Alpha', 'Beta', 'Delta']);
  assert.equal(t.document.activeElement.textContent, 'Gamma');
});

test('archive: row leaves the list, focus moves to a neighbour, archiving unpins', async () => {
  const t = await loaded(build({ entries: { 'claude:a2': E(5) } }));
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  menuItem(t, 'Archive').onclick();
  await flush();
  assert.equal(t.server.entries['claude:a2'].pinnedAt, 0);
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Alpha', 'Gamma', 'Delta']);
  assert.deepEqual(t.titlesIn(t.byId.archivedList), ['Beta']);
  assert.equal(sumOf(t.byId.archivedSummary), 'Archived 1');
  assert.equal(t.document.activeElement.textContent, 'Alpha', 'focus moves to the next row');
  assert.equal(t.log.ended.length, 0);
});

test('unarchive from an archived row puts it back and focuses it', async () => {
  const t = await loaded(build({ entries: { 'claude:a2': E(0, 5) } }));
  t.byId.archivedBox.open = true;
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  menuItem(t, 'Unarchive').onclick();
  await flush();
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Alpha', 'Beta', 'Gamma', 'Delta']);
  assert.equal(t.document.activeElement.textContent, 'Beta');
});

test('archiving a live conversation asks first: cancel, keep running, or end the session', async () => {
  const mk = () =>
    build({
      conversations: [
        conv('a1', 'Alpha', { live: { id: 'c1', sessionId: 'a1', breadth: { ops: [] } } }),
        conv('a2', 'Beta'),
      ],
    });
  for (const [label, expectEnded, expectArchived] of [
    ['Cancel', false, false],
    ['Keep running and archive', false, true],
    ["End this chat's session and archive", true, true],
  ]) {
    const t = await loaded(mk());
    t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
    menuItem(t, 'Archive').onclick();
    await flush();
    const dialog = dialogOf(t);
    assert.equal(dialog.open, true);
    assert.match(dialog.textContent, /live in AIB/);
    assert.deepEqual(
      dialog.buttons().map((b) => b.textContent),
      ['Cancel', 'Keep running and archive', "End this chat's session and archive"],
    );
    assert.equal(t.document.activeElement.textContent, 'Cancel', 'the safe choice has focus');
    assert.equal(
      t.server.calls.some((c) => c[0] === 'POST'),
      false,
      'nothing happens before the choice',
    );
    dialog.button(label).onclick();
    await flush();
    assert.equal(dialog.open, false);
    assert.equal(t.log.ended.length, expectEnded ? 1 : 0, label);
    assert.equal(!!t.server.entries['claude:a1']?.archivedAt, expectArchived, label);
    if (expectEnded) {
      const order = t.server.calls.map((c) => c[0]).filter((x) => x === 'END' || x === 'POST');
      assert.deepEqual(order, ['END', 'POST'], 'the session ends before the mark is written');
    }
    if (label === 'Cancel')
      assert.equal(t.document.activeElement, moreOf(t, 'Alpha'), 'cancel returns focus to the row control');
  }
});

test('if ending the session fails, nothing is archived and the error is shown', async () => {
  const t = await loaded(
    build({ endFails: true, conversations: [conv('a1', 'Alpha', { live: { id: 'c1', sessionId: 'a1' } })] }),
  );
  t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
  menuItem(t, 'Archive').onclick();
  await flush();
  dialogOf(t).button("End this chat's session and archive").onclick();
  await flush();
  assert.deepEqual(t.log.fail, ['could not disconnect']);
  assert.deepEqual(t.server.entries, {});
});

test('server errors on an action are reported and the list is refreshed', async () => {
  const t = await loaded(build());
  t.server.failNext = new Error('Studio could not save');
  t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
  menuItem(t, 'Pin').onclick();
  await flush();
  assert.deepEqual(t.log.fail, ['Studio could not save']);
  assert.deepEqual(t.server.entries, {});
});

test('delete: one click, no dialog, like Archive; the row leaves the list and can be restored', async () => {
  const t = await loaded(build({ selected: null }));
  t.ui._openMenu(moreOf(t, 'Delta'), t.conversations[3], 'row');
  menuItem(t, 'Delete').onclick();
  await flush();
  assert.equal(dialogOf(t), undefined, 'no confirmation dialog');
  assert.deepEqual(
    t.server.calls.filter((c) => c[0] === 'POST').map((c) => c[2].action),
    ['delete'],
  );
  assert.equal(t.server.calls.find((c) => c[0] === 'POST')[2].title, 'Delta');
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(t.byId.deletedSummary.textContent, 'Recently deleted1');
  assert.equal(t.log.listRefresh, 1);
  assert.equal(t.document.activeElement.textContent, 'Gamma', 'focus moves to a neighbouring row');
  assert.equal(t.server.entries['claude:a4'].deletedAt > 0, true);
});

test('delete of the open conversation closes it; a live one ends its Studio session first', async () => {
  const live = conv('a1', 'Alpha', { live: { id: 'c1', sessionId: 'a1', breadth: { ops: ['list', 'close'] } } });
  const t = await loaded(build({ conversations: [live, conv('a2', 'Beta')], selected: live }));
  t.ui._openMenu(moreOf(t, 'Alpha'), live, 'row');
  menuItem(t, 'Delete').onclick();
  await flush();
  assert.equal(dialogOf(t), undefined);
  assert.deepEqual(
    t.server.calls.map((c) => c[0]).filter((x) => x === 'END' || x === 'POST'),
    ['END', 'POST'],
  );
  assert.equal(t.log.closed, 1);
  assert.deepEqual(t.titlesIn(t.byId.connections), ['Beta']);
});

test('there is no permanent delete on the agent any more, even when the agent advertises session deletion', async () => {
  const live = conv('a1', 'Alpha', {
    live: { id: 'c1', sessionId: 'a1', busy: false, breadth: { ops: ['list', 'close', 'delete'] } },
  });
  const t = await loaded(build({ conversations: [live] }));
  t.ui._openMenu(moreOf(t, 'Alpha'), live, 'row');
  assert.equal(
    menuItems(t).some((x) => /permanent|agent.s saved|Delete session|from Studio/i.test(x)),
    false,
  );
  menuItem(t, 'Delete').onclick();
  await flush();
  assert.equal(
    t.server.calls.some((c) => c[0] === 'POST' && c[1] === 'session-op'),
    false,
    'session-op is never called from the menu',
  );
  assert.deepEqual(
    t.server.calls.filter((c) => c[0] === 'POST').map((c) => c[1]),
    ['conversation-state'],
  );
});

test('Recently deleted: restore returns the row, agent-deleted entries can only be removed from the list', async () => {
  const t = await loaded(
    build({
      conversations: [conv('a1', 'Alpha')],
      entries: {
        'claude:a2': E(0, 0, 50, { title: 'Snapshot title' }),
        'claude:a3': E(0, 0, 40, { title: 'Agent copy gone', agentDeleted: true }),
        'omp:z': E(0, 0, 60, { title: 'Other provider' }),
      },
    }),
  );
  t.byId.archivedBox.open = true;
  t.byId.deletedBox.open = true;
  assert.equal(t.byId.deletedSummary.textContent, 'Recently deleted2');
  const rows = t.byId.deletedList.all().filter((n) => n.className === 'deleted-row');
  assert.match(rows[0].textContent, /Snapshot title/);
  assert.match(rows[0].textContent, /transcript is untouched/);
  assert.match(rows[1].textContent, /cannot be restored/);
  assert.deepEqual(
    rows.map((r) => r.buttons()[0].textContent),
    ['Restore', 'Remove from list'],
  );
  assert.equal(rows[0].buttons()[0].attrs['aria-label'], 'Restore: Snapshot title');
  rows[1].buttons()[0].onclick();
  await flush();
  assert.equal(t.byId.deletedSummary.textContent, 'Recently deleted1');
  assert.equal(t.document.activeElement.textContent, 'Restore', 'focus moves to the remaining restore button');
  t.conversations.push(conv('a2', 'Beta'));
  t.byId.deletedList
    .all()
    .filter((n) => n.tagName === 'button')[0]
    .onclick();
  await flush();
  assert.equal(t.byId.deletedSummary.textContent, 'Recently deleted0');
  assert.ok(t.titlesIn(t.byId.connections).includes('Beta'));
  assert.equal(t.document.activeElement.textContent, 'Beta', 'the restored row takes focus');
  assert.deepEqual(
    t.server.calls.filter((c) => c[0] === 'POST').map((c) => c[2].action),
    ['restore', 'restore'],
  );
});

const H = (holdAt, holdNote = '', extra = {}) => E(0, 0, 0, Object.assign({ holdAt, holdNote }, extra));
const nowSec = () => Date.now() / 1000;

test('On hold chats sit under the "On hold" line of their project (collapsed by default); an older entry that is both pinned and held counts as held', async () => {
  const t = await loaded(
    build({
      entries: {
        'claude:a1': E(10, 0, 0, { holdAt: nowSec() - 7200, holdNote: 'waiting on CI' }),
        'claude:a2': H(nowSec() - 60, 'come back after lunch'),
        'claude:a3': H(nowSec() - 3 * 86400 * 1, ''),
      },
    }),
  );
  assert.deepEqual(headingsOf(t), ['Chats 1']);
  assert.equal(holdLine(t), '\u25B8 \u23F8 On hold \u00B7 3');
  assert.equal(holdRows(t).hidden, true, 'collapsed by default');
  assert.equal(
    t.byId.connections.all().some((n) => n.id === 'holdToggle'),
    false,
    'no separate On hold section any more',
  );
  assert.equal(t.ui.partition(t.conversations).main.length, 1);
  assert.equal(t.ui.partition(t.conversations).pinned.length, 0);
  assert.equal(t.ui.partition(t.conversations).hold.length, 3);
  holdToggleOf(t).onclick();
  await flush();
  assert.deepEqual(JSON.parse(t.store['studio-hold-open-by-project']), { '': 1 }, 'remembered per project key');
  assert.equal(holdRows(t).hidden, false);
  assert.equal(holdLine(t), '\u25BE \u23F8 On hold \u00B7 3');
  assert.deepEqual(
    t.titlesIn(t.byId.connections),
    ['Delta', 'Betacome back after lunch · held 1m', 'Alphawaiting on CI · held 2h', 'Gammano note · held 3d'],
    'on hold, latest first',
  );
  const notes = t.byId.connections
    .all()
    .filter((n) => n.className === 'hold-note')
    .map((n) => n.textContent);
  assert.deepEqual(notes, [
    'come back after lunch \u00B7 held 1m',
    'waiting on CI \u00B7 held 2h',
    'no note \u00B7 held 3d',
  ]);
  assert.equal(t.ui.count(t.conversations, 'claude'), 4, 'on hold chats stay in the tab count');
  assert.equal(
    t.ui.signature().split('|')[2] !== '0',
    true,
    'elapsed times refresh each minute while anything is on hold',
  );
});

test('the On hold line toggles per project, survives a redraw, and a broken store does not throw', async () => {
  const entries = { 'claude:a2': H(nowSec() - 60, 'x') };
  const t = await loaded(build({ entries }));
  holdToggleOf(t).onclick();
  t.draw();
  assert.equal(holdToggleOf(t).attrs['aria-expanded'], 'true');
  holdToggleOf(t).onclick();
  t.draw();
  assert.equal(holdToggleOf(t).attrs['aria-expanded'], 'false');
  assert.deepEqual(JSON.parse(t.store['studio-hold-open-by-project']), {});
  const bad = await loaded(build({ env: { storageThrows: true }, entries }));
  assert.doesNotThrow(() => holdToggleOf(bad).onclick());
  const junk = await loaded(build({ env: { stored: { 'studio-hold-open-by-project': '[1,2' } }, entries }));
  assert.equal(holdToggleOf(junk).attrs['aria-expanded'], 'false');
});

test('a view with only held chats still shows the On hold line, and collapsed held rows are not keyboard targets', async () => {
  const all = {
    'claude:a1': H(nowSec() - 60),
    'claude:a2': H(nowSec() - 120),
    'claude:a3': H(nowSec() - 180),
    'claude:a4': H(nowSec() - 240),
  };
  const t = await loaded(build({ env: { stored: { 'studio-hold-open-by-project': '{"":1}' } }, entries: all }));
  assert.deepEqual(headingsOf(t), []);
  assert.equal(holdLine(t), '\u25BE \u23F8 On hold \u00B7 4');
  assert.equal(t.ui.visibleKeys().length, 4);
  holdToggleOf(t).onclick();
  assert.deepEqual(plain(t.ui.visibleKeys()), []);
});

test('hold note is text only and archived conversations show no hold', async () => {
  const t = await loaded(
    build({
      env: { stored: { 'studio-hold-open-by-project': '{"":1}' } },
      entries: { 'claude:a1': H(nowSec() - 5000, WARNING_TITLE), 'claude:a2': E(0, 5, 0, { holdAt: nowSec() }) },
    }),
  );
  assert.equal(
    t.byId.connections.all().some((n) => ['img', 'script'].includes(n.tagName)),
    false,
  );
  assert.ok(t.byId.connections.textContent.includes(WARNING_TITLE));
  assert.equal(t.ui.bucket(t.conversations[1]), 'archived');
});

test('Put on hold asks for an optional note inline, Enter submits, Cancel changes nothing', async () => {
  const t = await loaded(build());
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  menuItem(t, 'Hold\u2026').onclick();
  await flush();
  let d = dialogOf(t);
  const field = d.all().find((n) => n.tagName === 'input');
  assert.ok(field && field.type === 'text' && field.maxLength === 120);
  assert.equal(t.document.activeElement, field, 'the note field has focus');
  assert.equal(
    t.server.calls.some((c) => c[0] === 'POST'),
    false,
  );
  d.button('Cancel').onclick();
  await flush();
  assert.equal(
    t.server.calls.some((c) => c[0] === 'POST'),
    false,
  );
  assert.equal(t.document.activeElement, moreOf(t, 'Beta'));
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  menuItem(t, 'Hold\u2026').onclick();
  await flush();
  const f2 = dialogOf(t)
    .all()
    .find((n) => n.tagName === 'input');
  f2.value = 'waiting on CI';
  f2.onkeydown({ key: 'Enter', preventDefault() {} });
  await flush();
  assert.deepEqual(plain(t.server.calls.find((c) => c[0] === 'POST').slice(1)), [
    'conversation-state',
    { action: 'hold', provider: 'claude', sessionId: 'a2', note: 'waiting on CI' },
  ]);
  assert.deepEqual(headingsOf(t), ['Chats 3']);
  assert.equal(holdLine(t), '\u25B8 \u23F8 On hold \u00B7 1');
  assert.equal(
    t.document.activeElement,
    holdToggleOf(t),
    'the held row is collapsed away: focus goes to its project On hold line (QA m9; was the Find button)',
  );
});

test('Resume and Edit hold note come from the same menus, header included; archiving clears the hold', async () => {
  const t = await loaded(
    build({
      env: { stored: { 'studio-hold-open-by-project': '{"":1}' } },
      entries: { 'claude:a2': H(nowSec() - 600, 'old note') },
    }),
  );
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  assert.deepEqual(menuItems(t), [
    'Rename',
    'Pin',
    'Edit hold note\u2026',
    'Resume',
    'Continue with another agent\u2026',
    'Archive',
    'Delete',
  ]);
  menuItem(t, 'Edit hold note\u2026').onclick();
  await flush();
  const field = dialogOf(t)
    .all()
    .find((n) => n.tagName === 'input');
  assert.equal(field.value, 'old note', 'prefilled');
  field.value = 'new note';
  dialogOf(t).button('Save note').onclick();
  await flush();
  assert.equal(t.server.entries['claude:a2'].holdNote, 'new note');
  t.select(t.conversations[1]);
  t.draw();
  assert.match(t.byId.organizeCurrent.textContent, /^On hold/);
  t.byId.organizeCurrent.onclick();
  assert.ok(menuItems(t).includes('Resume'));
  menuItem(t, 'Resume').onclick();
  await flush();
  assert.equal(t.server.entries['claude:a2'], undefined);
  assert.equal(t.document.activeElement, t.byId.organizeCurrent);
  assert.equal(
    t.byId.connections.all().some((n) => n.className === 'hold-note'),
    false,
  );
  // archive clears hold
  t.server.entries['claude:a3'] = H(nowSec(), 'x');
  await t.ui.sync('zz');
  t.draw();
  t.ui._openMenu(moreOf(t, 'Gamma'), t.conversations[2], 'row');
  menuItem(t, 'Archive').onclick();
  await flush();
  assert.equal(t.server.entries['claude:a3'].holdAt, 0);
  assert.equal(t.ui.bucket(t.conversations[2]), 'archived');
});

test('archived rows offer no hold action, and a pinned+held header reads Pinned \u00B7 On hold', async () => {
  const t = await loaded(
    build({ entries: { 'claude:a1': E(0, 5), 'claude:a2': E(4, 0, 0, { holdAt: nowSec(), holdNote: '' }) } }),
  );
  t.byId.archivedBox.open = true;
  t.ui._openMenu(moreOf(t, 'Alpha'), t.conversations[0], 'row');
  assert.equal(
    menuItems(t).some((x) => /hold/i.test(x)),
    false,
  );
  t.ui._closeMenu(false);
  t.select(t.conversations[1]);
  t.draw();
  assert.match(t.byId.organizeCurrent.textContent, /^Pinned \u00B7 On hold/);
});

// ---- QA sidebar round (qa/2-sidebar) ----------------------------------------------------------------------------
test('QA M4: the pin star is its own item after the title (outside the ellipsis box); the title text is unchanged', async () => {
  const t = await loaded(build({ entries: { 'claude:a2': E(10) } }));
  const beta = rowButton(t, 'Beta');
  const star = beta.children.find((n) => n.className === 'row-pin');
  assert.ok(star, 'a pinned card has a .row-pin child');
  assert.equal(star.attrs['aria-label'], 'Pinned');
  assert.equal(star.textContent, '', 'the glyph is drawn by CSS');
  assert.equal(beta.textContent, 'Beta');
  assert.ok(!rowButton(t, 'Alpha').children.some((n) => n.className === 'row-pin'));
});

test('QA m7: Up / Down move focus between the cards you can see', async () => {
  const t = await loaded(build());
  const cards = t.byId.connections.all().filter((n) => n.dataset.key);
  const titles = cards.map((n) => n.textContent);
  const down = { key: 'ArrowDown', preventDefault() {} },
    up = { key: 'ArrowUp', preventDefault() {} };
  cards[0].fire('keydown', down);
  assert.equal(t.document.activeElement, cards[1]);
  cards[1].fire('keydown', up);
  assert.equal(t.document.activeElement, cards[0]);
  t.document.activeElement = null;
  cards[0].fire('keydown', up);
  assert.equal(t.document.activeElement, null, 'nothing above the first card');
  cards[cards.length - 1].fire('keydown', down);
  assert.equal(t.document.activeElement, null, 'nothing below the last card');
  cards[0].fire('keydown', { key: 'ArrowDown', altKey: true, preventDefault() {} });
  assert.equal(t.document.activeElement, null, 'Alt+Down stays the page shortcut');
  assert.equal(titles.length, 4);
});

test('QA m5 + m9: holding a pinned chat says it unpins; afterwards focus goes to the On hold line, not Find chat', async () => {
  const t = await loaded(build({ entries: { 'claude:a2': E(10) } }));
  t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
  menuItem(t, 'Hold…').onclick();
  await flush();
  const dialog = dialogOf(t);
  assert.match(dialog.textContent, /putting it on hold unpins it/);
  dialog.button('Put on hold').onclick();
  await flush();
  const toggle = holdToggleOf(t);
  assert.ok(toggle);
  assert.equal(t.document.activeElement, toggle, 'the row is folded away: its project On hold line takes focus');
  // An unpinned chat gets no unpin note.
  t.ui._openMenu(moreOf(t, 'Gamma'), t.conversations[2], 'row');
  menuItem(t, 'Hold…').onclick();
  await flush();
  assert.doesNotMatch(dialogOf(t).textContent, /unpins/);
  dialogOf(t).button('Cancel').onclick();
  await flush();
});

test('QA c2: an on-hold card keeps "held 10m" as its own item; the full note is the tooltip', async () => {
  const t = await loaded(build({ entries: { 'claude:a1': H(nowSec() - 600, 'a very long note '.repeat(8)) } }));
  holdToggleOf(t).onclick();
  const note = t.byId.connections.all().find((n) => n.className === 'hold-note');
  assert.ok(note.attrs.title || note.title);
  assert.match(String(note.title), /held 10m$/);
});

test('QA m9: an inline rename, even a blank one, leaves focus on the card', async () => {
  const t = await loaded(build());
  for (const value of ['Beta two', '']) {
    t.ui._openMenu(moreOf(t, 'Beta'), t.conversations[1], 'row');
    menuItem(t, 'Rename').onclick();
    const row = rowButton(t, 'Beta').parentNode;
    const input = row.children.find((n) => n.tagName === 'input');
    input.value = value;
    input.onkeydown({ key: 'Enter', preventDefault() {} });
    assert.equal(t.document.activeElement, row.children[0], 'focus on the card after "' + value + '"');
  }
  assert.deepEqual(plain(t.log.named), [
    ['a2', 'Beta two'],
    ['a2', ''],
  ]);
});

test('the row menu closes on a click anywhere else and on Escape wherever the focus is, before Settings takes the key (QA 4)', async () => {
  const t = await loaded(build({ entries: {} }));
  const alpha = t.conversations[0];
  const isOpen = () => !!t.document.body.all().find((n) => n.attrs.role === 'menu');
  const fire = (type, target, extra = {}) => {
    let stopped = false,
      prevented = false;
    const event = Object.assign(
      { type, target, preventDefault: () => (prevented = true), stopPropagation: () => (stopped = true) },
      extra,
    );
    for (const fn of t.document.listeners[type] || []) fn(event);
    return { stopped, prevented };
  };
  t.ui._openMenu(moreOf(t, 'Alpha'), alpha, 'row');
  assert.equal(isOpen(), true);
  fire('click', t.document.body); // a click with no pointer press first (keyboard, script)
  assert.equal(isOpen(), false, 'a click elsewhere closes it');
  t.ui._openMenu(moreOf(t, 'Alpha'), alpha, 'row');
  const esc = fire('keydown', t.document.body, { key: 'Escape' }); // the focus went elsewhere (Settings' search box)
  assert.equal(isOpen(), false, 'Escape closes the menu');
  assert.deepEqual(esc, { stopped: true, prevented: true }, 'and Settings never sees that Escape');
  assert.deepEqual(fire('keydown', t.document.body, { key: 'Escape' }), { stopped: false, prevented: false }, 'no menu: left alone');
});
