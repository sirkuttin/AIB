/* The computer page's way in (remote control from other PCs, phase 1b; design v2 section 11). /pc.html is chat.html with this file
   in place of page-auth.js (server/remote/pc_page.ts pcShell): the page's own scripts run unchanged, and this file makes them talk
   to the PC as a paired computer.

   * The device key: a computer keeps NO long-lived key in its browser profile (any program on that computer can read the profile).
     What stays across browser restarts is the pairing's HttpOnly cookie (page scripts cannot read it); with it this file asks the PC
     for a short session token (POST /api/remote/pc/session; 12 h, renewed here) and keeps that in memory only. The record in
     IndexedDB ('aib-phone', store 'kv', key 'device') holds the device's name and id, never a key. A computer paired before this
     still has its key there: it is traded once for the cookie (POST /api/remote/pc/adopt, the old key stops working) and removed.
     Never the page token: no request from this page carries X-Studio-Token or any other page credential (the
     server refuses them); every API call carries X-AIB-Device (the session token), every socket the subprotocol aib-device.<it>.
   * Start: the page's scripts come in the shell as <script type="text/x-aib-later" data-src>; this file first reads the key, the
     remote bootstrap (GET /api/remote/pc/bootstrap: no token, launch key, state folder, process ids or loopback addresses) and
     this computer's own layout (GET /api/remote/pc/view-prefs), puts the layout where view-prefs.js reads it, then runs the
     scripts in order. The PC's layout is never read or written from here: panel widths, text size, tabs are this computer's.
   * A few page routes have a remote form (the bootstrap, the layout, Settings, WSL status, and phase 2's presence: this
     computer's tabs, slot ids made by the PC from the device) and a few are the PC's alone (its editors, desktop notifications,
     Settings changes): those are answered here without asking the PC.
   * window.AIBRemote: what the page scripts check (caps.remote) to hide what a computer cannot do (Open in editor becomes
     Download; Browse… goes, the folder is typed; Settings shows Appearance and This computer only). The server decides anyway. */
