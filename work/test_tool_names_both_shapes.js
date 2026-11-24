'use strict';
// Tool consolidation slice 3 (M4): the page readers that key on tool names read BOTH the old shape (doc_edit, publish, update) and the
// new one (doc + action, publish with id, artifacts + action). Old transcripts keep the old names for good.
const { PAGE: APP_DIR } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
const L = require('../app/page/doc-links.js');
const A = require('../app/page/artifacts-ui.js');

const mk = () => {
  const el = () => ({ children: [], append() {}, textContent: '', classList: { add() {} }, setAttribute() {} });
  const window = {};
  const ctx = vm.createContext({ document: { createElement: el }, window, URL, console });
  for (const f of ['markdown.js', 'tool-views.js']) vm.runInContext(fs.readFileSync(path.join(APP_DIR, f), 'utf8'), ctx);
  return window.ToolViews;
};
const TV = mk();
const raw = (name, input, out) => ({
  role: 'tool',
  raw: {
    toolCallId: 't',
    status: 'completed',
    kind: 'other',
    _meta: { claudeCode: { toolName: 'mcp__studio_artifact__' + name } },
    rawInput: input,
    rawOutput: out === undefined ? undefined : { content: [{ type: 'text', text: JSON.stringify(out) }] },
  },
});
const docs = [{ name: 'plan', title: 'Plan', pages: 1, pageList: [{ id: 'p1', title: 'Risks' }] }];

test('doc rows: old names and new doc + action give the same call and words', () => {
  const pairs = [
    [['doc_edit', { doc: 'plan', page: 'p1' }], ['doc', { action: 'edit', doc: 'plan', page: 'p1' }], 'doc_edit', 'Wrote Risks in Plan'],
    [['doc_read', { doc: 'plan' }], ['doc', { action: 'read', doc: 'plan' }], 'doc_read', 'Read Plan'],
    [['doc_reply', { doc: 'plan' }], ['doc', { action: 'reply', doc: 'plan' }], 'doc_reply', 'Replied to a comment in Plan'],
    [['doc_list', {}], ['doc', { action: 'list' }], 'doc_list', 'Listed the docs'],
    [['drawing_create', { doc: 'plan' }], ['drawing', { action: 'create', doc: 'plan' }], 'drawing_create', 'Drew in Plan'],
    [['doc_page', { doc: 'plan', action: 'add', title: 'M' }], ['doc', { action: 'page', change: 'add', doc: 'plan', title: 'M' }], 'doc_page', 'Added page M to Plan'],
  ];
  for (const [o, n, tool, words] of pairs) {
    const a = L.toolCall(raw(o[0], o[1])),
      b = L.toolCall(raw(n[0], n[1]));
    assert.equal(a.tool, tool);
    assert.equal(b.tool, tool);
    assert.equal(L.toolText(a, docs), words);
    assert.equal(L.toolText(b, docs), words);
  }
  assert.equal(L.toolCall(raw('doc', {})), null, 'a doc call with no action is no row');
});

test('artifact rows: publish, update, merged publish with id, artifacts list', () => {
  const res = { id: '0123456789abcdef', version: 1 };
  assert.equal(A.artifactCall(raw('publish', { title: 'T', path: 'a.html' }, res)).op, 'publish');
  assert.equal(A.artifactCall(raw('update', { id: res.id, path: 'a.html' }, res)).op, 'update');
  assert.equal(A.artifactCall(raw('publish', { id: res.id, path: 'a.html' }, res)).op, 'update');
  assert.equal(A.artifactCall(raw('list', {})).op, 'list');
  assert.equal(A.artifactCall(raw('artifacts', { action: 'list' })).op, 'list');
  assert.equal(A.artifactCall(raw('artifacts', { action: 'archive', ids: ['x'] })), null);
});

test('tool-view labels: new calls read naturally, old ones keep their words', () => {
  const S = (name, input) => TV.summarize(raw(name, input)).text;
  assert.equal(S('doc', { action: 'edit', doc: 'plan' }), 'Doc · edit: plan');
  assert.equal(S('helper', { action: 'work_land', work: 'sa_1' }), 'Helper · work land');
  assert.equal(S('publish', { title: 'Drop rates' }), 'Published page: Drop rates');
  assert.equal(S('publish', { id: 'abc' }), 'Published a new version: abc');
  assert.equal(S('doc_create', { doc: 'plan' }), 'Create doc: plan');
  assert.equal(S('update', { id: 'abc' }), 'Update artifact: abc');
});
