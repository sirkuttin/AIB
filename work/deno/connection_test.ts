/**
 * server/acp/connection.ts against work/fake_acp.py: the Connection cases of work/test_studio.py, test_conformance.py and
 * test_robustness.py (the queue, settings and recovery cases are in connection_queue_test.ts).
 */
import { assert, assertEquals, assertRejects, assertThrows } from './_assert.ts';
import { events, FAKE, type Json, Lab, pause, PYTHON, until, updateTexts } from './_connection.ts';
import { Connection, PyTextLines, ThreadEvent } from '../../outputs/agent-studio/server/acp/connection.ts';
import { MAX_EVENT_IMAGE_BYTES, MAX_IMAGE_BYTES } from '../../outputs/agent-studio/server/acp/attachments.ts';
import { ValueError } from '../../outputs/agent-studio/server/core/py.ts';

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const png = (tail: string) => b64(new Uint8Array([...PNG_HEAD, ...new TextEncoder().encode(tail)]));

async function rejectsWith(fn: () => Promise<unknown>, text: string | RegExp): Promise<Error> {
  const error = await assertRejects(fn);
  assert(typeof text === 'string' ? error.message.includes(text) : text.test(error.message), `unexpected error: ${error.message}`);
  return error;
}

// ---- test_studio.py StudioTests ---------------------------------------------------------------------------------------------

Deno.test('streaming and explicit approval', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('fixture prompt');
  await until(() => c.permissions.size);
  assert(c.busy);
  const key = c.permissions.keys().next().value!;
  assertThrows(() => c.permission(key, 'not-a-real-option'), ValueError);
  assert(c.permissions.has(key));
  c.permission(key, 'yes');
  await until(() => !c.busy);
  assert(updateTexts(c).includes('Fixture response'));
  assert(events(c, 'turn_end').length);
  assertEquals(c.permissions.size, 0);
});

Deno.test('busy guard, interrupt and cursor', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('wait');
  await assertRejects(() => c.prompt('second overlapping prompt'), ValueError);
  await pause(50);
  const cursor = c.public().cursor as number;
  c.cancel();
  await until(() => !c.busy);
  const later = c.public(cursor).events as Json[];
  assert(later.every((e) => (e.seq as number) > cursor));
  assert(later.some((e) => e.kind === 'turn_end' && (e.data as Json).stopReason === 'cancelled'));
});

Deno.test('a prompt retry is accepted only once', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const first = await c.prompt('wait', 'browser-attempt-1');
  const second = await c.prompt('wait', 'browser-attempt-1');
  assertEquals([first.duplicate, second.duplicate], [false, true]);
  assertEquals(events(c, 'user').length, 1);
  await assertRejects(() => c.prompt('different text', 'browser-attempt-1'), ValueError);
  await pause(50);
  c.cancel();
  await until(() => !c.busy);
  const third = await c.prompt('wait', 'browser-attempt-1');
  assert(third.duplicate);
  assert(!c.busy);
  assertEquals(third.turnState, 'finished');
});

Deno.test('an unsupported negotiated version is rejected', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  c.setupRequest = () => Promise.resolve({ protocolVersion: 99 });
  await rejectsWith(() => c.setup(), 'protocol version 1');
  assert(!c.ready);
});

Deno.test('a form elicitation is scoped, validated and answered', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const sent: unknown[] = [];
  c.write = (message) => void sent.push(message);
  const params = {
    sessionId: c.sessionId,
    mode: 'form',
    message: 'Choose a plan',
    requestedSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', oneOf: [{ const: 'basic', title: 'Basic' }, { const: 'pro', title: 'Pro' }] },
        email: { type: 'string', format: 'email' },
      },
      required: ['plan'],
    },
  };
  c.receiveElicitation('form-1', params);
  const key = c.elicitations.keys().next().value!;
  assertEquals(c.public().state, 'input_needed');
  assertThrows(() => c.answerElicitation(key, 'accept', { plan: 'admin' }), ValueError);
  assert(c.elicitations.has(key));
  c.answerElicitation(key, 'accept', { plan: 'pro', email: 'person@example.org' });
  assertEquals(sent.at(-1), {
    jsonrpc: '2.0',
    id: 'form-1',
    result: { action: 'accept', content: { plan: 'pro', email: 'person@example.org' } },
  });
  assertEquals(c.elicitations.size, 0);
});

