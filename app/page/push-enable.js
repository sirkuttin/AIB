'use strict';
/* Turning notifications on in a browser: the steps and, for every way they can fail, one plain line with the fix in it.
   Shared by the computer page (remote-auth.js, Settings > This computer) and the phone page (phone.js). Classic script: both pages
   read window.AIBPushEnable; node tests load it with require (work/test_push_enable.js), with the browser's objects passed in. */
(function (root) {
  const MESSAGES = {
    unsupported: "This browser can't receive push notifications here.",
    blocked: "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.",
    brave:
      "Brave blocks push notifications until you turn on 'Use Google services for push messaging' in brave://settings/privacy, then restart Brave.",
    unreachable: (pc) => "Can't reach " + pc + '. Try again.',
  };

  /** Brave says so on navigator.brave (an object with isBrave()). */
  function isBrave(nav) {
    return !!(nav && nav.brave);
  }

  /** Can this page get push at all: a service worker, PushManager and Notification. */
  function supported(env) {
    return !!(env.navigator && env.navigator.serviceWorker && env.PushManager && typeof env.Notification === 'function');
  }

  /** Is this the error pushManager.subscribe gives when the browser's push service could not be reached or registered with? */
  function isRegistrationFailure(err) {
    const name = err && err.name ? String(err.name) : '';
    const text = err && err.message ? String(err.message) : '';
    return name === 'AbortError' || /registration failed|push service error|push service not available/i.test(text);
  }

  /** The line for pushManager.subscribe rejecting (or the worker not registering). */
  function subscribeMessage(err, env) {
    if (isBrave(env.navigator)) return MESSAGES.brave;
    if (err && err.name === 'NotAllowedError') return MESSAGES.blocked;
    if (isRegistrationFailure(err)) {
      return "This browser's push service refused to register this computer (" + String((err && err.message) || err.name) +
        '). Check that the browser can reach its push service, then try again.';
    }
    return 'The browser could not set up notifications (' + String((err && (err.message || err.name)) || 'unknown error') + '). Try again.';
  }

  /** The host of a subscription's address ("fcm.googleapis.com"), or '' when it has none. */
  function hostOf(endpoint) {
    try {
      return new URL(String(endpoint)).hostname;
    } catch {
      return '';
    }
  }

  /** The line for the PC saying no to a subscription (status and body of POST /api/remote/push/subscribe). */
  function refusedMessage(status, data, endpoint) {
    const reason = (data && (data.error || data.code)) || 'HTTP ' + status;
    const host = hostOf(endpoint);
    if (data && data.code === 'push_service') return String(data.error || reason); // the PC already named the service
    return 'The PC refused this notification address' + (host ? ' (push service ' + host + ')' : '') + ': ' + reason;
  }

  /**
   * Ask for permission, subscribe, give the PC the subscription. Resolves { endpoint } on success, throws Error(line) otherwise.
   * env: { navigator, Notification, PushManager, keyBytes(text), getKey() -> key text or '', register() -> registration,
   *        send(subscription JSON) -> { ok, status, data }, pcName }
   */
  async function enable(env) {
    if (!supported(env)) throw new Error(MESSAGES.unsupported);
    let permission = env.Notification.permission;
    if (permission === 'denied') throw new Error(MESSAGES.blocked);
    if (permission !== 'granted') {
      try {
        permission = await env.Notification.requestPermission();
      } catch {
        permission = 'denied';
      }
    }
    if (permission !== 'granted') throw new Error(MESSAGES.blocked); // denied, or the prompt was dismissed ('default')
    const key = await env.getKey();
    if (!key) throw new Error(MESSAGES.unreachable(env.pcName));
    let sub;
    try {
      const reg = await env.register();
      let existing = await reg.pushManager.getSubscription();
      sub = existing || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: env.keyBytes(key) }));
    } catch (err) {
      throw new Error(subscribeMessage(err, env));
    }
    const json = sub.toJSON();
    const r = await env.send(json);
    if (!r.ok) throw new Error(refusedMessage(r.status, r.data, json.endpoint));
    return { endpoint: json.endpoint };
  }

  /** A notification from this browser itself (no round trip to the PC): shows that notifications reach this computer. */
  async function showTest(env) {
    if (!supported(env) || env.Notification.permission !== 'granted') throw new Error(MESSAGES.blocked);
    const reg = await env.register();
    await reg.showNotification('AIB', { body: 'This is a test notification.', tag: 'aib-test' });
  }

  const api = { MESSAGES, isBrave, supported, isRegistrationFailure, subscribeMessage, refusedMessage, hostOf, enable, showTest };
  root.AIBPushEnable = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
