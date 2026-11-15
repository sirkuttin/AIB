'use strict';
/* store-merge.js (multi-window Phase 1B): per-entry merges between windows that share one localStorage. Two "windows" here are
   two helper instances on one fake storage; refresh() stands in for the storage event. */
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const { APP } = require('./_paths.js');
const M = require(path.join(APP, 'store-merge.js'));

function fakeStorage() {
  const m = new Map();
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}
const win = (storage, ctx, extra = {}) =>
  M.make(
    {},
    Object.assign(
      {
        storage,
        ctx: Object.assign({ w: 'm', kind: 'main', mode: '', project: '', chat: '' }, ctx),
        channel: null,
        noEvents: true,
      },
      extra,
    ),
  );
const drafts = (W) =>
  W.map('studio-drafts-v1', {
    entries: (p) => (p && p.version === 1 && p.drafts) || {},
    build: (obj) => ({ version: 1, drafts: obj }),
  });

test('two windows: each draft survives the other window writing its own (C1)', () => {
  const st = fakeStorage();
  const A = drafts(win(st, {})),
    B = drafts(win(st, { w: 'w2', kind: 'project', project: 'p' }));
  A.load();
  B.load();
  A.set('chat-x', 'hello from A');
  B.set('chat-y', 'hello from B'); // B never saw A's draft in memory
  const saved = JSON.parse(st.getItem('studio-drafts-v1'));
  assert.deepEqual(saved, { version: 1, drafts: { 'chat-x': 'hello from A', 'chat-y': 'hello from B' } });
  // a whole-value write (the module's old shape) only writes what changed since it loaded
  A.write({ 'chat-x': 'hello from A, more' });
  assert.deepEqual(JSON.parse(st.getItem('studio-drafts-v1')).drafts, {
    'chat-x': 'hello from A, more',
    'chat-y': 'hello from B',
  });
  B.del('chat-y');
  assert.deepEqual(JSON.parse(st.getItem('studio-drafts-v1')).drafts, { 'chat-x': 'hello from A, more' });
});

test('one window: the saved text is exactly what the old code wrote (formats unchanged)', () => {
  const st = fakeStorage();
  const A = drafts(win(st, {}));
  A.load();
  A.set('a', 'one');
  A.set('b', 'two');
  A.del('a');
  assert.equal(st.getItem('studio-drafts-v1'), JSON.stringify({ version: 1, drafts: { b: 'two' } }));
  // unknown fields of the stored value are the builder's to keep
  st.setItem('k', JSON.stringify({ v: 2, extra: 'x', items: { a: 1 } }));
  const K = win(st, {}).map('k', {
    entries: (p) => p.items,
    build: (obj, prev) => Object.assign({}, prev, { items: obj }),
  });
  K.load();
  K.set('b', 2);
  assert.deepEqual(JSON.parse(st.getItem('k')), { v: 2, extra: 'x', items: { a: 1, b: 2 } });
});

test('newest change wins per entry; a refresh tells the module what changed', () => {
  const st = fakeStorage();
  const A = win(st, {}).map('s'),
    B = win(st, { w: 'w2', kind: 'project', project: 'p' }).map('s');
  A.load();
  B.load();
  const seen = [];
  A.onChange((obj, changed) => seen.push([obj, changed]));
  A.set('x', 1);
  B.set('x', 2);
  assert.deepEqual(JSON.parse(st.getItem('s')), { x: 2 });
  assert.equal(A.refresh(), true);
  assert.deepEqual(seen.at(-1), [{ x: 2 }, ['x']]);
  assert.equal(A.refresh(), false, 'nothing new: no second call');
});

test('cap keeps the newest entries; an entry set again moves to the end', () => {
  const st = fakeStorage();
  const A = win(st, {}).map('scroll', { cap: 3 });
  A.load();
  for (const k of ['a', 'b', 'c']) A.set(k, k);
  A.set('a', 'a2');
  A.set('d', 'd');
  assert.deepEqual(Object.keys(JSON.parse(st.getItem('scroll'))), ['c', 'a', 'd']);
});

