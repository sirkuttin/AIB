/** server/acp/breadth.ts: the pure cases of work/test_breadth.py, test_pending_settings.py and test_adapters.py, plus parity with Python. */
import { assert, assertEquals, assertRejects, assertThrows } from './_assert.ts';
import { PY_REF_DIR, PyParity, python } from './_parity.ts';
import {
  applyUpdate,
  augmentInitialize,
  type BreadthState,
  buildConfigRequest,
  checkMode,
  cleanCommands,
  currentValue,
  loadMcpConfig,
  MAX_COMPACTIONS,
  MAX_NOTICES,
  newState,
  optionValues,
  publicState,
  selectMcpServers,
  sessionCapabilities,
  sessionOp,
  type SessionOpConnection,
  validateMcpServers,
} from '../../outputs/agent-studio/server/acp/breadth.ts';
import { ValueError } from '../../outputs/agent-studio/server/core/py.ts';

type Dict = Record<string, unknown>;

/** {ok} or {error, message} like PyParity.raw, for the port. */
function outcome(fn: () => unknown): unknown {
  try {
    return { ok: JSON.parse(JSON.stringify(fn() ?? null)) };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { error: error instanceof ValueError ? 'ValueError' : error.name, message: error.message };
  }
}

/** Runs a Python snippet with the server folder importable; `data` arrives as DATA, the snippet sets OUT. */
async function pyRun(code: string, data: unknown): Promise<unknown> {
  const script = `import json, sys\nsys.path.insert(0, ${JSON.stringify(PY_REF_DIR)})\n` +
    `DATA = json.loads(sys.stdin.read())\n${code}\nsys.stdout.write(json.dumps(OUT))\n`;
  const child = new Deno.Command(python(), { args: ['-X', 'utf8', '-c', script], stdin: 'piped', stdout: 'piped', stderr: 'inherit' })
    .spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(data)));
  await writer.close();
  const { code: status, stdout } = await child.output();
  assertEquals(status, 0, 'python snippet failed');
  return JSON.parse(new TextDecoder().decode(stdout));
}

const plainState = (state: BreadthState) => ({ ...state, compaction: Object.fromEntries(state.compaction) });

// Same as work/fake_acp.py's config_options.
const SETTINGS = {
  modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }] },
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'fast',
      options: [
        { group: 'g1', name: 'Small', options: [{ value: 'fast', name: 'Fast' }] },
        { group: 'g2', name: 'Large', options: [{ value: 'deep', name: 'Deep', description: 'Slow' }] },
      ],
    },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }],
    },
    { id: 'verbose', name: 'Verbose', type: 'boolean', currentValue: false },
    { id: 'dial', name: 'Dial', type: 'slider', currentValue: 7 },
  ],
};

const BREADTH_INITIAL = {
  agentCapabilities: {
    loadSession: true,
    sessionCapabilities: { list: {}, close: {}, delete: {}, resume: {} },
    mcpCapabilities: { http: false },
  },
};

Deno.test('unit update rules (test_unit_update_rules)', () => {
  const state = newState();
  applyUpdate(state, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: '/ok', description: 'd' }, { name: 'has space' }, { description: 'no name' }, 'junk', {
      name: 'x',
      input: { hint: '' },
    }],
  });
  assertEquals(state.commands.map((c) => c.name), ['ok', 'x']);
  applyUpdate(state, { sessionUpdate: 'session_info_update', title: 'T', updatedAt: 'U' });
  applyUpdate(state, { sessionUpdate: 'session_info_update', title: null });
  assertEquals(state.sessionInfo, { updatedAt: 'U' });
  applyUpdate(state, { sessionUpdate: 'usage_update', size: true, used: -1 });
  assertEquals(state.usage, null);
  applyUpdate(state, { sessionUpdate: 'compaction_update', compactionId: 'a', status: 'weird' });
  assertEquals(state.compaction.get('a')!.status, 'other');
  assertEquals(applyUpdate(state, { sessionUpdate: 'agent_message_chunk' }), false);
});

Deno.test('usage_update names the model; synthetic or malformed values never replace it', () => {
  const state = newState();
  applyUpdate(state, { sessionUpdate: 'usage_update', size: 100, used: 5, _meta: { '_claude/model': 'claude-opus-5-5' } });
  assertEquals(state.responseModel, 'claude-opus-5-5');
  applyUpdate(state, { sessionUpdate: 'usage_update', size: 100, used: 6, _meta: { '_claude/model': '<synthetic>' } });
  applyUpdate(state, { sessionUpdate: 'usage_update', size: 100, used: 7, _meta: { '_claude/model': 5 } });
  assertEquals(state.responseModel, 'claude-opus-5-5');
});

