'use strict';
// inbox-rules.js: the one set of inbox rules every surface uses (page inbox, badge, title, toasts; the server's notifications,
// the phone's home, both trays). Rule R6 for plain-text questions is checked against the owner's hand-labelled replies from the
// usage study (private/designs/attention-ux/usage-data-2026-11-13.md, section 5): each sample is the reply's last question or
// sentence, put back into a reply of a realistic length and shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { APP } = require('./_paths');
const R = require(path.join(APP, 'inbox-rules.js'));

// A status paragraph with no question in it, so a sample's reply is as long as the real ones were (over 160 characters).
const PAD =
  'I went through the branch, ran the targeted tests and read the logs. The build passes, the two flaky tests are fixed, ' +
  'and the notes are updated in the docs folder.';
const TAIL = 'Status: the builder is still running the full suite; I will report when it lands.';
const reply = (...parts) => parts.join('\n\n');

// [table, row, label, the reply, R6's answer when it differs from the label (a known miss, and why)]
// label: true = blocked (nothing happens until the owner answers); false = optional offer, small talk, or not a question.
const SAMPLES = [
  // A. Turns ending with "?" (rows 23-26 are Codex forks of row 22, left out in the study too)
  ['A', 1, false, reply(PAD, 'The pattern `gpu_(\\w+)?_name` matched 41 entries; the ladder is in `ladder.json`.', 'No other names matched.')],
  ['A', 2, false, reply(PAD, 'The settings strings above are what the ladder then persists (see `persist?()` in the dump).')],
  ['A', 3, false, reply(PAD, 'Census correction to fold in: 7 of the 194 pass-82 targets were cross-pass addresses (`?` marks them).')],
  ['A', 4, true, reply(PAD, 'What were you hoping to do with it?')],
  ['A', 5, true, reply(PAD, 'Do you want me to install rizin?')],
  ['A', 6, true, reply(PAD, 'Should I install `TypeTreeGeneratorAPI`?')],
  ['A', 7, true, reply(PAD, 'Which do you want?')],
  ['A', 8, true, reply(PAD, 'Which would you like: 30 days (my recommendation), 3 days like D2 Survivors, or something else?')],
  ['A', 9, true, reply(PAD, 'A. Keep it.\nB. Drop it.', 'A or B?')],
  ['A', 10, true, reply(PAD, 'Which do you want?')],
  ['A', 11, true, reply(PAD, 'A, B, C, or wait until you\'ve play-tested?')],
  ['A', 12, true, reply(PAD, 'Do you have a name in mind, or should I use a placeholder for now?')],
  ['A', 13, true, reply(PAD, 'A or B?')],
  ['A', 14, true, reply(PAD, 'A, B or C?')],
  ['A', 15, true, reply(PAD, 'Want me to add an optional hosts-file step to the script alongside the firewall?')],
  ['A', 16, true, reply(PAD, 'Should I go ahead with that while you think about the rest?')],
  ['A', 17, true, reply(PAD, 'Which cheats interest you most?')],
  ['A', 18, true, reply(PAD, 'Shall I start?')],
  ['A', 19, true, reply(PAD, 'Should I make that test change and remove those four test sessions from your Claude history?')],
  ['A', 20, true, reply(PAD, 'Do you want me to take #3 now, and draft the page code for #2 in a separate file?')],
  ['A', 21, true, reply(PAD, 'If a, should it apply only to chats that were live in Studio before the restart?')],
  ['A', 22, true, reply(PAD, 'What was the main reason you chose to build this instead of using the alternatives?')],
  ['A', 27, true, reply(PAD, 'Should focus mode be remembered after a restart?')],
  ['A', 28, true, reply(PAD, 'Which one?')],
  ['A', 29, true, reply(PAD, 'Build both?')],
  ['A', 30, true, reply(PAD, 'Should I start all four, or just security and repo hygiene first?')],
  ['A', 31, true, reply(PAD, 'Approve, change, or drop?')],
  ['A', 32, true, reply(PAD, 'Want option 1, or one of the others?')],
  ['A', 33, true, reply(PAD, 'Should I take that minimal version to the architect and then build it?')],
  ['A', 34, true, reply(PAD, 'Shall I do both, the Codex install now and the mockups?')],
  ['A', 35, true, reply(PAD, 'Themes is still an open question: should I add it to the list after agent setup?')],
  ['A', 36, true, reply(PAD, 'Which route do you want for the two Mac builds?')],
  ['A', 37, true, reply(PAD, 'Should I fix both?')],
  ['A', 38, true, reply(PAD, 'Should I go ahead?')],
  ['A', 39, true, reply(PAD, 'What do you think: the half-day fix, or skip it?')],
  ['A', 40, true, reply(PAD, 'Should I start the old Python version for you, and that builder?')],
  ['A', 41, false, 'Hi! What would you like to test?'],
  ['A', 42, true, reply(PAD, 'What kind of fun webpage would you like me to make?')],
  ['A', 43, false, reply(PAD, 'Want a themed batch next, like space, food, or puns about music?'), 'an offer reads like a question'],
  ['A', 44, true, reply(PAD, 'I still need your answer on "3a": the worktree point or "nothing gets lost"?')],
  ['A', 45, false, reply(PAD, 'Want me to have that researched and drawn up?'), 'an optional offer reads like a question'],
  ['A', 46, true, reply(PAD, 'Want that instead?')],
  ['A', 47, true, reply(PAD, 'Should I tell the builder to go ahead with Edit and Request a change as described?')],
  ['A', 48, true, reply(PAD, 'Should I send the builder the Edit design with option 1 included?')],
  ['A', 49, true, reply(PAD, 'Should I stop those too?')],
  ['A', 50, true, reply(PAD, 'And should I check whether `aib-docs` is the only folder that closes after a reload?')],
  ['A', 51, true, reply(PAD, 'Which do you want?')],
  ['A', 52, true, reply(PAD, 'Do you want either or both?')],
  ['A', 53, true, reply(PAD, 'Or the projects inside the Claude and ChatGPT desktop apps themselves?')],
  ['A', 54, true, reply(PAD, 'Should I start the review now?')],
  ['A', 55, true, reply(PAD, 'Should I?')],
  ['A', 56, true, reply(PAD, 'Should I start them?')],
  ['A', 57, true, reply(PAD, 'Should the almost-empty ⋯ menu go?')],
  ['A', 58, true, reply(PAD, 'Should I make both changes?')],
  ['A', 59, true, reply(PAD, 'Which do you prefer?')],
  ['A', 60, true, reply(PAD, 'Should I add it?')],
  ['A', 61, true, reply(PAD, 'Should I fix it next, or leave it for later?')],
  ['A', 62, true, reply(PAD, 'Shall I start that now that the release is out?')],
  ['A', 63, false, "I'm here—what's up?"],
  // B. "?" elsewhere, not at the end
  ['B', 1, true, reply(PAD, '7. Docs tab: keep it.\n8. Publishing artifacts from local-only folders?', 'I recommend (b) for 8.')],
  ['B', 2, false, reply(PAD, 'The question was: should a subagent finishing send a push to your phone?', TAIL)],
  ['B', 3, false, reply(PAD, '## Moving from Conductor?', 'Import the chats from its folder; nothing else changes.')],
  ['B', 4, true, reply(PAD, 'Want me to make the clone there and start a builder on 1 and 2?', TAIL)],
  ['B', 5, true, reply(PAD, 'Which app should own your chats for now?', TAIL)],
  ['B', 6, true, reply(PAD, 'How many notifications should you get?', TAIL)],
  ['B', 7, true, reply(PAD, 'Your call: should docs keep their own sidebar tab, or go back to the Files tree?', TAIL)],
  ['B', 8, false, reply(PAD, 'The draft reads:', '> Is it there to look at or click through?', TAIL)],
  ['B', 9, true, reply(PAD, '**4. How deep should I go?** a) the inbox only b) every surface', 'I recommend (a).')],
  ['B', 10, true, reply(PAD, 'Still waiting on you: the Changes study and the artifacts study decisions.')],
  ['B', 11, true, reply(PAD, 'Still waiting on your reply: should I start a batch to fix the problems the screenshots found? The raw item codes are the most visible.')],
  ['B', 12, true, reply(PAD, 'One question for you: should the keeper be in beta.3?', TAIL)],
  ['B', 13, true, reply(PAD, 'While a chat is mid-turn, should your saved edits flow into its copy right away?', TAIL)],
  ['B', 14, true, reply(PAD, 'Does that work, or do you want some of these somewhere else?', TAIL)],
  ['B', 15, true, reply(PAD, 'Want me to send another batch of agents at that list next?', TAIL)],
  ['B', 16, true, reply(PAD, 'I need one answer from you: do you approve the docs design as recommended?', TAIL)],
  ['B', 17, true, reply(PAD, 'May the PC sleep?', TAIL)],
  ['B', 18, true, reply(PAD, '1. Should links to artifacts in old chat messages show their state?\n2. The list stays as it is.', TAIL)],
  ['B', 19, false, reply(PAD, 'In a real test run it asked "Word, PDF, or a simple text file?" and waited.', TAIL)],
  ['B', 20, true, reply(PAD, 'When should we build this?', TAIL)],
  ['B', 21, false, reply(PAD, '### Why not make it offline by editing files too?', 'Because the agent would have no way to see the result.')],
  ['B', 22, true, reply(PAD, 'Can a helper start its own helpers?', TAIL)],
  ['B', 23, true, reply(PAD, 'Good to build?', TAIL)],
  ['B', 24, true, reply(PAD, 'Still open from earlier: should the keeper go into beta.3?', TAIL)],
  ['B', 25, true, reply(PAD, 'One question: should "AIB Development" point at the real repo instead of the snapshot?', TAIL)],
  ['B', 26, true, reply(PAD, 'Should I?', TAIL)],
  ['B', 27, true, reply(PAD, '1. Then what? a ★ upload now / b wait until your pictures are in', TAIL)],
  ['B', 28, false, reply(PAD, 'Does any step here differ from what you mean?', TAIL), 'an optional check reads like a question'],
  ['B', 29, true, reply(PAD, 'Rewrite or just make it readable?', TAIL)],
  ['B', 30, true, reply(PAD, 'Should I stop the stuck loop (1) and the two old demo copies (2)?', TAIL)],
  // C. No "?" at all
  ['C', 1, false, reply(PAD, 'You can also run it directly:', '```\ndeno task test\n```')],
  ['C', 2, false, reply(PAD, 'If you have a copy running from that folder, it unzips to a new folder name and both keep working.')],
  ['C', 3, false, reply(PAD, "I'll use that approach for the next tracker items unless something breaks.")],
  ['C', 4, false, reply(PAD, 'Connection status can stay visible but secondary.')],
  ['C', 5, false, reply(PAD, 'Still waiting on the UI verifier.')],
  ['C', 6, false, reply(PAD, 'Undemonstrated features are marked not established in the table.')],
  ['C', 7, false, reply(PAD, "Nobody has tried splitting in your real Studio yet, so let me know if anything looks off.")],
  ['C', 8, false, reply(PAD, "I'm waiting on the final test run before building your test build.")],
  ['C', 9, false, reply(PAD, 'Remaining after pass 93: about 3,500 UI bodies.')],
  ['C', 10, true, reply(PAD, 'Open for beta.2: your go on the three older bugs and the agent-host fix.')],
  ['C', 11, false, reply(PAD, 'Nothing broken has reached main or your live Studio.')],
  ['C', 12, false, reply(PAD, 'Still running: the soak test; two copies can never run at once.')],
  ['C', 13, false, reply(PAD, "I'll publish the updated page when it's done.")],
  ['C', 14, false, reply(PAD, "It's another AI reviewer, not an external human specialist.")],
  ['C', 15, false, reply(PAD, 'The themes builder and the theme designer are still working.')],
  ['C', 16, false, reply(PAD, "If you'd like a longer history, I can change that.")],
  ['C', 17, true, reply(PAD, 'I built the inbox part, leaving the "Your turn" part out until you decide.')],
  ['C', 18, false, reply(PAD, 'Not published yet.')],
  ['C', 19, false, reply(PAD, 'The first wave-1 builder is done.')],
  ['C', 20, true, reply(PAD, 'For the earlier update, run Update once with this build to create a verified record.'), 'a task for the owner with no question'],
  ['C', 21, false, reply(PAD, "When the rebuild lands, I'll merge everything, run the full test set once and report.")],
  ['C', 22, false, reply(PAD, "If it's still silent, I'll stop it and finish the remaining items myself.")],
  ['C', 23, false, reply(PAD, 'Nothing to report yet.')],
  ['C', 24, false, reply(PAD, 'Both will be fixed before the final build.')],
  ['C', 25, true, reply(PAD, 'Phase 2 fix 1 is still waiting for your answer.')],
];

