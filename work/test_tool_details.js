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
    (this.handlers = this.handlers || {})[t] = fn;
  }
  click() {
    this.handlers.click();
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
const TV = window.ToolViews;
const bashInput = {
  command: "cd \"/c/Users/x/memory\" && python - <<'EOF'\np='notes-design.md'; s=open(p,encoding='utf-8').read()\nEOF",
  description: 'Patch the design doc',
  timeout: 120000,
  run_in_background: false,
};

test('Bash call: real newlines in a monospace block, caption, chips, collapsible output, raw JSON', () => {
  const view = TV.renderCall({ name: 'Bash', input: bashInput, result: { text: 'ok\nline2', isError: false } });
  const block = view.byClass('code-block')[0];
  assert.equal(block.copyCode, bashInput.command);
  assert.ok(block.copyCode.includes('\n'));
  assert.equal(block.find('pre')[0].textContent, bashInput.command);
  assert.equal(block.byClass('code-lang')[0].textContent, 'bash');
  assert.equal(view.byClass('tool-caption')[0].textContent, 'Patch the design doc');
  const chips = view.byClass('tool-chip').map((c) => c.textContent);
  assert.deepEqual(chips, ['timeout120000', 'run_in_backgroundfalse']);
  const result = view.byClass('tool-result')[0];
  assert.equal(result.find('summary')[0].textContent, 'Output · 2 lines');
  assert.equal(result.open, true);
  const raw = view.byClass('tool-raw')[0];
  assert.equal(raw.find('summary')[0].textContent, 'Raw JSON');
  assert.doesNotMatch(view.find('pre').slice(0, 1)[0].textContent, /\\n/);
});

test('long output starts collapsed and errors are labelled', () => {
  const text = Array.from({ length: 40 }, (_, i) => 'l' + i).join('\n');
  const view = TV.renderCall({ name: 'PowerShell', input: { command: 'dir' }, result: { text, isError: true } });
  const r = view.byClass('tool-result')[0];
  assert.equal(r.open, false);
  assert.match(r.find('summary')[0].textContent, /^Error output · 40 lines/);
  assert.equal(view.byClass('code-lang')[0].textContent, 'powershell');
});

test('Edit shows the path and a diff; Write shows content with a language from the extension; Read shows the path', () => {
  let v = TV.renderCall({
    name: 'Edit',
    input: { file_path: 'C:/p/a.py', old_string: 'x = 1\n', new_string: 'x = 2\n', replace_all: true },
  });
  assert.equal(v.byClass('tool-path-text')[0].textContent, 'C:/p/a.py');
  assert.equal(v.byClass('tool-diff').length, 1);
  assert.equal(v.byClass('tool-diff')[0].copyCode, 'x = 2\n');
  assert.equal(v.byClass('diff-added')[0].textContent, '+1');
  assert.deepEqual(
    v.byClass('tool-chip').map((c) => c.textContent),
    ['replace_alltrue'],
  );
  v = TV.renderCall({
    name: 'MultiEdit',
    input: {
      file_path: 'a.js',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    },
  });
  assert.equal(v.byClass('tool-diff').length, 2);
  v = TV.renderCall({ name: 'Write', input: { file_path: '/x/y.json', content: '{"a": [1, 2]}\n' } });
  const code = v.byClass('code-block')[0];
  assert.equal(code.copyLang, 'json');
  assert.equal(code.byClass('code-lang')[0].textContent, 'json');
  v = TV.renderCall({ name: 'Read', input: { file_path: '/x/y.py', offset: 10, limit: 5 } });
  assert.equal(v.byClass('tool-path-text')[0].textContent, '/x/y.py');
  assert.deepEqual(
    v.byClass('tool-chip').map((c) => c.textContent),
    ['offset10', 'limit5'],
  );
});

test('OMP shapes: bash, read, grep, eval, edit(input)', () => {
  let v = TV.renderCall({ name: 'bash', input: { command: 'ls', i: 3 }, intent: 'listing' });
  assert.equal(v.byClass('tool-chip').length, 0);
  assert.equal(v.byClass('code-lang')[0].textContent, 'bash');
  assert.equal(v.byClass('tool-caption')[0].textContent, 'listing');
  v = TV.renderCall({ name: 'grep', input: { pattern: 'TODO|FIXME', path: 'src', i: 1 } });
  assert.deepEqual(
    v.byClass('inline-code').map((c) => c.textContent),
    ['TODO|FIXME', 'src'],
  );
  v = TV.renderCall({ name: 'eval', input: { language: 'python', code: 'print(1)', title: 'Quick' } });
  assert.equal(v.byClass('code-block')[0].copyLang, 'python');
  v = TV.renderCall({ name: 'edit', input: { path: 'a.txt', input: '@@ -1 +1 @@\n-a\n+b' } });
  assert.equal(v.byClass('code-block')[0].copyLang, 'diff');
  assert.equal(v.byClass('tool-path-text')[0].textContent, 'a.txt');
});

test('generic fallback: key/values, newline strings as code blocks, nested objects pretty-printed', () => {
  const v = TV.renderCall({
    name: 'mcp__x__thing',
    input: { query: 'short', n: 3, flag: false, prompt: 'line1\nline2', nested: { a: { b: [1, 'two'] } } },
  });
  assert.equal(v.byClass('kv-str')[0].textContent, 'short');
  const blocks = v.byClass('code-block');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].copyCode, 'line1\nline2');
  assert.equal(blocks[1].copyCode, JSON.stringify({ a: { b: [1, 'two'] } }, null, 2));
  assert.ok(blocks[1].find('span').some((s) => s.className === 'tok-key'));
  assert.equal(v.byClass('tool-raw').length, 1);
});

