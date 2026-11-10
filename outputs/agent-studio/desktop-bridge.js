(function (root) {
  'use strict';
  // The page's bridge to the AIB desktop app (`deno desktop`, server/desktop/window.ts). In a plain browser none of this exists and
  // every call reports "not available", so the callers fall back to what they did before (the server's folder picker, the web
  // Notification API).
  //   * pickFolder() always rejects "The desktop app is not available": deno desktop has no native folder dialog, so the page
  //     uses the server's picker (server/desktop/folders.ts, a PowerShell dialog on Windows) in the app too.
  //   * notify(title, body) / notifyReady() / requestNotifications(): the app's Deno-side notifications, through the functions the
  //     app binds into its window (`bindings.aibNotify`, `bindings.aibNotifyReady`, `bindings.aibRequestNotifications`). Every
  //     frame of the window can call them, so the app only shows notifications with them, rate-limited.
  //   * Links: in the app, a plain click on an http(s) link to another origin would load that site in the app window. The click is
  //     turned into window.open, which the app hands to the system browser (as it does for target=_blank).
  // `invoke(name, args)` calls bindings[name](...args); it can be replaced for tests with setInvoke().
  let override = null;
  const invoke = () => {
    if (override) return override;
    const b = root.bindings;
    if (!b || typeof b.aibNotify !== 'function') return null;
    return (name, args) => {
      const fn = b[name];
      return typeof fn === 'function' ? fn.apply(b, args || []) : Promise.reject(new Error('The desktop app is not available'));
    };
  };
  const available = () => !!invoke();

  function pickFolder() {
    return Promise.reject(new Error('The desktop app is not available'));
  }

  function notifyReady() {
    const call = invoke();
    if (!call) return Promise.resolve(false);
    return Promise.resolve(call('aibNotifyReady', [])).then(
      (v) => v === true,
      () => false,
    );
  }

  // Resolves with 'granted' or 'denied'.
  function requestNotifications() {
    const call = invoke();
    if (!call) return Promise.resolve('denied');
    return Promise.resolve(call('aibRequestNotifications', [])).then(
      (v) => (v === 'granted' ? 'granted' : 'denied'),
      () => 'denied',
    );
  }

  function notify(title, body) {
    const call = invoke();
    if (!call) return Promise.reject(new Error('The desktop app is not available'));
    return Promise.resolve(call('aibNotify', [String(title || ''), String(body || '')]));
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
    notifyReady,
    requestNotifications,
    isExternal,
    onLinkClick,
    setInvoke(fn) {
      override = typeof fn === 'function' ? fn : null;
    },
  };
  root.AibDesktop = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
