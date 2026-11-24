/**
 * A computer keeps no long-lived device key in its browser profile (security fix 2026-11-23; remote/server.ts #pcSession,
 * remote/devices.ts sessions). No browser: the HTTP routes against an in-process AIB with Tailscale Serve's headers forged.
 *   - a computer approved as a computer is handed a SESSION (and the HttpOnly cookie), never a long-lived key; a phone is handed its key
 *     as before;
 *   - POST /api/remote/pc/session needs the cookie and the X-AIB-Session header, and only a computer gets one;
 *   - POST /api/remote/pc/adopt (the migration of an older computer): its stored key is traded once for the cookie and a session, and
 *     the key stops working; a session token or a phone cannot adopt;
 *   - sessions end (12 h; a removed device's at once) and are never written to devices.json;
 *   - a computer's notification button goes with its cookie; a phone's still needs its key.
 */
import { assert, assertEquals } from './_assert.ts';
import { DEVICE_HEADER, COOKIE_NAME } from '../../app/server/remote/server.ts';
import { DeviceStore, SESSION_SECONDS } from '../../app/server/remote/devices.ts';
import { readRemotePort } from '../../app/server/remote/port.ts';
import { fakeTailscale, pairComputer, pairPhone, pc, phoneHeaders, raw, type RemoteStudio, remoteStudio, serveStatus } from './_remote_fixture.ts';

const OPTS = { sanitizeResources: false, sanitizeOps: false };
type Json = Record<string, unknown>;

async function remoteOn(): Promise<RemoteStudio> {
  const fake = fakeTailscale();
  const s = await remoteStudio({ runner: fake.runner }, undefined, { saved: true });
  fake.state.serve = serveStatus(readRemotePort(s.state)!);
  const [status] = await pc(s, 'POST', '/api/live/devices/access', { on: true });
  assertEquals(status, 200);
  return s;
}
const bootstrap = (s: RemoteStudio, token: string) =>
  raw(s.phonePort(), 'GET', '/api/remote/pc/bootstrap', { ...phoneHeaders({}, 'GET'), [DEVICE_HEADER]: token });
const sessionCall = (s: RemoteStudio, headers: Record<string, string>) =>
  raw(s.phonePort(), 'POST', '/api/remote/pc/session', { ...phoneHeaders({}, 'POST'), ...headers }, '{}');
const adoptCall = (s: RemoteStudio, token: string) =>
  raw(s.phonePort(), 'POST', '/api/remote/pc/adopt', { ...phoneHeaders({}, 'POST'), [DEVICE_HEADER]: token }, '{}');
const cookieOf = (r: { headers: Headers }) => (r.headers.get('set-cookie') ?? '').match(/__Host-aib-phone=([^;]+)/)?.[1] ?? '';
const cookieHeader = (value: string) => ({ Cookie: `${COOKIE_NAME}=${value}` });

