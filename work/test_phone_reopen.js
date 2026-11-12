'use strict';
/* The phone page's pure parts for chats that are not running (owner decisions 3b, 4): the words under a not-running chat, when a
   chat is marked read on the PC (visible, its end on screen, something newer, at most every READ_MS), and that saved history in
   live-event shape draws as rows. The page itself runs in work/deno/remote_phone_e2e_test.ts. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));

test('not running: "Not running · agent · last active …"', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(
    P.savedWords({ agent: 'Claude Code', lastActive: '2026-11-12T09:00:00Z' }, now),
    'Not running · Claude Code · last active 3 h ago',
  );
  assert.equal(P.savedWords({ agent: 'Codex', lastActive: '2026-11-12T11:59:50Z' }, now), 'Not running · Codex · last active just now');
  assert.equal(P.savedWords({ agent: 'OMP', lastActive: '' }, now), 'Not running · OMP');
});

test('read on the PC: only when visible, at the end, something newer, and READ_MS since the last one', () => {
  const chat = { id: 'c1', cursor: 12 };
  const view = { visible: true, atEnd: true };
  const now = 100000;
  assert.equal(P.readTarget(chat, view, { seq: 0, at: 0 }, now), 12);
  assert.equal(P.readTarget(chat, { visible: false, atEnd: true }, { seq: 0, at: 0 }, now), 0, 'page hidden');
  assert.equal(P.readTarget(chat, { visible: true, atEnd: false }, { seq: 0, at: 0 }, now), 0, 'scrolled up');
  assert.equal(P.readTarget(chat, view, { seq: 12, at: 0 }, now), 0, 'nothing newer');
  assert.equal(P.readTarget(chat, view, { seq: 10, at: now - P.READ_MS + 1 }, now), 0, 'too soon');
  assert.equal(P.readTarget(chat, view, { seq: 10, at: now - P.READ_MS }, now), 12);
  assert.equal(P.readTarget({ ...chat, closed: true }, view, { seq: 0, at: 0 }, now), 0, 'not running');
  assert.equal(P.readTarget({ gone: true }, view, { seq: 0, at: 0 }, now), 0);
});

test('saved history (live-event shape from the server) draws as prompts, agent messages and folded steps', () => {
  const rows = P.rowsFrom([
    { seq: 1, kind: 'user', data: { text: 'Tidy the README\n[A picture: it is on your PC.]' } },
    { seq: 2, kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'On it.' } } } },
    { seq: 3, kind: 'update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Edit README.md', status: 'completed' } } },
    { seq: 4, kind: 'update', data: { update: { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' } } },
    { seq: 5, kind: 'studio_note', data: { message: 'Assignment: tidy' } },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.text || (r.steps && r.steps.map((s) => s.title).join())]),
    [
      ['you', 'Tidy the README\n[A picture: it is on your PC.]'],
      ['agent', 'On it.'],
      ['steps', 'Edit README.md'],
      ['notice', 'Assignment: tidy'],
    ],
  );
});
