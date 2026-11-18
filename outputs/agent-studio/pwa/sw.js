'use strict';
/* The service worker of the phone port (server/remote/server.ts), served at /sw.js, scope "/": the phone page's and the computer
   page's (phase 1b: one origin, one worker). It cannot ask a page which kind of device it is on (no page at install, none at a
   click with every window closed), so it caches both shells (they hold no secrets) and opens where the server's push says (`open`).
   * Pushes: shows "A chat needs you" / "Chat finished" with the chat's title (the server never sends more), one tag for all of them,
     so a newer push replaces the older. A tap opens the phone page on that chat with its approval or question sheet up: an open
     page is told (postMessage), else /phone.html#chat=<id>&sheet=1 is opened.
   * Buttons (0.13, server/remote/push_acts.ts): a push about one chat carries its buttons (at most 2: Android Chrome shows no more)
     and a one-time code. Allow, Deny, Continue and Retry are sent from here (POST /api/remote/notify-act with this phone's key from
     IndexedDB) without opening anything; when that fails (too old, already answered, switched off, AIB unreachable) the phone page
     opens on the chat with a short note. Reply opens the phone page on the chat's composer with the keyboard up (Chrome has no text
     box on a web notification); Open, or a tap on the notification, opens the chat. A "close" push (the request was answered
     somewhere else) takes that chat's notification away.
   * The app shell (the phone page's own files) is cached, never chat content and never /api/*: network first, the cached copy only
     when AIB cannot be reached (Tailscale Serve answers 502 once AIB is closed, or there is no network). Then the page loads anyway
     and says "Reconnecting…", then that AIB is closed on the PC or the PC cannot be reached, with Try again (phone.js).
   Pure helpers are exported for node tests (work/test_phone_sw.js). */
