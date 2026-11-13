/**
 * The phone port (server/remote/server.ts) in a Studio in this process with a fake agent host and a fake Tailscale CLI:
 *  - default deny: every page route (ROUTE_LIST), both WebSockets and the own-gate POSTs answer 403/404 here; REMOTE_ROUTES are not in
 *    the page's table;
 *  - RemoteGate refusals (Host, Origin, Fetch Metadata, page credentials, login header, device token, cookie, removed phone);
 *  - pairing over HTTP (second claim, reject, approve), home and chat payloads (helpers folded, tail, no image bytes, 304),
 *    images by cookie only;
 *  - Funnel on: no listener; a busy phone port: reported, the saved port kept, and taken once free;
 *  - no answer here ever carries the page token.
 */
import { assert, assertEquals } from './_assert.ts';
import { ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { COOKIE_NAME, DEVICE_HEADER, REMOTE_ROUTES } from '../../outputs/agent-studio/server/remote/server.ts';
import { readRemotePort, saveRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import {
  type FakeChat,
  fakeTailscale,
  LOGIN,
  NAME,
  nonce,
  pairPhone,
  pc,
  phoneHeaders,
  raw,
  type RemoteStudio,
  remoteStudio,
  serveStatus,
} from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;

async function phoneOn(over: Parameters<typeof remoteStudio>[0] = {}): Promise<RemoteStudio & { fake: ReturnType<typeof fakeTailscale> }> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner, ...over });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', { on: true });
  assertEquals(status, 200);
  return Object.assign(s, { fake });
}

function chat(id: string, over: Partial<FakeChat> = {}): FakeChat {
  return {
    id,
    provider: 'claude',
    sessionId: 'sess-' + id,
    cwd: 'C:\\code\\shop',
    busy: false,
    closed: false,
    attention: { state: 'idle', needs: 0, turnEndedAt: null, busySince: null },
    subagents: {},
    events: [],
    permissions: [],
    elicitations: [],
    ...over,
  };
}

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

