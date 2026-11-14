(function (root) {
  'use strict';
  // WSL projects on the page (docs/wsl/design.md section 8). A project or chat folder is a WSL one when its path is a ref
  // `wsl://<distro key><linux path>` (e.g. wsl://ubuntu/home/u/app); refs are split by hand, never URL-parsed. This file holds the
  // helpers every page file uses (names, short paths, tooltips) and the WSL status from GET /api/live/wsl/status: the distros, their
  // state line ("Starting Ubuntu…", "Ubuntu stopped." + Reconnect) and the URLs a distro asks to open ("Ubuntu wants to open …"
  // with Open / Always allow for Ubuntu / Don't open). Both lines use the server-notice look (.studio-notice). Everything is set with
  // textContent. The status is read once at start and every 5 s only while this PC has a WSL2 distro.
  const doc = () => root.document;
  const PREFIX = 'wsl://';
  const POLL_MS = 5000;
  const el = (tag, content, cls) => {
    const n = doc().createElement(tag);
    if (content != null && content !== '') n.textContent = String(content);
    if (cls) n.className = cls;
    return n;
  };

  let host = null,
    status = { available: false, distros: [], openRequests: [] },
    loaded = false,
    polling = false;
  const listeners = [];

  /** {key, linuxPath} of a ref, or null for a Windows path. */
  function parse(ref) {
    const text = typeof ref === 'string' ? ref : '';
    if (!text.startsWith(PREFIX)) return null;
    const rest = text.slice(PREFIX.length),
      at = rest.indexOf('/');
    if (at <= 0) return null;
    return { key: rest.slice(0, at).toLowerCase(), linuxPath: rest.slice(at) || '/' };
  }
  const isWsl = (ref) => parse(ref) !== null;
  const refOf = (key, linuxPath) =>
    PREFIX + String(key).toLowerCase() + '/' + String(linuxPath || '/').replace(/^\/+/, '');

  /** A Windows folder-dialog pick inside a distro (\\wsl.localhost\Ubuntu\home\u or \\wsl$\Ubuntu\...): {name, linuxPath}, else null. */
  function fromUnc(path) {
    const m = /^[\\/]{2}(?:wsl\.localhost|wsl\$)[\\/]([^\\/]+)(.*)$/i.exec(String(path || ''));
    if (!m) return null;
    const rest = m[2].split(/[\\/]+/).filter(Boolean).join('/');
    return { name: m[1], linuxPath: '/' + rest };
  }

  function distro(key) {
    const k = String(key || '').toLowerCase();
    return (status.distros || []).find((d) => d && String(d.key || '').toLowerCase() === k) || null;
  }
  /** The distro as the user named it ("Ubuntu"); the key itself while the status is not known. */
  function distroName(key) {
    const d = distro(key);
    return (d && d.name) || String(key || '');
  }
  /** "~/app" when under the distro user's home, else the Linux path. */
  function shortPath(ref) {
    const p = parse(ref);
    if (!p) return String(ref || '');
    const d = distro(p.key),
      home = d && d.home ? String(d.home).replace(/\/+$/, '') : '';
    if (home && (p.linuxPath === home || p.linuxPath.startsWith(home + '/'))) return '~' + p.linuxPath.slice(home.length);
    return p.linuxPath;
  }
  /** The header's form: "Ubuntu · ~/app". */
  function headerPath(ref) {
    const p = parse(ref);
    return p ? distroName(p.key) + ' · ' + shortPath(ref) : String(ref || '');
  }
  /** A tooltip's form: "Ubuntu: /home/u/app". */
  function tooltip(ref) {
    const p = parse(ref);
    return p ? distroName(p.key) + ': ' + p.linuxPath : String(ref || '');
  }
  /** Any path for display: a WSL ref in the header's form, a Windows path as it is. */
  const displayPath = (path) => (isWsl(path) ? headerPath(path) : String(path || ''));
  /** The state line of the project's distro ('' when it is ready or not WSL). */
  function stateLine(ref) {
    const p = parse(ref);
    if (!p) return '';
    const d = distro(p.key);
    if (!d) return loaded && status.available === false ? distroName(p.key) + ' is not available on this PC.' : '';
    return d.state === 'ready' ? '' : String(d.line || '');
  }

  // ---- status -----------------------------------------------------------------------------------------------------------
  // h: {getJson(path, params), postJson(name, body), currentPath(): the active project's folder or ''}
  function init(h) {
    host = h;
    return refresh();
  }
  function onChange(fn) {
    listeners.push(fn);
  }
  function changed() {
    draw();
    for (const fn of listeners) {
      try {
        fn(status);
      } catch {
        /* a listener's problem stays its own */
      }
    }
  }
  function refresh() {
    if (!host || !host.getJson) return Promise.resolve(status);
    return Promise.resolve(host.getJson('/api/live/wsl/status'))
      .then((s) => {
        loaded = true;
        status = s && typeof s === 'object' ? s : { available: false, distros: [], openRequests: [] };
        if (!Array.isArray(status.distros)) status.distros = [];
        if (!Array.isArray(status.openRequests)) status.openRequests = [];
        changed();
        schedule();
        return status;
      })
      .catch(() => status);
  }
  function schedule() {
    if (polling || !status.available || typeof root.setTimeout !== 'function') return;
    polling = true;
    root.setTimeout(() => {
      polling = false;
      refresh();
    }, POLL_MS);
  }
  function post(name, body) {
    if (!host || !host.postJson) return Promise.reject(Error('Not ready'));
    return Promise.resolve(host.postJson(name, body));
  }
  function reconnect(key) {
    return post('wsl/reconnect', { distro: key }).then(
      () => refresh(),
      () => refresh(),
    );
  }
  function answer(id, action) {
    status.openRequests = (status.openRequests || []).filter((r) => r.id !== id); // gone at once; the next status confirms it
    draw();
    return post('wsl/open-url', { id, action }).then(
      () => refresh(),
      () => refresh(),
    );
  }
  /** Linux folders of a distro for the folder browser: {path, parent, dirs:[{name, isGit}], truncated}. */
  function listDirs(key, path) {
    if (!host || !host.getJson) return Promise.reject(Error('Not ready'));
    return Promise.resolve(host.getJson('/api/live/wsl/dirs', { distro: key, path: path || '' }));
  }
  /** The agents found in a distro: {agents: [{id, found, version?, note?, install?}]}; cached per distro for a minute. */
  const agentCache = new Map();
  function agents(key, again) {
    const k = String(key).toLowerCase(),
      hit = agentCache.get(k);
    if (hit && (hit.busy || Date.now() - hit.at < 60000)) return hit.value;
    const rec = hit || { at: 0, busy: false, value: null };
    rec.busy = true;
    agentCache.set(k, rec);
    if (host && host.getJson)
      Promise.resolve(host.getJson('/api/live/wsl/agents', { distro: k }))
        .then((r) => {
          rec.value = r && Array.isArray(r.agents) ? r : { agents: [] };
        })
        .catch(() => {})
        .then(() => {
          rec.at = Date.now();
          rec.busy = false;
          if (again) again();
        });
    return rec.value;
  }
  /** One agent's row in a distro, or null while unknown. */
  function agentIn(key, id, again) {
    const list = agents(key, again);
    return list ? list.agents.find((a) => a && a.id === id) || { id, found: false } : null;
  }

  // ---- the two lines over the chat (server-notice look) -------------------------------------------------------------------
  const slots = {};
  function slot(id) {
    const d = doc();
    let box = slots[id] || d.getElementById(id);
    if (box) return box;
    const main = d.querySelector('main');
    if (!main) return null;
    box = el('div', null, 'studio-notice wsl-line');
    box.id = id;
    box.setAttribute('role', 'status');
    box.hidden = true;
    const anchor = d.getElementById('studioNotice');
    if (anchor && anchor.after) anchor.after(box);
    else main.prepend ? main.prepend(box) : main.append(box);
    slots[id] = box;
    return box;
  }
  function draw() {
    drawState();
    drawAsk();
  }
  /** "Starting Ubuntu…" / "Setting up AIB in Ubuntu (first time, ~100 MB)" / "Ubuntu stopped." with Reconnect, for the active project. */
  function drawState() {
    const box = slot('wslStateLine');
    if (!box) return;
    const ref = host && host.currentPath ? host.currentPath() : '';
    const line = stateLine(ref),
      p = parse(ref),
      d = p ? distro(p.key) : null;
    box.replaceChildren();
    box.hidden = !line;
    if (!line) return;
    const stopped = !!d && (d.state === 'stopped' || d.state === 'unavailable');
    // The server's text ends with "Reconnect" for a stopped distro: that word becomes the button.
    const text = stopped ? line.replace(/\s*Reconnect\.?$/, '') : line;
    box.append(el('span', text));
    if (stopped) {
      const b = el('button', 'Reconnect', 'wsl-act');
      b.type = 'button';
      b.title = 'Start ' + distroName(p.key) + ' and connect AIB to it again';
      b.onclick = () => {
        b.disabled = true;
        reconnect(p.key);
      };
      box.append(b);
    }
  }
  /** "Ubuntu wants to open <url>": the oldest waiting request, with Open / Always allow for Ubuntu / Don't open. */
  function drawAsk() {
    const box = slot('wslOpenAsk');
    if (!box) return;
    const r = (status.openRequests || [])[0];
    box.replaceChildren();
    box.hidden = !r;
    if (!r) return;
    const name = r.name || distroName(r.distro);
    box.setAttribute('role', 'alert');
    box.append(el('span', name + ' wants to open ' + r.url));
    const act = (label, action, title) => {
      const b = el('button', label, 'wsl-act');
      b.type = 'button';
      if (title) b.title = title;
      b.onclick = () => answer(r.id, action);
      box.append(b);
    };
    act('Open', 'open', 'Open this page in your browser once');
    act('Always allow for ' + name, 'always', 'Open pages ' + name + ' asks for without asking again');
    act("Don't open", 'dismiss');
  }

  const api = {
    init,
    refresh,
    onChange,
    parse,
    isWsl,
    refOf,
    fromUnc,
    distro,
    distroName,
    shortPath,
    headerPath,
    tooltip,
    displayPath,
    stateLine,
    reconnect,
    answer,
    listDirs,
    agents,
    agentIn,
    redraw: draw,
    status: () => status,
    available: () => !!status.available,
    distros: () => (status.distros || []).slice(),
    _set(s) {
      loaded = true;
      status = Object.assign({ available: false, distros: [], openRequests: [] }, s);
      agentCache.clear();
      changed();
    },
    _agentCache: agentCache,
  };
  root.AIBWsl = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
