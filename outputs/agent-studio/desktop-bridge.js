(function (root) {
  'use strict';
  // The page's bridge to the AIB desktop app (`deno desktop`, server/desktop/window.ts). In a plain browser none of this exists and
  // every call reports "not available", so the callers fall back to what they did before (the server's folder picker, the web
  // Notification API).
  //   * available(): the app binds one function into its window (`bindings.aibDesktop`); that is how the page knows it runs there.
  //   * pickFolder() always rejects "The desktop app is not available": deno desktop has no native folder dialog, so the page
  //     uses the server's picker (server/desktop/folders.ts, a PowerShell dialog on Windows) in the app too.
  //   * notify(title, body, target, test): the app process shows the notification itself (Windows: a toast from AIB's tray icon;
  //     macOS: osascript; Linux: notify-send), through POST /api/live/desktop/notify (server/desktop/notify.ts). Resolves with the
  //     server's answer {shown, reason}. A click on it brings the window forward and calls AgentNotifyUI.openFromDesktop(target).
  //   * os(): 'windows', 'macos' or 'linux' (for the wording: "Windows notifications" on Windows, "Desktop notifications" elsewhere).
  //   * Links: in the app, a plain click on an http(s) link to another origin would load that site in the app window. The click is
  //     turned into window.open, which the app hands to the system browser (as it does for target=_blank).
  // Tests replace the detection with setInvoke(fn) (any function: "in the app") and the network with setFetch(fn).
  let override = null,
    fetchOverride = null,
    token = '';
  const available = () => {
    if (override) return true;
    const b = root.bindings;
    return !!(b && typeof b.aibDesktop === 'function');
  };

  function pickFolder() {
    return Promise.reject(new Error('The desktop app is not available'));
  }

  function os() {
    const nav = root.navigator || {};
    const s = String(nav.userAgent || '') + ' ' + String(nav.platform || '');
    if (/Windows|Win32|Win64/i.test(s)) return 'windows';
    if (/Mac/i.test(s)) return 'macos';
    return 'linux';
  }

  const doFetch = (url, init) => (fetchOverride || root.fetch.bind(root))(url, init);
  async function getToken(fresh) {
    if (token && !fresh) return token;
    const r = await doFetch('/api/live/bootstrap', { cache: 'no-store' });
    if (!r.ok) throw new Error('bootstrap ' + r.status);
    token = (await r.json()).token || '';
    return token;
  }

  // Resolves {shown: boolean, reason: string}; rejects when not in the app or the server can't be reached.
  async function notify(title, body, target, test) {
    if (!available()) throw new Error('The desktop app is not available');
    const payload = JSON.stringify({
      title: String(title || ''),
      body: String(body || ''),
      target: target && typeof target === 'object' ? target : null,
      test: test === true,
    });
    const send = async (fresh) =>
      doFetch('/api/live/desktop/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Token': await getToken(fresh) },
        body: payload,
      });
    let r = await send(false);
    if (r.status === 401 || r.status === 403) r = await send(true); // the server restarted with a new token
    let data = {};
    try {
      data = await r.json();
    } catch (e) {
      data = {};
    }
    if (!r.ok) throw new Error((data && data.error) || 'The notification could not be sent');
    return { shown: data.shown === true, reason: typeof data.reason === 'string' ? data.reason : '' };
  }

  // The link rule (the same as window.ts isExternal): http(s) on another origin than the page.
  function isExternal(href, pageOrigin) {
    let url;
    try {
      url = new URL(href, pageOrigin);
    } catch (e) {
      return false;
    }
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== new URL(pageOrigin).origin;
  }

  // A click handler for the document (capture phase): in the app, an external link opens in the system browser.
  function onLinkClick(ev) {
    if (!available() || ev.defaultPrevented || ev.button !== 0) return;
    let el = ev.target;
    while (el && !(el.tagName === 'A' && el.href)) el = el.parentNode;
    if (!el || el.hasAttribute('download')) return;
    const origin = root.location && root.location.origin;
    if (!origin || !isExternal(el.href, origin)) return;
    ev.preventDefault();
    root.open(el.href, '_blank', 'noopener');
  }
  if (root.document && typeof root.document.addEventListener === 'function') {
    root.document.addEventListener('click', onLinkClick, true);
  }

  const api = {
    available,
    pickFolder,
    notify,
    os,
    isExternal,
    onLinkClick,
    setInvoke(fn) {
      override = typeof fn === 'function' ? fn : null;
    },
    setFetch(fn) {
      fetchOverride = typeof fn === 'function' ? fn : null;
      token = '';
    },
  };
  root.AibDesktop = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
