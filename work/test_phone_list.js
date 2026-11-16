'use strict';
/* The phone page's list and request cards (phone.js pure parts, owner-approved prototypes round 3): one list newest change of
   state first with the chats that are not running mixed in by time, the All projects filter, the project on each card, approvals
   and questions as cards in the stream (open when newest, closed once newer activity follows, open when a notification brought
   you there) and the one-line record after acting. The page itself runs in work/deno/remote_phone_e2e_test.ts. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));

const shop = { id: 'p-shop', name: 'Shop web', color: 'teal' };
const blog = { id: 'p-blog', name: 'Blog', color: 'pink' };
const live = (id, project, changedAt, extra) => ({ id, title: id, agent: 'Codex', project, changedAt, state: 'idle', needs: 0, ...extra });
const saved = (key, project, lastActive) => ({ key, title: key, agent: 'Claude Code', project, lastActive });

test('home: one list, newest change of state first; chats that are not running mixed in by time', () => {
  const home = {
    chats: [live('a', shop, '2026-11-12T10:00:00Z'), live('b', blog, '2026-11-12T11:30:00Z'), live('c', shop, '')],
    saved: [saved('claude:s1', shop, '2026-11-12T11:00:00Z'), saved('claude:s2', blog, '2026-11-11T09:00:00Z')],
  };
  const items = P.orderHome(home, '');
  assert.deepEqual(
    items.map((i) => [i.kind, i.id || i.key]),
    [
      ['live', 'b'],
      ['saved', 'claude:s1'],
      ['live', 'a'],
      ['saved', 'claude:s2'],
      ['live', 'c'],
    ],
  );
  assert.deepEqual(items[0].project, blog, 'each card names its project');
});

test('home: the All projects filter keeps one project, in the same order; the filter lists each project once with its count', () => {
  const home = {
    chats: [live('a', shop, '2026-11-12T10:00:00Z'), live('b', blog, '2026-11-12T11:30:00Z')],
    saved: [saved('claude:s1', shop, '2026-11-12T11:00:00Z')],
  };
  assert.deepEqual(
    P.orderHome(home, 'p-shop').map((i) => i.id || i.key),
    ['claude:s1', 'a'],
  );
  assert.deepEqual(P.homeProjects(P.orderHome(home, '')), [
    { id: 'p-blog', name: 'Blog', color: 'pink', count: 1 },
    { id: 'p-shop', name: 'Shop web', color: 'teal', count: 2 },
  ]);
  assert.equal(P.orderHome(home, 'p-none').length, 0);
});

test("project colour: the PC's palette ids; unknown is the muted colour", () => {
  assert.equal(P.projectColor('teal'), 'hsl(172 40% 56%)');
  assert.equal(P.projectColor('slate'), 'hsl(220 14% 60%)');
  assert.equal(P.projectColor(''), 'var(--muted)');
  assert.equal(P.projectColor('constructor'), 'var(--muted)');
});

test('card times: now, minutes, hours, days', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(P.ago('2026-11-12T11:59:40Z', now), 'now');
  assert.equal(P.ago('2026-11-12T11:58:00Z', now), '2m');
  assert.equal(P.ago('2026-11-12T07:00:00Z', now), '5h');
  assert.equal(P.ago('2026-11-10T12:00:00Z', now), '2d');
  assert.equal(P.ago('', now), '');
});

const user = (seq, text) => ({ seq, kind: 'user', data: { text } });
const say = (seq, text) => ({ seq, kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const perm = (seq, key, title) => ({ seq, kind: 'permission', data: { key, params: { toolCall: { title } } } });
const ask = (seq, key, message) => ({ seq, kind: 'elicitation', data: { key, params: { message } } });

test('requests are cards in the stream where they were asked; answered elsewhere: a notice; missing or sign-in: last', () => {
  const events = [user(1, 'Go'), say(2, 'Working.'), perm(3, 'p1', 'npm test'), ask(4, 'q-old', 'Old question'), say(5, 'More.')];
  const rows = P.rowsFrom(events, { waiting: [{ key: 'p1' }, { key: 'q9' }, { kind: 'sign-in' }] });
  assert.deepEqual(
    rows.map((r) => [r.kind, r.kind === 'notice' ? r.text : r.key]),
    [
      ['you', 'e1'],
      ['agent', 'e2'],
      ['req', 'p1'],
      ['notice', 'Asked: Old question'],
      ['agent', 'e5'],
      ['req', 'q9'],
      ['req', 'sign-in'],
    ],
  );
});

test('a request card is open when it is the newest thing in the chat, closed once newer activity follows, open when you land on it', () => {
  const newest = P.rowsFrom([user(1, 'Go'), perm(2, 'p1', 'npm test')], { waiting: [{ key: 'p1' }] });
  assert.equal(P.reqOpen(newest, 'p1', {}, ''), true, 'newest: open');
  const followed = P.rowsFrom([user(1, 'Go'), perm(2, 'p1', 'npm test'), say(3, 'Meanwhile…')], { waiting: [{ key: 'p1' }] });
  assert.equal(P.reqOpen(followed, 'p1', {}, ''), false, 'newer activity follows: closed');
  assert.equal(P.reqOpen(followed, 'p1', {}, 'p1'), true, 'a notification brought you here: open');
  assert.equal(P.reqOpen(followed, 'p1', { p1: true }, ''), true, 'tapped open');
  assert.equal(P.reqOpen(newest, 'p1', { p1: false }, 'p1'), false, 'tapped closed wins');
});

test('after acting from this phone the card is a one-line record', () => {
  const rows = P.rowsFrom([user(1, 'Go'), perm(2, 'p1', 'npm test')], {
    waiting: [{ key: 'p1' }],
    acted: { p1: { kind: 'allow', detail: 'npm test -- --coverage' } },
  });
  assert.deepEqual(rows.at(-1), { kind: 'record', key: 'p1', text: 'You allowed once from this phone: npm test -- --coverage' });
  assert.equal(P.recordText({ kind: 'deny', detail: 'rm -rf build' }), 'You denied from this phone: rm -rf build');
  assert.equal(P.recordText({ kind: 'answer', answer: 'Compact list' }), 'You answered from this phone: Compact list');
  assert.equal(P.recordText({ kind: 'decline' }), 'You declined to answer from this phone.');
  const fields = P.fieldsOf({
    properties: { layout: { type: 'string', enum: ['Cards', 'Compact'] }, time: { type: 'boolean', title: 'Reading time' } },
  });
  assert.equal(P.answerWords(fields, { layout: 'Compact', time: true }), 'Compact, Reading time: Yes');
});

test('subagents: the card and the shortcut under the title', () => {
  const subs = [
    { id: 'a', title: 'Tests', state: 'running' },
    { id: 'b', title: 'Docs', state: 'completed' },
  ];
  assert.deepEqual(P.subsWords(subs), { card: 'Subagents · 1 working', short: '1 subagent working' });
  assert.deepEqual(P.subsWords([subs[1]]), { card: 'Subagents · 1 finished', short: '1 subagent, done' });
  assert.deepEqual(P.subsWords([subs[1]], 4), { card: 'Subagents · 5 finished', short: '5 subagents, done' });
  assert.deepEqual(P.subsWords([{ id: 'f', title: 'x', state: 'failed' }]), { card: 'Subagents · 1 failed', short: '1 subagent failed' });
});

test('subagents follow the PC Activity rules: description first, working and failed on top, words never "idle"', () => {
  const m = P.subsModel(
    [
      { id: 'a', title: 'general-purpose', description: 'Check page 1', state: 'idle', stopReason: 'end_turn' },
      { id: 'b', title: 'general-purpose', description: 'Fix the test', state: 'failed' },
      { id: 'c', title: 'Explore', description: 'Find routes', state: 'running', where: '' },
      { id: 'd', title: 'general-purpose', description: 'Rename', state: 'idle', stopReason: 'cancelled', where: 'Own worktree', landing: 'Stopped — ask the agent to merge it' },
      { id: 'e', title: 'general-purpose', description: 'Write tests', state: 'running', where: 'Own worktree', landing: 'Merged · 2 files' },
      { id: 'f', title: '', state: 'idle', firstPrompt: 'Look at the logs\nand more' },
      { id: '0123456789abcdef', title: '', state: 'idle' },
      { id: 'g', title: 'general-purpose', description: 'Ask', state: 'needs_you' },
    ],
    { on: true, reason: '', readOnly: ['Explore'] },
  );
  assert.deepEqual(
    m.top.map((i) => [i.title, i.type, i.word, i.wt]),
    [
      ['Ask', 'general-purpose', 'Needs you', ''],
      ['Write tests', 'general-purpose', 'Working', 'Own worktree · Merged · 2 files'],
      ['Find routes', 'Explore', 'Working', 'In your folder (read-only)'],
      ['Fix the test', 'general-purpose', 'Failed', ''],
    ],
  );
  assert.deepEqual(
    m.done.map((i) => [i.title, i.word, i.wt]),
    [
      ['Subagent 01234567', 'Done', ''],
      ['Look at the logs', 'Done', ''],
      ['Rename', 'Stopped', 'Own worktree · Stopped — ask the agent to merge it'],
      ['Check page 1', 'Done', ''],
    ],
  );
  assert.equal(m.working, 3);
  assert.equal(m.failed, 1);
  // no worktree rule in the chat: no line
  assert.equal(P.subsModel([{ id: 'x', title: 'general-purpose', description: 'X', state: 'running', where: 'Own worktree' }]).top[0].wt, '');
});
