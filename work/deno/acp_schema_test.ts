/** server/acp/acp_schema.ts: the cases of work/test_conformance.py that cover acp_schema.py, plus parity with Python. */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  MAX_PROTOCOL_EVENTS,
  messageKind,
  type PendingRequest,
  ProtocolError,
  screen,
  type ScreenConnection,
  STOP_REASONS,
  validateInitializeResult,
  validateLoadSessionResult,
  validateNewSessionResult,
  validateNotification,
  validatePermissionRequest,
  validatePromptResult,
  validateRequest,
  validateResult,
  validateSessionUpdate,
} from '../../outputs/agent-studio/server/acp/acp_schema.ts';

type Json = Record<string, unknown>;

class Event {
  #set = false;
  isSet() {
    return this.#set;
  }
  set() {
    this.#set = true;
  }
}

/** Just enough of a connection for screen(), like test_conformance.py's StubConnection. */
class StubConnection implements ScreenConnection {
  pending = new Map<unknown, PendingRequest>();
  events: [string, Json][] = [];
  writes: Json[] = [];
  event(kind: string, data: Json) {
    this.events.push([kind, data]);
  }
  write(message: Json) {
    this.writes.push(message);
  }
  waiter(key: unknown, method: string): PendingRequest {
    const entry: PendingRequest = { done: new Event(), method };
    this.pending.set(key, entry);
    return entry;
  }
}

const line = (value: Json) => JSON.stringify({ jsonrpc: '2.0', ...value });

/** The TS twin of work/parity/acp_schema_shim.py's screen_session. */
function screenSession(steps: unknown[]) {
  const connection = new StubConnection();
  const results: unknown[] = [];
  for (const step of steps) {
    const s = step as Json;
    if (s && typeof s === 'object' && 'waiter' in s) connection.waiter(...(s.waiter as [unknown, string]));
    else if (s && typeof s === 'object' && 'finish' in s) {
      const waiting = connection.pending.get(s.finish)!;
      waiting.response = { result: {} };
      waiting.done.set();
    } else results.push(screen(connection, step) ?? null);
  }
  const waiters = [...connection.pending].map(([id, w]) => ({ id, done: w.done.isSet(), response: w.response ?? null }));
  return JSON.parse(JSON.stringify({ results, events: connection.events, writes: connection.writes, waiters }));
}

function outcome(fn: () => unknown) {
  try {
    return { ok: fn() ?? null };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error.name, message: error.message };
  }
}

function throwsProtocol(fn: () => unknown, message = '') {
  try {
    fn();
  } catch (error) {
    assert(error instanceof ProtocolError, `${message}: ${error}`);
    return;
  }
  throw new Error(`no ProtocolError: ${message}`);
}