Deno.test('client advertises session capabilities', () => {
  const params = augmentInitialize({ protocolVersion: 1, clientCapabilities: { terminal: false } });
  const caps = params.clientCapabilities as Dict;
  const session = caps.session as Dict;
  assertEquals(session.configOptions, { boolean: {} });
  assert('notices' in session && 'compaction' in session);
  assertEquals(caps.terminal, false);
});

Deno.test('config validation against reported options (test_config_validation, test_adapters)', () => {
  assertEquals(buildConfigRequest(SETTINGS, 'verbose', true), { configId: 'verbose', type: 'boolean', value: true });
  assertEquals(buildConfigRequest(SETTINGS, 'model', 'deep'), { configId: 'model', type: 'id', value: 'deep' });
  for (const [id, value] of [['verbose', 'yes'], ['model', 'nope'], ['effort', true], ['dial', 8], ['missing', 'x']]) {
    assertThrows(() => buildConfigRequest(SETTINGS, id, value), ValueError);
  }
  assertEquals(currentValue(SETTINGS, 'config', 'model'), 'fast');
  assertEquals(currentValue(SETTINGS, 'mode'), 'code');
  assertEquals(optionValues(SETTINGS.configOptions[0]), ['fast', 'deep']);
  assertEquals(checkMode(SETTINGS, 'code'), 'code');
  assertThrows(() => checkMode(SETTINGS, 'plan'), ValueError);
});

Deno.test('MCP config validation (test_validation)', () => {
  assertEquals(validateMcpServers({ mcpServers: [] }), []);
  assertEquals(validateMcpServers([{ name: 'a', command: 'c' }]), [{ name: 'a', command: 'c', args: [], env: [] }]);
  const bad = [
    'x',
    { servers: [] },
    [{ name: 'a' }],
    [{ name: 'a', command: 'c', env: { K: 'v' } }],
    [{ name: 'a', command: 'c' }, { name: 'a', command: 'd' }],
    [{ type: 'http', name: 'a', url: 'ftp://x' }],
    [{ type: 'websocket', name: 'a' }],
    [{ name: 'a', command: 'c', url: 'u' }],
    [{ name: '', command: 'c' }],
  ];
  for (const data of bad) assertThrows(() => validateMcpServers(data), ValueError);
});

const SERVERS = [
  { name: 'local', command: 'tool', args: ['--x'], env: [{ name: 'K', value: 'v' }] },
  { type: 'http', name: 'remote', url: 'https://example.test/mcp', headers: [{ name: 'A', value: 'b' }] },
];

Deno.test('http MCP servers are skipped unless advertised', () => {
  const servers = validateMcpServers(SERVERS);
  const [usable, skipped] = selectMcpServers(servers, BREADTH_INITIAL);
  assertEquals([usable.map((s) => s.name), skipped], [['local'], ['remote']]);
  const http = { agentCapabilities: { mcpCapabilities: { http: true } } };
  assertEquals(selectMcpServers(servers, http)[0].map((s) => s.name), ['local', 'remote']);
});

Deno.test('loadMcpConfig reads a good file and refuses bad JSON, big or missing files', () => {
  const dir = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(`${dir}/good.json`, JSON.stringify({ mcpServers: [{ name: 'a', command: 'c' }] }));
    assertEquals(loadMcpConfig(`${dir}/good.json`), [{ name: 'a', command: 'c', args: [], env: [] }]);
    Deno.writeTextFileSync(`${dir}/bad.json`, '{nope');
    assert(assertThrows(() => loadMcpConfig(`${dir}/bad.json`), ValueError).message.startsWith('MCP config is not valid JSON: '));
    assert(assertThrows(() => loadMcpConfig(`${dir}/missing.json`), ValueError).message.startsWith('Cannot read MCP config: '));
    Deno.writeTextFileSync(`${dir}/big.json`, ' '.repeat(1_000_001));
    assertEquals(assertThrows(() => loadMcpConfig(`${dir}/big.json`), ValueError).message, 'MCP config file is larger than 1 MB');
    Deno.writeFileSync(`${dir}/bin.json`, new Uint8Array([0xff, 0xfe]));
    assertThrows(() => loadMcpConfig(`${dir}/bin.json`), ValueError);
  } finally {
    Deno.removeSync(dir, { recursive: true });
  }
});

