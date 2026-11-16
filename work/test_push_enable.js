'use strict';
/* Turning notifications on: every failure has one plain line with the fix (push-enable.js), the Brave line, the PC's refusal
   naming the push service, and the pairing page's computer / phone guess (phone.js guessKind). Browser objects are mocks. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  path = require('node:path');
const PE = require(path.join(APP, 'push-enable.js'));
const P = require(path.join(APP, 'phone.js'));
const M = PE.MESSAGES;

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc';
function env(over = {}) {
  const sub = { toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }) };
  const calls = { requested: 0, sent: [] };
  const e = {
    navigator: { serviceWorker: {} },
    PushManager: function () {},
    Notification: Object.assign(function () {}, {
      permission: 'default',
      requestPermission: async () => {
        calls.requested++;
        return 'granted';
      },
    }),
    keyBytes: (t) => new Uint8Array([t.length]),
    pcName: 'My PC',
    getKey: async () => 'KEY',
    register: async () => ({
      pushManager: { getSubscription: async () => null, subscribe: async () => sub },
      showNotification: async (t, o) => calls.shown = [t, o],
    }),
    send: async (s) => {
      calls.sent.push(s);
      return { ok: true, status: 200, data: { ok: true } };
    },
    ...over,
  };
  return { e, calls };
}
const fails = async (e, line) => assert.rejects(PE.enable(e), (err) => err.message === line);

test('success: permission asked, subscription sent, endpoint returned', async () => {
  const { e, calls } = env();
  const r = await PE.enable(e);
  assert.equal(r.endpoint, ENDPOINT);
  assert.equal(calls.requested, 1);
  assert.equal(calls.sent.length, 1);
});

test('permission denied already: the blocked line, no prompt', async () => {
  const { e, calls } = env();
  e.Notification.permission = 'denied';
  await fails(e, M.blocked);
  assert.equal(calls.requested, 0);
  assert.match(M.blocked, /Allow them in the browser's site settings, then try again\.$/);
});

test('permission denied or dismissed at the prompt: the blocked line', async () => {
  for (const answer of ['denied', 'default']) {
    const { e } = env();
    e.Notification.requestPermission = async () => answer;
    await fails(e, M.blocked);
  }
});

test('no service worker, or no PushManager: the unsupported line', async () => {
  await fails(env({ navigator: {} }).e, "This browser can't receive push notifications here.");
  await fails(env({ PushManager: undefined }).e, M.unsupported);
});

test('Brave: subscribe rejecting gives the Brave line (AbortError or registration failure)', async () => {
  for (const err of [Object.assign(new Error('Registration failed - push service error'), { name: 'AbortError' }), new Error('boom')]) {
    const { e } = env();
    e.navigator = { serviceWorker: {}, brave: { isBrave: async () => true } };
    e.register = async () => ({ pushManager: { getSubscription: async () => null, subscribe: async () => { throw err; } } });
    await fails(e, "Brave blocks push notifications until you turn on 'Use Google services for push messaging' in brave://settings/privacy, then restart Brave.");
  }
});

test('not Brave: an AbortError names the push service and keeps the browser text', async () => {
  const { e } = env();
  e.register = async () => ({
    pushManager: { getSubscription: async () => null, subscribe: async () => { throw Object.assign(new Error('Registration failed - push service error'), { name: 'AbortError' }); } },
  });
  await assert.rejects(PE.enable(e), /push service refused to register this computer \(Registration failed - push service error\)/);
});

test('the PC refuses the endpoint: the line says which push service and the reason', async () => {
  const { e } = env({ send: async () => ({ ok: false, status: 400, data: { error: 'not allowed here', code: 'invalid' } }) });
  await fails(e, 'The PC refused this notification address (push service fcm.googleapis.com): not allowed here');
  assert.equal(
    PE.refusedMessage(400, { error: 'evil.example is not a push service AIB can send to.', code: 'push_service' }, 'https://evil.example/x'),
    'evil.example is not a push service AIB can send to.',
  );
  assert.equal(PE.refusedMessage(502, {}, ENDPOINT), 'The PC refused this notification address (push service fcm.googleapis.com): HTTP 502');
});

test('PC not reachable (no key): the Can\'t reach line', async () => {
  await fails(env({ getKey: async () => '' }).e, "Can't reach My PC. Try again.");
});

test('test notification: shown when granted, blocked line otherwise', async () => {
  const { e, calls } = env();
  e.Notification.permission = 'granted';
  await PE.showTest(e);
  assert.equal(calls.shown[0], 'AIB');
  e.Notification.permission = 'denied';
  await assert.rejects(PE.showTest(e), (err) => err.message === M.blocked);
});

test('server: the allowlist holds the push services of the browsers, with a reason for a refusal', async () => {
  // the server side is in work/deno/remote_push_test.ts (pushSubProblem); the phone page checks the host line here
  assert.equal(PE.hostOf(ENDPOINT), 'fcm.googleapis.com');
  assert.equal(PE.hostOf('nonsense'), '');
});

test('pairing page guess: a narrow desktop window is a computer', () => {
  const linux = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
  assert.equal(P.guessKind({ ua: linux, fine: true, coarse: false }), 'computer'); // 500 px app window: width is not asked
  assert.equal(P.guessKind({ ua: linux, fine: false, coarse: false }), 'computer'); // no pointer facts, desktop UA
  assert.equal(P.guessKind({ ua: 'Mozilla/5.0 (Linux; Android 14; Pixel) Mobile Safari', fine: false, coarse: true }), 'phone');
  assert.equal(P.guessKind({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', fine: false, coarse: true }), 'phone');
  assert.equal(P.guessKind({ ua: 'Mozilla/5.0 (Macintosh)', fine: false, coarse: true, iPadOS: true }), 'phone');
  assert.equal(P.guessKind({ ua: linux, fine: false, coarse: true }), 'phone'); // coarse only
});
