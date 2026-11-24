const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const C = require(path.join(APP_DIR, 'changes-ui.js'));

test('hunk headers parse, with default counts and the section text', () => {
  assert.deepEqual(C.parseHunkHeader('@@ -39,6 +41,8 @@ def f():'), {
    oldStart: 39,
    oldLines: 6,
    newStart: 41,
    newLines: 8,
    section: 'def f():',
  });
  assert.deepEqual(C.parseHunkHeader('@@ -1 +1 @@'), {
    oldStart: 1,
    oldLines: 1,
    newStart: 1,
    newLines: 1,
    section: '',
  });
  assert.deepEqual(C.parseHunkHeader('@@ -0,0 +1,2 @@'), {
    oldStart: 0,
    oldLines: 0,
    newStart: 1,
    newLines: 2,
    section: '',
  });
  assert.equal(C.parseHunkHeader('not a header'), null);
  assert.equal(C.parseHunkHeader(null), null);
});
test('rows are numbered on both sides: context counts both, add only new, delete only old', () => {
  const rows = C.hunkRows({
    header: '@@ -39,3 +41,4 @@',
    lines: [' keep', '-gone', '+new1', '+new2', ' tail', '\\ No newline at end of file'],
  });
  assert.deepEqual(
    rows.map((r) => [r.type, r.old, r.new, r.text]),
    [
      ['ctx', 39, 41, 'keep'],
      ['del', 40, null, 'gone'],
      ['add', null, 42, 'new1'],
      ['add', null, 43, 'new2'],
      ['ctx', 41, 44, 'tail'],
      ['note', null, null, 'No newline at end of file'],
    ],
  );
});
test('a broken header numbers from 1 and an empty hunk gives no rows', () => {
  assert.deepEqual(
    C.hunkRows({ header: 'oops', lines: ['+a', ' b'] }).map((r) => [r.old, r.new]),
    [
      [null, 1],
      [1, 2],
    ],
  );
  assert.deepEqual(C.hunkRows({ header: '@@ -1 +1 @@', lines: [] }), []);
  assert.deepEqual(C.hunkRows(null), []);
});
test('the line to open is the first added line, or where text was removed', () => {
  assert.equal(C.openLine({ header: '@@ -39,3 +41,4 @@', lines: [' a', ' b', '+c', ' d'] }), 43);
  assert.equal(C.openLine({ header: '@@ -10,3 +10,2 @@', lines: [' a', '-b', ' c'] }), 11);
  assert.equal(C.openLine({ header: '@@ -5,1 +4,0 @@', lines: ['-x'] }), 4);
  assert.equal(C.openLine({ header: '@@ -0,0 +1,2 @@', lines: ['+a', '+b'] }), 1);
  assert.equal(C.openLine({ header: 'garbage', lines: [] }), 1);
});
test('paths join with the root separator and split into folder and name', () => {
  assert.equal(C.joinPath('C:\\repo', 'src/a.py'), 'C:\\repo\\src\\a.py');
  assert.equal(C.joinPath('C:\\repo\\', 'a.py'), 'C:\\repo\\a.py');
  assert.equal(C.joinPath('/home/me/repo', 'src/a.py'), '/home/me/repo/src/a.py');
  assert.deepEqual(C.splitPath('src/loot/rates.py'), { dir: 'src/loot/', base: 'rates.py' });
  assert.deepEqual(C.splitPath('README.md'), { dir: '', base: 'README.md' });
});
test('status letters, counts and chip text', () => {
  assert.equal(C.statusInfo('U').cls, 'st-U');
  assert.equal(C.statusInfo('zz').letter, 'M');
  assert.equal(C.addText({ added: 12 }), '+12');
  assert.equal(C.addText({ added: 5, partial: true }), '+5+');
  assert.equal(C.delText({ removed: 4 }), '\u22124');
  const data = {
    files: [
      { added: 60, removed: 9 },
      { added: 12, removed: 4 },
      { added: 14, removed: 0 },
      { added: 0, removed: 8 },
    ],
  };
  assert.deepEqual(C.totalsOf(data), { files: 4, added: 86, removed: 21 });
  assert.equal(C.chipText(C.totalsOf(data)), 'Changes \u00b7 4 files +86 \u221221');
  assert.equal(C.chipText({ files: 1, added: 1, removed: 0 }), 'Changes \u00b7 1 file +1 \u22120');
  assert.equal(C.chipText({ files: 0, added: 0, removed: 0 }), '');
  assert.equal(C.chipParts(null), null);
  assert.equal(C.badge(0), '');
  assert.equal(C.badge(4), '4');
  assert.equal(C.badge(250), '250', 'QA M5: the tab shows the true count');
  assert.equal(C.badge(1200), '999+');
  // QA M5: the server's totals count every file, also those on pages not listed yet; unread new files make the count "+N+"
  const paged = {
    git: true,
    files: [{ added: 1 }],
    filesTotal: 361,
    totals: { files: 361, added: 400, removed: 2, partial: true },
  };
  assert.deepEqual(C.totalsOf(paged), { files: 361, added: 400, removed: 2, partial: true });
  assert.equal(C.chipText(C.totalsOf(paged)), 'Changes \u00b7 361 files +400+ \u22122');
  assert.equal(C.moreLeft(paged), 360);
  assert.equal(C.moreText(360), 'Show the next 300 (360 not listed yet)');
  assert.equal(C.moreText(61), 'Show the last 61 (61 not listed yet)');
  assert.equal(C.moreText(0), '');
  assert.equal(C.stripText(3), '3 changed');
  assert.equal(C.stripText(0), '');
});
test('notes explain binary, truncated and empty diffs', () => {
  assert.deepEqual(C.diffNotes({ binary: true, hunks: [] }), ['Binary file: no preview.']);
  assert.match(C.diffNotes({ truncated: true, hunks: [{ header: '@@ -1 +1 @@', lines: ['+a'] }] })[0], /first part/);
  assert.match(C.diffNotes({ hunks: [], status: 'M' })[0], /No line changes/);
  assert.deepEqual(C.diffNotes({ hunks: [{ header: '@@ -1 +1 @@', lines: ['+a'] }] }), []);
  assert.deepEqual(C.diffNotes(null), []);
});
test('file signatures change when the numbers change', () => {
  const a = { path: 'a', status: 'M', added: 1, removed: 0 };
  assert.equal(C.fileSignature(a), C.fileSignature({ ...a }));
  assert.notEqual(C.fileSignature(a), C.fileSignature({ ...a, added: 2 }));
  assert.equal(C.fileSignature(null), '');
});
test('tab state: the widened state changes only by the owner: tabs, a subagent history and a project switch keep it', () => {
  let s = C.tabState(null, { type: 'toggleExpand' });
  assert.deepEqual(s, { tab: 'activity', expanded: false }, 'widen is offered on Changes and Artifacts');
  s = C.tabState(s, { type: 'show', tab: 'changes' });
  s = C.tabState(s, { type: 'toggleExpand' });
  assert.deepEqual(s, { tab: 'changes', expanded: true });
  assert.deepEqual(C.tabState(s, { type: 'show', tab: 'activity' }), { tab: 'activity', expanded: true }, 'leaving Changes keeps it');
  assert.deepEqual(C.tabState(s, { type: 'show', tab: 'docs' }), { tab: 'docs', expanded: true }, 'a doc opening in Docs keeps it');
  assert.deepEqual(C.tabState(s, { type: 'subchat', open: true }), { tab: 'activity', expanded: true });
  assert.deepEqual(C.tabState(s, { type: 'reset' }), { tab: 'activity', expanded: true }, 'a project switch keeps it');
  assert.deepEqual(C.tabState(s, { type: 'subchat', open: false }), s);
  assert.deepEqual(C.tabState(s, { type: 'show', tab: 'bogus' }), s);
  const docs = C.tabState(s, { type: 'show', tab: 'docs' });
  assert.deepEqual(C.tabState(docs, { type: 'toggleExpand' }), { tab: 'docs', expanded: false }, 'the owner can narrow it from any tab');
  assert.deepEqual(C.tabState(docs, { type: 'unwiden' }), { tab: 'docs', expanded: false }, 'dragging the edge ends it');
  assert.deepEqual(C.tabState({ tab: 'docs', expanded: false }, { type: 'toggleExpand' }), { tab: 'docs', expanded: false });
});
test('polling only while Changes is visible; a turn that ends refreshes (owner 2026-11-18)', () => {
  assert.equal(C.shouldPoll({ tab: 'changes', visible: true }), true);
  assert.equal(C.shouldPoll({ tab: 'changes', visible: true, busy: false }), true, 'busy or not: other chats edit the project too');
  assert.equal(C.shouldPoll({ tab: 'activity', visible: true }), false, 'no polling while another tab is showing');
  assert.equal(C.shouldPoll({ tab: 'artifacts', visible: true }), false);
  assert.equal(C.shouldPoll({ tab: 'changes', visible: false }), false, 'no polling while the panel is hidden');
  assert.equal(C.shouldPoll(null), false);
  assert.equal(C.turnEnded(true, false), true);
  assert.equal(C.turnEnded(false, false), false);
  assert.equal(C.turnEnded(false, true), false);
});
test('turnStamp changes when any chat of the project ends a turn, and only then', () => {
  const a = { key: 'claude:a', turnEndedAt: '2026-11-18T10:00:00Z' },
    b = { key: 'claude:b', turnEndedAt: '2026-11-18T10:05:00Z' };
  assert.equal(C.turnStamp([a, b]), C.turnStamp([b, a]), 'the order of the list does not matter');
  assert.notEqual(C.turnStamp([a, b]), C.turnStamp([a, { ...b, turnEndedAt: '2026-11-18T10:06:00Z' }]));
  assert.equal(C.turnStamp([{ key: 'x', turnEndedAt: '' }]), '', 'a chat that never ended a turn adds nothing');
  assert.equal(C.turnStamp(null), '');
});

