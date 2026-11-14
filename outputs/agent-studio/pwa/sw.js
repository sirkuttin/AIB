'use strict';
/* The phone page's service worker, served at /sw.js on the phone port only (server/remote/server.ts), scope "/".
   * Pushes: shows "A chat needs you" / "Chat finished" with the chat's title (the server never sends more), one tag for all of them,
     so a newer push replaces the older. A tap opens the phone page on that chat with its approval or question sheet up: an open
     page is told (postMessage), else /phone.html#chat=<id>&sheet=1 is opened.
   * The app shell (the phone page's own files) is cached, never chat content and never /api/*: network first, the cached copy only
     when AIB cannot be reached (Tailscale Serve answers 502 once AIB is closed, or there is no network). Then the page loads anyway
     and says "Reconnecting…", then that AIB is closed on the PC or the PC cannot be reached, with Try again (phone.js).
   Pure helpers are exported for node tests (work/test_phone_sw.js). */
(function (self) {
  const SHELL = 'aib-shell-v2';
  const SHELL_FILES = [
    '/phone.html',
    '/phone.js',
    '/phone.css',
    '/phone-words.js',
    '/markdown.js',
    '/themes.js',
    '/theme.css',
    '/manifest.webmanifest',
    '/icons/icon-256.png',
    '/icons/icon-192.png',
    '/icons/maskable-192.png',
    '/icons/maskable-512.png',
    '/icons/apple-touch-180.png',
    '/icons/badge-96.png',
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
    if (mode === 'navigate') return u.pathname === '/' || u.pathname === '/phone.html' ? '/phone.html' : '';
    return SHELL_FILES.includes(u.pathname) ? u.pathname : '';
  }

  /* The notification a push shows: {title, options}. Only the words the server sent, nothing else. */
  function notificationOf(data) {
    const d = data && typeof data === 'object' ? data : {};
    const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    return {
      title: text(d.title, 120) || 'AIB',
      options: {
        body: text(d.body, 400),
        tag: TAG,
        renotify: true,
        icon: '/icons/icon-256.png',
        badge: '/icons/badge-96.png', // the status bar's small icon (Android draws its alpha only; without it a grey square)
        data: { chat: text(d.chat, 100), sheet: d.sheet === true },
      },
    };
  }

  /* Where a tap goes: the phone page, on the chat (with its sheet up for Needs you). */
  function openUrl(data) {
    const d = data && typeof data === 'object' ? data : {};
    if (!d.chat) return '/phone.html';
    return '/phone.html#chat=' + encodeURIComponent(d.chat) + (d.sheet ? '&sheet=1' : '');
  }

  const api = { SHELL, SHELL_FILES, TAG, shellPath, notificationOf, openUrl };
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

  self.addEventListener('push', (event) => {
    let data = {};
    try {
      data = event.data ? event.data.json() : {};
    } catch {
      data = {};
    }
    const n = notificationOf(data);
    event.waitUntil(self.registration.showNotification(n.title, n.options));
  });

  self.addEventListener('notificationclick', (event) => {
    const data = (event.notification && event.notification.data) || {};
    event.notification.close();
    event.waitUntil(
      (async () => {
        const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const page = all.find((c) => {
          try {
            return new URL(c.url).origin === self.location.origin;
          } catch {
            return false;
          }
        });
        if (page) {
          await page.focus();
          page.postMessage({ type: 'aib-open', chat: data.chat || '', sheet: !!data.sheet });
          return;
        }
        await self.clients.openWindow(openUrl(data));
      })(),
    );
  });
})(typeof self !== 'undefined' ? self : globalThis);
