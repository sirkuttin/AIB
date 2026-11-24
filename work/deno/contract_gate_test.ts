/**
 * Contract (ported from work/contract/test_contract_gate.py, GateContract): the auth gate, page files and bootstrap of the real server,
 * over HTTP only. The phone-port secrets check of that file (PhonePortContract) is work/deno/remote_phone_e2e_test.ts
 * ("no phone-port answer carries the page token, the agent host's token or the artifact key secret"); the Python-only
 * "bootstrap has the reference keys" check is dropped with the reference (bootstrap's keys are asserted below, its values in page_access_test.ts).
 */
import { assert, assertEquals } from './_assert.ts';
import { APP_DIR, ContractServer, shape } from './_contract_server.ts';

const ERR_TOKEN = { error: 'Invalid local session token' };
const ERR_PAGE = { error: 'Request must come from the AIB page' };

Deno.test('contract: the auth gate, page files and bootstrap', async (t) => {
  await using s = await ContractServer.start();
  const outsideGet = (path: string, extra: Record<string, string> = {}) =>
    s.request('GET', path, { 'Host': `127.0.0.1:${s.port}`, ...extra });

  await t.step('bootstrap hands out a token and the documented fields', async () => {
    const reply = await s.bootstrap();
    assertEquals(reply.status, 200);
    assert(reply.headers['content-type'].startsWith('application/json'));
    const body = reply.json;
    assert(/^\S{20,}$/.test(body.token));
    for (
      const key of [
        'instanceId',
        'webInstanceId',
        'pid',
        'launchNonce',
        'hostMode',
        'stateDir',
        'artifactOrigin',
        'server',
        'features',
        'connections',
        'migration',
        'hostTakeoverWaiting',
        'sandboxNotice',
        'hostCodeWarning',
        'packageContext',
      ]
    ) assert(key in body, key);
    for (const key of ['version', 'versionLabel', 'aboutLine', 'protocol', 'webPort']) assert(key in body.server, key);
    assertEquals(body.server.webPort, 0); // the --port flag as given
    assertEquals(body.connections, []);
    assertEquals(body.hostMode, 'in-process');
    assertEquals([body.hostPid, body.instanceId], [body.pid, body.webInstanceId]); // the web server manages the agents itself
    assert(Object.values(body.features).every((v) => typeof v === 'boolean' || typeof v === 'string'));
    assert(body.artifactOrigin.startsWith('http://127.0.0.1:'));
  });

  await t.step('bootstrap gives the token only to the page', async () => {
    const outside = await s.bootstrap(false);
    assertEquals(outside.status, 200);
    assertEquals(outside.json.token, '');
    assertEquals(Object.keys(outside.json).sort(), Object.keys((await s.bootstrap()).json).sort());
    const list = await s.get('/api/live/list', {}, outside.json.token);
    assertEquals([list.status, list.json], [403, ERR_TOKEN]);
    const permission = await s.post('/api/live/permission', { id: 'claude:x', key: 'k', option: 'allow' }, {}, '');
    assertEquals(permission.status, 403);
  });

  await t.step('bootstrap refuses a cross-site page', async () => {
    const reply = await s.get('/api/live/bootstrap', { 'Sec-Fetch-Site': 'cross-site' }, false);
    assertEquals([reply.status, reply.json], [403, ERR_PAGE]);
  });

  await t.step('the gate refuses: no token, wrong token, foreign host/origin, navigation, same-site, POST without origin', async () => {
    const noToken = await s.get('/api/live/list', {}, false);
    assertEquals([noToken.status, noToken.json], [403, ERR_TOKEN]);
    assertEquals((await s.get('/api/live/list', {}, 'x'.repeat(40))).status, 403);
    const host = await s.get('/api/live/list', { Host: 'evil.example:80' });
    assertEquals([host.status, host.json], [403, { error: 'Not an AIB address' }]);
    const origin = await s.get('/api/live/list', { Origin: 'http://evil.example' });
    assertEquals([origin.status, origin.json], [403, ERR_PAGE]);
    assertEquals((await s.get('/api/live/list', { 'Sec-Fetch-Mode': 'navigate' })).status, 403);
    assertEquals((await s.get('/api/live/list', { 'Sec-Fetch-Site': 'same-site' })).status, 403); // the artifact origin
    const bare = await s.post('/api/live/read-state', {}, { Origin: null, 'Sec-Fetch-Site': null });
    assertEquals([bare.status, bare.json], [403, ERR_PAGE]);
  });

  await t.step('an unknown API route is 404; a POST needs a JSON object body', async () => {
    assertEquals((await s.get('/api/live/no-such-route')).status, 404);
    assertEquals((await s.post('/api/live/no-such-route', {})).status, 404);
    for (const body of ['', '[1]', '{not json']) {
      const reply = await s.request('POST', '/api/live/read-state', s.pageHeaders(), body === '' ? new Uint8Array() : body);
      assertEquals(reply.status, 400, body);
      assert('error' in reply.json, body);
    }
  });

  await t.step('the chat page and its scripts are served without a token', async () => {
    const page = await s.request('GET', '/', { 'Host': `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' });
    assertEquals(page.status, 200);
    assertEquals(page.headers['content-type'], 'text/html; charset=utf-8');
    // the saved view preferences are a JSON data block, the saved theme and symbols attributes; the rest is the file
    let served = page.text.replace(/<script type="application\/json" id="aibViewPrefs">[^<]*<\/script>/, '');
    let removed = 0;
    served = served.replace(/ data-(?:theme|status-glyphs)-pref="[a-z0-9-]+"/g, (m) => removed++ < 2 ? '' : m);
    assertEquals(served, Deno.readTextFileSync(`${APP_DIR}/chat.html`));
    assert(page.text.includes('<script type="application/json" id="aibViewPrefs">{"prefs":{'));
    const scripts = [...page.text.matchAll(/<script[^>]+src="\/?([a-z0-9-]+\.js)"/g)].map((m) => m[1]);
    const styles = [...page.text.matchAll(/<link[^>]+href="\/?([a-z0-9-]+\.css)"/g)].map((m) => m[1]);
    assert(scripts.length > 10);
    for (const name of [...scripts, ...styles]) {
      const reply = await s.request('GET', '/' + name, { 'Host': `127.0.0.1:${s.port}`, 'Sec-Fetch-Site': 'same-origin' });
      assertEquals(reply.status, 200, name);
      assertEquals(reply.text, Deno.readTextFileSync(`${APP_DIR}/${name}`), name);
      assertEquals(reply.headers['content-type'], (name.endsWith('.js') ? 'text/javascript' : 'text/css') + '; charset=utf-8', name);
    }
  });

  await t.step('page responses carry the security headers', async () => {
    const page = await outsideGet('/');
    const csp = page.headers['content-security-policy'] ?? '';
    assert(csp.includes("default-src 'self'"));
    assert(csp.includes('frame-src'));
    assertEquals(page.headers['x-content-type-options'], 'nosniff');
  });

  await t.step('files outside the page set are not served', async () => {
    for (const path of ['/studio.py', '/../studio.py', '/docs/VISION.md', '/.git/config', '/Chat.js', '/deno.json']) {
      const reply = await outsideGet(path);
      assert([403, 404].includes(reply.status), `${path}: ${reply.status}`);
    }
  });

  await t.step('list and state shapes', async () => {
    const listing = await s.get('/api/live/list');
    assertEquals(listing.status, 200);
    for (const key of ['conversationRevision', 'projectsRevision', 'readStateRevision', 'settingsRevision', 'webInstanceId']) {
      assert(key in listing.json, key);
    }
    for (const path of ['/api/live/conversation-state', '/api/live/read-state', '/api/live/project-prefs', '/api/live/settings']) {
      const reply = await s.get(path);
      assertEquals(reply.status, 200, path);
      assert(reply.json && typeof reply.json === 'object' && !Array.isArray(reply.json), path);
    }
  });

  await t.step('read-state round trip only moves forward', async () => {
    const key = 'claude:contract-session-1';
    const reply = await s.post('/api/live/read-state', { set: { [key]: { seenAt: 1000.5, seenIndex: 7 } } }); // stored as a whole number
    assertEquals(reply.status, 200);
    assertEquals(reply.json.ok, true);
    const find = async () => {
      const stored = (await s.get('/api/live/read-state')).json;
      return { stored, found: Object.values(stored).filter((v) => v && typeof v === 'object' && key in (v as object)) as Record<string, Record<string, number>>[] };
    };
    const first = await find();
    const { ok: _ok, ...echoed } = reply.json;
    assertEquals(shape(echoed), shape(first.stored));
    assert(first.found.length, JSON.stringify(first.stored));
    assertEquals([first.found[0][key].seenAt, first.found[0][key].seenIndex], [1000, 7]);
    await s.post('/api/live/read-state', { set: { [key]: { seenAt: 999.0, seenIndex: 9 } } }); // older: ignored
    const again = (await find()).found[0][key];
    assertEquals([again.seenAt, again.seenIndex], [1000, 7]);
    for (const bad of [{}, { set: [] }, { set: { [key]: { seenAt: 'x' } } }]) {
      assertEquals((await s.post('/api/live/read-state', bad)).status, 400, JSON.stringify(bad));
    }
  });
});