for (const [table, row, label, text, miss] of SAMPLES) {
  const expected = miss ? !label : label;
  test(`R6 on sample ${table}${row} (${label ? 'blocked' : 'not blocked'}${miss ? '; known miss: ' + miss : ''})`, () => {
    const got = R.asksOf(text);
    assert.equal(got.asks, expected, JSON.stringify(text));
    if (got.asks) assert.ok(got.question.length > 0 && got.question.length <= 300);
  });
}

test('R6 on the labelled samples: at least as precise and as complete as the study measured (86% / 90%)', () => {
  let tp = 0,
    fp = 0,
    fn = 0;
  for (const [, , label, text] of SAMPLES) {
    const asks = R.asksOf(text).asks;
    if (asks && label) tp++;
    else if (asks) fp++;
    else if (label) fn++;
  }
  assert.ok(tp / (tp + fp) >= 0.86, `precision ${tp}/${tp + fp}`);
  assert.ok(tp / (tp + fn) >= 0.9, `recall ${tp}/${tp + fn}`);
});

test('R6: replies under 160 characters never ask; the question is the last one asked', () => {
  assert.equal(R.asksOf('Which do you want?').asks, false);
  assert.equal(R.asksOf('').asks, false);
  const got = R.asksOf(reply(PAD, 'Should I fix the first one?', 'Or should I fix both?'));
  assert.deepEqual(got, { asks: true, question: 'Or should I fix both?' });
  // code blocks and quotes never ask
  assert.equal(R.asksOf(reply(PAD, '```\nif (ready?) go()\nshould I?\n```')).asks, false);
  assert.equal(R.asksOf(reply(PAD, '> Should I run it?', 'Quoted from the issue.')).asks, false);
  // a long question is cut to 300 characters
  assert.ok(R.asksOf(reply(PAD, 'Should I ' + 'really '.repeat(80) + 'go?')).question.length <= 300);
});

