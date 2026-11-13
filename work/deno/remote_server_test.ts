/**
 * The phone port (server/remote/server.ts) in a Studio in this process with a fake agent host and a fake Tailscale CLI:
 *  - default deny: every page route (ROUTE_LIST), both WebSockets and the own-gate POSTs answer 403/404 here; REMOTE_ROUTES are not in
 *    the page's table;
 *  - RemoteGate refusals (Host, Origin, Fetch Metadata, page credentials, login header, device token, cookie, removed phone);
 *  - pairing over HTTP (second claim, reject, approve), home (one list by change of state, project, unread, last line, size budget) and chat payloads (tail, no image bytes, 304),
 *    images by cookie only;
 *  - Funnel on: no listener; a busy phone port: reported, the saved port kept, and taken once free;
 *  - no answer here ever carries the page token.
 */
import { assert, assertEquals } from './_assert.ts';
import { ROUTE_LIST } from '../../outputs/agent-studio/server/web/routes.ts';
import { COOKIE_NAME, DEVICE_HEADER, REMOTE_ROUTES } from '../../outputs/agent-studio/server/remote/server.ts';
import { readRemotePort, saveRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { HOME_BUDGET, lineOf, StateTimes } from '../../outputs/agent-studio/server/remote/payloads.ts';
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

async function phoneOn(
  over: Parameters<typeof remoteStudio>[0] = {},
  root?: string,
  extra: { saved?: boolean } = {},
): Promise<RemoteStudio & { fake: ReturnType<typeof fakeTailscale> }> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner, ...over }, root, extra);
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
      // the phone page itself, opened from a link in another app (camera QR result, chat app): a top-level cross-site navigation
      // is allowed for the static page; a cross-site sub-resource or a non-navigation stays refused
      const page = (h: Record<string, string | null>) => raw(port, 'GET', '/phone.html', phoneHeaders(h));
      const nav = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
      assertEquals((await page({ ...nav, 'Sec-Fetch-Site': 'cross-site' })).status, 200, 'page opened from another app');
      assertEquals((await page({ ...nav, 'Sec-Fetch-Site': 'same-site' })).status, 200, 'page opened from the artifact origin');
      assertEquals((await page({ 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script' })).status, 403);
      assertEquals((await page({ ...nav, 'Sec-Fetch-Dest': 'iframe', 'Sec-Fetch-Site': 'cross-site' })).status, 403, 'framed elsewhere');
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
        ['phone.read', 'phone.answer', 'phone.prompt', 'phone.start', 'phone.approve', 'phone.push'],
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
  name: 'home: one list, newest change of state first; project (name, colour, no path), unread, last line; archived left out; 304',
  async fn() {
    const s = await phoneOn();
    try {
      const phone = await pairPhone(s);
      const port = s.phonePort();
      const ended = new Date().toISOString(); // after this AIB started: unread until read on the PC
      const tool = (seq: number, id: string, title: string, status: string) => ({
        seq,
        kind: 'update',
        time: seq,
        data: { update: { sessionUpdate: 'tool_call', toolCallId: id, title, status } },
      });
      const say = (seq: number, text: string) => ({
        seq,
        kind: 'update',
        time: seq,
        data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
      });
      s.chats.push(
        chat('a', {
          breadth: { sessionInfo: { title: 'Tidy up' } },
          attention: { state: 'idle', needs: 0, turnEndedAt: ended, busySince: null },
          events: [{ seq: 1, kind: 'user', time: 1, data: { text: 'Tidy up' } }, say(2, 'All done.')],
        }),
        chat('b', {
          busy: true,
          cwd: 'C:\\code\\blog',
          attention: { state: 'working', needs: 0, turnEndedAt: null, busySince: new Date(Date.now() - 3600_000).toISOString() },
          subagents: { s1: { title: 'Codex · tests', state: 'running' } },
          breadth: { sessionInfo: { title: 'Main · checkout redesign' } },
          events: [tool(1, 't1', 'Read a.ts', 'completed'), tool(2, 't2', 'Run tests', 'in_progress')],
        }),
        chat('c', {
          attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: '2026-11-12T09:00:00Z' },
          elicitations: [{ key: 'q', params: { message: 'Which date format?' } }],
        }),
        chat('d', { sessionId: 'archived' }),
        chat('e', { closed: true }),
      );
      await s.ctx.conversations.apply('archive', 'claude', 'archived', '', '', true).catch(() => {});
      const get = (rev = '') =>
        raw(port, 'GET', `/api/remote/home${rev ? '?rev=' + rev : ''}`, phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      const first = await get();
      const home = first.json;
      const chats = home.chats as Json[];
      // c asks now (newest change), b started at 11:00 today, a ended just before: by when each last changed state
      const byTime = [...chats].sort((x, y) => Date.parse(y.changedAt as string) - Date.parse(x.changedAt as string));
      assertEquals(chats.map((c) => c.id), byTime.map((c) => c.id), 'newest change of state first');
      assertEquals(chats.map((c) => c.id).sort(), ['a', 'b', 'c'], 'archived and closed left out');
      assertEquals(chats[0].id, 'c', 'asking is the newest change');
      assert(!('main' in home), 'no main chat');
      const of = (id: string) => chats.find((c) => c.id === id)!;
      assertEquals(of('b').title, 'Main · checkout redesign');
      assertEquals(of('c').title, 'Claude Code in shop', 'no title yet: agent and folder');
      const pa = of('a').project as Json, pb = of('b').project as Json;
      assertEquals([pa.name, pb.name], ['shop', 'blog']);
      assert(/^[0-9a-f]{12}$/.test(pa.id as string) && pa.id !== pb.id, 'a short project id each');
      assert(['blue', 'sky', 'teal', 'indigo', 'violet', 'orchid', 'pink', 'slate'].includes(pa.color as string), `colour ${pa.color}`);
      assert(!first.text.includes('C:'), 'no folder path');
      assertEquals([of('a').unread, of('b').unread, of('c').unread], [true, false, false]);
      assertEquals(of('a').line, 'All done.');
      assertEquals(of('b').line, 'Working on: Run tests');
      assertEquals(of('c').line, 'Asks: Which date format?');
      assertEquals((await get(home.revision as string)).status, 304);
      // a new step is not a change of state: b keeps its time
      s.chats[1].events.push(tool(3, 't3', 'Edit b.ts', 'in_progress'));
      const again = (await get()).json;
      assertEquals((again.chats as Json[]).find((c) => c.id === 'b')!.changedAt, of('b').changedAt);
      // read on the PC: no unread dot; you send in a: it starts working and goes to the top
      await s.ctx.readState.update({ set: { 'claude:sess-a': { seenAt: Date.now() + 1000 } } });
      s.chats[0].attention = { state: 'working', needs: 0, turnEndedAt: ended, busySince: new Date(Date.now() + 5000).toISOString() };
      const after = await get(home.revision as string);
      assertEquals(after.status, 200, 'a change gives a new revision');
      const list = after.json.chats as Json[];
      assertEquals(list[0].id, 'a');
      assertEquals(list[0].unread, false);
      for (const key of ['token', 'events', 'permissions', 'settings', 'cwd', 'projectRoot']) assert(!(key in chats[0]), key);
    } finally {
      await s.close();
    }
  },
});

Deno.test('state times: a change of state moves a chat (working from its start, finished at its end, asking when seen); steps do not', () => {
  let now = Date.parse('2026-11-12T12:00:00Z');
  const t = new StateTimes(() => now);
  const list = (attention: Record<string, unknown>) => ({ connections: [{ id: 'a', attention }] });
  t.see(list({ state: 'idle', turnEndedAt: '2026-11-12T10:00:00Z' }));
  assertEquals(t.changedAt('a', { state: 'idle', turnEndedAt: '2026-11-12T10:00:00Z' }), Date.parse('2026-11-12T10:00:00Z'));
  now += 60_000;
  t.see(list({ state: 'working', busySince: '2026-11-12T12:00:30Z' })); // you send: it starts working
  assertEquals(t.changedAt('a', { state: 'working', busySince: '2026-11-12T12:00:30Z' }), Date.parse('2026-11-12T12:00:30Z'));
  now += 60_000;
  t.see(list({ state: 'working', busySince: '2026-11-12T12:00:30Z' })); // another step: no change
  assertEquals(t.changedAt('a', { state: 'working', busySince: '2026-11-12T12:00:30Z' }), Date.parse('2026-11-12T12:00:30Z'));
  t.see(list({ state: 'needs_you', needs: 1 })); // asks: when seen
  assertEquals(t.changedAt('a', { state: 'needs_you' }), now);
  now += 60_000;
  t.see(list({ state: 'idle', turnEndedAt: '2026-11-12T12:02:30Z' })); // finishes
  assertEquals(t.changedAt('a', { state: 'idle', turnEndedAt: '2026-11-12T12:02:30Z' }), Date.parse('2026-11-12T12:02:30Z'));
  t.see({ connections: [] }); // gone: forgotten
  assertEquals(t.changedAt('a', { state: 'needs_you' }), now, 'seen again: from now');
});

Deno.test('card line: what it asks, the step it works on, else the last message', () => {
  const say = (seq: number, text: string) => ({ seq, kind: 'update', data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
  assertEquals(lineOf({ permissions: [{ params: { toolCall: { title: 'Run', rawInput: { command: 'npm test' } } } }] }), 'Wants to run: npm test');
  assertEquals(lineOf({ elicitations: [{ params: { message: 'Which layout?' } }] }), 'Asks: Which layout?');
  assertEquals(lineOf({ events: [{ seq: 1, kind: 'user', data: { text: 'Do it' } }] }), 'You: Do it');
  assertEquals(lineOf({ events: [say(1, 'Hel'), say(2, 'lo there')] }), 'Hello there');
  const running = { seq: 3, kind: 'update', data: { update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Edit a.ts', status: 'in_progress' } } };
  assertEquals(lineOf({ busy: true, events: [say(1, 'Ok'), running] }), 'Working on: Edit a.ts');
  assertEquals(lineOf({ events: [say(1, 'x'.repeat(400))] }).length, 140);
});

Deno.test({
  ...OPTS,
  name: 'home: many chats with long titles and lines stay under the size budget; saved chats carry their project',
  async fn() {
    const s = await phoneOn({}, undefined, { saved: true });
    try {
      const phone = await pairPhone(s);
      const port = s.phonePort();
      s.saveChat({ sessionId: 's-old', prompt: 'Old work', ageSeconds: 7200 });
      const long = 'word '.repeat(80);
      for (let i = 0; i < 120; i++) {
        s.chats.push(chat('c' + i, {
          cwd: s.project,
          breadth: { sessionInfo: { title: 'T'.repeat(160) + i } },
          events: [{
            seq: 1,
            kind: 'update',
            time: 1,
            data: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: long } } },
          }],
          attention: { state: 'idle', needs: 0, turnEndedAt: new Date(Date.now() - i * 1000).toISOString(), busySince: null },
        }));
      }
      const r = await raw(port, 'GET', '/api/remote/home', phoneHeaders({ [DEVICE_HEADER]: phone.token }));
      assertEquals(r.status, 200);
      assert(r.bytes.byteLength <= HOME_BUDGET + 16 * 1024, `${r.bytes.byteLength} bytes`);
      const chats = r.json.chats as Json[];
      assertEquals(chats.length, 120);
      assert((chats[0].line as string).length <= 140);
      const saved = r.json.saved as Json[];
      assertEquals(saved.map((c) => [c.key, (c.project as Json).name]), [['claude:s-old', 'shop']]);
      assertEquals((saved[0].project as Json).id, (chats[0].project as Json).id, 'the same project id for live and saved chats');
      assert(!r.text.includes(JSON.stringify(s.project).slice(1, -1)), 'no folder path');
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
