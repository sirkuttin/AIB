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
    this.handlers = {};
    this.hidden = false;
    this.dataset = {};
  }
  get classList() {
    const self = this;
    return {
      add(c) {
        self.className = (self.className + ' ' + c).trim();
      },
    };
  }
  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }
  replaceChildren(...nodes) {
    this.children = [...nodes];
    this._text = '';
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  walk(fn) {
    fn(this);
    for (const c of this.children) c.walk(fn);
  }
  byClass(c) {
    const out = [];
    this.walk((n) => {
      if (n.hasClass(c)) out.push(n);
    });
    return out;
  }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  getAttribute(k) {
    return this.attrs[k];
  }
  addEventListener(t, fn) {
    (this.handlers[t] ??= []).push(fn);
  }
  hasClass(c) {
    return (' ' + this.className + ' ').split(' ').includes(c);
  }
  fire(t) {
    const ev = {
      stopped: false,
      stopPropagation() {
        this.stopped = true;
      },
      preventDefault() {},
    };
    for (const fn of this.handlers[t] || []) fn(ev);
    return ev;
  }
}
const document = { createElement: (tag) => new Node(tag) };
const opened = [];
const window = {
  ImageViewer: {
    makeViewable(img, name) {
      img.className += ' viewable-image';
      img.viewerName = name;
      img.addEventListener('click', () => opened.push(img.src));
    },
  },
};
const context = vm.createContext({ document, window, URL, console });
for (const file of ['markdown.js', 'tool-views.js'])
  vm.runInContext(fs.readFileSync(path.join(APP_DIR, file), 'utf8'), context);
const TV = window.ToolViews;
const url = (j) => '/api/transcript/image?key=a.jsonl&n=3&i=0&j=' + j;
const saved = (rows) => TV.pairSaved(rows);
const rows = () =>
  saved([
    { role: 'tool', label: 'mcp__Claude_Browser__computer', value: '{"action":"screenshot"}', callId: 't1' },
    {
      role: 'result',
      label: 'Tool result',
      value: 'Took a screenshot',
      callId: 't1',
      attachments: [
        { type: 'transcript-image', mimeType: 'image/png', url: url(1) },
        { type: 'transcript-image', mimeType: 'image/png', url: url(2) },
      ],
    },
  ]);

test('saved result images attach to the call', () => {
  const out = rows();
  assert.equal(out.length, 1);
  assert.equal(out[0].call.result.images.length, 2);
});

test('collapsed row gets small thumbnails; clicking one opens the viewer and does not toggle', () => {
  const row = rows()[0],
    box = TV.line(row, () => new Node('div'));
  const thumbs = box.byClass('tool-thumb');
  assert.equal(thumbs.length, 2);
  assert.ok(thumbs[0].hasClass('viewable-image'));
  assert.ok(!box.children[0].children.includes(thumbs[0]), 'thumbnail is not inside the toggle button');
  const ev = thumbs[0].fire('click');
  assert.equal(ev.stopped, true);
  assert.equal(opened.at(-1), url(1));
});

test('expanded detail shows the full set', () => {
  const detail = TV.renderCall(rows()[0].call);
  assert.equal(detail.byClass('tool-image').length, 2);
});

test('live ACP image content becomes thumbnails only for safe blocks', () => {
  const good = { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' } };
  const badType = { type: 'content', content: { type: 'image', mimeType: 'image/svg+xml', data: 'AAAA' } };
  const badData = { type: 'content', content: { type: 'image', mimeType: 'image/png', data: '<script>' } };
  const box = TV.line(
    {
      role: 'tool',
      raw: {
        toolCallId: 'x',
        title: 'Screenshot',
        kind: 'other',
        status: 'completed',
        content: [good, badType, badData],
      },
    },
    () => new Node('div'),
  );
  const thumbs = box.byClass('tool-thumb');
  assert.equal(thumbs.length, 1);
  assert.equal(thumbs[0].src, 'data:image/png;base64,iVBORw0KGgo=');
});

test('foreign image addresses are ignored', () => {
  const row = saved([
    { role: 'tool', label: 'T', value: '{}', callId: 't' },
    {
      role: 'result',
      value: '',
      callId: 't',
      attachments: [{ type: 'transcript-image', url: 'https://evil.test/x.png' }],
    },
  ])[0];
  const box = TV.line(row, () => new Node('div'));
  assert.equal(box.byClass('tool-thumb').length, 0);
});
