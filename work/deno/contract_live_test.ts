/**
 * Contract (ported from work/contract/test_contract_live.py): the live routes answered by the agent host (state, ownership, live ops,
 * agent install and sign-in status) refuse bad requests with the documented status and error, and POST /api/live/shutdown stops the
 * web server. The old version compared every answer with the reference; here the values are asserted. Exact error texts of the
 * install/sign-in routes are covered by installer_test.ts and signin_test.ts.
 */
import { assert, assertEquals } from './_assert.ts';
import { ContractServer } from './_contract_server.ts';

Deno.test('contract: live routes refuse bad requests', async (t) => {
  await using s = await ContractServer.start();
  const refused = async (what: string, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, status = 400) => {
    const reply = method === 'GET' ? await s.get(path) : await s.post(path, body ?? {});
    assertEquals(reply.status, status, `${what}: ${reply.text}`);
    assert(typeof reply.json?.error === 'string' && reply.json.error, `${what}: an error text`);
    return reply;
  };

  await t.step('state of an unknown connection is 404', async () => {
    const gone = await refused('unknown id', 'GET', '/api/live/state?id=no-such-connection&after=0', undefined, 404);
    assertEquals(gone.json.code, 'connection_not_found');
    await refused('bad cursor', 'GET', '/api/live/state?id=x&after=notanumber', undefined, 400);
  });

  await t.step('ownership: an empty folder is answered, a network path is refused', async () => {
    const ok = await s.get('/api/live/ownership?provider=claude&id=abc&cwd=');
    assertEquals(ok.status, 200);
    assert(typeof ok.json === 'object');
    const net = await refused('network path', 'GET', '/api/live/ownership?provider=claude&id=abc&cwd=%5C%5Cserver%5Cshare', undefined, 400);
    assertEquals(net.json.error, 'Network and device paths are not supported');
  });

  await t.step('live ops refuse bad requests', async () => {
    await refused('discover', 'POST', '/api/live/discover', { provider: 'nope' });
    for (
      const [name, body, status] of [
        ['connect', {}, 400],
        ['prompt', { id: 'missing', text: 'hi' }, 400],
        ['cancel', { id: 'missing' }, 400],
        ['queue', { id: 'missing' }, 400],
        ['disconnect', { id: 'missing' }, 400],
        ['session-op', { id: 'missing', op: 'x' }, 400],
      ] as [string, Record<string, unknown>, number][]
    ) await refused(name, 'POST', `/api/live/${name}`, body, status);
    // forgetting a chat that is not there is not an error
    assertEquals((await s.post('/api/live/forget', { provider: 'claude', sessionId: '' })).json, { ok: true, forgotten: false });
  });

  await t.step('agent install and sign-in status', async () => {
    for (const agent of ['claude', 'codex']) {
      const reply = await s.get(`/api/live/agents/install?agent=${agent}`);
      assertEquals(reply.status, 200, reply.text);
      assert(typeof reply.json === 'object' && reply.json);
    }
    const unknown = await refused('unknown agent', 'GET', '/api/live/agents/install?agent=nope', undefined, 409);
    assertEquals(unknown.json.code, 'install_refused');
    for (const [path, body] of [['install', { agent: 5 }], ['signin', { agent: null }], ['signin/check', { agent: 7 }]] as const) {
      const reply = await refused(path, 'POST', `/api/live/agents/${path}`, body);
      assertEquals(reply.json.error, 'agent must be text');
    }
  });
});

Deno.test('contract: POST /api/live/shutdown stops the web server', async () => {
  await using s = await ContractServer.start();
  const reply = await s.post('/api/live/shutdown', {});
  assertEquals([reply.status, reply.json], [200, { ok: true }]);
  await s.until('the web server exits', () => s.exited, 15);
});
