'use strict';
const { APP: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
class Node {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this._text = '';
    this.className = '';
    this.attrs = {};
    this.listeners = {};
    this.dataset = {};
    this.parentNode = null;
    this.hidden = false;
    this.isConnected = true;
    this.tabIndex = -1;
  }
  get classList() {
    const self = this;
    return {
      add(c) {
        if (!(' ' + self.className + ' ').includes(' ' + c + ' ')) self.className = (self.className + ' ' + c).trim();
      },
      remove(c) {
        self.className = self.className
          .split(' ')
          .filter((x) => x && x !== c)
          .join(' ');
      },
    };
  }
  append(...nodes) {
    for (const n of nodes) {
      n.parentNode = this;
      this.children.push(n);
    }
  }
  replaceChildren(...nodes) {
    this.children = [];
    this._text = '';
    this.append(...nodes);
  }
  remove() {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
    this.parentNode = null;
    this.isConnected = false;
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
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  focus() {
    document.activeElement = this;
  }
  walk(fn) {
    fn(this);
    for (const c of this.children) c.walk(fn);
  }
  find(tag) {
    const out = [];
    this.walk((n) => {
      if (n.tagName === tag.toUpperCase()) out.push(n);
    });
    return out;
  }
  hasClass(c) {
    return (' ' + this.className + ' ').includes(' ' + c + ' ');
  }
  closest(selector) {
    const wanted = selector.split(',').map((s) => s.trim().replace(/^\./, ''));
    for (let n = this; n; n = n.parentNode)
      if (wanted.some((c) => n.hasClass(c) || n.tagName === c.toUpperCase())) return n;
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    this.walk((n) => {
      if (n.tagName === 'IMG' && n.hasClass('viewable-image')) out.push(n);
    });
    return out;
  }
  fire(type, event = {}) {
    let stopped = false;
    const e = {
      type,
      target: this,
      key: '',
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        stopped = true;
      },
      ...event,
    };
    for (const fn of this.listeners[type] || []) fn(e);
    return e;
  }
}
const body = new Node('body');
const docListeners = {};
const document = {
  createElement: (tag) => new Node(tag),
  body,
  activeElement: null,
  addEventListener(type, fn) {
    (docListeners[type] ??= []).push(fn);
  },
  removeEventListener(type, fn) {
    docListeners[type] = (docListeners[type] || []).filter((f) => f !== fn);
  },
  press(key, extra = {}) {
    const e = {
      type: 'keydown',
      key,
      preventDefault() {
        this.prevented = true;
      },
      stopPropagation() {
        this.stopped = true;
      },
      ...extra,
    };
    for (const fn of docListeners.keydown || []) fn(e);
    return e;
  },
};
const window = {};
const context = vm.createContext({
  document,
  window,
  console,
  TextDecoder,
  TextEncoder,
  crypto: globalThis.crypto,
  btoa,
  DataView,
  Uint8Array,
  JSON,
  Math,
  Number,
  Array,
  Promise,
  Date,
});
for (const file of ['attachments-ui.js', 'image-viewer.js'])
  vm.runInContext(fs.readFileSync(path.join(APP_DIR, file), 'utf8'), context);
const UI = window.AttachmentsUI,
  Viewer = window.ImageViewer;
const plain = (v) => JSON.parse(JSON.stringify(v));
const bytes = (text) => new TextEncoder().encode(text);
const file = (name, content, type = '') => new File([content], name, { type });

test('names: traversal, drives, controls and invisible characters are refused', () => {
  for (const bad of [
    '../x.txt',
    'a/b',
    'a\\b',
    'C:x.txt',
    '..',
    '.',
    ' x',
    'x ',
    'x.',
    'a\u0000b',
    'a\nb',
    'a\u202etxt.exe',
    'a|b',
    'q?',
    'x'.repeat(201),
    '',
    null,
  ])
    assert.notEqual(UI.nameProblem(bad), '', String(bad));
  for (const good of ['notes.md', 'résumé (v2).txt', 'data.tar.gz', '.env', 'LICENSE'])
    assert.equal(UI.nameProblem(good), '', good);
});

