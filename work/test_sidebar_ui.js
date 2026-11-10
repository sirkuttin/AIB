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
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
  find(cls) {
    return this.all().filter((n) => (' ' + n.className + ' ').includes(' ' + cls + ' '));
  }
}

function setup({ stored = {}, hidden = false } = {}) {
  const document = { title: 'Agent Studio', visibilityState: hidden ? 'hidden' : 'visible', listeners: {} };
  document.createElement = (tag) => new Node(tag, document);
  document.createDocumentFragment = () => new Node('#fragment', document);
  document.addEventListener = (type, fn) => {
    (document.listeners[type] = document.listeners[type] || []).push(fn);
  };
  const store = Object.assign({}, stored);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
  const window = { document, localStorage, setTimeout: () => 0 };
  const sandbox = { window, Object, Array, String, Number, Promise, Error, Map, Set, Date, JSON, Math, isNaN, RegExp };
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'ownership-ui.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'status-words.js'), 'utf8'), sandbox);
  vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'sidebar-ui.js'), 'utf8'), sandbox);
  return { ui: window.AgentSidebarUI, document, store, window };
}
const aliasKey = (c) => c.provider + ':' + c.id;
const conv = (id, cwd, extra = {}) =>
  Object.assign({ provider: 'claude', id, key: 'k-' + id, title: 't-' + id, cwd, created: 100, modified: 100 }, extra);
const live = (extra = {}) => Object.assign({ id: 'L', closed: false, busy: false, state: 'ready' }, extra);
const init = (ctx, selected = null) => ctx.ui.init({ aliasKey, getSelected: () => selected, rerender() {} });

test('Windows paths differing in case, slashes and trailing separators are one project', () => {
  const { ui } = setup();
  const keys = ['C:\\Repos\\App', 'c:/repos/app/', 'C:\\\\Repos\\\\App\\', '\\\\?\\C:\\Repos\\App'].map(ui.pathKey);
  assert.equal(new Set(keys).size, 1);
  assert.notEqual(ui.pathKey('C:\\Repos\\App'), ui.pathKey('D:\\Repos\\App'));
  assert.notEqual(ui.pathKey('/home/a/App'), ui.pathKey('/home/a/app'), 'POSIX paths are case sensitive');
  assert.equal(ui.pathKey(''), '');
});

test('project names are the last segment; equal names get parent segments; full path is kept for the tooltip', () => {
  const { ui } = setup();
  const names = ui.projectNames([
    'C:\\Repos\\Alpha',
    'c:/repos/alpha/',
    'D:\\Work\\Alpha',
    'C:\\Repos\\Beta',
    '',
    '/srv/x/deep/Gamma',
    '/srv/y/deep/Gamma',
  ]);
  const by = (cwd) => names.get(ui.pathKey(cwd));
  assert.equal(by('C:\\Repos\\Alpha').name, 'Repos/Alpha');
  assert.equal(by('D:\\Work\\Alpha').name, 'Work/Alpha');
  assert.equal(by('C:\\Repos\\Alpha').path, 'C:\\Repos\\Alpha');
  assert.equal(by('C:\\Repos\\Beta').name, 'Beta');
  assert.equal(by('').name, 'No folder');
  assert.equal(by('/srv/x/deep/Gamma').name, 'x/deep/Gamma');
  assert.equal(by('/srv/y/deep/Gamma').name, 'y/deep/Gamma');
});

test('chats with different cwd but one projectRoot share one project, named from projectRoot', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const rows = [
    conv('a', 'C:\\Repos\\App\\.claude\\worktrees\\one', { projectRoot: 'C:\\Repos\\App' }),
    conv('b', 'C:\\Repos\\App\\.claude\\worktrees\\two', { projectRoot: 'c:/repos/app/' }),
  ];
  ctx.ui.sync(rows, null);
  const [pa, pb] = rows.map((r) => ctx.ui.projectOf(r));
  assert.equal(pa.key, pb.key, 'one group');
  assert.equal(pa.name, 'App', 'named from projectRoot, not the worktree folder');
  assert.equal(pa.path, 'C:\\Repos\\App');
  assert.equal(ctx.ui.rootOf(conv('c', 'C:\\x')), 'C:\\x', 'no projectRoot: falls back to cwd');
  assert.equal(ctx.ui.rootOf({ cwd: 'C:\\x', live: { projectRoot: 'C:\\r' } }), 'C:\\r');
});