test('truncated or non-JSON input falls back to a code block', () => {
  const rows = TV.pairSaved([{ role: 'tool', label: 'bash', value: '{"command": "ls', callId: '1' }]);
  assert.equal(rows[0].call.input, '{"command": "ls');
  const v = TV.renderCall(rows[0].call);
  assert.equal(v.byClass('code-block')[0].copyCode, '{"command": "ls');
});

test('pairSaved parses JSON, attaches results by id and keeps orphans', () => {
  const rows = TV.pairSaved([
    { role: 'user', value: 'hi' },
    { role: 'tool', label: 'Bash', value: JSON.stringify(bashInput, null, 2), callId: 't1' },
    { role: 'tool', label: 'Read', value: JSON.stringify({ file_path: 'a' }), callId: 't2' },
    { role: 'result', label: 'Tool result', value: 'out', callId: 't1' },
    { role: 'error', label: 'Tool result', value: 'boom', callId: 't2' },
    { role: 'result', label: 'Tool result', value: 'orphan', callId: 'nope' },
  ]);
  assert.equal(JSON.stringify(rows.map((r) => r.role)), '["user","tool","tool","result"]');
  assert.equal(rows[1].call.input.command, bashInput.command);
  assert.equal(JSON.stringify(rows[1].call.result), '{"text":"out","isError":false}');
  assert.equal(JSON.stringify(rows[2].call.result), '{"text":"boom","isError":true}');
});

test('live ACP tool call with rawInput gets the readable body and output; diffs are not duplicated', () => {
  const live = TV.render({
    toolCallId: 'a',
    kind: 'execute',
    title: 'x',
    status: 'completed',
    rawInput: { command: 'echo 1\necho 2', description: 'Two' },
    rawOutput: '1\n2\n',
  });
  assert.equal(live.byClass('code-block')[0].copyCode, 'echo 1\necho 2');
  assert.equal(live.byClass('tool-result').length, 1);
  const edit = TV.render({
    toolCallId: 'b',
    kind: 'edit',
    title: 'Edit',
    status: 'completed',
    rawInput: { file_path: 'a.py', old_string: 'a', new_string: 'b' },
    content: [{ type: 'diff', path: 'a.py', oldText: 'a', newText: 'b' }],
  });
  assert.equal(edit.byClass('tool-diff').length, 1);
  const old = TV.render({ toolCallId: 'c', kind: 'read', title: 'Read', status: 'pending' });
  assert.equal(old.byClass('code-block').length, 0);
});

