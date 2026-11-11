// The desktop bridge (the deno desktop app's window binding and its notify route) with the binding and the network mocked: no real
// dialog or notification is shown.
const { APP: APP_DIR } = require('./_paths');
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const B = require(path.join(APP_DIR, 'desktop-bridge.js'));
const NP = require(path.join(APP_DIR, 'new-project-ui.js'));
const N = require(path.join(APP_DIR, 'notify-ui.js'));
const U = require(path.join(APP_DIR, 'updates-ui.js'));
const SUI = require(path.join(APP_DIR, 'settings-ui.js'));

function mockInvoke() {
  B.setInvoke(() => true);
}
// A fake server for POST /api/live/desktop/notify: records each request and answers `answer` (a function of the body, or a value).
function mockServer(answer = { ok: true, shown: true, reason: '', mechanism: 'windows-balloon' }, status = 200) {
  const calls = [];
  B.setFetch(async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/live/bootstrap') return { ok: true, status: 200, json: async () => ({ token: 'tok' }) };
    const body = JSON.parse(init.body);
    const data = typeof answer === 'function' ? answer(body) : answer;
    return { ok: status === 200, status, json: async () => data };
  });
  return calls;
}
const posts = (calls) => calls.filter((c) => c.url === '/api/live/desktop/notify');
test.afterEach(() => {
  B.setInvoke(null);
  B.setFetch(null);
  delete globalThis.AibDesktop;
  delete globalThis.bindings;
});

test('in a browser nothing is available and every call says so', async () => {
  assert.equal(B.available(), false);
  await assert.rejects(B.pickFolder({}), /not available/);
  await assert.rejects(B.notify('a', 'b'), /not available/);
  assert.equal(B.notifyReady, undefined, 'no permission calls any more: the app asks nobody');
});

test('the app is detected by its one window binding', () => {
  globalThis.bindings = { aibDesktop: () => true };
  assert.equal(B.available(), true);
  globalThis.bindings = { aibNotify: () => true };
  assert.equal(B.available(), false, 'the old notification bindings are not the app any more');
  globalThis.bindings = { other: () => 1 };
  assert.equal(B.available(), false);
});

test('pickFolder rejects even in the app: deno desktop has no folder dialog', async () => {
  mockInvoke();
  assert.equal(B.available(), true);
  await assert.rejects(B.pickFolder({ start: 'C:\Temp' }), /not available/);
});

test('the New project dialog uses the server picker in the app and in a browser', async () => {
  const server = [];
  NP.init({ postJson: (name, body) => (server.push([name, body]), Promise.resolve({ path: 'D:\from-server' })) });
  assert.deepEqual(await NP.pickFolder('C:\a'), { path: 'D:\from-server' });
  globalThis.AibDesktop = B;
  mockInvoke();
  assert.deepEqual(await NP.pickFolder('C:\a'), { path: 'D:\from-server' });
  assert.deepEqual(server, [
    ['folders/pick', { start: 'C:\a' }],
    ['folders/pick', { start: 'C:\a' }],
  ]);
});

