'use strict';
/* The phone's saved copies of chats (phone.js cacheMerge and friends; owner decision Q6, 2026-11-16): joining the screen's events to
   the copy only where they meet, the per-chat byte cap by whole turns, keeping the 5 most recently active, another phone's copies
   going, and Load earlier from the copy. The page itself runs in work/deno/remote_phone_cache_e2e_test.ts. */
const { PAGE: APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));

const user = (seq, text) => ({ seq, kind: 'user', time: 1000 + seq, data: { text } });
const say = (seq, text) => ({ seq, kind: 'update', time: 1000 + seq, data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
/* `turns` turns from seq `from`: your message and two chunks of `size` characters each. */
function turns(from, n, size) {
  const out = [];
  let seq = from;
  for (let t = 0; t < n; t++) {
    out.push(user(seq++, 'Question ' + t));
    out.push(say(seq++, 'a'.repeat(size)));
    out.push(say(seq++, 'b'.repeat(size)));
  }
  return out;
}
const view = (events, over) => ({
  key: 'claude:s1',
  src: 'live:c1',
  device: 'dev1',
  title: 'Fix it',
  agent: 'Claude Code',
  project: { id: 'p1', name: 'Shop', color: 'teal' },
  events,
  firstSeq: events.length ? events[0].seq : 0,
  truncated: false,
  cursor: events.length ? events[events.length - 1].seq : 0,
  lastActive: 5000,
  ...over,
});
const seqs = (list) => list.map((e) => e.seq);

test('newestTurns: whole turns from the newest back while they fit; the newest turn stays whole even when larger', () => {
  const ev = turns(1, 4, 100); // 4 turns of 3 events
  const one = P.eventSize(ev[0]) + P.eventSize(ev[1]) + P.eventSize(ev[2]);
  assert.deepEqual(P.newestTurns(ev, 1e9), { events: ev, cut: false });
  const two = P.newestTurns(ev, one * 2 + 10);
  assert.equal(two.cut, true);
  assert.deepEqual(seqs(two.events), [7, 8, 9, 10, 11, 12]);
  assert.equal(two.events[0].kind, 'user', 'the cut is at one of your messages');
  const tiny = P.newestTurns(ev, 5);
  assert.deepEqual(seqs(tiny.events), [10, 11, 12], 'the newest turn whole');
  assert.deepEqual(P.newestTurns([], 10), { events: [], cut: false });
  // a page that starts inside a reply (no message of yours at its start) is cut only at your messages
  const tail = [say(1, 'x'), say(2, 'y'), user(3, 'q'), say(4, 'z')];
  assert.deepEqual(seqs(P.newestTurns(tail, P.eventSize(tail[2]) + P.eventSize(tail[3])).events), [3, 4]);
});

test('cacheMerge: the screen joins the older copy where they meet; a hole, another src or another phone replaces it', () => {
  const old = P.cacheMerge(null, view(turns(1, 3, 10)), 100);
  assert.deepEqual([old.firstSeq, old.events.length, old.v, old.savedAt, old.device, old.src], [1, 9, P.CACHE_V, 100, 'dev1', 'live:c1']);
  assert.equal(old.size, P.sizeOfEvents(old.events));
  // the screen now shows 7..15 (a fresh page overlapping the copy): 1..15, one per seq, the copy's older events in front
  const joined = P.cacheMerge(old, view(turns(7, 3, 10), { truncated: true, lastActive: 4000 }), 200);
  assert.deepEqual(seqs(joined.events), [...Array(15).keys()].map((i) => i + 1));
  assert.equal(joined.firstSeq, 1);
  assert.equal(joined.truncated, false, 'the copy reaches the start');
  assert.equal(joined.lastActive, 5000, 'the later of the two');
  // the screen starts right after the copy's last event: they meet
  assert.deepEqual(seqs(P.cacheMerge(old, view(turns(10, 1, 10)), 1).events), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  // a hole between them: the newer page replaces the copy (nothing pretends to be whole)
  const hole = P.cacheMerge(old, view(turns(20, 1, 10), { truncated: true }), 1);
  assert.deepEqual([seqs(hole.events), hole.truncated], [[20, 21, 22], true]);
  // another src (a saved transcript's seqs, or another connection) never joins
  assert.deepEqual(seqs(P.cacheMerge(old, view(turns(7, 1, 10), { src: 'saved' }), 1).events), [7, 8, 9]);
  assert.deepEqual(seqs(P.cacheMerge(old, view(turns(7, 1, 10), { device: 'dev2' }), 1).events), [7, 8, 9]);
  assert.deepEqual(seqs(P.cacheMerge({ ...old, v: 0 }, view(turns(7, 1, 10)), 1).events), [7, 8, 9]);
});

test('cacheMerge: about CACHE_BYTES per chat, the oldest whole turns go first (never part of a reply)', () => {
  const ev = turns(1, 10, 1000);
  const perTurn = P.sizeOfEvents(ev.slice(0, 3));
  const rec = P.cacheMerge(null, view(ev), 1, perTurn * 4 + 50);
  assert.equal(rec.events[0].kind, 'user');
  assert.deepEqual(seqs(rec.events), [...Array(12).keys()].map((i) => i + 19));
  assert.equal(rec.truncated, true);
  assert.equal(rec.firstSeq, 19);
  assert(rec.size <= perTurn * 4 + 50);
  // the default cap: 2 MB
  assert.equal(P.CACHE_BYTES, 2 * 1024 * 1024);
  const big = P.cacheMerge(null, view(turns(1, 30, 40000)), 1);
  assert(big.size <= P.CACHE_BYTES && big.size > P.CACHE_BYTES - 3 * 80100, String(big.size));
  assert.equal(big.events[0].kind, 'user');
});

test('cacheDrop: the 5 most recently active stay; another phone’s and an old format go', () => {
  const recs = [];
  for (let i = 0; i < 7; i++) recs.push({ key: 'k' + i, device: 'dev1', v: P.CACHE_V, lastActive: 100 + i });
  recs.push({ key: 'other', device: 'dev2', v: P.CACHE_V, lastActive: 999 });
  recs.push({ key: 'old', device: 'dev1', v: 0, lastActive: 999 });
  assert.equal(P.CACHE_CHATS, 5);
  assert.deepEqual(P.cacheDrop(recs, 'dev1', P.CACHE_CHATS).sort(), ['k0', 'k1', 'old', 'other']);
  assert.deepEqual(P.cacheDrop(recs, '', 5).length, recs.length, 'no phone: every copy goes');
  assert.deepEqual(P.cacheDrop(recs.slice(0, 3), 'dev1', 5), []);
});

test('cacheOpen and cacheEarlier: the newest page first, then the pages before it, without a hole or a repeat', () => {
  const rec = P.cacheMerge(null, view(turns(1, 6, 1000), { truncated: true }), 1);
  const perTurn = P.sizeOfEvents(rec.events.slice(0, 3));
  const open = P.cacheOpen(rec, perTurn * 2 + 10);
  assert.deepEqual([seqs(open.events), open.firstSeq, open.truncated], [[13, 14, 15, 16, 17, 18], 13, true]);
  const back = P.cacheEarlier(rec, open.firstSeq, perTurn * 2 + 10);
  assert.deepEqual([seqs(back.events), back.firstSeq, back.truncated], [[7, 8, 9, 10, 11, 12], 7, true]);
  const last = P.cacheEarlier(rec, back.firstSeq, perTurn * 5);
  assert.deepEqual([seqs(last.events), last.truncated], [[1, 2, 3, 4, 5, 6], true], 'still truncated: older events are on the PC');
  assert.equal(P.cacheEarlier(rec, 1, 1e9), null, 'nothing older in the copy');
  assert.equal(P.cacheEarlier(rec, 40, 1e9), null, 'the copy does not reach seq 40: the PC has what lies between');
  const whole = P.cacheMerge(null, view(turns(1, 2, 10)), 1);
  assert.equal(P.cacheOpen(whole, 1e9).truncated, false);
});

test('copyTime: the hour today, the day and hour before', () => {
  const now = new Date(2026, 10, 16, 18, 30).getTime();
  assert.equal(P.copyTime(new Date(2026, 10, 16, 9, 5).getTime(), now), '09:05');
  assert.equal(P.copyTime(new Date(2026, 10, 14, 14, 5).getTime(), now), '14 Nov, 14:05');
});