test('equal cwd and projectRoot group exactly as cwd alone did', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const plain = conv('a', 'C:\\x\\App');
  const both = conv('b', 'C:\\x\\App', { projectRoot: 'C:\\x\\App' });
  ctx.ui.sync([plain, both], null);
  assert.deepEqual(ctx.ui.projectOf(plain), ctx.ui.projectOf(both));
});

test('status uses the server attention object when present', () => {
  const ctx = setup();
  init(ctx);
  const s = (c) => ctx.ui.statusOf(c);
  assert.equal(s(conv('a')).state, 'saved');
  assert.equal(
    s(conv('a', 'C:\\x', { live: live({ attention: { state: 'needs_you', needs: 3, turnEndedAt: null } }) })).needs,
    3,
  );
  assert.match(
    s(conv('a', 'C:\\x', { live: live({ attention: { state: 'needs_you', needs: 3 } }) })).label,
    /Needs you \(3 items\)/,
  );
  assert.equal(s(conv('a', 'C:\\x', { live: live({ attention: { state: 'working', needs: 0 } }) })).state, 'working');
  assert.equal(s(conv('a', 'C:\\x', { live: live({ attention: { state: 'opening', needs: 0 } }) })).state, 'opening');
  assert.equal(s(conv('a', 'C:\\x', { live: live({ attention: { state: 'idle', needs: 0 } }) })).state, 'idle');
  assert.equal(s(conv('a', 'C:\\x', { live: live({ attention: { state: 'closed', needs: 0 } }) })).state, 'saved');
  assert.equal(s(conv('a', 'C:\\x', { live: live({ closed: true, attention: { state: 'working' } }) })).state, 'saved');
  assert.equal(
    s(conv('a', 'C:\\x', { live: live({ attention: { state: 'needs_you', needs: 0 } }) })).needs,
    1,
    'needs-you always counts at least one',
  );
});

test('status falls back to connection fields when attention is absent', () => {
  const ctx = setup();
  init(ctx);
  const s = (live2) => ctx.ui.statusOf(conv('a', 'C:\\x', { live: live(live2) }));
  assert.equal(s({ busy: true }).state, 'working');
  assert.equal(s({}).state, 'idle');
  assert.equal(s({ state: 'opening' }).state, 'opening');
  assert.equal(s({ state: 'input_needed' }).state, 'needs_you');
  assert.equal(s({ elicitations: [{}, {}], state: 'input_needed' }).needs, 2);
  assert.equal(s({ attention: 'garbage', busy: true }).state, 'working');
});

test('finished-unread: a turn that ended after you last viewed the conversation', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1000' } });
  init(ctx);
  const mk = (ended) =>
    conv('a', 'C:\\x', {
      live: live({ attention: { state: 'idle', needs: 0, turnEndedAt: new Date(ended).toISOString() } }),
    });
  assert.equal(ctx.ui.statusOf(mk(500)).state, 'idle', 'ended before this browser first looked');
  assert.equal(ctx.ui.statusOf(mk(5000)).state, 'unread');
  ctx.ui.markViewed(mk(5000), 6000);
  assert.equal(ctx.ui.statusOf(mk(5000)).state, 'idle');
  assert.equal(ctx.ui.statusOf(mk(7000)).state, 'unread', 'a later turn is unread again');
});

test('fallback without turnEndedAt notices busy to idle transitions', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const c = (busy) => conv('a', 'C:\\x', { live: live({ busy }) });
  ctx.ui.sync([c(true)], null);
  assert.equal(ctx.ui.statusOf(c(true)).state, 'working');
  ctx.ui.sync([c(false)], null);
  assert.equal(ctx.ui.statusOf(c(false)).state, 'unread');
  ctx.ui.sync([c(false)], c(false));
  assert.equal(ctx.ui.statusOf(c(false)).state, 'idle', 'looking at it clears it');
});

