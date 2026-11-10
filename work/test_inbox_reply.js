const { APP: APP_DIR } = require('./_paths');
// Quick reply from the inbox: row action sets, choice detection, context clamping and the keyboard state machine.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const R = require(path.join(APP_DIR, 'inbox-reply.js'));

const turnRow = { kind: 'yourTurn', kinds: [], handled: true };
const permRow = { kind: 'needs', kinds: [{ kind: 'permission', count: 1 }], handled: false };
const perm = (key, options) => ({ key, params: { toolCall: { title: 'run build' }, options } });
const choice = (props, extra) => ({
  key: 'e1',
  params: Object.assign(
    { mode: 'form', message: 'Which?', requestedSchema: { type: 'object', properties: props } },
    extra,
  ),
});

test('your-turn rows offer Reply, Mark handled and Open chat; no answer buttons', () => {
  const a = R.rowActions(turnRow, {});
  assert.equal(a.reply, true);
  assert.equal(a.handled, true);
  assert.deepEqual(a.buttons, []);
  assert.equal(a.open, true);
});

test("approval rows show the request's own options, in its order", () => {
  const a = R.rowActions(permRow, {
    permissions: [
      perm('p1', [
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no', name: 'Deny', kind: 'reject_once' },
      ]),
    ],
  });
  assert.equal(a.reply, false);
  assert.deepEqual(
    a.buttons.map((b) => b.label),
    ['Allow once', 'Always allow', 'Deny'],
  );
  assert.deepEqual(
    a.buttons.map((b) => b.tone),
    ['ok', 'ok', 'no'],
  );
  assert.deepEqual(a.buttons[2], {
    id: 'p2',
    label: 'Deny',
    tone: 'no',
    op: 'permission',
    reqKey: 'p1',
    optionId: 'no',
  });
});

test('an approval row whose request is not loaded yet says loading; with no options it is open-chat only', () => {
  assert.equal(R.rowActions(permRow, {}).loading, true);
  assert.equal(R.rowActions(permRow, { permissions: null }).loading, true);
  const none = R.rowActions(permRow, { permissions: [perm('p1', [])] });
  assert.equal(none.openOnly, true);
  assert.deepEqual(none.buttons, []);
  const gone = R.rowActions(permRow, { permissions: [] });
  assert.equal(gone.openOnly, true);
});

test('more than one waiting approval answers the first and counts the rest', () => {
  const a = R.rowActions(permRow, {
    permissions: [
      perm('p1', [{ optionId: 'y', name: 'Allow once' }]),
      perm('p2', [{ optionId: 'y', name: 'Allow once' }]),
    ],
  });
  assert.equal(a.more, 1);
  assert.equal(a.buttons[0].reqKey, 'p1');
});

test('a multiple-choice question shows its options as buttons and answers with the field value', () => {
  const q = choice({
    plan: {
      type: 'string',
      oneOf: [
        { const: 'basic', title: 'Basic' },
        { const: 'pro', title: 'Pro' },
      ],
    },
  });
  const row = { kind: 'needs', kinds: [{ kind: 'question', count: 1 }], handled: false };
  const a = R.rowActions(row, { elicitations: [q] });
  assert.deepEqual(
    a.buttons.map((b) => b.label),
    ['Basic', 'Pro'],
  );
  assert.deepEqual(a.buttons[1], {
    id: 'c1',
    label: 'Pro',
    tone: '',
    op: 'elicitation',
    reqKey: 'e1',
    field: 'plan',
    value: 'pro',
  });
  assert.equal(R.choiceOf(choice({ c: { type: 'string', enum: ['a', 'b'] } })).options[0].label, 'a');
});

test('complex forms, links and sign-in rows are Open chat only', () => {
  const row = { kind: 'needs', kinds: [{ kind: 'question', count: 1 }], handled: false };
  const free = choice({ name: { type: 'string' } });
  const two = choice({ name: { type: 'string' }, plan: { type: 'string', enum: ['a'] } });
  const multi = choice({ many: { type: 'array', items: { enum: ['a', 'b'] } } });
  const url = { key: 'u', params: { mode: 'url', url: 'https://example.com', message: 'sign in' } };
  for (const q of [free, two, multi, url]) {
    assert.equal(R.choiceOf(q), null);
    const a = R.rowActions(row, { elicitations: [q] });
    assert.equal(a.openOnly, true);
    assert.deepEqual(a.buttons, []);
    assert.equal(a.reply, false);
  }
  const auth = R.rowActions({ kind: 'needs', kinds: [{ kind: 'auth', count: 1 }], handled: false }, {});
  assert.equal(auth.openOnly, true);
  assert.equal(auth.reply, false);
});

test('a blocked row that is also your turn keeps Mark handled but never a typed reply', () => {
  const a = R.rowActions(Object.assign({}, permRow, { handled: true }), { permissions: null });
  assert.equal(a.handled, true);
  assert.equal(a.reply, false);
});