test('classifyError: the agent failures of the study and the usual kinds', () => {
  assert.equal(R.classifyError("You've hit your session limit · resets 3pm"), 'limit');
  assert.equal(R.classifyError('Prompt is too long'), 'limit');
  assert.equal(R.classifyError('Weekly credits used up'), 'limit'); // Qwen Code's quota
  assert.equal(R.classifyError("Couldn't connect to the server: connection refused"), 'network');
  assert.equal(R.classifyError('Authentication required: your subscription does not have access to Kimi Code'), 'auth');
  assert.equal(R.classifyError('Internal error: the agent crashed'), 'crash');
  assert.equal(R.classifyError('Something odd'), 'other');
  assert.equal(R.classifyError(''), '');
});

// ---- phases ----------------------------------------------------------------------------------------------------------------
const NOW = 1_800_000_000;
const iso = (s) => new Date(s * 1000).toISOString();

test('basePhase: requests first, then a running turn, a failure, a question, helpers, shells and the follow-up window', () => {
  const rows = [
    [{ closed: true, needs: 1 }, 'closed'],
    [{ needs: 2, busy: true }, 'needs_you'],
    [{ ready: false }, 'opening'],
    [{ busy: true, failedAt: NOW }, 'working'],
    [{ failedAt: NOW, asksAt: NOW }, 'failed'],
    [{ asksAt: NOW, helpers: 2 }, 'asks'],
    [{ helpers: 2 }, 'working'],
    [{ shells: true }, 'working'],
    [{ followUntil: NOW + 5 }, 'working'],
    [{ followUntil: NOW - 1 }, 'idle'],
    [{}, 'idle'],
  ];
  for (const [facts, phase] of rows) assert.equal(R.basePhase(facts, NOW), phase, JSON.stringify(facts));
});