test('the open conversation is marked viewed only while the page is visible', () => {
  const hidden = setup({ stored: { 'studio-sidebar-epoch': '1' }, hidden: true });
  init(hidden);
  const c = conv('a', 'C:\\x', { live: live() });
  hidden.ui.sync([c], c);
  assert.equal(hidden.ui._viewed()['claude:a'], undefined);
  const shown = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(shown);
  shown.ui.sync([c], c);
  assert.ok(shown.ui._viewed()['claude:a'] > 0);
});

test('last viewed and collapse state survive a reload; broken storage is tolerated', () => {
  const first = setup();
  init(first);
  first.ui.setCollapsed('w:c:/x', true);
  first.ui.markViewed(conv('a', 'C:\\x'), 1234);
  first.ui.sync([], null);
  const saved = Object.assign({}, first.store);
  const again = setup({
    stored: Object.assign({}, saved, { 'studio-last-viewed-v1': JSON.stringify({ 'claude:a': 1234 }) }),
  });
  init(again);
  assert.equal(again.ui.isCollapsed('w:c:/x'), true);
  const bad = setup({
    stored: { 'studio-sidebar-collapsed': '{oops', 'studio-last-viewed-v1': '[]', 'studio-sidebar-group': 'nope' },
  });
  init(bad);
  assert.equal(bad.ui.isGrouping(), true);
  assert.equal(bad.ui.isCollapsed('x'), false);
});

test('tab title shows how many things need you', () => {
  const ctx = setup();
  init(ctx);
  const needs = (n) => conv('n' + n, 'C:\\x', { live: live({ attention: { state: 'needs_you', needs: n } }) });
  ctx.ui.sync([needs(2), needs(1), conv('s', 'C:\\y')], null);
  assert.equal(ctx.document.title, '(3) Agent Studio');
  ctx.ui.sync([conv('s', 'C:\\y')], null);
  assert.equal(ctx.document.title, 'Agent Studio');
  ctx.ui.setBase('Plan · Agent Studio');
  assert.equal(ctx.document.title, 'Plan · Agent Studio');
  ctx.ui.sync([needs(1)], null);
  assert.equal(ctx.document.title, '(1) Plan · Agent Studio');
});

test('groups are sorted by recent activity; rows keep their incoming order', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const rows = [
    conv('a1', 'C:\\Repos\\A', { modified: 50 }),
    conv('b1', 'C:\\Repos\\B', { modified: 900 }),
    conv('a2', 'c:/repos/a/', { modified: 100 }),
    conv('c1', 'C:\\Repos\\C', { modified: 10 }),
  ];
  ctx.ui.sync(rows, null);
  const groups = ctx.ui.groupRows(rows);
  assert.deepEqual(Array.from(groups.map((g) => g.name)), ['B', 'A', 'C']);
  assert.deepEqual(Array.from(groups[1].rows.map((c) => c.id)), ['a1', 'a2']);
  rows.push(conv('c2', 'C:\\Repos\\C', { modified: 1, live: live({ busy: true }) }));
  ctx.ui.sync(rows, null);
  assert.equal(ctx.ui.groupRows(rows)[0].name, 'C', 'a working conversation lifts its project');
});

test('a project shows the most urgent child state and counts', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const rows = [
    conv('a', 'C:\\p', { live: live({ busy: true }) }),
    conv('b', 'C:\\p', { live: live({ attention: { state: 'needs_you', needs: 2 } }) }),
    conv('c', 'C:\\p'),
  ];
  const sum = ctx.ui.summarize(rows);
  assert.equal(sum.state, 'needs_you');
  assert.equal(sum.needs, 2);
  assert.match(sum.label, /2 items need you, 1 working/);
  assert.equal(ctx.ui.summarize([conv('c', 'C:\\p')]).state, 'saved');
  assert.equal(ctx.ui.summarize([conv('a', 'C:\\p', { live: live() })]).state, 'idle');
});

