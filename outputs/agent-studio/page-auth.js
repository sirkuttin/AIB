/* How the page proves it is the page, so bootstrap gives it the token (server/web/page_access.ts).

   The page holds a page session in this script's memory only: never in localStorage, sessionStorage or IndexedDB, which are plain
   files in the browser profile that any program of the user (an agent's shell included) can read. It gets the session by trading a
   one-time launch key (POST /api/live/page-session), which it receives
     - in the app window: from the desktop side, through the window's private channel (server/desktop/window.ts calls
       AIBPageAuth.accept(key)), at every load. The page asks for one at once through the app's binding (bindings.aibPageKey); the
       key never appears in the URL, so nothing about it lands in the browser's history or session-restore files.
     - in a browser: in the link `serve` prints or opens (/#aib-key=<key>). It is taken out of the address bar at once
       (history.replaceState). A reload in a browser needs a new link (the key worked once).
     - a window or frame this page's origin opened (a pop-out in a browser) shares its opener's session.
   Every request for /api/live/bootstrap waits until the trade is done (at most WAIT_MS) and carries the session header: this script
   wraps fetch for that one URL, so the callers (AIBPageAuth.init()/headers()) need not wait themselves. Loaded first, before any
   script that asks for the token. */
(function () {
  'use strict';
  const SHAPE = /^[A-Za-z0-9_-]{32,128}$/,
    FRAGMENT = 'aib-key',
    WAIT_MS = 8000;
  // What older versions kept in storage, where any program could read it: gone (the server no longer knows those sessions).
  for (const [area, name] of [
    ['localStorage', 'aib-page-session'],
    ['sessionStorage', 'aib-page-key'],
  ]) {
    try {
      window[area].removeItem(name);
    } catch {}
  }

  const realFetch = window.fetch.bind(window);
  let session = '',
    trading = 0,
    asking = false,
    unconnected = false,
    settled = false,
    settle;
  const ready = new Promise((resolve) => (settle = resolve));
  const done = () => {
    asking = false;
    if (!settled) {
      settled = true;
      settle();
    }
  };
  const bindings = () => {
    try {
      return window.bindings && typeof window.bindings.aibPageKey === 'function' ? window.bindings : null;
    } catch {
      return null;
    }
  };

  /** Trades a one-time launch key for a page session (memory only). Resolves true when it got one. */
  function trade(key) {
    trading++;
    return realFetch('/api/live/page-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && SHAPE.test(b.session || '')) {
          session = b.session;
          return true;
        }
        return false;
      })
      .catch(() => false)
      .finally(() => trading--);
  }

  /** The desktop side hands the page a fresh launch key (server/desktop/window.ts). True when it was taken. */
  function accept(key) {
    key = String(key || '');
    if (!SHAPE.test(key)) return false;
    trade(key).then((ok) => {
      if (!ok && asking) return; // a key that didn't work while the page still waits for one: it asks again (at most WAIT_MS)
      done();
      // The page came up without a session and already showed "not connected": load it again; the window hands the new page a key
      // before its first bootstrap, so this happens once.
      if (ok && unconnected && appWindow) location.reload();
    });
    return true;
  }

  // A key from the link (`serve`, a browser): out of the address bar at once, then traded.
  const params = new URLSearchParams(String(location.hash || '').replace(/^#/, ''));
  const fromLink = params.get(FRAGMENT) || '';
  if (params.has(FRAGMENT)) {
    params.delete(FRAGMENT);
    const rest = params.toString();
    try {
      history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    } catch {}
  }
  // An app window: its URL names its window id (?w=, server/desktop/windows_contract.ts windowPath), or the app's bindings are
  // there already (they may come a moment after this script runs). Only a top frame: the app's bindings exist in every frame, and
  // the window hands its key to the top frame only.
  let appWindow = false;
  try {
    appWindow = window.top === window && (!!bindings() || new URLSearchParams(location.search).has('w'));
  } catch {}
  // A window this page's own origin opened (a pop-out in a browser) or framed: it shares that page's session (same-origin script
  // could read it anyway).
  const kin = (() => {
    for (const w of [window.opener, window.parent !== window ? window.parent : null]) {
      try {
        if (w && w.location.origin === location.origin && w.AIBPageAuth && typeof w.AIBPageAuth.state === 'function') return w.AIBPageAuth;
      } catch {}
    }
    return null;
  })();
  if (SHAPE.test(fromLink)) trade(fromLink).then(done);
  else if (kin) {
    trading++;
    Promise.resolve(kin.ready)
      .then(() => {
        const s = String(kin.state().session || '');
        if (SHAPE.test(s)) session = s;
      })
      .catch(() => {})
      .finally(() => {
        trading--;
        done();
      });
  } else if (appWindow) {
    // Ask the desktop side for a key as soon as its binding is there (it answers through accept); the window's load check sends
    // one too. Bootstrap waits meanwhile, at most WAIT_MS.
    asking = true;
    const started = Date.now();
    const ask = () => {
      if (settled || trading) return;
      const b = bindings();
      if (b) {
        try {
          Promise.resolve(b.aibPageKey()).catch(() => {});
        } catch {}
      }
      // no binding yet: look again soon; asked: ask again if no key came (the handover can fail while the page is still loading)
      if (Date.now() - started < WAIT_MS) setTimeout(ask, b ? 1500 : 25);
    };
    ask();
    setTimeout(done, WAIT_MS);
  } else done();

  function headers() {
    return SHAPE.test(session) ? { 'X-AIB-Page-Session': session } : {};
  }
  /** fetch() options for GET /api/live/bootstrap: `extra` plus the page's headers. */
  function init(extra) {
    const base = extra || {};
    return Object.assign({}, base, { headers: Object.assign({}, base.headers || {}, headers()) });
  }
  /** What the window's load check reads (server/desktop/window.ts PAGE_AUTH_PROBE): the session, and whether one is on its way. */
  function state() {
    return { session, waiting: trading > 0 || asking };
  }

  const isBootstrap = (input) => {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : String(input.url), location.href);
      return url.origin === location.origin && url.pathname === '/api/live/bootstrap';
    } catch {
      return false;
    }
  };
  // Bootstrap waits for the session, and goes with the one the page has by then.
  window.fetch = function (input, options) {
    if (!isBootstrap(input)) return realFetch(input, options);
    return ready.then(() => {
      const h = new Headers((options && options.headers) || undefined);
      h.delete('X-AIB-Page-Session');
      h.delete('X-AIB-Page-Key');
      for (const [k, v] of Object.entries(headers())) h.set(k, v);
      const sent = realFetch(input, Object.assign({}, options || {}, { headers: h }));
      sent
        .then((r) => r.clone().json())
        .then((b) => {
          if (b && !b.token) unconnected = true;
        })
        .catch(() => {});
      return sent;
    });
  };

  // A link with a key opened while this page is already on / (only the fragment changes, so the page is not loaded again by
  // itself): load it again with the key still in the address, so the code above takes it, as on a first load.
  window.addEventListener('hashchange', () => {
    const key = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get(FRAGMENT) || '';
    if (SHAPE.test(key)) location.reload();
  });

  window.AIBPageAuth = { headers, init, accept, state, ready };
})();
