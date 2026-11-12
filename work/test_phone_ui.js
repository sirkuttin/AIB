'use strict';
/* The phone page's pure parts (phone.js) and Settings > Devices' (devices-ui.js): the condensed chat rows, status words, the live
   line, and the Tailscale checklist's wording. The pages themselves run in work/deno/remote_phone_e2e_test.ts. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const P = require(path.join(APP, 'phone.js'));
const D = require(path.join(APP, 'devices-ui.js'));

const update = (seq, u) => ({ seq, kind: 'update', data: { update: u } });
const say = (seq, text) => update(seq, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

test('rows: prompts, merged agent messages, one fold per run of steps, notices; images by URL', () => {
  const rows = P.rowsFrom([
    { seq: 1, kind: 'user', data: { text: 'Fix the tests', attachments: [{ name: 'a.png', url: '/api/remote/image?id=x&seq=1&n=0' }] } },
    say(2, 'Look'),
    say(3, 'ing now.'),
    update(4, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hidden' } }),
    update(5, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read a.ts', status: 'in_progress' }),
    update(6, { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Run tests', status: 'pending' }),
    update(7, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }),
    say(8, 'Done.'),
    { seq: 9, kind: 'permission', data: { key: 'k', params: { toolCall: { title: 'npm test' } } } },
    { seq: 10, kind: 'error', data: { message: 'Agent stopped' } },
    update(11, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', url: '/api/remote/image?id=x&seq=11&n=0' } }),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.text, r.steps && r.steps.map((s) => [s.title, s.done])]),
    [
      ['you', 'Fix the tests', undefined],
      ['agent', 'Looking now.', undefined],
      ['steps', undefined, [['Read a.ts', true], ['Run tests', false]]],
      ['agent', 'Done.', undefined],
      ['notice', 'Asked to: npm test', undefined],
      ['notice', 'Agent stopped', undefined],
      ['agent', '', undefined],
    ],
  );
  assert.deepEqual(rows[0].images, ['/api/remote/image?id=x&seq=1&n=0']);
  assert.deepEqual(rows[6].images, ['/api/remote/image?id=x&seq=11&n=0']);
  assert.equal(P.liveLine({ busy: true, busySince: '' }, rows), 'Step 2 · Run tests');
  assert.equal(P.liveLine({ busy: false }, rows), '');
});

test('status words match the PC: Needs you, Working, Your turn, Idle', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  assert.deepEqual(P.stateWords({ needs: 1, state: 'needs_you' }, now), { text: 'Needs you', tone: 'need' });
  assert.deepEqual(P.stateWords({ needs: 0, state: 'working', busySince: '2026-11-12T11:56:00Z' }, now), {
    text: 'Working · 4 min',
    tone: 'work',
  });
  assert.equal(P.stateWords({ needs: 0, state: 'idle', yourTurn: true, turnEndedAt: '2026-11-12T11:48:00Z' }, now).text, 'Your turn · finished 12 min ago');
  assert.equal(P.stateWords({ needs: 0, state: 'idle', turnEndedAt: null }, now).text, 'Idle');
  assert.equal(P.helperWord('running'), 'working');
  assert.equal(P.helperWord('completed'), 'done');
});

test('Devices: the Tailscale checklist says what to do next, and shows the serve command until it is done', () => {
  const view = { serveCommand: 'tailscale serve --bg --https=443 http://127.0.0.1:8779', tailscale: null };
  let steps = D.checklist(view);
  assert.deepEqual(steps.map((s) => s.done), [false, false, false]);
  assert.match(steps[0].detail, /tailscale\.com\/download/);
  const ts = { signedIn: true, machine: 'studio-pc', tailnet: 'tail-a1b2.ts.net', name: 'studio-pc.tail-a1b2.ts.net', login: 'a@b', https: true, serving: false };
  steps = D.checklist({ ...view, tailscale: ts });
  assert.equal(steps[0].detail, 'Found as STUDIO-PC on tail-a1b2.ts.net, signed in as a@b.');
  assert.equal(steps[2].command, view.serveCommand);
  steps = D.checklist({ ...view, tailscale: { ...ts, serving: true } });
  assert.deepEqual(steps.map((s) => s.done), [true, true, true]);
  assert.equal(steps[2].command, '');
  assert.equal(D.countdown(1000 + 292, 1000 * 1000), '4:52');
  assert.equal(D.ago(0), 'never');
});

test('question sheet: fields from the form schema (choices, yes / no, several, number, text) and the answer to send', () => {
  const schema = {
    type: 'object',
    properties: {
      format: { type: 'string', title: 'Date format', oneOf: [{ const: 'long', title: '12 November 2026' }, { const: 'iso' }] },
      size: { type: 'string', enum: ['s', 'm'] },
      ok: { type: 'boolean', title: 'Publish now' },
      tags: { type: 'array', items: { enum: ['a', 'b'] } },
      count: { type: 'integer', title: 'How many' },
      note: { type: 'string', description: 'Free text' },
    },
    required: ['format', 'count'],
  };
  const fields = P.fieldsOf(schema);
  assert.deepEqual(fields.map((f) => [f.key, f.type, f.required]), [
    ['format', 'choice', true],
    ['size', 'choice', false],
    ['ok', 'bool', false],
    ['tags', 'multi', false],
    ['count', 'number', true],
    ['note', 'text', false],
  ]);
  assert.deepEqual(fields[0].choices, [{ value: 'long', label: '12 November 2026' }, { value: 'iso', label: 'iso' }]);
  assert.deepEqual(P.contentFrom(fields, {}).missing, ['Date format', 'How many']);
  assert.deepEqual(P.contentFrom(fields, { format: 'iso', count: '3', note: '  ', ok: false, tags: [] }), {
    content: { format: 'iso', count: 3, ok: false },
    missing: [],
  });
});

test('approval sheet: Deny then Allow once, only for the options the PC sends; what this phone may do', () => {
  const wait = { kind: 'permission', key: 'k', options: [{ optionId: 'y', kind: 'allow_once' }, { optionId: 'n', kind: 'reject_once' }] };
  assert.deepEqual(P.approvalButtons(wait), [
    { label: 'Deny', optionId: 'n', tone: 'deny' },
    { label: 'Allow once', optionId: 'y', tone: 'allow' },
  ]);
  assert.deepEqual(P.approvalButtons({ options: [] }), []);
  const all = P.abilities(['phone.read', 'phone.answer', 'phone.prompt', 'phone.approve']);
  assert.deepEqual(all, { answer: true, approve: true, send: true });
  const none = P.abilities(['phone.read']);
  assert.equal(P.actionable(wait, all), true);
  assert.equal(P.actionable(wait, none), false, 'Approve off: no buttons');
  assert.equal(P.actionable({ ...wait, pcOnly: true }, all), false, 'PC only');
  assert.equal(P.actionable({ kind: 'question', key: 'q' }, all), true);
  assert.equal(P.actionable({ kind: 'question', key: 'q' }, { ...all, answer: false }), false, 'Answer off');
  assert.equal(P.actionable({ kind: 'sign-in', pcOnly: true }, all), false);
});

test("Devices: a phone's switches keep See chats on; a Phone activity line names the phone, action, chat and result", () => {
  assert.deepEqual(D.scopesAfter(['phone.read', 'phone.prompt'], 'phone.approve', true), ['phone.read', 'phone.prompt', 'phone.approve']);
  assert.deepEqual(D.scopesAfter(['phone.read', 'phone.prompt'], 'phone.prompt', false), ['phone.read']);
  assert.deepEqual(D.scopesAfter([], 'phone.read', false), ['phone.read']);
  const e = { name: 'Pixel 9', device: 'd1', action: 'approve', chat: 'abcdef123456', chatTitle: 'Checkout redesign', result: 'done' };
  assert.equal(D.activityLine(e, '12/11/2026 14:06'), '12/11/2026 14:06 · Pixel 9 · approve · "Checkout redesign": done');
  assert.equal(D.activityLine({ ...e, chatTitle: '' }, 'T'), 'T · Pixel 9 · approve · chat abcdef12: done');
  assert.equal(D.activityLine({ action: 'phone access', result: 'turned on' }, 'T'), 'T · AIB · phone access: turned on');
});