(function (self) {
  const SHELL = 'aib-shell-v4';
  const SHELL_FILES = [
    '/phone.html',
    '/phone.js',
    '/phone.css',
    '/phone-words.js',
    '/push-enable.js',
    '/markdown.js',
    '/subagents-ui.js', // the PC's Activity rules for a chat's subagents (phone.js subsModel)
    '/themes.js',
    '/theme.css',
    '/manifest.webmanifest',
    '/icons/icon-256.png',
    '/icons/icon-192.png',
    '/icons/maskable-192.png',
    '/icons/maskable-512.png',
    '/icons/apple-touch-180.png',
    '/icons/badge-96.png',
    // the loader and the computer page (phase 1b); its scripts and stylesheets are cached as they load (PC_FILES)
    '/',
    '/remote-loader.js',
    '/pc.html',
    '/remote-auth.js',
    '/remote-windows.js',
    '/remote.css',
    '/pc.webmanifest',
  ];
  /* The computer page's files that may be answered from the cache when AIB can't be reached (server/remote/pc_page.ts PC_STATIC;
     a test checks the two lists match). Cached when they load, not at install: a phone never needs them. */
  const PC_FILES = [
    '/chat.css', '/activity.css', '/workspace.css', '/clamp.css', '/stream.css', '/header.css', '/inbox-reply.css', '/commands.css',
    '/queue.css', '/textsize.css', '/settings.css', '/changes.css', '/artifacts.css', '/plan.css', '/split.css', '/views.css',
    '/start-page.css', '/terminal.css', '/files.css', '/typing.js', '/view-prefs.js', '/store-merge.js', '/window-context.js',
    '/terminal-ui.js', '/run-terminal-ui.js', '/wsl-ui.js', '/tool-views.js', '/editors-ui.js', '/copy-ui.js', '/stream-ui.js', '/unknown-send.js',
    '/image-viewer.js', '/attachments-ui.js', '/commands-ui.js', '/config-ui.js', '/session-ops.js', '/terminals-ui.js',
    '/ownership-ui.js', '/organize-ui.js', '/status-words.js', '/attention-ui.js', '/agent-choice.js', '/composer-chips.js',
    '/inbox-rules.js', '/notify-rules.js', '/notify-ui.js', '/read-state.js', '/sidebar-ui.js', '/commands-registry.js',
    '/switcher-ui.js', '/textsize-ui.js', '/resize-ui.js', '/workspace-state.js', '/new-project-ui.js', '/inbox-reply.js',
    '/delete-project-ui.js', '/workspace-ui.js', '/split-tree.js', '/split-ui.js', '/doc-icons.js', '/files-state.js',
    '/file-editor-ui.js', '/files-ui.js',
    '/doc-links.js', '/subagents-ui.js', '/activity-ui.js', '/clash-ui.js', '/changes-ui.js', '/artifacts-ui.js', '/clamp-ui.js',
    '/header-ui.js', '/send-menu-ui.js', '/queue-ui.js', '/updates-ui.js', '/devices-ui.js', '/allow-rules-ui.js', '/settings-ui.js',
    '/wsl-settings-ui.js', '/start-page-ui.js', '/plan-ui.js', '/views.js', '/views-ui.js', '/focus-return.js',
    '/scroll-controller.js', '/chat-cache.js', '/chat.js', '/elicitation-ui.js', '/docs.css', '/doc-ui.js', '/doc-toolbar.js',
    '/doc-panels.js', '/doc.html', '/remote-loader.html', '/vendor/xterm/xterm.js', '/vendor/xterm/addon-fit.js',
    '/vendor/xterm/addon-canvas.js', '/vendor/xterm/xterm.css', '/vendor/docs/editor.js', '/vendor/code/editor.js',
  ];
  const TAG = 'aib-attention';

  /* Which shell file a GET answers from the cache when AIB can't be reached, or '' (not a shell file: never cached). */
  function shellPath(url, mode, origin) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return '';
    }
    if (u.origin !== origin || u.pathname.startsWith('/api/')) return '';
    if (mode === 'navigate') {
      // the loader at / picks the page (phase 1b); a phone that kept / from before goes on to its page from the loader
      if (u.pathname === '/' || u.pathname === '/phone.html' || u.pathname === '/pc.html' || u.pathname === '/doc.html') {
        return u.pathname;
      }
      return '';
    }
    return SHELL_FILES.includes(u.pathname) || PC_FILES.includes(u.pathname) ? u.pathname : '';
  }

  /* The buttons a notification may have, and the ones that act on AIB (they need the push's one-time code). */
  const ACTS = ['allow', 'deny', 'reply', 'continue', 'retry', 'open'];
  const CODED = ['allow', 'deny', 'continue', 'retry'];
  const MAX_ACTIONS = 2; // Android Chrome shows no more (Notification.maxActions)

  /* The notification a push shows: {title, options}. Only the words the server sent, nothing else; its buttons only from the known
     list, at most `max` (and never more than 2). */
  function notificationOf(data, max) {
    const d = data && typeof data === 'object' ? data : {};
    const text = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
    const silent = d.silent === true;
    const limit = Math.max(0, Math.min(Number(max) || MAX_ACTIONS, MAX_ACTIONS));
    const actions = (Array.isArray(d.actions) ? d.actions : [])
      .filter((a) => a && ACTS.includes(a.action) && typeof a.title === 'string')
      .slice(0, limit)
      .map((a) => ({ action: a.action, title: a.title.slice(0, 20) }));
    const key = text(d.key, 600);
    const n = {
      title: text(d.title, 120) || 'AIB',
      options: {
        body: text(d.body, 400),
        tag: TAG,
        renotify: !silent,
        silent, // Finished only: no sound or vibration (a chat that needs you still rings)
        icon: '/icons/icon-256.png',
        badge: '/icons/badge-96.png', // the status bar's small icon (Android draws its alpha only; without it a grey square)
        data: { chat: text(d.chat, 100), sheet: d.sheet === true, open: text(d.open, 320) },
      },
    };
    if (key) {
      n.options.data.key = key;
      if (typeof d.code === 'string' && d.code) n.options.data.code = d.code.slice(0, 100);
      if (actions.length) n.options.actions = actions;
    }
    return n;
  }

  /* The phone page on a chat: its waiting card open (sheet), its composer focused (reply), a short note (a button that failed). */
  function chatUrl(chat, o) {
    const x = o || {};
    const note = typeof x.note === 'string' && /^[a-z_]{1,20}$/.test(x.note) ? x.note : '';
    return (
      '/phone.html#chat=' + encodeURIComponent(String(chat || '').slice(0, 100)) + (x.sheet ? '&sheet=1' : '') + (x.reply ? '&reply=1' : '') +
      (note ? '&note=' + note : '')
    );
  }

  /* What a tap does: {act, key, code} (sent to AIB from here) or {url} (a page opens). action: the button ('' for the body). */
  function clickPlan(data, action) {
    const d = data && typeof data === 'object' ? data : {};
    if (CODED.includes(action) && d.key && d.code) return { act: action, key: String(d.key), code: String(d.code) };
    if (action === 'reply' && d.chat) return { url: chatUrl(d.chat, { reply: true }) };
    if (action && d.chat) return { url: chatUrl(d.chat, { sheet: d.sheet === true }) }; // Open, or a button without its code
    return { url: openUrl(d) };
  }

  /* Where a tap goes: the page the server named for this device (`open`: the computer page or the phone page, on the chat), else
     the phone page on the chat (with its sheet up for Needs you). Only this origin's two pages: never another address. */
  function openUrl(data) {
    const d = data && typeof data === 'object' ? data : {};
    if (typeof d.open === 'string' && /^\/(pc|phone)\.html(#[A-Za-z0-9=&%._~-]{0,300})?$/.test(d.open)) return d.open;
    if (!d.chat) return '/phone.html';
    return '/phone.html#chat=' + encodeURIComponent(d.chat) + (d.sheet ? '&sheet=1' : '');
  }

  /* The device token the phone page keeps (IndexedDB aib-phone, kv "device": phone.js stored). '' when there is none. */
  function deviceToken() {
    return new Promise((resolve) => {
      let req;
      try {
        req = self.indexedDB.open('aib-phone', 2);
      } catch {
        return resolve('');
      }
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        if (!d.objectStoreNames.contains('chats')) d.createObjectStore('chats', { keyPath: 'key' });
      };
      req.onerror = () => resolve('');
      req.onsuccess = () => {
        const d = req.result;
        const done = (v) => {
          d.close();
          resolve(v);
        };
        try {
          const get = d.transaction('kv', 'readonly').objectStore('kv').get('device');
          get.onsuccess = () => done(get.result && typeof get.result.token === 'string' ? get.result.token : '');
          get.onerror = () => done('');
        } catch {
          done('');
        }
      };
    });
  }

  /* Sends a button to AIB: {ok: true} or {ok: false, code} ("offline" when AIB could not be reached). */
  async function sendAct(plan, fetcher, token) {
    if (!token) return { ok: false, code: 'unknown' };
    let r;
    try {
      r = await fetcher('/api/remote/notify-act', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-AIB-Device': token },
        body: JSON.stringify({ key: plan.key, act: plan.act, code: plan.code }),
      });
    } catch {
      return { ok: false, code: 'offline' };
    }
    if (r.ok) return { ok: true };
    if (r.status >= 500) return { ok: false, code: 'offline' }; // Serve answers 502 while AIB is closed
    let code = 'failed';
    try {
      const j = await r.json();
      if (j && typeof j.code === 'string' && /^[a-z_]{1,20}$/.test(j.code)) code = j.code;
    } catch {
      /* no body */
    }
    return { ok: false, code };
  }

  const api = { SHELL, SHELL_FILES, PC_FILES, TAG, MAX_ACTIONS, shellPath, notificationOf, openUrl, clickPlan, chatUrl, sendAct };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
    return;
  }

  self.addEventListener('install', (event) => {
    event.waitUntil(
      self.caches
        .open(SHELL)
        .then((cache) => cache.addAll(SHELL_FILES))
        .catch(() => {})
        .then(() => self.skipWaiting()),
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      self.caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => self.caches.delete(k))))
        .then(() => self.clients.claim()),
    );
  });

  async function shell(request, path) {
    const cached = () => self.caches.open(SHELL).then((cache) => cache.match(path));
    let response;
    try {
      response = await self.fetch(request);
    } catch (error) {
      const copy = await cached();
      if (copy) return copy;
      throw error;
    }
    if (response.ok) {
      const copy = response.clone();
      self.caches.open(SHELL).then((cache) => cache.put(path, copy)).catch(() => {});
      return response;
    }
    if (response.status >= 500) return (await cached()) || response;
    return response;
  }

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;
    const path = shellPath(request.url, request.mode, self.location.origin);
    if (path) event.respondWith(shell(request, path));
  });

  /* takes a chat's notification away (its request was answered somewhere else) */
  async function closeFor(key) {
    const list = await self.registration.getNotifications({ tag: TAG });
    for (const n of list) if (n.data && n.data.key === key) n.close();
  }

  async function onPush(data) {
    if (data && data.type === 'close') {
      if (typeof data.key === 'string' && data.key) await closeFor(data.key);
      return;
    }
    const n = notificationOf(data, self.Notification && self.Notification.maxActions);
    await self.registration.showNotification(n.title, n.options);
  }

  /* a page opens (or an open one of the same kind is told) on what the tap asked for */
  async function openPage(url, data, extra) {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // an open page of the same kind takes it (a computer's /pc.html, a phone's /phone.html)
    const want = url.split('#')[0];
    const page = all.find((c) => {
      try {
        const u = new URL(c.url);
        return u.origin === self.location.origin && u.pathname === want;
      } catch {
        return false;
      }
    });
    if (page) {
      try {
        await page.focus();
      } catch {
        /* focus needs the tap's user activation (always there on a real tap); the page is still told */
      }
      page.postMessage(Object.assign({ type: 'aib-open', chat: data.chat || '', sheet: !!data.sheet }, extra || {}));
      return;
    }
    await self.clients.openWindow(url);
  }

  async function onClick(notification, action) {
    const data = (notification && notification.data) || {};
    notification.close();
    const plan = clickPlan(data, action || '');
    if (plan.act) {
      const done = await sendAct(plan, (u, o) => self.fetch(u, o), await deviceToken());
      if (done.ok) return { done: true, act: plan.act };
      // it did not work: the chat, with a short note why (phone.js NOTIFY_NOTES)
      await openPage(chatUrl(data.chat, { note: done.code }), data, { sheet: false, note: done.code });
      return { done: false, act: plan.act, code: done.code };
    }
    await openPage(plan.url, data, action === 'reply' ? { sheet: false, reply: true } : null);
    return { done: false, act: action || 'open', opened: plan.url };
  }

  /* an event's work, kept alive by waitUntil; the newest is kept for tests (a test's dispatched event cannot be waited on) */
  function hold(event, work) {
    const p = work.catch((error) => ({ done: false, error: String((error && error.message) || error) }));
    self.__aibLast = p;
    try {
      event.waitUntil(p);
    } catch {
      /* an untrusted (test) event */
    }
  }

  self.addEventListener('push', (event) => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = {};
    }
    hold(event, onPush(data));
  });

  self.addEventListener('notificationclick', (event) => {
    hold(event, onClick(event.notification, event.action));
  });
})(typeof self !== 'undefined' ? self : globalThis);
