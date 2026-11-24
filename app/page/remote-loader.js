/* The phone port's first page, at / (remote control from other PCs, phase 1b; design v2 section 6, re-review fix 8).
   A page address cannot carry the device's key, so the server cannot pick the page: this one reads the device record where the
   phone page keeps it (IndexedDB 'aib-phone', store 'kv', key 'device': {token, device}; a computer's is {device} only) and opens
     * /phone.html with no record (its pairing page, which says "computer" in a computer's browser), or for a phone;
     * /pc.html for a device the PC approved as a computer (the server says which: GET /api/remote/bootstrap `layout`).
   QR links go straight to /phone.html#p=..., never through here. The cookie is never used to pick a page. Nothing secret is here:
   every API call still needs the key. */
(function (root) {
  'use strict';
  const go = (page) => root.location.replace(page + (root.location.hash || ''));
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
  async function start() {
    const saved = await record();
    // a computer keeps no key in this profile (its pairing cookie is HttpOnly): its record is the device's name and id only, and the
    // computer page asks the PC for a session with the cookie (remote-auth.js)
    if (saved && !saved.token && saved.device && saved.device.kind === 'computer') return go('/pc.html');
    if (!saved || typeof saved.token !== 'string' || !saved.token) return go('/phone.html');
    const kept = saved.device && saved.device.kind === 'computer' ? '/pc.html' : '/phone.html';
    let r;
    try {
      r = await root.fetch('/api/remote/bootstrap', {
        headers: { 'X-AIB-Device': saved.token },
        cache: 'no-store',
        credentials: 'same-origin',
      });
    } catch {
      return go(kept); // AIB can't be reached: the page it had says so (from the service worker's copy)
    }
    if (!r.ok) return go(r.status === 401 ? '/phone.html' : kept); // removed: the phone page says so and forgets the key
    let boot = {};
    try {
      boot = await r.json();
    } catch {}
    go(boot.layout === 'pc' ? '/pc.html' : '/phone.html');
  }
  start();
})(window);