const text = { type: 'text', text: 'hi' };
const validUpdates: Json[] = [
  { sessionUpdate: 'user_message_chunk', content: text },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AA==', mimeType: 'image/png' } },
  { sessionUpdate: 'agent_thought_chunk', content: { type: 'resource_link', name: 'n', uri: 'file:///x' } },
  {
    sessionUpdate: 'tool_call',
    toolCallId: 't',
    title: 'Run',
    kind: 'execute',
    status: 'pending',
    content: [{ type: 'content', content: text }],
  },
  { sessionUpdate: 'tool_call_update', toolCallId: 't', status: 'completed' },
  { sessionUpdate: 'plan', entries: [{ content: 'a', priority: 'high', status: 'pending' }] },
  { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'x', description: 'd' }] },
  { sessionUpdate: 'current_mode_update', currentModeId: 'code' },
  { sessionUpdate: 'config_option_update', configOptions: [] },
  { sessionUpdate: 'session_info_update', title: null },
  { sessionUpdate: 'usage_update', used: 1, size: 100 },
  { sessionUpdate: 'compaction_update', compactionId: 'c', status: 'in_progress' },
  { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c', content: text },
  { sessionUpdate: 'subagent_update', subagent: { sessionId: 'child' } },
];
const invalidUpdates: Json[] = [
  { sessionUpdate: 'agent_message_chunk' },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 3 } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'AA==' } },
  { sessionUpdate: 'tool_call', toolCallId: 't' },
  { sessionUpdate: 'tool_call_update', toolCallId: '' },
  { sessionUpdate: 'tool_call_update', toolCallId: 't', content: 'x' },
  { sessionUpdate: 'plan', entries: [{}] },
  { sessionUpdate: 'current_mode_update', currentModeId: 1 },
  { sessionUpdate: 'usage_update', used: true, size: 1 },
  { sessionUpdate: 3 },
  {},
];
const extraUpdates: Json[] = [
  { sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: 5 } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'resource', resource: {} } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'audio', data: 'x', mimeType: 7 } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'resource_link', name: 'n' } },
  { sessionUpdate: 'agent_message_chunk', content: { type: 'future_block' } },
  { sessionUpdate: 'agent_message_chunk', content: [] },
  { sessionUpdate: 'tool_call_update', toolCallId: 't', locations: {} },
  { sessionUpdate: 'tool_call_update', toolCallId: 't', locations: null, content: null },
  { sessionUpdate: 'tool_call', toolCallId: 't', title: 5 },
  { sessionUpdate: 'plan', entries: {} },
  { sessionUpdate: 'plan', entries: ['x'] },
  { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 1 }] },
  { sessionUpdate: 'available_commands_update' },
  { sessionUpdate: 'config_option_update' },
  { sessionUpdate: 'config_option_update', configOptions: [1] },
  { sessionUpdate: 'usage_update', used: 1.5, size: 'x' },
  { sessionUpdate: 'usage_update', size: 1 },
  { sessionUpdate: 'compaction_update' },
  { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c' },
  { sessionUpdate: 'constructor' },
  { sessionUpdate: 'toString', content: 5 },
  { sessionUpdate: '' },
  { sessionUpdate: 'notice', anything: [1] },
];

Deno.test('every known update kind accepts a valid example', () => {
  for (const body of validUpdates) assertEquals(validateSessionUpdate({ sessionId: 's', update: body }), body.sessionUpdate);
});

Deno.test('required fields and types are enforced', () => {
  for (const body of invalidUpdates) throwsProtocol(() => validateSessionUpdate({ sessionId: 's', update: body }), JSON.stringify(body));
  throwsProtocol(() => validateSessionUpdate({ update: { sessionUpdate: 'plan', entries: [] } }));
});

Deno.test('validateSessionUpdate matches Python', async () => {
  await using py = new PyParity();
  const params: unknown[] = [
    ...[...validUpdates, ...invalidUpdates, ...extraUpdates].map((update) => ({ sessionId: 's', update })),
    { update: { sessionUpdate: 'plan', entries: [] } },
    { sessionId: '', update: {} },
    { sessionId: 's', update: [] },
    { sessionId: 's' },
    null,
    [],
    'x',
  ];
  for (const p of params) {
    const expected = await py.raw('acp_schema', 'validate_session_update', [p]);
    assertEquals(outcome(() => validateSessionUpdate(p)), expected, JSON.stringify(p));
  }
});

const goodPermission = { sessionId: 's', toolCall: { toolCallId: 't' }, options: [{ optionId: 'a', name: 'A', kind: 'allow_once' }] };

Deno.test('permission request shape', () => {
  validatePermissionRequest(goodPermission);
  const mutations: ((p: Json & typeof goodPermission) => void)[] = [
    (p) => delete (p as Json).toolCall,
    (p) => ((p as Json).options = {}),
    (p) => delete (p.options[0] as Json).optionId,
    (p) => p.options.push({ ...p.options[0] }),
    (p) => (p.sessionId = ''),
  ];
  for (const mutate of mutations) {
    const bad = structuredClone(goodPermission);
    mutate(bad);
    throwsProtocol(() => validatePermissionRequest(bad), JSON.stringify(bad));
  }
});

const requests: [string, unknown][] = [
  ['session/request_permission', goodPermission],
  ['session/request_permission', { ...goodPermission, toolCall: { toolCallId: '' } }],
  ['session/request_permission', { ...goodPermission, options: [goodPermission.options[0], goodPermission.options[0]] }],
  ['session/request_permission', { ...goodPermission, options: [{ optionId: 'a', name: 'A' }] }],
  ['session/request_permission', { ...goodPermission, options: ['x'] }],
  ['session/request_permission', {}],
  ['elicitation/create', { message: 'm' }],
  ['elicitation/create', { message: 'm', mode: 5 }],
  ['elicitation/create', { mode: 'form' }],
  ['elicitation/create', []],
  ['fs/read_text_file', 'anything'],
];

