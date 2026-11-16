/* The computer page's way in (remote control from other PCs, phase 1b; design v2 section 11). /pc.html is chat.html with this file
   in place of page-auth.js (server/remote/pc_page.ts pcShell): the page's own scripts run unchanged, and this file makes them talk
   to the PC as a paired computer.

   * The device key: where the phone page keeps it (IndexedDB 'aib-phone', store 'kv', key 'device'), the same record for phones
     and computers. Never the page token: no request from this page carries X-Studio-Token or any other page credential (the
     server refuses them); every API call carries X-AIB-Device, every socket the subprotocol aib-device.<key>.
   * Start: the page's scripts come in the shell as <script type="text/x-aib-later" data-src>; this file first reads the key, the
     remote bootstrap (GET /api/remote/pc/bootstrap: no token, launch key, state folder, process ids or loopback addresses) and
     this computer's own layout (GET /api/remote/pc/view-prefs), puts the layout where view-prefs.js reads it, then runs the
     scripts in order. The PC's layout is never read or written from here: panel widths, text size, tabs are this computer's.
   * A few page routes have a remote form (the bootstrap, the layout, Settings, WSL status) and a few are the PC's alone (its
     editors, desktop notifications, window presence, Settings changes): those are answered here without asking the PC.
   * window.AIBRemote: what the page scripts check (caps.remote) to hide what a computer cannot do (Open in editor becomes
     Download; Browse… goes, the folder is typed; Settings shows Appearance and This computer only). The server decides anyway. */
