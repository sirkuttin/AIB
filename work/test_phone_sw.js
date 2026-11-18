'use strict';
/* Phase C of the phone page: its service worker (pwa/sw.js) and phone.js's new pure parts.
   - the worker caches only the page's own files (never /api/*, never another origin), shows only the words a push carries, one tag
     for all pushes, and a tap opens the chat with its sheet up;
   - the worker's events, run against a fake service-worker global: a push shows one notification; a tap focuses an open page and
     tells it which chat, or opens /phone.html#chat=...&sheet=1; a page load falls back to the cached copy on Serve's 502 only;
   - phone.js: "Reconnecting…" first, then "AIB is closed on <PC>" (Serve: 502) or "Can't reach <PC>" (no answer), never that
     the chats still run; Finish setup's steps (the Home Screen step on an iPhone only); the #chat link a push opens. */
const { APP } = require('./_paths');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  vm = require('node:vm');
const SW = require(path.join(APP, 'pwa', 'sw.js'));
const P = require(path.join(APP, 'phone.js'));

const ORIGIN = 'https://studio-pc.tail-a1b2.ts.net';

test('worker: only the phone page files are cached, never the API or another origin', () => {
  assert.equal(SW.shellPath(ORIGIN + '/phone.html', 'navigate', ORIGIN), '/phone.html');
  // phase 1b: / is the loader (it picks the phone or the computer page); the computer page's files are cached too
  assert.equal(SW.shellPath(ORIGIN + '/', 'navigate', ORIGIN), '/');
  assert.equal(SW.shellPath(ORIGIN + '/pc.html', 'navigate', ORIGIN), '/pc.html');
  assert.equal(SW.shellPath(ORIGIN + '/chat.js', 'no-cors', ORIGIN), '/chat.js');
  assert.equal(SW.shellPath(ORIGIN + '/remote-auth.js', 'no-cors', ORIGIN), '/remote-auth.js');
  assert.ok(SW.SHELL_FILES.includes('/pc.html') && SW.SHELL_FILES.includes('/'));
  assert.ok(!SW.SHELL_FILES.includes('/page-auth.js') && !SW.PC_FILES.includes('/page-auth.js'));
  assert.equal(SW.shellPath(ORIGIN + '/phone.js', 'no-cors', ORIGIN), '/phone.js');
  assert.equal(SW.shellPath(ORIGIN + '/icons/icon-256.png', 'no-cors', ORIGIN), '/icons/icon-256.png');
  for (const url of ['/api/remote/home', '/api/remote/chat?id=c1', '/api/remote/image?id=c&seq=1&n=0', '/sw.js', '/chat.html'])
    assert.equal(SW.shellPath(ORIGIN + url, 'cors', ORIGIN), '', url);
  assert.equal(SW.shellPath(ORIGIN + '/api/remote/bootstrap', 'navigate', ORIGIN), '');
  assert.equal(SW.shellPath('https://evil.example/phone.js', 'no-cors', ORIGIN), '');
  assert.ok(SW.SHELL_FILES.every((f) => !f.startsWith('/api/')));
});

test('worker: a push shows only its words, with one tag; a tap opens the chat with the sheet up', () => {
  const n = SW.notificationOf({ title: 'A chat needs you', body: 'Blog site', tag: 'x', chat: 'c1', sheet: true, extra: 'dropped' });
  assert.deepEqual(n, {
    title: 'A chat needs you',
    options: {
      body: 'Blog site',
      tag: 'aib-attention',
      renotify: true,
      silent: false,
      icon: '/icons/icon-256.png',
      badge: '/icons/badge-96.png',
      data: { chat: 'c1', sheet: true, open: '' },
    },
  });
  // a Finished-only push: no sound or vibration, and no re-alert
  const quiet = SW.notificationOf({ title: 'Chat finished', body: 'Blog', silent: true }).options;
  assert.equal(quiet.silent, true);
  assert.equal(quiet.renotify, false);
  assert.equal(SW.notificationOf(null).title, 'AIB');
  assert.equal(SW.openUrl({ chat: 'c 1', sheet: true }), '/phone.html#chat=c%201&sheet=1');
  assert.equal(SW.openUrl({ chat: 'c1', sheet: false }), '/phone.html#chat=c1');
  assert.equal(SW.openUrl({}), '/phone.html');
  // phase 1b: the server names the page (a computer's push opens the computer page); only this origin's two pages
  assert.equal(SW.openUrl({ chat: 'c1', open: '/pc.html#chat=c1' }), '/pc.html#chat=c1');
  assert.equal(SW.openUrl({ chat: 'c1', open: 'https://evil.example/pc.html' }), '/phone.html#chat=c1');
  assert.equal(SW.openUrl({ chat: 'c1', open: '/api/remote/home' }), '/phone.html#chat=c1');
});