Deno.test('url-with-requestId, unknown sessions and invalid schemas are rejected', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const base = { mode: 'form', message: 'Choose', requestedSchema: { type: 'object', properties: {} } };
  for (
    const params of [
      { ...base, sessionId: 'foreign' },
      { ...base, requestId: 'outside', mode: 'url', url: 'https://example.org' },
      { ...base, sessionId: c.sessionId, requestedSchema: { type: 'object', properties: { x: { type: 'object' } } } },
    ]
  ) assertThrows(() => c.receiveElicitation('invalid', params), ValueError);
  assertEquals(c.elicitations.size, 0);
});

Deno.test('agent cancellation withdraws a session form without an id collision', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const sent: unknown[] = [];
  c.write = (message) => void sent.push(message);
  const params = {
    sessionId: c.sessionId,
    mode: 'form',
    message: 'Name?',
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
  };
  c.receiveElicitation(42, params);
  const entry = { done: new ThreadEvent(), method: 'session/prompt', params: { sessionId: c.sessionId } };
  c.pending.set(42, entry);
  c.cancelIncomingRequest(42);
  assertEquals(c.elicitations.size, 0);
  assert(!entry.done.isSet(), 'opposite-direction request ID collision must not cancel the client request');
  assertEquals(sent.at(-1), { jsonrpc: '2.0', id: 42, result: { action: 'cancel' } });
  c.pending.delete(42);
});

Deno.test('fixture agent form round trip', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('form');
  await until(() => c.elicitations.size);
  const key = c.elicitations.keys().next().value!;
  const error = assertThrows(() => c.answerElicitation(key, 'accept'), ValueError);
  assert(error.message.includes('missing required'), error.message);
  c.answerElicitation(key, 'accept', { name: 'Ada', plan: 'pro' });
  await until(() => !c.busy);
  assert(updateTexts(c).some((t) => t.includes('Fixture form response')));
});

Deno.test('image-only prompt and a changed picture under the same receipt', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--images']);
  const image = { type: 'image', mimeType: 'image/png', data: png('fixture') };
  const result = await c.prompt('', 'image-attempt', [image]);
  assert(!result.duplicate);
  await until(() => !c.busy);
  assert(c.public().imageSupported);
  const user = events(c, 'user')[0];
  assertEquals(((user.data as Json).attachments as Json[])[0].mimeType, 'image/png');
  assert(updateTexts(c).some((t) => t.includes('Fixture images')));
  assert((await c.prompt('', 'image-attempt', [image])).duplicate);
  await rejectsWith(() => c.prompt('', 'image-attempt', [{ ...image, data: png('changed') }]), 'already used for different text');
});

Deno.test('image capability and attachment validation', async () => {
  await using lab = new Lab();
  const unsupported = await lab.open();
  const valid = { mimeType: 'image/png', data: png('bytes') };
  await rejectsWith(() => unsupported.prompt('look', null, [valid]), 'does not advertise image');
  const c = await lab.open(['--images']);
  const big = new Uint8Array(PNG_HEAD.length + MAX_IMAGE_BYTES + 1).fill(0x78);
  big.set(PNG_HEAD);
  let bigText = '';
  for (let i = 0; i < big.length; i += 0x8000) bigText += String.fromCharCode(...big.subarray(i, i + 0x8000));
  const invalid = [
    [{ mimeType: 'image/png', data: 'not base64!' }],
    [{ mimeType: 'image/svg+xml', data: 'PHN2Zz4=' }],
    [{ mimeType: 'image/jpeg', data: valid.data }],
    [{ mimeType: 'image/png', data: valid.data + 'junk' }],
    Array(5).fill({ mimeType: 'image/png', data: valid.data }),
    [{ mimeType: 'image/png', data: btoa(bigText) }],
  ];
  for (const items of invalid) await assertRejects(() => c.prompt('inspect', null, items), ValueError);
  await rejectsWith(() => c.prompt(''), 'prompt or attach');
  await rejectsWith(() => c.prompt('', null, []), 'prompt or attach');
  // Browsers send an empty list for text-only prompts; agents without image support must accept them.
  await unsupported.prompt('text only', null, []);
  await until(() => unsupported.permissions.size || !unsupported.busy);
});