test('phaseOf: marks decide Finished; Mark handled and Hold clear a failure or a question reported before them', () => {
  const idle = { state: 'idle', turnEndedAt: iso(NOW - 60) };
  const rows = [
    // [attention, mark, phase]
    [{ state: 'needs_you', needs: 1 }, { holdAt: NOW }, 'needs_you'],
    [{ state: 'working' }, { yourTurnAt: NOW }, 'working'],
    [idle, { yourTurnAt: NOW - 60 }, 'your_turn'],
    [idle, {}, 'idle'],
    [idle, { yourTurnAt: NOW - 60, holdAt: NOW - 10 }, 'idle'],
    [{ ...idle, helpers: 2 }, { yourTurnAt: NOW - 60 }, 'working'],
    [{ ...idle, shells: true }, { yourTurnAt: NOW - 60 }, 'working'],
    [{ ...idle, followUntil: iso(NOW + 10) }, { yourTurnAt: NOW - 60 }, 'working'],
    [{ ...idle, followUntil: iso(NOW - 10) }, { yourTurnAt: NOW - 60 }, 'your_turn'],
    [{ ...idle, failedAt: iso(NOW - 30) }, {}, 'failed'],
    [{ ...idle, failedAt: iso(NOW - 30) }, { handledAt: NOW - 10 }, 'idle'],
    [{ ...idle, failedAt: iso(NOW - 30) }, { handledAt: NOW - 40 }, 'failed'],
    [{ ...idle, asksAt: iso(NOW - 30), helpers: 1 }, { yourTurnAt: NOW - 30 }, 'asks'],
    [{ ...idle, asksAt: iso(NOW - 30) }, { handledAt: NOW - 5, yourTurnAt: NOW - 30 }, 'your_turn'],
    [{ ...idle, asksAt: iso(NOW - 30) }, { holdAt: NOW - 5 }, 'idle'],
    // an older agent host without the new facts reads as before
    [{ state: 'idle' }, { yourTurnAt: NOW }, 'your_turn'],
    [null, null, 'idle'],
  ];
  for (const [a, m, phase] of rows) assert.equal(R.phaseOf(a, m, NOW), phase, JSON.stringify([a, m]));
  assert.ok(R.blocked('needs_you') && R.blocked('failed') && R.blocked('asks'));
  assert.ok(!R.blocked('your_turn') && !R.blocked('working') && !R.blocked('idle'));
});

