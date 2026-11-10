const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

class Node {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.className = '';
    this.hidden = false;
    this._text = '';
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
  append(...ns) {
    ns.forEach((n) => {
      n.parent = this;
      this.children.push(n);
    });
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  all() {
    return this.children.flatMap((c) => [c, ...c.all()]);
  }
}
const document = { createElement: (tag) => new Node(tag) };
const window = {};
vm.runInNewContext(fs.readFileSync(path.join(APP_DIR, 'terminals-ui.js'), 'utf8'), {
  window,
  document,
  Array,
  String,
});
const ui = window.AgentClientCapsUI;

// Nothing enabled -> hidden and empty.
let root = new Node('div');
ui.render(root, { terminal: false, fs: null, terminals: [], writes: [] });
assert.equal(root.hidden, true);
assert.equal(root.children.length, 0);
ui.render(root, undefined);
assert.equal(root.hidden, true);

// Untrusted output, command and paths appear as literal text; no element is created from them.
const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
root = new Node('div');
ui.render(root, {
  terminal: true,
  fs: 'readwrite',
  terminals: [
    {
      id: 't1',
      command: evil + ' --flag',
      cwd: 'C:\\ws\\' + evil,
      status: 'running',
      exitCode: null,
      signal: null,
      truncated: true,
      outputTail: evil + '\n\u001b[31mred',
    },
    {
      id: 't2',
      command: 'python',
      cwd: 'C:\\ws',
      status: 'exited',
      exitCode: 3,
      signal: null,
      truncated: false,
      outputTail: 'done',
    },
  ],
  writes: [
    { path: 'C:\\ws\\' + evil + '.txt', bytes: 42, created: true },
    { path: 'C:\\ws\\b.txt', bytes: 7, created: false },
  ],
});
assert.equal(root.hidden, false);
const nodes = root.all();
assert.deepEqual(
  [...new Set(nodes.map((n) => n.tagName))].sort(),
  ['code', 'div', 'h3', 'h4', 'p', 'pre', 'span'].filter((t) => nodes.some((n) => n.tagName === t)).sort(),
);
assert.ok(!nodes.some((n) => ['img', 'script', 'a', 'iframe'].includes(n.tagName)));
const pres = nodes.filter((n) => n.tagName === 'pre');
assert.equal(pres[0].textContent, evil + '\n\u001b[31mred');
assert.equal(nodes.find((n) => n.className === 'client-terminal-command').textContent, evil + ' --flag');
assert.ok(root.textContent.includes('exited (exit 3)'));
assert.ok(root.textContent.includes('Output truncated'));
assert.ok(root.textContent.includes('files: read+write'));
const writeRows = nodes.filter((n) => n.className === 'client-write');
assert.equal(writeRows.length, 2);
assert.ok(writeRows[0].textContent.includes('overwrote, 7 bytes'), 'newest write first');
assert.ok(writeRows[1].textContent.includes('created, 42 bytes'));
assert.ok(nodes.some((n) => n.className.includes('client-terminal-running')));

// Status class cannot be injected from the status string.
root = new Node('div');
ui.render(root, {
  terminal: true,
  fs: null,
  terminals: [{ id: 'x', command: 'c', cwd: '.', status: 'bad status"onmouseover=1', outputTail: '' }],
  writes: [],
});
assert.ok(!root.all().some((n) => /\s/.test(n.className.replace('client-terminal ', '')) && n.className.includes('"')));

// Read-only: no writes section.
root = new Node('div');
ui.render(root, { terminal: false, fs: 'read', terminals: [], writes: [{ path: 'x', bytes: 1 }] });
assert.ok(root.textContent.includes('files: read-only'));
assert.ok(!root.textContent.includes('Files written'));

// Re-render replaces rather than appends.
const before = root.children.length;
ui.render(root, { terminal: false, fs: 'read', terminals: [], writes: [] });
assert.equal(root.children.length, before);
console.log('terminals-ui ok');