(function (root) {
  'use strict';
  const doc = root.document;
  const html = doc.documentElement;
  const REFUSED = [
    'X-Studio-Token',
    'X-AIB-Page-Key',
    'X-AIB-Page-Session',
    'X-Studio-Artifact-Key',
    'X-Studio-Hook-Key',
    'X-Studio-Hook-Nonce',
    'X-Agent-Host-Token',
  ]; // the bridge's REFUSED_HEADERS (server/remote/pc_bridge.ts): never sent from here
  const NAME_KEY = 'aib-remote-pc-name'; // the PC's name, for the "Can't reach" line before the PC answers (not a secret)
  const S = { token: '', session: false, timer: 0, boot: null, pushOn: false, pushKey: '', install: null, installed: false, started: false };
  const realFetch = root.fetch.bind(root);
  const RealSocket = root.WebSocket;

  /* Memory only on another computer (security review SF6): what was typed or sent and the chats' names never go to its disk, so a
     laptop that is lost and kept offline holds none of it (the 401 wipe needs the PC). The page's scripts keep these in
     localStorage on the PC; here those keys live in this window's memory. Copies an older page left on disk go now. */
  const MEMORY_KEYS = new Set([
    'studio-drafts-v1', // drafts
    'studio-pending-sends-v1', // messages mid-send (chat.js rememberSend), with their attachments
    'studio-prompt-attempts-v1', // send attempts
    'studio-conversation-names', // chat names
  ]);
  (function memoryOnly() {
    let ls = null;
    try {
      ls = root.localStorage;
    } catch {}
    if (!ls || !root.Storage) return;
    const P = root.Storage.prototype;
    const get = P.getItem, set = P.setItem, drop = P.removeItem;
    const mem = new Map();
    for (const k of MEMORY_KEYS)
      try {
        drop.call(ls, k);
      } catch {}
    const ours = (store, k) => store === ls && MEMORY_KEYS.has(String(k));
    P.getItem = function (k) {
      return ours(this, k) ? (mem.has(String(k)) ? mem.get(String(k)) : null) : get.call(this, k);
    };
    P.setItem = function (k, v) {
      if (ours(this, k)) mem.set(String(k), String(v));
      else set.call(this, k, v);
    };
    P.removeItem = function (k) {
      if (ours(this, k)) mem.delete(String(k));
      else drop.call(this, k);
    };
  })();

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
        // no version: the phone page's own (2 since saved copies of chats); a version lower than the stored one would fail
        req = root.indexedDB.open('aib-phone');
      } catch {
        return resolve(null);
      }
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        // saved copies of chats are phone-only (a device switched from Phone to Computer): a computer keeps chats in memory only (SF6)
        try {
          if (req.result.objectStoreNames.contains('chats')) req.result.transaction('chats', 'readwrite').objectStore('chats').clear();
        } catch { /* not available */ }
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

  /* The device record without any key: what a computer keeps in the profile (its name and id are not secrets). */
  function keepRecord(saved) {
    return new Promise((resolve) => {
      try {
        const req = root.indexedDB.open('aib-phone');
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction('kv', 'readwrite');
            const device = Object.assign({}, saved && saved.device, { kind: 'computer' });
            tx.objectStore('kv').put({ device }, 'device');
            tx.oncomplete = () => {
              req.result.close();
              resolve(true);
            };
            tx.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }
  /* A session token from the HttpOnly pairing cookie (a cross-site page cannot send the X-AIB-Session header). One call at a time.
     Resolves true with S.token set; false when the PC does not know this cookie (removed, or the cookie is gone: pair again). */
  let renewing = null;
  let renewGone = false;
  const SESSION_RENEW_MS = 3 * 3600 * 1000; // the PC's sessions last 12 h
  function renew() {
    if (renewing) return renewing;
    renewing = (async () => {
      try {
        const r = await realFetch('/api/remote/pc/session', {
          method: 'POST',
          headers: { 'X-AIB-Session': '1', 'Content-Type': 'application/json' },
          body: '{}',
          cache: 'no-store',
          credentials: 'same-origin',
        });
        renewGone = r.status === 401 || r.status === 403; // the PC does not know this cookie (not: it did not answer)
        if (!r.ok) return false;
        const b = await r.json();
        if (!b || typeof b.token !== 'string' || !b.token) return false;
        S.token = b.token;
        return true;
      } catch {
        return false;
      }
    })().finally(() => {
      renewing = null;
    });
    return renewing;
  }
  /* A computer paired before sessions: its stored key is traded once for the cookie and a session, then dropped from the profile. */
  async function adopt(saved) {
    let r;
    try {
      r = await realFetch('/api/remote/pc/adopt', {
        method: 'POST',
        headers: { 'X-AIB-Device': saved.token, 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch {
      return 'offline';
    }
    if (r.status === 401) return 'gone';
    if (r.status === 403) return 'phone';
    if (!r.ok) return 'offline';
    const b = await r.json().catch(() => null);
    if (!b || typeof b.token !== 'string' || !b.token) return 'offline';
    S.token = b.token;
    await keepRecord(saved);
    return 'ok';
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
    // phase 2: this computer's own presence (the PC makes the slot ids from the device; the answer lists only this computer's tabs
    // and says `quiet` while you are at another device: no chime or notification of this page's own then)
    if (path === '/api/live/presence' && method === 'POST') return '/api/remote/pc/presence';
    // this browser's own windows (phase 4): opened, routed and focused here by remote-windows.js, never on the PC's screen
    if (path === '/api/live/desktop/windows' && method === 'POST' && root.AIBRemoteWindows) return windowsHere;
    if (path.startsWith('/api/live/desktop/') || path.startsWith('/api/live/devices') || path === '/api/live/open') return pcOnly;
    return null;
  }
  const offlineAnswer = () => answer(503, { error: "Can't reach " + pcName() + '. Trying again…', code: 'offline' });
  const parsed = (init) => {
    try {
      return init && typeof init.body === 'string' ? JSON.parse(init.body) : null;
    } catch {
      return null;
    }
  };
  /* POST /api/live/desktop/windows: answered at once (no await before window.open), so the click that asked still counts and the
     browser lets the window open. */
  function windowsHere(init) {
    const r = root.AIBRemoteWindows.handle(parsed(init));
    return r && typeof r.then === 'function' ? r.then((x) => answer(x.status, x.body)) : answer(r.status, r.body);
  }

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
    // the page's presence report also tells this browser's other windows what this one shows (remote-windows.js)
    if (url.pathname === '/api/live/presence' && method === 'POST' && root.AIBRemoteWindows) root.AIBRemoteWindows.report(parsed(init));
    if (typeof instead === 'function') return instead(init); // nothing goes to the PC
    // Offline (phase 4): nothing is sent or queued until the PC answers again; the page keeps what it shows (in memory only)
    if (net.down && url.pathname !== '/api/remote/pc/bootstrap') return offlineRefusal(method);
    if (typeof instead === 'string') url.pathname = instead;
    const headers = new Headers((init && init.headers) || (req ? req.headers : undefined));
    for (const name of REFUSED) headers.delete(name);
    if (S.token) headers.set('X-AIB-Device', S.token);
    const options = Object.assign({}, init || {}, { headers, credentials: 'same-origin' });
    if (req && !(init && 'body' in init) && method !== 'GET' && method !== 'HEAD') options.body = await req.clone().arrayBuffer();
    if (!options.method) options.method = method;
    // keepalive bodies are capped at 64 KB in all; a bigger one goes without
    if (options.keepalive && !(typeof options.body === 'string' && options.body.length < 32000)) delete options.keepalive;
    let response;
    try {
      response = await realFetch(url.pathname + url.search, options);
    } catch (error) {
      // no answer at all (Tailscale off here, the PC asleep or offline). The page says "Connection lost …" for this request:
      // a POST may have arrived, so the page's own words (check the chat before retrying) stay true.
      if (!(error && error.name === 'AbortError')) lost('unreachable');
      throw error;
    }
    if (response.status === 401 && S.session && (await renew())) {
      // the session ended (AIB restarted, or 12 h passed): the cookie asked for a new one, and this request goes again once
      headers.set('X-AIB-Device', S.token);
      try {
        response = await realFetch(url.pathname + url.search, Object.assign({}, options, { headers }));
      } catch (error) {
        if (!(error && error.name === 'AbortError')) lost('unreachable');
        throw error;
      }
    }
    if (response.status === 401) removed(response.clone());
    // Tailscale Serve answers 502/503/504 itself (not JSON) when nothing listens behind it: AIB is closed on the PC
    if (response.status >= 502 && response.status <= 504 && !/json/i.test(response.headers.get('content-type') || '')) {
      lost('down');
      return offlineRefusal(method);
    }
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

  /* Pictures the page shows from an API address (a saved chat's pictures: /api/transcript/image): an <img> cannot send the device
     key, so each one is fetched with it and shown from memory (blob:, which the page's CSP allows). Only that route: an address
     agent-written content puts in the page is never fetched with the key (security review SF7). */
  const IMG_API = /^\/api\/transcript\/image\?/;
  function keyedImage(img) {
    const src = img.getAttribute('src') || '';
    if (!IMG_API.test(src) || img.dataset.remoteSrc === src) return;
    img.dataset.remoteSrc = src;
    img.removeAttribute('src');
    remoteFetch(src)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (blob && img.dataset.remoteSrc === src) img.src = URL.createObjectURL(blob);
      })
      .catch(() => {});
  }
  new root.MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes' && m.target.tagName === 'IMG') keyedImage(m.target);
      for (const n of m.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') keyedImage(n);
        else if (n.querySelectorAll) for (const img of n.querySelectorAll('img[src^="/api/transcript/image?"]')) keyedImage(img);
      }
    }
  }).observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

  /* Removed on the PC (401 not_paired): this page's storage and the cached shell go now (drafts, layout picks); the phone page then
     says so and forgets the key (one place for both kinds: phone.js removed() also wipes the origin). */
  let leaving = false;
  function dropRecord() {
    return new Promise((resolve) => {
      try {
        const req = root.indexedDB.open('aib-phone');
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          try {
            const tx = req.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').delete('device');
            tx.oncomplete = () => {
              req.result.close();
              resolve(true);
            };
            tx.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        };
      } catch {
        resolve(false);
      }
    });
  }
  async function wipe() {
    try {
      root.localStorage.clear();
    } catch { /* not available */ }
    try {
      root.sessionStorage.clear();
    } catch { /* not available */ }
    try {
      if (root.caches) for (const name of await root.caches.keys()) await root.caches.delete(name);
    } catch { /* not available */ }
  }
  function removed(response) {
    response
      .json()
      .then(async (b) => {
        if (b && b.code === 'not_paired' && !leaving) {
          leaving = true;
          await wipe();
          root.location.replace('/phone.html');
        }
      })
      .catch(() => {});
  }

  // ---- start ----
  const bootCall = () =>
    realFetch('/api/remote/pc/bootstrap', { headers: { 'X-AIB-Device': S.token }, cache: 'no-store', credentials: 'same-origin' });
  async function refreshBoot() {
    let r = await bootCall();
    if (r.status === 401 && S.session && (await renew())) r = await bootCall();
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
    if (!r.ok) throw new Error(r.status >= 502 && r.status <= 504 ? 'down' : 'offline');
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
  /* ---- offline (phase 4; design v2 section 10) ----
     The PC does not answer: a bar in the page's notice look says so ("Can't reach <PC>. Trying again…  Try now"; "AIB is closed on
     <PC>" once Tailscale Serve has said for 20 s that nothing listens there), and the page keeps showing what it showed: from
     memory only, nothing is written to the Cache API, IndexedDB or any other storage for it. While offline nothing is sent and
     nothing is queued: every request of the page is answered here at once (503 offline), so nothing can go out later by itself.
     It tries again every 5 s, every 30 s after 2 minutes, or at once on Try now; when the PC answers, the bar goes and the page's
     own polls carry on from their cursors (no event lost, nothing sent again). Removed while offline: the first 401 not_paired
     wipes this origin's storage (removed()). */
  const CLOSED_AFTER_MS = 20000;
  const net = { down: false, why: '', since: 0, timer: 0, note: '' };
  function offlineRefusal(method) {
    return answer(503, {
      error: "Can't reach " + pcName() + (method === 'GET' || method === 'HEAD' ? '. Trying again…' : '. Nothing was sent.'),
      code: 'offline',
    });
  }
  function barText() {
    if (net.note) return net.note; // updates-ui.js: "Updating AIB on <PC>…" while AIB restarts for an update
    if (net.why === 'down') {
      return Date.now() - net.since < CLOSED_AFTER_MS
        ? 'AIB on ' + pcName() + ' is not answering. Trying again…'
        : 'AIB is closed on ' + pcName() + '. Trying again…';
    }
    return "Can't reach " + pcName() + '. Trying again…';
  }
  function showBar() {
    let box = doc.getElementById('remoteOffline');
    if (!box) {
      box = doc.createElement('div');
      box.id = 'remoteOffline';
      box.className = 'remote-offline';
      box.setAttribute('role', 'status');
      const text = doc.createElement('span');
      const again = doc.createElement('button');
      again.type = 'button';
      again.className = 'remote-offline-try';
      again.textContent = 'Try now';
      again.addEventListener('click', () => (S.started ? probe() : start()));
      box.append(text, again);
      (doc.body || html).prepend(box);
    }
    box.firstChild.textContent = barText();
  }
  function retryIn() {
    root.clearTimeout(net.timer);
    net.timer = root.setTimeout(() => (S.started ? probe() : start()), Date.now() - net.since > 120000 ? 30000 : 5000);
  }
  function goOffline(why) {
    if (!net.down) {
      net.down = true;
      net.since = Date.now();
      html.setAttribute('data-remote-offline', '');
    }
    net.why = why;
  }
  /* A request of the started page got no answer: offline at once (nothing more is sent), one quick look a second later, and the
     bar only when that look fails too (a one-off blip shows nothing). */
  function lost(why) {
    if (!S.started || leaving) return;
    const first = !net.down;
    goOffline(why);
    if (first) {
      root.clearTimeout(net.timer);
      net.timer = root.setTimeout(probe, 1000);
    }
  }
  let probing = null;
  function probe() {
    if (probing) return probing;
    root.clearTimeout(net.timer);
    probing = (async () => {
      let why = '';
      try {
        let r = await bootCall();
        if (r.status === 401 && S.session && (await renew())) r = await bootCall();
        if (r.status === 401 || r.status === 403) {
          removed(r.clone());
          return;
        }
        if (r.ok && /json/i.test(r.headers.get('content-type') || '')) {
          S.boot = await r.json();
          paintCaps();
          back();
          return;
        }
        why = 'down';
      } catch {
        why = 'unreachable';
      }
      goOffline(why);
      showBar();
      retryIn();
    })().finally(() => {
      probing = null;
    });
    return probing;
  }
  /* The PC answers again: the bar goes, the page's "Connection lost" line too, and the page reads on from where it was. */
  function back() {
    root.clearTimeout(net.timer);
    const was = net.down;
    net.down = false;
    net.why = '';
    net.since = 0;
    html.removeAttribute('data-remote-offline');
    const box = doc.getElementById('remoteOffline');
    if (box) box.remove();
    const err = doc.getElementById('error');
    if (was && err && /^(Connection lost|Can't reach|Request timed out)/.test(err.textContent || '')) err.hidden = true;
    if (was) root.dispatchEvent(new Event('aib-remote-back'));
  }
  async function start() {
    const saved = await record();
    if (!saved) {
      root.location.replace('/'); // not paired here: the loader goes on to pairing
      return;
    }
    S.session = true;
    if (typeof saved.token === 'string' && saved.token) {
      const how = await adopt(saved);
      // another window of this computer may have traded the key a moment ago: its cookie is ours too
      if (how === 'gone' && (await renew())) await keepRecord(saved);
      else if (how === 'gone' && !renewGone) {
        goOffline('unreachable');
        showBar();
        retryIn();
        return;
      } else if (how === 'gone' && !leaving) {
        leaving = true;
        await wipe();
        root.location.replace('/phone.html');
        return;
      }
      if (how === 'phone' && !leaving) {
        leaving = true;
        root.location.replace('/phone.html');
        return;
      }
      if (how === 'offline') {
        // the PC can't be reached: the old key stays where it was until the PC answers (nothing is lost)
        goOffline('unreachable');
        showBar();
        retryIn();
        return;
      }
    } else if (!S.token && !(await renew())) {
      if (!renewGone) {
        // the PC did not answer (asleep, AIB restarting): say so and try again; nothing is forgotten
        goOffline('unreachable');
        showBar();
        retryIn();
        return;
      }
      // the cookie is gone (browser data cleared) or this computer was removed on the PC: pair again
      if (!leaving) {
        leaving = true;
        await wipe();
        await dropRecord();
        root.location.replace('/phone.html#unpaired'); // the phone page's "no longer paired" screen with Pair again
      }
      return;
    }
    if (!S.timer) S.timer = root.setInterval(() => renew(), SESSION_RENEW_MS);
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
      goOffline(error && error.message === 'down' ? 'down' : 'unreachable');
      showBar();
      retryIn();
      return;
    }
    back();
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
  /* The push names the live chat (its id); the page opens chats by their lasting key (<agent>:<session>). */
  async function openChat(chat) {
    const N = root.AgentNotifyUI;
    if (!chat || !N || typeof N.openFromDesktop !== 'function') return;
    let key = String(chat);
    try {
      const r = await remoteFetch('/api/live/list');
      const list = r.ok ? await r.json() : {};
      const c = (Array.isArray(list.connections) ? list.connections : []).find((x) => x && x.id === chat);
      if (c && c.provider && c.sessionId) key = c.provider + ':' + c.sessionId;
    } catch {
      /* the key as it came */
    }
    // the page may still be starting: wait (a few seconds at most) until its chat list has the chat
    const sel = '#connections [data-key="' + (root.CSS && root.CSS.escape ? root.CSS.escape(key) : key) + '"]';
    for (let i = 0; i < 40 && !doc.querySelector(sel); i++) await new Promise((resolve) => root.setTimeout(resolve, 250));
    for (let i = 0; i < 20; i++) {
      if (N.openFromDesktop({ type: 'chat', key }) !== false) return;
      await new Promise((resolve) => root.setTimeout(resolve, 250));
    }
  }
  function openFromAddress() {
    const m = /^#chat=([^&]+)/.exec(root.location.hash || '');
    if (!m) return;
    try {
      root.history.replaceState(null, '', root.location.pathname);
    } catch {}
    openChat(decodeURIComponent(m[1]));
  }
  /* Phase 2: the tab is closing: its presence slot goes at once (window-context.js sends this with the page token on the PC). */
  root.addEventListener('pagehide', () => {
    const W = root.AibWindow;
    if (!S.token || !W || typeof W.id !== 'function') return;
    try {
      realFetch('/api/remote/pc/presence', {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-AIB-Device': S.token },
        body: JSON.stringify({ w: W.id(), left: true, page: typeof W.page === 'function' ? W.page() : undefined }),
      }).catch(() => {});
    } catch {
      /* the page is going */
    }
  });
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
  const pushEnv = () => ({
    navigator: root.navigator,
    Notification: root.Notification,
    PushManager: root.PushManager,
    keyBytes,
    pcName: pcName(),
    async getKey() {
      if (!S.pushKey) await bootPush();
      return S.pushKey;
    },
    async register() {
      const reg = await root.navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await root.navigator.serviceWorker.ready;
      return reg;
    },
    async send(subscription) {
      const r = await remoteFetch('/api/remote/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    },
  });
  const push = {
    state: () => ({
      supported: pushSupported(),
      allowed: can('phone.push'),
      blocked: typeof root.Notification === 'function' && root.Notification.permission === 'denied',
      on: S.pushOn,
      brave: !!root.navigator.brave,
    }),
    async on() {
      await root.AIBPushEnable.enable(pushEnv()); // throws Error(one line with the fix in it) for every failure
      S.pushOn = true;
    },
    /** A notification from this browser itself, to see that it works. */
    test: () => root.AIBPushEnable.showTest(pushEnv()),
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

  /* Phase 1c: any file of the Files view as a download (binary, large, or not shown as text), through the computer-only route
     GET /api/pc/files/download (at most 20 MiB; the PC logs the path, never the content). `d`: the Files scope args ({id, root:
     'chat' | 'main'} or {root: 'project', project}) plus {path, name}.
     Resolves to '' when it worked, else the PC's reason. */
  async function downloadFile(d) {
    const q = new URLSearchParams();
    if (d && d.root === 'project') {
      q.set('root', 'project');
      q.set('project', String(d.project));
    } else {
      q.set('id', String((d && d.id) || ''));
      q.set('root', String((d && d.root) || 'chat'));
    }
    q.set('path', String((d && d.path) || ''));
    const r = await root.fetch('/api/pc/files/download?' + q.toString(), { cache: 'no-store', credentials: 'same-origin' });
    if (!r.ok) {
      const b = await r.json().catch(() => ({}));
      return b.error || 'The download did not work (' + r.status + ').';
    }
    const blob = await r.blob();
    const a = doc.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = String((d && (d.name || d.path)) || 'file').split(/[\/]/).pop() || 'file';
    doc.body.append(a);
    a.click();
    a.remove();
    root.setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    return '';
  }

  root.AIBRemote = {
    kind: 'pc',
    caps: { remote: true },
    pcName,
    can,
    scopes,
    /* updates-ui.js: what the offline bar says instead while AIB restarts for an update ('' = the usual words) */
    setNote(text) {
      net.note = String(text || '');
      const box = doc.getElementById('remoteOffline');
      if (box && box.firstChild) box.firstChild.textContent = barText();
    },
    device: () => (S.boot && S.boot.device) || null,
    push,
    install,
    downloadText,
    downloadFile,
  };
  // a phone page shell or the loader never loads this file; the doc page does (pc_page.ts)
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', () => start(), { once: true });
  else start();
})(window);
