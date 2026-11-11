'use strict';
/* global CSS */
/* The doc page (doc.html): one local doc in a tab or beside a chat.
   /doc.html?chat=<chat id>&name=<doc name or title>[&page=<id>][&block=<id>][&thread=<id>][&new=1][&preview=1][&where=beside|tab]
   (the doc-tab contract). It opens the doc (POST /api/live/docs/open), binds the vendored editor (vendor/docs/editor.js) to the
   server's live Y.Doc over the doc socket, and draws the header (crumbs, Saved, Comments, History, ⋯), the page list, live agent
   presence, claimed sections, page delete requests and refused-edit notes. doc-toolbar.js adds the toolbar, menus and block
   handles; doc-panels.js the comments rail, History and the ⋯ menu.

   Agent text looks exactly like the user's: nothing here draws who wrote what. Agents show only while they work: a cursor with
   a name flag, a soft outline on the block being edited, a chip in the toolbar and a pulsing dot on their page. When AIB reloads
   the doc under the page (a restart), the socket says so: the page drops its copy, opens the doc again, and names in one quiet
   line any of its last keystrokes that never reached AIB.

   This file is the core the other two build on: window.AIBDoc (state, events, server calls, menus, toasts). */
(function () {
  const params = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const NAMES = { claude: 'Claude Code', codex: 'Codex', omp: 'OMP' };

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function btn(cls, text, onClick, title) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }
  const icon = (name, cls) => window.AIBDocIcons.icon(name, cls);

  /** The name the page shows for an author or a chat ("claude:<session>" -> "Claude Code"). */
  function agentName(who) {
    if (!who) return 'The agent';
    if (who === 'user') return 'You';
    if (who === 'file') return 'File edit';
    if (who === 'system') return 'AIB';
    const provider = String(who).includes(':') ? String(who).slice(0, String(who).indexOf(':')) : String(who);
    return NAMES[provider] || provider;
  }

  const handlers = new Map();
  const D = (window.AIBDoc = {
    params,
    $,
    el,
    btn,
    icon,
    agentName,
    token: '',
    docId: '',
    info: null,
    session: null,
    editor: null,
    page: '',
    pages: [],
    threads: [],
    claims: [],
    requests: [],
    notes: [],
    noteOpen: new Set(),
    activeThread: null,
    changeCount: 0,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
    },
    emit(event, data) {
      for (const fn of handlers.get(event) || []) {
        try {
          fn(data);
        } catch (error) {
          console.error(error);
        }
      }
    },
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  // Server calls

  async function api(method, path, body) {
    const headers = { 'X-Studio-Token': D.token };
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let data = {};
    try {
      data = await r.json();
    } catch {
      /* no body */
    }
    if (!r.ok) {
      const e = new Error((data && data.error) || `AIB answered ${r.status}`);
      e.code = data && data.code;
      e.status = r.status;
      e.data = data;
      throw e;
    }
    return data;
  }
  D.post = (path, body) => api('POST', path, { doc: D.docId, ...(body || {}) });
  D.get = (path, query) => api('GET', path + '?' + new URLSearchParams({ doc: D.docId, ...(query || {}) }).toString());

  // ---------------------------------------------------------------------------------------------------------------------------
  // Talking to chat.html (the doc tab is a same-origin frame)

  D.tell = (msg) => {
    if (window.parent && window.parent !== window) window.parent.postMessage(msg, location.origin);
  };
  const picks = new Map();
  D.pickChat = (purpose) =>
    new Promise((resolve) => {
      if (!window.parent || window.parent === window) return resolve(null);
      const requestId = 'p' + Math.random().toString(36).slice(2);
      picks.set(requestId, resolve);
      D.tell({ type: 'aib-doc:pick-chat', requestId, purpose });
    });
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.parent || !e.data || typeof e.data !== 'object') return;
    const m = e.data;
    if (m.type === 'aib-doc:goto') goTo(m);
    else if (m.type === 'aib-doc:picked' && picks.has(m.requestId)) {
      picks.get(m.requestId)(m.chat || null);
      picks.delete(m.requestId);
    }
  });
  let pinned = params.get('preview') !== '1';
  function pin() {
    if (pinned) return;
    pinned = true;
    D.tell({ type: 'aib-doc:pin' });
  }
  D.pin = pin;

  // ---------------------------------------------------------------------------------------------------------------------------
  // Floating UI: menus, popovers, toasts (positioned through the CSSOM: the page's CSP allows no style attribute)

  const layer = () => $('docLayer');
  let openMenu = null;
  function closeMenu() {
    if (!openMenu) return;
    const m = openMenu;
    openMenu = null;
    m.node.remove();
    m.onClose && m.onClose();
  }
  D.closeMenu = closeMenu;
  /** Place a fixed box near an anchor rect, kept on screen. */
  function place(node, rect, side) {
    const vw = document.documentElement.clientWidth,
      vh = document.documentElement.clientHeight;
    const r = node.getBoundingClientRect();
    let x = side === 'right' ? rect.right + 4 : side === 'left' ? rect.left - r.width - 4 : rect.left;
    let y =
      side === 'right' || side === 'left' ? rect.top : side === 'above' ? rect.top - r.height - 6 : rect.bottom + 4;
    if (y + r.height > vh - 6 && side !== 'above') y = Math.max(6, rect.top - r.height - 4);
    if (y < 6) y = Math.min(vh - r.height - 6, rect.bottom + 4);
    x = Math.max(6, Math.min(x, vw - r.width - 6));
    node.style.left = Math.round(x) + 'px';
    node.style.top = Math.round(Math.max(6, y)) + 'px';
  }
  D.place = place;
  /**
   * A menu at `anchor` (an element or a rect). items: {label, hint, small, icon, iconCls, danger, disabled, on, run, keep} |
   * {sep: true} | {head}. opts: {filter: placeholder, side, onClose, cls, items(filterText)}.
   */
  function menu(anchor, items, opts) {
    const o = opts || {};
    closeMenu();
    const node = el('div', 'menu' + (o.cls ? ' ' + o.cls : ''));
    node.setAttribute('role', 'menu');
    let filter = null;
    const list = el('div', 'menu-list');
    const fill = (text) => {
      list.replaceChildren();
      const all = o.items ? o.items(text || '') : items;
      let any = false;
      for (const it of all) {
        if (it.sep) {
          list.append(el('div', 'sep'));
          continue;
        }
        if (it.head) {
          list.append(el('div', 'mh', it.head));
          continue;
        }
        any = true;
        const b = el(
          'button',
          'mi' +
            (it.compact !== false && !it.small ? ' compact' : '') +
            (it.danger ? ' dng' : '') +
            (it.on ? ' on' : ''),
        );
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        if (it.disabled) b.disabled = true;
        if (it.icon) {
          const i = el('span', 'ico' + (it.iconCls ? ' ' + it.iconCls : ''));
          if (typeof it.icon === 'string' && window.AIBDocIcons.names.includes(it.icon)) i.append(icon(it.icon));
          else i.textContent = it.icon;
          b.append(i);
        }
        const lbl = el('span', 'lbl', it.label);
        if (it.small) lbl.append(el('small', '', it.small));
        b.append(lbl);
        if (it.hint) b.append(el('span', it.kbd ? 'k2' : 'r', it.hint));
        if (it.data) for (const k of Object.keys(it.data)) b.dataset[k] = it.data[k];
        b.addEventListener('mousedown', (e) => e.preventDefault());
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (!it.keep) closeMenu();
          it.run && it.run(b);
        });
        list.append(b);
      }
      if (!any) list.append(el('div', 'empty', o.empty || 'Nothing matches'));
      const first = list.querySelector('.mi:not(:disabled)');
      if (first && o.filter !== undefined) first.classList.add('on');
    };
    if (o.filter !== undefined) {
      filter = el('input', 'filter');
      filter.placeholder = o.filter;
      filter.addEventListener('input', () => fill(filter.value));
      node.append(filter);
    }
    node.append(list);
    fill(o.text || '');
    layer().append(node);
    const rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    place(node, rect, o.side);
    openMenu = { node, onClose: o.onClose, fill, list, filter };
    if (filter) filter.focus();
    else if (o.focus !== false) {
      const first = node.querySelector('.mi:not(:disabled)');
      if (first) first.focus();
    }
    return openMenu;
  }
  D.menu = menu;
  /** Move the highlighted item of the open menu (the slash menu drives it from the editor's keys). */
  D.menuKey = (key) => {
    if (!openMenu) return false;
    const items = [...openMenu.list.querySelectorAll('.mi:not(:disabled)')];
    if (!items.length) return key === 'Escape' ? (closeMenu(), true) : false;
    let at = items.findIndex((b) => b.classList.contains('on'));
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (at >= 0) items[at].classList.remove('on');
      at = key === 'ArrowDown' ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
      items[at].classList.add('on');
      items[at].scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (key === 'Enter') {
      (items[at] || items[0]).click();
      return true;
    }
    if (key === 'Escape') {
      closeMenu();
      return true;
    }
    return false;
  };
  D.menuOpen = () => openMenu;
  document.addEventListener('mousedown', (e) => {
    if (openMenu && !openMenu.node.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (!openMenu) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMenu();
    } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && openMenu.node.contains(document.activeElement)) {
      e.preventDefault();
      const items = [...openMenu.list.querySelectorAll('.mi:not(:disabled)')];
      const at = items.indexOf(document.activeElement);
      const next = items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) next.focus();
    } else if (e.key === 'Enter' && openMenu.filter && document.activeElement === openMenu.filter) {
      e.preventDefault();
      const on = openMenu.list.querySelector('.mi.on') || openMenu.list.querySelector('.mi:not(:disabled)');
      if (on) on.click();
    }
  });

  let toastTimer = null;
  /** One small note at the bottom: text, then buttons ({label, run}). */
  D.toast = (text, actions, opts) => {
    const o = opts || {};
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    clearTimeout(toastTimer);
    const t = el('div', 'toast' + (o.bad ? ' bad' : ''));
    t.setAttribute('role', o.bad ? 'alert' : 'status');
    t.append(el('span', '', text));
    for (const a of actions || []) t.append(btn('linkish', a.label, () => (a.run(), a.keep || t.remove())));
    t.append(btn('linkish', '✕', () => t.remove(), 'Dismiss'));
    layer().append(t);
    if (o.ms !== 0) toastTimer = setTimeout(() => t.remove(), o.ms || 6000);
    return t;
  };
  D.fail = (error) => D.toast(String((error && error.message) || error), [], { bad: true, ms: 8000 });

  /** A small confirm popover next to an anchor. */
  D.confirm = (anchor, html, buttons) => {
    closeMenu();
    const p = el('div', 'pop menu');
    const text = el('p');
    for (const part of html) text.append(typeof part === 'string' ? document.createTextNode(part) : part);
    const row = el('div', 'row');
    for (const b of buttons) row.append(btn('btn sm ' + (b.cls || ''), b.label, () => (closeMenu(), b.run && b.run())));
    p.append(text, row);
    layer().append(p);
    let rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    if (!rect || (!rect.width && !rect.height)) rect = $('docHead').getBoundingClientRect(); // the anchor was re-drawn meanwhile
    place(p, rect, 'below');
    openMenu = { node: p, list: p, onClose: null };
    const first = row.querySelector('button');
    if (first) first.focus();
  };

  // ---------------------------------------------------------------------------------------------------------------------------
  // Opening the doc, the session, reopening after a restart

  const fail = (text) => {
    $('docError').textContent = text;
    $('docError').hidden = false;
    setStatus('bad', 'Not open');
    $('docApp').setAttribute('aria-busy', 'false');
  };

  async function openDoc(create) {
    const body = { id: params.get('chat') || '', name: params.get('name') || '' };
    if (create) body.create = '';
    const r = await fetch('/api/live/docs/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': D.token },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error(data.error || 'Could not open the doc');
      e.code = data.code;
      throw e;
    }
    return data;
  }

  const socketUrl = (doc, epoch) =>
    (location.protocol === 'https:' ? 'wss://' : 'ws://') +
    location.host +
    '/api/live/docs/socket?doc=' +
    encodeURIComponent(doc) +
    '&epoch=' +
    encodeURIComponent(epoch || '');

  let firstOpen = true;
  async function open(create) {
    const info = await openDoc(create);
    D.info = info;
    D.docId = info.doc;
    D.notes = Array.isArray(info.notes) ? info.notes.slice() : [];
    D.linked = info.chat || null;
    document.title = (info.title || info.name) + ' - AIB';
    $('docTitle').textContent = info.title || info.name;
    const session = window.AIBDocEditor.createSession({
      url: socketUrl(info.doc, info.epoch),
      protocols: ['aib-docs', 'aib-token.' + D.token],
      user: { name: 'You' },
      onStatus: socketStatus,
      onControl: control,
      onReopen: reopen,
      onAwareness: () => schedule('presence'),
      onLocalUpdate: (mine) => {
        D.changeCount++;
        if (mine) {
          localEdit();
          pin();
        }
      },
      onUndoElsewhere: (page) => showPage(page),
    });
    D.session = session;
    const ydoc = session.doc;
    ydoc.getMap('comments').observeDeep(() => schedule('threads'));
    ydoc.getMap('claims').observe(() => schedule('claims'));
    ydoc.getMap('pageRequests').observe(() => schedule('requests'));
    ydoc.getArray('pages').observeDeep(() => schedule('pages'));
    let drawn = 0;
    ydoc.getMap('drawings').observeDeep(() => {
      // AIB writes a drawing's picture when it saves (about a second later): then the previews load it again
      clearTimeout(drawn);
      drawn = setTimeout(() => {
        for (const k of [...fileUrls.keys()]) if (/\.excalidraw\.svg$/.test(k)) fileUrls.delete(k);
        document.dispatchEvent(new Event('aib-drawings'));
      }, 1500);
    });
    ydoc.on('update', () => D.changeCount++);
    await session.synced;
    if (D.session !== session) return;
    readPages();
    readThreads();
    readClaims();
    readRequests();
    const wanted = firstOpen ? params.get('page') : D.page;
    const remembered = firstOpen ? lastPage() : null;
    const page =
      [wanted, remembered].find((p) => p && D.pages.some((x) => x.id === p)) || (D.pages[0] && D.pages[0].id);
    showPage(page, firstOpen ? { block: params.get('block'), thread: params.get('thread') } : {});
    if (firstOpen && params.get('new') === '1')
      setTimeout(() => D.editor && D.editor.editor.commands.focus('start'), 0);
    firstOpen = false;
    $('docApp').setAttribute('aria-busy', 'false');
    D.emit('opened', info);
  }

  /** AIB reloaded the doc under the page (a restart): drop this copy, open again, name what never reached AIB. */
  async function reopen({ reason, texts }) {
    const old = D.session;
    D.session = null;
    if (D.editor) D.editor.destroy();
    D.editor = null;
    if (old) old.destroy();
    setStatus('off', 'Reopening…');
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await open(false);
        break;
      } catch (error) {
        if (error.code === 'no_doc' || error.code === 'bad_name')
          return fail(error.message + ' (it may have been moved or deleted)');
        await new Promise((r) => setTimeout(r, Math.min(500 * (attempt + 1), 4000)));
      }
    }
    if (!D.session) return fail('Could not open the doc again');
    const now = new Set(D.session.texts());
    const lost = (texts || []).filter((t) => !now.has(t));
    if (lost.length) unsyncedNote(lost, reason);
  }
  D.reopen = reopen;

  function unsyncedNote(lost, reason) {
    const box = $('docBanner');
    box.replaceChildren();
    box.className = 'doc-banner unsynced';
    box.hidden = false;
    const what = lost.join('\n\n');
    box.append(
      el(
        'span',
        'i-note',
        'Not saved: ' +
          (reason === 'epoch' ? 'AIB reloaded this doc' : 'AIB restarted') +
          ' before your last edits reached it, so they are not in the doc.',
      ),
      btn('linkish', 'Show them', (e) => {
        const pre = box.querySelector('.lost') || el('pre', 'lost', what);
        if (!pre.isConnected) box.append(pre);
        e.target.remove();
      }),
      btn('linkish', 'Copy', () => copyText(what)),
      el('span', 'sp'),
      btn('linkish', 'Dismiss', () => (box.hidden = true)),
    );
    D.unsynced = lost;
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(
        () => D.toast('Copied'),
        () => D.toast('Could not copy', [], { bad: true }),
      );
    }
    return Promise.resolve();
  }
  D.copyText = copyText;

  // ---------------------------------------------------------------------------------------------------------------------------
  // Saved state

  let statusKind = 'off',
    saving = null,
    offlineEdits = false;
  function setStatus(kind, text) {
    const s = $('docStatus');
    s.classList.toggle('off', kind === 'off');
    s.classList.toggle('bad', kind === 'bad');
    $('docStatusText').textContent = text;
  }
  let failures = 0,
    checking = false;
  function socketStatus(s) {
    statusKind = s;
    if (s === 'connected') {
      offlineEdits = false;
      failures = 0;
      setStatus('ok', 'Saved');
    } else if (s === 'connecting') setStatus('off', D.session && D.session.hello ? 'Reconnecting…' : 'Connecting…');
    else if (s === 'offline') {
      setStatus('off', offlineEdits ? 'Offline · not saved yet' : 'Offline · reconnecting');
      if (++failures >= 2) checkRestart();
    } else if (s === 'reopening') setStatus('off', 'Reopening…');
  }
  /** The socket keeps failing: if AIB restarted (a new page token), drop this copy and open the doc again. */
  async function checkRestart() {
    if (checking) return;
    checking = true;
    try {
      const b = await (await fetch('/api/live/bootstrap', { cache: 'no-store' })).json();
      if (b && b.token && b.token !== D.token && D.session) {
        D.token = b.token;
        failures = 0;
        D.session.abandon('doc_not_open');
      }
    } catch {
      /* still down: the socket keeps trying */
    } finally {
      checking = false;
    }
  }
  function localEdit() {
    if (statusKind !== 'connected') {
      offlineEdits = true;
      setStatus('off', 'Offline · not saved yet');
      return;
    }
    setStatus('ok', 'Saving…');
    clearTimeout(saving);
    saving = setTimeout(() => statusKind === 'connected' && setStatus('ok', 'Saved'), 700);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Control messages from the socket: refused notes, history marks

  function control(msg) {
    if (msg.type === 'refused' && Array.isArray(msg.notes)) {
      for (const n of msg.notes) if (!D.notes.some((x) => x.id === n.id)) D.notes.push(n);
      schedule('notes');
    } else if (msg.type === 'history') D.emit('history', msg);
    else if (msg.type === 'closed') {
      D.tell({ type: 'aib-doc:closed' });
      fail('This doc was moved to the trash.');
    }
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Reading the live state from the Y.Doc

  function readPages() {
    D.pages = D.session ? D.session.pages() : [];
  }
  function readThreads() {
    const out = [];
    const map = D.session.doc.getMap('comments');
    map.forEach((t, id) => {
      if (!t || typeof t.toJSON !== 'function') return;
      const j = t.toJSON();
      const v = {
        thread: id,
        by: String(j.by || 'user'),
        at: String(j.at || ''),
        seq: Number(j.seq) || 0,
        anchor: j.anchor || null,
        resolved: j.resolved === true,
        replies: Array.isArray(j.replies) ? j.replies : [],
        sent: j.sent || null,
        quote: j.quote || '',
      };
      if (v.anchor) {
        const where = j.detached ? null : D.session.anchorInfo(v.anchor);
        if (where) Object.assign(v, { page: where.page, block: where.block, quote: where.quote });
        else v.detached = true;
      }
      out.push(v);
    });
    out.sort((a, b) => ((a.replies[0] && a.replies[0].seq) || a.seq) - ((b.replies[0] && b.replies[0].seq) || b.seq));
    D.threads = out;
  }
  function readClaims() {
    const out = [];
    D.session.doc.getMap('claims').forEach((c) => c && Array.isArray(c.ids) && out.push(c));
    D.claims = out;
  }
  function readRequests() {
    const out = [];
    D.session.doc.getMap('pageRequests').forEach((r) => r && r.page && out.push(r));
    D.requests = out;
  }
  /** The agents working here now (awareness states with an `agent` field), each with its colour slot. */
  const slots = new Map();
  function presence() {
    const out = [];
    if (!D.session) return out;
    D.session.awareness.getStates().forEach((s, client) => {
      if (s && s.agent && s.agent.chat) out.push({ ...s.agent, client, name: s.agent.name || agentName(s.agent.chat) });
    });
    const live = new Set(out.map((p) => p.chat).concat(D.claims.map((c) => c.chat)));
    for (const chat of [...slots.keys()]) if (!live.has(chat)) slots.delete(chat);
    for (const p of out) p.slot = slotOf(p.chat);
    return out;
  }
  function slotOf(chat) {
    if (!chat) return 'a';
    if (!slots.has(chat)) {
      const used = new Set(slots.values());
      slots.set(chat, used.has('a') && !used.has('b') ? 'b' : 'a');
    }
    return slots.get(chat);
  }
  D.presence = presence;
  D.slotOf = slotOf;

  const pending = new Set();
  let frame = 0;
  function schedule(what) {
    pending.add(what);
    if (frame) return;
    frame = requestAnimationFrame(flush);
  }
  D.schedule = schedule;
  function flush() {
    frame = 0;
    if (!D.session) return pending.clear();
    const what = new Set(pending);
    pending.clear();
    if (what.has('pages')) {
      readPages();
      if (D.page && !D.pages.some((p) => p.id === D.page)) {
        D.toast('That page was deleted.');
        showPage(D.pages[0] && D.pages[0].id);
        return;
      }
      postTitle();
    }
    if (what.has('threads') || what.has('pages')) readThreads();
    if (what.has('claims')) readClaims();
    if (what.has('requests')) readRequests();
    D.agents = presence();
    renderPages();
    renderHeader();
    renderAsks();
    refreshMarks();
    D.emit('state', what);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The editor on one page

  const toggleKey = () => 'aib-doc-toggles:' + D.docId;
  let toggles = null;
  function toggleSet() {
    if (toggles) return toggles;
    try {
      toggles = new Set(JSON.parse(localStorage.getItem(toggleKey()) || '[]'));
    } catch {
      toggles = new Set();
    }
    return toggles;
  }
  D.setToggle = (id, open) => {
    if (!id) return;
    const s = toggleSet();
    if (open) s.add(id);
    else s.delete(id);
    try {
      localStorage.setItem(toggleKey(), JSON.stringify([...s].slice(-500)));
    } catch {
      /* private window */
    }
  };
  const lastPageKey = () => 'aib-doc-page:' + D.docId;
  function lastPage() {
    try {
      return localStorage.getItem(lastPageKey());
    } catch {
      return null;
    }
  }

  const fileUrls = new Map();
  /** A file of the doc (a drawing's picture, an image) as a URL the page can show (img-src allows data: and blob:). */
  function fileUrl(rel) {
    if (!rel || !D.info) return Promise.resolve(null);
    const path = (D.info.dir ? D.info.dir.replace(/\\/g, '/') + '/' : '') + String(rel).replace(/^\.\//, '');
    if (fileUrls.has(path)) return fileUrls.get(path);
    const q = new URLSearchParams({ id: params.get('chat') || '', root: 'main', path });
    const p = api('GET', '/api/live/files/read?' + q.toString())
      .then((r) => {
        if (r.viewUrl) return r.viewUrl;
        if (typeof r.text === 'string' && /\.svg$/i.test(path))
          return URL.createObjectURL(new Blob([r.text], { type: 'image/svg+xml' }));
        return null;
      })
      .catch(() => null)
      .then((url) => {
        if (!url) fileUrls.delete(path); // not written yet: ask again next time
        return url;
      });
    fileUrls.set(path, p);
    return p;
  }
  D.fileUrl = fileUrl;

  function editorOptions() {
    return {
      slotOf,
      toggleOpen: (id) => !!id && toggleSet().has(id),
      setToggle: D.setToggle,
      pendingName: () => {
        const a = (D.agents || []).find((p) => p.page === D.page) || (D.agents || [])[0];
        return a ? a.name : D.linked ? agentName(D.linked) : 'The agent';
      },
      drawingSrc: (attrs) => fileUrl(attrs.src || (attrs.drawing ? 'assets/' + attrs.drawing + '.excalidraw.svg' : '')),
      assetSrc: (src) => fileUrl(src),
      openDrawing: (attrs) => D.emit('drawing', attrs),
      onTransaction: (tr) => D.emit('tx', tr),
      onSelection: () => D.emit('selection'),
      onFocus: () => D.emit('focus'),
      onBlur: () => D.emit('blur'),
      onCommentKey: () => D.emit('comment-key'),
    };
  }

  function showPage(id, opts) {
    const o = opts || {};
    if (!D.session) return;
    readPages();
    if (!D.pages.some((p) => p.id === id)) id = D.pages[0] && D.pages[0].id;
    if (!id) return;
    const same = D.page === id && D.editor && !D.editor.destroyed;
    D.page = id;
    if (!same) {
      const host = $('docEditor');
      host.replaceChildren();
      D.editor = D.session.mountPage(host, id, editorOptions());
      try {
        localStorage.setItem(lastPageKey(), id);
      } catch {
        /* private window */
      }
      $('pageCol').scrollTop = 0;
    }
    readThreads();
    D.agents = presence();
    renderPages();
    renderHeader();
    renderAsks();
    refreshMarks();
    postTitle();
    D.emit('page', id);
    if (o.block) setTimeout(() => D.editor && D.editor.reveal(o.block), 30);
    if (o.thread) setTimeout(() => D.emit('open-thread', o.thread), 30);
  }
  D.showPage = showPage;

  function goTo(m) {
    if (m.page && D.pages.some((p) => p.id === m.page)) showPage(m.page, { block: m.block, thread: m.thread });
    else if (m.page) D.toast('That page was deleted.');
    else if (m.block) {
      const page = D.session && D.session.pageOfBlock(m.block);
      if (page) showPage(page, { block: m.block });
    }
    if (m.thread && !m.page) D.emit('open-thread', m.thread);
  }
  D.goTo = goTo;

  function postTitle() {
    const p = D.pages.find((x) => x.id === D.page);
    const title = (D.info && (D.info.title || D.info.name)) || 'Doc';
    D.tell({ type: 'aib-doc:title', title, page: D.page, pageTitle: p ? p.title : '' });
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Decorations in the editor: presence, claims, comment anchors, refused notes

  let marksFrame = 0;
  function refreshMarks() {
    if (marksFrame) return;
    marksFrame = requestAnimationFrame(() => {
      marksFrame = 0;
      if (!D.editor || D.editor.destroyed) return;
      D.editor.setMarks({
        presence: D.agents || [],
        claims: D.claims,
        threads: D.threads.filter((t) => t.page === D.page),
        activeThread: D.activeThread,
        notes: D.notes.filter((n) => (n.blocks || []).some((b) => D.session.pageOfBlock(b) === D.page)),
        noteView,
        noteOpen: D.noteOpen,
        onStopClaim: stopClaim,
      });
      renderFloatingNotes();
    });
  }
  D.refreshMarks = refreshMarks;

  async function stopClaim(c) {
    try {
      await D.post('/api/live/docs/claim/release', { chat: c.chat });
      D.toast(`${c.name} stopped. Your text stays as it is.`);
    } catch (error) {
      if (error.code !== 'no_claim') D.fail(error);
    }
  }
  D.stopClaim = stopClaim;

  const NOTE_WHY = {
    guard_mismatch: "didn't change this because you'd edited it.",
    user_editing: "didn't change this because you were editing it.",
    user_took_back: "didn't change this because you stopped it.",
    anchors_affected: "didn't change this because a comment is on these words.",
    claimed: "didn't change this because another agent was rewriting it.",
    block_gone: "didn't change this because the text it was aimed at is gone.",
  };
  function noteText(n) {
    return `${n.name || agentName(n.chat)} ${NOTE_WHY[n.code] || "didn't make an edit here."}`;
  }
  function noteView(n) {
    const box = el('div', 'qwrap');
    box.contentEditable = 'false';
    box.dataset.note = n.id;
    const line = el('div', 'qnote');
    const open = D.noteOpen.has(n.id);
    line.append(el('span', 'i', 'i'), el('span', 'tx', noteText(n)));
    if (n.wrote) {
      line.append(
        btn('linkish note-show', open ? 'Hide what it wrote' : 'Show what it wrote', () => {
          if (D.noteOpen.has(n.id)) D.noteOpen.delete(n.id);
          else D.noteOpen.add(n.id);
          refreshMarks();
        }),
      );
    }
    line.append(btn('linkish note-x', '✕', () => dismissNote(n), 'Dismiss'));
    box.append(line);
    if (open && n.wrote) {
      const x = el('div', 'qx');
      const when = n.at ? new Date(n.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
      x.append(
        el('div', 'lab', `What ${n.name || agentName(n.chat)} would have written${when ? ' (' + when + ')' : ''}:`),
        el('div', 'would', n.wrote),
      );
      const row = el('div', 'row');
      row.append(
        btn('btn sm note-insert', 'Insert below mine', () => insertBelow(n)),
        btn('btn sm note-copy', 'Copy', () => copyText(n.wrote)),
        btn('btn sm ghost note-dismiss', 'Dismiss', () => dismissNote(n)),
      );
      x.append(row);
      box.append(x);
    }
    for (const b of box.querySelectorAll('button')) b.addEventListener('mousedown', (e) => e.preventDefault());
    return box;
  }
  D.noteView = noteView;

  function renderFloatingNotes() {
    const host = $('pageNotes');
    host.replaceChildren();
    if (!D.session) return;
    for (const n of D.notes) {
      const pages = (n.blocks || []).map((b) => D.session.pageOfBlock(b)).filter(Boolean);
      if (pages.length) continue;
      if (n.page && n.page !== D.page && D.pages.some((p) => p.id === n.page)) continue;
      host.append(noteView(n));
    }
  }

  async function dismissNote(n) {
    D.notes = D.notes.filter((x) => x.id !== n.id);
    D.noteOpen.delete(n.id);
    refreshMarks();
    try {
      await D.post('/api/live/docs/notes/dismiss', { note: n.id });
    } catch (error) {
      D.fail(error);
    }
  }
  D.dismissNote = dismissNote;

  /** "Insert below mine": the agent's words as new paragraphs under the block (the user's own edit). */
  function insertBelow(n) {
    const ed = D.editor;
    if (!ed) return;
    const at = (n.blocks || [])
      .map((b) => ed.findBlock(b))
      .filter(Boolean)
      .sort((a, b) => b.pos - a.pos)[0];
    const top = at ? ed.topBlockAt(at.pos) : null;
    const pos = top ? top.pos + top.node.nodeSize : ed.view.state.doc.content.size;
    const paras = String(n.wrote || '')
      .split(/\n{2,}/)
      .map((t) => t.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
      .map((t) => ({ type: 'paragraph', content: [{ type: 'text', text: t.replace(/^#+\s+|^[-*]\s+/, '') }] }));
    if (!paras.length) return;
    ed.editor.chain().insertContentAt(pos, paras).run();
    dismissNote(n);
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Header

  function renderHeader() {
    const p = D.pages.find((x) => x.id === D.page);
    $('docPageName').textContent = p ? p.title : '';
    $('docPageName').hidden = D.pages.length < 2 && !!p && false;
    $('pagePickerName').textContent = p ? p.title : '';
    const index = D.pages.findIndex((x) => x.id === D.page);
    $('pagePickerOf').textContent = D.pages.length > 1 ? `${index + 1} of ${D.pages.length}` : '';
    const open = D.threads.filter((t) => !t.resolved).length;
    $('commentCount').textContent = open ? String(open) : '';
  }
  D.renderHeader = renderHeader;

  // ---------------------------------------------------------------------------------------------------------------------------
  // The page list (190 px at 900 px or wider; the header picker below that)

  let renaming = null,
    dragging = null;
  const openCount = (page) => D.threads.filter((t) => !t.resolved && t.page === page).length;

  function pageRow(p, index, inMenu) {
    const row = el('div', 'pg' + (p.id === D.page ? ' on' : ''));
    row.dataset.page = p.id;
    row.setAttribute('role', 'button');
    row.tabIndex = 0;
    row.setAttribute('aria-current', p.id === D.page ? 'page' : 'false');
    const grip = el('span', 'gr', '⋮⋮');
    grip.setAttribute('aria-hidden', 'true');
    if (!inMenu) {
      row.draggable = true;
    }
    row.append(grip);
    if (renaming === p.id && !inMenu) {
      const input = el('input', 'pg-ren');
      input.dataset.page = p.id;
      input.value = p.title;
      input.setAttribute('aria-label', 'Page name');
      input.maxLength = 100;
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finishRename(p, input.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          renaming = null;
          renderPages();
        }
      });
      input.addEventListener('blur', () => renaming === p.id && finishRename(p, input.value));
      input.addEventListener('click', (e) => e.stopPropagation());
      row.append(input);
      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
    } else row.append(el('span', 'nm', p.title));
    const count = openCount(p.id);
    if (count) {
      const cc = el('span', 'cc');
      cc.title = `${count} open comment${count === 1 ? '' : 's'}`;
      cc.append(icon('comment'), document.createTextNode(String(count)));
      row.append(cc);
    }
    for (const a of (D.agents || []).filter((x) => x.page === p.id)) {
      const dot = el('span', `agd live agent-${a.slot}`);
      dot.title = `${a.name} is writing here`;
      dot.dataset.agentDot = a.chat;
      row.append(dot);
    }
    if (!inMenu) {
      const more = btn(
        'more',
        '⋯',
        (e) => {
          e.stopPropagation();
          pageMenu(p, more);
        },
        'Page actions',
      );
      more.setAttribute('aria-haspopup', 'menu');
      more.setAttribute('aria-label', `Actions for ${p.title}`);
      row.append(more);
    }
    row.addEventListener('click', () => {
      if (renaming) return;
      if (inMenu) closeMenu();
      showPage(p.id);
    });
    if (inMenu) return row;
    row.addEventListener('dblclick', (e) => {
      e.preventDefault();
      startRename(p.id);
    });
    row.addEventListener('keydown', (e) => {
      if (e.target !== row) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        showPage(p.id);
      } else if (e.key === 'F2') {
        e.preventDefault();
        startRename(p.id);
      } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        movePage(p.id, index + (e.key === 'ArrowUp' ? -1 : 1), true);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const rows = [...$('pageList').querySelectorAll('.pg')];
        const next = rows[rows.indexOf(row) + (e.key === 'ArrowUp' ? -1 : 1)];
        if (next) next.focus();
      } else if (e.key === 'Delete') {
        e.preventDefault();
        askDelete(p, row);
      }
    });
    // drag reorder: a teal line shows where it lands
    row.addEventListener('dragstart', (e) => {
      dragging = p.id;
      row.classList.add('ghost');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/x-aib-page', p.id);
    });
    row.addEventListener('dragend', () => {
      dragging = null;
      row.classList.remove('ghost');
      dropLine(null);
    });
    return row;
  }

  function dropLine(at) {
    const list = $('pageList');
    list.querySelectorAll('.pg-drop').forEach((x) => x.remove());
    if (at === null) return;
    const rows = [...list.querySelectorAll('.pg')];
    const line = el('div', 'pg-drop');
    if (at >= rows.length) rows[rows.length - 1].after(line);
    else rows[at].before(line);
    list.dataset.dropAt = String(at);
  }
  function dropIndex(e) {
    const rows = [...$('pageList').querySelectorAll('.pg')];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) return i;
    }
    return rows.length;
  }

  function renderPages() {
    const list = $('pageList');
    // a name being typed stays as it is (a re-render would take the field away mid-word)
    const typing = list.querySelector('.pg-ren');
    if (renaming && typing && typing.isConnected && typing.dataset.page === renaming) return;
    const focused =
      document.activeElement && list.contains(document.activeElement) ? document.activeElement.closest('.pg') : null;
    const focusId = focused && focused.dataset.page;
    list.replaceChildren();
    const head = el('div', 'pg-h', 'Pages');
    head.append(el('span', 'sp'));
    const add = btn('pib', '+', () => addPage(), 'Add a page');
    add.setAttribute('aria-label', 'Add a page');
    head.append(add);
    list.append(head);
    D.pages.forEach((p, i) => list.append(pageRow(p, i, false)));
    list.append(btn('pg-add', '+ Add page', () => addPage()));
    for (const r of D.requests) list.append(askLine(r));
    if (focusId) {
      const again = list.querySelector(`.pg[data-page="${CSS.escape(focusId)}"]`);
      if (again && !renaming) again.focus();
    }
  }
  D.renderPages = renderPages;

  $('pageList').addEventListener('dragover', (e) => {
    if (!dragging) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropLine(dropIndex(e));
  });
  $('pageList').addEventListener('drop', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const id = dragging;
    let at = dropIndex(e);
    const from = D.pages.findIndex((p) => p.id === id);
    if (at > from) at -= 1;
    dropLine(null);
    dragging = null;
    if (at !== from) movePage(id, at, false);
  });

  async function pageOp(action, args) {
    try {
      const r = await D.post('/api/live/docs/page', { action, ...args });
      return r;
    } catch (error) {
      D.fail(error);
      return null;
    }
  }
  D.pageOp = pageOp;

  async function addPage() {
    const r = await pageOp('add', { title: uniqueTitle('Untitled page'), after: D.page });
    if (!r) return;
    const id = r.page || ((r.pages && r.pages.find((p) => !D.pages.some((x) => x.id === p.id))) || {}).id;
    await waitFor(() => D.session && D.session.pages().some((p) => p.id === id));
    readPages();
    showPage(id);
    startRename(id);
  }
  D.addPage = addPage;
  function uniqueTitle(base) {
    const taken = new Set(D.pages.map((p) => p.title.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let k = 2; k < 1000; k++) if (!taken.has(`${base} ${k}`.toLowerCase())) return `${base} ${k}`;
    return base;
  }
  function waitFor(check, ms) {
    return new Promise((resolve) => {
      const end = Date.now() + (ms || 3000);
      const tick = () => (check() || Date.now() > end ? resolve() : setTimeout(tick, 20));
      tick();
    });
  }
  D.waitFor = waitFor;

  function startRename(id) {
    renaming = id;
    renderPages();
  }
  D.startRename = startRename;
  async function finishRename(p, value) {
    renaming = null;
    const title = String(value || '')
      .replace(/\s+/g, ' ')
      .trim();
    renderPages();
    if (!title || title === p.title) return;
    await pageOp('rename', { page: p.id, title });
  }
  async function movePage(id, index, keepFocus) {
    if (index < 0 || index >= D.pages.length) return;
    await pageOp('move', { page: id, index });
    if (keepFocus) {
      await waitFor(() => D.session.pages().findIndex((p) => p.id === id) === index, 1500);
      readPages();
      renderPages();
      const row = $('pageList').querySelector(`.pg[data-page="${CSS.escape(id)}"]`);
      if (row) row.focus();
    }
  }
  D.movePage = movePage;

  function pageMenu(p, anchor) {
    const index = D.pages.findIndex((x) => x.id === p.id);
    anchor.setAttribute('aria-expanded', 'true');
    menu(
      anchor,
      [
        { label: 'Rename', hint: 'F2', run: () => startRename(p.id) },
        {
          label: 'Duplicate',
          run: async () => {
            const r = await pageOp('duplicate', { page: p.id });
            if (r && r.page) {
              await waitFor(() => D.session.pages().some((x) => x.id === r.page));
              readPages();
              showPage(r.page);
            }
          },
        },
        { label: 'Move up', hint: 'Alt+↑', disabled: index <= 0, run: () => movePage(p.id, index - 1, true) },
        {
          label: 'Move down',
          hint: 'Alt+↓',
          disabled: index >= D.pages.length - 1,
          run: () => movePage(p.id, index + 1, true),
        },
        { label: 'Copy link to page', run: () => copyText(linkTo({ page: p.id })) },
        { sep: true },
        {
          label: 'Delete page…',
          danger: true,
          disabled: D.pages.length < 2,
          run: () => askDelete(p, $('pageList').querySelector(`.pg[data-page="${CSS.escape(p.id)}"]`) || anchor),
        },
      ],
      { side: 'right', onClose: () => anchor.setAttribute('aria-expanded', 'false') },
    );
  }

  function askDelete(p, anchor) {
    if (D.pages.length < 2) return D.toast('A doc always keeps one page.');
    const n = openCount(p.id);
    const goes = n ? ` Its ${n} open comment${n === 1 ? '' : 's'} go${n === 1 ? 'es' : ''} with it.` : '';
    const name = el('b', '', `Delete "${p.title}"?`);
    D.confirm(
      anchor,
      [name, `${goes} History keeps the page, and Restore brings it back.`],
      [{ label: 'Delete page', cls: 'dng', run: () => pageOp('delete', { page: p.id }) }, { label: 'Cancel' }],
    );
  }
  D.askDelete = askDelete;

  /** A link to this doc (and page / block) that chat.html and the doc tab understand. */
  function linkTo(where) {
    const q = new URLSearchParams({
      chat: params.get('chat') || '',
      name: (D.info && D.info.name) || params.get('name') || '',
    });
    if (where.page) q.set('page', where.page);
    if (where.block) q.set('block', where.block);
    return location.origin + '/doc.html?' + q.toString();
  }
  D.linkTo = linkTo;

  // the header picker (narrow widths): the same rows, counts and dots
  $('pagePicker').addEventListener('click', () => {
    const m = menu($('pagePicker'), [], { cls: 'page-menu' });
    m.list.replaceChildren();
    m.list.append(el('div', 'mh', 'Pages in ' + ((D.info && D.info.title) || 'this doc')));
    D.pages.forEach((p, i) => m.list.append(pageRow(p, i, true)));
    m.list.append(btn('pg-add', '+ Add page', () => (closeMenu(), addPage())));
    for (const r of D.requests) m.list.append(askLine(r));
  });

  // ---------------------------------------------------------------------------------------------------------------------------
  // An agent's page delete request: "Claude Code wants to delete Metrics · Delete · Keep"

  function askLine(r) {
    const line = el('div', 'askline');
    line.dataset.request = r.page + '|' + r.chat;
    const page = D.pages.find((p) => p.id === r.page);
    const text = el('span', 'tx');
    text.append(
      el('b', '', r.name || agentName(r.chat)),
      document.createTextNode(' wants to delete '),
      el('b', '', page ? page.title : r.title),
    );
    const dot = el('span', `agd agent-${slotOf(r.chat)}`);
    line.append(
      dot,
      text,
      btn('btn sm dng req-delete', 'Delete', () => decide(r, 'delete')),
      btn('btn sm req-keep', 'Keep', () => decide(r, 'keep')),
    );
    return line;
  }
  async function decide(r, decision) {
    try {
      await D.post('/api/live/docs/page/request', { page: r.page, chat: r.chat, decision });
      if (decision === 'keep') D.toast(`Kept. ${r.name || agentName(r.chat)} will hear it in its next doc call.`);
    } catch (error) {
      D.fail(error);
    }
  }
  function renderAsks() {
    const host = $('askLines');
    host.replaceChildren();
    for (const r of D.requests) host.append(askLine(r));
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Layout by the doc pane's own width (a tab or beside the chat)

  function layout() {
    const w = document.documentElement.clientWidth;
    const app = $('docApp');
    const before = app.className;
    app.classList.toggle('wide-pages', w >= 900);
    app.classList.toggle('wide-rail', w >= 1100);
    app.classList.toggle('narrow', w < 600);
    $('pagePicker').hidden = w >= 900;
    $('docCrumbs').hidden = w < 900 && w >= 600 ? false : w < 600;
    if (app.className !== before) D.emit('layout', w);
  }
  D.layout = layout;
  new ResizeObserver(layout).observe(document.documentElement);

  // live theme: another AIB window or the Settings picker changed it
  window.addEventListener('storage', (e) => {
    if (e.key === 'aib-theme' && window.AIBThemes && window.AIBThemes.apply) window.AIBThemes.apply(e.newValue);
  });

  // ---------------------------------------------------------------------------------------------------------------------------

  async function boot() {
    layout();
    for (const h of document.querySelectorAll('[data-icon]')) h.replaceChildren(icon(h.dataset.icon));
    try {
      const b = await (await fetch('/api/live/bootstrap', { cache: 'no-store' })).json();
      D.token = b.token;
      D.emit('boot');
      await open(params.get('new') === '1');
    } catch (error) {
      if (error.code === 'doc_exists' || error.code === 'folder_exists') return fail(error.message);
      if (!error.code) console.error(error);
      fail(String((error && error.message) || error));
    }
  }
  D.boot = boot;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);
})();