class FakeConnection implements SessionOpConnection {
  initial: unknown = BREADTH_INITIAL;
  closed = false;
  ready = true;
  sessionId: string | null = 'fake-session';
  busy = false;
  calls: [string, Dict, number][] = [];
  events: [string, Dict][] = [];
  constructor(public reply: unknown = null) {}
  request(method: string, params: Dict, timeout: number): Promise<unknown> {
    this.calls.push([method, params, timeout]);
    return Promise.resolve(this.reply);
  }
  event(kind: string, data: Dict) {
    this.events.push([kind, data]);
  }
  close() {
    this.closed = true;
  }
}

const LISTED = {
  sessions: [{ sessionId: 'fake-session', cwd: 'C:\\work', title: 'First <b>', updatedAt: '2026-01-01T00:00:00Z' }, {
    sessionId: 'other',
    cwd: 'C:\\work',
    title: null,
  }],
  nextCursor: 'page2',
};

Deno.test('session operations: list, confirmation, busy, close (test_http_config_and_session_op_routes)', async () => {
  const c = new FakeConnection(LISTED);
  const listed = await sessionOp(c, { op: 'list', cursor: 'page2' });
  assertEquals(listed, {
    sessions: [{ sessionId: 'fake-session', cwd: 'C:\\work', title: 'First <b>', updatedAt: '2026-01-01T00:00:00Z' }, {
      sessionId: 'other',
      cwd: 'C:\\work',
      title: '',
      updatedAt: '',
    }],
    nextCursor: 'page2',
  });
  assertEquals(c.calls[0], ['session/list', { cursor: 'page2' }, 30]);
  for (
    const body of [{ op: 'delete' }, { op: 'delete', confirm: 'delete:other' }, { op: 'close', confirm: 'delete:fake-session' }, {
      op: 'fork',
    }]
  ) {
    await assertRejects(() => sessionOp(c, body), ValueError);
  }
  await assertRejects(() => sessionOp(c, { op: 'list', cursor: 5 }), ValueError);
  await assertRejects(() => sessionOp(c, { op: 'list', cwd: 'x'.repeat(1001) }), ValueError);
  assert(!c.closed);
  c.busy = true;
  await assertRejects(() => sessionOp(c, { op: 'delete', confirm: 'delete:fake-session' }), ValueError);
  c.busy = false;
  assertEquals(await sessionOp(c, { op: 'delete', confirm: 'delete:fake-session' }), { done: 'delete' });
  assert(c.closed);
  assertEquals(c.events, [['session_op', { op: 'delete', sessionId: 'fake-session' }]]);
  await assertRejects(() => sessionOp(c, { op: 'list' }), ValueError); // closed now
  const plain = new FakeConnection();
  plain.initial = {};
  await assertRejects(() => sessionOp(plain, { op: 'list' }), ValueError);
});

// ---- parity with Python -----------------------------------------------------------------------

const WEIRD = [
  '',
  ' ',
  'ok',
  ' /ok ',
  '//x',
  '/',
  'a\x1cb',
  '\ufeffname',
  'n\x85',
  '😀'.repeat(150),
  'tab\there',
  '\u3000x\u3000',
  'é',
  'x'.repeat(120),
];