Deno.test('image history keeps to the event budget', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--images']);
  const payload = 'x'.repeat(Math.floor(MAX_EVENT_IMAGE_BYTES / 2) + 1);
  c.event('user', { attachments: [{ data: payload }] });
  c.event('user', { attachments: [{ data: payload }] });
  assert(c.eventImageBytes <= MAX_EVENT_IMAGE_BYTES);
  assertEquals(c.events.length, 1);
  assertEquals(c.events[0].seq, c.sequence);
});

Deno.test('request-scoped form and close cleanup', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const sent: unknown[] = [];
  c.write = (message) => void sent.push(message);
  c.receiveElicitation(45, {
    requestId: 77,
    mode: 'form',
    message: 'Name?',
    requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
  });
  assertEquals(((c.public().elicitations as Json[])[0].params as Json).requestId, 77);
  c.cancelIncomingRequest(77);
  assertEquals(c.elicitations.size, 1, 'correlation requestId is not the incoming RPC ID');
  c.cancelIncomingRequest('45');
  assertEquals(c.elicitations.size, 1, 'string and integer RPC IDs are distinct');
  await c.close();
  assertEquals(sent.at(-1), { jsonrpc: '2.0', id: 45, result: { action: 'cancel' } });
  assertEquals(c.elicitations.size, 0);
});

Deno.test('close releases the session lease and calls the release hook', async () => {
  // test_owned_connection_releases_lease_on_close, with a stand-in lease (SessionLease is the Studio's).
  await using lab = new Lab();
  const c = await lab.open();
  const released: string[] = [];
  c.sessionLease = { release: () => void released.push('lease') };
  c.onRelease = () => void released.push('hook');
  await c.close();
  // As in Python: the reader's exit releases the lease (and runs the hook), then close() runs the hook again.
  assertEquals(released, ['lease', 'hook', 'hook']);
  assertEquals(c.sessionLease, null);
});

// ---- test_studio.py InteractiveRequestTests ---------------------------------------------------------------------------------

Deno.test('a setup question: accepting it continues setup', async () => {
  await using lab = new Lab();
  const [c, outcome] = lab.start(['--setup-question']);
  await until(() => c.elicitations.size);
  assert(!c.ready);
  assertEquals((c.public().elicitations as Json[])[0].route, 'setup');
  assertEquals(c.public().state, 'input_needed');
  assertEquals((c.initial as Json).protocolVersion, 1);
  c.answerElicitation(c.elicitations.keys().next().value!, 'accept', { label: 'ok' });
  await until(() => c.ready);
  assertEquals(outcome.error, undefined);
});

Deno.test('initialize advertises form and url elicitation', async () => {
  await using lab = new Lab();
  const c = lab.connection([PYTHON, FAKE]);
  const seen: [string, Json][] = [];
  const original = c.setupRequest.bind(c);
  c.setupRequest = (method, params, timeout) => (seen.push([method, params as Json]), original(method, params, timeout));
  await c.setup();
  const init = seen.find(([m]) => m === 'initialize')![1];
  assertEquals((init.clientCapabilities as Json).elicitation, { form: {}, url: {} });
});

