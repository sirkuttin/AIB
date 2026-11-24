/* The computer page's windows (remote control from other PCs, phase 4; design v2 section 8 "Multi-window on PC #2").
   On the PC the desktop app opens, routes, focuses and closes AIB windows (POST /api/live/desktop/windows, windows_route.ts). On
   another computer that route is the PC's own (its screen), so this file answers it here, in the browser, with the same rules:
     * one project per window: "Open in new window" opens /pc.html?w=<id>&kind=project&project=<key> as a browser window named
       aib-project-<n>; asking again brings that window forward ({existed: true}) instead of a second one;
     * a chat or doc pop-out is a small named popup (/pc.html?…&kind=chat&mode=chat, /doc.html?…&kind=doc); popping out MOVES it
       (the page's own code closes the tab it came from and takes it back when the pop-out goes);
     * route: the pop-out with the chat or doc, else the window pinned to the project, else a main window (a new one if none);
     * at most 8 windows, a window closes only itself.
   Which windows are open: this browser's own windows tell each other over a BroadcastChannel ('aib-remote-windows'), never the
   PC (the PC cannot raise a window on this computer, and the PC's windows are not this computer's). window-context.js reads this
   roster instead of the PC's presence answer when it is here (AIBRemoteWindows.answer). Window ids are 't-<random>' (no
   coordination needed); ids, kinds and keys only, never chat content. Nothing is kept in storage beyond what the page already
   keeps per window (sessionStorage). */