/* ---- the project's sections ---- */
const sec = (id, kind, over) =>
  Object.assign({ id, kind, name: id, git: true, state: 'active', why: '', expanded: true, counts: { files: 0, added: 0, removed: 0 } }, over);
test('projectTotals counts main (a doc once) and the active worktree sections, never left-over work', () => {
  const main = sec('main', 'main', { counts: { files: 3, added: 10, removed: 2 } });
  const r = {
    main,
    sections: [sec('s1', 'subagent', { counts: { files: 2, added: 5, removed: 1, partial: true } }), sec('s2', 'helper', { counts: { files: 1, added: 1, removed: 0 } })],
    left: [sec('l1', 'subagent', { state: 'left', counts: { files: 9, added: 90, removed: 9 } })],
  };
  assert.deepEqual(C.projectTotals(r), { files: 6, added: 16, removed: 3, partial: true });
  const docs = [{ doc: 'plan', dir: 'd', title: 'P', pages: 2, paths: ['d/a', 'd/b'] }];
  const withDocs = { ...r, main: { ...main, changes: { git: true, files: [{ path: 'd/a' }, { path: 'd/b' }, { path: 'x' }], docs, totals: { files: 3 } } } };
  assert.equal(C.projectTotals(withDocs).files, 5, 'two pages of a doc are one row');
  assert.deepEqual(C.projectTotals(null), { files: 0, added: 0, removed: 0 });
  assert.deepEqual(C.projectTotals({ main: { git: false }, sections: [] }), { files: 0, added: 0, removed: 0 });
});
test('section heads: counts, the sub-line names the parent chat and branch, a left-over one says why', () => {
  const s = sec('s1', 'subagent', { branch: 'studio/sub-1', counts: { files: 1, added: 4, removed: 0 } });
  assert.deepEqual(C.sectionSum(s), { files: '1 file', added: '+4', removed: '−0', n: 1 });
  assert.equal(C.sectionSub(s, 'Fix login'), 'Subagent of “Fix login” · studio/sub-1');
  assert.equal(C.sectionSub(s, ''), 'Subagent · studio/sub-1');
  assert.equal(C.sectionSub(sec('h1', 'helper', { provider: 'codex', branch: 'studio/helper-1' }), 'Main'), 'Helper (codex) of “Main” · studio/helper-1');
  assert.equal(C.sectionSub(sec('main', 'main', { branch: 'main' }), ''), 'Branch main');
  assert.match(C.sectionSub(sec('l', 'subagent', { state: 'left', why: 'stopped', branch: 'b' }), 'Chat'), /Stopped before its work landed$/);
  assert.match(C.sectionSub(sec('l', 'subagent', { state: 'left', why: 'kept' }), ''), /Files kept in its worktree$/);
});
test('folding: a section is open unless folded, a left-over one folded unless unfolded; only real ids are kept', () => {
  const act = sec('s1', 'subagent'),
    left = sec('l1', 'subagent', { state: 'left' });
  assert.equal(C.wantOpen(act, new Set(), new Set()), true);
  assert.equal(C.wantOpen(act, new Set(['s1']), new Set()), false);
  assert.equal(C.wantOpen(left, new Set(), new Set()), false);
  assert.equal(C.wantOpen(left, new Set(), new Set(['l1'])), true);
  assert.deepEqual(C.foldQuery(new Set(['b', 'a']), new Set(['l1'])), { fold: 'a,b', unfold: 'l1' });
  assert.deepEqual(C.foldQuery(null, null), { fold: '', unfold: '' });
  const r = { main: act, sections: [act], left: [left] };
  assert.deepEqual([...C.keepIds(new Set(['s1', 'gone', 'main']), r)].sort(), ['main', 's1']);
});