Deno.test('a declined or cancelled setup question fails setup with a clear message', async () => {
  for (const action of ['decline', 'cancel']) {
    await using lab = new Lab();
    const [c, outcome] = lab.start(['--setup-question'], 'omp', 'lease-' + action);
    await until(() => c.elicitations.size);
    c.answerElicitation(c.elicitations.keys().next().value!, action);
    await until(() => outcome.done);
    assert(new RegExp(action === 'decline' ? 'declined' : 'cancelled').test(outcome.error!.message), outcome.error!.message);
    assert(outcome.error!.message.includes('was not opened'));
    assert(!c.ready);
  }
});

Deno.test('a setup wait for a person does not time out', async () => {
  await using lab = new Lab();
  const [c, outcome] = lab.start(['--setup-question']);
  await until(() => c.elicitations.size);
  await pause(600);
  assertEquals(outcome.error, undefined);
  assert(!c.closed);
});

Deno.test('url requests are validated', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const base = { sessionId: c.sessionId, mode: 'url', message: 'Sign in', elicitationId: 'e1' };
  for (
    const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'ftp://example.com/x',
      'https://user:pw@example.com/',
      'https://',
      'example.com',
      'https://exa mple.com',
      'data:text/html,hi',
      '',
    ]
  ) assertThrows(() => c.receiveElicitation('bad', { ...base, url }), ValueError);
  assertThrows(() => c.receiveElicitation('bad', { ...base, url: 'https://example.com', elicitationId: '' }), ValueError);
  assertThrows(
    () => c.receiveElicitation('bad', { ...base, url: 'https://example.com', requestedSchema: { type: 'object', properties: {} } }),
    ValueError,
  );
  assertEquals(c.elicitations.size, 0);
  c.write = () => {};
  c.receiveElicitation('ok', { ...base, url: 'https://example.com/path?a=1' });
  const error = assertThrows(() => c.receiveElicitation('dup', { ...base, url: 'https://example.com/other' }), ValueError);
  assert(error.message.includes('already pending'));
});

Deno.test('url elicitation round trip with the fixture agent', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('url');
  await until(() => c.elicitations.size);
  const item = (c.public().elicitations as Json[])[0];
  assertEquals([(item.params as Json).mode, item.route], ['url', 'main']);
  c.answerElicitation(item.key, 'accept', { ignored: true });
  await until(() => !c.busy);
  assert(updateTexts(c).join('').includes('{"action": "accept"}'));
});

Deno.test('url decline, and the agent reporting completion', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('url');
  await until(() => c.elicitations.size);
  c.answerElicitation(c.elicitations.keys().next().value!, 'decline');
  await until(() => !c.busy);
  assert(updateTexts(c).join('').includes('{"action": "decline"}'));
  await c.prompt('url-complete');
  await until(() => !c.busy);
  assertEquals(c.elicitations.size, 0);
  assert(events(c, 'request_withdrawn').some((e) => ((e.data as Json).reason as string).includes('complete')));
});

Deno.test('requests left open are withdrawn when the turn ends', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('leave-open');
  await until(() => !c.busy);
  assertEquals([c.elicitations.size, c.permissions.size], [0, 0]);
  const reasons = events(c, 'request_withdrawn').map((e) => e.data as Json);
  assertEquals(new Set(reasons.map((r) => r.kind)), new Set(['elicitation', 'permission']));
  for (const r of reasons) {
    const error = assertThrows(
      () => r.kind === 'elicitation' ? c.answerElicitation(r.key, 'cancel') : c.permission(r.key, 'yes'),
      ValueError,
    );
    assert(error.message.includes('withdrawn: The turn that asked for this has ended'), error.message);
  }
});

Deno.test('an agent $/cancel_request withdraws the permission', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('agent-cancel');
  await until(() => !c.busy);
  assertEquals(c.permissions.size, 0);
  const withdrawn = events(c, 'request_withdrawn')[0].data as Json;
  const error = assertThrows(() => c.permission(withdrawn.key, 'yes'), ValueError);
  assert(error.message.includes('agent cancelled'));
});

