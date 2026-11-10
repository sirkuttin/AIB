// The desktop bridge (the deno desktop app's window bindings) with the bindings mocked: no real dialog or notification is shown.
const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const B = require(path.join(APP_DIR, 'desktop-bridge.js'));
const NP = require(path.join(APP_DIR, 'new-project-ui.js'));
const N = require(path.join(APP_DIR, 'notify-ui.js'));
const U = require(path.join(APP_DIR, 'updates-ui.js'));

function mockInvoke(answers) {
  const calls = [];
  B.setInvoke((name, args) => {
    calls.push([name, args]);
    const a = answers[name];
    if (a instanceof Error) return Promise.reject(a);
    return Promise.resolve(typeof a === 'function' ? a(...args) : a);
  });
  return calls;
}
test.afterEach(() => {
  B.setInvoke(null);
  delete globalThis.AibDesktop;
  delete globalThis.bindings;
});

test('in a browser nothing is available and every call says so', async () => {
  assert.equal(B.available(), false);
  await assert.rejects(B.pickFolder({}), /not available/);
  await assert.rejects(B.notify('a', 'b'), /not available/);
  assert.equal(await B.notifyReady(), false);
  assert.equal(await B.requestNotifications(), 'denied');
});

test('the app is detected by its window bindings, and calls go to them', async () => {
  const seen = [];
  globalThis.bindings = {
    aibNotify: (t, b) => (seen.push(['notify', t, b]), Promise.resolve(true)),
    aibNotifyReady: () => Promise.resolve(true),
    aibRequestNotifications: () => Promise.resolve('granted'),
  };
  assert.equal(B.available(), true);
  assert.equal(await B.notifyReady(), true);
  assert.equal(await B.requestNotifications(), 'granted');
  await B.notify('Chat b', 'It is your turn');
  assert.deepEqual(seen, [['notify', 'Chat b', 'It is your turn']]);
  globalThis.bindings = { other: () => 1 };
  assert.equal(B.available(), false, 'bindings without aibNotify are not the app');
});

test('pickFolder rejects even in the app: deno desktop has no folder dialog', async () => {
  mockInvoke({});
  assert.equal(B.available(), true);
  await assert.rejects(B.pickFolder({ start: 'C:\Temp' }), /not available/);
});

test('the New project dialog uses the server picker in the app and in a browser', async () => {
  const server = [];
  NP.init({ postJson: (name, body) => (server.push([name, body]), Promise.resolve({ path: 'D:\from-server' })) });
  assert.deepEqual(await NP.pickFolder('C:\a'), { path: 'D:\from-server' });
  globalThis.AibDesktop = B;
  mockInvoke({});
  assert.deepEqual(await NP.pickFolder('C:\a'), { path: 'D:\from-server' });
  assert.deepEqual(server, [
    ['folders/pick', { start: 'C:\a' }],
    ['folders/pick', { start: 'C:\a' }],
  ]);
});

test('notifications: the app bindings when present', async () => {
  const calls = mockInvoke({ aibNotifyReady: true, aibRequestNotifications: 'granted', aibNotify: true });
  assert.equal(await B.notifyReady(), true);
  assert.equal(await B.requestNotifications(), 'granted');
  await B.notify('Chat b', 'It is your turn');
  assert.deepEqual(calls.at(-1), ['aibNotify', ['Chat b', 'It is your turn']]);
  mockInvoke({ aibNotifyReady: null, aibRequestNotifications: 'default' });
  assert.equal(await B.notifyReady(), false);
  assert.equal(await B.requestNotifications(), 'denied');
  mockInvoke({ aibNotifyReady: new Error('x'), aibRequestNotifications: new Error('x') });
  assert.equal(await B.notifyReady(), false);
  assert.equal(await B.requestNotifications(), 'denied');
});

test('the link rule: http(s) on another origin is external', () => {
  const page = 'http://127.0.0.1:8777';
  assert.equal(B.isExternal('https://example.com/a', page), true);
  assert.equal(B.isExternal('http://127.0.0.1:8778/artifact', page), true, 'the artifact origin is another origin');
  assert.equal(B.isExternal('http://localhost:8777/', page), true);
  assert.equal(B.isExternal('/index.html', page), false);
  assert.equal(B.isExternal('http://127.0.0.1:8777/x?y', page), false);
  assert.equal(B.isExternal('mailto:a@b.c', page), false);
  assert.equal(B.isExternal('javascript:void 0', page), false);
  assert.equal(B.isExternal('http://[bad', page), false);
});

