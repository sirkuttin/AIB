'use strict';
/* The phone's inbox (Inbox v3.1: it draws the server-built rows, home.inbox): the envelope's count badge (the server's one number)
   or teal dot (only To review waits), the two sections in the server's order with no project split ("Needs you in <project>" is
   gone), the card's line 1 (the row's own words), its wait time, and its ONE action row (once-only options only; a stalled row:
   Continue / Reply / ×). The rows here come from inbox-rules.js rowsOf, the same builder the server runs. The pure parts of
   phone.js; the page itself runs in work/deno/remote_phone_inbox_e2e_test.ts and inbox_server_rows_e2e_test.ts. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));
const R = require(path.join(APP, 'inbox-rules.js'));

const shop = { key: 'p-shop', name: 'shopfront' };
const blog = { key: 'p-blog', name: 'blog-site' };
const NOW_S = Date.parse('2026-11-13T12:00:00Z') / 1000;
const NOW = NOW_S * 1000;
const iso = (m) => new Date((NOW_S - m * 60) * 1000).toISOString();
const ONCE = [
  { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'r1', name: 'Deny', kind: 'reject_once' },
];
const perm = (command, options, extra) => ({
  kind: 'permission',
  key: 'k-' + command,
  params: { toolCall: { title: 'Bash', rawInput: { command } }, options: options || ONCE },
  ...extra,
});
const chat = (id, project, attention, extra) => ({ key: 'claude:' + id, id, title: id, project, live: true, attention, ...extra });
const needs = (id, project, ago, request) =>
  chat(id, project, { state: 'needs_you', needs: 1 }, { requestAt: NOW_S - ago * 60, request });
const idle = { state: 'idle', needs: 0 };

const facts = [
  needs('s-new', shop, 2, perm('npm install stripe@18.0.0')),
  needs('b-old', blog, 30, perm('npm run build')),
  chat('s-old', shop, { state: 'needs_you', needs: 1 }, {
    requestAt: NOW_S - 20 * 60,
    elicitations: 1,
    request: { kind: 'question', key: 'q1', params: { message: 'Which layout?', mode: 'form' } },
  }),
  chat('s-fail', shop, { ...idle, failedAt: iso(5), error: 'Rate limit reached' }),
  chat('b-rev', blog, idle, { mark: { yourTurnAt: NOW_S - 60 }, lastText: 'Done: tests pass' }),
  chat('s-rev', shop, idle, { mark: { yourTurnAt: NOW_S - 540 }, lastText: 'All green.' }),
  chat('working', shop, { state: 'working', needs: 0 }),
  chat('quiet', shop, idle),
];
const home = { inbox: R.rowsOf(facts, NOW_S, {}) };
const row = (id) => home.inbox.rows.find((r) => r.id === id);

test('envelope: the count is the server\'s one number; a teal dot only when To review rows alone wait', () => {
  assert.deepEqual(P.inboxBadge(home), { count: 4, dot: false });
  const reviewOnly = { inbox: R.rowsOf([facts[4], facts[7]], NOW_S, {}) };
  assert.deepEqual(P.inboxBadge(reviewOnly), { count: 0, dot: true });
  assert.deepEqual(P.inboxBadge({ inbox: R.rowsOf([facts[7]], NOW_S, {}) }), { count: 0, dot: false });
  assert.deepEqual(P.inboxBadge(null), { count: 0, dot: false });
  assert.deepEqual(P.inboxBadge({ waiting: 3 }), { count: 3, dot: false }, 'an older PC: its count only');
});

test('inbox: one Needs you list (the longest wait first), then To review (newest first); no project split, whatever is picked', () => {
  const g = P.inboxGroups(home, 'p-shop', 'shopfront');
  assert.deepEqual(
    g.map((s) => [s.id, s.title, s.chats.map((c) => c.id)]),
    [
      ['needs', 'Needs you', ['b-old', 's-old', 's-fail', 's-new']],
      ['review', 'To review', ['b-rev', 's-rev']],
    ],
  );
  assert.deepEqual(P.inboxGroups({ inbox: R.rowsOf([], NOW_S, {}) }).map((s) => [s.id, s.chats.length]), [['needs', 0]]);
  for (const s of g) assert.doesNotMatch(s.title, /Needs you in /);
});

test('card line 1: the row\'s own words, no reason label; the wait time alone ("4m"), orange from 15 minutes', () => {
  assert.equal(P.inboxWhat(row('s-new')), 'Run npm install stripe@18.0.0');
  assert.equal(P.inboxWhat(row('s-old')), 'Which layout?');
  assert.equal(P.inboxWhat(row('s-fail')), 'Rate limit reached');
  assert.equal(P.inboxWhat(row('b-rev')), 'Done: tests pass');
  for (const r of home.inbox.rows) assert.doesNotMatch(P.inboxWhat(r), /^(Question|Sign-in|Asks|Approval)\b|waited|Claude Code/);
  assert.deepEqual(P.inboxWait(row('s-new'), NOW), { text: '2m', long: false });
  assert.deepEqual(P.inboxWait(row('b-old'), NOW), { text: '30m', long: true });
  assert.deepEqual(P.inboxWait(row('b-rev'), NOW), { text: '1m', long: false }, 'To review: how long ago, never orange');
});

const acts = (r, can) => P.inboxActions(r, can || { approve: true, answer: true, send: true }).map((a) => a.label + (a.optionId ? '=' + a.optionId : ''));
const one = (f) => R.rowsOf([f], NOW_S, {}).rows[0];

test('card actions: ONE row. Approval: Allow once / Deny / Reply (once-only options only, nothing "always")', () => {
  assert.deepEqual(acts(row('s-new')), ['Allow once=a1', 'Deny=r1', 'Reply']);
  const withAlways = perm('npm test', [
    { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'r1', name: 'Deny', kind: 'reject_once' },
  ]);
  assert.deepEqual(acts(one(needs('x', shop, 1, withAlways))), ['Deny=r1', 'Reply'], 'an "always" option is never a phone button');
  assert.deepEqual(acts(row('s-new'), { approve: false }), ['Reply']);
  assert.deepEqual(acts(one(needs('x', shop, 1, perm('npm test', ONCE, { pcOnly: true })))), ['Reply']);
});

test('card actions: a risky command is Review first; questions Reply; failures Retry / Reply; stalled Continue / Reply / ×; To review Reply + ×', () => {
  for (const cmd of ['git push origin main', 'git push --force', 'rm -rf build', 'git reset --hard HEAD~1', 'Remove-Item dist -Recurse']) {
    assert.deepEqual(acts(one(needs('r', shop, 1, perm(cmd)))), ['Review first', 'Deny=r1'], cmd);
  }
  assert.deepEqual(acts(row('s-old')), ['Reply']);
  assert.deepEqual(acts(row('s-fail')), ['Retry', 'Reply']);
  assert.deepEqual(acts(row('s-fail'), {}), ['Reply'], 'Retry needs the Send switch');
  assert.deepEqual(P.inboxActions(row('b-rev'), {}).map((a) => a.act), ['reply', 'handled']);
  const stalled = one(chat('st', shop, { ...idle, stalledAt: iso(3), stallKind: 'silent_end', stallStep: 'Edit src/cart.ts' }));
  assert.equal(stalled.kind, 'stalled');
  assert.deepEqual(P.inboxActions(stalled, { send: true }).map((a) => a.act), ['continue', 'reply', 'handled']);
  assert.deepEqual(P.inboxActions(stalled, {}).map((a) => a.act), ['reply', 'handled'], 'Continue needs the Send switch');
  assert.equal(home.inbox.rows.some((r) => r.id === 'working'), false, 'a working chat is not in the inbox');
});
