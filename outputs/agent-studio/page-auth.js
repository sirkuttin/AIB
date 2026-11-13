/* How the page proves it is the page, so bootstrap gives it the token (server/web/page_access.ts).

   AIB opens its window (and `serve --open` the browser) on /#aib-key=<launch key>. This script takes the key out of the address
   bar at once, keeps it for this tab (sessionStorage: a reload still works) and trades it for a page session that this origin keeps
   (localStorage: the next AIB start, a new tab or a bookmark work without the link). Every bootstrap request sends both headers;
   the server accepts either. Loaded first, before any script that asks for the token. */
(function () {
  'use strict';
  const SESSION = 'aib-page-session',
    KEY = 'aib-page-key',
    SHAPE = /^[A-Za-z0-9_-]{32,128}$/;
  const store = (area) => {
    try {
      return window[area] || null;
    } catch {
      return null; // storage turned off
    }
  };
  const read = (area, name) => {
    try {
      return store(area)?.getItem(name) || '';
    } catch {
      return '';
    }
  };
  const write = (area, name, value) => {
    try {
      store(area)?.setItem(name, value);
    } catch {}
  };

  let launchKey = '';
  const hash = String(location.hash || '').replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const fromLink = params.get('aib-key') || '';
  if (SHAPE.test(fromLink)) {
    launchKey = fromLink;
    write('sessionStorage', KEY, launchKey);
    params.delete('aib-key');
    const rest = params.toString();
    try {
      history.replaceState(history.state, '', location.pathname + location.search + (rest ? '#' + rest : ''));
    } catch {}
  } else {
    const kept = read('sessionStorage', KEY);
    if (SHAPE.test(kept)) launchKey = kept;
  }

  function headers() {
    const out = {};
    const session = read('localStorage', SESSION);
    if (SHAPE.test(session)) out['X-AIB-Page-Session'] = session;
    if (launchKey) out['X-AIB-Page-Key'] = launchKey;
    return out;
  }
  /** fetch() options for GET /api/live/bootstrap: `extra` plus the page's headers. */
  function init(extra) {
    const base = extra || {};
    return Object.assign({}, base, { headers: Object.assign({}, base.headers || {}, headers()) });
  }

  // A key from the link: make sure this origin keeps a lasting page session (the one it has, when AIB still knows it).
  if (fromLink && launchKey) {
    fetch('/api/live/page-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: launchKey, session: read('localStorage', SESSION) }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (b && SHAPE.test(b.session || '')) write('localStorage', SESSION, b.session);
      })
      .catch(() => {});
  }

  // The app window sent to /#aib-key=... while already on / (it landed there without the key, server/desktop/window.ts
  // #ensureConnected): only the fragment changes, so the page is not loaded again by itself. Reload it with the key still in the
  // address, so the code above takes it and pairs, as on a first load.
  window.addEventListener('hashchange', () => {
    const key = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get('aib-key') || '';
    if (SHAPE.test(key)) location.reload();
  });

  window.AIBPageAuth = { headers, init };
})();