test('classification mirrors the server: mime, extension and content', () => {
  const text = bytes('héllo\n');
  for (const [name, mime, want] of [
    ['a.txt', 'text/plain', 'text/plain'],
    ['a.md', '', 'text/markdown'],
    ['a.json', 'application/json', 'application/json'],
    ['a.py', '', 'text/x-python'],
    ['a.js', 'application/x-javascript', 'application/x-javascript'],
    ['a.log', 'application/octet-stream', 'text/plain'],
    ['a.ts', '', 'text/typescript'],
    ['a.yaml', '', 'application/yaml'],
    ['a.sql', '', 'application/sql'],
    ['x.svg', 'image/svg+xml', 'image/svg+xml'],
    ['LICENSE', '', 'text/plain'],
  ]) {
    const r = UI.classify(name, mime, text);
    assert.deepEqual([r.kind, r.mime], ['text', want], name);
  }
  assert.equal(UI.classify('notes.txt', 'text/plain', new Uint8Array([97, 0, 98])).kind, 'binary');
  assert.equal(UI.classify('notes.txt', 'text/plain', new Uint8Array([0xc3, 0x28])).kind, 'binary');
  assert.deepEqual(
    { ...UI.classify('a.pdf', 'application/pdf', bytes('%PDF-1.4 ascii')) },
    { kind: 'binary', mime: 'application/pdf' },
  );
  assert.equal(UI.classify('b.pdf', '', bytes('%PDF')).kind, 'binary');
  assert.deepEqual(
    { ...UI.classify('s.mp3', '', new Uint8Array([73, 68, 51, 3])) },
    { kind: 'audio', mime: 'audio/mpeg' },
  );
  assert.equal(UI.classify('a.png', 'image/png', new Uint8Array([1])).kind, 'image');
  assert.ok(UI.classify('a.txt', 'not a mime', bytes('x')).error);
  assert.equal(UI.classify('a.bin', '', new Uint8Array([1, 2, 0])).mime, 'application/octet-stream');
});

test('capability checks name what the agent lacks and never drop silently', () => {
  assert.equal(UI.capabilityProblem('text', 'text/plain', 'a.txt', {}), '');
  assert.match(
    UI.capabilityProblem('binary', 'application/pdf', 'a.pdf', { image: true, audio: true }),
    /a\.pdf.*embeddedContext/,
  );
  assert.equal(UI.capabilityProblem('binary', 'application/pdf', 'a.pdf', { embeddedContext: true }), '');
  assert.match(UI.capabilityProblem('audio', 'audio/wav', 's.wav', {}), /audio.*embeddedContext/);
  assert.equal(UI.capabilityProblem('audio', 'audio/wav', 's.wav', { audio: true }), '');
  assert.equal(UI.capabilityProblem('audio', 'audio/wav', 's.wav', { embeddedContext: true }), '');
  assert.match(UI.capabilityProblem('image', 'image/png', 'p.png', {}), /image input/);
  assert.equal(UI.capabilityProblem('image', 'image/png', 'p.png', { image: true }), '');
  assert.equal(UI.capabilityProblem('binary', 'x', 'a', undefined).length > 0, true);
});

test('size and count limits', () => {
  const MiB = 1048576;
  assert.equal(UI.sizeProblem('text', 2 * MiB, 'a'), '');
  assert.match(UI.sizeProblem('text', 2 * MiB + 1, 'a'), /2 MiB/);
  assert.equal(UI.sizeProblem('binary', 10 * MiB, 'a'), '');
  assert.match(UI.sizeProblem('binary', 10 * MiB + 1, 'a'), /10 MiB/);
  assert.match(UI.sizeProblem('text', 0, 'a'), /empty/);
  const files = (n) => Array.from({ length: n }, (_, i) => ({ kind: 'file', file: { size: 10 }, name: 'f' + i }));
  assert.equal(UI.limitProblem(files(7), 'text', 10, 'a'), '');
  assert.match(UI.limitProblem(files(8), 'text', 10, 'a'), /maximum 8 files/);
  assert.equal(UI.limitProblem(files(8), 'image', 10, 'a'), '');
  assert.match(UI.limitProblem([{ kind: 'file', file: { size: 19 * MiB } }], 'binary', 2 * MiB, 'a'), /20 MiB/);
  assert.match(UI.limitProblem([{ file: { size: 15 * MiB } }], 'binary', 6 * MiB, 'a'), /20 MiB/);
});