test('ownership: a project window writes only its project; a pop-out writes no layout and only its own chat', () => {
  const st = fakeStorage();
  const P = win(st, { w: 'w2', kind: 'project', project: 'budget' });
  const tabs = P.map('tabs', { writable: (k) => P.mayWriteProject(k) });
  tabs.load();
  tabs.write({ budget: ['t1'], recipes: ['stolen'] });
  assert.deepEqual(JSON.parse(st.getItem('tabs')), { budget: ['t1'] });
  const Pop = win(st, { w: 'w3', kind: 'chat', mode: 'chat', chat: 'claude:1', project: 'budget' });
  assert.equal(Pop.layoutWritable(), false);
  assert.equal(Pop.mayWriteProject('budget'), false);
  const d = Pop.map('d', { writable: (k) => Pop.mayWriteChat(k) });
  d.load();
  d.set('claude:1', 'mine');
  d.set('claude:2', 'not mine');
  assert.deepEqual(JSON.parse(st.getItem('d')), { 'claude:1': 'mine' });
  const Main = win(st, {});
  assert.equal(Main.layoutWritable(), true);
  assert.equal(Main.mayWriteProject('recipes'), true);
  Main.setOwnedElsewhere((p) => p === 'budget');
  assert.equal(Main.mayWriteProject('budget'), false);
  assert.equal(win(st, { w: 'w4', kind: 'doc' }).layoutWritable(), false);
});

test('self-repair: an entry this window wrote moments ago that a racing write lost is written again, once', () => {
  const st = fakeStorage();
  let t = 1000;
  const A = win(st, {}, { now: () => t }).map('s');
  A.load();
  A.set('mine', 'A');
  // window B read before A wrote and wrote after: A's entry is gone
  st.setItem('s', JSON.stringify({ theirs: 'B' }));
  t += 500;
  A.refresh();
  assert.deepEqual(JSON.parse(st.getItem('s')), { theirs: 'B', mine: 'A' });
  st.setItem('s', JSON.stringify({ theirs: 'B2' }));
  t += 100;
  A.refresh();
  assert.deepEqual(JSON.parse(st.getItem('s')), { theirs: 'B2' }, 'healed once only');
  // long after the write, a missing entry was removed on purpose by another window: left alone
  const C = win(st, {}, { now: () => t }).map('c');
  C.load();
  C.set('x', 1);
  st.setItem('c', '{}');
  t += 10000;
  C.refresh();
  assert.equal(st.getItem('c'), '{}');
});

test('per-window keys: main uses the plain key; window 2 starts from main and then keeps its own', () => {
  const st = fakeStorage();
  const Main = win(st, {}),
    W2 = win(st, { w: 'w2', kind: 'project', project: 'p' });
  st.setItem('studio-side-hidden', '1');
  assert.equal(Main.winKey('studio-side-hidden'), 'studio-side-hidden');
  const k = W2.winKey('studio-side-hidden');
  assert.equal(k, 'studio-side-hidden:w2');
  assert.equal(st.getItem(k), '1', 'first run copies the main window');
  st.setItem(k, '0');
  st.setItem('studio-side-hidden', '1');
  st.removeItem(k); // the window removed its own value: not copied again
  W2.winKey('studio-side-hidden');
  assert.equal(st.getItem(k), null);
  assert.equal(win(st, { w: 't-abcd' }).winKey('x'), 'x', 'browser tabs share the plain key');
});

test('readContext: the query wins and is kept per window; a bad id counts as the main window', () => {
  const ss = fakeStorage();
  const a = M.readContext({ location: { search: '?w=w2&kind=project&project=abc' }, sessionStorage: ss });
  assert.deepEqual(a, { w: 'w2', kind: 'project', mode: '', project: 'abc', chat: '' });
  const again = M.readContext({ location: { search: '' }, sessionStorage: ss });
  assert.equal(again.w, 'w2', 'a reload without the query keeps the id');
  const bad = M.readContext({ location: { search: '?w=evil' }, sessionStorage: fakeStorage() });
  assert.equal(bad.w, 'm');
});

test('a full storage keeps the store working in memory', () => {
  const st = fakeStorage();
  st.setItem = () => {
    throw new Error('QuotaExceededError');
  };
  const A = win(st, {}).map('s');
  A.load();
  assert.deepEqual(A.set('x', 1), { x: 1 });
});
