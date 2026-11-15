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
  /**
   * The agents found in a distro: {agents: [{id, found, version?, note?, install?, installable?, pinned?, managed?, update?, job?,
   * installBlock?, nodeInstall?}]}; cached per distro for a minute. force: ask now, and let the distro look for Node.js again.
   */
  const agentCache = new Map();
  function agents(key, again, force) {
    const k = String(key).toLowerCase(),
      hit = agentCache.get(k);
    if (hit && (hit.busy || (!force && Date.now() - hit.at < 60000))) return hit.value;
    const rec = hit || { at: 0, busy: false, value: null };
    rec.busy = true;
    agentCache.set(k, rec);
    if (host && host.getJson)
      Promise.resolve(host.getJson('/api/live/wsl/agents', force ? { distro: k, force: '1' } : { distro: k }))
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
  /**
   * Settings > AIB Linking (WSL): the distro's agents without starting it (peek=1). A distro that is not running answers
   * {state, line, agents: []}; only o.start (the "Start Ubuntu and check" click) asks the server to start it. A ready answer also
   * refreshes the new-chat panel's cache; a not-ready one never touches it (the panel would read "not installed" from it).
   */
  function peekAgents(key, o) {
    const k = String(key).toLowerCase(),
      opts = o || {};
    if (!host || !host.getJson) return Promise.reject(Error('Not ready'));
    const params = { distro: k, peek: '1' };
    if (opts.start) params.start = '1';
    if (opts.force) params.force = '1';
    return Promise.resolve(host.getJson('/api/live/wsl/agents', params)).then((r) => {
      const value = r && typeof r === 'object' ? r : {};
      if (!Array.isArray(value.agents)) value.agents = [];
      const ready = (!value.state || value.state === 'ready') && value.agents.length > 0;
      if (ready) agentCache.set(k, { at: Date.now(), busy: false, value });
      return value;
    });
  }
  /** One agent's row in a distro, or null while unknown. */
  function agentIn(key, id, again) {
    const list = agents(key, again);
    return list ? list.agents.find((a) => a && a.id === id) || { id, found: false } : null;
  }

  // ---- AIB's own install of an agent in a distro ("Install in Ubuntu") ------------------------------------------------------
  // The job runs in the distro (its helper), so it goes on while AIB or the page restarts. Here: the Install / Update button, a
  // progress bar with Cancel, polling once a second while it runs, the failure line with Retry, and, while Node.js is missing in the
  // distro, the line that says so with the command that installs it (Copy) and Check again. The same states as Settings' installs.
  const jobs = new Map(); // "<key>\0<agent>" -> {state: running|failed|refused, stage, percent, message}
  const jobTimers = new Map();
  const painters = new Map(); // the one panel shown per agent: repaints when its job changes
  const jobKey = (key, id) => String(key).toLowerCase() + '\0' + id;
  const STAGES = {
    preparing: 'Getting ready…',
    downloading: 'Downloading and unpacking…',
    verifying: 'Checking the install…',
  };
  function installJob(key, id) {
    return jobs.get(jobKey(key, id)) || null;
  }
  const jobListeners = []; // Settings > AIB Linking (WSL) repaints from the same store: there is no second one
  function setJob(key, id, job) {
    const k = jobKey(key, id);
    if (job) jobs.set(k, job);
    else jobs.delete(k);
    const paint = painters.get(k);
    if (paint) paint();
    for (const fn of jobListeners) {
      try {
        fn(String(key).toLowerCase(), id, job || null);
      } catch {
        /* a listener's problem stays its own */
      }
    }
  }
  function onJob(fn) {
    if (typeof fn === 'function') jobListeners.push(fn);
  }
  /** A job the agent list reports (running or failed, e.g. after a reload): kept in the store and, while it runs, polled. */
  function trackJob(key, id, job, done) {
    const k = jobKey(key, id);
    if (!jobs.has(k) && job && (job.state === 'running' || job.state === 'failed')) jobs.set(k, job);
    const now = jobs.get(k);
    if (now && now.state === 'running' && !jobTimers.has(k)) pollJob(key, id, done);
    return now || null;
  }
  /** Look at the distro's agents again (an install finished, or Node.js may be there now). */
  function forget(key) {
    agentCache.delete(String(key).toLowerCase());
  }
  function pollJob(key, id, done) {
    const k = jobKey(key, id);
    if (jobTimers.has(k) || typeof root.setTimeout !== 'function') return;
    jobTimers.set(
      k,
      root.setTimeout(() => {
        jobTimers.delete(k);
        if (!host || !host.getJson) return;
        Promise.resolve(host.getJson('/api/live/wsl/agents/install', { distro: String(key).toLowerCase(), agent: id })).then(
          (state) => applyJob(key, id, state, done),
          () => pollJob(key, id, done), // AIB is restarting: the job goes on in the distro, so keep asking
        );
      }, 1000),
    );
  }
  function applyJob(key, id, state, done) {
    if (state && state.state === 'running') {
      setJob(key, id, state);
      pollJob(key, id, done);
      return;
    }
    setJob(key, id, state && state.state === 'failed' ? state : null);
    forget(key); // finished (or cancelled, or failed): the agent list says what is there now
    if (done) done();
  }
  function startInstall(key, id, done) {
    setJob(key, id, { state: 'running', stage: 'preparing', percent: 2 });
    return post('wsl/agents/install', { distro: String(key).toLowerCase(), agent: id }).then(
      (state) => applyJob(key, id, state, done),
      (error) => {
        const code = (error && error.code) || '';
        // Node.js missing: the panel's Node.js line (from the agent list, looked at again) says it, with no Retry
        if (/^node_|^npm_/.test(code)) {
          setJob(key, id, null);
          forget(key);
          agents(key, done, true);
          return;
        }
        setJob(key, id, { state: 'refused', message: (error && error.message) || 'The install could not be started.' });
      },
    );
  }
  function cancelInstall(key, id, done) {
    return post('wsl/agents/install/cancel', { distro: String(key).toLowerCase(), agent: id }).then(
      (state) => applyJob(key, id, state, done),
      (error) => {
        const job = installJob(key, id);
        if (job) job.cancelError = (error && error.message) || 'The install could not be cancelled.';
        setJob(key, id, job);
      },
    );
  }
  function copyButton(text) {
    const copy = el('button', 'Copy', 'st-link');
    copy.type = 'button';
    copy.onclick = () =>
      Promise.resolve(root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText(text)).then(
        () => (copy.textContent = 'Copied'),
        () => {},
      );
    return copy;
  }
  /**
   * The install panel of one agent row (o: {key, id, agentName, row, done: repaint the new-chat panel, openShell?}). Only for a
   * row the server marks installable that is missing, or AIB's own install that is older than the version AIB pins (row.update).
   */
  function installBox(o) {
    const box = el('div', null, 'nc-wsl-install');
    const k = jobKey(o.key, o.id),
      name = distroName(o.key),
      row = o.row || {};
    if (!jobs.has(k) && row.job && (row.job.state === 'running' || row.job.state === 'failed')) jobs.set(k, row.job);
    const paint = () => {
      box.replaceChildren();
      const job = installJob(o.key, o.id);
      const verb = row.update ? 'Update' : 'Install';
      if (job && job.state === 'running') {
        if (!jobTimers.has(k)) pollJob(o.key, o.id, o.done);
        const percent = Math.max(0, Math.min(100, Number(job.percent) || 0));
        const line = el(
          'p',
          (row.update ? 'Updating ' : 'Installing ') + o.agentName + ' in ' + name + '… ' + (STAGES[job.stage] || ''),
          'st-note',
        );
        line.setAttribute('role', 'status');
        const bar = el('div', null, 'st-progress');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-label', (row.update ? 'Updating ' : 'Installing ') + o.agentName + ' in ' + name);
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', String(percent));
        const fill = el('div', null, 'st-progress-bar');
        fill.style.width = percent + '%';
        bar.append(fill);
        const actions = el('p', null, 'st-note');
        const cancel = el('button', 'Cancel', 'st-link');
        cancel.type = 'button';
        cancel.title = 'Stop the install and remove what it downloaded so far';
        cancel.onclick = () => {
          cancel.disabled = true;
          cancelInstall(o.key, o.id, o.done);
        };
        actions.append(cancel);
        box.append(line, bar, actions);
        if (job.cancelError) box.append(el('p', job.cancelError, 'st-note bad'));
        return;
      }
      if (job && (job.state === 'failed' || job.state === 'refused')) box.append(el('p', job.message || 'The install failed.', 'st-note bad'));
      if (row.update) {
        box.append(
          el(
            'p',
            'AIB now uses ' + o.agentName + ' ' + row.pinned + '; ' + name + ' has ' + (row.version || 'an older one') + '.',
            'st-note',
          ),
        );
      }
      const blocked = row.installBlock || '';
      if (blocked) {
        box.append(el('p', blocked, 'st-note dim'));
        if (row.nodeInstall) {
          const cmd = el('code', row.nodeInstall, 'nc-wsl-cmd');
          const line = el('p', null, 'st-note');
          line.append('Install Node.js in ' + name + ': ', cmd, ' ', copyButton(row.nodeInstall));
          box.append(line);
        }
      }
      const actions = el('p', null, 'st-note');
      const go = el('button', job ? 'Retry' : verb + ' in ' + name, 'primary nc-wsl-go');
      go.type = 'button';
      go.disabled = !!blocked;
      go.title = blocked
        ? 'Needs Node.js in ' + name + ' first'
        : 'AIB installs ' + o.agentName + (row.pinned ? ' ' + row.pinned : '') + ' into its own folder in ' + name +
          ' (~/.aib-server/agents), with the versions AIB reviewed. Nothing else in ' + name + ' changes.';
      go.onclick = () => {
        go.disabled = true;
        startInstall(o.key, o.id, o.done);
      };
      actions.append(go);
      if (blocked) {
        const again = el('button', 'Check again', 'st-link');
        again.type = 'button';
        again.title = 'Look for Node.js in ' + name + ' again';
        again.onclick = () => {
          again.disabled = true;
          agents(o.key, o.done, true);
        };
        actions.append(again);
      }
      box.append(actions);
    };
    painters.set(k, paint);
    paint();
    return box;
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
    peekAgents,
    forget,
    installBox,
    installJob,
    trackJob,
    onJob,
    startInstall,
    cancelInstall,
    redraw: draw,
    status: () => status,
    available: () => !!status.available,
    loaded: () => loaded,
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