(function (root) {
  'use strict';
  const doc = root.document;
  const html = doc.documentElement;
  const REFUSED = ['X-Studio-Token', 'X-AIB-Page-Key', 'X-AIB-Page-Session', 'X-Studio-Artifact-Key', 'X-Studio-Hook-Key'];
  const NAME_KEY = 'aib-remote-pc-name'; // the PC's name, for the "Can't reach" line before the PC answers (not a secret)
  const S = { token: '', boot: null, pushOn: false, pushKey: '', install: null, installed: false, started: false };
  const realFetch = root.fetch.bind(root);
  const RealSocket = root.WebSocket;

  const kept = () => {
    try {
      return root.localStorage.getItem(NAME_KEY) || '';
    } catch {
      return '';
    }
  };
  const pcName = () => (S.boot && S.boot.pcName) || kept() || 'the PC';
  const scopes = () => (S.boot && S.boot.device && Array.isArray(S.boot.device.scopes) ? S.boot.device.scopes : []);
  const can = (scope) => scopes().includes(scope);

  // ---- the device record (phone.js keeps it; the loader reads it too) ----
  function record() {
    return new Promise((resolve) => {
      let req;
      try {
        req = root.indexedDB.open('aib-phone', 1);
      } catch {
        return resolve(null);
      }
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        try {
          const get = req.result.transaction('kv', 'readonly').objectStore('kv').get('device');
          get.onsuccess = () => resolve(get.result || null);
          get.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      };
    });
  }

  // ---- answers made here ----
  const answer = (status, body) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  const pcOnly = () => answer(403, { error: 'Change this on ' + pcName() + '.', code: 'pc_only' });
  /* The shape the page scripts read from GET /api/live/bootstrap, made from the remote bootstrap. `token` is only a placeholder the
     scripts check is there; this file takes it off every request (it is never a credential). */
  function pageBootstrap() {
    const b = S.boot || {};
    return {
      token: 'remote',
      instanceId: b.instanceId || '',
      webInstanceId: b.instanceId || '',
      artifactOrigin: b.artifactOrigin || '',
      hostMode: 'remote',
      server: { version: b.version || '', versionLabel: b.version || '' },
      features: b.features || {},
      connections: [],
      remote: true,
    };
  }
  /* Page route -> what a computer does instead: [the remote route] or a function answering here. */
  function local(method, path) {
    if (path === '/api/live/bootstrap') return () => refreshBoot().then(() => answer(200, pageBootstrap()), offlineAnswer);
    if (path === '/api/live/view-prefs' && method === 'POST') return '/api/remote/pc/view-prefs';
    if (path === '/api/live/settings') return method === 'GET' ? '/api/remote/pc/settings' : pcOnly;
    if (path === '/api/live/wsl/status' && method === 'GET') return '/api/remote/pc/wsl-status';
    // the PC's programs and screen: no editors here (Files offers Download), no desktop notifications or window lists
    if (path === '/api/live/editors') return () => answer(200, { editors: [], default: '', workspaces: [] });
    if (path === '/api/live/presence') return () => answer(200, { ok: true, windows: [], openAll: [] });
    if (path.startsWith('/api/live/desktop/') || path.startsWith('/api/live/devices') || path === '/api/live/open') return pcOnly;
    return null;
  }
  const offlineAnswer = () => answer(503, { error: "Can't reach " + pcName() + '. Trying again…', code: 'offline' });

  // ---- every request of the page ----
  async function remoteFetch(input, init) {
    const req = input instanceof Request ? input : null;
    let url;
    try {
      url = new URL(req ? req.url : String(input), root.location.href);
    } catch {
      return realFetch(input, init);
    }
    if (url.origin !== root.location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
    const instead = local(method, url.pathname);
    if (typeof instead === 'function') return instead(); // nothing goes to the PC
    if (typeof instead === 'string') url.pathname = instead;
    const headers = new Headers((init && init.headers) || (req ? req.headers : undefined));
    for (const name of REFUSED) headers.delete(name);
    if (S.token) headers.set('X-AIB-Device', S.token);
    const options = Object.assign({}, init || {}, { headers, credentials: 'same-origin' });
    if (req && !(init && 'body' in init) && method !== 'GET' && method !== 'HEAD') options.body = await req.clone().arrayBuffer();
    if (!options.method) options.method = method;
    // keepalive bodies are capped at 64 KB in all; a bigger one goes without
    if (options.keepalive && !(typeof options.body === 'string' && options.body.length < 32000)) delete options.keepalive;
    const response = await realFetch(url.pathname + url.search, options);
    if (response.status === 401) removed(response.clone());
    return response;
  }
  root.fetch = remoteFetch;

  /* The page's sockets (terminal, docs): the device key as a subprotocol instead of the page token. */
  function RemoteSocket(url, protocols) {
    let list = protocols == null ? [] : Array.isArray(protocols) ? protocols.slice() : [protocols];
    list = list.filter((p) => !/^aib-token\./.test(String(p)));
    if (S.token) list.push('aib-device.' + S.token);
    return new RealSocket(url, list);
  }
  RemoteSocket.prototype = RealSocket.prototype;
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) RemoteSocket[k] = RealSocket[k];
  root.WebSocket = RemoteSocket;

  /* Removed on the PC (401 not_paired): the phone page says so and forgets the key (one place for both kinds). */
  let leaving = false;
  function removed(response) {
    response
      .json()
      .then((b) => {
        if (b && b.code === 'not_paired' && !leaving) {
          leaving = true;
          root.location.replace('/phone.html');
        }
      })
      .catch(() => {});
  }

  // ---- start ----
  async function refreshBoot() {
    const r = await realFetch('/api/remote/pc/bootstrap', {
      headers: { 'X-AIB-Device': S.token },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (r.status === 401 || r.status === 403) {
      removed(r.clone());
      const b = await r.json().catch(() => ({}));
      // a phone's key on the computer page: the phone page is its own
      if (b.code === 'not_computer' && !leaving) {
        leaving = true;
        root.location.replace('/phone.html');
      }
      throw new Error(b.error || 'This computer is not paired with ' + pcName() + '.');
    }
    if (!r.ok) throw new Error('offline');
    S.boot = await r.json();
    try {
      if (S.boot.pcName) root.localStorage.setItem(NAME_KEY, S.boot.pcName);
    } catch {}
    paintCaps();
    return S.boot;
  }
  /* What this computer may do, on <html> for the stylesheet (remote.css): data-can-<switch> per switch that is on. Hidden from the
     first paint (the server writes data-remote="pc" into the shell), so nothing jumps. */
  function paintCaps() {
    for (const s of ['pc.files', 'pc.terminal', 'pc.projects', 'pc.always', 'phone.prompt', 'phone.start', 'phone.approve']) {
      html.toggleAttribute('data-can-' + s.split('.')[1], can(s));
    }
  }
  function offlineScreen(message) {
    let box = doc.getElementById('remoteOffline');
    if (!box) {
      box = doc.createElement('div');
      box.id = 'remoteOffline';
      box.className = 'remote-offline';
      box.setAttribute('role', 'status');
      const text = doc.createElement('span');
      const again = doc.createElement('button');
      again.type = 'button';
      again.textContent = 'Try now';
      again.addEventListener('click', () => start());
      box.append(text, again);
      doc.body.prepend(box);
    }
    box.firstChild.textContent = message;
  }
  let retryMs = 5000,
    firstFail = 0;
  async function start() {
    const saved = await record();
    if (!saved || typeof saved.token !== 'string' || !saved.token) {
      root.location.replace('/'); // not paired here: the loader goes on to pairing
      return;
    }
    S.token = saved.token;
    let prefs;
    try {
      const both = await Promise.all([
        refreshBoot(),
        realFetch('/api/remote/pc/view-prefs', {
          headers: { 'X-AIB-Device': S.token },
          cache: 'no-store',
          credentials: 'same-origin',
        }).then((r) => (r.ok ? r.json() : { prefs: {} })),
      ]);
      prefs = both[1];
    } catch (error) {
      if (leaving) return;
      // AIB closed on the PC, or the PC can't be reached: say so and try again (every 5 s, every 30 s after 2 minutes)
      if (!firstFail) firstFail = Date.now();
      if (Date.now() - firstFail > 120000) retryMs = 30000;
      offlineScreen("Can't reach " + pcName() + '. Trying again…');
      root.setTimeout(start, retryMs);
      return;
    }
    const box = doc.getElementById('remoteOffline');
    if (box) box.remove();
    if (S.started) return;
    S.started = true;
    // this computer's layout, where view-prefs.js reads it (the PC's own is never here)
    const block = doc.createElement('script');
    block.type = 'application/json';
    block.id = 'aibViewPrefs';
    block.textContent = JSON.stringify({ prefs: (prefs && prefs.prefs) || {} }).replace(/</g, '\\u003c');
    doc.head.append(block);
    bootPush();
    await runLater();
    // the page's scripts that wait for DOMContentLoaded (it came before they were loaded)
    doc.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
    openFromAddress();
  }
  /* The page's own scripts, in their order, each after the one before. */
  async function runLater() {
    const later = [...doc.querySelectorAll('script[type="text/x-aib-later"]')];
    for (const old of later) {
      await new Promise((resolve) => {
        const s = doc.createElement('script');
        s.src = old.getAttribute('data-src');
        s.async = false;
        s.onload = s.onerror = resolve;
        old.replaceWith(s);
      });
    }
  }

  // ---- a notification click: /pc.html#chat=<id>, or a message from the service worker while this page is open ----
  function openChat(chat) {
    const N = root.AgentNotifyUI;
    if (chat && N && typeof N.openFromDesktop === 'function') N.openFromDesktop({ type: 'chat', key: String(chat) });
  }
  function openFromAddress() {
    const m = /^#chat=([^&]+)/.exec(root.location.hash || '');
    if (!m) return;
    try {
      root.history.replaceState(null, '', root.location.pathname);
    } catch {}
    openChat(decodeURIComponent(m[1]));
  }
  if (root.navigator.serviceWorker) {
    root.navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'aib-open') openChat(e.data.chat);
    });
  }

  // ---- notifications on this computer (Web Push; Settings > This computer) ----
  const pushSupported = () => !!(root.navigator.serviceWorker && root.PushManager && typeof root.Notification === 'function');
  function keyBytes(text) {
    const pad = '='.repeat((4 - (text.length % 4)) % 4);
    const raw = root.atob((text + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  async function bootPush() {
    try {
      const r = await realFetch('/api/remote/bootstrap', { headers: { 'X-AIB-Device': S.token }, cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const b = await r.json();
      S.pushKey = (b.push && typeof b.push.key === 'string' && b.push.key) || '';
      S.pushOn = !!(b.push && b.push.on === true);
      if (root.navigator.serviceWorker) await root.navigator.serviceWorker.register('/sw.js', { scope: '/' });
    } catch {
      /* Settings > This computer says what is wrong when it is used */
    }
  }
  async function post(path, body) {
    const r = await remoteFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      throw new Error(b.error || 'That did not work. Try again.');
    }
  }
  const push = {
    state: () => ({
      supported: pushSupported(),
      allowed: can('phone.push'),
      blocked: typeof root.Notification === 'function' && root.Notification.permission === 'denied',
      on: S.pushOn,
    }),
    async on() {
      if (!pushSupported()) throw new Error('This browser cannot show notifications from AIB.');
      const permission = await root.Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notifications were not allowed in this browser.');
      if (!S.pushKey) await bootPush();
      if (!S.pushKey) throw new Error("Can't reach " + pcName() + '. Try again.');
      const reg = await root.navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await root.navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(S.pushKey) });
      await post('/api/remote/push/subscribe', { subscription: sub.toJSON() });
      S.pushOn = true;
    },
    async off() {
      try {
        const reg = await root.navigator.serviceWorker.getRegistration('/');
        const sub = reg && (await reg.pushManager.getSubscription());
        if (sub) await sub.unsubscribe();
      } catch {}
      await post('/api/remote/push/unsubscribe', {});
      S.pushOn = false;
    },
  };

  // ---- Install AIB (Edge, Chrome): the browser's offer, kept for Settings > This computer ----
  root.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    S.install = e;
  });
  root.addEventListener('appinstalled', () => {
    S.install = null;
    S.installed = true;
  });
  const install = {
    can: () => !!S.install,
    installed: () => S.installed || (root.matchMedia && root.matchMedia('(display-mode: standalone)').matches),
    async run() {
      const e = S.install;
      if (!e) return;
      S.install = null;
      await e.prompt();
    },
  };

  /* Files on another computer: Download instead of Open in editor. A file shown as text downloads from what the page already has;
     anything else is phase 1c's download route (downloadFile). */
  function downloadText(name, text) {
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(new Blob([String(text)], { type: 'application/octet-stream' }));
    a.download = String(name || 'file').split(/[\\/]/).pop() || 'file';
    doc.body.append(a);
    a.click();
    a.remove();
    root.setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  root.AIBRemote = {
    kind: 'pc',
    caps: { remote: true },
    pcName,
    can,
    scopes,
    device: () => (S.boot && S.boot.device) || null,
    push,
    install,
    downloadText,
  };
  // a phone page shell or the loader never loads this file; the doc page does (pc_page.ts)
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => start(), { once: true });
  else start();
})(window);