test('countBlocked counts chats blocked on you, never finished or working ones', () => {
  const chats = [
    { attention: { state: 'needs_you', needs: 3 } },
    { attention: { state: 'idle', failedAt: iso(NOW - 5) } },
    { attention: { state: 'idle', asksAt: iso(NOW - 5) } },
    { attention: { state: 'idle' }, mark: { yourTurnAt: NOW } },
    { attention: { state: 'idle', helpers: 1 } },
    { attention: { state: 'working' } },
  ];
  assert.equal(R.countBlocked(chats, NOW), 3);
});

test('open on the PC: the chat in the active tab and split panes, while the window is visible; the desktop count leaves it out', () => {
  assert.deepEqual(R.openKeys({ selected: 'claude:a', panes: ['claude:b', 'claude:a', '', null] }), ['claude:a', 'claude:b']);
  assert.deepEqual(R.openKeys({ selected: 'claude:a', visible: true }), ['claude:a'], 'visible but not focused still counts');
  assert.deepEqual(R.openKeys({ selected: 'claude:a', visible: false }), [], 'minimized or in the tray: nothing is open');
  assert.deepEqual(R.openKeys({ selected: '' }), []);
  assert.equal(R.isOpen('claude:a', ['claude:a']), true);
  assert.equal(R.isOpen('claude:b', ['claude:a']), false);
  assert.equal(R.isOpen('', ['']), false);
  assert.equal(R.isOpen('claude:a', undefined), false);
  const chats = [
    { key: 'claude:a', attention: { state: 'idle', asksAt: iso(NOW - 5) } },
    { key: 'claude:b', attention: { state: 'needs_you', needs: 1 } },
  ];
  assert.equal(R.countBlocked(chats, NOW), 2, 'the phone counts both');
  assert.equal(R.countBlocked(chats, NOW, ['claude:a']), 1, 'the desktop: chat a is open in the window');
  assert.equal(R.countBlocked(chats, NOW, ['claude:b']), 1, 'switched to b: a counts again');
});

