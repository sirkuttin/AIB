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
    this.listeners = {};
    this.open = false;
    this.parentNode = null;
    this.id = '';
    this.title = '';
    this.value = '';
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
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }
  focus() {
    this.ownerDocument.activeElement = this;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls) {
    return this.all().filter((n) => (' ' + n.className + ' ').includes(' ' + cls + ' '));
  }
}

function setup(conversations, extra = {}) {
  const document = { activeElement: null, listeners: {}, title: 'Agent Studio', visibilityState: 'visible' };
  document.createElement = (tag) => new Node(tag, document);
  document.createDocumentFragment = () => new Node('#fragment', document);
  document.addEventListener = (type, fn) => {
    (document.listeners[type] = document.listeners[type] || []).push(fn);
  };
  document.body = new Node('body', document);
  document.getElementById = () => null;
  const store = { 'studio-sidebar-epoch': '1' };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
  const window = { document, localStorage, setTimeout: () => 0 };
  const ctx = { window, Object, Array, String, Number, Promise, Error, Map, Set, Date, JSON, Math, isNaN, RegExp };
  for (const f of ['notify-rules.js', 'sidebar-ui.js', 'organize-ui.js', 'commands-registry.js', 'switcher-ui.js'])
    vm.runInNewContext(fs.readFileSync(require('node:path').join(APP_DIR, f), 'utf8'), ctx);
  const aliases = extra.aliases || {};
  let selected = extra.selected || null;
  const opened = [],
    newChats = [];
  const aliasKey = (c) => c.provider + ':' + c.id;
  const host = {
    conversations: () => conversations,
    aliasKey,
    titleOf: (c) => aliases[aliasKey(c)] || c.title,
    getSelected: () => selected,
    open: (c) => {
      opened.push(aliasKey(c));
      selected = c;
    },
    newInProject: (c) => newChats.push(c ? c.cwd : null),
  };
  window.AgentOrganizeUI.init({ aliasKey, getSelected: () => selected });
  window.AgentSidebarUI.init({ aliasKey, getSelected: () => selected, rerender() {} });
  window.AgentSidebarUI.sync(conversations, selected);
  window.AgentSwitcherUI.init(host);
  return {
    window,
    document,
    ui: window.AgentSwitcherUI,
    opened,
    newChats,
    select: (c) => {
      selected = c;
    },
  };
}
const conv = (provider, id, title, cwd, extra = {}) =>
  Object.assign({ provider, id, title, cwd, key: id, created: 100, modified: 100 }, extra);
const key = (k, extra = {}) =>
  Object.assign(
    {
      key: k,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      target: { tagName: 'BODY' },
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    },
    extra,
  );

test('fuzzy score prefers substrings and word starts, rejects non-subsequences', () => {
  const { ui } = setup([]);
  const s = ui.score;
  assert.ok(s('pars', 'Refactor the parser') > s('pars', 'xxparsxx'));
  assert.ok(s('par', 'the parser') > s('par', 'sepa rated'));
  assert.ok(s('rfp', 'Refactor the parser') > 0, 'subsequence match');
  assert.equal(s('zzz', 'Refactor the parser'), -1);
  assert.equal(s('abc', ''), -1);
});

