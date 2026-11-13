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
  assert.deepEqual(steps.map((s) => s.done), [false, false, false, false]);
  assert.match(steps[0].detail, /tailscale\.com\/download/);
  const ts = { signedIn: true, machine: 'studio-pc', tailnet: 'tail-a1b2.ts.net', name: 'studio-pc.tail-a1b2.ts.net', login: 'a@b', https: true, serving: false };
  steps = D.checklist({ ...view, tailscale: ts });
  assert.equal(steps[0].detail, 'Found as STUDIO-PC on tail-a1b2.ts.net, signed in as a@b.');
  assert.equal(steps[2].command, view.serveCommand);
  steps = D.checklist({ ...view, tailscale: { ...ts, serving: true } });
  assert.deepEqual(steps.map((s) => s.done), [true, true, true, false]);
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

test('Devices: the second serve command (artifacts on the phone), its check, and a busy artifact port', () => {
  const view = {
    serveCommand: 'tailscale serve --bg --https=443 http://127.0.0.1:8779',
    artifactCommand: 'tailscale serve --bg --https=8443 http://127.0.0.1:8780',
    artifactProblem: null,
  };
  const ts = { signedIn: true, name: 'studio-pc.tail-a1b2.ts.net', https: true, serving: true, artifactServing: false };
  let step = D.checklist({ ...view, tailscale: ts })[3];
  assert.equal(step.title, 'Artifacts open on your phone');
  assert.equal(step.done, false);
  assert.equal(step.command, view.artifactCommand);
  assert.match(step.detail, /artifacts open on your PC only/);
  assert.deepEqual(
    D.checklist({ ...view, tailscale: ts }).map((s) => s.id),
    [undefined, undefined, 'dvServeCommand', 'dvArtifactCommand'],
  );
  step = D.checklist({ ...view, tailscale: { ...ts, artifactServingOther: 'http://127.0.0.1:9000' } })[3];
  assert.match(step.detail, /^https:\/\/studio-pc\.tail-a1b2\.ts\.net:8443 is shared to http:\/\/127\.0\.0\.1:9000 now/);
  step = D.checklist({ ...view, tailscale: { ...ts, artifactServing: true } })[3];
  assert.deepEqual([step.done, step.command], [true, '']);
  const busy = {
    code: 'artifact_port_busy',
    message: 'Port 8780 is busy: another program uses it, so artifacts open on your PC only.', // port-guard: not bound
  };
  step = D.checklist({ ...view, artifactProblem: busy, tailscale: { ...ts, artifactServing: true } })[3];
  assert.deepEqual([step.done, step.detail, step.command], [false, busy.message, '']);
});

test('artifacts in a chat: one card per artifact version, from artifact events and finished studio_artifact calls', () => {
  const id = '0123456789abcdef';
  const summary = { id, title: 'Sales report', kind: 'html', version: 1, url: 'https://n:8443/a/' + id + '/v1/r.html' };
  const rows = P.rowsFrom([
    { seq: 1, kind: 'user', data: { text: 'Make it' } },
    update(2, {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'mcp__studio_artifact__publish',
      status: 'in_progress',
    }),
    update(3, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      rawOutput: { content: [{ type: 'text', text: 'Published.\n' + JSON.stringify(summary) }] },
    }),
    { seq: 4, kind: 'artifact', data: { type: 'artifact', artifact: summary } }, // the same version: no second card
    say(5, 'Here it is.'),
    { seq: 6, kind: 'artifact', data: { type: 'artifact', artifact: { ...summary, version: 2 } } },
    update(7, {
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      title: 'Read a.ts',
      status: 'completed',
      rawOutput: JSON.stringify(summary),
    }),
    { seq: 8, kind: 'artifact', data: { type: 'artifact', artifact: { id: 'nope', title: 'x' } } },
  ]);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.artifact && [r.artifact.id, r.artifact.title, r.artifact.kind, r.artifact.version]]),
    [
      ['you', undefined],
      ['steps', undefined],
      ['artifact', [id, 'Sales report', 'html', 1]],
      ['agent', undefined],
      ['artifact', [id, 'Sales report', 'html', 2]],
      ['steps', undefined],
    ],
  );
  const failed = { sessionUpdate: 'tool_call_update', toolCallId: 'x', status: 'failed', title: 'studio_artifact' };
  assert.equal(P.artifactFrom(update(9, failed)), null);
  assert.equal(P.artifactKind('md'), 'Markdown');
  assert.equal(P.artifactKind('zip'), 'File');
});

test('artifact links: studio-artifact://, and links to the phone artifact origin (with or without a signed part)', () => {
  const id = '0123456789abcdef';
  const origin = 'https://studio-pc.tail-a1b2.ts.net:8443';
  assert.deepEqual(P.artifactRef('studio-artifact://' + id), { id, version: 0 });
  assert.deepEqual(P.artifactRef(origin + '/a/' + id + '/v3/notes.md?view=1', origin), { id, version: 3 });
  assert.deepEqual(P.artifactRef(origin + '/r/dev.' + id + '.1.mac/a/' + id + '/v1/r.html', origin), { id, version: 1 });
  assert.equal(P.artifactRef(origin + '/a/' + id + '/v3/notes.md', ''), null, 'no artifact origin: not an artifact link');
  assert.equal(P.artifactRef('http://127.0.0.1:8768/a/' + id + '/v1/r.html', origin), null); // port-guard: not bound
  assert.equal(P.artifactRef(origin + 'x/a/' + id + '/v1/r.html', origin), null);
  assert.equal(P.artifactRef('https://example.com/', origin), null);
});

test('banner: news about another chat while this phone is in hand; Needs you is not replaced by another chat finishing', () => {
  assert.equal(P.bannerFrom([], 'c1', null), null);
  assert.equal(P.bannerFrom([{ chat: 'c1', kind: 'turn', title: 'Here' }], 'c1', null), null, 'the chat on screen shows it itself');
  assert.deepEqual(P.bannerFrom([{ chat: 'c2', kind: 'turn', title: 'Shop' }], 'c1', null), {
    chat: 'c2',
    kind: 'turn',
    title: 'Shop',
    text: 'Chat finished',
  });
  const need = P.bannerFrom([{ chat: 'c2', kind: 'needs', title: 'Shop' }], '', null);
  assert.equal(need.text, 'A chat needs you');
  assert.equal(P.bannerFrom([{ chat: 'c3', kind: 'turn', title: 'Blog' }], '', need), need, 'kept');
  assert.equal(P.bannerFrom([{ chat: 'c3', kind: 'needs', title: 'Blog' }], '', need).chat, 'c3', 'the newest Needs you');
  assert.equal(P.bannerFrom(undefined, '', need), need);
  assert.equal(P.bannerFrom([], 'c2', need), null, 'opened that chat: gone');
  assert.equal(P.bannerFrom([{ chat: 'c4', kind: 'turn' }], '', null).title, 'A chat');
  assert.ok(P.BANNER_TURN_MS >= 5000);
});