/* The worker as a browser runs it: a fake service-worker global with caches, clients and registration. */
function runWorker({ network, pages = [] }) {
  const listeners = {};
  const cache = new Map();
  const shown = [];
  const opened = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: () => Promise.resolve(),
    caches: {
      open: () => Promise.resolve({ match: (p) => Promise.resolve(cache.get(p)), put: (p, r) => (cache.set(p, r), Promise.resolve()), addAll: () => Promise.resolve() }),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
    },
    clients: {
      matchAll: () => Promise.resolve(pages),
      openWindow: (url) => (opened.push(url), Promise.resolve()),
      claim: () => Promise.resolve(),
    },
    registration: { showNotification: (title, options) => (shown.push({ title, options }), Promise.resolve()) },
    fetch: network,
  };
  vm.runInNewContext(fs.readFileSync(path.join(APP, 'pwa', 'sw.js'), 'utf8'), { self, URL, Promise });
  const fire = async (type, event) => {
    let waited = null;
    let answer = null;
    listeners[type]({ ...event, waitUntil: (p) => (waited = p), respondWith: (p) => (answer = p) });
    if (waited) await waited;
    return answer ? await answer : null;
  };
  return { fire, cache, shown, opened, listeners };
}
const response = (status, text) => ({ ok: status >= 200 && status < 300, status, text, clone() { return response(status, text); } });

test('worker: push and tap events', async () => {
  const w = runWorker({ network: () => Promise.reject(new Error('offline')) });
  await w.fire('push', { data: { json: () => ({ title: 'Chat finished', body: 'Invoice parser', chat: 'c2', sheet: false }) } });
  assert.deepEqual(w.shown.map((s) => [s.title, s.options.body, s.options.tag]), [['Chat finished', 'Invoice parser', 'aib-attention']]);
  await w.fire('push', { data: { json: () => { throw new Error('not JSON'); } } });
  assert.equal(w.shown[1].title, 'AIB');
  // a tap with no page open: opens the phone page on the chat, the sheet up
  let closed = 0;
  await w.fire('notificationclick', { notification: { data: { chat: 'c1', sheet: true }, close: () => closed++ } });
  assert.deepEqual(w.opened, ['/phone.html#chat=c1&sheet=1']);
  assert.equal(closed, 1);
  // a tap with the page open: focus it and tell it which chat
  const told = [];
  const page = { url: ORIGIN + '/phone.html', focus: () => Promise.resolve(), postMessage: (m) => told.push(m) };
  const w2 = runWorker({ network: () => Promise.reject(new Error('offline')), pages: [page] });
  await w2.fire('notificationclick', { notification: { data: { chat: 'c1', sheet: true }, close() {} } });
  assert.deepEqual(JSON.parse(JSON.stringify(told)), [{ type: 'aib-open', chat: 'c1', sheet: true }]); // made in the worker's realm
  assert.deepEqual(w2.opened, []);
});