const notifications: [string, unknown][] = [
  ['session/update', { sessionId: 's', update: { sessionUpdate: 'future_kind_v9' } }],
  ['elicitation/complete', { elicitationId: 'e' }],
  ['elicitation/complete', { elicitationId: 3 }],
  ['elicitation/complete', null],
  ['$/cancel_request', { requestId: 1 }],
  ['$/cancel_request', { requestId: 'a' }],
  ['$/cancel_request', { requestId: true }],
  ['$/cancel_request', { requestId: 1.5 }],
  ['$/cancel_request', {}],
  ['other', 5],
];

const results: [string, unknown][] = [
  ['initialize', { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'x', name: 'X' }] }],
  ['initialize', { protocolVersion: true }],
  ['initialize', { protocolVersion: '1' }],
  ['initialize', { protocolVersion: 1, agentCapabilities: null, authMethods: null }],
  ['initialize', { protocolVersion: 1, agentCapabilities: [] }],
  ['initialize', { protocolVersion: 1, agentCapabilities: { promptCapabilities: 3 } }],
  ['initialize', { protocolVersion: 1, agentCapabilities: { promptCapabilities: null } }],
  ['initialize', { protocolVersion: 1, authMethods: {} }],
  ['initialize', { protocolVersion: 1, authMethods: [{ id: 2 }] }],
  ['initialize', { protocolVersion: 1, authMethods: ['x'] }],
  ['session/new', { sessionId: 's', modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }] }, configOptions: null }],
  ['session/new', { sessionId: 5 }],
  ['session/new', { sessionId: 's', modes: {} }],
  ['session/new', { sessionId: 's', modes: { currentModeId: 'a' } }],
  ['session/new', { sessionId: 's', modes: { currentModeId: 'a', availableModes: [{}] } }],
  ['session/new', { sessionId: 's', modes: { currentModeId: 'a', availableModes: [5] } }],
  ['session/new', { sessionId: 's', configOptions: {} }],
  ['session/new', { sessionId: 's', configOptions: [{}, 'x'] }],
  ['session/load', {}],
  ['session/load', { modes: 3 }],
  ['session/load', null],
  ['session/prompt', { stopReason: 'end_turn' }],
  ['session/prompt', { stopReason: 'sleepy' }],
  ['session/prompt', { stopReason: "it's" }],
  ['session/prompt', { stopReason: 5 }],
  ['session/prompt', {}],
  ['session/set_mode', {}],
  ['session/set_mode', []],
  ['session/set_config_option', { configOptions: [] }],
  ['session/set_config_option', { configOptions: 'x' }],
  ['session/set_config_option', 'x'],
  ['unknown/method', 'x'],
];

Deno.test('request, notification and result validators match Python', async () => {
  await using py = new PyParity();
  for (const [method, params] of requests) {
    assertEquals(outcome(() => validateRequest(method, params)), await py.raw('acp_schema', 'validate_request', [method, params]), method);
  }
  for (const [method, params] of notifications) {
    assertEquals(
      outcome(() => validateNotification(method, params)),
      await py.raw('acp_schema', 'validate_notification', [method, params]),
      method,
    );
  }
  for (const [method, result] of results) {
    assertEquals(
      outcome(() => validateResult(method, result)),
      await py.raw('acp_schema', 'validate_result', [method, result]),
      JSON.stringify(result),
    );
  }
});

Deno.test('prompt and session results', () => {
  for (const reason of STOP_REASONS) assert(validatePromptResult({ stopReason: reason }));
  assertEquals(validatePromptResult({ stopReason: 'sleepy' }), false);
  throwsProtocol(() => validatePromptResult({}));
  validateNewSessionResult({
    sessionId: 's',
    modes: { currentModeId: 'a', availableModes: [{ id: 'a', name: 'A' }] },
    configOptions: null,
  });
  validateLoadSessionResult({});
  throwsProtocol(() => validateNewSessionResult({ sessionId: 5 }));
  validateInitializeResult({ protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [{ id: 'x', name: 'X' }] });
  throwsProtocol(() => validateInitializeResult({ protocolVersion: true }));
});

