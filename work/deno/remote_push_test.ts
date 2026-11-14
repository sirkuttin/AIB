/**
 * Phone pushes (phase C, server/remote/push.ts) against a fake push service on a free port, with phones paired through the real
 * routes and a fake Tailscale CLI:
 *   - the test decrypts each push as the phone would (RFC 8291 aes128gcm with the phone's own keys) and checks the generic text,
 *     Urgency (high for Needs you), TTL (short for Needs you), Topic and the VAPID signature (RFC 8292, the PC's public key);
 *   - 410 from the push service deletes that phone's subscription; Remove phone drops its subscription with it; Remove all phones
 *     makes new VAPID keys; the Push switch off -> nothing is sent; the owner active at the PC -> nothing is sent;
 *   - the VAPID private key is never in the file in plain text on Windows (DPAPI), and the file store is owner-only elsewhere;
 *   - /manifest.webmanifest, /sw.js and the icons on the phone port with their types; never on the page port.
 */
import { assert, assertEquals } from './_assert.ts';
import { DEVICE_HEADER } from '../../outputs/agent-studio/server/remote/server.ts';
import { readRemotePort } from '../../outputs/agent-studio/server/remote/port.ts';
import { PUSH_KEYS_FILE, TOPIC, TTL_FINISHED, TTL_NEEDS, VapidKeys } from '../../outputs/agent-studio/server/remote/push.ts';
import { startAttention } from '../../outputs/agent-studio/server/attention/watcher.ts';
import { fakeTailscale, pairPhone, pc, phoneHeaders, raw, type RemoteStudio, remoteStudio, serveStatus } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;
const SEP = Deno.build.os === 'windows' ? '\\' : '/';
const enc = new TextEncoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (text: string): Uint8Array<ArrayBuffer> => {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const cat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

/** A phone's push subscription: its own ECDH key pair and auth secret (what PushManager.subscribe makes on a phone). */
async function phoneKeys(endpoint: string) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, subscription: { endpoint, expirationTime: null, keys: { p256dh: b64url(pub), auth: b64url(auth) } } };
}

/** RFC 8291 decryption, written here from the RFC (not the library's code): what the phone's browser does with a push. */
async function decrypt(body: Uint8Array<ArrayBuffer>, phone: Awaited<ReturnType<typeof phoneKeys>>): Promise<string> {
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const record = body.slice(21 + idlen);
  assertEquals(idlen, 65, 'keyid: the application server key');
  assert(record.length <= rs, 'one record');
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, phone.pair.privateKey, 256));
  const prkKey = await hmac(phone.auth, shared);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), phone.pub, asPublic, new Uint8Array([1])));
  const prk = await hmac(salt, ikm.slice(0, 32));
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, key, record));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assertEquals(plain[end], 2, 'the last record ends with the 0x02 delimiter');
  return new TextDecoder().decode(plain.slice(0, end));
}

/** The VAPID Authorization header: its JWT verifies with k (the PC's public key), aud is the push service's origin. */
async function checkVapid(header: string, endpoint: string, publicKey: string): Promise<void> {
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert(m, header);
  assertEquals(m![2], publicKey, "k is the PC's VAPID public key");
  const [h, p, sig] = m![1].split('.');
  const claims = JSON.parse(new TextDecoder().decode(unb64url(p)));
  assertEquals(claims.aud, new URL(endpoint).origin);
  assert(String(claims.sub).startsWith('mailto:') && !String(claims.sub).includes('owner'), "a placeholder contact, nobody's address");
  assert(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 86400);
  const raw = unb64url(publicKey);
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64url(raw.slice(1, 33)), y: b64url(raw.slice(33)) },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  assert(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, unb64url(sig), enc.encode(`${h}.${p}`)), 'JWT signature');
}

interface Got {
  path: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
}

/** A fake push service: http on a free port; the PC sends to https://127.0.0.1:<port>/... and the test's fetch goes plain http. */
function pushService() {
  const got: Got[] = [];
  const answer = new Map<string, number>(); // path -> status (default 201)
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen: () => {} }, async (request) => {
    const path = new URL(request.url).pathname;
    got.push({ path, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) });
    return new Response(null, { status: answer.get(path) ?? 201 });
  });
  const port = server.addr.port;
  const fetcher: typeof fetch = (input, init) => fetch(String(input).replace(/^https:/, 'http:'), init);
  return { got, answer, port, fetcher, endpoint: (p: string) => `https://127.0.0.1:${port}${p}`, close: () => server.shutdown() };
}

