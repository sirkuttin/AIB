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