Deno.test('interrupt withdraws pending requests and blocks stale answers', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('form');
  await until(() => c.elicitations.size);
  const key = c.elicitations.keys().next().value!;
  c.cancel();
  assertEquals(c.elicitations.size, 0);
  const error = assertThrows(() => c.answerElicitation(key, 'accept', { name: 'x', plan: 'pro' }), ValueError);
  assert(error.message.includes('withdrawn: The turn was cancelled'));
});

Deno.test('close withdraws pending requests', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('child-ask');
  await until(() => c.permissions.size);
  await c.close();
  assertEquals([c.permissions.size, c.elicitations.size], [0, 0]);
});

Deno.test('declining on a ready connection does not abort setup', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('form');
  await until(() => c.elicitations.size);
  c.answerElicitation(c.elicitations.keys().next().value!, 'decline');
  await until(() => !c.busy);
  assertEquals(c.setupAbort, '');
  assert(!c.closed);
});

Deno.test('requests are routed by session', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('child-ask');
  await until(() => c.permissions.size);
  const item = (c.public().permissions as Json[])[0];
  assertEquals([(item.params as Json).sessionId, item.route], ['child-session', 'subagent']);
  assertEquals([c.route(c.sessionId), c.route('never-seen'), c.route(null)], ['main', 'unknown', 'setup']);
  c.permission(item.key, 'yes');
  await until(() => !c.busy);
});

Deno.test('auth required: methods offered, in-app authenticate retries setup', async () => {
  await using lab = new Lab();
  const [c, outcome] = lab.start(['--auth-required'], 'claude');
  await until(() => c.auth !== null);
  const pub = c.public();
  assertEquals(pub.state, 'input_needed');
  const methods = Object.fromEntries(((pub.auth as Json).methods as Json[]).map((m) => [m.id, m]));
  assertEquals([(methods['fixture-login'] as Json).kind, (methods['fixture-terminal'] as Json).kind], ['agent', 'terminal']);
  assert(((methods['fixture-terminal'] as Json).instructions as string).includes('`fixture-cli login`'));
  assert(assertThrows(() => c.answerAuth('authenticate', 'fixture-terminal'), ValueError).message.includes('outside Studio'));
  assert(assertThrows(() => c.answerAuth('authenticate', 'nope'), ValueError).message.includes('Unknown'));
  c.answerAuth('authenticate', 'fixture-login');
  await until(() => c.ready);
  assertEquals(c.auth, null);
  assertEquals(outcome.error, undefined);
  assert(assertThrows(() => c.answerAuth('retry'), ValueError).message.includes('No sign-in'));
});

Deno.test('a terminal method is never executed; retry after an external login', async () => {
  await using lab = new Lab();
  const marker = lab.path('logged-in');
  const [c, outcome] = lab.start(['--auth-required', '--auth-file', marker]);
  await until(() => c.auth !== null);
  c.answerAuth('retry'); // not signed in yet: setup asks again instead of failing
  await until(() => c.events.filter((e) => e.kind === 'auth_required').length === 2 && c.auth !== null);
  assert(!c.ready);
  Deno.writeTextFileSync(marker, 'x');
  c.answerAuth('retry');
  await until(() => c.ready);
  assertEquals(outcome.error, undefined);
});

Deno.test('an auth failure stays pending and cancel fails setup with a clear message', async () => {
  await using lab = new Lab();
  const [c, outcome] = lab.start(['--auth-required', '--auth-reject']);
  await until(() => c.auth !== null);
  c.answerAuth('authenticate', 'fixture-login');
  await until(() => c.auth !== null && c.auth.error.includes('rejected'));
  c.answerAuth('cancel');
  await until(() => outcome.done);
  assert(outcome.error!.message.includes('Sign-in was cancelled'));
  assertEquals(c.auth, null);
});

// ---- test_conformance.py ----------------------------------------------------------------------------------------------------

Deno.test('version 1 is negotiated; other versions are rejected', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  assertEquals([(c.initial as Json).protocolVersion, c.ready], [1, true]);
  for (const version of ['0', '2']) {
    const other = await lab.open(['--protocol-version', version], { setup: false });
    await rejectsWith(() => other.setup(), 'protocol version 1');
    assert(!other.ready);
  }
});

