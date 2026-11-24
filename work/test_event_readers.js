'use strict';
/* History loading (design 5.1-5.2, review M2/M4): chat-cache.js, the page's memory cache of live chats' events, and the guard that
   keeps the event array inside it. node --test work/test_event_readers.js */
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { PAGE: APP } = require('./_paths');
const ChatCache = require(path.join(APP, 'chat-cache.js'));

const ev = (seq, kind = 'update', sid = 's') => ({ seq, kind, time: seq, data: { sessionId: sid } });
const range = (a, b, sid) => Array.from({ length: b - a + 1 }, (_, i) => ev(a + i, 'update', sid));

test('an opening page, older pages below it and deltas above make one sorted range without repeats', () => {
  const e = ChatCache.create().entry('c1');
  e.open({ events: range(51, 60), from: 51, to: 60, more: true, first: 1, cursor: 60, stable: 55, eventsId: 'x', edge: { seq: 51 }, turn: { promptSeq: 40, since: 9000 } });
  assert.equal(e.from, 51);
  assert.equal(e.more, true);
  assert.deepEqual(e.edge, { seq: 51 });
  e.delta({ events: range(59, 63), cursor: 63, eventsId: 'x' }); // overlaps what is loaded
  e.older({ events: range(41, 50), from: 41, more: true, edge: { seq: 41 }, eventsId: 'x' });
  assert.deepEqual(e.loaded().map((x) => x.seq), range(41, 63).map((x) => x.seq));
  assert.equal(e.from, 41);
  assert.deepEqual(e.edge, { seq: 41 });
  assert.equal(e.cursor, 63);
  assert.equal(e.promptMissing(), true, 'the prompt (40) is older than what is loaded');
  e.older({ events: range(30, 40), from: 30, more: false, edge: null, eventsId: 'x' });
  assert.equal(e.promptMissing(), false);
  assert.equal(e.sinceTurnStart()[0].seq, 40);
  assert.equal(e.more, false);
});

test('opening a cached chat again keeps the seqs up to stable and fetches the rest (they may be renumbered)', () => {
  const e = ChatCache.create().entry('c1');
  e.open({ events: range(1, 10), from: 1, cursor: 10, stable: 6, eventsId: 'x' });
  e.trust();
  assert.equal(e.cursor, 6);
  assert.deepEqual(e.loaded().map((x) => x.seq), [1, 2, 3, 4, 5, 6]);
});

test('another numbering (eventsId) starts again; an older page of another numbering is refused', () => {
  const e = ChatCache.create().entry('c1');
  e.open({ events: range(1, 5), from: 1, cursor: 5, stable: 5, eventsId: 'x' });
  assert.equal(e.older({ events: range(1, 2), from: 1, eventsId: 'y' }), false);
  e.open({ events: range(1, 3), from: 1, cursor: 3, stable: 3, eventsId: 'y' });
  assert.deepEqual(e.loaded().map((x) => x.seq), [1, 2, 3]);
  assert.equal(e.eventsId, 'y');
});

test("a helper's page joins the same entry and is remembered as loaded; the full state of an older host replaces everything", () => {
  const e = ChatCache.create().entry('c1');
  e.open({ events: range(10, 12), from: 10, cursor: 20, stable: 20, eventsId: 'x' });
  assert.equal(e.helperLoaded('h1'), false);
  e.helperPage('h1', { events: range(13, 15, 'h1'), edge: { seq: 13 } });
  assert.equal(e.helperLoaded('h1'), true);
  assert.deepEqual(e.helperEdge('h1'), { seq: 13 });
  assert.deepEqual(e.loaded().map((x) => x.seq), [10, 11, 12, 13, 14, 15]);
  e.full({ events: range(1, 4), cursor: 4, eventsId: 'x' });
  assert.equal(e.helperLoaded('h1'), false);
  assert.equal(e.from, 1);
  assert.equal(e.more, false);
});

test('the newest 30 chats are kept (LRU): touching one keeps it', () => {
  const c = ChatCache.create(3);
  c.entry('a');
  c.entry('b');
  c.entry('c');
  c.entry('a');
  c.entry('d');
  assert.deepEqual(c.ids(), ['c', 'a', 'd']);
  assert.equal(ChatCache.LIMIT, 30);
});

/* ---- the guard: the event array lives only in chat-cache.js ----
   The readers (chat.js, split-ui.js, subagents-ui.js, activity-ui.js, views.js, attention-ui.js, plan-ui.js) may take an event
   list as an argument, but none keeps one of its own: no `events` variable in chat.js, and no assignment to or push onto an
   `events` array or `.events` field anywhere in them (a saved transcript's window `w.events` and a response's `data.events`
   are not the live array and are allowed). */
const READERS = ['chat.js', 'split-ui.js', 'subagents-ui.js', 'activity-ui.js', 'views.js', 'attention-ui.js', 'plan-ui.js'];
const ALLOWED_OWNERS = /\b(w|hist|data|next|state|pg|older|win|window_)\.events\b/;
function code(src) {
  // drop comments and string bodies so a word in prose does not count
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, (m) => m[0] + ' '.repeat(Math.max(0, m.length - 2)) + m[0]);
}
function offences(file, src) {
  const out = [];
  code(src)
    .split('\n')
    .forEach((line, i) => {
      const at = (why) => out.push(file + ':' + (i + 1) + ' ' + why + ': ' + line.trim());
      if (/(?:^|[^\w$.])events\s*(?:=(?!=)|\.push\(|\.splice\()/.test(line)) at('keeps its own events array');
      const field = line.match(/\b(\w+)\.events\s*(?:=(?!=)|\.push\(|\.splice\()/);
      if (field && !ALLOWED_OWNERS.test(field[0])) at('keeps an events field');
      if (file === 'chat.js' && /(?:^|[^\w$.'"])events(?![\w$])(?!\s*:)/.test(line.replace(/\b(get|set) events\(/g, ''))) at('reads the live array directly');
    });
  return out;
}

test('lint: no reader keeps or reads the live event array itself (it is behind chat-cache.js calls)', () => {
  const found = READERS.flatMap((f) => offences(f, fs.readFileSync(path.join(APP, f), 'utf8')));
  assert.deepEqual(found, []);
});

test('lint: the rule catches a direct read, a held copy and a held field', () => {
  assert.equal(offences('chat.js', 'const n = events.length;').length, 1);
  assert.equal(offences('views.js', 'let events = [];').length, 1);
  assert.equal(offences('split-ui.js', 'm.events.push(...next.events);').length, 1);
  assert.equal(offences('chat.js', "const x = { events: liveLoaded() }; // events here\nw.events = data.events;").length, 0);
});
