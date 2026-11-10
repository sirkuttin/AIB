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
const document = { createElement: (tag) => new Node(tag) };
const window = {};
const context = vm.createContext({ document, window, URL, console });
for (const file of ['markdown.js', 'tool-views.js'])
  vm.runInContext(fs.readFileSync(path.join(APP_DIR, file), 'utf8'), context);
const md = (value) => {
  const box = new Node('div');
  window.AgentMarkdown.render(box, value);
  return box;
};
const tags = (box) => {
  const out = new Set();
  box.walk((n) => out.add(n.tagName.toLowerCase()));
  return out;
};

test('raw HTML and script tags remain text', () => {
  const box = md('hello <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<div onclick="x()">block</div>');
  assert.equal(box.find('script').length, 0);
  assert.equal(box.find('img').length, 0);
  assert.equal(box.find('div').length, 1);
  assert.match(box.textContent, /<script>alert\(1\)<\/script>/);
  assert.match(box.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('only http, https and mailto links become anchors', () => {
  const box = md(
    '[a](https://example.org/x) [b](javascript:alert(1)) [c](data:text/html,x) [d](mailto:a@b.co) [e](file:///C:/x) [f](http://e.org) [g](JaVaScRiPt:alert(1))',
  );
  const links = box.find('a');
  assert.deepEqual(
    links.map((a) => a.href),
    ['https://example.org/x', 'mailto:a@b.co', 'http://e.org/'],
  );
  for (const a of links) {
    assert.equal(a.rel, 'noopener noreferrer');
    assert.equal(a.target, '_blank');
  }
  assert.match(box.textContent, /\[b\]\(javascript:alert\(1\)\)/);
});

test('markdown images never create img elements', () => {
  const box = md('![x](https://evil.example/pixel.png)');
  assert.equal(box.find('img').length, 0);
  assert.match(box.textContent, /pixel\.png/);
});

test('nested emphasis and snake_case words', () => {
  let box = md('**bold *italic* more**');
  const strong = box.find('strong');
  assert.equal(strong.length, 1);
  assert.equal(strong[0].find('em').length, 1);
  assert.equal(strong[0].find('em')[0].textContent, 'italic');
  box = md('***both***');
  assert.equal(box.find('strong')[0].find('em')[0].textContent, 'both');
  box = md('use snake_case_name here');
  assert.equal(box.find('em').length, 0);
  assert.match(box.textContent, /snake_case_name/);
  box = md('`**not bold**`');
  assert.equal(box.find('strong').length, 0);
  assert.equal(box.find('code')[0].textContent, '**not bold**');
});

test('code fences keep content literal, including markup and unterminated fences', () => {
  let box = md('```js\n<b>x</b> **y** # z\n```\nafter');
  const code = box.find('code');
  assert.equal(code.length, 1);
  assert.equal(code[0].textContent, '<b>x</b> **y** # z');
  assert.equal(box.find('b').length, 0);
  assert.equal(box.find('strong').length, 0);
  box = md('~~~\nline1\nline2');
  assert.equal(box.find('code')[0].textContent, 'line1\nline2');
  box = md('````\n```\ninner\n```\n````');
  assert.equal(box.find('code')[0].textContent, '```\ninner\n```');
});

test('headings, lists, nesting, quotes and tables', () => {
  const box = md('# Title\n\n- a\n- b\n  - nested\n\n1. x\n2. y\n\n> quote\n\n| H1 | H2 |\n| --- | --- |\n| c1 | c2 |');
  assert.equal(box.find('h3')[0].textContent, 'Title');
  assert.equal(box.find('ul').length, 2);
  assert.equal(box.find('ol').length, 1);
  assert.equal(box.find('li').length, 5);
  assert.equal(box.find('blockquote').length, 1);
  assert.equal(box.find('th').length, 2);
  assert.equal(box.find('td')[1].textContent, 'c2');
});

test('hostile or deeply nested input terminates', () => {
  const deep = '>'.repeat(5000) + ' x';
  md(deep);
  md('*'.repeat(5000));
  md('['.repeat(3000) + 'a' + '](x)'.repeat(3000));
  md('  - a\n'.repeat(50) + '- b');
  assert.ok(true);
});

test('tool_call renders kind, status, locations and raw fallback', () => {
  const view = window.ToolViews.render({
    toolCallId: 't',
    title: 'Read <b>x</b>',
    kind: 'read',
    status: 'in_progress',
    locations: [{ path: 'C:/p/a.py', line: 12 }, { path: 'file:///C:/p/b.py' }],
  });
  assert.ok(view.hasClass('tool-kind-read'));
  assert.match(view.textContent, /Read <b>x<\/b>/);
  assert.equal(view.find('b').length, 0);
  const status = [];
  view.walk((n) => {
    if (n.hasClass('tool-status')) status.push(n);
  });
  assert.equal(status[0].textContent, 'in progress');
  assert.ok(status[0].hasClass('status-in_progress'));
  const li = view.find('li');
  assert.equal(li[0].textContent, 'C:/p/a.py:12');
  assert.equal(li[1].textContent, 'C:/p/b.py');
  assert.match(view.find('details').at(-1).textContent, /Raw JSON/);
});

test('unknown kind and status degrade safely', () => {
  const view = window.ToolViews.render({ kind: 'weird', status: 'x"><script>' });
  assert.ok(view.hasClass('tool-kind-other'));
  assert.equal(view.find('script').length, 0);
  assert.ok(!view.className.includes('"'));
});

test('line diff marks added and removed lines', () => {
  const d = window.ToolViews.lineDiff('a\nb\nc', 'a\nB\nc\nd');
  assert.deepEqual(
    Array.from(d).map((l) => l.type + ':' + l.text),
    ['ctx:a', 'del:b', 'add:B', 'ctx:c', 'add:d'],
  );
  const fresh = window.ToolViews.lineDiff(null, 'x\ny');
  assert.deepEqual(
    Array.from(fresh).map((l) => l.type),
    ['add', 'add'],
  );
  const gone = window.ToolViews.lineDiff('x', null);
  assert.deepEqual(
    Array.from(gone).map((l) => l.type),
    ['del'],
  );
});

test('diff view is collapsible, escapes content and collapses long unchanged runs', () => {
  const old = Array.from({ length: 30 }, (_, i) => 'line' + i).join('\n'),
    next = old.replace('line15', '<script>x</script>');
  const view = window.ToolViews.render({
    kind: 'edit',
    status: 'completed',
    content: [{ type: 'diff', path: 'C:/p/f.py', oldText: old, newText: next }],
  });
  const diff = view.find('details').find((d) => d.hasClass('tool-diff'));
  assert.equal(diff.open, true);
  assert.match(diff.children[0].textContent, /C:\/p\/f\.py\+1-1/);
  assert.equal(view.find('script').length, 0);
  const lines = [];
  diff.walk((n) => {
    if (n.hasClass('diff-line')) lines.push(n);
  });
  assert.equal(lines.length, 3 + 1 + 1 + 3);
  assert.ok(lines.some((l) => l.hasClass('diff-add') && l.textContent.includes('<script>')));
  assert.ok(lines.some((l) => l.hasClass('diff-del') && l.textContent.includes('line15')));
  const skips = [];
  diff.walk((n) => {
    if (n.hasClass('diff-skip')) skips.push(n.textContent);
  });
  assert.deepEqual(skips, ['… 12 unchanged lines', '… 11 unchanged lines']);
});

test('new-file diffs, terminal references and content blocks in tools', () => {
  const view = window.ToolViews.render({
    kind: 'execute',
    status: 'completed',
    content: [
      { type: 'diff', path: 'n.txt', oldText: null, newText: 'hi' },
      { type: 'terminal', terminalId: 'term-9' },
      { type: 'content', content: { type: 'text', text: 'out' } },
    ],
  });
  assert.match(view.textContent, /new file/);
  assert.match(view.textContent, /Terminal term-9/);
  assert.match(view.textContent, /out/);
});

test('resource_link is clickable only for http(s); file URIs are path text', () => {
  const web = window.ToolViews.contentBlock({
    type: 'resource_link',
    name: 'Docs',
    uri: 'https://example.org/d',
    mimeType: 'text/html',
    size: 2048,
  });
  assert.equal(web.find('a')[0].href, 'https://example.org/d');
  assert.equal(web.find('a')[0].rel, 'noopener noreferrer');
  assert.match(web.textContent, /2\.0 KB/);
  const file = window.ToolViews.contentBlock({ type: 'resource_link', name: 'cfg', uri: 'file:///C:/proj/config.py' });
  assert.equal(file.find('a').length, 0);
  assert.match(file.textContent, /C:\/proj\/config\.py/);
  const evil = window.ToolViews.contentBlock({ type: 'resource_link', name: 'x', uri: 'javascript:alert(1)' });
  assert.equal(evil.find('a').length, 0);
});

test('embedded resources: text is a collapsible pre, blobs are summarized only', () => {
  const text = window.ToolViews.contentBlock({
    type: 'resource',
    resource: { uri: 'file:///C:/n.txt', mimeType: 'text/plain', text: '<b>hello</b>' },
  });
  assert.equal(text.find('details').length, 1);
  assert.equal(text.find('pre')[0].textContent, '<b>hello</b>');
  assert.equal(text.find('b').length, 0);
  const blob = window.ToolViews.contentBlock({
    type: 'resource',
    resource: { uri: 'file:///C:/d.bin', mimeType: 'application/octet-stream', blob: 'AAECAwQF' },
  });
  assert.equal(
    blob.find('a').length + blob.find('img').length + blob.find('audio').length + blob.find('pre').length,
    0,
  );
  assert.match(blob.textContent, /6 B/);
  assert.match(blob.textContent, /not rendered/);
});

test('images and audio come only from the block and only for safe types', () => {
  const ok = window.ToolViews.contentBlock({ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' });
  assert.match(ok.find('img')[0].src, /^data:image\/png;base64,/);
  for (const bad of [
    { mimeType: 'image/svg+xml', data: 'aGVsbG8=' },
    { mimeType: 'image/png', data: 'https://x.test/a.png' },
  ])
    assert.equal(window.ToolViews.contentBlock({ type: 'image', ...bad }).find('img').length, 0);
  const audio = window.ToolViews.contentBlock({ type: 'audio', mimeType: 'audio/wav', data: 'aGVsbG8=' });
  assert.match(audio.find('audio')[0].src, /^data:audio\/wav;base64,/);
  assert.equal(
    window.ToolViews.contentBlock({ type: 'audio', mimeType: 'text/html', data: 'aGVsbG8=' }).find('audio').length,
    0,
  );
  assert.equal(
    window.ToolViews.contentBlock({ type: 'audio', mimeType: 'audio/wav', data: 'http://x.test/a.wav' }).find('audio')
      .length,
    0,
  );
});