const SCENARIOS: unknown[][] = [
  [
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        ...WEIRD.map((name) => ({ name, description: name, input: { hint: name } })),
        { name: 5 },
        null,
        { name: 'plan', description: 7, input: 'x' },
        { name: 'h', input: { hint: ' \x1c ' } },
        { name: 'h2', input: { hint: '\ufeff' } },
      ],
    },
    { sessionUpdate: 'available_commands_update', availableCommands: 'nope' },
    { sessionUpdate: 'available_commands_update', availableCommands: Array.from({ length: 510 }, (_, i) => ({ name: `c${i}` })) },
  ],
  [
    { sessionUpdate: 'usage_update', size: 200000, used: 12345, cost: { amount: 0.25, currency: 'USD' } },
    { sessionUpdate: 'usage_update', size: 1.5, used: 0, cost: { amount: true, currency: 'USD' } },
    { sessionUpdate: 'usage_update', cost: { amount: 3, currency: '' } },
    { sessionUpdate: 'usage_update', cost: { amount: 3, currency: '😀'.repeat(16) } },
    { sessionUpdate: 'usage_update', cost: { amount: 3, currency: '😀'.repeat(17) } },
    { sessionUpdate: 'usage_update', size: -1, _meta: { '_claude/model': ' claude-x ' } },
    { sessionUpdate: 'usage_update', _meta: { '_claude/model': 'bad\u200bmodel' } },
    { sessionUpdate: 'usage_update', _meta: { '_claude/model': 'with space' } },
    { sessionUpdate: 'usage_update', _meta: { '_claude/model': 'nbsp\xa0model' } },
    { sessionUpdate: 'usage_update', _meta: { '_claude/model': '   ' } },
    { sessionUpdate: 'usage_update', _meta: { '_claude/model': 'm'.repeat(300) } },
    { sessionUpdate: 'usage_update', _meta: 'x' },
  ],
  [
    { sessionUpdate: 'session_info_update', title: 'T'.repeat(400), updatedAt: '2026' },
    { sessionUpdate: 'session_info_update', title: 5 },
    { sessionUpdate: 'session_info_update', updatedAt: '😀'.repeat(70) },
    { sessionUpdate: 'session_info_update' },
  ],
  [
    ...Array.from(
      { length: 25 },
      (_, i) => ({ sessionUpdate: 'notice', title: `n${i}`, description: i % 2 ? 'd' : null, severity: i % 3 ? 'warning' : 5 }),
    ),
    { sessionUpdate: 'notice', title: '  ' },
    { sessionUpdate: 'notice', title: '\x1c' },
    { sessionUpdate: 'notice', title: 't'.repeat(300), description: 'd'.repeat(1200), severity: 's'.repeat(50) },
  ],
  [
    { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'in_progress' },
    { sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'Summary text' } },
    {
      sessionUpdate: 'compaction_summary_chunk',
      compactionId: 'c1',
      content: [{ type: 'text', text: ' more' }, { type: 'image' }, 'x', { type: 'text', text: 5 }],
    },
    { sessionUpdate: 'compaction_update', compactionId: 'c1', status: 'completed', error: null },
    {
      sessionUpdate: 'compaction_update',
      compactionId: 'c2',
      status: ['x'],
      error: 'e'.repeat(1100),
      summary: [{ type: 'text', text: 'S' }],
    },
    { sessionUpdate: 'compaction_update', compactionId: '', status: 'failed' },
    { sessionUpdate: 'compaction_update', status: 'failed' },
    { sessionUpdate: 'compaction_summary_chunk', compactionId: 'big', content: { type: 'text', text: '😀'.repeat(15000) } },
    { sessionUpdate: 'compaction_summary_chunk', compactionId: 'big', content: { type: 'text', text: '😀'.repeat(15000) } },
    ...Array.from({ length: 55 }, (_, i) => ({ sessionUpdate: 'compaction_update', compactionId: String(55 - i) })),
  ],
  [null, 'x', 5, {}, { sessionUpdate: 'agent_message_chunk' }, { sessionUpdate: null }],
];

const INITIALS: unknown[] = [
  null,
  {},
  BREADTH_INITIAL,
  {
    agentCapabilities: {
      sessionCapabilities: { list: {}, close: true, delete: null, fork: {} },
      loadSession: 1,
      mcpCapabilities: { http: true, sse: true },
    },
  },
  { agentCapabilities: { sessionCapabilities: [], mcpCapabilities: 'x' } },
  { agentCapabilities: 'x' },
];

Deno.test('applyUpdate and publicState match Python over update sequences', async () => {
  const expected = await pyRun(
    `import types, breadth
OUT = []
for updates in DATA['scenarios']:
    state = breadth.new_state()
    handled = [breadth.apply_update(state, u, 1.5) for u in updates]
    publics = [breadth.public_state(types.SimpleNamespace(breadth=state, initial=i, mcp_servers=[1, 2])) for i in DATA['initials']]
    OUT.append({'handled': handled, 'state': state, 'publics': publics})`,
    { scenarios: SCENARIOS, initials: INITIALS },
  ) as unknown[];
  SCENARIOS.forEach((updates, index) => {
    const state = newState();
    const handled = updates.map((u) => applyUpdate(state, u, 1.5));
    const publics = INITIALS.map((initial) => publicState({ breadth: state, initial, mcpServers: [1, 2] }));
    assertEquals(JSON.parse(JSON.stringify({ handled, state: plainState(state), publics })), expected[index], `scenario ${index}`);
  });
  assertEquals(MAX_NOTICES, 20);
  assertEquals(MAX_COMPACTIONS, 50);
});

