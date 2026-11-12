'use strict';
/* view-prefs.js: view and appearance preferences follow the data folder (studio-view.json) instead of the browser profile.
   The server half (the store, the route, the data block in chat.html) is tested in work/deno/view_prefs_test.ts. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const V = require(path.join(APP, 'view-prefs.js'));

/* A Storage look-alike with its methods on the prototype, as in a browser (the hook patches the prototype). */
function storageClass() {
  class FakeStorage {
    constructor(init) {
      this.m = new Map(Object.entries(init || {}));
    }
    get length() {
      return this.m.size;
    }
    key(i) {
      return [...this.m.keys()][i] ?? null;
    }
    getItem(k) {
      return this.m.has(k) ? this.m.get(k) : null;
    }
    setItem(k, v) {
      this.m.set(String(k), String(v));
    }
    removeItem(k) {
      this.m.delete(String(k));
    }
  }
  return FakeStorage;
}

function page(saved, local, answers) {
  const S = storageClass();
  const storage = new S(local),
    other = new S(); // sessionStorage: shares the prototype, must not be synced
  const timers = [];
  const posts = [];
  const queue = [...(answers || [])];
  const doc = {
    getElementById: (id) =>
      id === 'aibViewPrefs' && saved !== undefined ? { textContent: JSON.stringify({ prefs: saved }) } : null,
    addEventListener() {},
  };
  const win = { document: doc, addEventListener() {} };
  const fetch = async (url, o) => {
    if (url === '/api/live/bootstrap')
      return { ok: true, status: 200, json: async () => ({ token: 'tok' + posts.length }) };
    posts.push({ url, headers: o.headers, body: JSON.parse(o.body), keepalive: o.keepalive });
    const status = queue.length ? queue.shift() : 200;
    return { ok: status === 200, status, json: async () => ({}) };
  };
  const ctl = V.init(win, {
    storage,
    proto: S.prototype,
    fetch,
    setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimeout: () => {},
  });
  const runTimers = async () => {
    while (timers.length) {
      await timers.shift().fn();
      await new Promise((r) => setImmediate(r));
    }
  };
  return { ctl, storage, other, posts, timers, runTimers };
}
test.afterEach(() => {
  // init() keeps one live instance per page; each test makes a new page
  const live = V.init({ document: { getElementById: () => null } });
  if (live) live.stop();
});

test('the keys that move: layout and view state, by exact name or per-bucket prefix; drafts and caches stay', () => {
  for (const k of [
    'studio-workspace-v1',
    'studio-sidebar-group',
    'studio-sidebar-collapsed',
    'studio-archived-open',
    'studio-hold-open-by-project',
    'studio-chat-views',
    'studio-conversation-names',
    'studio-side-hidden',
    'studio-activity-hidden',
    'aib-terminal-height',
    'agentStudio.copyFormat',
    'agentStudio.copyFormat.code',
    'studio-textsize-v1:<1400',
    'studio-textsize-v1:>=1800',
    'studio-layout-v1:<1800',
    'studio-seen-turns',
    'studio-new-chat-agent',
    'studio-sidebar-epoch',
    'aib-sidebar-mode',
    'aib-file-tabs-v1',
    'aib-files-open-v1',
  ])
    assert.equal(V.synced(k), true, k);
  for (const k of [
    'studio-drafts-v1',
    'studio-prompt-attempts-v1',
    'studio-pending-sends-v1',
    'studio-read-state-v2',
    'studio-last-viewed-v1',
    'studio-subagents-finished:claude:abc',
    'studio-project-prefs-v1',
    'studio-agent-options-v1',
    'studio-selected',
    'aib-doc-page:abc',
    'studio-textsize-v1:',
    'aib-token.x',
    '',
    null,
  ])
    assert.equal(V.synced(k), false, String(k));
});

test('every key that moves is one a page script really uses (a renamed key fails here)', () => {
  const source = fs
    .readdirSync(APP)
    .filter((n) => n.endsWith('.js') && n !== 'view-prefs.js')
    .map((n) => fs.readFileSync(path.join(APP, n), 'utf8'))
    .join('\n');
  for (const k of [...V.KEYS, ...V.PREFIXES]) assert.ok(source.includes("'" + k), k);
});

test('plan: the data folder wins; a key it does not have yet is taken from localStorage and uploaded', () => {
  const r = V.plan(
    { 'studio-workspace-v1': '{"active":"all"}', 'studio-side-hidden': '0', 'studio-drafts-v1': 'x' },
    { 'studio-workspace-v1': '{"active":"w:c/a"}', 'studio-side-hidden': '0', 'studio-sidebar-group': '"project"' },
  );
  assert.deepEqual(r.seed, { 'studio-workspace-v1': '{"active":"all"}' });
  assert.deepEqual(r.upload, { 'studio-sidebar-group': '"project"' });
});