test('worker: the page loads from the network, and from its copy only when AIB is closed (502) or unreachable', async () => {
  let answer = response(200, 'fresh page');
  const w = runWorker({ network: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)) });
  const nav = { request: { method: 'GET', url: ORIGIN + '/phone.html', mode: 'navigate' } };
  assert.equal((await w.fire('fetch', nav)).text, 'fresh page');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(w.cache.get('/phone.html').text, 'fresh page', 'the copy is kept');
  answer = response(502, 'Tailscale: bad gateway');
  assert.equal((await w.fire('fetch', nav)).text, 'fresh page', 'AIB closed: the copy');
  answer = new Error('no network');
  assert.equal((await w.fire('fetch', nav)).text, 'fresh page', 'no answer: the copy');
  answer = response(403, 'refused');
  assert.equal((await w.fire('fetch', nav)).status, 403, 'a refusal is not hidden behind the copy');
  // the API is never answered by the worker
  assert.equal(await w.fire('fetch', { request: { method: 'GET', url: ORIGIN + '/api/remote/home', mode: 'cors' } }), null);
  assert.equal(await w.fire('fetch', { request: { method: 'POST', url: ORIGIN + '/phone.html', mode: 'navigate' } }), null);
});

test('phone: Reconnecting… first, then AIB is closed or the PC cannot be reached; never that the chats still run', () => {
  const t0 = 1_000_000;
  const r = P.offlineView(t0, t0 + 5000, 'down', 'STUDIO-PC');
  assert.equal(r.kind, 'reconnecting');
  assert.equal(r.title, 'Reconnecting…');
  assert.equal(r.retry, false);
  assert.equal(P.RECONNECT_MS, 20000, 'longer than the keeper takes to start a crashed AIB again (5 s)');
  const closed = P.offlineView(t0, t0 + 20000, 'down', 'STUDIO-PC');
  assert.deepEqual([closed.kind, closed.title, closed.retry], ['closed', 'AIB is closed on STUDIO-PC', true]);
  const far = P.offlineView(t0, t0 + 25000, 'unreachable', 'STUDIO-PC');
  assert.deepEqual([far.kind, far.title], ['unreachable', "Can't reach STUDIO-PC"]);
  for (const v of [r, closed, far]) {
    const text = [v.title, ...v.lines, ...v.checks].join(' ');
    assert.doesNotMatch(text, /still running|keep running|keeps running|chats (are|keep)/i, text);
  }
});