function host(caps, existing = []) {
  const store = new Map([['k', existing]]),
    notes = [],
    images = [];
  return {
    store,
    notes,
    images,
    caps: () => caps,
    key: () => 'k',
    available: () => true,
    addImage: (fs, key) => images.push(...fs.map((f) => f.name)),
    refresh() {},
    note: (m) => notes.push(m),
  };
}
test('addFiles stores accepted files, refuses the rest with reasons, and routes pictures to the image path', async () => {
  UI.setFeatures({ fileAttachments: true });
  const h = host({ embeddedContext: false, image: true });
  await UI.addFiles(
    [
      file('a.md', '# hi', 'text/markdown'),
      file('b.pdf', '%PDF', 'application/pdf'),
      file('../evil.txt', 'x'),
      file('p.png', 'x', 'image/png'),
      file('e.txt', ''),
    ],
    'k',
    h,
  );
  const items = h.store.get('k');
  assert.deepEqual(
    items.map((i) => [i.name, i.kind, i.fileKind, i.mime]),
    [['a.md', 'file', 'text', 'text/markdown']],
  );
  assert.deepEqual(h.images, ['p.png']);
  const note = h.notes.join(' | ');
  assert.match(note, /b\.pdf.*embeddedContext/);
  assert.match(note, /evil\.txt.*separators/);
  assert.match(note, /e\.txt.*empty/);
});
test('addFiles with embedded context keeps pdfs, enforces eight files, and is refused by servers without the feature', async () => {
  UI.setFeatures({ fileAttachments: true });
  const h = host({ embeddedContext: true });
  await UI.addFiles(
    Array.from({ length: 10 }, (_, i) => file('f' + i + '.txt', 'x')).concat(file('a.pdf', '%PDF', 'application/pdf')),
    'k',
    h,
  );
  assert.equal(h.store.get('k').length, 8);
  assert.match(h.notes.join(), /maximum 8 files/);
  UI.setFeatures({});
  const old = host({ embeddedContext: true });
  await UI.addFiles([file('a.txt', 'x')], 'k', old);
  assert.equal(old.store.get('k').length, 0);
  assert.match(old.notes.join(), /does not support file attachments/);
  UI.setFeatures({ fileAttachments: true });
});
test('addFiles rejects oversized text and totals', async () => {
  UI.setFeatures({ fileAttachments: true });
  const h = host({ embeddedContext: true });
  await UI.addFiles([file('big.txt', 'a'.repeat(2 * 1048576 + 1)), file('ok.txt', 'a'.repeat(2 * 1048576))], 'k', h);
  assert.deepEqual(
    h.store.get('k').map((i) => i.name),
    ['ok.txt'],
  );
  assert.match(h.notes.join(), /big\.txt.*2 MiB/);
  const full = host({ embeddedContext: true }, [{ kind: 'file', file: { size: 19 * 1048576 }, name: 'x' }]);
  await UI.addFiles([file('more.txt', 'a'.repeat(2 * 1048576))], 'k', full);
  assert.equal(full.store.get('k').length, 1);
  assert.match(full.notes.join(), /20 MiB/);
});

test('fingerprints change with name, type, bytes and set; wire blocks carry files', async () => {
  const mk = (name, content, mime = 'text/plain') => ({
    kind: 'file',
    name,
    mime,
    fileKind: 'text',
    file: file(name, content, mime),
  });
  const base = await UI.fingerprint([mk('a.txt', 'one')]);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(await UI.fingerprint([mk('a.txt', 'one')]), base);
  for (const other of [
    [mk('a.txt', 'two')],
    [mk('b.txt', 'one')],
    [mk('a.txt', 'one', 'text/markdown')],
    [mk('a.txt', 'one'), mk('c.txt', '')],
    [],
  ])
    assert.notEqual(await UI.fingerprint(other), base);
  assert.equal(await UI.fingerprint([]), '');
  const image = { id: 'i', file: file('p.png', 'PNG', 'image/png'), preview: 'blob:x' };
  assert.notEqual(await UI.fingerprint([image]), await UI.fingerprint([mk('p.png', 'PNG', 'image/png')]));
  const wire = plain(await UI.blocks([mk('a.txt', 'hi'), image]));
  assert.deepEqual(wire, [
    { type: 'file', name: 'a.txt', mimeType: 'text/plain', data: Buffer.from('hi').toString('base64') },
    { type: 'image', mimeType: 'image/png', data: Buffer.from('PNG').toString('base64') },
  ]);
});