test('start: saved values are in localStorage before anything reads it; a fresh copy of the app gets the saved look', async () => {
  const p = page({ 'studio-workspace-v1': '{"v":1,"active":"all"}', 'studio-textsize-v1:<1800': '{"chat":120}' }, {});
  assert.equal(p.storage.getItem('studio-workspace-v1'), '{"v":1,"active":"all"}');
  assert.equal(p.storage.getItem('studio-textsize-v1:<1800'), '{"chat":120}');
  await p.runTimers();
  assert.deepEqual(p.posts, [], 'nothing to send back');
});

test('start: values an older copy remembered move to the data folder once', async () => {
  const p = page(
    {},
    { 'studio-sidebar-collapsed': '["x"]', 'studio-drafts-v1': '{"a":1}', 'studio-layout-v1:<1400': '{"side":300}' },
  );
  assert.deepEqual(p.ctl.uploading.sort(), ['studio-layout-v1:<1400', 'studio-sidebar-collapsed']);
  await p.runTimers();
  assert.equal(p.posts.length, 1);
  assert.deepEqual(p.posts[0].body, {
    set: { 'studio-sidebar-collapsed': '["x"]', 'studio-layout-v1:<1400': '{"side":300}' },
  });
  assert.equal(p.posts[0].url, '/api/live/view-prefs');
  assert.equal(p.posts[0].headers['X-Studio-Token'], 'tok0');
});

test('changes are sent at once (next tick), removals as null; other keys and sessionStorage are not', async () => {
  const p = page({}, {});
  p.storage.setItem('studio-textsize-v1:<1800', '{"chat":110}');
  p.storage.setItem('studio-textsize-v1:<1800', '{"chat":120}');
  p.storage.removeItem('studio-side-hidden');
  p.storage.setItem('studio-drafts-v1', 'draft');
  p.other.setItem('studio-workspace-v1', 'session copy');
  assert.equal(p.storage.getItem('studio-drafts-v1'), 'draft', 'the real setItem still runs');
  assert.deepEqual(
    p.timers.map((t) => t.ms),
    [0],
    'one send on the next tick for the whole burst, nothing waits for the page to close',
  );
  await p.runTimers();
  assert.equal(p.posts.length, 1);
  assert.deepEqual(p.posts[0].body, {
    set: { 'studio-textsize-v1:<1800': '{"chat":120}', 'studio-side-hidden': null },
  });
});

test('a failed save is retried later with the newest values; a stale token is renewed once', async () => {
  const p = page({}, {}, [503, 403, 200]);
  p.storage.setItem('studio-chat-views', '{"a":"chat"}');
  await p.timers.shift().fn(); // 503: kept, retry scheduled
  assert.deepEqual(p.ctl.pending(), { 'studio-chat-views': '{"a":"chat"}' });
  assert.equal(p.timers[p.timers.length - 1].ms, 5000);
  p.storage.setItem('studio-chat-views', '{"a":"prompts"}');
  await p.runTimers(); // 403 then 200 with a new token
  assert.deepEqual(p.ctl.pending(), {});
  const last = p.posts[p.posts.length - 1];
  assert.deepEqual(last.body, { set: { 'studio-chat-views': '{"a":"prompts"}' } });
  assert.notEqual(last.headers['X-Studio-Token'], p.posts[p.posts.length - 2].headers['X-Studio-Token']);
});

test('a change made while a save is on its way goes out right after it; a busy stream of changes is one request per 100 ms', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const p = page({}, {});
  let t = 1000;
  // swap in a slow first answer and a clock
  p.ctl.stop();
  const S = storageClass();
  const storage = new S();
  const timers = [],
    posts = [];
  const fetch = async (url, o) => {
    if (url === '/api/live/bootstrap') return { ok: true, status: 200, json: async () => ({ token: 't' }) };
    posts.push(JSON.parse(o.body));
    if (posts.length === 1) await gate;
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const doc = { getElementById: () => ({ textContent: '{"prefs":{}}' }), addEventListener() {} };
  const ctl = V.init(
    { document: doc, addEventListener() {} },
    {
      storage,
      proto: S.prototype,
      fetch,
      now: () => t,
      setTimeout: (fn, ms) => (timers.push({ fn, ms }), timers.length),
      clearTimeout: () => {},
    },
  );
  storage.setItem('studio-workspace-v1', '{"active":"a"}');
  const first = timers.shift().fn(); // on its way, not answered yet
  await new Promise((r) => setImmediate(r));
  storage.setItem('studio-workspace-v1', '{"active":"b"}');
  storage.setItem('aib-file-tabs-v1', '{}');
  assert.equal(timers.length, 0, 'waits for the request on its way');
  t += 30;
  release();
  await first;
  assert.equal(timers.length, 1, 'sent again as soon as the first one ended');
  assert.equal(timers[0].ms, 70, 'no sooner than 100 ms after the previous request');
  await timers.shift().fn();
  assert.deepEqual(posts, [
    { set: { 'studio-workspace-v1': '{"active":"a"}' } },
    { set: { 'studio-workspace-v1': '{"active":"b"}', 'aib-file-tabs-v1': '{}' } },
  ]);
  assert.deepEqual(ctl.pending(), {});
});

