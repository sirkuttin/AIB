/* WebKit harness: plays the PC behind Tailscale Serve for remote-auth.js (installed before it captures fetch). */
window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => window.__errors.push('rejection ' + String(e.reason)));
window.__mode = 'up';
window.__posts = [];
(function () {
  const orig = window.fetch.bind(window);
  const json = (b, s) => new Response(JSON.stringify(b), { status: s || 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return orig(input, init);
    if (window.__mode === 'unreachable') throw new TypeError('Load failed');
    if (window.__mode === 'down') return new Response('Bad Gateway', { status: 502, headers: { 'Content-Type': 'text/plain' } });
    if (init && init.method === 'POST') window.__posts.push(url.pathname);
    if (url.pathname === '/api/remote/pc/bootstrap')
      return json({ layout: 'pc', pcName: 'DESK', device: { id: 'd1', name: 'Mac', kind: 'computer', scopes: ['phone.prompt'] }, instanceId: 'i', version: 'x', artifactOrigin: '', features: {} });
    if (url.pathname === '/api/remote/pc/view-prefs') return json({ prefs: {} });
    if (url.pathname === '/api/remote/bootstrap') return json({ push: { on: false, key: '' } });
    return json({ ok: true });
  };
  // the device record where the page reads it (IndexedDB aib-phone/kv/device): written on the first load, read on the second
  if (!localStorage.getItem('seeded')) {
    document.documentElement.dataset.seeding = '1';
    const req = indexedDB.open('aib-phone', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ token: 'tok', device: { id: 'd1' } }, 'device');
      tx.oncomplete = () => {
        localStorage.setItem('seeded', '1');
        location.reload();
      };
    };
  }
})();
