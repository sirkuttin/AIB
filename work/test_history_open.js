'use strict';
/* History loading phase 2B (page data path): a live chat opens with its newest page, not the full /api/live/state download; older
   pages load near the top; side panes share the chat's cache; an older host falls back to the full state; the live line and the
   working clock stay right for a turn longer than one page. The fake host answers with the real server/acp/event_pages.ts.
   node --test work/test_history_open.js */
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { makePage } = require('./chat_harness.js');
const { APP } = require('./_paths');

const pages = () => import(pathToFileURL(path.join(APP, 'server', 'acp', 'event_pages.ts')).href);
const SCRIPTS = ['read-state.js', 'stream-ui.js', 'tool-views.js', 'plan-ui.js', 'views.js', 'views-ui.js', 'scroll-controller.js'];
const MAIN = 's';

/* A big chat: a long turn (one prompt, then many tool calls with big outputs, ~6 MB) and a helper's events in between. */
function bigChat() {
  const out = [];
  let seq = 0;
  const ev = (kind, data) => out.push({ seq: ++seq, kind, time: 1000 + seq, data: { sessionId: MAIN, ...data } });
  ev('user', { text: 'first question' });
  ev('turn_end', { stopReason: 'end_turn' });
  ev('user', { text: 'do the long thing' });
  for (let i = 0; i < 3000; i++) {
    const id = 't' + i;
    ev('update', { update: { sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash ' + i, kind: 'execute', status: 'in_progress' } });
    ev('update', { update: { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', rawOutput: 'x'.repeat(1000) } });
    if (i % 100 === 0)
      ev('update', { sessionId: 'h1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'helper ' + i } } });
  }
  return out;
}

async function hostPage(all, { pagesRoute = true } = {}) {
  const P = await pages();
  const source = P.arraySource(all, { eventsId: 'E1', stable: all.length - 5, mainSession: MAIN });
  const bytes = { events: 0, state: 0 };
  const routes = {
    '/api/live/state': (q) => {
      const after = Number(q.after) || 0;
      const events = all.filter((e) => e.seq > after);
      const body = { sessionId: MAIN, busy: true, ready: true, eventsId: 'E1', cursor: all.length, events, unknownReceipts: [] };
      bytes.state += JSON.stringify(events).length;
      return { body };
    },
  };
  if (pagesRoute)
    routes['/api/live/events'] = (q) => {
      const body = P.page(source, P.pageQuery(q));
      bytes.events += JSON.stringify(body.events).length;
      return { body };
    };
  const page = makePage({ scripts: SCRIPTS, routes });
  page.run("selected={provider:'claude',id:'a',key:'a'};current='c1'");
  return { page, bytes, calls: page.calls };
}
const callsTo = (calls, url) => calls.filter((c) => c.url === url);

test('opening a big chat takes only its newest page (< 1 MB, no helper events), then deltas after the cursor', async () => {
  const all = bigChat();
  assert.ok(JSON.stringify(all).length > 3 * 1024 * 1024, 'the fixture chat is big');
  const { page, bytes, calls } = await hostPage(all);
  const { state } = await page.hook.pullLive('c1', { fresh: 0 });
  const entry = page.hook.chatCache.entry('c1');
  assert.ok(bytes.events <= 1024 * 1024 + 64 * 1024, 'the opening page is about 1 MB: ' + bytes.events);
  assert.equal(bytes.state, 2, 'the state read after the page carries no events (it asks after the page cursor)');
  assert.equal(callsTo(calls, '/api/live/state')[0].query.after, String(all.length));
  assert.ok(!callsTo(calls, '/api/live/state').some((c) => c.query.after === '0'), 'never the full state');
  assert.equal(entry.loaded().filter((e) => e.data.sessionId === 'h1').length, 0, 'no helper events in the opening page');
  assert.ok(entry.more && entry.from > 3, 'older history is left on the host');
  assert.equal(state.busy, true);
  assert.ok(entry.helpers && entry.helpers.h1, "the helper's facts came with the page");
  // the next poll: deltas only
  all.push({ seq: all.length + 1, kind: 'update', time: 1, data: { sessionId: MAIN, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } } } });
  await page.hook.pullLive('c1', { fresh: 0 });
  assert.equal(entry.cursor, all.length);
  assert.equal(entry.loaded().at(-1).seq, all.length);
  assert.equal(callsTo(calls, '/api/live/events').length, 1, 'no second page read for a delta');
});

test('a turn longer than one page: the live line and the working clock come from the turn facts, step count included', async () => {
  const all = bigChat();
  const { page } = await hostPage(all);
  await page.hook.pullLive('c1', { fresh: 0 });
  const entry = page.hook.chatCache.entry('c1');
  assert.equal(entry.promptMissing(), true, 'the prompt (seq 3) is older than the loaded page');
  const s = page.hook.liveStatusOf(entry, MAIN);
  assert.ok(s, 'there is a live line');
  assert.equal(s.since, (1000 + 3) * 1000, "the clock runs from your message's time");
  assert.equal(s.n, 3000, 'every tool call of the turn counts, not only the loaded ones');
  assert.equal(s.step.kind, 'tool');
  const A = require(path.join(APP, 'attention-ui.js'));
  assert.equal(A.turnStart(entry.loaded(), 9e15, null, entry.turn), (1000 + 3) * 1000, '"working (m:ss)" starts at the prompt');
});

test('near the top: the next older page joins the range below (before=from), the reader keeps the place', async () => {
  const all = bigChat();
  const { page, calls } = await hostPage(all);
  await page.hook.pullLive('c1', { fresh: 0 });
  const entry = page.hook.chatCache.entry('c1');
  const from = entry.from,
    n = entry.size();
  page.run("snapshot={sessionId:'s',busy:false,unknownReceipts:[]}");
  const box = page.element('messages');
  page.hook.repaintMain();
  page.hook.mainCtl();
  box._grow = null; // every loaded row is drawn: the next step is a fetch
  page.hook.mainNearTop();
  assert.ok(byClassName(box, 'loading-earlier'), 'the "Loading earlier…" line shows while the page lands');
  await new Promise((r) => setTimeout(r, 20));
  const older = callsTo(calls, '/api/live/events').at(-1);
  assert.equal(older.query.before, String(from));
  assert.ok(entry.from < from && entry.size() > n, 'older events joined');
  const seqs = entry.loaded().map((e) => e.seq);
  const want = [...new Set(seqs)].sort((a, b) => a - b);
  assert.equal(seqs.length, want.length, 'no repeats');
  assert.ok(seqs.every((s, i) => s === want[i]), 'sorted');
  assert.ok(!byClassName(box, 'loading-earlier'), 'the line is gone once it landed');
  assert.ok(!byClassName(box, 'show-earlier') && !byClassName(box, 'load-history'), 'no "Show earlier" / "Load earlier" button');
});
function byClassName(box, cls) {
  const walk = (el) => String(el.className || '').split(' ').includes(cls) || (el.children || []).some(walk);
  return (box.children || []).some(walk);
}

test('a side pane on the same chat shares the cache: no download of its own, one read stream', async () => {
  const all = bigChat();
  const { page, calls } = await hostPage(all);
  await page.hook.pullLive('c1', { fresh: 0 }); // the main list
  const before = calls.length;
  await page.hook.pullLive('c1'); // the side pane, within a second
  assert.equal(calls.length, before, 'the pane reused the read');
  const p1 = page.hook.pullLive('c1', { fresh: 0 }),
    p2 = page.hook.pullLive('c1');
  assert.equal(p1, p2, 'two reads at once are one');
  await p1;
});

test('an older host without /api/live/events: the full state, as today', async () => {
  const all = bigChat().slice(0, 50);
  const { page, calls } = await hostPage(all, { pagesRoute: false });
  await page.hook.pullLive('c1', { fresh: 0 });
  const entry = page.hook.chatCache.entry('c1');
  assert.equal(callsTo(calls, '/api/live/state')[0].query.after, '0');
  assert.equal(entry.size(), 50);
  assert.equal(entry.more, false);
  await page.hook.pullLive('c1', { fresh: 0 });
  assert.equal(callsTo(calls, '/api/live/events').length, 1, 'asked once, then remembered');
});

test('opening a cached chat again reads from its stable point (seqs above it may be renumbered), not from the start', async () => {
  const all = bigChat();
  const { page, calls } = await hostPage(all);
  await page.hook.pullLive('c1', { fresh: 0 });
  const entry = page.hook.chatCache.entry('c1');
  entry.reopened = true; // what switching chats marks
  await page.hook.pullLive('c1', { fresh: 0 });
  assert.equal(callsTo(calls, '/api/live/state').at(-1).query.after, String(all.length - 5));
  assert.equal(callsTo(calls, '/api/live/events').length, 1, 'no new page');
  assert.equal(entry.loaded().at(-1).seq, all.length);
});