Deno.test('cleanCommands, sessionCapabilities and augmentInitialize match Python', async () => {
  await using py = new PyParity();
  await py.same(
    'breadth',
    'clean_commands',
    [[SCENARIOS[0][0] && (SCENARIOS[0][0] as Dict).availableCommands], [null], [{}]],
    cleanCommands,
  );
  await py.same('breadth', 'session_capabilities', INITIALS.map((i) => [i]), sessionCapabilities);
  await py.same('breadth', 'augment_initialize', [
    [{ protocolVersion: 1 }],
    [{ protocolVersion: 1, clientCapabilities: null }],
    [{ clientCapabilities: { terminal: true, session: { custom: 1 } } }],
    [{ clientCapabilities: { session: null } }],
  ], augmentInitialize);
});

Deno.test('config helpers match Python, errors included', async () => {
  await using py = new PyParity();
  const settingsList: unknown[] = [
    SETTINGS,
    null,
    { configOptions: null },
    {
      configOptions: [{ id: 1, type: 'boolean' }, { id: 'n', type: 'select', options: 'abc' }, {
        id: 'g',
        type: 'select',
        options: [{ options: [{}, 'x'] }],
      }],
    },
    { configOptions: 'xyz' },
    { configOptions: [{ id: 'z', type: 'select', options: 5 }] },
    { modes: { availableModes: [] } },
    { modes: { availableModes: [{ id: 'a' }, 'b'], currentModeId: 7 } },
  ];
  const requests: [unknown, unknown][] = [
    ['verbose', true],
    ['verbose', 1],
    ['model', 'fast'],
    ['model', 'deep'],
    ['model', null],
    ['effort', 'high'],
    ['dial', 1],
    [1, true],
    [true, true],
    ['n', 'a'],
    ['g', null],
    ['z', 'x'],
    [null, 'x'],
  ];
  for (const settings of settingsList) {
    for (const [id, value] of requests) {
      assertEquals(
        outcome(() => buildConfigRequest(settings, id, value)),
        await py.raw('breadth', 'build_config_request', [settings, id, value]),
        JSON.stringify([settings, id, value]).slice(0, 120),
      );
      assertEquals(outcome(() => currentValue(settings, 'config', id)), await py.raw('breadth', 'current_value', [settings, 'config', id]));
    }
    assertEquals(outcome(() => currentValue(settings, 'mode')), await py.raw('breadth', 'current_value', [settings, 'mode']));
    for (const mode of ['code', 'a', 'b', '', 5, 'x'.repeat(201), '😀'.repeat(150)]) {
      assertEquals(outcome(() => checkMode(settings, mode)), await py.raw('breadth', 'check_mode', [settings, mode]));
    }
  }
  for (
    const option of [SETTINGS.configOptions[0], SETTINGS.configOptions[1], { options: null }, {
      options: [{ options: [{ value: 1 }, {}] }, 'x'],
    }]
  ) {
    assertEquals(outcome(() => optionValues(option)), await py.raw('breadth', '_option_values', [option]));
  }
});