test('in the app a click on an external link opens it outside instead of navigating the window', () => {
  const opened = [];
  const realOpen = globalThis.open,
    realLoc = globalThis.location;
  globalThis.open = (...a) => (opened.push(a), null);
  globalThis.location = { origin: 'http://127.0.0.1:8777' };
  const link = (href, attrs = {}) => ({ tagName: 'A', href, hasAttribute: (n) => n in attrs, parentNode: null });
  const click = (target, o = {}) => {
    const ev = { target, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...o };
    B.onLinkClick(ev);
    return ev.defaultPrevented;
  };
  try {
    assert.equal(click(link('https://example.com/')), false, 'browser: untouched');
    mockInvoke({});
    assert.equal(click(link('https://example.com/')), true);
    assert.deepEqual(opened, [['https://example.com/', '_blank', 'noopener']]);
    const span = { tagName: 'SPAN', parentNode: link('https://example.org/') };
    assert.equal(click(span), true, 'a click inside the link counts');
    assert.equal(click(link('http://127.0.0.1:8777/index.html')), false, 'same origin stays');
    assert.equal(click(link('https://example.com/f.zip', { download: '' })), false, 'downloads stay');
    assert.equal(click(link('https://example.com/'), { button: 1 }), false, 'middle click stays');
    click(link('https://example.com/'), { defaultPrevented: true }); // another handler took it: not opened again
    assert.equal(opened.length, 2);
  } finally {
    globalThis.open = realOpen;
    if (realLoc === undefined) delete globalThis.location;
    else globalThis.location = realLoc;
  }
});

test('notify-ui shows through the app bindings in the desktop app and through the web API otherwise', () => {
  const chat = (key, o = {}) => ({
    key,
    title: 'Chat ' + key,
    state: 'idle',
    needs: 0,
    yourTurn: false,
    yourTurnAt: 0,
    eligible: true,
    muted: false,
    selected: false,
    ...o,
  });
  const S = N._state;
  const realDoc = globalThis.document,
    realNotif = globalThis.Notification;
  const web = [];
  globalThis.document = {
    hidden: true,
    visibilityState: 'hidden',
    hasFocus: () => false,
    createElement: () => ({ append() {}, remove() {}, setAttribute() {}, addEventListener() {} }),
    body: { append() {} },
  };
  globalThis.Notification = class {
    constructor(title) {
      web.push(title);
    }
    close() {}
  };
  globalThis.Notification.permission = 'granted';
  try {
    const run = () => {
      S.prefs = N.cleanPrefs({ desktop: true, sound: 'off', notifyFor: 'both' });
      S.prev = null;
      S.group = null;
      S.host = { openChat() {}, openInbox() {} };
      N.observeItems([chat('b')], 0);
      N.observeItems([chat('b', { yourTurn: true, yourTurnAt: 7 })], 1000);
    };
    run();
    assert.deepEqual(web, ['Chat b'], 'browser: the web API');
    web.length = 0;
    globalThis.AibDesktop = B;
    const calls = mockInvoke({ aibNotify: true });
    S.nativePerm = 'granted';
    run();
    assert.deepEqual(web, [], 'desktop: the web API is not used');
    assert.equal(calls.at(-1)[0], 'aibNotify');
    assert.equal(calls.at(-1)[1][0], 'Chat b');
    S.nativePerm = 'default'; // not yet granted: no notification at all
    calls.length = 0;
    run();
    assert.equal(calls.length, 0);
  } finally {
    if (realDoc === undefined) delete globalThis.document;
    else globalThis.document = realDoc;
    if (realNotif === undefined) delete globalThis.Notification;
    else globalThis.Notification = realNotif;
  }
});

test('the amber update line', () => {
  const ready = { state: 'ready', inPlace: true, installWhenIdle: false, available: { version: '0.1.2' } };
  const b = U.banner(ready, new Set());
  assert.equal(b.show, true);
  assert.equal(b.text, 'AIB 0.1.2 is ready to install.');
  assert.deepEqual(
    b.buttons.map((x) => x.label),
    ['Install now', 'Later'],
  );
  assert.equal(U.banner(ready, new Set(['0.1.2'])).show, false, 'Later hides it');
  assert.equal(U.banner(ready, new Set(['0.1.1'])).show, true, 'a newer version asks again');
  for (const state of ['none', 'found', 'refused', 'error', 'unconfigured'])
    assert.equal(U.banner({ state, available: { version: '9' } }, new Set()).show, false, state);
  const busy = U.banner(ready, new Set(), { kind: 'busy', chats: 2 });
  assert.match(busy.text, /^2 chats are working/);
  assert.deepEqual(
    busy.buttons.map((x) => x.label),
    ['Install when chats finish', 'Later'],
  );
  const waiting = U.banner(Object.assign({}, ready, { installWhenIdle: true }), new Set(['0.1.2']));
  assert.equal(waiting.show, true, 'a waiting install stays visible');
  assert.match(waiting.text, /will install when your chats finish/);
  const manual = U.banner(Object.assign({}, ready, { inPlace: false, instructions: 'Open the file.' }), new Set());
  assert.match(manual.text, /downloaded and verified\. Open the file\./);
  assert.deepEqual(
    manual.buttons.map((x) => x.id),
    ['later'],
    'never an Install button where it cannot install',
  );
});
