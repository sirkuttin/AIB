// read-state.js: the page's view of the server-kept read positions (cache, forward-only merge, migration of old keys).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(stored = {}, server = { chats: {}, revision: 'r1' }) {
  const store = Object.assign({}, stored);
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
    removeItem: (k) => {
      delete store[k];
    },
  };
  const posts = [];
  const window = { localStorage, setTimeout: () => 1 };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../outputs/agent-studio/read-state.js'), 'utf8'), {
    window,
    Object,
    Array,
    Number,
    Math,
    JSON,
    isNaN,
    isFinite,
    RegExp,
    Promise,
    Error,
  });
  const rs = window.AgentReadState;
  rs.init({
    get: async () => server,
    post: async (name, body) => {
      posts.push([name, body]);
      return { revision: 'r2' };
    },
  });
  return { rs, store, posts, server };
}

test('positions only move forward and keep the index when a newer one has none', () => {
  const { rs } = setup();
  rs.mark('claude:a', 1000, 5);
  rs.mark('claude:a', 500, 9);
  assert.equal(rs.seenAt('claude:a'), 1000);
  assert.equal(rs.seenIndex('claude:a'), 5);
  rs.mark('claude:a', 2000);
  assert.equal(rs.seenAt('claude:a'), 2000);
  assert.equal(rs.seenIndex('claude:a'), 5);
  rs.mark('not a key', 1);
  assert.equal(rs.seenAt('not a key'), 0);
});

test('the browser cache is read at start and the server value is merged in', async () => {
  const cached = JSON.stringify({ 'claude:a': { seenAt: 100 } });
  const { rs } = setup(
    { 'studio-read-state-v2': cached },
    { revision: 'r9', chats: { 'claude:a': { seenAt: 300, seenIndex: 2 }, 'omp:b': { seenAt: 7 } } },
  );
  assert.equal(rs.seenAt('claude:a'), 100);
  assert.equal(await rs.sync('r9'), true);
  assert.equal(rs.seenAt('claude:a'), 300);
  assert.equal(rs.seenIndex('claude:a'), 2);
  assert.equal(rs.seenAt('omp:b'), 7);
});

test('flush sends only what changed', async () => {
  const { rs, posts } = setup();
  rs.mark('claude:a', 1000, 3);
  await rs.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [
    ['read-state', { set: { 'claude:a': { seenAt: 1000, seenIndex: 3 } } }],
  ]);
  await rs.flush();
  assert.equal(posts.length, 1);
});
