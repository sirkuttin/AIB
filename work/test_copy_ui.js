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
}
const writes = [];
class Blob {
  constructor(parts, opts) {
    this.parts = parts;
    this.type = opts.type;
  }
}
class ClipboardItem {
  constructor(items) {
    this.items = items;
  }
}
const store = {};
const window = {
  navigator: {
    clipboard: {
      write: async (items) => {
        writes.push({ kind: 'write', items });
      },
      writeText: async (text) => {
        writes.push({ kind: 'text', text });
      },
    },
  },
  ClipboardItem,
  Blob,
  localStorage: {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => {
      store[k] = v;
    },
  },
};
const document = { createElement: (tag) => new Node(tag) };
const context = vm.createContext({ document, window, URL, console, Blob, ClipboardItem });
for (const file of ['markdown.js', 'tool-views.js', 'copy-ui.js'])
  vm.runInContext(fs.readFileSync(path.join(APP_DIR, file), 'utf8'), context);
const CopyUI = window.CopyUI,
  TV = window.ToolViews;
const SAMPLE =
  '# Title\n\nSome **bold** and *italic* with `code` and [a link](https://example.org/x?a=1&b=2) plus <script>alert(1)</script>.\n\n- one\n- two\n  - nested\n\n1. first\n2. second\n\n> quoted\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```python\nprint("<hi>")\nif x:\n    pass\n```\n';

test('teams html is inline-styled, escaped and free of classes/scripts/events', async () => {
  const html = CopyUI.fromMarkdown(SAMPLE).html();
  assert.match(html, /<h3 style="/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code style="[^"]*monospace|<code style="[^"]*Consolas/);
  assert.match(html, /<a href="https:\/\/example\.org\/x\?a=1&amp;b=2">a link<\/a>/);
  assert.match(html, /<ul style=/);
  assert.match(html, /<ol style=/);
  assert.match(html, /<blockquote style=/);
  assert.match(html, /<table style=/);
  assert.match(html, /<th style=/);
  assert.match(
    html,
    /<pre style="[^"]*background:#f3f4f6[^"]*"><code style="[^"]*">print\(&quot;&lt;hi&gt;&quot;\)\nif x:\n    pass<\/code><\/pre>/,
  );
  assert.doesNotMatch(html, /<script|class=|onerror|onclick|<style|<link|<img/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('agent-supplied html and javascript links never reach the html clipboard', () => {
  const html = CopyUI.fromMarkdown(
    '<img src=x onerror=alert(1)> [x](javascript:alert(1)) <b onclick="y()">z</b>\n\n```\n</pre><script>bad()</script>\n```',
  ).html();
  assert.doesNotMatch(html, /<img|<script|<b |href="javascript/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;\/pre&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});

test('plain text keeps lists, tables, code line breaks and link targets', () => {
  const plain = CopyUI.fromMarkdown(SAMPLE).plain();
  assert.match(plain, /^Title\n\nSome bold and italic with code and a link \(https:\/\/example\.org\/x\?a=1&b=2\)/);
  assert.match(plain, /- one\n- two\n {2}- nested/);
  assert.match(plain, /1\. first\n2\. second/);
  assert.match(plain, /> quoted/);
  assert.match(plain, /a \| b\n1 \| 2/);
  assert.match(plain, /print\("<hi>"\)\nif x:\n {4}pass/);
});

test('markdown format is the original source; code payloads use a fence that survives backticks', () => {
  assert.equal(CopyUI.fromMarkdown(SAMPLE).markdown(), SAMPLE);
  assert.equal(CopyUI.fromPlain('a\nb').markdown(), 'a\nb');
  assert.equal(CopyUI.fromCode('x = 1', 'python').markdown(), '```python\nx = 1\n```');
  assert.equal(CopyUI.fromCode('```\ninner\n```', '').markdown(), '````\n```\ninner\n```\n````');
  assert.equal(CopyUI.fromCode('<b>&', 'html').html().includes('&lt;b&gt;&amp;'), true);
  assert.equal(CopyUI.fromCode('a\nb', '').plain(), 'a\nb');
  assert.equal(CopyUI.fromPlain('<b>x</b>\ny').html(), '<p style="margin:0 0 8px 0;">&lt;b&gt;x&lt;/b&gt;<br>y</p>');
});

test('teams copy writes text/html and text/plain through ClipboardItem', async () => {
  writes.length = 0;
  await CopyUI.write('teams', CopyUI.fromMarkdown('Hello **there**\n\n- a'));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].kind, 'write');
  const item = writes[0].items[0].items;
  assert.deepEqual(Object.keys(item).sort(), ['text/html', 'text/plain']);
  assert.equal(item['text/html'].type, 'text/html');
  assert.match(item['text/html'].parts[0], /<p style="[^"]*">Hello <strong>there<\/strong><\/p><ul/);
  assert.equal(item['text/plain'].parts[0], 'Hello there\n\n- a');
});

test('markdown and plain formats use writeText', async () => {
  writes.length = 0;
  await CopyUI.write('markdown', CopyUI.fromMarkdown('# t'));
  await CopyUI.write('plain', CopyUI.fromMarkdown('# t **b**'));
  assert.deepEqual(
    writes.map((w) => [w.kind, w.text]),
    [
      ['text', '# t'],
      ['text', 't b'],
    ],
  );
});

test('clipboard failure rejects so the UI can fall back', async () => {
  const saved = window.navigator;
  window.navigator = {};
  await assert.rejects(CopyUI.write('plain', CopyUI.fromPlain('x')));
  window.navigator = saved;
});

test('last format is remembered and tolerates broken storage', () => {
  assert.equal(CopyUI.lastFormat(), 'markdown');
  CopyUI.rememberFormat('teams');
  assert.equal(CopyUI.lastFormat(), 'teams');
  store['agentStudio.copyFormat'] = 'bogus';
  assert.equal(CopyUI.lastFormat(), 'markdown');
  const saved = window.localStorage;
  window.localStorage = {
    getItem() {
      throw new Error('x');
    },
    setItem() {
      throw new Error('x');
    },
  };
  assert.equal(CopyUI.lastFormat(), 'markdown');
  CopyUI.rememberFormat('plain');
  window.localStorage = saved;
});

test('rows: tool rows copy as markdown with a fenced command', () => {
  const call = {
    name: 'Bash',
    input: { command: 'ls "a b"\necho hi', description: 'List', timeout: 5000 },
    result: { text: 'a b\nhi', isError: false },
  };
  const md = CopyUI.fromRow({ role: 'tool', call }).markdown();
  assert.match(
    md,
    /^\*\*Bash\*\* — List\n\n```bash\nls "a b"\necho hi\n```\n\ntimeout: 5000\n\nOutput:\n\n```\na b\nhi\n```$/,
  );
  const html = CopyUI.fromRow({ role: 'tool', call }).html();
  assert.match(html, /<pre style=/);
  assert.doesNotMatch(html, /class=/);
  assert.equal(CopyUI.fromRow({ role: 'user', value: 'hi\nthere' }).plain(), 'hi\nthere');
  assert.equal(CopyUI.fromRow({ role: 'assistant', value: '**x**' }).plain(), 'x');
  assert.equal(CopyUI.fromRow({ role: 'assistant', value: '' }), null);
});