Deno.test('validateMcpServers and selectMcpServers match Python, messages included', async () => {
  await using py = new PyParity();
  const cases: unknown[] = [
    SERVERS,
    { mcpServers: SERVERS },
    { mcpServers: [], extra: 1 },
    {},
    5,
    Array.from({ length: 51 }, (_, i) => ({ name: `s${i}`, command: 'c' })),
    [5],
    [{ name: '  ', command: 'c' }],
    [{ name: '\x1c', command: 'c' }],
    [{ name: '\ufeff', command: 'c' }],
    [{ name: '😀'.repeat(200), command: 'c' }],
    [{ name: '😀'.repeat(201), command: 'c' }],
    [{ name: 'a', command: ' ' }],
    [{ name: 'a', command: 'c', args: null }],
    [{ name: 'a', command: 'c', args: ['x', 1] }],
    [{ name: 'a', command: 'c', env: null }],
    [{ name: 'a', command: 'c', env: [{ name: '', value: 'v' }] }],
    [{ name: 'a', command: 'c', env: [{ name: 'k', value: 'v', x: 1 }] }],
    [{ name: 'a', command: 'c', env: 'x' }],
    [{ name: 'a', type: null }],
    [{ name: 'a', type: 5 }],
    [{ name: 'a', type: 1.5 }],
    [{ name: 'a', type: true }],
    [{ name: 'a', type: ['x', "it's"] }],
    [{ name: 'a', type: { k: 'v' } }],
    [{ name: 'a', type: 'sse', url: 'http://h', headers: null, command: 'x' }],
    ...[
      'http://h',
      'HTTPS://h/x',
      'https://',
      'http:/h',
      'http:h',
      '//h',
      'h',
      ' http://h',
      'ht\ttp://h',
      'http://h\n/x',
      'http://[::1]/x',
      'http://[::1/x',
      'http://::1]/x',
      'http://a?b',
      'http://#x',
      'http://user@h:80',
      'http://ｈ/x',
      'http://h\u2100x/',
      'http://h\uff03x',
      '1http://h',
      'web+http://h',
      5,
      null,
    ].map((url) => [{ name: 'r', type: 'http', url }]),
  ];
  for (const data of cases) {
    assertEquals(
      outcome(() => validateMcpServers(data)),
      await py.raw('breadth', 'validate_mcp_servers', [data]),
      JSON.stringify(data).slice(0, 100),
    );
  }
  const servers = validateMcpServers([...SERVERS, { type: 'sse', name: 's', url: 'http://x' }]);
  await py.same('breadth', 'select_mcp_servers', INITIALS.map((i) => [servers, i]), selectMcpServers);
});

Deno.test('sessionOp matches Python with the same fake connection', async () => {
  const replies: unknown[] = [
    LISTED,
    null,
    { sessions: null, nextCursor: 5 },
    { sessions: 'abc' },
    { sessions: [{ sessionId: 'x'.repeat(600), cwd: 5, title: 't'.repeat(400), updatedAt: 'u'.repeat(70) }, { sessionId: 5 }, 'x'] },
    { sessions: Array.from({ length: 205 }, (_, i) => ({ sessionId: `s${i}` })) },
  ];
  const bodies: Dict[] = [
    { op: 'list' },
    { op: 'list', cursor: 'c', cwd: 'C:\\w' },
    { op: 'list', cursor: null, cwd: null },
    { op: 'list', cursor: 'x'.repeat(2001) },
    { op: 'list', cwd: 5 },
    { op: 'close', confirm: 'close:fake-session' },
    { op: 'delete', confirm: 'delete:fake-session' },
    { op: 'delete', confirm: 'close:fake-session' },
    { op: 'fork' },
    { op: ['list'] },
  ];
  const flags: Partial<FakeConnection>[] = [{}, { busy: true }, { ready: false }, { closed: true }, { sessionId: '' }, { initial: {} }];
  const runs = replies.flatMap((reply) => bodies.flatMap((body) => flags.map((flag) => ({ reply, body, flag }))));
  const expected = await pyRun(
    `import breadth
class Fake:
    def __init__(self, reply, flag):
        self.initial = DATA['initial']; self.closed = False; self.ready = True; self.session_id = 'fake-session'; self.busy = False
        self.reply = reply; self.calls = []; self.events = []
        for k, v in flag.items():
            setattr(self, {'sessionId': 'session_id'}.get(k, k), v)
    def request(self, method, params, timeout):
        self.calls.append([method, params, timeout]); return self.reply
    def event(self, kind, data):
        self.events.append([kind, data])
    def close(self):
        self.closed = True
OUT = []
for run in DATA['runs']:
    c = Fake(run['reply'], run['flag'])
    try:
        result = {'ok': breadth.session_op(c, run['body'])}
    except Exception as error:
        result = {'error': type(error).__name__, 'message': str(error)}
    OUT.append([result, c.calls, c.events, c.closed])`,
    { initial: BREADTH_INITIAL, runs },
  ) as unknown[];
  for (const [index, { reply, body, flag }] of runs.entries()) {
    const c = Object.assign(new FakeConnection(reply), flag);
    let result: unknown;
    try {
      result = { ok: JSON.parse(JSON.stringify(await sessionOp(c, body))) };
    } catch (error) {
      result = { error: error instanceof ValueError ? 'ValueError' : (error as Error).name, message: (error as Error).message };
    }
    assertEquals([result, c.calls, c.events, c.closed], expected[index], JSON.stringify(runs[index]).slice(0, 160));
  }
});
