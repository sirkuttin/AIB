'use strict';
const { APP: APP_DIR } = require('./_paths');
// The shared status vocabulary: Working · <time>, Your turn, Needs you, Ready, Elsewhere · Working / Ready, Reconnecting….
const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const W = require(path.join(APP_DIR, 'status-words.js'));

const s = (f) => W.statusOf(Object.assign({ now: 10 * 3600 * 1000 }, f));

test('every state has the agreed words, a tone and a dot', () => {
  const rows = [
    [
      { connected: true, busy: true, busySince: 10 * 3600 * 1000 - 4 * 60000 - 5000 },
      'working',
      'Working · 4m',
      'work',
      'd-work',
    ],
    [{ connected: true, yourTurn: true }, 'your-turn', 'Your turn', 'turn', 'd-turn'],
    [{ connected: true, needs: 1 }, 'needs', 'Needs you', 'need', 'd-need'],
    [{ connected: true }, 'idle', 'Ready', 'idle', 'd-idle'],
    [{}, 'not-running', 'Ready', 'off', 'd-off'],
    [
      { verdict: 'owned_elsewhere', elsewhereWorking: true },
      'elsewhere-working',
      'Elsewhere · Working',
      'else-work',
      'd-else-work',
    ],
    [{ verdict: 'possibly_active' }, 'elsewhere-idle', 'Elsewhere · Ready', 'else', 'd-else'],
    [{ connected: true, issue: true }, 'reconnecting', 'Reconnecting…', 'idle', 'd-idle'],
  ];
  for (const [facts, kind, label, tone, dot] of rows) {
    const r = s(facts);
    assert.deepEqual([r.kind, r.label, r.tone, r.dotClass], [kind, label, tone, dot], label);
    assert.ok(r.title && typeof r.title === 'string', label + ' has a tooltip');
  }
});

test('Ready carries the agreed tooltip, and the old word Saved is gone', () => {
  assert.equal(s({}).title, 'No agent is attached. Send a message to start it again.');
  assert.equal(W.NOT_RUNNING_TITLE, 'No agent is attached. Send a message to start it again.');
  for (const f of [{}, { recovered: true }, { recent: true }, { agentList: true }])
    assert.equal(s(f).label, 'Ready');
  assert.ok(s({ recovered: true }).title.includes('restarted'));
  assert.ok(s({ recent: true }).title.includes('not confirmed to be running'));
});

test('Reconnecting shows while a recovered chat is being reconnected, and stops once it is connected', () => {
  for (const f of [
    { reconnecting: true },
    { reconnecting: true, recovered: true },
    { reconnecting: true, connected: true, opening: true },
  ]) {
    const r = s(f);
    assert.deepEqual([r.kind, r.label], ['reconnecting', 'Reconnecting…']);
  }
  assert.equal(s({ reconnecting: true, connected: true }).label, 'Ready');
  assert.equal(s({ reconnecting: true, connected: true, yourTurn: true }).label, 'Your turn');
  assert.equal(s({ recovered: true }).label, 'Ready');
});

test('Working shows minutes only from one minute, then hours and minutes', () => {
  const at = (ms) => s({ connected: true, busy: true, busySince: 10 * 3600 * 1000 - ms }).label;
  assert.equal(at(0), 'Working');
  assert.equal(at(59000), 'Working');
  assert.equal(at(60000), 'Working · 1m');
  assert.equal(at(65 * 60000), 'Working · 1h 05m');
  assert.equal(s({ connected: true, busy: true }).label, 'Working', 'unknown start: no time');
});

test('precedence: reconnecting, then needs you, then working, then your turn, then idle', () => {
  const all = { connected: true, needs: 2, needsKind: 'question', busy: true, yourTurn: true };
  assert.equal(s(Object.assign({}, all, { issue: true })).kind, 'reconnecting');
  const needs = s(all);
  assert.equal(needs.kind, 'needs');
  assert.equal(needs.detail, 'question +1');
  assert.equal(s({ connected: true, busy: true, yourTurn: true }).kind, 'working');
  assert.equal(s({ connected: true, yourTurn: true }).kind, 'your-turn');
  assert.equal(s({ connected: true, yourTurn: false }).kind, 'idle');
});

test('an attached agent beats an ownership verdict; without one the verdict decides', () => {
  assert.equal(s({ connected: true, verdict: 'owned_elsewhere' }).kind, 'idle');
  assert.equal(s({ verdict: 'no_evidence' }).kind, 'not-running');
  assert.equal(s({ verdict: 'owned_by_studio' }).kind, 'not-running');
});

test('opening and failed are the only extras: transitional and an error', () => {
  assert.equal(s({ connected: true, opening: true }).label, 'Opening…');
  assert.equal(s({ opening: true }).label, 'Opening…');
  const failed = s({ connected: true, failed: true, error: 'spawn failed' });
  assert.deepEqual([failed.label, failed.tone, failed.title], ['Failed', 'bad', 'spawn failed']);
  assert.equal(
    s({ connected: true, failed: true, needs: 1 }).kind,
    'needs',
    'a waiting request is shown before an error',
  );
  assert.deepEqual(W.KINDS.sort(), [
    'elsewhere-idle',
    'elsewhere-working',
    'failed',
    'idle',
    'needs',
    'not-running',
    'opening',
    'reconnecting',
    'working',
    'your-turn',
  ]);
});