Deno.test('a wrong-typed initialize result fails setup cleanly', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--bad-initialize'], { setup: false });
  await rejectsWith(() => c.setup(), 'Malformed initialize response');
  assert(!c.ready);
  assert(!c.closed);
});

Deno.test('a session result without an id or with bad modes is rejected', async () => {
  await using lab = new Lab();
  for (const [flag, text] of [['no-id', 'sessionId'], ['bad-modes', 'currentModeId']]) {
    const c = await lab.open(['--bad-session', flag], { setup: false });
    await rejectsWith(() => c.setup(), new RegExp('Malformed session/new response.*' + text));
    assert(!c.ready);
    assertEquals(c.sessionId, null);
  }
});

function protocolMessages(c: Connection): string[] {
  return events(c, 'error').filter((e) => (e.data as Json).protocol).map((e) => (e.data as Json).message as string);
}

Deno.test('malformed traffic: the reader survives, bad updates are dropped, bad requests get errors', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--malformed']);
  await c.prompt('junk');
  await until(() => !c.busy && events(c, 'turn_end').length, 'end of junk turn');
  await until(
    () => events(c, 'update').filter((e) => JSON.stringify(e.data).includes('Fixture reply')).length === 2,
    'replies to bad requests',
  );
  assert(!c.closed);
  const problems = protocolMessages(c).join(' | ');
  for (
    const expected of [
      'non-JSON line',
      'must be an object',
      'jsonrpc',
      'exactly one of result or error',
      'method must be a non-empty string',
      'params.sessionId',
      'update.content',
      'update.toolCallId',
      'update.entries',
    ]
  ) assert(problems.includes(expected), expected);
  const texts = updateTexts(c);
  assert(texts.includes('valid after junk'));
  assert(!texts.includes('no session id'));
  assertEquals(
    events(c, 'update').filter((e) => ['tool_call', 'plan'].includes(((e.data as Json).update as Json).sessionUpdate as string)),
    [],
  );
  // unknown update kinds are tolerated and logged once; an unknown ContentBlock type is tolerated too
  assertEquals(events(c, 'update').filter((e) => ((e.data as Json).update as Json).sessionUpdate === 'future_kind_v9').length, 2);
  assertEquals(protocolMessages(c).filter((m) => m.includes('future_kind_v9')).length, 1);
  assert(events(c, 'update').some((e) => (((e.data as Json).update as Json).content as Json | undefined)?.type === 'future_block'));
  // malformed and unsupported agent requests get JSON-RPC errors
  assert(texts.includes('Fixture reply bad-perm: -32602'));
  assert(texts.includes('Fixture reply nope: -32601'));
  assertEquals(c.permissions.size, 0);
  // unknown and duplicate response ids are ignored
  assertEquals(events(c, 'turn_end').length, 1);
  assert(protocolMessages(c).filter((m) => m.includes('unknown request id') || m.includes('Duplicate response')).length >= 3);
  assert(!c.busy);
  await c.prompt('junk'); // still usable afterwards
  await until(() => events(c, 'turn_end').length === 2, 'second turn');
});

Deno.test('an invalid stopReason type fails the turn, not the connection', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--malformed']);
  await c.prompt('badstop');
  await until(() => !c.busy && events(c, 'error').length, 'prompt failure');
  assert(((events(c, 'error').at(-1)!.data as Json).message as string).includes('Malformed session/prompt response'));
  assertEquals(events(c, 'turn_end'), []);
  assert(!c.closed);
});

Deno.test('out-of-order responses resolve by id', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('wait');
  assert(c.busy);
  assertEquals(await c.request('session/set_mode', { sessionId: 'fake-session', modeId: 'code' }, 5), {});
  assert(c.busy);
  c.cancel();
  await until(() => !c.busy);
  assertEquals((events(c, 'turn_end').at(-1)!.data as Json).stopReason, 'cancelled');
});

