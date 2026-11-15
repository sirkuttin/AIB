'use strict';
/* History loading phase 1B: server/acp/event_pages.ts (pages by bytes, view-free row starts, boundary state) against the page's own
   row build (chat.js liveRows). The property: cut a chat at every seq, snap down to the page start the server would use, build the
   rows over the loaded range with the server's edge, and get exactly the rows the uncut build has from there on (plus the calls
   carried across the edge, drawn with their own ids). Both thinking modes. node --test work/test_history_pages.js */
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { makePage } = require('./chat_harness.js');
const { APP } = require('./_paths');

const pages = () => import(pathToFileURL(path.join(APP, 'server', 'acp', 'event_pages.ts')).href);
// PlanUI.fold folds per turn and is left out here: it runs after the row build and is not an edge concern of this phase
const SCRIPTS = ['read-state.js', 'stream-ui.js', 'tool-views.js', 'views.js', 'views-ui.js'];
const MAIN = 's';

function fixture() {
  let seq = 0;
  const out = [];
  const ev = (kind, data, extra = {}) => out.push({ seq: ++seq, kind, time: 1000 + seq, data: { sessionId: MAIN, ...data }, ...extra });
  const up = (update, sid = MAIN) => ev('update', { sessionId: sid, update });
  const chunk = (text, kind = 'agent_message_chunk', sid = MAIN) => up({ sessionUpdate: kind, content: { type: 'text', text } }, sid);
  const call = (id, status = 'in_progress', title = 'Bash ' + id) => up({ sessionUpdate: 'tool_call', toolCallId: id, title, kind: 'execute', status });
  const upd = (id, extra = {}) => up({ sessionUpdate: 'tool_call_update', toolCallId: id, ...extra });
  ev('user', { text: 'first question' });
  chunk('user echo', 'user_message_chunk');
  chunk('Hello ');
  chunk('think a', 'agent_thought_chunk');
  up({ sessionUpdate: 'usage_update', used: 10 });
  chunk('world');
  chunk('helper says hi', 'agent_message_chunk', 'h1'); // a helper's event inside the reply's run
  chunk(' and more');
  call('t1');
  chunk('while t1 runs ');
  upd('t1', { status: 'in_progress', rawOutput: 'part' });
  chunk('still one reply');
  up({ sessionUpdate: 'subagent_update', sessionId: 'h1', title: 'Helper one', state: 'running' });
  call('t2', 'pending');
  ev('permission', { key: 'p1', params: { toolCall: { title: 'Write file' } } });
  call('t3');
  ev('request_withdrawn', { key: 'p1' });
  upd('t2', { status: 'completed', rawOutput: 'done t2' });
  ev('permission_auto', { params: { toolCall: { title: 'Read' } }, label: 'reads' });
  up({ sessionUpdate: 'plan', entries: [{ status: 'pending', content: 'step 1' }] });
  chunk('');
  chunk('a picture', 'agent_message_chunk');
  up({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'AAAA' } });
  chunk('after the picture');
  ev('turn_end', { stopReason: 'end_turn' });
  ev('user', { text: 'second question' });
  ev('user', { text: 'second question' }); // the identical repeat chat.js drops
  call('t1'); // an id from an earlier turn: its own row (uid t1#2)
  upd('t3', { status: 'completed' }); // a call from the turn before
  chunk('reply two ');
  call('t1', 'in_progress', 'Bash t1 again'); // the same call re-sent in its turn: edits the row
  chunk('continues');
  ev('studio_note', { message: 'AIB note' });
  chunk('the agent said this then lost its login');
  ev('auth_required', { during: 'prompt', detail: 'the agent said this then lost its login and more' });
  upd('t1', { status: 'completed', rawOutput: 'x'.repeat(50) });
  upd('t-unknown', { status: 'completed', title: 'An update with no call' });
  upd('t-unknown', { rawOutput: 'more' });
  ev('error', { message: 'something failed' });
  chunk('think b', 'agent_thought_chunk');
  chunk('last ');
  chunk('think c', 'agent_thought_chunk');
  chunk('words');
  ev('turn_end', { stopReason: 'end_turn' });
  return out;
}

function source(P, events) {
  return P.arraySource(events, { eventsId: 'e1', mainSession: MAIN });
}