const envelopes: unknown[] = [
  { jsonrpc: '2.0', id: 1, method: 'm' },
  { jsonrpc: '2.0', method: 'm', params: {} },
  { jsonrpc: '2.0', id: 'a', result: null },
  { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } },
  [],
  { id: 1, result: {} },
  { jsonrpc: '2.0', id: 1 },
  { jsonrpc: '2.0', id: true, result: {} },
  { jsonrpc: '2.0', id: 1, method: 'm', params: [] },
  { jsonrpc: '2.0', id: 1, error: { code: 'x', message: 'y' } },
  { jsonrpc: '2.0', id: 1, error: { code: true, message: 'y' } },
  { jsonrpc: '2.0', id: 1, error: { code: 1 } },
  { jsonrpc: '2.0', id: 1, error: 'x' },
  { jsonrpc: '2.0', id: 1, result: 1, error: { code: 1, message: 'x' } },
  { jsonrpc: '2.0', id: null, method: 'm' },
  { jsonrpc: '2.0', id: null, result: {} },
  { jsonrpc: '2.0', id: 1.5, result: {} },
  { jsonrpc: '2.0', id: [1], result: {} },
  { jsonrpc: '2.0', method: '' },
  { jsonrpc: '2.0', method: 5 },
  { jsonrpc: '2.0', method: 'm', params: null },
  { jsonrpc: '1.0', method: 'm' },
  { jsonrpc: '2.0' },
  'x',
  null,
];

Deno.test('envelope classification matches Python', async () => {
  await using py = new PyParity();
  assertEquals(messageKind({ jsonrpc: '2.0', id: 1, method: 'm' }), 'request');
  assertEquals(messageKind({ jsonrpc: '2.0', method: 'm', params: {} }), 'notification');
  assertEquals(messageKind({ jsonrpc: '2.0', id: 'a', result: null }), 'response');
  for (const message of envelopes) {
    assertEquals(outcome(() => messageKind(message)), await py.raw('acp_schema', 'message_kind', [message]), JSON.stringify(message));
  }
});

Deno.test('protocol event log is capped', () => {
  const connection = new StubConnection();
  for (let i = 0; i < MAX_PROTOCOL_EVENTS + 40; i++) screen(connection, `garbage ${i}`);
  assertEquals(connection.events.length, MAX_PROTOCOL_EVENTS);
  assert((connection.events.at(-1)![1].message as string).includes('not logged'));
});

Deno.test('duplicate response for a completed waiter is dropped', () => {
  const connection = new StubConnection();
  const waiter = connection.waiter(7, 'session/prompt');
  const message = line({ id: 7, result: { stopReason: 'end_turn' } });
  assert(screen(connection, message) !== null);
  waiter.response = { result: {} };
  waiter.done.set();
  assertEquals(screen(connection, message), null);
  assert((connection.events.at(-1)![1].message as string).includes('Duplicate response'));
});

Deno.test('unknown stop reason string is tolerated with a warning', () => {
  const connection = new StubConnection();
  connection.waiter(1, 'session/prompt');
  assert(screen(connection, line({ id: 1, result: { stopReason: 'new_reason' } })) !== null);
  assert((connection.events.at(-1)![1].message as string).includes('Unknown stopReason'));
});

Deno.test('known adapter extensions raise no warning', () => {
  const connection = new StubConnection();
  for (const kind of ['subagent_update', 'session_message']) {
    screen(connection, line({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: kind } } }));
  }
  assertEquals(connection.events, []);
});

Deno.test('malformed response for a pending request fails the waiter', () => {
  const connection = new StubConnection();
  const waiter = connection.waiter(3, 'session/new');
  assertEquals(screen(connection, line({ id: 3, result: { sessionId: 9 } })), null);
  assert(waiter.done.isSet());
  assert(((waiter.response as Json).error as Json).message!.toString().includes('Malformed session/new response'));
  const waiter2 = connection.waiter(4, 'session/new');
  assertEquals(screen(connection, JSON.stringify({ jsonrpc: '2.0', id: 4, result: {}, error: { code: 1, message: 'x' } })), null);
  assert(waiter2.done.isSet());
});