(function (root) {
  'use strict';
  const CHANNEL = 'aib-remote-windows',
    CAP = 8,
    BEAT_MS = 3000,
    STALE_MS = 90000, // a hidden window's timers may run once a minute; one that says nothing for this long is gone
    ASK_MS = 1500, // a routed open waits this long for the window's answer
    OWN_KEY = 'aib-remote-own-w';
  const W_RE = /^t-[a-z0-9]{4,12}$/;
  const KINDS = ['main', 'project', 'chat', 'doc'];
  const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n || 400) : '');
  const newId = () => 't-' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  const nonce = Math.random().toString(36).slice(2, 12);

  let q;
  try {
    q = new URLSearchParams(root.location.search || '');
  } catch (e) {
    q = new URLSearchParams('');
  }
  const isDoc = /\/doc\.html$/.test(root.location.pathname || '');
  const session = () => {
    try {
      return root.sessionStorage || null;
    } catch (e) {
      return null;
    }
  };

  /* A window opened with window.open gets a COPY of its opener's sessionStorage (Chromium, WebKit): the opener's moved chats and
     docs, its selected chat and its tab id must not count as this window's. A window named by its query that has not seen this
     query before starts clean. */
  (function ownStorage() {
    const w = q.get('w') || '';
    const ss = session();
    if (!ss || !W_RE.test(w)) return;
    try {
      if (ss.getItem(OWN_KEY) === w) return;
      for (const k of ['aib-chat-popouts', 'aib-doc-popouts', 'studio-selected', 'aib-window-tab', 'aib-window-ctx']) ss.removeItem(k);
      ss.setItem(OWN_KEY, w);
    } catch (e) {
      /* private window */
    }
  })();

  // ---- this window ----
  function selfInfo() {
    const W = root.AibWindow;
    const c = W && W.context ? W.context() : null;
    const out = { w: W && W.id ? W.id() : q.get('w') || '', kind: 'main', project: '', chat: '', doc: null };
    if (isDoc) {
      out.w = q.get('w') || out.w || docId();
      out.kind = 'doc';
      out.project = clip(q.get('project') || '');
      out.doc = { project: out.project, name: clip(q.get('name') || '', 200) };
      return out;
    }
    if (c) {
      out.kind = KINDS.indexOf(c.kind) >= 0 ? c.kind : 'main';
      out.project = c.project || '';
      out.chat = c.kind === 'chat' ? c.chat || '' : '';
    }
    return out;
  }
  let docW = '';
  const docId = () => docW || (docW = newId());
  const me = () => selfInfo().w;

  // ---- the roster: the other windows of this browser ----
  const roster = new Map(); // w -> {w, kind, project, chat, doc, open, focusedAt, at, nonce}
  let myOpen = [],
    myFocusedAt = 0;
  try {
    if (root.document && root.document.hasFocus && root.document.hasFocus()) myFocusedAt = Date.now();
  } catch (e) {
    /* no focus info */
  }
  const changeFns = [];
  function changed() {
    for (const fn of changeFns.slice())
      try {
        fn();
      } catch (e) {
        /* one listener never stops the others */
      }
  }
  let channel = null;
  try {
    channel = typeof root.BroadcastChannel === 'function' ? new root.BroadcastChannel(CHANNEL) : null;
  } catch (e) {
    channel = null;
  }
  function send(m) {
    if (!channel) return;
    try {
      channel.postMessage(Object.assign({ from: me(), nonce }, m));
    } catch (e) {
      /* closed */
    }
  }
  let leaving = false; // after pagehide this window says nothing more (a focus or presence event while it closes would revive it)
  function here(extra) {
    if (leaving) return;
    const s = selfInfo();
    send(Object.assign({ t: 'here', kind: s.kind, project: s.project, chat: s.chat, doc: s.doc, open: myOpen.slice(0, 50), focusedAt: myFocusedAt }, extra || {}));
  }
  function prune() {
    const now = Date.now();
    let gone = false;
    for (const [w, e] of roster) {
      const h = handles.get(w);
      if ((h && h.closed) || now - e.at > STALE_MS) {
        roster.delete(w);
        handles.delete(w);
        gone = true;
      }
    }
    return gone;
  }
  function sameShape(a, b) {
    return (
      !!a &&
      a.kind === b.kind &&
      a.project === b.project &&
      a.chat === b.chat &&
      JSON.stringify(a.doc) === JSON.stringify(b.doc) &&
      a.open.join('\n') === b.open.join('\n') &&
      a.focusedAt === b.focusedAt
    );
  }
  const gone = new Set(); // nonces of windows that said bye: a late 'here' of theirs is not a window
  const waiting = new Map(); // request id -> resolve (a routed open's answer)
  const arrivals = new Map(); // w -> [resolve] (a new window's first 'here')
  function onMessage(e) {
    const m = e && e.data;
    if (!m || typeof m !== 'object' || m.nonce === nonce) return;
    // a window that is still starting asks before it has its id: every window answers (its 'here' goes to all)
    if (m.t === 'ask') return here();
    if (typeof m.from !== 'string' || !W_RE.test(m.from)) return;
    if (m.from === me()) {
      // two windows with one id (a duplicated tab copies its tab id): the one with the larger nonce takes a new id
      if (m.t === 'here' && m.nonce > nonce && !q.get('w')) renew();
      return;
    }
    if (m.t === 'here') {
      if (gone.has(m.nonce)) return;
      const entry = {
        w: m.from,
        kind: KINDS.indexOf(m.kind) >= 0 ? m.kind : 'main',
        project: clip(m.project),
        chat: clip(m.chat),
        doc: m.doc && typeof m.doc === 'object' ? { project: clip(m.doc.project), name: clip(m.doc.name, 200) } : null,
        open: Array.isArray(m.open) ? m.open.filter((k) => typeof k === 'string').slice(0, 50) : [],
        focusedAt: Number(m.focusedAt) || 0,
        at: Date.now(),
        nonce: String(m.nonce || ''),
      };
      const before = roster.get(m.from);
      roster.set(m.from, entry);
      const list = arrivals.get(m.from);
      if (list) {
        arrivals.delete(m.from);
        for (const fn of list) fn(true);
      }
      if (!sameShape(before, entry)) changed();
      return;
    }
    if (m.t === 'bye') {
      if (gone.size > 200) gone.clear();
      gone.add(m.nonce);
      const e = roster.get(m.from);
      if (e && (!e.nonce || e.nonce === m.nonce) && roster.delete(m.from)) changed();
      handles.delete(m.from);
      return;
    }
    if (m.to !== me()) return;
    if (m.t === 'focus') return focusSelf();
    if (m.t === 'open') {
      focusSelf();
      deliver(m.target).then((r) => send({ t: 'opened', to: m.from, id: m.id, result: r }));
      return;
    }
    if (m.t === 'opened') {
      const fn = waiting.get(m.id);
      if (fn) {
        waiting.delete(m.id);
        fn(m.result);
      }
    }
  }
  if (channel) channel.onmessage = onMessage;
  function renew() {
    const ss = session();
    try {
      if (ss) ss.removeItem('aib-window-tab');
    } catch (e) {
      /* private window */
    }
    if (root.AibWindow && root.AibWindow._reset) root.AibWindow._reset();
    here();
  }
  function focusSelf() {
    try {
      root.focus();
    } catch (e) {
      /* the browser decides */
    }
  }
  /* A routed open arrives here: the page opens it the way the desktop app's K6 delivery does (AgentNotifyUI.openFromDesktop:
     'mine', 'no', or false while the page still starts: try again for a few seconds). */
  async function deliver(target) {
    const t = target && typeof target === 'object' ? target : {};
    const what = t.chat
      ? { type: 'chat', key: String(t.chat) }
      : t.doc
        ? { type: 'doc', project: String(t.doc.project || t.project || ''), name: String(t.doc.name || '') }
        : { type: 'project', key: String(t.project || '') };
    for (let i = 0; i < 40; i++) {
      const N = root.AgentNotifyUI;
      const r = N && typeof N.openFromDesktop === 'function' ? N.openFromDesktop(what) : false;
      if (r !== false) return r === 'no' ? 'no' : 'mine';
      await new Promise((resolve) => root.setTimeout(resolve, 250));
    }
    return 'no';
  }

  // ---- what window-context.js reads instead of the PC's presence answer ----
  function others() {
    prune();
    return [...roster.values()].map((e) => ({
      w: e.w,
      kind: e.kind,
      project: e.project,
      chat: e.chat || undefined,
      doc: e.doc || undefined,
      visible: true,
    }));
  }
  /* {ok, at, soundOwner, openAll, windows, sent}: the shape window-context.js keeps from a presence answer. The sound owner is
     the window of this browser focused last (only it chimes). */
  function answer() {
    prune();
    const self = selfInfo();
    const list = [...roster.values()];
    let owner = self.w,
      best = myFocusedAt;
    for (const e of list)
      if (e.focusedAt > best) {
        best = e.focusedAt;
        owner = e.w;
      }
    const openAll = new Set(myOpen);
    for (const e of list) for (const k of e.open) openAll.add(k);
    return {
      ok: true,
      at: Date.now(),
      soundOwner: owner,
      openAll: [...openAll],
      windows: [{ w: self.w, kind: self.kind, project: self.project, chat: self.chat || undefined, doc: self.doc || undefined }].concat(
        others(),
      ),
      sent: myOpen.slice(),
    };
  }
  /* The page's presence report (POST /api/live/presence, remote-auth.js taps it): this window's open chats and focus, for the
     other windows of this browser. */
  function report(body) {
    if (!body || typeof body !== 'object') return;
    const open = Array.isArray(body.open) ? body.open.filter((k) => typeof k === 'string').slice(0, 50) : myOpen;
    const was = myOpen.join('\n');
    myOpen = open;
    if (body.focused === true && !myFocusedAt) myFocusedAt = Date.now();
    if (was !== open.join('\n')) here();
  }

  // ---- the windows route, answered here (the same request and answer shapes as windows_route.ts) ----
  const handles = new Map(); // w -> the window.open handle (windows this window opened)
  const reply = (status, body) => ({ status, body });
  const slug = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const features = (kind) => {
    if (kind === 'chat') return 'popup,width=720,height=860';
    if (kind === 'doc') return 'popup,width=760,height=900';
    // a project window: a browser tab in a browser, its own window when AIB is installed as an app
    let installed = false;
    try {
      installed = !!(root.matchMedia && root.matchMedia('(display-mode: standalone)').matches);
    } catch (e) {
      installed = false;
    }
    return installed ? 'popup,width=1280,height=860' : '';
  };
  function shows(e, req) {
    if (req.project && !req.chat && !req.doc) return e.kind === 'project' && e.project === req.project.key;
    if (req.chat) return e.kind === 'chat' && e.chat === req.chat.key;
    return e.kind === 'doc' && !!e.doc && e.doc.project === req.doc.project && e.doc.name === req.doc.name;
  }
  function focusWindow(w) {
    const h = handles.get(w);
    if (h && !h.closed) {
      try {
        h.focus();
        return true;
      } catch (e) {
        /* gone */
      }
    }
    if (!roster.has(w)) return false;
    send({ t: 'focus', to: w });
    return true;
  }
  /* Open a window of this browser. Runs while the click that asked is still being handled (the page's fetch reaches here without
     waiting), so the browser lets the window open. */
  function openWindow(kind, params, name) {
    const w = newId();
    const qs = new URLSearchParams(Object.assign({ w }, kind === 'main' ? {} : { kind }, params));
    const path = (kind === 'doc' ? '/doc.html?' : '/pc.html?') + qs.toString();
    let win = null;
    try {
      win = root.open(path, name, features(kind));
    } catch (e) {
      win = null;
    }
    if (!win) return null;
    handles.set(w, win);
    roster.set(w, { w, kind, project: params.project || '', chat: params.chat || '', doc: kind === 'doc' ? { project: params.project, name: params.name } : null, open: [], focusedAt: Date.now(), at: Date.now(), nonce: '' });
    changed();
    return w;
  }
  const blocked = () => reply(409, { error: 'The browser blocked the new window. Allow pop-ups for this address and try again.', code: 'popup_blocked' });
  function openOrPop(body) {
    const req = body.op === 'open' ? { project: body.project } : body.chat ? { chat: body.chat } : body.doc ? { doc: body.doc } : null;
    if (!req) return reply(400, { error: 'Invalid window request' });
    const key = req.project ? req.project.key : req.chat ? req.chat.key : req.doc.project;
    if (typeof key !== 'string' || !key || key.length > 400) return reply(400, { error: 'Invalid window request' });
    prune();
    for (const e of roster.values()) {
      if (shows(e, req)) {
        focusWindow(e.w);
        return reply(200, { w: e.w, existed: true });
      }
    }
    if (roster.size + 1 >= CAP) return reply(409, { error: 'At most 8 AIB windows can be open', cap: CAP });
    let w = null;
    if (req.project) w = openWindow('project', { project: key }, 'aib-project-' + slug(key));
    else if (req.chat)
      w = openWindow('chat', { mode: 'chat', chat: req.chat.key, project: String(req.chat.project || '') }, 'aib-chat-' + slug(req.chat.key));
    else w = openWindow('doc', { project: key, name: String(req.doc.name || '') }, 'aib-doc-' + slug(key + '\n' + req.doc.name));
    return w ? reply(200, { w, existed: false }) : blocked();
  }
  function route(body) {
    const t = body.target && typeof body.target === 'object' ? body.target : {};
    const from = typeof body.from === 'string' ? body.from : me();
    prune();
    const list = [...roster.values()];
    const self = selfInfo();
    const all = [Object.assign({}, self)].concat(list);
    const pick =
      (t.chat && all.find((e) => e.kind === 'chat' && e.chat === t.chat)) ||
      (t.doc && all.find((e) => e.kind === 'doc' && e.doc && e.doc.project === t.doc.project && e.doc.name === t.doc.name)) ||
      (t.project && all.find((e) => e.kind === 'project' && e.project === t.project)) ||
      all.find((e) => e.kind === 'main');
    if (pick && pick.w === from) return Promise.resolve(reply(200, { to: 'self' }));
    if (!pick) {
      // no main window open: a new one opens it (its address names the chat; a project or doc is sent once it is there)
      const w = openWindow('main', {}, 'aib-main');
      if (!w) return Promise.resolve(blocked());
      waitFor(w).then((ok) => ok && ask(w, t));
      return Promise.resolve(reply(200, { to: w }));
    }
    focusWindow(pick.w);
    return ask(pick.w, t).then((r) =>
      r === 'gone' ? (roster.delete(pick.w), changed(), reply(200, { to: 'self' })) : reply(200, { to: pick.w }),
    );
  }
  function waitFor(w) {
    return new Promise((resolve) => {
      const list = arrivals.get(w) || [];
      list.push(resolve);
      arrivals.set(w, list);
      root.setTimeout(() => {
        const l = arrivals.get(w);
        if (l && l.indexOf(resolve) >= 0) {
          l.splice(l.indexOf(resolve), 1);
          resolve(false);
        }
      }, 20000);
    });
  }
  let seq = 0;
  function ask(w, target) {
    const id = nonce + '-' + ++seq;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      send({ t: 'open', to: w, id, target });
      // no answer at all: that window is gone (closed without saying so); a slow page still answers within the time
      root.setTimeout(() => {
        if (!waiting.has(id)) return;
        waiting.delete(id);
        resolve(roster.has(w) && Date.now() - roster.get(w).at < ASK_MS ? 'mine' : 'gone');
      }, ASK_MS);
    });
  }
  /* body: the parsed request. Resolves {status, body}; a promise only for route (the others answer at once, while the click that
     asked is still being handled). */
  function handle(body) {
    const b = body && typeof body === 'object' ? body : {};
    if (b.op === 'open' || b.op === 'popout') return openOrPop(b);
    if (b.op === 'route') return route(b);
    if (b.op === 'focus') return focusWindow(String(b.w || '')) ? reply(200, { ok: true }) : reply(404, { error: 'No such window' });
    if (b.op === 'close') {
      if (b.from !== b.w || b.w !== me()) return reply(403, { error: 'A window can close only itself' });
      send({ t: 'bye' });
      leaving = true;
      root.setTimeout(() => {
        try {
          root.close();
        } catch (e) {
          /* not a window the page opened */
        }
      }, 0);
      return reply(200, { ok: true });
    }
    return reply(400, { error: 'Invalid window request' });
  }

  // ---- this window's life ----
  function beat() {
    if (prune()) changed();
    here();
  }
  root.addEventListener('focus', () => {
    myFocusedAt = Date.now();
    here();
    changed();
  });
  root.addEventListener('pagehide', () => {
    send({ t: 'bye' });
    leaving = true;
  });
  root.addEventListener('pageshow', (e) => {
    if (e && e.persisted) {
      leaving = false;
      here();
      send({ t: 'ask' });
    }
  });
  root.setInterval(beat, BEAT_MS);
  // watch the windows this one opened: a closed one leaves the roster at once (its 'bye' may not come)
  root.setInterval(() => {
    let gone = false;
    for (const [w, h] of handles)
      if (h.closed) {
        handles.delete(w);
        if (roster.delete(w)) gone = true;
      }
    if (gone) changed();
  }, 1000);
  here();
  send({ t: 'ask' });

  root.AIBRemoteWindows = {
    handle,
    answer,
    others,
    report,
    me,
    onChange(fn) {
      if (typeof fn === 'function') changeFns.push(fn);
    },
    _roster: () => [...roster.values()].map((e) => Object.assign({}, e)),
  };
})(window);