test('context text: whitespace is tidied, length capped, long text gets "more"', () => {
  assert.equal(R.contextText('  Hello\r\n\r\n\r\n\r\nthere  \n'), 'Hello\n\nthere');
  assert.equal(R.contextText(null), '');
  const big = R.contextText('x'.repeat(5000));
  assert.equal(big.length, R.MAX_CONTEXT);
  assert.ok(big.endsWith('…'));
  assert.equal(R.isLong('Short question?', 3, 50), false);
  assert.equal(R.isLong('a\nb\nc', 3, 50), false);
  assert.equal(R.isLong('a\nb\nc\nd', 3, 50), true, 'four hard lines');
  assert.equal(R.isLong('y'.repeat(150), 3, 50), false, 'exactly three wrapped lines fits');
  assert.equal(R.isLong('y'.repeat(151), 3, 50), true);
  assert.equal(R.estimateLines('', 50), 1);
});

// ---- keyboard ---------------------------------------------------------------------------------------------
const rows = [
  { reply: false, handled: false },
  { reply: true, handled: true },
  { reply: true, handled: true },
];
const press = (state, key, extra) => R.step(state, Object.assign({ key }, extra), { rows });
const alt = { alt: true };

test('Alt+I opens the inbox on the first row and closes it again; plain I does nothing', () => {
  let r = press(R.initial(), 'i', alt);
  assert.equal(r.effect, 'open-inbox');
  assert.deepEqual(r.state, { open: true, index: 0, replying: false });
  assert.equal(press(R.initial(), 'i').effect, 'none');
  assert.equal(press(R.initial(), 'r').effect, 'none', 'keys do nothing while the inbox is closed');
  r = press(r.state, 'I', alt);
  assert.equal(r.effect, 'close-inbox');
  assert.equal(r.state.open, false);
  assert.equal(press(R.initial(), 'i', { alt: true, ctrl: true }).effect, 'none', 'AltGr/Ctrl+Alt is not ours');
});

test('arrows move between rows and stop at the ends', () => {
  let s = { open: true, index: 0, replying: false };
  assert.equal(press(s, 'ArrowUp').index, 0);
  s = press(s, 'ArrowDown').state;
  assert.equal(s.index, 1);
  s = press(s, 'ArrowDown').state;
  assert.equal(s.index, 2);
  assert.equal(press(s, 'ArrowDown').index, 2);
  assert.equal(press(s, 'ArrowUp').effect, 'move');
});

test('R replies only on rows that take a reply; E only where Mark handled exists; O always opens', () => {
  const at = (i) => ({ open: true, index: i, replying: false });
  assert.equal(press(at(0), 'r').effect, 'none');
  const r = press(at(1), 'R');
  assert.equal(r.effect, 'start-reply');
  assert.equal(r.state.replying, true);
  assert.equal(press(at(0), 'e').effect, 'none');
  assert.equal(press(at(1), 'e').effect, 'mark-handled');
  assert.equal(press(at(0), 'o').effect, 'open-chat');
  assert.equal(press(at(2), 'o').index, 2);
  assert.equal(press(at(1), 'r', { shift: true }).effect, 'none');
  assert.equal(press(at(1), 'r', { ctrl: true }).effect, 'none', "Ctrl+R stays the browser's");
});

test('inside the reply box: Enter sends, Shift+Enter and letters are typing, Esc closes the box first, then the inbox', () => {
  const typing = { open: true, index: 1, replying: true };
  assert.equal(press(typing, 'Enter').effect, 'send');
  assert.equal(press(typing, 'Enter', { shift: true }).effect, 'none');
  assert.equal(press(typing, 'e').effect, 'none', 'E types an e, it does not mark handled');
  assert.equal(press(typing, 'r').effect, 'none');
  assert.equal(press(typing, 'ArrowDown').effect, 'none');
  assert.equal(press(typing, 'Enter', { composing: true }).effect, 'none', 'IME confirm is not a send');
  let r = press(typing, 'Escape');
  assert.equal(r.effect, 'close-reply');
  assert.deepEqual(r.state, { open: true, index: 1, replying: false });
  r = press(r.state, 'Escape');
  assert.equal(r.effect, 'close-inbox');
  assert.equal(r.state.open, false);
});

test('a text box outside a reply (notification settings) keeps its keys, but Esc still closes', () => {
  const s = { open: true, index: 1, replying: false };
  assert.equal(press(s, 'r', { typing: true }).effect, 'none');
  assert.equal(press(s, 'Escape', { typing: true }).effect, 'close-inbox');
});

test('an empty inbox: arrows and row keys are harmless', () => {
  const s = { open: true, index: 0, replying: false };
  for (const k of ['ArrowDown', 'r', 'e', 'o']) assert.doesNotThrow(() => R.step(s, { key: k }, { rows: [] }));
  assert.equal(R.step(s, { key: 'r' }, { rows: [] }).effect, 'none');
  assert.equal(R.clampIndex(5, 0), 0);
});

test('a quick reply to a busy chat (or one with queued messages) goes to the queue route; an idle chat takes a prompt', () => {
  assert.equal(R.sendRoute({ busy: true, queue: { items: [] } }), 'queue');
  assert.equal(R.sendRoute({ busy: false, queue: { items: [{ id: 'a' }] } }), 'queue');
  assert.equal(R.sendRoute({ busy: false, queue: { items: [] } }), 'prompt');
  assert.equal(R.sendRoute({ busy: false }), 'prompt');
  assert.equal(R.sendRoute(null), 'prompt');
});
