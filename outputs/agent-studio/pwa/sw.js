'use strict';
/* The service worker of the phone port (server/remote/server.ts), served at /sw.js, scope "/": the phone page's and the computer
   page's (phase 1b: one origin, one worker). It cannot ask a page which kind of device it is on (no page at install, none at a
   click with every window closed), so it caches both shells (they hold no secrets) and opens where the server's push says (`open`).
   * Pushes: shows "A chat needs you" / "Chat finished" with the chat's title (the server never sends more), one tag for all of them,
     so a newer push replaces the older. A tap opens the phone page on that chat with its approval or question sheet up: an open
     page is told (postMessage), else /phone.html#chat=<id>&sheet=1 is opened.
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
    '/vendor/xterm/addon-canvas.js', '/vendor/xterm/xterm.css', '/vendor/docs/editor.js',
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

  /* The notification a push shows: {title, options}. Only the words the server sent, nothing else. */
  function notificationOf(data) {
    const d = data && typeof data === 'object' ? data : {};
    const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
    const silent = d.silent === true;
    return {
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
  }

  /* Where a tap goes: the page the server named for this device (`open`: the computer page or the phone page, on the chat), else
     the phone page on the chat (with its sheet up for Needs you). Only this origin's two pages: never another address. */
  function openUrl(data) {
    const d = data && typeof data === 'object' ? data : {};
    if (typeof d.open === 'string' && /^\/(pc|phone)\.html(#[A-Za-z0-9=&%._~-]{0,300})?$/.test(d.open)) return d.open;
    if (!d.chat) return '/phone.html';
    return '/phone.html#chat=' + encodeURIComponent(d.chat) + (d.sheet ? '&sheet=1' : '');
  }

  const api = { SHELL, SHELL_FILES, PC_FILES, TAG, shellPath, notificationOf, openUrl };
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
        // an open page of the same kind takes it (a computer's /pc.html, a phone's /phone.html)
        const want = openUrl(data).split('#')[0];
        const page = all.find((c) => {
          try {
            const u = new URL(c.url);
            return u.origin === self.location.origin && u.pathname === want;
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