test('composer note reflects what the agent supports', () => {
  assert.match(UI.note({ imageFeature: false, snapshot: null, hasItems: false }), /does not support attachments/);
  const none = UI.note({ imageFeature: true, snapshot: { promptCapabilities: {} }, hasItems: false });
  assert.match(none, /inline/);
  assert.match(none, /cannot take PDFs/);
  assert.match(none, /does not support pictures/);
  const all = UI.note({
    imageFeature: true,
    snapshot: { promptCapabilities: { embeddedContext: true, audio: true, image: true } },
    hasItems: true,
  });
  assert.match(all, /embedded context/);
  assert.match(all, /audio is sent as audio/);
  assert.match(all, /pictures are sent as images/);
});

test('file cards show name, type and size; content is text only and expandable', () => {
  const badge = UI.fileBadge({ name: 'report.PDF', mime: 'application/pdf', fileKind: 'binary', file: { size: 2048 } });
  assert.match(badge.textContent, /PDF/);
  assert.match(badge.textContent, /2\.0 KB/);
  const card = UI.messageCard({
    name: 'x.html',
    mimeType: 'text/html',
    size: 30,
    kind: 'text',
    mode: 'inline',
    preview: '<script>alert(1)</script>',
    truncated: false,
  });
  assert.match(card.textContent, /x\.html/);
  assert.match(card.textContent, /text\/html/);
  assert.match(card.textContent, /30 B/);
  assert.match(card.textContent, /inline/);
  assert.equal(card.find('script').length, 0);
  assert.equal(card.find('details').length, 1);
  assert.equal(card.find('pre')[0].textContent, '<script>alert(1)</script>');
  const bin = UI.messageCard({ name: 'a.pdf', mimeType: 'application/pdf', size: 5, kind: 'binary', mode: 'embedded' });
  assert.equal(bin.find('details').length, 0);
  assert.deepEqual(plain(UI.eventFiles({ files: [{ name: 'a' }, { nope: 1 }] }).map((f) => f.type)), ['studio_file']);
  assert.deepEqual(plain(UI.eventFiles({})), []);
});

test('drop wiring: only file drags are handled and a disconnected composer explains itself', async () => {
  UI.setFeatures({ fileAttachments: true });
  const target = new Node('form'),
    h = host({}),
    calls = [];
  h.available = () => calls.length === 0;
  UI.wireDrop(target, h);
  const text = target.fire('dragover', { dataTransfer: { types: ['text/plain'] } });
  assert.notEqual(text.prevented, true);
  const over = target.fire('dragenter', { dataTransfer: { types: ['Files'] } });
  assert.equal(over.prevented, true);
  assert.ok(target.hasClass('drop-target'));
  target.fire('drop', { dataTransfer: { types: ['Files'], files: [file('a.txt', 'x')] } });
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(!target.hasClass('drop-target'));
  assert.equal(h.store.get('k').length, 1);
  calls.push(1);
  target.fire('drop', { dataTransfer: { types: ['Files'], files: [file('b.txt', 'x')] } });
  assert.match(h.notes.at(-1), /connect/);
  assert.equal(h.store.get('k').length, 1);
});