test('a malformed batch (400) is not sent again; keys the server refused are not either', async () => {
  const p = page({}, {}, [400, 200]);
  p.storage.setItem('studio-chat-views', 'x');
  await p.runTimers();
  assert.deepEqual(p.ctl.pending(), {});
  p.storage.setItem('studio-workspace-v1', '{"active":"a"}');
  await p.runTimers();
  assert.equal(p.posts.length, 2);
  assert.equal(p.timers.length, 0, 'no retry planned');
});

test('the one-time move covers the new keys: a page from before this build pushes its files tabs, open folders and seen turns up', async () => {
  const p = page(
    { 'studio-workspace-v1': '{"v":1,"active":"w:c:/p"}' },
    {
      'studio-workspace-v1': '{"v":1,"active":"w:c:/old"}',
      'aib-file-tabs-v1': '{"w:c:/p":{"tabs":[]}}',
      'aib-files-open-v1': '{"w:c:/p\nmain":["src"]}',
      'studio-seen-turns': '{"claude:a":5}',
      'aib-sidebar-mode': 'files',
    },
  );
  assert.equal(p.storage.getItem('studio-workspace-v1'), '{"v":1,"active":"w:c:/p"}', 'the data folder still wins');
  await p.runTimers();
  assert.deepEqual(Object.keys(p.posts[0].body.set).sort(), [
    'aib-file-tabs-v1',
    'aib-files-open-v1',
    'aib-sidebar-mode',
    'studio-seen-turns',
  ]);
});

test('without the data block (a server without view preferences) nothing is hooked or sent', () => {
  const p = page(undefined, { 'studio-workspace-v1': 'x' });
  assert.equal(p.ctl, null);
  p.storage.setItem('studio-workspace-v1', 'y');
  assert.equal(p.timers.length, 0);
  assert.equal(V.readBlock({ getElementById: () => ({ textContent: 'not json' }) }), null);
  assert.deepEqual(V.readBlock({ getElementById: () => ({ textContent: '{"prefs":{"a":"1","b":2}}' }) }), { a: '1' });
});

test('chat.html loads view-prefs.js before every other deferred page script (themes.js runs first, not deferred)', () => {
  const html = fs.readFileSync(path.join(APP, 'chat.html'), 'utf8');
  assert.ok(html.includes('<script src="/themes.js"></script>'), 'themes.js: blocking, so the theme is on <html> before paint');
  const first = html.match(/<script\b[^>]*\bsrc="\/([a-z0-9-]+\.js)" defer/);
  assert.equal(first[1], 'view-prefs.js');
  assert.ok(V.KEYS.includes('aib-theme'), 'the theme choice is kept in the data folder');
});

test('writing the value the data folder already has sends nothing (the sidebar rewrites its state on every list update)', async () => {
  const ws = '{"v":1,"active":"w:c:/a"}';
  const p = page({ 'studio-workspace-v1': ws }, {});
  await p.runTimers();
  p.posts.length = 0;
  p.storage.setItem('studio-workspace-v1', ws);
  await p.runTimers();
  assert.deepEqual(p.posts, [], 'the same value again: no request (a pick right after it would wait behind it)');
  p.storage.setItem('studio-workspace-v1', '{"v":1,"active":"w:c:/b"}');
  await p.runTimers();
  assert.equal(p.posts.length, 1, 'a real change is sent');
  p.storage.setItem('studio-workspace-v1', '{"v":1,"active":"w:c:/b"}');
  await p.runTimers();
  assert.equal(p.posts.length, 1, 'and is then known');
  p.storage.setItem('studio-workspace-v1', ws);
  await p.runTimers();
  assert.equal(p.posts.length, 2, 'going back to the first value is a change too');
  assert.deepEqual(p.posts[1].body, { set: { 'studio-workspace-v1': ws } });
});