test('project groups render collapsible sections without HTML injection', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const hostile = '<img src=x onerror=alert(1)>';
  const rows = [
    conv('a', 'C:\\Repos\\' + hostile, { title: hostile }),
    conv('b', 'C:\\Repos\\B', { live: live({ attention: { state: 'needs_you', needs: 2 } }) }),
  ];
  ctx.ui.sync(rows, null);
  const nodes = ctx.ui.projectGroups(rows, (c, visible) => {
    const n = ctx.document.createElement('div');
    n.textContent = c.title;
    n.visibleFn = visible;
    return n;
  });
  assert.equal(nodes.length, 2);
  const [first] = nodes;
  const head = first.find('project-head')[0],
    body = first.find('project-rows')[0];
  assert.equal(head.attrs['aria-expanded'], 'true');
  head.onclick();
  assert.equal(body.hidden, true);
  assert.equal(head.attrs['aria-expanded'], 'false');
  assert.equal(
    ctx.ui.isCollapsed(ctx.ui.projectOf(rows.find((c) => c.id === 'b')).key) ||
      ctx.ui.isCollapsed(ctx.ui.projectOf(rows[0]).key),
    true,
  );
  assert.equal(body.children[0].visibleFn(), false, 'rows in a collapsed group are not visible for keyboard focus');
  const urgent = nodes.find((n) => n.find('status-count').length);
  assert.equal(urgent.find('status-count')[0].textContent, '2');
  assert.ok(urgent.find('status-dot')[0].attrs['aria-label'].includes('need'));
  const forced = ctx.ui.projectGroups(rows, (c) => ctx.document.createElement('div'), { forceOpen: true });
  assert.equal(forced[0].find('project-rows')[0].hidden, false, 'search results are never hidden by a collapsed group');
});

test('project groups carry a folder mark and put held chats in their own project under a collapsed On hold line', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const rows = [conv('a', 'C://Repos//A'), conv('b', 'C://Repos//A')];
  const held = [conv('h1', 'C://Repos//A'), conv('h2', 'C://Repos//Only')];
  ctx.ui.sync(rows.concat(held), null);
  const mk = (c) => {
    const n = ctx.document.createElement('div');
    n.textContent = c.title;
    return n;
  };
  const seenBlocks = [];
  const nodes = ctx.ui.projectGroups(rows, (c, visible) => mk(c), {
    held,
    holdBlock: (b) => {
      seenBlocks.push([b.key, b.rows.map((c) => c.id)]);
      const n = ctx.document.createElement('div');
      n.className = 'hold-sub';
      return n;
    },
  });
  assert.equal(nodes.length, 2, 'a project with only held chats still gets a group');
  assert.ok(
    nodes.every((n) => n.find('project-folder').length === 1),
    'every project head has a folder mark',
  );
  const a = nodes.find((n) => n.find('project-name')[0].textContent === 'A'),
    only = nodes.find((n) => n.find('project-name')[0].textContent === 'Only');
  assert.equal(a.find('project-count')[0].textContent, '2', 'the count is active chats only');
  assert.equal(a.find('project-rows')[0].children.length, 3, 'two active chats, then the On hold sub-group');
  assert.equal(a.find('project-rows')[0].children[2].className, 'hold-sub');
  assert.equal(only.find('project-rows')[0].children.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(seenBlocks.map((b) => b[1]).sort())), [['h1'], ['h2']]);
});

test('decorateRow adds an accessible status dot and a project label', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const c = conv('a', 'C:\\Repos\\App', { live: live({ busy: true }) });
  ctx.ui.sync([c], null);
  const mk = () => {
    const d = ctx.document;
    const w = d.createElement('div'),
      b = d.createElement('button'),
      s = d.createElement('small');
    s.className = 'connection-workspace';
    s.textContent = 'App';
    b.append(s, d.createElement('span'));
    w.append(b);
    return { w, s };
  };
  const pinned = mk();
  ctx.ui.decorateRow(pinned.w, c, false);
  assert.equal(pinned.s.textContent, 'App \u00B7 Claude Code');
  assert.equal(pinned.s.title.split('\n')[0], 'C:\\Repos\\App');
  assert.equal(pinned.s.find('status-dot')[0].attrs['aria-label'], 'Working');
  const inside = mk();
  ctx.ui.decorateRow(inside.w, c, true);
  assert.equal(inside.s.textContent, 'Claude Code');
  const saved = mk();
  ctx.ui.decorateRow(saved.w, conv('z', 'C:\\Repos\\App'), true);
  assert.equal(saved.s.find('status-dot').length, 0, 'saved conversations get no dot');
});

