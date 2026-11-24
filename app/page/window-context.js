(function (root) {
  'use strict';
  /* This page's AIB window (multi-window Phase 1C; design section 4 K0, K2, K5, section 9 routeOpen).
       * Who am I: ?w=&kind=&mode=&project=&chat= read once at start and kept in sessionStorage (per window), the same key and rules
         as store-merge.js readContext. The desktop app's first window can come up without its query (spike S6): with no query and
         nothing saved it counts as the main window 'm' until the app sends its URL again (a new load reads it). A browser tab in
         serve mode (no desktop app) reports presence as 't-xxxx' (kept per tab), so two tabs never overwrite each other's slot.
       * What the other windows show: the last presence answer (POST /api/live/presence: soundOwner, openAll, windows), at most
         10 s old; older or none, this window acts as if it were the only one (today's behaviour).
       * Refresh hints on the BroadcastChannel 'aib-windows' (K5; hints only, never authority): {t:'focus'} (I got focus: I am the
         sound owner now), {t:'open'} (my open chats changed), {t:'bye'} (pagehide). Another window's hint asks this one to report
         again at once, so its answer (the open chats, the sound owner) is fresh.
       * Where a chat or project may open: mayShowHere(target) and route(target) (K3 op 'route'), used by routeOpen in
         workspace-ui.js. */
  const KEY = 'aib-window-ctx',
    TAB_KEY = 'aib-window-tab',
    CHANNEL = 'aib-windows',
    ANSWER_MS = 10000;
  const W_RE = /^(m|w[2-8]|t-[a-z0-9]{4,12})$/,
    APP_W = /^(m|w[2-8])$/;
  const KINDS = ['main', 'project', 'chat', 'doc'];
  const clip = (v) => (typeof v === 'string' ? v.slice(0, 400) : '');

  function session() {
    try {
      return root.sessionStorage || null;
    } catch (e) {
      return null;
    }
  }
  // The same parse as store-merge.js readContext (query first, then this window's saved copy, else the main window).
  function readContext() {
    const M = root.AibStoreMerge;
    if (M && typeof M.readContext === 'function') return M.readContext(root);
    const ctx = { w: 'm', kind: 'main', mode: '', project: '', chat: '' };
    let q = null;
    try {
      q = new URLSearchParams((root.location && root.location.search) || '');
    } catch (e) {
      q = null;
    }
    const ss = session();
    let saved = null;
    try {
      saved = ss && JSON.parse(ss.getItem(KEY) || 'null');
    } catch (e) {
      saved = null;
    }
    const fromQ = !!q && W_RE.test(q.get('w') || '');
    const src = fromQ
      ? { w: q.get('w'), kind: q.get('kind'), mode: q.get('mode'), project: q.get('project'), chat: q.get('chat') }
      : saved && typeof saved === 'object' && W_RE.test(saved.w || '')
        ? saved
        : null;
    if (src) {
      ctx.w = src.w;
      ctx.kind = KINDS.indexOf(src.kind) >= 0 ? src.kind : src.w === 'm' ? 'main' : 'project';
      ctx.mode = src.mode === 'chat' ? 'chat' : '';
      ctx.project = clip(src.project);
      ctx.chat = clip(src.chat);
      if (fromQ && ss) {
        try {
          ss.setItem(KEY, JSON.stringify(ctx));
        } catch (e) {
          /* private window */
        }
      }
    }
    return ctx;
  }

  let ctx = null;
  const C = () => ctx || (ctx = readContext());
  const desktop = () => !!(root.AibDesktop && root.AibDesktop.available && root.AibDesktop.available());
  /* The computer page (remote control from other PCs, phase 4): remote-windows.js opens, routes and focuses this browser's own
     windows, and its roster of them stands in for the PC's presence answer (the PC's windows are not this computer's). */
  const remote = () => root.AIBRemoteWindows || null;
  const app = () => desktop() || !!remote();
  // The query (or this window's saved context) names it; else, outside the desktop app, a per-tab id.
  function hasOwnId() {
    try {
      const q = new URLSearchParams((root.location && root.location.search) || '');
      if (W_RE.test(q.get('w') || '')) return true;
      const ss = session();
      const saved = ss && JSON.parse(ss.getItem(KEY) || 'null');
      return !!(saved && W_RE.test(saved.w || ''));
    } catch (e) {
      return false;
    }
  }
  // this page load's own id (presence `page`, see leave below)
  const newPage = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  let PAGE = newPage();
  let tabId = '';
  function me() {
    if (hasOwnId() || desktop()) return C().w;
    if (tabId) return tabId;
    const ss = session();
    try {
      tabId = (ss && ss.getItem(TAB_KEY)) || '';
    } catch (e) {
      tabId = '';
    }
    if (!/^t-[a-z0-9]{4,12}$/.test(tabId)) {
      tabId = 't-' + Math.random().toString(36).slice(2, 10).padEnd(8, '0');
      try {
        if (ss) ss.setItem(TAB_KEY, tabId);
      } catch (e) {
        /* private window */
      }
    }
    return tabId;
  }
  const kind = () => C().kind;
  // The project a project window is pinned to (A1), or the project of a popped-out chat; '' in the main window.
  const pinnedProject = () => (C().kind === 'project' || C().kind === 'chat' ? C().project : '');
  const pinned = () => C().kind === 'project' && !!C().project;

  // ---- the last presence answer (K2) ----
  let last = null; // {at, soundOwner, openAll, windows, sent}
  /* Remote control from other PCs, phase 2: the answer says `quiet` while you are at another device (the PC while you work on a
     laptop, the laptop while you work at the PC): this window does not chime or show a notification of its own until a later
     answer says otherwise. Kept for QUIET_MS (a page reports at least every 20 s, focused or not), so a page that stopped hearing
     back goes back to today's behaviour. */
  const QUIET_MS = 45000;
  let quietAt = 0;
  function noteAnswer(ans, sentOpen) {
    if (!ans || typeof ans !== 'object' || ans.ok !== true) return false;
    quietAt = ans.quiet === true ? Date.now() : 0;
    if (remote()) return true; // the computer page: this browser's windows come from remote-windows.js, never the PC's answer
    const before = othersOpen().join('\n') + '|' + others().map((w) => w.w + ':' + w.kind + ':' + w.project + ':' + w.chat).join(',');
    last = {
      at: Date.now(),
      soundOwner: typeof ans.soundOwner === 'string' ? ans.soundOwner : null,
      openAll: Array.isArray(ans.openAll) ? ans.openAll.filter((k) => typeof k === 'string') : [],
      windows: Array.isArray(ans.windows) ? ans.windows.filter((w) => w && typeof w.w === 'string') : [],
      sent: Array.isArray(sentOpen) ? sentOpen.slice() : [],
    };
    const after = othersOpen().join('\n') + '|' + others().map((w) => w.w + ':' + w.kind + ':' + w.project + ':' + w.chat).join(',');
    if (before !== after) changed();
    return true;
  }
  const answer = () => (remote() ? remote().answer() : last && Date.now() - last.at < ANSWER_MS ? last : null);
  // The other windows as the last fresh answer lists them (visible or not).
  function others() {
    const a = answer();
    if (!a) return [];
    const self = me();
    return a.windows.filter((w) => w.w !== self);
  }
  // Chats open in another window: the answer's union minus what this window reported itself. With one project per window and a
  // chat popped out moved (owner decision 4), one chat is never open in two windows, so this is exact.
  function othersOpen() {
    const a = answer();
    if (!a || !others().length) return [];
    return a.openAll.filter((k) => a.sent.indexOf(k) < 0);
  }
  /* D1: may this window chime (and, in a browser, show the desktop notification)? Unknown (no fresh answer) or alone: yes. Else
     only the sound owner; with none named (no window was ever focused), the main window, else the first one listed. */
  const quiet = () => !!quietAt && Date.now() - quietAt < QUIET_MS;
  function soundMine() {
    if (quiet()) return false; // you are at another device now (phase 2)
    const a = answer();
    if (!a || !others().length) return true;
    const self = me();
    if (a.soundOwner) return a.soundOwner === self;
    const main = a.windows.find((w) => w.kind === 'main');
    return (main ? main.w : (a.windows[0] || {}).w) === self || !a.windows.some((w) => w.w === self);
  }
  // The window (not this one) that shows the target: the pop-out with that chat, else the window pinned to its project.
  function ownerOf(target) {
    const t = target || {};
    const list = others();
    const pop = t.chat ? list.find((w) => w.kind === 'chat' && w.chat === t.chat) : null;
    if (pop) return pop.w;
    const pin = t.project ? list.find((w) => w.kind === 'project' && w.project === t.project) : null;
    return pin ? pin.w : null;
  }
  // A project another window is pinned to (store-merge.js: this window does not write it).
  const ownedElsewhere = (pk) => !!pk && others().some((w) => w.kind === 'project' && w.project === pk);
  /* routeOpen's local check (design section 9): the main window shows any project no other window owns and any chat not popped
     out; a project window only its own project; a pop-out only its own chat. */
  function mayShowHere(target) {
    const t = target || {},
      c = C();
    if (c.kind === 'chat' && c.chat) return !!t.chat && t.chat === c.chat;
    if (pinned()) return !!t.project && t.project === c.project && !(t.chat && ownerOf({ chat: t.chat }));
    return !ownerOf(t);
  }
  /* Phase 3 (design E6): a window in the background polls less often. In the background: this page has no focus while another
     AIB window is open (the last fresh answer lists one). Alone, or focused, a window keeps today's rates, so one AIB window on a
     second screen still updates as fast as before. pollMs(fast, slow): the period to use now. */
  function background() {
    let focused = true;
    try {
      const d = root.document;
      focused = !d || typeof d.hasFocus !== 'function' || !!d.hasFocus();
    } catch (e) {
      focused = true;
    }
    return !focused && others().length > 0;
  }
  const pollMs = (fast, slow) => (background() ? slow : fast);
  // Routing needs the desktop app and an app window id, or the computer page (remote-windows.js); in serve mode (or an old app)
  // every open stays in this page.
  const canRoute = () => (desktop() && APP_W.test(me())) || !!remote();
  const known = () => !!answer();
  // K3 op 'route': resolves {to:'self'} or {to:w}. post(path, body) is the page's token POST (chat.js post).
  function route(target, post) {
    const t = { project: String((target && target.project) || '') };
    if (target && target.chat) t.chat = String(target.chat);
    if (target && target.doc) t.doc = { project: String(target.doc.project || ''), name: String(target.doc.name || '') };
    return Promise.resolve(post('desktop/windows', { op: 'route', from: me(), target: t })).then((r) => {
      if (r && typeof r.to === 'string') return { to: r.to };
      throw new Error('The window route did not answer');
    });
  }

  // ---- the fields every presence report carries (K2) ----
  function presenceFields(project) {
    const c = C(),
      out = { w: me(), page: PAGE, kind: c.kind, project: null };
    const p = project && typeof project === 'object' && project.key ? project : null;
    if (p) out.project = { key: String(p.key).slice(0, 400), name: String(p.name || '').slice(0, 80) };
    else if (c.project) out.project = { key: c.project, name: '' };
    if (c.kind === 'chat' && c.chat) out.chat = c.chat;
    return out;
  }

  // ---- hints (K5) ----
  let channel = null;
  const listeners = [];
  const changeFns = [];
  function changed() {
    for (const fn of changeFns.slice())
      try {
        fn();
      } catch (e) {
        /* one listener never stops the others */
      }
  }
  function ensureChannel() {
    if (channel || typeof root.BroadcastChannel !== 'function') return channel;
    try {
      channel = new root.BroadcastChannel(CHANNEL);
      channel.onmessage = (e) => {
        const m = e && e.data;
        if (!m || typeof m !== 'object' || m.from === me()) return;
        if (m.t !== 'focus' && m.t !== 'open' && m.t !== 'bye') return; // 'store' is store-merge.js's
        if (m.t === 'focus' && last) last.soundOwner = String(m.from || '') || last.soundOwner;
        if (m.t === 'bye' && last) {
          last.windows = last.windows.filter((w) => w.w !== m.from);
          changed();
        }
        for (const fn of listeners.slice())
          try {
            fn(m);
          } catch (err) {
            /* ignore */
          }
      };
    } catch (e) {
      channel = null;
    }
    return channel;
  }
  function hint(t) {
    const ch = ensureChannel();
    if (t === 'focus' && last) last.soundOwner = me();
    if (!ch) return;
    try {
      ch.postMessage({ t, from: me(), at: Date.now() });
    } catch (e) {
      /* closed */
    }
  }
  function onHint(fn) {
    ensureChannel();
    if (typeof fn === 'function') listeners.push(fn);
  }
  function onChange(fn) {
    if (typeof fn === 'function') changeFns.push(fn);
  }

  // pagehide: the slot goes at once (K2 left:true, fetch keepalive), and the other windows are told. `page` names this page load:
  // a report it sent just before (a blur or hidden report on another connection) can reach the server after the left one, and the
  // server drops it instead of bringing the slot back (attention/presence.ts). A reload, or a return from the page cache, is a new one.
  let leftSent = false;
  function leave() {
    if (leftSent) return;
    leftSent = true;
    hint('bye');
    const D = root.AibDesktop;
    const token = D && typeof D.cachedToken === 'function' ? D.cachedToken() : '';
    if (!token || typeof root.fetch !== 'function') return;
    try {
      root.fetch('/api/live/presence', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
        body: JSON.stringify({ w: me(), left: true, page: PAGE }),
      });
    } catch (e) {
      /* the page is going */
    }
  }
  if (typeof root.addEventListener === 'function') {
    root.addEventListener('pagehide', leave);
    root.addEventListener('pageshow', (e) => {
      if (e && e.persisted) {
        leftSent = false; // back from the page cache: report again, as a new page load
        PAGE = newPage();
      }
    });
  }

  const api = {
    context: () => Object.assign({}, C()),
    id: me,
    page: () => PAGE,
    kind,
    pinned,
    pinnedProject,
    app,
    canRoute,
    known,
    noteAnswer,
    answer,
    others,
    othersOpen,
    soundMine,
    quiet,
    background,
    pollMs,
    ownerOf,
    ownedElsewhere,
    mayShowHere,
    route,
    presenceFields,
    hint,
    onHint,
    onChange,
    leave,
    _reset() {
      ctx = null;
      last = null;
      quietAt = 0;
      tabId = '';
      leftSent = false;
    },
  };
  root.AibWindow = api;
  if (remote() && typeof remote().onChange === 'function') remote().onChange(changed);
  // store-merge.js (Phase 1B): a project another window owns is not written from here.
  if (root.AibStore && typeof root.AibStore.setOwnedElsewhere === 'function') root.AibStore.setOwnedElsewhere(ownedElsewhere);
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