test('search matches title, alias, project and provider across vendors; every term must match', () => {
  const rows = [
    conv('claude', 'c1', 'Refactor the parser', 'C:\\Repos\\Alpha', { modified: 50 }),
    conv('omp', 'o1', 'Investigate slow build', 'C:\\Repos\\Alpha', { modified: 90 }),
    conv('claude', 'c2', 'Add dark mode', 'C:\\Repos\\Beta', { modified: 70 }),
  ];
  const ctx = setup(rows, { aliases: { 'claude:c2': 'Night theme work' } });
  const find = (q) => {
    ctx.ui.open();
    const input = ctx.document.body.children[0].children[0];
    input.value = q;
    input.listeners.input[0]();
    const out = Array.from(
      ctx.ui
        ._results()
        .filter((r) => r.kind === 'chat')
        .map((r) => r.key),
    );
    ctx.ui.close();
    return out;
  };
  assert.deepEqual(find('parser'), ['claude:c1']);
  assert.deepEqual(find('night'), ['claude:c2'], 'alias is searchable');
  assert.deepEqual(find('dark'), ['claude:c2'], 'the original title is searchable too');
  assert.deepEqual(Array.from(find('alpha')).sort(), ['claude:c1', 'omp:o1'], 'project name');
  assert.deepEqual(find('alpha slow'), ['omp:o1'], 'all terms must match');
  assert.deepEqual(find('omp'), ['omp:o1'], 'provider name');
  assert.deepEqual(find('nothing like this'), []);
});

test('empty query lists recent conversations first and archived ones last, labelled', () => {
  const rows = [
    conv('claude', 'old', 'Old chat', 'C:\\a', { modified: 10 }),
    conv('claude', 'arch', 'Archived chat', 'C:\\a', { modified: 999 }),
    conv('claude', 'new', 'New chat', 'C:\\b', { modified: 500 }),
    conv('claude', 'gone', 'Deleted chat', 'C:\\b', { modified: 1000 }),
  ];
  const ctx = setup(rows);
  ctx.window.AgentOrganizeUI.bucket = (c) => (c.id === 'arch' ? 'archived' : c.id === 'gone' ? 'deleted' : 'main');
  ctx.ui.open();
  assert.deepEqual(
    Array.from(
      ctx.ui
        ._results()
        .filter((r) => r.kind === 'chat')
        .map((r) => r.key),
    ),
    ['claude:new', 'claude:old', 'claude:arch'],
  );
  const dialog = ctx.document.body.children[0];
  const texts = dialog.find('switcher-sub').map((n) => n.textContent);
  assert.ok(texts[2].includes('Archived'));
  assert.ok(!texts[0].includes('Archived'));
});

test('arrow keys move the highlight and Enter opens the conversation', () => {
  const rows = [
    conv('claude', 'a', 'Alpha one', 'C:\\a', { modified: 30 }),
    conv('omp', 'b', 'Beta two', 'C:\\b', { modified: 20 }),
  ];
  const ctx = setup(rows);
  ctx.ui.open();
  const dialog = ctx.document.body.children[0],
    input = dialog.children[0];
  const press = (k) => {
    const e = key(k);
    input.listeners.keydown[0](e);
    return e;
  };
  press('Tab');
  press('Tab'); // Chats only
  assert.equal(dialog.find('switcher-item').length, 2);
  assert.ok(dialog.find('switcher-item')[0].className.includes('active'));
  assert.equal(press('ArrowDown').defaultPrevented, true);
  assert.ok(dialog.find('switcher-item')[1].className.includes('active'));
  press('ArrowDown');
  assert.ok(dialog.find('switcher-item')[0].className.includes('active'), 'wraps');
  press('ArrowUp');
  press('Enter');
  assert.deepEqual(ctx.opened, ['omp:b']);
  assert.equal(dialog.open, false);
});

test('results carry status dots, project, vendor; titles are never HTML', () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const c = conv('claude', 'a', hostile, 'C:\\Repos\\App', { live: { id: 'L', closed: false, busy: true } });
  const ctx = setup([c]);
  ctx.ui.open();
  const dialog = ctx.document.body.children[0];
  assert.equal(dialog.find('switcher-title')[0].textContent, hostile);
  assert.equal(dialog.find('status-dot')[0].attrs['aria-label'], 'Working');
  assert.ok(dialog.find('switcher-sub')[0].textContent.startsWith('App \u00B7 Claude Code'));
});

