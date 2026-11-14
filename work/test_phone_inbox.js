'use strict';
/* The phone's inbox (inbox prototype v3, phone frame): the envelope at the top right of home next to the project picker, its count
   badge (chats that need you, every project) or teal dot (only To review waits), the sections in order (picked project first,
   then other projects, then To review), the card's line 1 (the actual request), its wait time, and its ONE action row (once-only
   options only). The pure parts of phone.js; the page itself runs in work/deno/remote_phone_e2e_test.ts. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));

const shop = { id: 'p-shop', name: 'shopfront', color: 'teal' };
const blog = { id: 'p-blog', name: 'blog-site', color: 'pink' };
const NOW = Date.parse('2026-11-13T12:00:00Z');
const min = (m) => new Date(NOW - m * 60000).toISOString();
const chat = (id, project, ago, extra) => ({
  id,
  key: 'claude:' + id,
  title: id,
  agent: 'Claude Code',
  project,
  changedAt: min(ago),
  state: 'idle',
  phase: 'idle',
  needs: 0,
  line: '',
  ask: null,
  ...extra,
});
const ONCE = [
  { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'r1', name: 'Deny', kind: 'reject_once' },
];
const perm = (detail, title, options) => ({ kind: 'permission', key: 'k-' + detail, title: title || 'Bash', detail, options: options || ONCE, pcOnly: false });
const blocked = (id, project, ago, ask) => chat(id, project, ago, { state: 'needs_you', phase: 'needs_you', needs: 1, ask });
const review = (id, project, ago) => chat(id, project, ago, { phase: 'your_turn', yourTurn: true, line: 'Done: tests pass' });

const home = {
  chats: [
    blocked('s-new', shop, 2, perm('npm install stripe@18.0.0')),
    blocked('b-old', blog, 30, perm('npm run build')),
    blocked('s-old', shop, 20, { kind: 'question', key: 'q1', title: 'Which layout?', detail: '', options: [], pcOnly: false }),
    chat('s-fail', shop, 5, { phase: 'failed', line: 'Rate limit reached' }),
    review('b-rev', blog, 1),
    review('s-rev', shop, 9),
    chat('working', shop, 1, { state: 'working', phase: 'working' }),
    chat('idle', blog, 60),
  ],
};

test('envelope: the count is chats that need you in every project; a teal dot only when To review chats alone wait', () => {
  assert.deepEqual(P.inboxBadge(home), { count: 4, dot: false });
  assert.deepEqual(P.inboxBadge({ chats: [review('r', shop, 1), chat('i', shop, 1)] }), { count: 0, dot: true });
  assert.deepEqual(P.inboxBadge({ chats: [chat('i', shop, 1)] }), { count: 0, dot: false });
  assert.deepEqual(P.inboxBadge(null), { count: 0, dot: false });
});

test('inbox, a project picked: Needs you in it first (oldest first), then other projects right below, then To review (picked first)', () => {
  const g = P.inboxGroups(home, 'p-shop', 'shopfront');
  assert.deepEqual(
    g.map((s) => [s.id, s.title, s.chats.map((c) => c.id)]),
    [
      ['here', 'Needs you in shopfront', ['s-old', 's-fail', 's-new']],
      ['other', 'Needs you in other projects', ['b-old']],
      ['review', 'To review', ['s-rev', 'b-rev']],
    ],
  );
});

test('inbox, a project picked with nothing blocked in it: its section stays (empty); other projects follow', () => {
  const g = P.inboxGroups(home, 'p-blog', 'blog-site');
  assert.deepEqual(
    g.map((s) => [s.id, s.chats.map((c) => c.id)]),
    [
      ['here', ['b-old']],
      ['other', ['s-old', 's-fail', 's-new']],
      ['review', ['b-rev', 's-rev']],
    ],
  );
  const quiet = P.inboxGroups({ chats: [blocked('x', shop, 3, null)] }, 'p-blog', 'blog-site');
  assert.deepEqual(quiet.map((s) => [s.id, s.chats.length]), [['here', 0], ['other', 1]]);
});

test('inbox, All projects: one Needs you list (oldest first), then To review (newest first); no To review section when empty', () => {
  const g = P.inboxGroups(home, '', '');
  assert.deepEqual(
    g.map((s) => [s.id, s.title, s.chats.map((c) => c.id)]),
    [
      ['needs', 'Needs you', ['b-old', 's-old', 's-fail', 's-new']],
      ['review', 'To review', ['b-rev', 's-rev']],
    ],
  );
  assert.deepEqual(P.inboxGroups({ chats: [] }, '', '').map((s) => [s.id, s.chats.length]), [['needs', 0]]);
});

test('card line 1: the actual request, no reason label; the wait time alone ("4m"), orange from 15 minutes', () => {
  assert.equal(P.inboxWhat(home.chats[0]), 'Run npm install stripe@18.0.0');
  assert.equal(P.inboxWhat(blocked('e', shop, 1, perm('src/app.ts', 'Edit src/app.ts'))), 'Edit src/app.ts');
  assert.equal(P.inboxWhat(home.chats[2]), 'Which layout?');
  assert.equal(P.inboxWhat(home.chats[3]), 'Rate limit reached');
  assert.equal(P.inboxWhat(chat('a', shop, 1, { phase: 'asks', line: 'Asks: Ship it today?' })), 'Ship it today?');
  assert.equal(P.inboxWhat(home.chats[4]), 'Done: tests pass');
  for (const c of home.chats) assert.doesNotMatch(P.inboxWhat(c), /^(Question|Sign-in|Asks|Approval)\b|waited|Claude Code/);
  assert.deepEqual(P.inboxWait(home.chats[0], NOW), { text: '2m', long: false });
  assert.deepEqual(P.inboxWait(home.chats[1], NOW), { text: '30m', long: true });
  assert.deepEqual(P.inboxWait(chat('x', shop, 15), NOW), { text: '15m', long: true });
});

const acts = (c, can) => P.inboxActions(c, can || { approve: true, answer: true }).map((a) => a.label + (a.optionId ? '=' + a.optionId : ''));

test('card actions: ONE row. Approval: Allow once / Deny / Reply (once-only options only, nothing "always")', () => {
  assert.deepEqual(acts(home.chats[0]), ['Allow once=a1', 'Deny=r1', 'Reply']);
  const withAlways = perm('npm test', 'Bash', [
    { optionId: 'aa', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'r1', name: 'Deny', kind: 'reject_once' },
  ]);
  assert.deepEqual(acts(blocked('x', shop, 1, withAlways)), ['Deny=r1', 'Reply'], 'an "always" option is never a phone button');
  // approving from this phone is off, or the PC must answer it: Reply only (the card opens the chat)
  assert.deepEqual(acts(home.chats[0], { approve: false }), ['Reply']);
  assert.deepEqual(acts(blocked('x', shop, 1, { ...perm('npm test'), pcOnly: true })), ['Reply']);
});

test('card actions: a risky command is Review first (never one tap); questions and failures Reply; To review Reply + ×', () => {
  for (const cmd of ['git push origin main', 'git push --force', 'rm -rf build', 'git reset --hard HEAD~1', 'Remove-Item dist -Recurse']) {
    const c = blocked('r', shop, 1, perm(cmd));
    assert.ok(P.isRisky(c.ask), cmd);
    assert.deepEqual(acts(c), ['Review first', 'Deny=r1'], cmd);
  }
  assert.ok(!P.isRisky(perm('npm test')));
  assert.deepEqual(acts(home.chats[2]), ['Reply']);
  assert.deepEqual(acts(home.chats[3]), ['Reply']);
  assert.deepEqual(
    P.inboxActions(home.chats[4], {}).map((a) => a.act),
    ['reply', 'handled'],
  );
  assert.deepEqual(P.inboxActions(home.chats[6], {}), [], 'a working chat is not in the inbox');
});