test('signature changes with grouping, collapse state and project names only', () => {
  const ctx = setup();
  init(ctx);
  ctx.ui.sync([conv('a', 'C:\\x\\App')], null);
  const base = ctx.ui.signature();
  ctx.ui.sync([conv('a', 'C:\\x\\App')], null);
  assert.equal(ctx.ui.signature(), base);
  ctx.ui.setFlat(true);
  assert.notEqual(ctx.ui.signature(), base);
  ctx.ui.setFlat(false);
  ctx.ui.setCollapsed('k', true);
  assert.notEqual(ctx.ui.signature(), base);
  ctx.ui.setCollapsed('k', false);
  ctx.ui.sync([conv('a', 'C:\\x\\App'), conv('b', 'C:\\y\\App')], null);
  assert.notEqual(ctx.ui.signature(), base, 'a second App renames both');
});

test('shortAge is now while busy, otherwise m/h/d/w; setFlat turns project grouping off', () => {
  const ctx = setup();
  init(ctx);
  const now = 1_000_000_000_000,
    c = (secs) => ({ modified: now / 1000 - secs });
  assert.equal(ctx.ui.shortAge(c(5), { state: 'idle' }, now), 'now');
  assert.equal(ctx.ui.shortAge(c(5 * 60), { state: 'idle' }, now), '5m');
  assert.equal(ctx.ui.shortAge(c(3 * 3600), { state: 'saved' }, now), '3h');
  assert.equal(ctx.ui.shortAge(c(2 * 86400), { state: 'saved' }, now), '2d');
  assert.equal(ctx.ui.shortAge(c(15 * 86400), { state: 'saved' }, now), '2w');
  assert.equal(ctx.ui.shortAge(c(99999), { state: 'working' }, now), 'now');
  assert.equal(ctx.ui.shortAge({}, { state: 'saved' }, now), '');
  assert.equal(ctx.ui.isGrouping(), true);
  const base = ctx.ui.signature();
  ctx.ui.setFlat(true);
  assert.equal(ctx.ui.isGrouping(), false);
  assert.notEqual(ctx.ui.signature(), base);
  ctx.ui.setFlat(false);
  assert.equal(ctx.ui.isGrouping(), true);
});

// ---- status phrase and card rows ------------------------------------------------------------
const phraseOf = (c, opts, ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } })) => {
  init(ctx);
  ctx.ui.sync([c], null);
  return ctx.ui.phrase(c, opts);
};
const att = (state, extra = {}) => live({ attention: Object.assign({ state, needs: 0 }, extra) });

test('phrase: live states use the shared status words', () => {
  assert.equal(phraseOf(conv('a', 'C:\\x'), {}).text, 'Not running');
  assert.equal(phraseOf(conv('a', 'C:\\x'), {}).title, 'No agent is attached. Send a message to start it again.');
  assert.equal(phraseOf(conv('a', 'C:\\x', { live: att('idle') })).text, 'Idle');
  assert.equal(phraseOf(conv('a', 'C:\\x', { live: att('opening') })).text, 'Opening\u2026');
  assert.equal(
    phraseOf(conv('a', 'C:\\x', { live: att('working') })).text,
    'Working',
    'no elapsed time before a minute has passed',
  );
  assert.equal(
    phraseOf(conv('a', 'C:\\x', { live: att('idle', { turnEndedAt: new Date(Date.now() + 1000).toISOString() }) }))
      .text,
    'Your turn',
    'fallback: finished and not viewed',
  );
  assert.equal(
    phraseOf(conv('a', 'C:\\x', { live: att('idle'), recovered: { sessionId: 'a' } })).text,
    'Idle',
    'a live connection wins over a restart record',
  );
});