test('Ctrl+K always works; other shortcuts are ignored while typing', () => {
  const rows = [
    conv('claude', 'a', 'A', 'C:\\a'),
    conv('claude', 'b', 'B', 'C:\\b'),
    conv('claude', 'c', 'C', 'C:\\c'),
  ];
  const ctx = setup(rows, { selected: rows[0] });
  ctx.window.AgentOrganizeUI.visibleKeys = () => rows.map((r) => r.provider + ':' + r.id);
  const typing = { tagName: 'TEXTAREA' };
  assert.equal(ctx.ui.onKey(key('ArrowDown', { altKey: true, target: typing })), false);
  assert.deepEqual(ctx.opened, []);
  assert.equal(ctx.ui.onKey(key('N', { ctrlKey: true, shiftKey: true, target: typing })), false);
  assert.deepEqual(ctx.newChats, []);
  const k = key('k', { ctrlKey: true, target: typing });
  assert.equal(ctx.ui.onKey(k), true);
  assert.equal(k.defaultPrevented, true);
  assert.equal(ctx.document.body.children[0].open, true);
  ctx.ui.close();
});

test('Alt+Down / Alt+Up walk the visible sidebar order; Ctrl+Shift+N starts a chat in the current project', () => {
  const rows = [conv('claude', 'a', 'A', 'C:\\a'), conv('claude', 'b', 'B', 'C:\\b'), conv('omp', 'c', 'C', 'C:\\c')];
  const ctx = setup(rows, { selected: rows[0] });
  ctx.window.AgentOrganizeUI.visibleKeys = () => ['claude:a', 'claude:b', 'omp:c'];
  ctx.ui.onKey(key('ArrowDown', { altKey: true }));
  ctx.ui.onKey(key('ArrowDown', { altKey: true }));
  ctx.ui.onKey(key('ArrowDown', { altKey: true }));
  assert.deepEqual(ctx.opened, ['claude:b', 'omp:c'], 'stops at the end');
  ctx.ui.onKey(key('ArrowUp', { altKey: true }));
  assert.equal(ctx.opened[2], 'claude:b');
  const e = key('N', { ctrlKey: true, shiftKey: true });
  assert.equal(ctx.ui.onKey(e), true);
  assert.deepEqual(ctx.newChats, ['C:\\b']);
  const none = setup(rows);
  none.window.AgentOrganizeUI.visibleKeys = () => ['claude:a', 'claude:b', 'omp:c'];
  none.ui.onKey(key('ArrowDown', { altKey: true }));
  assert.deepEqual(none.opened, ['claude:a'], 'with nothing selected Alt+Down opens the first');
  assert.equal(none.ui.onKey(key('ArrowDown', { altKey: true, ctrlKey: true })), false);
});

// ---- command bar ----------------------------------------------------------------------------
function bar(rows, extra = {}) {
  const ctx = setup(rows, extra);
  const calls = [];
  const O = ctx.window.AgentOrganizeUI;
  O.menuModel = () => (extra.menu || ['rename', 'pin', 'hold', 'archive', 'delete', 'end']).map((id) => ({ id }));
  O.run = (id, c) => calls.push(id + ':' + c.id);
  ctx.window.AgentWorkspaceUI = {
    paletteProjects: () => [
      { key: 'p1', name: 'Alpha', path: 'C:\\a', waiting: 2, active: true },
      { key: 'p2', name: 'Beta', path: 'C:\\b' },
    ],
    openProjectMenu: (o) => calls.push('switch:' + (o && o.filter)),
    openNewProject: () => calls.push('newproject'),
    toggleInbox: () => calls.push('inbox'),
    selectProject: (k) => calls.push('select:' + k),
  };
  if (extra.resize)
    ctx.window.AgentResizeUI = { toggleSide: () => calls.push('side'), toggleActivity: () => calls.push('activity') };
  ctx.calls = calls;
  ctx.ui.open();
  ctx.dialog = ctx.document.body.children[0];
  ctx.input = ctx.dialog.children[0];
  ctx.type = (text) => {
    ctx.input.value = text;
    ctx.input.listeners.input[0]();
  };
  ctx.press = (k, e) => {
    const ev = key(k, e);
    ctx.input.listeners.keydown[0](ev);
    return ev;
  };
  ctx.titles = () => ctx.dialog.find('switcher-title').map((n) => n.textContent);
  return ctx;
}
const two = () => [
  conv('claude', 'a', 'Alpha chat', 'C:\\a', { modified: 30 }),
  conv('omp', 'b', 'Beta chat', 'C:\\b', { modified: 20 }),
];