// ---- image viewer ----
const SRC = 'data:image/png;base64,AAAA';
const items = [
  { src: SRC, name: 'one.png' },
  { src: 'blob:http://x/1', name: 'two.png' },
  { src: 'data:image/gif;base64,AAAA', name: 'three.gif' },
];
const dialog = () => body.children.find((c) => c.hasClass('image-viewer'));
test('viewer: opens modal, shows name and position, closes on Esc and restores focus', () => {
  const opener = new Node('img');
  opener.focus();
  assert.ok(Viewer.open(items, 1, opener));
  const d = dialog();
  assert.equal(d.attrs.role, 'dialog');
  assert.equal(d.attrs['aria-modal'], 'true');
  assert.equal(d.find('img')[0].src, 'blob:http://x/1');
  assert.match(d.textContent, /two\.png · 2 of 3/);
  assert.equal(document.activeElement.className, 'image-viewer-close');
  const e = document.press('Escape');
  assert.equal(e.prevented, true);
  assert.equal(dialog(), undefined);
  assert.equal(Viewer.isOpen(), false);
  assert.equal(document.activeElement, opener);
});
test('viewer: arrows move and wrap, buttons work, single image hides navigation', () => {
  Viewer.open(items, 0);
  const d = dialog(),
    img = () => d.find('img')[0].src;
  document.press('ArrowRight');
  assert.equal(img(), items[1].src);
  document.press('ArrowRight');
  document.press('ArrowRight');
  assert.equal(img(), items[0].src);
  document.press('ArrowLeft');
  assert.equal(img(), items[2].src);
  const [close, prev, next] = ['image-viewer-close', 'image-viewer-prev', 'image-viewer-next'].map((c) => {
    let f;
    d.walk((n) => {
      if (n.hasClass(c)) f = n;
    });
    return f;
  });
  next.fire('click');
  assert.equal(img(), items[0].src);
  prev.fire('click');
  assert.equal(img(), items[2].src);
  close.fire('click');
  assert.equal(dialog(), undefined);
  Viewer.open([items[0]], 0);
  assert.equal(
    dialog()
      .find('button')
      .filter((b) => b.hasClass('image-viewer-nav'))
      .every((b) => b.hidden),
    true,
  );
  document.press('ArrowRight');
  assert.match(dialog().textContent, /1 of 1/);
  Viewer.close();
});
test('viewer: backdrop click closes, image click does not; Tab stays inside', () => {
  Viewer.open(items, 0);
  const d = dialog();
  const image = d.find('img')[0];
  d.fire('click', { target: image });
  assert.ok(dialog());
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    document.press('Tab');
    seen.add(document.activeElement.className);
    assert.ok(d.find('button').includes(document.activeElement));
  }
  assert.equal(seen.size, 3);
  document.press('Tab', { shiftKey: true });
  assert.ok(d.find('button').includes(document.activeElement));
  d.fire('click');
  assert.equal(dialog(), undefined);
});
test('viewer: only blob: and data:image sources are accepted; nothing remote is ever loaded', () => {
  for (const src of [
    'https://evil.example/x.png',
    'http://x/y.png',
    'javascript:alert(1)',
    'data:text/html;base64,AAAA',
    'data:image/svg+xml;base64,AAAA',
    '/relative.png',
    'file:///c:/x.png',
    5,
    null,
  ])
    assert.equal(Viewer.open([{ src }], 0), false, String(src));
  assert.equal(dialog(), undefined);
  Viewer.open([{ src: 'https://evil.example/x.png' }, { src: SRC, name: 'ok' }], 0);
  assert.equal(dialog().find('img')[0].src, SRC);
  assert.match(dialog().textContent, /1 of 1/);
  Viewer.close();
});
test('viewer: makeViewable opens the set of images in the same strip and Enter activates', () => {
  const strip = new Node('div');
  strip.className = 'attachment-list';
  const imgs = ['a', 'b'].map((n, i) => {
    const im = new Node('img');
    im.src = i ? 'blob:http://x/b' : SRC;
    im.alt = n;
    strip.append(im);
    Viewer.makeViewable(im, n + '.png');
    return im;
  });
  assert.ok(imgs[0].hasClass('viewable-image'));
  assert.equal(imgs[0].attrs.role, 'button');
  assert.equal(imgs[0].tabIndex, 0);
  imgs[1].fire('click');
  assert.ok(dialog());
  assert.match(dialog().textContent, /b\.png · 2 of 2/);
  document.press('Escape');
  assert.equal(document.activeElement, imgs[1]);
  const e = imgs[0].fire('keydown', { key: 'Enter' });
  assert.equal(e.prevented, true);
  assert.match(dialog().textContent, /a\.png · 1 of 2/);
  Viewer.close();
});
