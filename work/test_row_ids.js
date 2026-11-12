'use strict';
/* Stable row ids (scroll design step 1): every row carries rid, from the events, not the drawing. 'L:' + the event number of its
   first event (live), 'T:' + its index in the whole transcript (saved), 'P:' + n (a send not shown yet). The same row keeps its id
   when older pages load, when the 6,000-event window slides, in every view and in a split pane. */
const assert = require('node:assert/strict');
const test = require('node:test');
const { makePage, El } = require('./chat_harness.js');

/* the harness' fake list: a fragment's children land in the list (as in test_views_unread.js) */
El.prototype.replaceChildren = function (...items) {
  this.children = items.flatMap((i) => (i.id === 'fragment' ? i.children : [i]));
};

const SCRIPTS = ['read-state.js', 'stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js', 'views-ui.js'];
let seq = 0;
const ev = (kind, data, time) => ({ seq: ++seq, kind, time, data: { sessionId: 's', ...data } });
const say = (text, time) => ev('user', { text }, time);
const chunk = (text, time) => ev('update', { update: { sessionUpdate: 'agent_message_chunk', content: { text } } }, time);
const call = (id, time, status = 'completed') =>
  ev('update', { update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash ' + id, kind: 'execute', status } }, time);
const update = (id, time) =>
  ev('update', { update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: 'ok' } }, time);

function chat() {
  seq = 0;
  const evs = [say('question', 1000), chunk('Hello ', 1001), chunk('world', 1002), call('c1', 1003, 'in_progress')];
  evs.push(update('c1', 1004), chunk('Done', 1005));
  for (let i = 0; i < 6; i++) evs.push(call('x' + i, 1010 + i));
  evs.push(chunk('After the steps', 1020));
  return evs;
}
const page = () => makePage({ scripts: SCRIPTS });
const ids = (rows) => rows.map((r) => r.rid);

test('live rows: a merged message keeps its first chunk, a step its tool_call, whatever updates come after', () => {
  const p = page();
  const evs = chat();
  const rows = p.hook.liveRows('s', evs, { sessionId: 's' });
  const byText = (t) => rows.find((r) => String(r.value).includes(t));
  assert.equal(byText('question').rid, 'L:1');
  assert.equal(byText('Hello world').rid, 'L:2', 'two chunks, one row, the first chunk\'s number');
  assert.equal(rows.find((r) => r.raw && r.raw.toolCallId === 'c1').rid, 'L:4', 'the tool_call, not its update');
  assert.equal(new Set(ids(rows)).size, rows.length, 'every id once');
});

test('live rows: the 6,000-event window sliding forward does not change the ids of the rows that stay', () => {
  const p = page();
  const evs = chat();
  const all = p.hook.liveRows('s', evs, { sessionId: 's' });
  const later = p.hook.liveRows('s', evs.slice(5), { sessionId: 's' });
  const kept = later.filter((r) => r.role !== 'assistant' || !String(r.value).startsWith('Done')).map((r) => r.rid);
  for (const rid of kept) assert.ok(ids(all).includes(rid), rid + ' was there before with the same id');
  assert.equal(later.find((r) => String(r.value).includes('After')).rid, all.find((r) => String(r.value).includes('After')).rid);
});

test('saved rows: an older page loaded in front keeps every id (absolute transcript index)', () => {
  const p = page();
  const t = (kind, text, i) => ({ kind, text, time: 1000 + i, label: kind === 'tool' ? 'Bash' : '' });
  const all = Array.from({ length: 40 }, (_, i) => t(i % 3 ? 'assistant' : 'user', 'row ' + i, i));
  const newer = p.hook.normalized({ events: all.slice(25), context: [], start: 25 }, 'k');
  const both = p.hook.normalized({ events: all.slice(10), context: [], start: 10 }, 'k');
  const pick = (rows, text) => rows.find((r) => r.value === text).rid;
  assert.equal(pick(newer, 'row 30'), 'T:30');
  assert.equal(pick(both, 'row 30'), 'T:30', 'the same row, the same id, after "Load earlier"');
  assert.equal(pick(both, 'row 10'), 'T:10');
});

test('the drawn rows carry data-rid in Full and in Chat, and a fold carries the range it hides', () => {
  const p = page();
  p.run("selected={provider:'claude',id:'a',key:'a'};current='c1'");
  const box = p.element('messages');
  p.run("snapshot={sessionId:'s',busy:false,unknownReceipts:[]}");
  p.run('events=' + JSON.stringify(chat()));
  p.hook.setView('full');
  p.hook.repaintMain();
  const full = box.children.map((c) => c.dataset && (c.dataset.rid || (c.dataset.ridFrom && c.dataset.ridFrom + '..' + c.dataset.ridTo)));
  assert.ok(full.includes('L:1') && full.includes('L:2'), 'messages: ' + full.join(' '));
  assert.ok(full.includes('L:7..L:12'), 'six steps folded into "6 steps" carry L:7..L:12: ' + full.join(' '));
  p.hook.setView('chat');
  const chatView = box.children.map((c) => c.dataset && (c.dataset.rid || (c.dataset.ridFrom && c.dataset.ridFrom + '..' + c.dataset.ridTo)));
  assert.ok(chatView.includes('L:1') && chatView.includes('L:13'), 'the prompt and the last message: ' + chatView.join(' '));
  assert.ok(chatView.some((x) => /^L:\d+\.\.L:\d+$/.test(x || '')), 'a "Show steps" fold with its range: ' + chatView.join(' '));
});

test('a split pane draws the same ids as the main list for the same chat', () => {
  const p = page();
  const evs = chat();
  const main = p.hook.liveRows('s', evs, { sessionId: 's' });
  const pane = p.hook.liveRows('s', evs.map((e) => ({ ...e })), { sessionId: 's' });
  assert.deepEqual(ids(pane), ids(main));
});