test('highlighter never loses or alters text', () => {
  const samples = {
    python: 'def f(x):\n    return "a#b" # c\n',
    bash: 'echo "hi" # c\nif [ 1 ]; then ls; fi',
    json: '{"a": [1, 2.5, true, null], "b": "x"}',
    javascript: 'const a = `t${1}`; // c\n/* x */ let b = 3;',
    powershell: "Get-ChildItem 'x' | Where { $true }",
    diff: '@@ -1 +1 @@\n-a\n+b\n c',
    sql: 'SELECT * FROM t -- c',
    unknown: 'zzz',
  };
  for (const [lang, code] of Object.entries(samples))
    assert.equal(
      TV.tokenize(code, lang)
        .map((t) => t.text)
        .join(''),
      code,
      lang,
    );
  assert.ok(TV.tokenize('{"a": 1}', 'json').some((t) => t.cls === 'tok-key' && t.text === '"a"'));
  assert.ok(TV.tokenize('x = "s" # c', 'python').some((t) => t.cls === 'tok-c'));
  assert.equal(TV.tokenize('a'.repeat(40000), 'python').length, 1);
});

test('markdown fences are highlighted but keep their literal text', () => {
  const box = new Node('div');
  window.AgentMarkdown.render(box, '```python\ndef f():\n    return 1\n```');
  assert.equal(box.find('code')[0].textContent, 'def f():\n    return 1');
  assert.ok(box.find('span').some((s) => s.className === 'tok-k'));
});

const callRow = (name, input, result, id) => ({ role: 'tool', label: name, callId: id, call: { name, input, result } });
test('summaries: shell skips cd/variable prefixes, file tools use verb + file name', () => {
  const S = (r) => TV.summarize(r);
  assert.equal(
    S(callRow('Bash', { command: 'cd "/c/a b" && export X=1 && pytest -q tests/x.py' })).text,
    'Ran pytest -q tests/x.py',
  );
  assert.equal(
    S(callRow('PowerShell', { command: "$sp = 'x'; Add-Type -Name y\nGet-ChildItem" })).text,
    'Ran Add-Type -Name y ; Get-ChildItem',
  );
  assert.equal(S(callRow('Bash', { command: 'cd /x' })).text, 'Ran cd /x');
  const d = S(
    callRow('Bash', { command: 'git ls-files | wc -l', description: 'Survey tracked files and scan for secrets' }),
  );
  assert.equal(d.text, 'Survey tracked files and scan for secrets');
  assert.equal(d.hint, 'Ran git ls-files | wc -l');
  assert.equal(
    S(callRow('PowerShell', { command: 'Get-ChildItem', description: '  List   files ' })).text,
    'List files',
  );
  assert.equal(S(callRow('Bash', { command: 'ls', description: '' })).text, 'Ran ls');
  assert.equal(
    S(
      callRow('Bash', {
        command:
          "cd /x && python - <<'EOF'" + String.fromCharCode(10) + 'print(1); x=2' + String.fromCharCode(10) + 'EOF',
      }),
    ).text,
    "Ran python - <<'EOF'",
  );
  assert.equal(
    S(callRow('Edit', { file_path: 'C:/p/src/overlay.rs', old_string: 'a', new_string: 'b' })).text,
    'Edited overlay.rs',
  );
  assert.equal(S(callRow('Read', { file_path: '/m/notes-design.md' })).text, 'Read notes-design.md');
  assert.equal(S(callRow('Write', { file_path: '/m/n.txt', content: 'x' })).text, 'Wrote n.txt');
  assert.equal(S(callRow('Grep', { pattern: 'TODO', path: '/a/src' })).text, "Searched 'TODO' in src");
  assert.equal(S(callRow('Agent', { description: 'Find the bug', prompt: 'long' })).text, 'Agent: Find the bug');
  assert.equal(S(callRow('mcp__rea__open_binary', { path: 'x.exe' })).text, 'open binary: x.exe');
});

