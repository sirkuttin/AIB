/**
 * Contract (ported from work/contract/test_contract_artifacts.py): the artifact routes (/api/live/artifacts*) and the artifact origin
 * of the real server, over HTTP. The Python version compared each answer with the reference over a store the Python module had filled;
 * here artifacts are made through the publish route and every status and payload is asserted. The sealed key file is covered by
 * artifact_keys_test.ts and secret_files_test.ts (AIB_SEAL=off here: the test issues an agent key from the plain secret file).
 * The Python test "watcher versions a changed source file" is covered by artifacts_test.ts: 'watcher: an existing artifact source is tracked,
 * with the missing flag' and 'watcher: an agent-written file becomes an artifact after settling, and changes add versions' (the watcher follows
 * agent writes and tracked sources of chats; this server runs no chat).
 */
import { assert, assertEquals } from './_assert.ts';
import { ContractServer, rawRequest } from './_contract_server.ts';
import * as keys from '../../app/server/artifacts/keys.ts';

const CHAT = 'claude:art';
const OTHER = 'claude:other';

Deno.test('contract: artifact routes and the artifact origin', async (t) => {
  await using s = await ContractServer.start({ env: { AIB_SEAL: 'off' } });
  const project = s.workspace;
  Deno.mkdirSync(`${project}/outputs`);
  Deno.writeTextFileSync(`${project}/outputs/page.html`, '<html><title>From disk</title><body>disk</body></html>');
  Deno.writeTextFileSync(`${project}/notes.txt`, 'plain\n');
  // the chat's project folder is known from its mark
  assertEquals((await s.post('/api/live/conversation-state', { action: 'delete', provider: 'claude', sessionId: 'art', cwd: project })).status, 200);
  const publish = async (body: Record<string, unknown>) => await s.post('/api/live/artifacts/publish', body);
  const page = (await publish({ conversationId: CHAT, content: '<html><body>one\ntwo\n</body></html>', title: 'A page', filename: 'page.html' })).json.id as string;
  const v2 = await publish({ conversationId: CHAT, id: page, content: '<html><body>one\nTWO\nthree\n</body></html>', note: 'second' });
  assertEquals([v2.status, v2.json.version, v2.json.id], [200, 2, page]);
  const notes = (await publish({ conversationId: CHAT, content: '# T\n\n* a\n', filename: 'notes.md' })).json.id as string;
  const other = (await publish({ conversationId: OTHER, content: '{"a":1}', filename: 'data.json' })).json.id as string;
  const errorOf = (reply: { status: number; json: { error?: string; code?: string } }) => [reply.status, reply.json.code ?? reply.json.error];

  await t.step('list, item, source and diff', async () => {
    const listed = await s.get(`/api/live/artifacts?conversationId=${CHAT}`);
    assertEquals(listed.status, 200);
    assertEquals(listed.json.artifacts.map((a: { id: string }) => a.id).sort(), [notes, page].sort());
    const only = await s.get(`/api/live/artifacts?conversationId=${OTHER}`);
    assertEquals(only.json.artifacts.map((a: { id: string }) => a.id), [other]);
    assertEquals((await s.get('/api/live/artifacts?conversationId=nobody')).json, { artifacts: [] });
    assertEquals(errorOf(await s.get('/api/live/artifacts')), [400, 'invalid']);
    assertEquals(errorOf(await s.get('/api/live/artifacts?conversationId=', {})), [400, 'invalid']);
    assertEquals((await s.get(`/api/live/artifacts?conversationId=${CHAT}`, {}, 'wrong')).status, 403);
    const item = (await s.get(`/api/live/artifacts/item?id=${page}`)).json;
    assertEquals([item.title, item.kind, item.entry, item.conversationId, item.versions.length], ['A page', 'html', 'page.html', CHAT, 2]);
    assertEquals(item.versions.map((v: { note: string }) => v.note), ['', 'second']);
    assertEquals((await s.get(`/api/live/artifacts/source?id=${page}`)).json, { text: '<html><body>one\nTWO\nthree\n</body></html>', truncated: false });
    assertEquals((await s.get(`/api/live/artifacts/source?id=${page}&version=1`)).json, { text: '<html><body>one\ntwo\n</body></html>', truncated: false });
    const expectedDiff = '--- v1\n+++ v2\n@@ -1,3 +1,4 @@\n <html><body>one\n-two\n+TWO\n+three\n </body></html>\n\\ No newline at end of file\n';
    assertEquals((await s.get(`/api/live/artifacts/diff?id=${page}`)).json, { diff: expectedDiff, truncated: false });
    assertEquals((await s.get(`/api/live/artifacts/diff?id=${page}&from=1&to=2`)).json, { diff: expectedDiff, truncated: false });
    assertEquals(errorOf(await s.get(`/api/live/artifacts/source?id=${page}&version=abc`)), [400, 'invalid']);
    assertEquals(errorOf(await s.get(`/api/live/artifacts/source?id=${page}&version=9`)), [404, 'not_found']);
    for (const path of ['item?id=zz', 'item?id=0123456789abcdef', 'item?id=', 'source?id=zz', 'diff?id=nope']) {
      assertEquals(errorOf(await s.get('/api/live/artifacts/' + path))[0], 404, path);
    }
    assertEquals((await s.get('/api/live/artifacts/nope')).json, { error: 'Not found' });
    assertEquals((await s.get(`/api/live/artifacts/item?id=${page}`, {}, 'wrong')).status, 403);
  });

  await t.step('pin, restore and preview', async () => {
    assertEquals((await s.post('/api/live/artifacts/pin', { id: notes, pinned: true })).json.pinned, true);
    assertEquals((await s.post('/api/live/artifacts/pin', { id: notes, pinned: true })).json.pinned, true);
    assertEquals(errorOf(await s.post('/api/live/artifacts/pin', { id: notes, pinned: 'yes' })), [400, 'invalid']);
    assertEquals(errorOf(await s.post('/api/live/artifacts/pin', { id: 'nope', pinned: true })), [404, 'not_found']);
    assertEquals((await s.post('/api/live/artifacts/pin', { id: notes, pinned: false })).json.pinned, false);
    assertEquals(errorOf(await s.post('/api/live/artifacts/pin', {})).at(0), 400);
    const restored = await s.post('/api/live/artifacts/restore', { id: page, version: 1 });
    assertEquals([restored.status, restored.json.version], [200, 3]);
    for (const version of ['x', true]) assertEquals(errorOf(await s.post('/api/live/artifacts/restore', { id: page, version })), [400, 'invalid']);
    assertEquals(errorOf(await s.post('/api/live/artifacts/restore', { id: page, version: 99 })), [404, 'not_found']);
    assertEquals(errorOf(await s.post('/api/live/artifacts/restore', { id: 'nope', version: 1 })).at(0), 404);
    assertEquals((await s.get(`/api/live/artifacts/item?id=${page}`)).json.versions.length, 3);
    const made = await s.post('/api/live/artifacts/preview', { conversationId: CHAT, path: 'outputs/page.html' });
    assertEquals([made.status, made.json.title, made.json.kind], [200, 'From disk', 'html']);
    const again = await s.post('/api/live/artifacts/preview', { conversationId: CHAT, path: `${project}/outputs/page.html` });
    assertEquals([again.status, again.json.id], [200, made.json.id]); // the same file, the same artifact
    assertEquals(errorOf(await s.post('/api/live/artifacts/preview', { conversationId: CHAT, path: 'missing.html' })), [404, 'not_found']);
    assertEquals(errorOf(await s.post('/api/live/artifacts/preview', { conversationId: CHAT, path: '../outside.html' })), [403, 'outside_project']);
    assertEquals(errorOf(await s.post('/api/live/artifacts/preview', { conversationId: CHAT, path: '' })), [400, 'invalid']);
    assertEquals(errorOf(await s.post('/api/live/artifacts/preview', { conversationId: 'claude:nofolder', path: 'x.html' })), [404, 'unknown_folder']);
    assertEquals((await s.post('/api/live/artifacts/pin', { id: notes, pinned: true }, {}, 'wrong')).status, 403);
    assertEquals((await s.post('/api/live/artifacts/nope', { id: notes })).status, 404);
    assertEquals((await s.post('/api/live/artifacts/pin', [1, 2])).status, 400); // a list body is not an object
    assertEquals((await s.request('POST', '/api/live/artifacts/pin', s.pageHeaders(), new Uint8Array())).status, 400);
  });

  await t.step('publish with the page token', async () => {
    assertEquals(errorOf(await publish({ conversationId: CHAT })), [400, 'invalid']);
    assertEquals(errorOf(await publish({ conversationId: CHAT, content: 5 })), [400, 'invalid']);
    assertEquals(errorOf(await publish({ conversationId: CHAT, content: 'x', kind: 'nope' })), [400, 'invalid']);
    assertEquals(errorOf(await publish({ conversationId: CHAT, content: 'x', filename: 'a.exe' })), [400, 'unsupported_kind']);
    assertEquals(errorOf(await publish({ conversationId: OTHER, id: page, content: 'x' })), [403, 'wrong_conversation']);
    const csv = await publish({ conversationId: CHAT, content: 'a,b\n', filename: 'd.csv' });
    assertEquals([csv.status, csv.json.kind], [200, 'csv']);
    const byPath = await publish({ conversationId: CHAT, path: 'outputs/page.html', note: 'n', toolCallId: 't1' });
    assertEquals([byPath.status, byPath.json.title], [200, 'From disk']);
  });

  await t.step('publish and list with an agent key', async () => {
    keys.configure(s.stateDir);
    const key = keys.issue(CHAT) ?? '';
    keys.configure(null);
    assert(key);
    const made = await s.agent('POST', '/api/live/artifacts/publish', key, { conversationId: CHAT, content: '# by agent', filename: 'agent.md' });
    assertEquals([made.status, made.json.kind, made.json.conversationId], [200, 'md', CHAT]);
    const refuse = { error: 'Invalid artifact key' };
    const body = { conversationId: CHAT, content: 'x' };
    assertEquals([(await s.agent('POST', '/api/live/artifacts/publish', key, { conversationId: OTHER, content: 'x' })).status], [403]); // key of another chat
    assertEquals((await s.agent('POST', '/api/live/artifacts/publish', 'not-a-key', body)).json, refuse);
    assertEquals((await s.agent('POST', '/api/live/artifacts/publish', key, { content: 'x' })).json, refuse);
    assertEquals((await s.agent('POST', '/api/live/artifacts/publish', key, body, { Origin: 'http://127.0.0.1:1' })).json, ERR_PAGE);
    assertEquals((await s.agent('POST', '/api/live/artifacts/pin', key, { id: page, pinned: true })).json, refuse); // the key is for publish and list only
    const listed = await s.agent('GET', `/api/live/artifacts?conversationId=${CHAT}`, key);
    assertEquals(listed.status, 200);
    assert(listed.json.artifacts.some((a: { id: string }) => a.id === made.json.id));
    assertEquals((await s.agent('GET', `/api/live/artifacts?conversationId=${OTHER}`, key)).json, refuse);
    assertEquals((await s.agent('GET', `/api/live/artifacts/item?id=${page}`, key)).json, refuse);
  });

  await t.step('the artifact origin serves the files, on the Studio port + 1, and is not a Studio address', async () => {
    const boot = (await s.bootstrap()).json;
    const originPort = Number(boot.artifactOrigin.split(':').pop());
    assertEquals(originPort, s.port + 1);
    const get = (path: string, host = `127.0.0.1:${originPort}`) => rawRequest(originPort, 'GET', path, { Host: host });
    const first = await get(`/a/${page}/v1/page.html`);
    assertEquals(first.status, 200);
    assertEquals(first.headers['content-type'], 'text/html; charset=utf-8');
    assert(first.text.startsWith('<html><body>one\ntwo\n'));
    assert(first.text.includes('studio-scroll'), 'the scroll script is injected into HTML pages');
    assertEquals(first.headers['cache-control'], 'no-store');
    assertEquals(first.headers['x-content-type-options'], 'nosniff');
    const csp = first.headers['content-security-policy'];
    assert(csp.startsWith("default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'"));
    assert(csp.includes(`http://127.0.0.1:${originPort}/_lib/ http://localhost:${originPort}/_lib/;`), 'script-src allows this origin /_lib/ only');
    assert(csp.includes(`frame-ancestors http://127.0.0.1:${s.port} http://localhost:${s.port}`));
    assert(csp.includes("connect-src 'none'") && csp.includes('sandbox allow-scripts'));
    assert((await get(`/a/${page}/v2/page.html`)).text.includes('TWO'));
    assertEquals((await get(`/a/${notes}/v1/notes.md`)).status, 200);
    assertEquals((await get(`/a/${other}/v1/data.json`)).status, 200);
    for (const path of [`/a/${page}/v9/page.html`, `/a/${page}/v1/other.html`, '/a/zz/v1/x.html', '/', '/a/..%2F/x']) {
      assertEquals((await get(path)).status, 404, path);
    }
    assertEquals((await get(`/a/${page}/v1/page.html`, `127.0.0.1:${s.port}`)).status, 403); // the Studio's own Host is refused here
    const asHost = await s.request('GET', '/api/live/list', s.pageHeaders(true, { Host: boot.artifactOrigin.slice('http://'.length) }));
    assertEquals([asHost.status, asHost.json], [403, { error: 'Not an AIB address' }]);
    const asOrigin = await s.request('GET', '/api/live/list', s.pageHeaders(true, { Origin: boot.artifactOrigin }));
    assertEquals([asOrigin.status, asOrigin.json], [403, ERR_PAGE]);
  });

  await t.step("the page's Content-Security-Policy names the artifact origin", async () => {
    const policy = (await s.get('/api/live/settings')).headers['content-security-policy'] ?? '';
    const origin = (await s.bootstrap()).json.artifactOrigin;
    assert(policy.includes(`frame-src 'self' ${origin}`), policy);
    assert(policy.includes(`img-src 'self' ${origin}`), policy);
  });

  await t.step('artifact-web.json names this server', () => {
    const data = JSON.parse(Deno.readTextFileSync(`${s.stateDir}/artifact-web.json`));
    assertEquals(data.url, s.origin);
    assertEquals(Object.keys(data).sort(), ['pid', 'url']);
  });
});

const ERR_PAGE = { error: 'Request must come from the AIB page' };