test('command bar: empty input shows recent chats, then common actions of the open chat', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[0] });
  assert.deepEqual(
    Array.from(
      b.ui
        ._results()
        .slice(0, 2)
        .map((r) => r.kind),
    ),
    ['chat', 'chat'],
  );
  assert.ok(
    b.ui
      ._results()
      .slice(2)
      .every((r) => r.kind === 'action'),
  );
  const titles = b.titles();
  assert.ok(
    titles.includes('Rename this chat') &&
      titles.includes('Hold this chat\u2026') &&
      titles.includes('Switch project\u2026'),
  );
  assert.ok(!titles.includes('Delete this chat'), 'delete is not a common action');
  b.ui.close();
});

test('command bar: Tab cycles All / Actions / Chats / Projects; Shift+Tab goes back', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[0] });
  const modes = [];
  for (let i = 0; i < 4; i++) {
    b.press('Tab');
    modes.push(b.ui._mode());
  }
  assert.deepEqual(modes, ['actions', 'chats', 'projects', 'all']);
  b.press('Tab');
  b.press('Tab');
  b.press('Tab');
  assert.deepEqual(new Set(b.ui._results().map((r) => r.kind)), new Set(['project']));
  assert.equal(b.dialog.find('switcher-tab').filter((n) => n.className.includes('on'))[0].textContent, 'Projects');
  b.press('Tab', { shiftKey: true });
  assert.equal(b.ui._mode(), 'chats');
  b.ui.close();
});

test('command bar: a leading > lists actions only; a project result selects the project', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[0] });
  b.type('>');
  assert.ok(b.ui._results().length > 0 && b.ui._results().every((r) => r.kind === 'action'));
  b.type('> chat');
  assert.ok(b.ui._results().every((r) => r.kind === 'action'));
  b.type('beta');
  const at = b.ui._results().findIndex((r) => r.kind === 'project');
  assert.ok(at >= 0);
  for (let i = 0; i < at; i++) b.press('ArrowDown');
  b.press('Enter');
  assert.deepEqual(b.calls, ['select:p2']);
  assert.equal(b.dialog.open, false);
});

test('command bar: Enter runs the action on the open chat and closes', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[1] });
  b.type('>hold');
  b.press('Enter');
  assert.deepEqual(b.calls, ['hold:b']);
  assert.equal(b.dialog.open, false);
});

test('command bar: Delete and End Studio session need a second Enter; moving or typing disarms', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[0] });
  b.type('>delete');
  b.press('Enter');
  assert.deepEqual(b.calls, [], 'first Enter only arms');
  assert.equal(b.dialog.open, true);
  assert.equal(b.dialog.find('switcher-sub')[0].textContent, 'Press Enter again to delete');
  assert.equal(b.ui._armed(), 'chat:delete');
  b.type('>delet');
  assert.equal(b.ui._armed(), null, 'typing disarms');
  b.press('Enter');
  b.press('ArrowDown');
  b.press('ArrowUp');
  assert.equal(b.ui._armed(), null, 'moving disarms');
  b.press('Enter');
  b.press('Enter');
  assert.deepEqual(b.calls, ['delete:a']);
  const e = bar(rows, { selected: rows[0] });
  e.type('>end studio');
  e.press('Enter');
  assert.deepEqual(e.calls, []);
  assert.equal(e.dialog.find('switcher-sub')[0].textContent, "Press Enter again to end this chat's session");
  e.press('Enter');
  assert.deepEqual(e.calls, ['end:a']);
});

