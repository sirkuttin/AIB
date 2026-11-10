/** server/web/security.ts against security.py: the gate's every branch, loopback names, route scopes, network paths. */
import { assert, assertEquals, assertThrows } from './_assert.ts';
import { PyParity } from './_parity.ts';
import {
  authorize,
  Gate,
  isNetworkPath,
  loopbackName,
  newToken,
  Principal,
  refuseNetworkPath,
  RouteTable,
  tokenMatches,
} from '../../outputs/agent-studio/server/web/security.ts';

const PORT = 47001, TOKEN = 'secret-token-123';
const page = { Host: `127.0.0.1:${PORT}`, Origin: `http://127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'same-origin', 'X-Studio-Token': TOKEN };
const without = (h: Record<string, string>, ...names: string[]) =>
  Object.fromEntries(Object.entries(h).filter(([k]) => !names.includes(k)));

const cases: [string, string, Record<string, string>, string | null][] = [
  ['GET', '/api/live/list', page, 'read'],
  ['GET', '/api/live/list', without(page, 'X-Studio-Token'), 'read'],
  ['GET', '/api/live/list', { ...page, 'X-Studio-Token': 'wrong' }, 'read'],
  ['GET', '/api/live/list', { ...page, 'X-Studio-Token': 'ünï' }, 'read'],
  ['GET', '/api/live/list', { ...page, Host: 'evil:1' }, 'read'],
  ['GET', '/api/live/list', { ...page, Host: `localhost:${PORT}`, Origin: `http://localhost:${PORT}` }, 'read'],
  ['GET', '/api/live/list', { ...page, Origin: 'http://evil.example' }, 'read'],
  ['GET', '/api/live/list', { ...page, 'Sec-Fetch-Site': 'same-site' }, 'read'],
  ['GET', '/api/live/list', { ...page, 'Sec-Fetch-Site': 'none' }, 'read'],
  ['GET', '/api/live/list', { ...page, 'Sec-Fetch-Mode': 'navigate' }, 'read'],
  ['GET', '/api/live/list', without(page, 'Sec-Fetch-Site', 'Origin'), 'read'],
  ['POST', '/api/live/settings', page, 'write'],
  ['POST', '/api/live/settings', without(page, 'Origin'), 'write'],
  ['POST', '/api/live/settings', without(page, 'Origin', 'Sec-Fetch-Site'), 'write'],
  ['GET', '/api/live/bootstrap', without(page, 'X-Studio-Token'), 'bootstrap'],
  ['GET', '/', { Host: `127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'none' }, 'static'],
  ['GET', '/chat.js', { Host: `127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'cross-site' }, 'static'],
  ['GET', '/chat.js', { Host: `evil:${PORT}` }, 'static'],
  ['GET', '/api/transcript/image', { Host: `127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Dest': 'image' }, 'image'],
  ['GET', '/api/transcript/image', { Host: `127.0.0.1:${PORT}`, 'Sec-Fetch-Site': 'same-origin' }, 'image'],
  ['GET', '/api/live/nope', page, null],
  ['POST', '/api/live/artifacts/publish', { Host: `127.0.0.1:${PORT}`, 'X-Studio-Artifact-Key': 'k' }, 'artifacts.tool'],
  [
    'POST',
    '/api/live/artifacts/publish',
    { Host: `127.0.0.1:${PORT}`, 'X-Studio-Artifact-Key': 'k', 'Sec-Fetch-Mode': 'cors' },
    'artifacts.tool',
  ],
  ['GET', '/api/live/list', { ...page, 'X-Studio-Artifact-Key': 'k' }, 'read'],
  ['GET', '/api/live/list', { ...page, Host: `127.0.0.1:${PORT + 1}`, Origin: `http://127.0.0.1:${PORT + 1}` }, 'read'],
  ['GET', '/api/live/shutdown', page, 'unknown-scope'],
];

Deno.test('authorize matches security.authorize on every branch', async () => {
  await using py = new PyParity();
  for (const [method, path, headers, scope] of cases) {
    for (const artifactPorts of [[], [PORT + 1]]) {
      const expected = await py.call('shims', 'authorize', [method, path, headers, scope, PORT, TOKEN, null, [], artifactPorts, null]);
      const gate = new Gate(PORT, () => TOKEN, null, [], artifactPorts);
      const result = authorize({ method, path, headers: new Headers(headers) }, gate, scope, null);
      const actual = result instanceof Principal
        ? { ok: result.kind }
        : { refused: result.reason, status: result.status, message: result.message(path) };
      assertEquals(actual, expected, `${method} ${path} ${JSON.stringify(headers)} ${artifactPorts}`);
    }
  }
});

Deno.test('a valid agent key is the tool principal for its conversation only', () => {
  const gate = new Gate(PORT, () => TOKEN);
  const req = {
    method: 'POST',
    path: '/api/live/artifacts/publish',
    headers: new Headers({ Host: `127.0.0.1:${PORT}`, 'X-Studio-Artifact-Key': 'good' }),
  };
  const check = (key: string, id: string) => key === 'good' && id === 'chat-1';
  const ok = authorize(req, gate, 'artifacts.tool', 'chat-1', check);
  assert(ok instanceof Principal && ok.kind === 'agent_tool' && ok.conversation === 'chat-1');
  assertEquals((authorize(req, gate, 'artifacts.tool', 'chat-2', check) as { reason: string }).reason, 'bad_key');
  assertEquals((authorize(req, gate, 'artifacts.tool', null, check) as { reason: string }).reason, 'bad_key');
  const throws = () => {
    throw new Error('no secret');
  };
  assertEquals((authorize(req, gate, 'artifacts.tool', 'chat-1', throws) as { reason: string }).reason, 'bad_key');
});

Deno.test('Gate hosts and origins match Python, including configured names and the artifact port', async () => {
  await using py = new PyParity();
  const variants: [string[] | null, string[], number[]][] = [
    [null, [], []],
    [['::1', 'example.com', '127.0.0.2', '[::1]'], [], []],
    [[], ['http://127.0.0.1:9000', 'https://127.0.0.1:9001', 'http://evil.com:1', 'http://localhost:9002/', 'http://localhost'], []],
    [[], [], [PORT + 1, PORT]],
  ];
  for (const [names, origins, artifactPorts] of variants) {
    const expected = await py.call('shims', 'gate_sets', [PORT, names, origins, artifactPorts]) as Record<string, string[]>;
    const gate = new Gate(PORT, () => 't', names, origins, artifactPorts);
    assertEquals(
      { names: gate.names, hosts: [...gate.hosts()].sort(), origins: [...gate.origins()].sort() },
      expected,
      JSON.stringify([names, origins]),
    );
  }
});

Deno.test('loopbackName matches ipaddress', async () => {
  await using py = new PyParity();
  const names = [
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.255.255.254',
    '127.0.0.256',
    '127.1',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::2',
    '::ffff:127.0.0.1',
    '10.0.0.1',
    '',
    'example.com',
    ' 127.0.0.1 ',
    '0::1',
    '1::',
  ];
  for (const name of names) assertEquals(loopbackName(name), await py.call('security', 'loopback_name', [name]), name);
});

Deno.test('RouteTable.scopeFor matches Python', async () => {
  await using py = new PyParity();
  const entries: [string, string, string][] = [['GET', '/api/a', 'read'], ['post', '/api/b', 'write'], ['GET', '/x.html', 'bootstrap']];
  const table = new RouteTable();
  for (const [m, p, s] of entries) table.add(m, p, s);
  for (
    const [method, path] of [['GET', '/api/a'], ['HEAD', '/api/a'], ['POST', '/api/b'], ['GET', '/api/nope'], ['GET', '/chat.js'], [
      'POST',
      '/chat.js',
    ], ['GET', '/x.html']]
  ) {
    assertEquals(table.scopeFor(method, path), await py.call('shims', 'scope_for', [entries, method, path]), `${method} ${path}`);
  }
});

Deno.test('tokens and network paths', async () => {
  await using py = new PyParity();
  for (const [a, b] of [['x', 'x'], ['x', 'y'], ['', ''], ['abc', 'abcd'], ['ü', 'ü'], ['a', '']]) {
    assertEquals(tokenMatches(a, b), await py.call('security', 'token_matches', [a, b]), `${a}|${b}`);
  }
  for (const p of ['\\\\server\\share', '//server/share', '\\\\?\\C:\\x', ' \\\\.\\pipe', 'C:\\x', '/home/x', '\\/x', '/\\x', '']) {
    assertEquals(isNetworkPath(p), await py.call('security', 'is_network_path', [p]), p);
  }
  assertThrows(() => refuseNetworkPath('\\\\srv\\x'));
  assertEquals(refuseNetworkPath('C:\\ok'), 'C:\\ok');
  assert(/^[A-Za-z0-9_-]{43}$/.test(newToken()));
});
