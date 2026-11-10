'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadChat } = require('./chat_harness.js');
const vm = require('node:vm');
function storage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) || null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}
function load() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', checked: false, hidden: false, addEventListener() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    localStorage: storage(),
    sessionStorage: storage(),
    document: { getElementById: element },
    window: { addEventListener() {} },
    fetch: () => new Promise(() => {}),
    setInterval() {},
    URLSearchParams,
    console,
  });
  return loadChat(context).hook.DraftStore;
}
const DraftStore = load();
test('drafts survive reload and remain separate by provider and session', () => {
  const backing = storage(),
    first = new DraftStore(backing);
  first.set('omp:one', 'first draft');
  first.set('claude:one', 'different draft');
  const restored = new DraftStore(backing);
  assert.equal(restored.get('omp:one'), 'first draft');
  assert.equal(restored.get('claude:one'), 'different draft');
  restored.delete('omp:one');
  assert.equal(new DraftStore(backing).get('omp:one'), '');
  assert.equal(new DraftStore(backing).get('claude:one'), 'different draft');
});
test('malformed persisted drafts do not break the client', () => {
  const backing = storage();
  backing.setItem('studio-drafts-v1', 'not JSON');
  assert.equal(new DraftStore(backing).get('x'), '');
  backing.setItem('studio-drafts-v1', JSON.stringify({ version: 1, drafts: { valid: 'text', invalid: 42 } }));
  const restored = new DraftStore(backing);
  assert.equal(restored.get('valid'), 'text');
  assert.equal(restored.get('invalid'), '');
});
test('failed persistence leaves the in-page draft available', () => {
  const backing = {
      getItem: () => null,
      setItem: () => {
        throw Error('quota');
      },
    },
    drafts = new DraftStore(backing);
  assert.throws(() => drafts.set('omp:one', 'keep this'), /quota/);
  assert.equal(drafts.get('omp:one'), 'keep this');
});