Deno.test('elicitation request envelope gets an error reply', () => {
  const connection = new StubConnection();
  assertEquals(screen(connection, line({ id: 'e1', method: 'elicitation/create', params: { mode: 'form' } })), null);
  assertEquals([connection.writes.at(-1)!.id, (connection.writes.at(-1)!.error as Json).code], ['e1', -32602]);
  const wellFormed = line({
    id: 'e2',
    method: 'elicitation/create',
    params: { mode: 'url', message: 'm', url: 'https://x', elicitationId: 'i', requestId: 1 },
  });
  assert(screen(connection, wellFormed) !== null);
});

Deno.test('screen() matches Python: events, replies, waiters and results', async () => {
  await using py = new PyParity();
  const update = (body: Json, extra: Json = {}) => line({ method: 'session/update', params: { sessionId: 's1', update: body, ...extra } });
  const sessions: unknown[][] = [
    // junk lines and envelopes
    [
      '',
      '   ',
      '　',
      'not json',
      '  {"broken"  ',
      '[1, 2]',
      '"str"',
      '5',
      '1.5',
      'true',
      'null',
      '{}',
      '{"jsonrpc": "1.0", "method": "m"}',
      7,
      null,
    ],
    ['x'.repeat(300), '😀'.repeat(250), '  padded \u0085', ' ﻿junk'],
    [
      line({ method: 5 }),
      line({ method: [1, 'a'] }),
      line({ method: { a: "it's" } }),
      line({ method: true }),
      line({ method: '' }),
      line({ method: 1.5 }),
    ],
    // requests answered with JSON-RPC errors
    [
      line({ id: 'bad-perm', method: 'session/request_permission', params: { sessionId: 's1' } }),
      line({ id: 9, method: 'elicitation/create', params: {} }),
    ],
    [
      line({ id: 1, method: 'session/request_permission', params: goodPermission }),
      line({ method: 'elicitation/complete', params: { elicitationId: 1 } }),
    ],
    [line({ id: 1, method: 'm', params: [] }), line({ id: true, method: 'm' }), line({ id: null, method: 'm' })],
    // updates
    [
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }),
      update({ sessionUpdate: 'tool_call', toolCallId: 't' }),
    ],
    [update({ sessionUpdate: 'future_kind_v9' }), update({ sessionUpdate: 'future_kind_v9' }), update({ sessionUpdate: 'it\'s "new"' })],
    [update({ sessionUpdate: 'subagent_update' }), update({ sessionUpdate: 'session_message' }), update({ sessionUpdate: 'constructor' })],
    [line({ method: 'session/update', params: { update: { sessionUpdate: 'plan', entries: [] } } })],
    Array.from({ length: 30 }, (_, i) => update({ sessionUpdate: `kind_${i}` })),
    // responses
    [
      { waiter: [7, 'session/prompt'] },
      line({ id: 7, result: { stopReason: 'end_turn' } }),
      { finish: 7 },
      line({ id: 7, result: { stopReason: 'end_turn' } }),
    ],
    [{ waiter: [1, 'session/prompt'] }, line({ id: 1, result: { stopReason: 'new_reason' } })],
    [{ waiter: [3, 'session/new'] }, line({ id: 3, result: { sessionId: 9 } }), line({ id: 3, result: { sessionId: 's' } })],
    [{ waiter: [4, 'session/new'] }, JSON.stringify({ jsonrpc: '2.0', id: 4, result: {}, error: { code: 1, message: 'x' } })],
    [
      { waiter: ['N', 'initialize'] },
      line({ id: 'N', result: { protocolVersion: 'one' } }),
      line({ id: 98765, result: {} }),
      line({ id: 'N', result: {} }),
    ],
    [
      { waiter: [5, 'session/set_mode'] },
      line({ id: 5, error: { code: -32601, message: 'nope' } }),
      line({ id: 5, error: { code: 'x', message: 'y' } }),
    ],
    [{ waiter: [6, 'session/load'] }, line({ id: '6', result: {} }), line({ id: 6, result: { modes: { currentModeId: 3 } } })],
    [{ waiter: [8, 'session/set_config_option'] }, line({ id: 8, result: [] }), line({ id: null, result: {} })],
    [{ waiter: [2, 'session/prompt'] }, line({ id: 2, result: { stopReason: 7 } }), line({ id: 2, result: { stopReason: 'end_turn' } })],
  ];
  for (const steps of sessions) {
    const expected = await py.call('acp_schema_shim', 'screen_session', [steps]);
    assertEquals(screenSession(steps), expected, JSON.stringify(steps).slice(0, 120));
  }
});