/* ---- accordion helpers ---- */
test('toggleOpen adds then removes a path, pruneOpen drops files that left the list', () => {
  let o = C.toggleOpen([], 'a');
  o = C.toggleOpen(o, 'b');
  assert.deepEqual(o, ['a', 'b']);
  assert.deepEqual(C.toggleOpen(o, 'a'), ['b']);
  assert.deepEqual(C.pruneOpen(['a', 'b', 'c'], [{ path: 'b' }, { path: 'c' }]), ['b', 'c']);
  assert.deepEqual(C.pruneOpen(null, null), []);
});

/* ---- accordion in a small fake DOM ---- */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.hidden = false;
    this.scrollTop = 0;
    this.style = {};
    this.id = '';
    const self = this;
    this.classList = {
      add: (c) => {
        if (!self.className.split(' ').includes(c)) self.className = (self.className + ' ' + c).trim();
      },
      remove: (c) => {
        self.className = self.className
          .split(' ')
          .filter((x) => x && x !== c)
          .join(' ');
      },
      contains: (c) => self.className.split(' ').includes(c),
      toggle: (c, on) => {
        (on === undefined ? !self.classList.contains(c) : on) ? self.classList.add(c) : self.classList.remove(c);
      },
    };
  }
  _adopt(n) {
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((x) => x !== n);
    n.parentNode = this;
    return n;
  }
  append(...n) {
    for (const x of n) {
      if (x.isFrag) {
        for (const c of x.children) this.children.push(this._adopt(c));
        x.children = [];
      } else this.children.push(this._adopt(x));
    }
  }
  replaceChildren(...n) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this.append(...n);
  }
  insertBefore(n, ref) {
    this._adopt(n);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(n);
    else this.children.splice(i, 0, n);
    return n;
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const s = this.parentNode.children;
    return s[s.indexOf(this) + 1] || null;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  addEventListener(t, f) {
    (this.listeners[t] = this.listeners[t] || []).push(f);
  }
  click() {
    if (this.onclick) this.onclick({});
    for (const f of this.listeners.click || []) f({ stopPropagation() {}, preventDefault() {} });
  }
  focus() {
    if (this.ownerDoc) this.ownerDoc.activeElement = this;
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
    this.parentNode = null;
  }
  key(k) {
    for (const f of this.listeners.keydown || []) f({ key: k, preventDefault() {}, stopPropagation() {} });
  }
  contains(n) {
    for (let x = n; x; x = x.parentNode) if (x === this) return true;
    return false;
  }
  walk(fn) {
    fn(this);
    for (const c of this.children) c.walk(fn);
  }
  all() {
    const out = [];
    this.walk((n) => out.push(n));
    return out;
  }
  matches(sel) {
    return sel.startsWith('.') ? this.classList.contains(sel.slice(1)) : this.tagName === sel.toUpperCase();
  }
  querySelectorAll(sel) {
    return this.all().filter((n) => n !== this && n.matches(sel));
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  get offsetParent() {
    return {};
  }
}
const FILES = [
  { path: 'src/a.js', status: 'M', added: 3, removed: 1 },
  { path: 'src/b.js', status: 'M', added: 2, removed: 0 },
  { path: 'c.txt', status: 'U', added: 1, removed: 0 },
];
const DIFF = (p) => ({
  abs: '/r/' + p,
  hunks: [{ header: '@@ -1,2 +1,3 @@', lines: [' keep', '+added ' + p, ' tail'] }],
});
const sums = (files) => ({
  files: files.length,
  added: files.reduce((a, f) => a + f.added, 0),
  removed: files.reduce((a, f) => a + f.removed, 0),
});
/* One worktree of the project: opts.sections / opts.left are [{id, kind, name, files, ...}]. */
function setup(opts) {
  opts = opts || {};
  const calls = [],
    posts = [],
    intervals = new Map();
  let files = opts.files || FILES,
    sections = opts.sections || [],
    left = opts.left || [],
    next = 1;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const section = (s, open) => {
    const c = sums(s.files);
    const out = {
      id: s.id,
      kind: s.kind || 'subagent',
      name: s.name || s.id,
      parent: s.parent || { live: 'chat1', lasting: 'claude:one' },
      provider: s.provider || '',
      branch: s.branch || 'studio/' + s.id,
      state: s.state || 'active',
      why: s.why || '',
      working: !!s.working,
      expanded: open,
      git: true,
      counts: c,
    };
    if (open) out.changes = { git: true, scope: 'branch', root: '/w/' + s.id, prefix: '', files: s.files, filesTotal: s.files.length, totals: c, truncated: false };
    return out;
  };
  const fetchImpl = async (url, init) => {
    calls.push(url);
    if (init && init.method === 'POST') posts.push([url, JSON.parse(init.body)]);
    if (url.includes('/bootstrap')) return ok({ token: 't' });
    if (url.includes('/changes/file')) {
      if (opts.hold) await opts.hold;
      if (opts.fail) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return ok(DIFF(decodeURIComponent(/path=([^&]*)/.exec(url)[1])));
    }
    if (opts.paged && url.includes('/api/live/project/changes?') && /[?&]only=main/.test(url)) {
      // main's next page, asked of the project route (never the per-chat one: that is the open chat's own folder)
      const off = Number((/offset=(\d+)/.exec(url) || [0, 0])[1]),
        all = opts.paged,
        part = { git: true, files: all.slice(off, off + 300), filesTotal: all.length, offset: off, totals: sums(all), truncated: off + 300 < all.length };
      return ok({ git: true, main: { id: 'main', changes: part }, sections: [], left: [] });
    }
    if (url.includes('/api/live/project/changes?')) {
      const q = new URLSearchParams(url.split('?')[1]),
        fold = new Set((q.get('fold') || '').split(',').filter(Boolean)),
        unfold = new Set((q.get('unfold') || '').split(',').filter(Boolean));
      const all = opts.paged || files;
      const first = opts.paged ? all.slice(0, 300) : all;
      const c = sums(all);
      const main = {
        id: 'main',
        kind: 'main',
        name: 'Project folder',
        parent: null,
        provider: '',
        branch: 'main',
        state: 'active',
        why: '',
        working: false,
        expanded: true,
        git: true,
        counts: c,
        changes: { git: true, scope: 'uncommitted', root: '/r', prefix: '', files: first, filesTotal: all.length, totals: c, offset: 0, truncated: first.length < all.length },
      };
      if (opts.docs) main.changes.docs = opts.docs;
      return ok({
        git: true,
        main,
        sections: sections.map((s) => section(s, !fold.has(s.id))),
        left: left.map((s) => section({ ...s, state: 'left' }, unfold.has(s.id))),
      });
    }
    return ok({ git: true, files });
  };
  const ids = {};
  const doc = { activeElement: null };
  const mk = (t) => {
    const e = new El(t);
    e.ownerDoc = doc;
    return e;
  };
  doc.createElement = mk;
  doc.createTextNode = (t) => {
    const e = mk('#text');
    e._text = String(t);
    return e;
  };
  doc.createDocumentFragment = () => {
    const f = mk('#frag');
    f.isFrag = true;
    return f;
  };
  doc.getElementById = (id) => ids[id] || null;
  doc.addEventListener = () => {};
  doc.body = mk('body');
  doc.querySelector = (sel) => doc.body.querySelector(sel);
  for (const id of ['subagentsPane', 'activityStrip', 'chat']) {
    ids[id] = mk('div');
    ids[id].id = id;
    doc.body.append(ids[id]);
  }
  ids.activityBody = mk('div');
  ids.subagentsPane.append(ids.activityBody);
  const win = {
    document: doc,
    fetch: fetchImpl,
    localStorage: { getItem: () => null },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    innerWidth: 1400,
    addEventListener() {},
    setInterval: (fn, ms) => {
      const id = next++;
      intervals.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  };
  C.init(win);
  C.sync({ id: 'chat1', busy: false, titleFor: (k) => ({ 'chat1': 'Fix login', 'claude:one': 'Fix login' })[k] || '' });
  return {
    calls,
    posts,
    win,
    ids,
    intervals,
    setFiles: (f) => {
      files = f;
    },
    setSections: (s, l) => {
      sections = s;
      if (l) left = l;
    },
    ui: () => C._live(),
    list: () => ids.subagentsPane.querySelector('.cg-project'),
    secs: () => ids.subagentsPane.querySelector('.cg-project').all().filter((n) => n.dataset && n.dataset.sec && n.dataset.sec !== 'left' && n.tagName === 'SECTION'),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const rows = (t) => t.list().querySelectorAll('.cg-file');
const secRows = (s) => s.querySelectorAll('.cg-file');
const heads = (t) => t.list().querySelectorAll('.cg-sec-head');
const diffCalls = (t) => t.calls.filter((u) => u.includes('/changes/file')).length;
const reads = (t) => t.calls.filter((u) => u.includes('/api/live/project/changes?'));
const reload = async (t) => {
  t.ui().show('activity');
  t.ui().show('changes');
  await flush();
};
const SUBS = [
  { id: 's1', name: 'Port the parser', files: [{ path: 'pkg/p.js', status: 'M', added: 7, removed: 2 }, { path: 'pkg/q.js', status: 'U', added: 4, removed: 0 }], working: true },
  { id: 's2', name: 'Check the docs', files: [{ path: 'docs/x.md', status: 'M', added: 1, removed: 1 }] },
];

test('accordion: rows are buttons with a caret and aria-expanded; the first file opens by default and has no separate heading', async () => {
  const t = setup();
  t.ui().show('changes');
  await flush();
  const rs = rows(t);
  assert.equal(rs.length, 3);
  assert.ok(rs.every((r) => r.tagName === 'BUTTON' && r.attrs['aria-expanded'] !== undefined));
  assert.equal(rs[0].attrs['aria-expanded'], 'true');
  assert.equal(rs[1].attrs['aria-expanded'], 'false');
  assert.ok(rs[0].textContent.startsWith('▾'));
  assert.ok(rs[1].textContent.startsWith('▸'));
  assert.equal(t.list().all().filter((n) => /cg-diff-head|cg-diff-path/.test(n.className)).length, 0);
  const d = t.list().querySelector('.cg-diff');
  assert.ok(d);
  assert.ok(rs[0].parentNode.contains(d));
  assert.ok(d.querySelector('.cg-hunk'));
});
test('accordion: clicking toggles a file, several can be open, a diff is fetched only on first open', async () => {
  const t = setup();
  t.ui().show('changes');
  await flush();
  assert.equal(diffCalls(t), 1);
  rows(t)[1].click();
  await flush();
  assert.deepEqual(t.ui().open(), ['src/a.js', 'src/b.js']);
  assert.equal(diffCalls(t), 2);
  assert.equal(t.list().querySelectorAll('.cg-diff').length, 2);
  rows(t)[1].click();
  await flush();
  assert.deepEqual(t.ui().open(), ['src/a.js']);
  assert.equal(rows(t)[1].attrs['aria-expanded'], 'false');
  rows(t)[1].click();
  await flush();
  assert.equal(diffCalls(t), 2);
  rows(t)[0].click();
  await flush();
  assert.equal(rows(t)[0].attrs['aria-expanded'], 'false');
  assert.equal(t.list().querySelectorAll('.cg-diff').length, 1);
});
test('accordion: open state survives a refresh while the file is listed and is dropped when it leaves', async () => {
  const t = setup();
  t.ui().show('changes');
  await flush();
  rows(t)[2].click();
  await flush();
  const before = diffCalls(t);
  await reload(t);
  assert.deepEqual(t.ui().open(), ['src/a.js', 'c.txt']);
  assert.equal(rows(t)[2].attrs['aria-expanded'], 'true');
  assert.equal(diffCalls(t), before);
  t.setFiles([FILES[0], FILES[1]]);
  await reload(t);
  assert.deepEqual(t.ui().open(), ['src/a.js']);
  assert.equal(rows(t).length, 2);
});
test('accordion: an open file whose numbers changed is read again; a closed one is not', async () => {
  const t = setup();
  t.ui().show('changes');
  await flush();
  const before = diffCalls(t);
  t.setFiles([FILES[0], { ...FILES[1], added: 9 }, FILES[2]]);
  await reload(t);
  assert.equal(diffCalls(t), before);
  t.setFiles([{ ...FILES[0], added: 7 }, FILES[1], FILES[2]]);
  await reload(t);
  assert.equal(diffCalls(t), before + 1);
});
test('accordion: a Loading line while reading, an error line when it fails', async () => {
  let release;
  const hold = new Promise((r) => {
    release = r;
  });
  const t2 = setup({ hold });
  t2.ui().show('changes');
  await flush();
  assert.ok(t2.list().textContent.includes('Loading'));
  release();
  await flush();
  assert.ok(!t2.list().textContent.includes('Loading'));
  assert.ok(t2.list().querySelector('.cg-hunk'));
  const t = setup({ fail: true });
  t.ui().show('changes');
  await flush();
  const msg = t.list().querySelector('.cg-msg');
  assert.ok(msg);
  assert.match(msg.textContent, /Could not read this diff: boom/);
});

test('the project: main first, then one section per active worktree, each head with name, parent chat, branch and counts', async () => {
  const t = setup({ sections: SUBS });
  t.ui().show('changes');
  await flush();
  const secs = t.secs();
  assert.deepEqual(secs.map((s) => s.dataset.sec), ['main', 's1', 's2']);
  assert.deepEqual(secs.map((s) => secRows(s).length), [3, 2, 1], "main's files are not repeated in the worktree sections");
  const head = (s) => s.querySelector('.cg-sec-head').textContent.replace(/\s+/g, ' ').trim();
  assert.match(head(secs[0]), /^▾Project folder3 files \+6 −1$/);
  assert.match(head(secs[1]), /^▾Port the parser2 files \+11 −2$/);
  assert.match(head(secs[2]), /^▾Check the docs1 file \+1 −1$/);
  assert.equal(secs[1].querySelector('.cg-sec-sub').textContent, 'Subagent of “Fix login” · studio/s1');
  assert.equal(secs[0].querySelector('.cg-sec-sub').textContent, 'Branch main');
  assert.equal(t.ids.subagentsPane.querySelector('.cg-scope').textContent, 'Project');
  assert.equal(t.ids.subagentsPane.querySelector('.cg-sum').textContent.replace(/\s+/g, ' ').trim(), '6 files +18 −4', 'the bar counts the project');
});
test('the header chip, the tab badge and the narrow strip count the project, not one chat', async () => {
  const t = setup({ sections: SUBS });
  await flush();
  const pane = t.ids.subagentsPane;
  assert.equal(pane.querySelector('.pane-badge').textContent, '6');
  assert.equal(pane.querySelector('.pane-badge').hidden, false);
  assert.equal(C.chipText(C.projectTotals(t.ui().project())), 'Changes · 6 files +18 −4');
  assert.equal(t.ui().project().sections.length, 2);
});
test('a worktree file is asked by its section id, never by a path; main keeps its own route', async () => {
  const t = setup({ sections: SUBS });
  t.ui().show('changes');
  await flush();
  const s1 = t.secs()[1];
  secRows(s1)[0].click();
  await flush();
  const asked = t.calls.filter((u) => u.includes('/api/live/project/changes/file') && !u.includes('section=main'));
  assert.equal(asked.length, 1);
  assert.ok(/section=s1/.test(asked[0]) && /path=pkg%2Fp\.js/.test(asked[0]), asked[0]);
  assert.ok(!/scope=|cwd=|folder=/.test(asked[0]), 'no scope, no folder, no raw path of the worktree');
  assert.ok(t.secs()[1].querySelector('.cg-hunk'), 'its diff opens under its row');
  assert.equal(t.calls.filter((u) => /\/api\/live\/changes\/file\?/.test(u)).length, 0, "no per-chat route: that is the open chat's own folder");
  assert.equal(t.calls.filter((u) => /project\/changes\/file\?.*section=main/.test(u)).length, 1, "main's first file opened by default, from the project route");
});
test('folding: a folded section keeps only its head, the next read asks for counts only, unfolding reads its files', async () => {
  const t = setup({ sections: SUBS });
  t.ui().show('changes');
  await flush();
  t.secs()[1].querySelector('.cg-sec-head').click(); // fold s1
  await flush();
  assert.equal(secRows(t.secs()[1]).length, 0);
  assert.equal(t.secs()[1].querySelector('.cg-sec-head').attrs['aria-expanded'], 'false');
  assert.ok(t.secs()[1].querySelector('.cg-sec-head').textContent.includes('2 files'), 'the numbers stay on the head');
  await reload(t);
  assert.ok(/fold=s1/.test(reads(t).at(-1)), reads(t).at(-1));
  assert.equal(secRows(t.secs()[1]).length, 0, 'still folded');
  assert.equal(t.ui().project().sections[0].changes, undefined, 'the reply had its counts only');
  t.secs()[1].querySelector('.cg-sec-head').click(); // unfold
  await flush();
  assert.equal(secRows(t.secs()[1]).length, 2);
  assert.ok(!/fold=s1/.test(reads(t).at(-1)));
});
test('Left over: a group only when there is left-over work, open for a short list, folded for a long one; unfold a section to see its files', async () => {
  const none = setup({ sections: SUBS });
  none.ui().show('changes');
  await flush();
  assert.equal(none.list().querySelector('.cg-left'), null, 'no group without left-over work');
  const L = [{ id: 'l1', name: 'Old refactor', files: [{ path: 'old.js', status: 'M', added: 5, removed: 0 }], why: 'stopped' }];
  const t = setup({ sections: SUBS, left: L });
  t.ui().show('changes');
  await flush();
  const group = t.list().querySelector('.cg-left');
  assert.ok(group);
  const gh = group.querySelector('.cg-left-head');
  assert.equal(gh.textContent, '▾Left over (1)');
  assert.equal(gh.attrs['aria-expanded'], 'true');
  assert.equal(group.querySelectorAll('.cg-sec').length, 1, 'a short list is open: its rows show');
  assert.equal(t.secs().length, 4, 'the 3 sections plus the one left-over row');
  const many = Array.from({ length: 6 }, (_, i) => ({ id: 'm' + i, name: 'Old ' + i, files: [{ path: 'o' + i + '.js', status: 'M', added: 1, removed: 0 }], why: 'stopped' }));
  const long = setup({ sections: SUBS, left: many });
  long.ui().show('changes');
  await flush();
  const lh = long.list().querySelector('.cg-left').querySelector('.cg-left-head');
  assert.equal(lh.textContent, '▸Left over (6)');
  assert.equal(lh.attrs['aria-expanded'], 'false');
  assert.equal(long.list().querySelector('.cg-left').querySelectorAll('.cg-sec').length, 0, 'a long list is folded: nothing below the head');
  lh.click();
  assert.equal(long.list().querySelector('.cg-left').querySelectorAll('.cg-sec').length, 6, 'the caret unfolds it');
  const sec = t.list().querySelector('.cg-left').querySelector('.cg-sec');
  assert.ok(sec);
  assert.equal(sec.querySelector('.cg-sec-head').attrs['aria-expanded'], 'false', 'its section is folded too');
  assert.match(sec.querySelector('.cg-sec-sub').textContent, /Stopped before its work landed/);
  assert.equal(secRows(sec).length, 0);
  assert.match(t.list().querySelector('.cg-left').textContent, /never reached the project folder/);
  sec.querySelector('.cg-sec-head').click();
  await flush();
  assert.ok(/unfold=l1/.test(reads(t).at(-1)), reads(t).at(-1));
  assert.equal(secRows(t.list().querySelector('.cg-left')).length, 1);
  assert.equal(C.projectTotals(t.ui().project()).files, 6, 'left-over work is not in the project count');
  assert.equal(t.list().querySelectorAll('button').filter((b) => /merge|discard|commit/i.test(b.textContent)).length, 0, 'no Merge or Discard');
});
test('refresh rule: no timer while the Changes tab is hidden; every 10 s while it shows; a turn that ends reads at once', async () => {
  const t = setup();
  await flush();
  assert.equal(t.intervals.size, 0, 'Activity is showing: nothing polls');
  const base = reads(t).length;
  t.ui().show('changes');
  await flush();
  assert.equal(t.intervals.size, 1);
  assert.equal([...t.intervals.values()][0].ms, 10000);
  const n = reads(t).length;
  [...t.intervals.values()][0].fn();
  await flush();
  assert.equal(reads(t).length, n + 1, 'a tick reads the project');
  t.ui().show('artifacts');
  assert.equal(t.intervals.size, 0, 'another tab: the timer is gone');
  t.ui().show('activity');
  assert.equal(t.intervals.size, 0);
  const before = reads(t).length;
  // another chat of the project ended its turn: the numbers refresh at once (the chips count the project), whichever tab shows
  C.turns('p1', '');
  C.turns('p1', 'claude:b=2026-11-18T10:00:00Z');
  await flush();
  assert.equal(reads(t).length, before + 1);
  C.turns('p1', 'claude:b=2026-11-18T10:00:00Z');
  await flush();
  assert.equal(reads(t).length, before + 1, 'the same stamp again reads nothing');
  assert.ok(base >= 0);
});
test('moving to another chat of the project changes nothing on screen and reads nothing new; the open chat ending a turn reads', async () => {
  const t = setup({ sections: SUBS });
  t.ui().show('changes');
  await flush();
  const shown = t.list().textContent,
    n = reads(t).length;
  C.sync({ id: 'chat2', busy: false, titleFor: (k) => ({ chat1: 'Fix login', 'claude:one': 'Fix login' })[k] || '' });
  assert.equal(t.list().textContent, shown, 'the same sections at once');
  await flush();
  assert.equal(t.secs().length, 3);
  C.sync({ id: 'chat2', busy: true });
  C.sync({ id: 'chat2', busy: false });
  await flush();
  assert.ok(reads(t).length > n, 'its turn ended: refreshed');
});

/* The panel is read-only: the one footer line, no buttons, for every kind of section. */
const noButtons = (pane) => {
  assert.equal(pane.querySelector('.cg-merge-btn'), null, 'no Merge button');
  assert.equal(pane.querySelector('.cg-discard'), null, 'no Discard button');
  assert.equal(pane.querySelector('.cg-foot').querySelectorAll('button').length, 0, 'nothing to click in the footer');
};
test('the footer: one fixed read-only line that points at the agent, and no Merge or Discard anywhere', async () => {
  const t = setup({ sections: SUBS });
  t.ui().show('changes');
  await flush();
  const pane = t.ids.subagentsPane;
  const line = pane.querySelector('.cg-foot-folder');
  assert.equal(pane.querySelector('.cg-foot').hidden, false);
  assert.equal(line.textContent, C.FOLDER_FOOT);
  assert.match(C.FOLDER_FOOT, /from any chat/);
  noButtons(pane);
  assert.ok(t.posts.every((p) => !/worktree|merge|discard/.test(p[0])), 'nothing merges or discards');
});

/* ---- QA right column: paging ---- */
const many = (n) =>
  Array.from({ length: n }, (_, i) => ({
    path: 'f' + String(i).padStart(4, '0') + '.txt',
    status: 'U',
    added: 1,
    removed: 0,
  }));
const pane = (t) => t.ids.subagentsPane;

test('QA M5: every file is reachable: "Show the last 61" lists the next page, and the tab counts all files', async () => {
  const t = setup({ paged: many(361) });
  t.ui().show('changes');
  await flush();
  assert.equal(rows(t).length, 300);
  const more = pane(t).querySelector('.cg-more');
  assert.ok(more, 'a button lists the rest');
  assert.equal(more.textContent, 'Show the last 61 (61 not listed yet)');
  assert.equal(pane(t).querySelector('.pane-badge').textContent, '361');
  more.click();
  await flush();
  assert.ok(t.calls.some((u) => u.includes('offset=300') && u.includes('/api/live/project/changes?') && u.includes('only=main')));
  assert.ok(!t.calls.some((u) => /\/api\/live\/changes\?/.test(u)), 'never the per-chat route');
  assert.equal(rows(t).length, 361);
  assert.ok(rows(t).some((r) => r.dataset.path === 'f0360.txt'), 'the last file is listed');
  assert.equal(pane(t).querySelector('.cg-more'), null);
  await reload(t);
  assert.equal(rows(t).length, 361, 'a refresh keeps the pages you opened');
});

test('local docs: a doc is one row "2 pages changed" (its files are not listed), the tab counts it once', async () => {
  const docPaths = ['docs/plan/doc.aibdoc', 'docs/plan/01-overview.md', 'docs/plan/02-risks.md'];
  const files = docPaths.map((p) => ({ path: p, status: 'M', added: 2, removed: 1 })).concat([{ path: 'docs/README.md', status: 'M', added: 1, removed: 0 }]);
  const docs = [{ doc: 'plan', dir: 'docs/plan', title: 'Release plan', pages: 2, paths: docPaths }];
  const t = setup({ files, docs });
  const opened = [];
  t.win.AgentDocLinks = { openDoc: (o) => opened.push(o) };
  t.ui().show('changes');
  await flush();
  const rs = rows(t);
  assert.equal(rs.length, 2, 'one doc row and docs/README.md');
  assert.ok(rs[0].classList.contains('cg-doc-btn'));
  assert.match(rs[0].textContent, /Release plan/);
  assert.match(rs[0].textContent, /2 pages changed/);
  assert.equal(rs[1].dataset.path, 'docs/README.md', "a user's docs/README.md stays a file row");
  assert.deepEqual(t.ui().files().map((f) => f.path), ['docs/README.md']);
  assert.equal(C.shownCount({ git: true, files, docs }), 2);
  assert.equal(pane(t).querySelector('.pane-badge').textContent, '2');
  rs[0].click();
  assert.deepEqual(opened.map((o) => [o.name, o.from]), [['plan', 'chat']]);
  noButtons(pane(t));
});

test('the right-column tab is the project\'s: another chat of the project keeps it, each project (per window) keeps its own, and a reload brings it back (owner 2026-11-18)', async () => {
  const t = setup();
  const pane = t.ids.subagentsPane;
  const saved = new Map();
  t.win.localStorage = { getItem: (k) => (saved.has(k) ? saved.get(k) : null), setItem: (k, v) => saved.set(k, String(v)) };
  t.win.AibStore = { winKey: (k) => k + ':w2', layoutWritable: () => true }; // window 2 of the app
  let pk = 'p1';
  t.win.AgentWorkspaceUI = { panelProject: () => ({ key: pk, name: pk }) };
  const tab = () => (pane.classList.contains('tab-changes') ? 'changes' : pane.classList.contains('tab-artifacts') ? 'artifacts' : 'activity');
  C.sync({ id: 'chat1', busy: false });
  assert.equal(tab(), 'activity', 'a project never seen starts on Activity');
  t.ui().show('changes');
  await flush();
  C.sync({ id: 'chat2', busy: false }); // another chat of p1
  await flush();
  assert.equal(tab(), 'changes', 'another chat of the same project keeps the tab');
  pk = 'p2';
  C.sync({ id: 'chat3', busy: false }); // a chat of another project
  await flush();
  assert.equal(tab(), 'activity', 'another project starts on its own tab (Activity when never set)');
  t.ui().show('artifacts');
  pk = 'p1';
  C.sync({ id: 'chat1', busy: false });
  await flush();
  assert.equal(tab(), 'changes', 'p1 is back on Changes');
  pk = 'p2';
  C.sync({ id: 'chat3', busy: false });
  await flush();
  assert.equal(tab(), 'artifacts', 'p2 is back on Artifacts');
  assert.deepEqual(JSON.parse(saved.get('studio-panel-tab-v1:w2')), { p1: 'changes', p2: 'artifacts' }, 'kept per window');
  assert.ok(!saved.has('studio-panel-tab-v1'), "the main window's key is not touched");
});
test('another project resets the project\'s Changes: its folds and open diffs are not carried over', async () => {
  const t = setup({ sections: SUBS });
  let pk = 'p1';
  t.win.AgentWorkspaceUI = { panelProject: () => ({ key: pk, name: pk }) };
  C.sync({ id: 'chat1', busy: false });
  t.ui().show('changes');
  await flush();
  t.secs()[1].querySelector('.cg-sec-head').click();
  await flush();
  assert.equal(secRows(t.secs()[1]).length, 0);
  pk = 'p2';
  C.sync({ id: 'chat9', busy: false });
  await flush();
  assert.equal(secRows(t.secs()[1]).length, 2, "p2's s1 is open again: the fold was p1's");
});