test('phrase: the conversation yourTurn flag, when present, decides Your turn', () => {
  assert.equal(phraseOf(conv('a', 'C:\\x', { yourTurn: true, live: att('idle') })).text, 'Your turn');
  assert.equal(
    phraseOf(conv('a', 'C:\\x', { live: Object.assign(att('idle'), { yourTurn: true }) })).text,
    'Your turn',
  );
  assert.equal(
    phraseOf(
      conv('a', 'C:\\x', {
        yourTurn: false,
        live: att('idle', { turnEndedAt: new Date(Date.now() + 1000).toISOString() }),
      }),
    ).text,
    'Idle',
    'handled: not your turn any more',
  );
  assert.equal(
    phraseOf(conv('a', 'C:\\x', { yourTurn: true, live: att('working') })).text,
    'Working',
    'a busy agent is Working whatever the mark says',
  );
  assert.equal(
    phraseOf(conv('a', 'C:\\x', { yourTurn: true })).text,
    'Not running',
    'the mark does not matter without an agent',
  );
});

test('phrase: Working shows minutes once the page has seen it busy that long', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const c = conv('a', 'C:\\x', { live: att('working', {}) });
  c.live.busy = true;
  ctx.ui.sync([c], null);
  assert.equal(ctx.ui.phrase(c, { now: Date.now() + 4 * 60000 + 5000 }).text, 'Working \u00B7 4m');
  assert.equal(ctx.ui.phrase(c, { now: Date.now() + 65 * 60000 }).text, 'Working \u00B7 1h 05m');
});

test('phrase: needs you is one word everywhere; the kind and count go in the tooltip', () => {
  const needs = (extra, n) =>
    phraseOf(conv('a', 'C:\\x', { live: Object.assign(att('needs_you', { needs: n }), extra) }));
  for (const p of [
    needs({}, 1),
    needs({ elicitations: [{}] }, 1),
    needs({ auth: { methods: [] } }, 1),
    needs({ elicitations: [{}], auth: {} }, 3),
  ])
    assert.equal(p.text, 'Needs you');
  assert.ok(needs({}, 1).title.includes('(permission)'));
  assert.ok(needs({ elicitations: [{}] }, 1).title.includes('(question)'));
  assert.ok(needs({ auth: { methods: [] } }, 1).title.includes('(sign-in)'));
  assert.ok(needs({ elicitations: [{}], auth: {} }, 3).title.includes('(sign-in +2)'));
  assert.ok(needs({ elicitations: [{}] }, 2).title.includes('(question +1)'));
  assert.equal(needs({}, 1).tone, 'need');
});

test('phrase: ownership verdicts become Elsewhere; Studio ownership hides them', () => {
  const owned = {
    verdict: 'owned_elsewhere',
    reasons: [{ signal: 'announcement', text: 'Another app announced this conversation 43 seconds ago.' }],
  };
  const p = phraseOf(conv('a', 'C:\\x'), { hint: owned });
  assert.equal(p.text, 'Elsewhere \u00B7 Idle');
  assert.equal(p.tone, 'else');
  assert.ok(p.title.includes('43 seconds ago'), 'the evidence is in the tooltip');
  const writing = {
    verdict: 'possibly_active',
    reasons: [{ signal: 'transcript', text: 'Transcript written 5s ago.' }],
  };
  assert.equal(
    phraseOf(conv('a', 'C:\\x'), { hint: writing }).text,
    'Elsewhere \u00B7 Working',
    'recent writes mean it is working',
  );
  assert.equal(
    phraseOf(conv('a', 'C:\\x'), { hint: Object.assign({ working: false }, writing) }).text,
    'Elsewhere \u00B7 Idle',
    'an explicit working flag wins',
  );
  assert.equal(phraseOf(conv('a', 'C:\\x'), { hint: { verdict: 'no_evidence', reasons: [] } }).text, 'Not running');
  assert.equal(phraseOf(conv('a', 'C:\\x', { live: att('idle') }), { hint: owned }).text, 'Idle');
});