for (const thinking of [false, true]) {
  test(`cut at every seq (thinking ${thinking ? 'shown' : 'hidden'}): rows over the loaded range with the edge equal the uncut rows`, async () => {
    const P = await pages();
    const p = makePage({ scripts: SCRIPTS });
    p.element('thinking').checked = thinking;
    const all = fixture();
    const snap = { sessionId: MAIN, permissions: [], elicitations: [] };
    const uncut = JSON.parse(JSON.stringify(p.hook.liveRows(MAIN, all, snap, true)));
    const starts = P.rowStarts(all, MAIN, MAIN);
    const src = source(P, all);
    const seqOf = (r) => Number(String(r.rid).slice(2));
    let checked = 0;
    for (const e of all) {
      // the page start the server uses for a cut at this seq: the run start of the chat's first own event at or after it
      const own = all.find((x) => x.seq >= e.seq && x.data.sessionId === MAIN);
      const cut = own ? starts.get(own.seq) : e.seq;
      const edge = P.edgeAt(src, cut);
      const loaded = all.filter((x) => x.seq >= cut);
      const rows = JSON.parse(JSON.stringify(p.hook.liveRows(MAIN, loaded, snap, true, 0, edge)));
      const carried = new Set(rows.filter((r) => seqOf(r) < cut).map(seqOf));
      const want = uncut.filter((r) => seqOf(r) >= cut || carried.has(seqOf(r)));
      assert.deepEqual(rows, want, `cut at ${cut} (event ${e.seq})`);
      for (const s of carried) assert.ok(edge.tools.some((t) => t.seq === s), `carried ${s} came from the edge`);
      checked++;
    }
    assert.equal(checked, all.length);
  });
}

test('row starts: a streamed reply is one run whatever its length; helper events and row-less events never start a page', async () => {
  const P = await pages();
  const evs = [{ seq: 1, kind: 'user', data: { text: 'go' } }];
  for (let i = 2; i < 5002; i++) evs.push({ seq: i, kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'w ' } } } });
  const starts = P.rowStarts(evs, MAIN, MAIN);
  assert.equal(starts.get(5001), 2);
  assert.equal(starts.get(1), 1);
  // a page by bytes over it still starts at the reply's first chunk (no event cap)
  const pg = P.page(P.arraySource(evs, { mainSession: MAIN }), { bytes: 4096 });
  assert.equal(pg.from, 2);
  assert.equal(pg.events.length, 5000);
});

test('pages: the tail is sized by bytes, before= pages back with no gap and no overlap down to the first event', async () => {
  const P = await pages();
  const all = [];
  for (let i = 1; i <= 400; i++) {
    all.push({ seq: all.length + 1, kind: 'user', time: i, data: { sessionId: MAIN, text: 'q' + i + ' ' + 'x'.repeat(200) } });
    all.push({ seq: all.length + 1, kind: 'update', time: i, data: { sessionId: 'helper', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'h'.repeat(300) } } } });
  }
  const src = P.arraySource(all, { mainSession: MAIN, eventsId: 'n1', stable: 700 });
  const tail = P.page(src, { bytes: 8192 });
  assert.ok(tail.bytes <= 8192 && tail.bytes > 8192 - 400, 'filled to the budget: ' + tail.bytes);
  assert.ok(tail.events.every((e) => e.data.sessionId === MAIN), 'no helper events on the main page');
  assert.equal(tail.to, 799);
  assert.equal(tail.more, true);
  assert.equal(tail.newer, false);
  assert.equal(tail.stable, 700);
  assert.equal(tail.cursor, 800);
  assert.equal(tail.eventsId, 'n1');
  assert.ok(tail.turn && tail.turn.promptSeq === 799, 'the open page carries the turn');
  assert.ok(tail.helpers && tail.helpers.helper.events === 400, 'and the helper facts');
  const seen = [...tail.events];
  let pg = tail;
  while (pg.more) {
    const older = P.page(src, { before: pg.from, bytes: 8192 });
    assert.equal(older.to < pg.from, true);
    assert.equal(older.turn, undefined, 'older pages carry only the edge');
    seen.unshift(...older.events);
    pg = older;
  }
  assert.deepEqual(seen.map((e) => e.seq), all.filter((e) => e.data.sessionId === MAIN).map((e) => e.seq));
  assert.equal(pg.first, 1);
  const bigger = P.page(src, { bytes: 64 * 1024 });
  assert.ok(bigger.events.length > tail.events.length * 6, 'the budget is bytes, not a count');
});