test('phone: Finish setup has the Home Screen step on an iPhone only; notifications by tap; Push off on the PC says so', () => {
  assert.equal(P.isIPhone('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15', 5), true);
  assert.equal(P.isIPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', 5), true, 'iPadOS');
  assert.equal(P.isIPhone('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0), false, 'a Mac');
  assert.equal(P.isIPhone('Mozilla/5.0 (Linux; Android 15; Pixel 9) Chrome/131.0 Mobile', 5), false);
  const base = { supported: true, permission: 'default', on: false, allowed: true, standalone: false };
  const ids = (o) => P.setupSteps(o).map((s) => [s.id, s.state]);
  assert.deepEqual(ids({ ...base, iphone: false }), [['install', 'todo'], ['notify', 'todo']], 'Android: Install AIB step');
  assert.deepEqual(ids({ ...base, iphone: false, standalone: true }), [['install', 'done'], ['notify', 'todo']]);
  assert.deepEqual(ids({ ...base, iphone: true }), [['home', 'todo'], ['notify', 'todo']]);
  assert.deepEqual(ids({ ...base, iphone: true, standalone: true }), [['home', 'done'], ['notify', 'todo']]);
  assert.deepEqual(ids({ ...base, iphone: false, permission: 'granted', on: true }), [['install', 'todo'], ['notify', 'done']]);
  assert.deepEqual(ids({ ...base, iphone: false, permission: 'denied' }), [['install', 'todo'], ['notify', 'blocked']]);
  assert.deepEqual(ids({ ...base, iphone: false, allowed: false }), [['install', 'todo'], ['notify', 'off']]);
  assert.match(P.setupSteps({ ...base, allowed: false }).at(-1).text, /Settings → Remote control/);
  assert.match(P.setupSteps({ ...base, iphone: true })[0].text, /Add to Home Screen/);
});

test('phone: a push link opens that chat (with its sheet); anything else is ignored', () => {
  assert.deepEqual(P.openTarget('#chat=c1&sheet=1'), { chat: 'c1', sheet: true });
  assert.deepEqual(P.openTarget('#chat=c%201'), { chat: 'c 1', sheet: false });
  assert.equal(P.openTarget('#p=0123456789ab'), null);
  assert.equal(P.openTarget('#chat=&sheet=1'), null);
  assert.deepEqual([...P.keyBytes('AQID_-8')], [1, 2, 3, 255, 239]);
});

test('phone: Install AIB: our button where the browser offers it, the Share steps on an iPhone, Firefox its menu, hidden once installed', () => {
  assert.equal(P.isFirefoxAndroid('Mozilla/5.0 (Android 15; Mobile; rv:140.0) Gecko/140.0 Firefox/140.0'), true);
  assert.equal(P.isFirefoxAndroid('Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile'), false);
  assert.equal(P.installKind({ prompt: true }), 'prompt');
  assert.equal(P.installKind({ prompt: true, standalone: true }), 'installed', 'running installed: nothing to install');
  assert.equal(P.installKind({ prompt: true, installed: true }), 'installed', 'after appinstalled');
  assert.equal(P.installKind({ iphone: true }), 'iphone');
  assert.equal(P.installKind({ firefox: true }), 'firefox');
  assert.equal(P.installKind({}), 'other');
  assert.match(P.installText('iphone'), /Share button.*Add to Home Screen.*Open as Web App/);
  assert.match(P.installText('firefox'), /menu ⋮, then Add app to Home screen/);
  assert.match(P.installText('prompt'), /Tap Install AIB/);
  assert.match(P.installText('other'), /browser menu/);
  const base = { supported: true, permission: 'default', on: false, allowed: true, standalone: false };
  assert.equal(P.setupSteps({ ...base, prompt: true })[0].kind, 'prompt');
  assert.equal(P.setupSteps({ ...base, firefox: true })[0].kind, 'firefox');
});

test('worker: notification buttons (0.13): at most two known ones, the key and code kept, a tap acts or opens the right page', () => {
  const push = {
    title: 'A chat needs you',
    body: 'Payments',
    chat: 'c1',
    sheet: true,
    key: 'claude:s1',
    code: 'CODE',
    actions: [
      { action: 'allow', title: 'Allow' },
      { action: 'deny', title: 'Deny' },
      { action: 'open', title: 'Open' },
      { action: 'evil', title: 'x' },
    ],
  };
  const n = SW.notificationOf(push, 3).options;
  assert.deepEqual(n.actions, [{ action: 'allow', title: 'Allow' }, { action: 'deny', title: 'Deny' }], 'Android shows two: never more');
  assert.deepEqual(n.data, { chat: 'c1', sheet: true, open: '', key: 'claude:s1', code: 'CODE' });
  assert.equal(SW.notificationOf(push, 1).options.actions.length, 1, 'a browser that shows one');
  assert.equal(SW.notificationOf({ ...push, key: '' }).options.actions, undefined, 'no buttons without the chat key');
  assert.equal(SW.notificationOf({ ...push, actions: [{ action: 'evil', title: 'x' }] }).options.actions, undefined);
  // a tap
  const data = n.data;
  assert.deepEqual(SW.clickPlan(data, 'allow'), { act: 'allow', key: 'claude:s1', code: 'CODE' });
  assert.deepEqual(SW.clickPlan(data, 'retry'), { act: 'retry', key: 'claude:s1', code: 'CODE' });
  assert.deepEqual(SW.clickPlan({ ...data, code: undefined }, 'allow'), { url: '/phone.html#chat=c1&sheet=1' }, 'no code: only opens');
  assert.deepEqual(SW.clickPlan(data, 'reply'), { url: '/phone.html#chat=c1&reply=1' }, 'Reply: the composer');
  assert.deepEqual(SW.clickPlan(data, 'open'), { url: '/phone.html#chat=c1&sheet=1' });
  assert.deepEqual(SW.clickPlan(data, ''), { url: '/phone.html#chat=c1&sheet=1' }, 'the notification itself');
  assert.equal(SW.chatUrl('c 1', { note: 'expired' }), '/phone.html#chat=c%201&note=expired');
  assert.equal(SW.chatUrl('c1', { note: '<b>' }), '/phone.html#chat=c1', 'a note is a code word only');
  // every page a tap opens passes the worker's own address check
  for (const u of ['/phone.html#chat=c1&reply=1', '/phone.html#chat=c%201&note=expired']) assert.equal(SW.openUrl({ open: u }), u);
});

test('worker: a button goes to AIB with the phone key; refusals and offline come back as a code word', async () => {
  const sent = [];
  const answer = (status, body) => async (url, o) => {
    sent.push([url, o]);
    return { ok: status === 200, status, json: async () => body };
  };
  const plan = { act: 'allow', key: 'claude:s1', code: 'CODE' };
  assert.deepEqual(await SW.sendAct(plan, answer(200, { ok: true }), 'TOKEN'), { ok: true });
  assert.equal(sent[0][0], '/api/remote/notify-act');
  assert.equal(sent[0][1].method, 'POST');
  assert.equal(sent[0][1].headers['X-AIB-Device'], 'TOKEN');
  assert.deepEqual(JSON.parse(sent[0][1].body), { key: 'claude:s1', act: 'allow', code: 'CODE' });
  assert.deepEqual(await SW.sendAct(plan, answer(409, { code: 'expired' }), 'TOKEN'), { ok: false, code: 'expired' });
  assert.deepEqual(await SW.sendAct(plan, answer(403, { code: 'scope' }), 'TOKEN'), { ok: false, code: 'scope' });
  assert.deepEqual(await SW.sendAct(plan, answer(409, { code: 'Not A Word!' }), 'TOKEN'), { ok: false, code: 'failed' });
  assert.deepEqual(await SW.sendAct(plan, answer(502, {}), 'TOKEN'), { ok: false, code: 'offline' }, "Serve's 502: AIB closed");
  const down = async () => {
    throw new TypeError('network');
  };
  assert.deepEqual(await SW.sendAct(plan, down, 'TOKEN'), { ok: false, code: 'offline' });
  const before = sent.length;
  assert.deepEqual(await SW.sendAct(plan, answer(200, {}), ''), { ok: false, code: 'unknown' }, 'not paired: nothing sent');
  assert.equal(sent.length, before);
});

test('phone: a notification link with Reply or a note; notes in words; notifications of answered chats are found', () => {
  assert.deepEqual(P.openTarget('#chat=c1&reply=1'), { chat: 'c1', sheet: false, reply: true });
  assert.deepEqual(P.openTarget('#chat=c1&note=expired'), { chat: 'c1', sheet: false, note: 'expired' });
  assert.deepEqual(P.openTarget('#chat=c1&sheet=1&note=scope'), { chat: 'c1', sheet: true, note: 'scope' });
  assert.equal(P.openTarget('#chat=c1&note=<b>'), null);
  assert.equal(P.notifyNote('expired'), 'That notification is too old. Answer it here.');
  assert.match(P.notifyNote('scope'), /Settings → Remote control/);
  assert.equal(P.notifyNote('offline'), 'AIB could not be reached. Try again here.');
  assert.equal(P.notifyNote('whatever'), 'That did not work. Try again here.');
  const shown = [{ data: { key: 'claude:a' } }, { data: { key: 'claude:b' } }, { data: {} }];
  assert.deepEqual(P.staleNotifications(shown, [{ key: 'claude:a' }]), [shown[1]], 'b was answered; a grouped one stays');
  assert.deepEqual(P.staleNotifications(shown, [{ key: 'claude:a' }, { key: 'claude:b' }]), []);
});