test('command bar: panel and project actions appear only when their module is present', () => {
  const rows = two();
  const without = bar(rows, { selected: rows[0] });
  without.type('>toggle');
  assert.deepEqual(without.titles(), []);
  without.ui.close();
  const withR = bar(rows, { selected: rows[0], resize: true });
  withR.type('>toggle');
  assert.deepEqual(withR.titles().sort(), ['Toggle Activity', 'Toggle chat list']);
  assert.deepEqual(
    withR.dialog
      .find('switcher-key')
      .map((n) => n.textContent)
      .sort(),
    ['Ctrl+Alt+B', 'Ctrl+B'],
  );
  withR.press('Enter');
  assert.equal(withR.calls.length, 1);
  withR.ui.close();
  const noChat = bar(rows);
  noChat.type('>this chat');
  assert.deepEqual(noChat.titles(), [], 'no chat actions without an open chat');
  noChat.type('>new chat in');
  assert.deepEqual(noChat.titles().sort(), ['New chat in Alpha', 'New chat in Beta']);
});

test('command bar: New chat in <project> starts a chat there; Switch project opens the dropdown with its filter', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[0] });
  b.type('>new chat in beta');
  b.press('Enter');
  assert.deepEqual(b.newChats, ['C:\\b']);
  const s = bar(rows, { selected: rows[0] });
  s.type('>switch project');
  s.press('Enter');
  assert.deepEqual(s.calls, ['switch:true']);
});

test('shortcut sheet: ? opens it outside text fields, lists the four groups, ? closes it', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[0], resize: true });
  b.ui.close();
  const typing = key('?', { target: { tagName: 'TEXTAREA' } });
  assert.equal(b.ui.onKey(typing), false);
  assert.equal(b.document.body.children.length, 1, 'not opened while typing');
  const e = key('?');
  assert.equal(b.ui.onKey(e), true);
  assert.equal(e.defaultPrevented, true);
  const sheet = b.document.body.children[1];
  assert.equal(sheet.open, true);
  assert.deepEqual(
    sheet.find('sheet-group').map((g) => g.children[0].textContent),
    ['Moving around', 'This chat', 'Panels', 'Text size'],
  );
  const text = sheet.textContent;
  for (const k of ['Ctrl+K', 'Ctrl+Tab', 'F2', 'Ctrl+B', 'Ctrl+Alt+B', 'Shift+F10']) assert.ok(text.includes(k), k);
  sheet.listeners.keydown[0](key('?', { target: sheet }));
  assert.equal(sheet.open, false);
  assert.equal(b.ui.onKey(key('?', { ctrlKey: true })), false);
});

test('shortcut sheet is also the Keyboard shortcuts action, and Ctrl+K swaps back to the bar', () => {
  const rows = two();
  const b = bar(rows, { selected: rows[0] });
  b.type('keyboard shortcuts');
  b.press('Enter');
  const sheet = b.document.body.children[1];
  assert.equal(sheet.open, true);
  assert.equal(b.dialog.open, false);
  b.ui.onKey(key('k', { ctrlKey: true }));
  assert.equal(sheet.open, false);
  assert.equal(b.dialog.open, true);
});

test('QA m9: choosing a chat in Ctrl+K puts focus in its message box, not on the page body', async () => {
  const rows = [conv('claude', 'a', 'Alpha one', 'C:\a')];
  const ctx = setup(rows);
  const prompt = ctx.document.createElement('textarea');
  prompt.offsetParent = {};
  ctx.document.getElementById = (id) => (id === 'prompt' ? prompt : null);
  ctx.ui.open();
  const dialog = ctx.document.body.children[0],
    input = dialog.children[0];
  input.listeners.keydown[0](key('Tab'));
  input.listeners.keydown[0](key('Tab')); // Chats only
  ctx.document.activeElement = ctx.document.body; // the redraw after opening dropped focus
  input.listeners.keydown[0](key('Enter'));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(ctx.opened, ['claude:a']);
  assert.equal(ctx.document.activeElement, prompt);
});