test('pages: after= deltas, around= a saved place', async () => {
  const P = await pages();
  const all = Array.from({ length: 300 }, (_, i) => ({ seq: i + 1, kind: 'user', time: i, data: { text: 'm' + (i + 1) + ' ' + 'y'.repeat(100) } }));
  const src = P.arraySource(all, { mainSession: MAIN });
  const delta = P.page(src, { after: 290 });
  assert.deepEqual(delta.events.map((e) => e.seq), [291, 292, 293, 294, 295, 296, 297, 298, 299, 300]);
  assert.equal(delta.newer, false);
  const capped = P.page(src, { after: 0, bytes: 4096 });
  assert.equal(capped.from, 1);
  assert.equal(capped.newer, true, 'a delta past the budget says there is more');
  const around = P.page(src, { around: 150, bytes: 8192 });
  assert.ok(around.from < 150 && around.to > 150, `${around.from}..${around.to}`);
  assert.ok(Math.abs((150 - around.from) - (around.to - 150)) <= 2, 'about even on both sides');
  assert.equal(P.page(src, { after: 300 }).events.length, 0);
});

test('helper output by helper id on demand, with its own row starts', async () => {
  const P = await pages();
  const all = fixture();
  const src = source(P, all);
  const main = P.page(src);
  assert.ok(!main.events.some((e) => e.data.sessionId === 'h1'));
  assert.equal(main.helpers.h1.title, 'Helper one');
  assert.equal(main.helpers.h1.state, 'running');
  assert.equal(main.helpers.h1.events, 1, 'its own events (the subagent_update belongs to the chat)');
  const h = P.page(src, { session: 'h1' });
  assert.equal(h.session, 'h1');
  assert.ok(h.events.length === 1 && h.events.every((e) => e.data.sessionId === 'h1'));
  assert.equal(h.turn, undefined);
});

test('clipping: a huge tool output is cut to the page limit on the way out; the full event by seq', async () => {
  const P = await pages();
  const big = 'z'.repeat(2_000_000);
  const all = [
    { seq: 1, kind: 'user', data: { text: 'run it' } },
    { seq: 2, kind: 'update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Bash', status: 'in_progress' } } },
    { seq: 3, kind: 'update', data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed', rawOutput: big } } },
    { seq: 4, kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: big } } } },
  ];
  const src = P.arraySource(all, { mainSession: MAIN });
  const one = P.page(src);
  assert.deepEqual(one.events.map((e) => e.seq), [4], 'one event larger than the budget is still a page of its own');
  const pg = P.page(src, { bytes: 4 * 1024 * 1024 });
  const e3 = pg.events.find((e) => e.seq === 3);
  assert.equal(e3.clipped, true);
  assert.ok(e3.bytes > 2_000_000);
  assert.ok(JSON.stringify(e3).length < 41_000);
  assert.ok(pg.bytes < 2_100_000, 'the picture is not a tool output: kept whole');
  assert.equal(pg.events.find((e) => e.seq === 4).clipped, undefined);
  assert.equal(P.fullEvent(src, 3).data.update.rawOutput.length, 2_000_000);
  assert.equal(P.fullEvent(src, 99), null);
  assert.equal(all[2].data.update.rawOutput.length, 2_000_000, 'the kept event is not changed');
  const raw = P.page(src, { clip: 0, bytes: 8 * 1024 * 1024 });
  assert.equal(raw.events.find((e) => e.seq === 3).clipped, undefined);
});

test('turn facts: the newest prompt, its clock, the newest step and the turn end', async () => {
  const P = await pages();
  const t = P.turnFacts(source(P, fixture()));
  assert.ok(t.promptSeq > 0);
  const all = fixture();
  assert.equal(all.find((e) => e.seq === t.promptSeq).data.text, 'second question');
  assert.equal(t.since, all.find((e) => e.seq === t.promptSeq).time * 1000);
  assert.equal(t.step.kind, 'thinking');
  assert.ok(t.endSeq === all.at(-1).seq);
  assert.equal(t.steps, 3, 't1 (new turn), t3, t-unknown');
});