Deno.test({
  ...OPTS,
  name: 'a computer approved as a computer gets a session and the cookie, never a long-lived key; sessions come from the cookie',
  async fn() {
    const s = await remoteOn();
    try {
      const laptop = await pairComputer(s);
      assertEquals(laptop.session, true, 'the pairing answer says it is a session');
      assertEquals((await bootstrap(s, laptop.token)).status, 200, 'the session works');
      assert(laptop.cookie.length > 20, 'the cookie came with it');
      // the phone is handed its key, as before
      const phone = await pairPhone(s);
      assertEquals(phone.session, false);
      assertEquals((await raw(s.phonePort(), 'GET', '/api/remote/bootstrap', { ...phoneHeaders({}, 'GET'), [DEVICE_HEADER]: phone.token })).status, 200);

      // /session: the cookie and the header
      const ok = await sessionCall(s, { ...cookieHeader(laptop.cookie), 'X-AIB-Session': '1' });
      assertEquals(ok.status, 200, ok.text);
      const fresh = String(ok.json.token);
      assert(fresh && fresh !== laptop.token && ok.json.expiresIn === SESSION_SECONDS);
      assert(/HttpOnly/i.test(ok.headers.get('set-cookie') ?? '') && /SameSite=Strict/i.test(ok.headers.get('set-cookie') ?? ''), 'the cookie stays HttpOnly, SameSite=Strict');
      assertEquals((await bootstrap(s, fresh)).status, 200, 'the new session works');
      assertEquals((await bootstrap(s, laptop.token)).status, 200, 'the earlier one too (it ends by time, not by renewal)');
      assertEquals((await sessionCall(s, cookieHeader(laptop.cookie))).status, 400, 'without X-AIB-Session (a cross-site form post cannot send it)');
      assertEquals((await sessionCall(s, { 'X-AIB-Session': '1' })).status, 401, 'without the cookie');
      assertEquals((await sessionCall(s, { ...cookieHeader('not-the-cookie'), 'X-AIB-Session': '1' })).status, 401, 'a wrong cookie');
      // the header alone (a session token is not a cookie)
      assertEquals((await sessionCall(s, { [DEVICE_HEADER]: laptop.token, 'X-AIB-Session': '1' })).status, 401);
      // a phone's cookie is no computer's
      const asPhone = await sessionCall(s, { ...cookieHeader(phone.cookie), 'X-AIB-Session': '1' });
      assertEquals(asPhone.status, 403);
      assertEquals(asPhone.json.code, 'not_computer');
      // a removed computer's cookie and sessions are dead at once
      const [removed] = await pc(s, 'POST', '/api/live/devices/remove', { id: laptop.id });
      assertEquals(removed, 200);
      assertEquals((await bootstrap(s, fresh)).status, 401);
      assertEquals((await sessionCall(s, { ...cookieHeader(laptop.cookie), 'X-AIB-Session': '1' })).status, 401);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'migration: an older computer trades its stored key once for the cookie and a session; the key stops working',
  async fn() {
    const s = await remoteOn();
    try {
      const old = await pairPhone(s, 'Laptop (Edge)', undefined, 'computer'); // paired before sessions: token is the long-lived key
      assertEquals((await bootstrap(s, old.token)).status, 200, 'the long-lived key works before the trade');
      const phone = await pairPhone(s);
      const asPhone = await adoptCall(s, phone.token);
      assertEquals(asPhone.status, 403, 'a phone cannot adopt');
      assertEquals(asPhone.json.code, 'not_computer');
      assertEquals((await adoptCall(s, 'not-a-key')).status, 401);
      assertEquals((await raw(s.phonePort(), 'POST', '/api/remote/pc/adopt', phoneHeaders({}, 'POST'), '{}')).status, 401, 'no key');

      const done = await adoptCall(s, old.token);
      assertEquals(done.status, 200, done.text);
      const session = String(done.json.token);
      const cookie = cookieOf(done);
      assert(session && session !== old.token && cookie && cookie !== old.cookie, 'a session and a new cookie');
      assertEquals((await bootstrap(s, session)).status, 200, 'the session works');
      assertEquals((await bootstrap(s, old.token)).status, 401, 'the old key is dead');
      assertEquals((await sessionCall(s, { ...cookieHeader(old.cookie), 'X-AIB-Session': '1' })).status, 401, 'the old cookie is dead');
      assertEquals((await sessionCall(s, { ...cookieHeader(cookie), 'X-AIB-Session': '1' })).status, 200, 'the new cookie makes sessions');
      // a session token cannot adopt: it would turn a short session into a lasting cookie
      assertEquals((await adoptCall(s, session)).status, 401);
      // the owner can still switch the device (Settings > Devices): as a phone it has no key left, so no session works for it
      const [kind] = await pc(s, 'POST', '/api/live/devices/kind', { id: old.id, kind: 'phone' });
      assertEquals(kind, 200);
      assertEquals((await bootstrap(s, session)).status, 401);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'a computer presses a notification button with its cookie; a phone still needs its key',
  async fn() {
    const s = await remoteOn();
    try {
      const laptop = await pairComputer(s);
      const phone = await pairPhone(s);
      const act = (headers: Record<string, string>) =>
        raw(s.phonePort(), 'POST', '/api/remote/notify-act', { ...phoneHeaders({}, 'POST'), ...headers }, JSON.stringify({ key: 'nope', act: 'allow', code: 'x' }));
      // past the key check (a bad body is a 400, never a 401)
      assertEquals((await act(cookieHeader(laptop.cookie))).status, 400, 'the computer is known by its cookie');
      assertEquals((await act({})).status, 401, 'nobody');
      assertEquals((await act(cookieHeader(phone.cookie))).status, 401, "a phone's cookie is not enough: it needs its key");
      assertEquals((await act({ [DEVICE_HEADER]: phone.token })).status, 400);
    } finally {
      await s.close();
    }
  },
});

Deno.test({
  ...OPTS,
  name: 'sessions end after their time, are never written to devices.json, and a restart ends them',
  async fn() {
    const dir = Deno.makeTempDirSync({ prefix: 'aib-sessions-' });
    try {
      let at = 1_000_000;
      const store = new DeviceStore(dir, () => at);
      const { device } = await store.add({ name: 'Laptop', login: 'a@b', scopes: ['phone.read'], kind: 'computer' });
      const phone = await store.add({ name: 'Phone', login: 'a@b', scopes: ['phone.read'] });
      assertEquals(store.issueSession(phone.device.id), null, 'a phone has no sessions');
      const token = store.issueSession(device.id)!;
      assertEquals(store.byToken(token)?.id, device.id);
      assertEquals(store.byPermanentToken(token), null, 'a session is not the long-lived key');
      assert(!Deno.readTextFileSync(`${dir}/devices.json`).includes(token), 'never written to the file');
      at += SESSION_SECONDS - 1;
      assertEquals(store.byToken(token)?.id, device.id, 'still good just before the end');
      at += 2;
      assertEquals(store.byToken(token), null, 'ended');
      // a restart: a new store has no sessions
      const live = store.issueSession(device.id)!;
      assertEquals(new DeviceStore(dir, () => at).byToken(live), null);
      // at most a few at once: the oldest go
      const many = Array.from({ length: 20 }, () => store.issueSession(device.id)!);
      assertEquals(store.byToken(many[0]), null, 'the oldest was dropped');
      assertEquals(store.byToken(many[19])?.id, device.id);
    } finally {
      Deno.removeSync(dir, { recursive: true });
    }
  },
});