async function phoneOn(fetcher: typeof fetch): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner, pushFetch: fetcher });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  assertEquals((await pc(s, 'POST', '/api/live/devices/access', { on: true }))[0], 200);
  return s;
}

const subscribe = (s: RemoteStudio, token: string, subscription: unknown) =>
  raw(
    s.phonePort(),
    'POST',
    '/api/remote/push/subscribe',
    phoneHeaders({ [DEVICE_HEADER]: token }, 'POST'),
    JSON.stringify({ subscription }),
  );

const NEEDS = { title: 'A chat needs you', body: 'Blog site', tag: 'aib-attention', chat: 'c1', sheet: true };
const DONE = { title: 'Chat finished', body: 'Invoice parser', tag: 'aib-attention', chat: 'c2', sheet: false };

Deno.test({
  ...OPTS,
  name: 'push: encrypted to each phone (RFC 8291), generic text only, Urgency and TTL by kind, VAPID-signed; 410 deletes; Remove drops',
  async fn() {
    const svc = pushService();
    const s = await phoneOn(svc.fetcher);
    try {
      const a = await pairPhone(s, 'Pixel 9');
      const b = await pairPhone(s, 'Pixel 8');
      const ka = await phoneKeys(svc.endpoint('/fcm/a'));
      const kb = await phoneKeys(svc.endpoint('/fcm/b'));
      // the phone learns the key it subscribes with from its bootstrap
      const boot = await raw(s.phonePort(), 'GET', '/api/remote/bootstrap', phoneHeaders({ [DEVICE_HEADER]: a.token }));
      const publicKey = await s.ctx.phone.vapid.publicKey();
      assertEquals(boot.json.push, { key: publicKey, on: false });
      assertEquals((await subscribe(s, a.token, ka.subscription)).status, 200);
      assertEquals((await subscribe(s, b.token, kb.subscription)).status, 200);
      assertEquals((await subscribe(s, b.token, { endpoint: 'http://plain.example/x', keys: kb.subscription.keys })).status, 400);
      const [, view] = await pc(s, 'GET', '/api/live/devices');
      assertEquals((view.devices as Json[]).map((d) => [d.name, d.pushOn]), [['Pixel 9', true], ['Pixel 8', true]]);
      assert(!JSON.stringify(view).includes(ka.subscription.keys.auth), 'Settings never gets a subscription key');

      await s.ctx.phone.push.send(NEEDS);
      assertEquals(svc.got.map((g) => g.path).sort(), ['/fcm/a', '/fcm/b']);
      for (const g of svc.got) {
        const keys = g.path === '/fcm/a' ? ka : kb;
        assertEquals(JSON.parse(await decrypt(g.body, keys)), NEEDS, 'only the generic words and the title');
        assertEquals(g.headers.get('content-encoding'), 'aes128gcm');
        assertEquals(g.headers.get('urgency'), 'high');
        assertEquals(g.headers.get('ttl'), String(TTL_NEEDS));
        assertEquals(g.headers.get('topic'), TOPIC);
        await checkVapid(g.headers.get('authorization')!, keys.subscription.endpoint, publicKey);
      }
      assert(TTL_NEEDS <= 600, 'a short time to live for Needs you');
      // a fresh application-server key for each message (RFC 8291)
      assert(String(svc.got[0].body.slice(21, 86)) !== String(svc.got[1].body.slice(21, 86)));

      svc.got.length = 0;
      svc.answer.set('/fcm/b', 410); // the phone unsubscribed or the browser was reset
      await s.ctx.phone.push.send(DONE);
      const done = svc.got.find((g) => g.path === '/fcm/a')!;
      assertEquals(JSON.parse(await decrypt(done.body, ka)), DONE);
      assertEquals([done.headers.get('urgency'), done.headers.get('ttl')], ['normal', String(TTL_FINISHED)]);
      const [, after] = await pc(s, 'GET', '/api/live/devices');
      assertEquals((after.devices as Json[]).map((d) => [d.name, d.pushOn]), [['Pixel 9', true], ['Pixel 8', false]], '410 deleted it');
      svc.got.length = 0;
      await s.ctx.phone.push.send(NEEDS);
      assertEquals(svc.got.map((g) => g.path), ['/fcm/a'], 'never sent to a gone subscription again');

      // the Push switch off for a phone: nothing is sent to it (its subscription stays for when it is turned on again)
      assertEquals((await pc(s, 'POST', '/api/live/devices/scopes', { id: a.id, scopes: ['phone.read', 'phone.prompt'] }))[0], 200);
      svc.got.length = 0;
      await s.ctx.phone.push.send(NEEDS);
      assertEquals(svc.got.length, 0, 'Push off');
      const refused = await subscribe(s, a.token, ka.subscription);
      assertEquals([refused.status, refused.json.code], [403, 'scope']);
      await pc(s, 'POST', '/api/live/devices/scopes', { id: a.id, scopes: ['phone.read', 'phone.push'] });
      await s.ctx.phone.push.send(NEEDS);
      assertEquals(svc.got.length, 1, 'Push on again');

      // Remove phone: its subscription goes with it
      await pc(s, 'POST', '/api/live/devices/remove', { id: a.id });
      svc.got.length = 0;
      await s.ctx.phone.push.send(NEEDS);
      assertEquals(svc.got.length, 0);
      assertEquals(s.ctx.devices.pushTargets(), []);
      const file = Deno.readTextFileSync(`${s.state}${SEP}devices.json`);
      assert(!file.includes(ka.subscription.endpoint), 'no subscription of a removed phone is kept');
      const log = await pc(s, 'GET', '/api/live/devices/activity');
      assert((log[1].entries as Json[]).some((e) => e.action === 'notifications' && e.result === 'turned on on the phone'));
    } finally {
      await s.close();
      await svc.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'push keys: their own file, private key sealed (DPAPI on Windows) or owner-only; Remove all phones makes new ones',
  async fn() {
    const svc = pushService();
    const s = await phoneOn(svc.fetcher);
    try {
      const first = await s.ctx.phone.vapid.publicKey();
      const path = `${s.state}${SEP}${PUSH_KEYS_FILE}`;
      const saved = JSON.parse(Deno.readTextFileSync(path));
      assertEquals(saved.publicKey, first);
      if (Deno.build.os === 'windows') {
        assertEquals(saved.store, 'dpapi');
        assert(String(saved.privateKey).startsWith('dpapi:v1:'), 'sealed for this Windows account');
      } else {
        assertEquals(saved.store, 'file');
        assertEquals(Deno.statSync(path).mode! & 0o777, 0o600);
      }
      // not in the agents' key store (studio-settings.json / beta-keys.json): saving agent keys never touches push keys
      for (const other of ['studio-settings.json', 'beta-keys.json']) {
        let text = '';
        try {
          text = Deno.readTextFileSync(`${s.state}${SEP}${other}`);
        } catch { /* not made in this test */ }
        assert(!text.includes(first) && !text.includes(String(saved.privateKey)), other);
      }
      // the same keys after a restart (a new process reads the file)
      assertEquals(await new VapidKeys(s.state).publicKey(), first);
      await pairPhone(s);
      assertEquals((await pc(s, 'POST', '/api/live/devices/remove-all', {}))[0], 200);
      const second = await s.ctx.phone.vapid.publicKey();
      assert(second !== first, 'new push keys');
      assertEquals(JSON.parse(Deno.readTextFileSync(path)).publicKey, second);
      assertEquals(await new VapidKeys(s.state).publicKey(), second);
    } finally {
      await s.close();
      await svc.close();
    }
    // the file store (macOS, Linux) works the same, and is owner-only
    const dir = Deno.realPathSync(Deno.makeTempDirSync({ prefix: 'aib-pushkeys-' }));
    Deno.env.set('AIB_PUSH_KEY_STORE', 'file');
    try {
      const k = await new VapidKeys(dir).publicKey();
      const saved = JSON.parse(Deno.readTextFileSync(`${dir}${SEP}${PUSH_KEYS_FILE}`));
      assertEquals([saved.store, String(saved.privateKey).startsWith('file:v1:')], ['file', true]);
      assertEquals(await new VapidKeys(dir).publicKey(), k);
    } finally {
      Deno.env.delete('AIB_PUSH_KEY_STORE');
      Deno.removeSync(dir, { recursive: true });
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'push from the watcher: a chat that needs you is pushed once; nothing while the owner is active at the PC',
  async fn() {
    const svc = pushService();
    const s = await phoneOn(svc.fetcher);
    const watcher = startAttention(s.ctx, { pollMs: 50 });
    try {
      const phone = await pairPhone(s);
      const keys = await phoneKeys(svc.endpoint('/p'));
      await subscribe(s, phone.token, keys.subscription);
      // active at the PC: focused AIB window and input just now
      s.ctx.presence.report(true, 0);
      s.chats.push({
        id: 'c1',
        provider: 'claude',
        sessionId: 's1',
        cwd: 'C:\\code\\blog',
        busy: false,
        closed: false,
        attention: { state: 'needs_you', needs: 1, turnEndedAt: null, busySince: null },
        subagents: {},
        breadth: { sessionInfo: { title: 'Blog site' } },
        events: [],
        permissions: [{ key: 'k1', params: {} }],
        elicitations: [],
      });
      await new Promise((r) => setTimeout(r, 600));
      assertEquals(svc.got.length, 0, 'active at the PC: no push');
      // away: the next request is pushed, once
      s.ctx.presence.report(false, 0);
      s.chats[0].permissions.push({ key: 'k2', params: {} });
      s.chats[0].attention = { ...s.chats[0].attention, needs: 2 };
      const deadline = Date.now() + 10_000;
      while (!svc.got.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      await new Promise((r) => setTimeout(r, 400));
      assertEquals(svc.got.length, 1);
      assertEquals(JSON.parse(await decrypt(svc.got[0].body, keys)), {
        title: 'A chat needs you',
        body: 'Blog site',
        tag: 'aib-attention',
        chat: 'c1',
        sheet: true,
      });
    } finally {
      await watcher.stop();
      await s.close();
      await svc.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'manifest, service worker and icons: on the phone port with their types and root scope; never on the page port',
  async fn() {
    const svc = pushService();
    const s = await phoneOn(svc.fetcher);
    try {
      const get = (path: string, extra: Record<string, string> = {}) =>
        raw(s.phonePort(), 'GET', path, phoneHeaders({ 'Sec-Fetch-Mode': 'no-cors', ...extra }));
      const m = await get('/manifest.webmanifest', { 'Sec-Fetch-Dest': 'manifest', 'Sec-Fetch-Mode': 'cors' });
      assertEquals(m.status, 200);
      assertEquals(m.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
      assertEquals([m.json.display, m.json.start_url, m.json.scope, m.json.short_name], ['standalone', '/phone.html', '/', 'AIB']);
      // installable: 192 and 512 for any use, and maskable 192 and 512 (Android's circle or squircle)
      const icons = m.json.icons as Json[];
      for (const want of ['192x192 any', '512x512 any', '192x192 maskable', '512x512 maskable']) {
        assert(icons.some((i) => `${i.sizes} ${i.purpose}` === want), want);
      }
      assert(m.json.background_color && m.json.theme_color && m.json.id === '/phone.html', 'colours and id');
      const sizeOf = (b: Uint8Array) => {
        const v = new DataView(b.buffer, b.byteOffset);
        return `${v.getUint32(16)}x${v.getUint32(20)}`;
      };
      const extra = [{ src: '/icons/apple-touch-180.png', sizes: '180x180' }, { src: '/icons/badge-96.png', sizes: '96x96' }];
      for (const icon of [...icons, ...extra]) {
        const r = await get(String(icon.src), { 'Sec-Fetch-Dest': 'image' });
        assertEquals([r.status, r.headers.get('content-type')], [200, 'image/png'], String(icon.src));
        assertEquals([...r.bytes.slice(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
        assertEquals(sizeOf(r.bytes), String(icon.sizes), `${icon.src}: the size it says`);
      }
      const sw = await get('/sw.js', { 'Sec-Fetch-Dest': 'serviceworker', 'Service-Worker': 'script' });
      assertEquals(sw.status, 200);
      assertEquals(sw.headers.get('content-type'), 'text/javascript; charset=utf-8');
      assertEquals(sw.headers.get('service-worker-allowed'), '/');
      assert(sw.text.includes("addEventListener('push'"), 'the service worker itself');
      const html = await get('/phone.html', { 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Site': 'none' });
      assert(html.text.includes('<link rel="manifest" href="/manifest.webmanifest">'));
      assert(html.text.includes('<link rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-180.png">'), 'iPhone icon 180');
      assert(sw.text.includes("badge: '/icons/badge-96.png'"), 'the worker gives notifications a badge');
      // a wrong Host (not through Serve) is refused for these too
      assertEquals((await get('/sw.js', { Host: `127.0.0.1:${s.phonePort()}` })).status, 403);
      // the page port: none of them
      for (const path of ['/sw.js', '/manifest.webmanifest', '/pwa/sw.js', ...icons.map((i) => String(i.src)), ...extra.map((i) => i.src)]) {
        const r = await fetch(`http://127.0.0.1:${s.port}${path}`);
        await r.body?.cancel();
        assertEquals(r.status, 404, path);
      }
    } finally {
      await s.close();
      await svc.close();
    }
  },
});
