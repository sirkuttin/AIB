/** server/acp/rpc_errors.ts: the cases of work/test_runtime.py and test_studio.py that cover rpc_errors.py, plus parity with Python. */
import { assert, assertEquals } from './_assert.ts';
import { PyParity } from './_parity.ts';
import { describeAuthMethods, isAuthRequired, RpcError } from '../../outputs/agent-studio/server/acp/rpc_errors.ts';
import { clip, pyJsonDumps } from '../../outputs/agent-studio/server/core/py.ts';

const methods = [
  [{ id: 'login', name: 'Log in', description: 'Opens a browser' }],
  [{ id: 'term', type: 'terminal', command: 'claude', args: ['/login', 7, '--x'] }],
  [{ id: 'meta', _meta: { 'terminal-auth': { command: 'codex', args: ['login'] } } }],
  [{ id: 'bare-term', type: 'terminal' }],
  [{ id: 'env', type: 'env_var', vars: [{ name: 'OPENAI_API_KEY' }, { name: 3 }, 'x', { name: 'B'.repeat(100) }] }],
  [{ id: 'env-empty', type: 'env_var', vars: 'nope' }],
  [{ id: 'oauth', type: 'oauth2', name: '' }],
  [{ id: '' }, { id: 5 }, 'x', null, { id: 'x'.repeat(257) }, { id: 'ok', name: 'n'.repeat(600), description: '😀'.repeat(1200) }],
  [Array.from({ length: 25 }, (_, i) => ({ id: `m${i}` }))].flat(),
  [{ id: 'é', name: 'ünïcødé 😀', description: null, type: 'agent' }],
];

Deno.test('describeAuthMethods matches Python for every kind of method', async () => {
  await using py = new PyParity();
  for (const provider of ['', 'claude', 'codex']) {
    for (const list of methods) {
      assertEquals(
        describeAuthMethods(list, provider),
        await py.call('rpc_errors', 'describe_auth_methods', [list, provider]),
        JSON.stringify(list).slice(0, 80),
      );
    }
  }
  for (const odd of [null, 'x', 5, {}]) assertEquals(describeAuthMethods(odd), await py.call('rpc_errors', 'describe_auth_methods', [odd]));
});

Deno.test('isAuthRequired matches Python', async () => {
  await using py = new PyParity();
  const errors = [
    { code: -32000, message: 'Authentication required' },
    { code: -32000, message: 'Something else' },
    { code: -32000, message: 'x', data: { reason: 'please log in' } },
    { code: -32603, message: 'auth_required' },
    { code: -32603, message: 'internal', data: { kind: 'auth_required' } },
    { code: -32000, message: 'Sign-in needed' },
    { code: -32000, message: 'bad credentials' },
    { code: 1, message: 'ok' },
  ];
  for (const error of errors) {
    const expected = await py.call('rpc_errors', 'is_auth_required', [{ __new__: ['rpc_errors.RpcError', [error]] }]);
    assertEquals(isAuthRequired(new RpcError(error)), expected, JSON.stringify(error));
  }
  assertEquals(isAuthRequired(new Error('auth_required')), false);
});

Deno.test('RpcError keeps message, code and data', () => {
  const error = new RpcError({ code: -32602, message: 'Invalid params', data: { field: 'x' } });
  assertEquals([error.message, error.code, error.data], ['Invalid params', -32602, { field: 'x' }]);
  assertEquals(new RpcError('plain').message, 'plain');
  assert(new RpcError({ code: 5 }).message.includes('5'));
});

Deno.test('clip counts code points like Python slicing', () => {
  assertEquals(clip('😀😀😀', 2), '😀😀');
  assertEquals(clip('abc', 5), 'abc');
  assertEquals(clip('a😀b', 2), 'a😀');
});

Deno.test('pyJsonDumps matches json.dumps', async () => {
  await using py = new PyParity();
  for (const value of [{ a: 1, b: [1, 2, { c: 'd: e, f' }] }, [], {}, 'ü😀"\\', null, [{ 'k"': ['x', true, false, null] }], 1.5]) {
    assertEquals(pyJsonDumps(value), await py.call('json', 'dumps', [value]), JSON.stringify(value));
  }
});
