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
  assert.equal(C.badge(250), '99+');
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
test('tab state: expand only on Changes, leaving Changes or opening a subagent history collapses it', () => {
  let s = C.tabState(null, { type: 'toggleExpand' });
  assert.deepEqual(s, { tab: 'activity', expanded: false });
  s = C.tabState(s, { type: 'show', tab: 'changes' });
  s = C.tabState(s, { type: 'toggleExpand' });
  assert.deepEqual(s, { tab: 'changes', expanded: true });
  assert.deepEqual(C.tabState(s, { type: 'show', tab: 'activity' }), { tab: 'activity', expanded: false });
  assert.deepEqual(C.tabState(s, { type: 'subchat', open: true }), { tab: 'activity', expanded: false });
  assert.deepEqual(C.tabState(s, { type: 'subchat', open: false }), s);
  assert.deepEqual(C.tabState(s, { type: 'show', tab: 'bogus' }), s);
  assert.deepEqual(C.tabState(s, { type: 'reset' }), { tab: 'activity', expanded: false });
});
test('polling only while Changes is visible and the agent works; refresh when a turn ends', () => {
  assert.equal(C.shouldPoll({ tab: 'changes', visible: true, busy: true }), true);
  assert.equal(C.shouldPoll({ tab: 'activity', visible: true, busy: true }), false);
  assert.equal(C.shouldPoll({ tab: 'changes', visible: false, busy: true }), false);
  assert.equal(C.shouldPoll({ tab: 'changes', visible: true, busy: false }), false);
  assert.equal(C.turnEnded(true, false), true);
  assert.equal(C.turnEnded(false, false), false);
  assert.equal(C.turnEnded(false, true), false);
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
function setup(opts) {
  opts = opts || {};
  const calls = [];
  let files = FILES;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/bootstrap')) return ok({ token: 't' });
    if (url.includes('/changes/file')) {
      if (opts.hold) await opts.hold;
      if (opts.fail) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      return ok(DIFF(decodeURIComponent(/path=([^&]*)/.exec(url)[1])));
    }
    return ok(opts.scope ? { git: true, scope: opts.scope, files } : { git: true, files });
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
    setInterval: () => 1,
    clearInterval() {},
  };
  C.init(win);
  C.sync({ id: 'chat1', busy: false });
  return {
    calls,
    ids,
    setFiles: (f) => {
      files = f;
    },
    ui: () => C._live(),
    list: () => ids.subagentsPane.querySelector('.cg-files'),
  };
}
const tick = () => new Promise((r) => setImmediate(r));
const flush = async () => {
  for (let i = 0; i < 10; i++) await tick();
};
const rows = (t) => t.list().querySelectorAll('.cg-file');
const diffCalls = (t) => t.calls.filter((u) => u.includes('/changes/file')).length;
const reload = async (t) => {
  t.ui().show('activity');
  t.ui().show('changes');
  await flush();
};

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
  assert.equal(
    t
      .list()
      .all()
      .filter((n) => /cg-diff-head|cg-diff-path/.test(n.className)).length,
    0,
  );
  const d = t.list().querySelector('.cg-diff');
  assert.ok(d);
  assert.ok(rs[0].parentNode.contains(d));
  assert.ok(d.children[0].matches('.cg-lines') || d.querySelector('.cg-hunk'));
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

test('the header line names the chat changes for a worktree chat and Uncommitted otherwise', async () => {
  const plain = setup();
  plain.ui().show('changes');
  await flush();
  assert.equal(plain.ids.subagentsPane.querySelector('.cg-scope').textContent, 'Uncommitted');
  const wt = setup({ scope: 'branch' });
  wt.ui().show('changes');
  await flush();
  assert.equal(wt.ids.subagentsPane.querySelector('.cg-scope').textContent, "This chat's changes");
  assert.equal(rows(wt).length, 3, 'the list is the same view');
  assert.ok(
    wt.calls.every((u) => !u.includes('scope=branch')),
    'the page still asks for its usual scope; the server decides',
  );
});

test('Discard exists only for a chat with its own branch that has changes, and asks once in the agreed words', () => {
  const files = [{ path: 'a.txt' }];
  assert.equal(C.canDiscard({ git: true, files, worktree: { branch: 'studio/x' } }), true);
  assert.equal(C.canDiscard({ git: true, files }), false, 'a chat without a worktree never gets the button');
  assert.equal(
    C.canDiscard({ git: true, files: [], worktree: { branch: 'studio/x' } }),
    false,
    'no changes: no button',
  );
  assert.equal(C.canDiscard(null), false);
  assert.equal(
    C.discardQuestion('studio/x'),
    'Discard this chat’s changes? This deletes its branch studio/x and can’t be undone.',
  );
  assert.match(C.discardNote({ pending: true }), /the next time it starts/);
  assert.match(C.discardNote({ removed: true }), /read it but not continue/);
});