Deno.test('an agent exit mid-turn ends the turn and releases waiters', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--malformed']);
  await c.prompt('die');
  await until(() => c.closed && !c.busy, 'closed connection');
  const kinds = events(c).map((e) => e.kind);
  assert(kinds.includes('error') && kinds.includes('disconnected') && !kinds.includes('turn_end'), kinds.join());
  assertEquals(c.permissions.size, 0);
  await assertRejects(() => c.prompt('after exit'), ValueError);
  c.cancel(); // must not raise on a dead agent
});

Deno.test('an agent exit with a pending permission clears it', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  await c.prompt('needs approval');
  await until(() => c.permissions.size);
  c.process!.kill('SIGKILL');
  await until(() => c.closed && !c.permissions.size, 'cleanup after exit');
});

Deno.test('cancel answers a pending permission with cancelled and the turn ends cancelled', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--cancel-aware']);
  await c.prompt('needs approval');
  await until(() => c.permissions.size);
  assertEquals((c.permissions.values().next().value!.params.toolCall as Json).toolCallId, 'fake-tool');
  c.cancel();
  assertEquals(c.permissions.size, 0);
  await until(() => !c.busy);
  const texts = updateTexts(c);
  assert(texts.includes('Fixture permission outcome: cancelled'));
  assert(!texts.includes('Fixture response'));
  assertEquals((events(c, 'turn_end').at(-1)!.data as Json).stopReason, 'cancelled');
});

Deno.test('cancel without a pending permission ends the turn cancelled', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--cancel-aware']);
  await c.prompt('wait');
  c.cancel();
  await until(() => !c.busy);
  assertEquals((events(c, 'turn_end').at(-1)!.data as Json).stopReason, 'cancelled');
});

Deno.test('cancel withdraws a session elicitation', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--cancel-aware']);
  await c.prompt('form');
  await until(() => c.elicitations.size);
  c.cancel();
  assertEquals(c.elicitations.size, 0);
  await until(() => !c.busy);
});

Deno.test('the cancel notification is sent after the permission answer', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  const sent: Json[] = [];
  const original = c.write.bind(c);
  c.write = (message) => (sent.push(message as Json), original(message));
  await c.prompt('needs approval');
  await until(() => c.permissions.size);
  sent.length = 0;
  c.cancel();
  assertEquals(sent[0].result, { outcome: { outcome: 'cancelled' } });
  assertEquals([sent[1].method, sent[1].params], ['session/cancel', { sessionId: 'fake-session' }]);
  await until(() => !c.busy);
});

// ---- test_robustness.py -----------------------------------------------------------------------------------------------------

Deno.test('a handler exception closes the connection with a message and kills the process', async () => {
  await using lab = new Lab();
  const c = await lab.open();
  c.ownArtifactTool = () => {
    const error = new Error("'boom'");
    error.name = 'KeyError';
    throw error;
  };
  await c.prompt('fixture prompt'); // the fake agent asks for permission, which runs the broken handler
  await until(() => c.closed);
  assert(c.error.includes('internal error') && c.error.includes('KeyError'), c.error);
  assert(c.traceback.includes('KeyError'));
  await until(() => c.poll() !== null);
  const gone = events(c, 'disconnected');
  assertEquals(gone.length, 1);
  assert(((gone[0].data as Json).message as string).includes('internal error'));
});

async function pidAlive(pid: number): Promise<boolean> {
  if (Deno.build.os === 'windows') {
    const out = await new Deno.Command('tasklist', { args: ['/FI', `PID eq ${pid}`, '/NH'], stdout: 'piped', stderr: 'null' }).output();
    return new TextDecoder().decode(out.stdout).includes(String(pid));
  }
  try {
    Deno.kill(pid, 'SIGCONT');
    return true;
  } catch {
    return false;
  }
}

async function childPid(file: string): Promise<number> {
  await until(() => {
    try {
      return Deno.readTextFileSync(file).trim() !== '';
    } catch {
      return false;
    }
  }, 'child pid file');
  return Number(Deno.readTextFileSync(file));
}