test('status: derived from the matching result, pending (•) when there is no result yet, live statuses map', () => {
  const st = (r) => TV.summarize(r).status;
  assert.equal(st(callRow('Bash', { command: 'ls' })), 'pending'); // a saved call without a result: pending, never a blank mark (running only via call.running, see test_status_drawer_toolmark.js)
  assert.equal(st(callRow('Bash', { command: 'ls' }, { text: 'ok', isError: false })), 'ok');
  assert.equal(st(callRow('Bash', { command: 'ls' }, { text: 'boom', isError: true })), 'failed');
  assert.equal(st(callRow('Bash', { command: 'ls' }, { text: 'Exit code 2\nbad', isError: false })), 'failed');
  for (const [s, e] of [
    ['pending', 'pending'],
    ['in_progress', 'running'],
    ['completed', 'ok'],
    ['failed', 'failed'],
  ])
    assert.equal(st({ role: 'tool', raw: { toolCallId: '1', title: 't', kind: 'other', status: s } }), e);
});

test('collapsed line is a button with aria-expanded; detail is lazy, copy lives in the detail; state survives rebuilds', () => {
  let built = 0;
  const row = callRow('Bash', { command: 'cd x && make all' }, { text: 'x', isError: true }, 'k1');
  let line = TV.line(row, () => {
    built++;
    return new Node('article');
  });
  const btn = line.find('button')[0];
  assert.equal(btn.getAttribute('aria-expanded'), 'false');
  assert.equal(built, 0);
  assert.equal(btn.title, 'Ran make all');
  assert.match(btn.textContent, /failed/);
  assert.ok(!line.byClass('copy-ctl').length);
  btn.click();
  assert.equal(btn.getAttribute('aria-expanded'), 'true');
  assert.equal(built, 1);
  line = TV.line(row, () => {
    built++;
    return new Node('article');
  });
  assert.equal(line.find('button')[0].getAttribute('aria-expanded'), 'true');
  assert.equal(built, 2);
  line.find('button')[0].click();
  assert.equal(line.find('button')[0].getAttribute('aria-expanded'), 'false');
});

test('more than 3 consecutive tool rows group into "N steps"; text between breaks runs', () => {
  const t = (i) => callRow('Read', { file_path: '/a/f' + i + '.py' }, null, 'g' + i),
    msg = { role: 'assistant', value: 'hi' };
  const render = (r) => {
    const n = new Node('div');
    n.rowRole = r.role;
    return n;
  };
  assert.equal(TV.groupRows([t(1), t(2), t(3)], render).length, 3);
  const four = TV.groupRows([msg, t(1), t(2), t(3), t(4), msg], render);
  assert.equal(four.length, 3);
  assert.ok(four[1].hasClass('tool-group'));
  const gbtn = four[1].find('button')[0];
  assert.equal(gbtn.textContent.includes('4 steps'), true);
  assert.equal(gbtn.getAttribute('aria-expanded'), 'false');
  gbtn.click();
  assert.equal(four[1].byClass('tool-group-body')[0].children.length, 4);
  gbtn.click();
  assert.equal(TV.groupRows([t(1), t(2), msg, t(3), t(4)], render).length, 5);
});

test('steps still in progress stay listed one by one until they are done and something arrives after them', () => {
  const t = (i, status) => {
      const r = callRow('Read', { file_path: '/a/f' + i + '.py' }, null, 'p' + i);
      if (status) r.call.running = true; // the chat marks a call still being worked on
      return r;
    },
    msg = { role: 'assistant', value: 'hi' };
  const render = (r) => {
    const n = new Node('div');
    n.rowRole = r.role;
    return n;
  };
  // the latest run, nothing after it yet: not folded
  assert.equal(TV.groupRows([msg, t(1), t(2), t(3), t(4), t(5)], render).length, 6);
  // a step still running: not folded, even with a message after it
  assert.equal(TV.groupRows([msg, t(1), t(2), t(3), t(4, 'in_progress'), msg], render).length, 6);
  // done and followed by a message: folded
  assert.equal(TV.groupRows([msg, t(1), t(2), t(3), t(4), msg], render).length, 3);
});