test('yourTurnFromEvents: a turn end the user has not answered or handled', () => {
  const end = (t) => ({ kind: 'turn_end', time: t }),
    user = (t) => ({ kind: 'user', time: t });
  assert.equal(W.yourTurnFromEvents([user(1), end(2)]), true);
  assert.equal(W.yourTurnFromEvents([user(1), end(2), user(3)]), false);
  assert.equal(W.yourTurnFromEvents([user(1), end(2), user(3), end(4)]), true);
  assert.equal(W.yourTurnFromEvents([user(1), end(2)], 2), false, 'handled at or after the turn end');
  assert.equal(
    W.yourTurnFromEvents([user(1), end(2), user(3), end(4)], 2),
    true,
    'a newer turn end is not covered by an older handled mark',
  );
  assert.equal(W.yourTurnFromEvents([]), false);
  assert.equal(W.yourTurnFromEvents(null), false);
});

test('elsewhereWorking: an explicit flag wins, else recent transcript writes', () => {
  assert.equal(W.elsewhereWorking(null), false);
  assert.equal(W.elsewhereWorking({ working: true }), true);
  assert.equal(W.elsewhereWorking({ working: false, reasons: [{ signal: 'transcript' }] }), false);
  assert.equal(W.elsewhereWorking({ reasons: [{ signal: 'transcript' }] }), true);
  assert.equal(W.elsewhereWorking({ reasons: [{ signal: 'process-folder' }] }), false);
});

test('conversation.elsewhere {working, confirmed, verdict} maps to Elsewhere words', () => {
  assert.equal(
    s({ elsewhere: { working: true, confirmed: false, verdict: 'possibly_active' } }).label,
    'Elsewhere \u00B7 Working',
  );
  assert.equal(
    s({ elsewhere: { working: false, confirmed: true, verdict: 'owned_elsewhere' } }).label,
    'Elsewhere \u00B7 Ready',
  );
  assert.equal(s({ connected: true, elsewhere: { working: true, verdict: 'owned_elsewhere' } }).kind, 'idle');
});

test('helpers or a background command still running after the reply: Working (· N helpers), never Your turn (the inbox rule)', () => {
  const two = W.statusOf({ connected: true, yourTurn: true, helpers: 2 });
  assert.equal(two.kind, 'working');
  assert.equal(two.label, 'Working · 2 subagents');
  assert.equal(W.statusOf({ connected: true, yourTurn: true, helpers: 1 }).label, 'Working · 1 subagent');
  const bg = W.statusOf({ connected: true, yourTurn: true, background: true });
  assert.equal(bg.kind, 'working');
  assert.equal(bg.label, 'Working');
  assert.equal(W.statusOf({ connected: true, yourTurn: true, helpers: 0 }).label, 'Your turn');
  assert.equal(W.statusOf({ connected: true, needs: 1, helpers: 2 }).label, 'Needs you', 'a request still wins');
});

test('a chat the reopen after a restart gave up on says so, with the reason in the tooltip (not Ready, still Continue)', () => {
  const r = s({ recovered: false, reconnectError: 'Ubuntu stopped. Reconnect' });
  assert.deepEqual([r.kind, r.label, r.tone], ['not-running', "Couldn't reopen", 'off']);
  assert.ok(r.title.includes('could not reopen it after the restart: Ubuntu stopped. Reconnect'), r.title);
  assert.ok(r.title.includes('Send a message to try again'), r.title);
  assert.ok(s({ reconnectError: '' }).title.startsWith('AIB could not reopen it after the restart.'));
  assert.equal(s({ connected: true, reconnectError: 'x' }).label, 'Ready', 'a running chat is not "could not reopen"');
  assert.equal(s({}).label, 'Ready', 'no reason, no change');
});

test('the three not-live words: saved chat Ready, gave up Couldn\'t reopen (reason on hover), reconnecting Reconnecting…', () => {
  assert.equal(s({ recovered: true }).label, 'Ready');
  const failed = s({ recovered: true, reconnectError: 'Ubuntu stopped' });
  assert.equal(failed.label, "Couldn't reopen");
  assert.ok(failed.title.includes('Ubuntu stopped') && failed.title.includes('Send a message to try again'), failed.title);
  assert.equal(s({ recovered: true, reconnecting: true }).label, 'Reconnecting…');
  for (const f of [{}, { recovered: true }, { reconnectError: 'x' }]) assert.ok(!/Not running/.test(s(f).label), s(f).label);
});

test('subagents running: the same words while the agent is mid-turn and after the reply ends', () => {
  const busy = s({ connected: true, busy: true, busySince: 10 * 3600 * 1000 - 5 * 60000, helpers: 4 });
  const ended = s({ connected: true, helpers: 4 });
  assert.equal(busy.label, 'Working · 4 subagents');
  assert.equal(ended.label, busy.label);
  assert.equal(busy.tone, ended.tone);
  assert.notEqual(busy.title, ended.title, 'only the tooltip tells whether you can send');
  assert.equal(s({ connected: true, busy: true, helpers: 1 }).label, 'Working · 1 subagent');
  assert.equal(s({ connected: true, busy: true, busySince: 10 * 3600 * 1000 - 5 * 60000 }).label, 'Working · 5m', 'no subagents: the time');
});