Deno.test('close removes the agent children', async () => {
  await using lab = new Lab();
  const pidFile = lab.path('child.pid');
  const c = await lab.open(['--child-pid-file', pidFile]);
  const child = await childPid(pidFile);
  assert(await pidAlive(child));
  await c.close();
  await until(async () => !(await pidAlive(child)), 'child process gone after close()');
  assert(c.poll() !== null);
});

Deno.test('close removes children even after the adapter already exited', async () => {
  await using lab = new Lab();
  const pidFile = lab.path('child.pid');
  const c = await lab.open(['--child-pid-file', pidFile]);
  const child = await childPid(pidFile);
  c.process!.kill('SIGKILL'); // the adapter dies, its child is orphaned: only the job object (Windows) or the group still reaches it
  await c.process!.status;
  assert(await pidAlive(child), 'the orphan should still be running before close()');
  await c.close();
  await until(async () => !(await pidAlive(child)), 'orphaned child gone after close()');
});

// ---- pieces with no Python test of their own ---------------------------------------------------------------------------------

Deno.test('PyTextLines: universal newlines, split chunks, invalid UTF-8, BOM kept', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const lines = new PyTextLines();
  const out: string[] = [];
  out.push(...lines.feed(enc('{"a":1}\r')));
  out.push(...lines.feed(enc('\n{"b"')));
  out.push(...lines.feed(enc(':2}\rthree\n')));
  out.push(...lines.feed(new Uint8Array([0xe2, 0x82])));
  out.push(...lines.feed(new Uint8Array([0xac, 0x0a, 0xff, 0x41, 0x0a, 0xef, 0xbb, 0xbf, 0x42, 0x0a, 0xe2])));
  out.push(...lines.feed(null, true));
  assertEquals(out, ['{"a":1}', '{"b":2}', 'three', '€', '�A', '﻿B', '�']);
  const cr = new PyTextLines();
  assertEquals([...cr.feed(enc('x\r')), ...cr.feed(null, true)], ['x']);
});

Deno.test('the test guard refuses a real agent', () => {
  const error = assertThrows(() => new Connection(['definitely-not-a-fixture'], Deno.cwd(), 'omp'));
  assert(error.message.startsWith('Test guard: refusing to start a real agent process'), error.message);
});

Deno.test('a connection started later can be retargeted, and not after it started', async () => {
  await using lab = new Lab();
  const c = lab.connection([PYTHON, FAKE], { start: false });
  const other = Deno.makeTempDirSync({ prefix: 'aib-conn-retarget-' });
  try {
    c.retarget(other);
    assertEquals([c.cwd, c.caps.workspace, c.writes.cwd], [other, other, other]);
    c.startProcess();
    await c.setup();
    assertThrows(() => c.retarget(lab.dir));
    await c.close();
  } finally {
    Deno.removeSync(other, { recursive: true });
  }
});

Deno.test('own studio_artifact permission requests are approved without asking', async () => {
  await using lab = new Lab();
  const c = await lab.open(['--breadth'], { setup: false });
  const { artifactToolCommand } = await import('../../outputs/agent-studio/server/artifacts/mcp.ts');
  c.mcpServers = [{ name: 'studio_artifact', ...artifactToolCommand(), env: [] }];
  const call = (name: string) => ({ toolCall: { toolCallId: 't', _meta: { claudeCode: { toolName: name } } } });
  assert(c.ownArtifactTool(call('mcp__studio_artifact__publish')));
  assert(c.ownArtifactTool(call('mcp__studio_artifact__publish\n')), "Python's re.match $ allows one trailing newline");
  assert(!c.ownArtifactTool(call('mcp__studio_artifact__delete')));
  assert(!c.ownArtifactTool({ toolCall: 'x' }));
  c.mcpServers = [];
  assert(!c.ownArtifactTool(call('mcp__studio_artifact__publish')));
});