Deno.test({
  ...OPTS,
  name: 'default deny: every page route, both WebSockets and the own-gate POSTs are refused on the phone port',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const port = s.phonePort();
      const remote = new Set(REMOTE_ROUTES.map(([m, p]) => `${m} ${p}`));
      for (const [m, p] of REMOTE_ROUTES) assert(!ROUTE_LIST.some(([lm, lp]) => lm === m && lp === p), `${m} ${p} is not a page route`);
      const extra: [string, string][] = [['GET', '/chat.html'], ['GET', '/doc.html'], ['GET', '/chat.js'], ['GET', '/theme.css'], [
        'GET',
        '/doc-drawing.html',
      ]];
      for (const [method, path] of [...ROUTE_LIST.map(([m, p]) => [m, p] as [string, string]), ...extra]) {
        if (remote.has(`${method} ${path}`)) continue;
        const r = await raw(port, method, path, {
          ...phoneHeaders({}, method),
          [DEVICE_HEADER]: phone.token,
          Cookie: `${COOKIE_NAME}=${phone.cookie}`,
        }, method === 'POST' ? '{}' : undefined);
        assert(r.status === 404 || r.status === 403, `${method} ${path} -> ${r.status}`);
        assert(!r.text.includes(s.token), `${method} ${path} leaks the page token`);
      }
      for (const path of ['/api/live/terminal', '/api/live/docs/socket', '/api/remote/home']) {
        const r = await raw(port, 'GET', path, {
          ...phoneHeaders(),
          [DEVICE_HEADER]: phone.token,
          Upgrade: 'websocket',
          Connection: 'Upgrade',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Protocol': `aib-token.${s.token}`,
        });
        assertEquals(r.status, 403, `${path} WebSocket`);
      }
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name:
    'RemoteGate refuses: loopback Host, wrong Host, http Origin, same-site, page credentials, no login, wrong login, cookie only, removed phone',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const port = s.phonePort();
      const home = (h: Record<string, string | null>) =>
        raw(port, 'GET', '/api/remote/home', phoneHeaders({ [DEVICE_HEADER]: phone.token, ...h }));
      assertEquals((await home({})).status, 200, 'the paired phone reads home');
      const cases: [string, Record<string, string | null>, number][] = [
        ['loopback Host', { Host: `127.0.0.1:${port}` }, 403],
        ['localhost Host', { Host: 'localhost' }, 403],
        ['wrong Host', { Host: 'other-pc.tail-a1b2.ts.net' }, 403],
        ['Host with a port', { Host: `${NAME}:443` }, 403],
        ['http Origin', { Origin: `http://${NAME}` }, 403],
        ['other Origin', { Origin: 'https://evil.example' }, 403],
        ['Sec-Fetch-Site same-site', { 'Sec-Fetch-Site': 'same-site' }, 403],
        ['Sec-Fetch-Site cross-site', { 'Sec-Fetch-Site': 'cross-site' }, 403],
        ['no Sec-Fetch-Site', { 'Sec-Fetch-Site': null }, 403],
        ['a navigation', { 'Sec-Fetch-Mode': 'navigate' }, 403],
        ['X-Studio-Token', { 'X-Studio-Token': s.token }, 403],
        ['X-Studio-Artifact-Key', { 'X-Studio-Artifact-Key': 'k' }, 403],
        ['no login header', { 'Tailscale-User-Login': null }, 403],
        ['another login', { 'Tailscale-User-Login': 'someone-else@example.com' }, 403],
        ['no device token', { [DEVICE_HEADER]: null }, 401],
        ['a wrong device token', { [DEVICE_HEADER]: 'x'.repeat(43) }, 401],
        ['the cookie only (no header token)', { [DEVICE_HEADER]: null, Cookie: `${COOKIE_NAME}=${phone.cookie}` }, 401],
        ['the cookie value as the token', { [DEVICE_HEADER]: phone.cookie }, 401],
      ];
      for (const [what, h, status] of cases) assertEquals((await home(h)).status, status, what);
      // X-Forwarded-* is never read: a forged one changes nothing
      assertEquals((await home({ 'X-Forwarded-Host': '127.0.0.1', 'X-Forwarded-For': '127.0.0.1' })).status, 200);
      // a POST without an Origin
      const claim = await raw(port, 'POST', '/api/remote/pair/claim', phoneHeaders({ Origin: null }), '{"code":"x"}');
      assertEquals(claim.status, 403);
      // removed on the PC: the next request fails at once
      assertEquals((await pc(s, 'POST', '/api/live/devices/remove', { id: phone.id }))[0], 200);
      const after = await home({});
      assertEquals([after.status, after.json.code], [401, 'not_paired']);
      const boot = await raw(port, 'GET', '/api/remote/bootstrap', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(boot.status, 401);
      const img = await raw(
        port,
        'GET',
        '/api/remote/image?id=a&seq=1&n=0',
        phoneHeaders({ Cookie: `${COOKIE_NAME}=${phone.cookie}`, 'Sec-Fetch-Dest': 'image' }),
      );
      assertEquals(img.status, 401, "the removed phone's cookie no longer loads images");
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'pairing over HTTP: other login refused, a second claim refused (PC told), reject leaves no phone, approve lets it read home',
  async fn() {
    const s = await phoneOn();
    try {
      const port = s.phonePort();
      const boot = await raw(port, 'GET', '/api/remote/bootstrap', phoneHeaders());
      assertEquals([boot.status, boot.json.paired, boot.json.layout, boot.json.pcName], [200, false, 'phone', 'STUDIO-PC']);
      const [, code] = await pc(s, 'POST', '/api/live/devices/pair', {});
      assert(String(code.url).startsWith(`https://${NAME}/phone.html#p=`), String(code.url));
      assert(String(code.qr).startsWith('<svg'), 'a QR');
      const words = (code.words as string[]).join(' ');
      const claimBody = (name: string) => JSON.stringify({ code: words, name, nonce: nonce() });
      const other = await raw(
        port,
        'POST',
        '/api/remote/pair/claim',
        phoneHeaders({ 'Tailscale-User-Login': 'friend@example.com' }, 'POST'),
        claimBody('Friend'),
      );
      assertEquals([other.status, other.json.code], [403, 'other_login']);
      const first = await raw(port, 'POST', '/api/remote/pair/claim', phoneHeaders({}, 'POST'), claimBody('Pixel 9'));
      assertEquals(first.status, 200);
      assertEquals((first.json.checkWords as string[]).length, 2);
      const second = await raw(port, 'POST', '/api/remote/pair/claim', phoneHeaders({}, 'POST'), claimBody('Intruder'));
      assertEquals([second.status, second.json.code], [409, 'already_used']);
      let [, view] = await pc(s, 'GET', '/api/live/devices');
      const pairing = view.pairing as Json;
      assertEquals(pairing.anotherTried, true, 'the PC shows "Another device tried this code"');
      const pending = pairing.pending as Json[];
      assertEquals(pending.map((p) => [p.name, p.checkWords]), [['Pixel 9', first.json.checkWords]]);
      assertEquals((await pc(s, 'POST', '/api/live/devices/reject', { claim: pending[0].id }))[1].rejected, true);
      const status = await raw(
        port,
        'POST',
        '/api/remote/pair/status',
        phoneHeaders({}, 'POST'),
        JSON.stringify({ claim: first.json.claim, claimSecret: first.json.claimSecret }),
      );
      assertEquals(status.json.state, 'rejected');
      assertEquals(status.headers.get('set-cookie'), null);
      [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals(view.devices, [], 'reject leaves no phone');
      // approve: the phone gets its token once, with the cookie, and reads home
      const phone = await pairPhone(s, 'Pixel 9');
      assert(phone.token && phone.cookie);
      const home = await raw(port, 'GET', '/api/remote/home', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(home.status, 200);
      [, view] = await pc(s, 'GET', '/api/live/devices');
      const devices = view.devices as Json[];
      assertEquals(devices.map((d) => [d.name, d.login]), [['Pixel 9', LOGIN]]);
      assertEquals(
        devices[0].scopes,
        ['phone.read', 'phone.answer', 'phone.prompt', 'phone.approve', 'phone.push'],
        'decision 2c defaults',
      );
      assert(!JSON.stringify(view).includes(phone.token), 'the PC view never shows a token');
      const [, activity] = await pc(s, 'GET', '/api/live/devices/activity');
      const results = (activity.entries as Json[]).map((e) => `${e.action}: ${e.result}`);
      assert(results.includes('pair: approved on the PC') && results.includes('pair: rejected on the PC'), results.join(' | '));
      assert(!JSON.stringify(activity).includes(words), 'no code in the log');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "home: needs-you first, helpers folded from each chat's own subagents, archived chats left out, 304 when unchanged",
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const port = s.phonePort();
      s.chats.push(
        chat('a', { attention: { state: 'idle', needs: 0, turnEndedAt: '2026-11-12T10:00:00Z', busySince: null } }),
        chat('b', {
          busy: true,
          attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: '2026-11-12T11:00:00Z' },
          subagents: { s1: { title: 'Codex · tests', state: 'running' }, s2: { description: 'Docs pass', state: 'completed' } },
          breadth: { sessionInfo: { title: 'Main · checkout redesign' } },
        }),
        chat('c', { attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: '2026-11-12T09:00:00Z' } }),
        chat('d', { sessionId: 'archived' }),
        chat('e', { closed: true }),
      );
      await s.ctx.conversations.apply('archive', 'claude', 'archived', '', '', true).catch(() => {});
      const get = (rev = '') =>
        raw(port, 'GET', `/api/remote/home${rev ? '?rev=' + rev : ''}`, phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      const home = (await get()).json;
      const chats = home.chats as Json[];
      assertEquals(chats.map((c) => c.id), ['c', 'b', 'a'], 'needs you first, then newest activity; archived and closed left out');
      assertEquals(home.main, 'b', 'the working chat with helpers is the big card');
      const b = chats[1];
      assertEquals(b.title, 'Main · checkout redesign');
      assertEquals(b.helpers, [{ id: 's1', title: 'Codex · tests', state: 'running' }, {
        id: 's2',
        title: 'Docs pass',
        state: 'completed',
      }]);
      assertEquals(chats[0].title, 'Claude Code in shop', 'no title yet: agent and folder');
      assertEquals((await get(home.revision as string)).status, 304);
      s.chats[0].attention = { state: 'working', needs: 0, turnEndedAt: null, busySince: '2026-11-12T12:00:00Z' };
      assertEquals((await get(home.revision as string)).status, 200, 'a change gives a new revision');
      for (const key of ['token', 'events', 'permissions', 'settings']) assert(!(key in chats[0]), key);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'chat: the tail is respected, images are URLs (no inline bytes), the image loads by cookie only',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const port = s.phonePort();
      const events: Json[] = [];
      for (let i = 1; i <= 50; i++) {
        events.push({
          seq: i,
          kind: 'update',
          time: i,
          data: { sessionId: 'sess-x', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `m${i}` } } },
        });
      }
      events.push({
        seq: 51,
        kind: 'user',
        time: 51,
        data: {
          text: 'look',
          attachments: [{ name: 'a.png', mimeType: 'image/png', data: PNG }, {
            name: 'f.pdf',
            mimeType: 'application/pdf',
            data: 'JVBERi0x',
          }],
        },
      });
      events.push({
        seq: 52,
        kind: 'update',
        time: 52,
        data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: PNG } } },
      });
      s.chats.push(
        chat('x', {
          events,
          permissions: [{ key: 'p1', params: { toolCall: { title: 'Run npm test' }, options: [] } }],
          attention: { state: 'needs_you', needs: 1 },
        }),
      );
      const get = (q: string, h: Record<string, string | null> = {}) =>
        raw(port, 'GET', `/api/remote/chat?${q}`, phoneHeaders({ [DEVICE_HEADER]: phone.token, ...h }));
      const r = await get('id=x&tail=10');
      assertEquals(r.status, 200);
      const body = r.json;
      const seqs = (body.events as Json[]).map((e) => e.seq);
      assertEquals(seqs, [43, 44, 45, 46, 47, 48, 49, 50, 51, 52]);
      assertEquals([body.truncated, body.firstSeq, body.cursor], [true, 43, 52]);
      assertEquals(body.waiting, [{ kind: 'permission', key: 'p1', title: 'Run npm test', detail: '', options: [], hidden: 0, pcOnly: true }]);
      assert(!r.text.includes(PNG) && !r.text.includes('JVBERi0x'), 'no inline file bytes');
      assert(!('inUse' in body) && !('settings' in body) && !('permissions' in body), 'no model lookup, settings or permission bodies');
      const att = ((body.events as Json[]).find((e) => e.seq === 51)!.data as Json).attachments as Json[];
      assertEquals(att[0].url, '/api/remote/image?id=x&seq=51&n=0');
      assertEquals(att[1].url, undefined, 'only pictures get a URL');
      const second = ((body.events as Json[]).find((e) => e.seq === 52)!.data as Json).update as Json;
      assertEquals((second.content as Json).url, '/api/remote/image?id=x&seq=52&n=0');
      assertEquals(((await get('id=x&tail=10&after=50')).json.events as Json[]).length, 2, 'after a cursor');
      assertEquals((await get('id=missing')).status, 404);
      // images: the cookie, never the header token
      const img = (h: Record<string, string | null>) =>
        raw(
          port,
          'GET',
          '/api/remote/image?id=x&seq=51&n=0',
          phoneHeaders({ 'Sec-Fetch-Dest': 'image', 'Sec-Fetch-Mode': 'no-cors', ...h }),
        );
      const ok = await img({ Cookie: `${COOKIE_NAME}=${phone.cookie}` });
      assertEquals([ok.status, ok.headers.get('content-type')], [200, 'image/png']);
      assertEquals(ok.bytes.slice(1, 4), new TextEncoder().encode('PNG'));
      assertEquals((await img({ [DEVICE_HEADER]: phone.token })).status, 401, 'the header token does not load images');
      // a chat page with no read scope cannot read
      const watcher = await pairPhone(s, 'Old phone', []);
      assertEquals((await get('id=x', { [DEVICE_HEADER]: watcher.token })).status, 200, 'phone.read is always kept');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone page files only, with the phone CSP; the cookie is renewed when the page loads',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const port = s.phonePort();
      const page = await raw(
        port,
        'GET',
        '/phone.html',
        phoneHeaders({
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
          Cookie: `${COOKIE_NAME}=${phone.cookie}`,
        }),
      );
      assertEquals(page.status, 200);
      assert(page.text.includes('phone.js') && !page.text.includes('chat.js'), 'the phone page');
      assert(/frame-ancestors 'none'/.test(page.headers.get('content-security-policy') ?? ''));
      assert((page.headers.get('set-cookie') ?? '').includes('Secure; HttpOnly; SameSite=Strict'), 'renewed');
      for (const path of ['/phone.js', '/phone.css', '/phone-words.js', '/markdown.js']) {
        assertEquals((await raw(port, 'GET', path, phoneHeaders({ 'Sec-Fetch-Dest': 'script' }))).status, 200, path);
      }
      const unpaired = await raw(port, 'GET', '/phone.html', phoneHeaders({ 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' }));
      assertEquals(
        [unpaired.status, unpaired.headers.get('set-cookie')],
        [200, null],
        'a phone that is not paired can open the page to pair',
      );
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: "Funnel on for this PC's name: the phone port does not start, and says why",
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    try {
      fake.state.serve = serveStatus(readRemotePort(s.state)!, true);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals([view.listening, (view.problem as Json).code], [false, 'funnel']);
      assertEquals(s.ctx.phone.server, null);
      const refused = await Deno.connect({ hostname: '127.0.0.1', port: readRemotePort(s.state)! }).then(
        (c) => (c.close(), false),
        () => true,
      );
      assert(refused, 'nothing listens on the phone port');
      fake.state.serve = serveStatus(readRemotePort(s.state)!, false);
      await pc(s, 'POST', '/api/live/devices/check', {});
      assertEquals((await pc(s, 'GET', '/api/live/devices'))[1].listening, true, 'Check again starts it once Funnel is off');
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a busy phone port: Devices says so, the saved port stays, and Check again takes it once it is free',
  async fn() {
    const held = Deno.listen({ hostname: '127.0.0.1', port: 0 });
    const port = (held.addr as Deno.NetAddr).port;
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner, bindRetryMs: 1000 });
    try {
      saveRemotePort(s.state, port);
      fake.state.serve = serveStatus(port);
      await pc(s, 'POST', '/api/live/devices/access', { on: true });
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals([view.listening, (view.problem as Json).code, view.port], [false, 'port_busy', port]);
      assert(String((view.problem as Json).message).includes(`Port ${port} is busy`));
      assertEquals(readRemotePort(s.state), port, 'not swapped for another port');
      held.close();
      await pc(s, 'POST', '/api/live/devices/check', {});
      const [, again] = await pc(s, 'GET', '/api/live/devices');
      assertEquals([again.listening, again.port, again.problem], [true, port, null]);
      assertEquals(s.phonePort(), port);
      // turning it off closes the port
      await pc(s, 'POST', '/api/live/devices/access', { on: false });
      assertEquals(s.ctx.phone.server, null);
    } finally {
      try {
        held.close();
      } catch { /* closed */ }
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'phone access is off by default; Add a phone needs it on; the PC routes need the page token',
  async fn() {
    const fake = fakeTailscale();
    const s = await remoteStudio({ runner: fake.runner });
    try {
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals([view.on, view.listening, view.devices], [false, false, []]);
      assertEquals(fake.calls, [], 'Tailscale is not even read while phone access is off');
      const [status, body] = await pc(s, 'POST', '/api/live/devices/pair', {});
      assertEquals([status, body.code], [409, 'not_ready']);
      const noToken = await fetch(`http://127.0.0.1:${s.port}/api/live/devices`);
      assertEquals(noToken.status, 403);
      await noToken.body?.cancel();
    } finally {
      await s.close();
    }
  },
});