test('phrase: restart, failure, reconnecting, agent list and just-written saves', () => {
  const restart = phraseOf(conv('a', 'C:\\x', { recovered: { sessionId: 'a' } }));
  assert.equal(restart.text, 'Not running');
  assert.ok(restart.title.includes('before the server restarted'));
  const failed = conv('a', 'C:\\x', { live: Object.assign(att('idle'), { error: 'spawn failed' }) });
  assert.deepEqual([phraseOf(failed).text, phraseOf(failed).tone], ['Failed', 'bad']);
  assert.equal(phraseOf(conv('a', 'C:\\x', { live: att('working') }), { issue: true }).text, 'Reconnecting\u2026');
  assert.equal(phraseOf(conv('a', 'C:\\x', { source: 'agent' })).text, 'Not running');
  assert.equal(phraseOf(conv('a', 'C:\\x', { modified: Date.now() / 1000 - 20 })).text, 'Not running');
  assert.ok(
    phraseOf(conv('a', 'C:\\x', { modified: Date.now() / 1000 - 20 })).title.includes('not confirmed to be running'),
  );
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  ctx.ui.init({
    aliasKey,
    getSelected: () => null,
    rerender() {},
    ownershipOf: () => ({ verdict: 'owned_elsewhere' }),
    issueFor: () => false,
  });
  assert.equal(
    ctx.ui.phrase(conv('a', 'C:\\x')).text,
    'Elsewhere \u00B7 Idle',
    'the page supplies hints through the host',
  );
});

test('previewOf takes the last user or assistant line; subagentsOf prefers live counts', () => {
  const { ui } = setup();
  assert.equal(ui.previewOf({ last: { kind: 'assistant', text: '\n## Done\nmore' } }), 'Done');
  assert.equal(ui.previewOf({ last: { kind: 'user', text: 'fix the build' } }), 'You: fix the build');
  assert.equal(ui.previewOf({ last: { kind: 'tool', text: 'ls' } }), '');
  assert.equal(ui.previewOf({}), '');
  assert.equal(ui.previewOf({ last: { kind: 'assistant', text: 'x'.repeat(500) } }).length, 160);
  assert.equal(ui.subagentsOf({ subagentCount: 3 }), 3);
  assert.equal(ui.subagentsOf({ subagentCount: 3, live: live({ subagents: { a: {}, b: {} } }) }), 2);
  assert.equal(ui.subagentsOf({}), 0);
});

test('decorateRow builds the card: dot, age, coloured phrase with agent and chip, last message line', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const c = conv('a', 'C:\\Repos\\App', {
    live: live({ busy: true, subagents: { s1: {} } }),
    last: { kind: 'assistant', text: 'Patched the parser' },
    modified: 0,
    created: 0,
  });
  ctx.ui.sync([c], null);
  const d = ctx.document,
    w = d.createElement('div'),
    b = d.createElement('button'),
    s = d.createElement('small');
  s.className = 'connection-workspace';
  b.append(s, d.createElement('span'));
  w.append(b);
  assert.equal(ctx.ui.decorateRow(w, c, true), false);
  const status = b.find('row-status')[0];
  assert.equal(status.find('row-phrase')[0].textContent, 'Working');
  assert.equal(status.find('row-agent')[0].textContent, ' \u00B7 Claude Code');
  assert.equal(status.find('row-chip').length, 0, 'no subagent count on the card');
  assert.ok(status.className.includes('tone-work'));
  assert.equal(b.find('row-line3')[0].textContent, 'Patched the parser');
  assert.equal(b.find('row-project').length, 0, 'no project name under a project heading');
  const loose = d.createElement('div'),
    lb = d.createElement('button'),
    ls = d.createElement('small');
  lb.append(ls);
  loose.append(lb);
  ctx.ui.decorateRow(loose, c, false);
  assert.equal(lb.find('row-project')[0].textContent, 'App \u00B7 ');
  ctx.ui.setFlat(true);
  const one = d.createElement('div'),
    ob = d.createElement('button'),
    os = d.createElement('small');
  ob.append(os);
  one.append(ob);
  ctx.ui.decorateRow(one, c, false);
  assert.equal(ob.find('row-project').length, 0, 'a single-project list never repeats the project name');
});