test('rows: Needs you oldest wait first, then Finished newest first; the count is Needs you only', () => {
  const rows = [
    { key: 'f1', section: 'finished', at: 100 },
    { key: 'n2', section: 'needs', since: 50 },
    { key: 'f2', section: 'finished', at: 300 },
    { key: 'n1', section: 'needs', since: 10 },
  ];
  assert.deepEqual(
    R.sortRows(rows).map((r) => r.key),
    ['n1', 'n2', 'f2', 'f1'],
  );
  assert.equal(R.countOf(rows), 2);
});

test('words: reasons, helpers, the wait and when it turns orange', () => {
  assert.equal(R.reasonOf('needs_you', [{ kind: 'permission' }]), 'approval');
  assert.equal(R.reasonOf('needs_you', [{ kind: 'question' }]), 'question');
  assert.equal(R.reasonOf('needs_you', [{ kind: 'auth' }]), 'signin');
  assert.equal(R.reasonOf('failed'), 'failed');
  assert.equal(R.reasonOf('asks'), 'asks');
  assert.equal(R.reasonOf('your_turn'), 'finished');
  assert.equal(R.reasonWord('signin'), 'Sign-in');
  assert.equal(R.helpersLine(0), '');
  assert.equal(R.helpersLine(1), '1 subagent running');
  assert.equal(R.helpersLine(2), '2 subagents running');
  assert.deepEqual(R.waitText(NOW - 20, NOW), { text: 'just now', long: false });
  assert.deepEqual(R.waitText(NOW - 14 * 60, NOW), { text: '14m', long: false });
  assert.deepEqual(R.waitText(NOW - 15 * 60, NOW), { text: '15m', long: true });
  assert.deepEqual(R.waitText(NOW - 65 * 60, NOW), { text: '1h 05m', long: true });
  assert.equal(R.waitingSince('failed', { failedAt: iso(NOW) }, 0), NOW);
  assert.equal(R.waitingSince('needs_you', {}, 42), 42);
});

test('R6 reads a 3 MB line without a "?" in linear time (the sentence regex was quadratic and hung the server)', () => {
  const started = Date.now();
  assert.deepEqual(R.asksOf('x'.repeat(3 * 1024 * 1024)), { asks: false, question: '' });
  assert.equal(R.asksOf('x'.repeat(200) + '. Should I merge it now? ').question, 'Should I merge it now?');
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});