test('notify: the page asks the server (token, JSON body, target) and returns its answer', async () => {
  mockInvoke();
  const calls = mockServer({ ok: true, shown: true, reason: '', mechanism: 'windows-balloon' });
  assert.deepEqual(await B.notify('Chat b', 'Needs you', { type: 'chat', key: 'claude:s1' }), { shown: true, reason: '' });
  const p = posts(calls);
  assert.equal(p.length, 1);
  assert.equal(p[0].init.method, 'POST');
  assert.equal(p[0].init.headers['X-Studio-Token'], 'tok');
  assert.equal(p[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(p[0].init.body), {
    title: 'Chat b',
    body: 'Needs you',
    target: { type: 'chat', key: 'claude:s1' },
    test: false,
  });
  await B.notify('AIB', 'x', null, true);
  assert.deepEqual(JSON.parse(posts(calls)[1].init.body).test, true);
  assert.equal(calls.filter((c) => c.url === '/api/live/bootstrap').length, 1, 'the token is fetched once');
  mockServer({ ok: true, shown: false, reason: 'Windows is in presentation mode', mechanism: 'windows-balloon' });
  assert.deepEqual(await B.notify('a', 'b'), { shown: false, reason: 'Windows is in presentation mode' });
  mockServer({ error: 'Only the AIB desktop app shows notifications itself' }, 409);
  await assert.rejects(B.notify('a', 'b'), /Only the AIB desktop app/);
});

test('notify: a stale token is fetched again once', async () => {
  mockInvoke();
  let first = true;
  const calls = [];
  B.setFetch(async (url, init) => {
    calls.push(url);
    if (url === '/api/live/bootstrap') return { ok: true, status: 200, json: async () => ({ token: 't' + calls.length }) };
    if (first) {
      first = false;
      return { ok: false, status: 403, json: async () => ({ error: 'token' }) };
    }
    return { ok: true, status: 200, json: async () => ({ shown: true }) };
  });
  assert.deepEqual(await B.notify('a', 'b'), { shown: true, reason: '' });
  assert.deepEqual(calls, ['/api/live/bootstrap', '/api/live/desktop/notify', '/api/live/bootstrap', '/api/live/desktop/notify']);
});

test('os(): Windows, macOS or Linux from the user agent', () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const as = (userAgent, platform = '') =>
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent, platform }, configurable: true });
  try {
    as('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/131');
    assert.equal(B.os(), 'windows');
    as('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'MacIntel');
    assert.equal(B.os(), 'macos');
    as('Mozilla/5.0 (X11; Linux x86_64)', 'Linux x86_64');
    assert.equal(B.os(), 'linux');
  } finally {
    if (real) Object.defineProperty(globalThis, 'navigator', real);
    else delete globalThis.navigator;
  }
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

function chat(key, o = {}) {
  return {
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
  };
}
// Just enough DOM for notify-ui.js's settings block and toasts.
function fakeDoc(o = {}) {
  const node = (tag) => {
    const n = {
      tagName: tag.toUpperCase(),
      children: [],
      className: '',
      textContent: '',
      value: '',
      disabled: false,
      listeners: {},
      attrs: {},
      append(...c) {
        for (const x of c) {
          if (x && typeof x === 'object' && x.tagName === 'OPTION' && n.tagName === 'SELECT' && !n.value) n.value = x.value;
          n.children.push(x);
        }
      },
      replaceChildren() {
        n.children = [];
      },
      remove() {},
      setAttribute(k, v) {
        n.attrs[k] = v;
      },
      addEventListener(k, fn) {
        n.listeners[k] = fn;
      },
    };
    return n;
  };
  return {
    hidden: false,
    visibilityState: 'visible',
    hasFocus: () => true,
    createElement: node,
    body: { append() {} },
    addEventListener() {},
    ...o,
  };
}
const texts = (n) => [n.textContent, ...n.children.flatMap((c) => (c && typeof c === 'object' ? texts(c) : []))].filter(Boolean);
const find = (n, tag, text) => {
  if (n.tagName === tag && (text === undefined || n.textContent === text)) return n;
  for (const c of n.children) {
    const f = c && typeof c === 'object' ? find(c, tag, text) : null;
    if (f) return f;
  }
  return null;
};
function withGlobals(values, fn) {
  const saved = {};
  for (const k of Object.keys(values)) {
    saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    Object.defineProperty(globalThis, k, { value: values[k], configurable: true, writable: true });
  }
  const restore = () => {
    for (const k of Object.keys(values)) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  };
  let r;
  try {
    r = fn();
  } catch (e) {
    restore();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(restore);
  restore();
  return r;
}
function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('notify-ui shows through the server in the desktop app and through the web API otherwise', async () => {
  const S = N._state;
  const web = [];
  class FakeNotification {
    constructor(title) {
      web.push(title);
    }
    close() {}
  }
  FakeNotification.permission = 'granted';
  const doc = fakeDoc({ hidden: true, visibilityState: 'hidden', hasFocus: () => false });
  await withGlobals({ document: doc, Notification: FakeNotification }, async () => {
    const run = (prefs) => {
      S.prefs = prefs;
      S.prev = null;
      S.group = null;
      S.host = { openChat() {}, openInbox() {} };
      N.observeItems([chat('b')], 0);
      N.observeItems([chat('b', { state: 'needs_you', needs: 1 })], 1000);
    };
    run(N.cleanPrefs({ desktop: true, sound: 'off', notifyFor: 'both' }));
    assert.deepEqual(web, ['Chat b'], 'browser: the web API');
    web.length = 0;
    globalThis.AibDesktop = B;
    mockInvoke();
    const calls = mockServer();
    run(N.cleanPrefs({}, true)); // the app's defaults: on, Needs you only
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(web, [], 'desktop: the web API is not used');
    const sent = posts(calls).map((c) => JSON.parse(c.init.body));
    assert.deepEqual(sent, [{ title: 'Chat b', body: 'Needs you', target: { type: 'chat', key: 'b' }, test: false }]);
    run(N.cleanPrefs({ desktop: false }, true)); // turned off in the app: nothing
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(posts(calls).length, 1);
  });
});

test('notify-ui: no desktop notification about anything while AIB is in front (the open chat least of all)', async () => {
  const S = N._state;
  globalThis.AibDesktop = B;
  mockInvoke();
  const calls = mockServer();
  await withGlobals({ document: fakeDoc() }, async () => {
    S.prefs = N.cleanPrefs({ notifyFor: 'both' }, true);
    S.prev = null;
    S.group = null;
    S.host = { openChat() {}, openInbox() {} };
    N.observeItems([chat('a', { selected: true }), chat('b')], 0);
    N.observeItems([chat('a', { selected: true, state: 'needs_you' }), chat('b', { state: 'needs_you' })], 1000);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(posts(calls).length, 0, 'in front: the badge, the list and an in-page toast for b only');
    assert.equal(S.toasts.has('b:needs'), true);
    assert.equal(S.toasts.has('a:needs'), false, 'the chat you are looking at gets nothing');
    for (const k of [...S.toasts.keys()]) S.toasts.delete(k);
  });
});

test('notify-ui defaults: the app starts on for Needs you only; a browser starts off for both', () => {
  assert.deepEqual(N.cleanPrefs({}, true), { desktop: true, sound: 'needs', notifyFor: 'needs' });
  assert.deepEqual(N.cleanPrefs(null, true), { desktop: true, sound: 'needs', notifyFor: 'needs' });
  assert.deepEqual(N.cleanPrefs({ desktop: false, notifyFor: 'both' }, true), { desktop: false, sound: 'needs', notifyFor: 'both' });
  assert.deepEqual(N.cleanPrefs({}), { desktop: false, sound: 'needs', notifyFor: 'both' });
});

test('notify-ui: the app keeps its choices under its own key (synced to the data folder), a browser under its old one', () => {
  const V = require(path.join(APP_DIR, 'view-prefs.js'));
  assert.ok(V.KEYS.includes('studio-notifications-app'), 'view-prefs.js moves the app key into the data folder');
  assert.ok(!V.KEYS.includes('studio-notifications'), "a browser's choice stays in that browser");
  const S = N._state;
  const store = memoryStorage({ 'studio-notifications': JSON.stringify({ desktop: false }) });
  withGlobals({ document: fakeDoc(), localStorage: store, setInterval: () => 0, addEventListener() {} }, () => {
    globalThis.AibDesktop = B;
    mockInvoke();
    N.init({});
    assert.deepEqual(S.prefs, { desktop: true, sound: 'needs', notifyFor: 'needs' }, "the browser's old choice is not the app's");
    S.prefs.notifyFor = 'both';
    N.enableDesktop();
    assert.deepEqual(JSON.parse(store.map.get('studio-notifications-app')), { desktop: true, sound: 'needs', notifyFor: 'both' });
    B.setInvoke(null);
    N.init({});
    assert.deepEqual(S.prefs.desktop, false, 'a browser reads its own key');
  });
});

test('Settings > Notifications in the desktop app: no browser wording, "Windows notifications" on Windows, a test button', async () => {
  const S = N._state;
  globalThis.AibDesktop = B;
  mockInvoke();
  const ua = (userAgent) => ({ userAgent, platform: '' });
  await withGlobals({ document: fakeDoc(), localStorage: memoryStorage(), navigator: ua('Mozilla/5.0 (Windows NT 10.0)') }, async () => {
    S.prefs = N.cleanPrefs({}, true);
    const pop = fakeDoc().createElement('div');
    N.mountSettings(pop);
    let all = texts(pop).join('\n');
    assert.match(all, /Windows notifications/);
    assert.doesNotMatch(all, /browser|site settings/i);
    assert.equal(find(pop, 'SELECT').value, 'on', 'on by default');
    const button = find(pop, 'BUTTON', 'Send a test notification');
    assert.ok(button, 'the test button');
    let calls = mockServer({ ok: true, shown: true, reason: '', mechanism: 'windows-balloon' });
    await N.sendTest(button);
    assert.deepEqual(JSON.parse(posts(calls)[0].init.body), {
      title: 'AIB',
      body: 'This is a test notification.',
      target: null,
      test: true,
    });
    all = texts(pop).join('\n');
    assert.match(all, /Test sent\. If nothing showed, Do not disturb may be on\./);
    calls = mockServer({ ok: true, shown: false, reason: 'Windows is in presentation mode', mechanism: 'windows-balloon' });
    await N.sendTest(find(pop, 'BUTTON', 'Send a test notification'));
    assert.match(texts(pop).join('\n'), /Not shown: Windows is in presentation mode\./);
    assert.doesNotMatch(texts(pop).join('\n'), /browser|site settings/i);
  });
  await withGlobals({ document: fakeDoc(), localStorage: memoryStorage(), navigator: ua('Mozilla/5.0 (X11; Linux x86_64)') }, () => {
    S.prefs = N.cleanPrefs({ desktop: false }, true);
    const pop = fakeDoc().createElement('div');
    N.mountSettings(pop);
    const all = texts(pop).join('\n');
    assert.match(all, /Desktop notifications/);
    assert.doesNotMatch(all, /Windows notifications|browser|site settings/i);
    assert.equal(find(pop, 'SELECT').value, 'off');
    assert.ok(find(pop, 'BUTTON', 'Send a test notification'), 'offered while off too');
  });
});

test('Settings > Notifications in a browser: today\'s permission wording', () => {
  const S = N._state;
  class Denied {}
  Denied.permission = 'denied';
  withGlobals({ document: fakeDoc(), Notification: Denied }, () => {
    S.prefs = N.cleanPrefs({});
    const pop = fakeDoc().createElement('div');
    N.mountSettings(pop);
    const all = texts(pop).join('\n');
    assert.match(all, /Windows notifications/);
    assert.match(all, /Blocked by the browser - allow it in site settings/);
    assert.equal(find(pop, 'BUTTON', 'Send a test notification'), null, 'no test button while off in a browser');
  });
});

test('the Notifications section note: AIB\'s own in the app, the browser\'s permission in a browser', () => {
  const note = (app) => {
    const seen = [];
    const box = { append: (...n) => seen.push(...n) };
    if (app) {
      globalThis.AibDesktop = B;
      mockInvoke();
    } else delete globalThis.AibDesktop;
    withGlobals({ document: fakeDoc() }, () => SUI.renderNotifications(box));
    return texts({ textContent: '', children: seen }).join('\n');
  };
  assert.equal(note(true).includes("AIB shows these itself. They are saved with AIB's data."), true);
  assert.doesNotMatch(note(true), /browser|site settings/i);
  B.setInvoke(null);
  assert.match(note(false), /These apply to this browser only: desktop notifications need this browser's permission\./);
});

test('a click on the app\'s notification opens its chat (openFromDesktop)', () => {
  const S = N._state;
  const opened = [];
  S.host = { openChat: (k) => opened.push(['chat', k]), openInbox: () => opened.push(['inbox']) };
  withGlobals({ focus() {} }, () => {
    assert.equal(N.openFromDesktop({ type: 'chat', key: 'claude:1' }), true);
    assert.equal(N.openFromDesktop({ type: 'inbox' }), true);
    assert.equal(N.openFromDesktop(null), true, 'nothing to open: the window is already in front');
  });
  assert.deepEqual(opened, [['chat', 'claude:1'], ['inbox']]);
  S.host = null;
  assert.equal(N.openFromDesktop({ type: 'chat', key: 'x' }), false, 'not ready yet: the app tries again');
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
  const installing = U.banner(ready, new Set(), { kind: 'installing', chats: 2 });
  assert.equal(installing.text, 'Installing AIB 0.1.2. AIB will close and open again by itself. Your working chats keep running.');
  assert.deepEqual(installing.buttons, []);
  assert.equal(
    U.banner(ready, new Set(), { kind: 'installing', chats: 0 }).text,
    'Installing AIB 0.1.2. AIB will close and open again by itself.',
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

test('the Settings card: a source run says updates come through the desktop app, and a failed check says when (QA 4 #11, #12)', () => {
  const src = { state: 'unconfigured', current: '0.1.0-beta.2', desktop: false, configured: false };
  assert.equal(U.sourceRun(src), true);
  assert.match(U.cardLine(src), /^You have AIB 0\.1\.0-beta\.2\. This copy runs from source/);
  assert.match(U.cardLine(src), /updates come through the AIB desktop app/);
  assert.equal(U.sourceRun({ ...src, configured: true }), false, 'a source run pointed at a release page still checks');
  assert.equal(U.sourceRun({ ...src, desktop: true }), false);
  const now = new Date(2026, 10, 10, 15, 0).getTime();
  const tried = new Date(2026, 10, 10, 14, 5).getTime() / 1000;
  const off = { state: 'error', current: '0.1.0', error: 'Could not reach GitHub to check for updates.', lastCheck: tried, autoCheck: true, retryAt: tried + 3600, desktop: true };
  const line = U.cardLine(off, now);
  assert.match(line, /^Could not reach GitHub to check for updates\. \(Tried today at /);
  assert.match(line, /AIB tries again today at /);
  assert.doesNotMatch(U.cardLine({ ...off, autoCheck: false }, now), /tries again/, 'no promise when automatic checks are off');
  assert.match(U.atTime(new Date(2026, 10, 8, 9, 30).getTime() / 1000, now), / at /);
  assert.doesNotMatch(U.atTime(new Date(2026, 10, 8, 9, 30).getTime() / 1000, now), /today/);
});