test('decorateRow puts the hold note on line 3 and omits line 3 when there is nothing to say', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx, null);
  ctx.ui.setFlat(true);
  const c = conv('a', 'C:\\Repos\\App', { last: { kind: 'assistant', text: 'hello' } });
  ctx.ui.sync([c], null);
  const mk = () => {
    const d = ctx.document,
      w = d.createElement('div'),
      b = d.createElement('button'),
      s = d.createElement('small');
    b.append(s);
    w.append(b);
    return { w, b };
  };
  const held = mk();
  assert.equal(ctx.ui.decorateRow(held.w, c, false, { hold: 'waiting on CI \u00B7 held 2h' }), true);
  assert.equal(held.b.find('hold-note')[0].textContent, 'waiting on CI \u00B7 held 2h');
  assert.equal(
    held.b.find('row-preview')[0].textContent,
    'waiting on CI \u00B7 held 2h',
    'the hold note replaces the preview',
  );
  const none = mk();
  ctx.ui.decorateRow(none.w, conv('b', 'C:\\Repos\\App'), false);
  assert.equal(none.b.find('row-line3').length, 0);
});

test('a worktree chat card shows its branch; other cards do not', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const card = (c) => {
    ctx.ui.sync([c], null);
    const d = ctx.document,
      w = d.createElement('div'),
      b = d.createElement('button'),
      s = d.createElement('small');
    s.className = 'connection-workspace';
    b.append(s, d.createElement('span'));
    w.append(b);
    ctx.ui.decorateRow(w, c, true);
    return b.find('row-branch');
  };
  assert.equal(card(conv('a', 'C:\Repos\App', { live: live({}) })).length, 0, 'no branch line for a normal chat');
  const liveChip = card(conv('b', 'C:\wt', { live: live({ worktree: { branch: 'studio/silly-gif', base: 'main' } }) }));
  assert.equal(liveChip.length, 1);
  assert.equal(liveChip[0].textContent, '⎇ studio/silly-gif');
  const saved = card(conv('c', 'C:\wt', { worktree: { branch: 'studio/silly-gif', base: 'main' } }));
  assert.equal(saved[0].textContent, '⎇ studio/silly-gif', 'a saved chat shows the same branch');
});

test('reconnect after a restart (a different live connection) is not a finished turn', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1' } });
  init(ctx);
  const c = (id, busy) => conv('a', 'C:\\x', { live: live({ id, busy }) });
  ctx.ui.sync([c('L1', true)], null);
  ctx.ui.sync([c('L2', false)], null); // the old connection was busy; the new one after the restart is not
  assert.equal(ctx.ui.statusOf(c('L2', false)).state, 'idle');
  ctx.ui.sync([c('L2', true)], null);
  ctx.ui.sync([c('L2', false)], null);
  assert.equal(ctx.ui.statusOf(c('L2', false)).state, 'unread', 'a real turn end on the same connection still counts');
});

test('the sidebar reads and writes the shared stored position, and holds it while the open chat is scrolled up', () => {
  const ctx = setup({ stored: { 'studio-sidebar-epoch': '1000' } });
  const calls = [];
  const store = {};
  ctx.window.AgentReadState = {
    seenAt: (k) => store[k] || 0,
    mark: (k, t) => {
      calls.push(k);
      store[k] = Math.max(store[k] || 0, t);
    },
  };
  let held = true;
  ctx.ui.init({ aliasKey, getSelected: () => null, rerender() {}, holdSeen: () => held });
  const c = conv('a', 'C:\\x', {
    live: live({ attention: { state: 'idle', needs: 0, turnEndedAt: new Date(5000).toISOString() } }),
  });
  assert.equal(ctx.ui.statusOf(c).state, 'unread');
  ctx.ui.sync([c], c);
  assert.equal(calls.length, 0, 'scrolled up in the open chat: not viewed');
  held = false;
  ctx.ui.sync([c], c);
  assert.equal(calls.join(), 'claude:a');
  assert.equal(ctx.ui.statusOf(c).state, 'idle');
});
